import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createCollaborationSchema } from '../../../../packages/storage/src/collaboration-migration.js';
import { createCollaborationRepository } from '../../../../packages/storage/src/collaboration.js';
import { RuntimeError, type CollaborationSnapshot, type CollaborationFollowup, type CollaborationTeamContext } from '@dutydeck/shared';
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
const reply = (snapshot: CollaborationSnapshot): ParticipationResult => ({ action: 'reply', reason: '补充来源明确的新进展', evidenceIds: [snapshot.observations.filter(item => item.origin === 'live').at(-1)!.id], updates: [] });
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const clean of cleanups.splice(0).reverse()) await clean(); });

async function harness(mode: 'off' | 'observe' | 'selective' = 'selective', extra: Pick<GroupParticipationOptions, 'withDelivery' | 'readMemory' | 'readGroupDescription' | 'readTeamContext' | 'authorizeTeamContext'> = {}) {
  const db = new Database(':memory:'); createCollaborationSchema(db);
  const repository = createCollaborationRepository(db);
  if (mode !== 'off') await repository.updateSettings(scope, { expectedRevision: 0, participation: mode }, 'owner');
  const service = { listChatMessages: vi.fn(async (_input: any) => ({ items: [] as any[], hasMore: false })), replyText: vi.fn(async () => ({ messageId: 'om_sent' })), sendText: vi.fn(async () => ({ messageId: 'om_sent' })),
    listOwnReactions: vi.fn(async () => [] as Array<{ messageId: string; reactionId: string; emojiType: string }>), addReaction: vi.fn(async () => ({ reactionId: 'reaction' })), deleteReaction: vi.fn(async () => {}), send: vi.fn(async () => ({ messageId: 'om_card' })), reply: vi.fn(async () => ({ messageId: 'om_card' })), update: vi.fn(async () => ({ messageId: 'om_card' })) };
  const decide = vi.fn(async (_config: StoredLarkConfig, _snapshot: CollaborationSnapshot) => silent());
  const respond = vi.fn(async (_config: StoredLarkConfig, _snapshot: CollaborationSnapshot, _decision: ParticipationResult, _triggerId: string) => '材料已有进展');
  const authorize = vi.fn(async (_scope: typeof scope, _actor: string | undefined, _action: string, _followup?: CollaborationFollowup) => true);
  const options = { repository, decider: { decide, respond }, authorize, readConfig: async () => config, serviceFor: () => service, readGroupDescription: async () => '测试群', listScopes: async () => [scope], debounceMs: 10000, ...extra };
  const participation = new LarkGroupParticipation(options);
  const session = { id: 's1', protocol: 'acp', state: 'idle', agentId: 'mock', cwd: '/tmp', permissionMode: 'ask', createdAt: '', updatedAt: '' };
  const runtime = { start: vi.fn(async () => session), getSession: vi.fn(async () => session), subscribe: vi.fn(() => vi.fn()), send: vi.fn(async () => {}), interrupt: vi.fn(async () => {}) };
  const coordinator = new LarkMessageCoordinator(runtime as any, service as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, Math.random, 'ou_bot', undefined, undefined, async () => 'group', undefined, undefined, { participation });
  cleanups.push(async () => { coordinator.stop(); await participation.close(); if (db.open) db.close(); });
  return { db, repository, service, decide, respond, authorize, participation, coordinator, runtime, options };
}

const teamContext = (): CollaborationTeamContext => {
  const source = { ...scope, chatId: 'oc_personal' };
  const at = '2026-09-21T10:00:00.000Z';
  return { query: '看看个人待办群', searchedAt: at, sources: [{ scope: source, name: '个人待办', status: 'complete', missing: [] }], observations: [
    { id: 'team_work', scope: source, sequence: 100000, source: 'lark.message', eventId: 'om_work', occurredAt: at, receivedAt: at, senderId: 'ou_a', senderKind: 'human', messageId: 'om_work', text: '推进容量扫描', refs: ['om_work'], origin: 'history', missing: [], revision: 1 }
  ] };
};

