import { larkMessageAnchor } from './message-anchor.js';
import { describeLarkTaskRecovery } from './task-recovery.js';
import { permissionDisplayText, timeLoop } from '@dutydeck/shared';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentEvent, ConfigRepository, PermissionRequestData, PolicyAction } from '@dutydeck/shared';
import type { RelayAskBroker, RelayAskChoice, RelayDeferredAsk } from '@dutydeck/relay';
import type { LarkMessageEvent, LarkRuntime, ListenerLog } from './listener.js';
import { LarkServiceError, buildLarkCard, larkCardSafeLimits } from './service.js';
import type { LarkCardService } from './service.js';
import { safeLarkWebUrl } from './card-actions.js';
import { countCardComponents } from './card-elements.js';
import { isBotSenderType, isGroupChat, renderGroupMention } from './card-mentions.js';
import { isLarkMessageUnupdatable, type LarkCardElement } from './card-renderer.js';
import { sendLarkFile } from './result-delivery.js';
import { renderQuestionMarkdown } from './ask-markdown.js';
import { LarkUrgentManager, type LarkUrgentCheckResult } from './workflow-urgent.js';
import { larkCommandEcho } from './commands.js';
import { escapeLarkPromptEcho } from './queue-summary.js';
import { redactTraceText } from './secret-redaction.js';
import { testRegexWithTimeout } from '@dutydeck/acp-client';
import { permissionIntent } from './permission-intent.js';
import { planClosedText, planPendingElements, planStaleText, type LarkPlanDecision } from './plan-flow.js';

export { countCardComponents } from './card-elements.js';

/**
 * 询问（ask）问题正文保留 Markdown 网页链接，改用 markdown 元素；
 * 授权（permission）问题来自受控命令拼装，不需要任何 Markdown，继续用 plain_text。
 */
const questionElement = (kind: LarkInteraction['kind'], question: string): LarkCardElement => {
  const content = kind === 'ask' ? question : question.slice(0, 6000);
  return kind !== 'permission'
    ? { tag: 'markdown', content: renderQuestionMarkdown(content) }
    : { tag: 'div', text: { tag: 'plain_text', content } };
};

export interface LarkInteractionContext {
  appId: string;
  sessionId: string;
  taskId: string;
  /** 与任务进度卡使用同一份标题；旧记录缺省时沿用原卡名称。 */
  taskName?: string;
  turn: number;
  event: LarkMessageEvent;
}
export interface LarkInteraction extends LarkInteractionContext {
  id: string;
  boot: string;
  /** plan：先出计划的计划卡，挂在计划轮的结果卡上；不随服务重启失效，按 24 小时上限过期。 */
  kind: 'ask' | 'permission' | 'result' | 'plan';
  nativeId: string;
  question: string;
  state: 'pending' | 'resolving' | 'answered' | 'approved' | 'rejected' | 'expired' | 'accepted' | 'needs_changes';
  cardId?: string;
  relatedCardIds?: string[];
  expiresAt?: string;
  updatedAt: string;
  actorId?: string;
  /** ask 渲染时是否带结构化选项（单选/多选）；缺省为自由文本问答 */
  structured?: boolean;
  /** Persisted confirmation, detached from the original relay waiter and boot. */
  deliveryAttempts?: number;
  deliveryRetryAt?: number;
  durable?: { choices: RelayAskChoice[]; snapshot: { prompt: string; cwd: string; scopeId: string }; answer?: string; selected?: string[] };
  /** structured=true 时是否多选；缺省/false 为单选 */
  multiple?: boolean;
  /** 已加急时间戳（ISO 字符串），每条卡片最多加急一次 */
  urgentAt?: string;
  /** 卡片创建并绑定时间戳 */
  cardCreatedAt?: string;
  /** 目标提问/审批人 openId（缺省为 context.event.senderOpenId） */
  targetUserId?: string;
  /** permission 无人处理满 30 分钟后的提醒已发出的时间戳，每条审批最多提醒一次 */
  remindedAt?: string;
  /** permission 超过 24 小时上限仍无人处理、已自动拒绝的时间戳；expired 状态下据此区分「已过期」与「已失效」 */
  timedOutAt?: string;
  /** 审批卡顶部那句「要做什么」，由工具类别和参数确定性生成；升级前的记录没有 */
  intent?: string;
  /** 可以「本会话允许」时这条命令的精确匹配键；高危、被脱敏或被截断的命令不设，卡上也不给按钮 */
  sessionAllowKey?: string;
  /** 建卡时群 @ 开关是否开启；截止前提醒据此决定要不要 @ */
  groupMention?: boolean;
  /** plan：用户在计划卡上的决定与修改意见，进入 resolving 时写入，重启后据此补完提交 */
  decision?: LarkPlanDecision;
  feedback?: string;
  /** ask 实际展示的正文、选项与全文附件提示，关闭卡复用同一份内容。 */
  askContentElements?: LarkCardElement[];
  /** 建卡时的显示模式，终态重绘和重启修复沿用。 */
  adhdMode?: boolean;
  /** 终态卡回执和有界重试记录，保存在已有配置记录中。 */
  closeMessage?: string;
  answerLabel?: string;
  closeAttempts?: number;
  closeRetryAt?: number;
  cardClosedAt?: string;
}
export const deadlineText = (expiresAt: string) => `${new Date(expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）`;
/**
 * 权限卡审批硬上限：任务一直等审批，超过这个时长仍无人处理才自动拒绝。
 * 用户离开几个小时回来仍能批准；上限只防一张没人点的卡无限期堵住同一会话后面的任务。
 */
export const larkPermissionTimeoutMs = 24 * 60 * 60_000;
/** 审批发出后无人处理满这个时长，在原话题提醒一次；任务继续等待。 */
export const larkPermissionReminderAfterMs = 30 * 60_000;
const timeoutHours = larkPermissionTimeoutMs / 3_600_000;
/** 超时拒绝时交给 Agent 的原因（PTY 驱动会把它作为拒绝说明转告 CLI）。 */
export const larkPermissionTimeoutReason = `超过 ${timeoutHours} 小时未处理，已自动拒绝`;
/** 审批卡上说明等待与上限的那一行。 */
const permissionDeadlineNotice = (expiresAt: string) =>
  `任务会一直等待审批：${larkPermissionReminderAfterMs / 60_000} 分钟无人处理会提醒一次，超过 ${timeoutHours} 小时未处理才自动拒绝（${deadlineText(expiresAt)}）。`;
/** 审批卡顶部的意图摘要；升级前的记录没有，不渲染。 */
const intentElements = (record: Pick<LarkInteraction, 'kind' | 'intent'>): LarkCardElement[] =>
  record.kind === 'permission' && record.intent ? [{ tag: 'div', text: { tag: 'plain_text', content: record.intent } }] : [];
/** 同一任务连续来审批时，60 秒内只在第一张卡上 @ 人。 */
const approvalMentionWindowMs = 60_000;
/** 发起人不能批准时，一张卡最多 @ 几位被授予高风险审批的成员。 */
const maxMentionedApprovers = 3;
/** 北京时间的 HH:MM，与 coordinator-cards 的卡片时间同一写法。 */
const shanghaiClockFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const shanghaiClock = (at: number) => shanghaiClockFormat.format(at);
/**
 * 「本会话允许此命令」的精确匹配键：目录、资源、命令逐字相同才算同一条。
 * 执行端交来的是脱敏、截断后的事实，被脱敏或截断过的命令已经不能逐字比对；高危判定复用
 * 部署配置的高危正则。这几种情况都不给按钮，宁可每次都问。
 */
const sessionAllowKey = async (request: PermissionRequestData, highRiskPattern?: string) => {
  const operation = request.operation;
  if (!operation?.command || !highRiskPattern) return undefined;
  const facts = [operation.cwd ?? '', operation.resource ?? '', operation.command];
  if (facts.some(fact => fact.includes('[REDACTED]') || fact.endsWith('…'))) return undefined;
  // 与执行端拦截同一口径：标题和各项事实逐行拼起来，放进带硬超时的隔离线程匹配。
  // 正则由部署者配置，灾难性回溯不能卡住服务主线程；超时或出错都按可能高危处理。
  if (await testRegexWithTimeout(highRiskPattern, [request.title, ...facts].join('\n')).catch(() => true)) return undefined;
  return createHash('sha256').update(facts.join('\0')).digest('hex');
};
/** 文字回复对上某个选项：忽略大小写与首尾空白后等于选项文本、提交值或序号，返回该选项的提交值。 */
const matchChoice = (choices: RelayAskChoice[], text: string) => {
  const reply = text.trim().toLowerCase();
  const choice = choices.find((item, index) => [item.label, item.value ?? item.label, String(index + 1)].some(candidate => candidate.trim().toLowerCase() === reply));
  return choice ? choice.value ?? choice.label : undefined;
};
const mentions = (openIds: string[]) => openIds.map(renderGroupMention).filter(Boolean).join(' ');
/** 审批与计划卡共用的时限：30 分钟提醒、24 小时上限。 */
const hasDeadline = (record: LarkInteraction) => record.kind === 'permission' || record.kind === 'plan';
const pastDeadline = (record: LarkInteraction, now = Date.now()) => hasDeadline(record) && Boolean(record.expiresAt) && Date.parse(record.expiresAt!) <= now;
const prefix = (appId: string) => `lark.interaction.${appId}.`;
const stale = () => new LarkServiceError('LARK_INTERACTION_EXPIRED', '此操作已处理或失效。请发送 `/status` 查看任务状态，不要重复操作旧卡。', 409);
const button = (record: LarkInteraction, action: string, label: string): LarkCardElement => ({
  tag: 'button', element_id: `workflow_${action}`, text: { tag: 'plain_text', content: label }, type: action === 'approve' ? 'primary' : 'default',
  behaviors: [{ type: 'callback', value: { dutydeck_workflow: action, request_id: record.id, generation: record.boot } }]
});

/** 单选：每个选项一个回调按钮，点按即提交，回调 value 复用 dutydeck_workflow 命名空间。 */
const singleChoiceElements = (record: LarkInteraction, choices: RelayAskChoice[]): LarkCardElement[] =>
  choices.map((choice, index) => ({
    tag: 'button', element_id: `workflow_answer_choice_${index}`, type: record.adhdMode === true && choices.length === 1 ? 'primary' : 'default',
    text: { tag: 'plain_text', content: choice.label },
    behaviors: [{ type: 'callback', value: {
      dutydeck_workflow: 'answer', request_id: record.id, generation: record.boot,
      answer: choice.value ?? choice.label
    } }]
  }));

/**
 * 多选：JSON 2.0 原生表单（form + multi_select_static + form_action_type:'submit' 按钮）。
 * 提交时按钮 value 仍走 dutydeck_workflow，所选值由平台放在 event.action.form_value.answer（string[]）。
 */
