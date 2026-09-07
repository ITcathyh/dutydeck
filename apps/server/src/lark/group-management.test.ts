import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentConfigSchema, type RepositoryBundle, type Session } from '@dockmux/shared';
import { createRepositories } from '@dockmux/storage';
import { buildApp } from '../app.js';
import { LarkGroupManager } from './group-management.js';
import { LarkAgentToolCapabilityRegistry, LarkAgentToolsService } from './agent-tools.js';
import { deleteLarkConfig, readLarkConfig, saveLarkConfig } from './config.js';
import { resolveLarkSession } from './session-resolver.js';
import type { LarkMessageEvent } from './listener.js';

describe('live group configuration', () => {
  let dir: string;
  let repos: RepositoryBundle;
  let manager: LarkGroupManager;
  let time: Date;
  let members: string[];
  let listChats: ReturnType<typeof vi.fn>;
  const event: LarkMessageEvent = { messageId: 'om_start', chatId: 'oc_one', chatType: 'group', threadId: 'omt_one', rootId: 'om_root', messageType: 'text', content: '{"text":"hi"}', mentions: [], senderOpenId: 'ou_alice' };
  const save = (appId = 'cli_one', chatId = 'oc_one', patch = {}) => manager.save(appId, chatId, { expectedRevision: 0, patch });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dockmux-group-management-'));
    await mkdir(join(dir, 'one')); await mkdir(join(dir, 'two'));
    repos = createRepositories(join(dir, 'state.sqlite'));
    time = new Date('2026-09-07T00:00:00.000Z'); members = ['ou_alice', 'ou_bob'];
    for (const id of ['agent_one', 'agent_two']) await repos.agents.save(agentConfigSchema.parse({ id, name: id, command: process.execPath, cwd: dir, protocol: 'pipe' }));
    for (const appId of ['cli_one', 'cli_two']) await saveLarkConfig(repos.config, repos.agents, { appId, appSecret: `synthetic_${appId}`, defaultAgentId: 'agent_one', workspace: dir, fullTrustConfirmed: true, groupToolsEnabled: true, groupToolsAllowSend: true });
    listChats = vi.fn(async () => ({ items: [{ chatId: 'oc_one', name: '项目群', external: false }, { chatId: 'oc_two', name: '值班群', external: false }], hasMore: false }));
    manager = new LarkGroupManager(repos, { now: () => time, client: config => ({
      getBotInfo: async () => ({ appName: config.appId, openId: `ou_bot_${config.appId}` }),
      checkApplicationIdentity: async () => ({ verified: true, reportedAppId: config.appId, tenantKey: 'synthetic-tenant' }),
      listChats,
      listChatMembers: async () => ({ items: members.map(openId => ({ memberId: openId, openId, name: openId, memberType: 'user' })), hasMore: false, securityLimited: false }),
      getUserEmails: async () => []
    }) as any });
    await manager.sync('cli_one'); await manager.sync('cli_two');
  });
  afterEach(async () => { repos?.close(); await rm(dir, { recursive: true, force: true }); });

  it('discovers two Bots in two groups with valid evidence, without activating configuration', async () => {
    const { groups } = await manager.groups();
    expect(groups).toHaveLength(2);
    expect(groups.every(group => group.bots.length === 2)).toBe(true);
    expect(groups.flatMap(group => group.bots).every(bot => bot.validity === 'valid' && !bot.applied && !bot.binding)).toBe(true);
    expect(JSON.stringify(groups)).not.toContain('synthetic_cli');
  });

  it('persists independent App/group overrides, inheritance and explicit model clearing', async () => {
    const one = await save('cli_one', 'oc_one', { workspaceOverride: { mode: 'set', value: join(dir, 'one') }, modelOverride: { mode: 'set', value: 'model_one' } });
    await save('cli_one', 'oc_two', { workspaceOverride: { mode: 'set', value: join(dir, 'two') }, agentOverride: { mode: 'set', value: 'agent_two' } });
    await save('cli_two', 'oc_one');
    expect((await manager.resolved((await readLarkConfig(repos.config, 'cli_one'))!, 'oc_one')).defaultModel).toBe('model_one');
    expect((await manager.resolved((await readLarkConfig(repos.config, 'cli_one'))!, 'oc_two')).defaultAgentId).toBe('agent_two');
    expect((await manager.resolved((await readLarkConfig(repos.config, 'cli_two'))!, 'oc_one')).workspace).toBe(dir);
    await saveLarkConfig(repos.config, repos.agents, { originalAppId: 'cli_one', defaultModel: 'bot_default' });
    const cleared = await manager.save('cli_one', 'oc_one', { expectedRevision: one.binding!.revision, patch: { modelOverride: { mode: 'clear' } } });
    expect(cleared.effective!.model.source).toBe('group_clear');
    expect((await manager.resolved((await readLarkConfig(repos.config, 'cli_one'))!, 'oc_one')).defaultModel).toBeUndefined();
    const inherited = await manager.save('cli_one', 'oc_one', { expectedRevision: cleared.binding!.revision, patch: { modelOverride: { mode: 'inherit' } } });
    expect(inherited.effective!.model).toEqual({ source: 'bot_default', value: 'bot_default' });
  });

  it('rolls back behavior edits when a role revision conflicts', async () => {
    const initial = await save();
    const alice = (await manager.members('cli_one', 'oc_one')).members[0]!;
    const withRole = await manager.save('cli_one', 'oc_one', { expectedRevision: initial.binding!.revision, patch: {}, roleChanges: [{ kind: 'create', principalId: alice.principalId, role: 'can_operate', operateScope: 'group_runs', actionGates: { terminalWrite: false, highRisk: false, groupToolsSend: false } }] });
    const role = withRole.roles[0]!;
    await repos.roleAssignments.update(role.id, { expectedRevision: role.revision, state: 'revoked' });
    await expect(manager.save('cli_one', 'oc_one', { expectedRevision: withRole.binding!.revision, patch: { workspaceOverride: { mode: 'set', value: join(dir, 'two') } }, roleChanges: [{ kind: 'update', id: role.id, expectedRevision: role.revision, patch: { state: 'active' } }] })).rejects.toMatchObject({ statusCode: 409 });
    expect((await repos.groupBindings.get(initial.binding!.id))!.revision).toBe(withRole.binding!.revision);
    expect((await repos.groupBindings.get(initial.binding!.id))!.workspaceOverride).toEqual({ mode: 'inherit' });
  });

  it('rejects stale group saves and returns the current public value through the real API', async () => {
    const initial = await save();
    const app = await buildApp({} as any, { lark: { groupManager: manager, config: repos.config, listeningDisabled: true } });
    try {
      const response = await app.inject({ method: 'PUT', url: '/api/lark/bots/cli_one/groups/oc_one', payload: { expectedRevision: 0, patch: { oncall: true } } });
      expect(response.statusCode).toBe(409);
      expect(response.json().current.binding.revision).toBe(initial.binding!.revision);
      expect(JSON.stringify(response.json())).not.toContain('synthetic_cli');
    } finally { await app.close(); }
  });

  it('preserves groups after partial pagination failure and rejects repeated page tokens', async () => {
    listChats.mockResolvedValue({ items: [], hasMore: true, pageToken: 'same' });
    await expect(manager.sync('cli_one')).rejects.toMatchObject({ code: 'LARK_PAGINATION_INCOMPLETE' });
    expect((await manager.groups()).groups).toHaveLength(2);
  });

  it('invalidates runtime use when credentials rotate, evidence expires or membership is revoked', async () => {
    await save();
    expect((await manager.authorize('cli_one', 'oc_one', 'ou_alice', 'task.create'))?.allowed).toBe(true);
    members = ['ou_bob'];
    expect((await manager.authorize('cli_one', 'oc_one', 'ou_alice', 'task.create'))?.allowed).toBe(false);
    members = ['ou_alice']; time = new Date(time.getTime() + 3_600_001);
    listChats.mockRejectedValueOnce(new Error('identity refresh unavailable'));
    expect((await manager.authorize('cli_one', 'oc_one', 'ou_alice', 'task.create'))?.allowed).toBe(false);
    await manager.sync('cli_one');
    await saveLarkConfig(repos.config, repos.agents, { originalAppId: 'cli_one', appSecret: 'rotated-synthetic' });
    listChats.mockRejectedValueOnce(new Error('credential refresh unavailable'));
    expect((await manager.authorize('cli_one', 'oc_one', 'ou_alice', 'task.create'))?.allowed).toBe(false);
  });

  it('does not treat App-scoped member identifiers as interchangeable', async () => {
    const a = (await manager.members('cli_one', 'oc_one')).members[0]!;
    const b = (await manager.members('cli_two', 'oc_one')).members[0]!;
    expect(a.principalId).not.toBe(b.principalId);
    await expect(manager.save('cli_two', 'oc_one', { expectedRevision: 0, patch: { accessOverride: { mode: 'allowlist', principalIds: [a.principalId] } } })).rejects.toMatchObject({ code: 'LARK_PRINCIPAL_SCOPE_MISMATCH' });
    await expect(manager.save('cli_two', 'oc_one', { expectedRevision: 0, patch: {}, roleChanges: [{ kind: 'create', principalId: a.principalId, role: 'can_talk', operateScope: 'none', actionGates: { terminalWrite: false, highRisk: false, groupToolsSend: false } }] })).rejects.toMatchObject({ code: 'LARK_PRINCIPAL_SCOPE_MISMATCH' });
  });

  it('applies current tool ceilings and group disablement to an already recorded session', async () => {
    const initial = await save();
    const config = await manager.resolved((await readLarkConfig(repos.config, 'cli_one'))!, 'oc_one');
    const session: Session = { id: 'recorded', agentId: 'agent_one', cwd: dir, state: 'idle', runId: 'run', createdAt: time.toISOString(), updatedAt: time.toISOString() };
    await manager.recordRun(session, config, event, 'thread:om_root');
    await manager.beginTurn(session.id, 'ou_alice');
    expect((await manager.authorizeSession(session.id, 'group_tools.send'))?.allowed).toBe(true);
    const changed = await manager.save('cli_one', 'oc_one', { expectedRevision: initial.binding!.revision, patch: { groupToolsOverride: { read: 'inherit', discover: 'inherit', send: 'deny' } } });
    expect((await manager.authorizeSession(session.id, 'group_tools.send'))?.allowed).toBe(false);
    await manager.save('cli_one', 'oc_one', { expectedRevision: changed.binding!.revision, patch: { state: 'disabled' } });
    expect((await manager.authorizeSession(session.id, 'run.interrupt'))?.allowed).toBe(false);
  });

  it('only switches the active permission identity when the queued task starts', async () => {
    const first = await save();
    const bob = (await manager.members('cli_one', 'oc_one')).members[1]!;
    await manager.save('cli_one', 'oc_one', { expectedRevision: first.binding!.revision, patch: {}, roleChanges: [{ kind: 'create', principalId: bob.principalId, role: 'can_operate', operateScope: 'group_runs', actionGates: { terminalWrite: false, highRisk: true, groupToolsSend: false } }] });
    await saveLarkConfig(repos.config, repos.agents, { originalAppId: 'cli_one', riskControlMode: 'enforced', highRiskPattern: 'rm' });
    const config = await manager.resolved((await readLarkConfig(repos.config, 'cli_one'))!, 'oc_one');
    const session: Session = { id: 'active-identity', agentId: 'agent_one', cwd: dir, state: 'thinking', runId: 'run', createdAt: time.toISOString(), updatedAt: time.toISOString() };
    await manager.recordRun(session, config, event, 'thread:om_root');
    await manager.beginTurn(session.id, 'ou_alice');
    expect((await manager.riskPolicy(session.id))?.authorized).toBe(false);
    await manager.recordRun(session, config, { ...event, senderOpenId: 'ou_bob' }, 'thread:om_root');
    expect((await manager.riskPolicy(session.id))?.authorized).toBe(false);
    await expect(manager.beginTurn(session.id)).rejects.toMatchObject({ code: 'LARK_TASK_ACTOR_REQUIRED' });
    await manager.beginTurn(session.id, 'ou_bob');
    expect((await manager.riskPolicy(session.id))?.authorized).toBe(true);
  });

  it('never grants a running legacy Agent the identity of a newly recorded queued sender', async () => {
    const session: Session = { id: 'activation-tools', agentId: 'agent_one', cwd: dir, source: 'lark', sourceId: 'cli_one:oc_one:group:chat:oc_one', state: 'thinking', runId: 'run', createdAt: time.toISOString(), updatedAt: time.toISOString() };
    await repos.sessions.save(session);
    const bob = (await manager.members('cli_one', 'oc_one')).members[1]!;
    await save('cli_one', 'oc_one', { accessOverride: { mode: 'allowlist', principalIds: [bob.principalId] } });
    const config = await manager.resolved((await readLarkConfig(repos.config, 'cli_one'))!, 'oc_one');
    const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:1');
    const token = capabilities.environmentFor(session).dockmux_group_tools_token;
    const sendText = vi.fn(async () => ({ messageId: 'om_test', chatId: 'oc_one' }));
    const tools = new LarkAgentToolsService(capabilities, repos.config, { groupManager: manager, clientFactory: () => ({ sendText }) as any });
    try {
      await expect(tools.send(token, { content: 'before activation' })).rejects.toMatchObject({ statusCode: 403 });
      await manager.recordRun(session, config, { ...event, senderOpenId: 'ou_bob' }, 'chat:oc_one');
      await expect(tools.send(token, { content: 'Bob is still queued' })).rejects.toMatchObject({ statusCode: 403 });
      expect(sendText).not.toHaveBeenCalled();
      await manager.beginTurn(session.id, 'ou_bob');
      await tools.send(token, { content: 'Bob is now executing' });
      expect(sendText).toHaveBeenCalledTimes(1);
    } finally { capabilities.close(); }
  });

  it('enforces new group restrictions on an existing legacy session and refreshes its policy', async () => {
    await save('cli_one', 'oc_one', { accessOverride: { mode: 'disabled', principalIds: [] } });
    const session: Session = { id: 'legacy', agentId: 'agent_one', cwd: dir, source: 'lark', sourceId: 'cli_one:oc_one:group:thread:om_root', state: 'thinking', runId: 'run', createdAt: time.toISOString(), updatedAt: time.toISOString() };
    await repos.sessions.save(session);
    expect((await manager.authorizeSession(session.id, 'turn.append', true))?.allowed).toBe(false);
    expect(await manager.riskPolicy(session.id, { enabled: true, authorized: true, pattern: 'rm' })).toMatchObject({ enabled: true, authorized: false, pattern: '.*' });
    const setRiskPolicy = vi.fn();
    const unmanaged = { ...session, id: 'unmanaged', sourceId: 'cli_two:oc_one:group:thread:om_legacy' };
    await repos.sessions.save(unmanaged);
    await manager.refreshPolicies({ listSessions: async () => [session, unmanaged], setRiskPolicy });
    expect(setRiskPolicy).toHaveBeenCalledTimes(1);
    expect(setRiskPolicy).toHaveBeenCalledWith(session.id, expect.objectContaining({ authorized: false }));
  });

  it('allows revocation with a deleted workspace and restores a revoked role with a new revision', async () => {
    const first = await save('cli_one', 'oc_one', { workspaceOverride: { mode: 'set', value: join(dir, 'one') } });
    const alice = (await manager.members('cli_one', 'oc_one')).members[0]!;
    const change = { kind: 'create', principalId: alice.principalId, role: 'can_operate', operateScope: 'group_runs', actionGates: { terminalWrite: false, highRisk: false, groupToolsSend: false } };
    const granted = await manager.save('cli_one', 'oc_one', { expectedRevision: first.binding!.revision, patch: {}, roleChanges: [change] });
    await rm(join(dir, 'one'), { recursive: true });
    time = new Date(time.getTime() + 2 * 60 * 60_000);
    const revoked = await manager.save('cli_one', 'oc_one', { expectedRevision: granted.binding!.revision, patch: {}, roleChanges: [{ kind: 'update', id: granted.roles[0]!.id, expectedRevision: granted.roles[0]!.revision, patch: { state: 'revoked' } }] });
    await manager.sync('cli_one');
    const restored = await manager.save('cli_one', 'oc_one', { expectedRevision: revoked.binding!.revision, patch: {}, roleChanges: [change] });
    expect(restored.roles[0]!.state).toBe('active');
    expect(restored.roles[0]!.revision).toBeGreaterThan(revoked.roles[0]!.revision);
    await repos.agents.delete('agent_one');
    time = new Date(time.getTime() + 2 * 60 * 60_000);
    const disabled = await manager.save('cli_one', 'oc_one', { expectedRevision: restored.binding!.revision, patch: { accessOverride: { mode: 'disabled', principalIds: [] } } });
    expect(disabled.binding!.accessOverride.mode).toBe('disabled');
  });

  it('does not treat a quoted group message as continuation of a Bot-owned topic', async () => {
    await save();
    const config = (await readLarkConfig(repos.config, 'cli_one'))!;
    await repos.sessions.save({ id: 'chat', agentId: 'agent_one', cwd: dir, source: 'lark', sourceId: 'cli_one:oc_one:group:chat:oc_one', state: 'idle', runId: 'run', createdAt: time.toISOString(), updatedAt: time.toISOString() });
    expect(await manager.ownsTopic(config, { ...event, threadId: undefined, rootId: 'om_quote' }, 'chat:oc_one')).toBe(false);
  });

  it('retains old execution context while new topics use new defaults and explicit clear', async () => {
    await save();
    const config = await manager.resolved((await readLarkConfig(repos.config, 'cli_one'))!, 'oc_one');
    const existing: Session = { id: 'old', agentId: 'agent_two', cwd: join(dir, 'one'), model: 'old_model', state: 'idle', source: 'lark', sourceId: 'cli_one:oc_one:group:thread:om_root', permissionMode: 'full-trust', runId: 'run', createdAt: time.toISOString(), updatedAt: time.toISOString() };
    const start = vi.fn(async input => ({ ...existing, ...input, id: 'new' }));
    const runtime: any = { getSession: async () => existing, listSessions: async () => [existing], start, stop: vi.fn() };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    expect((await resolveLarkSession(runtime, log, { tail: Promise.resolve() }, config, 'oc_one', 'group', 'thread:om_root')).id).toBe('old');
    expect((await resolveLarkSession(runtime, log, { tail: Promise.resolve() }, config, 'oc_one', 'group', 'thread:other')).id).toBe('new');
    expect(start.mock.calls[0]![0]).not.toHaveProperty('model');
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it('does not activate imported same-App configuration', async () => {
    await saveLarkConfig(repos.config, repos.agents, { appId: 'cli_import', appSecret: 'synthetic' });
    await repos.channelBots.create({ id: 'imported', externalAppId: 'cli_import', displayName: '导入', brand: 'feishu', channel: 'lark', state: 'staged' });
    await expect(manager.sync('cli_import')).rejects.toMatchObject({ code: 'LARK_IMPORTED_BOT_CONFLICT' });
    expect(await manager.owner('cli_import')).toBeUndefined();
  });

  it('atomically protects different App edits and rejects same-App stale edits across repository instances', async () => {
    const other = createRepositories(join(dir, 'state.sqlite'));
    try {
      await Promise.all([
        saveLarkConfig(repos.config, repos.agents, { originalAppId: 'cli_one', expectedRevision: 1, workspace: join(dir, 'one') }),
        saveLarkConfig(other.config, other.agents, { originalAppId: 'cli_two', expectedRevision: 1, workspace: join(dir, 'two') })
      ]);
      expect((await readLarkConfig(repos.config, 'cli_one'))!.workspace).toBe(join(dir, 'one'));
      expect((await readLarkConfig(repos.config, 'cli_two'))!.workspace).toBe(join(dir, 'two'));
      await expect(saveLarkConfig(other.config, other.agents, { originalAppId: 'cli_one', expectedRevision: 1, workspace: dir })).rejects.toMatchObject({ statusCode: 409 });
      await Promise.all([deleteLarkConfig(other.config, 'cli_two'), saveLarkConfig(repos.config, repos.agents, { originalAppId: 'cli_one', expectedRevision: 2, name: 'updated' })]);
      expect(await readLarkConfig(repos.config, 'cli_two')).toBeUndefined();
      expect((await readLarkConfig(repos.config, 'cli_one'))!.name).toBe('updated');
    } finally { other.close(); }
  });
});
