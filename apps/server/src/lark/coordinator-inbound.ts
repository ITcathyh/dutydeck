import type { CommandServices, ButtonServices, WorkflowServices } from './handlers/service-context.js';
import type { ButtonResult, ButtonSource } from './handlers/button-context.js';
import { answer as answerWorkflow } from './handlers/workflow-commands.js';
import { storedButtons } from './handlers/stored-buttons.js';
import { taskButtons } from './handlers/task-buttons.js';
import { resolveCallback } from './handlers/callbacks.js';
import { turnDecisionKey } from './recovery-decision.js';
import { fromRecord } from './turn-record.js';
import { annotateDisposition, type Disposition } from './disposition.js';
import { larkMessageAnchor } from './message-anchor.js';
import { runAgentScheduleRequest } from '../agent-schedule-request.js';
import { larkElapsedLabel } from './card-status.js';
import { agentSettingsConfirmKind, parseAgentSettings, showAgentSettings } from './agent-settings.js';
import { createHash } from 'node:crypto';
import { jsonSha256 } from '../hash.js';
import { describeLarkTaskRecovery, larkContinuePrompt } from './task-recovery.js';
import type { LarkInteraction } from './workflow-interactions.js';
import { formatUnknownTaskTime as deadlineText } from '../task-resolution.js';
import type { LarkInboxAdoption, LarkInboxRecord } from './task-inbox.js';
import { larkTurnIdentityError, larkConfirmationInputDigest, isLarkFirstCardUndelivered } from './task-inbox.js';
import { parseLarkNewSession } from './new-session.js';
import { formatLarkHandoff, larkHandoffEventLimit, larkHandoffIndexLimit } from './handoff.js';
import { explicitFinalContext, readExplicitFinal } from './explicit-final.js';
import { redactTraceText } from './secret-redaction.js';
import { readGitSnapshot } from './git-status.js';
import { buildLarkTaskDashboard, pageLarkTaskDashboard, type LarkTaskDashboardDecision, type LarkTaskDashboardEntry } from './task-dashboard.js';
import { collectInbox } from '../inbox.js';
import { isRunnable } from '../ci-common.js';
import { describeScheduleTrigger, scenarioPolicyVersion, parseLarkSourceId, resolveParticipation, RuntimeError, timeLoop, type ChannelMapping, type PolicyAction, type Session, type TaskRecord } from '@dutydeck/shared';
import { decideWake, isExplicitWake, wakeSignals, type WakeFacts } from './wake-decision.js';
import { directScenarioPrompt } from './scenario-direct.js';
import { larkScenarioAdoptionOf } from './scenario-legacy.js';
import { isBotSenderType, renderGroupMention } from './card-mentions.js';
import { larkExecutionIdentity, larkPermissionMode, readLarkConfig, type StoredLarkConfig } from './config.js';
import type { LarkMessageResource } from './message-content.js';
import { LarkServiceError, type LarkChatMessage } from './service.js';
import { isLarkDeterministicFailure } from './api-gate.js';
import { larkRecoveryNoticeExpired, larkRedispatchMaxAgeMs } from './turn-redispatch.js';
import { busyProgressSummary, eventsForRuntimeTask, loadLarkTaskWindow, renderLarkResultElements, terminalTaskStates, type LarkCardElement } from './card-renderer.js';
import { larkResultDeliveryIssues } from './reconciler.js';
import { larkSessionDetailUrl } from './detail-link.js';
import { clock } from './group-task-context.js';
import { isLarkCardActionAvailable, parseLarkCardActionValue, safeLarkWebUrl } from './card-actions.js';
import {
  larkAgentAvailabilityLine, larkCommandCapabilities, larkCommandEcho, larkHelpCardTitle,
  parseSlashCommand, resolveLarkCommand, routeLarkCommand, type LarkCommandRoute
} from './commands.js';
import { expandLarkPluginCommand, larkPluginCommandHelp, resolveLarkPluginQuery, callLarkPluginQuery, pluginQueryReplyText } from './plugin-commands.js';
import { clipCodePoints, escapeLarkPromptEcho } from './queue-summary.js';
import { unwrapEditedTextContent } from './edited-message.js';
import { withLarkContextReadTimeout } from './context-read-timeout.js';
import { larkNotice } from './notify-tier.js';
import { claimLarkTaskDispatches, larkTaskAgentAllowlistConfigured, larkTaskAgentGuid, releaseLarkTaskClaim } from './task-agent.js';
import { buildRepairConfirmCard, renderRepairResultCard, runOpenPlatformRepair } from './repair.js';
import { connectLarkOpenPlatformSession } from './open-platform-session.js';
import { findLarkThreadContinuation, listPersistedLarkSessions, larkSessionMatchesScope, larkGroupKey, larkSessionConfigKey, parsePrompt, resolveLarkScopeId, sameWorkspace } from './session-resolver.js';
import type { LarkMessageEvent } from './listener.js';
import type { LarkGroup, LarkTask, PersistedLarkCardTask } from './coordinator.js';
import { parseCardTask, parseOptionalCardTask } from './persisted-card-task.js';
import { type LarkCommandPrompt, larkCardChannel, larkHumanTaskAllowed, type LarkRelaunchClaim, larkTaskTitle, sendTaskCard } from './coordinator-core.js';
import { LarkCoordinatorDispatch, larkCancelledBeforeSubmit, larkTurnRequest, larkTurnRequestKey } from './coordinator-dispatch.js';
import { planReplyAction } from './plan-flow.js';
import { AgentCommandParamError, agentCommandConfirmSummary, agentCommandPlan, larkAgentCommandKind, type LarkAgentCommandRequest, type LarkAgentViewRequest, type LarkAgentSettingsRequest } from './agent-command.js';
import type { LarkConfirmRecord } from './confirm-cards.js';
/** 命令回执的去向：不传时照常发卡；capture 时只记下、不发卡（dutydeck agent 的查看类），否则发卡的同时记下。 */
export interface LarkCommandReceipts { capture: boolean; deliveryFailed?: boolean; notice?: string; cards: Array<{ title: string; markdown: string; failed: boolean; elements?: LarkCardElement[] }> }
const larkPlainText = (markdown: string) => markdown.replace(/\*\*/g, '').trim();

// 飞书消息协调器 · 入站唤醒：入站消息与卡片回调的入口和路由、聊天命令与 /status、
// 工作流与问答回复、群参与认领，以及飞书任务的认领。

/** 私信里的登录卡：一句说明、链接按钮、一句使用限制。登录链接只出现在这张卡上。 */
const larkDetailLoginElements = (url: string): LarkCardElement[] => [
  { tag: 'markdown', content: '点击下方按钮登录 Dutydeck Web，并打开这个任务的会话页。', margin: '0px' },
  { tag: 'button', text: { tag: 'plain_text', content: '打开任务详情' }, type: 'primary', behaviors: [{ type: 'open_url', default_url: url }], margin: '0px' },
  { tag: 'markdown', content: "<font color='grey'>10 分钟内有效、只能用一次，不要转发。</font>", text_size: 'notation', margin: '0px' }
];

/** 私信里的只读详情卡：和新卡页脚「查看详情」是同一个分享链接 */
const larkSessionShareElements = (url: string): LarkCardElement[] => [
  { tag: 'markdown', content: '点击下方按钮打开这个任务的只读详情页，不用登录。', margin: '0px' },
  { tag: 'button', text: { tag: 'plain_text', content: '打开任务详情' }, type: 'primary', behaviors: [{ type: 'open_url', default_url: url }], margin: '0px' },
  { tag: 'markdown', content: "<font color='grey'>只能查看这一个任务；管理员轮换分享密钥后失效。</font>", text_size: 'notation', margin: '0px' }
];

/** 首张进度卡没送达时，进程内重试整条入站处理的等待时间。 */
const larkUndeliveredRetryDelaysMs = [30_000, 120_000];
/** 启动恢复一条入站消息瞬时失败后的重试间隔：30 秒起翻倍，最长 5 分钟；记录过了恢复年龄上限就不再重试。 */
const larkInboundRecoveryDelayMs = (attempt: number) => Math.min(30_000 * 2 ** (attempt - 1), 300_000);
/** 过期提问的文字回复：附上原问题，作为一条新消息交给 Agent。不是这种情况返回 undefined。 */
const expiredAskPrompt = (error: unknown, answer: string) =>
  error instanceof LarkServiceError && error.code === 'LARK_ASK_EXPIRED' && typeof error.details?.question === 'string'
    ? `[你之前的提问] ${error.details.question}\n[用户的回复] ${answer}` : undefined;

const larkExecutionIdentityLine = () =>
  `**执行身份**：\`${larkCommandEcho(larkExecutionIdentity(), 128)}\`（部署这台 Dutydeck 的系统账号）。任务以它运行，能用到它的文件、凭据与网络；独立工作目录只隔离可写目录，不隔离这些。`;

/** C2：机器人话题里的短控制语。 */
const larkControlPhrases = new Map<string, 'continue' | 'stop' | 'restart'>([
  ['继续', 'continue'], ['接着做', 'continue'], ['接着来', 'continue'],
  ['停', 'stop'], ['停一下', 'stop'], ['先停', 'stop'], ['别做了', 'stop'], ['停止', 'stop'],
  ['重来', 'restart'], ['重新做', 'restart'], ['再来一次', 'restart']
]);

/** 去掉 @、空白和标点后整条消息（不超过 6 个字）就是一句控制语时返回它的意图，否则是普通消息。 */
export function larkControlPhrase(prompt: string) {
  const text = prompt.replace(/@\S+/g, '').replace(/[\s\p{P}\p{S}]/gu, '');
  return text.length <= 6 ? larkControlPhrases.get(text) : undefined;
}

type ChatCommandReply = (taskName: string, markdown: string, options?: { elements?: LarkCardElement[]; failed?: boolean }) => Promise<{ messageId: string } | undefined>;

const larkForkStatusLabels: Record<string, string> = {
  queued: '排队中', running: '进行中', completed: '已完成', failed: '失败', interrupted: '已中断', cancelled: '已取消', reconcile_required: '需要核对'
};

/** 实时路径上清理已忽略入站记录的最小间隔。 */
const LARK_IGNORED_PRUNE_INTERVAL_MS = 3_600_000;
const reactionTaskConfirmKind = (appId: string) => `reaction_task.${appId}`;
const reactionBodyDigest = (message: LarkChatMessage) => jsonSha256([message.messageType, message.rawContent]);

export class LarkCoordinatorInbound extends LarkCoordinatorDispatch {
  async initializeWorkflows(config: StoredLarkConfig) {
    this.state.reconcileConfig = config;
    this.parts.core.applyReminderSettings(config);
    this.parts.cards.registerTurnDiffReview(config.appId);
    this.registerAgentCommandConfirm(config.appId);
    this.registerAgentSettingsConfirm(config.appId);
    this.registerReactionTaskConfirm(config.appId);
    await this.parts.core.workflows.initialize(config.appId);
    await this.recoverAutoVerifications(config).catch(error => this.state.log.warn({ error, appId: config.appId }, '重启后收尾自动验证失败'));
    await this.pruneIgnoredInbox(config.appId);
    // 入站恢复仍在监听建连之前、逐条完成：上次没处理完的旧请求先排进各自会话的队列，建连后新到的消息
    // （包括 /new）排在它们后面，不会反过来插队。单条记录失败只影响这一条，不让初始化抛出、不阻止建连；
    // 瞬时失败的记录交还后在后台重试，不占着建连。
    for (const record of await this.parts.core.inbox.orphanedCommands(config.appId)) {
      try {
        await this.parts.core.inbox.update(record, { state: 'failed', error: '重启后无法确认命令是否完成；如未生效，请重新发送。' });
        const actor = record.event.senderOpenId;
        // 旧命令（larkRecoveryNoticeExpired）只记失败，不在群里回复。
        const receivedAt = Number(record.event.createTime) || Date.parse(record.receivedAt ?? '');
        if (actor && !larkRecoveryNoticeExpired(receivedAt) && await this.parts.core.currentAccess(config, record.event.chatId, record.event.chatType, actor, 'task.view_result')) {
          await this.workflowReply(record.event, config, '重启后无法确认这条命令是否完成。如结果未生效，请重新发送该命令。', { failed: true }).catch(error => this.state.log.warn({ error }, '命令恢复回执发送失败'));
        }
      } catch (error) {
        this.state.log.warn({ error, messageId: record.event.messageId }, '重启后收尾命令记录失败，跳过这一条');
      }
    }
    for (const record of await this.parts.core.inbox.recoverable(config.appId)) await this.recoverInbound(record, config);
    await this.recoverAcceptedCards(config);
  }

  async recoverAcceptedCards(config: StoredLarkConfig, only?: ReadonlySet<string>) {
    const held = new Set<string>();
    if (!this.state.runtime.getAcceptedTask) return held;
    const records = only ? await Promise.all([...only].map(id => this.parts.core.inbox.lookup(config.appId, id))) : await this.parts.core.inbox.cardRecoveryRecords(config.appId);
    for (const record of records) {
      if (this.state.stopped || !record?.sessionId) continue;
      if (record.state === 'failed' && record.error === larkTurnIdentityError) {
        held.add(record.event.messageId);
        continue;
      }
      if (record.state !== 'accepted') continue;
      const id = record.event.messageId;
      try {
        const mapping = await this.state.cardMappings.get(larkCardChannel(config.appId), id);
        if (await this.recoverAcceptedCard(config, record, mapping) === false) held.add(id);
      } catch (error) {
        held.add(id);
        this.state.log.warn({ error, messageId: id }, '接回飞书任务卡失败，稍后重试');
      }
    }
    return held;
  }

  private async recoverAcceptedCard(config: StoredLarkConfig, record: LarkInboxRecord, mapping?: ChannelMapping) {
    const { event, sessionId } = record;
    const id = event.messageId;
    const saved = parseOptionalCardTask(mapping?.extra);
    if (record.taskId && saved?.runtime_task_id && record.taskId !== saved.runtime_task_id) {
      this.state.log.warn({ appId: config.appId, messageId: id, taskId: record.taskId, mappedTaskId: saved.runtime_task_id }, '飞书入站记录与卡片归属不符，等待核对');
      return false;
    }
    const taskId = record.taskId ?? saved?.runtime_task_id;
    const turn = record.turn ?? saved?.turn ?? 1;
    const scopeId = record.request?.scopeId ?? saved?.scope_id;
    const prompt = record.request?.prompt ?? saved?.prompt;
    if (!sessionId || !taskId) return;
    if (!scopeId || !event.senderOpenId || prompt === undefined) return false;
    const live = this.state.tasks.get(id);
    if (live && (live.runtimeTaskId !== taskId || live.turn !== turn || live.sessionId !== sessionId)) return;
    const mappingMatches = !mapping || saved && mapping.sessionId === sessionId && saved.app_id === config.appId
      && saved.chat_id === event.chatId && saved.sender_open_id === event.senderOpenId && saved.scope_id === scopeId
      && (saved.turn ?? 1) === turn
      && (!saved.card_message_id || !record.cardId || saved.card_message_id === record.cardId);
    if (mappingMatches && saved?.runtime_task_id === taskId && (live || terminalTaskStates.has(saved.state))) return;
    const request = larkTurnRequest(sessionId, config.appId, event, turn, prompt);
    const accepted = this.readAcceptedTurn(request, taskId);
    const runtimeTask = accepted.task;
    if (runtimeTask && !['running', 'queued'].includes(runtimeTask.status)) return;
    if (!mappingMatches) {
      this.state.log.warn({ appId: config.appId, messageId: id, turn, taskId }, '飞书入站记录与卡片归属不符，等待核对');
      return false;
    }
    if (!runtimeTask) return accepted.mismatch ? false : undefined;
    const source = await this.state.runtime.getSession(sessionId);
    const chat = parseLarkSourceId(source?.sourceId);
    if (accepted.mismatch || record.appId !== config.appId || source?.source !== 'lark'
      || chat.appId !== config.appId || chat.chatId !== event.chatId || chat.chatType !== event.chatType
      || taskId !== this.state.runtime.getAcceptedTaskByKey(request.namespace, sessionId, request.key)?.task.id) {
      this.state.log.warn({ appId: config.appId, messageId: id, turn, taskId, mismatch: accepted.mismatch }, '飞书入站记录与执行归属不符，等待核对');
      return false;
    }
    if (live) return (await this.parts.cards.saveCardTask(live)).saved;
    const effective = event.chatType === 'group' && this.state.groupManager ? await this.state.groupManager.resolved(config, event.chatId) : config;
    const adopted = await this.parts.core.inbox.adoptAccepted(record);
    if (!adopted || this.state.stopped || this.state.tasks.has(id)) return;
    const key = larkGroupKey(event, scopeId, config.appId);
    const group = this.state.groups.get(key) ?? { tail: Promise.resolve() };
    this.state.groups.set(key, group);
    const restored = saved && fromRecord(saved, { externalId: id, sessionId }, effective);
    const task: LarkTask = Object.assign(restored ?? { id, config: effective, resources: [], events: [], sessionId, startedAt: Date.parse(runtimeTask.createdAt) }, {
      event: { ...event, replyMessageId: saved?.anchor_message_id ? restored?.event.replyMessageId : event.replyMessageId },
      prompt, group, inbox: adopted, state: 'queued' as const, turn: turn - 1, scopeId, epoch: group.epoch ?? 0,
      retryMaterialPrompt: restored?.retryMaterialPrompt ?? record.request?.materialPrompt, cardMessageId: restored?.cardMessageId ?? record.cardId,
      runtimeTaskId: taskId, fallbackNote: restored?.fallbackNote ?? record.fallbackNote, resumeTask: runtimeTask, restoring: true });
    this.state.tasks.set(id, task);
    this.state.handledMessages.add(id);
    group.tail = group.tail.then(() => this.runTurn(task)).catch(error => {
      if (this.state.tasks.get(id) === task) this.state.tasks.delete(id);
      this.state.log.warn({ error, taskId }, '恢复飞书任务交互失败');
      this.scheduleReconcile();
    });
  }

  /** 启动恢复里瞬时失败、正在等待重试的入站消息，按消息记已重试次数。 */
  private readonly inboundRecoveryRetries = new Map<string, number>();

  /** 卡片「重试」正在认领的任务（task.id）。 */
  private readonly retryInFlight = new Set<string>();

  /**
   * 恢复一条上次没处理完的入站消息。handle 会重新检查当前配置和成员身份，凭据从不重放。
   * - 超过恢复年龄上限：unrouted 静默 ignored；received 先按幂等键查执行账本（inboundTurnAccepted），
   *   已接收的照常重放接回结果；确认没接收的标 failed，给仍有权限的发送人提示重新发送；查不到的标 failed，
   *   只说结果未知，不说没有执行。旧消息（larkRecoveryNoticeExpired）不回。
   * - 平台明确拒绝（机器人不在群里、群已解散、没有权限）：标 failed 并写原因，重试也不会成功。
   * - 网络、5xx、超时这类瞬时失败：交还记录，退避后在后台重试，不丢；过了年龄上限按上一条收口。
   */
  async recoverInbound(record: LarkInboxRecord, config: StoredLarkConfig) {
    if (this.state.stopped) return;
    const messageId = record.event.messageId;
    const receivedAt = record.state === 'unrouted' ? Date.parse(record.receivedAt ?? '') : Number(record.event.createTime) || Date.parse(record.receivedAt ?? '');
    if (Date.now() - receivedAt > larkRedispatchMaxAgeMs) {
      this.inboundRecoveryRetries.delete(messageId);
      const hours = larkRedispatchMaxAgeMs / 3_600_000;
      try {
        if (record.state === 'unrouted') {
          await this.parts.core.inbox.update(record, { state: 'ignored', reason: 'backlog_expired' });
          this.scheduleIgnoredPrune(config.appId);
          return;
        }
        const accepted = await this.inboundTurnAccepted(record, config);
        if (accepted !== true) {
          const unknown = accepted === undefined;
          await this.parts.core.inbox.update(record, { state: 'failed', reason: 'backlog_expired',
            error: unknown ? `重启后超过 ${hours} 小时，无法确认是否已执行，不再自动执行。` : `重启后超过 ${hours} 小时仍未执行，不再自动执行。` });
          const actor = record.event.senderOpenId;
          if (actor && !larkRecoveryNoticeExpired(receivedAt) && await this.parts.core.currentAccess(config, record.event.chatId, record.event.chatType, actor, 'task.view_result')) {
            await this.workflowReply(record.event, config, unknown
              ? `服务重启后无法确认这条请求是否已经执行，且已超过 ${hours} 小时，不会自动重发。请先核对结果，如仍需要再重新发送。`
              : `服务重启后，这条请求已超过 ${hours} 小时没有执行，不会再自动执行。如仍需要，请重新发送。`,
              { failed: true, taskName: unknown ? '请求结果未知' : '请求未执行' });
          }
          return;
        }
      } catch (error) {
        this.state.log.warn({ error, messageId }, '过期的入站记录收尾失败');
        return;
      }
    }
    try {
      if (record.state === 'unrouted') await this.routeCaptured(record, config);
      else await this.handle(record.event, config, true);
      this.inboundRecoveryRetries.delete(messageId);
      return;
    } catch (error) {
      try {
        // 失败可能发生在路由或认领前后：仅交还库中仍待处理的 unrouted/received。
        const current = await this.parts.core.inbox.reload(record);
        if (current?.state !== 'received' && current?.state !== 'unrouted') return;
        const reason = error instanceof Error ? error.message : String(error);
        if (isLarkDeterministicFailure(error)) {
          this.inboundRecoveryRetries.delete(messageId);
          await this.parts.core.inbox.update(current, { state: 'failed', error: reason });
          this.state.log.warn({ error, messageId }, '重启恢复的入站消息被飞书明确拒绝，已标记失败');
          return;
        }
        const released = await this.parts.core.inbox.release(current);
        if (!released) return;
        const attempt = (this.inboundRecoveryRetries.get(messageId) ?? 0) + 1;
        this.inboundRecoveryRetries.set(messageId, attempt);
        const delayMs = larkInboundRecoveryDelayMs(attempt);
        const cancel = () => { clearTimeout(timer); this.state.turnCleanups.delete(cancel); };
        const timer = setTimeout(() => {
          cancel();
          void this.enqueueInbound(released.event.chatId, async () => {
            if (this.state.stopped) return;
            const latest = await this.parts.core.inbox.reload(released);
            // 等待期间被别的路径认领（例如同一条消息被再次推送）或已收口：不再重试。
            if (this.state.stopped || (latest?.state !== 'received' && latest?.state !== 'unrouted') || latest.boot) return;
            this.state.handledMessages.delete(messageId);
            await this.recoverInbound(latest, config);
          }).catch(retryError => this.state.log.error({ error: retryError, messageId }, '重试恢复入站消息失败'));
        }, delayMs);
        timer.unref?.();
        this.state.turnCleanups.add(cancel);
        this.state.log.warn({ error, messageId, attempt, retryInMs: delayMs }, '重启恢复入站消息暂时失败，稍后重试');
      } catch (settleError) {
        this.state.log.error({ error: settleError, cause: error, messageId }, '重启恢复入站消息失败后收口出错');
      }
    }
  }

