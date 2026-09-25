import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { agentConfigSchema, installationOwnerTaskActor, type AgentDriver } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { createCollaborationIntegration } from './collaboration-integration.js';
import { LarkGroupManager } from './lark/group-management.js';
import { readLarkConfig, saveLarkConfig } from './lark/config.js';
import { LarkAgentToolCapabilityRegistry, LarkAgentToolsService, type AgentGroupToolError } from './lark/agent-tools.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
const scope = { appId: 'cli_collaboration', chatId: 'oc_group' };
async function eventually(check: () => Promise<boolean>) {
  for (let count = 0; count < 100; count++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Condition did not converge');
}
async function fixture(options: { realAcp?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'collaboration-wiring-'));
  const repos = createRepositories(join(directory, 'test.db'), { newDatabaseAuthority: 'ledger_v1' });
  const agent = agentConfigSchema.parse({ id: 'agent', name: 'Agent', command: options.realAcp ? process.execPath : 'fake', ...(options.realAcp ? { args: [resolve('tests/fixtures/mock-acp-agent.mjs')], timeout: 2 } : {}), protocol: 'acp', cwd: directory, permissionMode: 'full-trust' });
  await repos.agents.save(agent);
  await saveLarkConfig(repos.config, repos.agents, { ...scope, appSecret: 'synthetic', defaultAgentId: agent.id, workspace: directory, fullTrustConfirmed: true, listening: true, groupToolsEnabled: true, groupToolsAllowSend: true, riskControlMode: 'enforced', highRiskPattern: 'rm\\s' });
  let members = ['ou_alice'];
  const client = {
    getBotInfo: async () => ({ appName: 'Agent', openId: 'ou_bot' }),
    checkApplicationIdentity: async () => ({ verified: true, reportedAppId: scope.appId, tenantKey: 'synthetic' }),
    listChats: vi.fn(async () => ({ items: [{ chatId: scope.chatId, name: '文档协作', external: false }], hasMore: false })),
    listChatMembers: async () => ({ items: members.map(openId => ({ memberId: openId, openId, name: openId, memberType: 'user' })), hasMore: false, securityLimited: false }),
    getUserEmails: async () => [],
    getChatPreflightInfo: async () => ({ name: '文档协作', description: '讨论资料进度' }),
    listMessages: vi.fn(async () => ({ items: [], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })),
    addReaction: vi.fn(async () => ({ reactionId: 'reaction' })), deleteReaction: vi.fn(async () => {}), listOwnReactions: vi.fn(async () => []),
    sendText: vi.fn(async (_input: { text: string }) => ({ messageId: 'om_result', chatId: scope.chatId })),
    replyText: vi.fn(async () => ({ messageId: 'om_reply', chatId: scope.chatId }))
  };
  const groups = new LarkGroupManager(repos, { client: () => client as any });
  await groups.sync(scope.appId);
  const group = await groups.save(scope.appId, scope.chatId, { expectedRevision: 0, patch: {} });
  let collaboration: ReturnType<typeof createCollaborationIntegration>;
  const calls: Array<{ sessionId: string; prompt: string; finish(text: string): void }> = [];
  const stopped: string[] = [];
  const runtime = new DutydeckRuntime(repos, {
    workspaceRoot: join(directory, 'workspaces'), cleanupIntervalMs: 0,
    probe: (() => ({ available: true, protocol: 'acp', acp: true })) as any,
    authorizeExecution: async (id, actor) => { await collaboration.background.authorizeExecution(id, actor); },
    authorizeTask: (session, task) => collaboration.background.authorizeTask(session, task),
    authorizeControl: async (id, actor) => { await collaboration.background.authorizeControl(id, actor); },
    resolveRiskPolicy: async (id, fallback) => (await collaboration.riskPolicy(id, fallback))?.policy,
    driverFactory: options.realAcp ? undefined : (_agent, _protocol, onEvent, _exit, sessionId) => {
      let end: (() => void) | undefined;
      return {
        start: async () => {}, resume: async () => {},
        stop: async () => { stopped.push(sessionId); end?.(); }, isStopped: async () => stopped.includes(sessionId),
        interrupt: async () => { end?.(); },
        send: (prompt: string) => new Promise<void>(resolve => {
          end = () => { onEvent({ type: 'completed', data: { stopReason: 'cancelled' } }); resolve(); };
          calls.push({ sessionId, prompt, finish(text) { onEvent({ type: 'text', data: { text } }); onEvent({ type: 'completed', data: { stopReason: 'end_turn' } }); end = undefined; resolve(); } });
        })
      } satisfies AgentDriver;
    }
  });
  collaboration = createCollaborationIntegration({ repositories: repos, runtime, groups, workspaceRoot: directory, client: () => client as any });
  await runtime.initialize([agent]);
  let clock = new Date();
  collaboration.scheduler.options.now = () => clock;
  collaboration.service.options.now = () => clock;
  cleanups.push(async () => { await collaboration.close(); await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true }); });
  const create = (id = 'review', prompt = '总结还缺的资料') => collaboration.service.createMandate(scope, 'ou_alice', { id, goal: '检查资料进展', mode: 'agent', prompt, condition: 'always', trigger: { kind: 'interval', everySeconds: 60, anchorAt: clock.toISOString() }, timezone: 'UTC' });
  return { repos, runtime, collaboration, groups, client, group, calls, stopped, create,
    advance() { clock = new Date(clock.getTime() + 60_000); }, revoke() { members = []; } };
}

