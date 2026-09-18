import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createCollaborationSchema } from '../../../../packages/storage/src/collaboration-migration.js';
import { createCollaborationRepository } from '../../../../packages/storage/src/collaboration.js';
import { RuntimeError, type CollaborationSnapshot, type CollaborationFollowup } from '@dutydeck/shared';
import { LarkGroupParticipation, type GroupParticipationOptions } from './group-participation.js';
import { LarkMessageCoordinator } from './coordinator.js';
import type { LarkMessageEvent } from './listener.js';
import type { StoredLarkConfig } from './config.js';
import type { ParticipationResult } from './readonly-decider.js';
import { LarkContextBootstrap } from './context-bootstrap.js';

const scope = { appId: 'cli_test', chatId: 'oc_test' };
const config: StoredLarkConfig = { appId: scope.appId, appSecret: 'test', listening: true, defaultAgentId: 'mock', workspace: '/tmp', fullTrustConfirmed: true,
  permissionMode: 'ask', preInjectPrompt: '', groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1000, hideTraceOnComplete: false,
  allowedUsers: [], allowedEmails: [], highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'danger', riskControlMode: 'off' };
const message = (id = 'om_1', text = '资料已提交', patch: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({ messageId: id, chatId: scope.chatId, chatType: 'group', messageType: 'text', content: JSON.stringify({ text }), createTime: '1789707600000', senderOpenId: 'ou_a', senderType: 'user', mentions: [], ...patch });
const silent = (): ParticipationResult => ({ action: 'silent', reason: '没有新增信息', evidenceIds: [], updates: [] });
const reply = (snapshot: CollaborationSnapshot): ParticipationResult => ({ action: 'reply', reason: '补充来源明确的新进展', evidenceIds: [snapshot.observations.find(item => item.origin === 'live')!.id], response: '材料已有进展', updates: [] });
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

async function harness(mode: 'off' | 'observe' | 'selective' = 'selective', extra: Pick<GroupParticipationOptions, 'withDelivery' | 'readMemory' | 'readGroupDescription'> = {}) {
  const db = new Database(':memory:'); createCollaborationSchema(db);
  const repository = createCollaborationRepository(db);
  if (mode !== 'off') await repository.updateSettings(scope, { expectedRevision: 0, participation: mode }, 'owner');
  const service = { listChatMessages: vi.fn(async (_input: any) => ({ items: [] as any[], hasMore: false })), replyText: vi.fn(async () => ({ messageId: 'om_sent' })), sendText: vi.fn(async () => ({ messageId: 'om_sent' })),
    addReaction: vi.fn(async () => ({ reactionId: 'reaction' })), deleteReaction: vi.fn(async () => {}), send: vi.fn(async () => ({ messageId: 'om_card' })), reply: vi.fn(async () => ({ messageId: 'om_card' })), update: vi.fn(async () => ({ messageId: 'om_card' })) };
  const decide = vi.fn(async (_config: StoredLarkConfig, _snapshot: CollaborationSnapshot) => silent());
  const authorize = vi.fn(async (_scope: typeof scope, _actor: string | undefined, _action: string, _followup?: CollaborationFollowup) => true);
  const options = { repository, decider: { decide }, authorize, readConfig: async () => config, serviceFor: () => service, readGroupDescription: async () => '测试群', listScopes: async () => [scope], debounceMs: 10000, ...extra };
  const participation = new LarkGroupParticipation(options);
  const session = { id: 's1', protocol: 'acp', state: 'idle', agentId: 'mock', cwd: '/tmp', permissionMode: 'ask', createdAt: '', updatedAt: '' };
  const runtime = { start: vi.fn(async () => session), getSession: vi.fn(async () => session), subscribe: vi.fn(() => vi.fn()), send: vi.fn(async () => {}), interrupt: vi.fn(async () => {}) };
  const coordinator = new LarkMessageCoordinator(runtime as any, service as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, Math.random, 'ou_bot', undefined, undefined, async () => 'group', undefined, undefined, { participation });
  cleanups.push(async () => { coordinator.stop(); await participation.close(); if (db.open) db.close(); });
  return { db, repository, service, decide, authorize, participation, coordinator, runtime, options };
}

describe('group observation and selective participation through the coordinator', () => {
  it('off preserves old ambient wake behavior and does not persist observation', async () => {
    const h = await harness('off');
    await h.coordinator.handle(message(), { ...config, mentionPolicy: 'ambient' });
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    expect(h.service.addReaction).toHaveBeenCalledOnce();
    expect(await h.repository.listObservations(scope)).toEqual([]);
    expect(h.decide).not.toHaveBeenCalled();
  });
  it('ambient yields to a message addressed at someone else, while never still wakes', async () => {
    const mentionsOther = { mentions: [{ key: '@_user_1', name: '同事', openId: 'ou_other' }] };
    const ambient = await harness('off');
    await ambient.coordinator.handle(message('om_other', '@_user_1 你看下这个', mentionsOther), { ...config, mentionPolicy: 'ambient' });
    await ambient.participation.flush(scope);
    expect(ambient.runtime.send).not.toHaveBeenCalled();
    expect(ambient.service.addReaction).not.toHaveBeenCalled();
    const never = await harness('off');
    await never.coordinator.handle(message('om_other', '@_user_1 你看下这个', mentionsOther), { ...config, mentionPolicy: 'never' });
    await vi.waitFor(() => expect(never.runtime.send).toHaveBeenCalledOnce());
  });
  it('ambient yields even when the message addressed at someone else carries a slash command', async () => {
    // 让路是彻底的：点名了别人的消息里就算带斜杠命令也不接。commandInteraction 由 legacyWake 推导，
    // always 策略下未被 @ 的同一条命令同样不触发，这里只是把 ambient 归到同一侧并锁住。
    const mentionsOther = { mentions: [{ key: '@_user_1', name: '同事', openId: 'ou_other' }] };
    const h = await harness('off');
    await h.coordinator.handle(message('om_cmd', '@_user_1 /help', mentionsOther), { ...config, mentionPolicy: 'ambient' });
    await h.participation.flush(scope);
    expect(h.runtime.send).not.toHaveBeenCalled();
    expect(h.service.addReaction).not.toHaveBeenCalled();
    expect(h.service.reply).not.toHaveBeenCalled();
    expect(h.service.send).not.toHaveBeenCalled();
    // 没有点名任何人时同一条命令照常处理。
    const open = await harness('off');
    await open.coordinator.handle(message('om_cmd', '/help'), { ...config, mentionPolicy: 'ambient' });
    await vi.waitFor(() => expect(open.service.reply.mock.calls.length + open.service.send.mock.calls.length).toBeGreaterThan(0));
  });
  it('stops calling the decider once the hourly decision budget is exhausted', async () => {
    const h = await harness();
    await h.repository.updateSettings(scope, { expectedRevision: 1, maxDecisionsPerHour: 1 }, 'owner');
    await h.coordinator.handle(message('om_1', '第一条'), { ...config, mentionPolicy: 'never' });
    await h.participation.flush(scope);
    expect(h.decide).toHaveBeenCalledOnce();
    await h.coordinator.handle(message('om_2', '第二条'), { ...config, mentionPolicy: 'never' });
    await h.participation.flush(scope);
    expect(h.decide).toHaveBeenCalledOnce();
    const decisions = await h.repository.listDecisions(scope);
    expect(decisions[0]).toMatchObject({ action: 'silent', status: 'suppressed' });
    expect(decisions[0]!.reason).toContain('判定预算');
  });
  it('does not let budget-gated records consume the next window', async () => {
    const h = await harness();
    await h.repository.updateSettings(scope, { expectedRevision: 1, maxDecisionsPerHour: 1 }, 'owner');
    await h.coordinator.handle(message('om_1', '第一条'), { ...config, mentionPolicy: 'never' });
    await h.participation.flush(scope);
    await h.coordinator.handle(message('om_2', '第二条'), { ...config, mentionPolicy: 'never' });
    await h.participation.flush(scope);
    expect(h.decide).toHaveBeenCalledOnce();
    // 被闸门挡下的记录不消耗预算：上限抬到 2 时，只有那一次真实判定计入。
    await h.repository.updateSettings(scope, { expectedRevision: 2, maxDecisionsPerHour: 2 }, 'owner');
    await h.coordinator.handle(message('om_3', '第三条'), { ...config, mentionPolicy: 'never' });
    await h.participation.flush(scope);
    expect(h.decide).toHaveBeenCalledTimes(2);
  });
  it('writes at most one gate record per hour so gated rows cannot fill the counting window', async () => {
    const h = await harness();
    await h.repository.updateSettings(scope, { expectedRevision: 1, maxDecisionsPerHour: 0 }, 'owner');
    for (const index of [1, 2, 3, 4, 5]) {
      await h.coordinator.handle(message(`om_${index}`, `第 ${index} 条`), { ...config, mentionPolicy: 'never' });
      await h.participation.flush(scope);
    }
    expect(h.decide).not.toHaveBeenCalled();
    // 五条消息只留一条闸门记录：否则超限期间每条消息写一条，500 条统计窗口会被闸门记录占满。
    expect(await h.repository.listDecisions(scope)).toHaveLength(1);
  });
  it('persists an unmentioned message before silence, with no reaction, card, or runtime task', async () => {
    const h = await harness();
    await h.coordinator.handle(message(), { ...config, mentionPolicy: 'never' });
    expect((await h.repository.listObservations(scope)).some(item => item.messageId === 'om_1')).toBe(true);
    await h.participation.flush(scope);
    expect(h.decide).toHaveBeenCalledOnce();
    expect((await h.repository.listDecisions(scope))[0]).toMatchObject({ action: 'silent' });
    expect(h.service.addReaction).not.toHaveBeenCalled(); expect(h.service.send).not.toHaveBeenCalled(); expect(h.service.reply).not.toHaveBeenCalled();
    expect(h.service.replyText).not.toHaveBeenCalled(); expect(h.runtime.send).not.toHaveBeenCalled();
  });
  it('observe records a reply candidate without sending or applying changes', async () => {
    const h = await harness('observe'); h.decide.mockImplementation(async (_config, snapshot) => reply(snapshot));
    await h.coordinator.handle(message(), config); await h.participation.flush(scope);
    expect((await h.repository.listDecisions(scope))[0]).toMatchObject({ action: 'reply', status: 'candidate' });
    expect(h.service.replyText).not.toHaveBeenCalled(); expect(await h.repository.listActions(scope)).toEqual([]);
  });
  it('explicit requests retain their ordinary execution and include manager instructions', async () => {
    const h = await harness('observe'); await h.repository.updateSettings(scope, { expectedRevision: 1, instructions: '简短并附来源' }, 'owner');
    await h.coordinator.handle(message('om_explicit', '@_user_1 hello', { mentions: [{ key: '@_user_1', name: 'Bot', openId: 'ou_bot' }] }), config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    expect(h.runtime.send.mock.calls[0]).toEqual(expect.arrayContaining([expect.stringContaining('简短并附来源')]));
    await h.participation.flush(scope); expect(h.decide).not.toHaveBeenCalled();
  });
  it('coalesces consecutive messages, sends through a persisted intent, and binds authority to group policy', async () => {
    const h = await harness(); h.decide.mockImplementation(async (_config, snapshot) => reply(snapshot));
    await h.coordinator.handle(message(), config); await h.coordinator.handle(message('om_2'), config); await h.participation.flush(scope);
    expect(h.decide).toHaveBeenCalledOnce(); expect(h.service.replyText).toHaveBeenCalledOnce();
    const action = (await h.repository.listActions(scope))[0]!;
    expect(action).toMatchObject({ status: 'succeeded', requesterId: 'policy:group-participation', receipt: 'om_sent' });
    expect(h.authorize).toHaveBeenCalledWith(scope, 'policy:group-participation', 'deliver');
    expect((await h.repository.listDecisions(scope))[0]!.inputSnapshot).toHaveProperty('observations');
    await h.coordinator.handle(message('om_2'), config); await h.participation.flush(scope);
    expect(h.service.replyText).toHaveBeenCalledOnce();
  });
  it.each(['pause', 'revoke', 'new-message', 'stop'])('suppresses a draft when %s occurs during model execution', async kind => {
    const h = await harness();
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    h.decide.mockImplementationOnce(async (_config, snapshot) => { await wait; return reply(snapshot); });
    await h.coordinator.handle(message(), config); const flushing = h.participation.flush(scope);
    await vi.waitFor(() => expect(h.decide).toHaveBeenCalledOnce());
    if (kind === 'pause') await h.repository.updateSettings(scope, { expectedRevision: 1, notificationsPaused: true }, 'owner');
    if (kind === 'revoke') h.authorize.mockResolvedValue(false);
    if (kind === 'new-message') await h.coordinator.handle(message('om_2', '已经解决，不需要再补充'), config);
    if (kind === 'stop') h.participation.closeApp(scope.appId);
    release(); await flushing;
    expect(h.service.replyText).not.toHaveBeenCalled();
    expect((await h.repository.listDecisions(scope)).some(item => item.status === 'suppressed')).toBe(true);
  });
  it('checks revocation again after the sending intent was claimed', async () => {
    const h = await harness(); h.decide.mockImplementation(async (_config, snapshot) => reply(snapshot));
    const update = h.repository.updateAction.bind(h.repository);
    vi.spyOn(h.repository, 'updateAction').mockImplementation(async (scope, id, patch) => {
      const result = await update(scope, id, patch); if (patch.status === 'sending') h.authorize.mockResolvedValue(false); return result;
    });
    await h.coordinator.handle(message(), config); await h.participation.flush(scope);
    expect(h.service.replyText).not.toHaveBeenCalled(); expect((await h.repository.listActions(scope))[0]!.status).toBe('suppressed');
  });
  it('rechecks context after waiting for the shared delivery guard', async () => {
    let entered!: () => void; const queued = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
    const h = await harness('selective', { withDelivery: async (_scope, _actionId, send) => { entered(); await waiting; return send(); } });
    h.decide.mockImplementation(async (_config, snapshot) => reply(snapshot));
    await h.coordinator.handle(message(), config); const flush = h.participation.flush(scope);
    await queued;
    await h.repository.updateSettings(scope, { expectedRevision: 1, notificationsPaused: true }, 'owner');
    release(); await flush;
    expect(h.service.replyText).not.toHaveBeenCalled();
    expect((await h.repository.listActions(scope))[0]!.status).toBe('suppressed');
  });
  it('a shared budget suppression before provider invocation is not an unknown network result', async () => {
    const h = await harness('selective', { withDelivery: async () => { throw new RuntimeError('COLLABORATION_DELIVERY_SUPPRESSED', 'Group notification budget exhausted', 409); } });
    h.decide.mockImplementation(async (_config, snapshot) => reply(snapshot));
    await h.coordinator.handle(message(), config); await h.participation.flush(scope);
    expect(h.service.replyText).not.toHaveBeenCalled();
    expect((await h.repository.listActions(scope))[0]!.status).toBe('suppressed');
  });

  it('an unknown delivery is never resent, including rewritten wording for identical evidence', async () => {
    const h = await harness(); h.decide.mockImplementation(async (_config, snapshot) => reply(snapshot));
    h.service.replyText.mockRejectedValueOnce(new Error('response lost'));
    await h.coordinator.handle(message(), config); await h.participation.flush(scope);
    expect((await h.repository.listActions(scope))[0]!.status).toBe('unknown');
    h.decide.mockImplementation(async (_config, snapshot) => ({ ...reply(snapshot), response: '换一种表达，材料已有进展' }));
    await h.coordinator.handle(message('om_2'), config); await h.participation.flush(scope);
    expect(h.service.replyText).toHaveBeenCalledOnce();
  });
  it('enforces a zero proactive budget while preserving decisions', async () => {
    const h = await harness(); h.decide.mockImplementation(async (_config, snapshot) => reply(snapshot));
    await h.repository.updateSettings(scope, { expectedRevision: 1, maxProactivePerHour: 0 }, 'owner');
    await h.coordinator.handle(message(), config); await h.participation.flush(scope);
    expect(h.service.replyText).not.toHaveBeenCalled(); expect((await h.repository.listDecisions(scope))[0]!.status).toBe('suppressed');
  });
  it('bot messages remain context and cannot create task authority or inferred changes', async () => {
    const h = await harness();
    await h.coordinator.handle(message('om_bot', '@_user_1 mark completed', { senderType: 'app', senderOpenId: 'ou_other_bot', mentions: [{ key: '@_user_1', name: 'Bot', openId: 'ou_bot' }] }), config);
    await h.participation.flush(scope);
    expect((await h.repository.listObservations(scope)).some(item => item.senderKind === 'bot')).toBe(true);
    expect(h.decide).not.toHaveBeenCalled(); expect(h.runtime.send).not.toHaveBeenCalled();
  });
  it('recognizes its own sender identity even when the event omits sender type', async () => {
    const h = await harness();
    await h.participation.handle(message('om_self', 'generated', { senderType: undefined, senderOpenId: 'ou_bot' }), config, { explicit: false, botOpenId: 'ou_bot' });
    await h.participation.flush(scope);
    expect((await h.repository.listObservations(scope)).find(item => item.messageId === 'om_self')!.senderKind).toBe('bot');
    await h.participation.recover(scope.appId); await h.participation.flush(scope);
    expect(h.decide).not.toHaveBeenCalled();
  });
  it('closes interrupted intents and marks sending as unknown without retry', async () => {
    const h = await harness();
    for (const status of ['intent', 'sending'] as const) {
      const action = await h.repository.beginAction({ id: status, scope, kind: 'participation.reply', requesterId: 'policy:group-participation', inputDigest: status, payload: {} });
      if (status === 'sending') await h.repository.updateAction(scope, status, { expectedRevision: action.action.revision, status });
    }
    await h.participation.recover(scope.appId); await h.participation.flush(scope);
    expect((await h.repository.getAction(scope, 'intent'))!.status).toBe('suppressed');
    expect((await h.repository.getAction(scope, 'sending'))!.status).toBe('unknown');
    expect(h.service.replyText).not.toHaveBeenCalled();
  });
  it.each([true, false])('proposed existing-step updates require the source human authorization (%s)', async allowed => {
    const h = await harness();
    await h.repository.createFollowup({ id: 'follow_1', scope, goal: '提交资料', status: 'open', progress: '', steps: [{ id: 'draft', label: '初稿', status: 'open' }, { id: 'review', label: '审核', status: 'open' }], sourceRefs: [], taskIds: [], externalRefs: [], fields: {}, createdBy: 'ou_a', updatedBy: 'ou_a', provenance: 'confirmed' });
    h.authorize.mockImplementation(async (_scope, actor, action) => action !== 'update' || allowed && actor === 'ou_a');
    h.decide.mockImplementation(async (_config, snapshot) => ({ ...silent(), updates: [{ followupId: 'follow_1', expectedRevision: 1, progress: '初稿已提交，仍待审核', steps: [{ id: 'draft', label: '初稿', status: 'done' }, { id: 'review', label: '审核', status: 'open' }], evidenceIds: [snapshot.observations.find(item => item.origin === 'live')!.id] }] }));
    await h.coordinator.handle(message(), config); await h.participation.flush(scope);
    const followup = (await h.repository.getFollowup(scope, 'follow_1'))!;
    expect(followup.status).toBe('open'); expect(followup.steps[0]!.status).toBe(allowed ? 'done' : 'open');
    if (allowed) { expect(followup.provenance).toBe('inferred'); expect(followup.sourceRefs).not.toEqual([]); expect(followup.updatedBy).toBe('ou_a'); }
    expect(h.service.replyText).not.toHaveBeenCalled();
  });
  it('restart recovery consumes only unprocessed live material and never historical messages', async () => {
    const h = await harness();
    await h.coordinator.handle(message(), config); h.participation.closeApp(scope.appId);
    const next = new LarkGroupParticipation(h.options);
    cleanups.push(async () => { next.closeApp(scope.appId); await next.flush(scope); });
    await next.recover(scope.appId); await next.flush(scope);
    expect(h.decide).toHaveBeenCalledOnce();
    await next.recover(scope.appId); await next.flush(scope); expect(h.decide).toHaveBeenCalledOnce();
  });
});

describe('context bootstrap', () => {
  it('paginates and resumes a bounded scan using stable time boundaries, recording gaps without tasks', async () => {
    const h = await harness();
    let clock = new Date('2026-09-18T10:00:00.000Z');
    h.service.listChatMessages.mockImplementation(async input => ({ items: [{ messageId: input.pageToken ? 'om_old2' : 'om_old1', chatId: scope.chatId, messageType: 'text', rawContent: '{"text":"history"}', createTime: '1789707600000', sender: { id: 'old_bot', type: 'app' }, mentions: [], deleted: false, updated: false }], hasMore: !input.pageToken, ...(input.pageToken ? {} : { pageToken: 'next_page' }) }));
    const bootstrap = new LarkContextBootstrap({ ...h.options, authorize: async () => true, maxPages: 1, now: () => clock, readGroupDescription: undefined });
    await bootstrap.ensure(scope); expect((await h.repository.getBootstrap(scope))!.status).toBe('partial');
    clock = new Date('2026-09-19T10:00:00.000Z'); await bootstrap.ensure(scope);
    expect((await h.repository.getBootstrap(scope))!.status).toBe('complete');
    expect(h.service.listChatMessages.mock.calls[0]![0].startTime).toBe(h.service.listChatMessages.mock.calls[1]![0].startTime);
    expect(h.service.listChatMessages.mock.calls[0]![0].endTime).toBe(h.service.listChatMessages.mock.calls[1]![0].endTime);
    expect((await h.repository.getBootstrap(scope))!.missing).toContain('group_description_unavailable');
    expect((await h.repository.listObservations(scope)).map(item => item.origin)).toEqual(['history', 'history']);
    expect(h.decide).not.toHaveBeenCalled(); expect(h.service.replyText).not.toHaveBeenCalled();
  });
  it('does not read any history before scope authorization', async () => {
    const h = await harness(); h.authorize.mockResolvedValue(false);
    await h.participation.bootstrap(scope); expect(h.service.listChatMessages).not.toHaveBeenCalled();
    await h.coordinator.handle(message(), config); expect(await h.repository.listObservations(scope)).toEqual([]);
  });
});


describe('participation shutdown and source completeness', () => {
  it('drains a history request and its checkpoint before close, then refuses entry without touching the closed database', async () => {
    const h = await harness('observe');
    let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: () => void; const network = new Promise<void>(resolve => { release = resolve; });
    h.service.listChatMessages.mockImplementation(async () => { enter(); await network; return { items: [], hasMore: true, pageToken: 'next' }; });
    const boot = h.participation.bootstrap(scope); await entered;
    let drained = false; const close = h.participation.close().then(() => { drained = true; });
    try { await Promise.resolve(); expect(drained).toBe(false); }
    finally { release(); await Promise.all([boot, close]); }
    expect(await h.repository.getBootstrap(scope)).toMatchObject({ status: 'partial', missing: expect.arrayContaining(['bootstrap_stopped']) });
    expect(h.service.listChatMessages).toHaveBeenCalledOnce();
    h.db.close();
    await h.participation.close();
    await h.participation.handle(message(), config, { explicit: false });
    await h.participation.recover(scope.appId); await h.participation.bootstrap(scope);
    expect(await h.participation.taskContext(scope)).toBe(''); expect(await h.participation.instructions(scope)).toBe('');
    expect(h.decide).not.toHaveBeenCalled(); expect(h.service.listChatMessages).toHaveBeenCalledOnce();
  });
  it('drains an active decision and suppresses its reply during shutdown', async () => {
    const h = await harness();
    let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: () => void; const model = new Promise<void>(resolve => { release = resolve; });
    h.decide.mockImplementation(async (_config, snapshot) => { enter(); await model; return reply(snapshot); });
    await h.coordinator.handle(message(), config); const flush = h.participation.flush(scope); await entered;
    let drained = false; const close = h.participation.close().then(() => { drained = true; });
    try { await Promise.resolve(); expect(drained).toBe(false); }
    finally { release(); await Promise.all([flush, close]); }
    expect(h.service.replyText).not.toHaveBeenCalled(); expect(h.runtime.send).not.toHaveBeenCalled();
    expect((await h.repository.listDecisions(scope))[0]!.status).toBe('suppressed');
  });
  it('preserves the receipt for a participation send already accepted by the provider', async () => {
    const h = await harness(); h.decide.mockImplementation(async (_config, snapshot) => reply(snapshot));
    let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: () => void; const network = new Promise<void>(resolve => { release = resolve; });
    h.service.replyText.mockImplementation(async () => { enter(); await network; return { messageId: 'accepted-receipt' }; });
    await h.coordinator.handle(message(), config); const flush = h.participation.flush(scope); await entered;
    let drained = false; const close = h.participation.close().then(() => { drained = true; });
    try { await Promise.resolve(); expect(drained).toBe(false); }
    finally { release(); await Promise.all([flush, close]); }
    expect((await h.repository.listActions(scope))[0]).toMatchObject({ status: 'succeeded', receipt: 'accepted-receipt' });
    expect((await h.repository.listDecisions(scope))[0]!.status).toBe('sent');
  });
  it('includes accepted handle work outside decision slots in the drain', async () => {
    const h = await harness();
    let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: () => void; const grant = new Promise<void>(resolve => { release = resolve; });
    h.authorize.mockImplementationOnce(async () => { enter(); await grant; return true; });
    const handle = h.participation.handle(message(), config, { explicit: false }); await entered;
    let drained = false; const close = h.participation.close().then(() => { drained = true; });
    try { await Promise.resolve(); expect(drained).toBe(false); }
    finally { release(); await Promise.all([handle, close]); }
    expect((await h.repository.listObservations(scope)).some(item => item.messageId === 'om_1')).toBe(true);
    expect(h.decide).not.toHaveBeenCalled(); expect(h.service.listChatMessages).not.toHaveBeenCalled();
  });
  it('marks the original 16000-character clipping boundary for live/history text, memory and description', async () => {
    const h = await harness('observe', { readMemory: async () => 'm'.repeat(16001), readGroupDescription: async () => 'd'.repeat(16001) });
    h.service.listChatMessages.mockResolvedValue({ items: [{ messageId: 'old_long', chatId: scope.chatId, messageType: 'text', rawContent: JSON.stringify({ text: 'h'.repeat(16001) }), createTime: '1789707600000', sender: { id: 'human', type: 'user' }, mentions: [], deleted: false, updated: false }], hasMore: false });
    await h.coordinator.handle(message('live_long', 'l'.repeat(16001)), config); await h.participation.flush(scope);
    const materials = await h.repository.listObservations(scope);
    for (const [source, eventId, marker] of [['lark.message', 'live_long', 'text_truncated'], ['lark.message', 'old_long', 'text_truncated'], ['lark.memory', scope.chatId, 'memory_truncated'], ['lark.description', scope.chatId, 'description_truncated']]) {
      const material = materials.find(item => item.source === source && item.eventId === eventId)!;
      expect(material.text).toHaveLength(16000); expect(material.missing).toContain(marker);
    }
    expect((await h.repository.getBootstrap(scope))!.missing).toEqual(expect.arrayContaining(['text_truncated', 'description_truncated']));
  });
});