const multipleChoiceForm = (record: LarkInteraction, choices: RelayAskChoice[]): LarkCardElement => ({
  tag: 'form', element_id: 'workflow_answer_form', name: `workflow_ask_${record.id}`,
  direction: 'vertical', vertical_spacing: '8px', margin: '0px',
  elements: [
    { tag: 'multi_select_static', element_id: 'workflow_answer_select', name: 'answer', behaviors: [],
      placeholder: { tag: 'plain_text', content: '选择一个或多个选项' },
      options: choices.map(choice => ({ text: { tag: 'plain_text', content: choice.label }, value: choice.value ?? choice.label })) },
    { tag: 'button', element_id: 'workflow_answer_submit', type: 'primary',
      text: { tag: 'plain_text', content: '提交选择' }, form_action_type: 'submit',
      behaviors: [{ type: 'callback', value: { dutydeck_workflow: 'answer', request_id: record.id, generation: record.boot, multiple: true } }] }
  ]
});

/** 自由文本：JSON 2.0 原生 input（multiline，平台上限 max_length 1000）+ 提交按钮。 */
const freeTextForm = (record: LarkInteraction): LarkCardElement => ({
  tag: 'form', element_id: 'workflow_answer_form', name: `workflow_ask_${record.id}`,
  direction: 'vertical', vertical_spacing: '8px', margin: '0px',
  elements: [
    { tag: 'input', element_id: 'workflow_answer_input', name: 'answer',
      input_type: 'multiline_text', max_length: 1000,
      placeholder: { tag: 'plain_text', content: '输入回答后点提交' } },
    { tag: 'button', element_id: 'workflow_answer_submit', type: 'primary',
      text: { tag: 'plain_text', content: '提交回答' }, form_action_type: 'submit',
      behaviors: [{ type: 'callback', value: { dutydeck_workflow: 'answer', request_id: record.id, generation: record.boot } }] }
  ]
});

/** 给 reply 时才注入的 header/agentName 等固定开销留 1KB 余量，按 24KB/180 做真整卡试算。 */
const structuredCardBudgetHeadroomBytes = 1024;

export interface LarkWorkflowUrgentOptions {
  enabled?: boolean;
  /** 卡片发出后无人处理的加急超时阈值（毫秒），默认 10 分钟 (600,000ms) */
  thresholdMs?: number;
  /** 每个群每小时最多加急次数，默认 3 次 */
  maxPerHourPerChat?: number;
  /** 免打扰时段 HH:MM-HH:MM；时段内不发加急，结束后补发。 */
  quietHours?: string;
}

export interface LarkWorkflowInteractionsOptions {
  log?: Pick<ListenerLog, 'warn'>;
  /** 计划卡上批准或提修改意见后，以操作人身份提交下一轮；重复调用必须幂等（重启后会补调） */
  onPlanDecision?: (record: LarkInteraction) => Promise<void>;
  onConfirmation?: (record: LarkInteraction) => Promise<void>;
  confirmationAvailable?: (record: LarkInteraction) => Promise<boolean>;
  urgentManager?: LarkUrgentManager;
  urgent?: boolean | LarkWorkflowUrgentOptions;
  /** 发起人不能批准时，群里还有谁可能批准（被授予高风险审批的成员）；是否真能批准仍逐个走 authorize */
  approverCandidates?: (record: LarkInteraction) => Promise<string[]>;
}

/** Persisted cards identify a live waiter; history never recreates executable approvals. */
export class LarkWorkflowInteractions {
  readonly boot = randomUUID();
  private closed = false;
  private repairWait?: { timer: NodeJS.Timeout; release(): void };
  private repairCancelled = false;
  private readonly closedCards = new Set<string>();
  private readonly closingCards = new Map<string, Promise<void>>();
  private readonly deferredCloses = new Map<string, { active: number; timer?: NodeJS.Timeout }>();
  private readonly log?: Pick<ListenerLog, 'warn'>;
  private readonly delivering = new Set<string>();
  private readonly retryAfter = new Map<string, number>();
  urgentManager?: LarkUrgentManager;
  /** 当前生效的加急设置签名；相同就不重建 manager，避免每次对账都丢掉内存去重。 */
  private urgentSignature?: string;
  /** 「本会话允许」的命令只记在内存里，按会话存精确匹配键：服务重启或换了会话都不再生效。 */
  private readonly sessionAllowed = new Map<string, Set<string>>();
  /** 每个任务上一次在审批卡上 @ 人的时间。 */
  private readonly approvalMentionedAt = new Map<string, number>();
  /** 正在按「本会话允许」自动批准的请求，重复事件不再重复提交。 */
  private readonly autoApproving = new Set<string>();
  private readonly approverCandidates?: (record: LarkInteraction) => Promise<string[]>;
  private readonly onConfirmation?: (record: LarkInteraction) => Promise<void>;
  private readonly confirmationAvailable?: (record: LarkInteraction) => Promise<boolean>;
  private readonly confirming = new Set<string>();
  private readonly onPlanDecision?: (record: LarkInteraction) => Promise<void>;
  /** 每个 App 一个计时器，处理计划卡截止/提醒和终态卡关闭重试；无活跃任务时也能恢复。 */
  private readonly planTimers = new Map<string, NodeJS.Timeout>();
  constructor(
    private readonly store: ConfigRepository,
    private readonly runtime: LarkRuntime,
    private readonly service: LarkCardService,
    private readonly broker: RelayAskBroker | undefined,
    private readonly authorize: (record: LarkInteraction, actor: string, action: PolicyAction) => Promise<boolean>,
    options?: LarkWorkflowInteractionsOptions
  ) {
    if (!store.compareAndSet || !store.list) throw new Error('Lark workflows require persistent CAS and prefix listing');
    this.configureUrgent(options?.urgent, options?.urgentManager);
    this.approverCandidates = options?.approverCandidates;
    this.onPlanDecision = options?.onPlanDecision;
    this.onConfirmation = options?.onConfirmation;
    this.confirmationAvailable = options?.confirmationAvailable;
    this.log = options?.log;
  }