it('resolves Bot defaults on every read and keeps explicit group overrides until inheritance is restored', async () => {
  const f = await fixture();
  await saveLarkConfig(f.repos.config, f.repos.agents, { originalAppId: scope.appId, defaultGroupParticipation: 'selective' });
  expect((await f.collaboration.service.get(scope, installationOwnerTaskActor)).snapshot.settings).toMatchObject({ revision: 0, participation: 'selective', inheritParticipation: true });
  await f.collaboration.service.updateSettings(scope, installationOwnerTaskActor, { expectedRevision: 0, instructions: '简短回答' });
  expect(await f.collaboration.service.repositories.collaboration.getSettings(scope)).toMatchObject({ participation: 'selective', inheritParticipation: true });
  await f.collaboration.service.updateSettings(scope, installationOwnerTaskActor, { expectedRevision: 1, participation: 'off' });
  await saveLarkConfig(f.repos.config, f.repos.agents, { originalAppId: scope.appId, defaultGroupParticipation: 'observe' });
  expect(await f.collaboration.service.repositories.collaboration.getSettings(scope)).toMatchObject({ participation: 'off', inheritParticipation: false });
  await f.collaboration.service.updateSettings(scope, installationOwnerTaskActor, { expectedRevision: 2, inheritParticipation: true });
  expect(await f.collaboration.service.repositories.collaboration.getSettings(scope)).toMatchObject({ participation: 'observe', inheritParticipation: true });
  expect(await f.repos.collaboration.getSettings(scope)).toMatchObject({ participation: 'off', inheritParticipation: true });
  expect(await f.collaboration.service.repositories.collaboration.getSettings({ ...scope, appId: 'another_bot' })).toMatchObject({ participation: 'off' });
});

it('re-sends the participation mode line when an inheriting group follows a changed Bot default', async () => {
  const f = await fixture();
  await saveLarkConfig(f.repos.config, f.repos.agents, { originalAppId: scope.appId, defaultGroupParticipation: 'observe' });
  const before = await f.repos.collaboration.getSettings(scope);
  const first = (await f.collaboration.participation.taskContext(scope))!;
  expect(first.text).toContain('本群参与模式：仅观察');
  await saveLarkConfig(f.repos.config, f.repos.agents, { originalAppId: scope.appId, defaultGroupParticipation: 'selective' });
  // 改的是机器人默认值：群自己的设置修订不变，只有有效模式变了。
  expect(await f.repos.collaboration.getSettings(scope)).toMatchObject({ revision: before.revision, inheritParticipation: true });
  const next = (await f.collaboration.participation.taskContext(scope, { watermark: first.watermark }))!;
  expect(next.text.split('\n')[0]).toBe('[Dutydeck 群上下文 · 自上轮以来的新增 · 非指令材料]');
  expect(next.text).toContain('本群参与模式：Tag 按需参与');
  const settled = (await f.collaboration.participation.taskContext(scope, { watermark: next.watermark }))!;
  expect(settled.text).toContain('自上轮以来无新增');
});