  /**
   * 入站记录当前这一轮有没有被 runtime 接收。派发前一定先写会话和轮次，没写过就没有派发；
   * 写过时按这一轮的幂等键查执行账本。没有账本、会话或读取失败时返回 undefined（结果未知）。
   */
  private async inboundTurnAccepted(record: LarkInboxRecord, config: StoredLarkConfig): Promise<boolean | undefined> {
    const { sessionId, turn } = record;
    if (!sessionId || !turn) return false;
    if (!this.state.runtime.getAcceptedTask) return undefined;
    try {
      if (!await this.state.runtime.getSession(sessionId)) return undefined;
      const key = larkTurnRequestKey(config.appId, record.event.messageId, turn);
      return Boolean(this.state.runtime.getAcceptedTaskByKey('runtime', sessionId, key));
    } catch (error) {
      this.state.log.warn({ error, messageId: record.event.messageId }, '重启后查询入站请求的执行记录失败，按结果未知处理');
      return undefined;
    }
  }

  /**
   * 任务操作类命令的回执。
   *
   * `failed` 必须由调用方按语义传：这里原先写死 `state: 'completed'`，于是拒绝、报错和
   * 「命令可能没生效」的警告都顶着绿色色带和「已完成」发出去——读者看到的颜色和文字
   * 说的是相反的事。同文件的 replyCard 一直是按语义分的（见其 options.failed）。
   */
  private async workflowReply(
    event: LarkMessageEvent, config: StoredLarkConfig, markdown: string,
    options: { elements?: LarkCardElement[]; failed?: boolean; taskName?: string } = {}
  ) {
    return sendTaskCard(this.state.service, event, {
      taskId: event.messageId, taskName: options.taskName ?? '任务操作',
      state: options.failed ? 'failed' : 'completed', readOnly: true,
      permissionMode: larkPermissionMode(config), markdown, ...(options.elements ? { elements: options.elements } : {}),
      idempotencyKey: `workflow_reply_${event.replyKey ?? event.messageId}`.slice(0, 50) }, this.state.log);
  }

  private async taskDashboard(event: LarkMessageEvent, config: StoredLarkConfig, page: number) {
    const { entries, sessions } = await this.taskDashboardData(event, config);
    return buildLarkTaskDashboard(entries, page, undefined, event.chatId, await this.taskDashboardDecisions(event, config, sessions)).elements;
  }

  /**
   * 任务看板之外等人决定的对象：与 Web 总览「待你决定」同一套汇总，只取看板上没有行的类型，
   * 且只看 /tasks 已经按发送人权限筛出来的那些会话。这些对象的按钮绑在各自的原卡上，所以只给跳转。
   */
  private async taskDashboardDecisions(event: LarkMessageEvent, config: StoredLarkConfig, sessions: Map<string, { session: Session; url: string }>): Promise<LarkTaskDashboardDecision[]> {
    if (!event.senderOpenId) return [];
    const actorId = event.senderOpenId;
    const interactions = await this.parts.core.workflows.list(config.appId).catch(() => []);
    const items = await collectInbox({
      runtime: {
        getTasks: id => this.state.runtime.getTasks?.(id) ?? Promise.resolve([]),
        ...(this.state.runtime.getInboxTasks ? { getInboxTasks: (id: string) => this.state.runtime.getInboxTasks!(id) } : {})
      },
      store: this.state.workflowOptions.store,
      larkCards: async () => interactions,
      ...(this.state.workflowOptions.workbench ? { workItems: this.state.workflowOptions.workbench.inboxSource() } : {}),
      ...(this.state.workflowOptions.automation?.pullRequests ? { pullRequests: this.state.workflowOptions.automation.pullRequests } : {})
    }, [...sessions.values()].map(entry => entry.session), {
      actorFor: () => actorId,
      kinds: new Set(['plan', 'work_item_confirm', 'work_item_revision', 'work_item_answer', 'work_item_request', 'pull_request_confirm', 'pull_request_question'])
    }).catch(error => { this.state.log.warn({ error }, '读取任务看板的待决定对象失败'); return []; });
    return items.map(item => ({ kind: item.kind, title: item.title, session: item.sessionTitle, waitingMs: item.waitingMs, url: sessions.get(item.sessionId)?.url }));
  }

  /** /tasks 列出的任务：只有发送人能看结果的那些。 */
  async taskDashboardEntries(event: LarkMessageEvent, config: StoredLarkConfig) {
    return (await this.taskDashboardData(event, config)).entries;
  }

  private async taskDashboardData(event: LarkMessageEvent, config: StoredLarkConfig) {
    if (!event.senderOpenId) throw new LarkServiceError('LARK_IDENTITY_REQUIRED', '缺少当前成员身份。', 403);
    const entries: LarkTaskDashboardEntry[] = [];
    const sessions = new Map<string, { session: Session; url: string }>();
    const interactions = await this.parts.core.workflows.list(config.appId);
    // Agent 显示名只查一次；查不到名字就退化成 agentId，绝不留空让读者猜是谁在跑。
    const agentNames = new Map((await this.state.runtime.listAgents?.().catch(() => []) ?? []).map(agent => [agent.id, agent.name] as const));
    for (const mapping of await this.state.cardMappings.list(larkCardChannel(config.appId))) {
      const saved = parseCardTask(mapping.extra ?? '{}');
      if (saved.app_id !== config.appId || !saved.runtime_task_id) continue;
      if (event.chatType === 'group' ? saved.chat_id !== event.chatId : saved.sender_open_id !== event.senderOpenId) continue;
      if (saved.chat_type !== 'group' && saved.chat_id !== event.chatId) continue;
      try {
        if (!await this.parts.core.currentAccess(config, saved.chat_id, saved.chat_type ?? 'group', event.senderOpenId, 'task.view_result', mapping.sessionId)) continue;
      } catch { continue; }
      const session = await this.state.runtime.getSession(mapping.sessionId);
      const task = (await this.state.runtime.getTasks?.(mapping.sessionId))?.find(task => task.id === saved.runtime_task_id);
      if (!session || !task) continue;
      const taskReport = await this.state.runtime.getSessionTaskReport?.(mapping.sessionId);
      const pending = interactions.find(item => item.taskId === task.id && item.state === 'pending' && item.kind !== 'result' && item.boot === this.parts.core.workflows.boot);
      const result = interactions.find(item => item.taskId === task.id && item.kind === 'result');
      const host = config.brand === 'lark' ? 'applink.larksuite.com' : 'applink.feishu.cn';
      const url = new URL(`https://${host}/client/${saved.thread_id ? 'thread' : 'chat'}/open`);
      if (saved.thread_id) {
        for (const key of ['open_chat_id', 'openchatid']) url.searchParams.set(key, saved.chat_id);
        for (const key of ['open_thread_id', 'openthreadid']) url.searchParams.set(key, saved.thread_id);
        url.searchParams.set('thread_position', '-1');
      } else url.searchParams.set('openChatId', saved.chat_id);
      // 行内操作只认本进程内存里的活任务：重启后 tasks Map 为空，渲染不出按钮
      // （actionTaskId 缺省），避免发出主控无法定位的死按钮；slash 命令仍是兜底入口。
      const liveTask = this.state.tasks.get(mapping.externalId);
      const recovery = ['queued', 'reconcile_required', 'legacy_unresolved'].includes(task.status)
        ? await describeLarkTaskRecovery(this.state.runtime, mapping.sessionId, task.id, task.status) : undefined;
      const matter = this.state.runtime.getMatter?.(session.id);
      sessions.set(session.id, { session, url: url.toString() });
      entries.push({ ...(taskReport?.taskId === task.id ? { taskReport } : {}), ...(matter ? { matter: { id: matter.id, title: matter.title, sessionId: session.id, ...(session.name ? { sessionName: session.name } : {}), superseded: matter.supersededSessionIds?.includes(session.id) } } : {}), taskId: task.id, title: session.name ? `${session.name} · ${saved.task_name}` : saved.task_name, workspace: session.cwd, agent: agentNames.get(session.agentId) ?? session.agentId, status: pending && task.status === 'running'
        ? pending.kind === 'ask' ? 'waiting_for_answer' : 'waiting_for_permission' : task.status, updatedAt: task.updatedAt, url: url.toString(),
        ...(recovery ? { detail: recovery.markdown, blocked: recovery.blocked } : {}),
        ...(liveTask ? {
          actionTaskId: mapping.externalId,
          turn: liveTask.turn,
          ...(liveTask.retryable === false ? { retryable: false } : {})
        } : {}),
        ...(pending && pending.kind === 'permission' && task.status === 'running'
          ? {
              pendingApproval: {
                requestId: pending.id,
                generation: pending.boot,
                commandSummary: pending.question,
                chatId: pending.event.chatId
              }
            }
          : {}),
        ...(result && ['pending', 'accepted', 'needs_changes'].includes(result.state) ? { feedback: result.state as 'pending' | 'accepted' | 'needs_changes' } : {}) });
    }
    return { entries, sessions };
  }

  private workflowDependencies(workflows: NonNullable<typeof this.parts.core.workflows>): WorkflowServices {
    return {
      workflows,
      chatModeResolver: this.state.chatModeResolver,
      workflowReply: this.workflowReply.bind(this),
      saveTaskDashboardOrigin: this.saveTaskDashboardOrigin.bind(this),
      taskDashboard: this.taskDashboard.bind(this),
      expiredAskPrompt
    };
  }

  private async routeWorkflow(event: LarkMessageEvent, config: StoredLarkConfig, prompt: string, scope: { id: string; prompt?: string }, receipts?: LarkCommandReceipts): Promise<boolean> {
    const parsed = parseSlashCommand(prompt);
    const quoted = await this.parts.core.workflows.quoted(config.appId, event);
    const names = ['tasks', 'answer', 'approve', 'reject'];
    if (!quoted && (!parsed || !names.includes(parsed.name))) return false;
    if (isBotSenderType(event.senderType)) {
      await this.workflowReply(event, config, '任务操作需由人类成员发起。', { failed: true }); return true;
    }
    try {
      const command = parsed && resolveLarkCommand(parsed)?.workflow;
      const input = { event, config, prompt, scope, quoted, parsed, receipts };
      const deps = this.workflowDependencies(this.parts.core.workflows);
      if (parsed?.name === 'tasks' && command) return await command(deps, input);
      // 引用计划卡回复：「批准」「取消」按按钮处理，其余文字是修改意见。斜杠命令照常走命令路由。
      if (quoted?.kind === 'plan' && !parsed) {
        const result = await this.parts.core.workflows.respond({ appId: config.appId, chatId: event.chatId, actorId: event.senderOpenId, requestId: quoted.id, action: planReplyAction(prompt), answer: prompt });
        await this.workflowReply(event, config, result);
        return true;
      }
      if (quoted?.kind === 'result' && prompt.trim() === '验收通过') {
        const result = await this.parts.core.workflows.respond({ appId: config.appId, chatId: event.chatId, actorId: event.senderOpenId, requestId: quoted.id, action: 'accept' });
        await this.parts.cards.refreshResultFeedback(config, quoted.id).catch(error => this.state.log.warn({ error }, '验收已记录，卡片刷新失败'));
        await this.workflowReply(event, config, result);
        return true;
      }
      if (quoted?.kind === 'result' && (!parsed || !names.includes(parsed.name))) {
        if (!event.senderOpenId || !await this.parts.core.authorizeInteraction(quoted, event.senderOpenId, 'run.interrupt')) throw new LarkServiceError('LARK_INTERACTION_DENIED', '当前账号无权修改此任务。', 403);
        const mapping = (await this.state.cardMappings.get(larkCardChannel(config.appId), quoted.event.messageId))!;
        const saved = parseCardTask(mapping.extra!);
        if (!saved.scope_id) throw new LarkServiceError('LARK_CONTEXT_MISSING', '原任务上下文不可恢复，请发送新的任务目标。', 409);
        if (quoted.state === 'pending') {
          await this.parts.core.workflows.respond({ appId: config.appId, chatId: event.chatId, actorId: event.senderOpenId, requestId: quoted.id, action: 'changes' });
          await this.parts.cards.refreshResultFeedback(config, quoted.id).catch(error => this.state.log.warn({ error }, '修改要求已记录，卡片刷新失败'));
        }
        // A follow-up after acceptance is a new task in the same context; the
        // accepted result remains an accurate record of the previous version.
        scope.id = saved.scope_id;
        return false;
      }
      return await (command ?? answerWorkflow)(deps, input);
    } catch (error) {
      await this.workflowReply(event, config, error instanceof Error ? error.message : String(error), { failed: true });
    }
    return true;
  }

  private async pendingAskCandidates(event: LarkMessageEvent, config: StoredLarkConfig, scopeId: string): Promise<LarkInteraction[]> {
    const candidates: LarkInteraction[] = [];
    let continued: Promise<string | undefined> | undefined;
    for (const record of await this.parts.core.workflows.pendingAsks(config.appId)) {
      // 话题续接了发起人顶层任务的会话：那个会话里等着的提问，也收本人在这个话题里的回答。
      continued ??= this.threadContinuation(event, config, scopeId).then(session => session?.id);
      if (record.sessionId === await continued && record.event.chatId === event.chatId && record.event.senderOpenId === event.senderOpenId) { candidates.push(record); continue; }
      if (record.event.threadId && event.threadId && record.event.threadId !== event.threadId) continue;
      const originalRoot = record.event.rootId ?? (record.event.threadId ? larkMessageAnchor(record.event) : undefined);
      const replyRoot = event.rootId ?? (event.threadId ? larkMessageAnchor(event) : undefined);
      if (originalRoot !== replyRoot) continue;
      if (record.event.chatId === event.chatId && record.event.senderOpenId === event.senderOpenId
        && await resolveLarkScopeId(record.event, config, this.state.chatModeResolver) === scopeId) candidates.push(record);
    }
    return candidates;
  }

  /**
   * 群参与开启时，这轮对话的根消息由同一用户发出，这条回复针对根消息或本机器人的消息、没有 @ 任何人，
   * 且对应会话仍在进行：它是在继续和机器人对话，不必再 @。回复其他人的消息保持原有路由。
   */
  private async continuesOwnRequest(event: LarkMessageEvent, config: StoredLarkConfig, durable = false): Promise<boolean> {
    const rootId = event.rootId?.trim();
    const parentId = event.parentId?.trim();
    if (event.chatType !== 'group' || event.senderType !== 'user' || !event.senderOpenId || !rootId || rootId === event.messageId
      || event.mentions.length || !this.state.botOpenId || !this.state.groupManager) return false;
    try {
      if (await this.state.workflowOptions.participation!.mode({ appId: config.appId, chatId: event.chatId }) === 'off') return false;
      const scopeId = await resolveLarkScopeId(event, config, this.state.chatModeResolver);
      // 续接了发起人顶层会话的话题没有自己的会话，按它续接的那个会话算。
      if (!await this.state.groupManager.hasActiveSession(config, event, scopeId) && !await this.threadContinuation(event, config, scopeId)) return false;
      const root = await this.state.service.getMessage(rootId);
      if (root.messageId !== rootId || root.chatId !== event.chatId || root.deleted || root.sender.type !== 'user' || root.sender.id !== event.senderOpenId) return false;
      // 话题会话本身证明机器人接过这个话题；普通群按人归属的会话证明不了，根消息必须是 @ 本机器人的请求。
      // 消息读取接口把被 @ 的机器人报成 app_id，实时事件里才是 open_id，两种都认。
      if (!event.threadId?.trim() && !root.mentions.some(mention => mention.id === this.state.botOpenId || mention.idType === 'app_id' && mention.id === config.appId)) return false;
      if (!parentId || parentId === rootId) return true;
      const parent = await this.state.service.getMessage(parentId);
      return parent.messageId === parentId && parent.chatId === event.chatId && !parent.deleted
        && ['app', 'bot'].includes(parent.sender.type ?? '') && (parent.sender.id === config.appId || parent.sender.id === this.state.botOpenId);
    } catch (error) { if (durable) throw error; return false; }
  }

  /** 查不到或查询出错都当作不续接，按原逻辑新建会话。 */
  async threadContinuation(event: LarkMessageEvent, config: StoredLarkConfig, scopeId: string) {
    try { return await findLarkThreadContinuation(this.state.runtime, config, event, scopeId, this.state.cardMappings); }
    catch (error) {
      this.state.log.warn({ error, chatId: event.chatId, messageId: event.messageId }, '查询话题续接的会话失败，按新话题处理');
      return undefined;
    }
  }

  private async continuesPendingAsk(event: LarkMessageEvent, config: StoredLarkConfig, durable = false): Promise<boolean> {
    if (!event.senderOpenId || event.senderType !== 'user' || !['text', 'post', 'rich_text'].includes(event.messageType)
      || event.parentId && (!event.threadId || event.parentId !== event.rootId)) return false;
    try {
      const { prompt, resources } = await parsePrompt(event, this.state.botOpenId);
      if (!prompt.trim() || resources.length || parseSlashCommand(prompt)) return false;
      const scopeId = await resolveLarkScopeId(event, config, this.state.chatModeResolver);
      return (await this.pendingAskCandidates(event, config, scopeId)).some(record => this.parts.core.workflows.acceptsReply(record, prompt));
    } catch (error) { if (durable) throw error; return false; }
  }

  private async routePendingAsk(event: LarkMessageEvent, config: StoredLarkConfig, prompt: string, resources: LarkMessageResource[], scope: { id: string; prompt?: string }, inbox: LarkInboxRecord | undefined, recovering: boolean): Promise<boolean> {
    if (!event.senderOpenId || event.senderType !== 'user' || !['text', 'post', 'rich_text'].includes(event.messageType)
      || !prompt.trim() || resources.length || parseSlashCommand(prompt)
      // Ordinary topic replies point at the topic root. A different parent
      // is an explicit quote and must retain its existing routing semantics.
      || event.parentId && (!event.threadId || event.parentId !== event.rootId)) return false;
    let requestId = inbox?.workflowRequestId;
    if (!requestId) {
      // Recovery must not reinterpret an old message as a reply to a new ask.
      if (recovering) return false;
      // 带选项的提问只认对得上某个选项的回复，其余文字按普通消息处理。
      const candidates = (await this.pendingAskCandidates(event, config, scope.id)).filter(record => this.parts.core.workflows.acceptsReply(record, prompt));
      if (!candidates.length) return false;
      if (candidates.length > 1) {
        if (inbox) await this.parts.core.inbox.update(inbox, { state: 'command' });
        await this.workflowReply(event, config, '当前有多个问题等待回答，请引用要回答的提问卡片回复。');
        return true;
      }
      requestId = candidates[0]!.id;
      // Pin the waiter before answering: if acknowledgement fails or the
      // daemon restarts, this message can never answer a later question.
      if (inbox) await this.parts.core.inbox.update(inbox, { workflowRequestId: requestId });
    }
    try {
      const result = await this.parts.core.workflows.respond({ appId: config.appId, chatId: event.chatId, actorId: event.senderOpenId, requestId, action: 'answer', answer: prompt });
      await this.workflowReply(event, config, result);
    } catch (error) {
      const handover = expiredAskPrompt(error, prompt);
      if (handover) { scope.prompt = handover; return false; }
      await this.workflowReply(event, config, error instanceof Error ? error.message : String(error), { failed: true });
    }
    return true;
  }

  scheduleTaskAgentPoll(config: StoredLarkConfig) {
    if (this.state.stopped || this.state.taskAgentTimer) return;
    this.state.taskAgentTimer = setTimeout(() => {
      this.state.taskAgentTimer = undefined;
      if (this.state.stopped) return;
      void timeLoop('lark.task-agent-poll', this.state.log, () => this.pollLarkTaskDispatches(config), undefined, config.appId)
        .catch(error => this.state.log.warn({ error, appId: config.appId }, '飞书任务智能体通道轮询失败，下一轮重试'))
        .finally(() => this.scheduleTaskAgentPoll(config));
    }, this.state.taskAgentIntervalMs);
    this.state.taskAgentTimer.unref();
  }

