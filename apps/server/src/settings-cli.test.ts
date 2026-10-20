import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { RuntimeError } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { buildApp } from './app.js';
import { createCliProgram } from './cli-program.js';
import { registerCollaborationRoutes } from './collaboration-routes.js';
import { CollaborationService } from './collaboration-service.js';
import { larkBotsConfigKey, readLarkConfig } from './lark/config.js';
import { LarkGroupManager } from './lark/group-management.js';
import { LarkGroupParticipation } from './lark/group-participation.js';
import { PluginHost } from './plugins/host.js';
import { botFields, fieldsHelp, groupFields, runSettingsCli, SettingsCliError, type SettingsAction, type SettingsCliInput } from './settings-cli.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

const target = { url: 'http://127.0.0.1:4310', database: '/tmp/runtime.db' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const readToken = () => undefined;

describe('settings CLI foundation channel bots', () => {
  async function foundationRuntime() {
    const repos = createRepositories(':memory:');
    cleanups.push(() => repos.close());
    await repos.channelBots.create({ id: 'draft/bot', channel: 'lark', externalAppId: 'cli_draft', displayName: 'Draft', brand: 'feishu', state: 'staged' });
    await repos.secretRefs.create({ id: 'ref_cli', kind: 'lark_app_secret', provider: 'local-file-v1', referenceKey: 'opaque.reference', status: 'configured' });
    let allowed = true;
    const manager = new LarkGroupManager(repos);
    const app = await buildApp({ listAgents: async () => [] } as any, { foundation: {
      repositories: repos, authorize: async () => allowed, isLiveManagedBot: id => manager.isLiveManagedBot(id), inspectSecretRef: async () => 'available'
    } });
    cleanups.push(() => app.close());
    const fetcher = bridge(app);
    return { repos, fetcher, deny: () => { allowed = false; }, run: (action: SettingsAction, input: SettingsCliInput = {}) => runSettingsCli(action, { ...target, channelBotId: 'draft/bot', ...input }, { fetcher, readToken }) };
  }

  it('creates, addresses and updates the Dashboard offline group bindings with CAS', async () => {
    const { repos, run, fetcher } = await foundationRuntime();
    const add = { groupBindingId: 'draft/binding', chatId: 'oc_draft', pairs: ['oncall=true'] };
    expect(await run('group-binding-add', add)).toMatchObject({ binding: { id: 'draft/binding', revision: 1, state: 'staged', oncall: true } });
    expect(await run('group-binding-list')).toMatchObject({ bindings: [{ id: 'draft/binding' }] });
    expect(await run('group-binding-list', { channelBotId: 'absent' })).toEqual({ bindings: [] });
    expect(await run('group-binding-show', { groupBindingId: 'draft/binding' })).toMatchObject({ binding: { channelBotId: 'draft/bot', externalChatId: 'oc_draft' } });
    const patch = { groupBindingId: 'draft/binding', pairs: ['oncall=false', 'routingOverride={"groupReplyMode":{"mode":"set","value":"chat-topic"},"mentionPolicy":{"mode":"set","value":"topic"}}', 'groupToolsOverride={"read":"deny","discover":"deny","send":"deny"}', 'modelOverride=clear'] };
    expect(await run('group-binding-set', patch)).toMatchObject({ binding: { revision: 2, oncall: false, modelOverride: { mode: 'clear' }, routingOverride: { mentionPolicy: { value: 'topic' } }, groupToolsOverride: { read: 'deny' } } });
    await expect(run('group-binding-set', { ...patch, expectedRevision: '1' })).rejects.toMatchObject({ code: 'FOUNDATION_REVISION_CONFLICT' });
    expect((await repos.groupBindings.get('draft/binding'))?.revision).toBe(2);
    await expect(run('group-binding-add', add)).rejects.toMatchObject({ code: 'FOUNDATION_NATURAL_KEY_CONFLICT' });
    expect((await repos.groupBindings.get('draft/binding'))?.revision).toBe(2);
    expect(fetcher.mock.calls.every(([url]) => new URL(String(url)).pathname.startsWith('/api/foundation/'))).toBe(true);
  });

  it('retains foundation authorization, live management guard and disabled-state validation', async () => {
    const { repos, run, deny } = await foundationRuntime();
    const add = { groupBindingId: 'guarded', chatId: 'oc_draft' };
    await run('group-binding-add', add);
    await expect(run('group-binding-set', { groupBindingId: 'guarded', pairs: ['state=active'] })).rejects.toMatchObject({ code: 'SETTINGS_VALUE_INVALID' });
    await expect(run('group-binding-set', { groupBindingId: 'guarded', pairs: ['oncall=true'], expectedRevision: '0' })).rejects.toMatchObject({ code: 'SETTINGS_VALUE_INVALID' });
    await expect(run('group-binding-add', { ...add, groupBindingId: 'active', pairs: ['state=disabled'] })).rejects.toMatchObject({ code: 'SETTINGS_KEY_UNKNOWN' });
    await repos.config.set(larkBotsConfigKey, JSON.stringify([{ appId: 'cli_draft', appSecret: 'fixture', foundationChannelBotId: 'draft/bot' }]));
    await repos.config.set('lark.live-owner.cli_draft', JSON.stringify({ channelBotId: 'draft/bot' }));
    await expect(run('group-binding-set', { groupBindingId: 'guarded', pairs: ['oncall=true'] })).rejects.toMatchObject({ code: 'LARK_LIVE_MANAGEMENT_REQUIRED' });
    await expect(run('group-binding-add', { ...add, groupBindingId: 'live-new' })).rejects.toMatchObject({ code: 'LARK_LIVE_MANAGEMENT_REQUIRED' });
    deny();
    await expect(run('group-binding-set', { groupBindingId: 'guarded', pairs: ['oncall=true'] })).rejects.toMatchObject({ code: 'FOUNDATION_PERMISSION_DENIED' });
    expect((await repos.groupBindings.get('guarded'))?.revision).toBe(1);
  });

  it('selects and clears a SecretRef through the same revision-checked metadata API as the dashboard', async () => {
    const { repos, run } = await foundationRuntime();
    expect(await run('channel-bot-list')).toMatchObject({ bots: [{ id: 'draft/bot', revision: 1 }] });
    expect(await run('channel-bot-set', { pairs: ['credentialRef=ref_cli'] })).toMatchObject({ bot: { selectedSecretRefId: 'ref_cli', revision: 2 } });
    expect(await run('channel-bot-set', { pairs: ['displayName=Renamed'] })).toMatchObject({ bot: { selectedSecretRefId: 'ref_cli', displayName: 'Renamed', revision: 3 } });
    await expect(run('channel-bot-set', { pairs: ['credentialRef=null'], expectedRevision: '2' })).rejects.toMatchObject({ code: 'FOUNDATION_REVISION_CONFLICT' });
    expect(await run('channel-bot-set', { pairs: ['credentialRef=null'], expectedRevision: '3' })).toMatchObject({ bot: { credentialStatus: 'missing', revision: 4 } });
    expect((await repos.channelBots.get('draft/bot'))?.credentialRef).toBeUndefined();
    const shown = await run('channel-bot-show');
    expect(JSON.stringify(shown)).not.toMatch(/"appSecret"|"value"|opaque.reference/);
  });

  it('preserves permission, disabled-state restrictions and SecretRef readiness checks', async () => {
    const { repos, deny, fetcher, run } = await foundationRuntime();
    await repos.secretRefs.create({ id: 'invalid_ref', kind: 'lark_app_secret', provider: 'local-file-v1', referenceKey: 'opaque.other', status: 'invalid' });
    expect(await run('channel-bot-set', { pairs: ['credentialRef=invalid_ref'] })).toMatchObject({ bot: { credentialStatus: 'invalid', blockerCodes: expect.arrayContaining(['channel_bot_credential_invalid']) } });
    await expect(run('channel-bot-set', { pairs: ['state=active'] })).rejects.toMatchObject({ code: 'SETTINGS_VALUE_INVALID' });
    await expect(run('channel-bot-set', { pairs: ['credentialRef=ref_cli'], expectedRevision: '0' })).rejects.toMatchObject({ code: 'SETTINGS_VALUE_INVALID' });
    await expect(run('channel-bot-set', { pairs: ['appSecret=raw_secret'] })).rejects.toMatchObject({ code: 'SETTINGS_KEY_UNKNOWN' });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
    deny();
    await expect(run('channel-bot-set', { pairs: ['credentialRef=ref_cli'] })).rejects.toMatchObject({ code: 'FOUNDATION_PERMISSION_DENIED' });
    expect((await repos.channelBots.get('draft/bot'))?.revision).toBe(2);
  });
});

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
  it.each(['chat', 'shared', 'new-topic', 'chat-topic'])('clears the explicit %s reply mode with auto without changing omitted-field semantics', async mode => {
    const { repos, run, fetcher } = await botRuntime();
    await run('bot-set', { appId: 'cli_a', pairs: [`groupReplyMode=${mode}`] });
    await run('bot-set', { appId: 'cli_a', pairs: ['preInjectPrompt=retain reply mode'] });
    expect((await readLarkConfig(repos.config, 'cli_a'))?.groupReplyMode).toBe(mode);
    const result = await run('bot-set', { appId: 'cli_a', pairs: ['groupReplyMode=auto'] });
    expect(result.bot).not.toHaveProperty('groupReplyMode');
    expect(await readLarkConfig(repos.config, 'cli_a')).not.toHaveProperty('groupReplyMode');
    const last = fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT').at(-1)!;
    expect(JSON.parse(String(last[1]!.body))).toMatchObject({ groupReplyMode: null });
  });

  it('changes bot settings with typed values and the current revision, like the dashboard', async () => {
    const { repos, run } = await botRuntime();
    const before = (await run('bot-show', { appId: 'cli_a' })).bot as { revision: number };
    const result = await run('bot-set', { appId: 'cli_a', pairs: ['adhdMode=true', 'mentionPolicy=never', 'pinAfterMs=null', 'idleCompactHours=48', 'workerAgentIds=codex, claude-code', 'preInjectPrompt=先读 AGENTS.md'] });
    expect(result.bot).toMatchObject({ appId: 'cli_a', revision: before.revision + 1, adhdMode: true, mentionPolicy: 'never', idleCompactHours: 48, workerAgentIds: ['codex', 'claude-code'], preInjectPrompt: '先读 AGENTS.md' });
    expect(result.bot).not.toHaveProperty('appSecret');
    expect(await readLarkConfig(repos.config, 'cli_a')).toMatchObject({ appSecret: 'secret-a', adhdMode: true, mentionPolicy: 'never' });
    expect((await run('bot-list')).bots).toEqual([expect.objectContaining({ appId: 'cli_a', defaultAgentId: 'codex', listening: false })]);
  });

  it('defaults busy triage off and saves typed on/off values through the bot route', async () => {
    const { repos, run } = await botRuntime();
    expect((await run('bot-show', { appId: 'cli_a' })).bot).toMatchObject({ busyTriage: false });
    expect((await run('bot-set', { appId: 'cli_a', pairs: ['busyTriage=true'] })).bot).toMatchObject({ busyTriage: true });
    expect(await readLarkConfig(repos.config, 'cli_a')).toMatchObject({ busyTriage: true });
    await run('bot-set', { appId: 'cli_a', pairs: ['preInjectPrompt=keep busy setting'] });
    expect(await readLarkConfig(repos.config, 'cli_a')).toMatchObject({ busyTriage: true });
    expect((await run('bot-set', { appId: 'cli_a', pairs: ['busyTriage=false'] })).bot).toMatchObject({ busyTriage: false });
    await expect(run('bot-set', { appId: 'cli_a', pairs: ['busyTriage=maybe'] })).rejects.toThrow();
  });

  it('persists card forwarding through CLI/API updates and redacts its token from all public results', async () => {
    const { repos, run } = await botRuntime();
    const forwarding = { owner: 'sample-service', url: 'http://127.0.0.1:14432/cards', token: 'private-forward-token', legacyActions: ['ack'] };
    const result = await run('bot-set', { appId: 'cli_a', pairs: [`cardActionForwarding=${JSON.stringify(forwarding)}`] });
    expect(result.bot).toMatchObject({ cardActionForwarding: { owner: forwarding.owner, url: forwarding.url, legacyActions: ['ack'] } });
    expect(JSON.stringify(result)).not.toContain(forwarding.token);
    expect((result.bot as any).cardActionForwarding).not.toHaveProperty('token');
    expect(await readLarkConfig(repos.config, 'cli_a')).toMatchObject({ cardActionForwarding: forwarding });
    await run('bot-set', { appId: 'cli_a', pairs: ['preInjectPrompt=keep forwarding'] });
    expect(await readLarkConfig(repos.config, 'cli_a')).toMatchObject({ cardActionForwarding: forwarding });
    expect(JSON.stringify(await run('bot-show', { appId: 'cli_a' }))).not.toContain(forwarding.token);
    expect(JSON.stringify(await run('bot-list'))).not.toContain(forwarding.token);
    await expect(run('bot-set', { appId: 'cli_a', pairs: [`cardActionForwarding=${JSON.stringify({ ...forwarding, legacyActions: ['cancel'] })}`] })).rejects.toMatchObject({ code: 'INVALID_LARK_CONFIG' });
    await expect(run('bot-set', { appId: 'cli_a', pairs: [`cardActionForwarding=${JSON.stringify({ ...forwarding, url: 'http://remote.example/cards' })}`] })).rejects.toMatchObject({ code: 'INVALID_LARK_CONFIG' });
    await run('bot-set', { appId: 'cli_a', pairs: ['cardActionForwarding=null'] });
    expect(await readLarkConfig(repos.config, 'cli_a')).not.toHaveProperty('cardActionForwarding');
    expect((await run('bot-show', { appId: 'cli_a' })).bot).not.toHaveProperty('cardActionForwarding');
    expect(fieldsHelp(botFields)).toContain('cardActionForwarding=<JSON>');
  });

  it('saves ordered event handlers, hides tokens, preserves them by ID, and requires credentials when changing URL', async () => {
    const { repos, run } = await botRuntime();
    const first = { id: 'first', eventTypes: ['card.action.trigger'], url: 'http://127.0.0.1:14432/events', token: 'private-first-token', owner: 'sample-service' };
    const second = { id: 'second', eventTypes: ['im.message.receive_v1'], url: 'https://receiver.example/events', token: 'private-second-token' };
    const saved = await run('bot-set', { appId: 'cli_a', pairs: [`eventHandlers=${JSON.stringify([first, second])}`] });
    expect((saved.bot as any).eventHandlers.map((handler: any) => handler.id)).toEqual(['first', 'second']);
    for (const output of [saved, await run('bot-show', { appId: 'cli_a' }), await run('bot-list')]) {
      expect(JSON.stringify(output)).not.toContain(first.token); expect(JSON.stringify(output)).not.toContain(second.token);
    }
    const { token: _firstToken, ...publicFirst } = first;
    const { token: _secondToken, ...publicSecond } = second;
    await run('bot-set', { appId: 'cli_a', pairs: [`eventHandlers=${JSON.stringify([publicSecond, publicFirst])}`] });
    expect(await readLarkConfig(repos.config, 'cli_a')).toMatchObject({ eventHandlers: [second, first] });
    await run('bot-set', { appId: 'cli_a', pairs: ['preInjectPrompt=keep handlers'] });
    expect(await readLarkConfig(repos.config, 'cli_a')).toMatchObject({ eventHandlers: [second, first] });
    await expect(run('bot-set', { appId: 'cli_a', pairs: [`eventHandlers=${JSON.stringify([{ ...publicFirst, url: 'https://new.example/events' }])}`] })).rejects.toMatchObject({ code: 'INVALID_LARK_CONFIG' });
    expect(await readLarkConfig(repos.config, 'cli_a')).toMatchObject({ eventHandlers: [second, first] });
    await expect(run('bot-set', { appId: 'cli_a', pairs: [`eventHandlers=${JSON.stringify([{ ...publicFirst, id: 'new' }])}`] })).rejects.toMatchObject({ code: 'INVALID_LARK_CONFIG' });
    await run('bot-set', { appId: 'cli_a', pairs: [`eventHandlers=${JSON.stringify([{ ...publicFirst, url: 'https://new.example/events', token: 'rotated-token' }])}`] });
    expect(await readLarkConfig(repos.config, 'cli_a')).toMatchObject({ eventHandlers: [{ id: 'first', token: 'rotated-token', url: 'https://new.example/events' }] });
    await run('bot-set', { appId: 'cli_a', pairs: ['eventHandlers=[]'] });
    expect(await readLarkConfig(repos.config, 'cli_a')).toMatchObject({ eventHandlers: [] });
    await run('bot-set', { appId: 'cli_a', pairs: ['eventHandlers=null'] });
    expect(await readLarkConfig(repos.config, 'cli_a')).not.toHaveProperty('eventHandlers');
    expect(fieldsHelp(botFields)).toContain('eventHandlers=<JSON>');
  });

  it('preserves corrupt handlers on migrations and writes to other bots, requires explicit repair, and exposes safe diagnostics', async () => {
    const { repos, run } = await botRuntime();
    const broken = [{ id: 'broken', eventTypes: ['card.action.trigger'], url: 'http://remote.example', token: 'invalid-handler-secret' }];
    await repos.config.set(larkBotsConfigKey, JSON.stringify([
      { appId: 'cli_a', appSecret: 'secret-a', listening: false, permissionMode: 'ask', defaultAgentId: 'codex', eventHandlers: broken },
      { appId: 'cli_b', appSecret: 'secret-b', listening: false, permissionMode: 'ask', defaultAgentId: 'codex' }
    ]));
    const shown = await run('bot-show', { appId: 'cli_a' });
    expect(shown.bot).toHaveProperty('eventHandlersError'); expect(shown.bot).not.toHaveProperty('eventHandlers');
    expect(JSON.stringify(shown)).not.toContain('invalid-handler-secret');
    expect(JSON.parse((await repos.config.get(larkBotsConfigKey))!)[0].eventHandlers).toEqual(broken);
    await expect(run('bot-set', { appId: 'cli_a', pairs: ['welcomeEnabled=false'] })).rejects.toMatchObject({ code: 'INVALID_LARK_CONFIG' });
    await run('bot-set', { appId: 'cli_b', pairs: ['welcomeEnabled=false'] });
    expect(JSON.parse((await repos.config.get(larkBotsConfigKey))!)[0].eventHandlers).toEqual(broken);
    await run('bot-set', { appId: 'cli_a', pairs: ['eventHandlers=null'] });
    expect((await run('bot-show', { appId: 'cli_a' })).bot).not.toHaveProperty('eventHandlersError');
  });

  it('shows, changes, and preserves the Agent badge switch through the settings API', async () => {
    const { repos, run, fetcher } = await botRuntime();
    expect((await run('bot-show', { appId: 'cli_a' })).bot.showAgentName).toBe(false);
    for (const showAgentName of [true, false]) {
      await run('bot-set', { appId: 'cli_a', pairs: [`showAgentName=${showAgentName}`] });
      await run('bot-set', { appId: 'cli_a', pairs: ['preInjectPrompt=keep badge preference'] });
      expect((await run('bot-show', { appId: 'cli_a' })).bot.showAgentName).toBe(showAgentName);
      expect((await readLarkConfig(repos.config, 'cli_a'))?.showAgentName).toBe(showAgentName);
    }
    const invalid = await fetcher(`${target.url}/api/lark/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ originalAppId: 'cli_a', showAgentName: 'true' }) });
    expect(invalid.status).toBe(400);
    expect(fieldsHelp(botFields)).toContain('showAgentName=<true|false>');
  });

  it('defaults welcomes on, saves and preserves the boolean setting, and rejects invalid API values', async () => {
    const { repos, run, fetcher } = await botRuntime();
    expect((await run('bot-show', { appId: 'cli_a' })).bot).toMatchObject({ welcomeEnabled: true });
    expect((await run('bot-set', { appId: 'cli_a', pairs: ['welcomeEnabled=false'] })).bot).toMatchObject({ welcomeEnabled: false });
    await run('bot-set', { appId: 'cli_a', pairs: ['preInjectPrompt=retain welcome preference'] });
    expect(await readLarkConfig(repos.config, 'cli_a')).toMatchObject({ welcomeEnabled: false });
    const invalid = await fetcher(`${target.url}/api/lark/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ originalAppId: 'cli_a', welcomeEnabled: 'false' }) });
    expect(invalid.status).toBe(400);
    expect((await run('bot-set', { appId: 'cli_a', pairs: ['welcomeEnabled=true'] })).bot).toMatchObject({ welcomeEnabled: true });
    expect(fieldsHelp(botFields)).toContain('welcomeEnabled=<true|false>');
  });

  it('shows safe diagnostics for corrupt forwarding, preserves it on unrelated writes, and permits explicit repair', async () => {
    const { repos, run } = await botRuntime();
    const broken = { owner: 'sample-service', url: 'http://remote.example/cards', token: 'invalid-forward-secret' };
    await repos.config.set(larkBotsConfigKey, JSON.stringify([
      { appId: 'cli_a', appSecret: 'secret-a', listening: false, permissionMode: 'ask', defaultAgentId: 'codex', cardActionForwarding: broken },
      { appId: 'cli_b', appSecret: 'secret-b', listening: false, permissionMode: 'ask', defaultAgentId: 'codex' }
    ]));
    const shown = await run('bot-show', { appId: 'cli_a' });
    expect(shown.bot).toHaveProperty('cardActionForwardingError');
    expect(shown.bot).not.toHaveProperty('cardActionForwarding');
    expect(JSON.stringify(shown)).not.toContain(broken.token);
    const afterMigration = JSON.parse((await repos.config.get(larkBotsConfigKey))!);
    expect(afterMigration[0].cardActionForwarding).toEqual(broken);
    await expect(run('bot-set', { appId: 'cli_a', pairs: ['welcomeEnabled=false'] })).rejects.toMatchObject({ code: 'INVALID_LARK_CONFIG' });
    await run('bot-set', { appId: 'cli_b', pairs: ['welcomeEnabled=false'] });
    expect(JSON.parse((await repos.config.get(larkBotsConfigKey))!)[0].cardActionForwarding).toEqual(broken);
    expect(JSON.parse((await repos.config.get(larkBotsConfigKey))!)[0]).not.toHaveProperty('cardActionForwardingError');
    await run('bot-set', { appId: 'cli_a', pairs: ['cardActionForwarding=null'] });
    expect((await run('bot-show', { appId: 'cli_a' })).bot).not.toHaveProperty('cardActionForwardingError');
    expect(await readLarkConfig(repos.config, 'cli_a')).not.toHaveProperty('cardActionForwarding');
  });

  it('reads and writes groupMemoryScope, defaulting to shared and rejecting unknown values', async () => {
    const { repos, run } = await botRuntime();
    expect((await run('bot-show', { appId: 'cli_a' })).bot).toMatchObject({ groupMemoryScope: 'shared' });
    const set = await run('bot-set', { appId: 'cli_a', pairs: ['groupMemoryScope=per-group'] });
    expect(set.bot).toMatchObject({ appId: 'cli_a', groupMemoryScope: 'per-group' });
    expect(await readLarkConfig(repos.config, 'cli_a')).toMatchObject({ groupMemoryScope: 'per-group' });
    await run('bot-set', { appId: 'cli_a', pairs: ['preInjectPrompt=别的设置'] });
    expect((await run('bot-show', { appId: 'cli_a' })).bot).toMatchObject({ groupMemoryScope: 'per-group' });
    await expect(run('bot-set', { appId: 'cli_a', pairs: ['groupMemoryScope=everyone'] })).rejects.toMatchObject({ code: 'SETTINGS_VALUE_INVALID' });
    expect(await run('bot-set', { appId: 'cli_a', pairs: ['groupMemoryScope=shared'] })).toMatchObject({ bot: { groupMemoryScope: 'shared' } });
    expect(fieldsHelp(botFields)).toContain('groupMemoryScope=<shared|per-group>');
  });

  it('reads, writes, partially preserves, and clears roleTitle and roleScope', async () => {
    const { repos, run } = await botRuntime();
    // 写入 roleTitle 和 roleScope
    const setRes = await run('bot-set', {
      appId: 'cli_a',
      pairs: ['roleTitle=告警值班', 'roleScope=负责全部告警与线上排查']
    });
    expect(setRes.bot).toMatchObject({
      appId: 'cli_a',
      roleTitle: '告警值班',
      roleScope: '负责全部告警与线上排查'
    });
    expect(await readLarkConfig(repos.config, 'cli_a')).toMatchObject({
      roleTitle: '告警值班',
      roleScope: '负责全部告警与线上排查'
    });
    const showRes = await run('bot-show', { appId: 'cli_a' });
    expect(showRes.bot).toMatchObject({
      roleTitle: '告警值班',
      roleScope: '负责全部告警与线上排查'
    });

    // 局部更新其他字段，roleTitle 和 roleScope 保持不变
    await run('bot-set', { appId: 'cli_a', pairs: ['preInjectPrompt=新做法'] });
    const showPreserved = await run('bot-show', { appId: 'cli_a' });
    expect(showPreserved.bot).toMatchObject({
      roleTitle: '告警值班',
      roleScope: '负责全部告警与线上排查',
      preInjectPrompt: '新做法'
    });

    // 传入空值清空
    await run('bot-set', { appId: 'cli_a', pairs: ['roleTitle=', 'roleScope='] });
    const showCleared = await run('bot-show', { appId: 'cli_a' });
    expect((showCleared.bot as any).roleTitle).toBeUndefined();
    expect((showCleared.bot as any).roleScope).toBeUndefined();
    expect(showCleared.bot).not.toHaveProperty('roleTitle');
    expect(showCleared.bot).not.toHaveProperty('roleScope');
  });

  it('sets notification tiers and quiet hours, keeps them across other edits, and rejects bad values', async () => {
    const { repos, run } = await botRuntime();
    expect((await run('bot-show', { appId: 'cli_a' })).bot).toMatchObject({ notifyMentionAction: true, notifyMentionDone: true });
    expect((await run('bot-show', { appId: 'cli_a' })).bot).not.toHaveProperty('notifyQuietHours');
    const set = await run('bot-set', { appId: 'cli_a', pairs: ['notifyMentionDone=false', 'notifyQuietHours=22:00-08:00'] });
    expect(set.bot).toMatchObject({ notifyMentionAction: true, notifyMentionDone: false, notifyQuietHours: '22:00-08:00' });
    expect(await readLarkConfig(repos.config, 'cli_a')).toMatchObject({ notifyMentionAction: true, notifyMentionDone: false, notifyQuietHours: '22:00-08:00' });

    await run('bot-set', { appId: 'cli_a', pairs: ['preInjectPrompt=别的设置'] });
    expect((await run('bot-show', { appId: 'cli_a' })).bot).toMatchObject({ notifyMentionDone: false, notifyQuietHours: '22:00-08:00' });

    for (const bad of ['25:00-08:00', '22:00', '22:00-22:00', '8:00-9:00', 'always']) {
      await expect(run('bot-set', { appId: 'cli_a', pairs: [`notifyQuietHours=${bad}`] })).rejects.toMatchObject({ code: 'INVALID_LARK_CONFIG' });
    }
    await expect(run('bot-set', { appId: 'cli_a', pairs: ['notifyMentionAction=maybe'] })).rejects.toMatchObject({ code: 'SETTINGS_VALUE_INVALID' });
    expect(await readLarkConfig(repos.config, 'cli_a')).toMatchObject({ notifyQuietHours: '22:00-08:00' });

    await run('bot-set', { appId: 'cli_a', pairs: ['notifyQuietHours=', 'notifyMentionAction=false'] });
    const cleared = (await run('bot-show', { appId: 'cli_a' })).bot;
    expect(cleared).not.toHaveProperty('notifyQuietHours');
    expect(cleared).toMatchObject({ notifyMentionAction: false });
    expect(fieldsHelp(botFields)).toContain('notifyQuietHours=<text>');
  });

  it('rejects unknown keys and bad values before sending anything', async () => {
    const { fetcher, run } = await botRuntime();
    await expect(run('bot-set', { appId: 'cli_a', pairs: ['adhdmode=true'] })).rejects.toMatchObject({ code: 'SETTINGS_KEY_UNKNOWN' });
    await expect(run('bot-set', { appId: 'cli_a', pairs: ['adhdMode=yes'] })).rejects.toMatchObject({ code: 'SETTINGS_VALUE_INVALID', message: 'adhdMode expects true|false' });
    await expect(run('bot-set', { appId: 'cli_a', pairs: ['mentionPolicy=sometimes'] })).rejects.toMatchObject({ code: 'SETTINGS_VALUE_INVALID' });
    await expect(run('bot-set', { appId: 'cli_a', pairs: ['adhdMode=true', 'adhdMode=false'] })).rejects.toMatchObject({ code: 'SETTINGS_KEY_DUPLICATE' });
    // 服务端会静默丢掉这些条目，名单变空就等于不限制访问。
    await expect(run('bot-set', { appId: 'cli_a', pairs: ['allowedUsers=["ou_owner"]'] })).rejects.toMatchObject({ code: 'SETTINGS_VALUE_INVALID' });
    await expect(run('bot-set', { appId: 'cli_a', pairs: ['allowedUsers=[{"openId":"on_union"}]'] })).rejects.toMatchObject({ code: 'SETTINGS_VALUE_INVALID' });
    await expect(run('bot-set', { appId: 'cli_a', pairs: ['allowedEmails=[1]'] })).rejects.toMatchObject({ code: 'SETTINGS_VALUE_INVALID' });
    // 换凭据或改成员名单时不经过完全信任确认，其余键要分开提交。
    await expect(run('bot-set', { appId: 'cli_a', appSecret: 'new-secret', pairs: ['permissionMode=full-trust'] })).rejects.toMatchObject({ code: 'SETTINGS_KEYS_CONFLICT' });
    await expect(run('bot-set', { appId: 'cli_a', pairs: ['allowedUserNames=张三', 'listening=true'] })).rejects.toMatchObject({ code: 'SETTINGS_KEYS_CONFLICT' });
    await expect(run('bot-add', { appId: 'cli_new', appSecret: 's', pairs: ['defaultAgentId=codex'] })).rejects.toMatchObject({ code: 'SETTINGS_KEYS_CONFLICT' });
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

/** 群分工的请求交给真实的协作路由、群参与和场景包注册表（内置 alarm 包）；群列表用固定数据。 */
async function dutyRuntime() {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-settings-duty-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const repos = createRepositories(join(directory, 'test.sqlite'));
  cleanups.push(() => repos.close());
  const host = await PluginHost.load({ dataDir: directory });
  const participation = new LarkGroupParticipation({ repository: repos.collaboration, decider: {} as any, authorize: async () => true, serviceFor: () => ({}) as any,
    readConfig: async appId => appId === 'cli_a' ? { appId, appSecret: 'secret-a' } as any : undefined, scenarios: host.scenarios });
  cleanups.push(() => participation.close());
  const service = new CollaborationService({ repositories: repos, authorize: async () => true, resolveScheduleScope: async () => ({ channelBotId: 'bot', identityRef: 'identity', secretRef: 'secret' }) });
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply.code((error as RuntimeError).statusCode ?? 500).send({ error: { code: (error as RuntimeError).code, message: error.message } }));
  app.get('/api/lark/management/groups', async () => ({ groups: [{ key: 'k', chatId: 'oc_duty', name: '测试群', bots: [{ appId: 'cli_a', membership: 'member', validity: 'valid', roles: [], applied: true, binding: { revision: 1, state: 'staged', oncall: false } }] }] }));
  await registerCollaborationRoutes(app, { service, runtime: {} as any, tools: {} as any, evaluation: {} as any, extensions: {} as any, bootstrap: async () => {}, authorizeManagement: async () => 'ou_owner',
    updateDuty: (scope, patch, actorId) => participation.updateDuty(scope, patch, actorId), scenarios: scope => participation.scenarioOverview(scope) });
  cleanups.push(() => app.close());
  const fetcher = bridge(app);
  const dutyBodies = () => fetcher.mock.calls.filter(([url, init]) => new URL(String(url)).pathname.endsWith('/collaboration/duty') && init?.method === 'PATCH').map(([, init]) => JSON.parse(String(init!.body)));
  const scope = { appId: 'cli_a', chatId: 'oc_duty' };
  return { repos, scope, fetcher, dutyBodies, run: (action: SettingsAction, input: SettingsCliInput = {}) => runSettingsCli(action, { ...target, chatId: 'oc_duty', ...input }, { fetcher, readToken }) };
}

describe('settings CLI group duty against the real collaboration routes', () => {
  const sources = [{ appId: 'cli_source_a', name: '来源 A' }];
  const alarmOf = (result: Record<string, unknown>) => (result.collaboration as { scenarios: Array<{ id: string }> }).scenarios.find(item => item.id === 'alarm');

  it('writes scenario bindings, merges partial params, and shows each pack with its params, binding and staleness', async () => {
    const { repos, scope, run } = await dutyRuntime();
    const before = alarmOf(await run('group-show'));
    expect(before).toMatchObject({ title: '告警初筛', version: '1.1.0', mode: 'direct', requiresRequester: true, versionStale: false,
      params: { sources: { type: 'bot_list', label: '来源机器人 app_id' }, dedupeHours: { type: 'integer', min: 1, max: 168, default: 6 } } });
    expect(before).not.toHaveProperty('binding');
    const saved = await run('group-set', { pairs: [`scenarios=${JSON.stringify({ alarm: { enabled: false, params: { sources, levels: ['P0'] } } })}`] });
    expect(saved.applied).toEqual(['duty']);
    expect(saved).not.toHaveProperty('warnings');
    const off = { enabled: false, params: { sources, levels: ['P0'], dedupeHours: 6, maxPerHour: 3 }, packVersion: '1.1.0' };
    expect(alarmOf(saved)).toMatchObject({ binding: off });
    // 群里确认后（确认卡写入确认人），CLI 只改一个参数，其余沿用。
    await repos.collaboration.updateDuty(scope, { expectedRevision: 1, scenarios: { alarm: { ...off, enabled: true, requesterId: 'ou_tester' } } }, 'ou_tester');
    const changed = await run('group-set', { pairs: ['scenarios={"alarm":{"enabled":true,"params":{"maxPerHour":5}}}'] });
    expect((changed.collaboration as any).duty.scenarios.alarm).toEqual({ enabled: true, params: { ...off.params, maxPerHour: 5 }, requesterId: 'ou_tester', packVersion: '1.1.0' });
    // 绑定的大版本落后于包：show 标出过期，开启被服务端拒绝。
    await repos.collaboration.updateDuty(scope, { expectedRevision: 3, scenarios: { alarm: { ...off, enabled: true, requesterId: 'ou_tester', packVersion: '0.9.0' } } }, 'ou_tester');
    expect(alarmOf(await run('group-show'))).toMatchObject({ versionStale: true, binding: { packVersion: '0.9.0' } });
    await expect(run('group-set', { pairs: ['scenarios={"alarm":{"enabled":true}}'] })).rejects.toMatchObject({ code: 'COLLABORATION_SCENARIO_VERSION_STALE' });
    expect(fieldsHelp(groupFields)).toContain('scenarios=<JSON>');
    expect(fieldsHelp(groupFields)).not.toContain('alarm=');
  });

  it('refuses confirmer and pack version from the CLI, and enabling a direct pack nobody confirmed in the group', async () => {
    const { run } = await dutyRuntime();
    await expect(run('group-set', { pairs: [`scenarios=${JSON.stringify({ alarm: { enabled: false, params: { sources }, requesterId: 'ou_tester' } })}`] })).rejects.toMatchObject({ code: 'COLLABORATION_INVALID_INPUT' });
    await expect(run('group-set', { pairs: [`scenarios=${JSON.stringify({ alarm: { enabled: false, params: { sources }, packVersion: '1.0.0' } })}`] })).rejects.toMatchObject({ code: 'COLLABORATION_INVALID_INPUT' });
    await expect(run('group-set', { pairs: [`alarm=${JSON.stringify({ enabled: false, sources, requesterId: 'ou_tester' })}`] })).rejects.toMatchObject({ code: 'COLLABORATION_INVALID_INPUT' });
    await expect(run('group-set', { pairs: [`scenarios=${JSON.stringify({ alarm: { enabled: true, params: { sources } } })}`] })).rejects.toMatchObject({ code: 'COLLABORATION_SCENARIO_REQUESTER_REQUIRED' });
    await expect(run('group-set', { pairs: ['scenarios={"alarm":{"enabled":false,"params":{"dedupeHours":0}}}'] })).rejects.toMatchObject({ code: 'COLLABORATION_SCENARIO_INVALID' });
    expect((await run('group-show')).collaboration).toMatchObject({ duty: { revision: 0 } });
  });

  it('keeps alarm=<flat subscription> as an alias of scenarios.alarm for one release, with a warning; alarm=null removes the binding', async () => {
    const { run, dutyBodies } = await dutyRuntime();
    const saved = await run('group-set', { pairs: [`alarm=${JSON.stringify({ enabled: false, sources, levels: ['P1'], dedupeHours: 12 })}`] });
    expect(dutyBodies()).toEqual([{ expectedRevision: 0, scenarios: { alarm: { enabled: false, params: { sources, levels: ['P1'], dedupeHours: 12 } } } }]);
    expect(saved.warnings).toEqual([expect.stringContaining('scenarios={"alarm"')]);
    expect(alarmOf(saved)).toMatchObject({ binding: { enabled: false, params: { sources, levels: ['P1'], dedupeHours: 12, maxPerHour: 3 } } });
    const removed = await run('group-set', { pairs: ['alarm=null'] });
    expect(dutyBodies().at(-1)).toEqual({ expectedRevision: 1, scenarios: { alarm: null } });
    expect((removed.collaboration as any).duty.scenarios?.alarm).toBeUndefined();
    expect(alarmOf(removed)).not.toHaveProperty('binding');
  });
});

describe('settings CLI requests', () => {
  const run = (fetcher: ReturnType<typeof vi.fn>, action: SettingsAction, input: SettingsCliInput = {}) => runSettingsCli(action, { ...target, ...input }, { fetcher, readToken });
  const bodyOf = (fetcher: ReturnType<typeof vi.fn>, method: string, path: string) => {
    const call = fetcher.mock.calls.find(([url, init]) => (url as URL).pathname === path && init.method === method);
    return call && JSON.parse(call[1].body);
  };
  const groupBot = (appId: string, revision?: number) => ({ appId, membership: 'member', validity: 'valid', roles: [], applied: true, ...(revision ? { binding: { revision, state: 'staged', oncall: false } } : {}) });
  const groupApi = (bots: unknown[], failOn?: string, groups = [{ key: 'k', chatId: 'oc_1', name: '值班群', bots }]) => vi.fn(async (url: URL, init: RequestInit) => {
    const key = `${init.method} ${url.pathname}`;
    if (key === failOn) return json({ error: { code: 'COLLABORATION_REVISION_CONFLICT', message: '群协作设置已变化' } }, 409);
    if (key === 'GET /api/lark/management/groups') return json({ groups });
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

  it('sends raw owner open_ids through the Lark step that checks they belong to this app', async () => {
    const fetcher = vi.fn(async () => json({ configured: true, bots: [{ appId: 'cli_a', revision: 4 }] }));
    await run(fetcher, 'bot-set', { appId: 'cli_a', pairs: ['allowedUsers=[{"openId":"ou_owner","name":"Owner"}]'] });
    expect(bodyOf(fetcher, 'PUT', '/api/lark/config')).toEqual({ stage: 'lark', originalAppId: 'cli_a', expectedRevision: 4, allowedUsers: [{ openId: 'ou_owner', name: 'Owner' }] });
  });

  it('creates the binding first when only collaboration settings are given for a new group', async () => {
    const fetcher = groupApi([groupBot('cli_a')]);
    expect((await run(fetcher, 'group-set', { chatId: 'oc_1', pairs: ['participation=selective'] })).applied).toEqual(['binding', 'collaboration']);
    expect(bodyOf(fetcher, 'PUT', '/api/lark/bots/cli_a/groups/oc_1')).toEqual({ expectedRevision: 0, patch: {} });
  });

  it('finds every bot of a group even when the group is listed once per bot', async () => {
    const fetcher = groupApi([], undefined, [{ key: 'a', chatId: 'oc_1', name: '值班群', bots: [groupBot('cli_a', 1)] }, { key: 'b', chatId: 'oc_1', name: '值班群', bots: [groupBot('cli_b', 2)] }]);
    await expect(run(fetcher, 'group-set', { chatId: 'oc_1', pairs: ['oncall=true'] })).rejects.toMatchObject({ code: 'SETTINGS_APP_REQUIRED' });
    await run(fetcher, 'group-set', { chatId: 'oc_1', appId: 'cli_b', pairs: ['oncall=true'] });
    expect(bodyOf(fetcher, 'PUT', '/api/lark/bots/cli_b/groups/oc_1')).toEqual({ expectedRevision: 2, patch: { oncall: true } });
  });

  it('asks for --app when several bots share a group', async () => {
    const fetcher = groupApi([groupBot('cli_a', 1), groupBot('cli_b', 1)]);
    await expect(run(fetcher, 'group-set', { chatId: 'oc_1', pairs: ['oncall=true'] })).rejects.toMatchObject({ code: 'SETTINGS_APP_REQUIRED', message: expect.stringContaining('cli_a|cli_b') });
    await run(fetcher, 'group-set', { chatId: 'oc_1', appId: 'cli_b', pairs: ['oncall=true'] });
    expect(bodyOf(fetcher, 'PUT', '/api/lark/bots/cli_b/groups/oc_1')).toMatchObject({ patch: { oncall: true } });
  });

  it('merges alarm= into the other packs of scenarios=, and refuses it together with scenarios.alarm before sending anything', async () => {
    const fetcher = groupApi([groupBot('cli_a', 2)]);
    await run(fetcher, 'group-set', { chatId: 'oc_1', pairs: ['scenarios={"team-faq":{"enabled":true}}', 'alarm=null'] });
    expect(bodyOf(fetcher, 'PATCH', '/api/lark/groups/cli_a/oc_1/collaboration/duty')).toEqual({ expectedRevision: 3, scenarios: { 'team-faq': { enabled: true }, alarm: null } });
    const untouched = groupApi([groupBot('cli_a', 2)]);
    await expect(run(untouched, 'group-set', { chatId: 'oc_1', pairs: ['alarm={"enabled":false}', 'scenarios={"alarm":{"enabled":false}}'] })).rejects.toMatchObject({ code: 'SETTINGS_KEYS_CONFLICT' });
    await expect(run(untouched, 'group-set', { chatId: 'oc_1', pairs: ['alarm=true'] })).rejects.toMatchObject({ code: 'SETTINGS_VALUE_INVALID' });
    await expect(run(untouched, 'group-set', { chatId: 'oc_1', pairs: ['alarm=null', 'scenarios=[]'] })).rejects.toMatchObject({ code: 'SETTINGS_VALUE_INVALID' });
    expect(untouched).not.toHaveBeenCalled();
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
  it('registers offline group binding commands with explicit IDs and revision', async () => {
    const settings = vi.fn();
    const invoke = (args: string[]) => createCliProgram('0.0.7', { settings }).parseAsync(['node', 'dutydeck', 'settings', 'group-binding', ...args]);
    await invoke(['add', 'binding/id', '--bot', 'draft/bot', '--chat', 'oc_draft', 'oncall=true', '--instance', 'tag']);
    expect(settings).toHaveBeenLastCalledWith('group-binding-add', expect.objectContaining({ groupBindingId: 'binding/id', channelBotId: 'draft/bot', chatId: 'oc_draft', pairs: ['oncall=true'], instance: 'tag' }));
    await invoke(['set', 'binding/id', 'oncall=false', '--expected-revision', '3']);
    expect(settings).toHaveBeenLastCalledWith('group-binding-set', expect.objectContaining({ groupBindingId: 'binding/id', pairs: ['oncall=false'], expectedRevision: '3' }));
    await invoke(['list', '--bot', 'draft/bot']);
    expect(settings).toHaveBeenLastCalledWith('group-binding-list', expect.objectContaining({ channelBotId: 'draft/bot' }));
    await invoke(['show', 'binding/id']);
    expect(settings).toHaveBeenLastCalledWith('group-binding-show', expect.objectContaining({ groupBindingId: 'binding/id' }));
  });

  it('passes a foundation ID, reference selection and revision to the handler', async () => {
    const settings = vi.fn();
    await createCliProgram('0.0.7', { settings }).parseAsync(['node', 'dutydeck', 'settings', 'channel-bot', 'set', 'draft/bot', 'credentialRef=ref_cli', '--expected-revision', '4', '--instance', 'tag']);
    expect(settings).toHaveBeenCalledWith('channel-bot-set', expect.objectContaining({ channelBotId: 'draft/bot', pairs: ['credentialRef=ref_cli'], expectedRevision: '4', instance: 'tag' }));
  });

  it('passes target, ids and key=value pairs to the handler', async () => {
    const settings = vi.fn();
    await createCliProgram('0.0.7', { settings }).parseAsync(['node', 'dutydeck', 'settings', 'agent', 'set', 'claude', 'authMode=bearer', '--api-key-fd', '0', '--instance', 'tag']);
    expect(settings).toHaveBeenLastCalledWith('agent-set', expect.objectContaining({ agentId: 'claude', pairs: ['authMode=bearer'], apiKeyFd: '0', instance: 'tag' }));
    await createCliProgram('0.0.7', { settings }).parseAsync(['node', 'dutydeck', 'settings', 'agent', 'show', 'claude']);
    expect(settings).toHaveBeenLastCalledWith('agent-show', expect.objectContaining({ agentId: 'claude' }));
    await createCliProgram('0.0.7', { settings }).parseAsync(['node', 'dutydeck', 'settings', 'group', 'set', 'oc_1', 'oncall=true', 'participation=eager', '--app', 'cli_a', '--instance', 'tag']);
    expect(settings).toHaveBeenLastCalledWith('group-set', expect.objectContaining({ chatId: 'oc_1', appId: 'cli_a', instance: 'tag', pairs: ['oncall=true', 'participation=eager'] }));
    await createCliProgram('0.0.7', { settings }).parseAsync(['node', 'dutydeck', 'settings', 'bot', 'set', 'cli_a', '--app-secret-fd', '0', '--url', 'http://127.0.0.1:4401', '--database', '/tmp/bot.db']);
    expect(settings).toHaveBeenLastCalledWith('bot-set', expect.objectContaining({ appId: 'cli_a', pairs: [], appSecretFd: '0', url: 'http://127.0.0.1:4401', database: '/tmp/bot.db' }));
    await createCliProgram('0.0.7', { settings }).parseAsync(['node', 'dutydeck', 'settings', 'usage', 'set-cap', '30', '--app', 'cli_a', '--chat', 'oc_1']);
    expect(settings).toHaveBeenLastCalledWith('usage-set-cap', expect.objectContaining({ amount: '30', appId: 'cli_a', chatId: 'oc_1' }));
  });
});

it('passes a bot scope and a secret descriptor for Claude service settings without accepting an API key in argv', async () => {
  const settings = vi.fn();
  await createCliProgram('0.0.7', { settings }).parseAsync(['node', 'dutydeck', 'settings', 'agent', 'set', 'claude', 'baseUrl=https://gateway.example', '--app', 'cli_a', '--api-key-fd', '0']);
  expect(settings).toHaveBeenLastCalledWith('agent-set', expect.objectContaining({ agentId: 'claude', appId: 'cli_a', apiKeyFd: '0', pairs: ['baseUrl=https://gateway.example'] }));
  await createCliProgram('0.0.7', { settings }).parseAsync(['node', 'dutydeck', 'settings', 'agent', 'show', 'claude', '--app', 'cli_a']);
  expect(settings).toHaveBeenLastCalledWith('agent-show', expect.objectContaining({ agentId: 'claude', appId: 'cli_a' }));
  await expect(runSettingsCli('agent-set', { ...target, agentId: 'claude', appId: 'cli_a', pairs: ['apiKey=ARGV_SECRET'] }, { fetcher: vi.fn(), readToken })).rejects.toMatchObject({ code: 'SETTINGS_KEY_UNKNOWN' });
});
