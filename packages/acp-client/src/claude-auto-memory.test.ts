import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRuntimeStore } from 'acpx/runtime';
import type { AgentConfig, DriverContext, NativeContextExpected, NativeContextIdentity } from '@dutydeck/shared';
import { AcpxAdapter } from './index.js';

// claudeAutoMemory=off 的 ACPX 回归：真实 AcpxAdapter + 持久化 session key，经内置 claude-acp.mjs 启动一个记录自身环境的假 ACP Agent。
// 断言真正的 Agent 子进程收到的 CLAUDE_CODE_DISABLE_AUTO_MEMORY，以及恢复时 load 的仍是原生会话。
const launcher = resolve('packages/acp-client/agents/claude-acp.mjs');
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const probeAgent = `
import readline from 'node:readline';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const log = process.env.probe_log;
const ids = log + '.ids';
const record = entry => appendFileSync(log, JSON.stringify({ pid: process.pid, ...entry }) + '\\n');
record({ event: 'spawn', autoMemory: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? null, marker: process.env.dutydeck_claude_auto_memory ?? null });
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params = {} } = JSON.parse(line);
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true }, authMethods: [] } });
  if (method === 'session/new') {
    const sessionId = 'native-' + randomUUID();
    appendFileSync(ids, sessionId + '\\n');
    record({ event: 'new', sessionId });
    return send({ jsonrpc: '2.0', id, result: { sessionId, configOptions: [] } });
  }
  if (method === 'session/load') {
    record({ event: 'load', sessionId: params.sessionId });
    if (!existsSync(ids) || !readFileSync(ids, 'utf8').split('\\n').includes(params.sessionId)) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Resource not found' } });
    return send({ jsonrpc: '2.0', id, result: { configOptions: [] } });
  }
  if (method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'probe-ok' } } } });
    return send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unsupported ' + method } });
});
`;

type Probe = { pid: number; event: 'spawn' | 'new' | 'load'; autoMemory?: string | null; marker?: string | null; sessionId?: string };

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-acp-auto-memory-')); dirs.push(cwd);
  const agentScript = join(cwd, 'probe-agent.mjs');
  await writeFile(agentScript, probeAgent);
  const configDir = join(cwd, 'claude-config'); await mkdir(configDir);
  // 内置启动器读这两个变量改用假 Agent；它们属于可继承的服务键，不会把直接启动改成 launcher。
  vi.stubEnv('DUTYDECK_CLAUDE_ACP_COMMAND', process.execPath);
  vi.stubEnv('DUTYDECK_CLAUDE_ACP_ARGS_JSON', JSON.stringify([agentScript]));
  vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
  vi.stubEnv('CLAUDE_CODE_DISABLE_AUTO_MEMORY', undefined);
  const log = join(cwd, 'probe.jsonl');
  const agent = (env: Record<string, string>): AgentConfig => ({
    id: 'claude', name: 'Claude', command: process.execPath, args: [launcher], protocol: 'acp', cwd,
    permissionMode: 'full-trust', timeout: 10, capabilities: { pause: false, resume: true }, builtin: true,
    env: { probe_log: log, dutydeck_group_tools_url: 'http://127.0.0.1:4310/api/lark/agent-tools', ...env }
  });
  const probes = async (): Promise<Probe[]> => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const store = createRuntimeStore({ stateDir: join(cwd, '.dutydeck', 'acpx') });
  return { cwd, configDir, agent, probes, store };
}

/** 受控（controlled-v1）路径的最小 DriverContext，写法同 transcript-source.test.ts。 */
function strictContext(mode: 'create' | 'attach', sessionKey: string, expected?: NativeContextIdentity) {
  const confirmed: NativeContextIdentity[] = [];
  const permit = Object.freeze({});
  const scope = { begin: () => scope, cleanup: () => scope, beforeSpawn: () => permit, spawned: () => undefined, notCreated: () => undefined, finish: () => undefined };
  const resources = { beginOperation: () => permit, beginCleanup: () => permit, beforeCreate: () => permit, assertCreation: () => undefined, spawned: () => undefined, creationFinished: () => undefined };
  const context = {
    sessionId: 'ses-auto-memory', runId: 'run-1', protocol: 'controlled-v1' as const, driverInstanceId: 'driver-1', executionDomain: 'local',
    mode, rootOperation: permit, resources,
    assertSubmission: () => undefined,
    prepareSubmission: () => ({ nativeContextRef: { resourceId: 'native-1', identityId: 'identity-1', originRunId: 'run-1' } }),
    native: {
      sessionKey,
      ...(expected ? { expected } : {}),
      reserve: (input: NativeContextExpected) => ({ resourceId: 'native-1', nativeCreationId: input.nativeCreationId }),
      confirmed: (identity: NativeContextIdentity) => { confirmed.push(identity); }
    }
  } as unknown as DriverContext;
  void scope;
  return { context, confirmed };
}

const spawns = (probes: Probe[]) => probes.filter(probe => probe.event === 'spawn');
const off = { dutydeck_claude_auto_memory: 'off' };

