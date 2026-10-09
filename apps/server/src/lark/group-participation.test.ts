import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createCollaborationSchema } from '../../../../packages/storage/src/collaboration-migration.js';
import { createCollaborationRepository } from '../../../../packages/storage/src/collaboration.js';
import { allowEagerParticipation } from '../../../../packages/storage/src/migrations.js';
import { deciderMetaOf, RuntimeError, type CollaborationSnapshot, type CollaborationFollowup, type CollaborationTeamContext, type ObserveCollaborationInput } from '@dutydeck/shared';
import { LarkGroupParticipation, type GroupParticipationOptions } from './group-participation.js';
import { TASK_CONTEXT_BOT_TEXT_LIMIT, TASK_CONTEXT_BUDGET, TASK_CONTEXT_FULL_REFRESH_MS, TASK_CONTEXT_HUMAN_TEXT_LIMIT, TASK_CONTEXT_WINDOW } from './group-task-context.js';
import { LarkMessageCoordinator } from './coordinator.js';
import type { LarkMessageEvent } from './listener.js';
import type { StoredLarkConfig } from './config.js';
import type { ParticipationResult } from './readonly-decider.js';
import { LarkContextBootstrap } from './context-bootstrap.js';
import { responderClaimText, responderReleaseText } from './group-duty.js';
import { buildLarkCard } from './service.js';

const scope = { appId: 'cli_test', chatId: 'oc_test' };
const config: StoredLarkConfig = { appId: scope.appId, appSecret: 'test', listening: true, defaultAgentId: 'mock', workspace: '/tmp', fullTrustConfirmed: true,
  permissionMode: 'ask', preInjectPrompt: '', memoryEnabled: true, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1000, hideTraceOnComplete: false,
  allowedUsers: [], allowedEmails: [], highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'danger', riskControlMode: 'off' };
const message = (id = 'om_1', text = '资料已提交', patch: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({ messageId: id, chatId: scope.chatId, chatType: 'group', messageType: 'text', content: JSON.stringify({ text }), createTime: '1789707600000', senderOpenId: 'ou_a', senderType: 'user', mentions: [], ...patch });
const silent = (): ParticipationResult => ({ action: 'silent', reason: '没有新增信息', evidenceIds: [], updates: [] });
const reply = (snapshot: CollaborationSnapshot): ParticipationResult => ({ action: 'reply', reason: '补充来源明确的新进展', evidenceIds: [snapshot.observations.filter(item => item.origin === 'live').at(-1)!.id], updates: [] });
const act = (snapshot: CollaborationSnapshot, evidence = true): ParticipationResult => ({ action: 'act', reason: '点名请机器人读取文档', evidenceIds: evidence ? [snapshot.observations.filter(item => item.origin === 'live').at(-1)!.id] : [], updates: [] });
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const clean of cleanups.splice(0).reverse()) await clean(); });