  /**
   * 拉取分配给本机器人的飞书任务并逐条交给消息入口。返回本轮真正派出去的条数。
   *
   * 认领与交接必须成对：claimLarkTaskDispatches 先把任务在账本上认领下来，交接抛错时
   * 这里把尚未进入持久化 inbox 的认领退回；进程中断的遗留认领由下一进程接手。
   */
  async pollLarkTaskDispatches(config: StoredLarkConfig): Promise<number> {
    const store = this.state.workflowOptions.store;
    if (this.state.stopped) return 0;
    if (this.state.taskAgentRun) return this.state.taskAgentRun;
    const run = (async () => {
      // 定时器和事件带的可能是启动时的旧配置：监听开关与白名单门按当前保存的配置判断，与 handle 同口径。
      const current = await readLarkConfig(store, config.appId);
      if (!current?.listening) return 0;
      const intake = await claimLarkTaskDispatches({
        appId: config.appId, client: this.state.service, store, botConfig: current, log: this.state.log,
        hasHandoff: dispatch => store.get(`lark.inbox.${config.appId}.${dispatch.event.messageId}`).then(Boolean)
      });
      if (intake.status !== 'ready') return 0;
      let dispatched = 0;
      try {
        for (const dispatch of intake.dispatches) {
          if (this.state.stopped) break;
          try {
            await this.handle(dispatch.event, config);
            if (await store.get(`lark.inbox.${config.appId}.${dispatch.event.messageId}`)) dispatched++;
          } catch (error) {
            this.state.log.warn({ error, taskGuid: dispatch.taskGuid }, '飞书任务交接失败，未入站任务等待下一轮重派');
          }
        }
      } finally {
        // The inbox owns handed-off tasks, including received tasks awaiting recovery.
        // Release every remaining claim on stop, early handle return, or failure.
        for (const dispatch of intake.dispatches) {
          if (await store.get(`lark.inbox.${config.appId}.${dispatch.event.messageId}`)) continue;
          await releaseLarkTaskClaim(store, dispatch.ledgerKey, dispatch.claimValue)
            .catch(error => this.state.log.error({ error, taskGuid: dispatch.taskGuid }, '退回飞书任务认领失败'));
        }
      }
      return dispatched;
    })().finally(() => { if (this.state.taskAgentRun === run) this.state.taskAgentRun = undefined; });
    this.state.taskAgentRun = run;
    return run;
  }

  /**
   * task.task.update_user_access_v2（含 task_assignees_update）事件入口：立即走一次与
   * 定时轮询完全相同的认领流程，不必等下一轮轮询。幂等性由 claimLarkTaskDispatches 的
   * ledger CAS 与 taskAgentRun 的在途合并共同保证——重复事件、事件与轮询并发都只会认领
   * 一次。通道未激活时 pollLarkTaskDispatches 内部直接返回 0，无需在此重复判定。
   * 不 await：事件回调不能被一次交接拖死，失败由保留的定时轮询兜底重试。
   */
  handleTaskAssigneesUpdate(config: StoredLarkConfig): void {
    void this.pollLarkTaskDispatches(config)
      .then(dispatched => {
        if (dispatched > 0) this.state.log.info({ appId: config.appId, dispatched }, '飞书任务指派人变更事件触发即时认领');
      })
      .catch(error => this.state.log.warn({ error, appId: config.appId }, '飞书任务事件触发认领失败，等待轮询兜底'));
  }

  private async rejectIncoming(event: LarkMessageEvent, config: StoredLarkConfig, reason: string, explicit: boolean) {
    if (!explicit || this.state.handledMessages.has(event.messageId)) return;
    this.state.handledMessages.add(event.messageId);
    if (this.state.handledMessages.size > 5_000) this.state.handledMessages.delete(this.state.handledMessages.values().next().value!);
    const inbox = await this.parts.core.inbox.claim(config.appId, event, true);
    if (!inbox) return;
    await sendTaskCard(this.state.service, event, {
      state: 'failed', readOnly: true, retryable: false, taskId: event.messageId, taskName: '请求未执行',
      markdown: `**请求未执行，Agent 尚未启动。**\n\n${reason}\n\n请联系此机器人的管理员检查群配置、运行权限和你的访问授权，确认生效后重新发送。`,
      idempotencyKey: `input_denied_${event.messageId}`.slice(0, 50)
    }, this.state.log).catch(error => this.state.log.warn({ error, messageId: event.messageId }, '发送未执行回执失败'));
    if (inbox) await this.parts.core.inbox.update(inbox, { state: 'failed', error: reason });
  }

  /** Confirmation checks the clicker's current task permissions, never the original sender's. */
  async canConfirmParticipation(scope: { appId: string; chatId: string }, actor: string): Promise<boolean> {
    let config = await readLarkConfig(this.state.workflowOptions.store, scope.appId);
    if (!config?.listening || this.state.stopped) return false;
    if (this.state.groupManager) config = await this.state.groupManager.resolved(config, scope.chatId);
    await this.parts.core.requireExecution('listener', 'task.create');
    return this.parts.core.currentAccess(config, scope.chatId, 'group', actor, 'task.create', undefined, actor);
  }

  /** 群参与投递前复核触发消息的机器人：按当前配置（含群级覆盖）重新判断它是否仍受信。 */
  async trustsBotSender(config: StoredLarkConfig, chatId: string, senderOpenId: string): Promise<boolean> {
    if (this.state.stopped) return false;
    if (this.state.groupManager) config = await this.state.groupManager.resolved(config, chatId);
    return this.parts.core.isTrustedBot(config, { senderType: 'app', senderOpenId, chatId });
  }

  /** 内部收养请求仍经过普通入口的授权、领取和执行。 */
  adopt(event: LarkMessageEvent, config: StoredLarkConfig) {
    // 只有内部 dispatcher 的场景派生可改变执行身份/话题，正文始终沿用持久原文。
    const adoption: LarkInboxAdoption | undefined = event.scenario || event.authorization ? {
      senderOpenId: event.senderOpenId, senderType: event.senderType, scenario: event.scenario, authorization: event.authorization,
      rootId: event.rootId, threadId: event.threadId, parentId: event.parentId,
      ...(event.authorization?.via === 'participation_confirmed' ? { confirmedInputDigest: larkConfirmationInputDigest(event) } : {})
    } : undefined;
    return this.handle(event, config, false, true, undefined, undefined, adoption);
  }

  private readonly intakeTails = new Map<string, Promise<void>>();
  /** 每个机器人上次清理已忽略记录的时间，以及是否已排了下一次。 */
  private readonly ignoredPrunes = new Map<string, { lastRunAt: number; pending: boolean }>();

  /** SDK 只等待本地接收。同群路由保持接收顺序，其他群不受慢权限查询影响。 */
  async receive(event: LarkMessageEvent, config: StoredLarkConfig, trustedReplyMessageId?: string) {
    const record = await this.parts.core.inbox.capture(config.appId, event, trustedReplyMessageId);
    if (!record) return;
    void this.enqueueInbound(record.event.chatId, () => this.recoverInbound(record, config))
      .catch(error => this.state.log.error({ error, messageId: event.messageId }, '处理已接收的飞书消息失败'));
  }

  private enqueueInbound(chatId: string, operation: () => Promise<void>) {
    const prior = this.intakeTails.get(chatId) ?? Promise.resolve();
    const next = prior.then(() => new Promise<void>(resolve => setImmediate(resolve))).then(operation);
    const settled = next.catch(() => {});
    this.intakeTails.set(chatId, settled);
    void settled.then(() => { if (this.intakeTails.get(chatId) === settled) this.intakeTails.delete(chatId); });
    return next;
  }

  handleEdited(event: LarkMessageEvent, config: StoredLarkConfig) {
    return this.enqueueInbound(event.chatId, async () => {
      await this.parts.core.inbox.reopenIgnored(config.appId, event);
      const record = await this.parts.core.inbox.capture(config.appId, event);
      if (record) return this.recoverInbound(record, config);
      return this.handle(event, config);
    });
  }

  async handleReaction(messageId: string, emoji: string, actor: string, config: StoredLarkConfig) {
    const { store, participation } = this.state.workflowOptions;
    const confirmations = participation?.confirmations;
    if (this.state.stopped || !store.compareAndSet || !confirmations || !config.listening || emoji !== config.reactionTriggerEmoji) return;
    try {
      const message = await withLarkContextReadTimeout(signal => this.state.service.getMessage(messageId, signal), '读取表情来源消息');
      const { chatId, sender, messageType, threadId, rootId } = message;
      if (message.messageId !== messageId || !chatId || message.deleted || !sender.id
        || sender.id === config.appId || sender.id === this.state.botOpenId || !['text', 'post', 'rich_text'].includes(messageType)) {
        this.state.log.info({ appId: config.appId, messageId, actor }, '表情来源不是可处理的文本消息');
        return;
      }
      const bodyDigest = reactionBodyDigest(message);
      const dedupeKey = jsonSha256([messageId, actor, bodyDigest]);
      const claimKey = `lark.reaction-trigger.${config.appId}.${dedupeKey}`;
      if (await store.get(claimKey)) return;
      const chatType = await this.state.chatModeResolver?.(config.appId, chatId) === 'p2p' ? 'p2p' : 'group';
      const current = await readLarkConfig(store, config.appId);
      if (this.state.stopped || !current?.listening || current.reactionTriggerEmoji !== emoji) return;
      if (!await this.reactionTaskAllowed(current, chatId, chatType, actor)) {
        this.state.log.info({ appId: config.appId, chatId, messageId, actor }, '表情操作者没有任务创建权限');
        return;
      }
      const { prompt } = await parsePrompt({
        messageId, chatId, chatType, messageType, content: messageType === 'text' ? unwrapEditedTextContent(message.rawContent) : message.rawContent,
        mentions: message.mentions.map(mention => ({ key: mention.key ?? '', name: mention.name ?? '' }))
      });
      const excerpt = escapeLarkPromptEcho(clipCodePoints(prompt.replace(/\s+/g, ' '), 199)) || '（原消息没有文字。）';
      const requester = (chatType === 'group' ? renderGroupMention(actor) : undefined) ?? escapeLarkPromptEcho(actor);
      const topicRoot = threadId ? rootId ?? messageId : undefined;
      // 协作历史会清掉旧确认卡。只保留无正文的幂等键，避免清理后又为同一个人、同一版正文发卡。
      if (this.state.stopped || !await store.compareAndSet(claimKey, undefined, '1')) return;
      await confirmations.request({
        kind: reactionTaskConfirmKind(config.appId), scope: { appId: config.appId, chatId }, requesterId: actor,
        replyTo: { messageId, threadId }, dedupeKey, title: '确认处理原消息', confirmLabel: '开始处理',
        summary: `${requester} 想让机器人处理这条消息。\n\n> ${excerpt}`,
        payload: { chatType, bodyDigest, ...(topicRoot ? { rootId: topicRoot } : {}) }
      });
    } catch (error) {
      this.state.log.warn({ error, appId: config.appId, messageId, actor }, '处理飞书表情触发失败');
    }
  }

  private async reactionTaskAllowed(config: StoredLarkConfig, chatId: string, chatType: string, actor: string) {
    const decision = chatType === 'group' ? await this.state.groupManager?.authorize(config.appId, chatId, actor, 'task.create', undefined, { memberObserved: true }) : undefined;
    if (decision) {
      if (!decision.allowed) return false;
    } else {
      const emails = !config.allowedUsers.length && config.allowedEmails.length ? await this.state.service.getUserEmails(actor) : [];
      if (!larkHumanTaskAllowed(config, actor, emails)) return false;
    }
    await this.parts.core.requireExecution('listener', 'task.create');
    return true;
  }

  private registerReactionTaskConfirm(appId: string) {
    this.state.workflowOptions.participation?.confirmations?.register(reactionTaskConfirmKind(appId), {
      requesterOnly: true, successLabel: '已开始',
      authorize: async (record, actor) => {
        const config = await readLarkConfig(this.state.workflowOptions.store, appId);
        return config?.listening && await this.reactionTaskAllowed(config, record.scope.chatId, String(record.payload.chatType), actor)
          ? true : '当前账号没有任务创建权限。';
      },
      apply: async (record, actor) => {
        const config = await readLarkConfig(this.state.workflowOptions.store, appId);
        if (this.state.stopped || !record.cardMessageId || !config?.listening) throw new LarkServiceError('LARK_REACTION_TASK_UNAVAILABLE', '确认暂不可用，请稍后重试。', 409);
        const originalId = record.replyTo.messageId;
        const original = await withLarkContextReadTimeout(signal => this.state.service.getMessage(originalId, signal), '核对表情来源消息')
          .catch((error: unknown) => {
            if (error instanceof LarkServiceError
              && (error.code === 'LARK_MESSAGE_NOT_FOUND' || error.statusCode === 404 || error.upstreamCode === 230001)) return undefined;
            throw error;
          });
        if (!original || original.deleted || original.messageId !== originalId || reactionBodyDigest(original) !== record.payload.bodyDigest) {
          throw new LarkServiceError('LARK_REACTION_SOURCE_CHANGED', '原消息在发卡后被修改或撤回，没有开始处理。需要的话请取消表情后重新点一次。', 409);
        }
        const event: LarkMessageEvent = {
          messageId: `reaction_${record.id}`, chatId: record.scope.chatId, chatType: String(record.payload.chatType),
          ...(record.payload.rootId ? { rootId: String(record.payload.rootId) } : {}), threadId: record.replyTo.threadId, parentId: originalId,
          createTime: String(Date.now()), messageType: 'text', senderOpenId: actor, senderType: 'user',
          content: JSON.stringify({ text: '@_user_1 请处理我引用的这条消息。' }),
          mentions: [{ key: '@_user_1', name: config.name || 'Dutydeck', openId: this.state.botOpenId, mentionedType: 'bot' }]
        };
        // 原消息是引用来源，确认卡是本次入站的可见锚点。不同操作者不会共用回执或覆盖原作者的群观察。
        await this.receive(event, config, record.cardMessageId);
        return '已开始处理，进度会发在此会话。';
      }
    });
  }

  private async routeCaptured(record: LarkInboxRecord, config: StoredLarkConfig) {
    if (this.state.stopped) return;
    const owned = await this.parts.core.inbox.ownUnrouted(record);
    if (!owned) return;
    // 尚未路由的记录重新走正常唤醒和当前权限；既不 adopt，也不跳过 live ask/request continuation。
    await this.handle(owned.event, config, false, false, undefined, owned);
    if (this.state.stopped) return;
    const current = await this.parts.core.inbox.reload(record);
    if (current?.state !== 'unrouted') return;
    await this.parts.core.inbox.update(current, { state: 'ignored', ...(!current.reason ? { reason: 'not_addressed' as const } : {}) });
    this.scheduleIgnoredPrune(config.appId);
  }

  private ignoredPruneState(appId: string) {
    let state = this.ignoredPrunes.get(appId);
    if (!state) this.ignoredPrunes.set(appId, state = { lastRunAt: 0, pending: false });
    return state;
  }

  private pruneIgnoredInbox(appId: string) {
    this.ignoredPruneState(appId).lastRunAt = Date.now();
    return timeLoop('lark.inbox.prune', this.state.log, () => this.parts.core.inbox.pruneIgnored(appId), undefined, appId);
  }

  /** 保留期按天计，不必每条忽略消息都清：实时路径上每个机器人每小时至多清理一次（启动时已清过一轮）。 */
  private scheduleIgnoredPrune(appId: string) {
    const state = this.ignoredPruneState(appId);
    if (state.pending) return;
    state.pending = true;
    const cancel = () => { clearTimeout(timer); state.pending = false; this.state.turnCleanups.delete(cancel); };
    const timer = setTimeout(() => {
      this.state.turnCleanups.delete(cancel);
      void this.pruneIgnoredInbox(appId)
        .catch(error => this.state.log.warn({ error, appId }, '清理已忽略的飞书入站记录失败'))
        .finally(() => { state.pending = false; });
    }, Math.max(30_000, state.lastRunAt + LARK_IGNORED_PRUNE_INTERVAL_MS - Date.now()));
    timer.unref?.();
    this.state.turnCleanups.add(cancel);
  }