  /**
   * 按当前配置决定要不要加急，以及用什么阈值。
   *
   * 加急开关在 Bot 配置里，而构造协调器时还读不到配置，所以必须能在拿到配置之后再落一次；
   * 传 false / undefined 会把已有的 manager 撤掉——把开关关掉的人期待的正是「立刻不再发」。
   * 设置没变时保留原 manager，否则每次对账重建都会丢掉它的内存去重。
   */
  configureUrgent(urgent: boolean | LarkWorkflowUrgentOptions | undefined, urgentManager?: LarkUrgentManager) {
    const enabled = typeof urgent === 'boolean'
      ? urgent
      : (typeof urgent === 'object' && urgent !== null && urgent.enabled !== false);
    if (!enabled) { this.urgentManager = undefined; this.urgentSignature = undefined; return; }
    const config = typeof urgent === 'object' && urgent !== null ? urgent : {};
    const signature = JSON.stringify([config.thresholdMs ?? null, config.maxPerHourPerChat ?? null, config.quietHours ?? null, Boolean(urgentManager)]);
    if (this.urgentManager && this.urgentSignature === signature) return;
    this.urgentSignature = signature;
    this.urgentManager = urgentManager ?? new LarkUrgentManager({
      service: this.service,
      thresholdMs: config.thresholdMs,
      maxPerHourPerChat: config.maxPerHourPerChat,
      quietHours: config.quietHours,
      onUrged: async (record, urgentAt) => {
        try {
          const current = await this.store.get(this.key(record));
          if (!current) return;
          const parsed = JSON.parse(current) as LarkInteraction;
          const next = { ...parsed, urgentAt };
          await this.store.compareAndSet!(this.key(record), current, JSON.stringify(next));
        } catch { /* best effort */ }
      }
    });
  }
  private key(record: Pick<LarkInteraction, 'appId' | 'id'>) { return prefix(record.appId) + record.id; }
  async list(appId: string): Promise<LarkInteraction[]> {
    return (await this.store.list!(prefix(appId))).map(row => JSON.parse(row.value));
  }
  async get(appId: string, id: string): Promise<LarkInteraction | undefined> {
    const raw = await this.store.get(this.key({ appId, id }));
    return raw ? JSON.parse(raw) as LarkInteraction : undefined;
  }
  async initialize(appId: string) {
    for (let record of await this.list(appId)) {
      record = await this.refreshPermissionDecision(record);
      if (record.durable && ['pending', 'resolving'].includes(record.state)) {
        await this.reconcileConfirmation(record).catch(error => this.log?.warn({ error, requestId: record.id }, 'Recovering durable confirmation failed'));
        continue;
      }
      if (record.kind === 'plan' && record.state === 'resolving') {
        // 上个进程提交决定到一半：重新提交（幂等）后收尾。
        await this.finishPlan(record).catch(() => undefined);
        continue;
      }
      if (record.kind === 'plan' && record.state === 'pending' && !pastDeadline(record)) continue;
      if (record.kind !== 'result' && !['pending', 'resolving'].includes(record.state)) {
        await this.renderClosed(record, await this.closedMessage(record));
      } else if (record.state === 'pending' && pastDeadline(record)) {
        // 截止时间在停机或协调器重建期间已过：按持久化的 expiresAt 补做超时处理，执行端仍挂着这条请求时一并拒绝。
        await this.timeoutPermission(record);
      } else if (record.kind !== 'result' && ['pending', 'resolving'].includes(record.state)) {
        // 快照与 move 之间记录可能已被旧协调器的 in-flight 终态处理移走（stop 不拦截
        // detached 续跑）；那种情况下重启收敛的目标已经达成，重读确认后不再重复处理，
        // 绝不能把别人的 resolved 决议倒回 expired。
        let target: LarkInteraction;
        try { target = await this.move(record, 'expired'); }
        catch (error) {
          if (!(error instanceof LarkServiceError) || error.code !== 'LARK_INTERACTION_EXPIRED') throw error;
          const current = await this.store.get(this.key(record));
          if (!current) continue;
          const stored = JSON.parse(current) as LarkInteraction;
          if (!['pending', 'resolving'].includes(stored.state)) continue;
          target = stored;
        }
        await this.renderClosed(target, await this.expiryMessage(target));
      }
    }
    await this.schedulePlanCheck(appId);
  }
  private async expiryMessage(record: LarkInteraction) {
    if (record.kind === 'ask' && record.adhdMode === true) return '已结束，未执行';
    // 超时的时刻就是截止时间：停机期间到期、重启后才补做的，也按截止时间写。
    if (record.timedOutAt && record.expiresAt) return `超时自动拒绝 · ${shanghaiClock(Date.parse(record.expiresAt))}\n\n超过 ${timeoutHours} 小时未处理，这次操作没有执行，不再接受批准；需要的话请重新发起。`;
    if (record.kind === 'plan') return planStaleText;
    const task = (await this.runtime.getTasks?.(record.sessionId))?.find(item => item.id === record.taskId);
    const recovery = task && ['queued', 'reconcile_required', 'legacy_unresolved'].includes(task.status) ? await describeLarkTaskRecovery(this.runtime, record.sessionId, record.taskId, task.status) : undefined;
    if (recovery?.blocked || recovery?.label === '已核对，结果未确认') {
      return `此请求已失效，不再接受回答或批准。\n\n${recovery.markdown}`;
    }
    return `${record.expiresAt ? `回答截止时间：${deadlineText(record.expiresAt)}。\n\n` : ''}此请求已失效，不再接受回答或批准。发送 /status 查看任务状态，不要回复这张旧卡。`;
  }
  /** Heartbeats also repair persisted cards whose broker waiter has already ended. */
  async reconcile(appId: string, taskId?: string) {
    let unresolved = 0;
    for (let record of await this.list(appId)) {
      if (record.kind === 'result' || (taskId && record.taskId !== taskId)) continue;
      const receipt = await this.permissionReceipt(record);
      record = await this.refreshPermissionDecision(record, receipt);
      if (record.durable && ['pending', 'resolving'].includes(record.state)) {
        try { record = await this.reconcileConfirmation(record); if (record.state === 'pending') unresolved++; }
        catch (error) { this.log?.warn({ error, requestId: record.id }, 'Reconciling durable confirmation failed'); unresolved++; continue; }
      }
      if (record.state === 'pending' && !await this.live(record)) {
        // Runtime hides a permission while its decision is being submitted.
        // A still-running task with a pending receipt has no expiry evidence.
        if (record.kind === 'permission' && record.boot === this.boot && receipt?.status === 'pending'
          && (await this.runtime.getTasks?.(record.sessionId))?.some(task => task.id === record.taskId && task.status === 'running')) continue;
        if (record.kind === 'ask' && this.broker?.get(record.nativeId)?.status === 'answering') continue;
        try { record = await this.move(record, 'expired'); } catch { continue; }
      }
      if (record.state === 'pending') record = await this.enforcePermissionDeadline(record);
      if (!['pending', 'resolving'].includes(record.state) && !await this.renderClosed(record, await this.closedMessage(record))) {
        const current = await this.current(record);
        if ((current.closeAttempts ?? 0) < 5) unresolved++;
      }
    }
    if (!taskId) await this.schedulePlanCheck(appId);
    if (this.urgentManager) {
      await this.checkAndUrgePending(appId).catch(() => undefined);
    }
    return unresolved;
  }
  async checkAndUrgePending(appId: string, options?: { now?: number }): Promise<LarkUrgentCheckResult> {
    if (!this.urgentManager) return { checked: 0, urged: [], skippedRateLimited: [], skippedNotEligible: [], skippedQuietHours: [], failed: [] };
    const records = await this.list(appId);
    return this.urgentManager.checkAndUrge(records, options?.now);
  }
  private async permissionReceipt(record: LarkInteraction): Promise<PermissionRequestData | undefined> {
    if (record.kind !== 'permission' || record.timedOutAt || !['pending', 'resolving', 'expired'].includes(record.state)) return undefined;
    if (this.runtime.getLatestPermissionRequest) {
      const event = await this.runtime.getLatestPermissionRequest(record.sessionId, record.taskId, record.nativeId);
      return event?.data as PermissionRequestData | undefined;
    }
    const events = await this.runtime.getEvents?.(record.sessionId);
    const event = events?.slice().reverse().find(event => event.type === 'permission_request' && event.taskId === record.taskId
      && (event.data as PermissionRequestData).id === record.nativeId);
    return event?.data as PermissionRequestData | undefined;
  }
  private async refreshPermissionDecision(record: LarkInteraction, ...receipts: [PermissionRequestData?]) {
    // An explicitly supplied undefined means this reconciliation already queried.
    const receipt = receipts.length ? receipts[0] : await this.permissionReceipt(record);
    if (receipt?.status !== 'approved' && receipt?.status !== 'rejected') return record;
    for (let attempt = 0; attempt < 3; attempt++) {
      // Finish any older expiry PATCH before writing the accepted decision, so
      // a delayed provider response cannot replace the final approval card.
      await this.closingCards.get(record.id);
      const current = await this.current(record);
      if (this.closingCards.has(record.id)) continue;
      if (current.timedOutAt || ['approved', 'rejected'].includes(current.state)
        || current.state === 'resolving' && current.boot === this.boot) return current;
      try {
        return await this.move(current, receipt.status, undefined, { closeMessage: undefined, cardClosedAt: undefined, closeAttempts: 0, closeRetryAt: undefined });
      } catch (error) {
        if (!(error instanceof LarkServiceError) || error.code !== 'LARK_INTERACTION_EXPIRED') throw error;
      }
    }
    return this.current(record);
  }
  private async closedMessage(record: LarkInteraction) {
    if (record.state === 'expired') return this.expiryMessage(record);
    if (record.closeMessage) return record.closeMessage;
    const actor = isGroupChat(record.event.chatType) && record.actorId ? renderGroupMention(record.actorId) : undefined;
    const outcome = record.kind === 'plan'
      ? ({ approved: '已批准', needs_changes: '已提修改意见', rejected: '已取消' } as Record<string, string>)[record.state]
      : ({ answered: record.adhdMode === true && record.answerLabel ? `已${record.answerLabel}` : '已回答', approved: '已允许', rejected: '已拒绝' } as Record<string, string>)[record.state];
    return [[outcome ?? '已处理', actor, shanghaiClock(Date.parse(record.updatedAt))].filter(Boolean).join(' · '),
      ...(record.kind === 'plan' ? [planClosedText(record)] : [])].join('\n\n');
  }
  private async renderClosed(record: LarkInteraction, message: string) {
    if (!record.cardId || record.kind === 'result') return true;
    if (this.deferredCloses.has(this.key(record))) {
      record = await this.current(record);
      if (record.closeMessage !== message) await this.annotate(record, { closeMessage: message });
      return true;
    }
    const requestedState = record.state;
    const key = `${record.cardId}:${record.state}:${message}`;
    if (this.closedCards.has(key)) return true;
    if (this.closingCards.has(record.id)) return false;
    let release!: () => void;
    this.closingCards.set(record.id, new Promise<void>(resolve => { release = resolve; }));
    let changed = false;
    try {
      record = await this.current(record);
      if (record.state !== requestedState) {
        if (['pending', 'resolving'].includes(record.state)) return false;
        message = await this.closedMessage(record);
      }
      if (record.cardClosedAt && record.closeMessage === message) return true;
      if (record.closeMessage && record.closeMessage !== message) {
        changed = true;
        record = await this.annotate(record, { cardClosedAt: undefined, closeAttempts: 0, closeRetryAt: undefined });
      }
      if ((record.closeAttempts ?? 0) >= 5 || (record.closeRetryAt ?? 0) > Date.now()) return false;
      const attempts = (record.closeAttempts ?? 0) + 1;
      changed = true;
      record = await this.annotate(record, { closeMessage: message, closeAttempts: attempts,
        closeRetryAt: Date.now() + Math.min(60_000, 5_000 * 2 ** (attempts - 1)) });
      // ADHD 提问终态只保留决定、操作人和时间；普通模式沿用原卡正文。
      const contentElements = record.kind === 'ask'
        ? record.adhdMode === true ? [] : record.askContentElements ?? [questionElement('ask', record.question.slice(0, 6000))]
        : [questionElement(record.kind, record.question)];
      await this.service.update({ ...(record.kind === 'ask' && record.adhdMode === true ? { adhdMode: true } : {}), messageId: record.cardId!, taskId: record.id, taskName: record.taskName || (record.kind === 'ask' ? 'Agent 提问' : record.kind === 'plan' ? '执行计划' : '本次操作确认'),
        permissionMode: 'ask', state: record.state === 'expired' ? 'interrupted' : 'completed', statusLabel: record.state === 'expired' ? record.timedOutAt ? '已过期' : '已失效'
          : record.kind === 'plan' ? ({ approved: '已批准', needs_changes: '已提修改意见', rejected: '已取消' } as Partial<Record<LarkInteraction['state'], string>>)[record.state] ?? '已处理'
          : ({ answered: '已回答', approved: '已允许', rejected: '已拒绝' } as Partial<Record<LarkInteraction['state'], string>>)[record.state] ?? '已处理',
        readOnly: true, elements: [...intentElements(record), ...contentElements, { tag: 'markdown', content: message }] });
      await this.annotate(record, { cardClosedAt: new Date().toISOString() });
      this.closedCards.add(key);
      return true;
    } catch (error) {
      if (isLarkMessageUnupdatable(error)) {
        // 230031 等是永久错误（消息超过可更新期限/已删除），重试不会成功：
        // 落 cardClosedAt 让重启和后续对账都不再尝试，并按“已处理”返回。
        this.log?.warn({ cardId: record.cardId, requestId: record.id, code: error.details?.upstreamCode },
          '飞书交互卡已过期或不可更新，放弃关闭卡片且不再重试');
        await this.annotate(record, { cardClosedAt: new Date().toISOString() }).catch(() => undefined);
        this.closedCards.add(key);
        return true;
      }
      this.log?.warn({ error, cardId: record.cardId, requestId: record.id, attempt: record.closeAttempts,
        code: error instanceof LarkServiceError ? error.details?.upstreamCode ?? error.code : undefined,
        message: error instanceof Error ? error.message : String(error) }, '飞书交互卡关闭失败，等待有界重试');
      return false;
    } finally {
      this.closingCards.delete(record.id);
      release();
      if (changed) await this.schedulePlanCheck(record.appId);
    }
  }
  private async renderPendingPermission(record: LarkInteraction) {
    if (!record.cardId) return;
    await this.service.update({ messageId: record.cardId, taskId: record.id, taskName: record.taskName || '确认本次操作', permissionMode: 'ask', state: 'running', statusLabel: '待审批', awaitingHuman: true, readOnly: true,
      elements: [...intentElements(record), { tag: 'div', text: { tag: 'plain_text', content: record.question.slice(0, 6000) } }, { tag: 'markdown', content: '上次提交未送达执行端，请重新批准或拒绝。' }, button(record, 'approve', '允许本次'), button(record, 'reject', '拒绝')] }).catch(() => undefined);
  }
  async expireTask(appId: string, taskId: string) {
    for (let record of await this.list(appId)) {
      if (record.kind === 'permission' && record.taskId === taskId) {
        record = await this.refreshPermissionDecision(record);
        if (['approved', 'rejected'].includes(record.state)) { await this.renderClosed(record, await this.closedMessage(record)); continue; }
      }
      if (record.durable || record.taskId !== taskId || record.kind === 'result' || record.kind === 'plan' || record.state !== 'pending') continue;
      try { await this.renderClosed(await this.move(record, 'expired'), await this.expiryMessage(record)); }
      catch { /* A concurrently accepted decision owns this request. */ }
    }
  }
  /**
   * 权限卡的时限只认持久化的 expiresAt（请求首次建卡时间 + 24 小时）：请求发出满 30 分钟仍无人处理时在原话题提醒一次，
   * 任务继续等待；到 24 小时上限才自动拒绝。心跳对账、重启初始化和迟到的点击都按它处理，进程重启不会顺延、重发提醒或漏掉上限。
   * 提醒时刻由 expiresAt 反推，同一条请求换 boot 重新建卡也不重新计时。
   * 提醒只 @ 能批准的人；飞书里没有人能批准时不发，群里不多一条谁也处理不了的消息。
   * 加急（workflow-urgent）是机器人单独开关、单独阈值和频控的应用内强提醒，这里不代为触发：它照常由 reconcile 按自己的设置处理同一张卡。
   */
  private async enforcePermissionDeadline(record: LarkInteraction, now = Date.now()) {
    if (!hasDeadline(record) || record.state !== 'pending' || !record.expiresAt) return record;
    if (pastDeadline(record, now)) return this.timeoutPermission(record);
    const remindAt = Date.parse(record.expiresAt) - larkPermissionTimeoutMs + larkPermissionReminderAfterMs;
    if (record.remindedAt || !record.cardId || now < remindAt) return record;
    const approvers = await this.approvers(record);
    if (approvers.length) {
      const mention = record.groupMention && isGroupChat(record.event.chatType) ? mentions(approvers) : '';
      try {
        await this.service.reply({ messageId: record.cardId, ...(record.event.threadId ? { replyInThread: true } : {}),
          taskId: record.id, taskName: '审批提醒', permissionMode: 'ask', state: 'running', statusLabel: '待审批', awaitingHuman: true, readOnly: true,
          elements: [{ tag: 'markdown', content: record.kind === 'plan'
            ? `${mention ? `${mention}\n\n` : ''}**这份计划已等待 ${larkPermissionReminderAfterMs / 60_000} 分钟**\n\nAgent 在等你决定，还没有执行；超过 ${timeoutHours} 小时（${deadlineText(record.expiresAt)}）未处理，计划卡失效。请在计划卡上点「批准执行」、提修改意见或「取消」。`
            : `${mention ? `${mention}\n\n` : ''}**这条审批已等待 ${larkPermissionReminderAfterMs / 60_000} 分钟**\n\n${record.intent ? `${record.intent}\n\n` : ''}任务仍在等待，不会因为这次提醒被拒绝；超过 ${timeoutHours} 小时（${deadlineText(record.expiresAt)}）仍未处理才自动拒绝。请在审批卡上点「允许本次」或「拒绝」。` }],
          idempotencyKey: `workflow_remind_${record.id}` });
      } catch { return record; }
    }
    return this.annotate(record, { remindedAt: new Date(now).toISOString() });
  }
  /** 飞书里能批准这条请求的人，判断与 respond 批准时同一道：发起人能批就只算发起人，否则看群里有这道权限的成员（工具审批是高风险审批，计划卡与中断同级）。 */
  private async approvers(record: LarkInteraction) {
    const allowed = (actor: string) => this.authorize(record, actor, record.kind === 'plan' ? 'run.interrupt' : 'high_risk.execute').catch(() => false);
    const requester = record.event.senderOpenId;
    if (requester && !isBotSenderType(record.event.senderType) && await allowed(requester)) return [requester];
    if (!isGroupChat(record.event.chatType) || !this.approverCandidates) return [];
    const approvers: string[] = [];
    for (const candidate of await this.approverCandidates(record).catch(() => [])) {
      if (approvers.length >= maxMentionedApprovers) break;
      if (candidate !== requester && !approvers.includes(candidate) && await allowed(candidate)) approvers.push(candidate);
    }
    return approvers;
  }
  /**
   * 按「本会话允许」代发起人批准：发起人此刻必须仍能批准，判断与点「允许本次」同一道。
   * 发起人已不能批准或执行端没接住时返回 false，照常发卡交给人处理；同一请求已在处理中返回 undefined。
   */
  private async autoApprove(context: LarkInteractionContext, nativeId: string, question: string) {
    const key = `${context.sessionId}:${nativeId}`;
    if (this.autoApproving.has(key)) return undefined;
    this.autoApproving.add(key);
    try {
      const requester = context.event.senderOpenId;
      const probe: LarkInteraction = { ...context, id: this.interactionId(context, 'permission', nativeId), boot: this.boot, kind: 'permission', nativeId, question, state: 'pending', updatedAt: new Date().toISOString() };
      if (!requester || !await this.authorize(probe, requester, 'high_risk.execute')) return false;
      return await this.runtime.resolvePermission!(context.sessionId, nativeId, true) !== false;
    } catch { return false; }
    finally { this.autoApproving.delete(key); }
  }
  private allowForSession(record: LarkInteraction) {
    if (!record.sessionAllowKey) return;
    const keys = this.sessionAllowed.get(record.sessionId) ?? new Set<string>();
    keys.add(record.sessionAllowKey);
    this.sessionAllowed.set(record.sessionId, keys);
    if (this.sessionAllowed.size > 1_000) this.sessionAllowed.delete(this.sessionAllowed.keys().next().value!);
  }
  /** 超过 24 小时上限仍无人处理：先抢占 resolving，再让执行端带原因拒绝这条请求；已在处理中的人工决议优先。 */
  private async timeoutPermission(record: LarkInteraction) {
    let claimed: LarkInteraction;
    try { claimed = await this.move(record, 'resolving'); }
    catch { return this.current(record); }
    try {
      if ((await this.runtime.getPendingPermissions?.(record.sessionId))?.some(item => item.id === record.nativeId)) {
        await this.runtime.resolvePermission!(record.sessionId, record.nativeId, false, larkPermissionTimeoutReason);
      }
    } catch (error) {
      // 执行端暂时没接住拒绝（例如正在落盘决议意图）：退回 pending，下一次心跳再拒；请求已不存在或已被接受则照常收尾。
      if (!['PERMISSION_NOT_FOUND', 'PERMISSION_EXPIRED', 'PERMISSION_ACCEPTED_AUDIT_FAILED'].includes((error as { code?: string }).code ?? '')) {
        return this.move(claimed, 'pending').catch(() => this.current(record));
      }
    }
    let expired: LarkInteraction;
    try { expired = await this.move(claimed, 'expired', undefined, { timedOutAt: new Date().toISOString() }); }
    catch { return this.current(record); }
    await this.closeExpired(expired);
    return this.current(expired);
  }
  /** 失效/过期的卡收成只读；超时拒绝也只原位改这张卡，不另发消息，更新失败随对账重试。 */
  private async closeExpired(record: LarkInteraction) {
    return this.renderClosed(record, await this.expiryMessage(record));
  }
  private async current(record: LarkInteraction) {
    return await this.get(record.appId, record.id) ?? record;
  }
  /** 只补写附加字段；记录已被别处改写时按最新值重试，状态流转仍由 move 的 CAS 负责。 */
  private async annotate(record: LarkInteraction, patch: Partial<LarkInteraction>) {
    let current = record;
    for (let attempt = 0; attempt < 3; attempt++) {
      const next = { ...current, ...patch };
      if (await this.store.compareAndSet!(this.key(current), JSON.stringify(current), JSON.stringify(next))) return next;
      const raw = await this.store.get(this.key(current));
      if (!raw) return current;
      current = JSON.parse(raw) as LarkInteraction;
    }
    return current;
  }
  /** Disabled bots retain only bounded terminal-card PATCH retries, never a task dispatcher. */
  async repairClosedCards(appId: string) {
    this.repairCancelled = false;
    for (let cycle = 0; cycle < 5 && !this.repairCancelled; cycle++) {
      const records = (await this.list(appId)).filter(record => record.kind !== 'result'
        && !['pending', 'resolving'].includes(record.state) && !record.cardClosedAt && record.cardId && (record.closeAttempts ?? 0) < 5);
      if (!records.length) return;
      const nextAt = Math.min(...records.map(record => record.closeRetryAt ?? Date.now()));
      if (nextAt > Date.now()) await new Promise<void>(release => {
        const timer = setTimeout(release, nextAt - Date.now() + 10);
        timer.unref(); this.repairWait = { timer, release };
      });
      this.repairWait = undefined;
      if (this.repairCancelled) return;
      for (const record of records) await this.renderClosed(record, await this.closedMessage(record))
        .catch(error => this.log?.warn({ error, cardId: record.cardId }, 'Repairing closed card failed'));
    }
  }
  close() {
    this.closed = true;
    this.repairCancelled = true;
    if (this.repairWait) { clearTimeout(this.repairWait.timer); this.repairWait.release(); this.repairWait = undefined; }
    for (const timer of this.planTimers.values()) clearTimeout(timer);
    this.planTimers.clear();
    for (const entry of this.deferredCloses.values()) clearTimeout(entry.timer);
    this.deferredCloses.clear();
  }
  private async move(record: LarkInteraction, state: LarkInteraction['state'], actorId?: string, patch: Partial<LarkInteraction> = {}) {
    const next = { ...record, ...patch, state, updatedAt: new Date().toISOString(), ...(actorId ? { actorId } : {}) };
    if (!await this.store.compareAndSet!(this.key(record), JSON.stringify(record), JSON.stringify(next))) throw stale();
    return next;
  }
  private interactionId(context: LarkInteractionContext, kind: LarkInteraction['kind'], nativeId: string) {
    return createHash('sha256').update([context.appId, context.sessionId, context.taskId, context.turn, kind, nativeId, kind === 'result' || kind === 'plan' ? '' : this.boot].join('\0')).digest('hex').slice(0, 24);
  }
  private async create(
    context: LarkInteractionContext,
    kind: LarkInteraction['kind'],
    nativeId: string,
    question: string,
    structured?: Pick<LarkInteraction, 'structured' | 'multiple' | 'expiresAt' | 'remindedAt' | 'sessionAllowKey' | 'groupMention' | 'intent' | 'adhdMode' | 'durable'>
  ) {
    const id = this.interactionId(context, kind, nativeId);
    const record: LarkInteraction = {
      ...context, id, kind, nativeId, question, boot: this.boot, state: 'pending',
      updatedAt: new Date().toISOString(), ...(structured ?? {})
    };
    if (!await this.store.compareAndSet!(this.key(record), undefined, JSON.stringify(record))) {
      const old = await this.store.get(this.key(record));
      if (!old) throw stale();
      return { record: JSON.parse(old) as LarkInteraction, created: false };
    }
    return { record, created: true };
  }
  /**
   * 协调器重建后同一条执行端请求会换 boot 重新建卡；截止时间沿用最早那张卡持久化的 expiresAt，
   * 已发过的提醒也不再重发，重启不会让审批时限重新计时。
   */
  private async permissionDeadline(context: LarkInteractionContext, nativeId: string) {
    const earlier = (await this.list(context.appId)).filter(record => record.kind === 'permission' && record.sessionId === context.sessionId
      && record.taskId === context.taskId && record.nativeId === nativeId && record.expiresAt)
      .sort((left, right) => Date.parse(left.expiresAt!) - Date.parse(right.expiresAt!))[0];
    return { expiresAt: earlier?.expiresAt ?? new Date(Date.now() + larkPermissionTimeoutMs).toISOString(), ...(earlier?.remindedAt ? { remindedAt: earlier.remindedAt } : {}) };
  }
  private async bindCard(record: LarkInteraction, cardId: string) {
    const now = new Date().toISOString();
    const next = { ...record, cardId, cardCreatedAt: record.cardCreatedAt ?? now, updatedAt: now };
    if (!await this.store.compareAndSet!(this.key(record), JSON.stringify(record), JSON.stringify(next))) throw stale();
    return next;
  }
  /**
   * options.structuredAskCards：结构化问答卡总开关（来自 config，默认开启，显式 false 关闭）。
   * 关闭时使用文本卡并展示可读选项；开启后：带选项的 ask 渲染单选按钮组/多选表单，
   * 无选项的 ask 渲染自由文本 input 表单。低版本客户端仍可引用本卡片直接回复。
   * options.webBaseUrl：仅在传入且为合法 http(s) 地址时透传给结构化 ask 卡，未配置不渲染、无公网兜底。
   * options.groupMention：群 @ 开关（P0-4，取自 Bot/群配置，配置默认开启；未传视为关闭）。开启且为群聊时在卡片最前方插入 @：
   * 问答卡 @ 发起人；审批卡 @ 能批准的人，同一任务 60 秒内的后续审批卡不再 @。关闭时不添加 @ 元素。
   * options.highRiskPattern：部署配置的高危正则，命中的命令不给「本会话允许此命令」；未传不给按钮。
   * options.onSessionAllowed：按「本会话允许」自动批准、不再发卡时回调，调用方在进度卡上原位留一行记录。
   */
  async observe(
    context: LarkInteractionContext,
    event: AgentEvent,
    options: { adhdMode?: boolean; structuredAskCards?: boolean; webBaseUrl?: string; groupMention?: boolean; highRiskPattern?: string; onSessionAllowed?: (permissionId: string) => void } = {}
  ) {
    if (this.closed) return;
    const data = event.data as Record<string, any>;
    if (event.type === 'permission_request' && ['approved', 'rejected'].includes(data.status)) {
      for (let record of await this.list(context.appId)) {
        if (record.kind !== 'permission' || record.sessionId !== context.sessionId || record.taskId !== context.taskId || record.nativeId !== data.id) continue;
        record = await this.refreshPermissionDecision(record, data as PermissionRequestData);
        if (['approved', 'rejected'].includes(record.state)) await this.renderClosed(record, await this.closedMessage(record));
      }
      return;
    }
    let kind: 'ask' | 'permission';
    let nativeId: string;
    let question: string;
    let askChoices: RelayAskChoice[] | undefined;
    let askMultiple = false;
    let expiresAt: string | undefined;
    let remindedAt: string | undefined;
    let allowKey: string | undefined;
    let intent: string | undefined;
    if (event.type === 'text' && data.relay === 'ask' && this.broker) {
      const ask = this.broker.get(String(data.askId));
      if (!ask || ask.status !== 'pending' || ask.sessionId !== context.sessionId) return;
      kind = 'ask'; nativeId = ask.id; question = ask.question;
      askChoices = Array.isArray(ask.choices) ? ask.choices : undefined;
      askMultiple = ask.multiple === true;
      expiresAt = ask.expiresAt;
    } else if (event.type === 'permission_request' && data.status === 'pending' && this.runtime.resolvePermission && this.runtime.getPendingPermissions) {
      const request = data as PermissionRequestData;
      if (!(await this.runtime.getPendingPermissions(context.sessionId)).some(item => item.id === request.id)) return;
      kind = 'permission'; nativeId = request.id;
      ({ expiresAt, remindedAt } = await this.permissionDeadline(context, request.id));
      const operation = request.operation;
      question = [permissionDisplayText(request.title) || 'Agent 请求执行受控操作',
        ...(operation?.source === 'acp_tool_call' || operation?.source === 'claude_permission_hook' ? [
          '来源：执行端工具请求',
          ...(operation.cwd ? [`目录：${permissionDisplayText(operation.cwd)}`] : []),
          ...(operation.resource ? [`资源：${permissionDisplayText(operation.resource)}`] : []),
          ...(operation.command ? [`命令（已脱敏）：${permissionDisplayText(operation.command)}`] : [])
        ] : ['执行端未提供详细操作。'])
      ].join('\n');
      // 摘要只是把标题原样再说一遍时不重复展示（执行端没给工具类别和参数）。
      intent = permissionIntent(request);
      if (intent === question.split('\n')[0]) intent = undefined;
      allowKey = await sessionAllowKey(request, options.highRiskPattern);
      // 发起人已对这条命令点过「本会话允许」：代发起人批准，不再发卡。自动批准前的高危复核就是上面这次隔离匹配。
      if (allowKey && this.sessionAllowed.get(context.sessionId)?.has(allowKey)) {
        const approved = await this.autoApprove(context, nativeId, question);
        if (approved === undefined) return;
        if (approved) { options.onSessionAllowed?.(nativeId); return; }
      }
    } else return;
    const structuredOn = options.structuredAskCards !== false && kind === 'ask';
    const structuredChoices = structuredOn && askChoices && askChoices.length > 0 ? askChoices : undefined;
    const created = await this.create(
      context, kind, nativeId, question,
      { ...(options.adhdMode === true ? { adhdMode: true } : {}), ...(expiresAt ? { expiresAt } : {}), ...(remindedAt ? { remindedAt } : {}), ...(structuredChoices ? { structured: true, ...(askMultiple ? { multiple: true } : {}) } : {}),
        ...(allowKey ? { sessionAllowKey: allowKey } : {}), ...(intent ? { intent } : {}), ...(kind === 'permission' && options.groupMention === true ? { groupMention: true } : {}) }
    );
    let record = created.record;
    if (record.state !== 'pending' || record.cardId || this.delivering.has(record.id) || (this.retryAfter.get(record.id) ?? 0) > Date.now()) return;
    this.delivering.add(record.id);
    const approvers = kind === 'permission' ? await this.approvers(record).catch(() => []) : [];
    const requesterApproves = Boolean(context.event.senderOpenId) && approvers[0] === context.event.senderOpenId;
    const mentionKey = `${context.appId}:${context.taskId}`;
    const mentionAllowed = options.groupMention === true && isGroupChat(context.event.chatType);
    // 同一轮并发的几条审批都会走到这里：决定 @ 与占住本任务的提醒窗口在同一个同步段里完成，
    // 中间不能有 await，否则几张卡都会读到「尚未 @」；卡没发出去时再把窗口还回去。
    const previousMentionAt = this.approvalMentionedAt.get(mentionKey);
    const approvalMention = kind === 'permission' && mentionAllowed && Date.now() - (previousMentionAt ?? 0) >= approvalMentionWindowMs ? mentions(approvers) : '';
    const mentionClaimedAt = approvalMention ? Date.now() : undefined;
    if (mentionClaimedAt !== undefined) {
      this.approvalMentionedAt.set(mentionKey, mentionClaimedAt);
      if (this.approvalMentionedAt.size > 1_000) this.approvalMentionedAt.delete(this.approvalMentionedAt.keys().next().value!);
    }
    let mentionDelivered = false;
    // P0-4：仅在开关开启且为群聊时于卡首 @；关闭时该展开为空，卡面零变化。
    // 问答卡 @ 发起人；审批卡 @ 能批准的人，同一任务 60 秒内的后续审批卡不再 @。
    const groupMentionTag = !mentionAllowed ? undefined
      : kind === 'ask' ? context.event.senderOpenId ? renderGroupMention(context.event.senderOpenId) : undefined
      : approvalMention || undefined;
    // 提示语元素单独持有引用：结构化选项超预算回落为纯文本卡时，要替换的始终是这一条提示，
    // 不能写死下标——群 @ 开启时它前面还会插入 group_mention，下标会错位覆盖问题正文。
    const hintElement: LarkCardElement = { tag: 'markdown', content: kind === 'ask'
      ? (structuredOn
        ? structuredChoices ? '点选下方选项提交；也可引用本卡片直接回复你的答案。' : '在下方填写答案并点击提交；也可引用本卡片直接回复你的答案。'
        : '请引用本卡片回复你的答案。')
      : record.sessionAllowKey && requesterApproves
        ? '「允许本次」只处理这一条请求；「本会话允许此命令」仅允许目录、资源与命令完全相同的后续请求，服务重启后失效。'
        : '本次选择只处理这一条请求，不改变后续授权方式。' };
    const minimalAsk = kind === 'ask' && record.adhdMode === true;
    const displayedQuestion = minimalAsk ? { tag: 'markdown', content: question } : questionElement(kind, question);
    const elements: LarkCardElement[] = [
      ...(!minimalAsk && groupMentionTag ? [{ tag: 'markdown', element_id: 'group_mention', content: groupMentionTag }] : []),
      ...(minimalAsk ? [] : intentElements(record)),
      displayedQuestion,
      // 正文只写读者做决定时需要知道的东西：授权范围（permission）、怎么答（ask）。
      // 原先还各带一份完整 slash 指令，`/approve wf_01H…` 里那串请求编号在 permission 卡上
      // 出现两次，正下方就是「批准一次 / 拒绝」两个按钮——对能点按钮的人是三行纯噪声。
      //
      // 编号因此不再出现在任何卡片正文里，按钮失灵时的备用路径改成「引用这张卡 + /approve」：
      // routeWorkflow 组装 requestId 时，没有显式编号就回落到被引用卡片的 id。删掉编号
      // 而不做那个回落，等于把这条备用路径一起删掉——命令会以「请填写请求编号」失败，
      // 而那个编号已经没有任何卡会显示。
      // 命令本身的可发现性由 `/help` 承担（commands.ts:173-175 已列出三条命令及其用法）。
      ...(minimalAsk ? [] : [hintElement]),
      ...(kind === 'permission' && !approvers.length ? [{ tag: 'markdown', content: '飞书里没有人能批准这条请求，需要在 Web 上处理。' }] : []),
      ...(kind === 'permission' ? [button(record, 'approve', '允许本次'), button(record, 'reject', '拒绝')] : []),
      // 只有发起人能点、且只在发起人本人能批准时给；高危、被脱敏或被截断的命令没有匹配键，不给。
      ...(kind === 'permission' && record.sessionAllowKey && requesterApproves ? [button(record, 'allow_session', '本会话允许此命令')] : []),
      ...(record.expiresAt && !(kind === 'ask' && record.adhdMode === true) ? [{ tag: 'markdown', element_id: 'workflow_deadline', text_size: 'notation', content: kind === 'permission'
        ? permissionDeadlineNotice(record.expiresAt)
        : `回答截止时间：${deadlineText(record.expiresAt)}。超时后请发送 /status 查看任务状态。` }] : [])
    ];
    // 结构化问答仅在开关开启且记录本身带选项时渲染；持久记录缺 structured（升级前的卡）
    // 一律走自由文本形态，绝不让新渲染逻辑作用于旧记录。
    let structuredParts: LarkCardElement[] | undefined;
    if (structuredOn && kind === 'ask') {
      if (record.structured && structuredChoices) {
        structuredParts = record.multiple
          ? [multipleChoiceForm(record, structuredChoices)]
          : singleChoiceElements(record, structuredChoices);
      } else if (!record.structured) {
        structuredParts = [freeTextForm(record)];
      }
    }
    const safeWebBaseUrl = structuredOn && kind === 'ask' ? safeLarkWebUrl(options.webBaseUrl) : undefined;
    try {
      if (!await this.live(record)) { await this.move(record, 'expired'); return; }
      if (kind === 'ask') {
        const questionIndex = elements.indexOf(displayedQuestion);
        const labels = (askChoices ?? []).map((choice, index) => `${index + 1}. ${choice.label}`);
        const choicesElement = (visible: number): LarkCardElement => ({ tag: 'div', text: { tag: 'plain_text',
          content: `可选项：\n${labels.slice(0, visible).join('\n')}${visible < labels.length ? `\n还有 ${labels.length - visible} 个选项未展示，请查看全文附件。` : ''}` } });
        const fullTextParts = labels.length ? [choicesElement(labels.length)] : [];
        let contentElements = [questionElement(kind, question), ...fullTextParts];
        if (structuredParts && this.withinAskCardBudget([...elements, ...structuredParts], safeWebBaseUrl)) {
          elements.push(...structuredParts);
        } else {
          hintElement.content = '请引用本卡片回复你的答案。';
          if (this.withinAskCardBudget([...elements, ...fullTextParts], safeWebBaseUrl)) {
            elements.push(...fullTextParts);
          } else {
            // 只有问答全文确实放不下时上传；审批卡不经过这里，避免扩大命令/秘密的披露范围。
            const attachment = await sendLarkFile(this.service, {
              chatId: context.event.chatId, replyMessageId: larkMessageAnchor(context.event),
              replyInThread: Boolean(context.event.threadId), allowReplyFallback: false
            }, {
              data: Buffer.from([question, ...(labels.length ? ['可选项：', ...labels] : [])].join('\n\n'), 'utf8'),
              filename: `question-${record.id}.txt`, idempotencyKey: `workflow_${record.id}_full`
            }, { warn: () => undefined }, this.store, async () => { if (!await this.live(record)) throw stale(); });
            if (!attachment.messageId) throw new Error('Question attachment delivery has no receipt');
            const notice: LarkCardElement = { tag: 'markdown', content: '以下是节选；完整问题和全部选项已提供为本话题的全文附件，请阅读后回答。' };
            let visible = labels.length;
            const excerpt = () => [questionElement(kind, question), ...(labels.length ? [choicesElement(visible)] : []), notice];
            // 先保留完整问题，逐个减少可见选项；问题自身超限时再按 Unicode 字符缩短。
            while (visible > 0 && !this.withinAskCardBudget([...elements.filter((_, index) => index !== questionIndex), ...excerpt()], safeWebBaseUrl)) visible--;
            const characters = Array.from(question);
            let low = 0, high = characters.length;
            while (low < high) {
              const middle = Math.ceil((low + high) / 2);
              const candidate = [questionElement(kind, characters.slice(0, middle).join('')), ...(labels.length ? [choicesElement(visible)] : []), notice];
              if (this.withinAskCardBudget([...elements.filter((_, index) => index !== questionIndex), ...candidate], safeWebBaseUrl)) low = middle;
              else high = middle - 1;
            }
            contentElements = [questionElement(kind, characters.slice(0, low).join('')), ...(labels.length ? [choicesElement(visible)] : []), notice];
            elements.splice(questionIndex, 1, ...contentElements);
          }
        }
        // 展示真相独立于 broker 的 live waiter；回答/过期后的重绘仍保留当时全部可读内容。
        for (;;) {
          const next = { ...record, askContentElements: contentElements };
          if (await this.store.compareAndSet!(this.key(record), JSON.stringify(record), JSON.stringify(next))) { record = next; break; }
          const current = await this.store.get(this.key(record));
          if (!current) throw stale();
          record = JSON.parse(current) as LarkInteraction;
        }
      }
      if (!await this.live(record)) { await this.move(record, 'expired'); return; }
      const card = await this.service.reply({ ...(minimalAsk ? { adhdMode: true } : {}), messageId: larkMessageAnchor(context.event), ...(context.event.threadId ? { replyInThread: true } : {}),
        state: 'running', statusLabel: kind === 'ask' ? '待回答' : '待审批', awaitingHuman: true, readOnly: true,
        taskId: record.id, taskName: record.taskName || (kind === 'ask' ? 'Agent 需要你的回答' : '确认本次操作'), permissionMode: 'ask', elements,
        ...(safeWebBaseUrl ? { webBaseUrl: safeWebBaseUrl } : {}),
        idempotencyKey: `workflow_${record.id}`,
        ...(kind === 'ask' ? { beforeSend: async () => { if (!await this.live(record)) throw stale(); } } : {}) });
      mentionDelivered = true;
      let bound: LarkInteraction;
      try { bound = await this.bindCard(record, card.messageId); }
      catch {
        const current = await this.store.get(this.key(record));
        if (!current) throw stale();
        bound = await this.bindCard(JSON.parse(current), card.messageId);
      }
      if (bound.state === 'expired') await this.renderClosed(bound, await this.expiryMessage(bound));
      else await this.reconcile(context.appId, context.taskId);
      this.retryAfter.delete(record.id);
    } catch (error) {
      // The waiter remains valid when delivery fails. A later task heartbeat
      // retries the same provider UUID; one in-flight delivery owns this boot.
      this.retryAfter.set(record.id, Date.now() + 5_000);
      throw error;
    } finally {
      this.delivering.delete(record.id);
      // 占了提醒窗口但卡没发出去：窗口仍是这一次占的才还回去。
      if (mentionClaimedAt !== undefined && !mentionDelivered && this.approvalMentionedAt.get(mentionKey) === mentionClaimedAt) {
        if (previousMentionAt === undefined) this.approvalMentionedAt.delete(mentionKey);
        else this.approvalMentionedAt.set(mentionKey, previousMentionAt);
      }
    }
  }