async function harness(mode: 'off' | 'observe' | 'selective' | 'eager' = 'selective', extra: Partial<Pick<GroupParticipationOptions, 'withDelivery' | 'readMemory' | 'readGroupDescription' | 'readTeamContext' | 'authorizeTeamContext' | 'now' | 'usageRefusal' | 'canOperate' | 'applyLevel' | 'readParticipationUsage'>> = {}) {
  const db = new Database(':memory:'); createCollaborationSchema(db); allowEagerParticipation(db);
  const repository = createCollaborationRepository(db);
  if (mode !== 'off') await repository.updateSettings(scope, { expectedRevision: 0, participation: mode }, 'owner');
  const service = { listChatMessages: vi.fn(async (_input: any) => ({ items: [] as any[], hasMore: false })), replyText: vi.fn(async () => ({ messageId: 'om_sent' })), sendText: vi.fn(async () => ({ messageId: 'om_sent' })),
    listOwnReactions: vi.fn(async () => [] as Array<{ messageId: string; reactionId: string; emojiType: string }>), addReaction: vi.fn(async () => ({ reactionId: 'reaction' })), deleteReaction: vi.fn(async () => {}), send: vi.fn(async () => ({ messageId: 'om_card' })), reply: vi.fn(async () => ({ messageId: 'om_card' })), update: vi.fn(async () => ({ messageId: 'om_card' })) };
  const decide = vi.fn(async (_config: StoredLarkConfig, _snapshot: CollaborationSnapshot, _triggerId?: string, _facts?: Record<string, unknown>) => silent());
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
    expect((await h.repository.listDecisions(scope))[0]).toMatchObject({ action: 'silent', status: 'failed', reason: expect.stringContaining('outside its snapshot') });
  });

  it('persists addressing evidence through recovery without turning a mention of others into an explicit request', async () => {
    const h = await harness();
    const event = message('om_other', '@_user_1 帮忙看看', { parentId: 'om_human', mentions: [{ key: '@_user_1', name: '小王', openId: 'ou_other' }] });
    await h.participation.handle(event, config, { explicit: false, botOpenId: 'ou_bot' });
    await h.participation.close();
    const recovered = new LarkGroupParticipation(h.options);
    cleanups.push(() => recovered.close());
    await recovered.recover(scope.appId); await recovered.flush(scope);
    // 恢复后同样只凭持久化的 refs 判定：@ 了别人由规则层直接判为不接，不调模型。
    expect(h.decide).not.toHaveBeenCalled();
    const decision = (await h.repository.listDecisions(scope))[0]!;
    expect(decision).toMatchObject({ action: 'silent', inputSnapshot: { decider: { kind: 'rule', rule: 'mentions_other' } } });
    const trigger = (decision.inputSnapshot as unknown as CollaborationSnapshot).observations.find(item => item.messageId === event.messageId)!;
    expect(trigger.refs).toEqual(['om_other', 'om_human', 'dutydeck:self:ou_bot', 'dutydeck:parent:om_human', 'dutydeck:mention:other']);
    expect(trigger.refs).not.toContain('dutydeck:explicit');
    expect(h.service.addReaction).not.toHaveBeenCalled();
    expect(h.service.replyText).not.toHaveBeenCalled();
  });

  it('requests and freezes cross-group evidence after the local decision and delivers only to the originating question', async () => {
    const read = vi.fn(async () => teamContext());
    const h = await harness('selective', { readTeamContext: read, authorizeTeamContext: async () => true });
    h.decide.mockImplementation(async (_config, snapshot) => ({ ...reply(snapshot), teamQuery: '看看个人待办群' }));
    await h.coordinator.handle(message('om_question', '看看个人待办群'), config);
    await h.participation.flush(scope);
    expect(read).toHaveBeenCalledExactlyOnceWith(scope, '看看个人待办群');
    expect(h.decide.mock.calls[0]![1].teamContext).toBeUndefined();
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.respond.mock.calls[0]![1].teamContext).toEqual(teamContext());
    expect(h.service.replyText).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_question' }));
    const decision = (await h.repository.listDecisions(scope))[0]!;
    expect(decision).toMatchObject({ status: 'sent', evidenceIds: [h.decide.mock.calls[0]![1].observations.find(item => item.origin === 'live')!.id, 'team_work'] });
    expect(decision.inputSnapshot).toHaveProperty('teamContext.sources.0.name', '个人待办');
    expect((await h.repository.listObservations(scope)).some(item => item.id === 'team_work')).toBe(false);
  });

  it('rechecks source access during generation and clears OK without sending revoked material', async () => {
    let allowed = true;
    const h = await harness('selective', { readTeamContext: async () => teamContext(), authorizeTeamContext: async () => allowed });
    h.decide.mockImplementation(async (_config, snapshot) => ({ ...reply(snapshot), teamQuery: '看看个人待办群' }));
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
    h.decide.mockImplementation(async (_config, snapshot) => ({ action: 'reply', reason: '新的查询复用同一来源', evidenceIds: [snapshot.observations.filter(item => item.origin === 'live').at(-1)!.id], updates: [], teamQuery: '看看个人待办群' }));
    await h.coordinator.handle(message('om_first', '看看个人待办群'), config); await h.participation.flush(scope);
    await h.coordinator.handle(message('om_next', '这里面哪些和容量有关？'), config); await h.participation.flush(scope);
    expect(h.service.replyText.mock.calls).toEqual([
      [expect.objectContaining({ messageId: 'om_first' })], [expect.objectContaining({ messageId: 'om_next' })]
    ]);
  });

  it('records unavailable team retrieval without silently dropping the local request', async () => {
    const h = await harness('selective', { readTeamContext: async () => { throw new Error('temporarily unavailable'); } });
    h.decide.mockImplementation(async (_config, snapshot) => ({ ...reply(snapshot), teamQuery: '看看个人待办群' }));
    await h.coordinator.handle(message(), config); await h.participation.flush(scope);
    expect(h.respond.mock.calls[0]![1].bootstrap?.missing).toContain('team_context_unavailable');
    expect(h.service.replyText).toHaveBeenCalledOnce();
  });

  it('marks a stalled team read unavailable for the decider and releases the next decision', async () => {
    let release!: () => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise<CollaborationTeamContext>(resolve => { release = () => resolve(teamContext()); }))
      .mockImplementation(async () => teamContext());
    const h = await harness('selective', { readTeamContext: read, authorizeTeamContext: async () => true });
    h.decide.mockImplementation(async (_config, snapshot) => ({ ...reply(snapshot), teamQuery: '个人待办' }));
    await h.coordinator.handle(message('om_first', '第一条查询'), config);
    vi.useFakeTimers();
    const first = h.participation.flush(scope);
    try {
      for (let i = 0; i < 100 && !read.mock.calls.length; i++) await vi.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10_001);
      await first;
      expect(h.respond.mock.calls[0]![1].bootstrap?.missing).toContain('team_context_unavailable');
      vi.useRealTimers();
      await h.coordinator.handle(message('om_second', '第二条查询'), config);
      await h.participation.flush(scope);
      expect(h.respond.mock.calls[1]![1].teamContext?.observations.map(item => item.id)).toEqual(['team_work']);
    } finally {
      release?.();
      vi.useRealTimers();
    }
  });

  it('drops a decision whose team material authorization stalls', async () => {
    let release!: () => void;
    const authorizeTeamContext = vi.fn(() => new Promise<boolean>(resolve => { release = () => resolve(true); }));
    const h = await harness('selective', { readTeamContext: async () => teamContext(), authorizeTeamContext });
    h.decide.mockImplementation(async (_config, snapshot) => ({ ...reply(snapshot), teamQuery: '个人待办' }));
    await h.coordinator.handle(message('om_1', '个人待办'), config);
    vi.useFakeTimers();
    const pending = h.participation.flush(scope);
    try {
      for (let i = 0; i < 100 && !authorizeTeamContext.mock.calls.length; i++) await vi.advanceTimersByTimeAsync(1);
      expect(authorizeTeamContext).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10_001);
      await pending;
      expect(h.decide).toHaveBeenCalledOnce();
      expect(h.respond).not.toHaveBeenCalled();
      expect(h.service.replyText).not.toHaveBeenCalled();
    } finally {
      release?.();
      vi.useRealTimers();
    }
  });

  it('finishes a stalled memory read without a late observation or shutdown wait', async () => {
    let release!: () => void;
    const readMemory = vi.fn(() => new Promise<string>(resolve => { release = () => resolve('迟到的私有记忆'); }));
    const h = await harness('selective', { readMemory });
    await h.coordinator.handle(message(), config);
    vi.useFakeTimers();
    const pending = h.participation.flush(scope);
    try {
      for (let i = 0; i < 100 && !readMemory.mock.calls.length; i++) await vi.advanceTimersByTimeAsync(1);
      expect(readMemory).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10_001);
      await pending;
      expect(h.decide.mock.calls[0]![1].observations.find(item => item.source === 'lark.memory')?.missing).toContain('memory_unavailable');
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
    const pending = h.participation.taskContext(scope);
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
    vi.spyOn(h.participation, 'taskContext').mockImplementationOnce(() => new Promise<undefined>(resolve => { release = () => resolve(undefined); }));
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

  it('keeps cross-group material and group memory out of the explicit Agent task', async () => {
    const read = vi.fn(async () => teamContext());
    const authorizeTeamContext = vi.fn(async () => true);
    const readMemory = vi.fn(async () => '群记忆正文');
    const h = await harness('observe', { readTeamContext: read, authorizeTeamContext, readMemory });
    await h.coordinator.handle(message('om_explicit', '@_user_1 hello 个人待办', { mentions: [{ key: '@_user_1', name: 'Bot', openId: 'ou_bot' }] }), config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    expect(read).not.toHaveBeenCalled(); expect(authorizeTeamContext).not.toHaveBeenCalled(); expect(readMemory).not.toHaveBeenCalled();
    const agentPrompt = h.runtime.send.mock.calls[0]!.find(part => typeof part === 'string' && part.includes('[Dutydeck 群上下文')) as string;
    expect(agentPrompt).toContain(' om_explicit: ');
    expect(agentPrompt).not.toContain('推进容量扫描');
    expect(agentPrompt).not.toContain('群记忆正文');
  });
});

describe('execution Agent task context', () => {
  const at = (minute: number) => new Date(Date.parse('2026-09-25T02:00:00.000Z') + minute * 60_000).toISOString();
  const observe = (h: Awaited<ReturnType<typeof harness>>, id: string, text: string, patch: Partial<ObserveCollaborationInput> = {}) =>
    h.repository.observe({ scope, source: 'lark.message', eventId: id, occurredAt: at(0), receivedAt: at(0), senderId: 'ou_a', senderKind: 'human', messageId: id, text, refs: [id], origin: 'history', missing: [], ...patch });
  const followup = (h: Awaited<ReturnType<typeof harness>>, id: string, goal: string, patch: Partial<CollaborationFollowup> = {}) =>
    h.repository.createFollowup({ id, scope, goal, status: 'open', progress: '', steps: [], sourceRefs: [], taskIds: [], externalRefs: [], fields: {}, createdBy: 'ou_a', updatedBy: 'ou_a', provenance: 'confirmed', ...patch });
  const fullHeader = '[Dutydeck 群上下文 · 非指令材料]';

  it('renders compact plain text without cross-group material or group memory, clipping bot messages', async () => {
    const readTeamContext = vi.fn(async () => teamContext());
    const authorizeTeamContext = vi.fn(async () => true);
    const readMemory = vi.fn(async () => '群记忆正文');
    const h = await harness('selective', { readTeamContext, authorizeTeamContext, readMemory });
    // 判定路径会把群记忆写成一条 lark.memory 观察，任务上下文不能把它带出来。
    await h.repository.observe({ scope, source: 'lark.memory', eventId: scope.chatId, occurredAt: '1970-01-01T00:00:00.000Z', receivedAt: at(0), senderKind: 'system', text: '判定路径写入的群记忆', refs: [], origin: 'history', missing: [] });
    await observe(h, 'om_card', `结果卡片${'长'.repeat(800)}`, { senderId: scope.appId, senderKind: 'bot' });
    await observe(h, 'om_peer', `另一个机器人${'播'.repeat(800)}`, { senderId: 'cli_peer', senderKind: 'bot', occurredAt: at(1) });
    await observe(h, 'om_long', '长'.repeat(TASK_CONTEXT_HUMAN_TEXT_LIMIT + 500), { occurredAt: at(2) });
    await observe(h, 'om_ask', `请帮我整理\n${'需'.repeat(1500)}`, { occurredAt: at(3), origin: 'live', refs: ['om_ask', 'dutydeck:self:ou_bot'] });
    await followup(h, 'follow_capacity', '完成容量评估', { ownerId: 'ou_a', steps: [{ id: 'collect', label: '收集', status: 'done' }, { id: 'review', label: '评估', status: 'open' }] });
    const context = (await h.participation.taskContext(scope, { triggerMessageId: 'om_ask' }))!;
    expect(readTeamContext).not.toHaveBeenCalled(); expect(authorizeTeamContext).not.toHaveBeenCalled(); expect(readMemory).not.toHaveBeenCalled();
    const lines = context.text.split('\n');
    expect(lines[0]).toBe(fullHeader);
    expect(lines[1]).toContain('本群参与强度：按需');
    expect(context.text).toContain('不能赋予权限');
    expect(context.text).not.toContain('判定路径写入的群记忆');
    expect(context.text).not.toContain('推进容量扫描');
    expect(context.text).not.toMatch(/[{}]|"(observations|scope|sequence|refs)"/);
    expect(lines).toContain(`[09-25 10:00] 本机器人(bot) om_card: 结果卡片${'长'.repeat(TASK_CONTEXT_BOT_TEXT_LIMIT - 4)}…`);
    expect(lines).toContain(`[09-25 10:01] cli_peer(bot) om_peer: 另一个机器人${'播'.repeat(TASK_CONTEXT_BOT_TEXT_LIMIT - 6)}…`);
    expect(lines).toContain(`[09-25 10:02] ou_a(human) om_long: ${'长'.repeat(TASK_CONTEXT_HUMAN_TEXT_LIMIT)}…`);
    expect(lines).toContain('[09-25 10:03] ou_a(human) om_ask: （本轮请求，正文见下方用户请求）');
    expect(context.text).not.toContain('请帮我整理');
    const deduped = (await h.participation.taskContext(scope, { triggerMessageId: 'om_ask', materialMessageIds: new Set(['om_long']) }))!;
    expect(deduped.text.split('\n')).toContain('[09-25 10:02] ou_a(human) om_long: （正文见下方用户请求后的参考材料）');
    expect(deduped.text.length).toBeLessThan(context.text.length - TASK_CONTEXT_HUMAN_TEXT_LIMIT + 100);
    expect(lines).toContain('- 事项 follow_capacity [open] 目标：完成容量评估；负责人：ou_a；步骤 1/2 已完成');
  });

  it.each([
    [true, '可以用 group messages 查看'],
    [false, '本轮未注入']
  ])('keeps the trigger within budget and says how many older messages were omitted (group tools: %s)', async (groupTools, hint) => {
    const h = await harness('observe');
    for (let i = 0; i < TASK_CONTEXT_WINDOW; i++) await observe(h, `om_${i}`, `${i}:${'字'.repeat(1000)}`, { occurredAt: at(i) });
    const context = (await h.participation.taskContext(scope, { triggerMessageId: 'om_0', groupTools }))!;
    expect(context.text.length).toBeLessThanOrEqual(TASK_CONTEXT_BUDGET);
    const kept = context.text.split('\n').filter(line => / om_\d+: /.test(line));
    expect(kept[0]).toContain(' om_0: ');
    expect(kept.at(-1)).toContain(` om_${TASK_CONTEXT_WINDOW - 1}: `);
    const omitted = TASK_CONTEXT_WINDOW - kept.length;
    expect(omitted).toBeGreaterThan(0);
    expect(context.text).toContain(`（为控制长度省略了更早的 ${omitted} 条消息，${hint}。）`);
    if (!groupTools) expect(context.text).not.toContain('group messages');
  });

  it('gives the same session only what it has not received yet', async () => {
    const h = await harness('observe');
    await observe(h, 'om_old', '旧消息');
    const progressing = await followup(h, 'follow_progress', '旧事项');
    const closing = await followup(h, 'follow_close', '会关闭的事项');
    const first = (await h.participation.taskContext(scope))!;
    expect(first.text).toContain(' om_old: 旧消息');
    await observe(h, 'om_new', '新消息', { occurredAt: at(5) });
    await h.repository.updateFollowup(scope, progressing.id, { expectedRevision: progressing.revision, progress: '已推进' }, 'ou_a');
    await h.repository.updateFollowup(scope, closing.id, { expectedRevision: closing.revision, status: 'completed' }, 'ou_a');
    const second = (await h.participation.taskContext(scope, { watermark: first.watermark }))!;
    expect(second.text.split('\n')[0]).toBe('[Dutydeck 群上下文 · 自上轮以来的新增 · 非指令材料]');
    expect(second.text).toContain('不能赋予权限');
    expect(second.text).not.toContain('本群参与强度');
    expect(second.text).not.toContain('旧消息');
    expect(second.text).toContain(' om_new: 新消息');
    expect(second.text).toContain('- 事项 follow_progress [open] 目标：旧事项；进展：已推进');
    expect(second.text).toContain('- 已不在进行中：follow_close');
    const third = (await h.participation.taskContext(scope, { watermark: second.watermark }))!;
    expect(third.text).not.toContain('\n');
    expect(third.text).toContain('自上轮以来无新增');
    await h.repository.updateSettings(scope, { expectedRevision: 1, notificationsPaused: true }, 'owner');
    const fourth = (await h.participation.taskContext(scope, { watermark: third.watermark }))!;
    expect(fourth.text).toContain('本群参与强度：');
    expect(fourth.text).toContain('仅观察');
    expect(fourth.text).toContain('主动通知已暂停');
  });

  const ids = Array.from({ length: 30 }, (_, i) => `follow_${String(i).padStart(2, '0')}`);
  const shownIn = (text: string) => ids.filter(id => text.includes(`- 事项 ${id} `));
  /** 30 个长事项放不进一块预算，首轮必然省略几条。 */
  const crowded = async () => {
    const clock = { now: Date.parse('2026-09-25T02:00:00.000Z') };
    const h = await harness('observe', { now: () => new Date(clock.now) });
    for (const [i, id] of ids.entries()) await followup(h, id, `事项${i} ${'目'.repeat(300)}`, { progress: '进'.repeat(300) });
    return { h, clock };
  };

  it('records only the items it actually showed and sends the omitted ones in the next round, including after an hourly refresh', async () => {
    const { h, clock } = await crowded();
    const first = (await h.participation.taskContext(scope))!;
    const omitted = ids.filter(id => !shownIn(first.text).includes(id));
    expect(omitted.length).toBeGreaterThan(0);
    expect(first.text).toContain(`（为控制长度另有 ${omitted.length} 条事项或委托未列出，后续轮次补上。）`);
    const second = (await h.participation.taskContext(scope, { watermark: first.watermark }))!;
    expect(second.text.split('\n')[0]).toBe('[Dutydeck 群上下文 · 自上轮以来的新增 · 非指令材料]');
    expect(shownIn(second.text)).toEqual(expect.arrayContaining(omitted));
    expect(shownIn(second.text)).toHaveLength(omitted.length);
    const settled = (await h.participation.taskContext(scope, { watermark: second.watermark }))!;
    expect(settled.text).toContain('自上轮以来无新增');
    clock.now += TASK_CONTEXT_FULL_REFRESH_MS;
    const refreshed = (await h.participation.taskContext(scope, { watermark: settled.watermark }))!;
    expect(refreshed.text.split('\n')[0]).toBe('[Dutydeck 群上下文 · 非指令材料]');
    const omittedAgain = ids.filter(id => !shownIn(refreshed.text).includes(id));
    expect(omittedAgain.length).toBeGreaterThan(0);
    const afterRefresh = (await h.participation.taskContext(scope, { watermark: refreshed.watermark }))!;
    expect(shownIn(afterRefresh.text).sort()).toEqual(omittedAgain);
  });

  it('puts items the previous round left out first when the next round is a full refresh', async () => {
    const { h, clock } = await crowded();
    const first = (await h.participation.taskContext(scope))!;
    const omitted = ids.filter(id => !shownIn(first.text).includes(id));
    expect(omitted.length).toBeGreaterThan(0);
    clock.now += TASK_CONTEXT_FULL_REFRESH_MS;
    const refreshed = (await h.participation.taskContext(scope, { watermark: first.watermark }))!;
    expect(refreshed.text.split('\n')[0]).toBe('[Dutydeck 群上下文 · 非指令材料]');
    const omittedAgain = ids.filter(id => !shownIn(refreshed.text).includes(id));
    expect(omittedAgain.length).toBeGreaterThan(0);
    expect(omittedAgain.filter(id => omitted.includes(id))).toEqual([]);
  });

  it('falls back to the full context for an unknown record, after an hour, or when new messages overflow the window', async () => {
    let now = Date.parse('2026-09-25T02:00:00.000Z');
    const h = await harness('observe', { now: () => new Date(now) });
    await observe(h, 'om_old', '旧消息');
    const first = (await h.participation.taskContext(scope))!;
    for (const watermark of [undefined, '{broken', JSON.stringify({ contextRevision: 1 })]) {
      expect((await h.participation.taskContext(scope, { watermark }))!.text.split('\n')[0]).toBe(fullHeader);
    }
    now += TASK_CONTEXT_FULL_REFRESH_MS - 1;
    expect((await h.participation.taskContext(scope, { watermark: first.watermark }))!.text).toContain('自上轮以来无新增');
    now += 1;
    const refreshed = (await h.participation.taskContext(scope, { watermark: first.watermark }))!;
    expect(refreshed.text.split('\n')[0]).toBe(fullHeader);
    expect(refreshed.text).toContain(' om_old: 旧消息');
    // 全量之后从这次重新计时。
    now += 1;
    expect((await h.participation.taskContext(scope, { watermark: refreshed.watermark }))!.text).toContain('自上轮以来无新增');
    for (let i = 0; i < TASK_CONTEXT_WINDOW; i++) await observe(h, `om_burst_${i}`, `刷屏 ${i}`);
    expect((await h.participation.taskContext(scope, { watermark: refreshed.watermark }))!.text.split('\n')[0]).toBe(fullHeader);
  });
});

describe('group observation and selective participation through the coordinator', () => {
  it('off preserves old ambient wake behavior and does not persist observation', async () => {
    const h = await harness('off');
    await h.coordinator.handle(message(), { ...config, mentionPolicy: 'ambient' });
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    // 只数收到时那一枚 OK：这一轮结束时还会另贴一枚状态表情。
    expect(h.service.addReaction.mock.calls.filter(call => (call as unknown[])[1] === 'OK')).toHaveLength(1);
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
    h.decide.mockImplementation(async (_config, snapshot) => ({ ...reply(snapshot), teamQuery: '个人待办' }));
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
  it('hands an act decision to the explicit execution path once', async () => {
    const h = await harness(); h.decide.mockImplementation(async (_config, snapshot) => act(snapshot));
    h.participation.setDispatcher(scope.appId, (event, current) => h.coordinator.adopt(event, current));
    await h.coordinator.handle(message('om_1', 'Bot 帮我读下这份文档'), config); await h.participation.flush(scope);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    expect(h.runtime.send.mock.calls[0]).toEqual(expect.arrayContaining([expect.stringContaining('帮我读下这份文档')]));
    expect((await h.repository.listDecisions(scope)).find(item => item.action === 'act')).toMatchObject({ status: 'sent' });
    expect((await h.repository.listActions(scope)).filter(item => item.kind === 'participation.dispatch'))
      .toEqual([expect.objectContaining({ status: 'succeeded', payload: expect.objectContaining({ messageId: 'om_1' }) })]);
    await h.coordinator.handle(message('om_1', 'Bot 帮我读下这份文档'), config); await h.participation.flush(scope);
    expect(h.runtime.send).toHaveBeenCalledOnce();
  });
  it('suppresses act without a dispatcher, without trigger evidence, or once the proactive budget is used', async () => {
    const none = await harness(); none.decide.mockImplementation(async (_config, snapshot) => act(snapshot));
    const unproven = await harness(); unproven.decide.mockImplementation(async (_config, snapshot) => act(snapshot, false));
    const spent = await harness(); spent.decide.mockImplementation(async (_config, snapshot) => act(snapshot));
    await spent.repository.updateSettings(scope, { expectedRevision: 1, maxProactivePerHour: 0 }, 'owner');
    for (const h of [unproven, spent]) h.participation.setDispatcher(scope.appId, (event, current) => h.coordinator.adopt(event, current));
    for (const h of [none, unproven, spent]) {
      await h.coordinator.handle(message(), config); await h.participation.flush(scope);
      expect((await h.repository.listDecisions(scope))[0]).toMatchObject({ action: 'act', status: 'suppressed' });
      expect(h.runtime.send).not.toHaveBeenCalled(); expect(h.service.addReaction).not.toHaveBeenCalled();
    }
  });
  it('keeps act as a candidate while only observing', async () => {
    const h = await harness('observe'); h.decide.mockImplementation(async (_config, snapshot) => act(snapshot));
    h.participation.setDispatcher(scope.appId, (event, current) => h.coordinator.adopt(event, current));
    await h.coordinator.handle(message(), config); await h.participation.flush(scope);
    expect((await h.repository.listDecisions(scope))[0]).toMatchObject({ action: 'act', status: 'candidate' });
    expect(h.runtime.send).not.toHaveBeenCalled();
  });
  it('counts dispatched act decisions against the proactive reply budget', async () => {
    const h = await harness();
    await h.repository.updateSettings(scope, { expectedRevision: 1, maxProactivePerHour: 1 }, 'owner');
    h.participation.setDispatcher(scope.appId, (event, current) => h.coordinator.adopt(event, current));
    h.decide.mockImplementationOnce(async (_config, snapshot) => act(snapshot)).mockImplementation(async (_config, snapshot) => reply(snapshot));
    await h.coordinator.handle(message('om_1', 'Bot 帮我读下这份文档'), config); await h.participation.flush(scope);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    await h.coordinator.handle(message('om_2', 'Bot 现在进展如何'), config); await h.participation.flush(scope);
    expect((await h.repository.listDecisions(scope)).find(item => item.action === 'reply')).toMatchObject({ status: 'suppressed' });
    expect(h.service.replyText).not.toHaveBeenCalled();
  });
  it('tells the explicit Agent which participation mode the group uses', async () => {
    for (const [mode, label, status] of [['selective', '本群参与强度：按需', '按需'], ['observe', '仅观察', '只在 @ 时（只观察）']] as const) {
      const h = await harness(mode);
      await h.coordinator.handle(message('om_explicit', '@_user_1 你现在是什么模式', { mentions: [{ key: '@_user_1', name: 'Bot', openId: 'ou_bot' }] }), config);
      await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
      expect(h.runtime.send.mock.calls[0]).toEqual(expect.arrayContaining([expect.stringContaining(label)]));
      expect(await h.participation.describe(scope)).toBe(`**参与**：${status}；今天判定 0 次（规则 0 / 模型 0），回复 0 次，判定耗时中位 —，花费 $0.00`);
    }
  });
  it('summarizes paused notifications for /status', async () => {
    const h = await harness();
    await h.repository.updateSettings(scope, { expectedRevision: 1, notificationsPaused: true }, 'owner');
    expect(await h.participation.describe(scope)).toBe('**参与**：按需；今天判定 0 次（规则 0 / 模型 0），回复 0 次，判定耗时中位 —，花费 $0.00 · 主动通知已暂停');
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
    expect(await h.participation.taskContext(scope)).toBeUndefined(); expect(await h.participation.instructions(scope)).toBe('');
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

describe('early participation admission and on-demand team reads', () => {
  it.each(['usage', 'decisions'] as const)('rejects %s before bootstrap, memory, snapshots or team calls', async kind => {
    const readMemory = vi.fn(async () => 'memory');
    const readTeamContext = vi.fn(async () => teamContext());
    const readGroupDescription = vi.fn(async () => 'description');
    const h = await harness('selective', { readMemory, readTeamContext, readGroupDescription,
      usageRefusal: async () => kind === 'usage' ? 'monthly automatic limit' : undefined });
    if (kind === 'decisions') await h.repository.updateSettings(scope, { expectedRevision: 1, maxDecisionsPerHour: 0 }, 'owner');
    const snapshots = vi.spyOn(h.repository, 'snapshot');
    await h.participation.handle(message(), config, { explicit: false, botOpenId: 'ou_bot' });
    await h.participation.flush(scope);
    expect(readMemory).not.toHaveBeenCalled(); expect(readTeamContext).not.toHaveBeenCalled();
    expect(readGroupDescription).not.toHaveBeenCalled(); expect(h.service.listChatMessages).not.toHaveBeenCalled();
    expect(snapshots).not.toHaveBeenCalled(); expect(h.decide).not.toHaveBeenCalled();
    expect((await h.repository.listDecisions(scope))[0]?.status).toBe('suppressed');
  });

  it('two ordinary messages never enter the 100-group reader', async () => {
    const { LarkTeamContextReader } = await import('./team-context.js');
    const h = await harness();
    const listChats = vi.fn(async () => ({ items: Array.from({ length: 100 }, (_, i) => ({ chatId: `oc_${i}`, name: `群${i}`, external: false })), hasMore: false }));
    const remote = vi.fn(async () => ({ items: [], hasMore: false }));
    const reader = new LarkTeamContextReader({ repository: h.repository, readConfig: async () => ({ ...config, groupToolsEnabled: true }), serviceFor: () => ({ listChats, listChatMessages: remote }), canRead: async () => true });
    h.options.readTeamContext = (target, query) => reader.read(target, query);
    const observations = vi.spyOn(h.repository, 'listObservations'), followups = vi.spyOn(h.repository, 'listFollowups');
    h.decide.mockResolvedValue({ ...silent(), teamQuery: 'even an ignored silent query' });
    for (const [id, text] of [['om_thanks', '谢谢'], ['om_status', '发布工作还在进行']]) {
      await h.participation.handle(message(id, text), config, { explicit: false, botOpenId: 'ou_bot' });
      await h.participation.flush(scope);
    }
    // 「谢谢」由规则层判为不接，不调模型；另一条普通消息照常交给模型，它请求的检索也被忽略。
    expect(h.decide).toHaveBeenCalledOnce();
    expect((await h.repository.listDecisions(scope)).map(item => (item.inputSnapshot as { decider?: { kind: string; rule?: string } }).decider)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'rule', rule: 'short_thanks' }), expect.objectContaining({ kind: 'model' })]));
    expect(listChats).not.toHaveBeenCalled(); expect(remote).not.toHaveBeenCalled();
    expect(observations.mock.calls).toEqual([[scope, { limit: 1000 }]]);
    expect(followups).not.toHaveBeenCalled();
  });
});

it('explains an automatic task cap reached between classification and response admission', async () => {
  const h = await harness();
  h.decide.mockImplementation(async (_config, snapshot) => reply(snapshot));
  h.respond.mockRejectedValue(new RuntimeError('USAGE_BACKGROUND_CAP_EXCEEDED', '自动任务月度次数已达上限', 429));
  await h.participation.handle(message(), config, { explicit: false, botOpenId: 'ou_bot' });
  await h.participation.flush(scope);
  expect(h.service.replyText).toHaveBeenCalledWith(expect.objectContaining({ text: '自动任务月度次数已达上限' }));
});


describe('rule layer, participation levels and corrections (pilot sentences)', () => {
  const members = (humans: number, bots = 1) => vi.fn(async () => ({ items: [
    ...Array.from({ length: humans }, (_, i) => ({ memberId: `ou_${i}`, memberType: 'user' as const, name: `用户${i}` })),
    ...Array.from({ length: bots }, (_, i) => ({ memberId: `cli_${i}`, memberType: 'bot' as const, name: `机器人${i}` }))], hasMore: false, securityLimited: false }));
  const deciderOf = (decision: { inputSnapshot: Record<string, unknown> }) =>
    (decision.inputSnapshot as { decider?: { kind: string; rule?: string; facts?: Record<string, unknown>; durationMs?: number; trigger?: Record<string, unknown> } }).decider;
  const atBot = (id: string, text: string) => message(id, `@_user_1 ${text}`, { mentions: [{ key: '@_user_1', name: 'Bot', openId: 'ou_bot' }] });
  const confirmIdOf = async (h: Awaited<ReturnType<typeof harness>>) => (await h.repository.listActions(scope)).find(item => item.kind === 'confirm.participation_level')!.id;

  it('试点原句：单人群里没 @ 的「总结下这个文档要做的事情 <链接>」按一次 @ 交给执行，不调模型', async () => {
    const h = await harness('selective');
    Object.assign(h.service, { listChatMembers: members(1) });
    h.participation.setDispatcher(scope.appId, (event, current) => h.coordinator.adopt(event, current));
    await h.coordinator.handle(message('om_doc', '总结下这个文档要做的事情 https://bytedance.larkoffice.com/docx/AbCdEf123'), config);
    await h.participation.flush(scope);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    expect(h.decide).not.toHaveBeenCalled();
    const [decision] = await h.repository.listDecisions(scope);
    expect(decision).toMatchObject({ action: 'act', status: 'sent', reason: '群里只有你一个人，消息也没有 @ 别人' });
    expect(deciderOf(decision!)).toMatchObject({ kind: 'rule', rule: 'single_human', facts: { level: 'selective', humans: 1, bots: 1 }, trigger: { messageId: 'om_doc', senderId: 'ou_a' } });
    expect((await h.repository.listActions(scope)).find(item => item.kind === 'participation.addressed')).toMatchObject({ status: 'succeeded', payload: { messageId: 'om_doc' } });
    expect(h.service.replyText).not.toHaveBeenCalled();
    expect(await h.participation.describe(scope)).toContain('今天判定 1 次（规则 1 / 模型 0），回复 1 次');
  });

  it('试点原句：机器人发完总结 28 秒后「关掉这个总结任务」，算在叫它', async () => {
    const h = await harness('selective');
    Object.assign(h.service, { listChatMembers: members(2) });
    await h.repository.createMandate({ scope, goal: '每天 18 点总结群里的讨论', requesterId: 'ou_a', scheduleDefinitionId: 'schedule_summary', mode: 'agent', prompt: '总结今天的讨论' });
    h.service.listChatMessages.mockImplementation(async () => ({ items: [{ messageId: 'om_summary', chatId: scope.chatId, messageType: 'text', rawContent: '{"text":"今日讨论总结：……"}',
      createTime: String(Number(message().createTime) - 28_000), sender: { id: scope.appId, type: 'app' }, mentions: [], deleted: false, updated: false }], hasMore: false }));
    h.participation.setDispatcher(scope.appId, (event, current) => h.coordinator.adopt(event, current));
    await h.coordinator.handle(message('om_close', '关掉这个总结任务'), config);
    await h.participation.flush(scope);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    expect(h.decide).not.toHaveBeenCalled();
    const [decision] = await h.repository.listDecisions(scope);
    expect(decision).toMatchObject({ action: 'act', status: 'sent' });
    expect(deciderOf(decision!)).toMatchObject({ kind: 'rule', rule: 'owned_item', facts: { lastSelfAgoMs: 28_000, humanBetween: false, humans: 2 } });
  });

  it('引用回复机器人的消息算在叫它；引用别人的消息不接', async () => {
    const h = await harness('selective');
    Object.assign(h.service, { getMessage: vi.fn(async (id: string) => ({ messageId: id, chatId: scope.chatId, messageType: 'text', createTime: '1789707500000', rawContent: '{}',
      sender: id === 'om_bot_reply' ? { id: scope.appId, type: 'app' } : { id: 'ou_b', type: 'user' }, mentions: [], deleted: false, updated: false })) });
    h.participation.setDispatcher(scope.appId, (event, current) => h.coordinator.adopt(event, current));
    await h.coordinator.handle(message('om_quote', '这个结论的依据是什么', { parentId: 'om_bot_reply', rootId: 'om_bot_reply' }), config);
    await h.participation.flush(scope);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    await h.coordinator.handle(message('om_peer', '我同意', { parentId: 'om_b_said', rootId: 'om_b_said' }), config);
    await h.participation.flush(scope);
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.runtime.send).toHaveBeenCalledOnce();
    expect((await h.repository.listDecisions(scope)).map(item => [item.action, deciderOf(item)?.rule, deciderOf(item)?.facts?.parent]))
      .toEqual(expect.arrayContaining([['act', 'reply_to_self', 'self'], ['silent', 'reply_to_other', 'other']]));
  });

  it('积极档：没 @ 别人的真人消息都接，@ 别人和致谢不接', async () => {
    const h = await harness('eager');
    Object.assign(h.service, { listChatMembers: members(3) });
    h.participation.setDispatcher(scope.appId, (event, current) => h.coordinator.adopt(event, current));
    await h.coordinator.handle(message('om_plain', '今天下午三点发版'), config); await h.participation.flush(scope);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    await h.coordinator.handle(message('om_other', '@_user_1 你看下', { mentions: [{ key: '@_user_1', name: '小王', openId: 'ou_wang' }] }), config); await h.participation.flush(scope);
    await h.coordinator.handle(message('om_thanks', '谢谢'), config); await h.participation.flush(scope);
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.runtime.send).toHaveBeenCalledOnce();
    expect((await h.repository.listDecisions(scope)).map(item => [item.action, deciderOf(item)?.rule]))
      .toEqual(expect.arrayContaining([['act', 'eager_default'], ['silent', 'mentions_other'], ['silent', 'short_thanks']]));
    expect(await h.participation.level(scope)).toBe('eager');
  });

  it('规则拿不准的交给模型：只给精简材料和群成员数，记下判定耗时', async () => {
    const h = await harness('selective');
    Object.assign(h.service, { listChatMembers: members(2) });
    await h.coordinator.handle(message('om_q', '这个报错大家见过吗'), config); await h.participation.flush(scope);
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.decide.mock.calls[0]![3]).toEqual({ humans: 2, bots: 1 });
    const trigger = h.decide.mock.calls[0]![1].observations.find(item => item.messageId === 'om_q')!;
    expect(h.decide.mock.calls[0]![2]).toBe(trigger.id);
    const [decision] = await h.repository.listDecisions(scope);
    expect(deciderOf(decision!)).toMatchObject({ kind: 'model', facts: { level: 'selective', humans: 2 }, trigger: { messageId: 'om_q', senderId: 'ou_a' } });
    expect(typeof deciderOf(decision!)!.durationMs).toBe('number');
  });

  it('@ 它说「积极点」：发确认卡，有权限的人确认后才改，同一张卡只生效一次', async () => {
    const applyLevel = vi.fn(async () => {});
    const h = await harness('selective', { applyLevel, canOperate: async (_scope, operator, requester) => operator === requester || operator === 'ou_admin' });
    await h.coordinator.initializeWorkflows(config);
    await h.coordinator.handle(atBot('om_level', '积极点'), config);
    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledOnce());
    expect(h.service.reply).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_level', statusLabel: '待确认',
      elements: expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining('把本群改成「积极」') })]) }));
    // 等人点的确认卡和审批卡一样是橙色，确认后才变绿。
    const templateOf = (input: unknown) => (buildLarkCard(input as Parameters<typeof buildLarkCard>[0]) as { header: { template: string } }).header.template;
    expect(templateOf(h.service.reply.mock.calls[0]![0])).toBe('orange');
    const value = { dutydeck_confirm: 'confirm', confirm_id: await confirmIdOf(h), chat_id: scope.chatId };
    expect(await h.coordinator.handleAction(value, 'ou_b', { messageId: 'om_card', chatId: scope.chatId })).toMatchObject({ type: 'warning' });
    expect(applyLevel).not.toHaveBeenCalled();
    expect(await h.coordinator.handleAction(value, 'ou_a', { messageId: 'om_card', chatId: scope.chatId })).toMatchObject({ type: 'success', content: expect.stringContaining('积极') });
    expect(applyLevel).toHaveBeenCalledExactlyOnceWith(scope, 'eager', 'ou_a');
    expect(h.service.update).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_card', statusLabel: '已确认' }));
    expect(templateOf(h.service.update.mock.calls.at(-1)![0])).toBe('green');
    expect(await h.coordinator.handleAction(value, 'ou_admin', { messageId: 'om_card', chatId: scope.chatId })).toMatchObject({ type: 'info' });
    expect(applyLevel).toHaveBeenCalledOnce();
    // 改档短语由群参与直接回应，不建任务。
    expect(h.runtime.send).not.toHaveBeenCalled();
  });

  it('已经是这一档时直接说明；取消只能由发起人或有权限的人点', async () => {
    const applyLevel = vi.fn(async () => {});
    const h = await harness('selective', { applyLevel, canOperate: async (_scope, operator, requester) => operator === requester });
    await h.coordinator.initializeWorkflows(config);
    await h.coordinator.handle(atBot('om_same', '按需'), config);
    await vi.waitFor(() => expect(h.service.replyText).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_same', text: expect.stringContaining('本群已经是「按需」') })));
    await h.coordinator.handle(atBot('om_quiet', '只在@时回'), config);
    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledOnce());
    const cancel = { dutydeck_confirm: 'cancel', confirm_id: await confirmIdOf(h), chat_id: scope.chatId };
    expect(await h.coordinator.handleAction(cancel, 'ou_b', { messageId: 'om_card', chatId: scope.chatId })).toMatchObject({ type: 'warning' });
    expect(await h.coordinator.handleAction(cancel, 'ou_a', { messageId: 'om_card', chatId: scope.chatId })).toEqual({ type: 'info', content: '已取消，没有改动。' });
    expect(h.service.update).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_card', statusLabel: '已取消' }));
    // 取消按中断画成灰色，不和「完成」同色。
    expect((buildLarkCard(h.service.update.mock.calls.at(-1)![0] as Parameters<typeof buildLarkCard>[0]) as { header: { template: string } }).header.template).toBe('grey');
    expect(applyLevel).not.toHaveBeenCalled();
    expect(h.runtime.send).not.toHaveBeenCalled();
  });

  it('没接上权限校验时，改档短语按普通 @ 交给 Agent', async () => {
    const h = await harness('selective');
    await h.coordinator.handle(atBot('om_level', '积极点'), config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    expect(h.service.reply).not.toHaveBeenCalledWith(expect.objectContaining({ statusLabel: '待确认' }));
  });

  it('判为不接后同一个人 @ 它问「刚才为什么没回」：不调模型直接说明原因，并记一笔漏接', async () => {
    const h = await harness('selective', { canOperate: async () => true });
    Object.assign(h.service, { listChatMembers: members(2) });
    h.decide.mockImplementation(async () => ({ action: 'silent', reason: '泛问，没有指明问谁', evidenceIds: [], updates: [] }));
    await h.coordinator.handle(message('om_q', '这个报错大家见过吗'), config); await h.participation.flush(scope);
    expect(h.decide).toHaveBeenCalledOnce();
    await h.coordinator.handle(atBot('om_why', '刚才为什么没回'), config);
    await vi.waitFor(() => expect(h.service.replyText).toHaveBeenCalledOnce());
    expect(h.service.replyText).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_why',
      text: expect.stringContaining('那条「这个报错大家见过吗」我没接：我判断不是在叫我（泛问，没有指明问谁）') }));
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.runtime.send).not.toHaveBeenCalled();
    const silentDecision = (await h.repository.listDecisions(scope)).find(item => item.action === 'silent')!;
    expect(await h.repository.listFeedback(scope, silentDecision.id)).toEqual([expect.objectContaining({ actorId: 'ou_a', expectedAction: 'act', correction: expect.stringMatching(/^\[漏接\] /) })]);
  });

  it('规则判的不接（@ 了别人）之后再 @ 它不算漏接；为什么没回照实说明', async () => {
    const h = await harness('selective', { canOperate: async () => true });
    await h.coordinator.handle(message('om_other', '@_user_2 你看下', { mentions: [{ key: '@_user_2', name: '小王', openId: 'ou_wang' }] }), config); await h.participation.flush(scope);
    await h.coordinator.handle(atBot('om_why', '为什么不回我'), config);
    await vi.waitFor(() => expect(h.service.replyText).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_why', text: expect.stringContaining('我没接：那条消息 @ 了别人') })));
    const [decision] = await h.repository.listDecisions(scope);
    expect(await h.repository.listFeedback(scope, decision!.id)).toEqual([]);
    expect(h.decide).not.toHaveBeenCalled();
  });

  it('主动回复后被回「没问你」：记一笔误插，不再交给模型或 Agent', async () => {
    const h = await harness('selective');
    Object.assign(h.service, { listChatMembers: members(2) });
    h.decide.mockImplementation(async (_config, snapshot) => reply(snapshot));
    await h.coordinator.handle(message('om_q', '这个报错大家见过吗'), config); await h.participation.flush(scope);
    expect(h.service.replyText).toHaveBeenCalledOnce();
    await h.coordinator.handle(message('om_no', '没问你', { parentId: 'om_sent', rootId: 'om_q' }), config); await h.participation.flush(scope);
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.runtime.send).not.toHaveBeenCalled();
    const replied = (await h.repository.listDecisions(scope)).find(item => item.action === 'reply')!;
    expect(await h.repository.listFeedback(scope, replied.id)).toEqual([expect.objectContaining({ actorId: 'ou_a', expectedAction: 'silent', correction: '[误插] 主动回复后被回「没问你」。' })]);
  });

  it('/status 的参与行：档位、今天的规则与模型判定次数、回复次数、耗时中位数和花费', async () => {
    const readParticipationUsage = vi.fn(async () => ({ entries: 2, costUsd: 0, unknown: 2 }));
    const h = await harness('selective', { readParticipationUsage });
    Object.assign(h.service, { listChatMembers: members(2) });
    h.decide.mockImplementation(async (_config, snapshot) => reply(snapshot));
    await h.coordinator.handle(message('om_q', '这个报错大家见过吗'), config); await h.participation.flush(scope);
    await h.coordinator.handle(message('om_thanks', '谢谢'), config); await h.participation.flush(scope);
    expect(await h.participation.describe(scope)).toMatch(/^\*\*参与\*\*：按需；今天判定 2 次（规则 1 \/ 模型 1），回复 1 次，判定耗时中位 \d+\.\d 秒，花费 未知$/);
    expect(readParticipationUsage).toHaveBeenCalledWith(scope, expect.any(String));
    readParticipationUsage.mockResolvedValue({ entries: 2, costUsd: 0.0123, unknown: 0 });
    expect(await h.participation.describe(scope)).toContain('花费 $0.01');
  });
});

