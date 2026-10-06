import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRuntimeStore } from 'acpx/runtime';
import type { AgentConfig, DriverContext, NativeContextExpected, NativeContextIdentity, DriverTranscriptSourceObservation } from '@dutydeck/shared';
import { AcpxAdapter } from './index.js';
import {
  acpDataRoot,
  buildLaunchObservation,
  buildNativeObservation,
  inferAcpInsightClient,
  resolveAcpChildEnvironment
} from './transcript-source.js';

const fixture = resolve('tests/fixtures/acp-transcript-source-agent.mjs');
const dirs: string[] = [];

function makeAgent(cwd: string, extraEnv: Record<string, string> = {}): AgentConfig {
  return {
    id: 'codex', name: 'Codex', command: process.execPath, args: [fixture], protocol: 'acp',
    cwd, permissionMode: 'full-trust', timeout: 10,
    capabilities: { pause: false, resume: true }, builtin: false,
    // 真实 runtime 通过 agent.env 注入 group 工具小写 snake_case 运行时变量。
    env: {
      native_directory: cwd,
      dutydeck_group_tools_url: 'http://group-tools',
      dutydeck_group_tools_token: 'group-runtime-token',
      ...extraEnv
    }
  };
}

function makeSubmission(permit: object) {
  return {
    taskId: 'task-1', attemptId: 'attempt-1', submissionId: 'submission-1', prompt: 'hello',
    executionOptions: { permissionMode: 'full-trust' as const },
    inputDigest: 'digest', resourceRefs: [],
    operation: permit, onAccepted() {}
  };
}

/** 最小受控 DriverContext：native.confirmed/reserve 用记录器模拟 runtime 的 DB 行为。 */
function makeContext(mode: 'create' | 'attach', sessionKey: string, expected?: NativeContextIdentity, options: {
  confirmFail?: () => boolean;
} = {}): { context: DriverContext; confirmed: NativeContextIdentity[]; reserveCalls: NativeContextExpected[] } {
  const confirmed: NativeContextIdentity[] = [];
  const reserveCalls: NativeContextExpected[] = [];
  const permit = Object.freeze({});
  const scope = {
    begin: () => scope,
    cleanup: () => scope,
    beforeSpawn: () => permit,
    spawned: () => undefined,
    notCreated: () => undefined,
    finish: () => undefined
  };
  const resources = {
    beginOperation: () => permit,
    beginCleanup: () => permit,
    beforeCreate: () => permit,
    assertCreation: () => undefined,
    spawned: () => undefined,
    creationFinished: () => undefined
  };
  const context = {
    sessionId: 'ses-1', runId: 'run-1',
    protocol: 'controlled-v1' as const, driverInstanceId: 'driver-1', executionDomain: 'local',
    mode, rootOperation: permit, resources,
    assertSubmission: () => undefined,
    prepareSubmission: () => ({ nativeContextRef: { resourceId: 'native-1', identityId: 'identity-1', originRunId: 'run-1' } }),
    native: {
      sessionKey,
      ...(expected ? { expected } : {}),
      reserve: (input: NativeContextExpected) => { reserveCalls.push(input); return { resourceId: 'native-1', nativeCreationId: input.nativeCreationId }; },
      confirmed: (identity: NativeContextIdentity) => {
        if (options.confirmFail?.()) throw new Error('native confirmation unavailable');
        confirmed.push(identity);
      }
    }
  } as unknown as DriverContext;
  return { context, confirmed, reserveCalls };
}

async function spawnLogs(cwd: string) {
  const file = join(cwd, 'source-spawn.jsonl');
  const raw = await readFile(file, 'utf8');
  return raw.trim().split('\n').map(line => JSON.parse(line) as Record<string, string | undefined>);
}

