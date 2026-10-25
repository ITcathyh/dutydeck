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

it('restores a persisted Codex profile before runtime initialization rewrites agents', async () => {
  const { repos, settings, agent } = await fixture();
  await repos.agents.save({ ...agent, id: 'codex', adapterId: 'codex', codexProfile: 'review.safe' });
  const configured = { ...agent, id: 'codex', adapterId: 'codex', codexProfile: undefined };
  expect((await settings.defaultsForBoot([configured]))[0].codexProfile).toBe('review.safe');
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

it('persists and returns the Codex profile through the owner-only agent config route', async () => {
  const { repos, settings, agent } = await fixture();
  const profileRoot = await mkdtemp(join('/tmp', 'dutydeck-codex-profile-route-'));
  cleanups.push(() => rm(profileRoot, { recursive: true, force: true }));
  await writeFile(join(profileRoot, 'config.toml'), '[profiles.review.safe]\nmodel = "hidden"\n');
  const codex = agentConfigSchema.parse({ ...agent, id: 'codex', name: 'Codex', adapterId: 'codex', protocol: 'pty-cli', env: { CODEX_HOME: profileRoot }, codexProfile: undefined });
  await repos.agents.save(codex);
  const runtime = { listAgents: () => repos.agents.list() } as any;
  const app = await buildApp(runtime, { agentModelSettings: settings, lark: { agents: repos.agents, listeningDisabled: true }, sessionNames: { authorize: async () => true } });
  cleanups.push(() => app.close());
  const saved = await app.inject({ method: 'PATCH', url: '/api/agents/codex/config', payload: { codexProfile: 'review.safe' } });
  expect(saved.statusCode).toBe(200);
  expect(saved.json().codexProfile).toBe('review.safe');
  expect((await app.inject('/api/agents/codex/config')).json()).toEqual({ id: 'codex', codexProfile: 'review.safe' });
  expect((await app.inject('/api/agents')).body).toContain('review.safe');
  const unknown = await app.inject({ method: 'PATCH', url: '/api/agents/codex/config', payload: { codexProfile: 'missing' } });
  expect(unknown.statusCode).toBe(400);
  const unsupported = await app.inject({ method: 'PATCH', url: '/api/agents/claude/config', payload: { codexProfile: 'bad' } });
  expect(unsupported.statusCode).toBe(400);
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
  expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  expect(results.find(result => result.status === 'rejected')).toMatchObject({ status: 'rejected', reason: { code: 'SESSION_RESOURCE_BLOCKED' } });
  expect(factories).toHaveLength(2);
  factories[1].emit({ type: 'text', data: { text: 'resumed driver remains current' } });
  await vi.waitFor(async () => expect((await runtime.getEvents(session.id)).some(event => (event.data as { text?: string }).text === 'resumed driver remains current')).toBe(true));
});

it('keeps bot gateway accounts separate from each other and shared settings, including rotation and clearing', async () => {
  const { settings, agent, repos, provider } = await fixture();
  await settings.set('claude', { baseUrl: 'https://shared.example', apiKey: 'SHARED_CANARY', model: 'shared-model' });
  const shared = await repos.agents.get('claude');
  await settings.set('claude', { baseUrl: 'https://a.example', apiKey: 'BOT_A_CANARY' }, 'cli_a');
  await settings.set('claude', { baseUrl: 'https://b.example', apiKey: 'BOT_B_CANARY', authMode: 'api-key' }, 'cli_b');
  expect(await repos.agents.get('claude')).toEqual(shared);
  expect((await settings.resolve(agent, 'cli_a')).env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://a.example', ANTHROPIC_AUTH_TOKEN: 'BOT_A_CANARY', ANTHROPIC_API_KEY: '' });
  expect((await settings.resolve(agent, 'cli_b')).env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://b.example', ANTHROPIC_API_KEY: 'BOT_B_CANARY', ANTHROPIC_AUTH_TOKEN: '' });
  expect((await settings.resolve(agent)).env.ANTHROPIC_AUTH_TOKEN).toBe('SHARED_CANARY');
  expect((await settings.resolve(agent, 'cli_unconfigured')).env.ANTHROPIC_AUTH_TOKEN).toBe('SHARED_CANARY');
  await settings.set('claude', { apiKey: 'BOT_A_ROTATED' }, 'cli_a');
  expect((await settings.resolve(agent, 'cli_a')).env.ANTHROPIC_AUTH_TOKEN).toBe('BOT_A_ROTATED');
  await settings.set('claude', { clearApiKey: true }, 'cli_a');
  expect((await settings.resolve(agent, 'cli_a')).env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://shared.example', ANTHROPIC_AUTH_TOKEN: 'SHARED_CANARY' });
  expect((await settings.resolve(agent, 'cli_b')).env.ANTHROPIC_API_KEY).toBe('BOT_B_CANARY');
  await expect(settings.set('claude', { model: 'bot-model' }, 'cli_b')).rejects.toMatchObject({ code: 'BOT_MODEL_SETTING_REQUIRED' });
  const serialized = JSON.stringify([await repos.config.list?.(''), await settings.get('claude', 'cli_a'), await settings.get('claude', 'cli_b'), await repos.agents.list()]);
  for (const secret of ['SHARED_CANARY', 'BOT_A_CANARY', 'BOT_A_ROTATED', 'BOT_B_CANARY']) expect(serialized).not.toContain(secret);
  const storedB = JSON.parse((await repos.config.get('dutydeck.bot_agent_model.cli_b.claude'))!);
  await settings.clearBot('cli_b');
  expect(provider.inspect(storedB.referenceKey).availability).toBe('missing');
  expect((await settings.resolve(agent, 'cli_b')).env.ANTHROPIC_AUTH_TOKEN).toBe('SHARED_CANARY');
});

it('uses unambiguous bot and agent scope keys even when identifiers contain dots', async () => {
  const { settings, agent, repos, provider } = await fixture();
  const other = { ...agent, id: 'b.claude', adapterId: 'claude' };
  await repos.agents.save(other);
  const scoped = new AgentModelSettings(repos, [agent, other], provider);
  await scoped.set('claude', { apiKey: 'DOT_A' }, 'a.b');
  await scoped.set('b.claude', { apiKey: 'DOT_B' }, 'a');
  expect((await scoped.resolve(agent, 'a.b')).env.ANTHROPIC_AUTH_TOKEN).toBe('DOT_A');
  expect((await scoped.resolve(other, 'a')).env.ANTHROPIC_AUTH_TOKEN).toBe('DOT_B');
  await scoped.clearBot('a');
  expect((await scoped.resolve(agent, 'a.b')).env.ANTHROPIC_AUTH_TOKEN).toBe('DOT_A');
  expect((await settings.get('claude')).hasApiKey).toBe(false);
});

it('moves bot-scoped settings when a bot is renamed, carrying the shared secret file and removing only the orphaned override', async () => {
  const { settings, repos, agent, provider } = await fixture();
  await settings.set('claude', { baseUrl: 'https://moved.example', authMode: 'bearer', apiKey: 'MOVED_CANARY' }, 'cli_old');
  await settings.set('claude', { baseUrl: 'https://kept.example', authMode: 'api-key', apiKey: 'KEPT_CANARY' }, 'cli_new');
  const movedKey = JSON.parse((await repos.config.get('dutydeck.bot_agent_model.cli_old.claude'))!).referenceKey;
  const keptKey = JSON.parse((await repos.config.get('dutydeck.bot_agent_model.cli_new.claude'))!).referenceKey;
  await settings.renameBot('cli_old', 'cli_new');
  expect(await repos.config.get('dutydeck.bot_agent_model.cli_old.claude')).toBe('{}');
  expect((await settings.resolve(agent, 'cli_new')).env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://kept.example', ANTHROPIC_API_KEY: 'KEPT_CANARY' });
  expect(provider.inspect(keptKey).availability).toBe('available');
  expect(provider.inspect(movedKey).availability).toBe('missing');
  // 目标作用域空闲时设置连同密钥引用一起搬走，密钥文件本身不删。
  await settings.set('claude', { baseUrl: 'https://moved.example', authMode: 'bearer', apiKey: 'MOVED_CANARY' }, 'cli_old');
  await settings.renameBot('cli_old', 'cli_empty');
  expect(await repos.config.get('dutydeck.bot_agent_model.cli_old.claude')).toBe('{}');
  expect((await settings.resolve(agent, 'cli_empty')).env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://moved.example', ANTHROPIC_AUTH_TOKEN: 'MOVED_CANARY' });
  // 含点号的 appId/agent id 编解码往返一致。
  const other = { ...agent, id: 'b.claude', adapterId: 'claude' };
  await repos.agents.save(other);
  const dotted = new AgentModelSettings(repos, [agent, other], provider);
  await dotted.set('b.claude', { apiKey: 'DOT_MOVE' }, 'a.b');
  await dotted.renameBot('a.b', 'c.d');
  expect(await repos.config.get('dutydeck.bot_agent_model.a%2Eb.b%2Eclaude')).toBe('{}');
  expect((await dotted.resolve(other, 'c.d')).env.ANTHROPIC_AUTH_TOKEN).toBe('DOT_MOVE');
});

it('carries bot-scoped model settings to the new appId when renaming a bot through HTTP', async () => {
  const { settings, repos, agent } = await fixture();
  await repos.config.set('lark.bots', JSON.stringify([{ appId: 'cli_old', appSecret: 'synthetic', defaultAgentId: 'claude', permissionMode: 'ask', listening: false }]));
  const runtime = { listAgents: () => repos.agents.list() } as any;
  const app = await buildApp(runtime, { agentModelSettings: settings, lark: { config: repos.config, agents: repos.agents, listeningDisabled: true }, sessionNames: { authorize: async () => true } });
  cleanups.push(() => app.close());
  await settings.set('claude', { baseUrl: 'https://route.example', apiKey: 'ROUTE_MOVE' }, 'cli_old');
  const renamed = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_old', appId: 'cli_new' } });
  expect(renamed.statusCode).toBe(200);
  expect(renamed.json().bots.map((bot: { appId: string }) => bot.appId)).toEqual(['cli_new']);
  expect((await settings.resolve(agent, 'cli_new')).env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://route.example', ANTHROPIC_AUTH_TOKEN: 'ROUTE_MOVE' });
  expect(await repos.config.get('dutydeck.bot_agent_model.cli_old.claude')).toBe('{}');
  const returned = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_new', appId: 'cli_old' } });
  expect(returned.statusCode).toBe(200);
  expect((await settings.resolve(agent, 'cli_old')).env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://route.example', ANTHROPIC_AUTH_TOKEN: 'ROUTE_MOVE' });
});

it('CLI and bot routes require an owner and an existing bot, save independently, and remove its secret files', async () => {
  const { settings, repos, agent, provider } = await fixture();
  await repos.config.set('lark.bots', JSON.stringify([{ appId: 'cli_a', appSecret: 'synthetic', defaultAgentId: 'claude', permissionMode: 'ask', listening: false }]));
  const options = { agentModelSettings: settings, lark: { config: repos.config, agents: repos.agents, listeningDisabled: true } };
  const runtime = { listAgents: () => repos.agents.list() } as any;
  const app = await buildApp(runtime, { ...options, sessionNames: { authorize: async () => true } });
  cleanups.push(() => app.close());
  const fetcher = vi.fn(async (url: URL | string | Request, init?: RequestInit) => {
    const response = await app.inject({ method: init?.method as 'GET', url: new URL(String(url)).pathname, payload: init?.body as string, headers: init?.headers as Record<string, string> });
    return new Response(response.body, { status: response.statusCode });
  });
  const target = { agentId: 'claude', appId: 'cli_a', url: 'http://127.0.0.1:4310', database: '/tmp/runtime.db' };
  const dependencies = { fetcher, readToken: () => undefined };
  expect(await runSettingsCli('agent-set', { ...target, pairs: ['baseUrl=https://bot.example', 'authMode=api-key'], apiKey: 'BOT_CLI_CANARY' }, dependencies)).toMatchObject({ appId: 'cli_a', hasApiKey: true });
  expect((await settings.resolve(agent, 'cli_a')).env.ANTHROPIC_API_KEY).toBe('BOT_CLI_CANARY');
  expect((await settings.get('claude')).hasApiKey).toBe(false);
  expect(JSON.stringify(await runSettingsCli('agent-show', target, dependencies))).not.toContain('BOT_CLI_CANARY');
  expect((await app.inject('/api/agents')).body).not.toContain('BOT_CLI_CANARY');
  const endpoint = '/api/lark/bots/cli_a/agents/claude/model-settings';
  const invalid = await app.inject({ method: 'PUT', url: endpoint, payload: { apiKey: 'BOT_SECRET_CANARY\u0000' } });
  expect(invalid.statusCode).toBe(400); expect(invalid.body).not.toContain('BOT_SECRET_CANARY');
  expect((await app.inject('/api/lark/bots/missing/agents/claude/model-settings')).statusCode).toBe(404);
  expect((await app.inject({ method: 'PUT', url: '/api/lark/bots/missing/agents/claude/model-settings', payload: { apiKey: 'never-saved' } })).statusCode).toBe(404);
  const forbidden = await buildApp(runtime, options); cleanups.push(() => forbidden.close());
  expect((await forbidden.inject(endpoint)).statusCode).toBe(403);
  expect((await forbidden.inject({ method: 'PUT', url: endpoint, payload: { apiKey: 'denied' } })).statusCode).toBe(403);
  expect((await forbidden.inject('/api/lark/bots/cli_a/agents/claude/models')).statusCode).toBe(403);
  const saved = JSON.parse((await repos.config.get('dutydeck.bot_agent_model.cli_a.claude'))!);
  const removed = await app.inject({ method: 'DELETE', url: '/api/lark/config/cli_a' });
  expect(removed.statusCode).toBe(200);
  expect(provider.inspect(saved.referenceKey).availability).toBe('missing');
  expect((await app.inject(endpoint)).statusCode).toBe(404);
});

it('runtime selects bot accounts for chats, background and child sessions, preserves explicit models, and resolves new keys on resume', async () => {
  const { settings, agent, repos } = await fixture();
  await settings.set('claude', { apiKey: 'ROOT_CANARY' }, 'cli_a');
  await settings.set('claude', { apiKey: 'OTHER_CANARY' }, 'cli_b');
  const launched: typeof agent[] = [];
  const parentIds = new Map<string, string>();
  const parentOf = async (id: string) => parentIds.has(id) ? { parentSessionId: parentIds.get(id)! } : undefined;
  const runtime = new DutydeckRuntime(repos, { configureAgent: (config, session) => settings.resolveForSession(config, session, parentOf), driverIdleTimeoutMs: 1, cleanupIntervalMs: 0, probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: config => { launched.push(config); return { start: async () => {}, send: async () => {}, stop: async () => {}, interrupt: async () => {}, resume: async () => {}, isStopped: async () => true }; } });
  cleanups.push(() => runtime.shutdown());
  await runtime.initialize([agent]);
  const root = await runtime.start({ agentId: 'claude', source: 'lark', sourceId: 'cli_a:ou_owner:p2p', model: 'bot-model' });
  expect(launched.at(-1)).toMatchObject({ model: 'bot-model', env: { ANTHROPIC_AUTH_TOKEN: 'ROOT_CANARY' } });
  for (const [source, sourceId] of [['lark-memory', 'cli_a:groups:memory'], ['lark-decision', 'cli_a:oc_group'], ['lark-response', 'cli_a:oc_group'], ['plugin_trigger', 'cli_a:oc_group:plugin:hello:ping']]) {
    await runtime.start({ agentId: 'claude', source, sourceId });
    expect(launched.at(-1)!.env.ANTHROPIC_AUTH_TOKEN).toBe('ROOT_CANARY');
  }
  // Parent lookup is also the path used by persisted work-item/Leader bindings.
  const leader = await runtime.start({ agentId: 'claude', source: 'lark-leader', sourceId: 'opaque-delegation' });
  parentIds.set(leader.id, root.id); parentIds.set('child', leader.id);
  expect((await settings.resolveForSession(agent, { ...root, id: 'child', source: 'work_item', sourceId: 'opaque-attempt' }, parentOf)).env.ANTHROPIC_AUTH_TOKEN).toBe('ROOT_CANARY');
  await runtime.start({ agentId: 'claude', source: 'lark', sourceId: 'cli_b:ou_owner:p2p' });
  expect(launched.at(-1)!.env.ANTHROPIC_AUTH_TOKEN).toBe('OTHER_CANARY');
  await runtime.start({ agentId: 'claude' });
  expect(launched.at(-1)!.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  await runtime.cleanupIdleDrivers(Date.now() + 100);
  await settings.set('claude', { apiKey: 'ROOT_ROTATED' }, 'cli_a');
  await runtime.resume(root.id);
  expect(launched.at(-1)).toMatchObject({ model: 'bot-model', env: { ANTHROPIC_AUTH_TOKEN: 'ROOT_ROTATED' } });
  const stored = JSON.stringify([await repos.agents.list(), await repos.sessions.list(), await repos.config.list?.('')]);
  for (const key of ['ROOT_CANARY', 'ROOT_ROTATED', 'OTHER_CANARY']) expect(stored).not.toContain(key);
});

it('real AcpxAdapter persists and reopens separate bot sessions without secrets or vendor keys in session options', async () => {
  const { settings, agent, cwd } = await fixture();
  const output = join(cwd, 'bot-env.jsonl'), script = join(cwd, 'bot-report.mjs');
  await writeFile(script, `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(output)}, JSON.stringify({ key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN, base: process.env.ANTHROPIC_BASE_URL })+'\\n');await import(${JSON.stringify(resolve('tests/fixtures/mock-acp-agent.mjs'))});`);
  const bots = [{ appId: 'cli_a', apiKey: 'ACPX_BOT_A', baseUrl: 'https://a.example', authMode: 'bearer' as const }, { appId: 'cli_b', apiKey: 'ACPX_BOT_B', baseUrl: 'https://b.example', authMode: 'api-key' as const }];
  for (const { appId, ...patch } of bots) await settings.set('claude', patch, appId);
  for (const bot of bots) {
    const sessionKey = `bot-model-${bot.appId}`;
    let nativeId: string | undefined;
    for (let pass = 0; pass < 2; pass++) {
      const config = await settings.resolve({ ...agent, model: undefined, args: [script] }, bot.appId);
      const adapter = new AcpxAdapter(config, { sessionKey, onEvent() {} });
      try { await adapter.start(); await adapter.send('hello'); } finally { await adapter.stop(); }
      const record = (await createRuntimeStore({ stateDir: join(cwd, '.dutydeck', 'acpx') }).load(sessionKey))!;
      const options = record.acpx!.session_options!;
      expect(JSON.stringify(options)).not.toContain(bot.apiKey);
      expect(Object.keys(options.env!).every(key => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key))).toBe(true);
      if (pass === 0) nativeId = record.acpSessionId;
      else expect(record.acpSessionId).toBe(nativeId);
    }
  }
  const reports = (await readFile(output, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  for (const bot of bots) {
    const matches = reports.filter(report => report.base === bot.baseUrl);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    for (const report of matches) expect(report).toEqual({ key: bot.authMode === 'api-key' ? bot.apiKey : '', token: bot.authMode === 'bearer' ? bot.apiKey : '', base: bot.baseUrl });
  }
});


it('renames back into a tombstone without losing settings or the real secret file', async () => {
  const { settings, repos, provider, agent } = await fixture();
  await settings.set('claude', { baseUrl: 'https://roundtrip.example', authMode: 'api-key', apiKey: 'ROUNDTRIP' }, 'a');
  const original = await repos.config.get('dutydeck.bot_agent_model.a.claude');
  const reference = JSON.parse(original!).referenceKey;
  await settings.renameBot('a', 'b');
  await settings.renameBot('b', 'a');
  expect(await repos.config.get('dutydeck.bot_agent_model.a.claude')).toBe(original);
  expect(provider.inspect(reference).availability).toBe('available');
  expect((await settings.resolve(agent, 'a')).env.ANTHROPIC_API_KEY).toBe('ROUNDTRIP');
  await settings.set('claude', { apiKey: 'DISCARD' }, 'b');
  await settings.clearBot('b');
  await settings.renameBot('a', 'b');
  expect(await repos.config.get('dutydeck.bot_agent_model.b.claude')).toBe(original);
  expect((await settings.resolve(agent, 'b')).env.ANTHROPIC_API_KEY).toBe('ROUNDTRIP');
  await settings.renameBot('b', 'b');
  expect(await repos.config.get('dutydeck.bot_agent_model.b.claude')).toBe(original);
});

it.each([undefined, 'bot-a'])('serializes concurrent patches and key deletion in scope %s', async appId => {
  const { settings, repos, provider, agent } = await fixture();
  const second = new AgentModelSettings(repos, [agent], provider);
  await settings.set('claude', { apiKey: 'OLD_KEY' }, appId);
  await Promise.all([
    settings.set('claude', { clearApiKey: true }, appId),
    second.set('claude', { baseUrl: 'https://concurrent.example' }, appId),
    settings.set('claude', { authMode: 'api-key' }, appId)
  ]);
  expect(await settings.get('claude', appId)).toMatchObject({ baseUrl: 'https://concurrent.example', authMode: 'api-key', hasApiKey: false, apiKeyAvailable: false });
  expect((await settings.resolve(agent, appId)).env).toEqual(agent.env);
  await Promise.all([settings.set('claude', { apiKey: 'NEW_KEY' }, appId), second.set('claude', { clearApiKey: true }, appId)]);
  expect((await settings.get('claude', appId)).hasApiKey).toBe(false);
  await Promise.all([settings.set('claude', { clearApiKey: true }, appId), second.set('claude', { apiKey: 'LAST_KEY' }, appId)]);
  expect((await settings.resolve(agent, appId)).env.ANTHROPIC_API_KEY).toBe('LAST_KEY');
});

it('coordinates clear and rename with patches while preserving separate scope credentials', async () => {
  const { settings, agent } = await fixture();
  await settings.set('claude', { apiKey: 'GLOBAL' });
  await settings.set('claude', { apiKey: 'BOT_A' }, 'a');
  await settings.set('claude', { apiKey: 'BOT_B' }, 'b');
  await Promise.all([settings.set('claude', { baseUrl: 'https://clear.example' }, 'a'), settings.clearBot('a')]);
  expect((await settings.get('claude', 'a')).hasApiKey).toBe(false);
  await Promise.all([settings.set('claude', { baseUrl: 'https://rename.example' }, 'b'), settings.renameBot('b', 'a')]);
  expect((await settings.resolve(agent, 'a')).env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'BOT_B', ANTHROPIC_BASE_URL: 'https://rename.example' });
  expect((await settings.get('claude', 'b')).hasApiKey).toBe(false);
  expect((await settings.resolve(agent)).env.ANTHROPIC_AUTH_TOKEN).toBe('GLOBAL');
});