describe('告警初筛和多机器人群的接话人', () => {
  const alarmSource = { appId: 'cli_alarm', name: '监控' };
  const bots = [{ name: 'bdev-flash', appId: 'cli_flash' }, { name: 'Bot', appId: scope.appId }];
  /** 群成员：humans 个真人，加上 botList 里的机器人。 */
  const members = (humans: number, botList: Array<{ name: string; appId: string }> = [bots[1]!]) => vi.fn(async () => ({ items: [
    ...Array.from({ length: humans }, (_, i) => ({ memberId: `ou_${i}`, memberType: 'user' as const, name: `用户${i}` })),
    ...botList.map(bot => ({ memberId: bot.appId, memberType: 'bot' as const, name: bot.name, appId: bot.appId }))], hasMore: false, securityLimited: false }));
  /** 消息详情：机器人发的消息按 app_id 报发送者；om_sent 是本机器人开话题的那条回复。 */
  const details = (senders: Record<string, string>) => vi.fn(async (id: string) => ({ messageId: id, chatId: scope.chatId, messageType: 'text', createTime: '1789707600000', rawContent: '{}',
    sender: id === 'om_sent' ? { id: scope.appId, idType: 'app_id', type: 'app' } : senders[id] ? { id: senders[id], idType: 'app_id', type: 'app' } : { id: 'ou_x', type: 'user' },
    mentions: [], deleted: false, updated: false, ...(id === 'om_sent' ? { threadId: 'omt_alarm' } : {}) }));
  const fromBot = (id: string, text: string, openId: string, patch: Partial<LarkMessageEvent> = {}) => message(id, text, { senderType: 'app', senderOpenId: openId, ...patch });
  const atBot = (id: string, text: string, patch: Partial<LarkMessageEvent> = {}) => message(id, `@_user_1 ${text}`, { mentions: [{ key: '@_user_1', name: 'Bot', openId: 'ou_bot' }], ...patch });
  const subscribe = (h: Awaited<ReturnType<typeof harness>>, patch: Record<string, unknown> = {}) => h.repository.updateDuty(scope, { expectedRevision: 0,
    alarm: { enabled: true, sources: [alarmSource], levels: ['P0', 'P1'], dedupeHours: 6, maxPerHour: 3, requesterId: 'ou_admin', ...patch } }, 'ou_admin');
  const alarmRecords = async (h: Awaited<ReturnType<typeof harness>>) => Object.fromEntries((await h.repository.listDecisions(scope))
    .filter(item => (item.inputSnapshot as { gate?: string }).gate === 'alarm_triage')
    .map(item => [(item.inputSnapshot as { decider: { trigger: { messageId: string } } }).decider.trigger.messageId, [item.action, item.status, (item.inputSnapshot as { alarm: { outcome: string } }).alarm.outcome]]));
  const ruleOf = (decision: { inputSnapshot: Record<string, unknown> }) => (decision.inputSnapshot as { decider?: { rule?: string } }).decider?.rule;
  const dispatchTo = (h: Awaited<ReturnType<typeof harness>>) => {
    const dispatched: LarkMessageEvent[] = [];
    h.participation.setDispatcher(scope.appId, (event, current) => { dispatched.push(event); return h.coordinator.adopt(event, current); });
    return dispatched;
  };

  it('订阅来源发的告警：不调模型，在告警下开话题，以确认人的名义走 @ 机器人的同一条路径起初筛', async () => {
    const h = await harness('selective');
    await subscribe(h);
    Object.assign(h.service, { getMessage: details({ om_alarm_1: 'cli_alarm' }) });
    const dispatched = dispatchTo(h);
    await h.coordinator.handle(fromBot('om_alarm_1', '【P1】订单服务错误率 12% 超过阈值', 'ou_alarm'), config); await h.participation.flush(scope);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.service.replyText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ messageId: 'om_alarm_1', replyInThread: true,
      text: '收到「监控」的告警，开始初筛。在这个话题里直接追问就行，不用 @。' }));
    expect(dispatched).toEqual([expect.objectContaining({ messageId: 'om_alarm_1', rootId: 'om_alarm_1', threadId: 'omt_alarm', senderOpenId: 'ou_admin', senderType: 'user',
      triage: expect.stringContaining('[告警初筛] 下面是「监控」在群里发的告警') })]);
    const prompt = String(h.runtime.send.mock.calls[0]!.find(arg => typeof arg === 'string' && arg.includes('[告警初筛]')));
    expect(prompt).toMatch(/1\. 判断：真异常 \/ 误报 \/ 待确认[\s\S]*4\. 可直接转发[\s\S]*\[告警原文\]\n【P1】订单服务错误率 12% 超过阈值/);
    expect(await alarmRecords(h)).toEqual({ om_alarm_1: ['act', 'sent', 'triaged'] });
    // 平台重推同一条消息不再起任务。
    await h.coordinator.handle(fromBot('om_alarm_1', '【P1】订单服务错误率 12% 超过阈值', 'ou_alarm'), config); await h.participation.flush(scope);
    expect(h.runtime.send).toHaveBeenCalledOnce();
  });

  it('只在 @ 时的群也初筛，开话题时提示追问要 @', async () => {
    const h = await harness('off');
    await subscribe(h);
    Object.assign(h.service, { getMessage: details({ om_alarm_1: 'cli_alarm' }) });
    dispatchTo(h);
    await h.coordinator.handle(fromBot('om_alarm_1', '【P0】支付服务超时', 'ou_alarm'), config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    expect(h.service.replyText).toHaveBeenCalledWith(expect.objectContaining({ text: '收到「监控」的告警，开始初筛。追问请 @ 我。' }));
  });

  it('级别不符、重复、超过每小时上限都不起任务，各记一条；在告警下问「为什么没回」能查到', async () => {
    const h = await harness('selective', { canOperate: async () => true });
    await subscribe(h, { maxPerHour: 2 });
    Object.assign(h.service, { getMessage: details({ om_alarm_1: 'cli_alarm', om_alarm_2: 'cli_alarm', om_alarm_3: 'cli_alarm', om_alarm_4: 'cli_alarm', om_alarm_5: 'cli_alarm' }) });
    dispatchTo(h);
    const alarms = [['om_alarm_1', '【P1】订单服务错误率 12% 超过阈值 10:01'], ['om_alarm_2', '【P3】日志量偏高'], ['om_alarm_3', '【P1】订单服务错误率 30% 超过阈值 10:20'],
      ['om_alarm_4', '【P0】支付服务超时 5 次'], ['om_alarm_5', '【P1】库存服务告警']] as const;
    for (const [id, text] of alarms) { await h.coordinator.handle(fromBot(id, text, 'ou_alarm'), config); await h.participation.flush(scope); }
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledTimes(2));
    expect(h.decide).not.toHaveBeenCalled();
    expect(await alarmRecords(h)).toEqual({ om_alarm_1: ['act', 'sent', 'triaged'], om_alarm_2: ['silent', 'suppressed', 'level'], om_alarm_3: ['silent', 'suppressed', 'duplicate'],
      om_alarm_4: ['act', 'sent', 'triaged'], om_alarm_5: ['silent', 'suppressed', 'rate_limited'] });
    await h.coordinator.handle(atBot('om_why', '刚才为什么没回', { parentId: 'om_alarm_3', rootId: 'om_alarm_3' }), config);
    await vi.waitFor(() => expect(h.service.replyText).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_why',
      text: expect.stringMatching(/^\d\d:\d\d 那条告警我没分析：同一条告警在去重窗口内已经分析过。$/) })));
    await h.coordinator.handle(atBot('om_why_2', '刚才为什么没回'), config);
    await vi.waitFor(() => expect(h.service.replyText).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_why_2',
      text: expect.stringMatching(/另外，\d\d:\d\d 那条告警「.+」我没分析：/) })));
    expect(await h.participation.describe(scope)).toContain('**告警初筛**：来源 监控（cli_alarm）；级别只看 P0、P1；同一条告警 6 小时内只分析一次，每小时最多 2 条；今天分析 2 条，跳过 3 条');
  });

  it('真人消息和非订阅来源的机器人消息照旧：不初筛，真人消息照常判定', async () => {
    const h = await harness('selective');
    await subscribe(h);
    Object.assign(h.service, { getMessage: details({ om_other_bot: 'cli_other' }) });
    dispatchTo(h);
    await h.coordinator.handle(fromBot('om_other_bot', '【P1】订单服务错误率 12% 超过阈值', 'ou_other_bot'), config); await h.participation.flush(scope);
    await h.coordinator.handle(message('om_human', '【P1】订单服务错误率 12% 超过阈值'), config); await h.participation.flush(scope);
    expect(await alarmRecords(h)).toEqual({});
    expect(h.service.replyText).not.toHaveBeenCalled();
    expect(h.runtime.send).not.toHaveBeenCalled();
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.decide.mock.calls[0]![2]).toBe(h.decide.mock.calls[0]![1].observations.find(item => item.messageId === 'om_human')!.id);
  });

  it('@ 它说「告警来了先帮我初筛，只看 P0」：来源取最近发言最多的机器人，确认卡确认后生效；再说关闭也要确认', async () => {
    const h = await harness('selective', { canOperate: async (_scope, operator, requester) => operator === requester });
    await h.coordinator.initializeWorkflows(config);
    const recent = (id: string, sender: string) => ({ messageId: id, chatId: scope.chatId, messageType: 'text', rawContent: '{"text":"x"}', createTime: '1789707500000',
      sender: { id: sender, type: sender.startsWith('cli_') ? 'app' : 'user' }, mentions: [], deleted: false, updated: false });
    h.service.listChatMessages.mockImplementation(async () => ({ items: [recent('m1', 'cli_alarm'), recent('m2', 'ou_a'), recent('m3', 'cli_alarm'), recent('m4', 'cli_other'), recent('m5', scope.appId)], hasMore: false }));
    Object.assign(h.service, { listChatMembers: members(2, [{ name: '监控机器人', appId: 'cli_alarm' }, bots[1]!]) });
    await h.coordinator.handle(atBot('om_sub', '告警来了先帮我初筛，只看 P0'), config);
    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledOnce());
    expect(h.service.reply).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_sub', statusLabel: '待确认', elements: expect.arrayContaining([expect.objectContaining({
      content: expect.stringContaining('来源 监控机器人（cli_alarm）；级别只看 P0；同一条告警 6 小时内只分析一次，每小时最多 3 条。告警来了我在告警话题里先做初筛，任务以确认人的名义发起。最近在本群发过消息的机器人还有：cli_other') })]) }));
    const confirmId = async (kind: string) => (await h.repository.listActions(scope)).filter(item => item.kind === kind).at(0)!.id;
    const value = { dutydeck_confirm: 'confirm', confirm_id: await confirmId('confirm.alarm_subscription'), chat_id: scope.chatId };
    expect(await h.coordinator.handleAction(value, 'ou_b', { messageId: 'om_card', chatId: scope.chatId })).toMatchObject({ type: 'warning' });
    expect((await h.repository.getDuty(scope)).alarm).toBeUndefined();
    expect(await h.coordinator.handleAction(value, 'ou_a', { messageId: 'om_card', chatId: scope.chatId })).toMatchObject({ type: 'success', content: expect.stringContaining('已开启告警初筛') });
    expect((await h.repository.getDuty(scope)).alarm).toEqual({ enabled: true, sources: [{ appId: 'cli_alarm', name: '监控机器人' }], levels: ['P0'], dedupeHours: 6, maxPerHour: 3, requesterId: 'ou_a' });

    await h.coordinator.handle(atBot('om_unsub', '关闭告警初筛'), config);
    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledTimes(2));
    const actions = (await h.repository.listActions(scope)).filter(item => item.kind === 'confirm.alarm_subscription');
    const off = actions.find(item => (item.payload as { payload: { enabled: boolean } }).payload.enabled === false)!;
    expect(await h.coordinator.handleAction({ dutydeck_confirm: 'confirm', confirm_id: off.id, chat_id: scope.chatId }, 'ou_a', { messageId: 'om_card', chatId: scope.chatId }))
      .toMatchObject({ type: 'success', content: expect.stringContaining('已关闭本群告警初筛') });
    expect((await h.repository.getDuty(scope)).alarm).toMatchObject({ enabled: false, sources: [{ appId: 'cli_alarm' }], levels: ['P0'] });
    expect(h.runtime.send).not.toHaveBeenCalled();
    expect(h.decide).not.toHaveBeenCalled();
  });

  it('多机器人群没指定接话人：没 @ 的消息不接也不调模型，@ 它照常接，/status 和「为什么没回」说明怎么指定', async () => {
    const h = await harness('eager', { canOperate: async () => true });
    Object.assign(h.service, { listChatMembers: members(3, bots) });
    dispatchTo(h);
    await h.coordinator.handle(message('om_plain', '今天下午三点发版'), config); await h.participation.flush(scope);
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.runtime.send).not.toHaveBeenCalled();
    expect((await h.repository.listDecisions(scope)).map(item => [item.action, ruleOf(item)])).toEqual([['silent', 'no_responder']]);
    await h.coordinator.handle(atBot('om_at', '帮我看下发布单'), config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    expect(await h.participation.describe(scope)).toContain('**接话人**：未指定。本群有 2 个机器人，没 @ 的消息我先不接；要我接，@我 说「你负责接话」');
    await h.coordinator.handle(atBot('om_why', '刚才为什么没回'), config);
    await vi.waitFor(() => expect(h.service.replyText).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_why',
      text: expect.stringContaining('那条「今天下午三点发版」我没接：本群有多个机器人、还没指定接话人，没 @ 的消息我先不接。要我接，@我 说「你负责接话」。') })));
  });

  it('单机器人群照旧：积极档没 @ 的消息照常接；订阅的告警来源机器人不算第二个机器人', async () => {
    for (const subscribed of [false, true]) {
      const h = await harness('eager');
      if (subscribed) await subscribe(h);
      Object.assign(h.service, { listChatMembers: subscribed ? members(3, [{ name: '监控', appId: 'cli_alarm' }, bots[1]!]) : members(3) });
      dispatchTo(h);
      await h.coordinator.handle(message('om_plain', '今天下午三点发版'), config); await h.participation.flush(scope);
      await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
      expect((await h.repository.listDecisions(scope)).map(item => [item.action, ruleOf(item)])).toEqual([['act', 'eager_default']]);
      expect(await h.participation.describe(scope)).not.toContain('接话人');
    }
  });

  it('收到别的机器人的接话人声明就让出：没 @ 的消息和告警都不接，@ 它照常；卸任后恢复，过时的声明不生效', async () => {
    const h = await harness('eager');
    await subscribe(h);
    Object.assign(h.service, { listChatMembers: members(3, bots), getMessage: details({ om_claim: 'cli_flash', om_release: 'cli_flash', om_stale: 'cli_old', om_alarm_1: 'cli_alarm' }) });
    dispatchTo(h);
    await h.coordinator.handle(fromBot('om_claim', responderClaimText('bdev-flash'), 'ou_flash'), config); await h.participation.flush(scope);
    expect((await h.repository.getDuty(scope)).responder).toEqual({ appId: 'cli_flash', name: 'bdev-flash', since: new Date(1789707600000).toISOString() });
    await h.coordinator.handle(fromBot('om_stale', responderClaimText('old-bot'), 'ou_old', { createTime: '1789707500000' }), config); await h.participation.flush(scope);
    expect((await h.repository.getDuty(scope)).responder?.appId).toBe('cli_flash');

    await h.coordinator.handle(message('om_plain', '今天下午三点发版'), config); await h.participation.flush(scope);
    await h.coordinator.handle(fromBot('om_alarm_1', '【P1】订单服务错误率 12% 超过阈值', 'ou_alarm'), config); await h.participation.flush(scope);
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.runtime.send).not.toHaveBeenCalled();
    expect((await h.repository.listDecisions(scope)).find(item => ruleOf(item) === 'not_responder')).toMatchObject({ action: 'silent' });
    expect(await alarmRecords(h)).toEqual({ om_alarm_1: ['silent', 'suppressed', 'not_responder'] });
    expect(await h.participation.describe(scope)).toContain('**接话人**：bdev-flash，没 @ 机器人的消息由它接，我只接 @ 和自己接手的话题');

    await h.coordinator.handle(atBot('om_at', '帮我看下发布单'), config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    await h.coordinator.handle(fromBot('om_release', responderReleaseText('bdev-flash'), 'ou_flash'), config); await h.participation.flush(scope);
    expect((await h.repository.getDuty(scope)).responder).toBeUndefined();
  });

  it('@ 它说「你来接话」：确认卡确认后记成接话人并在群里声明；点名别的机器人时不发卡', async () => {
    const h = await harness('selective', { canOperate: async (_scope, operator, requester) => operator === requester });
    await h.coordinator.initializeWorkflows(config);
    Object.assign(h.service, { listChatMembers: members(3, bots) });
    await h.coordinator.handle(atBot('om_resp', '你来接话'), config);
    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledOnce());
    expect(h.service.reply).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_resp', statusLabel: '待确认',
      elements: expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining('由我（cli_test）接本群没 @ 机器人的消息') })]) }));
    const confirmId = (await h.repository.listActions(scope)).find(item => item.kind === 'confirm.group_responder')!.id;
    expect(await h.coordinator.handleAction({ dutydeck_confirm: 'confirm', confirm_id: confirmId, chat_id: scope.chatId }, 'ou_a', { messageId: 'om_card', chatId: scope.chatId }))
      .toMatchObject({ type: 'success', content: expect.stringContaining('已在群里发了声明') });
    expect((await h.repository.getDuty(scope)).responder).toMatchObject({ appId: scope.appId, name: 'cli_test' });
    expect(h.service.replyText).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_resp', text: responderClaimText('cli_test') }));
    // 已经是接话人时再说一次：直接回一条声明（之前没发出去或别的实例错过时能补上），不再发卡。
    await h.coordinator.handle(atBot('om_resp_again', '你来接话'), config);
    await vi.waitFor(() => expect(h.service.replyText).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_resp_again', text: responderClaimText('cli_test') })));

    // 成为接话人后，多机器人群里没 @ 的消息照常走判定。
    await h.coordinator.handle(message('om_q', '这个报错大家见过吗'), config); await h.participation.flush(scope);
    expect(h.decide).toHaveBeenCalledOnce();
    // 没 @ 任何机器人地点名 flash：本机器人不发卡也不出声。
    await h.coordinator.handle(message('om_flash', '这个群由 flash 负责接话'), config); await h.participation.flush(scope);
    expect(h.service.reply).toHaveBeenCalledOnce();
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.runtime.send).not.toHaveBeenCalled();
  });

  const levelCards = async (h: Awaited<ReturnType<typeof harness>>) => (await h.repository.listActions(scope)).filter(item => item.kind === 'confirm.participation_level');
  const confirmCard = (h: Awaited<ReturnType<typeof harness>>, id: string) =>
    h.coordinator.handleAction({ dutydeck_confirm: 'confirm', confirm_id: id, chat_id: scope.chatId }, 'ou_a', { messageId: 'om_card', chatId: scope.chatId });
  const cardText = (h: Awaited<ReturnType<typeof harness>>, call: number) => JSON.stringify(h.service.reply.mock.calls[call]);

  it('多机器人群没有接话人时调到积极：卡上写明由我接，确认后调档并发接话人声明', async () => {
    const applyLevel = vi.fn(async () => {});
    const h = await harness('selective', { applyLevel, canOperate: async (_scope, operator, requester) => operator === requester });
    await h.coordinator.initializeWorkflows(config);
    Object.assign(h.service, { listChatMembers: members(3, bots) });
    await h.coordinator.handle(atBot('om_level', '积极点'), config);
    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledOnce());
    expect(cardText(h, 0)).toContain('本群有多个机器人，确认后由我负责接没 @ 的消息，并在群里发接话人声明。');
    const [card] = await levelCards(h);
    expect(await confirmCard(h, card!.id)).toMatchObject({ type: 'success', content: expect.stringContaining('没 @ 机器人的消息由我接，已在群里发了接话人声明') });
    expect(applyLevel).toHaveBeenCalledExactlyOnceWith(scope, 'eager', 'ou_a');
    expect((await h.repository.getDuty(scope)).responder).toMatchObject({ appId: scope.appId, name: 'cli_test' });
    expect(h.service.replyText).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_level', text: responderClaimText('cli_test') }));
  });

  it('调档时群里已有别的接话人就不抢：发卡后别人先声明的，确认时也不抢', async () => {
    const applyLevel = vi.fn(async () => {});
    const h = await harness('selective', { applyLevel, canOperate: async (_scope, operator, requester) => operator === requester });
    await h.coordinator.initializeWorkflows(config);
    Object.assign(h.service, { listChatMembers: members(3, bots), getMessage: details({ om_claim: 'cli_flash' }) });
    await h.coordinator.handle(atBot('om_level', '积极点'), config);
    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledOnce());
    await h.coordinator.handle(fromBot('om_claim', responderClaimText('bdev-flash'), 'ou_flash', { createTime: String(Date.now()) }), config);
    expect(await confirmCard(h, (await levelCards(h))[0]!.id)).toMatchObject({ type: 'success', content: expect.stringContaining('发卡后「bdev-flash」已成为本群接话人，没 @ 的消息仍由它接') });
    expect(applyLevel).toHaveBeenCalledOnce();
    expect((await h.repository.getDuty(scope)).responder?.appId).toBe('cli_flash');
    expect(h.service.replyText).not.toHaveBeenCalled();

    await h.coordinator.handle(atBot('om_level_2', '积极点'), config);
    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledTimes(2));
    expect(cardText(h, 1)).toContain('本群接话人是「bdev-flash」，没 @ 的消息仍由它接；要改由我接，@我 说「你负责接话」。');
    expect((await levelCards(h)).map(item => (item.payload as { payload: Record<string, unknown> }).payload)).toContainEqual({ level: 'eager' });
  });

  it('本 Bot 是接话人时调到只在 @ 时：卡上写明会卸任，确认后调档并发卸任声明', async () => {
    const applyLevel = vi.fn(async () => {});
    const h = await harness('selective', { applyLevel, canOperate: async (_scope, operator, requester) => operator === requester });
    await h.coordinator.initializeWorkflows(config);
    Object.assign(h.service, { listChatMembers: members(3, bots) });
    await h.repository.updateDuty(scope, { expectedRevision: 0, responder: { appId: scope.appId, name: 'cli_test', since: new Date().toISOString() } }, 'owner');
    await h.coordinator.handle(atBot('om_quiet', '只在@时回'), config);
    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledOnce());
    expect(cardText(h, 0)).toContain('我现在是本群接话人，确认后在群里发卸任声明，没 @ 的消息不再由我接。');
    expect(await confirmCard(h, (await levelCards(h))[0]!.id)).toMatchObject({ type: 'success', content: expect.stringContaining('我不再接没 @ 机器人的消息，已在群里发了卸任声明') });
    expect(applyLevel).toHaveBeenCalledExactlyOnceWith(scope, 'mention', 'ou_a');
    expect((await h.repository.getDuty(scope)).responder).toBeUndefined();
    expect(h.service.replyText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ messageId: 'om_quiet', text: responderReleaseText('cli_test') }));
  });

  const responderCard = async (h: Awaited<ReturnType<typeof harness>>) => (await h.repository.listActions(scope)).find(item => item.kind === 'confirm.group_responder')!;

  it('只在 @ 时的 Bot 被说「你来接话」：卡上写明先调到按需，确认后先调档再认领并发声明', async () => {
    const applyLevel = vi.fn(async () => {});
    const h = await harness('off', { applyLevel, canOperate: async (_scope, operator, requester) => operator === requester });
    await h.coordinator.initializeWorkflows(config);
    Object.assign(h.service, { listChatMembers: members(3, bots) });
    await h.coordinator.handle(atBot('om_resp', '你来接话'), config);
    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledOnce());
    expect(cardText(h, 0)).toContain('我现在只在 @ 时回复，确认后调到「按需」并负责接话：由我（cli_test）接本群没 @ 机器人的消息。');
    expect(await confirmCard(h, (await responderCard(h)).id)).toMatchObject({ type: 'success',
      content: expect.stringMatching(/^本群已改成「按需」：.+。本群没 @ 机器人的消息改由我接。已在群里发了声明/) });
    expect(applyLevel).toHaveBeenCalledExactlyOnceWith(scope, 'selective', 'ou_a');
    expect((await h.repository.getDuty(scope)).responder).toMatchObject({ appId: scope.appId });
    expect(h.service.replyText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ messageId: 'om_resp', text: responderClaimText('cli_test') }));
    expect(applyLevel.mock.invocationCallOrder[0]).toBeLessThan(h.service.replyText.mock.invocationCallOrder[0]!);
  });

  it('调档失败时整张卡不生效：不记接话人、不发声明', async () => {
    const applyLevel = vi.fn(async () => { throw new RuntimeError('LARK_CONFIG_WRITE_FAILED', '写入群配置失败', 500); });
    const h = await harness('off', { applyLevel, canOperate: async (_scope, operator, requester) => operator === requester });
    await h.coordinator.initializeWorkflows(config);
    await h.coordinator.handle(atBot('om_resp', '你来接话'), config);
    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledOnce());
    expect(await confirmCard(h, (await responderCard(h)).id)).toEqual({ type: 'error', content: '没有改成：写入群配置失败' });
    expect((await h.repository.getDuty(scope)).responder).toBeUndefined();
    expect(h.service.replyText).not.toHaveBeenCalled();
  });

  it('Web 把只在 @ 时的 Bot 设成接话人：接口拒绝并说明先调参与模式，不替人调档、不发声明；清掉接话人照常', async () => {
    const applyLevel = vi.fn(async () => {});
    const h = await harness('off', { applyLevel });
    await expect(h.participation.updateDuty(scope, { expectedRevision: 0, responder: 'self' }, 'owner')).rejects.toMatchObject({ code: 'COLLABORATION_RESPONDER_NOT_LISTENING', statusCode: 409,
      message: '本 Bot 在这个群现在是「只在 @ 时」，收不到没 @ 的消息，当不了接话人。请先在上面的参与模式里选「按需参与」或「积极参与」并保存设置，再把接话人设成本 Bot。' });
    expect(applyLevel).not.toHaveBeenCalled();
    expect(h.service.sendText).not.toHaveBeenCalled();
    expect((await h.repository.getDuty(scope)).revision).toBe(0);
    expect(await h.participation.updateDuty(scope, { expectedRevision: 0, responder: null }, 'owner')).toMatchObject({ duty: { revision: 1 } });
  });

  it('本 Bot 已经是按需或积极时照旧：卡上不提调档，确认后不调档；Web 设成本 Bot 照常声明', async () => {
    for (const mode of ['selective', 'eager'] as const) {
      const applyLevel = vi.fn(async () => {});
      const h = await harness(mode, { applyLevel, canOperate: async (_scope, operator, requester) => operator === requester });
      await h.coordinator.initializeWorkflows(config);
      Object.assign(h.service, { listChatMembers: members(3, bots) });
      await h.coordinator.handle(atBot('om_resp', '你来接话'), config);
      await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledOnce());
      expect(cardText(h, 0)).toContain('由我（cli_test）接本群没 @ 机器人的消息');
      expect(cardText(h, 0)).not.toContain('确认后调到');
      expect(await confirmCard(h, (await responderCard(h)).id)).toMatchObject({ type: 'success', content: expect.stringMatching(/^本群没 @ 机器人的消息改由我接。/) });
      expect(applyLevel).not.toHaveBeenCalled();
      expect((await h.repository.getDuty(scope)).responder).toMatchObject({ appId: scope.appId });
      expect(await h.participation.updateDuty(scope, { expectedRevision: 1, responder: null }, 'owner')).toMatchObject({ announced: true });
      expect(await h.participation.updateDuty(scope, { expectedRevision: 2, responder: 'self' }, 'owner')).toMatchObject({ announced: true, duty: { responder: { appId: scope.appId } } });
    }
  });

  it('Web 改分工：设成本 Bot 或清掉时在群里声明；没在群里确认过的订阅不能开启，改来源沿用原确认人', async () => {
    const h = await harness('selective');
    const alarm = { enabled: true, sources: [alarmSource], levels: [], dedupeHours: 6, maxPerHour: 3 };
    await expect(h.participation.updateDuty(scope, { expectedRevision: 0, alarm }, 'owner')).rejects.toMatchObject({ code: 'COLLABORATION_ALARM_REQUESTER_REQUIRED', statusCode: 409 });
    const claimed = await h.participation.updateDuty(scope, { expectedRevision: 0, responder: 'self' }, 'owner');
    expect(claimed).toMatchObject({ announced: true, duty: { revision: 1, responder: { appId: scope.appId, name: 'cli_test' } } });
    expect(h.service.sendText).toHaveBeenCalledWith(expect.objectContaining({ chatId: scope.chatId, text: responderClaimText('cli_test') }));
    await expect(h.participation.updateDuty(scope, { expectedRevision: 0, responder: null }, 'owner')).rejects.toMatchObject({ code: 'COLLABORATION_REVISION_CONFLICT' });
    // 已经是本 Bot 时再存一次不重复声明。
    expect(await h.participation.updateDuty(scope, { expectedRevision: 1, responder: 'self' }, 'owner')).not.toHaveProperty('announced');

    await h.repository.updateDuty(scope, { expectedRevision: 2, alarm: { ...alarm, requesterId: 'ou_admin' } }, 'ou_admin');
    const edited = await h.participation.updateDuty(scope, { expectedRevision: 3, alarm: { ...alarm, levels: ['P0'] } }, 'owner');
    expect(edited.duty.alarm).toEqual({ ...alarm, levels: ['P0'], requesterId: 'ou_admin' });
    const released = await h.participation.updateDuty(scope, { expectedRevision: 4, responder: null }, 'owner');
    expect(released).toMatchObject({ announced: true });
    expect(released.duty.responder).toBeUndefined();
    expect(h.service.sendText).toHaveBeenLastCalledWith(expect.objectContaining({ text: responderReleaseText('cli_test') }));
    expect(h.service.sendText).toHaveBeenCalledTimes(2);
  });

  it('在自己接手的话题里没 @ 的追问照常接；别的机器人的话题不接', async () => {
    const run = async (ownsTopic: boolean) => {
      const h = await harness('selective');
      Object.assign(h.service, { listChatMembers: members(3, bots), getMessage: details({ om_alarm_1: 'cli_alarm' }) });
      const groupManager = { resolved: async (current: StoredLarkConfig) => ({ ...current, mentionPolicy: 'topic' as const }), ownsTopic: vi.fn(async () => ownsTopic),
        authorize: async () => ({ allowed: true }), hasActiveSession: async () => false, highRiskOpenIds: async () => [], recordRun: async () => {} };
      const coordinator = new LarkMessageCoordinator(h.runtime as any, h.service as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, Math.random, 'ou_bot', undefined, undefined,
        async () => 'group', undefined, groupManager as any, { participation: h.participation });
      cleanups.push(() => coordinator.stop());
      h.participation.setDispatcher(scope.appId, (event, current) => coordinator.adopt(event, current));
      await coordinator.handle(message('om_follow', '那要不要回滚', { threadId: 'omt_alarm', rootId: 'om_alarm_1', parentId: 'om_alarm_1' }), config); await h.participation.flush(scope);
      expect(h.decide).not.toHaveBeenCalled();
      return { h, decisions: (await h.repository.listDecisions(scope)).map(item => [item.action, ruleOf(item)]) };
    };
    const owner = await run(true);
    expect(owner.decisions).toEqual([['act', 'owned_topic']]);
    await vi.waitFor(() => expect(owner.h.runtime.send).toHaveBeenCalledOnce());
    const other = await run(false);
    expect(other.decisions).toEqual([['silent', 'topic_of_other']]);
    expect(other.h.runtime.send).not.toHaveBeenCalled();
  });
});