  /**
   * 预测「信封 + 结构化元素」拼装后的整卡体积，选项过多时由调用方回落成普通文本问答卡。
   * 不能直接 buildLarkCard(elements) 试算：buildLarkCard 超预算时会静默把整卡换成只剩
   * 提示文案的兜底卡，拿兜底卡反算永远「达标」。这里用同入参的空信封卡测得固定开销，
   * arrange 会把未登记 element_id 的结构化元素原样追加进 body，将元素追加到空信封后，连 content 外层 JSON 转义一起计入请求预算。
   */
  private withinAskCardBudget(elements: LarkCardElement[], webBaseUrl?: string) {
    const envelope = buildLarkCard({
      state: 'running', statusLabel: '待回答', awaitingHuman: true, readOnly: true,
      taskName: 'Agent 需要你的回答', permissionMode: 'ask',
      ...(webBaseUrl ? { webBaseUrl } : {})
    });
    envelope.body.elements.push(...elements);
    const content = JSON.stringify(envelope);
    // reply 的 content 是再次序列化的 JSON 字符串；引号和反斜杠会放大整个 HTTP 请求。
    const projectedRequestBytes = Buffer.byteLength(JSON.stringify({ msg_type: 'interactive', content,
      reply_in_thread: true, uuid: `workflow_${'x'.repeat(24)}` }), 'utf8');
    const projectedComponents = countCardComponents(envelope);
    return projectedRequestBytes <= larkCardSafeLimits.bytes - structuredCardBudgetHeadroomBytes
      && projectedComponents <= larkCardSafeLimits.components;
  }
  async result(context: LarkInteractionContext, cardId: string, relatedCardIds?: string[]) {
    const raw = await this.store.get(prefix(context.appId) + this.interactionId(context, 'result', context.taskId));
    if (!raw) return [];
    let record = JSON.parse(raw) as LarkInteraction;
    for (;;) {
      const next = { ...record, cardId, ...(relatedCardIds ? { relatedCardIds } : {}) };
      if (JSON.stringify(record) === JSON.stringify(next)) break;
      if (await this.store.compareAndSet!(this.key(record), JSON.stringify(record), JSON.stringify(next))) {
        record = next;
        break;
      }
      const current = await this.store.get(this.key(record));
      if (!current) throw stale();
      record = JSON.parse(current) as LarkInteraction;
    }
    return record.state === 'pending' ? [
      { tag: 'markdown', element_id: 'workflow_result_status', content: '执行已结束。请验收结果；需要修改时，回复此卡片并说明要求。' },
      button(record, 'accept', '验收通过'), button(record, 'changes', '需要修改')
    ] : [{ tag: 'markdown', element_id: 'workflow_result_status', content: record.state === 'accepted' ? '验收：已通过' : '验收：需要修改，回复此卡片说明要求。' }];
  }
  /**
   * 计划轮的结果卡：第一次调用（planText 给出、cardId 为空）建计划记录并返回卡上的计划操作；
   * 结果卡发出后再带 cardId 调一次绑定。没有记录又没给计划正文时返回空（对账补发的普通结果卡）。
   */
  async plan(context: LarkInteractionContext, cardId: string, planText?: string, options: { groupMention?: boolean; relatedCardIds?: string[] } = {}) {
    const id = this.interactionId(context, 'plan', context.taskId);
    let raw = await this.store.get(prefix(context.appId) + id);
    if (!raw && planText === undefined) return [];
    if (!raw) {
      await this.create(context, 'plan', context.taskId, planText || '（Agent 没有给出计划正文）', {
        expiresAt: new Date(Date.now() + larkPermissionTimeoutMs).toISOString(), ...(options.groupMention ? { groupMention: true } : {}) });
      raw = await this.store.get(prefix(context.appId) + id);
      if (!raw) throw stale();
    }
    let record = JSON.parse(raw) as LarkInteraction;
    if (cardId && (record.cardId !== cardId || options.relatedCardIds && JSON.stringify(record.relatedCardIds) !== JSON.stringify(options.relatedCardIds))) {
      record = await this.annotate(record, { cardId, cardCreatedAt: record.cardCreatedAt ?? new Date().toISOString(), ...(options.relatedCardIds ? { relatedCardIds: options.relatedCardIds } : {}) });
      await this.schedulePlanCheck(context.appId);
    }
    return record.state === 'pending' ? planPendingElements(record) : [{ tag: 'markdown', element_id: 'workflow_plan_status', content: planClosedText(record) }];
  }
  /** 计划卡可操作：计划轮已完成，且会话里没有更新的任务（之后又发了消息，这份计划就不是最新的上文了）。 */
  async endConfirmation(appId: string, requestId: string) {
    const record = await this.get(appId, requestId);
    if (!record?.durable || record.state === 'expired') return;
    const ended = await this.move(record, 'expired');
    await this.renderClosed(ended, '已结束，未执行');
  }
  /** Register one structured question, without an HTTP waiter or a deadline. */
  async defer(context: LarkInteractionContext, input: RelayDeferredAsk, snapshot: NonNullable<LarkInteraction['durable']>['snapshot'], signal?: AbortSignal) {
    // A retry in the same original turn must not register another dependent question.
    const existing = (await this.list(context.appId)).find(record => record.durable && record.sessionId === context.sessionId && record.taskId === context.taskId);
    if (!existing && signal?.aborted) throw new LarkServiceError('LARK_CONFIRMATION_ENDED', '已结束，未执行', 409);
    const probe: LarkInteraction = { ...context, id: this.interactionId(context, 'ask', `deferred_${context.taskId}`), boot: this.boot,
      kind: 'ask', nativeId: '', question: input.question, structured: true, multiple: input.multiple, state: 'pending', updatedAt: new Date().toISOString(),
      durable: { choices: input.choices, snapshot } };
    if (!this.withinAskCardBudget(this.confirmationElements(probe))) throw new LarkServiceError('LARK_CONFIRMATION_TOO_LARGE', '问题和选项过长，请拆成一个较短的问题。', 400);
    const record = existing ?? (await this.create(context, 'ask', `deferred_${context.taskId}`, input.question, {
      adhdMode: true, structured: true, ...(input.multiple ? { multiple: true } : {}), durable: { choices: input.choices, snapshot }
    })).record;
    if (record.state === 'pending') await this.deliverConfirmation(record).catch(error => this.log?.warn({ error, requestId: record.id }, 'Delivering durable confirmation failed; reconcile will retry'));
    return { status: 'deferred' as const, askId: record.id, reason: '确认已登记，等待用户点击后另起一轮；本轮结束，不执行依赖该确认的操作。' };
  }
  private confirmationElements(record: LarkInteraction) {
    return [{ tag: 'markdown', content: record.question }, ...(record.multiple
      ? [multipleChoiceForm(record, record.durable!.choices)] : singleChoiceElements(record, record.durable!.choices))];
  }
  private async deliverConfirmation(record: LarkInteraction) {
    if (record.cardId || this.delivering.has(record.id) || this.closed || (record.deliveryRetryAt ?? 0) > Date.now()) return;
    this.delivering.add(record.id);
    try {
      const elements = this.confirmationElements(record);
      const attempts = (record.deliveryAttempts ?? 0) + 1;
      record = await this.annotate(record, { deliveryAttempts: attempts, deliveryRetryAt: Date.now() + 5_000 * 2 ** (attempts - 1) });
      const card = await this.service.reply({ messageId: larkMessageAnchor(record.event),
        ...(record.event.threadId ? { replyInThread: true } : {}), state: 'running', statusLabel: '待确认', awaitingHuman: true,
        readOnly: true, adhdMode: true, taskId: record.id, taskName: record.taskName || '待确认', permissionMode: 'ask', elements,
        idempotencyKey: `workflow_${record.id}` });
      const bound = await this.bindCard(record, card.messageId);
      await this.annotate(bound, { deliveryRetryAt: undefined });
    } catch (error) {
      this.log?.warn({ error, requestId: record.id, attempts: record.deliveryAttempts }, 'Delivering durable confirmation failed');
      if ((record.deliveryAttempts ?? 0) >= 5) await this.move(await this.current(record), 'expired');
    } finally {
      this.delivering.delete(record.id);
      await this.schedulePlanCheck(record.appId);
    }
  }
  private async reconcileConfirmation(record: LarkInteraction) {
    if (!await this.live(record)) {
      const ended = await this.move(record, 'expired');
      await this.renderClosed(ended, '已结束，未执行');
      return ended;
    }
    if (record.state === 'resolving') return this.finishConfirmation(record);
    await this.deliverConfirmation(record);
    return this.current(record);
  }
  private async finishConfirmation(record: LarkInteraction) {
    if (this.confirming.has(record.id)) return record;
    this.confirming.add(record.id);
    try {
      // Recheck current authority on recovery, before the idempotent inbox seed.
      if (!record.actorId || !await this.live(record) || !await this.authorize(record, record.actorId, 'run.interrupt')) {
        const ended = await this.move(record, 'expired');
        await this.renderClosed(ended, '已结束，未执行');
        return ended;
      }
      if (!this.onConfirmation) throw new LarkServiceError('LARK_CONFIRMATION_UNAVAILABLE', '确认暂不可用，请稍后重试。', 409);
      await this.onConfirmation(record);
      const answered = await this.move(record, 'answered');
      await this.renderClosed(answered, await this.closedMessage(answered));
      return answered;
    } finally { this.confirming.delete(record.id); }
  }
  private async respondConfirmation(record: LarkInteraction, input: { actorId?: string; callback?: boolean; answer?: string; selected?: string[] }) {
    if (!input.callback) throw new LarkServiceError('LARK_CONFIRMATION_CLICK_REQUIRED', '请点击卡片选项。', 400);
    if (!await this.live(record)) {
      if (record.state === 'pending') await this.renderClosed(await this.move(record, 'expired'), '已结束，未执行');
      throw new LarkServiceError('LARK_CONFIRMATION_ENDED', '已结束，未执行', 409);
    }
    if (!input.actorId || !await this.authorize(record, input.actorId, 'run.interrupt')) throw new LarkServiceError('LARK_INTERACTION_DENIED', '当前账号无权确认。', 403);
    if (record.state !== 'pending') return '已登记，请勿重复确认。';
    const selected = record.multiple ? [...new Set(input.selected ?? [])] : [input.answer?.trim() ?? ''];
    const choices = record.durable!.choices;
    if (!selected.length || selected.some(value => !choices.some(choice => (choice.value ?? choice.label) === value))) {
      throw new LarkServiceError('LARK_ANSWER_CHOICE_INVALID', '请选择卡片上的选项。', 400);
    }
    const answerLabel = choices.filter(choice => selected.includes(choice.value ?? choice.label)).map(choice => choice.label).join('、');
    record = await this.move(record, 'resolving', input.actorId, { answerLabel,
      durable: { ...record.durable!, answer: selected.join('、'), selected } });
    await this.finishConfirmation(record);
    return '已登记确认，Agent 将在原会话继续。';
  }