describe.each([
  ['direct launch', {}],
  ['launcher launch (uppercase Agent env)', { MOCK_VENDOR_TOKEN: 'vendor-value' }],
] as const)('Claude auto memory over real ACPX: %s', (_name, vendorEnv) => {
  it('strict restore after switching to off keeps the native session and the child receives the variable', async () => {
    const { agent, probes, store } = await fixture();
    const sessionKey = 'auto-memory-strict';
    const first = strictContext('create', sessionKey);
    const created = new AcpxAdapter(agent({ ...vendorEnv }), { context: first.context, onEvent() {} });
    await created.start(); await created.stop();
    const identity = first.confirmed[0]!;
    expect(spawns(await probes()).at(-1)?.autoMemory).toBeNull();

    const second = strictContext('attach', sessionKey, identity);
    const restored = new AcpxAdapter(agent({ ...vendorEnv, ...off }), { context: second.context, onEvent() {} });
    await restored.start();
    try {
      const after = await probes();
      expect(spawns(after).at(-1)).toMatchObject({ autoMemory: '1', marker: 'off' });
      expect(after.filter(probe => probe.event === 'new')).toHaveLength(1);
      expect(after.filter(probe => probe.event === 'load').at(-1)?.sessionId).toBe(identity.backendSessionId);
      expect(second.confirmed[0]?.backendSessionId).toBe(identity.backendSessionId);
      const env = (await store.load(sessionKey))?.acpx?.session_options?.env ?? {};
      expect(env).toMatchObject(off);
      expect(Object.keys(env).every(key => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key))).toBe(true);
    } finally { await restored.stop(); }

    // 切回 inherit：同样不重建，存档 env 里的标记被本次 env 覆盖掉。
    const third = strictContext('attach', sessionKey, identity);
    const reverted = new AcpxAdapter(agent({ ...vendorEnv }), { context: third.context, onEvent() {} });
    await reverted.start(); await reverted.stop();
    expect(spawns(await probes()).at(-1)?.autoMemory).toBeNull();
    expect(third.confirmed[0]?.backendSessionId).toBe(identity.backendSessionId);
    expect((await store.load(sessionKey))?.acpx?.session_options?.env ?? {}).not.toHaveProperty('dutydeck_claude_auto_memory');
  });

  it('non-strict sessions are never reset by the marker; only new sessions receive the variable', async () => {
    const { agent, probes, store } = await fixture();
    const sessionKey = 'auto-memory-local';
    const created = new AcpxAdapter(agent({ ...vendorEnv }), { sessionKey, onEvent() {} });
    await created.start(); await created.send('hello'); await created.stop();
    const record = await store.load(sessionKey);
    const nativeId = (await probes()).find(probe => probe.event === 'new')!.sessionId;

    const existing = new AcpxAdapter(agent({ ...vendorEnv, ...off }), { sessionKey, onEvent() {} });
    await existing.start(); await existing.send('hello again'); await existing.stop();
    const after = await probes();
    // 不 reset、不新建：仍 load 原生会话；重新拉起的子进程用本次启动环境，已有会话下次拉起即生效。
    expect(after.filter(probe => probe.event === 'new')).toHaveLength(1);
    expect(after.filter(probe => probe.event === 'load').map(probe => probe.sessionId)).toEqual([nativeId]);
    expect(spawns(after).map(probe => probe.autoMemory)).toEqual([null, '1']);
    expect(record?.acpSessionId).toBe(nativeId);
    expect((await store.load(sessionKey))?.acpSessionId).toBe(nativeId);
    expect((await store.load(sessionKey))?.acpx?.reset_on_next_ensure).not.toBe(true);

    const fresh = new AcpxAdapter(agent({ ...vendorEnv, ...off }), { sessionKey: 'auto-memory-local-new', onEvent() {} });
    await fresh.start(); await fresh.send('hello'); await fresh.stop();
    expect(spawns(await probes()).at(-1)).toMatchObject({ autoMemory: '1', marker: 'off' });
  });

  it('an explicit user value wins over the default', async () => {
    const { agent, probes, configDir } = await fixture();
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' } }));
    const fromSettings = new AcpxAdapter(agent({ ...vendorEnv, ...off }), { sessionKey: 'auto-memory-settings', onEvent() {} });
    await fromSettings.start(); await fromSettings.send('hello'); await fromSettings.stop();
    expect(spawns(await probes()).at(-1)?.autoMemory).toBe('0');
    await writeFile(join(configDir, 'settings.json'), '{}');
    // Agent env 里的大写值走 launcher（不进持久化 env），同样压过默认值。
    const fromAgent = new AcpxAdapter(agent({ ...vendorEnv, ...off, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' }), { sessionKey: 'auto-memory-agent-env', onEvent() {} });
    await fromAgent.start(); await fromAgent.send('hello'); await fromAgent.stop();
    expect(spawns(await probes()).at(-1)?.autoMemory).toBe('0');
  });
});
