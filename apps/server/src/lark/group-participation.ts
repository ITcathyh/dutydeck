import { RuntimeError, DECISION_BUDGET_GATE, DECISION_WINDOW_LIMIT, USAGE_CAP_GATE, countDecisionUsage } from '@dutydeck/shared';
import { BOT_LOOP_DEPTH_LIMIT, BOT_LOOP_GATE, BOT_TURN_LIMIT_PER_HOUR, BOT_TURN_RECORD, countBotTurnUsage } from '@dutydeck/shared';
import { createHash } from 'node:crypto';
import type { CollaborationRepository, CollaborationScope, CollaborationFollowup, CollaborationSnapshot, CollaborationObservation, CollaborationDecision, CollaborationAction, CollaborationTeamContext, CollaborationParticipationMode } from '@dutydeck/shared';
import { larkMemoryEnabled, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import type { LarkCardService } from './service.js';
import { parseLarkMessageContent } from './message-content.js';
import { LarkContextBootstrap, observationTime } from './context-bootstrap.js';
import { participationInput, parseParticipationResult, parseParticipationResponse, type ParticipationDecider, type ParticipationResult } from './readonly-decider.js';
import { boundCollaborationSnapshot } from '../collaboration-context.js';
import { withLarkContextReadTimeout } from './context-read-timeout.js';
import { renderGroupTaskContext, TASK_CONTEXT_WINDOW, type GroupTaskContext, type GroupTaskContextRequest } from './group-task-context.js';

export interface GroupParticipationOptions {
  repository: CollaborationRepository;
  decider: ParticipationDecider;
  authorize(scope: CollaborationScope, actorId: string | undefined, action: 'observe' | 'update' | 'deliver', followup?: CollaborationFollowup): Promise<boolean>;
  readConfig(appId: string, chatId?: string): Promise<StoredLarkConfig | undefined>;
  serviceFor(config: StoredLarkConfig): Pick<LarkCardService, 'listChatMessages' | 'sendText' | 'replyText' | 'addReaction' | 'deleteReaction' | 'listOwnReactions'>;
  readMemory?(scope: CollaborationScope): Promise<string>;
  readTeamContext?(scope: CollaborationScope, query: string): Promise<CollaborationTeamContext>;
  authorizeTeamContext?(scope: CollaborationScope, context: CollaborationTeamContext): Promise<boolean>;
  readGroupDescription?(scope: CollaborationScope, config: StoredLarkConfig): Promise<string>;
  withDelivery?<T>(scope: CollaborationScope, actionId: string, send: () => Promise<T>): Promise<T>;
  listScopes?(appId: string): Promise<CollaborationScope[]>;
  /** 本月成本上限已用满时返回说明；判定前调用，返回说明即不再判定、不建会话。 */
  usageRefusal?(scope: CollaborationScope): Promise<string | undefined>;
  now?: () => Date;
  debounceMs?: number;
  log?: { warn(details: unknown, message: string): void };
}
type Pending = { event: LarkMessageEvent; config: StoredLarkConfig; observation: CollaborationObservation };
type Slot = { pending?: Pending; timer?: NodeJS.Timeout; running?: Promise<void>; stopped: boolean };
/** 把一条人类消息按显式 @ 交给执行路径；授权、领取与执行由 coordinator 负责。 */
export type ParticipationDispatcher = (event: LarkMessageEvent, config: StoredLarkConfig) => Promise<void>;
/** 一次回合门禁的结论：放行返回 undefined，拦下返回可直接落日志的理由。 */
export type BotTurnGate = string | undefined;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keyFor = (scope: CollaborationScope) => JSON.stringify([scope.appId, scope.chatId]);
const teamContextTimeoutMs = 10_000;
const participationLabels: Record<CollaborationParticipationMode, string> = { off: '关闭', observe: '仅观察', selective: 'Tag 按需参与' };
const participationBehavior: Record<CollaborationParticipationMode, string> = {
  off: '其他未 @ 的消息不处理',
  observe: '其他消息只作为上下文记录，不主动发言',
  selective: '其他未 @ 的消息由判定器决定是否回复或转交给你执行'
};
/** 主动回复与 act 转执行共用每小时主动发言额度。 */
const proactiveKinds = ['participation.reply', 'participation.dispatch'];

/** Silent decisions stay invisible; accepted replies own their processing reaction. */
export class LarkGroupParticipation {
  private closed = false;
  private readonly active = new Set<Promise<unknown>>();
  private readonly slots = new Map<string, Slot>();
  /** 同一话题内连续由机器人触发的回合数；人类触发的回合把它清零。 */
  private readonly botTurnDepth = new Map<string, number>();
  /** 已判定超出机器人预算的群 → 该结论的短期有效期（ms）。刷屏时避免每条消息都读一次统计窗口。 */
  private readonly botBudgetExhausted = new Map<string, number>();
  /** 每群一条门禁串行链。门禁是跨 await 的读-改-写，并发进入会让同一份用量被重复放行。 */
  private readonly botTurnChain = new Map<string, Promise<unknown>>();
  /** 各 Bot 的 coordinator 在监听启动时登记；act 判定经它走显式 @ 的同一路径。 */
  private readonly dispatchers = new Map<string, ParticipationDispatcher>();
  private readonly bootstrapper: LarkContextBootstrap;
  constructor(private readonly options: GroupParticipationOptions) {
    this.bootstrapper = new LarkContextBootstrap({ ...options, authorize: scope => options.authorize(scope, undefined, 'observe') });
  }
  private track<T>(operation: () => Promise<T>): Promise<T> {
    const running = operation();
    this.active.add(running);
    void running.finally(() => this.active.delete(running)).catch(() => undefined);
    return running;
  }
  private now() { return this.options.now?.() ?? new Date(); }
  instructions(scope: CollaborationScope): Promise<string> {
    if (this.closed) return Promise.resolve('');
    return this.track(() => this.readInstructions(scope));
  }
  private async readInstructions(scope: CollaborationScope): Promise<string> {
    // Called after the coordinator's normal task authorization; off only disables ambient participation.
    return (await this.options.repository.getSettings(scope)).instructions;
  }
  private async snapshot(scope: CollaborationScope, trigger?: CollaborationObservation, query = trigger?.text ?? ''): Promise<CollaborationSnapshot> {
    const materials: CollaborationObservation[] = [];
    const description = this.bootstrapper.material(scope);
    if (description) materials.push(description);
    if (this.options.readMemory && await withLarkContextReadTimeout(this.options.authorize(scope, undefined, 'observe'), '群记忆读取授权', teamContextTimeoutMs)) {
      const config = await this.options.readConfig(scope.appId, scope.chatId);
      if (config && larkMemoryEnabled(config)) {
        let text = ''; const missing: string[] = [];
        try { text = await withLarkContextReadTimeout(this.options.readMemory(scope), '群记忆读取', teamContextTimeoutMs); } catch { missing.push('memory_unavailable'); }
        if (text.length > 16000) missing.push('memory_truncated');
        const result = await this.options.repository.observe({ scope, source: 'lark.memory', eventId: scope.chatId,
          occurredAt: '1970-01-01T00:00:00.000Z', receivedAt: this.now().toISOString(), senderKind: 'system', text: text.slice(0, 16000), refs: [], origin: 'history', missing });
        materials.push(result.observation);
      }
    }
    let teamContext: CollaborationTeamContext | undefined;
    let teamUnavailable = false;
    if (this.options.readTeamContext && query.trim()) {
      try { teamContext = await withLarkContextReadTimeout(this.options.readTeamContext(scope, query), '团队上下文读取', teamContextTimeoutMs); }
      catch (error) {
        teamUnavailable = true;
        this.options.log?.warn({ error, scope }, '团队上下文检索暂不可用');
      }
    }
    const snapshot = await this.options.repository.snapshot(scope, 30);
    if (teamUnavailable) snapshot.bootstrap = { ...snapshot.bootstrap, scope, status: 'partial', updatedAt: this.now().toISOString(), missing: [...new Set([...(snapshot.bootstrap?.missing ?? []), 'team_context_unavailable'])] };
    const ids = new Set(materials.map(item => item.id));
    const observations = [...materials, ...snapshot.observations.filter(item => !ids.has(item.id))];
    // A first live message is persisted before history arrives; keep it even if that
    // backfill pushes its sequence outside the recent observation window.
    const currentTrigger = trigger && (observations.find(item => item.id === trigger.id) ?? trigger);
    return participationInput({ ...snapshot, ...(teamContext ? { teamContext } : {}), observations: currentTrigger
      ? [...observations.filter(item => item.id !== currentTrigger.id), currentTrigger] : observations });
  }
  /** watermark 是该会话上次收到的位置（由 coordinator 按会话存取），缺省时注入全量。 */
  taskContext(scope: CollaborationScope, input: GroupTaskContextRequest = {}): Promise<GroupTaskContext | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    return this.track(() => this.readTaskContext(scope, input));
  }
  /** 执行 Agent 只看本群最近材料：不读跨群消息，也不读群记忆（记忆由 coordinator 单独注入）。 */
  private async readTaskContext(scope: CollaborationScope, input: GroupTaskContextRequest): Promise<GroupTaskContext | undefined> {
    if (!await withLarkContextReadTimeout(this.options.authorize(scope, undefined, 'observe'), '群上下文授权', teamContextTimeoutMs)) return undefined;
    const snapshot = await this.options.repository.snapshot(scope, TASK_CONTEXT_WINDOW);
    const { settings } = snapshot;
    if (settings.participation === 'off') return undefined;
    const modeLine = `本群参与模式：${participationLabels[settings.participation]}。被 @、或发起人回复自己 @ 你的请求及你的回复时按正常任务处理；${participationBehavior[settings.participation]}${settings.notificationsPaused ? '；主动通知已暂停' : ''}。用户问起你的参与方式时直接按此回答。`;
    const description = this.bootstrapper.material(scope) ?? snapshot.observations.find(item => item.source === 'lark.description');
    return renderGroupTaskContext({ snapshot, description, modeLine, now: this.now(), ...input });
  }
  private async teamContextAllowed(scope: CollaborationScope, context: CollaborationTeamContext): Promise<boolean | 'unavailable'> {
    if (!this.options.authorizeTeamContext) return false;
    try { return await withLarkContextReadTimeout(this.options.authorizeTeamContext(scope, context), '团队上下文授权', teamContextTimeoutMs); }
    catch (error) {
      this.options.log?.warn({ error, scope }, '团队上下文授权暂不可用');
      return 'unavailable';
    }
  }
  bootstrap(scope: CollaborationScope) {
    if (this.closed) return Promise.resolve(undefined);
    return this.track(async () => {
      await this.bootstrapper.ensure(scope, true);
      return this.options.repository.getBootstrap(scope);
    });
  }
  async mode(scope: CollaborationScope) {
    return (await this.options.repository.getSettings(scope)).participation;
  }
  /** /status 的群参与摘要。 */
  async describe(scope: CollaborationScope): Promise<string> {
    const [settings, mandates] = await Promise.all([this.options.repository.getSettings(scope), this.options.repository.listMandates(scope)]);
    const active = mandates.filter(item => item.status === 'active').length;
    return [`**群参与**：${participationLabels[settings.participation]}`, ...(active ? [`生效中的持续委托 ${active} 个`] : []), ...(settings.notificationsPaused ? ['主动通知已暂停'] : [])].join(' · ');
  }
  setDispatcher(appId: string, dispatch: ParticipationDispatcher) {
    this.dispatchers.set(appId, dispatch);
  }
  refresh(appId: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.track(async () => {
      for (const scope of await this.options.listScopes?.(appId) ?? []) {
        if (this.closed) return;
        await this.bootstrapper.ensure(scope, true);
      }
    });
  }
  recover(appId: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.track(() => this.recoverApp(appId));
  }
  private async recoverApp(appId: string) {
    const [acknowledgements, replies] = await Promise.all([
      this.options.repository.listPendingActions(appId, 'participation.ack'),
      this.options.repository.listPendingActions(appId, 'participation.reply')
    ]);
    // Reconcile persisted work before starting any new live backlog.
    for (const action of acknowledgements) {
      if (this.closed) return;
      await this.clearAcknowledgement(action);
    }
    // Sending interrupted by a restart is an uncertain result, not a retryable failure.
    for (const action of replies) {
      if (this.closed) return;
      if (!['intent', 'sending'].includes(action.status)) continue;
      const sending = action.status === 'sending';
      await this.options.repository.updateAction(action.scope, action.id, { expectedRevision: action.revision, status: sending ? 'unknown' : 'suppressed', error: sending ? 'Process stopped while sending; reconcile before retry' : 'Process stopped before delivery' }).catch(() => undefined);
    }
    for (const scope of await this.options.listScopes?.(appId) ?? []) {
      if (this.closed) return;
      await this.bootstrapper.ensure(scope, true);
      if (this.closed) return;
      if (!await this.options.authorize(scope, undefined, 'observe')) continue;
      const snapshot = await this.options.repository.snapshot(scope, 30);
      if (snapshot.settings.participation === 'off') continue;
      // Live backlog only: history is context, never a source of newly authorized actions.
      const latest = [...snapshot.observations].reverse().find(item => item.origin === 'live' && item.senderKind === 'human' && !item.refs.includes('dutydeck:explicit'));
      if (!latest?.messageId || !latest.senderId) continue;
      const decisions = await this.options.repository.listDecisions(scope, 100);
      if (decisions.some(item => item.evidenceIds.includes(latest.id) || (item.inputSnapshot as unknown as CollaborationSnapshot)?.observations?.some(observation => observation.id === latest.id))) continue;
      const config = await this.options.readConfig(appId, scope.chatId);
      if (!config?.listening) continue;
      this.enqueue(scope, { config, observation: latest, event: { messageId: latest.messageId, chatId: scope.chatId, chatType: 'group', senderOpenId: latest.senderId, senderType: 'user', messageType: 'text', content: JSON.stringify({ text: latest.text }), threadId: latest.threadId, createTime: latest.occurredAt, mentions: [] } });
    }
  }
  closeApp(appId: string) {
    this.dispatchers.delete(appId);
    for (const [key, slot] of this.slots) {
      if ((JSON.parse(key) as [string, string])[0] !== appId) continue;
      slot.stopped = true; slot.pending = undefined;
      if (slot.timer) clearTimeout(slot.timer);
      slot.timer = undefined;
    }
  }
  close(): Promise<void> {
    this.closed = true;
    for (const appId of new Set([...this.slots.keys()].map(key => (JSON.parse(key) as [string, string])[0]))) this.closeApp(appId);
    const bootstrap = this.bootstrapper.close();
    return Promise.allSettled([bootstrap, ...this.active, ...[...this.slots.values()].flatMap(slot => slot.running ?? [])]).then(() => undefined);
  }
  handle(event: LarkMessageEvent, config: StoredLarkConfig, input: { explicit: boolean; botOpenId?: string }): Promise<{ enabled: boolean; instructions: string }> {
    if (this.closed) return Promise.resolve({ enabled: true, instructions: '' });
    return this.track(() => this.observe(event, config, input));
  }
  private async observe(event: LarkMessageEvent, config: StoredLarkConfig, input: { explicit: boolean; botOpenId?: string }): Promise<{ enabled: boolean; instructions: string }> {
    if (event.chatType !== 'group') return { enabled: false, instructions: '' };
    const scope = { appId: config.appId, chatId: event.chatId };
    const settings = await this.options.repository.getSettings(scope);
    if (settings.participation === 'off') return { enabled: false, instructions: settings.instructions };
    if (!await this.options.authorize(scope, undefined, 'observe')) return { enabled: true, instructions: '' };
    const now = this.now().toISOString();
    const bot = event.senderType === 'app' || event.senderType === 'bot' || Boolean(input.botOpenId && event.senderOpenId === input.botOpenId);
    const missing: string[] = [];
    let text = '';
    try {
      const parsed = await parseLarkMessageContent(event.messageType, event.content, { messageId: event.messageId });
      text = parsed.text;
      if (parsed.resources.length) missing.push('resource_binary_not_loaded');
    } catch { missing.push('message_parse_failed'); }
    if (text.length > 16000) missing.push('text_truncated');
    if (!event.createTime) missing.push('event_time_unavailable');
    const result = await this.options.repository.observe({ scope, source: 'lark.message', eventId: event.messageId,
      occurredAt: observationTime(event.createTime, '1970-01-01T00:00:00.000Z'), receivedAt: now, senderId: event.senderOpenId,
      senderKind: bot ? 'bot' : event.senderOpenId ? 'human' : 'system', threadId: event.threadId, messageId: event.messageId,
      text: text.slice(0, 16_000), refs: [event.messageId, ...(event.parentId ? [event.parentId] : []), ...(input.explicit ? ['dutydeck:explicit'] : []),
        ...(input.botOpenId ? [`dutydeck:self:${input.botOpenId}`] : []),
        ...(event.parentId ? [`dutydeck:parent:${event.parentId}`] : []),
        ...new Set(event.mentions.map(mention => `dutydeck:mention:${!input.botOpenId || !mention.openId ? 'unknown' : mention.openId === input.botOpenId ? 'self' : 'other'}`))], origin: 'live', missing });
    // Bootstrap can run alongside explicit requests, but is awaited before ambient decisions.
    void this.bootstrapper.ensure(scope).catch(error => this.options.log?.warn({ error, scope }, '群上下文补读失败'));
    if ((result.created || result.changed) && !input.explicit && !bot && event.senderOpenId && event.senderOpenId !== input.botOpenId) {
      this.enqueue(scope, { event, config, observation: result.observation });
    }
    return { enabled: true, instructions: settings.instructions };
  }
  private enqueue(scope: CollaborationScope, pending: Pending) {
    if (this.closed) return;
    const key = keyFor(scope);
    let slot = this.slots.get(key);
    if (!slot || slot.stopped && !slot.running) { slot = { stopped: false }; this.slots.set(key, slot); }
    if (slot.stopped) return;
    slot.pending = pending;
    if (slot.timer) clearTimeout(slot.timer);
    if (!slot.running) {
      slot.timer = setTimeout(() => { slot!.timer = undefined; void this.drain(scope, slot!); }, this.options.debounceMs ?? 500);
      slot.timer.unref();
    }
  }
  async flush(scope: CollaborationScope) {
    const slot = this.slots.get(keyFor(scope));
    if (!slot) return;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = undefined;
    await this.drain(scope, slot);
  }
  private async drain(scope: CollaborationScope, slot: Slot): Promise<void> {
    if (slot.running) return slot.running;
    const run = (async () => {
      while (slot.pending && !slot.stopped) {
        const pending = slot.pending; slot.pending = undefined;
        try { await this.decide(scope, pending, slot); }
        catch (error) { this.options.log?.warn({ error, scope }, '群参与判定失败，保持静默'); }
      }
    })();
    slot.running = run;
    try { await run; } finally { slot.running = undefined; }
  }
  private async current(scope: CollaborationScope, snapshot: CollaborationSnapshot, actorId: string, slot: Slot, deliver = false, accepted = false) {
    if (this.closed || slot.stopped || !(await this.options.readConfig(scope.appId, scope.chatId))?.listening || !await this.options.authorize(scope, undefined, 'observe')) return false;
    if (snapshot.teamContext && await this.teamContextAllowed(scope, snapshot.teamContext) !== true) return false;
    const current = await this.options.repository.snapshot(scope, 30);
    return (accepted || current.contextRevision === snapshot.contextRevision) && current.settings.revision === snapshot.settings.revision
      && current.settings.participation !== 'off' && (!deliver || current.settings.participation === 'selective' && !current.settings.notificationsPaused
        && await this.options.authorize(scope, 'policy:group-participation', 'deliver')) && !this.closed && !slot.stopped;
  }
  /**
   * 返回拦截理由，通过则返回 undefined。
   * 只统计真正跑过模型的判定：被闸门挡下的记录不计入，否则一旦超限就再也降不回来。
   */
  private async decisionBudget(scope: CollaborationScope, limit: number): Promise<string | undefined> {
    const since = this.now().getTime() - 3_600_000;
    const recent = await this.options.repository.listDecisions(scope, DECISION_WINDOW_LIMIT);
    const used = countDecisionUsage(recent, since);
    // 取满上限且最旧一条仍在窗口内时，窗口没有读全，用量只会被低估，按超限处理。
    // 上限 500 同时是 maxDecisionsPerHour 的最大值，所以走到这一步时用量本来就已经超配置。
    if (recent.length >= DECISION_WINDOW_LIMIT && Date.parse(recent.at(-1)!.createdAt) >= since) {
      return `判定预算窗口不完整：最近 ${DECISION_WINDOW_LIMIT} 条判定都落在本小时内`;
    }
    return used >= limit ? `判定预算已用尽：本小时 ${used}/${limit}` : undefined;
  }
  /**
   * 机器人互相 @ 的硬门禁，与 participation 设置无关。
   *
   * 唤醒判据里的 mentionsBot 分支不受 `!botSender` 约束，访问控制在没配成员名单时
   * 又对任何机器人一律放行——两个机器人互相 @ 就能无限往返。这里是唯一封口的地方。
   * 它只读自己的状态，不看 participation 开关：participation 默认 off，而事故恰好
   * 发生在默认配置上。（真实接线见 service.ts，participation 实例始终存在。）
   *
   * 按群串行执行：coordinator.handle 由长连接 fire-and-forget 调起，同一 tick 到达的
   * 多条机器人消息会并发进来。不串行的话它们会读到同一份深度与用量后一起放行——
   * 而「同一 tick 涌进一批」正是刷屏事故的形态，门禁必须在这里就是准的。
   * decide() 靠 enqueue/drain 的按群 slot 拿到同样的保证。
   *
   * 返回拦截理由，放行返回 undefined。调用方拦下后只留日志与门禁记录，不向群里发消息。
   */
  guardBotTurn(event: LarkMessageEvent, config: StoredLarkConfig, input: { botOpenId?: string }): Promise<BotTurnGate> {
    if (this.closed || event.chatType !== 'group') return Promise.resolve(undefined);
    const key = keyFor({ appId: config.appId, chatId: event.chatId });
    const run = (this.botTurnChain.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.checkBotTurn(event, config, input));
    this.botTurnChain.set(key, run.catch(() => undefined));
    return this.track(() => run);
  }
  private async checkBotTurn(event: LarkMessageEvent, config: StoredLarkConfig, input: { botOpenId?: string }): Promise<BotTurnGate> {
    const scope = { appId: config.appId, chatId: event.chatId };
    const chatKey = keyFor(scope);
    const topicKey = `${chatKey}::${event.threadId ?? ''}`;
    const bot = event.senderType === 'app' || event.senderType === 'bot' || Boolean(input.botOpenId && event.senderOpenId === input.botOpenId);
    if (!bot) { this.botTurnDepth.delete(topicKey); return undefined; }
    const depth = (this.botTurnDepth.get(topicKey) ?? 0) + 1;
    if (depth > BOT_LOOP_DEPTH_LIMIT) {
      // 深度不再往上累加：挡住之后每条消息都在这里返回，不读库也不写库。
      const reason = `同一话题内已连续 ${BOT_LOOP_DEPTH_LIMIT} 轮由机器人触发，在人类发言前不再响应`;
      await this.recordBotGate(scope, reason, 'depth');
      return reason;
    }
    const now = this.now().getTime();
    // 预算是滑动一小时，缓存只是「刷屏时别每条消息都读一次库」的短期结论，
    // 因此只缓存几秒：过期后重新按滑动窗口判，名额一到点就能放出来。
    if ((this.botBudgetExhausted.get(chatKey) ?? 0) > now) return `机器人触发的回合已用尽本小时预算（上限 ${BOT_TURN_LIMIT_PER_HOUR}）`;
    const since = now - 3_600_000;
    const recent = await this.options.repository.listDecisions(scope, DECISION_WINDOW_LIMIT);
    const used = countBotTurnUsage(recent, since);
    // 与 decisionBudget 同一形态：窗口取满且最旧一条仍在本小时内时用量只会被低估，按超限处理。
    const windowIncomplete = recent.length >= DECISION_WINDOW_LIMIT && Date.parse(recent.at(-1)!.createdAt) >= since;
    if (windowIncomplete || used >= BOT_TURN_LIMIT_PER_HOUR) {
      this.botBudgetExhausted.set(chatKey, now + 10_000);
      const reason = windowIncomplete
        ? `机器人预算窗口不完整：最近 ${DECISION_WINDOW_LIMIT} 条记录都落在本小时内`
        : `机器人触发的回合已用尽本小时预算：${used}/${BOT_TURN_LIMIT_PER_HOUR}`;
      await this.recordBotGate(scope, reason, 'budget');
      return reason;
    }
    await this.options.repository.recordDecision({
      id: `decision_bot_turn_${digest([scope, event.messageId])}`, scope, contextRevision: 0, policyVersion: 'bot-loop-guard',
      action: 'silent', reason: `机器人触发的回合 ${used + 1}/${BOT_TURN_LIMIT_PER_HOUR}，同话题连续第 ${depth} 轮`,
      evidenceIds: [], status: 'suppressed',
      inputSnapshot: { gate: BOT_TURN_RECORD, messageId: event.messageId, ...(event.threadId ? { threadId: event.threadId } : {}) },
      createdAt: this.now().toISOString()
    });
    // 先 delete 再 set：Map 对已存在的键不会移到末尾，不删就等于按「最早插入」淘汰，
    // 正在刷屏的话题反而可能被丢掉、连续深度归零，回路上限从此拦不住它。
    this.botTurnDepth.delete(topicKey);
    this.botTurnDepth.set(topicKey, depth);
    // 话题键只增不减，长驻进程会累积；上限与 coordinator 的 handledMessages 同款，惰性丢最久未用的。
    if (this.botTurnDepth.size > 5_000) this.botTurnDepth.delete(this.botTurnDepth.keys().next().value!);
    return undefined;
  }
  /**
   * 门禁留痕按小时分桶：recordDecision 遇到已存在的 id 直接返回，所以每群每小时每类最多一条。
   * 按每条消息写会让几百条门禁记录把 500 条统计窗口占满，用量从此再也读不准。
   */
  private async recordBotGate(scope: CollaborationScope, reason: string, kind: 'depth' | 'budget') {
    const hour = Math.floor(this.now().getTime() / 3_600_000);
    await this.options.repository.recordDecision({
      id: `decision_bot_gate_${digest([scope, hour, kind])}`, scope, contextRevision: 0, policyVersion: 'bot-loop-guard',
      action: 'silent', reason, evidenceIds: [], status: 'suppressed',
      inputSnapshot: { gate: BOT_LOOP_GATE, kind }, createdAt: this.now().toISOString()
    }).catch(error => this.options.log?.warn({ error, scope, kind }, '机器人回合门禁留痕失败'));
  }
  private async decide(scope: CollaborationScope, pending: Pending, slot: Slot) {
    await this.bootstrapper.ensure(scope);
    const repo = this.options.repository;
    let snapshot = await this.snapshot(scope, pending.observation);
    if (snapshot.settings.participation === 'off' || !await this.current(scope, snapshot, pending.event.senderOpenId!, slot)) return;
    const trigger = snapshot.observations.find(item => item.messageId === pending.event.messageId && item.origin === 'live' && item.senderKind === 'human');
    if (!trigger) return;
    const id = `decision_${digest([scope, snapshot.contextRevision, snapshot.settings.policyVersion])}`;
    if (await repo.getDecision(scope, id)) return;
    // 成本上限用满后判定也不再跑；群里的说明由用量账本发一次。留痕与预算闸门一样按小时分桶。
    const refusal = await this.options.usageRefusal?.(scope);
    if (refusal) {
      await repo.recordDecision({ id: `decision_usage_cap_${digest([scope, Math.floor(this.now().getTime() / 3_600_000)])}`, scope, contextRevision: snapshot.contextRevision, policyVersion: snapshot.settings.policyVersion,
        action: 'silent', reason: refusal, evidenceIds: [trigger.id], status: 'suppressed', inputSnapshot: { gate: USAGE_CAP_GATE }, createdAt: this.now().toISOString() });
      return;
    }
    // 判定本身要花一次模型调用，observe 影子模式同样花。闸门必须在调用之前，
    // 否则每条新消息都会先付费再被发言预算挡下。
    const gate = await this.decisionBudget(scope, snapshot.settings.maxDecisionsPerHour);
    if (gate) {
      // 留痕让用量可见，但按小时分桶而不是按 contextRevision：recordDecision 遇到已存在的 id 直接返回，
      // 所以每群每小时最多写一条。否则超限期间每条消息都写一条，闸门记录会把 500 条统计窗口占满。
      const gateId = `decision_gate_${digest([scope, Math.floor(this.now().getTime() / 3_600_000)])}`;
      await repo.recordDecision({ id: gateId, scope, contextRevision: snapshot.contextRevision, policyVersion: snapshot.settings.policyVersion,
        action: 'silent', reason: gate, evidenceIds: [trigger.id], status: 'suppressed', inputSnapshot: { gate: DECISION_BUDGET_GATE }, createdAt: this.now().toISOString() });
      return;
    }
    let result: ParticipationResult;
    const inputSnapshot = snapshot as unknown as Record<string, unknown>;
    try {
      const config = await this.options.readConfig(scope.appId, scope.chatId);
      if (this.closed || slot.stopped || !config?.listening) return;
      result = parseParticipationResult(JSON.stringify(await this.options.decider.decide(config, snapshot, trigger.id)), snapshot, trigger.id);
    } catch (error) {
      await repo.recordDecision({ id, scope, contextRevision: snapshot.contextRevision, policyVersion: snapshot.settings.policyVersion, action: 'silent', reason: `Decision unavailable: ${error instanceof Error ? error.message.slice(0, 1500) : 'unknown'}`, evidenceIds: [trigger.id], status: 'failed', inputSnapshot, createdAt: this.now().toISOString() });
      return;
    }
    const decision: CollaborationDecision = { id, scope, contextRevision: snapshot.contextRevision, policyVersion: snapshot.settings.policyVersion,
      action: result.action, reason: result.reason, evidenceIds: result.evidenceIds, status: 'candidate', inputSnapshot, createdAt: this.now().toISOString() };
    await repo.recordDecision(decision);
    if (snapshot.settings.participation !== 'selective') return;
    if (!await this.current(scope, snapshot, pending.event.senderOpenId!, slot)) { await repo.updateDecision(scope, id, { status: 'suppressed' }); return; }
    let updated: CollaborationSnapshot | undefined;
    try { updated = await this.applyUpdates(scope, pending, trigger, snapshot, result, slot); }
    catch { await repo.updateDecision(scope, id, { status: 'failed' }); return; }
    if (!updated) { await repo.updateDecision(scope, id, { status: 'suppressed' }); return; }
    snapshot = updated;
    if (result.action !== 'reply') {
      // act 本身不授权任何工具，只把当前人类消息交回显式执行路径，由 coordinator 按发送者本人重新授权。
      if (result.action === 'act') await this.dispatch(scope, pending, trigger, snapshot, result, id, slot);
      return;
    }
    if (!await this.current(scope, snapshot, pending.event.senderOpenId!, slot, true)) { await repo.updateDecision(scope, id, { status: 'suppressed' }); return; }
    const actions = await repo.listActions(scope, 1000);
    if (this.proactiveBudgetExhausted(actions, snapshot.settings.maxProactivePerHour)) { await repo.updateDecision(scope, id, { status: 'suppressed' }); return; }
    // Keep uncertain/in-flight delivery deduplicated. A completed answer must not
    // suppress a different human question that happens to cite the same source.
    // The trigger proves who asked; adding it must not defeat deduplication of uncertain sends for the same material.
    const materialIds = result.evidenceIds.filter(id => id !== trigger.id);
    const notificationKey = digest([(materialIds.length ? materialIds : result.evidenceIds).slice().sort(), pending.event.threadId ?? scope.chatId]);
    const inputDigest = digest([notificationKey, id]);
    for (const item of actions) {
      if (item.kind !== 'participation.reply' || item.status === 'suppressed' || item.status === 'failed'
        || item.status === 'succeeded' && item.payload.messageId !== pending.event.messageId) continue;
      let duplicate = item.payload.notificationKey === notificationKey;
      // Older pending receipts included their trigger in the key. Normalize the
      // persisted decision too so an upgrade cannot retry an uncertain send.
      if (!duplicate && item.status !== 'succeeded' && typeof item.payload.decisionId === 'string') {
        const previous = await repo.getDecision(scope, item.payload.decisionId);
        const observations = previous?.inputSnapshot?.observations;
        const previousTrigger = Array.isArray(observations) ? observations.find(observation => observation.messageId === item.payload.messageId) : undefined;
        if (previous && previousTrigger) {
          const previousMaterials = previous.evidenceIds.filter(id => id !== previousTrigger.id);
          duplicate = digest([(previousMaterials.length ? previousMaterials : previous.evidenceIds).slice().sort(), previousTrigger.threadId ?? scope.chatId]) === notificationKey;
        }
      }
      if (duplicate) { await repo.updateDecision(scope, id, { status: 'suppressed' }); return; }
    }
    const actionId = `reply_${digest([id, inputDigest])}`;
    const begun = await repo.beginAction({ id: actionId, scope, kind: 'participation.reply', requesterId: 'policy:group-participation', inputDigest,
      contextRevision: snapshot.contextRevision, payload: { notificationKey, decisionId: id, messageId: pending.event.messageId, settingsRevision: snapshot.settings.revision } });
    if (!begun.created) return;
    if (!await this.current(scope, snapshot, pending.event.senderOpenId!, slot, true)) {
      await repo.updateAction(scope, actionId, { expectedRevision: begun.action.revision, status: 'suppressed' });
      await repo.updateDecision(scope, id, { status: 'suppressed' }); return;
    }
    // Once accepted, freeze the input. Unrelated new observations must not swallow an acknowledged request.
    let action = begun.action;
    let acknowledgement: CollaborationAction | undefined;
    let providerStarted = false;
    try {
      const config = await this.options.readConfig(scope.appId, scope.chatId);
      if (!config || !await this.current(scope, snapshot, pending.event.senderOpenId!, slot, true, true)) {
        throw new RuntimeError('COLLABORATION_DELIVERY_SUPPRESSED', 'Listener or authorization changed before acceptance', 409);
      }
      acknowledgement = await this.acknowledge(scope, pending.event.messageId, actionId, config);
      if (!await this.current(scope, snapshot, pending.event.senderOpenId!, slot, true, true)) {
        throw new RuntimeError('COLLABORATION_DELIVERY_SUPPRESSED', 'Listener or authorization changed before generation', 409);
      }
      let response: string;
      let generationError: string | undefined;
      try {
        response = parseParticipationResponse(JSON.stringify({ response: await this.options.decider.respond(config, snapshot, result, trigger.id) }));
      } catch (error) {
        generationError = error instanceof Error ? error.message.slice(0, 1000) : 'Reply generation failed';
        // 判定之后成本刚好用满：如实说明上限，「稍后重试」在调高上限或下月之前都不会成功。
        response = error instanceof RuntimeError && error.code === 'USAGE_CAP_EXCEEDED' ? error.message : '这次回复生成失败，请稍后重试。';
      }
      await repo.updateDecision(scope, id, { status: generationError ? 'failed' : 'candidate', response });
      action = await repo.updateAction(scope, actionId, { expectedRevision: action.revision, status: 'sending' });
      const send = async () => {
        // Shared group delivery serialization may wait: recheck inside the acquired guard.
        if (!await this.current(scope, snapshot, pending.event.senderOpenId!, slot, true, true)) {
          throw new RuntimeError('COLLABORATION_DELIVERY_SUPPRESSED', 'Context or authorization changed before delivery', 409);
        }
        const config = await this.options.readConfig(scope.appId, scope.chatId);
        if (this.closed || slot.stopped || !config?.listening) throw new RuntimeError('COLLABORATION_DELIVERY_SUPPRESSED', 'Listener stopped before delivery', 409);
        providerStarted = true;
        return this.options.serviceFor(config).replyText({ messageId: pending.event.messageId, replyInThread: true, text: response, idempotencyKey: actionId.slice(0, 50) });
      };
      const sent = await (this.options.withDelivery ? this.options.withDelivery(scope, actionId, send) : send());
      await repo.updateAction(scope, actionId, { expectedRevision: action.revision, status: 'succeeded', receipt: sent.messageId, ...(generationError ? { error: generationError } : {}) });
      await repo.updateDecision(scope, id, { status: generationError ? 'failed' : 'sent' });
    } catch (error) {
      const suppressed = !providerStarted && error instanceof RuntimeError && error.code === 'COLLABORATION_DELIVERY_SUPPRESSED';
      await repo.updateAction(scope, actionId, { expectedRevision: action.revision, status: suppressed ? 'suppressed' : providerStarted ? 'unknown' : 'failed', error: error instanceof Error ? error.message.slice(0, 1000) : 'Unknown delivery result' }).catch(() => undefined);
      await repo.updateDecision(scope, id, { status: suppressed ? 'suppressed' : 'failed' });
    } finally {
      if (acknowledgement) await this.clearAcknowledgement(acknowledgement);
    }
  }
  private proactiveBudgetExhausted(actions: CollaborationAction[], limit: number): boolean {
    const since = this.now().getTime() - 3_600_000;
    const used = actions.filter(item => proactiveKinds.includes(item.kind) && ['intent', 'sending', 'succeeded', 'unknown'].includes(item.status) && Date.parse(item.createdAt) >= since).length;
    return actions.length >= 500 && Date.parse(actions.at(-1)!.createdAt) >= since || used >= limit;
  }
  private async dispatch(scope: CollaborationScope, pending: Pending, trigger: CollaborationObservation, snapshot: CollaborationSnapshot, result: ParticipationResult, id: string, slot: Slot) {
    const repo = this.options.repository;
    const dispatch = this.dispatchers.get(scope.appId);
    if (!dispatch || !result.evidenceIds.includes(trigger.id) || !await this.current(scope, snapshot, pending.event.senderOpenId!, slot, true)
      || this.proactiveBudgetExhausted(await repo.listActions(scope, 1000), snapshot.settings.maxProactivePerHour)) {
      await repo.updateDecision(scope, id, { status: 'suppressed' }); return;
    }
    const actionId = `dispatch_${digest([id, pending.event.messageId])}`;
    const begun = await repo.beginAction({ id: actionId, scope, kind: 'participation.dispatch', requesterId: 'policy:group-participation', inputDigest: digest([id, pending.event.messageId]),
      contextRevision: snapshot.contextRevision, payload: { decisionId: id, messageId: pending.event.messageId } });
    if (!begun.created) return;
    let action = await repo.updateAction(scope, actionId, { expectedRevision: begun.action.revision, status: 'sending' });
    try {
      await dispatch(pending.event, pending.config);
      action = await repo.updateAction(scope, actionId, { expectedRevision: action.revision, status: 'succeeded' });
      await repo.updateDecision(scope, id, { status: 'sent' });
    } catch (error) {
      // coordinator 可能已领取这条消息，结果以任务收件箱为准，这里只记为待核对。
      await repo.updateAction(scope, actionId, { expectedRevision: action.revision, status: 'unknown', error: error instanceof Error ? error.message.slice(0, 1000) : 'Dispatch result unknown' }).catch(() => undefined);
      await repo.updateDecision(scope, id, { status: 'failed' });
    }
  }
  private async acknowledge(scope: CollaborationScope, messageId: string, replyActionId: string, config: StoredLarkConfig): Promise<CollaborationAction> {
    const repo = this.options.repository;
    const begun = await repo.beginAction({ id: `ack_${digest(replyActionId)}`, scope, kind: 'participation.ack', requesterId: 'policy:group-participation',
      inputDigest: digest([messageId, replyActionId]), payload: { messageId, replyActionId } });
    let action = begun.action;
    try {
      action = await repo.updateAction(scope, action.id, { expectedRevision: action.revision, status: 'sending' });
      const { reactionId } = await this.options.serviceFor(config).addReaction(messageId, 'OK');
      action = { ...action, receipt: reactionId };
      action = await repo.updateAction(scope, action.id, { expectedRevision: action.revision, status: 'sending', receipt: reactionId });
    } catch (error) {
      // A reaction failure must not discard the accepted answer.
      this.options.log?.warn({ error, scope, messageId }, '群回复处理标记添加失败');
      await repo.updateAction(scope, action.id, { expectedRevision: action.revision, status: 'unknown', receipt: action.receipt,
        error: error instanceof Error ? error.message.slice(0, 1000) : 'Reaction result unknown' }).then(updated => { action = updated; }).catch(() => undefined);
    }
    return action;
  }
  private async clearAcknowledgement(action: CollaborationAction): Promise<void> {
    try {
      const config = await this.options.readConfig(action.scope.appId, action.scope.chatId);
      if (!config) return;
      const service = this.options.serviceFor(config);
      const messageId = String(action.payload.messageId);
      // An add may have succeeded before its receipt was saved. Only reconcile this app's OK.
      const reactionIds = action.receipt ? [action.receipt] : (await service.listOwnReactions(messageId, 'OK')).map(item => item.reactionId);
      // Removing our own marker is cleanup, including after pause, revocation or shutdown.
      for (const reactionId of reactionIds) {
        try { await service.deleteReaction(messageId, reactionId); }
        catch (error) {
          // A prior delete may have succeeded before its response or checkpoint was saved.
          if ((await service.listOwnReactions(messageId, 'OK')).some(item => item.reactionId === reactionId)) throw error;
        }
      }
      await this.options.repository.updateAction(action.scope, action.id, { expectedRevision: action.revision, status: action.status === 'intent' ? 'suppressed' : 'succeeded', error: null });
    } catch (error) {
      // Keep the reaction receipt durable so recovery can retry cleanup, never the reply.
      this.options.log?.warn({ error, scope: action.scope, actionId: action.id }, '群回复处理标记清理失败');
    }
  }
  private async applyUpdates(scope: CollaborationScope, pending: Pending, trigger: CollaborationObservation, snapshot: CollaborationSnapshot, result: ParticipationResult, slot: Slot): Promise<CollaborationSnapshot | undefined> {
    for (const update of result.updates) {
      if (!update.evidenceIds.includes(trigger.id)) return undefined;
      const followup = snapshot.followups.find(item => item.id === update.followupId && item.revision === update.expectedRevision && item.status === 'open');
      if (!followup || !await this.options.authorize(scope, pending.event.senderOpenId, 'update', followup)) return undefined;
      if (update.steps && (update.steps.length !== followup.steps.length || update.steps.some(step => !followup.steps.some(old => old.id === step.id && old.label === step.label)) || new Set(update.steps.map(step => step.id)).size !== update.steps.length)) return undefined;
      if (!await this.current(scope, snapshot, pending.event.senderOpenId!, slot)) return undefined;
      await this.options.repository.updateFollowup(scope, followup.id, { expectedRevision: followup.revision, ...(update.progress !== undefined ? { progress: update.progress } : {}), ...(update.steps ? { steps: update.steps } : {}), provenance: 'inferred', sourceRefs: [...new Set([...followup.sourceRefs, ...update.evidenceIds])].slice(-100) }, pending.event.senderOpenId!);
      // Account only for our own single state transition; any concurrent material change invalidates delivery.
      const after = participationInput(await this.options.repository.snapshot(scope, 30));
      if (after.contextRevision !== snapshot.contextRevision + 1) return { ...after, contextRevision: snapshot.contextRevision };
      snapshot = boundCollaborationSnapshot({ ...after, observations: snapshot.observations, ...(snapshot.teamContext ? { teamContext: snapshot.teamContext } : {}) });
    }
    return snapshot;
  }
}