  private async planLive(record: LarkInteraction) {
    if (this.closed) return false;
    const tasks = await this.runtime.getTasks?.(record.sessionId);
    const latest = tasks?.reduce<typeof tasks[number] | undefined>((last, task) => !last || Date.parse(task.createdAt) >= Date.parse(last.createdAt) ? task : last, undefined);
    return latest?.id === record.taskId && latest.status === 'completed';
  }
  /** 没有任务心跳时，在最近的计划提醒、截止或关闭重试时刻对账。 */
  private async schedulePlanCheck(appId: string) {
    if (this.closed) return;
    const now = Date.now();
    const records = await this.list(appId);
    if (this.closed) return;
    const due = records.filter(record => record.kind === 'plan' && record.state === 'pending' && record.expiresAt && record.cardId)
      .flatMap(record => [Date.parse(record.expiresAt!), ...(record.remindedAt ? [] : [Date.parse(record.expiresAt!) - larkPermissionTimeoutMs + larkPermissionReminderAfterMs])])
      .filter(at => at > now);
    due.push(...records.filter(record => record.durable && record.state === 'pending' && !record.cardId && record.deliveryRetryAt && (record.deliveryAttempts ?? 0) < 5).map(record => Math.max(now, record.deliveryRetryAt!)));
    due.push(...records.filter(record => record.kind !== 'result' && !['pending', 'resolving'].includes(record.state)
      && !record.cardClosedAt && record.closeRetryAt && (record.closeAttempts ?? 0) < 5).map(record => Math.max(now, record.closeRetryAt!)));
    clearTimeout(this.planTimers.get(appId));
    this.planTimers.delete(appId);
    if (!due.length) return;
    const timer = setTimeout(() => {
      this.planTimers.delete(appId);
      void timeLoop('lark.interaction-plan-check', this.log, () => this.reconcile(appId)).catch(() => this.schedulePlanCheck(appId));
    }, Math.min(...due) - now + 1_000);
    timer.unref();
    this.planTimers.set(appId, timer);
  }
  /** 决定已占住（resolving）：提交下一轮，再落到终态并把计划卡收成只读。 */
  private async finishPlan(record: LarkInteraction) {
    if (record.decision !== 'cancel') {
      if (!this.onPlanDecision) throw new LarkServiceError('LARK_PLAN_UNAVAILABLE', '当前服务不能提交计划的下一轮。', 409);
      await this.onPlanDecision(record);
    }
    const closed = await this.move(record, record.decision === 'approve' ? 'approved' : record.decision === 'revise' ? 'needs_changes' : 'rejected');
    const actor = isGroupChat(closed.event.chatType) && closed.actorId ? renderGroupMention(closed.actorId) : undefined;
    const outcome = closed.state === 'approved' ? '已批准' : closed.state === 'needs_changes' ? '已提修改意见' : '已取消';
    await this.renderClosed(closed, [[outcome, actor, shanghaiClock(Date.parse(closed.updatedAt))].filter(Boolean).join(' · '), planClosedText(closed)].join('\n\n'));
    return closed;
  }
  private async live(record: LarkInteraction) {
    if (record.durable) return !this.closed && await this.confirmationAvailable?.(record) === true;
    if (record.kind === 'plan') return this.planLive(record);
    if (this.closed || record.boot !== this.boot) return false;
    if (!(await this.runtime.getTasks?.(record.sessionId))?.some(task => task.id === record.taskId && task.status === 'running')) return false;
    return record.kind === 'ask'
      ? this.broker?.get(record.nativeId)?.status === 'pending'
      : (await this.runtime.getPendingPermissions?.(record.sessionId))?.some(item => item.id === record.nativeId) === true;
  }
  async pendingAsks(appId: string) {
    const pending: LarkInteraction[] = [];
    for (const record of await this.list(appId)) {
      if (!record.durable && record.kind === 'ask' && record.state === 'pending' && record.cardId && await this.live(record)) pending.push(record);
    }
    return pending;
  }
  /** 不引用卡片的直接回复算不算这条提问的回答：带选项的只认对得上某个选项的文字，自由作答照旧都算。 */
  acceptsReply(record: LarkInteraction, text: string) {
    const choices = this.broker?.get(record.nativeId)?.choices ?? [];
    return !choices.length || matchChoice(choices, text) !== undefined;
  }
  /** 过期的提问：已收成 expired，或仍记为 pending 但执行端已不再等这条回答。 */
  private async askExpired(record: LarkInteraction) {
    if (record.state === 'expired') return true;
    if (record.state !== 'pending' || await this.live(record) || this.broker?.get(record.nativeId)?.status === 'answering') return false;
    try { await this.renderClosed(await this.move(record, 'expired'), await this.expiryMessage(record)); }
    catch { return false; }
    return true;
  }
  async respond(input: { appId: string; chatId: string; actorId?: string; requestId: string; action: 'answer' | 'approve' | 'reject' | 'accept' | 'changes' | 'allow_session' | 'plan_approve' | 'plan_revise' | 'plan_cancel'; answer?: string; selected?: string[]; cardId?: string; generation?: string; callback?: boolean; deferClose?: boolean }): Promise<string> {
    if (!input.deferClose) return this.respondNow(input);
    const key = prefix(input.appId) + input.requestId;
    const entry = this.deferredCloses.get(key) ?? { active: 0, timer: undefined };
    clearTimeout(entry.timer);
    entry.active++;
    this.deferredCloses.set(key, entry);
    try { return await this.respondNow(input); }
    finally {
      if (--entry.active === 0 && !this.closed) {
        entry.timer = setTimeout(() => {
          this.deferredCloses.delete(key);
          void (async () => {
            const raw = await this.store.get(key);
            if (this.closed || !raw) return;
            const record = JSON.parse(raw) as LarkInteraction;
            if (!['pending', 'resolving'].includes(record.state)) await this.renderClosed(record, await this.closedMessage(record));
          })().catch(error => this.log?.warn({ error, requestId: input.requestId }, '延迟收卡失败，等待终态补关'));
        }, 1_000);
        entry.timer.unref();
      }
    }
  }
  private async respondNow(input: Parameters<LarkWorkflowInteractions['respond']>[0]) {
    const raw = await this.store.get(prefix(input.appId) + input.requestId);
    if (!raw || !input.actorId) throw stale();
    let record = JSON.parse(raw) as LarkInteraction;
    if (record.event.chatId !== input.chatId || record.appId !== input.appId || !record.cardId) throw stale();
    if (input.callback && (input.cardId !== record.cardId || input.generation !== record.boot)) throw stale();
    const expectedKind = input.action === 'answer' ? 'ask' : ['approve', 'reject', 'allow_session'].includes(input.action) ? 'permission' : input.action.startsWith('plan_') ? 'plan' : 'result';
    if (record.kind !== expectedKind) throw stale();
    if (record.durable) return this.respondConfirmation(record, input);
    if (input.action === 'allow_session') {
      if (!record.sessionAllowKey) throw new LarkServiceError('LARK_SESSION_ALLOW_UNAVAILABLE', '这条命令不能设为本会话允许，请点「允许本次」。', 400);
      if (input.actorId !== record.event.senderOpenId) throw new LarkServiceError('LARK_INTERACTION_DENIED', '只有发起人可以设置本会话允许此命令。', 403);
    }
    // 提问过期后发起人再用文字回复：答案不再作废，交回调用方附上原问题，作为一条新消息发给 Agent。
    // 只认发起人本人；新消息照常走建任务的授权，这里不代任何人答题。
    if (record.kind === 'ask' && !input.callback && input.actorId === record.event.senderOpenId && await this.askExpired(record)) {
      throw new LarkServiceError('LARK_ASK_EXPIRED', '这条提问已过期，回复会作为新消息发给 Agent。', 409, { question: record.question });
    }
    // 计划卡三个动作与验收、中断同一道：发起人本来就能直接发这个任务，批准计划不要更高权限。
    const policy: PolicyAction = input.action === 'approve' || input.action === 'allow_session' ? 'high_risk.execute' : 'run.interrupt';
    if (!await this.authorize(record, input.actorId, policy)) throw new LarkServiceError('LARK_INTERACTION_DENIED', '当前账号无权操作此任务。', 403);
    // 截止时间已过而对账还没轮到它：先按超时收尾，迟到的批准不再生效。
    if (record.state === 'pending' && pastDeadline(record)) record = await this.timeoutPermission(record);
    if (record.state !== 'pending') {
      if (record.state === 'expired') {
        const message = await this.expiryMessage(record);
        await this.renderClosed(record, message);
        throw new LarkServiceError('LARK_INTERACTION_EXPIRED', message, 409);
      }
      throw stale();
    }
    if (record.kind === 'plan') {
      const decision: LarkPlanDecision = input.action === 'plan_approve' ? 'approve' : input.action === 'plan_revise' ? 'revise' : 'cancel';
      const feedback = input.answer?.trim() ?? '';
      if (decision === 'revise' && !feedback) throw new LarkServiceError('LARK_ANSWER_EMPTY', '请先写下修改意见再提交。', 400);
      if (!await this.planLive(record)) {
        await this.renderClosed(await this.move(record, 'expired'), planStaleText).catch(() => undefined);
        throw new LarkServiceError('LARK_INTERACTION_EXPIRED', planStaleText, 409);
      }
      record = await this.move(record, 'resolving', input.actorId, { decision, ...(decision === 'revise' ? { feedback: feedback.slice(0, 2000) } : {}) });
      try { await this.finishPlan(record); }
      catch (error) {
        // 下一轮没提交成功：放回待处理，卡上还能再点。
        await this.move(record, 'pending').catch(() => undefined);
        throw error;
      }
      return decision === 'approve' ? '已批准，Agent 开始按计划执行，进度发在下方。' : decision === 'revise' ? '已提交修改意见，Agent 会重新出计划。' : '已取消，这份计划不会执行。';
    }
    if (record.kind === 'result') {
      record = await this.move(record, input.action === 'accept' ? 'accepted' : 'needs_changes', input.actorId);
      return input.action === 'accept' ? '已记录验收通过。' : '已记录需要修改。请回复结果卡片，说明具体修改要求。';
    }
    if (!await this.live(record)) {
      const message = await this.expiryMessage(record);
      await this.renderClosed(await this.move(record, 'expired'), message);
      throw new LarkServiceError('LARK_INTERACTION_EXPIRED', message, 409);
    }
    // 结构化卡只接受选项集合内的提交值：单选值来自按钮 value，多选值来自表单 form_value。
    // 校验在 resolving CAS 之前，失败时卡片保持 pending，读者仍可引用卡片回复。
    let answerText = '';
    let echo = '';
    if (input.action === 'answer') {
      // 严格选项校验只约束卡片回调：按钮/表单的提交值必须是渲染过的选项，防止伪造 value。
      // 引用卡片回复走的是人类自由文本（低版本兜底入口），即使是结构化卡也照常接受。
      if (record.structured && input.callback) {
        const values = (this.broker?.get(record.nativeId)?.choices ?? []).map(choice => choice.value ?? choice.label);
        const invalidChoice = () => new LarkServiceError('LARK_ANSWER_CHOICE_INVALID', '提交的选项已失效，请点选卡片上的最新选项，或引用本卡片直接回复答案。', 400);
        if (record.multiple) {
          const picked = Array.isArray(input.selected)
            ? [...new Set(input.selected.filter((value): value is string => typeof value === 'string'))]
            : [];
          if (!picked.length || picked.some(value => !values.includes(value))) throw invalidChoice();
          answerText = picked.join('、');
        } else {
          answerText = input.answer?.trim() ?? '';
          if (!answerText || !values.includes(answerText)) throw invalidChoice();
        }
      } else {
        answerText = input.answer?.trim() ?? '';
        // 文字回复对上某个选项时按该选项提交；对不上的仍按自由文本接受。
        const choice = matchChoice(this.broker?.get(record.nativeId)?.choices ?? [], answerText);
        if (choice !== undefined) answerText = choice;
        else if (!input.callback) echo = escapeLarkPromptEcho(larkCommandEcho(redactTraceText(answerText), 200));
      }
      if (!answerText) throw new LarkServiceError('LARK_ANSWER_EMPTY', '回答不能为空。', 400);
    }
    const answerLabel = record.kind === 'ask' && record.adhdMode === true
      ? (this.broker?.get(record.nativeId)?.choices ?? []).filter(choice => (input.selected ?? [answerText]).includes(choice.value ?? choice.label)).map(choice => choice.label).join('、') || undefined
      : undefined;
    record = await this.move(record, 'resolving', input.actorId);
    try {
      // The authoritative broker/runtime repeats the single-consumer and liveness check.
      if (input.action === 'answer') await this.broker!.answer(record.nativeId, answerText, { sessionId: record.sessionId });
      else {
        const resolved = await this.runtime.resolvePermission!(record.sessionId, record.nativeId, input.action !== 'reject');
        if (resolved === false) throw stale();
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'PERMISSION_ACCEPTED_AUDIT_FAILED') {
        if (input.action === 'allow_session') this.allowForSession(record);
        await this.move(record, input.action === 'reject' ? 'rejected' : 'approved').catch(() => undefined);
        return '执行端已接受决策，审计回执暂未完成；请勿重复提交。';
      }
      // Runtime may reject before its driver consumes the decision (for example
      // while persisting intent). A live permission remains safely retryable;
      // do not burn its fixed interaction id. Relay asks have no equivalent
      // recoverable state and retain the expired behavior below.
      const code = (error as { code?: string }).code;
      if (record.kind === 'permission' && !['PERMISSION_NOT_FOUND', 'PERMISSION_EXPIRED', 'LARK_INTERACTION_EXPIRED'].includes(code ?? '') && await this.live(record)) {
        const pending = await this.move(record, 'pending');
        await this.renderPendingPermission(pending);
        throw error;
      }
      await this.renderClosed(await this.move(record, 'expired'), await this.expiryMessage(record));
      throw error;
    }
    if (input.action === 'allow_session') this.allowForSession(record);
    const state = input.action === 'answer' ? 'answered' : input.action === 'reject' ? 'rejected' : 'approved';
    try { record = await this.move(record, state, undefined, answerLabel ? { answerLabel } : {}); }
    catch { return '执行端已接受决策，回执记录暂未更新；请勿重复提交。'; }
    // 关闭后的卡写清结果、处理人和时间；ADHD 模式回显受控选项文案，自由文本回答不上卡。
    const actor = isGroupChat(record.event.chatType) && record.actorId ? renderGroupMention(record.actorId) : undefined;
    const outcome = [input.action === 'answer' ? answerLabel ? `已${answerLabel}` : '已回答' : input.action === 'reject' ? '已拒绝' : '已允许', actor, shanghaiClock(Date.parse(record.updatedAt))].filter(Boolean).join(' · ');
    const rendered = await this.renderClosed(record, input.action === 'allow_session' ? `${outcome}\n\n本会话内完全相同的命令之后会自动允许。` : outcome);
    if (!rendered) return '已处理，卡片状态更新失败，稍后自动重试；请勿重复提交。';
    if (input.action === 'answer') return echo ? `回答已送达原任务：${echo}` : '回答已送达原任务。';
    return input.action === 'allow_session' ? '已允许，本会话内完全相同的命令之后会自动允许。' : input.action === 'approve' ? '执行端已接受本次批准。' : '执行端已接受拒绝。';
  }
  async quoted(appId: string, event: LarkMessageEvent) {
    if (!event.parentId) return undefined;
    return (await this.list(appId)).find(record => (record.cardId === event.parentId || (record.kind === 'result' || record.kind === 'plan') && record.relatedCardIds?.includes(event.parentId!)) && record.event.chatId === event.chatId);
  }
}