describe('角色在群参与的实时判定接线', () => {
  const bots = [{ name: 'bdev-flash', appId: 'cli_flash' }, { name: 'Bot', appId: scope.appId }];
  const members = (humans: number, botList: Array<{ name: string; appId: string }> = [bots[1]!]) => vi.fn(async () => ({ items: [
    ...Array.from({ length: humans }, (_, i) => ({ memberId: `ou_${i}`, memberType: 'user' as const, name: `用户${i}` })),
    ...botList.map(bot => ({ memberId: bot.appId, memberType: 'bot' as const, name: bot.name, appId: bot.appId }))], hasMore: false, securityLimited: false }));
  const roleConfig: StoredLarkConfig = {
    ...config,
    roleTitle: '告警值班',
    roleScope: '报警和告警排查'
  };

  it('有 scope 时多 Bot、别的接话人、单人 eager 均绕过规则进入 decider，元数据记录当时的 role', async () => {
    let currentConfig = roleConfig;
    const h = await harness('selective', { readConfig: async () => currentConfig });
    Object.assign(h.service, { listChatMembers: members(3, bots) });

    // 1. 多 Bot 未指定接话人：无 scope 时会判 no_responder，有 scope 时绕过规则进入 decider
    await h.coordinator.handle(message('om_multi', '线上告警排查一下'), currentConfig);
    await h.participation.flush(scope);
    expect(h.decide).toHaveBeenCalledOnce();
    const dec1 = (await h.repository.listDecisions(scope)).find(d => deciderMetaOf(d)?.trigger?.messageId === 'om_multi');
    expect(deciderMetaOf(dec1!)!).toMatchObject({
      kind: 'model',
      roleTitle: '告警值班',
      roleScope: '报警和告警排查'
    });

    // 2. 接话人是别人：更新 duty.responder 为 cli_flash，无 scope 会判 not_responder，有 scope 时进入 decider
    await h.repository.updateDuty(scope, { expectedRevision: 0, responder: { appId: 'cli_flash', name: 'bdev-flash', since: new Date().toISOString() } }, 'owner');
    await h.coordinator.handle(message('om_other_resp', '又一个报错看一下'), currentConfig);
    await h.participation.flush(scope);
    expect(h.decide).toHaveBeenCalledTimes(2);
    const dec2 = (await h.repository.listDecisions(scope)).find(d => deciderMetaOf(d)?.trigger?.messageId === 'om_other_resp');
    expect(deciderMetaOf(dec2!)!).toMatchObject({
      kind: 'model',
      roleTitle: '告警值班',
      roleScope: '报警和告警排查'
    });

    // 3. 单人 eager：改成 eager 模式，单人群；无 scope 会直接判 eager_default 为 act，有 scope 时进入 decider
    await h.repository.updateSettings(scope, { expectedRevision: 1, participation: 'eager' }, 'owner');
    Object.assign(h.service, { listChatMembers: members(1) });
    await h.coordinator.handle(message('om_single_eager', '单人闲聊'), currentConfig);
    await h.participation.flush(scope);
    expect(h.decide).toHaveBeenCalledTimes(3);

    // 4. 配置变化后新判定记录反映新 role，旧记录保持不变
    currentConfig = { ...config, roleTitle: '普通助手' }; // 去掉 roleScope
    await h.coordinator.handle(message('om_plain_single', '单人闲聊2'), currentConfig);
    await h.participation.flush(scope);
    const decisions = await h.repository.listDecisions(scope);
    const decOld = decisions.find(d => deciderMetaOf(d)?.roleScope === '报警和告警排查');
    expect(decOld).toBeDefined();
    expect(deciderMetaOf(decOld!)?.roleTitle).toBe('告警值班');
    const decNew = decisions.find(d => (d.inputSnapshot as any)?.observations?.some((o: any) => o.messageId === 'om_plain_single'));
    expect(deciderMetaOf(decNew!)?.roleScope).toBeUndefined();
    expect(deciderMetaOf(decNew!)?.roleTitle).toBe('普通助手');
  });

  it('有 scope 时明确规则仍保持生效：@他人 与 别人的话题 保持 silent，规则元数据记录当时的 role', async () => {
    const h = await harness('selective', { readConfig: async () => roleConfig });
    Object.assign(h.service, { listChatMembers: members(3, bots) });

    // 1. @ 他人
    const mentionOtherEvent = message('om_mention_other', '@_user_2 你看下', {
      mentions: [{ key: '@_user_2', name: '小李', openId: 'ou_other' }]
    });
    await h.coordinator.handle(mentionOtherEvent, roleConfig);
    await h.participation.flush(scope);
    expect(h.decide).not.toHaveBeenCalled();
    const decMention = (await h.repository.listDecisions(scope))[0]!;
    expect(deciderMetaOf(decMention)!).toMatchObject({
      kind: 'rule',
      rule: 'mentions_other',
      roleTitle: '告警值班',
      roleScope: '报警和告警排查'
    });
    expect(decMention.action).toBe('silent');

    // 2. 别人的话题 (threadRootOther)
    const threadOtherEvent = message('om_thread_other', '继续讨论', {
      threadId: 'omt_other_root',
      rootId: 'om_other_root',
      parentId: 'om_other_root'
    });
    h.service.listChatMessages.mockResolvedValueOnce({ items: [], hasMore: false });
    Object.assign(h.service, {
      getMessage: vi.fn(async (id: string) => ({
        messageId: id,
        chatId: scope.chatId,
        messageType: 'text',
        createTime: '1789707600000',
        rawContent: '{}',
        sender: { id: 'cli_flash', idType: 'app_id', type: 'app' },
        mentions: [],
        deleted: false,
        updated: false
      }))
    });
    await h.coordinator.handle(threadOtherEvent, roleConfig);
    await h.participation.flush(scope);
    expect(h.decide).not.toHaveBeenCalled();
    const decThread = (await h.repository.listDecisions(scope)).find(d => deciderMetaOf(d)?.rule === 'topic_of_other')!;
    expect(decThread).toBeDefined();
    expect(deciderMetaOf(decThread)!).toMatchObject({
      kind: 'rule',
      rule: 'topic_of_other',
      roleTitle: '告警值班',
      roleScope: '报警和告警排查'
    });
    expect(decThread.action).toBe('silent');
  });
});

