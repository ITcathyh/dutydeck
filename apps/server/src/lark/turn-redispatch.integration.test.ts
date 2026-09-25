import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import type { AgentConfig, DriverFactory, NormalizedDriverEvent } from '@dutydeck/shared';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import { LarkMessageCoordinator, type PersistedLarkCardTask } from './coordinator.js';
import type { LarkMessageEvent } from './listener.js';
import { buildLarkCard } from './service.js';

/**
 * 服务重启切断的一轮自动重投（真实 Runtime + SQLite，按守护进程重启的顺序关停再打开）。
 *
 * 假 Agent：hang 为 true 时一轮一直不结束，直到服务关停；否则直接完成。关停时执行进程确认已停止，
 * 原会话没有资源阻塞，被切断那一轮的原因码是 DAEMON_SHUTDOWN（与 PREVIOUS_RUNTIME_RESULT_UNKNOWN 同样处理）。
 * 执行进程未确认停止（有资源阻塞）的情形由 relaunch-session.integration.test.ts 覆盖：那里不自动重投。
 */

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 600; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('condition not reached');
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const silentLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** 按 idempotencyKey 去重的卡片服务替身；每个进程用不同前缀。 */
function cardService(prefix: string) {
  let issued = 0;
  const byKey = new Map<string, string>();
  const deliver = async (input: any) => {
    const existing = input.idempotencyKey ? byKey.get(input.idempotencyKey) : undefined;
    if (existing) return { messageId: existing };
    const messageId = `${prefix}_card_${++issued}`;
    if (input.idempotencyKey) byKey.set(input.idempotencyKey, messageId);
    return { messageId };
  };
  return {
    addReaction: vi.fn(async () => ({ messageId: 'om_any', reactionId: 'reaction', emojiType: 'OK' })),
    deleteReaction: vi.fn(async () => {}),
    reply: vi.fn(deliver),
    send: vi.fn(deliver),
    update: vi.fn(async (input: any) => ({ messageId: input.messageId })),
    getUserEmails: vi.fn(async () => ['alice@example.com']),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice', memberType: 'user', name: 'Alice' }, { memberId: 'ou_bob', memberType: 'user', name: 'Bob' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [], hasMore: false }))
  };
}

const message = (messageId: string, text: string): LarkMessageEvent => ({
  messageId, chatId: 'oc_group', chatType: 'group', rootId: 'om_root', threadId: 'omt_topic', messageType: 'text',
  content: JSON.stringify({ text: `@_user_1 ${text}` }), senderOpenId: 'ou_alice', senderType: 'user',
  mentions: [{ key: '@_user_1', name: 'Dutydeck', openId: 'ou_bot' }]
});

const callbackValueOf = (card: any, elementId: string) => {
  const found: any[] = [];
  const visit = (node: any) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if (node.element_id === elementId && node.tag === 'button') found.push(node);
    Object.values(node).forEach(visit);
  };
  visit(buildLarkCard(card));
  return found[0]?.behaviors?.find((behavior: any) => behavior.type === 'callback')?.value;
};
const callbackButtonCount = (card: any) => (JSON.stringify(buildLarkCard(card)).match(/"type":"callback"/g) ?? []).length;