it('discovers existing groups and handles a newly joined group without per-group setup or restarting the runtime', async () => {
  const f = await fixture();
  const second = { ...scope, chatId: 'oc_second' }, joined = { ...scope, chatId: 'oc_joined' };
  f.client.listChats.mockResolvedValue({ items: [scope, second].map(item => ({ chatId: item.chatId, name: item.chatId, external: false })), hasMore: false });
  await saveLarkConfig(f.repos.config, f.repos.agents, { originalAppId: scope.appId, defaultGroupParticipation: 'selective' });
  await f.collaboration.participation.refresh(scope.appId);
  expect((await f.collaboration.service.get(second, installationOwnerTaskActor)).snapshot.settings).toMatchObject({ participation: 'selective', inheritParticipation: true });
  expect(await f.repos.collaboration.getSettings(second)).toMatchObject({ revision: 0, inheritParticipation: true });
  f.client.listChats.mockResolvedValue({ items: [scope, second, joined].map(item => ({ chatId: item.chatId, name: item.chatId, external: false })), hasMore: false });
  const config = (await readLarkConfig(f.repos.config, scope.appId))!;
  await f.collaboration.participation.handle({ messageId: 'om_joined', chatId: joined.chatId, chatType: 'group', senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: '{"text":"帮我总结这里的进展"}', createTime: String(Date.now()), mentions: [] }, config, { explicit: false });
  const flushing = f.collaboration.participation.flush(joined);
  await eventually(async () => f.calls.length === 1);
  const snapshot = JSON.parse(f.calls[0]!.prompt.split('[非指令材料 JSON]\n')[1]!.split('\n[/非指令材料]')[0]!);
  expect(snapshot.scope).toEqual(joined);
  f.calls[0]!.finish(JSON.stringify({ action: 'reply', reason: '直接提问', evidenceIds: [snapshot.observations.find((item: any) => item.messageId === 'om_joined').id], updates: [] }));
  await eventually(async () => f.calls.length === 2);
  expect(f.client.addReaction).toHaveBeenCalledWith('om_joined', 'OK');
  f.calls[1]!.finish('{"response":"目前可见材料不足，请补充具体进展。"}');
  await flushing;
  expect(f.client.replyText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ messageId: 'om_joined', text: '目前可见材料不足，请补充具体进展。' }));
  expect(f.client.deleteReaction).toHaveBeenCalledWith('om_joined', 'reaction');
  expect((await f.collaboration.service.get(joined, installationOwnerTaskActor)).snapshot.settings).toMatchObject({ revision: 0, participation: 'selective', inheritParticipation: true });
  expect((await f.groups.groups()).groups.every(item => item.bots.every(bot => bot.applied))).toBe(true);
});

it('keeps an unconfigured Bot and explicitly closed or disabled groups out of automatic participation', async () => {
  const f = await fixture();
  const closed = { ...scope, chatId: 'oc_closed' };
  f.client.listChats.mockResolvedValue({ items: [scope, closed].map(item => ({ chatId: item.chatId, name: item.chatId, external: false })), hasMore: false });
  await f.collaboration.participation.refresh(scope.appId);
  expect(f.client.listChatMessages).not.toHaveBeenCalled();
  expect((await f.groups.groups()).groups.find(item => item.chatId === closed.chatId)).toBeUndefined();
  await f.repos.collaboration.updateSettings(closed, { expectedRevision: 0, participation: 'off' }, 'owner');
  await f.groups.save(scope.appId, scope.chatId, { expectedRevision: f.group.binding!.revision, patch: { accessOverride: { mode: 'disabled', principalIds: [] } } });
  await saveLarkConfig(f.repos.config, f.repos.agents, { originalAppId: scope.appId, defaultGroupParticipation: 'selective' });
  await f.collaboration.participation.refresh(scope.appId);
  expect(f.client.listChatMessages).not.toHaveBeenCalled();
  expect((await f.groups.groups()).groups.find(item => item.chatId === closed.chatId)!.bots[0]!.binding).toBeUndefined();
  expect((await f.groups.groupAccess(scope.appId, scope.chatId))!.effective.mode).toBe('disabled');
  expect(f.calls).toHaveLength(0);
});