describe('角色注入与 /status 展示', () => {
  const atBot = (id: string, text: string, patch: Partial<LarkMessageEvent> = {}) =>
    message(id, `@_user_1 ${text}`, { mentions: [{ key: '@_user_1', name: 'Bot', openId: 'ou_bot' }], ...patch });
  const roleConfig: StoredLarkConfig = { ...config, roleTitle: '告警值班', roleScope: '报警和告警排查、服务异常定位',
    preInjectPrompt: '排查告警要给出确定的根因和影响，不要停在现象' };
  const dispatchPrompt = (h: Awaited<ReturnType<typeof harness>>) =>
    String(h.runtime.send.mock.calls[0]!.find(arg => typeof arg === 'string' && arg.includes('[Dutydeck')));

  it('执行 prompt 里角色在群长期指令前，群长期指令在做法（预注入 Prompt）前，且包含授权不改变说明', async () => {
    const h = await harness('observe');
    await h.repository.updateSettings(scope, { expectedRevision: 1, instructions: '群里讨论用中文' }, 'owner');
    await h.coordinator.handle(message('om_role', '@_user_1 看下这个报警', { mentions: [{ key: '@_user_1', name: 'Bot', openId: 'ou_bot' }] }), roleConfig);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    const prompt = dispatchPrompt(h);
    const roleAt = prompt.indexOf('[Dutydeck 角色 · 管理者配置]');
    const instructionsAt = prompt.indexOf('[Dutydeck 群长期指令 · 管理者配置]');
    const practiceAt = prompt.indexOf('[Dutydeck 预注入 Prompt]');
    expect(roleAt).toBeGreaterThanOrEqual(0);
    expect(instructionsAt).toBeGreaterThan(roleAt);
    expect(practiceAt).toBeGreaterThan(instructionsAt);
    expect(prompt).toContain('你在群里的角色是「告警值班」，负责：报警和告警排查、服务异常定位');
    expect(prompt).toContain('明确向你派发的任务即使在负责范围外也照常处理，角色不改变现有权限。');
    expect(prompt).toContain('[Dutydeck 群长期指令 · 管理者配置]\n群里讨论用中文');
    expect(prompt).toContain('[Dutydeck 预注入 Prompt]\n排查告警要给出确定的根因和影响，不要停在现象');
  });

  it('@ 它做负责范围外的事也照常派发执行，角色不拦截、不拒绝', async () => {
    const h = await harness('observe');
    await h.coordinator.handle(message('om_outside', '@_user_1 帮我订个明天的会议室', { mentions: [{ key: '@_user_1', name: 'Bot', openId: 'ou_bot' }] }), roleConfig);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    const prompt = dispatchPrompt(h);
    expect(prompt).toContain('[Dutydeck 角色 · 管理者配置]');
    expect(prompt).toContain('帮我订个明天的会议室');
    expect(prompt).not.toContain('不在我负责');
  });

  it('/status 在参与行前显示角色；没有角色时不显示角色行', async () => {
    const h = await harness();
    h.options.readConfig = vi.fn(async () => roleConfig);
    const withRole = await h.participation.describe(scope);
    expect(withRole.split('\n\n')[0]).toBe('**角色**：告警值班，负责：报警和告警排查、服务异常定位');
    expect(withRole).toContain('\n\n**参与**：');

    h.options.readConfig = vi.fn(async () => config);
    const withoutRole = await h.participation.describe(scope);
    expect(withoutRole.startsWith('**参与**：')).toBe(true);
    expect(withoutRole).not.toContain('**角色**');
  });

  it('有 scope 时确认卡与成功回复说明范围接话；无 scope 和 title-only 保留原 behavior', async () => {
    const applyLevel = vi.fn(async () => {});
    const h = await harness('selective', { applyLevel, canOperate: async (_scope, operator, requester) => operator === requester });
    h.options.readConfig = vi.fn(async () => roleConfig);
    await h.coordinator.initializeWorkflows(roleConfig);
    await h.coordinator.handle(atBot('om_eager', '积极点'), roleConfig);
    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledOnce());
    const cardContent = JSON.stringify(h.service.reply.mock.calls[0]);
    expect(cardContent).toContain('明确叫我、或负责范围内需要处理的消息我才会接；范围外请 @我');
    expect(cardContent).not.toContain('群里真人的消息我都接');

    const [card] = (await h.repository.listActions(scope)).filter(item => item.kind === 'confirm.participation_level');
    const result = await h.coordinator.handleAction({ dutydeck_confirm: 'confirm', confirm_id: card!.id, chat_id: scope.chatId }, 'ou_a', { messageId: 'om_card', chatId: scope.chatId });
    expect(result).toMatchObject({ type: 'success', content: expect.stringContaining('明确叫我、或负责范围内需要处理的消息我才会接；范围外请 @我') });

    // title-only 与无 scope 保持旧文案
    const titleOnlyConfig = { ...config, roleTitle: '普通助手' };
    h.options.readConfig = vi.fn(async () => titleOnlyConfig);
    await h.coordinator.handle(atBot('om_title_eager', '积极点'), titleOnlyConfig);
    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledTimes(2));
    const titleCardContent = JSON.stringify(h.service.reply.mock.calls[1]);
    expect(titleCardContent).toContain('除了明显是对别人说的、表情和致谢，群里真人的消息我都接，适合单人群');
  });

  it('taskContext 在有 scope 时使用角色描述，不向执行注入全接承诺；无 scope 保留旧文案', async () => {
    const h = await harness('eager');
    h.options.readConfig = vi.fn(async () => roleConfig);
    const contextWithRole = await h.participation.taskContext(scope);
    expect(contextWithRole?.text).toContain('明确叫我、或负责范围内需要处理的消息我才会接；范围外请 @我');
    expect(contextWithRole?.text).not.toContain('群里真人的消息我都接');

    h.options.readConfig = vi.fn(async () => config);
    const contextWithoutRole = await h.participation.taskContext(scope);
    expect(contextWithoutRole?.text).toContain('除了明显是对别人说的、表情和致谢，群里真人的消息我都接，适合单人群');
  });

  it('dutyLines 和改档 note 在有 scope 且接话人是别人或多 Bot 未指定时，不作「先不接」或「只接@」绝对承诺', async () => {
    const applyLevel = vi.fn(async () => {});
    const h = await harness('selective', { applyLevel, canOperate: async (_scope, operator, requester) => operator === requester });
    const bots = [{ name: 'bdev-flash', appId: 'cli_flash' }, { name: 'Bot', appId: scope.appId }];
    const membersMock = vi.fn(async () => ({ items: [
      { memberId: 'ou_1', memberType: 'user' as const, name: '用户1' },
      ...bots.map(bot => ({ memberId: bot.appId, memberType: 'bot' as const, name: bot.name, appId: bot.appId }))
    ], hasMore: false, securityLimited: false }));
    Object.assign(h.service, { listChatMembers: membersMock });
    h.options.readConfig = vi.fn(async () => roleConfig);

    // 1. 多 Bot 未指定接话人
    const descUnassigned = await h.participation.describe(scope);
    expect(descUnassigned).toContain('我仍按负责范围判断未明确叫我的消息，明确叫我照常处理');
    expect(descUnassigned).toContain('要将接话人设为我');
    expect(descUnassigned).toContain('我负责的范围不变');
    expect(descUnassigned).not.toContain('要我全面接话');
    expect(descUnassigned).not.toContain('没 @ 的消息我先不接');

    // 2. 接话人是别人
    await h.repository.updateDuty(scope, { expectedRevision: 0, responder: { appId: 'cli_flash', name: 'bdev-flash', since: new Date().toISOString() } }, 'owner');
    const descOther = await h.participation.describe(scope);
    expect(descOther).toContain('**接话人**：bdev-flash，没 @ 机器人的消息由它接；我仍按负责范围判断未明确叫我的消息，明确叫我照常处理');
    expect(descOther).not.toContain('我只接 @ 和自己接手的话题');

    // 3. 改档 note
    await h.coordinator.initializeWorkflows(roleConfig);
    await h.coordinator.handle(atBot('om_note_test', '积极点'), roleConfig);
    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalled());
    const noteCardContent = JSON.stringify(h.service.reply.mock.calls);
    expect(noteCardContent).toContain('没 @ 的消息仍由它接，但我仍按负责范围接话');
    expect(noteCardContent).toContain('要将接话人设为我');
    expect(noteCardContent).toContain('我负责的范围不变');
    expect(noteCardContent).not.toContain('要改由我全面接话');

    // 4. 无 scope 时旧文案保持
    h.options.readConfig = vi.fn(async () => config);
    const descWithoutRole = await h.participation.describe(scope);
    expect(descWithoutRole).toContain('**接话人**：bdev-flash，没 @ 机器人的消息由它接，我只接 @ 和自己接手的话题');
  });

  it('有 scope 时本 Bot 已是接话人，/status 与认领确认卡/成功回执不无条件声称全接；无 scope 保留原文案', async () => {
    // 有 scope：本 Bot 已是接话人
    const h = await harness('selective', { canOperate: async (_scope, operator, requester) => operator === requester });
    h.options.readConfig = vi.fn(async () => roleConfig);
    await h.repository.updateDuty(scope, { expectedRevision: 0, responder: { appId: scope.appId, name: 'cli_test', since: new Date().toISOString() } }, 'owner');
    const descSelf = await h.participation.describe(scope);
    expect(descSelf).toContain('**接话人**：我。没 @ 机器人的消息由我按负责范围判断是否接，明确叫我照常处理');
    expect(descSelf).not.toContain('本群没 @ 机器人的消息由我接');

    // 认领确认卡 summary 与确认成功回执：有 scope 时按范围措辞
    await h.coordinator.initializeWorkflows(roleConfig);
    Object.assign(h.service, { listChatMembers: vi.fn(async () => ({ items: [
      { memberId: 'ou_1', memberType: 'user' as const, name: '用户1' },
      { memberId: 'cli_flash', memberType: 'bot' as const, name: 'bdev-flash', appId: 'cli_flash' },
      { memberId: scope.appId, memberType: 'bot' as const, name: 'cli_test', appId: scope.appId }
    ], hasMore: false, securityLimited: false })) });
    // 先清掉接话人，让「你来接话」发认领确认卡
    await h.repository.updateDuty(scope, { expectedRevision: 1, responder: null }, 'owner');
    await h.coordinator.handle(atBot('om_claim', '你来接话'), roleConfig);
    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledOnce());
    const claimCard = JSON.stringify(h.service.reply.mock.calls[0]);
    expect(claimCard).toContain('由我（cli_test）按负责范围判断接本群没 @ 机器人的消息，明确叫我照常处理。');
    expect(claimCard).not.toContain('由我（cli_test）接本群没 @ 机器人的消息。');
    const confirmId = (await h.repository.listActions(scope)).find(item => item.kind === 'confirm.group_responder')!.id;
    const confirmed = await h.coordinator.handleAction({ dutydeck_confirm: 'confirm', confirm_id: confirmId, chat_id: scope.chatId }, 'ou_a', { messageId: 'om_card', chatId: scope.chatId });
    expect(confirmed).toMatchObject({ type: 'success', content: expect.stringContaining('本群没 @ 机器人的消息改由我按负责范围判断是否接，明确叫我照常处理。') });
    expect(String((confirmed as any).content)).not.toContain('本群没 @ 机器人的消息改由我接。');

    // 无 scope：认领卡与成功回执保留原文案
    const h2 = await harness('selective', { canOperate: async (_scope, operator, requester) => operator === requester });
    await h2.coordinator.initializeWorkflows(config);
    Object.assign(h2.service, { listChatMembers: vi.fn(async () => ({ items: [
      { memberId: 'ou_1', memberType: 'user' as const, name: '用户1' },
      { memberId: 'cli_flash', memberType: 'bot' as const, name: 'bdev-flash', appId: 'cli_flash' },
      { memberId: scope.appId, memberType: 'bot' as const, name: 'cli_test', appId: scope.appId }
    ], hasMore: false, securityLimited: false })) });
    await h2.coordinator.handle(atBot('om_claim2', '你来接话'), config);
    await vi.waitFor(() => expect(h2.service.reply).toHaveBeenCalledOnce());
    expect(JSON.stringify(h2.service.reply.mock.calls[0])).toContain('由我（cli_test）接本群没 @ 机器人的消息。');
    const confirmId2 = (await h2.repository.listActions(scope)).find(item => item.kind === 'confirm.group_responder')!.id;
    await expect(h2.coordinator.handleAction({ dutydeck_confirm: 'confirm', confirm_id: confirmId2, chat_id: scope.chatId }, 'ou_a', { messageId: 'om_card', chatId: scope.chatId }))
      .resolves.toMatchObject({ type: 'success', content: expect.stringContaining('本群没 @ 机器人的消息改由我接。') });
    // 无 scope 时本 Bot 是接话人的 /status 原文案
    await h2.repository.updateDuty(scope, { expectedRevision: (await h2.repository.getDuty(scope)).revision, responder: { appId: scope.appId, name: 'cli_test', since: new Date().toISOString() } }, 'owner');
    expect(await h2.participation.describe(scope)).toContain('**接话人**：我，本群没 @ 机器人的消息由我接');
  });
});
