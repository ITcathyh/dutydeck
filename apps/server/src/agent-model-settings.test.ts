import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRuntimeStore } from 'acpx/runtime';
import { createRepositories } from '@dutydeck/storage';
import { agentConfigSchema } from '@dutydeck/shared';
import { LocalFileSecretProvider, secretDirectoryForDatabase } from '@dutydeck/secret-provider';
import { AcpxAdapter } from '@dutydeck/acp-client';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { AgentModelSettings } from './agent-model-settings.js';
import { buildApp } from './app.js';
import { runSettingsCli } from './settings-cli.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); vi.unstubAllEnvs(); });
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'dd-model-settings-'));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const database = join(cwd, 'test.sqlite');
  const repos = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
  cleanups.push(() => repos.close());
  const provider = new LocalFileSecretProvider(secretDirectoryForDatabase(database), { createDirectory: true });
  const agent = agentConfigSchema.parse({ id: 'claude', name: 'Claude', command: process.execPath, args: [resolve('tests/fixtures/mock-acp-agent.mjs')], protocol: 'acp', cwd, env: { existing: 'keep' }, model: 'original' });
  await repos.agents.save(agent);
  const settings = new AgentModelSettings(repos, [agent], provider);
  return { cwd, database, repos, provider, agent, settings };
}

it('persists defaults and private credentials, retains blank/omitted keys, rotates and clears without exposing values', async () => {
  const { repos, provider, agent, settings } = await fixture();
  const saved = await settings.set('claude', { model: 'custom-model', baseUrl: 'https://gateway.example/claude', apiKey: 'KEY_CANARY' });
  expect(saved).toMatchObject({ model: 'custom-model', authMode: 'bearer', hasApiKey: true, apiKeyAvailable: true });
  expect(JSON.stringify(saved)).not.toContain('KEY_CANARY');
  expect(await repos.config.get('dutydeck.agent_model.claude')).not.toContain('KEY_CANARY');
  expect(JSON.stringify(await repos.agents.list())).not.toContain('KEY_CANARY');
  const fresh = new AgentModelSettings(repos, [agent], provider);
  expect(await fresh.get('claude')).toEqual(saved);
  expect((await fresh.defaultsForBoot([agent]))[0].model).toBe('custom-model');
  expect((await fresh.resolve(agent)).env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'KEY_CANARY', ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_USE_BEDROCK: '0', ANTHROPIC_BASE_URL: 'https://gateway.example/claude', existing: 'keep' });
  await fresh.set('claude', { model: 'next' });
  expect((await fresh.resolve(agent)).env.ANTHROPIC_AUTH_TOKEN).toBe('KEY_CANARY');
  await fresh.set('claude', { apiKey: 'ROTATED_KEY', authMode: 'api-key' });
  expect((await fresh.resolve(agent)).env).toMatchObject({ ANTHROPIC_API_KEY: 'ROTATED_KEY', ANTHROPIC_AUTH_TOKEN: '' });
  const stored = JSON.parse((await repos.config.get('dutydeck.agent_model.claude'))!);
  expect((await stat(join(provider.directory, `${stored.referenceKey}.secret`))).mode & 0o777).toBe(0o600);
  await fresh.set('claude', { clearApiKey: true });
  expect((await fresh.resolve({ ...agent, env: { ANTHROPIC_AUTH_TOKEN: 'cli-login' } })).env).toEqual({ ANTHROPIC_AUTH_TOKEN: 'cli-login' });
  await fresh.set('claude', { model: '', baseUrl: '' });
  expect(await fresh.get('claude')).toMatchObject({ model: 'original', baseUrl: '', hasApiKey: false });
  expect((await fresh.resolve(agent)).env).toEqual(agent.env);
  expect(provider.inspect(stored.referenceKey).availability).toBe('missing');
});

it('validates service addresses, auth modes and mutually exclusive key actions before writing', async () => {
  const { repos, settings } = await fixture();
  for (const patch of [{ baseUrl: 'file:///tmp' }, { baseUrl: 'https://name:password@example.com' }, { baseUrl: 'https://example.com?key=secret' }, { authMode: 'unknown' }, { apiKey: 'key', clearApiKey: true }, { apiKey: '' }, { apiKey: 'secret\0value' }, { apiKey: 'secret\nvalue' }, { apiKey: 'secret value' }]) await expect(settings.set('claude', patch)).rejects.toThrow();
  expect(await repos.config.get('dutydeck.agent_model.claude')).toBeUndefined();
  await expect(settings.get('codex')).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
});