it('stops an inherited reply when the Bot default is disabled during response generation', async () => {
  const f = await fixture();
  await saveLarkConfig(f.repos.config, f.repos.agents, { originalAppId: scope.appId, defaultGroupParticipation: 'selective' });
  await f.collaboration.participation.handle({ messageId: 'om_stop', chatId: scope.chatId, chatType: 'group', senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: '{"text":"回答一下"}', createTime: String(Date.now()), mentions: [] }, (await readLarkConfig(f.repos.config, scope.appId))!, { explicit: false });
  const flushing = f.collaboration.participation.flush(scope);
  await eventually(async () => f.calls.length === 1);
  const snapshot = JSON.parse(f.calls[0]!.prompt.split('[非指令材料 JSON]\n')[1]!.split('\n[/非指令材料]')[0]!);
  f.calls[0]!.finish(JSON.stringify({ action: 'reply', reason: '直接提问', evidenceIds: [snapshot.observations.find((item: any) => item.messageId === 'om_stop').id], updates: [] }));
  await eventually(async () => f.calls.length === 2);
  await saveLarkConfig(f.repos.config, f.repos.agents, { originalAppId: scope.appId, defaultGroupParticipation: 'off' });
  f.calls[1]!.finish('{"response":"旧请求的答复"}'); await flushing;
  expect(f.client.replyText).not.toHaveBeenCalled();
  expect(f.client.deleteReaction).toHaveBeenCalledWith('om_stop', 'reaction');
  expect((await f.repos.collaboration.listDecisions(scope))[0]!.status).toBe('suppressed');
});

it('reads another joined group for Tag without activating its participation or changing the reply destination', async () => {
  const f = await fixture();
  const personal = { ...scope, chatId: 'oc_personal' };
  await saveLarkConfig(f.repos.config, f.repos.agents, { originalAppId: scope.appId, defaultGroupParticipation: 'selective' });
  await f.repos.collaboration.updateSettings(personal, { expectedRevision: 0, participation: 'off' }, 'owner');
  f.client.listChats.mockResolvedValue({ items: [{ chatId: scope.chatId, name: '测试群', external: false }, { chatId: personal.chatId, name: '个人待办', external: false }], hasMore: false });
  f.client.listChatMessages.mockImplementation(async (input?: any) => ({ items: input.chatId === personal.chatId ? [{
    messageId: 'om_capacity', chatId: personal.chatId, messageType: 'text', rawContent: '{"text":"推进容量扫描，监控 RDS 和 Abase 水位"}',
    createTime: String(Date.now() - 10000), sender: { id: 'ou_alice', type: 'user' }, mentions: [], deleted: false, updated: false
  }] : [], hasMore: false }));
  await f.collaboration.participation.handle({ messageId: 'om_team_question', chatId: scope.chatId, chatType: 'group', senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: '{"text":"看看我的个人待办都有什么"}', createTime: String(Date.now()), mentions: [] }, (await readLarkConfig(f.repos.config, scope.appId))!, { explicit: false });
  const flushing = f.collaboration.participation.flush(scope);
  await eventually(async () => f.calls.length === 1);
  const snapshot = JSON.parse(f.calls[0]!.prompt.split('[非指令材料 JSON]\n')[1]!.split('\n[/非指令材料]')[0]!);
  expect(snapshot.teamContext.sources).toEqual(expect.arrayContaining([expect.objectContaining({ scope: personal, name: '个人待办' })]));
  const evidence = snapshot.teamContext.observations.find((item: any) => item.messageId === 'om_capacity');
  expect(evidence.scope).toEqual(personal);
  f.calls[0]!.finish(JSON.stringify({ action: 'reply', reason: '当前请求查询另一个可读群', evidenceIds: [snapshot.observations.find((item: any) => item.messageId === 'om_team_question').id, evidence.id], updates: [] }));
  await eventually(async () => f.calls.length === 2);
  expect(f.calls[1]!.prompt).toContain('推进容量扫描');
  f.calls[1]!.finish('{"response":"「个人待办」群：推进容量扫描，监控 RDS 和 Abase 水位。"}');
  await flushing;
  expect(f.client.replyText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ messageId: 'om_team_question', text: expect.stringContaining('个人待办') }));
  expect((await f.repos.collaboration.getSettings(personal)).participation).toBe('off');
  expect(await f.repos.groupBindings.getByNaturalKey((await f.groups.owner(scope.appId))!.channelBotId, personal.chatId)).toBeUndefined();
  expect((await f.runtime.listSessions()).every(item => item.permissionMode === 'deny-all')).toBe(true);
});

