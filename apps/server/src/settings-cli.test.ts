import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createRepositories } from '@dutydeck/storage';
import { buildApp } from './app.js';
import { createCliProgram } from './cli-program.js';
import { larkBotsConfigKey, readLarkConfig } from './lark/config.js';
import { runSettingsCli, SettingsCliError, type SettingsAction, type SettingsCliInput } from './settings-cli.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

const target = { url: 'http://127.0.0.1:4310', database: '/tmp/runtime.db' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const readToken = () => undefined;

/** CLI 发出的请求直接交给内存里的服务端路由处理，校验和保存都走真实代码。 */
function bridge(app: FastifyInstance) {
  return vi.fn(async (url: URL | string | Request, init?: RequestInit) => {
    const { pathname, search } = new URL(String(url));
    const response = await app.inject({ method: init?.method as 'GET', url: `${pathname}${search}`, headers: init?.headers as Record<string, string>, payload: init?.body as string | undefined });
    return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
  });
}

async function botRuntime() {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-settings-cli-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const repos = createRepositories(join(directory, 'test.sqlite'));
  cleanups.push(() => repos.close());
  await repos.config.set(larkBotsConfigKey, JSON.stringify([{ appId: 'cli_a', appSecret: 'secret-a', listening: false, permissionMode: 'ask', defaultAgentId: 'codex' }]));
  const app = await buildApp({} as any, { lark: { env: { DUTYDECK_DISABLE_LARK_LISTENER: 'true' }, config: repos.config, fetcher: vi.fn(async () => { throw new Error('Unexpected network'); }) } });
  cleanups.push(() => app.close());
  const fetcher = bridge(app);
  return { repos, fetcher, run: (action: SettingsAction, input: SettingsCliInput = {}) => runSettingsCli(action, { ...target, ...input }, { fetcher, readToken }) };
}

describe('settings CLI against the real bot routes', () => {
  it('changes bot settings with typed values and the current revision, like the dashboard', async () => {
    const { repos, run } = await botRuntime();
    const before = (await run('bot-show', { appId: 'cli_a' })).bot as { revision: number };
    const result = await run('bot-set', { appId: 'cli_a', pairs: ['adhdMode=true', 'mentionPolicy=never', 'pinAfterMs=null', 'idleCompactHours=48', 'workerAgentIds=codex, claude-code', 'preInjectPrompt=先读 AGENTS.md'] });
    expect(result.bot).toMatchObject({ appId: 'cli_a', revision: before.revision + 1, adhdMode: true, mentionPolicy: 'never', idleCompactHours: 48, workerAgentIds: ['codex', 'claude-code'], preInjectPrompt: '先读 AGENTS.md' });
    expect(result.bot).not.toHaveProperty('appSecret');
    expect(await readLarkConfig(repos.config, 'cli_a')).toMatchObject({ appSecret: 'secret-a', adhdMode: true, mentionPolicy: 'never' });
    expect((await run('bot-list')).bots).toEqual([expect.objectContaining({ appId: 'cli_a', defaultAgentId: 'codex', listening: false })]);
  });

  it('rejects unknown keys and bad values before sending anything', async () => {
    const { fetcher, run } = await botRuntime();
    await expect(run('bot-set', { appId: 'cli_a', pairs: ['adhdmode=true'] })).rejects.toMatchObject({ code: 'SETTINGS_KEY_UNKNOWN' });
    await expect(run('bot-set', { appId: 'cli_a', pairs: ['adhdMode=yes'] })).rejects.toMatchObject({ code: 'SETTINGS_VALUE_INVALID', message: 'adhdMode expects true|false' });
    await expect(run('bot-set', { appId: 'cli_a', pairs: ['mentionPolicy=sometimes'] })).rejects.toMatchObject({ code: 'SETTINGS_VALUE_INVALID' });
    await expect(run('bot-set', { appId: 'cli_a', pairs: ['adhdMode=true', 'adhdMode=false'] })).rejects.toMatchObject({ code: 'SETTINGS_KEY_DUPLICATE' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('passes the server reason through when the server refuses a change', async () => {
    const { repos, run } = await botRuntime();
    await expect(run('bot-set', { appId: 'cli_a', pairs: ['executionMode=layered'] })).rejects.toMatchObject({ code: 'INVALID_LARK_CONFIG', message: '分层协作需要开启群工具。' });
    await expect(run('bot-set', { appId: 'cli_a', pairs: ['permissionMode=full-trust'] })).rejects.toMatchObject({ code: 'LARK_FULL_TRUST_CONFIRMATION_REQUIRED' });
    expect((await run('bot-set', { appId: 'cli_a', pairs: ['permissionMode=full-trust', 'fullTrustConfirmed=true'] })).bot).toMatchObject({ permissionMode: 'full-trust' });
    await expect(run('bot-show', { appId: 'cli_missing' })).rejects.toMatchObject({ code: 'SETTINGS_BOT_NOT_FOUND' });
    expect((await readLarkConfig(repos.config, 'cli_a'))?.executionMode).not.toBe('layered');
  });

  it('removes a bot only with --yes', async () => {
    const { repos, run } = await botRuntime();
    await expect(run('bot-remove', { appId: 'cli_a' })).rejects.toMatchObject({ code: 'SETTINGS_CONFIRMATION_REQUIRED' });
    expect(await run('bot-remove', { appId: 'cli_a', yes: true })).toEqual({ removed: 'cli_a', bots: [] });
    expect(await readLarkConfig(repos.config, 'cli_a')).toBeUndefined();
  });
});

describe('settings CLI requests', () => {
  const run = (fetcher: ReturnType<typeof vi.fn>, action: SettingsAction, input: SettingsCliInput = {}) => runSettingsCli(action, { ...target, ...input }, { fetcher, readToken });
  const bodyOf = (fetcher: ReturnType<typeof vi.fn>, method: string, path: string) => {
    const call = fetcher.mock.calls.find(([url, init]) => (url as URL).pathname === path && init.method === method);
    return call && JSON.parse(call[1].body);
  };
  const groupBot = (appId: string, revision?: number) => ({ appId, membership: 'member', validity: 'valid', roles: [], applied: true, ...(revision ? { binding: { revision, state: 'staged', oncall: false } } : {}) });
  const groupApi = (bots: unknown[], failOn?: string) => vi.fn(async (url: URL, init: RequestInit) => {
    const key = `${init.method} ${url.pathname}`;
    if (key === failOn) return json({ error: { code: 'COLLABORATION_REVISION_CONFLICT', message: '群协作设置已变化' } }, 409);
    if (key === 'GET /api/lark/management/groups') return json({ groups: [{ key: 'k', chatId: 'oc_1', name: '值班群', bots }] });
    if (key.startsWith('GET /api/lark/groups/')) return json({ snapshot: { settings: { revision: 7 } }, duty: { revision: 3 } });
    return json({});
  });

  it('routes each group key to the binding, collaboration or duty endpoint with its own revision', async () => {
    const fetcher = groupApi([groupBot('cli_a', 5)]);
    const result = await run(fetcher, 'group-set', { chatId: 'oc_1', pairs: ['oncall=true', 'modelOverride=gpt-5.5', 'agentOverride=inherit', 'participation=selective', 'responder=self'] });
    expect(result.applied).toEqual(['binding', 'collaboration', 'duty']);
    expect(bodyOf(fetcher, 'PUT', '/api/lark/bots/cli_a/groups/oc_1')).toEqual({ expectedRevision: 5, patch: { oncall: true, modelOverride: { mode: 'set', value: 'gpt-5.5' }, agentOverride: { mode: 'inherit' } } });
    expect(bodyOf(fetcher, 'PATCH', '/api/lark/groups/cli_a/oc_1/collaboration/settings')).toEqual({ expectedRevision: 7, participation: 'selective' });
    expect(bodyOf(fetcher, 'PATCH', '/api/lark/groups/cli_a/oc_1/collaboration/duty')).toEqual({ expectedRevision: 3, responder: 'self' });
  });

  it('creates a missing binding at revision 0 and only calls the endpoints it needs', async () => {
    const fetcher = groupApi([groupBot('cli_a')]);
    await run(fetcher, 'group-set', { chatId: 'oc_1', pairs: ['reasoningOverride=clear'] });
    expect(bodyOf(fetcher, 'PUT', '/api/lark/bots/cli_a/groups/oc_1')).toEqual({ expectedRevision: 0, patch: { reasoningOverride: { mode: 'clear' } } });
    expect(fetcher.mock.calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(0);
  });

  it('asks for --app when several bots share a group', async () => {
    const fetcher = groupApi([groupBot('cli_a', 1), groupBot('cli_b', 1)]);
    await expect(run(fetcher, 'group-set', { chatId: 'oc_1', pairs: ['oncall=true'] })).rejects.toMatchObject({ code: 'SETTINGS_APP_REQUIRED', message: expect.stringContaining('cli_a|cli_b') });
    await run(fetcher, 'group-set', { chatId: 'oc_1', appId: 'cli_b', pairs: ['oncall=true'] });
    expect(bodyOf(fetcher, 'PUT', '/api/lark/bots/cli_b/groups/oc_1')).toMatchObject({ patch: { oncall: true } });
  });

  it('says which part was already saved when a later part fails', async () => {
    const fetcher = groupApi([groupBot('cli_a', 2)], 'PATCH /api/lark/groups/cli_a/oc_1/collaboration/settings');
    await expect(run(fetcher, 'group-set', { chatId: 'oc_1', pairs: ['oncall=true', 'notificationsPaused=true'] })).rejects.toMatchObject({ code: 'COLLABORATION_REVISION_CONFLICT', message: '群协作设置已变化 (already saved: binding)' });
  });

  it('reaches a peer instance through the target runtime like the dashboard', async () => {
    const fetcher = vi.fn(async () => json({ configured: true, bots: [{ appId: 'cli_t', revision: 2 }] }));
    await run(fetcher, 'bot-show', { appId: 'cli_t', instance: 'tag' });
    expect(fetcher).toHaveBeenCalledWith(new URL('http://127.0.0.1:4310/api/instances/tag/lark/config'), expect.objectContaining({ method: 'GET' }));
    await expect(run(fetcher, 'bot-list', { instance: '../x' })).rejects.toBeInstanceOf(SettingsCliError);
  });

  it('sets and removes monthly caps for a bot or one group', async () => {
    const fetcher = vi.fn(async () => json({ deleted: true }));
    await run(fetcher, 'usage-set-cap', { appId: 'cli_a', amount: '25.5' });
    expect(bodyOf(fetcher, 'PUT', '/api/usage/caps')).toEqual({ scope: 'bot', appId: 'cli_a', monthlyCostUsd: 25.5 });
    await run(fetcher, 'usage-remove-cap', { appId: 'cli_a', chatId: 'oc_1' });
    expect(fetcher).toHaveBeenLastCalledWith(new URL('http://127.0.0.1:4310/api/usage/caps?scope=group&appId=cli_a&chatId=oc_1'), expect.objectContaining({ method: 'DELETE' }));
    await expect(run(fetcher, 'usage-set-cap', { appId: 'cli_a', amount: 'ten' })).rejects.toMatchObject({ code: 'SETTINGS_VALUE_INVALID' });
  });
});

describe('settings commands', () => {
  it('passes target, ids and key=value pairs to the handler', async () => {
    const settings = vi.fn();
    await createCliProgram('0.0.7', { settings }).parseAsync(['node', 'dutydeck', 'settings', 'group', 'set', 'oc_1', 'oncall=true', 'participation=eager', '--app', 'cli_a', '--instance', 'tag']);
    expect(settings).toHaveBeenLastCalledWith('group-set', expect.objectContaining({ chatId: 'oc_1', appId: 'cli_a', instance: 'tag', pairs: ['oncall=true', 'participation=eager'] }));
    await createCliProgram('0.0.7', { settings }).parseAsync(['node', 'dutydeck', 'settings', 'bot', 'set', 'cli_a', '--app-secret-fd', '0', '--url', 'http://127.0.0.1:4401', '--database', '/tmp/bot.db']);
    expect(settings).toHaveBeenLastCalledWith('bot-set', expect.objectContaining({ appId: 'cli_a', pairs: [], appSecretFd: '0', url: 'http://127.0.0.1:4401', database: '/tmp/bot.db' }));
    await createCliProgram('0.0.7', { settings }).parseAsync(['node', 'dutydeck', 'settings', 'usage', 'set-cap', '30', '--app', 'cli_a', '--chat', 'oc_1']);
    expect(settings).toHaveBeenLastCalledWith('usage-set-cap', expect.objectContaining({ amount: '30', appId: 'cli_a', chatId: 'oc_1' }));
  });
});