describe('ACP transcript source collection', () => {
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function freshDir() {
    const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-acp-source-'));
    dirs.push(cwd);
    return cwd;
  }

  it('creates: freezes launch_observed dataRoot from the REAL child env, appends native id after confirmed only', async () => {
    const cwd = await freshDir();
    const codeHome = join(cwd, 'isolated-codex-home');
    const agent = makeAgent(cwd, { CODEX_HOME: codeHome });
    const { context, confirmed } = makeContext('create', 'source-create-key');
    const received: DriverTranscriptSourceObservation[] = [];
    const publicEvents: any[] = [];
    const adapter = new AcpxAdapter(agent, { context, onEvent: e => publicEvents.push(e) });
    const unsubscribe = adapter.subscribeTranscriptSource(o => received.push(o));
    await adapter.start();
    await adapter.send(makeSubmission(context.rootOperation) as any);

    // 真实子进程 env 证据：CODEX_HOME 覆盖到达 Agent 进程。
    const logs = await spawnLogs(cwd);
    expect(logs.at(-1)?.CODEX_HOME).toBe(codeHome);

    // launch 观察 + native 追加观察；native 观察在 confirmed 之后。
    expect(confirmed).toHaveLength(1);
    const launch = received.find(o => !('nativeSessionId' in o));
    const native = received.find(o => 'nativeSessionId' in o);
    expect(launch).toMatchObject({ client: 'codex', launchKind: 'created', proofKind: 'launch_observed', dataRoot: codeHome, cwd });
    expect(received.indexOf(launch!)).toBeLessThan(received.indexOf(native!));
    expect(native).toMatchObject({ proofKind: 'launch_observed', nativeSessionId: null, identityProof: null });
    // confirmed 成功后经 prepareSubmission 取到本次来源关联。
    expect(native).toHaveProperty('nativeContextRef', { resourceId: 'native-1', identityId: 'identity-1', originRunId: 'run-1' });
    // fixture 未回 _meta.agentSessionId：不能拿 acpx record / backend id 顶替。
    expect(native).not.toHaveProperty('verifiedPath');

    // 非密钥元信息不进公开事件流。
    expect(JSON.stringify(publicEvents)).not.toContain(codeHome);
    expect(JSON.stringify(publicEvents)).not.toContain('group-runtime-token');

    // 落盘 session：无 Persisted key policy violation，env 仅小写 snake_case。
    const record = await createRuntimeStore({ stateDir: join(cwd, '.dutydeck', 'acpx') }).load('source-create-key');
    expect(record).toBeTruthy();
    const envKeys = Object.keys(record?.acpx?.session_options?.env ?? {});
    expect(envKeys.every(k => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(k))).toBe(true);
    expect(record?.acpx?.session_options?.env?.dutydeck_group_tools_token).toBe('group-runtime-token');
    expect(JSON.stringify(record?.acpx?.session_options)).not.toContain('dataRoot');

    unsubscribe();
    await adapter.stop();
  });

  it('maps ACP _meta.agentSessionId to nativeSessionId and keeps it distinct from acpx/backend ids', async () => {
    const cwd = await freshDir();
    const agent = makeAgent(cwd, { native_meta_id: 'cli-session-77' });
    const { context, confirmed } = makeContext('create', 'source-meta-key');
    const received: DriverTranscriptSourceObservation[] = [];
    const adapter = new AcpxAdapter(agent, { context, onEvent() {} });
    adapter.subscribeTranscriptSource(o => received.push(o));
    await adapter.start();
    const identity = confirmed[0]!;
    expect(identity.acpxRecordId).toBe('source-meta-key');
    expect(identity.backendSessionId).toBe('native-backend-1');
    const native = received.find(o => 'nativeSessionId' in o)!;
    expect(native.nativeSessionId).toBe('cli-session-77');
    expect(native.identityProof).toBe('acpx_agent_session_meta');
    // CLI id 既不是 acpx record id 也不是 backend session id。
    expect(identity.backendSessionId).not.toBe('cli-session-77');
    await adapter.stop();
  });

  it('bridge launch: real agent grandchild env proves dataRoot; group runtime var stays lowercase snake_case', async () => {
    const cwd = await freshDir();
    const codeHome = join(cwd, 'bridge-home');
    // 大写 vendor 变量强制走 env-launcher 桥接；小写 group token 走持久 env。
    const agent = makeAgent(cwd, { CODEX_HOME: codeHome, UPPER_VENDOR_TOKEN: 'vendor-secret' });
    const { context } = makeContext('create', 'source-bridge-key');
    const received: DriverTranscriptSourceObservation[] = [];
    const adapter = new AcpxAdapter(agent, { context, onEvent() {} });
    adapter.subscribeTranscriptSource(o => received.push(o));
    await adapter.start();

    const logs = await spawnLogs(cwd);
    const last = logs.at(-1)!;
    expect(last.CODEX_HOME).toBe(codeHome);
    expect(last.dutydeck_group_tools_token).toBe('group-runtime-token');
    // 大写 vendor 变量经 env-file 在真正 agent 孙进程处展开，证明下钻读到的是
    // 重构后的最终环境，而非 env-launcher 包装层自身。
    expect(last.UPPER_VENDOR_TOKEN).toBe('vendor-secret');
    // 真正 agent 进程已删除载体键（在 launcher 内完成重构）。
    expect(last.carrier_file).toBeUndefined();

    const launch = received.find(o => !('nativeSessionId' in o))!;
    expect(launch.proofKind).toBe('launch_observed');
    expect(launch.dataRoot).toBe(codeHome);

    const record = await createRuntimeStore({ stateDir: join(cwd, '.dutydeck', 'acpx') }).load('source-bridge-key');
    const envKeys = Object.keys(record?.acpx?.session_options?.env ?? {});
    expect(envKeys.every(k => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(k))).toBe(true);
    expect(JSON.stringify(record)).not.toContain('UPPER_VENDOR_TOKEN');
    await adapter.stop();
  });

  it('attach (restore) yields only inferred proof even with a live child env; new HOME cannot endorse history', async () => {
    // 第一次 create 落盘真实身份。大写 vendor 变量让两次都走同一 bridge 形态，
    // 避免 argv 形态变化触发 ACPX 既有安全冲突。
    const cwd = await freshDir();
    const firstHome = join(cwd, 'first-home');
    const firstAgent = makeAgent(cwd, { HOME: firstHome, UPPER_VENDOR_TOKEN: 'v' });
    const first = makeContext('create', 'source-restore-key');
    const firstAdapter = new AcpxAdapter(firstAgent, { context: first.context, onEvent() {} });
    await firstAdapter.start();
    const identity = first.confirmed[0]!;
    await firstAdapter.stop();

    // 恢复时改 HOME：当前配置不能证明历史 launch root，只能给 inferred。
    const newHome = join(cwd, 'other-home');
    const restoredAgent = makeAgent(cwd, { HOME: newHome, UPPER_VENDOR_TOKEN: 'v' });
    const second = makeContext('attach', 'source-restore-key', identity);
    const received: DriverTranscriptSourceObservation[] = [];
    const secondAdapter = new AcpxAdapter(restoredAgent, { context: second.context, onEvent() {} });
    secondAdapter.subscribeTranscriptSource(o => received.push(o));
    await secondAdapter.start();
    expect(received.every(o => o.proofKind === 'inferred')).toBe(true);
    expect(received.every(o => o.launchKind === 'attached')).toBe(true);
    await secondAdapter.stop();
  });

  it('does not append a native observation when native.confirmed fails, and start rejects', async () => {
    const cwd = await freshDir();
    const agent = makeAgent(cwd, {});
    const { context } = makeContext('create', 'source-confirm-fail-key', undefined, { confirmFail: () => true });
    const received: any[] = [];
    const adapter = new AcpxAdapter(agent, { context, onEvent() {} });
    adapter.subscribeTranscriptSource(o => received.push(o));
    await expect(adapter.start()).rejects.toThrow('native confirmation unavailable');
    // 真实 agent 进程确实 spawn 过（证据落盘），但没有任何携带 nativeSessionId
    // 的身份追加：confirmed 失败时不得追加 native 关联。
    await expect.poll(async () => (await spawnLogs(cwd)).length).toBeGreaterThan(0);
    expect(received.some(o => 'nativeSessionId' in o)).toBe(false);
    await adapter.stop().catch(() => undefined);
  });

  it('replays immutable snapshots to late subscribers, unsubscribe stops callbacks, listener throws never break the driver', async () => {
    const cwd = await freshDir();
    const agent = makeAgent(cwd, {});
    const { context } = makeContext('create', 'source-replay-key');
    const adapter = new AcpxAdapter(agent, { context, onEvent() {} });

    // 发射前订阅又取消：之后 start 不应再回调它。
    const cancelled: DriverTranscriptSourceObservation[] = [];
    const cancelEarly = adapter.subscribeTranscriptSource(o => cancelled.push(o));
    cancelEarly();

    // start 前同时注册会抛错的 listener 和健康 listener：发射时前者的异常不得
    // 影响 driver 执行，也不得阻断后者收到同一批观察。
    const healthy: DriverTranscriptSourceObservation[] = [];
    adapter.subscribeTranscriptSource(() => { throw new Error('listener boom'); });
    adapter.subscribeTranscriptSource(o => healthy.push(o));
    await adapter.start();
    expect(cancelled).toHaveLength(0);
    expect(healthy.length).toBeGreaterThanOrEqual(2);

    // 已产生 launch + native 观察后再订阅：完整重放不可变快照。
    const late: DriverTranscriptSourceObservation[] = [];
    const unsubscribe = adapter.subscribeTranscriptSource(o => late.push(o));
    expect(late.length).toBe(healthy.length);

    // 快照不可变（含嵌套 streamIdentity）。
    expect(Object.isFrozen(late[0])).toBe(true);
    expect(() => { (late[0] as any).dataRoot = 'x'; }).toThrow();

    // 取消订阅后不再收到（这里以 stop 后不新增回调来验证 unsubscribe 返回的
    // dispose 可用；stop 清空活动订阅，历史快照仍允许只读重放）。
    unsubscribe();
    await adapter.stop();
    const afterStop: DriverTranscriptSourceObservation[] = [];
    adapter.subscribeTranscriptSource(o => afterStop.push(o));
    expect(afterStop.length).toBe(late.length);
  });
});