async function teamSearchFixture() {
  const f = await fixture();
  const personal = { ...scope, chatId: 'oc_personal' };
  // 设置后，下一次读取来源群消息（reader.read，不含 authorize 的单条探测）时先执行它，模拟读取期间的配置变化。
  let duringRead: (() => Promise<unknown>) | undefined;
  f.client.listChats.mockResolvedValue({ items: [{ chatId: scope.chatId, name: '测试群', external: false }, { chatId: personal.chatId, name: '个人待办', external: false }], hasMore: false });
  f.client.listChatMessages.mockImplementation(async (input?: any) => {
    if (input.chatId === personal.chatId && input.pageSize !== 1 && duringRead) { const change = duringRead; duringRead = undefined; await change(); }
    return { items: input.chatId === personal.chatId ? [
      { messageId: 'om_capacity', chatId: personal.chatId, messageType: 'text', rawContent: '{"text":"推进容量扫描，监控 RDS 和 Abase 水位"}',
        createTime: String(Date.now() - 10000), sender: { id: 'ou_alice', type: 'user' }, mentions: [], deleted: false, updated: false },
      { messageId: 'om_lunch', chatId: personal.chatId, messageType: 'text', rawContent: '{"text":"今天午饭吃什么"}',
        createTime: String(Date.now() - 5000), sender: { id: 'ou_alice', type: 'user' }, mentions: [], deleted: false, updated: false }
    ] : [], hasMore: false };
  });
  const session = await f.runtime.start({ agentId: 'agent', source: 'lark', sourceId: `${scope.appId}:${scope.chatId}:group:user:ou_alice` });
  const capabilities = new LarkAgentToolCapabilityRegistry(f.repos.sessions, 'http://localhost', 'secret');
  // 模拟群成员 ou_alice 触发的这一轮：工具调用按其身份走真实的群访问策略。
  const tools = new LarkAgentToolsService(capabilities, f.repos.config, { teamSearch: () => f.collaboration.teamSearch, groupManager: f.groups, authorizeTool: async () => ({ actorId: 'ou_alice' }) });
  const token = capabilities.environmentFor(session).dutydeck_group_tools_token;
  return { f, personal, tools, token, onRead(change: () => Promise<unknown>) { duringRead = change; } };
}

it('serves group team-search from the real reader only while this group has participation on', async () => {
  const { f, personal, tools, token } = await teamSearchFixture();
  await expect(tools.teamSearch(token, { query: '容量扫描' })).rejects.toMatchObject({ code: 'GROUP_TEAM_SEARCH_UNAVAILABLE', statusCode: 403 });
  expect(f.client.listChatMessages).not.toHaveBeenCalledWith(expect.objectContaining({ chatId: personal.chatId }));
  await saveLarkConfig(f.repos.config, f.repos.agents, { originalAppId: scope.appId, defaultGroupParticipation: 'selective' });
  const result = await tools.teamSearch(token, { query: '容量扫描' });
  expect(result.sources).toEqual([expect.objectContaining({ name: '个人待办', chatId: personal.chatId, entries: [expect.stringContaining('ou_alice(human): 推进容量扫描，监控 RDS 和 Abase 水位')] })]);
  expect(JSON.stringify(result)).not.toContain('午饭');
  expect((await f.repos.collaboration.getSettings(personal)).participation).toBe('off');
});

it.each([
  ['participation is turned off', 'GROUP_TEAM_SEARCH_UNAVAILABLE', (f: Awaited<ReturnType<typeof fixture>>) => saveLarkConfig(f.repos.config, f.repos.agents, { originalAppId: scope.appId, defaultGroupParticipation: 'off' })],
  ['the group is disabled', 'LARK_GROUP_POLICY_DENIED', (f: Awaited<ReturnType<typeof fixture>>) => f.groups.save(scope.appId, scope.chatId, { expectedRevision: f.group.binding!.revision, patch: { accessOverride: { mode: 'disabled', principalIds: [] } } })]
] as const)('discards team-search material when %s while other groups are being read', async (_label, code, change) => {
  const { f, tools, token, onRead } = await teamSearchFixture();
  await saveLarkConfig(f.repos.config, f.repos.agents, { originalAppId: scope.appId, defaultGroupParticipation: 'selective' });
  expect(JSON.stringify(await tools.teamSearch(token, { query: '容量扫描' }))).toContain('推进容量扫描');
  onRead(() => change(f));
  const error = await tools.teamSearch(token, { query: '容量扫描' }).then(() => undefined, (caught: AgentGroupToolError) => caught);
  expect(error).toMatchObject({ code, statusCode: 403 });
  const body = JSON.stringify(error!.response());
  for (const leaked of ['推进容量扫描', '个人待办', 'oc_personal']) expect(body).not.toContain(leaked);
});