describe('team context in group participation', () => {
  it('rejects a reply justified only by team material before acknowledging or generating', async () => {
    const h = await harness('selective', { readTeamContext: async () => teamContext(), authorizeTeamContext: async () => true });
    h.decide.mockImplementation(async () => ({ action: 'reply', reason: '外群有相关资料', evidenceIds: ['team_work'], updates: [] }));
    await h.coordinator.handle(message('om_other', '大家觉得容量够吗？'), config);
    await h.participation.flush(scope);
    expect(h.respond).not.toHaveBeenCalled();
    expect(h.service.addReaction).not.toHaveBeenCalled();
    expect(h.service.replyText).not.toHaveBeenCalled();
    expect((await h.repository.listDecisions(scope))[0]).toMatchObject({ action: 'silent', status: 'failed', reason: expect.stringContaining('current human trigger') });
  });

  it('persists addressing evidence through recovery without turning a mention of others into an explicit request', async () => {
    const h = await harness();
    const event = message('om_other', '@_user_1 帮忙看看', { parentId: 'om_human', mentions: [{ key: '@_user_1', name: '小王', openId: 'ou_other' }] });
    await h.participation.handle(event, config, { explicit: false, botOpenId: 'ou_bot' });
    await h.participation.close();
    const recovered = new LarkGroupParticipation(h.options);
    cleanups.push(() => recovered.close());
    await recovered.recover(scope.appId); await recovered.flush(scope);
    expect(h.decide).toHaveBeenCalledOnce();
    const trigger = h.decide.mock.calls[0]![1].observations.find(item => item.messageId === event.messageId)!;
    expect(trigger.refs).toEqual(['om_other', 'om_human', 'dutydeck:self:ou_bot', 'dutydeck:parent:om_human', 'dutydeck:mention:other']);
    expect(trigger.refs).not.toContain('dutydeck:explicit');
    expect(h.service.addReaction).not.toHaveBeenCalled();
    expect(h.service.replyText).not.toHaveBeenCalled();
  });

  it('freezes cross-group evidence once for both phases and delivers only to the originating question', async () => {
    const read = vi.fn(async () => teamContext());
    const h = await harness('selective', { readTeamContext: read, authorizeTeamContext: async () => true });
    h.decide.mockImplementation(async (_config, snapshot) => ({ ...reply(snapshot), evidenceIds: [...reply(snapshot).evidenceIds, snapshot.teamContext!.observations[0]!.id] }));
    await h.coordinator.handle(message('om_question', '看看个人待办群'), config);
    await h.participation.flush(scope);
    expect(read).toHaveBeenCalledExactlyOnceWith(scope, '看看个人待办群');
    expect(h.respond.mock.calls[0]![1].teamContext).toEqual(h.decide.mock.calls[0]![1].teamContext);
    expect(h.service.replyText).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_question' }));
    const decision = (await h.repository.listDecisions(scope))[0]!;
    expect(decision).toMatchObject({ status: 'sent', evidenceIds: [h.decide.mock.calls[0]![1].observations.find(item => item.origin === 'live')!.id, 'team_work'] });
    expect(decision.inputSnapshot).toHaveProperty('teamContext.sources.0.name', '个人待办');
    expect((await h.repository.listObservations(scope)).some(item => item.id === 'team_work')).toBe(false);
  });

  it('rechecks source access during generation and clears OK without sending revoked material', async () => {
    let allowed = true;
    const h = await harness('selective', { readTeamContext: async () => teamContext(), authorizeTeamContext: async () => allowed });
    h.decide.mockImplementation(async (_config, snapshot) => reply(snapshot));
    let finish!: () => void;
    h.respond.mockImplementation(async () => { await new Promise<void>(resolve => { finish = resolve; }); return '个人待办：推进容量扫描'; });
    await h.coordinator.handle(message(), config);
    const flushing = h.participation.flush(scope);
    await vi.waitFor(() => expect(h.respond).toHaveBeenCalledOnce());
    allowed = false; finish(); await flushing;
    expect(h.service.replyText).not.toHaveBeenCalled();
    expect(h.service.deleteReaction).toHaveBeenCalledWith('om_1', 'reaction');
    expect((await h.repository.listDecisions(scope))[0]!.status).toBe('suppressed');
  });

  it('answers a new question even when its team evidence was used by a completed reply', async () => {
    const h = await harness('selective', { readTeamContext: async () => teamContext(), authorizeTeamContext: async () => true });
    h.decide.mockImplementation(async (_config, snapshot) => ({ action: 'reply', reason: '新的查询复用同一来源', evidenceIds: [snapshot.observations.filter(item => item.origin === 'live').at(-1)!.id, 'team_work'], updates: [] }));
    await h.coordinator.handle(message('om_first', '看看个人待办群'), config); await h.participation.flush(scope);
    await h.coordinator.handle(message('om_next', '这里面哪些和容量有关？'), config); await h.participation.flush(scope);
    expect(h.service.replyText.mock.calls).toEqual([
      [expect.objectContaining({ messageId: 'om_first' })], [expect.objectContaining({ messageId: 'om_next' })]
    ]);
  });

  it('records unavailable team retrieval without silently dropping the local request', async () => {
    const h = await harness('selective', { readTeamContext: async () => { throw new Error('temporarily unavailable'); } });
    h.decide.mockImplementation(async (_config, snapshot) => reply(snapshot));
    await h.coordinator.handle(message(), config); await h.participation.flush(scope);
    expect(h.decide.mock.calls[0]![1].bootstrap?.missing).toContain('team_context_unavailable');
    expect(h.service.replyText).toHaveBeenCalledOnce();
  });

  it('marks a stalled team read unavailable and releases the next task context read', async () => {
    let release!: () => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise<CollaborationTeamContext>(resolve => { release = () => resolve(teamContext()); }))
      .mockImplementation(async () => teamContext());
    const h = await harness('selective', { readTeamContext: read, authorizeTeamContext: async () => true });
    vi.useFakeTimers();
    const first = h.participation.taskContext(scope, '第一条查询');
    let settled = false;
    void first.then(() => { settled = true; });
    try {
      for (let i = 0; i < 100 && !read.mock.calls.length; i++) await vi.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10_001);
      expect(settled).toBe(true);
      expect(await first).toContain('team_context_unavailable');
      expect(await h.participation.taskContext(scope, '第二条查询')).toContain('team_work');
    } finally {
      release?.();
      vi.useRealTimers();
    }
  });

  it('drops team material when its authorization stalls', async () => {
    let release!: () => void;
    const authorizeTeamContext = vi.fn(() => new Promise<boolean>(resolve => { release = () => resolve(true); }));
    const h = await harness('selective', { readTeamContext: async () => teamContext(), authorizeTeamContext });
    vi.useFakeTimers();
    const pending = h.participation.taskContext(scope, '个人待办');
    try {
      for (let i = 0; i < 100 && !authorizeTeamContext.mock.calls.length; i++) await vi.advanceTimersByTimeAsync(1);
      expect(authorizeTeamContext).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10_001);
      const text = await pending;
      expect(text).not.toContain('team_work');
      expect(text).not.toContain('个人待办真实进展');
      expect(text).toContain('team_context_authorization_unavailable');
    } finally {
      release?.();
      vi.useRealTimers();
    }
  });

  it('finishes a stalled memory read without a late observation or shutdown wait', async () => {
    let release!: () => void;
    const readMemory = vi.fn(() => new Promise<string>(resolve => { release = () => resolve('迟到的私有记忆'); }));
    const h = await harness('selective', { readMemory });
    vi.useFakeTimers();
    const pending = h.participation.taskContext(scope, '查询');
    try {
      for (let i = 0; i < 100 && !readMemory.mock.calls.length; i++) await vi.advanceTimersByTimeAsync(1);
      expect(readMemory).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await pending).toContain('memory_unavailable');
      await h.participation.close();
      const before = await h.repository.listObservations(scope);
      release();
      await Promise.resolve();
      expect(await h.repository.listObservations(scope)).toEqual(before);
    } finally {
      release?.();
      vi.useRealTimers();
    }
  });

  it('fails closed and drains shutdown when initial context authorization stalls', async () => {
    const h = await harness('selective');
    let release!: () => void;
    h.authorize.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = () => resolve(true); }));
    vi.useFakeTimers();
    const pending = h.participation.taskContext(scope, '查询');
    try {
      await vi.advanceTimersByTimeAsync(10_001);
      await expect(pending).rejects.toThrow('群上下文授权超时');
      await h.participation.close();
    } finally {
      release?.();
      vi.useRealTimers();
    }
  });

  it('fails a stalled task context visibly before invoking the Agent and frees the next turn', async () => {
    const h = await harness('observe');
    let release!: () => void;
    vi.spyOn(h.participation, 'taskContext').mockImplementationOnce(() => new Promise<string>(resolve => { release = () => resolve(''); }));
    vi.useFakeTimers();
    const mention = { mentions: [{ key: '@_user_1', name: 'Bot', openId: 'ou_bot' }] };
    await h.coordinator.handle(message('om_stalled', '@_user_1 第一条', mention), config);
    try {
      for (let i = 0; i < 100 && !release; i++) await vi.advanceTimersByTimeAsync(1);
      expect(release).toBeTypeOf('function');
      await vi.advanceTimersByTimeAsync(15_001);
      expect(h.runtime.send).not.toHaveBeenCalled();
      expect(JSON.stringify(h.service.reply.mock.calls)).toContain('上下文读取超时或失败');
      expect(h.service.deleteReaction).toHaveBeenCalledWith('om_stalled', 'reaction');
      vi.useRealTimers();
      await h.coordinator.handle(message('om_next', '@_user_1 第二条', mention), config);
      await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    } finally {
      release?.();
      vi.useRealTimers();
    }
  });

  it('injects query-specific team context into the explicit Agent task', async () => {
    const read = vi.fn(async () => teamContext());
    const h = await harness('observe', { readTeamContext: read, authorizeTeamContext: async () => true });
    await h.coordinator.handle(message('om_explicit', '@_user_1 hello 个人待办', { mentions: [{ key: '@_user_1', name: 'Bot', openId: 'ou_bot' }] }), config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    expect(read).toHaveBeenCalledWith(scope, expect.stringContaining('个人待办'));
    expect(h.runtime.send.mock.calls[0]).toEqual(expect.arrayContaining([expect.stringContaining('推进容量扫描')]));
  });
});

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
    expect(h.respond).not.toHaveBeenCalled(); expect(h.service.addReaction).not.toHaveBeenCalled();
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
    const action = (await h.repository.listActions(scope)).find(item => item.kind === 'participation.reply')!;
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
      const result = await update(scope, id, patch); if (patch.status === 'sending' && id.startsWith('reply_')) h.authorize.mockResolvedValue(false); return result;
    });
    await h.coordinator.handle(message(), config); await h.participation.flush(scope);
    expect(h.service.replyText).not.toHaveBeenCalled(); expect((await h.repository.listActions(scope)).find(item => item.kind === 'participation.reply')!.status).toBe('suppressed');
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
    expect((await h.repository.listActions(scope)).find(item => item.kind === 'participation.reply')!.status).toBe('suppressed');
  });
  it('a shared budget suppression before provider invocation is not an unknown network result', async () => {
    const h = await harness('selective', { withDelivery: async () => { throw new RuntimeError('COLLABORATION_DELIVERY_SUPPRESSED', 'Group notification budget exhausted', 409); } });
    h.decide.mockImplementation(async (_config, snapshot) => reply(snapshot));
    await h.coordinator.handle(message(), config); await h.participation.flush(scope);
    expect(h.service.replyText).not.toHaveBeenCalled();
    expect((await h.repository.listActions(scope)).find(item => item.kind === 'participation.reply')!.status).toBe('suppressed');
  });

  it('an unknown delivery is never resent, including rewritten wording for identical evidence', async () => {
    const h = await harness(); h.decide.mockImplementation(async (_config, snapshot) => ({ ...reply(snapshot), evidenceIds: [...new Set([snapshot.observations.find(item => item.origin === 'live')!.id, ...reply(snapshot).evidenceIds])] }));
    h.service.replyText.mockRejectedValueOnce(new Error('response lost'));
    await h.coordinator.handle(message(), config); await h.participation.flush(scope);
    expect((await h.repository.listActions(scope)).find(item => item.kind === 'participation.reply')!.status).toBe('unknown');
    h.respond.mockResolvedValue('换一种表达，材料已有进展');
    await h.coordinator.handle(message('om_2'), config); await h.participation.flush(scope);
    expect(h.service.replyText).toHaveBeenCalledOnce();
  });
  it.each([false, true])('preserves legacy uncertain-send keys within their original thread (new thread: %s)', async newThread => {
    const h = await harness('selective', { readTeamContext: async () => teamContext(), authorizeTeamContext: async () => true });
    h.decide.mockImplementation(async (_config, snapshot) => ({ ...reply(snapshot), evidenceIds: [...reply(snapshot).evidenceIds, 'team_work'] }));
    h.service.replyText.mockRejectedValueOnce(new Error('response lost'));
    await h.coordinator.handle(message('om_1', '看看容量', { threadId: 'omt_original' }), config); await h.participation.flush(scope);
    const action = (await h.repository.listActions(scope)).find(item => item.kind === 'participation.reply')!;
    expect(action.status).toBe('unknown');
    const first = (await h.repository.listDecisions(scope))[0]!;
    const legacyKey = createHash('sha256').update(JSON.stringify([first.evidenceIds.slice().sort(), 'omt_original'])).digest('hex');
    h.db.prepare('UPDATE collaboration_actions SET payload_json = ? WHERE id = ?').run(JSON.stringify({ ...action.payload, notificationKey: legacyKey }), action.id);
    await h.coordinator.handle(message('om_2', '看看容量', { threadId: newThread ? 'omt_other' : 'omt_original' }), config); await h.participation.flush(scope);
    expect(h.service.replyText).toHaveBeenCalledTimes(newThread ? 2 : 1);
    expect(h.respond).toHaveBeenCalledTimes(newThread ? 2 : 1);
    expect((await h.repository.listDecisions(scope))[0]!.status).toBe(newThread ? 'sent' : 'suppressed');
  });
  it('enforces a zero proactive budget while preserving decisions', async () => {
    const h = await harness(); h.decide.mockImplementation(async (_config, snapshot) => reply(snapshot));
    await h.repository.updateSettings(scope, { expectedRevision: 1, maxProactivePerHour: 0 }, 'owner');
    await h.coordinator.handle(message(), config); await h.participation.flush(scope);
    expect(h.service.replyText).not.toHaveBeenCalled(); expect((await h.repository.listDecisions(scope))[0]!.status).toBe('suppressed');
    expect(h.respond).not.toHaveBeenCalled(); expect(h.service.addReaction).not.toHaveBeenCalled();
  });
  it('acknowledges only after deciding to reply, before generation, and clears the exact reaction after sending', async () => {
    const h = await harness(); h.decide.mockImplementation(async (_config, snapshot) => reply(snapshot));
    let release!: () => void; const model = new Promise<void>(resolve => { release = resolve; });
    h.respond.mockImplementation(async () => { await model; return '实际生成的回复'; });
    await h.coordinator.handle(message(), config); const flush = h.participation.flush(scope);
    try {
      await vi.waitFor(() => expect(h.respond).toHaveBeenCalledOnce());
      expect(h.service.addReaction).toHaveBeenCalledWith('om_1', 'OK');
      expect(h.service.replyText).not.toHaveBeenCalled(); expect(h.service.deleteReaction).not.toHaveBeenCalled();
      expect((await h.repository.listActions(scope)).find(item => item.kind === 'participation.ack')).toMatchObject({ status: 'sending', receipt: 'reaction', payload: { messageId: 'om_1' } });
    } finally { release(); await flush; }
    expect(h.service.replyText).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_1', text: '实际生成的回复' }));
    expect(h.service.deleteReaction).toHaveBeenCalledWith('om_1', 'reaction');
    expect(h.service.deleteReaction.mock.invocationCallOrder[0]).toBeGreaterThan(h.service.replyText.mock.invocationCallOrder[0]!);
    expect((await h.repository.listDecisions(scope))[0]).toMatchObject({ status: 'sent', response: '实际生成的回复' });
  });
  it.each([false, true])('keeps the first question after bootstrapping over 30 older messages (update: %s)', async update => {
    const h = await harness();
    if (update) await h.repository.createFollowup({ id: 'follow_first', scope, goal: '整理进展', status: 'open', progress: '', steps: [], sourceRefs: [], taskIds: [], externalRefs: [], fields: {}, createdBy: 'ou_a', updatedBy: 'ou_a', provenance: 'confirmed' });
    h.service.listChatMessages.mockResolvedValue({ items: Array.from({ length: 50 }, (_, index) => ({
      messageId: `om_history_${index}`, chatId: scope.chatId, messageType: 'text', rawContent: JSON.stringify({ text: `历史材料 ${index}` }),
      createTime: '1789700000000', sender: { id: 'ou_a', type: 'user' }, mentions: [], deleted: false, updated: false
    })), hasMore: false });
    h.decide.mockImplementation(async (_config, snapshot) => {
      const result = reply(snapshot);
      return { ...result, updates: update ? [{ followupId: 'follow_first', expectedRevision: 1, progress: '已提出整理请求', evidenceIds: result.evidenceIds }] : [] };
    });
    await h.coordinator.handle(message('om_first_question', '请总结本群的进展'), config);
    await h.participation.flush(scope);
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.decide.mock.calls[0]![1].observations).toEqual(expect.arrayContaining([expect.objectContaining({ messageId: 'om_first_question', origin: 'live' })]));
    expect(h.respond.mock.calls[0]![1].observations).toEqual(expect.arrayContaining([expect.objectContaining({ messageId: 'om_first_question', origin: 'live' })]));
    expect(h.service.replyText).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_first_question' }));
    expect(h.service.deleteReaction).toHaveBeenCalledWith('om_first_question', 'reaction');
  });
  it('does not discard an acknowledged reply when another question arrives in the same group', async () => {
    const h = await harness();
    h.decide.mockImplementation(async (_config, snapshot) => ({ ...reply(snapshot), evidenceIds: [snapshot.observations.filter(item => item.origin === 'live').at(-1)!.id] }));
    let release!: () => void; const model = new Promise<void>(resolve => { release = resolve; });
    h.respond.mockImplementationOnce(async () => { await model; return '第一个问题的回答'; }).mockResolvedValue('第二个问题的回答');
    await h.coordinator.handle(message('om_first', '第一个问题'), config); const flush = h.participation.flush(scope);
    try {
      await vi.waitFor(() => expect(h.respond).toHaveBeenCalledOnce());
      await h.coordinator.handle(message('om_second', '第二个问题'), config);
    } finally { release(); await flush; }
    expect(h.service.replyText.mock.calls).toEqual([
      [expect.objectContaining({ messageId: 'om_first', text: '第一个问题的回答' })],
      [expect.objectContaining({ messageId: 'om_second', text: '第二个问题的回答' })]
    ]);
    expect(h.service.deleteReaction).toHaveBeenCalledTimes(2);
  });
  it.each(['pause', 'revoke', 'stop'])('clears an accepted reaction and suppresses the answer when %s occurs during generation', async kind => {
    const h = await harness(); h.decide.mockImplementation(async (_config, snapshot) => reply(snapshot));
    let release!: () => void; const model = new Promise<void>(resolve => { release = resolve; });
    h.respond.mockImplementation(async () => { await model; return '回答'; });
    await h.coordinator.handle(message(), config); const flush = h.participation.flush(scope);
    try {
      await vi.waitFor(() => expect(h.respond).toHaveBeenCalledOnce());
      if (kind === 'pause') await h.repository.updateSettings(scope, { expectedRevision: 1, notificationsPaused: true }, 'owner');
      if (kind === 'revoke') h.authorize.mockResolvedValue(false);
      if (kind === 'stop') h.participation.closeApp(scope.appId);
    } finally { release(); await flush; }
    expect(h.service.replyText).not.toHaveBeenCalled();
    expect(h.service.deleteReaction).toHaveBeenCalledWith('om_1', 'reaction');
    expect((await h.repository.listDecisions(scope))[0]!.status).toBe('suppressed');
  });
  it('reports generation failure once and clears OK without leaking the internal error', async () => {
    const h = await harness(); h.decide.mockImplementation(async (_config, snapshot) => reply(snapshot));
    h.respond.mockRejectedValue(new Error('provider secret detail'));
    await h.coordinator.handle(message(), config); await h.participation.flush(scope);
    expect(h.service.replyText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ messageId: 'om_1', text: '这次回复生成失败，请稍后重试。' }));
    expect(h.service.deleteReaction).toHaveBeenCalledWith('om_1', 'reaction');
    expect((await h.repository.listDecisions(scope))[0]!.status).toBe('failed');
  });
  it('still answers when adding OK fails', async () => {
    const h = await harness(); h.decide.mockImplementation(async (_config, snapshot) => reply(snapshot));
    h.service.addReaction.mockRejectedValue(new Error('reaction API unavailable'));
    await h.coordinator.handle(message(), config); await h.participation.flush(scope);
    expect(h.service.replyText).toHaveBeenCalledOnce(); expect(h.service.deleteReaction).not.toHaveBeenCalled();
    expect((await h.repository.listDecisions(scope))[0]!.status).toBe('sent');
  });
  it('recovers failed reaction cleanup without replaying generation or sending', async () => {
    const h = await harness(); h.decide.mockImplementation(async (_config, snapshot) => reply(snapshot));
    h.service.deleteReaction.mockRejectedValueOnce(new Error('temporary failure'));
    h.service.listOwnReactions.mockResolvedValue([{ messageId: 'om_1', reactionId: 'reaction', emojiType: 'OK' }]);
    await h.coordinator.handle(message(), config); await h.participation.flush(scope);
    expect((await h.repository.listActions(scope)).find(item => item.kind === 'participation.ack')).toMatchObject({ status: 'sending', receipt: 'reaction' });
    await h.participation.recover(scope.appId); await h.participation.flush(scope);
    expect(h.service.deleteReaction).toHaveBeenCalledTimes(2);
    expect((await h.repository.listActions(scope)).find(item => item.kind === 'participation.ack')).toMatchObject({ status: 'succeeded' });
    expect(h.respond).toHaveBeenCalledOnce(); expect(h.service.replyText).toHaveBeenCalledOnce();
  });
  it.each(['sending', 'unknown'] as const)('reconciles an OK whose add receipt was lost (%s)', async status => {
    const h = await harness();
    const begun = await h.repository.beginAction({ id: 'ack_lost', scope, kind: 'participation.ack', requesterId: 'policy:group-participation', inputDigest: 'lost', payload: { messageId: 'om_1' } });
    const sending = await h.repository.updateAction(scope, begun.action.id, { expectedRevision: 1, status: 'sending' });
    if (status === 'unknown') await h.repository.updateAction(scope, begun.action.id, { expectedRevision: sending.revision, status });
    h.service.listOwnReactions.mockResolvedValue([{ messageId: 'om_1', reactionId: 'own_lost', emojiType: 'OK' }]);
    await h.participation.recover(scope.appId);
    expect(h.service.listOwnReactions).toHaveBeenCalledWith('om_1', 'OK');
    expect(h.service.deleteReaction).toHaveBeenCalledExactlyOnceWith('om_1', 'own_lost');
    expect((await h.repository.getAction(scope, 'ack_lost'))!.status).toBe('succeeded');
    expect(h.respond).not.toHaveBeenCalled(); expect(h.service.replyText).not.toHaveBeenCalled();
  });
  it('finds pending cleanup older than the global action window', async () => {
    const h = await harness();
    await h.repository.beginAction({ id: 'ack_old', scope, kind: 'participation.ack', requesterId: 'policy:group-participation', inputDigest: 'old', payload: { messageId: 'om_1' } });
    await h.repository.updateAction(scope, 'ack_old', { expectedRevision: 1, status: 'sending', receipt: 'own_old' });
    for (let i = 0; i < 501; i++) {
      await h.repository.beginAction({ id: `unrelated_${i}`, scope: { appId: 'another_app', chatId: 'other_chat' }, kind: 'unrelated', requesterId: 'owner', inputDigest: String(i), payload: {} });
    }
    await h.participation.recover(scope.appId);
    expect(h.service.deleteReaction).toHaveBeenCalledExactlyOnceWith('om_1', 'own_old');
    expect((await h.repository.getAction(scope, 'ack_old'))!.status).toBe('succeeded');
  });
  it('does not recover a new live reply that starts while old reaction cleanup is waiting', async () => {
    const h = await harness(); h.decide.mockImplementation(async (_config, snapshot) => reply(snapshot));
    await h.repository.beginAction({ id: 'ack_old', scope, kind: 'participation.ack', requesterId: 'policy:group-participation', inputDigest: 'old', payload: { messageId: 'om_old' } });
    await h.repository.updateAction(scope, 'ack_old', { expectedRevision: 1, status: 'sending', receipt: 'old_reaction' });
    let releaseCleanup!: () => void; const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
    let releaseModel!: () => void; const model = new Promise<void>(resolve => { releaseModel = resolve; });
    h.service.deleteReaction.mockImplementationOnce(async () => { await cleanup; });
    h.respond.mockImplementationOnce(async () => { await model; return '新请求的回答'; });
    const recovery = h.participation.recover(scope.appId);
    let flush: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(h.service.deleteReaction).toHaveBeenCalledWith('om_old', 'old_reaction'));
      await h.coordinator.handle(message('om_new'), config); flush = h.participation.flush(scope);
      await vi.waitFor(() => expect(h.respond).toHaveBeenCalledOnce());
      releaseCleanup(); await recovery;
      expect((await h.repository.listActions(scope)).find(item => item.kind === 'participation.reply')).toMatchObject({ status: 'intent' });
    } finally { releaseCleanup(); releaseModel(); await Promise.all([recovery, flush]); }
    expect(h.service.replyText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ messageId: 'om_new', text: '新请求的回答' }));
    expect((await h.repository.listDecisions(scope))[0]!.status).toBe('sent');
  });
  it('finishes cleanup when a previous delete succeeded but its acknowledgement was lost', async () => {
    const h = await harness(); h.decide.mockImplementation(async (_config, snapshot) => reply(snapshot));
    h.service.deleteReaction.mockRejectedValueOnce(new Error('reaction already absent'));
    h.service.listOwnReactions.mockResolvedValue([]);
    await h.coordinator.handle(message(), config); await h.participation.flush(scope);
    expect((await h.repository.listActions(scope)).find(item => item.kind === 'participation.ack')).toMatchObject({ status: 'succeeded' });
    expect(h.service.replyText).toHaveBeenCalledOnce();
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
    h.decide.mockImplementation(async (_config, snapshot) => ({ ...silent(), updates: [{ followupId: 'follow_1', expectedRevision: 1, progress: '初稿已提交，仍待审核', steps: [{ id: 'draft', label: '初稿', status: 'done' }, { id: 'review', label: '审核', status: 'open' }], evidenceIds: [snapshot.observations.filter(item => item.origin === 'live').at(-1)!.id] }] }));
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
    expect((await h.repository.listActions(scope)).find(item => item.kind === 'participation.reply')).toMatchObject({ status: 'succeeded', receipt: 'accepted-receipt' });
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