  /** retrying：首卡重试重新走入站处理时传入原任务，按它触发时的 epoch 判断 /new。 */
  async handle(event: LarkMessageEvent, config: StoredLarkConfig, recovering = false, adopted = false, retrying?: LarkTask, captured?: LarkInboxRecord, adoption?: LarkInboxAdoption) {
    const note = async (reason: Disposition['reason'], detail?: string) => { await annotateDisposition(this.state.workflowOptions.store, config.appId, event.messageId, { schemaVersion: 1, reason, ...(detail ? { detail: detail.slice(0, 500) } : {}) }, this.state.log); };
    const persisted = captured ?? await this.parts.core.inbox.lookup(config.appId, event.messageId);
    if (adoption?.confirmedInputDigest && (!persisted || larkConfirmationInputDigest(persisted.event) !== adoption.confirmedInputDigest)) {
      throw new RuntimeError('LARK_CONFIRMATION_INPUT_CHANGED', '原消息已修改，请重新确认', 409);
    }
    if (persisted && !await this.parts.core.confirmationInputAllowed(persisted)) { await note('input_rejected'); return; }
    if (persisted) {
      if (persisted.state !== 'received' && !((captured || adopted) && persisted.state === 'unrouted') && !(adopted && persisted.state === 'ignored')) return;
      event = persisted.event;
    }
    if (adoption) {
      const { confirmedInputDigest: _expected, ...fields } = adoption;
      event = { ...event, ...fields };
    }
    // direct 场景请求的消息已由群参与看过，这里不再观察、不过机器人回合门禁（包自带去重和每小时上限）；
    // 发起人不是这条消息的发送者，要按群成员重新确认。重启恢复时同样按受理处理。
    // model 场景的 act 和普通 act 一样以发消息的人的身份执行，收养字段只影响执行 prompt（见 coordinator-dispatch.ts）。
    const adoptedScenario = adoption || persisted?.state === 'received' ? larkScenarioAdoptionOf(event) : undefined;
    const scenario = adoptedScenario?.mode === 'direct' ? adoptedScenario : undefined;
    if (scenario) adopted = true;
    const current = await readLarkConfig(this.state.workflowOptions.store, config.appId);
    if (!current?.listening) { await note('listening_disabled'); return; }
    // 任务通道的认领可能早于名单被清空：按这份配置快照再判一次，不落进普通私聊「空名单对所有人开放」。
    // 不建入站记录直接返回，认领由轮询退回，通道重新开放后再派。
    if (larkTaskAgentGuid(event.messageId) && !larkTaskAgentAllowlistConfigured(current)) return;
    config = current;
    const quotedWorkflow = await this.parts.core.workflows.quoted(config.appId, event);
    const mentionsBot = this.state.botOpenId ? event.mentions.some(mention => mention.openId === this.state.botOpenId) : event.mentions.some(mention => mention.mentionedType === 'bot');
    if (this.state.stopped) return;
    const botSender = isBotSenderType(event.senderType);
    let helpOnly = false;
    let recognizedCommand = false;
    try {
      const parsed = parseSlashCommand((await parsePrompt(event, this.state.botOpenId)).prompt);
      helpOnly = parsed?.name === 'help';
      recognizedCommand = Boolean(parsed && resolveLarkCommand(parsed));
    } catch { /* normal parser reports malformed content below */ }
    const entryAction: PolicyAction = helpOnly ? 'task.view_result' : 'task.create';
    try {
      if (event.chatType === 'group' && this.state.groupManager) config = await this.state.groupManager.resolved(config, event.chatId);
    } catch (error) {
      if (captured && !isLarkDeterministicFailure(error) && (error as { code?: string })?.code !== 'LARK_GROUP_NOT_APPLIED') throw error;
      await note('group_unbound');
      await this.rejectIncoming(event, config, error instanceof Error ? error.message : '群配置尚未生效。', isExplicitWake({ chatType: event.chatType, botSender, trustedBot: false, mentionsBot, quotedWorkflow: Boolean(quotedWorkflow), adopted }));
      return;
    }
    // 受信机器人没 @ 的消息和真人一样交给群参与判定。核对同伴要读群成员，只在结论有用时查：
    // 被群参与受理的消息，或按需、积极档里没 @ 的消息。@ 本机器人的命令在命令路由里另行核对。
    const ambientBotMode = botSender && event.chatType === 'group' && !adopted && !mentionsBot
      ? await this.state.workflowOptions.participation?.mode({ appId: config.appId, chatId: event.chatId }) : undefined;
    const trustedBot = botSender && event.chatType === 'group' && (adopted || ambientBotMode === 'selective' || ambientBotMode === 'eager')
      && await this.parts.core.isTrustedBot(config, event);
    const explicit = isExplicitWake({ chatType: event.chatType, botSender, trustedBot, mentionsBot, quotedWorkflow: Boolean(quotedWorkflow), adopted });
    const mentionPolicy = resolveParticipation({ mentionPolicy: config.mentionPolicy }).mentionPolicy;
    const participationMode = mentionPolicy !== 'topic' && event.chatType === 'group' && (!botSender || trustedBot) && this.state.groupManager
      ? await this.state.workflowOptions.participation?.mode({ appId: config.appId, chatId: event.chatId }) : undefined;
    const topicScope = (mentionPolicy === 'topic' || participationMode === 'selective' || participationMode === 'eager') && this.state.groupManager
      ? await resolveLarkScopeId(event, config, this.state.chatModeResolver) : undefined;
    // 续接了发起人顶层会话的话题没有自己的会话，续接的会话还在就同样算机器人接过的话题。
    // 只 @ 了别人（另一个 Bot 或同事）的消息是在叫别人，即使在自己接过的话题里也让路，同 ambient；
    // 已识别命令里的 @ 是参数（/grant @成员），不算。
    const ownedTopic = topicScope && this.state.groupManager && (mentionsBot || !event.mentions.length || recognizedCommand)
      ? await this.state.groupManager.ownsTopic(config, event, topicScope) || Boolean(await this.threadContinuation(event, config, topicScope)) : false;
    // Observation precedes wake filtering and every visible acknowledgement.
    // 发起人在同一话题里直接回复仍在等待的提问就是在作答，不依赖群参与开关。
    const pendingAskContinuation = Boolean(!recovering && !explicit && await this.continuesPendingAsk(event, config, Boolean(captured)));
    const requestContinuation = Boolean(this.state.workflowOptions.participation && !recovering && !explicit && !pendingAskContinuation && await this.continuesOwnRequest(event, config, Boolean(captured)));
    const wakeFacts: WakeFacts = { chatType: event.chatType, botSender, trustedBot, mentionsBot, hasMentions: event.mentions.length > 0, quotedWorkflow: Boolean(quotedWorkflow), adopted, recovering,
      recognizedCommand, mentionPolicy, ownedTopic: Boolean(ownedTopic), directScenario: Boolean(scenario), pendingAskContinuation, requestContinuation };
    const { addressed, participation: participationInput } = wakeSignals(wakeFacts);
    // 真人发言让同话题的机器人连续回合清零：判为不接的消息也算，所以在唤醒过滤之前做。
    if (event.chatType === 'group' && !botSender && event.senderOpenId && !scenario) this.state.workflowOptions.participation?.noteHumanMessage(config.appId, event);
    const participation = scenario ? undefined : await this.state.workflowOptions.participation?.handle(event, config, { ...participationInput, botOpenId: this.state.botOpenId, trustedBot });
    if (this.state.handledMessages.has(event.messageId)) return;
    const wake = decideWake(wakeFacts, participation);
    if (!wake.wake) { await note(wake.reason === 'not_addressed' && botSender ? 'bot_message' : wake.reason); return; }
    // 可选的机器人互相 @ 门禁。legacyWake 的 mentionsBot / quotedWorkflow 两支都不受 !botSender
    // 约束，访问控制在没配成员名单时又对机器人一律放行，所以开启 botLoopGuard 时由这里封口。
    // 判定失败按挡下处理：门禁读不到状态时放行等于把回路重新打开。
    // 被挡下的回合只留门禁记录，绝不向群里发消息——那本身就是噪音。
    if (wake.guardBotTurn && this.state.workflowOptions.participation) {
      let botTurnGate: string | undefined;
      try {
        // 群参与判定唤醒的机器人回合不论开关都计入连续上限；@ 唤醒的由 botLoopGuard 决定。
        const participationWake = botSender && (event.authorization?.via === 'addressed' || event.authorization?.via === 'participation_act');
        botTurnGate = await this.state.workflowOptions.participation.guardBotTurn(event, config, { botOpenId: this.state.botOpenId, participationWake });
      } catch (error) {
        if (captured) throw error;
        botTurnGate = '机器人回合门禁判定失败';
        this.state.log.warn({ error, chatId: event.chatId, messageId: event.messageId }, '机器人回合门禁判定失败，本轮不响应');
      }
      if (botTurnGate) {
        await note('bot_loop_guard', botTurnGate);
        this.state.log.info({ chatId: event.chatId, messageId: event.messageId, reason: botTurnGate }, '机器人触发的回合已被门禁挡下');
        return;
      }
    }
    if (event.chatType === 'group' && this.state.groupManager) {
      const decision = await this.state.groupManager.authorize(config.appId, event.chatId, event.senderOpenId, entryAction, undefined, { memberObserved: !recovering && !scenario });
      if (decision && !decision.allowed) {
        await note('access_denied', decision.reason);
        await this.rejectIncoming(event, config, decision.code === 'talk_required' ? '当前账号没有此群的任务访问权限。' : decision.reason, addressed);
        return;
      }
    }
    if (this.state.stopped || this.state.handledMessages.has(event.messageId)) return;
    if (recovering && (!event.senderOpenId || !await this.parts.core.currentAccess(config, event.chatId, event.chatType, event.senderOpenId, entryAction, undefined, event.senderOpenId))) { await note('access_denied'); return; }
    try { if (!helpOnly) await this.parts.core.requireExecution('listener', 'task.create'); }
    catch (error) {
      if (captured && !isLarkDeterministicFailure(error)) throw error;
      await note('execution_denied');
      await this.rejectIncoming(event, config, error instanceof Error ? error.message : '机器人尚未获得运行权限。', addressed);
      return;
    }
    const inbox = await this.parts.core.inbox.claim(config.appId, event, adopted, adoption);
    if (!inbox) return;
    if (inbox) event = inbox.event;
    const explicitVia = larkTaskAgentGuid(event.messageId) ? 'task_channel' as const
      : recognizedCommand ? 'command' as const : event.chatType !== 'group' ? 'direct' as const
      : mentionsBot ? 'mention' as const : quotedWorkflow || pendingAskContinuation ? 'answer_reply' as const
      : ownedTopic || requestContinuation ? 'topic_followup' as const : undefined;
    const source = (adoption || persisted?.state === 'received') && event.authorization ? event.authorization
      : scenario ? { strength: 'inferred' as const, via: 'scenario_direct' as const,
        ...('recordId' in scenario ? { decisionId: scenario.recordId, policyVersion: scenarioPolicyVersion(scenario.packId, scenario.version) } : {}) }
      : explicitVia ? { strength: 'explicit' as const, via: explicitVia }
      : { strength: 'inferred' as const, via: 'group_rule' as const };
    event = { ...event, authorization: source };
    if (inbox) await this.parts.core.inbox.update(inbox, { event });
    // 原任务还留在 tasks 里，/new 按它作废入站记录：新认领要立刻交给它，否则 CAS 对不上。
    if (retrying && inbox) retrying.inbox = inbox;
    // 先标记已处理，避免异步解析期间同一条消息被重复入队。
    this.state.handledMessages.add(event.messageId);
    if (this.state.handledMessages.size > 5_000) this.state.handledMessages.delete(this.state.handledMessages.values().next().value!);
    // 事件接入后立即给出稳定、单义的接收确认。解析、附件下载和会话路由均可能较慢，
    // 不应让用户在这些步骤中面对无反馈的聊天界面。
    // 任务通道派来的是合成事件，背后没有真实消息：给它贴表情必然失败，
    // 每条任务留一条 warn 就是纯噪声，因此在调用前跳过。
    const acknowledgement = larkTaskAgentGuid(event.messageId) ? undefined : this.parts.core.beginAcknowledgementReaction(event);
    const clearAcknowledgement = () => this.parts.core.clearAcknowledgementReaction({ event, acknowledgement });
    let handedOff = false;
    try {
      let prompt: string;
      let resources: LarkMessageResource[];
      let scopeId: string;
      try {
        ({ prompt, resources } = await parsePrompt(event, this.state.botOpenId));
        // 路由解析（话题群种子 / 普通群回复模式 / legacy）与 group key 共用同一 scopeId，
        // 保证同一会话的消息串行化到同一个 group。
        scopeId = await resolveLarkScopeId(event, config, this.state.chatModeResolver);
      } catch (error) {
        this.state.log.warn({ error, chatId: event.chatId, messageId: event.messageId }, '解析飞书消息失败，已向用户回执');
        // P0-4：解析失败回执是独立新消息，群聊开启时与其他失败回执同口径 @ 发起人；私聊不 @。
        const parseFailMention = larkNotice('failure_receipt', config, event).mention;
        await sendTaskCard(this.state.service, event, {
          state: 'failed', retryable: false, readOnly: true,
          taskId: event.messageId, taskName: '消息接收失败',
          markdown: `${parseFailMention ? `${parseFailMention}\n\n` : ''}**消息未能解析，Agent 尚未执行。**\n\n${error instanceof Error ? error.message : String(error)}\n\n请检查消息内容或附件后重新发送。`,
          idempotencyKey: `parse_failed_${event.messageId}`.slice(0, 50),
          ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {})
        }, this.state.log).catch(cardError => this.state.log.error({ error: cardError, messageId: event.messageId }, '发送飞书解析失败回执失败'));
        await clearAcknowledgement();
        if (inbox) await this.parts.core.inbox.update(inbox, { state: 'failed', error: '消息解析失败' });
        return;
      }
      if (scenario) prompt = directScenarioPrompt(scenario, prompt);
      if (inbox?.request) { prompt = inbox.request.prompt; resources = inbox.request.resources; scopeId = inbox.request.scopeId; }
      // 这条曾并入前一条排队消息：先按合并意图收口，决定执行合并后的原文还是自己的原文（见 resumeMergedInbox）。
      // 状态暂时读不到时不创建任务；交还认领，让后续对账从同一持久合并意图重试。
      if (inbox?.request && inbox.mergeFrom) {
        const resumed = await this.resumeMergedInbox(inbox);
        if (resumed === undefined) {
          this.state.handledMessages.delete(event.messageId);
          throw new Error('合并前一条的状态暂未读清，保留合并意图等待重试');
        }
        prompt = resumed;
      }
      const workflowScope: { id: string; prompt?: string } = { id: scopeId };
      if (!inbox?.request && (await this.routeWorkflow(event, config, prompt, workflowScope)
        || await this.routePendingAsk(event, config, prompt, resources, workflowScope, inbox, recovering))) {
        if (inbox) await this.parts.core.inbox.update(inbox, { state: 'accepted', reason: 'workflow_handled' });
        await clearAcknowledgement();
        return;
      }
      scopeId = workflowScope.id;
      if (workflowScope.prompt) prompt = workflowScope.prompt;
      // 聊天内斜杠命令：必须在解析之后（拿到剥离 @机器人 的纯文本）、建任务之前。
      // 命令不是 Agent 任务，不应占用一次 Agent 轮次，也不应留下进度卡。
      // 未识别的 /xxx 会被归一化成普通文字继续走建任务流程（用户发路径不该收到失败回执）。
      // group 必须先于命令路由取出：/new 要在这个 group 上登记「已结束的会话」，
      // 之后同一 group 的消息（包括本条 /new 自带的任务内容）才不会把旧上下文绑回来。
      const groupKey = larkGroupKey(event, scopeId, config.appId);
      const group = this.state.groups.get(groupKey) ?? { tail: Promise.resolve() };
      this.state.groups.set(groupKey, group);
      // 话题续接发起人的顶层任务时，先把内存绑定指向那个会话：命令和后续消息都按它处理。
      if (!group.sessionId) {
        const continued = await this.threadContinuation(event, config, scopeId);
        if (continued && !group.retiredSessionIds?.has(continued.id)) { group.sessionId = continued.id; group.sessionConfigKey = larkSessionConfigKey(config); }
      }
      if (inbox && !inbox.request && (parseSlashCommand(prompt) || resolveLarkPluginQuery(prompt, { botAppId: config.appId, cwd: config.workspace }))) await this.parts.core.inbox.update(inbox, { state: 'command' });
      let commandRoute = inbox?.request ? undefined : await this.routeChatCommand(event, config, prompt, group, scopeId, acknowledgement);
      // C2：机器人话题里的「继续」「停」「重来」先按控制处理，不适用时照常当普通消息。
      const control = !inbox?.request && commandRoute === undefined ? larkControlPhrase(prompt) : undefined;
      if (control) {
        // 与斜杠命令同规则：执行期间重启，入站记录不能被当成普通消息重放（重放会再停一次或再执行一次）。
        if (inbox) await this.parts.core.inbox.update(inbox, { state: 'command' });
        commandRoute = await this.routeControlPhrase(control, event, config, prompt, group, scopeId, acknowledgement);
        // 不按控制处理时就是普通消息，改回 received，重启后照常恢复。
        if (inbox && commandRoute === undefined) await this.parts.core.inbox.update(inbox, { state: 'received' });
      }
      if (commandRoute === 'handled') {
        await clearAcknowledgement();
        if (inbox) await this.parts.core.inbox.update(inbox, { state: 'accepted', ...((await this.parts.core.inbox.reload(inbox))?.reason !== 'command_rejected' ? { reason: 'command_handled' as const } : {}) });
        return;
      }
      const busy = config.busyTriage === true && !recovering && !inbox?.request && !commandRoute && !control
        && !prompt.trimStart().startsWith('/') && event.senderType === 'user' && event.senderOpenId
        && !quotedWorkflow && !scenario && !event.scenario && !larkTaskAgentGuid(event.messageId)
        ? await this.routeBusyMessage(event, config, prompt, group, scopeId).catch(error => {
          this.state.log.warn({ error, messageId: event.messageId }, '忙时判断失败，按普通消息排队');
          return undefined;
        }) : undefined;
      if (busy === 'handled') {
        if (inbox) await this.parts.core.inbox.update(inbox, { state: 'accepted', reason: 'busy_supplement' });
        await clearAcknowledgement();
        return;
      }
      let retryMaterialPrompt = inbox?.request?.materialPrompt;
      let launchOptions = inbox?.request?.launchOptions;
      let commandEpoch: number | undefined;
      if (typeof commandRoute === 'string') prompt = commandRoute;
      else if (commandRoute) { prompt = commandRoute.prompt; retryMaterialPrompt = commandRoute.materialPrompt; launchOptions = commandRoute.launchOptions; commandEpoch = commandRoute.epoch; }
      if (inbox && commandRoute && typeof commandRoute !== 'string' && commandRoute.lineage) await this.parts.core.inbox.update(inbox, { lineage: commandRoute.lineage });
      if (inbox && !inbox.request) await this.parts.core.inbox.update(inbox, { state: 'received', request: { prompt, scopeId, resources, ...(retryMaterialPrompt ? { materialPrompt: retryMaterialPrompt } : {}), ...(launchOptions ? { launchOptions } : {}) } });
      // 首卡重试从触发到这里有多步异步操作，期间用户可能发了 /new 或 /cancel。
      if (retrying && (retrying.cancelRequested || retrying.epoch !== (group.epoch ?? 0) || (inbox?.sessionId && group.retiredSessionIds?.has(inbox.sessionId)))) {
        if (inbox?.state === 'received') await this.parts.core.inbox.update(inbox, { state: 'failed', error: retrying.cancelRequested ? larkCancelledBeforeSubmit : '请求在执行前被 /new 作废' });
        await clearAcknowledgement();
        return;
      }
      // 空 @ 消息（仅 @ 机器人无文字）仍需创建任务，由 runTurn 拉取聊天记录做兜底意图判断。
      const task: LarkTask = { ...(commandRoute && typeof commandRoute !== 'string' && commandRoute.lineage ? { matterLineage: commandRoute.lineage } : {}), id: event.messageId, group, event, prompt, resources, inbox, retryMaterialPrompt, launchOptions, ...(inbox?.cardId ? { cardMessageId: inbox.cardId } : {}), ...(inbox?.redispatch ? { redispatch: inbox.redispatch } : {}), ...(commandRoute && typeof commandRoute !== 'string' && commandRoute.suggestion ? { commandSuggestion: commandRoute.suggestion } : {}), ...(commandRoute && typeof commandRoute !== 'string' && commandRoute.steer ? { steer: true } : {}), config, ...(busy ? { busySupplement: busy } : {}), state: 'queued', events: [], restoring: recovering, ...(recovering ? { recovered: true } : {}), turn: (inbox?.turn ?? 1) - 1, scopeId, epoch: commandEpoch ?? retrying?.epoch ?? group.epoch ?? 0, acknowledgement };
      this.state.tasks.set(task.id, task);
      handedOff = true;
      if (this.state.tasks.size > 5_000) this.state.tasks.delete(this.state.tasks.keys().next().value!);
      group.tail = group.tail.then(() => this.runTurn(task)).catch(async error => {
        this.state.log.error({ error, chatId: event.chatId, messageId: event.messageId }, '处理飞书唤醒消息失败');
        // runTurn 在首张卡片送达前抛出（附件下载、空 @ 兜底、卡片发送本身失败）时，
        // OK reaction 会永远留在原消息上：用户看到「已接收」却永远等不到进度卡，
        // 正是设计契约禁止的两个竞争状态并存。此处兜底撤销，保证回执不会悬挂。
        await this.parts.core.clearAcknowledgementReaction(task);
        if (inbox?.state === 'received' && !task.runtimeTaskId && isLarkFirstCardUndelivered(error)) {
          await this.retryUndeliveredInbound(task, inbox, config, recovering, adopted, error);
          return;
        }
        if (inbox?.state === 'received') await this.parts.core.inbox.update(inbox, { state: 'failed', error: error instanceof Error ? error.message : String(error) });
        // group.tail 是同一会话的排队链，收尾再抛出会让下一条消息跳过 runTurn。
      }).catch(error => this.state.log.error({ error, messageId: event.messageId }, '收尾失败的飞书请求出错'));
    } finally {
      if (!handedOff) await clearAcknowledgement();
    }
  }

  /** 只接已授权的真人普通消息；任何判定或校验失败都保留原来的排队路径。 */
  private async routeBusyMessage(event: LarkMessageEvent, config: StoredLarkConfig, prompt: string, group: LarkGroup, scopeId: string): Promise<'handled' | { taskId: string; attemptId?: string } | undefined> {
    const sessionId = group.sessionId;
    const participation = this.state.workflowOptions.participation;
    if (!sessionId || !participation || !event.senderOpenId || !this.state.runtime.getTasks) return;
    if (!config.managedGroup && !await this.parts.core.isStaticOperatorAllowed(config, event.senderOpenId, event.chatId)) return;
    if (event.parentId && await participation.confirmations?.isPendingReply(config.appId, event.chatId, event.parentId)) return;
    const running = (await this.state.runtime.getTasks(sessionId)).find(task => task.status === 'running');
    if (!running) return;
    const epoch = group.epoch;
    const decision = await participation.triageBusy(config, event, prompt, running.prompt);
    const current = await readLarkConfig(this.state.workflowOptions.store, config.appId);
    if (!current?.listening || current.busyTriage !== true) return;
    config = event.chatType === 'group' && this.state.groupManager ? await this.state.groupManager.resolved(current, event.chatId) : current;
    const access = event.chatType === 'group' ? await this.state.groupManager?.authorize(config.appId, event.chatId, event.senderOpenId, 'task.create') : undefined;
    if (access ? !access.allowed : !await this.parts.core.isStaticOperatorAllowed(config, event.senderOpenId, event.chatId)) return;
    // 判定期间上一轮可能完成、被中断或换会话；不能把补充交给另一轮。
    const tasks = await this.state.runtime.getTasks(sessionId);
    if (this.state.stopped || group.sessionId !== sessionId || group.epoch !== epoch || !tasks.some(task => task.id === running.id && task.currentAttemptId === running.currentAttemptId && task.status === 'running')) return;
    if (decision.kind === 'queue') return;
    if (decision.kind === 'supplement') return { taskId: running.id, ...(running.currentAttemptId ? { attemptId: running.currentAttemptId } : {}) };
    const reply = async (markdown: string, elements?: LarkCardElement[]) => sendTaskCard(this.state.service, event, {
      taskId: event.messageId, taskName: '忙时消息', state: 'completed', readOnly: true, retryable: false,
      markdown, ...(elements?.length ? { elements: [{ tag: 'markdown', content: '按控制操作处理。' }, ...elements] } : {}), idempotencyKey: `busy_${event.messageId}`.slice(0, 50)
    }, this.state.log);
    if (decision.kind === 'progress') {
      const live = [...this.state.tasks.values()].find(task => task.sessionId === sessionId && task.runtimeTaskId === running.id);
      const events = live?.events ?? eventsForRuntimeTask(await loadLarkTaskWindow(this.state.runtime, sessionId, running.id, 500), running.id);
      const summary = busyProgressSummary(events);
      const origin = await this.parts.core.larkTaskOrigin(config, event.chatId, { id: running.id, sessionId });
      const startedAt = live?.startedAt ?? origin?.startedAt;
      const approval = (await this.state.runtime.getPendingPermissions?.(sessionId) ?? []).length > 0 || Boolean(await this.approvalBlock(config.appId, sessionId));
      await reply(`按问进度回复。\n\n阶段：${summary.phase}\n\n最近一步：${summary.latest}\n\n已用时间：${startedAt ? larkElapsedLabel((Date.now() - startedAt) / 1000) : '暂无记录'}\n\n排队数：${tasks.filter(task => task.status === 'queued').length}\n\n待审批：${approval ? '有' : '无'}`);
      return 'handled';
    }
    const origin = { config, requested: event, place: event, scopeId };
    if (decision.kind === 'settings') {
      await this.agentSettingsAt({ sessionId, taskId: running.id, actorId: event.senderOpenId, action: 'set', pairs: decision.pairs }, origin, '按控制操作处理。');
      return 'handled';
    }
    if (decision.kind === 'schedule') {
      const automation = this.state.workflowOptions.automation;
      const requests = this.state.workflowOptions.scheduleRequests;
      if (!automation || !requests) return;
      const messageOrigin = { appId: config.appId, chatId: event.chatId, messageId: larkMessageAnchor(event), replyInThread: Boolean(event.threadId?.trim()) };
      const result = await runAgentScheduleRequest({ automation, prepareDelivery: id => requests.prepareDelivery(sessionId, messageOrigin, id),
        sendConfirmation: (schedule, notice, requestId) => requests.sendConfirmation(schedule, notice ? `按控制操作处理。\n\n${notice}` : '按控制操作处理。', requestId)
      }, { sessionId, requestId: event.messageId, actorId: event.senderOpenId }, decision.params);
      if (result.confirmationDelivery === 'failed') return;
      return 'handled';
    }
    // 再用 agent 的参数与命令校验器核对，绝不接受模型给的原始斜杠命令。
    if (decision.kind !== 'command') return;
    agentCommandPlan(decision.command);
    const request = { sessionId, taskId: running.id, actorId: event.senderOpenId, command: decision.command, action: decision.action, ...(decision.members ? { members: decision.members } : {}) };
    if (decision.view) {
      const receipts: LarkCommandReceipts = { capture: true, cards: [] };
      await this.runAgentCommand(this.agentCommandEvent(config, event, event.senderOpenId, decision.command, []), config, decision.command, scopeId, undefined, receipts);
      const card = receipts.cards.at(-1);
      if (!card || card.failed) return;
      const sent = await reply(`按控制操作处理。\n\n${card.markdown}`, card.elements);
      if (decision.view === 'tasks' || decision.view === 'status' && card.elements?.length) await this.saveTaskDashboardOrigin(config, sent, event);
    } else {
      await this.agentCommandAt(request, { config, requested: event, place: event, scopeId }, '按控制操作处理。', true);
    }
    return 'handled';
  }

  /** 首卡没送达的请求已经重试了几次，按「消息:轮次」记。 */
  private readonly undeliveredRetries = new Map<string, number>();
  /** 排定了重试、正在等待的请求，按消息记；/new 用它撤销同一会话里的重试。 */
  private readonly undeliveredPending = new Map<string, { task: LarkTask; cancel: () => void }>();

  /**
   * 首张进度卡没送达、runtime 还没接到任务：飞书抖动或限流时这条请求会悄悄丢掉。
   * 进程内 30 秒、2 分钟后各重试一次整条入站处理，首卡幂等键不变，不会重复发卡。
   * 等待期间入站记录保持 received 并交还认领，进程先退出的话重启恢复照常接手。
   * 两次都没送达时尽量回一条纯文本，再标 failed。
   */
  private async retryUndeliveredInbound(task: LarkTask, inbox: LarkInboxRecord, config: StoredLarkConfig, recovering: boolean, adopted: boolean, error: unknown) {
    if (this.state.stopped) return;
    const key = `${task.id}:${task.turn}`;
    const attempt = this.undeliveredRetries.get(key) ?? 0;
    const delayMs = larkUndeliveredRetryDelaysMs[attempt];
    if (delayMs === undefined) {
      this.undeliveredRetries.delete(key);
      if (typeof this.state.service.replyText === 'function') {
        await this.state.service.replyText({ messageId: larkMessageAnchor(task.event), ...(task.event.threadId ? { replyInThread: true } : {}), text: '这条请求没有执行，请重发。', idempotencyKey: `request_not_run_${task.id}`.slice(0, 50) })
          .catch(replyError => this.state.log.warn({ error: replyError, messageId: task.id }, '发送「请求没有执行」提示失败'));
      }
      await this.parts.core.inbox.update(inbox, { state: 'failed', error: error instanceof Error ? error.message : String(error) })
        .catch(updateError => this.state.log.error({ error: updateError, messageId: task.id }, '标记入站请求失败出错'));
      return;
    }
    const released = await this.parts.core.inbox.release(inbox).catch(() => undefined);
    // 记录已被改动，说明别的路径接手了这条消息。
    if (!released) return;
    // 任务上持有的认领要换成交还后的这份：等待期间 /new 按它把记录标成不再执行，旧对象的 CAS 会失败。
    task.inbox = released;
    this.undeliveredRetries.set(key, attempt + 1);
    const failedAt = Date.now();
    const cancel = () => {
      clearTimeout(timer);
      this.state.turnCleanups.delete(cancel);
      this.undeliveredPending.delete(task.id);
    };
    const timer = setTimeout(() => {
      cancel();
      void this.runUndeliveredRetry(task, released, config, recovering, adopted, failedAt)
        .catch(retryError => this.state.log.error({ error: retryError, messageId: task.id }, '重试飞书入站请求失败'));
    }, delayMs);
    timer.unref?.();
    this.state.turnCleanups.add(cancel);
    this.undeliveredPending.set(task.id, { task, cancel });
    this.state.log.warn({ error, messageId: task.id, attempt: attempt + 1, retryInMs: delayMs }, '首张进度卡没送达，稍后重试这条请求');
  }

  /** /new 结束了这个会话：撤销其中等待重试的请求。入站记录由 /new 作废待执行请求时一并标成不再执行。 */
  cancelUndeliveredRetries(group: LarkGroup) {
    for (const { task, cancel } of [...this.undeliveredPending.values()]) {
      if (task.group !== group) continue;
      cancel();
      this.undeliveredRetries.delete(`${task.id}:${task.turn}`);
    }
  }

  private async runUndeliveredRetry(task: LarkTask, released: LarkInboxRecord, config: StoredLarkConfig, recovering: boolean, adopted: boolean, failedAt: number) {
    if (this.state.stopped) return;
    const key = `${task.id}:${task.turn}`;
    // 等待期间会话被 /new 作废，或请求被 /cancel 取消：旧请求不再执行。
    const sessionId = released.sessionId;
    const superseded = task.epoch !== (task.group.epoch ?? 0) || Boolean(sessionId && task.group.retiredSessionIds?.has(sessionId));
    if (superseded || task.cancelRequested) {
      this.undeliveredRetries.delete(key);
      if (await this.parts.core.inbox.unclaimed(released)) await this.parts.core.inbox.update(released, { state: 'failed', error: superseded ? '请求在执行前被 /new 作废' : larkCancelledBeforeSubmit });
      return;
    }
    // 等待期间已被别的路径接手（例如重启恢复，或同一条消息被再次推送），或已不是 received，不再重试。
    if (!await this.parts.core.inbox.unclaimed(released)) {
      this.undeliveredRetries.delete(key);
      return;
    }
    // 用户已经用新消息重发了同一条请求：旧的这条不再执行，免得同一件事做两遍。
    // 只认两条都是纯文本（没有图片、附件，也不是引用回复）、新的一条已被接收的情形；
    // 图片、文件的文字摘要都一样，看不出是不是同一个请求。
    const plainText = (item: LarkTask) => item.event.messageType === 'text' && !item.event.parentId && !item.inbox?.request?.resources.length;
    const resent = plainText(task) && [...this.state.tasks.values()].some(other => other.id !== task.id && other.group === task.group
      && other.event.senderOpenId === task.event.senderOpenId && other.prompt === task.prompt && (other.startedAt ?? 0) >= failedAt
      && plainText(other) && (other.inbox?.state === 'accepted' || Boolean(other.runtimeTaskId)));
    if (resent) {
      this.undeliveredRetries.delete(key);
      await this.parts.core.inbox.update(released, { state: 'failed', error: '用户已重新发送同一请求' });
      return;
    }
    this.state.handledMessages.delete(task.id);
    await this.handle(released.event, config, recovering, adopted, task);
  }

  /**
   * 聊天内斜杠命令路由。
   *
   * 返回值：
   * - `'handled'`  —— 命令已自行回执（/help、拒绝、不可用、已执行），调用方直接结束
   * - `string`     —— 未识别的 /xxx，已归一化为普通文字，调用方用它继续建任务
   * - `undefined`  —— 不是命令，调用方按原流程继续
   *
   * 权限沿用既有白名单机制（isOperatorAllowed），不新造权限系统；
   * 能力则从真实 runtime 探测，缺能力的命令只会收敛成 unavailable 回执，不会产生 intent。
   */
  /** /help 首屏与翻页回调重建同一能力屏，两处口径必须一致，集中在此。 */
  private larkRouteCapabilities() {
    return {
      ...larkCommandCapabilities(this.state.runtime),
      // 只有 automation 不算可用：至少装了一个 CI 插件，否则 /ci 回「未配置」。
      ci: Boolean(this.state.workflowOptions.automation?.ciConfigured),
      pr: Boolean(this.state.workflowOptions.automation?.pullRequests?.availability().available),
      schedule: Boolean(this.state.workflowOptions.automation),
      work: Boolean(this.state.workflowOptions.workbench),
      tasks: Boolean(this.state.runtime.getTasks),
      answer: Boolean(this.state.workflowOptions.broker),
      approval: true,
      memory: Boolean(this.state.workflowOptions.memory),
      groupPolicy: Boolean(this.state.groupManager),
      plan: true
    };
  }

  async routeChatCommand(
    event: LarkMessageEvent,
    config: StoredLarkConfig,
    prompt: string,
    group: LarkGroup,
    scopeId: string,
    acknowledgement?: LarkTask['acknowledgement'],
    receipts?: LarkCommandReceipts
  ): Promise<'handled' | string | LarkCommandPrompt | undefined> {
    // 插件命令展开成 prompt 模板后照普通请求处理（授权与建任务都不变）；内置命令名在安装时已拒绝。
    const pluginScope = { botAppId: config.appId, ...(config.workspace ? { cwd: config.workspace } : {}) };
    const query = resolveLarkPluginQuery(prompt, pluginScope);
    if (query) {
      // A durable command claim already exists before routing. Never fall through to an Agent on failure.
      try {
        if (event.senderType !== 'user' || !event.senderOpenId || event.scenario || larkTaskAgentGuid(event.messageId)) throw new Error('PLUGIN_COMMAND_IDENTITY_REQUIRED');
        const claim = await this.parts.core.inbox.lookup(config.appId, event.messageId);
        if (claim?.state !== 'command' || claim.event.chatId !== event.chatId || claim.event.senderOpenId !== event.senderOpenId) throw new Error('PLUGIN_COMMAND_CLAIM_REQUIRED');
        const revision = config.revision;
        const assertCurrent = async () => {
          const current = await readLarkConfig(this.state.workflowOptions.store, config.appId);
          if (this.state.stopped || !current?.listening || current.revision !== revision || !await this.parts.core.currentAccess(current, event.chatId, event.chatType, event.senderOpenId!, 'task.view_result')) throw new Error('PLUGIN_COMMAND_AUTHORITY_CHANGED');
        };
        await callLarkPluginQuery(query, { identity: {
          kind: 'command', eventId: event.messageId, channel: 'lark', botAppId: config.appId, chatId: event.chatId,
          actor: { kind: 'channel', appId: config.appId, id: event.senderOpenId }, cwd: config.workspace ?? '', workspaceRoot: config.workspace ?? ''
        }, assertCurrent }, async (output, beforeSend) => {
          // Render as literal text, never plugin-provided card elements or a redirectable delivery target.
          const rawText = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
          // Keep one bounded delivery (including JSON escaping), without partial-result replay.
          const text = pluginQueryReplyText(rawText);
          await this.state.service.sendText({ chatId: event.chatId, text, idempotencyKey: `plugin_query_${createHash('sha256').update(`${config.appId}:${event.messageId}`).digest('hex').slice(0, 32)}`, beforeSend });
        });
      } catch {
        this.state.log.warn({ messageId: event.messageId, code: 'PLUGIN_COMMAND_FAILED' }, '插件查询未返回结果');
        if (!this.state.stopped) await this.workflowReply(event, config, '插件查询未返回结果：请检查查询参数、插件绑定和读取授权。Agent 未启动；本条消息不会自动重试。', { failed: true });
      }
      return 'handled';
    }
    const pluginPrompt = expandLarkPluginCommand(prompt, pluginScope);
    if (pluginPrompt !== undefined) return pluginPrompt;
    if (!parseSlashCommand(prompt)) return undefined;
    const botSender = isBotSenderType(event.senderType);
    const allowlisted = await this.commandAllowlisted(config, event.chatType, event.chatId, event.senderOpenId, group.sessionId);
    const pluginCommands = larkPluginCommandHelp(pluginScope);
    const route = routeLarkCommand(prompt, {
      capabilities: this.larkRouteCapabilities(),
      operator: { kind: botSender ? 'bot' : 'user', allowlisted, ...(botSender ? { trusted: await this.parts.core.isTrustedBot(config, event) } : {}) },
      ...(pluginCommands.length ? { pluginCommands } : {})
    });
    if (route.kind === 'not_a_command') return undefined;
    // 未识别命令交回主流程当普通请求处理，命令层已做归一化防止再被当成内置命令。
    // S3：近似匹配时 suggestion 随对象带回，只上卡面，promptText 仍是唯一进 agent 的原文。
    if (route.kind === 'unknown_command') {
      return route.suggestion ? { prompt: route.promptText, suggestion: route.suggestion } : route.promptText;
    }

    // 命令回执一律是只读卡片：它不是任务，没有进度可承诺，也不该提供操作按钮。
    const replyCard = async (
      taskName: string,
      markdown: string,
      options: { elements?: LarkCardElement[]; failed?: boolean } = {}
    ) => {
      if (receipts?.notice) {
        markdown = `${receipts.notice}\n\n${markdown}`;
        if (options.elements?.length) options = { ...options, elements: [{ tag: 'markdown', content: receipts.notice }, ...options.elements] };
      }
      receipts?.cards.push({ title: taskName, markdown, failed: options.failed === true, ...(options.elements?.length ? { elements: options.elements } : {}) });
      if (receipts?.capture) return undefined;
      const card = await sendTaskCard(this.state.service, event, {
        state: options.failed ? 'failed' : 'completed', readOnly: true, retryable: false,
        taskId: event.messageId, taskName,
        markdown,
        ...(options.elements?.length ? { elements: options.elements } : {}),
        idempotencyKey: `cmd_${route.command}_${event.replyKey ?? event.messageId}`.slice(0, 50),
        ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {})
      }, this.state.log).catch(error => { this.state.log.error({ error, messageId: event.messageId, command: route.command }, '发送飞书命令回执失败'); if (receipts) receipts.deliveryFailed = true; return undefined; });
      // reaction 是「请求已接入」的回执，命令回执落地后必须撤销，避免两个状态并存。
      await this.parts.core.clearAcknowledgementReaction({ event, acknowledgement });
      return card;
    };

    if (route.kind === 'correction') {
      await replyCard('命令未执行', route.text);
      return 'handled';
    }
    if (route.kind === 'reply') {
      await replyCard(larkHelpCardTitle, route.text, { elements: route.elements });
      return 'handled';
    }
    if (route.kind === 'denied' || route.kind === 'unavailable') {
      const record = await this.parts.core.inbox.lookup(config.appId, event.messageId);
      if (record) await this.parts.core.inbox.update(record, { reason: 'command_rejected', detail: route.reason.slice(0, 500) });
      await replyCard(`/${route.command} 未执行`, route.reason, { failed: true });
      this.state.log.info({ messageId: event.messageId, command: route.command, kind: route.kind }, '飞书命令未执行');
      return 'handled';
    }
    return await this.executeChatCommandIntent(route, event, config, group, scopeId, replyCard, acknowledgement);
  }

  /**
   * C2：机器人自己的话题里（已有会话）的短控制语。返回 'handled' 表示已回执；返回请求表示接着走建任务链路
   * （授权、风险检查照常）；undefined 表示当普通消息。
   * - 停：同 /cancel。
   * - 继续：前面有结果未知、挡着话题的一轮，就按没做完处理，在原对话接着做；上一轮被中断、无进展超时停下或被自动结束的，
   *   也在原对话接着做。Agent 收到的是按原因写的接续说明，不是原请求。其余当普通消息。
   * - 重来：停在结果未知、等人选的那一轮同卡上「重新执行」（只限发起人本人）；上一轮失败、中断或取消同 /retry。其余当普通消息。
   */
  private async routeControlPhrase(kind: 'continue' | 'stop' | 'restart', event: LarkMessageEvent, config: StoredLarkConfig, prompt: string,
    group: LarkGroup, scopeId: string, acknowledgement?: LarkTask['acknowledgement']): Promise<'handled' | LarkCommandPrompt | undefined> {
    const boundSessionId = group.sessionId && !group.retiredSessionIds?.has(group.sessionId) ? group.sessionId : undefined;
    const sessionId = boundSessionId ?? (await this.findScopeSession(config, event, scopeId, group).catch(() => undefined))?.id;
    // 首轮还没建出会话时，准备中的请求只能靠「停」叫住：有这样的请求就按 /cancel 处理，不把「停」建成一条新请求。
    if (kind === 'stop' && (sessionId || [...this.state.tasks.values()].some(task => task.group === group && !task.cancelRequested && this.preparingTurn(task)))) {
      return await this.routeChatCommand(event, config, '/cancel', group, scopeId, acknowledgement) === 'handled' ? 'handled' : undefined;
    }
    if (!sessionId || !this.state.runtime.getTasks) return undefined;
    const confirm = (text: string) => this.state.service.replyText({ messageId: larkMessageAnchor(event), ...(event.threadId?.trim() ? { replyInThread: true } : {}),
      text, idempotencyKey: `control_${event.messageId}`.slice(0, 50) }).catch(error => this.state.log.warn({ error, messageId: event.messageId }, '控制语回执发送失败'));
    try {
      const tasks = await this.state.runtime.getTasks(sessionId);
      const unresolved = await this.unresolvedTurns(sessionId);
      const last = tasks.at(-1);
      if (kind === 'continue') {
        if (unresolved.length) {
          if (!await this.parts.core.isOperatorAllowed(config, event.senderOpenId, event.chatId, sessionId)) return undefined;
          let cause = {};
          for (const task of unresolved) cause = await this.closeUnresolvedTurn(config, sessionId, task.id);
          await confirm('好，上一轮按没做完处理，接着在原对话里做。');
          return { prompt, materialPrompt: larkContinuePrompt(cause) };
        }
        if (!last || !['failed', 'interrupted'].includes(last.status)) return undefined;
        const cause = await this.runtimeTaskContinueCause(config.appId, last);
        if (last.status === 'failed' && !cause) return undefined;
        await confirm('好，接着上一轮做。');
        return { prompt, materialPrompt: larkContinuePrompt(cause ?? {}) };
      }
      if (unresolved.length) {
        const { mapping, saved } = await this.cardTaskFor(config.appId, sessionId, unresolved.at(-1)!.id);
        if (!mapping || !saved?.card_message_id || saved.sender_open_id !== event.senderOpenId) return undefined;
        const result = await this.interruptedTurnAction('replay_turn', mapping.externalId, saved.turn ?? 0, event.senderOpenId, { messageId: saved.card_message_id, chatId: saved.chat_id });
        if (result.type !== 'success') return undefined;
        await confirm('好，重新执行上一条请求。');
        await this.parts.core.clearAcknowledgementReaction({ event, acknowledgement });
        return 'handled';
      }
      if (!last || !['failed', 'interrupted', 'cancelled'].includes(last.status)) return undefined;
      const retry = await this.routeChatCommand(event, config, '/retry', group, scopeId, acknowledgement);
      if (retry === 'handled' || retry === undefined) return retry;
      await confirm('好，重新执行上一条请求。');
      return typeof retry === 'string' ? { prompt: retry } : retry;
    } catch (error) {
      // 读不到上一轮或那一轮还没停稳等原因收不了口：当普通消息排队，排队卡上会写清楚并给按钮。
      this.state.log.warn({ error, sessionId, kind }, '控制语未能按控制处理，按普通消息处理');
      return undefined;
    }
  }

  /**
   * 命令层白名单门：群聊按群策略的 task.view_result，策略缺席时与私聊一样按机器人白名单。
   * 聊天命令与结果卡上的删记忆按钮共用这一个判断，两处对同一个人不会给出不同答案。
   */
  private async commandAllowlisted(config: StoredLarkConfig, chatType: string, chatId: string, operatorOpenId: string | undefined, sessionId?: string) {
    const access = chatType === 'group' ? await this.state.groupManager?.authorize(config.appId, chatId, operatorOpenId, 'task.view_result') : undefined;
    return access?.allowed ?? await this.parts.core.isOperatorAllowed(config, operatorOpenId, chatId, sessionId);
  }

  private commandDependencies(): CommandServices {
    return {
      absorbQueuedTask: this.absorbQueuedTask.bind(this),
      approvalBlock: this.approvalBlock.bind(this),
      botOpenId: this.state.botOpenId,
      cancelPreparingTurns: this.cancelPreparingTurns.bind(this),
      cancelUndeliveredRetries: this.cancelUndeliveredRetries.bind(this),
      cardMappings: this.state.cardMappings,
      clearAcknowledgementReaction: this.parts.core.clearAcknowledgementReaction.bind(this.parts.core),
      closedScopeSessions: this.closedScopeSessions.bind(this),
      currentTurnInterruptDenial: this.currentTurnInterruptDenial.bind(this),
      describeChatStatus: this.describeChatStatus.bind(this),
      groupManager: this.state.groupManager,
      groups: this.state.groups,
      handle: this.handle.bind(this),
      handleAction: this.handleAction.bind(this),
      inbox: this.parts.core.inbox,
      isDeferredTask: this.parts.core.isDeferredTask.bind(this.parts.core),
      isGrantOperatorAllowed: this.parts.core.isGrantOperatorAllowed.bind(this.parts.core),
      isInterruptOperatorAllowed: this.parts.core.isInterruptOperatorAllowed.bind(this.parts.core),
      isOperatorAllowed: this.parts.core.isOperatorAllowed.bind(this.parts.core),
      isRepairOperatorAllowed: this.parts.core.isRepairOperatorAllowed.bind(this.parts.core),
      isStaticOperatorAllowed: this.parts.core.isStaticOperatorAllowed.bind(this.parts.core),
      isTaskOperatorAllowed: this.parts.core.isTaskOperatorAllowed.bind(this.parts.core),
      larkTaskOrigin: this.parts.core.larkTaskOrigin.bind(this.parts.core),
      log: this.state.log,
      memory: this.parts.core.memory,
      newSessionHandoff: this.newSessionHandoff.bind(this),
      pickRetryableRuntimeTask: this.pickRetryableRuntimeTask.bind(this),
      pinSwitchedSession: this.pinSwitchedSession.bind(this),
      preparingTurn: this.preparingTurn.bind(this),
      replyForkList: this.replyForkList.bind(this),
      requesterOnlyReason: this.parts.core.requesterOnlyReason.bind(this.parts.core),
      requireExecution: this.parts.core.requireExecution.bind(this.parts.core),
      restoreRetryPrompt: this.restoreRetryPrompt.bind(this),
      retireScopeSession: this.retireScopeSession.bind(this),
      runtime: this.state.runtime,
      saveTaskDashboardOrigin: this.saveTaskDashboardOrigin.bind(this),
      service: this.state.service,
      sessionFor: this.sessionFor.bind(this),
      steeringPermissionStatus: this.steeringPermissionStatus.bind(this),
      taskDisplayPrompt: this.parts.core.taskDisplayPrompt.bind(this.parts.core),
      taskTitle: this.parts.core.taskTitle.bind(this.parts.core),
      tasks: this.state.tasks,
      validateNewSession: this.validateNewSession.bind(this),
      automation: this.state.workflowOptions.automation,
      memoryOptions: this.state.workflowOptions.memory,
      participation: this.state.workflowOptions.participation,
      store: this.state.workflowOptions.store,
      usage: this.state.workflowOptions.usage,
      workbench: this.state.workflowOptions.workbench,
    };
  }

  /**
   * 执行已授权的命令意图。全部复用既有机制：
   * /status 读持久化会话与排队任务；/cancel 与 /retry 直接走 handleAction 的同源分支；
   * /new 结束当前上下文，让下一条消息重新建会话。
   *
   * 返回 `'handled'` 表示命令已自行回执；返回字符串表示命令之后还带着一条任务内容
   * （`/new 跑一遍回归`），调用方要用它继续走完整的建任务链路——授权、风险检查、
   * 附件处理、幂等、卡片与队列一个都不能少，绝不在命令分支里直接发 prompt。
   */
  private async executeChatCommandIntent(
    route: Extract<LarkCommandRoute, { kind: 'intent' }>,
    event: LarkMessageEvent,
    config: StoredLarkConfig,
    group: LarkGroup,
    scopeId: string,
    replyCard: (taskName: string, markdown: string, options?: { elements?: LarkCardElement[]; failed?: boolean }) => Promise<{ messageId: string } | undefined>,
    acknowledgement?: LarkTask['acknowledgement']
  ): Promise<'handled' | string | LarkCommandPrompt> {
    // 最近一轮任务：/cancel 与 /retry 需要它，按插入顺序取该 group 的最后一个任务。
    const latestTask = [...this.state.tasks.values()].reverse().find(task => task.group === group);

    try {
      // 命令与普通消息共用同一条会话定位：内存绑定优先（同一进程内最新），
      // 缺失时回落到持久化查询，这样 coordinator 重建后命令仍能找到本上下文的会话。
      // 查询失败必须让命令整体失败：把它当成「没有会话」会让 /status 谎称尚未创建、
      // 让 /new 在没停掉任何东西的情况下回一句「已受理」，甚至直接派发新任务。
      const boundSessionId = group.sessionId && !group.retiredSessionIds?.has(group.sessionId) ? group.sessionId : undefined;
      const sessionId = boundSessionId ?? (await this.findScopeSession(config, event, scopeId, group))?.id;
      if (config.managedGroup && route.command === 'new' && !await this.parts.core.isOperatorAllowed(config, event.senderOpenId, event.chatId, sessionId)) {
        await replyCard(`/${route.command} 未执行`, '当前账号没有操作此任务的权限。', { failed: true });
        return 'handled';
      }
      const execute = route.definition.execute;
      if (execute) return await execute({ ...this.commandDependencies(), route, event, config, group, scopeId, sessionId, latestTask, replyCard, acknowledgement });
    } catch (error) {
      this.state.log.warn({ error, command: route.command, messageId: event.messageId }, '执行飞书聊天命令失败');
      await replyCard(`/${route.command} 执行失败`, `**命令未能完成。**\n\n${error instanceof Error ? error.message : String(error)}\n\n可稍后重试，或前往 Dutydeck Web 处理。`, { failed: true });
    }
    return 'handled';
  }

  /**
   * 切换后的模型与机器人配置的默认模型不一致时，普通消息的会话匹配（larkSessionMatchesScope）会在重启后认不出这条会话，
   * 悄悄另开新会话。像 /resume 一样写一条持久的启动绑定，让它按会话编号被认回来。返回 false 表示需要绑定却没写成。
   */
  private async pinSwitchedSession(config: StoredLarkConfig, session: Session): Promise<boolean> {
    if (!session.sourceId || larkSessionMatchesScope(session, config, session.sourceId)) return true;
    const mappings = this.state.cardMappings, sourceId = session.sourceId;
    try {
      // 与 /new 写事项边界串行：/new 已结束这条会话时不再改绑定，否则会抹掉它刚写的边界。
      return await this.withLaunchBinding(sourceId, async () => {
        const live = await this.state.runtime.getSession(session.id);
        if (!isRunnable(live)) return true;
        const channel = `lark-launch:${config.appId}`;
        const binding = await mappings.get(channel, sourceId);
        if (binding?.channel === channel && binding.externalId === sourceId && binding.sessionId === session.id) return true;
        // 旧绑定属于别的会话，它的事项边界等标记不能带到这条会话上；fallback 仍按“非显式指定 Agent”处理。
        await mappings.save({ id: `lark-launch:${sourceId}`, channel, externalId: sourceId, sessionId: session.id,
          extra: JSON.stringify({ baseConfigKey: larkSessionConfigKey(config), explicitAgent: false }), createdAt: new Date().toISOString() });
        return true;
      });
    } catch (error) {
      this.state.log.warn({ error, sessionId: session.id }, '保存切换后的会话绑定失败');
      return false;
    }
  }

  /** /fork list：同一事项（源会话与它的所有分身共用）里 relation=fork 的会话，只列调用人能查看结果的。 */
  private async replyForkList(config: StoredLarkConfig, event: LarkMessageEvent, sessionId: string | undefined, reply: ChatCommandReply) {
    if (!this.state.runtime.getMatter) throw new Error('当前运行时读不到分身关系，/fork list 不可用。');
    const forkIds = sessionId ? this.state.runtime.getMatter(sessionId)?.forkSessionIds ?? [] : [];
    const agentNames = new Map((await this.state.runtime.listAgents?.().catch(() => []) ?? []).map(agent => [agent.id, agent.name] as const));
    const rows: Array<{ id: string; title: string; status: string; agent: string; updatedAt: string; topicId?: string }> = [];
    for (const id of forkIds) {
      const fork = await this.state.runtime.getSession(id);
      const source = parseLarkSourceId(fork?.sourceId);
      if (!fork || fork.source !== 'lark' || source.appId !== config.appId || source.chatId !== event.chatId || source.chatType !== event.chatType) continue;
      const tasks = await this.state.runtime.getTasks?.(id) ?? [];
      const first = [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!first || !await this.parts.core.isTaskOperatorAllowed(config, event, { id: first.id, sessionId: id }, 'task.view_result')) continue;
      const last = tasks.reduce((latest, task) => (task.updatedAt || task.createdAt) > (latest.updatedAt || latest.createdAt) ? task : latest, first);
      const closed = !isRunnable(fork);
      const origin = await this.parts.core.larkTaskOrigin(config, event.chatId, { id: first.id, sessionId: id });
      const topicId = source.scope[0] === 'thread' ? source.scope[1] : undefined;
      rows.push({ id, title: fork.name ?? origin?.title ?? larkTaskTitle(first.prompt, config.name),
        status: closed ? '已关闭' : larkForkStatusLabels[last.status] ?? fork.state, agent: agentNames.get(fork.agentId) ?? fork.agentId,
        updatedAt: [fork.updatedAt, last.updatedAt || last.createdAt].sort().at(-1)!, topicId });
    }
    if (!rows.length) { await reply('分身列表', `**${forkIds.length ? '没有你可查看的分身' : '还没有分身'}。**\n\n发送 \`/fork [任务]\` 在新话题开分身。`); return; }
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    // 只给列出的前 10 条取话题链接，并发取。
    const links = await Promise.all(rows.slice(0, 10).map(row => row.topicId ? this.state.service.getMessageLink(row.topicId).catch(() => undefined) : undefined));
    const listed = rows.slice(0, 10).map((row, index) => `**${escapeLarkPromptEcho(larkCommandEcho(row.title, 60))}**${row.id === sessionId ? '（当前话题）' : ''}\n\`${row.id}\` · ${row.status} · ${larkCommandEcho(row.agent, 40)} · 更新 ${clock(row.updatedAt)}\n${links[index] ? `[打开话题](${links[index]})` : '话题链接暂不可用'}`);
    await reply('分身列表', `${listed.join('\n\n')}${rows.length > 10 ? `\n\n另有 ${rows.length - 10} 个分身未列出。` : ''}`);
  }

  private async closedScopeSessions(config: StoredLarkConfig, event: LarkMessageEvent, scopeId: string) {
    const candidates: Array<{ session: Session; firstTaskId: string; closedAt: string; approximate: boolean; title: string }> = [];
    for (const session of await listPersistedLarkSessions(this.state.runtime, config, event.chatId, event.chatType, scopeId, this.state.cardMappings)) {
      if (!['stopped', 'failed'].includes(session.state)) continue;
      const tasks = await this.state.runtime.getTasks?.(session.id) ?? [];
      // Empty command-created sessions have no context to restore.
      const first = [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      const origin = first ? await this.parts.core.larkTaskOrigin(config, event.chatId, { id: first.id, sessionId: session.id }) : undefined;
      if (!first || !origin?.requester || !await this.parts.core.isTaskOperatorAllowed(config, event, { id: first.id, sessionId: session.id }, 'run.resume')) continue;
      const events = await this.state.runtime.getRecentEvents?.(session.id, 500) ?? [];
      const closed = events.filter(item => item.type === 'status' && ['stopped', 'failed'].includes((item.data as { state?: string })?.state ?? ''))
        .sort((a, b) => b.sequence - a.sequence)[0];
      candidates.push({ session, firstTaskId: first.id, closedAt: closed?.timestamp ?? session.updatedAt, approximate: !closed, title: session.name ?? origin.title ?? larkTaskTitle(first.prompt, config.name) });
    }
    candidates.sort((a, b) => b.closedAt.localeCompare(a.closedAt));
    return candidates;
  }

  /** 从当前聊天有权读取的记录冻结交接，不调用模型，不扩展到无界事件历史。 */
  async newSessionHandoff(config: StoredLarkConfig, event: LarkMessageEvent, sessionId: string | undefined, tasks: TaskRecord[], note: string, nativeContextCopied = false) {
    const session = sessionId ? await this.state.runtime.getSession(sessionId) : undefined;
    if (sessionId) {
      const source = session?.sourceId ? parseLarkSourceId(session.sourceId) : undefined;
      if (session?.source !== 'lark' || source?.appId !== config.appId || source.chatId !== event.chatId || source.chatType !== event.chatType)
        throw new Error('无法核实交接来源属于当前机器人和聊天，未读取历史。');
    }
    const sessionUrl = sessionId && config.webBaseUrl ? safeLarkWebUrl(`${config.webBaseUrl.replace(/\/$/, '')}/sessions/${encodeURIComponent(sessionId)}`) : undefined;
    const source = { ...(sessionId ? { sessionId } : {}), ...(sessionUrl ? { sessionUrl } : {}) };
    const cwd = session?.cwd ?? config.workspace;
    if (nativeContextCopied) return formatLarkHandoff({ ...source, turns: [], note: '', nativeContextCopied: true, ...(cwd ? { cwd, git: await readGitSnapshot(cwd) } : {}) });
    const ordered = tasks.filter(task => task.sessionId === sessionId).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const visible: TaskRecord[] = [];
    for (const task of ordered) {
      if (await this.parts.core.isTaskOperatorAllowed(config, event, task, 'task.view_result')) visible.push(task);
    }
    const recent = visible.filter(task => terminalTaskStates.has(task.status)).slice(-3);
    const other = visible.filter(task => !recent.includes(task));
    const important = (task: TaskRecord) => ['failed', 'interrupted', 'reconcile_required'].includes(task.status) ? 0 : 1;
    const indexed = [...other].sort((left, right) => important(left) - important(right) || left.createdAt.localeCompare(right.createdAt)).slice(0, larkHandoffIndexLimit);
    const window = sessionId && recent.length && this.state.runtime.getRecentEvents
      ? await this.state.runtime.getRecentEvents(sessionId, larkHandoffEventLimit).catch(() => []) : [];
    const store = this.state.workflowOptions.store;
    const cards = sessionId && recent.length ? await this.state.cardMappings.list(larkCardChannel(config.appId)).catch(() => undefined) : undefined;
    const explicitFinal = async (task: TaskRecord) => {
      const matches = (cards ?? []).flatMap(row => {
        try {
          const saved = parseCardTask(row.extra ?? '{}');
          return row.sessionId === sessionId && saved.app_id === config.appId && saved.runtime_task_id === task.id && saved.chat_id === event.chatId && saved.chat_type === event.chatType ? [{ row, saved }] : [];
        } catch { return []; }
      });
      const context = matches.length === 1 ? explicitFinalContext(matches[0]!.row, matches[0]!.saved, task.currentAttemptId) : undefined;
      const content = context ? (await readExplicitFinal(store, context).catch(() => undefined))?.trim() : undefined;
      return content ? redactTraceText(content) : undefined;
    };
    const title = async (task: TaskRecord) => (await this.parts.core.larkTaskOrigin(config, event.chatId, task).catch(() => undefined))?.title ?? larkTaskTitle(task.prompt, config.name);
    const turns = await Promise.all(recent.map(async task => {
      // A missing boundary must not attribute a neighbouring turn's output to this task.
      let start = -1;
      for (let index = 0; index < window.length; index++) {
        const item = window[index]!;
        if (item.type === 'text' && (item.data as any)?.role === 'user' && (item.data as any)?.taskId === task.id
          && (!task.currentAttemptId || !item.attemptId || item.attemptId === task.currentAttemptId)) start = index;
      }
      const next = start >= 0 ? window.findIndex((item, index) => index > start && item.type === 'text' && (item.data as any)?.role === 'user' && (item.data as any)?.taskId !== task.id) : -1;
      const events = start >= 0 ? eventsForRuntimeTask(window.slice(start, next < 0 ? undefined : next), task.id)
        .filter(item => (!item.taskId || item.taskId === task.id) && (!task.currentAttemptId || !item.attemptId || item.attemptId === task.currentAttemptId)) : [];
      const elements = renderLarkResultElements(events);
      const explicit = await explicitFinal(task);
      const result = explicit ?? elements.find(element => element.element_id === 'final_output')?.content
        ?? elements.find(element => String(element.element_id ?? '').startsWith('execution_alert_'))?.content;
      return { title: await title(task), status: task.status, taskId: task.id, attemptId: task.currentAttemptId, events,
        ...(typeof result === 'string' ? { result, resultSource: explicit ? 'explicit_final' as const : elements.some(element => element.element_id === 'final_output') ? 'agent_text' as const : 'execution_alert' as const } : {}) };
    }));
    const index = await Promise.all(indexed.map(async task => ({ title: await title(task), status: task.status, taskId: task.id, attemptId: task.currentAttemptId })));
    return formatLarkHandoff({ ...source, turns, index, taskTotal: visible.length, goal: visible[0]?.prompt, goalSource: visible[0] ? { taskId: visible[0].id, attemptId: visible[0].currentAttemptId } : undefined, note,
      eventsIncomplete: window.length >= larkHandoffEventLimit || turns.some(turn => !turn.events.length),
      ...(cwd ? { cwd, git: await readGitSnapshot(cwd) } : {}) });
  }

  /**
   * 汇总会话/Agent/工作区/排队状态，口径与 Web 保持一致：运行数与待执行指令数分开。
   *
   * 有实际会话时以**会话自己的** agentId / cwd 为准：配置可能在会话创建之后被改过，
   * 照着配置写会告诉用户一个它其实没在用的 Agent。配置与会话不一致时两者都列出来。
   */
  /** /status 的 Agent 状态行（A1）。不可用标记超过 5 分钟先复查一次（不调模型）。 */
  private async agentAvailabilityLine(agentId: string) {
    const reliability = this.state.runtime;
    if (!reliability.getAgentAvailability) return undefined;
    let mark = reliability.getAgentAvailability(agentId);
    if (mark && Date.now() - Date.parse(mark.at) > 5 * 60_000 && reliability.checkAgentAvailability) mark = await reliability.checkAgentAvailability(agentId).catch(() => mark);
    return larkAgentAvailabilityLine(mark);
  }

  async describeChatStatus(config: StoredLarkConfig, sessionId?: string, latestTask?: LarkTask, chatId = latestTask?.event.chatId ?? ''): Promise<string> {
    const lines: string[] = [];
    const configuredAgent = config.defaultAgentId ?? 'Dutydeck';
    if (!sessionId) {
      lines.push(`**Agent**：${larkCommandEcho(configuredAgent, 64)}`);
      const availability = config.defaultAgentId ? await this.agentAvailabilityLine(config.defaultAgentId) : undefined;
      if (availability) lines.push(availability);
      if (config.workspace) lines.push(`**工作区**：${larkCommandEcho(config.workspace, 160)}`);
      lines.push(larkExecutionIdentityLine());
      lines.push('这条消息不在已有任务话题中。请回原话题查询，或发送 `/tasks` 查看任务。');
      return lines.join('\n\n');
    }
    let session: Session | undefined;
    let sessionError = false;
    try {
      session = await this.state.runtime.getSession(sessionId);
    } catch (error) {
      this.state.log.warn({ error, sessionId }, '读取会话状态失败');
      sessionError = true;
    }
    lines.push(`**Agent**：${larkCommandEcho(session?.agentId ?? configuredAgent, 64)}`);
    const statusAgentId = session?.agentId ?? config.defaultAgentId;
    const availability = statusAgentId ? await this.agentAvailabilityLine(statusAgentId) : undefined;
    if (availability) lines.push(availability);
    if (session && session.agentId !== config.defaultAgentId) {
      lines.push(`**配置的 Agent**：${larkCommandEcho(configuredAgent, 64)}（下一个新会话生效）`);
    }
    const workspace = session?.cwd ?? config.workspace;
    const worktree = session?.workspaceMode === 'worktree';
    const worktreeSource = worktree && session?.workspaceSourceCwd ? `，基于 ${larkCommandEcho(session.workspaceSourceCwd, 160)}` : '';
    if (workspace) lines.push(`**工作区**：${larkCommandEcho(workspace, 160)}${worktree ? `（独立 worktree${worktreeSource}）` : ''}`);
    if (session?.model) lines.push(`**模型**：${larkCommandEcho(session.model, 128)}`);
    if (session?.reasoningEffort) lines.push(`**推理强度**：${larkCommandEcho(session.reasoningEffort, 32)}`);
    // worktree 会话的 cwd 是另建的目录，拿它的源目录比较；与会话复用（larkSessionMatchesScope）用同一个口径。
    if (session && config.workspace && !sameWorkspace(session.workspaceSourceCwd ?? session.cwd, config.workspace)) {
      lines.push(`**配置的工作区**：${larkCommandEcho(config.workspace, 160)}（下一个新会话生效）`);
    }
    lines.push(`**会话**：\`${larkCommandEcho(sessionId, 64)}\``);
    lines.push(larkExecutionIdentityLine());
    if (sessionError) lines.push('**运行状态**：读取失败，请前往 Dutydeck Web 查看。');
    else if (session) lines.push(`**运行状态**：${larkCommandEcho(session.state, 32)}`);
    else lines.push('**运行状态**：会话记录已不存在，发送新的请求会开启新会话。');
    if (this.state.runtime.getTasks) {
      try {
        const tasks = await this.state.runtime.getTasks(sessionId);
        const queued = tasks.filter(task => task.status === 'queued').length;
        const running = tasks.filter(task => task.status === 'running').length;
        // 排队运行数与待执行指令数是两个口径，必须分开表达，不混用。
        const unresolved = tasks.filter(task => ['reconcile_required', 'legacy_unresolved'].includes(task.status));
        const approval = queued ? await this.approvalBlock(config.appId, sessionId) : undefined;
        lines.push(`**执行中的运行**：${running} 个　**待执行指令**：${queued} 条${approval ? '（被审批阻塞）' : ''}　**需要核对**：${unresolved.length} 条`);
        if (approval) {
          const deadline = approval.record?.expiresAt ? `，${deadlineText(approval.record.expiresAt)}截止，到时仍未处理将自动拒绝` : '';
          lines.push(`**被审批阻塞**：当前一轮在等审批${deadline}。后面 ${queued} 条指令要等它处理完才会执行。${approval.record
            ? '不需要这一步时，可以点下方「拒绝这条审批」放行队列。' : '请在审批卡或 Dutydeck Web 上处理这条审批。'}`);
        }
        for (const task of [...unresolved, ...tasks.filter(task => task.status === 'queued')].slice(0, 3)) {
          const recovery = await describeLarkTaskRecovery(this.state.runtime, sessionId, task.id, task.status);
          const displayedPrompt = await this.parts.core.taskDisplayPrompt(config, chatId, sessionId, task);
          lines.push(`${larkCommandEcho(displayedPrompt, 80)}\n\n${approval && task.status === 'queued' && !recovery.blocked
            ? '**被审批阻塞**\n\n前一轮在等审批，处理完后才会执行。' : recovery.markdown}`);
        }
      } catch (error) {
        this.state.log.warn({ error, sessionId }, '读取任务队列失败');
      }
    }
    // 结果没送达的轮次：任务本身已经结束，只是结论没能发到飞书，读者在群里看不到它。
    try {
      const issues = larkResultDeliveryIssues((await this.state.cardMappings.list(larkCardChannel(config.appId))).filter(mapping => mapping.sessionId === sessionId));
      for (const issue of issues.slice(0, 3)) {
        const reason = larkCommandEcho(issue.error ?? '未记录', 200);
        lines.push(issue.state === 'failed'
          ? `**结果未送达**：「${larkCommandEcho(issue.taskName, 80)}」的结果没有确认送达飞书，不会再自动重发。原因：${reason}`
          : `**结果投递重试中**：「${larkCommandEcho(issue.taskName, 80)}」的结果第 ${issue.attempts} 次发送失败，稍后自动重发。原因：${reason}`);
      }
    } catch (error) {
      this.state.log.warn({ error, sessionId }, '读取结果投递状态失败');
    }
    if (latestTask) lines.push(`**最近一轮**：${larkCommandEcho(latestTask.state, 32)}`);
    return lines.join('\n\n');
  }

  /**
   * 当前一轮停在执行端审批上、同一会话后面还有指令排队时，这些指令都被这条审批挡住。
   * record 是本进程发出的审批卡记录（卡片尚未送达或审批只在 Web 上时没有），供「拒绝这条审批」入口使用。
   */
  async approvalBlock(appId: string, sessionId: string) {
    if (!(await this.state.runtime.getTasks?.(sessionId))?.some(task => task.status === 'queued')) return undefined;
    const permissions = await this.state.runtime.getPendingPermissions?.(sessionId) ?? [];
    if (!permissions.length) return undefined;
    const record = (await this.parts.core.workflows.list(appId)).find(item => item.kind === 'permission' && item.state === 'pending' && item.sessionId === sessionId
      && item.boot === this.parts.core.workflows.boot && permissions.some(permission => permission.id === item.nativeId));
    return { record };
  }

  /**
   * 「查看详情」回调（仅 Web 要求登录时渲染）：管理员收到一条私信，内含绑定该会话的一次性登录链接。
   * 一键登录停用（没有 loginLinks）后新卡不再渲染这个按钮，但已经发出的旧卡上还有：这时私信的是这个
   * 会话的只读分享链接，和新卡页脚同一个链接。新卡页脚群里谁都能看到，所以这条路不走管理员门。
   *
   * 回调里不信任卡片上的任何值：会话按平台给出的 open_message_id 从卡片账本里查，账本记录必须属于
   * 当前机器人和当前群。旧卡同样受理（查看详情只读）：重试旧卡跳到任务现在所在的会话，转交旧卡跳原会话。
   * target 只用来定位转交认领，会话一律取持久化记录。
   * 链接只发到点击人的单聊，群里不出现；也不写日志——下面记录的错误只含飞书返回码。
   */
  private async handleDetailLogin(operatorOpenId?: string, context?: { messageId?: string; chatId?: string }, target?: { taskId: string; turn?: number }) {
    const links = this.state.workflowOptions.loginLinks;
    if (!operatorOpenId || !context?.messageId || !context.chatId || !this.state.reconcileConfig) {
      return { type: 'error', content: '详情入口已失效，请在最新的任务卡片上操作。' };
    }
    try {
      const config = await readLarkConfig(this.state.workflowOptions.store, this.state.reconcileConfig.appId);
      if (!config?.listening) return { type: 'warning', content: '机器人已停用，无法打开详情。' };
      const webBaseUrl = config.webBaseUrl?.trim().replace(/\/$/, '');
      let card: { externalId: string; sessionId: string; saved: PersistedLarkCardTask } | undefined;
      for (const mapping of await this.state.cardMappings.list(larkCardChannel(config.appId))) {
        let saved: PersistedLarkCardTask;
        try { saved = parseCardTask(mapping.extra ?? '{}'); }
        catch { continue; }
        if (saved.app_id !== config.appId || saved.chat_id !== context.chatId
          || ![saved.card_message_id, saved.final_message_id, ...saved.earlier_message_ids ?? []].includes(context.messageId)) continue;
        card = { externalId: mapping.externalId, sessionId: mapping.sessionId, saved };
        break;
      }
      // 转交旧卡：映射已移到新一轮，按回调里的任务与轮次读转交认领。claim.sessionId 是原会话，
      // 与 markRelaunchedCard 给这张旧卡的页脚会话一致。
      if (!card && target?.turn !== undefined) {
        const raw = await this.decisions.get(turnDecisionKey('relaunch', config.appId, target.taskId, target.turn));
        const claim = raw ? JSON.parse(raw) as LarkRelaunchClaim : undefined;
        if (claim?.phase === 'moved' && claim.cardMessageId === context.messageId && claim.chatId === context.chatId) {
          card = { externalId: claim.taskId, sessionId: claim.sessionId, saved: { app_id: claim.appId, chat_id: claim.chatId, turn: claim.turn,
            state: claim.action === 'rerun_in_new_session' ? 'reconcile_required' : 'cancelled' } as PersistedLarkCardTask };
        }
      }
      // 与渲染端同一个判断：卡上出现「查看详情」按钮的条件，就是这里受理的条件。
      if (!card || !webBaseUrl || !isLarkCardActionAvailable('detail', {
        state: card.saved.state, taskId: card.externalId, turn: card.saved.turn ?? 0,
        capabilities: { canCancelQueued: false, canInterrupt: false, canRetry: false, canRefresh: false, detailLogin: true, webUrl: `${webBaseUrl}/sessions/${encodeURIComponent(card.sessionId)}` }
      })) {
        return { type: 'warning', content: '找不到这张卡片对应的任务记录，无法打开详情。' };
      }
      // 登录链接兑换后等同登录，与 /repair 同一道安装级门；谁能拿到链接完全由这道门决定。
      // 未配置操作白名单时没有可认定的管理员，一律不发。
      const loginAuth = links ? await this.parts.core.isRepairOperatorAllowed(config, operatorOpenId, context.chatId) : undefined;
      if (loginAuth && !loginAuth.allowed) {
        return { type: 'warning', content: loginAuth.reason === 'unconfigured'
          ? '未配置操作白名单，飞书里不发 Web 登录链接；请管理员在机器人设置里配置操作白名单，或直接在 Web 上查看。完整执行记录可点「导出执行记录」获取'
          : 'Web 详情仅机器人管理员可打开；完整执行记录可点「导出执行记录」获取' };
      }
      const elements = links
        ? larkDetailLoginElements(`${webBaseUrl}/api/auth/link?code=${links.issue(card.sessionId)}`)
        : larkSessionShareElements(larkSessionDetailUrl(webBaseUrl, card.sessionId));
      try {
        await this.state.service.send({ receiveId: operatorOpenId, receiveIdType: 'open_id', taskName: links ? '登录 Dutydeck Web' : '任务详情', state: 'completed', readOnly: true,
          permissionMode: larkPermissionMode(config), elements });
      } catch (error) {
        const upstreamCode = error instanceof LarkServiceError ? error.upstreamCode : undefined;
        this.state.log.warn({ upstreamCode, messageId: context.messageId }, '私信 Web 登录链接失败');
        // 230013：点击人不在应用可用范围内，机器人无法与其单聊。
        return { type: 'error', content: upstreamCode === 230013
          ? '私信发送失败：你不在机器人应用的可用范围内，请联系管理员把你加入可用范围。链接没有发出。'
          : `私信发送失败（飞书返回码 ${Number.isFinite(upstreamCode) ? upstreamCode : '未知'}），链接没有发出，请稍后重试。` };
      }
      return { type: 'success', content: links ? '已私信你一个 10 分钟内有效的登录链接' : '已私信你这个任务的只读详情链接' };
    } catch (error) {
      this.state.log.warn({ error, messageId: context.messageId }, '受理查看详情失败');
      return { type: 'error', content: '暂时无法打开详情，请稍后重试。' };
    }
  }

  /**
   * /repair 后台执行体：卡片回调在全部门禁通过后 3 秒内返回，真正的开放平台发布与结果卡
   * PATCH 在这里完成。任何失败都如实落到卡片，绝不抛出（调用方 fire-and-forget）。
   */
  async executeRepairFlight(config: StoredLarkConfig, appId: string, messageId: string) {
    await this.state.service.update({
      messageId, taskId: messageId, taskName: '/repair 正在执行',
      state: 'running', readOnly: true, permissionMode: larkPermissionMode(config),
      markdown: '**正在执行修复**\n\n正在连接飞书开放平台，增量补齐权限、事件订阅与卡片回调；完成后会在本卡回报结果，请勿重复触发。'
    }).catch(error => this.state.log.warn({ error }, 'PATCH /repair 进行中状态失败'));
    // 缓存登录态命中时不进入扫码等待；缓存失效又无人扫码时，用有界等待快速失败，
    // 让结果卡回报「登录态过期」而不是长时间悬挂。
    let result: Awaited<ReturnType<typeof runOpenPlatformRepair>>;
    try {
      result = await runOpenPlatformRepair(
        {
          connectClient: async () => connectLarkOpenPlatformSession({ maxWaitMs: 30_000 }),
          // 斜杠命令走 tenant_access_token，而 this.state.service 正是本机器人的客户端。
          // 回调门禁已保证被修复的就是本应用（见上方 appId 比对）；万一不是，宁可交给
          // repair 的 env 回落去判，也绝不拿另一个应用的 token 去写命令菜单。
          ...(appId === config.appId ? { slashCommandClient: this.state.service } : {})
        },
        { appId, confirmed: true }
      );
    } catch (error) {
      this.state.log.warn({ error }, '后台执行 /repair 失败');
      await this.state.service.update({
        messageId, taskId: messageId, taskName: '/repair 修复失败',
        state: 'failed', readOnly: true, permissionMode: larkPermissionMode(config),
        markdown: '修复执行失败，请稍后重试；本次未完成发布。'
      }).catch(() => undefined);
      return;
    }
    const rendered = renderRepairResultCard(result);
    const state = result.status === 'failed' ? 'failed' as const : 'completed' as const;
    try {
      await this.state.service.update({
        messageId, taskId: messageId, taskName: rendered.title,
        state, readOnly: true, permissionMode: larkPermissionMode(config),
        markdown: rendered.markdown, ...(rendered.elements.length ? { elements: rendered.elements } : {})
      });
    } catch (error) {
      // 外部修复已经有确定结果；回执失败不能改写发布事实，也不能诱导用户再次发布。
      this.state.log.warn({ error, status: result.status,
        ...('versionId' in result ? { versionId: result.versionId } : {}),
        ...('publishAttempted' in result ? { publishAttempted: result.publishAttempted } : {})
      }, '/repair 执行结果已产生，但结果卡投递失败');
    }
  }

  /** 代办命令的出处：按这一轮的卡片记录找回请求消息、会话 scope 和机器人配置。 */
  private async agentCommandOrigin(request: { sessionId: string; taskId: string }) {
    const store = this.state.workflowOptions.store;
    const current = this.state.reconcileConfig ? await readLarkConfig(store, this.state.reconcileConfig.appId) : undefined;
    if (!current?.listening) throw new RuntimeError('AGENT_COMMAND_UNAVAILABLE', '机器人当前不在监听，现在不能代办命令。', 503);
    let origin: { externalId: string; saved: PersistedLarkCardTask } | undefined;
    for (const mapping of await this.state.cardMappings.list(larkCardChannel(current.appId))) {
      const saved = mapping.sessionId === request.sessionId ? parseOptionalCardTask(mapping.extra) : undefined;
      if (saved?.runtime_task_id === request.taskId && saved.scope_id) { origin = { externalId: mapping.externalId, saved }; break; }
    }
    const raw = origin?.externalId.startsWith('om_') ? await store.get(`lark.inbox.${current.appId}.${origin.externalId}`) : undefined;
    const requested = raw ? (JSON.parse(raw) as LarkInboxRecord).event : undefined;
    if (!origin || !requested) throw new RuntimeError('AGENT_COMMAND_ORIGIN_MISSING', '找不到这一轮的飞书消息，不能代办命令。', 409);
    const { saved } = origin;
    const config = saved.chat_type === 'group' && this.state.groupManager ? await this.state.groupManager.resolved(current, saved.chat_id) : current;
    // 话题根要带上：话题续接发起人顶层会话时，重启后靠它找回那个会话。
    const place = { chatId: saved.chat_id, chatType: saved.chat_type ?? 'group', ...(requested.threadId ? { threadId: requested.threadId } : {}), ...(requested.rootId ? { rootId: requested.rootId } : {}) };
    return { config, requested, place, scopeId: saved.scope_id! };
  }

  /**
   * Agent 代发的命令（dutydeck agent 的写入命令、旧入口 dutydeck command，见 agent-command.ts）。按这一轮的卡片记录找回请求消息和会话 scope：
   * 查看类以发起人的身份、在请求消息下立即执行；会改东西的在请求消息下发确认卡，点「确认」后再执行。dryRun 只返回将要做什么，不执行、不发卡。
   */
  async agentCommand(request: LarkAgentCommandRequest): Promise<Record<string, unknown>> {
    return this.agentCommandAt(request, await this.agentCommandOrigin(request));
  }

  private async agentCommandAt(request: LarkAgentCommandRequest, origin: Awaited<ReturnType<LarkCoordinatorInbound['agentCommandOrigin']>>, notice?: string, requireDelivery = false): Promise<Record<string, unknown>> {
    const { parsed, summary, confirm } = agentCommandPlan(request.command);
    const { config, requested, place, scopeId } = origin;
    if (parsed.name === 'resume' && !parsed.args.length && !request.dryRun) {
      const target = (await this.closedScopeSessions(config, requested, scopeId))[0];
      if (!target) throw new Error('本话题没有可恢复的已关闭会话。');
      return this.agentCommandAt({ ...request, command: `/resume ${target.session.id}` }, origin, notice, requireDelivery);
    }
    if (parsed.name === 'new' || parsed.name === 'fork') {
      // Agent 看不到 Agent 编号：填错时直接退回可用编号让它改，不发一张注定失败的确认卡。
      const agentId = parseLarkNewSession(parsed.argsText).launchOptions?.agentId;
      const agents = agentId ? await this.state.runtime.listAgents?.() ?? [] : [];
      if (agentId && !agents.some(agent => agent.id === agentId)) {
        const available = agents.map(agent => `${agent.id}（${agent.name}）`).join('、') || '无';
        throw new AgentCommandParamError('AGENT_COMMAND_INVALID', `没有编号为 ${agentId} 的 Agent。可用：${available}。`, [{ name: '--agent', reason: `没有编号为 ${agentId} 的 Agent；可用：${available}` }]);
      }
    }
    // /grant @成员：成员要在用户这条消息里被 @ 过，按名字对上那条提及（命令层只认真实的提及）。
    const mentioned = requested.mentions.filter(mention => mention.openId && mention.openId !== this.state.botOpenId);
    const missing = request.members?.filter(name => !mentioned.some(mention => mention.name === name)) ?? [];
    if (missing.length) {
      const seen = mentioned.length ? `这条消息 @ 过：${mentioned.map(mention => mention.name).join('、')}` : '这条消息没有 @ 任何成员';
      throw new AgentCommandParamError('INVALID_ARGUMENT', `${missing.join('、')} 没有在用户这条消息里被 @ 过。`, missing.map(name => ({ name: '--member', reason: `${name} 没有在用户这条消息里被 @ 过；${seen}` })),
        '只能操作用户在这条消息里 @ 过的成员；需要的话请用户在消息里 @ 要操作的人。');
    }
    const mentions = mentioned.filter(mention => parsed.argsText.includes(`@${mention.name}`));
    const confirmSummary = `${notice ? `${notice}\n\n` : ''}${agentCommandConfirmSummary(summary, parsed.raw)}`;
    if (request.dryRun) {
      const route = routeLarkCommand(parsed.raw, { capabilities: this.larkRouteCapabilities(), operator: { kind: 'user', allowlisted: true } });
      if (route.kind === 'unavailable') throw new RuntimeError('AGENT_COMMAND_UNAVAILABLE', route.reason, 409);
      const repair = parsed.name === 'repair' ? buildRepairConfirmCard(config.appId) : undefined;
      const card = confirm ? { title: '待确认的操作', body: confirmSummary } : repair ? { title: repair.title, body: repair.markdown }
        : parsed.name === 'pr' ? { title: '/pr 需要确认', body: '执行时生成：要推送的 dutydeck/ 分支、提交和 PR 标题。' } : undefined;
      return { dryRun: true, command: parsed.raw, summary, needsConfirmation: Boolean(card), ...(card ? { confirmCard: card } : {}),
        effect: confirm ? '在本轮请求消息下发确认卡；发起人或有权限的人点「确认」后，以点击人的身份执行，和他在原话题自己发这条命令一样。'
          : card ? '执行后在本轮请求消息下发这张确认卡；用户在卡上确认后才真正执行。' : '以本轮发起人的身份立即执行，结果卡发在本轮请求消息下。' };
    }
    if (!confirm) {
      // 回执挂在请求消息下；去重键按命令区分，同一轮代发 /help 1 和 /help 2 各回一张卡。
      const replyKey = createHash('sha256').update(`${requested.messageId}\n${parsed.raw}`).digest('hex').slice(0, 24);
      const receipts: LarkCommandReceipts = { capture: false, cards: [], ...(notice ? { notice } : {}) };
      await this.runAgentCommand({ ...this.agentCommandEvent(config, { ...place, messageId: requested.messageId }, request.actorId, parsed.raw, mentions), replyKey }, config, parsed.raw, scopeId, undefined, receipts);
      if (requireDelivery && receipts.deliveryFailed) throw new RuntimeError('AGENT_COMMAND_CARD_FAILED', '确认卡或回执没发出去。', 502);
      if (!request.action) return { executed: true, message: '已执行，结果卡已发到对话里。不用复述卡片内容，也不要让用户再发命令。' };
      // dutydeck agent 这里只有自己发确认卡的命令（/pr、/repair）：卡没发成就如实报错。
      const failed = receipts.cards.find(card => card.failed);
      if (failed) throw new RuntimeError('AGENT_COMMAND_REJECTED', larkPlainText(failed.markdown), 409);
      return { pendingConfirmation: true, message: '已发确认卡，用户在卡上确认后才执行。只回一句已发确认卡，不要说已完成，也不要让用户发命令。' };
    }
    const confirmations = this.state.workflowOptions.participation?.confirmations;
    if (!confirmations) throw new RuntimeError('AGENT_COMMAND_UNAVAILABLE', '当前服务不能发确认卡，现在不能代办这条命令。', 503);
    const record = await confirmations.request({ kind: larkAgentCommandKind(config.appId), scope: { appId: config.appId, chatId: place.chatId }, requesterId: request.actorId,
      replyTo: { messageId: requested.messageId, ...(requested.threadId ? { threadId: requested.threadId } : {}) }, dedupeKey: `${requested.messageId}:${parsed.raw}`,
      title: '待确认的操作', summary: confirmSummary,
      payload: { command: parsed.raw, session_id: request.sessionId, scope_id: scopeId, chat_type: place.chatType, ...(place.threadId ? { thread_id: place.threadId } : {}), ...(place.rootId ? { root_id: place.rootId } : {}), mentions: JSON.stringify(mentions) } });
    if (!record?.cardMessageId) throw new RuntimeError('AGENT_COMMAND_CARD_FAILED', '确认卡没发出去。', 502);
    return { pendingConfirmation: true, message: '已发确认卡，用户点「确认」后才执行。只回一句已发确认卡，不要说已完成，也不要让用户发命令。' };
  }

  /**
   * dutydeck agent 的查看类：以这一轮发起人的身份，走和他在原话题发这条命令同一条路（权限一致），回执不发卡，
   * 和卡片同样的文本连同结构化数据交回给 Agent。/tasks 直接取导航卡的数据。
   */
  async agentView(request: LarkAgentViewRequest): Promise<Record<string, unknown>> {
    const { config, requested, place, scopeId } = await this.agentCommandOrigin(request);
    const command = { status: '/status', agents: '/agents', tasks: '/tasks', queue: '/queue', schedules: '/schedule', ci: '/ci' }[request.view];
    const event = this.agentCommandEvent(config, { ...place, messageId: requested.messageId }, request.actorId, command, []);
    if (request.view === 'tasks') {
      const { entries, sessions } = await this.taskDashboardData(event, config);
      const { page, totalPages, entries: items } = pageLarkTaskDashboard(entries, request.page ?? 1);
      const decisions = await this.taskDashboardDecisions(event, config, sessions);
      return { page, totalPages, total: entries.length, decisions: decisions.map(({ kind, title, session, waitingMs, url }) => ({ kind, title, ...(session ? { session } : {}), waitingMs, ...(url ? { url } : {}) })), tasks: items.map(entry => ({ taskId: entry.taskId, title: entry.title, status: entry.status, agent: entry.agent, workspace: entry.workspace,
        updatedAt: entry.updatedAt, ...(entry.taskReport ? { taskReport: entry.taskReport } : {}), ...(entry.url ? { url: entry.url } : {}), ...(entry.detail ? { detail: entry.detail } : {}), ...(entry.feedback ? { feedback: entry.feedback } : {}),
        ...(entry.pendingApproval ? { pendingApproval: entry.pendingApproval.commandSummary } : {}) })) };
    }
    const receipts: LarkCommandReceipts = { capture: true, cards: [] };
    await this.runAgentCommand(event, config, command, scopeId, undefined, receipts);
    const card = receipts.cards.at(-1);
    if (!card) throw new RuntimeError('AGENT_COMMAND_FAILED', '命令没有给出结果。', 500);
    if (card.failed) throw new RuntimeError('AGENT_COMMAND_REJECTED', larkPlainText(card.markdown), 403);
    return { ...await this.agentViewData(request, config), text: card.markdown };
  }

  /** 查看类的结构化数据：命令已按发起人的权限执行成功后才读。 */
  private async agentViewData(request: LarkAgentViewRequest, config: StoredLarkConfig): Promise<Record<string, unknown>> {
    const { sessionId, actorId } = request;
    const automation = this.state.workflowOptions.automation;
    switch (request.view) {
      case 'status': {
        const session = await this.state.runtime.getSession(sessionId).catch(() => undefined);
        const tasks = await this.state.runtime.getTasks?.(sessionId).catch(() => []) ?? [];
        const count = (...statuses: string[]) => tasks.filter(task => statuses.includes(task.status)).length;
        return { sessionId, agent: session?.agentId ?? config.defaultAgentId, ...(session && config.defaultAgentId && session.agentId !== config.defaultAgentId ? { configuredAgent: config.defaultAgentId } : {}),
          ...(session?.model ? { model: session.model } : {}), ...(session?.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
          workspace: session?.cwd ?? config.workspace, state: session?.state ?? 'missing',
          running: count('running'), queued: count('queued'), needsReview: count('reconcile_required', 'legacy_unresolved') };
      }
      case 'agents':
        return { agents: (await this.state.runtime.listAgents?.() ?? []).map(agent => ({ id: agent.id, name: agent.name, ...(agent.version?.trim() ? { version: agent.version.trim() } : {}), default: agent.id === config.defaultAgentId })) };
      case 'queue':
        return { queued: (await this.state.runtime.getTasks?.(sessionId) ?? []).filter(task => task.status === 'queued').map((task, index) => ({ index: index + 1, taskId: task.id, prompt: task.prompt })) };
      case 'schedules':
        return { schedules: automation ? (await automation.listBySession(sessionId, actorId)).schedules.map(item => ({ id: item.id, name: item.name, prompt: item.prompt, enabled: item.enabled,
          when: describeScheduleTrigger(item.trigger, item.timezone), ...(item.nextDueAt ? { nextDueAt: item.nextDueAt } : {}) })) : [] };
      default: {
        const records = automation ? await automation.listBySession(sessionId, actorId) : undefined;
        return {
          waits: (records?.subscriptions ?? []).map(item => ({ id: item.id, status: item.status, repository: item.repository.slug, headSha: item.headSha, expiresAt: item.expiresAt, ...(item.error ? { error: item.error } : {}) })),
          webhookWaits: (await automation?.ciWebhook?.listBySession(sessionId) ?? []).map(item => ({ id: item.id, status: item.status, repository: item.repository, branch: item.branch, headSha: item.headSha, rounds: item.rounds, ...(item.reason ? { reason: item.reason } : {}) }))
        };
      }
    }
  }

  async agentSettings(request: LarkAgentSettingsRequest): Promise<Record<string, unknown>> {
    return this.agentSettingsAt(request, await this.agentCommandOrigin(request));
  }

  private async agentSettingsAt(request: LarkAgentSettingsRequest, origin: Awaited<ReturnType<LarkCoordinatorInbound['agentCommandOrigin']>>, notice?: string): Promise<Record<string, unknown>> {
    const { config: resolved, requested, place } = origin;
    const config = await readLarkConfig(this.state.workflowOptions.store, resolved.appId) ?? resolved;
    if (!await this.parts.core.currentAccess(config, place.chatId, place.chatType, request.actorId, 'task.view_result', request.sessionId, requested.senderOpenId)) {
      throw new RuntimeError('AGENT_COMMAND_REJECTED', '当前账号没有查看机器人设置的权限。', 403);
    }
    if (request.action === 'show') return showAgentSettings(config);
    if (!this.state.workflowOptions.saveBotConfig) throw new RuntimeError('AGENT_COMMAND_UNAVAILABLE', '当前服务不能保存机器人设置。', 503);
    const patch = await this.validateAgentSettings(request.pairs ?? []);
    const summary = `${notice ? `${notice}\n\n` : ''}\`\`\`json\n${JSON.stringify(patch, null, 2)}\n\`\`\``;
    if (request.dryRun) return { dryRun: true, needsConfirmation: true, settings: patch, confirmCard: { title: '机器人设置', body: summary } };
    const record = await this.state.workflowOptions.participation?.confirmations?.request({
      kind: agentSettingsConfirmKind(config.appId), scope: { appId: config.appId, chatId: place.chatId }, requesterId: request.actorId,
      replyTo: { messageId: requested.messageId, ...(requested.threadId ? { threadId: requested.threadId } : {}) },
      dedupeKey: `${requested.messageId}:${config.revision ?? 1}:${JSON.stringify(patch)}`, title: '机器人设置', summary,
      payload: { pairs: JSON.stringify(request.pairs), expected_revision: config.revision ?? 1, chat_type: place.chatType }
    });
    if (!record?.cardMessageId) throw new RuntimeError('AGENT_COMMAND_CARD_FAILED', '确认卡没发出去。', 502);
    return { pendingConfirmation: true, message: '已发确认卡，机器人管理员点确认后生效。' };
  }

  private async validateAgentSettings(pairs: string[]) {
    const patch = parseAgentSettings(pairs);
    const agentId = patch.defaultAgentId?.trim();
    if (agentId && !(await this.state.runtime.listAgents?.() ?? []).some(agent => agent.id === agentId)) {
      throw new AgentCommandParamError('INVALID_ARGUMENT', `没有编号为 ${agentId} 的 Agent。`, [{ name: 'defaultAgentId', reason: '用 dutydeck agent agents 查看可用编号' }]);
    }
    return patch;
  }

  private registerAgentSettingsConfirm(appId: string) {
    const configFor = (record: LarkConfirmRecord) => readLarkConfig(this.state.workflowOptions.store, record.scope.appId);
    this.state.workflowOptions.participation?.confirmations?.register(agentSettingsConfirmKind(appId), {
      authorize: async (record, operator) => {
        const config = await configFor(record);
        if (!config?.listening) return '只有机器人管理员能确认。';
        const managed = record.payload.chat_type === 'group'
          ? await this.state.groupManager?.authorize(config.appId, record.scope.chatId, operator, 'channel_bot.update') : undefined;
        return (managed ? managed.allowed : (await this.parts.core.isRepairOperatorAllowed(config, operator)).allowed)
          ? true : '只有机器人管理员能确认。';
      },
      apply: async record => {
        const patch = await this.validateAgentSettings(JSON.parse(String(record.payload.pairs)));
        if (!this.state.workflowOptions.saveBotConfig) throw new RuntimeError('AGENT_COMMAND_UNAVAILABLE', '当前服务不能保存机器人设置。', 503);
        await this.state.workflowOptions.saveBotConfig({ ...patch, stage: 'agent', originalAppId: record.scope.appId, expectedRevision: Number(record.payload.expected_revision) });
        return '机器人设置已保存。';
      }
    });
  }

  /** 代发命令的确认卡：发起人或有权限的人点「确认」，以点击人的身份执行，带出的新一轮挂在确认卡下。 */
  private registerAgentCommandConfirm(appId: string) {
    const configFor = async (record: LarkConfirmRecord) => {
      const current = await readLarkConfig(this.state.workflowOptions.store, record.scope.appId);
      if (!current?.listening) return undefined;
      return record.payload.chat_type === 'group' && this.state.groupManager ? await this.state.groupManager.resolved(current, record.scope.chatId) : current;
    };
    this.state.workflowOptions.participation?.confirmations?.register(larkAgentCommandKind(appId), {
      authorize: async (record, operator) => {
        const config = await configFor(record);
        if (!config) return '机器人已停用，无法执行此操作';
        return operator === record.requesterId || await this.parts.core.isOperatorAllowed(config, operator, record.scope.chatId, String(record.payload.session_id), record.requesterId)
          ? true : '只有发起人或有权限的人能确认。';
      },
      apply: async (record, operator) => {
        const config = await configFor(record);
        if (!config || !record.cardMessageId) throw new RuntimeError('AGENT_COMMAND_UNAVAILABLE', '机器人已停用，没有执行。', 409);
        const command = String(record.payload.command);
        const event = this.agentCommandEvent(config, { messageId: record.cardMessageId, chatId: record.scope.chatId, chatType: String(record.payload.chat_type),
          ...(record.payload.thread_id ? { threadId: String(record.payload.thread_id) } : {}), ...(record.payload.root_id ? { rootId: String(record.payload.root_id) } : {}) }, operator, command, JSON.parse(String(record.payload.mentions ?? '[]')));
        const parsed = parseSlashCommand(command);
        if (parsed?.name === 'resume' || parsed?.name === 'fork') {
          const scopeId = String(record.payload.scope_id);
          const group = this.state.groups.get(larkGroupKey(event, scopeId, config.appId)) ?? { tail: Promise.resolve() };
          const bound = group.sessionId && !group.retiredSessionIds?.has(group.sessionId) ? group.sessionId : (await this.findScopeSession(config, event, scopeId, group))?.id;
          if (bound !== String(record.payload.session_id)) throw new RuntimeError('AGENT_COMMAND_STALE', '这个话题的会话已经切换，请重新发起恢复或分身请求。', 409);
          if (parsed.name === 'fork' && operator !== record.requesterId) throw new RuntimeError('AGENT_COMMAND_FORBIDDEN', '分身需要原请求人自己确认。', 403);
        }
        // 先落库再回卡片：执行中进程退出的话，重启后在这张卡下回执无法确认是否完成。
        const started = await this.parts.core.inbox.startCommand(config.appId, event);
        if (!started) throw new RuntimeError('AGENT_COMMAND_UNAVAILABLE', '这条命令已经执行过或无法登记，没有再执行。', 409);
        // 卡片回调要在 3 秒内返回：命令放到后台执行，结果和失败由命令自己的回执写在这张卡下面。
        void this.runAgentCommand(event, config, command, String(record.payload.scope_id), started).catch(async error => {
          this.state.log.error({ error, messageId: event.messageId }, '执行代办命令失败');
          await this.parts.core.inbox.update(started, { state: 'failed', error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
        });
        return `已确认执行 ${larkCommandEcho(command, 120)}，结果会发在这张卡下面。`;
      }
    });
  }

  /** 代发命令的合成消息：带 @机器人，和用户在这里 @我 发这条命令一样；不带引用，免得被当成在回复哪张卡。 */
  private agentCommandEvent(config: StoredLarkConfig, place: { messageId: string; chatId: string; chatType: string; threadId?: string; rootId?: string },
    sender: string, command: string, mentions: LarkMessageEvent['mentions']): LarkMessageEvent {
    return { ...place, createTime: String(Date.now()), messageType: 'text', content: JSON.stringify({ text: `@_user_1 ${command}` }), senderOpenId: sender, senderType: 'user',
      mentions: [{ key: '@_user_1', name: config.name?.trim() || 'Dutydeck', ...(this.state.botOpenId ? { openId: this.state.botOpenId } : {}), mentionedType: 'bot' },
        ...mentions.map((mention, index) => ({ ...mention, key: `@_user_${index + 2}` }))] };
  }

  /**
   * 以 event 发送人的身份、在 scopeId 这个会话里执行一条命令，和他在那里自己发一样；命令带出的新一轮挂在 event 这条消息下。
   * started 是确认后落库的执行中记录：命令自己回执后记为完成，带出新一轮时改成待处理的请求交给 handle。
   */
  private async runAgentCommand(event: LarkMessageEvent, config: StoredLarkConfig, command: string, scopeId: string, started?: LarkInboxRecord, receipts?: LarkCommandReceipts) {
    let route: 'handled' | string | LarkCommandPrompt | undefined = 'handled';
    if (!await this.routeWorkflow(event, config, command, { id: scopeId }, receipts)) {
      const groupKey = larkGroupKey(event, scopeId, config.appId);
      const group = this.state.groups.get(groupKey) ?? { tail: Promise.resolve() };
      this.state.groups.set(groupKey, group);
      if (!group.sessionId) {
        const continued = await this.threadContinuation(event, config, scopeId);
        if (continued && !group.retiredSessionIds?.has(continued.id)) { group.sessionId = continued.id; group.sessionConfigKey = larkSessionConfigKey(config); }
      }
      route = await this.routeChatCommand(event, config, command, group, scopeId, undefined, receipts);
    }
    // 只取回执的查看命令不带出新一轮。
    if (route === 'handled' || route === undefined || receipts?.capture) {
      if (started) await this.parts.core.inbox.update(started, { state: 'accepted' });
      return;
    }
    // /new 带任务、/retry、/plan：按这条消息登记成一条请求交给 handle，授权、排队和卡片照常；进程退出的话重启后接着执行。
    const next = typeof route === 'string' ? { prompt: route } : route;
    const request = { prompt: next.prompt, scopeId, resources: [],
      ...(next.materialPrompt ? { materialPrompt: next.materialPrompt } : {}), ...(next.launchOptions ? { launchOptions: next.launchOptions } : {}) };
    if (started) {
      await this.parts.core.inbox.update(started, { state: 'received', request });
      if (!await this.parts.core.inbox.release(started)) return;
    } else if (!await this.parts.core.inbox.seed(config.appId, event, request)) return;
    await this.handle(event, config);
  }

  private buttonDependencies(): ButtonServices {
    const state = this.state;
    return {
      capabilitiesForTask: this.parts.cards.capabilitiesForTask.bind(this.parts.cards),
      continueInPlaceAction: this.continueInPlaceAction.bind(this),
      currentTurnInterruptDenial: this.currentTurnInterruptDenial.bind(this),
      handleDetailLogin: this.handleDetailLogin.bind(this),
      inbox: this.parts.core.inbox,
      interruptedTurnAction: this.interruptedTurnAction.bind(this),
      isDeferredTask: this.parts.core.isDeferredTask.bind(this.parts.core),
      pushTaskError: this.parts.core.pushTaskError.bind(this.parts.core),
      queuedSteerCapabilities: this.queuedSteerCapabilities.bind(this),
      refreshResultVerification: this.parts.cards.refreshResultVerification.bind(this.parts.cards),
      relaunchCardAction: this.relaunchCardAction.bind(this),
      retryInFlight: this.retryInFlight,
      runTurn: this.runTurn.bind(this),
      scheduleResultDaily: this.parts.cards.scheduleResultDaily.bind(this.parts.cards),
      steerQueuedTurn: this.steerQueuedTurn.bind(this),
      submitResultFollowUp: this.parts.cards.submitResultFollowUp.bind(this.parts.cards),
      unknownTaskAction: this.unknownTaskAction.bind(this),
      verificationView: this.parts.cards.verificationView.bind(this.parts.cards),
      verifyInFlight: this.state.verifyInFlight,
      cardMappings: this.state.cardMappings,
      commandAllowlisted: this.commandAllowlisted.bind(this),
      currentAccess: this.parts.core.currentAccess.bind(this.parts.core),
      executeRepairFlight: this.executeRepairFlight.bind(this),
      groupManager: this.state.groupManager,
      handleAction: this.handleAction.bind(this),
      isOperatorAllowed: this.parts.core.isOperatorAllowed.bind(this.parts.core),
      isRepairOperatorAllowed: this.parts.core.isRepairOperatorAllowed.bind(this.parts.core),
      larkRouteCapabilities: this.larkRouteCapabilities.bind(this),
      log: this.state.log,
      memory: this.parts.core.memory,
      get reconcileConfig() { return state.reconcileConfig; },
      refreshResultFeedback: this.parts.cards.refreshResultFeedback.bind(this.parts.cards),
      refreshResultMemory: this.parts.cards.refreshResultMemory.bind(this.parts.cards),
      repairInFlight: this.state.repairInFlight,
      respondFromQueuedCard: this.respondFromQueuedCard.bind(this),
      runtime: this.state.runtime,
      service: this.state.service,
      taskDashboard: this.taskDashboard.bind(this),
      tasks: this.state.tasks,
      automation: this.state.workflowOptions.automation,
      participation: this.state.workflowOptions.participation,
      store: this.state.workflowOptions.store,
      workbench: this.state.workflowOptions.workbench,
      workflows: this.parts.core.workflows,
    };
  }

  handleAction(value: unknown, operatorOpenId?: string, context?: ButtonSource): Promise<ButtonResult> {
    try {
      const workflow = value as Record<string, unknown> | null;
      if (workflow && typeof workflow === 'object') {
        const callback = resolveCallback(workflow);
        if (callback) {
          const [key, , handle] = callback;
          return handle(this.buttonDependencies(), { key, workflow, operatorOpenId, context });
        }
      }
      return this.handleTaskButton(value, operatorOpenId, context);
    } catch (error) { return Promise.reject(error); }
  }

  private async handleTaskButton(value: unknown, operatorOpenId?: string, context?: ButtonSource): Promise<ButtonResult> {
    // 解析交给 card-actions.ts 的共享解析器：渲染端与回调端共用一套形状校验，
    // 不存在「一端认、另一端不认」的权限缝隙。同时兼容线上遗留的 {action, task_id}。
    const parsed = parseLarkCardActionValue(value);
    if (!parsed) return { type: 'error', content: '无法识别卡片操作' };
    const { action, taskId } = parsed;
    const deps = this.buttonDependencies();
    if (Object.hasOwn(storedButtons, action)) {
      return storedButtons[action as keyof typeof storedButtons](deps, parsed, operatorOpenId, context);
    }
    const task = this.state.tasks.get(taskId) ?? (action === 'cancel'
      ? await this.restoreQueuedCardAction(taskId, parsed.turn, context)
      : action === 'verify' || action === 'use_verification_command' ? await this.restoreVerifyCardAction(taskId, parsed.turn, context) : undefined);
    if (!task && action === 'retry' && this.state.reconcileConfig) {
      const mapping = await this.state.cardMappings.get(larkCardChannel(this.state.reconcileConfig.appId), taskId);
      const saved = mapping && parseOptionalCardTask(mapping.extra);
      if (mapping && saved?.runtime_task_id && await this.parts.core.isDeferredTask(mapping.sessionId, saved.runtime_task_id)) return { type: 'warning', content: '确认已登记，请使用原确认卡。' };
    }
    // 结果卡活过服务重启，「重试」回调却只在内存里找任务；/retry 和「重来」从持久化记录恢复原请求，重启后照样可用。
    if (!task) return { type: 'warning', content: action === 'retry' ? '这张卡上的「重试」已失效，请在原话题里说「重来」或发送 /retry 重新执行' : '此卡当前不可操作，请回原话题发送 /status 或 /cancel 查看和处理任务' };

    /**
     * 这次点击属于哪一轮。
     *
     * 卡片按钮带 turn；遗留卡片没有，按当前轮处理（旧行为）。之后的每个 await 都要重判：
     * 取消/中断是 detached 的，await runtime.interrupt / cancelQueued 期间用户可能已经
     * /retry 开了新一轮——那时 task 上的 state、events、requestUpdate 都属于新一轮，
     * 旧点击的续跑再写就会把新一轮打回 interrupted、或把旧错误推进新卡。
     */
    const actionTurn = parsed.turn ?? task.turn ?? 0;
    const actionStale = () => (task.turn ?? 0) !== actionTurn;
    if (actionStale()) return { type: 'warning', content: '任务已开始新一轮，请在最新的卡片上操作' };

    // 中断按钮单独校验发起人/管理员；其他操作沿用机器人访问权限。
    const currentConfig = await readLarkConfig(this.state.workflowOptions.store, task.config.appId);
    if (!currentConfig || !currentConfig.listening) return { type: 'warning', content: '机器人已停用，无法执行此操作' };
    const effectiveConfig = task.event.chatType === 'group' && this.state.groupManager ? await this.state.groupManager.resolved(currentConfig, task.event.chatId) : currentConfig;
    const allowed = action === 'interrupt'
      ? await this.parts.core.isInterruptOperatorAllowed(effectiveConfig, operatorOpenId, task.event.chatId, task.sessionId, task.event.senderOpenId)
      : await this.parts.core.isOperatorAllowed(effectiveConfig, operatorOpenId, task.event.chatId, task.sessionId, task.event.senderOpenId);
    // 拒绝说明写真实原因：点的是别人的任务时是「只有发起人和管理员能操作」，只有白名单挡住时才说白名单。
    if (!allowed) {
      return { type: 'warning', content: action === 'interrupt'
        ? this.parts.core.requesterOnlyReason(effectiveConfig, task.event.senderOpenId, '中断正在执行的这一轮', true)
        : operatorOpenId && operatorOpenId !== task.event.senderOpenId
          && (effectiveConfig.managedGroup || await this.parts.core.isStaticOperatorAllowed(effectiveConfig, operatorOpenId, task.event.chatId))
          ? this.parts.core.requesterOnlyReason(effectiveConfig, task.event.senderOpenId, '操作这条任务')
          : '当前账号不在机器人白名单中，无法执行此操作' };
    }
    // 鉴权本身是异步的，期间同样可能翻页。
    if (actionStale()) return { type: 'warning', content: '任务已开始新一轮，请在最新的卡片上操作' };

    // 旧版排队卡片会发 interrupt，仍按安全的单轮次取消处理，不中断当前运行任务。
    // P0-1：有权限取消/中断/重试他人发起的任务时，要求二次点击确认。
    // 键绑定 操作人+任务+轮次+动作，60 秒内同一按钮第二次点击才真正执行，过期需重新确认。
    if (operatorOpenId && task.event.senderOpenId && operatorOpenId !== task.event.senderOpenId
      && (action === 'cancel' || action === 'interrupt' || action === 'retry')) {
      if (!this.parts.core.foreignActionConfirmed(operatorOpenId, task.event.senderOpenId, `${taskId}|${actionTurn}|${action}`)) {
        return { type: 'warning', content: '该任务由他人发起，再次点击同一按钮以确认操作' };
      }
    }
    const button = action === 'interrupt' && task.state === 'queued' ? 'cancel' : action;
    if (Object.hasOwn(taskButtons, button)) {
      return taskButtons[button as keyof typeof taskButtons](deps, { task, taskId, action, actionTurn, actionStale, currentConfig, effectiveConfig, operatorOpenId });
    }
    return { type: 'error', content: '不支持的卡片操作' };
  }
}