it.each(['ask', undefined] as const)('runs unattended %s delegations through real ACP without leaving permission requests pending', async permissionMode => {
  const f = await fixture({ realAcp: true });
  const original = f.collaboration.background.options.resolveConfig;
  f.collaboration.background.options.resolveConfig = async scope => ({ ...await original(scope), permissionMode });
  await f.create('permission-summary', 'request permission'); f.advance(); await f.collaboration.scheduler.tick();
  const session = (await f.runtime.listSessions()).find(item => item.id.startsWith('ses_collab_'))!;
  await expect.poll(async () => (await f.runtime.getTasks(session.id))[0]?.status, { timeout: 6_000 }).toMatch(/completed|reconcile_required/);
  expect((await f.runtime.getTasks(session.id))[0]?.status).toBe('completed');
  expect(session.permissionMode).toBe('deny-all');
  expect(await f.runtime.getPendingPermissions(session.id)).toEqual([]);
  const events = await f.repos.events.listWindow(session.id, { limit: 100 });
  expect(events.some(event => event.type === 'permission_request' && (event.data as { status?: string }).status === 'pending')).toBe(false);
  await f.collaboration.scheduler.tick(); await f.collaboration.scheduler.tick();
  expect(f.client.sendText).toHaveBeenCalledOnce();
  expect(f.client.sendText.mock.calls[0]![0]).toMatchObject({ text: expect.stringContaining('deny') });
  const tasks = await f.runtime.getTasks(session.id);
  expect(tasks).toHaveLength(1);
  expect(f.repos.execution.getTaskExecution(tasks[0]!.id)?.attempts).toEqual([expect.objectContaining({ state: 'settled', outcome: 'completed' })]);
  const actions = await f.repos.collaboration.listActions(scope);
  const request = actions.find(action => action.kind === 'agent_execution')!.payload.request as { prompt: string; options: { permissionMode: string } };
  expect(request.options.permissionMode).toBe('deny-all');
  expect(request.prompt).toContain('不调用工具');
  expect(request.prompt).toContain('不能声称');
});

it.each(['approve-reads', 'full-trust'] as const)('retains explicit %s background tool policy', async permissionMode => {
  const f = await fixture();
  const original = f.collaboration.background.options.resolveConfig;
  f.collaboration.background.options.resolveConfig = async scope => ({ ...await original(scope), permissionMode });
  await f.create(); f.advance(); await f.collaboration.scheduler.tick();
  await eventually(async () => f.calls.length === 1);
  expect((await f.runtime.getSession(f.calls[0]!.sessionId))?.permissionMode).toBe(permissionMode);
  expect(f.calls[0]!.prompt).not.toContain('不调用工具');
  f.calls[0]!.finish('Done');
});

it('passes partial history coverage and omitted-context markers through the real runtime to the background driver', async () => {
  const f = await fixture();
  const bootstrap = { scope, status: 'partial' as const, missing: ['context_omitted:observations=50', 'Earlier alert history is outside this window'], updatedAt: new Date().toISOString() };
  await f.repos.collaboration.saveBootstrap(bootstrap);
  await f.repos.collaboration.observe({ scope, source: 'lark.message', eventId: 'recent', occurredAt: bootstrap.updatedAt, receivedAt: bootstrap.updatedAt, senderKind: 'human', text: 'Latest visible discussion', refs: [], origin: 'history', missing: [] });
  await f.create('partial-summary'); f.advance(); await f.collaboration.scheduler.tick();
  await eventually(async () => f.calls.length === 1);
  const call = f.calls[0]!;
  const material = JSON.parse(call.prompt.slice(call.prompt.lastIndexOf('\n\n') + 2));
  expect(material.bootstrap).toEqual(bootstrap);
  expect(material.observations).toEqual([expect.objectContaining({ eventId: 'recent', text: 'Latest visible discussion' })]);
  expect(call.prompt).toContain('有限窗口');
  expect(call.prompt).toContain('不能据此推断全天无异常');
  expect(call.prompt).toContain('不得声称已完整查阅全天消息');
  const action = (await f.repos.collaboration.listActions(scope)).find(item => item.kind === 'agent_execution')!;
  expect((action.payload.request as { prompt: string }).prompt).toBe(call.prompt);
  call.finish('Only the supplied window was reviewed; earlier history is missing.');
});