describe('ACP transcript source pure helpers', () => {
  const baseAgent = (over: Partial<AgentConfig> = {}): AgentConfig => ({
    id: 'codex', name: 'Codex', command: process.execPath, args: [], protocol: 'acp',
    permissionMode: 'full-trust', timeout: 10, capabilities: { pause: false, resume: true },
    builtin: false, env: {}, ...over
  });
  const launcherPath = resolve('packages/acp-client/agents/env-launcher.mjs');

  it('infers the log client from adapterId, executable, or exact builtin id, null when unknown', () => {
    // 1. 精确 builtin id fallback
    expect(inferAcpInsightClient(baseAgent({ id: 'codex' }))).toBe('codex');
    expect(inferAcpInsightClient(baseAgent({ id: 'claude' }))).toBe('claude');
    expect(inferAcpInsightClient(baseAgent({ id: 'traex' }))).toBe('traex');
    expect(inferAcpInsightClient(baseAgent({ id: 'trae' }))).toBe('traex');

    // 2. 真实启动可执行文件
    expect(inferAcpInsightClient(baseAgent({ id: 'custom', command: '/opt/trae/bin/traecli' }))).toBe('traex');
    expect(inferAcpInsightClient(baseAgent({ id: 'custom', command: '/usr/local/bin/codex-acp' }))).toBe('codex');
    expect(inferAcpInsightClient(baseAgent({ id: 'custom', command: 'claude' }))).toBe('claude');

    // 3. 显式 adapterId 优先
    expect(inferAcpInsightClient(baseAgent({ id: 'custom-tool', command: 'my-wrapper', adapterId: 'traex' }))).toBe('traex');
    expect(inferAcpInsightClient(baseAgent({ id: 'custom-tool', command: 'my-wrapper', adapterId: 'codex' }))).toBe('codex');

    // 4. runtime wrapper (node / npx) 识别脚本/包目标，不被模型名误导
    expect(inferAcpInsightClient(baseAgent({ id: 'custom', command: 'node', args: ['/path/to/claude-acp.mjs'] }))).toBe('claude');
    expect(inferAcpInsightClient(baseAgent({ id: 'custom', command: 'npx', args: ['@agentclientprotocol/claude-agent-acp'] }))).toBe('claude');

    // 5. 关键反例（probe）：不能被 --model 或标签中的 claude 误导
    expect(inferAcpInsightClient(baseAgent({ id: 'custom', command: '/opt/bin/codex-acp', args: ['--model', 'claude-opus'] }))).toBe('codex');
    expect(inferAcpInsightClient(baseAgent({ id: 'custom-claude-model', command: '/opt/bin/codex-acp', args: [] }))).toBe('codex');
    expect(inferAcpInsightClient(baseAgent({ id: 'custom', command: 'unknown-agent', args: ['--model', 'claude-opus'] }))).toBeNull();

    // 6. 自由标签不能作为推导依据
    expect(inferAcpInsightClient(baseAgent({ id: 'my-claude-assistant', command: 'custom-script' }))).toBeNull();
    expect(inferAcpInsightClient(baseAgent({ id: 'mystery', command: 'mystery-bin' }))).toBeNull();
  });

  it('resolves non-secret data roots only from the supplied child env', () => {
    expect(acpDataRoot('codex', { CODEX_HOME: '/x/codex' })).toBe('/x/codex');
    expect(acpDataRoot('claude', { CLAUDE_CONFIG_DIR: '/x/claude' })).toBe('/x/claude');
    expect(acpDataRoot('traex', { TRAE_HOME: '/x/trae' })).toBe('/x/trae');
    expect(acpDataRoot('codex', { HOME: '/home/u' })).toBe(join('/home/u', '.codex'));
    expect(acpDataRoot('claude', {})).toBe(join(homedir(), '.claude'));
    // 显式子进程 HOME override：默认根与带 ~ 的配置都必须落在新 HOME 下，
    // 与 pty-driver cli-paths 在 agent.env 改 HOME 时的语义一致。
    const overridden = { HOME: '/sandbox/home' };
    expect(acpDataRoot('codex', overridden)).toBe('/sandbox/home/.codex');
    expect(acpDataRoot('claude', { ...overridden, CLAUDE_CONFIG_DIR: '~/.claude' })).toBe('/sandbox/home/.claude');
    expect(acpDataRoot('traex', { ...overridden, TRAE_HOME: '~/custom/trae' })).toBe('/sandbox/home/custom/trae');
  });

  it('direct launch merges persisted snake_case env over a clean inherited env', () => {
    const launch = { command: [process.execPath, fixture], sessionOptions: { env: { custom_home: '/direct' } } };
    const env = resolveAcpChildEnvironment(baseAgent({ env: { custom_home: '/direct' } }), launch, launcherPath);
    expect(env.custom_home).toBe('/direct');
    expect(env).not.toHaveProperty('dutydeck_agent_env_file');
  });

  it('bridge launch reconstructs agent.env and drops the carrier keys without leaking them as persisted data', () => {
    const launch = {
      command: [process.execPath, launcherPath, process.execPath, fixture],
      sessionOptions: { env: { dutydeck_agent_env_file: '/tmp/carrier.json', lower_key: 'v' } }
    };
    const env = resolveAcpChildEnvironment(
      baseAgent({ env: { UPPER_VENDOR_TOKEN: 'secret', lower_key: 'v' } }),
      launch,
      launcherPath
    );
    expect(env.UPPER_VENDOR_TOKEN).toBe('secret');
    expect(env.lower_key).toBe('v');
    expect(env).not.toHaveProperty('dutydeck_agent_env_file');
    expect(env).not.toHaveProperty('dutydeck_agent_env_digest');
  });

  it('marks launch_observed only for create with evidence, inferred otherwise; native observation never fakes a CLI id', () => {
    const created = buildLaunchObservation({ client: 'codex', launchKind: 'created', observed: true, dataRoot: '/r', cwd: '/c' });
    // adapter 对 attach 一律传 observed=false，即使读到了当前附着进程 env。
    const attached = buildLaunchObservation({ client: 'codex', launchKind: 'attached', observed: false, dataRoot: '/r', cwd: '/c' });
    const weak = buildLaunchObservation({ client: 'codex', launchKind: 'created', observed: false, dataRoot: '/r', cwd: '/c' });
    expect(created.proofKind).toBe('launch_observed');
    expect(attached.proofKind).toBe('inferred');
    expect(weak.proofKind).toBe('inferred');
    const noCli = buildNativeObservation({ client: 'codex', launchKind: 'created', observed: true, dataRoot: '/r', cwd: '/c' });
    expect(noCli.nativeSessionId).toBeNull();
    expect(noCli.identityProof).toBeNull();
    const withCli = buildNativeObservation({ client: 'codex', launchKind: 'created', observed: true, dataRoot: '/r', cwd: '/c', agentSessionId: 'cli-1' });
    expect(withCli.nativeSessionId).toBe('cli-1');
    expect(withCli.identityProof).toBe('acpx_agent_session_meta');
  });
});