/** tools：第一轮在挂起前记下的工具调用。 */
async function interruptedTopic({ tools = [] as NormalizedDriverEvent[] } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-redispatch-'));
  const path = join(cwd, 'state.db');
  const agent: AgentConfig = { id: 'redispatch-fixture', name: 'Fixture', command: 'unused', args: [], protocol: 'acp', cwd, env: {},
    permissionMode: 'full-trust', timeout: 60, capabilities: { pause: false, resume: true }, builtin: false };
  const config: StoredLarkConfig = { appId: 'app', appSecret: 'fixture', workspace: cwd, defaultAgentId: agent.id,
    fullTrustConfirmed: true, listening: true, preInjectPrompt: '', structuredAskCards: false, groupCardMention: false,
    groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 60_000, hideTraceOnComplete: false,
    allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }, { openId: 'ou_bob', name: 'Bob' }], allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
    highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'danger', riskControlMode: 'off' };
  const prompts: Array<{ sessionId: string; prompt: string }> = [];
  const agentState = { hang: true };
  const pending = new Set<() => void>();
  let script = tools;
  const factory: DriverFactory = (_agent, _protocol, emit, _exit, sessionId) => ({
    start: async () => {}, resume: async () => {}, interrupt: async () => {}, isStopped: async () => true,
    stop: async () => { for (const release of pending) release(); pending.clear(); },
    send: async (input: any) => {
      prompts.push({ sessionId, prompt: typeof input === 'string' ? input : input.prompt });
      if (agentState.hang) {
        for (const event of script) emit(event);
        script = [];
        await new Promise<void>(resolve => pending.add(resolve));
        return;
      }
      emit({ type: 'text', data: { text: '已接着做完' } });
      emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    }
  }) as any;
  const probe = () => ({ protocol: 'acp' as const, available: true, pause: false, resume: true });
  type Daemon = { repos: ReturnType<typeof createRepositories>; runtime: DutydeckRuntime; coordinator: LarkMessageCoordinator; service: ReturnType<typeof cardService> };
  let daemon: Daemon | undefined;
  let boots = 0;
  const boot = async (): Promise<Daemon> => {
    const repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
    if (!boots) await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
    const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0, probe, driverFactory: factory });
    await runtime.initialize([agent]);
    const service = cardService(`p${++boots}`);
    const coordinator = new LarkMessageCoordinator(runtime, service as any, silentLog(), Math.random, 'ou_bot',
      undefined, repos.channelMappings, undefined, undefined, undefined, { store: repos.config });
    await coordinator.initializeWorkflows(config);
    return { repos, runtime, coordinator, service };
  };
  const shutdown = async () => {
    if (!daemon) return;
    daemon.coordinator.stop();
    await daemon.runtime.shutdown();
    daemon.repos.close();
    daemon = undefined;
  };
  cleanups.push(async () => { await shutdown(); await rm(cwd, { recursive: true, force: true }); });
  const current = () => daemon!;
  const inbox = async (id = 'om_first') => JSON.parse(await current().repos.config.get(`lark.inbox.app.${id}`) ?? '{}');
  const mapping = async (id = 'om_first') => {
    const row = await current().repos.channelMappings.get('lark-card:app', id);
    return { sessionId: row!.sessionId, saved: JSON.parse(row!.extra!) as PersistedLarkCardTask };
  };
  /** 等这一轮被 runtime 接收：入站记录已受理、卡片映射已记下 runtime 任务。 */
  const accepted = (turn: number) => until(async () => {
    const record = await inbox();
    const row = await current().repos.channelMappings.get('lark-card:app', 'om_first');
    const saved = row?.extra ? JSON.parse(row.extra) as PersistedLarkCardTask : undefined;
    return record.state === 'accepted' && record.turn === turn && saved?.turn === turn && Boolean(saved.runtime_task_id);
  });
  /** 服务重启：关停当前进程再打开，跑一次启动对账。 */
  const restart = async (beforeReconcile?: (daemon: Daemon) => Promise<unknown>) => {
    await shutdown();
    daemon = await boot();
    await beforeReconcile?.(daemon);
    await daemon.coordinator.reconcile(config);
    return daemon;
  };
  /**
   * 重启，并把这一轮在重启前留下的时间（事件时间与开始时间）交给 time 改写，模拟「切断发生在多久以前」；
   * time 返回空串表示取不到。启动时账本补记的事件保持原样。
   */
  const restartAged = async (time: (value: string) => string) => {
    await shutdown();
    const cutAt = Date.now();
    await new Promise(resolve => setTimeout(resolve, 5));
    daemon = await boot();
    const runtime = daemon.runtime;
    const at = (value: string) => Date.parse(value) <= cutAt ? time(value) : value;
    const getEvents = runtime.getEvents.bind(runtime);
    const inspect = runtime.inspectExecutionRecovery.bind(runtime);
    vi.spyOn(runtime, 'getEvents').mockImplementation(async (...args) => (await getEvents(...args)).map(event => ({ ...event, timestamp: at(event.timestamp) })));
    vi.spyOn(runtime, 'inspectExecutionRecovery').mockImplementation(async (...args) => {
      const result = await inspect(...args);
      return { ...result, tasks: result.tasks.map(task => task.attempt ? { ...task, attempt: { ...task.attempt, createdAt: at(task.attempt.createdAt) } } : task) };
    });
    await daemon.coordinator.reconcile(config);
    return daemon;
  };
  const minutesEarlier = (minutes: number) => (value: string) => new Date(Date.parse(value) - minutes * 60_000).toISOString();
  const lastUpdate = (messageId: string) =>
    current().service.update.mock.calls.map(([input]) => input as any).filter(input => input.messageId === messageId).at(-1);
  const tasks = async () => current().runtime.getTasks((await mapping()).sessionId);
  const timelineNotes = async (sessionId: string) => (await current().runtime.getEvents(sessionId))
    .filter(event => event.type === 'text' && (event.data as any)?.source === 'lark_redispatch').map(event => String((event.data as any).text));

  daemon = await boot();
  await daemon.coordinator.handle(message('om_first', '整理本周报警并回复群里'), config);
  await until(() => prompts.length === 1);
  await accepted(1);
  return { config, prompts, agentState, restart, restartAged, minutesEarlier, current, inbox, mapping, accepted, lastUpdate, tasks, timelineNotes };
}