it('uses real saved group bindings, runs one frozen background task and delivers its result once', async () => {
  const f = await fixture();
  expect((await f.groups.owner(scope.appId))?.activeGroups).toContain(f.group.binding!.id);
  expect(f.group.binding!.id).not.toBe(scope.chatId);
  expect(await f.collaboration.authorize(scope, 'ou_alice', 'execute')).toBe(true);
  await f.create(); f.advance(); await f.collaboration.scheduler.tick();
  await eventually(async () => f.calls.length === 1);
  const call = f.calls[0]!;
  expect(call.prompt).toContain('总结还缺的资料');
  const sessions = await f.runtime.listSessions();
  expect(sessions.filter(session => session.id.startsWith('ses_collab_'))).toHaveLength(1);
  await f.collaboration.scheduler.tick(); expect(f.calls).toHaveLength(1);
  const policy = (await f.collaboration.riskPolicy(call.sessionId))?.policy;
  expect(policy).toMatchObject({ enabled: true, authorized: false, pattern: 'rm\\s' });
  await saveLarkConfig(f.repos.config, f.repos.agents, { originalAppId: scope.appId, riskControlMode: 'off' });
  expect(await f.collaboration.riskPolicy(call.sessionId, policy)).toEqual({ policy: undefined });
  const capabilities = new LarkAgentToolCapabilityRegistry(f.repos.sessions, 'http://localhost:1');
  const tools = new LarkAgentToolsService(capabilities, f.repos.config, { groupManager: f.groups, clientFactory: () => f.client as any, authorizeTool: (id, action) => f.collaboration.background.authorizeTool(id, action) });
  const session = (await f.runtime.getSession(call.sessionId))!;
  const token = capabilities.environmentFor(session).dutydeck_group_tools_token;
  expect(await tools.workbenchContext(token)).toMatchObject({ sessionId: call.sessionId });
  await expect(tools.send(token, { content: 'duplicate' })).rejects.toMatchObject({ code: 'COLLABORATION_MANAGED_DELIVERY' });
  capabilities.close();
  call.finish('仍缺最终核对。');
  await eventually(async () => (await f.repos.tasks.listBySession(call.sessionId)).every(task => !['queued', 'running'].includes(task.status)));
  await f.collaboration.scheduler.tick(); await f.collaboration.scheduler.tick();
  expect(f.client.sendText).toHaveBeenCalledTimes(1);
  expect(f.client.sendText.mock.calls[0]?.[0]).toMatchObject({ chatId: scope.chatId, text: '仍缺最终核对。' });
  expect(f.calls).toHaveLength(1);
});

it('physically stops the original task after cancellation and rejects forged or revoked identities', async () => {
  const f = await fixture(); const { mandate } = await f.create(); f.advance(); await f.collaboration.scheduler.tick();
  await eventually(async () => f.calls.length === 1);
  const id = f.calls[0]!.sessionId;
  await expect(f.collaboration.background.authorizeExecution(id, 'ou_other')).rejects.toMatchObject({ code: 'COLLABORATION_EXECUTION_REVOKED' });
  await expect(f.runtime.stop(id, { kind: 'channel', appId: 'cli_foreign', id: 'ou_alice' })).rejects.toBeDefined();
  await f.collaboration.service.updateMandate(scope, 'ou_alice', mandate.id, { expectedRevision: mandate.revision, status: 'cancelled' });
  await f.collaboration.scheduler.tick();
  expect(f.stopped).toContain(id); expect(f.client.sendText).not.toHaveBeenCalled();
  expect((await f.collaboration.riskPolicy(id))?.policy).toMatchObject({ authorized: false, pattern: '.*' });
  expect(await f.collaboration.authorize(scope, 'ou_alice', 'manage')).toBe(false);
  expect(await f.collaboration.authorize(scope, installationOwnerTaskActor, 'manage')).toBe(true);
});

