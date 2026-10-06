import { RuntimeError, DECISION_BUDGET_GATE, DECISION_WINDOW_LIMIT, USAGE_CAP_GATE, countDecisionUsage } from '@dutydeck/shared';
import { BOT_LOOP_DEPTH_LIMIT, BOT_LOOP_GATE, BOT_TURN_LIMIT_PER_HOUR, BOT_TURN_RECORD, countBotTurnUsage } from '@dutydeck/shared';
import { DECIDER_META_KEY, INTRUSIVE_FEEDBACK_PREFIX, MISSED_FEEDBACK_PREFIX, deciderMetaOf, isDecisionGate, participationLevelBehaviors, participationLevelLabels, participationLevelOf, participationLevels } from '@dutydeck/shared';
import { createHash } from 'node:crypto';
import type { CollaborationRepository, CollaborationScope, CollaborationFollowup, CollaborationSnapshot, CollaborationObservation, CollaborationDecision, CollaborationAction, CollaborationTeamContext, CollaborationDeciderMeta, CollaborationSettings, ParticipationLevel } from '@dutydeck/shared';
import { larkMemoryEnabled, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import type { LarkCardService, LarkChatMessage } from './service.js';
import { parseLarkMessageContent } from './message-content.js';
import { LarkContextBootstrap, observationTime } from './context-bootstrap.js';
import { decisionInput, participationInput, parseParticipationResult, parseParticipationResponse, type ParticipationDecider, type ParticipationFacts, type ParticipationResult } from './readonly-decider.js';
import { evaluateParticipationRules, intrusionPattern, ownedItems, participationIntentOf, participationRuleReasons, ruleContextOf, stripMentionPlaceholders, type ParticipationRule, type RuleFacts, type RuleVerdict } from './participation-rules.js';
import { LarkConfirmCards } from './confirm-cards.js';
import { boundCollaborationSnapshot } from '../collaboration-context.js';
import { withLarkContextReadTimeout } from './context-read-timeout.js';
import { renderGroupTaskContext, TASK_CONTEXT_WINDOW, type GroupTaskContext, type GroupTaskContextRequest } from './group-task-context.js';

export interface GroupParticipationOptions {
  repository: CollaborationRepository;
  decider: ParticipationDecider;
  authorize(scope: CollaborationScope, actorId: string | undefined, action: 'observe' | 'update' | 'deliver', followup?: CollaborationFollowup): Promise<boolean>;
  readConfig(appId: string, chatId?: string): Promise<StoredLarkConfig | undefined>;
  /** 规则层要读父消息和群成员，确认卡要发卡和刷新；缺这些能力时对应规则不触发、确认卡不可用。 */
  serviceFor(config: StoredLarkConfig): Pick<LarkCardService, 'listChatMessages' | 'sendText' | 'replyText' | 'addReaction' | 'deleteReaction' | 'listOwnReactions'>
    & Partial<Pick<LarkCardService, 'getMessage' | 'listChatMembers' | 'reply' | 'update'>>;
  readMemory?(scope: CollaborationScope): Promise<string>;
  readTeamContext?(scope: CollaborationScope, query: string): Promise<CollaborationTeamContext>;
  authorizeTeamContext?(scope: CollaborationScope, context: CollaborationTeamContext): Promise<boolean>;
  readGroupDescription?(scope: CollaborationScope, config: StoredLarkConfig): Promise<string>;
  withDelivery?<T>(scope: CollaborationScope, actionId: string, send: () => Promise<T>): Promise<T>;
  listScopes?(appId: string): Promise<CollaborationScope[]>;
  /** 本月成本上限已用满时返回说明；判定前调用，返回说明即不再判定、不建会话。 */
  usageRefusal?(scope: CollaborationScope): Promise<string | undefined>;
  /**
   * operator 能否处理 requester 在本群发起的请求：发起人本人能对机器人说话即可，替别人确认要本群操作员或管理员。
   * 改档短语、「为什么没回」和确认卡都按它鉴权；没接线时这些短语交给 Agent 按普通消息处理。
   */
  canOperate?(scope: CollaborationScope, operatorOpenId: string, requesterOpenId: string): Promise<boolean>;
  /** 把本群改成某个参与强度：写群级唤醒方式覆盖和群参与模式。 */
  applyLevel?(scope: CollaborationScope, level: ParticipationLevel, actorId: string): Promise<void>;
  /** 本群自 since 起判定与回复生成会话的用量：记账条数、已知费用、费用未知的条数。 */
  readParticipationUsage?(scope: CollaborationScope, since: string): Promise<{ entries: number; costUsd: number; unknown: number }>;
  now?: () => Date;
  debounceMs?: number;
  log?: { warn(details: unknown, message: string): void };
}
type Pending = { event: LarkMessageEvent; config: StoredLarkConfig; observation: CollaborationObservation; botOpenId?: string };
type Slot = { pending?: Pending; timer?: NodeJS.Timeout; running?: Promise<void>; stopped: boolean };
/** 把一条人类消息按显式 @ 交给执行路径；授权、领取与执行由 coordinator 负责。 */
export type ParticipationDispatcher = (event: LarkMessageEvent, config: StoredLarkConfig) => Promise<void>;
/** 一次回合门禁的结论：放行返回 undefined，拦下返回可直接落日志的理由。 */
export type BotTurnGate = string | undefined;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keyFor = (scope: CollaborationScope) => JSON.stringify([scope.appId, scope.chatId]);
const teamContextTimeoutMs = 10_000;
/** 主动回复与 act 转执行共用每小时主动发言额度。规则判为「在叫我」的转执行等同一次 @，不占这个额度。 */
const proactiveKinds = ['participation.reply', 'participation.dispatch'];
const ADDRESSED_KIND = 'participation.addressed';
const MISSED_WINDOW_MS = 10 * 60_000;
const WHY_WINDOW_MS = 3_600_000;
const MEMBER_CACHE_MS = 10 * 60_000;
const LEVEL_CONFIRM_KIND = 'participation_level';
const activeModes = new Set(['selective', 'eager']);
const clock = (at: string) => { const date = new Date(at); return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; };
const snippet = (text: string | undefined) => { const plain = stripMentionPlaceholders(text ?? ''); return plain.length > 20 ? `${plain.slice(0, 20)}…` : plain; };
const isSelfMessage = (message: Pick<LarkChatMessage, 'sender'>, appId: string, botOpenId?: string) =>
  ['app', 'bot'].includes(message.sender.type ?? '') && Boolean(message.sender.id) && (message.sender.id === appId || message.sender.id === botOpenId);

const triggerMeta = (trigger: CollaborationObservation): NonNullable<CollaborationDeciderMeta['trigger']> => ({ id: trigger.id,
  ...(trigger.messageId ? { messageId: trigger.messageId } : {}), ...(trigger.senderId ? { senderId: trigger.senderId } : {}), ...(trigger.threadId ? { threadId: trigger.threadId } : {}), text: trigger.text.slice(0, 200) });
/** 存进判定记录的事实去掉未填项（JSON 本来也不存 undefined）。 */
const compactFacts = (facts: RuleFacts): Record<string, string | number | boolean> =>
  Object.fromEntries(Object.entries(facts).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined));