it('CLI saves through the real authorized routes and every read stays redacted', async () => {
  const { settings, repos } = await fixture();
  const app = await buildApp({ listAgents: () => repos.agents.list() } as any, { agentModelSettings: settings, sessionNames: { authorize: async () => true } });
  cleanups.push(() => app.close());
  const fetcher = vi.fn(async (url: URL | string | Request, init?: RequestInit) => {
    const response = await app.inject({ method: init?.method as 'GET', url: new URL(String(url)).pathname, payload: init?.body as string, headers: init?.headers as Record<string, string> });
    return new Response(response.body, { status: response.statusCode });
  });
  const target = { agentId: 'claude', url: 'http://127.0.0.1:4310', database: '/tmp/runtime.db' };
  const dependencies = { fetcher, readToken: () => undefined };
  expect(await runSettingsCli('agent-set', { ...target, pairs: ['model=proxy-model', 'baseUrl=https://proxy.example', 'authMode=api-key'], apiKey: 'CLI_CANARY' }, dependencies)).toMatchObject({ hasApiKey: true, model: 'proxy-model' });
  expect(JSON.stringify(await runSettingsCli('agent-show', target, dependencies))).not.toContain('CLI_CANARY');
  expect((await app.inject('/api/agents')).body).not.toContain('CLI_CANARY');
  await runSettingsCli('agent-set', { ...target, pairs: ['clearApiKey=true', 'baseUrl='] }, dependencies);
  expect(await settings.get('claude')).toMatchObject({ hasApiKey: false, baseUrl: '' });
  const invalid = await app.inject({ method: 'PUT', url: '/api/agents/claude/model-settings', payload: { apiKey: 'SECRET_CANARY\0value' } });
  expect(invalid.statusCode).toBe(400); expect(invalid.body).not.toContain('SECRET_CANARY');
  const forbidden = await buildApp({} as any, { agentModelSettings: settings }); cleanups.push(() => forbidden.close());
  expect((await forbidden.inject('/api/agents/claude/model-settings')).statusCode).toBe(403);
  expect((await forbidden.inject({ method: 'PUT', url: '/api/agents/claude/model-settings', payload: { apiKey: 'denied' } })).statusCode).toBe(403);
});

it.each(['bearer', 'api-key'] as const)('injects %s credentials using a real AcpxAdapter and persistent session key without persisting vendor values', async authMode => {
  const { settings, agent, cwd } = await fixture();
  await settings.set('claude', { apiKey: 'ACP_KEY_CANARY', baseUrl: 'https://gateway.example', authMode });
  const output = join(cwd, 'env.jsonl'), script = join(cwd, 'report.mjs');
  await writeFile(script, `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(output)}, JSON.stringify({ key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN, base: process.env.ANTHROPIC_BASE_URL, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN, cloud: process.env.CLAUDE_CODE_USE_BEDROCK })+'\\n');await import(${JSON.stringify(resolve('tests/fixtures/mock-acp-agent.mjs'))});`);
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'ambient-token'); vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
  const config = await settings.resolve({ ...agent, model: undefined, args: [script] });
  const sessionKey = `model-settings-${authMode}`;
  let adapter: AcpxAdapter | undefined;
  try {
    let nativeId: string | undefined;
    for (let pass = 0; pass < 2; pass++) {
      adapter = new AcpxAdapter(config, { sessionKey, onEvent() {} });
      await adapter.start(); await adapter.send('hello'); await adapter.stop();
      const record = (await createRuntimeStore({ stateDir: join(cwd, '.dutydeck', 'acpx') }).load(sessionKey))!;
      expect(JSON.stringify(record.acpx?.session_options)).not.toContain('ACP_KEY_CANARY');
      expect(Object.keys(record.acpx!.session_options!.env!).every(key => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key))).toBe(true);
      if (pass === 0) nativeId = record.acpSessionId;
      else expect(record.acpSessionId).toBe(nativeId);
    }
    const reports = (await readFile(output, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(reports.length).toBeGreaterThanOrEqual(2);
    for (const report of reports) expect(report).toEqual({ key: authMode === 'api-key' ? 'ACP_KEY_CANARY' : '', token: authMode === 'bearer' ? 'ACP_KEY_CANARY' : '', base: 'https://gateway.example', oauth: '', cloud: '0' });
  } finally { await adapter?.stop(); }
});