it('stores immutable instruction versions and fails closed when the current group is revoked', async () => {
  const f = await fixture();
  const patch = await f.collaboration.prepareSettings(scope, { expectedRevision: 0, participation: 'observe', instructions: '只补充遗漏' });
  await f.collaboration.service.updateSettings(scope, installationOwnerTaskActor, patch);
  expect(patch.policyVersion).toBe('revision-1');
  await expect(f.collaboration.prepareSettings(scope, { expectedRevision: 1, instructions: '改为每条都回复', policyVersion: 'revision-1' })).rejects.toMatchObject({ code: 'COLLABORATION_POLICY_VERSION_CONFLICT' });
  await expect(f.collaboration.prepareSettings(scope, { expectedRevision: 0, instructions: '过期草稿' })).rejects.toMatchObject({ code: 'COLLABORATION_REVISION_CONFLICT' });
  await f.create(); f.advance(); await f.collaboration.scheduler.tick(); await eventually(async () => f.calls.length === 1);
  const session = (await f.runtime.getSession(f.calls[0]!.sessionId))!;
  const capabilities = new LarkAgentToolCapabilityRegistry(f.repos.sessions, 'http://localhost');
  const tools = new LarkAgentToolsService(capabilities, f.repos.config, { authorizeTool: (id, action) => f.collaboration.background.authorizeTool(id, action) });
  const token = capabilities.environmentFor(session).dutydeck_group_tools_token;
  expect(await tools.memoryContext(token)).toMatchObject({ sessionId: session.id });
  f.revoke();
  await expect(tools.memoryContext(token)).rejects.toMatchObject({ code: 'COLLABORATION_EXECUTION_REVOKED' });
  capabilities.close();
  expect(await f.collaboration.authorize(scope, 'ou_alice', 'execute')).toBe(false);
  expect((await f.collaboration.riskPolicy(f.calls[0]!.sessionId))?.policy).toMatchObject({ authorized: false, pattern: '.*' });
});

it('keeps one real background execution while toggling delivery and resumes only its result', async () => {
  const f = await fixture(); const { mandate } = await f.create(); f.advance(); await f.collaboration.scheduler.tick();
  await eventually(async () => f.calls.length === 1);
  const call = f.calls[0]!;
  const paused = await f.collaboration.service.updateMandate(scope, 'ou_alice', mandate.id, { expectedRevision: mandate.revision, deliveryPaused: true });
  await f.collaboration.scheduler.tick();
  expect(f.stopped).not.toContain(call.sessionId);
  expect(await f.collaboration.background.authorizeExecution(call.sessionId, 'ou_alice')).toBe(true);
  await f.collaboration.service.updateMandate(scope, 'ou_alice', mandate.id, { expectedRevision: paused.mandate.revision, deliveryPaused: false });
  await f.collaboration.scheduler.tick(); expect(f.calls).toHaveLength(1);
  call.finish('已核对资料。');
  await eventually(async () => (await f.repos.tasks.listBySession(call.sessionId)).every(task => !['queued', 'running'].includes(task.status)));
  await f.collaboration.scheduler.tick(); await f.collaboration.scheduler.tick();
  expect(await f.repos.collaboration.listActions(scope)).toEqual(expect.arrayContaining([expect.objectContaining({kind: 'schedule_delivery', status: 'succeeded'})]));
  expect(f.client.sendText).toHaveBeenCalledTimes(1); expect(f.calls).toHaveLength(1);
});

it('applies the live execution gate to registered external actions, including local owner calls', async () => {
  const f = await fixture();
  const execute = vi.fn(async () => ({ receipt: 'external-result' }));
  f.collaboration.extensions.registerAction('document-export', { parse: input => input, execute });
  await f.groups.save(scope.appId, scope.chatId, { expectedRevision: f.group.binding!.revision, patch: { state: 'disabled' } });
  await expect(f.collaboration.extensions.execute('document-export', scope, installationOwnerTaskActor, 'export-one', {})).rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN' });
  expect(execute).not.toHaveBeenCalled();
});