describe('服务重启切断的一轮自动重投（真实 Runtime + SQLite）', () => {
  it('安全的一轮在原会话自动重投一次：prompt 前附说明，旧一轮结果未知、不标失败，重复对账与再次重启都不再重投', async () => {
    const h = await interruptedTopic();
    const { sessionId, saved: before } = await h.mapping();
    const oldCardId = before.card_message_id!;
    const oldTaskId = before.runtime_task_id!;
    h.agentState.hang = false;

    await h.restart();
    await until(() => h.prompts.length === 2);
    const replay = h.prompts[1]!;
    expect(replay.sessionId).toBe(sessionId);
    for (const phrase of ['[Dutydeck 重启恢复 · 系统说明]', '服务重启打断了上一轮', '请从停下处继续', '重复任何对外操作', '第 1/2 次自动重投', '整理本周报警并回复群里']) {
      expect(replay.prompt).toContain(phrase);
    }
    expect(replay.prompt.indexOf('[Dutydeck 重启恢复 · 系统说明]')).toBeLessThan(replay.prompt.indexOf('[用户请求]'));

    // 旧一轮记为结果未知（不是失败），新的一轮在同一会话里跑完。
    await until(async () => (await h.tasks()).some(task => task.id !== oldTaskId && task.status === 'completed'));
    expect((await h.tasks()).map(task => task.status)).toEqual(['reconcile_required', 'completed']);
    expect(await h.current().runtime.getTaskRecovery(sessionId, oldTaskId)).toMatchObject({ status: 'reconcile_required', resolvedUnknown: true });
    expect(h.current().repos.execution.getTaskExecution(oldTaskId)!.currentAttempt).toMatchObject({ state: 'settled', outcome: 'unknown' });

    // 旧卡：结果未知，写明重投次数与去向，没有按钮。新卡带注记，映射与入站记录转到第 2 轮。
    await until(() => h.lastUpdate(oldCardId)?.statusLabel === '结果未知');
    const oldCard = h.lastUpdate(oldCardId);
    expect(oldCard).toMatchObject({ state: 'reconcile_required', readOnly: true, sessionId });
    expect(oldCard.markdown).toContain('已自动重投（第 1/2 次）');
    expect(oldCard.markdown).toContain('在原会话中继续');
    expect(callbackButtonCount(oldCard)).toBe(0);
    expect(h.current().service.reply).toHaveBeenCalledWith(expect.objectContaining({ turn: 2, markdown: expect.stringContaining('第 1/2 次自动重投') }));
    expect(await h.inbox()).toMatchObject({ turn: 2, redispatch: { count: 1, resumed: true, auto: true } });
    expect((await h.mapping()).saved).toMatchObject({ turn: 2, earlier_message_ids: expect.arrayContaining([oldCardId]) });
    expect(await h.timelineNotes(sessionId)).toEqual([expect.stringContaining('已自动重投（第 1/2 次）')]);

    // 再对账、再重启：这一轮已经完成，不会再发第三次。
    await h.current().coordinator.reconcile(h.config);
    await h.restart();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(h.prompts).toHaveLength(2);
  });

  it('原会话续不上（旧一轮记不成结果未知）时改在本话题的新会话里重投，说明改为之前的动作可能已经生效', async () => {
    const h = await interruptedTopic();
    const { sessionId, saved: before } = await h.mapping();
    const oldCardId = before.card_message_id!;
    h.agentState.hang = false;

    await h.restart(async daemon => { vi.spyOn(daemon.runtime, 'confirmExecutionRecovery').mockRejectedValueOnce(new Error('EXECUTION_REVISION_CONFLICT')); });
    await until(() => h.prompts.length === 2);
    const replay = h.prompts[1]!;
    expect(replay.sessionId).not.toBe(sessionId);
    for (const phrase of ['[Dutydeck 重启恢复 · 系统说明]', '原会话无法恢复', '之前的动作可能已经生效', '第 1/2 次自动重投', '整理本周报警并回复群里']) {
      expect(replay.prompt).toContain(phrase);
    }
    expect(replay.prompt).not.toContain('请从停下处继续');
    expect(await h.inbox()).toMatchObject({ turn: 2, sessionId: replay.sessionId, redispatch: { count: 1, resumed: false, auto: true } });
    await until(() => h.lastUpdate(oldCardId)?.statusLabel === '结果未知');
    expect(h.lastUpdate(oldCardId).markdown).toContain('已自动重投（第 1/2 次），原会话无法恢复，已在本话题的新会话中重新执行');
    expect(callbackButtonCount(h.lastUpdate(oldCardId))).toBe(0);
    expect((await h.mapping()).sessionId).toBe(replay.sessionId);
    // 旧一轮没记上，原样留给管理员核对；新会话这一轮照常跑完，之后不再重投。
    expect(await h.current().runtime.getTaskRecovery(sessionId, before.runtime_task_id!)).toMatchObject({ status: 'reconcile_required', resolvedUnknown: false });
    await h.current().coordinator.reconcile(h.config);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(h.prompts).toHaveLength(2);
  });

  it('最后一次活动在 60 分钟内（59 分钟前）照常自动重投', async () => {
    const h = await interruptedTopic({ tools: [{ type: 'tool_call', data: { id: 'call_read', name: 'Read', status: 'completed', input: { file_path: '/work/alerts.md' } } }] });
    h.agentState.hang = false;
    await h.restartAged(h.minutesEarlier(59));
    await until(() => h.prompts.length === 2);
    expect(h.prompts[1]!.prompt).toContain('第 1/2 次自动重投');
    expect(await h.inbox()).toMatchObject({ turn: 2, redispatch: { count: 1, resumed: true, auto: true } });
  });

  it('最后一次活动超过 60 分钟：不自动重投，停在结果未知，说明中断时间较早并给「重新执行」「放弃」；重新执行照常可用', async () => {
    const h = await interruptedTopic({ tools: [{ type: 'tool_call', data: { id: 'call_read', name: 'Read', status: 'completed', input: { file_path: '/work/alerts.md' } } }] });
    h.agentState.hang = false;
    const daemon = await h.restartAged(h.minutesEarlier(61));
    const { sessionId, saved } = await h.mapping();
    const cardId = saved.card_message_id!;
    await until(() => h.lastUpdate(cardId)?.statusLabel === '结果未知');
    await daemon.coordinator.reconcile(h.config);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(h.prompts).toHaveLength(1);
    const card = h.lastUpdate(cardId);
    expect(card).toMatchObject({ state: 'reconcile_required', readOnly: false, capabilities: expect.objectContaining({ canReplay: true }) });
    expect(card.markdown).toContain('中断时间较早，没有自动重投');
    const rendered = JSON.stringify(buildLarkCard(card));
    for (const phrase of ['重新执行', '放弃']) expect(rendered).toContain(phrase);
    expect(await h.timelineNotes(sessionId)).toEqual([expect.stringContaining('中断时间较早，没有自动重投')]);
    expect(JSON.parse(await daemon.repos.config.get('lark.redispatch.app.om_first.1') ?? '{}')).toMatchObject({ phase: 'held', redispatch: { count: 0, stale: 'old' } });

    const value = callbackValueOf(card, 'replay_turn');
    expect(await daemon.coordinator.handleAction(value, 'ou_alice', { messageId: cardId, chatId: 'oc_group' })).toMatchObject({ type: 'success' });
    await until(() => h.prompts.length === 2);
    expect(h.prompts[1]).toMatchObject({ sessionId, prompt: expect.stringContaining('按「重新执行」重投') });
  });

  it('这一轮的时间取不到：按不自动重投处理', async () => {
    const h = await interruptedTopic();
    h.agentState.hang = false;
    const daemon = await h.restartAged(() => '');
    const { saved } = await h.mapping();
    const cardId = saved.card_message_id!;
    await until(() => h.lastUpdate(cardId)?.statusLabel === '结果未知');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(h.prompts).toHaveLength(1);
    expect(h.lastUpdate(cardId).markdown).toContain('无法确认中断时间，没有自动重投');
    expect(h.lastUpdate(cardId).capabilities).toMatchObject({ canReplay: true });
    expect(JSON.parse(await daemon.repos.config.get('lark.redispatch.app.om_first.1') ?? '{}')).toMatchObject({ phase: 'held', redispatch: { stale: 'unknown' } });
  });

  it('每一轮最多自动重投 2 次：第三次被切断时停在结果未知，给「重新执行」「放弃」；放弃之后不再执行', async () => {
    const h = await interruptedTopic();
    await h.restart();
    await until(() => h.prompts.length === 2);
    await h.accepted(2);
    await h.restart();
    await until(() => h.prompts.length === 3);
    await h.accepted(3);
    expect(h.prompts[2]!.prompt).toContain('第 2/2 次自动重投');

    const daemon = await h.restart();
    const { sessionId, saved } = await h.mapping();
    const cardId = saved.card_message_id!;
    await until(() => h.lastUpdate(cardId)?.statusLabel === '结果未知');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(h.prompts).toHaveLength(3);
    const card = h.lastUpdate(cardId);
    expect(card).toMatchObject({ state: 'reconcile_required', readOnly: false, capabilities: expect.objectContaining({ canReplay: true }) });
    expect(card.capabilities.canRelaunch).toBeUndefined();
    expect(card.markdown).toContain('已重投 2 次仍被重启打断，不再自动重投');
    const rendered = JSON.stringify(buildLarkCard(card));
    for (const phrase of ['重新执行', '放弃']) expect(rendered).toContain(phrase);
    expect(await h.timelineNotes(sessionId)).toContainEqual(expect.stringContaining('已重投 2 次仍被重启打断'));
    // 对账反复跑也只停在这里，不会偷偷再投。
    await daemon.coordinator.reconcile(h.config);
    expect(h.prompts).toHaveLength(3);

    const value = callbackValueOf(card, 'abandon_turn');
    expect(value).toEqual({ action: 'abandon_turn', task_id: 'om_first', turn: '3' });
    const context = { messageId: cardId, chatId: 'oc_group' };
    expect(await daemon.coordinator.handleAction(value, 'ou_mallory', context)).toMatchObject({ type: 'warning' });
    expect(await daemon.coordinator.handleAction({ ...value }, 'ou_alice', { messageId: 'om_other_card', chatId: 'oc_group' })).toMatchObject({ type: 'warning', content: expect.stringContaining('已失效') });
    expect(await daemon.coordinator.handleAction(value, 'ou_alice', context)).toMatchObject({ type: 'success', content: expect.stringContaining('已放弃') });
    await until(() => h.lastUpdate(cardId)?.statusLabel === '已放弃');
    expect(callbackButtonCount(h.lastUpdate(cardId))).toBe(0);
    // 放弃把这一轮记为结果未知，原会话照常接后面的消息；对账不再把卡改回去，也不再执行。
    expect(await daemon.runtime.getTaskRecovery(sessionId, saved.runtime_task_id!)).toMatchObject({ status: 'reconcile_required', resolvedUnknown: true });
    await daemon.coordinator.reconcile(h.config);
    expect(h.lastUpdate(cardId)?.statusLabel).toBe('已放弃');
    expect(await daemon.coordinator.handleAction(callbackValueOf(card, 'replay_turn'), 'ou_alice', context)).toMatchObject({ type: 'success', content: expect.stringContaining('已放弃') });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(h.prompts).toHaveLength(3);
  });

  it('执行过 git push 的一轮标为 replay_unsafe、不自动重投；卡上说明原因，「重新执行」走现有鉴权与他人任务二次确认', async () => {
    const h = await interruptedTopic({ tools: [{ type: 'tool_call', data: { id: 'call_push', name: 'Bash', status: 'running',
      input: { command: 'cd /work && git push origin master', description: 'Push' } } }] });
    h.agentState.hang = false;
    const daemon = await h.restart();
    const { sessionId, saved } = await h.mapping();
    const cardId = saved.card_message_id!;
    await until(() => h.lastUpdate(cardId)?.statusLabel === '结果未知');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(h.prompts).toHaveLength(1);
    const card = h.lastUpdate(cardId);
    expect(card.markdown).toContain('这一轮执行过 git push，可能已产生外部副作用，没有自动重投');
    expect(card.markdown).not.toContain('origin master');
    expect(card.capabilities).toMatchObject({ canReplay: true });
    // 旧一轮原样留着：没有被记成失败，也没有被记成结果未知以外的任何东西。
    expect(await daemon.runtime.getTaskRecovery(sessionId, saved.runtime_task_id!)).toMatchObject({ status: 'reconcile_required', resolvedUnknown: false });
    expect(await h.timelineNotes(sessionId)).toEqual([expect.stringContaining('执行过 git push')]);
    const redispatch = JSON.parse(await daemon.repos.config.get('lark.redispatch.app.om_first.1') ?? '{}');
    expect(redispatch).toMatchObject({ phase: 'held', redispatch: { count: 0, unsafeReason: '执行过 git push' } });

    const value = callbackValueOf(card, 'replay_turn');
    expect(value).toEqual({ action: 'replay_turn', task_id: 'om_first', turn: '1' });
    const context = { messageId: cardId, chatId: 'oc_group' };
    // 白名单外：拒绝。他人发起的任务：第一次只提示，60 秒内再点一次才执行，执行身份是点击人。
    expect(await daemon.coordinator.handleAction(value, 'ou_mallory', context)).toMatchObject({ type: 'warning' });
    expect(await daemon.coordinator.handleAction(value, 'ou_bob', context)).toMatchObject({ type: 'warning', content: expect.stringContaining('再次点击') });
    expect(h.prompts).toHaveLength(1);
    const results = await Promise.all([1, 2].map(() => daemon.coordinator.handleAction(value, 'ou_bob', context)));
    expect(results.filter(result => result?.type === 'success')).toHaveLength(1);
    await until(() => h.prompts.length === 2);
    expect(h.prompts[1]).toMatchObject({ sessionId, prompt: expect.stringContaining('按「重新执行」重投') });
    expect(h.prompts[1]!.prompt).toContain('请从停下处继续');
    await until(() => h.lastUpdate(cardId)?.markdown?.includes('已按「重新执行」重投'));
    expect(callbackButtonCount(h.lastUpdate(cardId))).toBe(0);
    expect(await h.inbox()).toMatchObject({ turn: 2, event: { senderOpenId: 'ou_bob' }, redispatch: { count: 1, auto: false } });
    expect(await daemon.coordinator.handleAction(value, 'ou_bob', context)).toMatchObject({ type: 'warning' });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(h.prompts).toHaveLength(2);
  });
});