it('runtime resolves launch-only env and keeps secrets out of agent and execution records', async () => {
  const { settings, agent, repos } = await fixture();
  await settings.set('claude', { apiKey: 'RUNTIME_KEY_CANARY' });
  const launched: typeof agent[] = [];
  const runtime = new DutydeckRuntime(repos, { configureAgent: agent => settings.resolve(agent), driverIdleTimeoutMs: 0, probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: config => { launched.push(config); return { start: async () => {}, send: async () => {}, stop: async () => {}, interrupt: async () => {}, resume: async () => {}, isStopped: async () => true }; } });
  cleanups.push(() => runtime.shutdown());
  await runtime.initialize(await settings.defaultsForBoot([agent]));
  const session = await runtime.start({ agentId: 'claude' });
  expect(launched.at(-1)!.env.ANTHROPIC_AUTH_TOKEN).toBe('RUNTIME_KEY_CANARY');
  expect(JSON.stringify(await repos.agents.list())).not.toContain('RUNTIME_KEY_CANARY');
  expect(JSON.stringify(await repos.sessions.get(session.id))).not.toContain('RUNTIME_KEY_CANARY');
  expect(JSON.stringify(await repos.config.list?.(''))).not.toContain('RUNTIME_KEY_CANARY');
});

it('recovers by reentering a key when the existing secret file is unreadable', async () => {
  const { settings, repos, provider, agent } = await fixture();
  await settings.set('claude', { apiKey: 'old-key' });
  const old = JSON.parse((await repos.config.get('dutydeck.agent_model.claude'))!);
  await chmod(join(provider.directory, `${old.referenceKey}.secret`), 0o644);
  expect(await settings.get('claude')).toMatchObject({ hasApiKey: true, apiKeyAvailable: false });
  await settings.set('claude', { apiKey: 'new-key' });
  expect(await settings.get('claude')).toMatchObject({ apiKeyAvailable: true });
  expect((await settings.resolve(agent)).env.ANTHROPIC_AUTH_TOKEN).toBe('new-key');
  await settings.set('claude', { clearApiKey: true });
  await settings.set('claude', { apiKey: 'after-clear' });
  expect((await settings.resolve(agent)).env.ANTHROPIC_AUTH_TOKEN).toBe('after-clear');
});

it('does not construct a late driver after stop revokes an asynchronous config resolution', async () => {
  const { agent, repos } = await fixture();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const factory = vi.fn(() => ({ start: async () => {}, send: async () => {}, stop: async () => {}, interrupt: async () => {}, resume: async () => {}, isStopped: async () => true }));
  const runtime = new DutydeckRuntime(repos, { configureAgent: async config => { enter(); await gate; return config; }, driverIdleTimeoutMs: 0, probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: factory });
  cleanups.push(() => runtime.shutdown());
  await runtime.initialize([agent]);
  const starting = runtime.start({ agentId: 'claude' }).catch(error => error);
  await entered;
  const session = (await repos.sessions.list())[0];
  await runtime.stop(session.id);
  const result = await starting;
  expect(result).toMatchObject({ code: 'OPERATION_REVOKED' });
  release(); await gate; await Promise.resolve();
  expect(factory).not.toHaveBeenCalled();
  expect((await repos.sessions.get(session.id))!.state).toBe('stopped');
});

it('preserves the surviving driver and events when simultaneous resumes finish asynchronous config resolution', async () => {
  const { agent, repos } = await fixture();
  let gate: Promise<void> | undefined, release!: () => void, entered!: () => void;
  let waiting = 0;
  const both = new Promise<void>(resolve => { entered = resolve; });
  const factories: Array<{ emit: (event: any) => void }> = [];
  const runtime = new DutydeckRuntime(repos, { configureAgent: async config => { if (gate) { if (++waiting === 2) entered(); await gate; } return config; }, driverIdleTimeoutMs: 1, cleanupIntervalMs: 0, probe: () => ({ protocol: 'jsonl', available: true, pause: false, resume: true }), driverFactory: (_config, _protocol, emit) => { factories.push({ emit }); return { start: async () => {}, send: async () => {}, stop: async () => {}, interrupt: async () => {}, resume: async () => {}, isStopped: async () => true }; } });
  cleanups.push(() => runtime.shutdown());
  await runtime.initialize([{ ...agent, protocol: 'jsonl' }]);
  const session = await runtime.start({ agentId: 'claude' });
  await runtime.cleanupIdleDrivers(Date.now() + 100);
  gate = new Promise<void>(resolve => { release = resolve; });
  const first = runtime.resume(session.id), second = runtime.resume(session.id);
  await both; release();
  const results = await Promise.allSettled([first, second]);
  expect(results[0].status).toBe('fulfilled');
  expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'SESSION_RESOURCE_BLOCKED' } });
  expect(factories).toHaveLength(2);
  factories[1].emit({ type: 'text', data: { text: 'resumed driver remains current' } });
  await vi.waitFor(async () => expect((await runtime.getEvents(session.id)).some(event => (event.data as { text?: string }).text === 'resumed driver remains current')).toBe(true));
});