/** 交给模型的事实只给群成员数，其余规则事实只用于规则和回放。 */
export const memberFacts = (facts: Partial<RuleFacts>): ParticipationFacts | undefined =>
  facts.humans === undefined ? undefined : { humans: facts.humans, bots: facts.bots ?? 0 };

/** 判定针对的那条人类消息；旧记录没有来源说明时，按快照里最后一条实时人类消息找回。 */
export function decisionTrigger(decision: Pick<CollaborationDecision, 'inputSnapshot'>): CollaborationDeciderMeta['trigger'] {
  const meta = deciderMetaOf(decision)?.trigger;
  if (meta) return meta;
  const observations = (decision.inputSnapshot as { observations?: unknown }).observations;
  const trigger = Array.isArray(observations) ? [...observations as CollaborationObservation[]].reverse().find(item => item?.origin === 'live' && item.senderKind === 'human') : undefined;
  return trigger ? { id: trigger.id, ...(trigger.messageId ? { messageId: trigger.messageId } : {}), ...(trigger.senderId ? { senderId: trigger.senderId } : {}), text: trigger.text.slice(0, 200) } : undefined;
}

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
  /** 群成员数缓存：规则层「群里只有一个真人」要用，按群缓存 10 分钟。 */
  private readonly members = new Map<string, { until: number; value?: { humans: number; bots: number } }>();
  /** 群级变更的确认卡。参与强度已注册；其他种类（如告警订阅）按同样方式 register 后用 request 发卡。 */
  readonly confirmations: LarkConfirmCards;
  constructor(private readonly options: GroupParticipationOptions) {
    this.bootstrapper = new LarkContextBootstrap({ ...options, authorize: scope => options.authorize(scope, undefined, 'observe') });
    this.confirmations = new LarkConfirmCards({ repository: options.repository, readConfig: options.readConfig, now: options.now, log: options.log,
      serviceFor: config => {
        const service = options.serviceFor(config);
        if (!service.reply || !service.update) throw new RuntimeError('LARK_CARD_UNAVAILABLE', '当前连接不能发送卡片', 503);
        return { reply: service.reply.bind(service), update: service.update.bind(service) };
      } });
    this.confirmations.register(LEVEL_CONFIRM_KIND, {
      authorize: async (record, operator) => await this.options.canOperate?.(record.scope, operator, record.requesterId)
        ? true : '只有发起人本人、本群的操作员或管理员能确认。',
      apply: async (record, operator) => {
        const level = participationLevels.find(item => item === record.payload.level);
        if (!level || !this.options.applyLevel) throw new RuntimeError('COLLABORATION_LEVEL_UNAVAILABLE', '这个群暂时不能在群里改参与强度，请在 Dutydeck Web 的群设置里调整。', 409);
        await this.options.applyLevel(record.scope, level, operator);
        return `本群已改成「${participationLevelLabels[level]}」：${participationLevelBehaviors[level]}。`;
      }
    });
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
  private async snapshot(scope: CollaborationScope, trigger?: CollaborationObservation): Promise<CollaborationSnapshot> {
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
    const snapshot = await this.options.repository.snapshot(scope, 30);
    const ids = new Set(materials.map(item => item.id));
    const observations = [...materials, ...snapshot.observations.filter(item => !ids.has(item.id))];
    // A first live message is persisted before history arrives; keep it even if that
    // backfill pushes its sequence outside the recent observation window.
    const currentTrigger = trigger && (observations.find(item => item.id === trigger.id) ?? trigger);
    return participationInput({ ...snapshot, observations: currentTrigger
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
    const level = await this.level(scope, settings);
    const modeLine = `本群参与强度：${participationLevelLabels[level]}（${participationLevelBehaviors[level]}）${settings.participation === 'observe' ? '；群参与目前是仅观察：只记录群消息，不主动发言' : ''}${settings.notificationsPaused ? '；主动通知已暂停' : ''}。被 @、回复你的消息、或在你接手的话题里续聊时按正常任务处理。用户问起你的参与方式时直接按此回答；想调整时请他 @ 你说「积极点」「按需」「话题里不用@」或「只在@时回」，会收到一张确认卡。`;
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
  /**
   * 本群当前的参与强度。唤醒方式取本群生效的配置（含群级覆盖），读不到时按「只在 @ 时」说明。
   * 给 U5 等后续模块读档位用：接话人、告警初筛按它决定是否接话。
   */
  async level(scope: CollaborationScope, settings?: CollaborationSettings): Promise<ParticipationLevel> {
    const current = settings ?? await this.options.repository.getSettings(scope);
    const config = await this.options.readConfig(scope.appId, scope.chatId).catch(() => undefined);
    return participationLevelOf(config?.mentionPolicy, current.participation);
  }
  /** /status 的参与行：档位、今天的判定与回复次数、模型判定耗时中位数和花费。 */
  async describe(scope: CollaborationScope): Promise<string> {
    const repo = this.options.repository;
    const [settings, mandates, decisions] = await Promise.all([repo.getSettings(scope), repo.listMandates(scope), repo.listDecisions(scope, DECISION_WINDOW_LIMIT)]);
    const now = this.now();
    const since = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const today = decisions.filter(item => Date.parse(item.createdAt) >= since.getTime() && !isDecisionGate(item));
    const rules = today.filter(item => deciderMetaOf(item)?.kind === 'rule').length;
    const models = today.length - rules;
    // 回复次数：真正发出去的文字回复，加上按 @ 交给执行的接话。
    const replies = today.filter(item => item.action !== 'silent' && item.status === 'sent').length;
    const durations = today.map(item => deciderMetaOf(item)?.durationMs).filter((value): value is number => typeof value === 'number').sort((a, b) => a - b);
    const median = durations.length ? (durations.length % 2 ? durations[(durations.length - 1) / 2]! : (durations[durations.length / 2 - 1]! + durations[durations.length / 2]!) / 2) : undefined;
    const usage = await this.options.readParticipationUsage?.(scope, since.toISOString()).catch(() => undefined);
    // 费用拿不到就写未知：PTY 等会话只记次数没有金额，不能当 0。
    const cost = !usage ? (models ? '未知' : '$0.00')
      : usage.unknown ? (usage.costUsd > 0 ? `$${usage.costUsd.toFixed(2)}（另有 ${usage.unknown} 次未知）` : '未知')
      : usage.entries || !models ? `$${usage.costUsd.toFixed(2)}` : '未知';
    const level = await this.level(scope, settings);
    const active = mandates.filter(item => item.status === 'active').length;
    const line = `**参与**：${participationLevelLabels[level]}${settings.participation === 'observe' ? '（只观察）' : ''}；今天判定 ${today.length} 次（规则 ${rules} / 模型 ${models}），回复 ${replies} 次，判定耗时中位 ${median === undefined ? '—' : `${(median / 1000).toFixed(1)} 秒`}，花费 ${cost}`;
    return [line, ...(active ? [`生效中的持续委托 ${active} 个`] : []), ...(settings.notificationsPaused ? ['主动通知已暂停'] : [])].join(' · ');
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
      const settings = await this.options.repository.getSettings(scope);
      if (settings.participation === 'off' || await this.options.usageRefusal?.(scope)
        || await this.decisionBudget(scope, settings.maxDecisionsPerHour)) continue;
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
      const ref = (prefix: string) => latest.refs.find(item => item.startsWith(prefix))?.slice(prefix.length);
      const parentId = ref('dutydeck:parent:'), botOpenId = ref('dutydeck:self:');
      this.enqueue(scope, { config, observation: latest, ...(botOpenId ? { botOpenId } : {}), event: { messageId: latest.messageId, chatId: scope.chatId, chatType: 'group', senderOpenId: latest.senderId, senderType: 'user', messageType: 'text', content: JSON.stringify({ text: latest.text }), threadId: latest.threadId, ...(parentId ? { parentId } : {}), createTime: latest.occurredAt, mentions: [] } });
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
  /**
   * addressed：这条消息明确在叫本机器人（@、回复自己的请求等，不含命令）。这类短消息先看是不是改参与强度、
   * 问刚才为什么没回；是的话由这里直接回复，返回 handled，调用方不再往下处理。
   */
  handle(event: LarkMessageEvent, config: StoredLarkConfig, input: { explicit: boolean; botOpenId?: string; addressed?: boolean }): Promise<{ enabled: boolean; instructions: string; handled?: boolean }> {
    if (this.closed) return Promise.resolve({ enabled: true, instructions: '' });
    return this.track(() => this.observe(event, config, input));
  }
  private async observe(event: LarkMessageEvent, config: StoredLarkConfig, input: { explicit: boolean; botOpenId?: string; addressed?: boolean }): Promise<{ enabled: boolean; instructions: string; handled?: boolean }> {
    if (event.chatType !== 'group') return { enabled: false, instructions: '' };
    const scope = { appId: config.appId, chatId: event.chatId };
    const bot = event.senderType === 'app' || event.senderType === 'bot' || Boolean(input.botOpenId && event.senderOpenId === input.botOpenId);
    const human = !bot && Boolean(event.senderOpenId);
    // 漏接、误插和改档短语与参与模式无关：只在 @ 时的群也要能在群里改回来。
    let intrusive = false;
    if (human) {
      const text = await parseLarkMessageContent(event.messageType, event.content, { messageId: event.messageId }).then(parsed => parsed.text, () => '');
      const result = await this.corrections(scope, event, config, text, input);
      if (result.handled) return { enabled: true, instructions: '', handled: true };
      intrusive = result.intrusive;
    }
    const settings = await this.options.repository.getSettings(scope);
    if (settings.participation === 'off') return { enabled: false, instructions: settings.instructions, ...(intrusive ? { handled: true } : {}) };
    if (!await this.options.authorize(scope, undefined, 'observe')) return { enabled: true, instructions: '', ...(intrusive ? { handled: true } : {}) };
    const now = this.now().toISOString();
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
    if (input.explicit) void this.bootstrapper.ensure(scope).catch(error => this.options.log?.warn({ error, scope }, '群上下文补读失败'));
    // 「没问你」之类的回复记下误插后照常留作群材料，但不再交给判定或 Agent。
    if (intrusive) return { enabled: true, instructions: settings.instructions, handled: true };
    if ((result.created || result.changed) && !input.explicit && human) {
      this.enqueue(scope, { event, config, observation: result.observation, ...(input.botOpenId ? { botOpenId: input.botOpenId } : {}) });
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
      && current.settings.participation !== 'off' && (!deliver || activeModes.has(current.settings.participation) && !current.settings.notificationsPaused
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
    const repo = this.options.repository;
    const settings = await repo.getSettings(scope);
    if (this.closed || slot.stopped || settings.participation === 'off') return;
    const config = await this.options.readConfig(scope.appId, scope.chatId);
    if (!config?.listening) return;
    // 规则层先判：不调模型，不占判定预算和成本上限。这一轮只查父消息、话题根和群成员（有缓存），
    // 要翻最近消息的规则放到闸门之后，免得预算用满时每条消息还去读一次群历史。
    const botNames = [config.name, config.displayName].filter((name): name is string => Boolean(name));
    let facts = await this.ruleFacts(scope, pending, config, participationLevelOf(config.mentionPolicy, settings.participation));
    const owned = ownedItems(await repo.listMandates(scope), []);
    const early = evaluateParticipationRules(ruleContextOf(pending.observation, owned, botNames, facts));
    if (early) { await this.decideByRule(scope, pending, slot, early, facts); return; }
    // 成本上限用满后判定也不再跑；群里的说明由用量账本发一次。留痕与预算闸门一样按小时分桶。
    const refusal = await this.options.usageRefusal?.(scope);
    if (refusal) {
      await repo.recordDecision({ id: `decision_usage_cap_${digest([scope, Math.floor(this.now().getTime() / 3_600_000)])}`, scope, contextRevision: 0, policyVersion: settings.policyVersion,
        action: 'silent', reason: refusal, evidenceIds: [pending.observation.id], status: 'suppressed', inputSnapshot: { gate: USAGE_CAP_GATE }, createdAt: this.now().toISOString() });
      return;
    }
    // 判定本身要花一次模型调用，observe 影子模式同样花。闸门必须在调用之前，
    // 否则每条新消息都会先付费再被发言预算挡下。
    const gate = await this.decisionBudget(scope, settings.maxDecisionsPerHour);
    if (gate) {
      // 留痕让用量可见，但按小时分桶而不是按 contextRevision：recordDecision 遇到已存在的 id 直接返回，
      // 所以每群每小时最多写一条。否则超限期间每条消息都写一条，闸门记录会把 500 条统计窗口占满。
      const gateId = `decision_gate_${digest([scope, Math.floor(this.now().getTime() / 3_600_000)])}`;
      await repo.recordDecision({ id: gateId, scope, contextRevision: 0, policyVersion: settings.policyVersion,
        action: 'silent', reason: gate, evidenceIds: [pending.observation.id], status: 'suppressed', inputSnapshot: { gate: DECISION_BUDGET_GATE }, createdAt: this.now().toISOString() });
      return;
    }
    await this.bootstrapper.ensure(scope);
    const full = await this.snapshot(scope, pending.observation);
    if (full.settings.participation === 'off' || !await this.current(scope, full, pending.event.senderOpenId!, slot)) return;
    const trigger = full.observations.find(item => item.messageId === pending.event.messageId && item.origin === 'live' && item.senderKind === 'human');
    if (!trigger) return;
    // 第二轮规则：补上最近发言（续问、「这个任务」）和事项名称。
    facts = { ...facts, ...await this.recentFacts(config, pending, full) };
    const late = evaluateParticipationRules(ruleContextOf(trigger, ownedItems(full.mandates, full.followups), botNames, facts));
    if (late) { await this.decideByRule(scope, pending, slot, late, facts, full); return; }
    // 交给模型的材料只留当前消息、最近 20 条、本机器人最近的发言和事项标题，控制在 8000 字以内。
    let snapshot = decisionInput(full, trigger.id);
    const id = `decision_${digest([scope, snapshot.contextRevision, snapshot.settings.policyVersion])}`;
    if (await repo.getDecision(scope, id)) return;
    const modelFacts = memberFacts(facts);
    const meta: CollaborationDeciderMeta = { kind: 'model', trigger: triggerMeta(trigger), ...(Object.keys(facts).length ? { facts: compactFacts(facts) } : {}) };
    let result: ParticipationResult;
    let inputSnapshot: Record<string, unknown> = { ...snapshot, [DECIDER_META_KEY]: meta };
    const started = Date.now();
    try {
      if (this.closed || slot.stopped) return;
      try { result = parseParticipationResult(JSON.stringify(await this.options.decider.decide(config, snapshot, trigger.id, modelFacts)), snapshot, trigger.id); }
      finally { meta.durationMs = Date.now() - started; }
      if (result.action === 'reply' && result.teamQuery && this.options.readTeamContext) {
        if (!await this.current(scope, snapshot, pending.event.senderOpenId!, slot)) return;
        // A second budget check covers configuration changes while the classifier ran.
        if (await this.options.usageRefusal?.(scope)) return;
        try {
          const teamContext = await withLarkContextReadTimeout(this.options.readTeamContext(scope, result.teamQuery), '团队上下文读取', teamContextTimeoutMs);
          snapshot = participationInput({ ...snapshot, teamContext });
          // Host-selected evidence is frozen with the accepted local trigger; this
          // also keeps uncertain-send deduplication stable across team queries.
          result = { ...result, evidenceIds: [...new Set([...result.evidenceIds, ...(snapshot.teamContext?.observations ?? []).map(item => item.id)])].slice(0, 30) };
        } catch (error) {
          snapshot = { ...snapshot, bootstrap: { ...snapshot.bootstrap, scope, status: 'partial', updatedAt: this.now().toISOString(), missing: [...new Set([...(snapshot.bootstrap?.missing ?? []), 'team_context_unavailable'])] } };
          this.options.log?.warn({ error, scope }, '团队上下文检索暂不可用');
        }
        inputSnapshot = { ...snapshot, [DECIDER_META_KEY]: meta };
      }
    } catch (error) {
      await repo.recordDecision({ id, scope, contextRevision: snapshot.contextRevision, policyVersion: snapshot.settings.policyVersion, action: 'silent', reason: `Decision unavailable: ${error instanceof Error ? error.message.slice(0, 1500) : 'unknown'}`, evidenceIds: [trigger.id], status: 'failed', inputSnapshot, createdAt: this.now().toISOString() });
      return;
    }
    const decision: CollaborationDecision = { id, scope, contextRevision: snapshot.contextRevision, policyVersion: snapshot.settings.policyVersion,
      action: result.action, reason: result.reason, evidenceIds: result.evidenceIds, status: 'candidate', inputSnapshot, createdAt: this.now().toISOString() };
    await repo.recordDecision(decision);
    if (!activeModes.has(snapshot.settings.participation)) return;
    if (!await this.current(scope, snapshot, pending.event.senderOpenId!, slot)) { await repo.updateDecision(scope, id, { status: 'suppressed' }); return; }
    let updated: CollaborationSnapshot | undefined;
    try { updated = await this.applyUpdates(scope, pending, trigger, snapshot, result, slot); }
    catch { await repo.updateDecision(scope, id, { status: 'failed' }); return; }
    if (!updated) { await repo.updateDecision(scope, id, { status: 'suppressed' }); return; }
    snapshot = updated;
    if (result.action !== 'reply') {
      // act 本身不授权任何工具，只把当前人类消息交回显式执行路径，由 coordinator 按发送者本人重新授权。
      if (result.action === 'act') await this.dispatch(scope, pending, trigger, snapshot, result.evidenceIds, id, slot);
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
        response = error instanceof RuntimeError && ['USAGE_CAP_EXCEEDED', 'USAGE_BACKGROUND_CAP_EXCEEDED'].includes(error.code) ? error.message : '这次回复生成失败，请稍后重试。';
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
  /**
   * 把当前人类消息按显式 @ 交给执行路径。addressed 是规则判为「在叫我」：等同对方 @ 了机器人，
   * 不占主动发言额度，也不受「暂停主动通知」影响；模型给出的 act 仍按主动发言计。
   */
  private async dispatch(scope: CollaborationScope, pending: Pending, trigger: CollaborationObservation, snapshot: CollaborationSnapshot, evidenceIds: string[], id: string, slot: Slot, addressed = false) {
    const repo = this.options.repository;
    const dispatch = this.dispatchers.get(scope.appId);
    if (!dispatch || !evidenceIds.includes(trigger.id) || !await this.current(scope, snapshot, pending.event.senderOpenId!, slot, !addressed, addressed)
      || !addressed && this.proactiveBudgetExhausted(await repo.listActions(scope, 1000), snapshot.settings.maxProactivePerHour)) {
      await repo.updateDecision(scope, id, { status: 'suppressed' }); return;
    }
    const actionId = `${addressed ? 'addressed' : 'dispatch'}_${digest([id, pending.event.messageId])}`;
    const begun = await repo.beginAction({ id: actionId, scope, kind: addressed ? ADDRESSED_KIND : 'participation.dispatch', requesterId: 'policy:group-participation', inputDigest: digest([id, pending.event.messageId]),
      contextRevision: snapshot.contextRevision, payload: { decisionId: id, messageId: pending.event.messageId, ...(pending.event.senderOpenId ? { senderId: pending.event.senderOpenId } : {}) } });
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
  /** 第一轮规则要的事实：消息类型、引用的是谁的消息、话题根是不是本机器人发的、群成员数。查不到的不填。 */
  private async ruleFacts(scope: CollaborationScope, pending: Pending, config: StoredLarkConfig, level: ParticipationLevel): Promise<RuleFacts> {
    const { event } = pending;
    const service = this.options.serviceFor(config);
    const facts: RuleFacts = { level, messageType: event.messageType };
    const read = async (messageId: string) => {
      if (!service.getMessage) return undefined;
      try {
        const message = await service.getMessage(messageId);
        return message.chatId && message.chatId !== event.chatId ? undefined : message;
      } catch (error) { this.options.log?.warn({ error, scope, messageId }, '读取被回复的消息失败'); return undefined; }
    };
    // 话题里的消息默认挂在根消息下，引用了话题内另一条消息才算回复。
    const quoted = event.parentId && (!event.threadId || event.rootId && event.parentId !== event.rootId) ? event.parentId : undefined;
    const parent = quoted ? await read(quoted) : undefined;
    if (parent) facts.parent = isSelfMessage(parent, config.appId, pending.botOpenId) ? 'self' : parent.sender.id && parent.sender.id === event.senderOpenId ? 'sender' : 'other';
    if (event.threadId && event.rootId && event.rootId !== event.messageId && isSelfMessage(await read(event.rootId) ?? { sender: {} }, config.appId, pending.botOpenId)) facts.threadRootSelf = true;
    const members = await this.memberCounts(config, event.chatId);
    if (members) { facts.humans = members.humans; facts.bots = members.bots; }
    return facts;
  }
  /** 群里真人和机器人的数量，按群缓存 10 分钟；查不到（没权限、被安全策略截断）时不填，「只有一个真人」规则不触发。 */
  private async memberCounts(config: StoredLarkConfig, chatId: string) {
    const key = keyFor({ appId: config.appId, chatId });
    const now = this.now().getTime();
    const cached = this.members.get(key);
    if (cached && cached.until > now) return cached.value;
    const service = this.options.serviceFor(config);
    let value: { humans: number; bots: number } | undefined;
    if (service.listChatMembers) {
      try {
        const page = await service.listChatMembers({ chatId, memberTypes: ['user', 'bot'], pageSize: 100 });
        if (!page.securityLimited) value = { humans: page.items.filter(item => item.memberType === 'user').length + (page.hasMore ? 1 : 0), bots: page.items.filter(item => item.memberType === 'bot').length };
      } catch (error) { this.options.log?.warn({ error, chatId }, '读取群成员数失败'); }
    }
    // 读失败只缓存 1 分钟，免得一次抖动让规则失效 10 分钟。
    this.members.set(key, { until: now + (value ? MEMBER_CACHE_MS : 60_000), ...(value ? { value } : {}) });
    if (this.members.size > 1_000) this.members.delete(this.members.keys().next().value!);
    return value;
  }
  /** 第二轮规则要的事实：本机器人在这里最近一次发言距当前消息多久、之后有没有别人说话、发送者是不是它最近的交互对象。 */
  private async recentFacts(config: StoredLarkConfig, pending: Pending, snapshot: CollaborationSnapshot): Promise<Partial<RuleFacts>> {
    const { event, observation } = pending;
    let items: LarkChatMessage[];
    try {
      items = (await this.options.serviceFor(config).listChatMessages({ ...(event.threadId ? { threadId: event.threadId } : { chatId: event.chatId }), order: 'desc', pageSize: 20 })).items;
    } catch (error) { this.options.log?.warn({ error, chatId: event.chatId }, '读取最近消息失败'); return {}; }
    const occurred = Date.parse(observation.occurredAt);
    const at = occurred > 0 ? occurred : Date.parse(observation.receivedAt);
    const before = items.filter(item => item.messageId !== event.messageId && !item.deleted && Number(item.createTime) <= at)
      .sort((left, right) => Number(right.createTime) - Number(left.createTime));
    const self = (item: LarkChatMessage) => isSelfMessage(item, config.appId, pending.botOpenId);
    const index = before.findIndex(self);
    if (index < 0) return {};
    // 交互对象：本机器人回复过的人、在这里 @ 过它的人、生效委托的发起人。
    const partners = new Set(snapshot.mandates.filter(item => item.status === 'active').map(item => item.requesterId));
    for (const item of before) {
      if (self(item)) {
        const parent = item.parentId ? before.find(other => other.messageId === item.parentId) : undefined;
        if (parent?.sender.type === 'user' && parent.sender.id) partners.add(parent.sender.id);
      } else if (item.sender.type === 'user' && item.sender.id && item.mentions.some(mention => mention.id === pending.botOpenId || mention.id === config.appId)) partners.add(item.sender.id);
    }
    return { lastSelfAgoMs: Math.max(0, at - Number(before[index]!.createTime)),
      humanBetween: before.slice(0, index).some(item => item.sender.type === 'user' && item.sender.id !== event.senderOpenId),
      partner: Boolean(event.senderOpenId && partners.has(event.senderOpenId)) };
  }
  /** 记下规则层的结论；「在叫我」按一次显式 @ 交给执行路径，observe 模式只留记录。 */
  private async decideByRule(scope: CollaborationScope, pending: Pending, slot: Slot, verdict: RuleVerdict, facts: RuleFacts, full?: CollaborationSnapshot) {
    const repo = this.options.repository;
    if (!full) {
      await this.bootstrapper.ensure(scope);
      full = await this.snapshot(scope, pending.observation);
    }
    // 规则只看这一条消息本身，期间来了新消息也不影响结论，所以按已受理处理，不比对上下文版本。
    if (full.settings.participation === 'off' || !await this.current(scope, full, pending.event.senderOpenId!, slot, false, true)) return;
    const trigger = full.observations.find(item => item.messageId === pending.event.messageId && item.origin === 'live' && item.senderKind === 'human');
    if (!trigger) return;
    const snapshot = decisionInput(full, trigger.id);
    const id = `decision_${digest([scope, snapshot.contextRevision, snapshot.settings.policyVersion])}`;
    if (await repo.getDecision(scope, id)) return;
    const meta: CollaborationDeciderMeta = { kind: 'rule', rule: verdict.rule, trigger: triggerMeta(trigger), facts: compactFacts(facts) };
    await repo.recordDecision({ id, scope, contextRevision: snapshot.contextRevision, policyVersion: snapshot.settings.policyVersion,
      action: verdict.action === 'addressed' ? 'act' : 'silent', reason: verdict.reason, evidenceIds: [trigger.id], status: 'candidate',
      inputSnapshot: { ...snapshot, [DECIDER_META_KEY]: meta }, createdAt: this.now().toISOString() });
    if (verdict.action === 'addressed' && activeModes.has(snapshot.settings.participation)) await this.dispatch(scope, pending, trigger, snapshot, [trigger.id], id, slot, true);
  }
  /**
   * 人类消息的即时处理：@ 本机器人时记漏接；回复本机器人主动发言说「没问你」记误插；在叫本机器人的短消息里
   * 有改档或「为什么没回」时直接回应。handled 表示已回应，intrusive 表示这是误插纠正，都不再交给判定或 Agent。
   */
  private async corrections(scope: CollaborationScope, event: LarkMessageEvent, config: StoredLarkConfig, text: string, input: { botOpenId?: string; addressed?: boolean }) {
    const warn = (message: string) => (error: unknown) => { this.options.log?.warn({ error, scope, messageId: event.messageId }, message); return false; };
    if (input.botOpenId && event.mentions.some(mention => mention.openId === input.botOpenId)) await this.markMissed(scope, event).catch(warn('记录漏接失败'));
    const intrusive = intrusionPattern.test(text) && await this.markIntrusive(scope, event, text).catch(warn('记录误插失败'));
    const handled = Boolean(input.addressed) && await this.handleIntent(scope, event, config, text).catch(warn('处理参与强度短语失败'));
    return { handled, intrusive };
  }
  /** 改参与强度发确认卡；「刚才为什么没回」不调模型，直接按判定记录回答。 */
  private async handleIntent(scope: CollaborationScope, event: LarkMessageEvent, config: StoredLarkConfig, text: string): Promise<boolean> {
    const intent = participationIntentOf(text);
    const sender = event.senderOpenId;
    // 只回应能在本群使唤机器人的人，与直接 @ 同一套权限；没接线时按普通消息交给 Agent。
    if (!intent || !sender || !this.options.canOperate || !await this.options.canOperate(scope, sender, sender)) return false;
    const key = `${intent.kind}_${digest([scope, event.messageId])}`.slice(0, 50);
    if (intent.kind === 'why_silent') {
      await this.replyText(config, event, await this.explainSilence(scope, sender), key);
      return true;
    }
    const label = participationLevelLabels[intent.level], behavior = participationLevelBehaviors[intent.level];
    if (await this.level(scope) === intent.level) { await this.replyText(config, event, `本群已经是「${label}」：${behavior}。`, key); return true; }
    if (!this.options.applyLevel) { await this.replyText(config, event, '这个群暂时不能在群里改参与强度，请在 Dutydeck Web 的群设置里调整。', key); return true; }
    const record = await this.confirmations.request({ kind: LEVEL_CONFIRM_KIND, scope, requesterId: sender,
      replyTo: { messageId: event.messageId, ...(event.threadId ? { threadId: event.threadId } : {}) },
      title: '调整参与强度', summary: `把本群改成「${label}」：${behavior}。`, payload: { level: intent.level } });
    if (!record) await this.replyText(config, event, '确认卡没发出去，请稍后再说一次，或在 Dutydeck Web 的群设置里调整。', key);
    return true;
  }
  private async replyText(config: StoredLarkConfig, event: LarkMessageEvent, text: string, idempotencyKey: string) {
    await this.options.serviceFor(config).replyText({ messageId: event.messageId, replyInThread: Boolean(event.threadId), text, idempotencyKey });
  }
  /** 按这个人最近一小时在本群被判为不接的那条消息说明原因；没有这样的记录时说明闸门或档位。 */
  private async explainSilence(scope: CollaborationScope, senderId: string): Promise<string> {
    const since = this.now().getTime() - WHY_WINDOW_MS;
    const [settings, decisions] = await Promise.all([this.options.repository.getSettings(scope), this.options.repository.listDecisions(scope, DECISION_WINDOW_LIMIT)]);
    const recent = decisions.filter(item => Date.parse(item.createdAt) >= since);
    const level = await this.level(scope, settings);
    const hint = level === 'eager' ? '' : '想让我多接话，可以 @ 我说「积极点」。';
    const silent = recent.find(item => item.action === 'silent' && !isDecisionGate(item) && decisionTrigger(item)?.senderId === senderId);
    if (silent) {
      const trigger = decisionTrigger(silent);
      const meta = deciderMetaOf(silent);
      const rule = meta?.kind === 'rule' ? participationRuleReasons[meta.rule as ParticipationRule] : undefined;
      const why = rule ?? (silent.status === 'failed' ? '那次判断没跑成，按规定不出声' : `我判断不是在叫我（${silent.reason.slice(0, 200)}）`);
      // 对别人说的话不该接，就不再提示调档。
      return `${clock(silent.createdAt)} 那条「${snippet(trigger?.text)}」我没接：${why}。${meta?.rule === 'mentions_other' || meta?.rule === 'reply_to_other' ? '' : hint}`;
    }
    const gate = recent.find(item => isDecisionGate(item) && [DECISION_BUDGET_GATE, USAGE_CAP_GATE].includes(String((item.inputSnapshot as { gate?: unknown }).gate)));
    if (gate) return `最近一小时没有判断新消息：${gate.reason}。`;
    if (settings.participation === 'observe') return '本群目前只观察，不主动接话；判断结果只留记录，不会发出来。';
    if (level === 'mention' || level === 'topic') return `本群是「${participationLevelLabels[level]}」：${participationLevelBehaviors[level]}，所以没 @ 我的消息我不会接。${hint}`;
    return `最近一小时没有你的消息被我判为不接。可能那条消息在我处理别的消息时被合并跳过了，直接 @ 我再说一次就行。${hint}`;
  }
  /** 判为不接后 10 分钟内同一个人又 @ 了机器人：记一笔漏接，回放评测时这条判定应当接话。规则层判的不记。 */
  private async markMissed(scope: CollaborationScope, event: LarkMessageEvent) {
    const repo = this.options.repository;
    const sender = event.senderOpenId!;
    const now = this.now().getTime();
    const candidates = (await repo.listDecisions(scope, 100)).filter(item => item.action === 'silent' && item.status !== 'failed' && !isDecisionGate(item)
      && deciderMetaOf(item)?.kind !== 'rule' && now - Date.parse(item.createdAt) <= MISSED_WINDOW_MS && decisionTrigger(item)?.senderId === sender && decisionTrigger(item)?.messageId !== event.messageId);
    const target = candidates.find(item => event.parentId && decisionTrigger(item)?.messageId === event.parentId) ?? candidates[0];
    if (!target) return;
    const id = `feedback_missed_${digest([scope, target.id])}`;
    if ((await repo.listFeedback(scope, target.id)).some(item => item.id === id)) return;
    const minutes = Math.max(1, Math.round((now - Date.parse(target.createdAt)) / 60_000));
    await repo.addFeedback({ id, scope, decisionId: target.id, actorId: sender, expectedAction: 'act', createdAt: this.now().toISOString(),
      correction: `${MISSED_FEEDBACK_PREFIX} ${clock(target.createdAt)} 判为不接「${snippet(decisionTrigger(target)?.text)}」，${minutes} 分钟内同一个人又 @ 了机器人。` });
  }
  /** 回复本机器人一天内的主动发言（主动回复、主动接手）说「别插话 / 没问你」：记一笔误插，回放评测时那条判定应当沉默。 */
  private async markIntrusive(scope: CollaborationScope, event: LarkMessageEvent, text: string): Promise<boolean> {
    const anchors = [event.parentId, event.rootId].filter((id): id is string => Boolean(id));
    if (!anchors.length) return false;
    const repo = this.options.repository;
    const since = this.now().getTime() - 86_400_000;
    const action = (await repo.listActions(scope, 200)).find(item => Date.parse(item.createdAt) >= since && typeof item.payload.decisionId === 'string'
      && (item.kind === 'participation.reply' ? Boolean(item.receipt && anchors.includes(item.receipt))
        : (item.kind === 'participation.dispatch' || item.kind === ADDRESSED_KIND) && anchors.includes(String(item.payload.messageId))));
    if (!action) return false;
    const decisionId = String(action.payload.decisionId);
    const id = `feedback_intrusive_${digest([scope, decisionId])}`;
    if (!(await repo.listFeedback(scope, decisionId)).some(item => item.id === id)) {
      await repo.addFeedback({ id, scope, decisionId, actorId: event.senderOpenId!, expectedAction: 'silent', createdAt: this.now().toISOString(),
        correction: `${INTRUSIVE_FEEDBACK_PREFIX} 主动${action.kind === 'participation.reply' ? '回复' : '接手'}后被回「${snippet(text)}」。` });
    }
    return true;
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
