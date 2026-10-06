import { RuntimeError, DECISION_BUDGET_GATE, DECISION_WINDOW_LIMIT, USAGE_CAP_GATE, countDecisionUsage } from '@dutydeck/shared';
import { BOT_LOOP_DEPTH_LIMIT, BOT_LOOP_GATE, BOT_TURN_LIMIT_PER_HOUR, BOT_TURN_RECORD, countBotTurnUsage } from '@dutydeck/shared';
import { DECIDER_META_KEY, INTRUSIVE_FEEDBACK_PREFIX, MISSED_FEEDBACK_PREFIX, deciderMetaOf, isDecisionGate, participationLevelBehaviors, participationLevelLabels, participationLevelOf, participationLevels } from '@dutydeck/shared';
import { ALARM_DEDUPE_HOURS, ALARM_MAX_PER_HOUR, ALARM_TRIAGE_RECORD, alarmSubscriptionSchema, isAlarmRecord, type AlarmSubscription, type CollaborationDuty, type UpdateCollaborationDutyInput } from '@dutydeck/shared';
import { createHash } from 'node:crypto';
import type { CollaborationRepository, CollaborationScope, CollaborationFollowup, CollaborationSnapshot, CollaborationObservation, CollaborationDecision, CollaborationAction, CollaborationTeamContext, CollaborationDeciderMeta, CollaborationSettings, ParticipationLevel } from '@dutydeck/shared';
import { larkMemoryEnabled, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import type { LarkCardService, LarkChatMessage } from './service.js';
import { parseLarkMessageContent } from './message-content.js';
import { LarkContextBootstrap, observationTime } from './context-bootstrap.js';
import { decisionInput, participationInput, parseParticipationResult, parseParticipationResponse, type ParticipationDecider, type ParticipationFacts, type ParticipationResult } from './readonly-decider.js';
import { botNameTokens, callsBotName, compactText, evaluateParticipationRules, intrusionPattern, ownedItems, participationIntentOf, participationRuleReasons, ruleContextOf, stripMentionPlaceholders, type ParticipationRule, type RuleFacts, type RuleVerdict } from './participation-rules.js';
import { alarmFingerprint, alarmIntentOf, alarmLevelMatches, alarmOutcomeReasons, alarmTriagePrompt, describeAlarm, responderAnnouncementOf, responderClaimText, responderIntentOf, responderReleaseText, type AlarmIntent, type AlarmOutcome } from './group-duty.js';
import { LarkConfirmCards, type LarkConfirmRecord } from './confirm-cards.js';
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
type ObserveInput = { explicit: boolean; botOpenId?: string; addressed?: boolean; ownedTopic?: boolean };
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
const ALARM_CONFIRM_KIND = 'alarm_subscription';
const RESPONDER_CONFIRM_KIND = 'group_responder';
/** 观察 refs 里的标记：这条消息在本机器人接手的话题里（coordinator 按话题会话判断）。 */
const OWNED_TOPIC_REF = 'dutydeck:owned-topic';
type BotMember = { name: string; appId?: string; openId?: string };
type Members = { humans: number; bots: number; botList: BotMember[] };
const activeModes = new Set(['selective', 'eager']);
/** 当不了接话人的档（只在 @ 时、话题内免 @）怎么跟人说。 */
const deafLevelText = (level: ParticipationLevel) => level === 'mention' ? '我现在只在 @ 时回复' : `我现在是「${participationLevelLabels[level]}」，不接没 @ 的消息`;
const clock = (at: string) => { const date = new Date(at); return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; };
const snippet = (text: string | undefined) => { const plain = stripMentionPlaceholders(text ?? ''); return plain.length > 20 ? `${plain.slice(0, 20)}…` : plain; };
const botName = (config: StoredLarkConfig) => config.name ?? config.displayName ?? config.appId;
const isSelfMessage = (message: Pick<LarkChatMessage, 'sender'>, appId: string, botOpenId?: string) =>
  ['app', 'bot'].includes(message.sender.type ?? '') && Boolean(message.sender.id) && (message.sender.id === appId || message.sender.id === botOpenId);

/** 会接话的机器人：群里的机器人去掉本群订阅的告警来源，告警机器人只发告警，不算多机器人群里的另一个。 */
const talkingBots = (members: Members, duty: CollaborationDuty) => {
  const sources = new Set(duty.alarm?.sources.map(source => source.appId));
  return members.botList.filter(item => !item.appId || !sources.has(item.appId));
};
const alarmOf = (item: Pick<CollaborationDecision, 'inputSnapshot'>) => (item.inputSnapshot as { alarm?: { outcome?: string; fingerprint?: string } }).alarm;
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
  /** 群成员缓存：规则层「群里只有一个真人」「多机器人群」和接话人、告警来源的名字要用，按群缓存 10 分钟。 */
  private readonly members = new Map<string, { until: number; value?: Members }>();
  /** 其他 Bot 在本 App 视角下的 open_id → 它的 app_id。实时事件只给 open_id，订阅和接话人按 app_id 记。 */
  private readonly botApps = new Map<string, string>();
  /** 每群一条告警处理串行链：去重和每小时上限是跨 await 的读-改-写。 */
  private readonly alarmChain = new Map<string, Promise<unknown>>();
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
        return `本群已改成「${participationLevelLabels[level]}」：${participationLevelBehaviors[level]}。${await this.levelResponder(record, level, operator)}`;
      }
    });
    const operate = async (record: { scope: CollaborationScope; requesterId: string }, operator: string) => await this.options.canOperate?.(record.scope, operator, record.requesterId)
      ? true as const : '只有发起人本人、本群的操作员或管理员能确认。';
    this.confirmations.register(ALARM_CONFIRM_KIND, {
      authorize: operate,
      apply: async (record, operator) => {
        const repo = this.options.repository;
        const duty = await repo.getDuty(record.scope);
        if (record.payload.enabled === false) {
          if (!duty.alarm?.enabled) return '本群本来就没开告警初筛。';
          await repo.updateDuty(record.scope, { expectedRevision: duty.revision, alarm: { ...duty.alarm, enabled: false } }, operator);
          return '已关闭本群告警初筛，订阅设置保留，之后可以再打开。';
        }
        if (duty.responder && duty.responder.appId !== record.scope.appId) throw new RuntimeError('COLLABORATION_NOT_RESPONDER', `本群接话人是「${duty.responder.name ?? duty.responder.appId}」，告警初筛只由接话人做。`, 409);
        // 初筛任务以点确认的人的名义发起：他为这份订阅负责，任务也按他的权限执行。
        const alarm = alarmSubscriptionSchema.parse({ enabled: true, sources: JSON.parse(String(record.payload.sources)), levels: JSON.parse(String(record.payload.levels)),
          dedupeHours: record.payload.dedupeHours, maxPerHour: record.payload.maxPerHour, requesterId: operator });
        await repo.updateDuty(record.scope, { expectedRevision: duty.revision, alarm }, operator);
        return `已开启告警初筛：${describeAlarm(alarm)}。告警来了我在告警话题里先做初筛，任务以你的名义发起。`;
      }
    });
    this.confirmations.register(RESPONDER_CONFIRM_KIND, {
      authorize: operate,
      apply: async (record, operator) => {
        const config = await this.options.readConfig(record.scope.appId, record.scope.chatId);
        if (!config) throw new RuntimeError('LARK_CONFIG_NOT_FOUND', '机器人配置已不可用。', 409);
        // 卡上说了先调到按需：接话人要收得到没 @ 的消息。调档失败就整张卡不生效，不留下收不到消息的接话人。
        const raise = record.payload.level === 'selective' && !activeModes.has(await this.level(record.scope));
        if (raise) {
          if (!this.options.applyLevel) throw new RuntimeError('COLLABORATION_LEVEL_UNAVAILABLE', '这个群暂时不能在群里改参与强度，请在 Dutydeck Web 的群设置里调整。', 409);
          await this.options.applyLevel(record.scope, 'selective', operator);
        }
        const announced = await this.claimResponder(record.scope, config, operator, record.replyTo);
        return `${raise ? `本群已改成「按需」：${participationLevelBehaviors.selective}。` : ''}本群没 @ 机器人的消息改由我接。${announced ? '已在群里发了声明，其他 Dutydeck 机器人收到后只接 @ 和自己接手的话题。' : '群里的声明没发出去，其他机器人可能还不知道；请稍后 @我 再说一次「你负责接话」，我会重发声明。'}`;
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
    const alarms = decisions.filter(item => isAlarmRecord(item) && Date.parse(item.createdAt) >= since.getTime());
    return [[line, ...(active ? [`生效中的持续委托 ${active} 个`] : []), ...(settings.notificationsPaused ? ['主动通知已暂停'] : [])].join(' · '),
      ...await this.dutyLines(scope, alarms)].join('\n\n');
  }
  /** /status 的分工行：接话人（多机器人群或已指定时）和告警初筛订阅。 */
  private async dutyLines(scope: CollaborationScope, alarmsToday: CollaborationDecision[]): Promise<string[]> {
    const duty = await this.options.repository.getDuty(scope);
    const config = await this.options.readConfig(scope.appId, scope.chatId).catch(() => undefined);
    const members = config && await this.memberCounts(config, scope.chatId);
    const bots = members ? talkingBots(members, duty).length : 0;
    const lines: string[] = [];
    if (duty.responder) lines.push(duty.responder.appId === scope.appId ? '**接话人**：我，本群没 @ 机器人的消息由我接'
      : `**接话人**：${duty.responder.name ?? duty.responder.appId}，没 @ 机器人的消息由它接，我只接 @ 和自己接手的话题`);
    else if (bots > 1) lines.push(`**接话人**：未指定。本群有 ${bots} 个机器人，没 @ 的消息我先不接；要我接，@我 说「你负责接话」，或在 Dutydeck Web 的群设置里指定`);
    if (duty.alarm) {
      const triaged = alarmsToday.filter(item => item.action === 'act').length;
      lines.push(duty.alarm.enabled ? `**告警初筛**：${describeAlarm(duty.alarm)}；今天分析 ${triaged} 条，跳过 ${alarmsToday.length - triaged} 条` : '**告警初筛**：已关闭');
    }
    return lines;
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
   * ownedTopic：消息在本机器人接手的话题里，规则层据此直接接话。
   */
  handle(event: LarkMessageEvent, config: StoredLarkConfig, input: ObserveInput): Promise<{ enabled: boolean; instructions: string; handled?: boolean }> {
    if (this.closed) return Promise.resolve({ enabled: true, instructions: '' });
    return this.track(() => this.observe(event, config, input));
  }
  private async observe(event: LarkMessageEvent, config: StoredLarkConfig, input: ObserveInput): Promise<{ enabled: boolean; instructions: string; handled?: boolean }> {
    if (event.chatType !== 'group') return { enabled: false, instructions: '' };
    const scope = { appId: config.appId, chatId: event.chatId };
    const self = Boolean(input.botOpenId && event.senderOpenId === input.botOpenId);
    const bot = event.senderType === 'app' || event.senderType === 'bot' || self;
    const human = !bot && Boolean(event.senderOpenId);
    // 漏接、误插和改档短语与参与模式无关：只在 @ 时的群也要能在群里改回来。
    let intrusive = false;
    if (human) {
      const text = await parseLarkMessageContent(event.messageType, event.content, { messageId: event.messageId }).then(parsed => parsed.text, () => '');
      const result = await this.corrections(scope, event, config, text, input);
      if (result.handled) return { enabled: true, instructions: '', handled: true };
      intrusive = result.intrusive;
    } else if (bot && !self) {
      // 告警订阅和接话人声明同样与参与模式无关：只在 @ 时的群也能订阅告警。
      await this.botDuty(scope, event, config).catch(error => this.options.log?.warn({ error, scope, messageId: event.messageId }, '处理机器人消息的分工失败'));
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
        ...(event.parentId ? [`dutydeck:parent:${event.parentId}`] : []), ...(input.ownedTopic ? [OWNED_TOPIC_REF] : []),
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
  /** 别的机器人发的消息：接话人声明照着同步；订阅的告警来源发的消息起初筛。都不调模型。 */
  private async botDuty(scope: CollaborationScope, event: LarkMessageEvent, config: StoredLarkConfig) {
    const duty = await this.options.repository.getDuty(scope);
    if (!duty.alarm?.enabled && event.messageType !== 'text') return;
    const text = await parseLarkMessageContent(event.messageType, event.content, { messageId: event.messageId }).then(parsed => parsed.text, () => '');
    const announcement = responderAnnouncementOf(text);
    if (!announcement && !duty.alarm?.enabled) return;
    const appId = await this.senderAppId(config, event);
    if (!appId || appId === config.appId) return;
    if (announcement) { await this.syncResponder(scope, duty, announcement, appId, event); return; }
    if (!duty.alarm!.sources.some(source => source.appId === appId)) return;
    const key = keyFor(scope);
    const run = (this.alarmChain.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => this.triageAlarm(scope, event, config, appId, text));
    this.alarmChain.set(key, run.catch(() => undefined));
    await run;
  }
  /** 机器人消息发送者的 app_id。实时事件只给本 App 视角的 open_id，按消息详情查一次后缓存。 */
  private async senderAppId(config: StoredLarkConfig, event: LarkMessageEvent): Promise<string | undefined> {
    const openId = event.senderOpenId;
    if (openId?.startsWith('cli_')) return openId;
    const key = `${config.appId}:${openId ?? ''}`;
    const cached = openId ? this.botApps.get(key) : undefined;
    const service = this.options.serviceFor(config);
    if (cached || !service.getMessage) return cached;
    const sender = (await service.getMessage(event.messageId)).sender;
    const appId = sender.idType === 'app_id' || sender.id?.startsWith('cli_') ? sender.id : undefined;
    if (appId && openId) {
      this.botApps.set(key, appId);
      if (this.botApps.size > 1_000) this.botApps.delete(this.botApps.keys().next().value!);
    }
    return appId;
  }
  /** 别的 Bot 声明自己成为或不再是接话人。声明比本地记录还早（乱序或重放）时不回退。 */
  private async syncResponder(scope: CollaborationScope, duty: CollaborationDuty, announcement: { kind: 'claim' | 'release'; name?: string }, appId: string, event: LarkMessageEvent) {
    const repo = this.options.repository;
    if (announcement.kind === 'release') {
      if (duty.responder?.appId === appId) await repo.updateDuty(scope, { expectedRevision: duty.revision, responder: null }, `bot:${appId}`);
      return;
    }
    const at = observationTime(event.createTime, this.now().toISOString());
    if (duty.responder && (duty.responder.appId === appId || Date.parse(duty.responder.since) > Date.parse(at))) return;
    await repo.updateDuty(scope, { expectedRevision: duty.revision, responder: { appId, ...(announcement.name ? { name: announcement.name } : {}), since: at } }, `bot:${appId}`);
  }
  /** 订阅来源发来一条消息：按级别、接话人、去重和每小时上限决定起不起初筛，结论都记一条判定，「为什么没回」能查到。 */
  private async triageAlarm(scope: CollaborationScope, event: LarkMessageEvent, config: StoredLarkConfig, sourceAppId: string, text: string) {
    const repo = this.options.repository;
    const { alarm, responder } = await repo.getDuty(scope);
    const id = `decision_alarm_${digest([scope, event.messageId])}`;
    // 平台重推同一条告警只处理一次。
    if (!alarm?.enabled || await repo.getDecision(scope, id)) return;
    const now = this.now();
    const fingerprint = alarmFingerprint(sourceAppId, text);
    const triaged = (await repo.listDecisions(scope, DECISION_WINDOW_LIMIT)).filter(item => isAlarmRecord(item) && item.action === 'act' && item.status !== 'failed');
    const within = (item: CollaborationDecision, ms: number) => Date.parse(item.createdAt) >= now.getTime() - ms;
    const outcome: AlarmOutcome = !alarmLevelMatches(alarm.levels, text) ? 'level'
      : responder && responder.appId !== scope.appId ? 'not_responder'
      : triaged.some(item => alarmOf(item)?.fingerprint === fingerprint && within(item, alarm.dedupeHours * 3_600_000)) ? 'duplicate'
      : triaged.filter(item => within(item, 3_600_000)).length >= alarm.maxPerHour ? 'rate_limited'
      : !alarm.requesterId ? 'no_requester' : 'triaged';
    const meta: CollaborationDeciderMeta = { kind: 'rule', rule: `alarm_${outcome}`, trigger: { id: event.messageId, messageId: event.messageId, ...(event.senderOpenId ? { senderId: event.senderOpenId } : {}), text: text.slice(0, 200) } };
    // 先记下再派发：同一指纹的下一条告警在派发期间到达也能看到这条。
    await repo.recordDecision({ id, scope, contextRevision: 0, policyVersion: 'alarm-triage', action: outcome === 'triaged' ? 'act' : 'silent', reason: alarmOutcomeReasons[outcome],
      evidenceIds: [], status: outcome === 'triaged' ? 'candidate' : 'suppressed', createdAt: now.toISOString(),
      inputSnapshot: { gate: ALARM_TRIAGE_RECORD, alarm: { outcome, fingerprint, sourceAppId }, [DECIDER_META_KEY]: meta } });
    if (outcome !== 'triaged') return;
    try {
      await this.startTriage(scope, event, config, alarm, sourceAppId);
      await repo.updateDecision(scope, id, { status: 'sent' });
    } catch (error) {
      this.options.log?.warn({ error, scope, messageId: event.messageId }, '告警初筛任务没起来');
      await repo.updateDecision(scope, id, { status: 'failed' });
    }
  }
  /**
   * 在告警话题里起初筛任务：走和 @ 机器人同一条派发路径，以订阅确认人的身份发起，提示词前加初筛约定。
   * 普通群的告警是顶层消息，先在它下面回一句开出话题，初筛结果和后续追问都在这个话题里。
   */
  private async startTriage(scope: CollaborationScope, event: LarkMessageEvent, config: StoredLarkConfig, alarm: AlarmSubscription, sourceAppId: string) {
    const dispatch = this.dispatchers.get(scope.appId);
    if (!dispatch) throw new RuntimeError('COLLABORATION_DISPATCH_UNAVAILABLE', '机器人还没开始监听', 409);
    const name = alarm.sources.find(item => item.appId === sourceAppId)?.name ?? sourceAppId;
    let thread = event.threadId ? { rootId: event.rootId ?? event.messageId, threadId: event.threadId } : undefined;
    if (!thread) {
      const service = this.options.serviceFor(config);
      const follow = await this.level(scope) === 'mention' ? '追问请 @ 我。' : '在这个话题里直接追问就行，不用 @。';
      const intro = await service.replyText({ messageId: event.messageId, replyInThread: true, text: `收到「${name}」的告警，开始初筛。${follow}`, idempotencyKey: `alarm_${digest([scope, event.messageId])}`.slice(0, 50) });
      const threadId = service.getMessage ? (await service.getMessage(intro.messageId).catch(() => undefined))?.threadId : undefined;
      if (threadId) thread = { rootId: event.messageId, threadId };
    }
    await dispatch({ ...event, ...thread, senderOpenId: alarm.requesterId, senderType: 'user', triage: alarmTriagePrompt(name) }, config);
  }
  /** 把本机器人记成接话人并在群里声明；返回声明有没有发出去。 */
  private async claimResponder(scope: CollaborationScope, config: StoredLarkConfig, actorId: string, replyTo?: { messageId: string; threadId?: string }): Promise<boolean> {
    const repo = this.options.repository;
    const duty = await repo.getDuty(scope);
    await repo.updateDuty(scope, { expectedRevision: duty.revision, responder: { appId: scope.appId, name: botName(config), since: this.now().toISOString() } }, actorId);
    return this.announce(scope, config, responderClaimText(botName(config)), replyTo);
  }
  /**
   * 调档确认后处理接话人：卡上说了要认领、而且确认时还没有别的接话人就认领；改成不接没 @ 消息的档、本 Bot 又是接话人就卸任。
   * 返回接在卡片结果后面的一句话。
   */
  private async levelResponder(record: LarkConfirmRecord, level: ParticipationLevel, operator: string): Promise<string> {
    const repo = this.options.repository;
    const duty = await repo.getDuty(record.scope);
    const self = duty.responder?.appId === record.scope.appId;
    const claim = activeModes.has(level) && record.payload.claim === true && !self;
    if (claim && duty.responder) return `发卡后「${duty.responder.name ?? duty.responder.appId}」已成为本群接话人，没 @ 的消息仍由它接。`;
    if (!claim && (activeModes.has(level) || !self)) return '';
    const config = await this.options.readConfig(record.scope.appId, record.scope.chatId);
    if (!config) throw new RuntimeError('LARK_CONFIG_NOT_FOUND', '机器人配置已不可用。', 409);
    if (claim) {
      const announced = await this.claimResponder(record.scope, config, operator, record.replyTo);
      return announced ? '没 @ 机器人的消息由我接，已在群里发了接话人声明。' : '没 @ 机器人的消息由我接，但群里的声明没发出去，其他机器人可能还不知道；请稍后 @我 再说一次「你负责接话」，我会重发声明。';
    }
    await repo.updateDuty(record.scope, { expectedRevision: duty.revision, responder: null }, operator);
    const announced = await this.announce(record.scope, config, responderReleaseText(botName(config)), record.replyTo);
    return announced ? '我不再接没 @ 机器人的消息，已在群里发了卸任声明。' : '我不再接没 @ 机器人的消息，但卸任声明没发出去，其他机器人可能还以为由我接；需要别的机器人接时，@它 说「你负责接话」。';
  }
  private async announce(scope: CollaborationScope, config: StoredLarkConfig, text: string, replyTo?: { messageId: string; threadId?: string }): Promise<boolean> {
    const service = this.options.serviceFor(config);
    const idempotencyKey = `responder_${digest([scope, text, this.now().getTime()])}`.slice(0, 50);
    try {
      if (replyTo) await service.replyText({ messageId: replyTo.messageId, replyInThread: Boolean(replyTo.threadId), text, idempotencyKey });
      else await service.sendText({ chatId: scope.chatId, text, idempotencyKey });
      return true;
    } catch (error) {
      this.options.log?.warn({ error, scope }, '发送接话人声明失败');
      return false;
    }
  }
  /**
   * Web 群设置改分工。接话人只能设成本 Bot 或清掉：设成本 Bot 时在群里声明，本来是本 Bot 而清掉时发卸任声明，
   * 其他实例据此同步。告警订阅沿用已有的确认人；从没在群里确认过的不能开启，初筛任务要以确认过的人的名义发起。
   */
  async updateDuty(scope: CollaborationScope, patch: { expectedRevision: number; responder?: 'self' | null; alarm?: Omit<AlarmSubscription, 'requesterId'> | null }, actorId: string): Promise<{ duty: CollaborationDuty; announced?: boolean }> {
    const repo = this.options.repository;
    const current = await repo.getDuty(scope);
    if (current.revision !== patch.expectedRevision) throw new RuntimeError('COLLABORATION_REVISION_CONFLICT', '群分工已变化，请刷新后再改。', 409);
    const config = await this.options.readConfig(scope.appId, scope.chatId);
    if (!config) throw new RuntimeError('LARK_CONFIG_NOT_FOUND', '机器人配置已不可用。', 409);
    // 当前档收不到没 @ 的消息时不能当接话人，也不在这里替人调档。
    const level = patch.responder === 'self' ? await this.level(scope) : undefined;
    if (level && !activeModes.has(level)) {
      throw new RuntimeError('COLLABORATION_RESPONDER_NOT_LISTENING', `本 Bot 在这个群现在是「${participationLevelLabels[level]}」，收不到没 @ 的消息，当不了接话人。请先在上面的参与模式里选「按需参与」或「积极参与」并保存设置，再把接话人设成本 Bot。`, 409);
    }
    const wasSelf = current.responder?.appId === scope.appId;
    const responder: UpdateCollaborationDutyInput['responder'] = patch.responder === undefined ? undefined
      : patch.responder === null ? null : wasSelf ? current.responder : { appId: scope.appId, name: botName(config), since: this.now().toISOString() };
    const alarm = patch.alarm && { ...patch.alarm, ...(current.alarm?.requesterId ? { requesterId: current.alarm.requesterId } : {}) };
    if (alarm?.enabled && !alarm.requesterId) {
      throw new RuntimeError('COLLABORATION_ALARM_REQUESTER_REQUIRED', '告警初筛要以在群里确认过的人的名义发起：请先在群里 @机器人 说「这个群的告警来了先帮我看看」并点确认，之后可以在这里改来源和级别。', 409);
    }
    const duty = await repo.updateDuty(scope, { expectedRevision: current.revision, ...(responder !== undefined ? { responder } : {}), ...(patch.alarm !== undefined ? { alarm: alarm ?? null } : {}) }, actorId);
    const announced = patch.responder === 'self' && !wasSelf ? await this.announce(scope, config, responderClaimText(botName(config)))
      : patch.responder === null && wasSelf ? await this.announce(scope, config, responderReleaseText(botName(config))) : undefined;
    return { duty, ...(announced === undefined ? {} : { announced }) };
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
    const members = await this.memberCounts(config, event.chatId);
    const duty = await this.options.repository.getDuty(scope);
    const bots = members && talkingBots(members, duty);
    if (members) { facts.humans = members.humans; facts.bots = bots!.length; }
    const crowded = (bots?.length ?? 0) > 1;
    if (event.threadId && event.rootId && event.rootId !== event.messageId) {
      const root = await read(event.rootId);
      if (root && isSelfMessage(root, config.appId, pending.botOpenId)) facts.threadRootSelf = true;
      // 多机器人群里，话题根是别的机器人发的、或 @ 的是别人，这个话题就不归本机器人。
      else if (root && crowded && (['app', 'bot'].includes(root.sender.type ?? '') || root.mentions.some(mention => mention.id !== pending.botOpenId && mention.id !== config.appId))) facts.threadRootOther = true;
    }
    if (pending.observation.refs.includes(OWNED_TOPIC_REF)) facts.ownedTopic = true;
    // 叫自己名字的消息先由 calls_name 接走，这里列表里含不含自己都一样。
    if (crowded && callsBotName(stripMentionPlaceholders(pending.observation.text), botNameTokens(bots!.map(item => item.name)))) facts.callsOther = true;
    if (duty.responder) facts.responder = duty.responder.appId === config.appId ? 'self' : 'other';
    return facts;
  }
  /** 群里真人和机器人的数量和机器人名单，按群缓存 10 分钟；查不到（没权限、被安全策略截断）时不填，「只有一个真人」「多机器人群」规则不触发。 */
  private async memberCounts(config: StoredLarkConfig, chatId: string): Promise<Members | undefined> {
    const key = keyFor({ appId: config.appId, chatId });
    const now = this.now().getTime();
    const cached = this.members.get(key);
    if (cached && cached.until > now) return cached.value;
    const service = this.options.serviceFor(config);
    let value: Members | undefined;
    if (service.listChatMembers) {
      try {
        const page = await service.listChatMembers({ chatId, memberTypes: ['user', 'bot'], pageSize: 100 });
        const botList = page.items.filter(item => item.memberType === 'bot').map(item => ({ name: item.name, ...(item.appId ? { appId: item.appId } : {}), ...(item.openId ? { openId: item.openId } : {}) }));
        if (!page.securityLimited) value = { humans: page.items.filter(item => item.memberType === 'user').length + (page.hasMore ? 1 : 0), bots: botList.length, botList };
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
    const handled = await this.handleResponderIntent(scope, event, config, text, input).catch(warn('处理接话人短语失败'))
      || Boolean(input.addressed) && await this.handleIntent(scope, event, config, text).catch(warn('处理参与强度短语失败'));
    return { handled, intrusive };
  }
  /** 改参与强度、开关告警初筛发确认卡；「刚才为什么没回」不调模型，直接按判定记录回答。 */
  private async handleIntent(scope: CollaborationScope, event: LarkMessageEvent, config: StoredLarkConfig, text: string): Promise<boolean> {
    const intent = participationIntentOf(text);
    const alarm = intent ? undefined : alarmIntentOf(text);
    const sender = event.senderOpenId;
    // 只回应能在本群使唤机器人的人，与直接 @ 同一套权限；没接线时按普通消息交给 Agent。
    if (!intent && !alarm || !sender || !this.options.canOperate || !await this.options.canOperate(scope, sender, sender)) return false;
    const key = `${intent?.kind ?? 'alarm'}_${digest([scope, event.messageId])}`.slice(0, 50);
    if (!intent) return this.handleAlarmIntent(scope, event, config, alarm!, sender, key);
    if (intent.kind === 'why_silent') {
      await this.replyText(config, event, await this.explainSilence(scope, sender, [event.parentId, event.rootId].filter((id): id is string => Boolean(id))), key);
      return true;
    }
    const label = participationLevelLabels[intent.level], behavior = participationLevelBehaviors[intent.level];
    if (await this.level(scope) === intent.level) { await this.replyText(config, event, `本群已经是「${label}」：${behavior}。`, key); return true; }
    if (!this.options.applyLevel) { await this.replyText(config, event, '这个群暂时不能在群里改参与强度，请在 Dutydeck Web 的群设置里调整。', key); return true; }
    // 接话人跟着档位走：多机器人群没有接话人时，改成按需或积极就一并认领；本 Bot 是接话人而改成不接没 @ 消息的档时一并卸任。
    const duty = await this.options.repository.getDuty(scope);
    const active = activeModes.has(intent.level);
    const members = active && !duty.responder ? await this.memberCounts(config, scope.chatId) : undefined;
    const claim = Boolean(members && talkingBots(members, duty).length > 1);
    const note = claim ? '本群有多个机器人，确认后由我负责接没 @ 的消息，并在群里发接话人声明。'
      : active && duty.responder && duty.responder.appId !== scope.appId ? `本群接话人是「${duty.responder.name ?? duty.responder.appId}」，没 @ 的消息仍由它接；要改由我接，@我 说「你负责接话」。`
      : !active && duty.responder?.appId === scope.appId ? '我现在是本群接话人，确认后在群里发卸任声明，没 @ 的消息不再由我接。' : '';
    const record = await this.confirmations.request({ kind: LEVEL_CONFIRM_KIND, scope, requesterId: sender,
      replyTo: { messageId: event.messageId, ...(event.threadId ? { threadId: event.threadId } : {}) },
      title: '调整参与强度', summary: `把本群改成「${label}」：${behavior}。${note}`, payload: { level: intent.level, ...(claim ? { claim: true } : {}) } });
    if (!record) await this.replyText(config, event, '确认卡没发出去，请稍后再说一次，或在 Dutydeck Web 的群设置里调整。', key);
    return true;
  }
  /**
   * 「这个群由 flash 负责接话」：群里每个 Bot 都收得到这句话，不需要 @。被点名的 Bot 发确认卡，确认后在群里声明；
   * 其他 Bot 不出声（被 @ 时回一句），等收到声明再让出。点的不是群里的机器人时当普通消息。
   */
  private async handleResponderIntent(scope: CollaborationScope, event: LarkMessageEvent, config: StoredLarkConfig, text: string, input: { botOpenId?: string; addressed?: boolean }): Promise<boolean> {
    const intent = responderIntentOf(text);
    const sender = event.senderOpenId;
    if (!intent || !sender || !this.options.canOperate) return false;
    const target = await this.responderTarget(config, event, intent.name, input.botOpenId);
    if (!target && !input.addressed || !await this.options.canOperate(scope, sender, sender)) return false;
    const key = `responder_${digest([scope, event.messageId])}`.slice(0, 50);
    if (!target) {
      await this.replyText(config, event, intent.name ? `群里没找到叫「${intent.name}」的机器人。` : '没看出要让哪个机器人接话，请 @ 它说「你负责接话」。', key);
      return true;
    }
    if (target !== 'self') {
      if (input.addressed) await this.replyText(config, event, `好的，等「${target}」在群里确认后，没 @ 的消息交给它接。`, key);
      return true;
    }
    // 接话人要收得到没 @ 的消息：当前档不接时，确认卡同时把档调到按需。
    const level = await this.level(scope);
    const deaf = !activeModes.has(level);
    if (deaf && !this.options.applyLevel) {
      await this.replyText(config, event, `${deafLevelText(level)}，当不了接话人；这个群暂时不能在群里改参与强度，请先在 Dutydeck Web 的群设置里把参与模式调到按需或积极，再说一次「你负责接话」。`, key);
      return true;
    }
    if (!deaf && (await this.options.repository.getDuty(scope)).responder?.appId === scope.appId) {
      // 已经是接话人：回复本身就是一条声明，之前声明没发出去或别的实例错过了，这样能补上。
      await this.replyText(config, event, responderClaimText(botName(config)), key);
      return true;
    }
    const record = await this.confirmations.request({ kind: RESPONDER_CONFIRM_KIND, scope, requesterId: sender,
      replyTo: { messageId: event.messageId, ...(event.threadId ? { threadId: event.threadId } : {}) }, title: '指定接话人',
      summary: `${deaf ? `${deafLevelText(level)}，确认后调到「按需」并负责接话：` : ''}由我（${botName(config)}）接本群没 @ 机器人的消息。确认后我在群里发一条声明，其他 Dutydeck 机器人收到后只接 @ 和自己接手的话题。`,
      payload: deaf ? { level: 'selective' } : {} });
    if (!record) await this.replyText(config, event, '确认卡没发出去，请稍后再说一次，或在 Dutydeck Web 的群设置里指定。', key);
    return true;
  }
  /** 接话人说法指的是谁：本机器人返回 self，群里别的机器人返回它的名字，认不出返回 undefined。 */
  private async responderTarget(config: StoredLarkConfig, event: LarkMessageEvent, name: string, botOpenId?: string): Promise<string | undefined> {
    if (!name) {
      if (botOpenId && event.mentions.some(mention => mention.openId === botOpenId)) return 'self';
      const bots = event.mentions.filter(mention => mention.mentionedType === 'bot');
      return bots.length === 1 ? bots[0]!.name : undefined;
    }
    const wanted = compactText(name);
    const named = (names: Array<string | undefined>) => botNameTokens(names).some(token => compactText(token) === wanted);
    if (named([config.name, config.displayName])) return 'self';
    return (await this.memberCounts(config, event.chatId))?.botList.find(item => named([item.name]))?.name;
  }
  /** 开关告警初筛：发确认卡，写明来源、级别和去重上限。 */
  private async handleAlarmIntent(scope: CollaborationScope, event: LarkMessageEvent, config: StoredLarkConfig, intent: AlarmIntent, sender: string, key: string): Promise<boolean> {
    const duty = await this.options.repository.getDuty(scope);
    const replyTo = { messageId: event.messageId, ...(event.threadId ? { threadId: event.threadId } : {}) };
    if (intent.kind === 'unsubscribe') {
      if (!duty.alarm?.enabled) { await this.replyText(config, event, '本群没开告警初筛。', key); return true; }
      const record = await this.confirmations.request({ kind: ALARM_CONFIRM_KIND, scope, requesterId: sender, replyTo, title: '关闭告警初筛',
        summary: `不再自动初筛本群告警（${describeAlarm(duty.alarm)}）。订阅设置会保留，之后说「告警来了先帮我看看」可以再打开。`, payload: { enabled: false } });
      if (!record) await this.replyText(config, event, '确认卡没发出去，请稍后再说一次，或在 Dutydeck Web 的群设置里关闭。', key);
      return true;
    }
    if (duty.responder && duty.responder.appId !== scope.appId) {
      await this.replyText(config, event, `本群接话人是「${duty.responder.name ?? duty.responder.appId}」，告警初筛只由接话人做。要我来做，先 @我 说「你负责接话」。`, key);
      return true;
    }
    const { chosen, others } = await this.alarmSources(event, config, duty);
    if (!chosen.length) {
      await this.replyText(config, event, '最近没看到别的机器人在本群发消息，不知道该订阅哪个告警来源。请在告警消息下面回复我再说一次，或在 Dutydeck Web 的群设置里填写来源。', key);
      return true;
    }
    const alarm = { sources: chosen, levels: intent.levels.length ? intent.levels : duty.alarm?.levels ?? [],
      dedupeHours: duty.alarm?.dedupeHours ?? ALARM_DEDUPE_HOURS, maxPerHour: duty.alarm?.maxPerHour ?? ALARM_MAX_PER_HOUR };
    const record = await this.confirmations.request({ kind: ALARM_CONFIRM_KIND, scope, requesterId: sender, replyTo, title: '开启告警初筛',
      summary: `${describeAlarm(alarm)}。告警来了我在告警话题里先做初筛，任务以确认人的名义发起。${others.length
        ? `最近在本群发过消息的机器人还有：${others.map(item => item.name ?? item.appId).join('、')}；来源不对可以在 Dutydeck Web 的群设置里改。` : ''}`,
      payload: { enabled: true, sources: JSON.stringify(alarm.sources), levels: JSON.stringify(alarm.levels), dedupeHours: alarm.dedupeHours, maxPerHour: alarm.maxPerHour } });
    if (!record) await this.replyText(config, event, '确认卡没发出去，请稍后再说一次，或在 Dutydeck Web 的群设置里开启。', key);
    return true;
  }
  /** 订阅哪个来源：回复或话题里的那条机器人消息优先；没有就沿用已有订阅；再没有就看最近 50 条消息里发过言的机器人，发得最多的排第一。 */
  private async alarmSources(event: LarkMessageEvent, config: StoredLarkConfig, duty: CollaborationDuty): Promise<{ chosen: AlarmSubscription['sources']; others: AlarmSubscription['sources'] }> {
    const service = this.options.serviceFor(config);
    const members = await this.memberCounts(config, event.chatId);
    const source = (appId: string) => { const name = members?.botList.find(item => item.appId === appId)?.name; return { appId, ...(name ? { name } : {}) }; };
    // 消息读取接口把机器人发送者报成 app_id。
    const otherBot = (message: Pick<LarkChatMessage, 'sender' | 'chatId'>) => ['app', 'bot'].includes(message.sender.type ?? '') && Boolean(message.sender.id?.startsWith('cli_'))
      && message.sender.id !== config.appId && (!message.chatId || message.chatId === event.chatId);
    for (const anchor of new Set([event.parentId, event.rootId])) {
      if (!anchor || anchor === event.messageId || !service.getMessage) continue;
      const message = await service.getMessage(anchor).catch(() => undefined);
      if (message && otherBot(message)) return { chosen: [source(message.sender.id!)], others: [] };
    }
    if (duty.alarm?.sources.length) return { chosen: duty.alarm.sources, others: [] };
    const recent = await service.listChatMessages({ chatId: event.chatId, order: 'desc', pageSize: 50 }).then(page => page.items, () => []);
    const counts = new Map<string, number>();
    for (const item of recent) if (!item.deleted && otherBot(item)) counts.set(item.sender.id!, (counts.get(item.sender.id!) ?? 0) + 1);
    const ranked = [...counts].sort((left, right) => right[1] - left[1]).map(([appId]) => source(appId));
    return { chosen: ranked.slice(0, 1), others: ranked.slice(1) };
  }
  private async replyText(config: StoredLarkConfig, event: LarkMessageEvent, text: string, idempotencyKey: string) {
    await this.options.serviceFor(config).replyText({ messageId: event.messageId, replyInThread: Boolean(event.threadId), text, idempotencyKey });
  }
  /**
   * 按这个人最近一小时在本群被判为不接的那条消息说明原因；没有这样的记录时说明闸门或档位。
   * 在某条告警下面问（anchors 是回复的消息和话题根）时，按那条告警的处理记录回答。
   */
  private async explainSilence(scope: CollaborationScope, senderId: string, anchors: string[] = []): Promise<string> {
    const since = this.now().getTime() - WHY_WINDOW_MS;
    const [settings, decisions] = await Promise.all([this.options.repository.getSettings(scope), this.options.repository.listDecisions(scope, DECISION_WINDOW_LIMIT)]);
    const alarm = decisions.find(item => isAlarmRecord(item) && anchors.includes(decisionTrigger(item)?.messageId ?? ''));
    if (alarm) return alarm.action === 'act' ? `${clock(alarm.createdAt)} 那条告警已经起了初筛任务，结果在告警话题里。` : `${clock(alarm.createdAt)} 那条告警我没分析：${alarm.reason}。`;
    const recent = decisions.filter(item => Date.parse(item.createdAt) >= since);
    const level = await this.level(scope, settings);
    const hint = level === 'eager' ? '' : '想让我多接话，可以 @ 我说「积极点」。';
    const silent = recent.find(item => item.action === 'silent' && !isDecisionGate(item) && decisionTrigger(item)?.senderId === senderId);
    if (silent) {
      const trigger = decisionTrigger(silent);
      const meta = deciderMetaOf(silent);
      const rule = meta?.kind === 'rule' ? participationRuleReasons[meta.rule as ParticipationRule] : undefined;
      const why = rule ?? (silent.status === 'failed' ? '那次判断没跑成，按规定不出声' : `我判断不是在叫我（${silent.reason.slice(0, 200)}）`);
      // 对别人说的话不该接，就不再提示调档；多机器人群里是接话人的事，提示指定接话人。
      const ruleHint = meta?.rule === 'no_responder' ? '要我接，@我 说「你负责接话」。'
        : ['mentions_other', 'reply_to_other', 'calls_other', 'topic_of_other', 'not_responder'].includes(meta?.rule ?? '') ? '' : hint;
      return `${clock(silent.createdAt)} 那条「${snippet(trigger?.text)}」我没接：${why}。${ruleHint}`;
    }
    // 告警订阅跳过的告警不是这个人的消息，附在说明后面。
    const skipped = recent.find(item => isAlarmRecord(item) && item.action === 'silent');
    const alarmNote = skipped ? `另外，${clock(skipped.createdAt)} 那条告警「${snippet(decisionTrigger(skipped)?.text)}」我没分析：${skipped.reason}。` : '';
    const gate = recent.find(item => isDecisionGate(item) && [DECISION_BUDGET_GATE, USAGE_CAP_GATE].includes(String((item.inputSnapshot as { gate?: unknown }).gate)));
    if (gate) return `最近一小时没有判断新消息：${gate.reason}。${alarmNote}`;
    if (settings.participation === 'observe') return `本群目前只观察，不主动接话；判断结果只留记录，不会发出来。${alarmNote}`;
    if (level === 'mention' || level === 'topic') return `本群是「${participationLevelLabels[level]}」：${participationLevelBehaviors[level]}，所以没 @ 我的消息我不会接。${hint}${alarmNote}`;
    return `最近一小时没有你的消息被我判为不接。可能那条消息在我处理别的消息时被合并跳过了，直接 @ 我再说一次就行。${hint}${alarmNote}`;
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
