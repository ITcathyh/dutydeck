import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from './app.js';
import { createRepositories } from '@dockmux/storage';
import { larkBotsConfigKey, larkCredentialsConfigKey } from './lark/config.js';

const apps: any[] = [];
const tempDirectories: string[] = [];
const repositories: Array<ReturnType<typeof createRepositories>> = [];
function listenerPool() {
  let activeAppIds: string[] = [];
  return {
    get listening() { return activeAppIds.length > 0; },
    get activeAppIds() { return activeAppIds; },
    sync: vi.fn(async (configs: Array<{ appId: string; listening: boolean }>) => { activeAppIds = configs.filter(config => config.listening).map(config => config.appId); }),
    stop: vi.fn(() => { activeAppIds = []; })
  };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const repository of repositories.splice(0)) repository.close();
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('HTTP API boundary', () => {
  it('mounts optional Lark status, send, and update routes', async () => {
    const lark: any = { send: vi.fn(async () => ({ messageId: 'om_sent', chatId: 'oc_chat' })), update: vi.fn(async () => ({ messageId: 'om_sent' })) };
    const app = await buildApp({} as any, { lark: { env: { LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test', LARK_AGENT_NAME: 'My Agent' }, service: lark } }); apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/api/lark/status' })).json()).toMatchObject({ configured: true, listening: false, defaultAgentName: 'My Agent' });
    expect((await app.inject({ method: 'POST', url: '/api/lark/send', payload: { receiveId: 'user@example.com', markdown: 'done' } })).json()).toEqual({ messageId: 'om_sent', chatId: 'oc_chat' });
    expect((await app.inject({ method: 'POST', url: '/api/lark/update', payload: { messageId: 'om_sent', markdown: 'updated' } })).json()).toEqual({ messageId: 'om_sent' });
    expect(lark.send).toHaveBeenCalledWith(expect.objectContaining({ markdown: 'done' }));
    expect(lark.update).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_sent', markdown: 'updated' }));
  });

  it('keeps Dockmux available when Lark is not configured', async () => {
    const app = await buildApp({} as any, { lark: { env: {} } }); apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/api/lark/status' })).json()).toMatchObject({ configured: false, missing: ['LARK_APP_ID', 'LARK_APP_SECRET'] });
    const response = await app.inject({ method: 'POST', url: '/api/lark/send', payload: { receiveId: 'user@example.com', markdown: 'done' } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('LARK_NOT_CONFIGURED');
  });

  it('persists Lark credentials in SQLite without returning the secret', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    await repos.agents.save({ id: 'codex', name: 'Codex', command: 'codex', args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 600, capabilities: { pause: false, resume: true }, builtin: true, version: 'codex-cli test' });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token', expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { message_id: 'om_saved', chat_id: 'oc_group' } }), { status: 200 }));
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, agents: repos.agents, fetcher: fetcher as typeof fetch } }); apps.push(app);
    const saved = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { appId: 'cli_saved', appSecret: 'secret_saved', defaultAgentId: 'codex', defaultModel: 'model-a', defaultReasoningEffort: 'high' } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ configured: true, bots: [{ configured: true, appId: 'cli_saved', name: 'cli_saved', tabLabel: 'cli_saved', setupComplete: true, defaultAgentId: 'codex', defaultModel: 'model-a', defaultReasoningEffort: 'high', listening: false, activeListening: false, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1000, traceLimit: 50, hideTraceOnComplete: true, allowedEmails: [], highRiskAllowedEmails: [], gateEnabled: false, softGateEnabled: false, hardGateEnabled: false, hookTrustConfirmed: false }], listeningDisabled: false });
    expect(saved.body).not.toContain('secret_saved');
    expect(JSON.parse((await repos.config.get(larkBotsConfigKey))!)[0]).toMatchObject({ appId: 'cli_saved', appSecret: 'secret_saved', defaultAgentId: 'codex', defaultModel: 'model-a', defaultReasoningEffort: 'high', listening: false, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1000, traceLimit: 50, hideTraceOnComplete: true, allowedEmails: [], highRiskAllowedEmails: [], gateEnabled: false, softGateEnabled: false, hardGateEnabled: false, hookTrustConfirmed: false });
    const loaded = await app.inject({ method: 'GET', url: '/api/lark/config' });
    expect(loaded.json()).toEqual(saved.json());
    expect(loaded.body).not.toContain('secret_saved');
    expect((await app.inject({ method: 'GET', url: '/api/lark/status' })).json()).toMatchObject({ configured: true });
    expect((await app.inject({ method: 'POST', url: '/api/lark/send', payload: { chatId: 'oc_group', markdown: 'hello', state: 'completed' } })).json()).toEqual({ messageId: 'om_saved', chatId: 'oc_group' });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ app_id: 'cli_saved', app_secret: 'secret_saved' });
  });

  it('resolves typed real names from bot groups and persists open_id member access', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token', expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { items: [{ chat_id: 'oc_group', name: '研发群', external: false }], has_more: false } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token', expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { users: [{ member_id: 'ou_user', member_id_type: 'open_id', open_id: 'ou_user', name: '涂泽国' }], has_more: false, user_total: 1 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token', expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, bot: { app_name: '真实姓名机器人', open_id: 'ou_bot' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { items: [{ chat_id: 'oc_group', name: '研发群', external: false }], has_more: false } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { users: [{ member_id: 'ou_user', member_id_type: 'open_id', open_id: 'ou_user', name: '涂泽国' }], has_more: false, user_total: 1 } }), { status: 200 }));
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, fetcher: fetcher as typeof fetch, listener: listenerPool() } }); apps.push(app);
    await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { appId: 'cli_named', appSecret: 'secret_named' } });

    const chats = await app.inject({ method: 'GET', url: '/api/lark/bots/cli_named/chats' });
    expect(chats.json()).toEqual({ items: [{ chatId: 'oc_group', name: '研发群', external: false }], hasMore: false });
    const members = await app.inject({ method: 'GET', url: '/api/lark/bots/cli_named/chats/oc_group/members' });
    expect(members.json()).toMatchObject({ items: [{ memberId: 'ou_user', openId: 'ou_user', memberType: 'user', name: '涂泽国' }], hasMore: false, memberTotal: 1 });

    const saved = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'lark', originalAppId: 'cli_named', allowedUserNames: ['涂泽国'], allowedEmails: [] } });
    expect(saved.json().bots[0]).toMatchObject({ allowedUsers: [{ openId: 'ou_user', name: '涂泽国' }], allowedEmails: [] });
    expect(fetcher).toHaveBeenCalledTimes(8);
  });

  it('starts and stops the optional Lark listener from persisted config', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    await repos.agents.save({ id: 'codex', name: 'Codex', command: 'codex', args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 600, capabilities: { pause: false, resume: true }, builtin: true });
    const listener = listenerPool();
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, agents: repos.agents, listener } }); apps.push(app);
    await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { appId: 'cli_saved', appSecret: 'secret_saved', defaultAgentId: 'codex', listening: false } });
    listener.sync.mockClear();
    const enabled = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_saved', listening: true } });
    expect(enabled.json().bots[0]).toMatchObject({ appId: 'cli_saved', listening: true, activeListening: true });
    expect(listener.sync).toHaveBeenCalledOnce();
    const disabled = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_saved', listening: false } });
    expect(disabled.json().bots[0]).toMatchObject({ appId: 'cli_saved', listening: false, activeListening: false });
  });

  it('persists the listener switch and retries a transient first connection failure within one save', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    let activeAppIds: string[] = []; let failedOnce = false;
    const listener = {
      get listening() { return activeAppIds.length > 0; },
      get activeAppIds() { return activeAppIds; },
      sync: vi.fn(async (configs: Array<{ appId: string; listening: boolean }>) => {
        if (configs.some(config => config.listening) && !failedOnce) { failedOnce = true; throw new Error('transient websocket failure'); }
        activeAppIds = configs.filter(config => config.listening).map(config => config.appId);
      }),
      stop: vi.fn()
    };
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, agents: repos.agents, listener } }); apps.push(app);
    await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { appId: 'cli_saved', appSecret: 'secret_saved', listening: false } });
    listener.sync.mockClear();
    const response = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_saved', listening: true } });
    expect(response.statusCode).toBe(200);
    expect(response.json().bots[0]).toMatchObject({ listening: true, activeListening: true });
    expect(listener.sync).toHaveBeenCalledTimes(2);
    expect(JSON.parse((await repos.config.get(larkBotsConfigKey))!)[0].listening).toBe(true);
  });

  it('allows listening with valid Lark credentials before an Agent is configured', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    const listener = listenerPool();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token', expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, bot: { app_name: 'Listener only', open_id: 'ou_bot' } }), { status: 200 }));
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, agents: repos.agents, listener, fetcher: fetcher as typeof fetch } }); apps.push(app);
    const response = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'lark', appId: 'cli_saved', appSecret: 'secret_saved', listening: true } });
    expect(response.statusCode).toBe(200);
    expect(response.json().bots[0]).toMatchObject({ appId: 'cli_saved', setupComplete: false, listening: true, activeListening: true });
    expect(listener.sync).toHaveBeenLastCalledWith([expect.objectContaining({ appId: 'cli_saved', listening: true })]);
    expect(listener.sync.mock.calls.at(-1)?.[0]?.[0]).not.toHaveProperty('defaultAgentId');
    expect(JSON.parse((await repos.config.get(larkBotsConfigKey))!)[0]).toMatchObject({ appId: 'cli_saved', listening: true });
  });

  it('keeps the persisted listener switch unchanged when startup disables listening', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    await repos.agents.save({ id: 'codex', name: 'Codex', command: 'codex', args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 600, capabilities: { pause: false, resume: true }, builtin: true });
    await repos.config.set(larkCredentialsConfigKey, JSON.stringify({ appId: 'cli_saved', appSecret: 'secret_saved', defaultAgentId: 'codex', listening: true, pushIntervalMs: 1200, hideTraceOnComplete: false }));
    const listener = listenerPool();
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, agents: repos.agents, listener, listeningDisabled: true } }); apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/api/lark/config' })).json()).toMatchObject({ listeningDisabled: true, bots: [expect.objectContaining({ listening: true, activeListening: false, pushIntervalMs: 1200 })] });
    const saved = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_saved', listening: false, pushIntervalMs: 1500 } });
    expect(saved.json()).toMatchObject({ listeningDisabled: true, bots: [expect.objectContaining({ listening: true, activeListening: false, pushIntervalMs: 1500 })] });
    expect(JSON.parse((await repos.config.get(larkBotsConfigKey))!)[0].listening).toBe(true);
    expect(listener.sync).not.toHaveBeenCalled();
  });

  it('restores an enabled listener from SQLite on startup', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    await repos.config.set(larkCredentialsConfigKey, JSON.stringify({ appId: 'cli_saved', appSecret: 'secret_saved', defaultAgentId: 'codex', listening: true, pushIntervalMs: 1000, hideTraceOnComplete: false }));
    const listener = listenerPool();
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, listener } }); apps.push(app);
    expect(listener.sync).toHaveBeenCalledWith([expect.objectContaining({ listening: true, pushIntervalMs: 1000, traceLimit: 50 })]);
    expect((await app.inject({ method: 'GET', url: '/api/lark/config' })).json()).toMatchObject({ bots: [expect.objectContaining({ listening: true, activeListening: true, groupToolsEnabled: false, groupToolsAllowSend: false, traceLimit: 50 })] });
  });

  it('validates and persists Lark delivery policy', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    await repos.agents.save({ id: 'codex', name: 'Codex', command: 'codex', args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 600, capabilities: { pause: false, resume: true }, builtin: true });
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, agents: repos.agents } }); apps.push(app);
    const invalid = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { appId: 'cli_saved', appSecret: 'secret_saved', defaultAgentId: 'codex', pushIntervalMs: 499 } });
    expect(invalid.statusCode).toBe(400);
    const saved = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { appId: 'cli_saved', appSecret: 'secret_saved', defaultAgentId: 'codex', pushIntervalMs: 20000, traceLimit: 8, hideTraceOnComplete: true } });
    expect(saved.json().bots[0]).toMatchObject({ pushIntervalMs: 20000, traceLimit: 8, hideTraceOnComplete: true });
    expect(JSON.parse((await repos.config.get(larkBotsConfigKey))!)[0]).toMatchObject({ pushIntervalMs: 20000, traceLimit: 8, hideTraceOnComplete: true });
    const reset = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_saved', traceLimit: null } });
    expect(reset.json().bots[0]).toMatchObject({ traceLimit: 50 });
    expect(JSON.parse((await repos.config.get(larkBotsConfigKey))!)[0]).toMatchObject({ traceLimit: 50 });
  });

  it('persists independent group-tool discovery and send policies', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    await repos.agents.save({ id: 'codex', name: 'Codex', command: 'codex', args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 600, capabilities: { pause: false, resume: true }, builtin: true });
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, agents: repos.agents } }); apps.push(app);
    await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { appId: 'cli_saved', appSecret: 'secret_saved', defaultAgentId: 'codex' } });
    const saved = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId: 'cli_saved', groupToolsEnabled: true, groupToolsAllowSend: false } });
    expect(saved.json().bots[0]).toMatchObject({ groupToolsEnabled: true, groupToolsAllowSend: false });
    expect(JSON.parse((await repos.config.get(larkBotsConfigKey))!)[0]).toMatchObject({ groupToolsEnabled: true, groupToolsAllowSend: false });
  });

  it('keeps one unique panel per bot and persists each workspace independently', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    await repos.agents.save({ id: 'codex', name: 'Codex', command: 'codex', args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 600, capabilities: { pause: false, resume: true }, builtin: true });
    const listener = listenerPool();
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, agents: repos.agents, listener } }); apps.push(app);
    const first = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { name: '超级智慧大脑', appId: 'cli_one', appSecret: 'secret_one', workspace: '/work/one', defaultAgentId: 'codex' } });
    expect(first.statusCode).toBe(200);
    const duplicate = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { name: '重复机器人', appId: 'cli_one', appSecret: 'secret_other', workspace: '/work/duplicate', defaultAgentId: 'codex' } });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('LARK_BOT_ALREADY_CONFIGURED');
    const relative = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { name: '机器人二号', appId: 'cli_two', appSecret: 'secret_two', workspace: 'relative/path', defaultAgentId: 'codex' } });
    expect(relative.statusCode).toBe(400);
    const second = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { name: '机器人二号', appId: 'cli_two', appSecret: 'secret_two', workspace: '/work/two', defaultAgentId: 'codex' } });
    expect(second.json().bots).toEqual([
      expect.objectContaining({ appId: 'cli_one', name: '超级智慧大脑', workspace: '/work/one' }),
      expect.objectContaining({ appId: 'cli_two', name: '机器人二号', workspace: '/work/two' })
    ]);
  });

  it('creates a bot in two stages, auto-resolves its name, and disambiguates duplicate tab labels', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    await repos.agents.save({ id: 'codex', name: 'Codex', command: 'codex', args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 600, capabilities: { pause: false, resume: true }, builtin: true });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token-one', expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, bot: { app_name: '同名机器人', open_id: 'ou_one' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { user_ids: ['ou_visible'] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { user: { email: 'user@example.com' } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token-listen', expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, bot: { app_name: '同名机器人', open_id: 'ou_one' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token-two', expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, bot: { app_name: '同名机器人', open_id: 'ou_two' } }), { status: 200 }));
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, agents: repos.agents, fetcher: fetcher as typeof fetch, listener: listenerPool() } }); apps.push(app);

    const first = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'lark', appId: 'cli_one', appSecret: 'secret_one', name: '伪造名称', workspace: '/work/one', allowedEmails: ['USER@EXAMPLE.COM'] } });
    expect(first.statusCode).toBe(200);
    expect(first.json().bots[0]).toMatchObject({ appId: 'cli_one', name: '同名机器人', setupComplete: false, allowedEmails: ['user@example.com'], listening: false });
    const firstAgent = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId: 'cli_one', defaultAgentId: 'codex' } });
    expect(firstAgent.json().bots[0]).toMatchObject({ setupComplete: true, defaultAgentId: 'codex' });
    const listeningFromFirstStep = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'lark', originalAppId: 'cli_one', listening: true, allowedEmails: [] } });
    expect(listeningFromFirstStep.json().bots[0]).toMatchObject({ setupComplete: true, listening: true, activeListening: true });

    const second = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'lark', appId: 'cli_two', appSecret: 'secret_two', workspace: '/work/two' } });
    expect(second.json().bots).toEqual([
      expect.objectContaining({ appId: 'cli_one', tabLabel: '同名机器人 · cli_one' }),
      expect.objectContaining({ appId: 'cli_two', tabLabel: '同名机器人 · cli_two', setupComplete: false })
    ]);
  });

  it('requires an installed hook, then locks the Agent while allowing model changes', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    const workspace = await mkdtemp(join(tmpdir(), 'dockmux-hard-gate-')); tempDirectories.push(workspace);
    for (const id of ['codex', 'claude']) await repos.agents.save({ id, name: id, command: id, args: [], protocol: 'acp', cwd: workspace, env: {}, permissionMode: 'ask', timeout: 600, capabilities: { pause: false, resume: true }, builtin: true });
    const listener = listenerPool();
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, agents: repos.agents, listener } }); apps.push(app);
    await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { appId: 'cli_guard', appSecret: 'secret', workspace, defaultAgentId: 'codex' } });

    const invalidSyntax = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId: 'cli_guard', gateEnabled: true, highRiskPattern: '(unclosed' } });
    expect(invalidSyntax.statusCode).toBe(400);
    expect(invalidSyntax.json().error).toMatchObject({ code: 'INVALID_HIGH_RISK_PATTERN', message: expect.stringContaining('语法错误') });
    const catastrophic = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId: 'cli_guard', gateEnabled: true, highRiskPattern: '^(a+)+$' } });
    expect(catastrophic.statusCode).toBe(400);
    expect(catastrophic.json().error).toMatchObject({ code: 'INVALID_HIGH_RISK_PATTERN', message: expect.stringContaining('灾难性回溯') });
    const unsafeInstall = await app.inject({ method: 'POST', url: '/api/lark/hooks/install', payload: { appId: 'cli_guard', highRiskPattern: '^(a+)+$' } });
    expect(unsafeInstall.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/lark/hooks/status?appId=cli_guard' })).json()).toMatchObject({ installed: false });

    const beforeInstall = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId: 'cli_guard', gateEnabled: true, hardGateEnabled: true } });
    expect(beforeInstall.statusCode).toBe(409);
    expect(beforeInstall.json().error.code).toBe('HARD_GATE_NOT_READY');

    const installed = await app.inject({ method: 'POST', url: '/api/lark/hooks/install', payload: { appId: 'cli_guard', highRiskPattern: 'rm\\b|bytedcli\\b' } });
    expect(installed.statusCode).toBe(200);
    expect(installed.json()).toMatchObject({ supported: true, installed: true, writable: true, trustRequired: true });
    expect((await app.inject({ method: 'GET', url: '/api/lark/config' })).json().bots[0]).toMatchObject({ highRiskPattern: 'rm\\b|bytedcli\\b', gateEnabled: true, softGateEnabled: true, hardGateEnabled: false, hookTrustConfirmed: true });

    const enabled = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId: 'cli_guard', hardGateEnabled: true } });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().bots[0]).toMatchObject({ gateEnabled: true, softGateEnabled: true, hardGateEnabled: true });

    const modelChanged = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId: 'cli_guard', defaultModel: 'model-b', defaultReasoningEffort: 'high' } });
    expect(modelChanged.statusCode).toBe(200);
    expect(modelChanged.json().bots[0]).toMatchObject({ defaultAgentId: 'codex', defaultModel: 'model-b', defaultReasoningEffort: 'high', hardGateEnabled: true });

    const locked = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId: 'cli_guard', defaultAgentId: 'claude' } });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error.code).toBe('HARD_GATE_AGENT_LOCKED');
  });

  it('selects the requested persisted bot for service card calls', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    await repos.config.set(larkBotsConfigKey, JSON.stringify([
      { appId: 'cli_one', appSecret: 'secret_one', defaultAgentId: 'codex', listening: false, pushIntervalMs: 1000, hideTraceOnComplete: false },
      { appId: 'cli_two', appSecret: 'secret_two', defaultAgentId: 'codex', listening: false, pushIntervalMs: 1000, hideTraceOnComplete: false }
    ]));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token_two', expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { message_id: 'om_two', chat_id: 'oc_group' } }), { status: 200 }));
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, fetcher: fetcher as typeof fetch } }); apps.push(app);
    expect((await app.inject({ method: 'POST', url: '/api/lark/send', payload: { botAppId: 'cli_two', chatId: 'oc_group', markdown: 'hello', state: 'completed' } })).json()).toMatchObject({ messageId: 'om_two' });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ app_id: 'cli_two', app_secret: 'secret_two' });
    const missing = await app.inject({ method: 'POST', url: '/api/lark/send', payload: { botAppId: 'cli_missing', chatId: 'oc_group', markdown: 'hello' } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('LARK_BOT_NOT_FOUND');
  });

  it('exposes the real macOS directory picker through a guarded system API', async () => {
    const selectDirectory = vi.fn(async () => '/Users/test/project');
    const selectFile = vi.fn(async () => '/Users/test/project/App.tsx');
    const discoverSkills = vi.fn(async () => [{ name: 'review', description: 'Review code', path: '/Users/test/.codex/skills/review/SKILL.md', source: 'user' as const }]);
    const app = await buildApp({} as any, { system: { platform: 'darwin', selectDirectory, selectFile, discoverSkills } }); apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/api/system/capabilities' })).json()).toEqual({ platform: 'darwin', directoryPicker: true, filePicker: true });
    expect((await app.inject({ method: 'POST', url: '/api/system/select-directory' })).json()).toEqual({ path: '/Users/test/project' });
    expect((await app.inject({ method: 'POST', url: '/api/system/select-file' })).json()).toEqual({ path: '/Users/test/project/App.tsx' });
    expect((await app.inject({ method: 'GET', url: '/api/system/skills?cwd=%2Frepo' })).json()).toEqual([{ name: 'review', description: 'Review code', path: '/Users/test/.codex/skills/review/SKILL.md', source: 'user' }]);
    expect(selectDirectory).toHaveBeenCalledOnce();
    expect(selectFile).toHaveBeenCalledOnce();
    expect(discoverSkills).toHaveBeenCalledWith('/repo');
  });

  it('routes lifecycle actions exclusively through Runtime', async () => {
    const session = { id: 's1', agentId: 'mock', state: 'idle', cwd: '/tmp', permissionMode: 'full-trust', runId: 'r1', createdAt: '', updatedAt: '' };
    const task = { id: 't1', sessionId: 's1', prompt: 'hello', status: 'queued', createdAt: '', updatedAt: '' };
    const runtime: any = { listAgents: vi.fn(async () => []), listSessions: vi.fn(async () => [session]), start: vi.fn(async () => session), getSession: vi.fn(async () => session), getEvents: vi.fn(async () => []), subscribe: vi.fn(() => () => {}), dispatch: vi.fn(async () => task), setModel: vi.fn(async () => ({ ...session, model: 'model-b' })), setReasoningEffort: vi.fn(async () => ({ ...session, reasoningEffort: 'high' })), cancelQueued: vi.fn(async () => ({ ...task, status: 'cancelled' })), steerQueued: vi.fn(async () => task), interrupt: vi.fn(async () => {}), pause: vi.fn(async () => {}), resume: vi.fn(async () => {}), stop: vi.fn(async () => {}), restart: vi.fn(async () => session), archive: vi.fn(async () => ({ ...session, archivedAt: 'now' })), resolvePermission: vi.fn() };
    const app = await buildApp(runtime); apps.push(app);
    expect((await app.inject({ method: 'POST', url: '/api/sessions', payload: { agentId: 'mock', model: 'model-selected-in-web', reasoningEffort: 'high' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/send', payload: { prompt: 'hello' } })).statusCode).toBe(202);
    expect((await app.inject({ method: 'PATCH', url: '/api/sessions/s1/config', payload: { model: 'model-b' } })).json()).toMatchObject({ model: 'model-b' });
    expect((await app.inject({ method: 'PATCH', url: '/api/sessions/s1/config', payload: { reasoningEffort: 'high' } })).json()).toMatchObject({ reasoningEffort: 'high' });
    expect((await app.inject({ method: 'DELETE', url: '/api/sessions/s1/queue/t1' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/queue/t1/steer' })).statusCode).toBe(200);
    for (const action of ['interrupt', 'pause', 'resume', 'stop', 'restart']) expect((await app.inject({ method: 'POST', url: `/api/sessions/s1/${action}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/archive' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/api/sessions/s1/permission-mode', payload: { mode: 'ask' } })).statusCode).toBe(404);
    expect(runtime.start).toHaveBeenCalledWith({ agentId: 'mock', model: 'model-selected-in-web', reasoningEffort: 'high' }); expect(runtime.dispatch).toHaveBeenCalledWith('s1', 'hello', 'queue'); expect(runtime.setModel).toHaveBeenCalledWith('s1', 'model-b'); expect(runtime.setReasoningEffort).toHaveBeenCalledWith('s1', 'high'); expect(runtime.cancelQueued).toHaveBeenCalledWith('s1', 't1'); expect(runtime.steerQueued).toHaveBeenCalledWith('s1', 't1'); expect(runtime.stop).toHaveBeenCalledOnce();
  });

  it('validates queued send input before handing it to Runtime', async () => {
    const runtime: any = { dispatch: vi.fn() };
    const app = await buildApp(runtime); apps.push(app);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/send', payload: { prompt: '   ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/send', payload: { prompt: 'hello', mode: 'later' } })).statusCode).toBe(400);
    expect(runtime.dispatch).not.toHaveBeenCalled();
  });

  it('replays missed SSE events after Last-Event-ID reconnect', async () => {
    const missed = { id: 'e2', sessionId: 's1', sequence: 2, type: 'text', timestamp: new Date().toISOString(), data: { text: 'replayed' } };
    const runtime: any = { listAgents: async () => [], listSessions: async () => [], getSession: async () => undefined, start: vi.fn(), send: vi.fn(), interrupt: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), restart: vi.fn(), resolvePermission: vi.fn(), getEvents: vi.fn(async (_id: string, after: number) => after === 1 ? [missed] : []), subscribe: vi.fn(() => () => {}) };
    const app = await buildApp(runtime); apps.push(app); await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('No port');
    const controller = new AbortController(); const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/s1/stream`, { headers: { 'Last-Event-ID': '1' }, signal: controller.signal });
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let chunk = '';
    while (!chunk.includes('id: 2')) { const next = await reader.read(); if (next.done) break; chunk += decoder.decode(next.value); }
    controller.abort();
    expect(chunk).toContain('id: 2'); expect(chunk).toContain('replayed'); expect(runtime.getEvents).toHaveBeenCalledWith('s1', 1);
  });

  it('continues after the newest SSE cursor without replaying acknowledged events', async () => {
    const runtime: any = { listAgents: async () => [], listSessions: async () => [], getSession: async () => undefined, start: vi.fn(), send: vi.fn(), interrupt: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), restart: vi.fn(), resolvePermission: vi.fn(), getEvents: vi.fn(async () => []), subscribe: vi.fn(() => () => {}) };
    const app = await buildApp(runtime); apps.push(app); await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('No port');
    const controller = new AbortController(); await fetch(`http://127.0.0.1:${address.port}/api/sessions/s1/stream?after=4`, { headers: { 'Last-Event-ID': '9' }, signal: controller.signal }); controller.abort();
    expect(runtime.getEvents).toHaveBeenCalledWith('s1', 9);
  });

  it('serves the bundled Web UI while preserving API 404 responses', async () => {
    const webRoot = await mkdtemp(join(tmpdir(), 'dockmux-web-')); tempDirectories.push(webRoot);
    await mkdir(join(webRoot, 'assets'));
    await writeFile(join(webRoot, 'index.html'), '<main>Dockmux UI</main>');
    await writeFile(join(webRoot, 'assets', 'app.js'), 'globalThis.agentDock = true;');
    const runtime: any = { listAgents: async () => [], listSessions: async () => [], getSession: async () => undefined, start: vi.fn(), send: vi.fn(), interrupt: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), restart: vi.fn(), resolvePermission: vi.fn(), getEvents: vi.fn(async () => []), getTasks: vi.fn(async () => []), subscribe: vi.fn(() => () => {}) };
    const app = await buildApp(runtime, { webRoot }); apps.push(app);

    const index = await app.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200); expect(index.headers['content-type']).toContain('text/html'); expect(index.body).toContain('Dockmux UI');
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200); expect(asset.headers['cache-control']).toContain('immutable');
    expect((await app.inject({ method: 'GET', url: '/sessions/s1' })).body).toContain('Dockmux UI');
    const api = await app.inject({ method: 'GET', url: '/api/not-real' });
    expect(api.statusCode).toBe(404); expect(api.json().error.code).toBe('NOT_FOUND');
  });

});
