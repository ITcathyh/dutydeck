import { completeExplicitFinal, explicitFinalContext, hasExplicitFinal, withExplicitFinalLock } from './explicit-final.js';
import type { LarkGroupParticipation } from './group-participation.js';
import { createHash } from 'node:crypto';
import { describeLarkTaskRecovery, notifyLarkTaskRecovery, verifiedLarkRecoveryOutput } from './task-recovery.js';
import type { RelayAskBroker } from '@dutydeck/relay';
import { LarkWorkflowInteractions, type LarkInteraction, type LarkInteractionContext } from './workflow-interactions.js';
import { LarkTaskInbox, type LarkInboxRecord } from './task-inbox.js';
import { parseLarkNewSession, validateLarkLaunchOptions, type LarkLaunchOptions } from './new-session.js';
import { collectLarkTaskContext } from './task-context.js';
import { withLarkContextReadTimeout } from './context-read-timeout.js';
import { buildLarkTaskDashboard, type LarkTaskDashboardEntry } from './task-dashboard.js';
import { isLarkMemoryId, LarkMemoryStore, renderLarkMemoryList } from './memory.js';
import { LarkMemoryProjection, renderLarkMemoryInjection, renderMemoryIndex } from './memory-view.js';
import type { LarkMemoryPipeline } from './memory-pipeline.js';
import type { LarkGroupManager } from './group-management.js';
import type { AgentEvent, ChannelMapping, ChannelMappingRepository, ConfigRepository, PolicyAction, PolicyDecision, PublicSessionSchedule, Session, TaskRecord, ToolRiskPolicy, VerificationResponse } from '@dutydeck/shared';
import { RuntimeError } from '@dutydeck/shared';
import { executeScheduleCommand } from './schedule-command.js';
import { defaultHighRiskPattern, defaultLarkTraceLimit, larkExecutionIdentity, larkPermissionMode, readLarkConfig, type StoredLarkConfig } from './config.js';
import type { LarkMessageResource } from './message-content.js';
import { boundLarkCardElements, larkIdentityPermissionHelp, LarkServiceError, type LarkCardService } from './service.js';
import {
  loadLarkTaskEvents,
  hasUnresolvedToolCalls,
  isLarkCardContentRejected,
  isLarkMessageRateLimit,
  isLarkMessageUnupdatable,
  larkRateLimitBackoffMs,
  patchRejectedCardDelta,
  renderLarkProcessElements,
  renderLarkResultElements,
  renderLarkRecordExport,
  renderLarkVerificationElement,
  LARK_VERIFICATION_ELEMENT_ID,
  type LarkCardElement
} from './card-renderer.js';
import { deliverLarkCompletionReaction, larkResultKey, larkSilentResultAnchor, sendLarkResult, sendLarkFile } from './result-delivery.js';
import { performLarkCardReconcile } from './reconciler.js';
import { isLarkCardActionAvailable, isLarkCardFollowUpPrompt, larkCardActionLabel, larkCardFollowUpPrompt, parseLarkCardActionValue, type LarkCardActionState, type LarkCardActionValue, type LarkCardCapabilities } from './card-actions.js';
import {
  larkCommandCapabilities,
  larkCommandEcho,
  larkHelpCardTitle,
  parseLarkHelpPageValue,
  parseSlashCommand,
  resolveLarkCommand,
  renderLarkCommandHelp,
  routeLarkCommand,
  type LarkCommandRoute
} from './commands.js';
import { escapeLarkPromptEcho, renderQueueSummary, renderQueueSummaryElement, QUEUE_SUMMARY_ELEMENT_ID, QUEUE_SUMMARY_MAX_ITEMS } from './queue-summary.js';
import { isFileResultDelivery, reactionDedupeKey, reactionEmojiForAcceptance, type ReactionRecord } from './reaction-records.js';
import { replayedRecoveryNote } from './recovery-notes.js';
import { protocolModeNote } from './protocol-hints.js';
import { isBotSenderType, isGroupChat, senderGroupMention } from './card-mentions.js';
import { appendLarkTaskSteps, claimLarkTaskDispatches, larkTaskAgentGuid, releaseLarkTaskClaim } from './task-agent.js';
import { LarkPinManager } from './pin-manager.js';
import { buildRepairConfirmCard, parseRepairCardActionValue, renderRepairResultCard, runOpenPlatformRepair } from './repair.js';
import { connectLarkOpenPlatformSession } from './open-platform-session.js';
import {
  findPersistedLarkSession,
  larkGroupKey,
  larkReplyContext,
  larkSessionConfigKey,
  listPersistedLarkSessions,
  materializeLarkResources,
  parsePrompt,
  resolveLarkScopeId,
  resolveLarkSession,
  type LarkChatModeResolver
} from './session-resolver.js';
import type { ListenerLog, LarkMessageEvent, LarkRuntime } from './listener.js';

// 飞书消息协调器（从 listener.ts 拆分）：按群/话题串行化任务轮次、驱动 Agent 会话、
// 渲染并更新服务卡片。卡片终态对账见 reconciler.ts，会话路由见 session-resolver.ts。

export type LarkGroup = {
  sessionId?: string;
  sessionConfigKey?: string;
  /** Newly created replacement for a maintenance-retired legacy context. */
  legacyUpgradeSessionId?: string;
  tail: Promise<void>;
  /**
   * 被 /new 结束的会话 id。runtime.stop 落库前会话状态仍是 idle，此刻并发到达的消息
   * 会在 listSessions 里重新命中它——记下来才能保证「/new 回执之后不再复用旧上下文」。
   */
  retiredSessionIds?: Set<string>;
  /**
   * 上下文代数，每次 /new 递增。任务在入队时记下当时的代数，runTurn 里对不上就说明
   * 这一轮已经被 /new 作废：附件下载、身份解析、runtime.start 都可能让一条旧消息在
   * /new 之后才走到派发那一步，没有这个标记它就会把旧 prompt 发进已经宣布结束的上下文。
   */
  epoch?: number;
  /**
   * 正在进行的 sessionFor。/new 必须等它（建会话是短操作），才能连同这条刚建出来的
   * 会话一起停掉；但绝不能等 group.tail —— fallback 路径的 tail 要等整轮 send 结束，
   * 把它当锁会让 /new 在长任务期间永远停不下来。
   */
  pendingSession?: Promise<Session | undefined>;
};
type LarkCommandPrompt = { prompt: string; suggestion?: string; materialPrompt?: string; launchOptions?: LarkLaunchOptions; epoch?: number; steer?: boolean };
export type LarkTaskState = 'queued' | 'running' | 'interrupting' | 'interrupted' | 'completed' | 'failed' | 'cancelled' | 'reconcile_required' | 'legacy_unresolved';
export type LarkTask = {
  id: string;
  group: LarkGroup;
  event: LarkMessageEvent;
  prompt: string;
  resources: LarkMessageResource[];
  inbox?: LarkInboxRecord;
  resumeTask?: TaskRecord;
  retryMaterialPrompt?: string;
  launchOptions?: LarkLaunchOptions;
  restoring?: boolean;
  config: StoredLarkConfig;
  state: LarkTaskState;
  events: AgentEvent[];
  lastSuccessfulElements?: LarkCardElement[];
  sessionId?: string;
  cardMessageId?: string;
  runtimeTaskId?: string;
  startedAt?: number;
  acknowledgementReactionId?: string;
  /** Immutable terminal notification for the current turn. */
  finalMessageId?: string;
  /**
   * 本轮终态是怎么交付的：'delivered' = 发了结果卡；'reaction' = 只贴了完成表情
   * （completionReactionOnly，成功终态专用，此时没有 finalMessageId）。
   */
  finalDeliveryState?: 'delivered' | 'reaction';
  finalAttachmentMessageId?: string;
  finalDeliveredTurn?: number;
  finalElements?: LarkCardElement[];
  /** 结果卡的整卡入参（不含 elements / 幂等键），供「运行验证」完成后原样重绘同一张卡。 */
  finalCardInput?: Record<string, unknown>;
  progressFrozen?: boolean;
  interruptRequested?: boolean;
  requestUpdate?: (state: Exclude<LarkTaskState, 'interrupting'>, completed?: boolean) => Promise<void>;
  retryable?: boolean;
  /** 递增的轮次编号，用于防止上一轮的终态回调覆盖重试后的新状态。 */
  turn: number;
  /** 本条消息解析出的会话隔离 scope（与 group key 一致），sessionFor 复用。 */
  scopeId: string;
  /** 入队时所属的上下文代数；与 group.epoch 不符说明本轮已被 /new 作废。 */
  epoch: number;
  /** S3：未知命令近似匹配提示，只渲染在卡片上，绝不进入 agent prompt。 */
  commandSuggestion?: string;
  /** S8：恢复轮次已渲染过 daemon 重启注记，避免同一轮次重复落注记。 */
  replayedNote?: boolean;
  /** /steer：这一轮派发后要立刻提到队首（运行时没有「注入当前轮」的原语，只能降级到队首）。 */
  steer?: boolean;
  /** /steer 的降级结果说明，派发后按真实发生的事写进卡面，绝不预告未发生的成功。 */
  steerNote?: string;
};
export type PersistedLarkCardTask = {
  result_feedback_state?: string;
  retry_material_prompt?: string;
  sender_open_id?: string;
  /** 发送方类型（user / app / bot）。重启后的回执卡靠它决定要不要 @ 回发起人。 */
  sender_type?: string;
  thread_id?: string;
  scope_id?: string;
  app_id: string;
  chat_id: string;
  reply_message_id?: string;
  reply_in_thread?: boolean;
  /** @deprecated 兼容旧记录；历史版本可能错误地写入 omt_* thread_id。 */
  root_message_id?: string;
  /** 静默进展下本轮不发过程卡，这里就没有值；除此之外恒有值。 */
  card_message_id?: string;
  runtime_task_id?: string;
  task_name: string;
  prompt: string;
  state: LarkTaskState;
  started_at: number;
  last_successful_elements?: LarkCardElement[];
  /** Daemon recovery already removed stale in-memory card actions. */
  recovery_read_only?: boolean;
  recovery_status_key?: string;
  chat_type?: LarkMessageEvent['chatType'];
  final_message_id?: string;
  final_attachment_message_id?: string;
  /** 'reaction' = 只贴了完成表情、没有结果卡消息，对账据此判定「已交付」。 */
  final_delivery_state?: 'delivered' | 'reaction';
  final_elements?: LarkCardElement[];
  /** 结果卡整卡入参，供重启后的「运行验证」原样重绘同一张收据。 */
  final_card_input?: Record<string, unknown>;
  progress_frozen?: boolean;
  turn?: number;
};

const larkCardChannel = (appId: string) => `lark-card:${appId}`;
/** 去掉开头对本机器人的 @（可能连着好几个）。卡片标题与重复请求判定共用。 */
const withoutLeadingBotMention = (prompt: string, botName?: string) => {
  const mention = botName?.trim() ? `@${botName.trim()}` : '';
  let text = prompt.trim();
  // 名字后面必须是空白或结尾：@bdev-flashy 不是在 @ bdev-flash。
  while (mention && text.startsWith(mention) && !/^\S/.test(text.slice(mention.length))) text = text.slice(mention.length).trimStart();
  return text;
};
/**
 * 卡片标题：去掉开头对本机器人的 @。卡片回复在原消息下面，标题第一眼读到机器人自己的名字
 * 是噪声；@ 别的机器人是原话的一部分，保留。
 */
export const larkTaskTitle = (prompt: string, botName?: string) => (withoutLeadingBotMention(prompt, botName) || prompt.trim()).slice(0, 80);
/** 重复请求判定用的请求原文：去掉开头的 @机器人，合并空白。 */
const larkRequestText = (prompt: string, botName?: string) => withoutLeadingBotMention(prompt, botName).replace(/\s+/g, ' ');
/** 同一发起人在同一个聊天里多久之内发过同一句话，才算重复请求。 */
const repeatedRequestWindowMs = 14 * 24 * 60 * 60 * 1000;
/** 北京时间的 HH:MM，秒数直接舍去。 */
const shanghaiClock = (at: number) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
/**
 * 续聊规则与在原位置发言一致：按发送人隔离的会话（user:）只有发起人本人发言才会回到它；
 * 话题、整群与私聊会话由在原位置发言的人共用。message: 是缺身份时的一次性会话，谁也续不上。
 */
const larkScopeContinuesFor = (scopeId: string, operatorOpenId: string) =>
  scopeId.startsWith('user:') ? scopeId === `user:${operatorOpenId}` : !scopeId.startsWith('message:');
const resultActionDigest = (...parts: Array<string | number>) => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
/** 续问按钮的去重键：同一张结果卡（任务 + 轮次）上的同一个按钮只提交一轮，落库后重启仍成立。 */
const followUpClaimKey = (appId: string, digest: string) => `lark.result_follow_up.${appId}.${digest}`;
/** 「每天自动执行」的登记：同一张结果卡只建一个计划，渲染端也靠它把按钮画成「已设为…」。 */
const dailyScheduleKey = (appId: string, digest: string) => `lark.result_schedule.${appId}.${digest}`;
type LarkDailyScheduleRecord = { state: 'creating' | 'created'; operator_open_id: string; time: string; schedule_id?: string };
/** 结果卡续问行回调的服务端目标：全部取自持久化映射，卡片上只信 task_id 与 turn 用来定位。 */
type LarkResultActionTarget = {
  current: StoredLarkConfig; config: StoredLarkConfig; mapping: ChannelMapping; saved: PersistedLarkCardTask;
  task: LarkTask; operator: string; scopeId: string; resultMessageId: string;
};

/**
 * /status 的执行身份说明。机器人干活用的是**部署这台机器的人**的身份：worktree 只隔离
 * 可写目录，不隔离宿主凭据、文件系统与网络（README「远程浏览器访问」一节同一口径）。
 * 别人在群里使唤它，实际就是拿部署者的权限在跑，这件事必须写在状态里，而不是靠人推断。
 */
/** 生效的群访问口径的人话说明，/grant、/revoke 的回执用它写清「改之前/改之后谁能用」。 */
const describeLarkAccess = (mode: 'owner_only' | 'allowlist' | 'all_chat_members' | 'disabled') =>
  ({ owner_only: '仅机器人管理员可用', allowlist: '仅名单内成员可用', all_chat_members: '全部群成员可用', disabled: '本群已停用' })[mode];

const larkExecutionIdentityLine = () =>
  `**执行身份**：\`${larkCommandEcho(larkExecutionIdentity(), 128)}\`（部署这台 Dutydeck 的系统账号）。任务以它运行，能用到它的文件、凭据与网络；独立工作目录只隔离可写目录，不隔离这些。`;

// 群消息统一回复触发消息；话题消息显式 reply_in_thread，避免卡片脱离提问人的话题。
async function sendTaskCard(
  service: Pick<LarkCardService, 'send' | 'reply'>,
  event: LarkMessageEvent,
  input: Omit<Parameters<LarkCardService['send']>[0], 'chatId'>,
  log?: { warn: (...args: any[]) => void }
) {
  const executionInput = { permissionMode: 'full-trust' as const, ...input };
  if (event.chatType === 'group' && typeof service.reply === 'function') {
    try {
      return await service.reply({ ...larkReplyContext(event), ...executionInput });
    } catch (error) {
      // 回复触发消息失败（例如消息已被删除）时，回退为群内发送，保证卡片仍能送达。
      log?.warn({ error, messageId: event.messageId, chatId: event.chatId }, '回复卡片失败，回退为群内发送');
      return await service.send({ chatId: event.chatId, ...executionInput });
    }
  }
  return await service.send({ chatId: event.chatId, ...executionInput });
}

export class LarkMessageCoordinator {
  private readonly groups = new Map<string, LarkGroup>();
  private readonly tasks = new Map<string, LarkTask>();
  private readonly handledMessages = new Set<string>();
  private reconcileTimer?: NodeJS.Timeout;
  private reconcileRun?: Promise<number>;
  private reconcileConfig?: StoredLarkConfig;
  private reconcileIntervalMs = 5_000;
  private stopped = false;
  private readonly turnCleanups = new Set<() => void>();
  /** P0-1：他人任务取消/中断/重试的二次确认键 → 过期时间戳（60s），惰性清理。 */
  private readonly foreignActionConfirmations = new Map<string, number>();
  private readonly workflows?: LarkWorkflowInteractions;
  private readonly inbox?: LarkTaskInbox;
  /** 长任务进度卡置顶。默认关闭（见 config.pinLongTasks），但对账在关闭后仍要能撤掉僵尸置顶。 */
  private readonly pins?: LarkPinManager;
  private taskAgentTimer?: NodeJS.Timeout;
  private taskAgentRun?: Promise<number>;
  /** 已写回飞书任务记录的 `${guid}:${turn}:${state}`，避免同一状态被心跳重复写。 */
  private readonly writtenTaskSteps = new Set<string>();
  /** 会话记忆：与 inbox / workflows 共用 workflowStore，缺存储时三条记忆命令收敛为 unavailable，也不注入。 */
  private readonly memory?: LarkMemoryStore;

  constructor(
    private readonly runtime: LarkRuntime,
    private readonly service: LarkCardService,
    private readonly log: ListenerLog,
    private readonly _random: () => number = Math.random,
    private readonly botOpenId?: string,
    private readonly peerBotAuthorized?: (chatId: string, senderOpenId: string) => Promise<boolean>,
    private readonly cardMappings?: ChannelMappingRepository,
    private readonly chatModeResolver?: LarkChatModeResolver,
    private readonly executionPolicy?: {
      integrationMode: 'legacy_unmanaged';
      authorize(boundary: 'listener' | 'session' | 'high_risk', action: PolicyAction): Promise<PolicyDecision>;
    },
    private readonly groupManager?: LarkGroupManager,
    private readonly workflowOptions: {
      participation?: LarkGroupParticipation;
      store?: ConfigRepository;
      broker?: RelayAskBroker;
      automation?: import('../session-automation.js').SessionAutomationService;
      workbench?: import('./workbench.js').LarkWorkbench;
      memory?: {
        store: LarkMemoryStore;
        projection: LarkMemoryProjection;
        command?: string;
        pipeline?: LarkMemoryPipeline;
      };
    } = {},
  ) {
    this.memory = workflowOptions.memory?.store;
    if (workflowOptions.store) {
      this.inbox = new LarkTaskInbox(workflowOptions.store);
      this.workflows = new LarkWorkflowInteractions(workflowOptions.store, runtime, service, workflowOptions.broker,
        (record, actor, action) => this.authorizeInteraction(record, actor, action));
      // 置顶记录必须持久化：进程崩在长任务中间时，只有账本能让重启后的对账认出僵尸置顶。
      this.pins = new LarkPinManager(service, { store: workflowOptions.store, log: this.log });
    }
  }

  /**
   * 加急与置顶的开关都在 Bot 配置里，而构造协调器时还读不到配置，
   * 所以在每次拿到配置的入口（初始化与对账启动）按当前配置重新落一次。
   * 两项默认关闭：加急是收件人手机上的强提醒横幅，置顶会改写群成员的会话列表，
   * 升级本身不能替用户打开任何一个。
   */
  private applyReminderSettings(config: StoredLarkConfig) {
    this.workflows?.configureUrgent(config.urgentEnabled === true
      ? {
        enabled: true,
        ...(config.urgentThresholdMs !== undefined ? { thresholdMs: config.urgentThresholdMs } : {}),
        ...(config.urgentMaxPerHourPerChat !== undefined ? { maxPerHourPerChat: config.urgentMaxPerHourPerChat } : {})
      }
      : false);
  }

  async initializeWorkflows(config: StoredLarkConfig) {
    this.reconcileConfig = config;
    this.applyReminderSettings(config);
    await this.workflows?.initialize(config.appId);
    for (const record of await this.inbox?.orphanedCommands(config.appId) ?? []) {
      await this.inbox!.update(record, { state: 'failed', error: '重启后无法确认命令是否完成；如未生效，请重新发送。' });
      const actor = record.event.senderOpenId;
      if (actor && await this.currentAccess(config, record.event.chatId, record.event.chatType, actor, 'task.view_result')) {
        await this.workflowReply(record.event, config, '重启后无法确认这条命令是否完成。如结果未生效，请重新发送该命令。', { failed: true }).catch(error => this.log.warn({ error }, '命令恢复回执发送失败'));
      }
    }
    for (const record of await this.inbox?.recoverable(config.appId) ?? []) {
      // handle re-checks current configuration and membership; credentials are never replayed.
      await this.handle(record.event, config, true);
    }
    // Queued Runtime tasks can start before the Feishu listener. Reattach their
    // original cards and query live waiters as well as subscribing to future events.
    if (!this.workflows || !this.runtime.getTasks) return;
    for (const mapping of await this.cardMappings?.list(larkCardChannel(config.appId)) ?? []) {
      if (this.tasks.has(mapping.externalId)) continue;
      const saved = JSON.parse(mapping.extra ?? '{}') as PersistedLarkCardTask;
      if (!saved.runtime_task_id || !saved.scope_id || !saved.sender_open_id) continue;
      const runtimeTask = (await this.runtime.getTasks(mapping.sessionId)).find(task => task.id === saved.runtime_task_id);
      if (!runtimeTask || !['running', 'queued'].includes(runtimeTask.status)) continue;
      const raw = await this.workflowOptions.store!.get(`lark.inbox.${config.appId}.${mapping.externalId}`);
      if (!raw) continue;
      const stored = JSON.parse(raw) as LarkInboxRecord;
      if (stored.state !== 'accepted' || stored.sessionId !== mapping.sessionId || stored.event.chatId !== saved.chat_id) continue;
      const adopted = await this.inbox!.adoptAccepted(stored);
      if (!adopted) continue;
      const effective = stored.event.chatType === 'group' && this.groupManager ? await this.groupManager.resolved(config, saved.chat_id) : config;
      const key = larkGroupKey(stored.event, saved.scope_id, config.appId);
      const group = this.groups.get(key) ?? { tail: Promise.resolve() };
      this.groups.set(key, group);
      const task: LarkTask = { id: mapping.externalId, event: stored.event, config: effective, prompt: saved.prompt, resources: [],
        group, inbox: adopted, state: 'queued', events: [], turn: (saved.turn ?? 1) - 1, scopeId: saved.scope_id, epoch: group.epoch ?? 0,
        retryMaterialPrompt: saved.retry_material_prompt, sessionId: mapping.sessionId, cardMessageId: saved.card_message_id,
        runtimeTaskId: runtimeTask.id, startedAt: saved.started_at, lastSuccessfulElements: saved.last_successful_elements,
        progressFrozen: saved.progress_frozen, resumeTask: runtimeTask, restoring: true };
      this.tasks.set(task.id, task);
      this.handledMessages.add(task.id);
      group.tail = group.tail.then(() => this.runTurn(task)).catch(error => this.log.error({ error, taskId: task.id }, '恢复飞书任务交互失败'));
    }
  }

  /** 结构化问答/群 @ 等 observe 渲染开关统一取自任务配置，三处 observe 调用共用同一口径。 */
  private workflowObserveOptions(task: LarkTask) {
    return {
      structuredAskCards: task.config.structuredAskCards !== false,
      ...(task.config.webBaseUrl ? { webBaseUrl: task.config.webBaseUrl } : {}),
      groupMention: task.config.groupCardMention === true && isGroupChat(task.event.chatType) && !isBotSenderType(task.event.senderType)
    };
  }

  private async observeLiveWaiters(task: LarkTask) {
    const context = this.interactionContext(task);
    if (!context || !this.workflows) return;
    await this.workflows.reconcile(context.appId, context.taskId);
    for (const permission of await this.runtime.getPendingPermissions?.(context.sessionId) ?? []) {
      await this.workflows.observe(context, { id: permission.id, sessionId: context.sessionId, sequence: 0,
        timestamp: new Date().toISOString(), type: 'permission_request', data: permission }, this.workflowObserveOptions(task));
    }
    for (const ask of this.workflowOptions.broker?.listPending(context.sessionId) ?? []) {
      await this.workflows.observe(context, { id: ask.id, sessionId: context.sessionId, sequence: 0,
        timestamp: new Date().toISOString(), type: 'text', data: { relay: 'ask', askId: ask.id } }, this.workflowObserveOptions(task));
    }
  }

  private async currentAccess(config: StoredLarkConfig, chatId: string, chatType: string, actor: string, action: PolicyAction, sessionId?: string, requester?: string) {
    const managed = chatType === 'group' ? await this.groupManager?.authorize(config.appId, chatId, actor, action, sessionId,
      { ...(requester ? { taskRequesterOpenId: requester } : {}) }) : undefined;
    if (managed) return managed.allowed;
    if (!await this.isOperatorAllowed(config, actor)) return false;
    if (chatType === 'group') {
      let pageToken: string | undefined;
      let member = false;
      for (let page = 0; page < 20; page++) {
        const result = await this.service.listChatMembers({ chatId, pageSize: 100, ...(pageToken ? { pageToken } : {}) });
        if (result.items.some(item => item.memberId === actor)) { member = true; break; }
        if (!result.hasMore || !result.pageToken) break;
        pageToken = result.pageToken;
      }
      if (!member) return false;
    }
    if (action === 'task.view_result') return true;
    if (!requester || requester !== actor) return false;
    if (action !== 'high_risk.execute') return true;
    const users = config.highRiskAllowedUsers ?? [];
    const emails = config.highRiskAllowedEmails ?? [];
    if (users.length) return users.some(user => user.openId === actor);
    return !emails.length || (await this.service.getUserEmails(actor)).some(email => emails.includes(email));
  }

  private async authorizeInteraction(record: LarkInteraction, actor: string, action: PolicyAction) {
    const config = await readLarkConfig(this.workflowOptions.store, record.appId);
    if (!config?.listening || !record.event.senderOpenId) return false;
    const mapping = (await this.cardMappings?.list(larkCardChannel(record.appId)))?.find(item => item.externalId === record.event.messageId);
    if (!mapping || mapping.sessionId !== record.sessionId) return false;
    const saved = JSON.parse(mapping.extra ?? '{}') as PersistedLarkCardTask;
    if (saved.app_id !== record.appId || saved.chat_id !== record.event.chatId || saved.runtime_task_id !== record.taskId
      || saved.turn !== record.turn || saved.sender_open_id !== record.event.senderOpenId) return false;
    const task = (await this.runtime.getTasks?.(record.sessionId))?.find(item => item.id === record.taskId);
    if (!task || (record.kind === 'result' ? task.status !== 'completed' : task.status !== 'running')) return false;
    return this.currentAccess(config, saved.chat_id, record.event.chatType, actor, action, record.sessionId, saved.sender_open_id);
  }

  private interactionContext(task: LarkTask): LarkInteractionContext | undefined {
    return task.sessionId && task.runtimeTaskId ? { appId: task.config.appId, sessionId: task.sessionId,
      taskId: task.runtimeTaskId, turn: task.turn, event: task.event } : undefined;
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
    return sendTaskCard(this.service, event, {
      taskId: event.messageId, taskName: options.taskName ?? '任务操作',
      state: options.failed ? 'failed' : 'completed', readOnly: true,
      permissionMode: larkPermissionMode(config), markdown, ...(options.elements ? { elements: options.elements } : {}),
      idempotencyKey: `workflow_reply_${event.messageId}`.slice(0, 50) }, this.log);
  }

  private async taskDashboard(event: LarkMessageEvent, config: StoredLarkConfig, page: number) {
    if (!event.senderOpenId) throw new LarkServiceError('LARK_IDENTITY_REQUIRED', '缺少当前成员身份。', 403);
    const entries: LarkTaskDashboardEntry[] = [];
    const interactions = await this.workflows?.list(config.appId) ?? [];
    // Agent 显示名只查一次；查不到名字就退化成 agentId，绝不留空让读者猜是谁在跑。
    const agentNames = new Map((await this.runtime.listAgents?.().catch(() => []) ?? []).map(agent => [agent.id, agent.name] as const));
    for (const mapping of await this.cardMappings?.list(larkCardChannel(config.appId)) ?? []) {
      const saved = JSON.parse(mapping.extra ?? '{}') as PersistedLarkCardTask;
      if (saved.app_id !== config.appId || !saved.runtime_task_id) continue;
      if (event.chatType === 'group' ? saved.chat_id !== event.chatId : saved.sender_open_id !== event.senderOpenId) continue;
      if (saved.chat_type !== 'group' && saved.chat_id !== event.chatId) continue;
      try {
        if (!await this.currentAccess(config, saved.chat_id, saved.chat_type ?? 'group', event.senderOpenId, 'task.view_result', mapping.sessionId)) continue;
      } catch { continue; }
      const session = await this.runtime.getSession(mapping.sessionId);
      const task = (await this.runtime.getTasks?.(mapping.sessionId))?.find(task => task.id === saved.runtime_task_id);
      if (!session || !task) continue;
      const pending = interactions.find(item => item.taskId === task.id && item.state === 'pending' && item.kind !== 'result' && item.boot === this.workflows?.boot);
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
      const liveTask = this.tasks.get(mapping.externalId);
      const recovery = ['queued', 'reconcile_required', 'legacy_unresolved'].includes(task.status)
        ? await describeLarkTaskRecovery(this.runtime, mapping.sessionId, task.id, task.status) : undefined;
      entries.push({ taskId: task.id, title: saved.task_name, workspace: session.cwd, agent: agentNames.get(session.agentId) ?? session.agentId, status: pending && task.status === 'running'
        ? pending.kind === 'ask' ? 'waiting_for_answer' : 'waiting_for_permission' : task.status, updatedAt: task.updatedAt, url: url.toString(),
        ...(recovery ? { detail: recovery.markdown, blocked: recovery.blocked } : {}),
        ...(liveTask ? {
          actionTaskId: mapping.externalId,
          turn: liveTask.turn,
          ...(liveTask.retryable === false ? { retryable: false } : {})
        } : {}),
        ...(pending && pending.kind === 'permission' && task.status === 'running'
          ? { pendingApproval: { requestId: pending.id, generation: pending.boot } }
          : {}),
        ...(result && ['pending', 'accepted', 'needs_changes'].includes(result.state) ? { feedback: result.state as 'pending' | 'accepted' | 'needs_changes' } : {}) });
    }
    return buildLarkTaskDashboard(entries, page).elements;
  }

  private async routeWorkflow(event: LarkMessageEvent, config: StoredLarkConfig, prompt: string, scope: { id: string }): Promise<boolean> {
    if (!this.workflows) return false;
    const parsed = parseSlashCommand(prompt);
    const quoted = await this.workflows.quoted(config.appId, event);
    const names = ['tasks', 'answer', 'approve', 'reject'];
    if (!quoted && (!parsed || !names.includes(parsed.name))) return false;
    if (event.senderType === 'app' || event.senderType === 'bot') {
      await this.workflowReply(event, config, '任务操作需由人类成员发起。', { failed: true }); return true;
    }
    try {
      if (parsed?.name === 'tasks') {
        const card = await this.workflowReply(event, config, '', { taskName: '任务导航', elements: await this.taskDashboard(event, config, Number(parsed.args[0] ?? 1)) });
        await this.workflowOptions.store?.set(`lark.task_dashboard.${config.appId}.${card.messageId}`, JSON.stringify({
          messageId: event.messageId, chatId: event.chatId, chatType: event.chatType,
          senderOpenId: event.senderOpenId, messageType: 'text', content: '', mentions: []
        } satisfies LarkMessageEvent));
        return true;
      }
      if (quoted?.kind === 'result' && prompt.trim() === '验收通过') {
        const result = await this.workflows.respond({ appId: config.appId, chatId: event.chatId, actorId: event.senderOpenId, requestId: quoted.id, action: 'accept' });
        await this.refreshResultFeedback(config, quoted.id).catch(error => this.log.warn({ error }, '验收已记录，卡片刷新失败'));
        await this.workflowReply(event, config, result);
        return true;
      }
      if (quoted?.kind === 'result' && (!parsed || !names.includes(parsed.name))) {
        if (!event.senderOpenId || !await this.authorizeInteraction(quoted, event.senderOpenId, 'run.interrupt')) throw new LarkServiceError('LARK_INTERACTION_DENIED', '当前账号无权修改此任务。', 403);
        const mapping = (await this.cardMappings!.list(larkCardChannel(config.appId))).find(item => item.externalId === quoted.event.messageId)!;
        const saved = JSON.parse(mapping.extra!) as PersistedLarkCardTask;
        if (!saved.scope_id) throw new LarkServiceError('LARK_CONTEXT_MISSING', '原任务上下文不可恢复，请发送新的任务目标。', 409);
        if (quoted.state === 'pending') {
          await this.workflows!.respond({ appId: config.appId, chatId: event.chatId, actorId: event.senderOpenId, requestId: quoted.id, action: 'changes' });
          await this.refreshResultFeedback(config, quoted.id).catch(error => this.log.warn({ error }, '修改要求已记录，卡片刷新失败'));
        }
        // A follow-up after acceptance is a new task in the same context; the
        // accepted result remains an accurate record of the previous version.
        scope.id = saved.scope_id;
        return false;
      }
      const action = parsed && ['answer', 'approve', 'reject'].includes(parsed.name) ? parsed.name as 'answer' | 'approve' | 'reject' : 'answer';
      if (quoted && quoted.kind !== 'ask' && action === 'answer') throw new LarkServiceError('LARK_APPROVAL_EXPLICIT', '审批请使用按钮或明确的 /approve、/reject 命令。', 400);
      // 显式编号优先，其次回落到被引用的那张卡。请求编号不再印在卡片正文里
      // （审批卡下方就是按钮，编号对能点按钮的人是噪声），所以「引用那张卡 + /approve」
      // 必须能走通——否则删掉编号就等于删掉了按钮失灵时的唯一备用路径。
      const requestId = (parsed && names.includes(parsed.name) ? parsed.args[0] : undefined) ?? quoted?.id;
      if (!requestId) throw new LarkServiceError('LARK_REQUEST_REQUIRED', '请回复要处理的那张卡片，或直接用卡片上的按钮。', 400);
      const answer = parsed?.name === 'answer' ? parsed.argsText.slice(parsed.args[0]?.length ?? 0).trim() : prompt;
      const result = await this.workflows.respond({ appId: config.appId, chatId: event.chatId, actorId: event.senderOpenId, requestId, action, answer });
      await this.workflowReply(event, config, result);
    } catch (error) {
      await this.workflowReply(event, config, error instanceof Error ? error.message : String(error), { failed: true });
    }
    return true;
  }

  private async pendingAskCandidates(event: LarkMessageEvent, config: StoredLarkConfig, scopeId: string): Promise<LarkInteraction[]> {
    const candidates: LarkInteraction[] = [];
    for (const record of await this.workflows?.pendingAsks(config.appId) ?? []) {
      if (record.event.threadId && event.threadId && record.event.threadId !== event.threadId) continue;
      const originalRoot = record.event.rootId ?? (record.event.threadId ? record.event.messageId : undefined);
      const replyRoot = event.rootId ?? (event.threadId ? event.messageId : undefined);
      if (originalRoot !== replyRoot) continue;
      if (record.event.chatId === event.chatId && record.event.senderOpenId === event.senderOpenId
        && await resolveLarkScopeId(record.event, config, this.chatModeResolver) === scopeId) candidates.push(record);
    }
    return candidates;
  }

  private async continuesPendingAsk(event: LarkMessageEvent, config: StoredLarkConfig): Promise<boolean> {
    if (!this.workflows || !event.senderOpenId || event.senderType !== 'user' || !['text', 'post', 'rich_text'].includes(event.messageType)
      || event.parentId && (!event.threadId || event.parentId !== event.rootId)) return false;
    try {
      const { prompt, resources } = await parsePrompt(event, this.botOpenId);
      if (!prompt.trim() || resources.length || parseSlashCommand(prompt)) return false;
      const scopeId = await resolveLarkScopeId(event, config, this.chatModeResolver);
      return (await this.pendingAskCandidates(event, config, scopeId)).length > 0;
    } catch { return false; }
  }

  private async routePendingAsk(event: LarkMessageEvent, config: StoredLarkConfig, prompt: string, resources: LarkMessageResource[], scopeId: string, inbox: LarkInboxRecord | undefined, recovering: boolean): Promise<boolean> {
    if (!this.workflows || !event.senderOpenId || event.senderType !== 'user' || !['text', 'post', 'rich_text'].includes(event.messageType)
      || !prompt.trim() || resources.length || parseSlashCommand(prompt)
      // Ordinary topic replies point at the topic root. A different parent
      // is an explicit quote and must retain its existing routing semantics.
      || event.parentId && (!event.threadId || event.parentId !== event.rootId)) return false;
    let requestId = inbox?.workflowRequestId;
    if (!requestId) {
      // Recovery must not reinterpret an old message as a reply to a new ask.
      if (recovering) return false;
      const candidates = await this.pendingAskCandidates(event, config, scopeId);
      if (!candidates.length) return false;
      if (candidates.length > 1) {
        if (inbox) await this.inbox!.update(inbox, { state: 'command' });
        await this.workflowReply(event, config, '当前有多个问题等待回答，请引用要回答的提问卡片回复。');
        return true;
      }
      requestId = candidates[0]!.id;
      // Pin the waiter before answering: if acknowledgement fails or the
      // daemon restarts, this message can never answer a later question.
      if (inbox) await this.inbox!.update(inbox, { workflowRequestId: requestId });
    }
    try {
      const result = await this.workflows.respond({ appId: config.appId, chatId: event.chatId, actorId: event.senderOpenId, requestId, action: 'answer', answer: prompt });
      await this.workflowReply(event, config, result);
    } catch (error) {
      await this.workflowReply(event, config, error instanceof Error ? error.message : String(error), { failed: true });
    }
    return true;
  }

  private async requireExecution(boundary: 'listener' | 'session' | 'high_risk', action: PolicyAction) {
    if (!this.executionPolicy) return;
    const decision = await this.executionPolicy.authorize(boundary, action);
    if (!decision.allowed) {
      throw new LarkServiceError('LARK_EXECUTION_POLICY_DENIED', decision.reason, 403, {
        policyCode: decision.code,
        boundary,
        integrationMode: this.executionPolicy.integrationMode,
      });
    }
  }

  private async saveCardTask(task: LarkTask, state = task.state) {
    await this.persistCardTask(task, state);
    // 任务通道派来的任务：同一处状态汇聚点顺带把进度写成飞书任务记录。
    await this.writeLarkTaskStep(task, state);
  }

  private async persistCardTask(task: LarkTask, state: LarkTaskState) {
    // 静默进展下没有过程卡，映射仍然要落库：没有它，重启后这条任务就彻底失联。
    if (!this.cardMappings || !task.sessionId || !task.startedAt) return;
    const extra: PersistedLarkCardTask = {
      app_id: task.config.appId,
      sender_open_id: task.event.senderOpenId,
      ...(task.event.senderType ? { sender_type: task.event.senderType } : {}),
      thread_id: task.event.threadId,
      scope_id: task.scopeId,
      chat_id: task.event.chatId,
      ...(task.cardMessageId ? { card_message_id: task.cardMessageId } : {}),
      ...(task.runtimeTaskId ? { runtime_task_id: task.runtimeTaskId } : {}),
      task_name: larkTaskTitle(task.prompt, task.config.name),
      prompt: task.prompt,
      ...(task.retryMaterialPrompt ? { retry_material_prompt: task.retryMaterialPrompt } : {}),
      state,
      chat_type: task.event.chatType,
      turn: task.turn,
      ...(task.finalMessageId
        ? { final_message_id: task.finalMessageId, final_delivery_state: 'delivered' as const }
        : task.finalDeliveryState === 'reaction' ? { final_delivery_state: 'reaction' as const } : {}),
      ...(task.finalAttachmentMessageId ? { final_attachment_message_id: task.finalAttachmentMessageId } : {}),
      ...(task.finalElements ? { final_elements: task.finalElements } : {}),
      ...(task.finalCardInput ? { final_card_input: task.finalCardInput } : {}),
      ...(task.progressFrozen ? { progress_frozen: true } : {}),
      ...(task.lastSuccessfulElements?.length ? { last_successful_elements: task.lastSuccessfulElements } : {}),
      ...(task.event.chatType === 'group' ? {
        reply_message_id: task.event.messageId,
        ...(task.event.threadId?.trim() ? { reply_in_thread: true } : {})
      } : {}),
      started_at: task.startedAt
    };
    const channel = larkCardChannel(task.config.appId);
    const row = { id: `${channel}:${task.id}`, channel, externalId: task.id, sessionId: task.sessionId,
      createdAt: new Date(task.startedAt).toISOString() };
    // 合并必须和写入基于同一次读：对账（reconciler.ts）用 compareAndSetExtra 写同一条
    // 记录，「读—改—写」会把它先写进去的字段整条丢掉。冲突时重读重算，而不是覆盖。
    for (let attempt = 0; ; attempt++) {
      let current: { sessionId: string; extra?: string | null } | undefined;
      try { current = await this.cardMappings.get(channel, task.id); }
      catch { /* 读不到就整体覆写：至少保证当前轮次可恢复 */ }
      const merged = this.mergeCardTaskExtra(current?.extra, extra, task.turn);
      // 新建记录、换了会话（/new 之后 sessionId 变了）、或存储没有 CAS（测试替身）时
      // 只能整行落库——compareAndSetExtra 写不了 extra 以外的列。
      if (!current || current.sessionId !== task.sessionId || typeof this.cardMappings.compareAndSetExtra !== 'function' || attempt >= 5) {
        if (attempt >= 5) this.log.warn({ taskId: task.id, turn: task.turn }, '飞书卡片映射并发写冲突反复失败，改为整行覆写');
        await this.cardMappings.save({ ...row, extra: JSON.stringify(merged) });
        return;
      }
      if (await this.cardMappings.compareAndSetExtra(row.id, current.extra, JSON.stringify(merged))) return;
    }
  }

  /**
   * 同一轮次内按合并写。LarkTask 带不回持久化记录里的全部字段：重启后重建的任务
   * （restoreVerifyCardAction）只带回一个子集，result_feedback_state 更是根本不在任务上。
   * 整体覆写会在「重启后点运行验证」这一步把附件绑定、验收状态与冻结标记一起抹掉，
   * ✅ 再也打不到那条文件消息上，对账也会开始反复重绘已终态的卡。
   * 轮次推进时不合并：新一轮本来就要清掉上一轮的卡片归属与终态。
   */
  private mergeCardTaskExtra(previous: string | null | undefined, extra: PersistedLarkCardTask, turn: number): PersistedLarkCardTask {
    try {
      const parsed = previous ? JSON.parse(previous) as PersistedLarkCardTask : undefined;
      if (parsed && (parsed.turn ?? 0) === turn) return { ...parsed, ...extra };
    } catch { /* 记录损坏时按整体覆写处理 */ }
    return extra;
  }

  /** 执行宿主名不进持久化，每次渲染时重新解析：Agent 可能被改名或删除，卡上应显示当前的名字。 */
  private async resolveAgentName(config: StoredLarkConfig) {
    try {
      return (await this.runtime.listAgents?.())?.find(agent => agent.id === config.defaultAgentId)?.name ?? config.defaultAgentId ?? 'Dutydeck';
    } catch (error) {
      this.log.warn({ error, agentId: config.defaultAgentId }, '读取 Agent 展示名失败，使用 Agent ID 渲染卡片');
      return config.defaultAgentId ?? 'Dutydeck';
    }
  }

  /**
   * 从持久化记录重建一份足够渲染结果卡的任务视图。
   * 重启后的「运行验证」与验收刷新都从这里取能力与状态，两条路径因此不会给出不同答案。
   * 带全字段是硬要求：少带一个，saveCardTask 写回时那个字段就会从记录里消失。
   */
  private restoredCardTask(config: StoredLarkConfig, mapping: { externalId: string; sessionId: string }, saved: PersistedLarkCardTask): LarkTask {
    return {
      id: mapping.externalId, group: { tail: Promise.resolve() }, config, state: saved.state,
      turn: saved.turn ?? 0, epoch: 0, scopeId: saved.scope_id ?? '', prompt: saved.prompt,
      resources: [], events: [], sessionId: mapping.sessionId, startedAt: saved.started_at,
      ...(saved.runtime_task_id ? { runtimeTaskId: saved.runtime_task_id } : {}),
      ...(saved.card_message_id ? { cardMessageId: saved.card_message_id } : {}),
      ...(saved.final_message_id ? { finalMessageId: saved.final_message_id } : {}),
      ...(saved.final_delivery_state ? { finalDeliveryState: saved.final_delivery_state } : {}),
      ...(saved.final_attachment_message_id ? { finalAttachmentMessageId: saved.final_attachment_message_id } : {}),
      ...(saved.final_card_input ? { finalCardInput: saved.final_card_input } : {}),
      ...(saved.progress_frozen ? { progressFrozen: true } : {}),
      ...(saved.last_successful_elements ? { lastSuccessfulElements: saved.last_successful_elements } : {}),
      finalElements: saved.final_elements ?? [],
      event: { messageId: mapping.externalId, chatId: saved.chat_id, chatType: saved.chat_type ?? 'group', messageType: 'text',
        content: '', mentions: [], senderOpenId: saved.sender_open_id,
        ...(saved.sender_type ? { senderType: saved.sender_type } : {}),
        ...(saved.thread_id ? { threadId: saved.thread_id } : {}) }
    };
  }

  private async refreshResultFeedback(config: StoredLarkConfig, requestId: string) {
    const record = (await this.workflows?.list(config.appId))?.find(item => item.id === requestId && item.kind === 'result');
    if (!record?.cardId) return;
    const mapping = (await this.cardMappings?.list(larkCardChannel(config.appId)))?.find(item => item.externalId === record.event.messageId);
    if (!mapping) return;
    const saved = JSON.parse(mapping.extra ?? '{}') as PersistedLarkCardTask;
    if (saved.state !== 'completed' || saved.final_delivery_state !== 'delivered'
      || saved.final_message_id !== record.cardId || saved.runtime_task_id !== record.taskId || saved.turn !== record.turn) return;
    // S4：文件型结果先补验收 reaction，再做「状态未变」短路——重启对账靠这个顺序补偿漏写。
    await this.addAcceptanceReaction(config, saved, record);
    if (saved.result_feedback_state === record.state) return;
    const resultElements = saved.final_elements ?? (saved.final_message_id === saved.card_message_id ? saved.last_successful_elements : undefined);
    if (!resultElements) {
      // File results cannot be PATCHed; the reply receipt and task dashboard
      // show acceptance while the original file and process stay unchanged.
      await this.cardMappings!.save({ ...mapping, extra: JSON.stringify({ ...saved, result_feedback_state: record.state }) });
      return;
    }
    // 验证状态行与「运行验证」按钮必须同源。这里若不重算，就会用回落的默认能力表
    // （canVerify 未声明 = 不给按钮）覆盖整卡，而 elements 里「可点『运行验证』执行。」
    // 那句是渲染时写死进 markdown 的：按钮没了，文字还在指一条不存在的路。
    const restored = this.restoredCardTask(config, mapping, saved);
    const verification = await this.verificationView(restored, config, saved.state as LarkCardActionState);
    const elements = [
      ...resultElements.filter(item => !['workflow_accept', 'workflow_changes', 'workflow_result_status', LARK_VERIFICATION_ELEMENT_ID].includes(String(item.element_id))),
      ...(verification.element ? [verification.element] : []),
      ...await this.workflows!.result(record, record.cardId, saved.final_attachment_message_id ? [saved.final_attachment_message_id] : undefined)];
    await this.service.update({ cardKind: 'result', messageId: record.cardId, taskId: mapping.externalId, taskName: saved.task_name, state: 'completed', readOnly: true, elements,
      capabilities: { ...this.capabilitiesForTask(restored), canVerify: verification.canRun, ...await this.resultActionCapabilities(restored, config, saved.state) },
      agentName: await this.resolveAgentName(config), turn: saved.turn });
    const current = (await this.cardMappings!.list(larkCardChannel(config.appId))).find(item => item.id === mapping.id);
    if (current?.extra !== mapping.extra) return;
    await this.cardMappings!.save({ ...mapping, extra: JSON.stringify({ ...saved, result_feedback_state: record.state, final_elements: elements }) });
  }

  /**
   * S4：文件型结果被验收（通过/需修改）后，对原文件消息补一枚 ✅/⌨️ reaction。
   * 先查 kv 幂等键再调平台再 CAS 落库；重启对账会反复进入本方法，命中即返，绝不重复打表情。
   * reaction 不承担通知职责，任何失败只 warn，不影响验收落库与卡片刷新。
   */
  private async addAcceptanceReaction(
    config: StoredLarkConfig,
    saved: PersistedLarkCardTask,
    record: { cardId?: string; state: string }
  ) {
    if (!this.workflowOptions.store) return;
    if (record.state !== 'accepted' && record.state !== 'needs_changes') return;
    // 新结果给附件加 reaction；旧的纯文件结果仍通过无内联元素识别。
    if (!saved.final_attachment_message_id && !isFileResultDelivery({ elements: saved.final_elements })) return;
    if (!saved.final_message_id || saved.final_message_id === saved.card_message_id || !record.cardId) return;
    const emojiType = reactionEmojiForAcceptance(record.state === 'accepted' ? 'accept' : 'changes');
    if (!emojiType) return;
    const fileMessageId = saved.final_attachment_message_id ?? record.cardId;
    const key = reactionDedupeKey(config.appId, fileMessageId, emojiType);
    try {
      if (await this.workflowOptions.store.get(key)) return;
      const result = await this.service.addReaction(fileMessageId, emojiType);
      const payload = {
        messageId: result.messageId,
        emojiType,
        reactionId: result.reactionId,
        createdAt: new Date().toISOString()
      } satisfies ReactionRecord;
      // 并发两条决议链路时 INSERT OR IGNORE 保证只有一条落库；未抢到也不撤销已加表情。
      await this.workflowOptions.store.compareAndSet?.(key, undefined, JSON.stringify(payload));
    } catch (error) {
      this.log.warn({ error, key }, '文件结果验收 reaction 写入失败，不影响验收状态');
    }
  }

  private async reconciledResult(mapping: { externalId: string; sessionId: string }, saved: PersistedLarkCardTask, cardId: string) {
    if (!this.workflows || !saved.sender_open_id || !saved.runtime_task_id || !saved.turn) return [];
    return this.workflows.result({ appId: saved.app_id, sessionId: mapping.sessionId, taskId: saved.runtime_task_id, turn: saved.turn,
      event: { messageId: mapping.externalId, chatId: saved.chat_id, chatType: saved.chat_type ?? 'group', senderOpenId: saved.sender_open_id,
        threadId: saved.thread_id, messageType: 'text', content: JSON.stringify({ text: saved.prompt }), mentions: [] } }, cardId, saved.final_attachment_message_id ? [saved.final_attachment_message_id] : undefined);
  }

  private async performReconcile(config: StoredLarkConfig) {
    if (!this.cardMappings) return 0;
    let unresolved = await performLarkCardReconcile({
      runtime: this.runtime,
      service: this.service,
      cardMappings: this.cardMappings,
      log: this.log,
      config,
      channel: larkCardChannel(config.appId),
      deliveryStore: this.workflowOptions.store,
      // 呈现开关可以按群覆盖，对账必须按记录所属会话解析后再决定怎么补发，
      // 否则重启后群里的静默/只贴表情配置全部失效。解析失败退回 Bot 级配置。
      resolveConfig: async saved => {
        if (saved.chat_type !== 'group' || !this.groupManager) return config;
        try { return await this.groupManager.resolved(config, saved.chat_id); }
        catch (error) {
          this.log.warn({ error, chatId: saved.chat_id }, '对账解析群级呈现配置失败，按 Bot 级配置补发');
          return config;
        }
      },
      resultElements: (mapping, saved, cardId) => this.reconciledResult(mapping, saved, cardId),
      terminalDecoration: async (mapping, saved, effective) => {
        const restored = this.restoredCardTask(effective, mapping, saved);
        const verification = await this.verificationView(restored, effective, saved.state as LarkCardActionState);
        return { elements: verification.element ? [verification.element] : [],
          cardInput: { capabilities: { ...this.capabilitiesForTask(restored), canVerify: verification.canRun, ...await this.resultActionCapabilities(restored, effective, saved.state) } } };
      }
    });
    unresolved += await this.workflows?.reconcile(config.appId) ?? 0;
    for (const record of await this.workflows?.list(config.appId) ?? []) {
      if (record.kind !== 'result' || !['accepted', 'needs_changes'].includes(record.state)) continue;
      try { await this.refreshResultFeedback(config, record.id); }
      catch (error) { unresolved++; this.log.warn({ error, requestId: record.id }, '验收状态刷新待重试'); }
    }
    return unresolved;
  }

  reconcile(config: StoredLarkConfig) {
    this.reconcileConfig = config;
    if (this.reconcileRun) return this.reconcileRun;
    const run = this.performReconcile(config).finally(() => {
      if (this.reconcileRun === run) this.reconcileRun = undefined;
    });
    this.reconcileRun = run;
    return run;
  }

  private scheduleReconcile() {
    if (this.stopped || this.reconcileTimer || !this.reconcileConfig) return;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = undefined;
      const config = this.reconcileConfig;
      if (!config || this.stopped) return;
      void this.reconcile(config).then(unresolved => {
        if (unresolved > 0) this.scheduleReconcile();
      }).catch(error => {
        this.log.warn({ error, appId: config.appId }, '飞书卡片周期对账失败，稍后重试');
        this.scheduleReconcile();
      });
    }, this.reconcileIntervalMs);
    this.reconcileTimer.unref();
  }

  async startReconciliation(config: StoredLarkConfig, intervalMs = 5_000) {
    this.reconcileConfig = config;
    this.applyReminderSettings(config);
    this.reconcileIntervalMs = Math.max(50, intervalMs);
    if (this.reconcileTimer) { clearTimeout(this.reconcileTimer); this.reconcileTimer = undefined; }
    // 僵尸置顶的唯一收敛点：崩在长任务中间的置顶卡只有启动对账能撤下来。
    // 与开关无关——把开关关掉的人期待的正是「以前置顶的都撤掉」。
    await this.pins?.reconcile({ appId: config.appId, activeTaskIds: [...this.tasks.keys()] })
      .catch(error => this.log.warn({ error, appId: config.appId }, '飞书置顶对账失败，不影响任务执行'));
    this.scheduleTaskAgentPoll(config);
    const unresolved = await this.reconcile(config);
    if (unresolved > 0) this.scheduleReconcile();
    return unresolved;
  }

  /**
   * 飞书任务智能体通道的轮询周期。
   *
   * 60 秒：派活是人的动作，任务界面上指派一条任务到机器人接单之间隔一分钟，与这条通道
   * 的使用节奏相称；聊天入口本来就是实时的，这条是补充入口，不必也不该按秒抢。代价这边，
   * 每轮最多一次列表请求（只有翻页才追加），对租户级限流可以忽略。通道关闭时
   * claimLarkTaskDispatches 在三道门里直接返回，一个请求都不会发出去，定时器空转而已。
   */
  private readonly taskAgentIntervalMs = 60_000;

  private scheduleTaskAgentPoll(config: StoredLarkConfig) {
    if (this.stopped || this.taskAgentTimer) return;
    this.taskAgentTimer = setTimeout(() => {
      this.taskAgentTimer = undefined;
      if (this.stopped) return;
      void this.pollLarkTaskDispatches(config)
        .catch(error => this.log.warn({ error, appId: config.appId }, '飞书任务智能体通道轮询失败，下一轮重试'))
        .finally(() => this.scheduleTaskAgentPoll(config));
    }, this.taskAgentIntervalMs);
    this.taskAgentTimer.unref();
  }

  /**
   * 拉取分配给本机器人的飞书任务并逐条交给消息入口。返回本轮真正派出去的条数。
   *
   * 认领与交接必须成对：claimLarkTaskDispatches 先把任务在账本上认领下来，交接抛错时
   * 这里必须把认领退回，否则这条任务会被永久当成已派发、静默丢活。
   */
  async pollLarkTaskDispatches(config: StoredLarkConfig): Promise<number> {
    const store = this.workflowOptions.store;
    if (this.stopped || !store) return 0;
    if (this.taskAgentRun) return this.taskAgentRun;
    const run = (async () => {
      const intake = await claimLarkTaskDispatches({
        appId: config.appId, client: this.service, store, botConfig: config, log: this.log
      });
      if (intake.status !== 'ready') return 0;
      let dispatched = 0;
      for (const dispatch of intake.dispatches) {
        if (this.stopped) break;
        try {
          await this.handle(dispatch.event, config);
          dispatched++;
        } catch (error) {
          this.log.warn({ error, taskGuid: dispatch.taskGuid }, '飞书任务交接失败，已退回认领等待下一轮重派');
          await releaseLarkTaskClaim(store, dispatch.ledgerKey)
            .catch(releaseError => this.log.error({ error: releaseError, taskGuid: dispatch.taskGuid }, '退回飞书任务认领失败，这条任务不会被再次派发'));
        }
      }
      return dispatched;
    })().finally(() => { if (this.taskAgentRun === run) this.taskAgentRun = undefined; });
    this.taskAgentRun = run;
    return run;
  }

  /** 状态流转写回飞书任务记录的文案；没有对应说法的中间态不写。 */
  private static readonly taskStepContent: Partial<Record<LarkTaskState, string>> = {
    queued: 'Dutydeck 已接单，排队等待执行。',
    running: 'Dutydeck 正在执行。',
    completed: 'Dutydeck 执行完成，结果已发到飞书会话。',
    failed: 'Dutydeck 执行失败，详情见飞书会话里的结果卡。',
    interrupted: 'Dutydeck 执行已中断。',
    cancelled: 'Dutydeck 任务已取消。'
  };

  /**
   * 把本轮状态写成飞书任务记录，在飞书任务界面直接可见。
   * 只对任务通道派来的任务生效（合成 messageId 才解得出 guid），聊天消息一条都不写。
   * 同一轮同一状态只写一次；写失败撤回本地标记，下一次状态保存会重试。
   */
  private async writeLarkTaskStep(task: LarkTask, state: LarkTaskState) {
    const taskGuid = larkTaskAgentGuid(task.event.messageId);
    const content = LarkMessageCoordinator.taskStepContent[state];
    if (!taskGuid || !content) return;
    const key = `${taskGuid}:${task.turn}:${state}`;
    if (this.writtenTaskSteps.has(key)) return;
    this.writtenTaskSteps.add(key);
    if (this.writtenTaskSteps.size > 5_000) this.writtenTaskSteps.delete(this.writtenTaskSteps.values().next().value!);
    try {
      await appendLarkTaskSteps({ client: this.service, taskGuid, steps: [{ content }], idempotentKey: key.slice(0, 64) });
    } catch (error) {
      this.writtenTaskSteps.delete(key);
      this.log.warn({ error, taskGuid, state }, '飞书任务记录写入失败，不影响任务执行');
    }
  }

  /**
   * 长任务的进度卡置顶。默认关闭；开启后跑过 pinAfterMs 才置顶，短任务不打扰会话列表。
   * 置顶与撤销都由 LarkPinManager 兜底，失败只记日志，绝不影响任务本身。
   */
  private async pinLongRunningCard(task: LarkTask) {
    if (!this.pins || task.config.pinLongTasks !== true || !task.cardMessageId || !task.startedAt) return;
    if (Date.now() - task.startedAt < (task.config.pinAfterMs ?? 10 * 60 * 1000)) return;
    await this.pins.pin(task.cardMessageId, { appId: task.config.appId, taskId: task.id, chatId: task.event.chatId });
  }

  /** 终态撤销置顶：与开关无关，开关关掉之后仍然要把已经置顶的卡撤下来。 */
  private async unpinTaskCard(task: LarkTask) {
    if (!this.pins || !task.cardMessageId || !this.pins.isPinned(task.cardMessageId)) return;
    await this.pins.unpin(task.cardMessageId, { appId: task.config.appId });
  }

  private async rejectIncoming(event: LarkMessageEvent, config: StoredLarkConfig, reason: string, explicit: boolean) {
    if (!explicit || this.handledMessages.has(event.messageId)) return;
    this.handledMessages.add(event.messageId);
    if (this.handledMessages.size > 5_000) this.handledMessages.delete(this.handledMessages.values().next().value!);
    const inbox = await this.inbox?.claim(config.appId, event);
    if (this.inbox && !inbox) return;
    await sendTaskCard(this.service, event, {
      state: 'failed', readOnly: true, retryable: false, taskId: event.messageId, taskName: '请求未执行',
      markdown: `**请求未执行，Agent 尚未启动。**\n\n${reason}\n\n请联系此机器人的管理员检查群配置、运行权限和你的访问授权，确认生效后重新发送。`,
      idempotencyKey: `input_denied_${event.messageId}`.slice(0, 50)
    }, this.log).catch(error => this.log.warn({ error, messageId: event.messageId }, '发送未执行回执失败'));
    if (inbox) await this.inbox!.update(inbox, { state: 'failed', error: reason });
  }

  async handle(event: LarkMessageEvent, config: StoredLarkConfig, recovering = false) {
    if (this.workflowOptions.store) {
      const current = await readLarkConfig(this.workflowOptions.store, config.appId);
      if (!current?.listening) return;
      config = current;
    }
    const quotedWorkflow = await this.workflows?.quoted(config.appId, event);
    const mentionsBot = this.botOpenId ? event.mentions.some(mention => mention.openId === this.botOpenId) : event.mentions.some(mention => mention.mentionedType === 'bot');
    if (this.stopped) return;
    const botSender = event.senderType === 'app' || event.senderType === 'bot';
    const explicit = !botSender && (event.chatType === 'p2p' || mentionsBot || Boolean(quotedWorkflow));
    let helpOnly = false;
    let recognizedCommand = false;
    try {
      const parsed = parseSlashCommand((await parsePrompt(event, this.botOpenId)).prompt);
      helpOnly = parsed?.name === 'help';
      recognizedCommand = Boolean(parsed && resolveLarkCommand(parsed));
    } catch { /* normal parser reports malformed content below */ }
    const entryAction: PolicyAction = helpOnly ? 'task.view_result' : 'task.create';
    try {
      if (event.chatType === 'group' && this.groupManager) config = await this.groupManager.resolved(config, event.chatId);
    } catch (error) {
      await this.rejectIncoming(event, config, error instanceof Error ? error.message : '群配置尚未生效。', explicit);
      return;
    }
    const mentionPolicy = config.mentionPolicy ?? 'always';
    const continuedTopic = mentionPolicy === 'topic' && this.groupManager
      ? await this.groupManager.ownsTopic(config, event, await resolveLarkScopeId(event, config, this.chatModeResolver)) : false;
    // ambient 与 never 的区别在这里：ambient 在消息指名了别人时让路，只接没有指名任何人的消息。
    // 本分支已排除 mentionsBot，所以此处出现的任何 mention 都是「点了别人」。
    const ambientOpen = mentionPolicy === 'ambient' && !event.mentions.length;
    const legacyWake = Boolean(quotedWorkflow) || event.chatType === 'p2p' || (event.chatType === 'group' && (mentionsBot || !botSender && (continuedTopic || mentionPolicy === 'never' || ambientOpen)));
    // Known commands retain their existing wake and authorization rules; unknown /paths remain material.
    const commandInteraction = !botSender && recognizedCommand && legacyWake;
    // Observation precedes wake filtering and every visible acknowledgement.
    const pendingAskContinuation = Boolean(this.workflowOptions.participation && !recovering && !explicit && await this.continuesPendingAsk(event, config));
    const participation = await this.workflowOptions.participation?.handle(event, config, { explicit: explicit || pendingAskContinuation || commandInteraction, botOpenId: this.botOpenId });
    if (this.handledMessages.has(event.messageId)) return;
    // 定向机器人交接仍走下方循环门禁和访问授权，不作为人类显式指令或主动判定。
    if (participation?.enabled && !explicit && !pendingAskContinuation && !commandInteraction && !(botSender && legacyWake)) return;
    const shouldWake = legacyWake || Boolean(participation?.enabled && pendingAskContinuation);
    // 机器人互相 @ 的硬门禁。legacyWake 的 mentionsBot / quotedWorkflow 两支都不受 !botSender
    // 约束，访问控制在没配成员名单时又对机器人一律放行，所以刷屏回路只能在这里封口。
    // 判定失败按挡下处理：门禁读不到状态时放行等于把回路重新打开。
    // 被挡下的回合只留门禁记录，绝不向群里发消息——那本身就是噪音。
    if (shouldWake && event.chatType === 'group' && this.workflowOptions.participation) {
      let botTurnGate: string | undefined;
      try {
        botTurnGate = await this.workflowOptions.participation.guardBotTurn(event, config, { botOpenId: this.botOpenId });
      } catch (error) {
        botTurnGate = '机器人回合门禁判定失败';
        this.log.warn({ error, chatId: event.chatId, messageId: event.messageId }, '机器人回合门禁判定失败，本轮不响应');
      }
      if (botTurnGate) {
        this.log.info({ chatId: event.chatId, messageId: event.messageId, reason: botTurnGate }, '机器人触发的回合已被门禁挡下');
        return;
      }
    }
    if (shouldWake && event.chatType === 'group' && this.groupManager) {
      const decision = await this.groupManager.authorize(config.appId, event.chatId, event.senderOpenId, entryAction, undefined, { memberObserved: !recovering });
      if (decision && !decision.allowed) {
        await this.rejectIncoming(event, config, decision.code === 'talk_required' ? '当前账号没有此群的任务访问权限。' : decision.reason, explicit);
        return;
      }
    }
    if (this.stopped || !shouldWake || this.handledMessages.has(event.messageId)) return;
    if (recovering && (!event.senderOpenId || !await this.currentAccess(config, event.chatId, event.chatType, event.senderOpenId, entryAction, undefined, event.senderOpenId))) return;
    try { if (!helpOnly) await this.requireExecution('listener', 'task.create'); }
    catch (error) {
      await this.rejectIncoming(event, config, error instanceof Error ? error.message : '机器人尚未获得运行权限。', explicit);
      return;
    }
    const inbox = await this.inbox?.claim(config.appId, event);
    if (this.inbox && !inbox) return;
    if (inbox) event = inbox.event;
    // 先标记已处理，避免异步解析期间同一条消息被重复入队。
    this.handledMessages.add(event.messageId);
    if (this.handledMessages.size > 5_000) this.handledMessages.delete(this.handledMessages.values().next().value!);
    // 事件接入后立即给出稳定、单义的接收确认。解析、附件下载和会话路由均可能较慢，
    // 不应让用户在这些步骤中面对无反馈的聊天界面。
    // 任务通道派来的是合成事件，背后没有真实消息：给它贴表情必然失败，
    // 每条任务留一条 warn 就是纯噪声，因此在调用前跳过。
    let acknowledgementReactionId: string | undefined;
    if (!larkTaskAgentGuid(event.messageId)) {
      try {
        acknowledgementReactionId = (await this.service.addReaction(event.messageId, 'OK')).reactionId;
      } catch (error) {
        this.log.warn({ error, messageId: event.messageId }, '发送飞书确认表情失败，继续处理消息');
      }
    }
    let prompt: string;
    let resources: LarkMessageResource[];
    let scopeId: string;
    try {
      ({ prompt, resources } = await parsePrompt(event, this.botOpenId));
      // 路由解析（话题群种子 / 普通群回复模式 / legacy）与 group key 共用同一 scopeId，
      // 保证同一会话的消息串行化到同一个 group。
      scopeId = await resolveLarkScopeId(event, config, this.chatModeResolver);
    } catch (error) {
      this.log.warn({ error, chatId: event.chatId, messageId: event.messageId }, '解析飞书消息失败，已向用户回执');
      // P0-4：解析失败回执是独立新消息，群聊开启时与其他失败回执同口径 @ 发起人；私聊不 @。
      const parseFailMention = senderGroupMention(config.groupCardMention, event);
      await sendTaskCard(this.service, event, {
        state: 'failed', retryable: false, readOnly: true,
        taskId: event.messageId, taskName: '消息接收失败',
        markdown: `${parseFailMention ? `${parseFailMention}\n\n` : ''}**消息未能解析，Agent 尚未执行。**\n\n${error instanceof Error ? error.message : String(error)}\n\n请检查消息内容或附件后重新发送。`,
        idempotencyKey: `parse_failed_${event.messageId}`.slice(0, 50),
        ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {})
      }, this.log).catch(cardError => this.log.error({ error: cardError, messageId: event.messageId }, '发送飞书解析失败回执失败'));
      if (acknowledgementReactionId) await this.service.deleteReaction(event.messageId, acknowledgementReactionId).catch(() => undefined);
      if (inbox) await this.inbox!.update(inbox, { state: 'failed', error: '消息解析失败' });
      return;
    }
    if (inbox?.request) { prompt = inbox.request.prompt; resources = inbox.request.resources; scopeId = inbox.request.scopeId; }
    const workflowScope = { id: scopeId };
    if (!inbox?.request && (await this.routeWorkflow(event, config, prompt, workflowScope)
      || await this.routePendingAsk(event, config, prompt, resources, workflowScope.id, inbox, recovering))) {
      if (inbox) await this.inbox!.update(inbox, { state: 'accepted' });
      if (acknowledgementReactionId) await this.service.deleteReaction(event.messageId, acknowledgementReactionId).catch(() => undefined);
      return;
    }
    scopeId = workflowScope.id;
    // 聊天内斜杠命令：必须在解析之后（拿到剥离 @机器人 的纯文本）、建任务之前。
    // 命令不是 Agent 任务，不应占用一次 Agent 轮次，也不应留下进度卡。
    // 未识别的 /xxx 会被归一化成普通文字继续走建任务流程（用户发路径不该收到失败回执）。
    // group 必须先于命令路由取出：/new 要在这个 group 上登记「已结束的会话」，
    // 之后同一 group 的消息（包括本条 /new 自带的任务内容）才不会把旧上下文绑回来。
    const groupKey = larkGroupKey(event, scopeId, config.appId);
    const group = this.groups.get(groupKey) ?? { tail: Promise.resolve() };
    this.groups.set(groupKey, group);
    if (inbox && !inbox.request && parseSlashCommand(prompt)) await this.inbox!.update(inbox, { state: 'command' });
    const commandRoute = inbox?.request ? undefined : await this.routeChatCommand(event, config, prompt, group, scopeId, acknowledgementReactionId);
    if (commandRoute === 'handled') {
      if (inbox) await this.inbox!.update(inbox, { state: 'accepted' });
      return;
    }
    let retryMaterialPrompt = inbox?.request?.materialPrompt;
    let launchOptions = inbox?.request?.launchOptions;
    let commandEpoch: number | undefined;
    if (typeof commandRoute === 'string') prompt = commandRoute;
    else if (commandRoute) { prompt = commandRoute.prompt; retryMaterialPrompt = commandRoute.materialPrompt; launchOptions = commandRoute.launchOptions; commandEpoch = commandRoute.epoch; }
    if (inbox && !inbox.request) await this.inbox!.update(inbox, { state: 'received', request: { prompt, scopeId, resources, ...(retryMaterialPrompt ? { materialPrompt: retryMaterialPrompt } : {}), ...(launchOptions ? { launchOptions } : {}) } });
    // 空 @ 消息（仅 @ 机器人无文字）仍需创建任务，由 runTurn 拉取聊天记录做兜底意图判断。
    const task: LarkTask = { id: event.messageId, group, event, prompt, resources, inbox, retryMaterialPrompt, launchOptions, ...(inbox?.cardId ? { cardMessageId: inbox.cardId } : {}), ...(commandRoute && typeof commandRoute !== 'string' && commandRoute.suggestion ? { commandSuggestion: commandRoute.suggestion } : {}), ...(commandRoute && typeof commandRoute !== 'string' && commandRoute.steer ? { steer: true } : {}), config, state: 'queued', events: [], restoring: recovering, turn: (inbox?.turn ?? 1) - 1, scopeId, epoch: commandEpoch ?? group.epoch ?? 0, acknowledgementReactionId };
    this.tasks.set(task.id, task);
    if (this.tasks.size > 5_000) this.tasks.delete(this.tasks.keys().next().value!);
    group.tail = group.tail.then(() => this.runTurn(task)).catch(async error => {
      this.log.error({ error, chatId: event.chatId, messageId: event.messageId }, '处理飞书唤醒消息失败');
      // runTurn 在首张卡片送达前抛出（附件下载、空 @ 兜底、卡片发送本身失败）时，
      // OK reaction 会永远留在原消息上：用户看到「已接收」却永远等不到进度卡，
      // 正是设计契约禁止的两个竞争状态并存。此处兜底撤销，保证回执不会悬挂。
      await this.clearAcknowledgementReaction(task);
      if (inbox?.state === 'received') await this.inbox!.update(inbox, { state: 'failed', error: error instanceof Error ? error.message : String(error) });
    });
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
      ...larkCommandCapabilities(this.runtime),
      ci: Boolean(this.workflowOptions.automation),
      schedule: Boolean(this.workflowOptions.automation),
      work: Boolean(this.workflowOptions.workbench),
      tasks: Boolean(this.workflows && this.cardMappings && this.runtime.getTasks),
      answer: Boolean(this.workflows && this.workflowOptions.broker),
      approval: Boolean(this.workflows && this.runtime.resolvePermission && this.runtime.getPendingPermissions),
      memory: Boolean(this.workflowOptions.memory),
      groupPolicy: Boolean(this.groupManager)
    };
  }

  private async routeChatCommand(
    event: LarkMessageEvent,
    config: StoredLarkConfig,
    prompt: string,
    group: LarkGroup,
    scopeId: string,
    acknowledgementReactionId?: string
  ): Promise<'handled' | string | LarkCommandPrompt | undefined> {
    if (!parseSlashCommand(prompt)) return undefined;
    const botSender = event.senderType === 'app' || event.senderType === 'bot';
    const commandAccess = event.chatType === 'group' ? await this.groupManager?.authorize(config.appId, event.chatId, event.senderOpenId, 'task.view_result') : undefined;
    const allowlisted = commandAccess?.allowed ?? await this.isOperatorAllowed(config, event.senderOpenId, event.chatId, group.sessionId);
    const route = routeLarkCommand(prompt, {
      capabilities: this.larkRouteCapabilities(),
      operator: { kind: botSender ? 'bot' : 'user', allowlisted }
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
      await sendTaskCard(this.service, event, {
        state: options.failed ? 'failed' : 'completed', readOnly: true, retryable: false,
        taskId: event.messageId, taskName,
        markdown,
        ...(options.elements?.length ? { elements: options.elements } : {}),
        idempotencyKey: `cmd_${route.command}_${event.messageId}`.slice(0, 50),
        ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {})
      }, this.log).catch(error => this.log.error({ error, messageId: event.messageId, command: route.command }, '发送飞书命令回执失败'));
      // reaction 是「请求已接入」的回执，命令回执落地后必须撤销，避免两个状态并存。
      if (acknowledgementReactionId) {
        await this.service.deleteReaction(event.messageId, acknowledgementReactionId).catch(() => undefined);
      }
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
      await replyCard(`/${route.command} 未执行`, route.reason, { failed: true });
      this.log.info({ messageId: event.messageId, command: route.command, kind: route.kind }, '飞书命令未执行');
      return 'handled';
    }
    return await this.executeChatCommandIntent(route, event, config, group, scopeId, replyCard, acknowledgementReactionId);
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
    replyCard: (taskName: string, markdown: string, options?: { elements?: LarkCardElement[]; failed?: boolean }) => Promise<void>,
    acknowledgementReactionId?: string
  ): Promise<'handled' | string | LarkCommandPrompt> {
    // 最近一轮任务：/cancel 与 /retry 需要它，按插入顺序取该 group 的最后一个任务。
    const latestTask = [...this.tasks.values()].reverse().find(task => task.group === group);

    try {
      // 命令与普通消息共用同一条会话定位：内存绑定优先（同一进程内最新），
      // 缺失时回落到持久化查询，这样 coordinator 重建后命令仍能找到本上下文的会话。
      // 查询失败必须让命令整体失败：把它当成「没有会话」会让 /status 谎称尚未创建、
      // 让 /new 在没停掉任何东西的情况下回一句「已受理」，甚至直接派发新任务。
      const boundSessionId = group.sessionId && !group.retiredSessionIds?.has(group.sessionId) ? group.sessionId : undefined;
      const sessionId = boundSessionId ?? (await this.findScopeSession(config, event, scopeId, group))?.id;
      if (config.managedGroup && route.command === 'new' && !await this.isOperatorAllowed(config, event.senderOpenId, event.chatId, sessionId)) {
        await replyCard(`/${route.command} 未执行`, '当前账号没有操作此任务的权限。', { failed: true });
        return 'handled';
      }

      if (route.command === 'repair') {
        // 安装级发布动作：发卡前就按 high_risk/静态白名单口径拦一道，无权成员看不到确认卡。
        if (!event.senderOpenId || !await this.isInstallationOperatorAllowed(config, event.senderOpenId, event.chatId)) {
          await replyCard('/repair 未执行', '当前账号无权执行应用修复：需要安装管理员权限。', { failed: true });
          return 'handled';
        }
        // 只发二次确认卡；真正的发布动作只能由确认卡回调触发（handleAction 的 dutydeck_repair 分支）。
        const card = buildRepairConfirmCard(config.appId);
        await replyCard(card.title, card.markdown, { elements: card.elements });
        return 'handled';
      }

      if (route.command === 'work') {
        const workbench = this.workflowOptions.workbench;
        if (!workbench) throw new Error('当前服务尚未接入目标工作台。');
        if (!sessionId && !route.args.length) {
          await replyCard('Dutydeck 工作台', '在此话题描述目标，或发送 `/work research 研究目标`，Dutydeck 会分配两个独立分析步骤并汇总成果。已有目标可用 `/work` 查看，常用流程可用 `/work templates` 查看。');
          return 'handled';
        }
        const parentSessionId = sessionId ?? (await this.sessionFor(group, config, event.chatId, event.chatType, scopeId)).id;
        await workbench.command(parentSessionId, route.argsText, event, config);
        if (acknowledgementReactionId) await this.service.deleteReaction(event.messageId, acknowledgementReactionId).catch(() => undefined);
        return 'handled';
      }
      if (route.command === 'schedule') {
        const automation = this.workflowOptions.automation;
        if (!automation) throw new Error('当前服务未接入定时任务。');
        if (!event.senderOpenId || !await this.isOperatorAllowed(config, event.senderOpenId, event.chatId, sessionId)) throw new Error('当前账号没有操作此任务的权限。');
        if (!sessionId && !route.args.length) {
          await replyCard('定时任务', '此话题暂无计划。发送 `/schedule every 分钟 指令` 创建停用的计划，再按回执核对并启用。');
          return 'handled';
        }
        const parentSessionId = sessionId ?? (await this.sessionFor(group, config, event.chatId, event.chatType, scopeId)).id;
        await replyCard('定时任务', await executeScheduleCommand(automation, this.workflowOptions.store, parentSessionId, route.argsText, event, config));
        return 'handled';
      }
      if (route.command === 'ci') {
        const automation = this.workflowOptions.automation;
        if (!automation || !sessionId) throw new Error('当前话题还没有可用的工作项，请先发送任务。');
        if (!event.senderOpenId || !await this.isOperatorAllowed(config, event.senderOpenId, event.chatId, sessionId)) throw new Error('当前账号没有操作此任务的权限。');
        const [action, argument, ...extra] = route.args;
        if (action === 'wait' && !extra.length) {
          const item = await automation.subscribeCi(sessionId, argument ? { workflow: argument } : {}, event.senderOpenId);
          await replyCard('等待 GitHub Actions', `已等待 ${item.repository.slug} 的提交 ${item.headSha.slice(0, 12)}。\n\n截止：${item.expiresAt}\n取消：/ci cancel ${item.id}`);
        } else if (action === 'cancel' && argument && !extra.length) {
          const items = await automation.listBySession(sessionId, event.senderOpenId);
          const item = items.subscriptions.find(value => value.id === argument);
          if (!item) throw new Error('此工作项中找不到该等待记录。');
          await automation.cancelCi(sessionId, item.id, { expectedRevision: item.revision }, event.senderOpenId);
          await replyCard('已取消 CI 等待', '尚未开始的自动续作不会再执行。已经运行的任务可通过 /cancel 中断。');
        } else if (!action) {
          const items = await automation.listBySession(sessionId, event.senderOpenId);
          const labels: Record<string, string> = { waiting: '等待中', dispatching: '提交中', accepted: '续作已接收', completed: '续作已结束', cancelled: '已取消', expired: '已过期', stale_head: '提交已变化', session_inactive: '会话已结束', revoked: '权限已撤销', error: '查询失败' };
          await replyCard('CI 等待记录', items.subscriptions.slice(0, 10).map(item => `${labels[item.status] ?? item.status} · ${item.repository.slug} · ${item.headSha.slice(0, 12)}\n${item.error ?? ''}\n/ci cancel ${item.id}`).join('\n\n') || '尚无等待记录。发送 /ci wait [工作流文件名或 ID] 等待当前提交。');
        } else throw new Error('用法：/ci、/ci wait [工作流文件名或 ID]、/ci cancel 等待编号');
        return 'handled';
      }
      if (route.command === 'status') {
        await replyCard('任务状态', await this.describeChatStatus(config, sessionId, latestTask));
        return 'handled';
      }
      if (route.command === 'agents') {
        const agents = await this.runtime.listAgents!();
        if (!agents.length) {
          await replyCard('本机可用 Agent', '**这台机器还没有配置任何 Agent。**\n\n请先在 Dutydeck Web 添加 Agent。');
          return 'handled';
        }
        const lines = agents.map(agent => {
          // 版本只来自 Agent 配置里探测到的值；探测不到就说探测不到，不拿命令名冒充版本。
          const version = agent.version?.trim() ? `版本 ${larkCommandEcho(agent.version, 40)}` : '版本未探测到';
          const current = agent.id === config.defaultAgentId ? ' · **本机器人当前默认**' : '';
          return `**${larkCommandEcho(agent.name, 64)}**（\`${larkCommandEcho(agent.id, 64)}\`）\n${version}${current}`;
        });
        await replyCard('本机可用 Agent', lines.join('\n\n'));
        return 'handled';
      }
      if (route.command === 'queue') {
        if (!sessionId) throw new Error('当前话题还没有会话，也就没有待执行的指令。');
        // 编号口径与心跳里的排队摘要同源（runtime.getTasks 里 status=queued 的那些，按收到顺序）。
        const queued = (await this.runtime.getTasks!(sessionId)).filter(task => task.status === 'queued');
        const [action, argument, ...extra] = route.args;
        if (!action) {
          const summary = renderQueueSummary(queued);
          // 摘要为卡片预算只列前几条，编号却一直有效：不写这句，第 6 条以后就成了看不见也够不着的死区。
          const hidden = queued.length > QUEUE_SUMMARY_MAX_ITEMS ? `上面只列出前 ${QUEUE_SUMMARY_MAX_ITEMS} 条，编号 ${QUEUE_SUMMARY_MAX_ITEMS + 1}-${queued.length} 同样可用。` : '';
          await replyCard('待执行指令', summary
            ? `${summary}\n\n编号按收到顺序，共 ${queued.length} 条。${hidden}取消：\`/queue cancel <编号>\`；提到队首：\`/queue top <编号>\`。`
            : '**当前没有待执行的指令。**');
          return 'handled';
        }
        if (action !== 'cancel' && action !== 'top' || !argument || extra.length) {
          throw new Error('用法：`/queue`、`/queue cancel <编号>`、`/queue top <编号>`');
        }
        const index = Number(argument);
        if (!Number.isInteger(index) || index < 1 || index > queued.length) {
          await replyCard('/queue 未执行', `**编号超出范围：当前有 ${queued.length} 条待执行指令。**\n\n发送 \`/queue\` 查看最新编号。`, { failed: true });
          return 'handled';
        }
        const target = queued[index - 1]!;
        const policy: PolicyAction = action === 'cancel' ? 'queue.cancel' : 'queue.promote';
        if (!await this.isTaskOperatorAllowed(config, event, { id: target.id, sessionId }, policy)) {
          await replyCard('/queue 未执行', '当前账号没有操作这条排队指令的权限。', { failed: true });
          return 'handled';
        }
        if (action === 'cancel') {
          if (!this.runtime.cancelQueued) throw new Error('当前 Dutydeck 运行时无法取消排队任务，请前往 Dutydeck Web 处理。');
          await this.runtime.cancelQueued(sessionId, target.id, event.senderOpenId);
          await replyCard('已取消排队指令', `**第 ${index} 条待执行指令不会再执行。**\n\n${escapeLarkPromptEcho(larkCommandEcho(target.prompt, 120))}`);
        } else {
          if (!this.runtime.steerQueued) throw new Error('当前 Dutydeck 运行时无法调整队列顺序，请前往 Dutydeck Web 处理。');
          if (!await this.canInterruptCurrentTurn(config, event, sessionId)) {
            await replyCard('/queue 未执行', '**提到队首会中断当前正在执行的那一轮，而那一轮不是你的任务。**\n\n你没有中断它的权限，队列顺序没有改动。', { failed: true });
            return 'handled';
          }
          await this.runtime.steerQueued(sessionId, target.id, event.senderOpenId);
          await replyCard('已提到队首', `**第 ${index} 条待执行指令已排到队首，当前这一轮会被中断。**\n\n${escapeLarkPromptEcho(larkCommandEcho(target.prompt, 120))}`);
        }
        return 'handled';
      }
      if (route.command === 'steer') {
        if (!route.argsText) {
          await replyCard('/steer 未执行', '**用法：`/steer <内容>`**\n\n例如：`/steer 先跑一遍测试再改`。', { failed: true });
          return 'handled';
        }
        // 提到队首会中断当前这一轮，因此必须先过与 /cancel 同一道 run.interrupt 门；
        // 否则只有 own_runs 权限的成员能用一条 /steer 打断别人的任务，而 /cancel 会拒绝他。
        if (sessionId && !await this.canInterruptCurrentTurn(config, event, sessionId)) {
          await replyCard('/steer 未执行', '**当前正在执行的是他人的任务，你没有中断它的权限。**\n\n直接把这条内容作为普通消息发出来，它会排到队尾执行。', { failed: true });
          return 'handled';
        }
        // 运行时没有「向正在执行的这一轮注入内容」的原语，只有把排队中的一轮提到队首。
        // 内容仍走完整建任务链路（授权、风险检查、附件、卡片一个都不能少）；
        // 队首提升在派发拿到 runtime task id 之后做，结果如实写在这张卡上。
        return { prompt: route.argsText, steer: true };
      }
      if (route.command === 'grant' || route.command === 'revoke') {
        return await this.executeGrantCommand(route.command, event, config, route.argsText, replyCard);
      }
      // 记忆命令的授权就是命令层的白名单门（发言人能在本聊天用命令，就能维护本聊天的记忆），
      // 作用域固定为当前聊天，不接受参数指定别的群。
      if (route.command === 'remember' || route.command === 'memory' || route.command === 'forget') {
        if (config.memoryEnabled === false) {
          await replyCard(`/${route.command} 未执行`, '本机器人已关闭会话记忆。', { failed: true });
          return 'handled';
        }
        const memory = this.memory!;
        const scope = { appId: config.appId, chatId: event.chatId };
        if (route.command === 'memory') {
          if (route.args[0] === 'consolidate') {
            // /memory 整体是只读命令，但 consolidate 会改写账本：这里单独挡住机器人发送者，
            // 与 /remember、/forget 的 mutating 口径一致。
            if (event.senderType === 'app' || event.senderType === 'bot') {
              await replyCard('/memory consolidate 未执行', '机器人发送者不能整理本聊天的记忆。', { failed: true });
              return 'handled';
            }
            const pipeline = this.workflowOptions.memory?.pipeline;
            if (!pipeline) {
              await replyCard('/memory consolidate 未执行', '整理功能未启用。', { failed: true });
              return 'handled';
            }
            const outcome = await pipeline.requestConsolidation(scope, { ...(event.senderOpenId ? { actorId: event.senderOpenId } : {}) });
            if (outcome === 'started') await replyCard('会话记忆整理', '**已开始整理，完成后 `/memory` 可见。**');
            else if (outcome === 'running') await replyCard('/memory consolidate 未执行', '**整理正在进行中。**', { failed: true });
            else await replyCard('/memory consolidate 未执行', '本机器人已关闭会话记忆。', { failed: true });
            return 'handled';
          }
          let page: number | undefined;
          if (route.args.length > 0) {
            page = Number(route.args[0]);
            if (!Number.isInteger(page) || page < 1) {
              await replyCard('/memory 未执行', '**用法：`/memory [页码]` 或 `/memory consolidate`**', { failed: true });
              return 'handled';
            }
          }
          const [byTopic, state] = await Promise.all([
            memory.byTopic(scope),
            memory.getState(scope)
          ]);
          const result = renderLarkMemoryList(byTopic, state, { page });
          if (page !== undefined && page > result.totalPages) {
            await replyCard('/memory 未执行', `**页码超出范围，共 ${result.totalPages} 页。**\n\n发送 \`/memory 1\` 查看第一页。`, { failed: true });
            return 'handled';
          }
          await replyCard('会话记忆', result.text);
          return 'handled';
        }
        if (route.command === 'remember') {
          if (!route.argsText) {
            await replyCard('/remember 未执行', '**用法：`/remember <要记住的内容>`**\n\n例如：`/remember 这个群的回复统一用中文`。', { failed: true });
            return 'handled';
          }
          const entry = await memory.add(scope, { content: route.argsText, source: 'user', topic: 'general',
            ...(event.senderOpenId ? { createdBy: event.senderOpenId } : {}), messageId: event.messageId });
          await replyCard('已记住', `**已保存为本聊天记忆 \`${entry.id}\`。**\n\n${larkCommandEcho(entry.content, 200)}\n\n之后本聊天的每轮任务都会带给 Agent。查看：\`/memory\`；删除：\`/forget ${entry.id}\`。`);
          return 'handled';
        }
        const [id, ...extra] = route.args;
        if (!isLarkMemoryId(id) || extra.length) {
          await replyCard('/forget 未执行', '**用法：`/forget <记忆编号>`**\n\n编号形如 `mem_1a2b3c4d`，发送 `/memory` 查看。', { failed: true });
          return 'handled';
        }
        const removed = await memory.remove(scope, id, event.senderOpenId);
        if (!removed) {
          await replyCard('/forget 未执行', `**本聊天没有编号为 \`${id}\` 的记忆。**\n\n发送 \`/memory\` 查看当前记忆。`, { failed: true });
          return 'handled';
        }
        await replyCard('已忘记', `**已删除记忆 \`${removed.id}\`。**\n\n${larkCommandEcho(removed.content, 200)}\n\n之后的任务不再带上这条记忆。`);
        return 'handled';
      }
      if (route.command === 'cancel') {
        // 内存里还有这一轮时走原分支：它持有 requestUpdate，能把进度卡就地收敛成取消收据。
        if (latestTask && ['queued', 'running'].includes(latestTask.state)) {
          const result = await this.handleAction(
            { action: latestTask.state === 'queued' ? 'cancel' : 'interrupt', task_id: latestTask.id, turn: String(latestTask.turn) },
            event.senderOpenId
          );
          await replyCard(result?.type === 'success' ? '/cancel 已受理' : '/cancel 未执行', `**${result?.content ?? '停止请求未完成'}**`, { failed: result?.type !== 'success' });
          return 'handled';
        }
        // 重建之后内存是空的，判据只能来自 runtime 的真实任务状态。
        const target = sessionId ? await this.findLiveRuntimeTask(sessionId) : undefined;
        if (!target) {
          await replyCard('/cancel 未执行', '**当前没有正在排队或执行的任务。**\n\n发送新的请求即可开始一轮执行。', { failed: true });
          return 'handled';
        }
        if (!await this.isTaskOperatorAllowed(config, event, target)) {
          await replyCard('/cancel 未执行', '当前账号没有操作此任务的权限。', { failed: true });
          return 'handled';
        }
        // 停止原语必须真的被调用；调不动就说调不动，不发一句空口「已受理」。
        if (target.status === 'queued') {
          if (!this.runtime.cancelQueued) {
            await replyCard('/cancel 未执行', '**当前 Dutydeck 运行时无法取消排队任务。**\n\n请前往 Dutydeck Web 处理。', { failed: true });
            return 'handled';
          }
          await this.runtime.cancelQueued(target.sessionId, target.id, event.senderOpenId);
        } else {
          await this.runtime.interrupt(target.sessionId, target.id, event.senderOpenId);
        }
        await replyCard(
          '/cancel 已受理',
          `**已${target.status === 'queued' ? '取消排队任务' : '请求中断当前任务'}。**\n\n${
            target.status === 'queued' ? '该任务不会再执行。' : '任务停止后会更新原任务卡。'
          }`
        );
        return 'handled';
      }
      if (route.command === 'retry') {
        // /retry 一律是一个新任务，绝不复用旧 task 的 event/config——旧 handleAction 会
        // 沿用原发起人的身份与当时的配置，让「Alice 有高危授权、Bob 点重试」变成
        // Bob 借 Alice 的权限执行。恢复出原 prompt 后交给正常建任务链路，由当前
        // event.senderOpenId 与当前 config 重新过授权与风险检查。
        const runtimeTasks = sessionId && this.runtime.getTasks ? await this.runtime.getTasks(sessionId) : undefined;
        const target = this.pickRetryableRuntimeTask(runtimeTasks);
        // runtime 有这个会话的任务记录时一律以它为准；只有完全没有记录（旧运行时没有
        // getTasks，或这一轮还没落库）才回落到内存里的这一轮，且同样只取 prompt。
        const memoryTask = !runtimeTasks?.length && latestTask && ['failed', 'interrupted', 'cancelled'].includes(latestTask.state)
          ? latestTask
          : undefined;
        if (!target && !memoryTask) {
          await replyCard('/retry 未执行', '**只有失败、已中断或已取消的任务可以重试。**\n\n当前没有可重试的任务，请直接发送新的请求。', { failed: true });
          return 'handled';
        }
        const retryAllowed = target ? await this.isTaskOperatorAllowed(config, event, target)
          : await this.isOperatorAllowed(config, event.senderOpenId, event.chatId, memoryTask?.sessionId, memoryTask?.event.senderOpenId);
        if (!retryAllowed) {
          await replyCard('/retry 未执行', '当前账号没有操作此任务的权限。', { failed: true });
          return 'handled';
        }
        // 原请求只认本 App channel 里、app_id/chat_id 与 runtime_task_id 都对得上的那条记录；
        // 恢复不出来就直说，绝不拿别处或相邻一轮的 prompt 凑一个「看起来能跑」的重试。
        const restored = target
          ? await this.restoreRetryPrompt(config, event, target)
          : memoryTask?.prompt?.trim() ? { prompt: memoryTask.prompt, materialPrompt: memoryTask.retryMaterialPrompt ?? memoryTask.prompt } : undefined;
        if (!restored) {
          await replyCard('/retry 未执行', '**找不到这一轮的原始请求内容，无法重试。**\n\n请重新发送你的请求。', { failed: true });
          return 'handled';
        }
        return restored;
      }
      if (route.command === 'new') {
        // 任务内容随 /new 一起到达时，本条消息既要结束旧上下文、又要派发新任务。
        const request = parseLarkNewSession(route.argsText);
        const beforeValidation = group.epoch ?? 0;
        if (request.launchOptions) request.launchOptions = await this.validateNewSession(config, event, request.launchOptions);
        if (beforeValidation !== (group.epoch ?? 0)) throw new Error('已有更新的 /new 请求，请在新上下文中重新发送。');
        const retirement = this.retireScopeSession(group, config, event, scopeId);
        const epoch = group.epoch;
        const retired = await retirement;
        const goal = request.prompt;
        if (goal) {
          // reaction 仍挂在原消息上，交给随后的建任务链路按正常节奏撤销——
          // 这里不发命令回执，因为用户马上会收到这条新任务的进度卡。
          return { ...request, epoch };
        }
        await replyCard(
          '/new 已受理',
          retired
            ? '**已结束当前会话，下一条消息将开启全新上下文。**\n\n历史记录仍可在 Dutydeck Web 查看。'
            : '**当前没有已绑定的会话，下一条消息会直接开启新会话。**'
        );
        return 'handled';
      }
    } catch (error) {
      this.log.warn({ error, command: route.command, messageId: event.messageId }, '执行飞书聊天命令失败');
      await replyCard(`/${route.command} 执行失败`, `**命令未能完成。**\n\n${error instanceof Error ? error.message : String(error)}\n\n可稍后重试，或前往 Dutydeck Web 处理。`, { failed: true });
    }
    return 'handled';
  }

  /**
   * 在聊天里改本群的对话授权。唯一写入路径仍是 LarkGroupManager.save（与 Web 的 PUT 同一条），
   * 本方法只负责：定位当前授权 → 过授权门 → 把 @ 到的人解析成 principal → 算出新的 accessOverride。
   *
   * 三条硬规则：
   * 1. 群没有同步/绑定就直说没有可改的授权，绝不替用户新建一份群配置；
   * 2. 带参数（含 @）却解析不出群成员时整条命令失败，绝不静默按「放开全员」处理；
   * 3. 回执必须写出改完之后谁能用，而不是只说一句「已更新」。
   */
  private async executeGrantCommand(
    command: 'grant' | 'revoke',
    event: LarkMessageEvent,
    config: StoredLarkConfig,
    argsText: string,
    replyCard: (taskName: string, markdown: string, options?: { elements?: LarkCardElement[]; failed?: boolean }) => Promise<void>
  ): Promise<'handled'> {
    const manager = this.groupManager;
    if (!manager || event.chatType !== 'group') throw new Error('只有群聊里才有可修改的对话授权。');
    const state = await manager.groupAccess(config.appId, event.chatId);
    if (!state) throw new Error('本群还没有在 Dutydeck 中同步群配置，聊天里没有可修改的授权。请管理员先在 Dutydeck Web 同步此机器人的群聊。');
    if (!await this.isGrantOperatorAllowed(config, event.senderOpenId, event.chatId, command === 'grant' ? 'grant.create' : 'grant.revoke')) {
      await replyCard(`/${command} 未执行`, '当前账号没有修改本群授权的权限：需要本机器人的管理员，或已被授予高风险操作权限的群成员。', { failed: true });
      return 'handled';
    }
    // 目标成员只认真实的飞书提及（带 open_id），机器人自己的提及不算目标。
    const mentioned = event.mentions.filter(mention => mention.openId && mention.openId !== this.botOpenId);
    if (!mentioned.length && argsText) {
      throw new Error('请用 @ 选中要操作的群成员，例如 `/grant @张三`。纯文字的名字解析不出群成员身份。');
    }
    const targets: string[] = [];
    const unresolved: string[] = [];
    for (const mention of mentioned) {
      const principal = await manager.resolveGroupPrincipal(config.appId, event.chatId, mention.openId!);
      if (principal) targets.push(principal);
      else unresolved.push(mention.name || mention.openId!);
    }
    if (unresolved.length) {
      throw new Error(`这些成员解析不到本群身份，本次授权没有做任何修改：${unresolved.map(name => larkCommandEcho(name, 40)).join('、')}。请确认他们仍在本群中。`);
    }
    // 基准只取**本群自己**的名单。继承来的机器人默认名单不是本群的 principal，
    // 把它抄进群覆盖会写进一批没登记过身份的 principal，被 save 的作用域校验直接打回。
    const own = state.override.mode === 'allowlist' ? state.override.principalIds : undefined;
    if (command === 'revoke' && targets.length && !own) {
      throw new Error(`本群现在不是按名单授权（当前：${describeLarkAccess(state.effective.mode)}），没有可移除的名单。要整体收回请直接发送 \`/revoke\`；要改成名单请先用 \`/grant @成员\` 建立。`);
    }
    const next = targets.length
      ? (() => {
        const list = new Set(own ?? []);
        for (const id of targets) command === 'grant' ? list.add(id) : list.delete(id);
        return list.size
          ? { mode: 'allowlist' as const, principalIds: [...list] }
          : { mode: 'owner_only' as const, principalIds: [] };
      })()
      : command === 'grant'
        ? { mode: 'all_chat_members' as const, principalIds: [] }
        : { mode: 'owner_only' as const, principalIds: [] };
    await manager.save(config.appId, event.chatId, { expectedRevision: state.revision, patch: { accessOverride: next } });
    const summary = next.mode === 'all_chat_members' ? '本群所有成员都可以使用本机器人'
      : next.mode === 'allowlist' ? `仅名单内 ${next.principalIds.length} 人可以使用本机器人`
        : '仅本机器人的管理员可以使用';
    // 建了本群自己的名单就必须写出改之前是什么。从「继承机器人默认」切到群名单时，
    // 原先按机器人默认（allowedUsers / allowedEmails）放行的人会一起失效——
    // 这一步恰恰是用户最容易没想到的，必须显式说出来，不能只报改完的结果。
    const narrowed = next.mode !== 'allowlist' || state.override.mode === 'allowlist' ? ''
      : state.override.mode === 'inherit'
        ? `\n\n此前本群继承机器人默认授权（${describeLarkAccess(state.effective.mode)}），现在改为本群自己的名单：原先按机器人默认放行的成员不再自动可用。`
        : `\n\n此前本群是「${describeLarkAccess(state.effective.mode)}」，现在改为本群自己的名单。`;
    const oncall = state.oncall ? '\n\n本群仍处于值班模式：值班期间所有群成员都能使用，名单要等关闭值班后才生效。' : '';
    // 「谁能用」不止这一条口径：Web 上单独授予过 can_talk / can_operate 角色的成员
    // 不受群 access 影响，回执不能把结论说成排他的。
    await replyCard(`/${command} 已生效`, `**本群授权已改为：${summary}。**${narrowed}${oncall}\n\n在 Dutydeck Web 上单独授予过角色的成员不受本命令影响，需要到 Web 上撤销。`);
    return 'handled';
  }

  /**
   * 「提到队首」会中断当前正在执行的那一轮（runtime 的 promoteQueued 带 interrupt），
   * 所以除了队列自己的 queue.promote，还必须过与 /cancel 同一道 run.interrupt 门。
   * 当前没有正在执行的任务时没有可中断的对象，直接放行。
   */
  private async canInterruptCurrentTurn(config: StoredLarkConfig, event: LarkMessageEvent, sessionId: string): Promise<boolean> {
    const running = this.runtime.getTasks ? (await this.runtime.getTasks(sessionId)).find(task => task.status === 'running') : undefined;
    return !running || await this.isTaskOperatorAllowed(config, event, { id: running.id, sessionId });
  }

  /**
   * 修改本群授权（/grant、/revoke）的鉴权。
   *
   * - 托管群：先按 grant.create / grant.revoke 策略动作判定（owner 或 admin 角色）。
   *   本部署形态下 admin 角色只能由安装管理员在 Web 授予，因此未通过时回落到与 /repair
   *   同一道安装级门（high_risk.execute）——改「谁能使唤机器人」至少和跑一条高风险命令同级。
   * - 非托管群：回落部署级静态白名单，与该形态下其他管理动作口径一致。
   */
  private async isGrantOperatorAllowed(config: StoredLarkConfig, operatorOpenId: string | undefined, chatId: string, action: PolicyAction): Promise<boolean> {
    if (!operatorOpenId) return false;
    const decision = await this.groupManager?.authorize(config.appId, chatId, operatorOpenId, action);
    if (decision?.allowed) return true;
    return this.isInstallationOperatorAllowed(config, operatorOpenId, chatId);
  }

  /**
   * 当前会话里正在排队或执行的那一轮，取最近创建的一条。
   * 判据来自 runtime 的真实任务记录，不看重启前留在卡片上的 state。
   */
  private async findLiveRuntimeTask(sessionId: string) {
    if (!this.runtime.getTasks) return undefined;
    const tasks = await this.runtime.getTasks(sessionId);
    return [...tasks].reverse().find(task => task.status === 'queued' || task.status === 'running');
  }

  /**
   * 当前会话**最近**那一轮，且它确实是失败或被中断。
   *
   * 刻意不是 `reverse().find(failed)`：那会越过最新的 completed/running/queued，
   * 把用户早就放下的旧请求重新跑一遍。语义与内存里的 latestTask 一致——只看最近一轮，
   * 它不可重试就诚实地说没有可重试的任务。
   */
  private pickRetryableRuntimeTask(tasks?: TaskRecord[]) {
    const latest = tasks?.at(-1);
    return latest && (latest.status === 'failed' || latest.status === 'interrupted' || latest.status === 'cancelled') ? latest : undefined;
  }

  /**
   * 恢复一轮运行的原始请求文本。
   *
   * 两道硬条件，缺一即失败（fail-closed）：
   * 1. 只在本 App 的卡片 channel 里找，且 app_id / chat_id 与当前命令一致——ou_/oc_
   *    这些 id 在不同 App 下含义不同，拿错一条就会把别的 App、别的聊天的请求重发出去。
   * 2. `runtime_task_id` 必须精确等于重试目标。同一会话里相邻那轮的 prompt 不是这一轮的
   *    prompt，拿它顶替等于替用户执行了一件他没要求的事。
   *
   * prompt 保留原用户目标；retry_material_prompt 单独保存身份/策略注入前的材料与附件说明。
   * 旧记录没有独立材料字段时，沿用当时保存的 prompt。身份与策略在重试时重新生成。
   */
  private async restoreRetryPrompt(
    config: StoredLarkConfig,
    event: LarkMessageEvent,
    target: { id: string; sessionId: string }
  ): Promise<LarkCommandPrompt | undefined> {
    if (!this.cardMappings) return undefined;
    const mappings = await this.cardMappings.list(larkCardChannel(config.appId));
    for (const mapping of mappings) {
      if (mapping.sessionId !== target.sessionId || !mapping.extra) continue;
      let persisted: PersistedLarkCardTask;
      try { persisted = JSON.parse(mapping.extra) as PersistedLarkCardTask; }
      catch { continue; }
      if (persisted.app_id !== config.appId || persisted.chat_id !== event.chatId) continue;
      if (!persisted.runtime_task_id || persisted.runtime_task_id !== target.id) continue;
      const prompt = typeof persisted.prompt === 'string' ? persisted.prompt.trim() : '';
      if (prompt) return { prompt, materialPrompt: persisted.retry_material_prompt ?? prompt };
    }
    return undefined;
  }

  /**
   * 只读定位当前 App + chat + scope 的持久化会话。
   *
   * 查询失败**不吞**：调用方会把异常变成一条「命令执行失败」的回执。诚实地说不知道，
   * 好过让 /status 谎称没有会话、让 /new 在什么都没停掉的情况下回「已受理」。
   */
  private async findScopeSession(config: StoredLarkConfig, event: LarkMessageEvent, scopeId: string, group: LarkGroup) {
    const session = await findPersistedLarkSession(this.runtime, config, event.chatId, event.chatType, scopeId, this.cardMappings);
    return session && !group.retiredSessionIds?.has(session.id) ? session : undefined;
  }

  /**
   * 结束一个上下文的**全部**可复用会话。
   *
   * 关键不变量：返回之后，同一 App/chat/scope/config 下不能再有任何一条会话被
   * resolveLarkSession 选回来。因此目标是 listPersistedLarkSessions 的全集（与普通消息
   * 同一份 larkSessionMatchesScope 判据），而不是「最近那一条」。
   *
   * 另外三件事缺一不可：
   * 1. 递增 epoch —— 已经在跑、但还没走到派发那一步的旧任务（正在下载附件、解析身份、
   *    或卡在 runtime.start）必须作废，否则它会在「已结束」回执之后把旧 prompt 发出去。
   * 2. 等 pendingSession —— 建会话是短操作。等它落地才能把这条刚建出来的会话一并停掉；
   *    但绝不等 group.tail：fallback 路径的 tail 要等整轮 send 结束，把它当锁会让 /new
   *    在长任务期间永远停不下来。
   * 3. 先登记 retired 再 stop —— runtime.stop 落库前会话状态仍是 idle，
   *    不先登记，stop 期间到达的消息会重新命中它。
   *
   * 只 stop 本轮真正还能被选回来的会话：已经是 failed/stopped 的，resolveLarkSession
   * 本来就不会复用，重复 /new 不该再对它们发一次 stop。反过来，上一次 stop 失败的会话
   * 仍然是活跃状态，于是它自然又出现在本轮目标里——重试不需要额外记账，也不能因为
   * 「已在 retired 集合里」就跳过。
   */
  private async retireScopeSession(group: LarkGroup, config: StoredLarkConfig, event: LarkMessageEvent, scopeId: string) {
    if (!event.senderOpenId) throw new Error('缺少操作人身份，无法重开会话。');
    if (!this.runtime.stop) throw new Error('当前运行时无法结束会话，请前往 Dutydeck Web 处理。');
    group.epoch = (group.epoch ?? 0) + 1;
    // 查询失败不吞：调用方会把异常变成一条「命令执行失败」的回执。
    const persisted = await listPersistedLarkSessions(this.runtime, config, event.chatId, event.chatType, scopeId, this.cardMappings);
    const pendingSessionId = (await group.pendingSession?.catch(() => undefined))?.id;
    const targets = new Set([
      ...persisted.filter(session => !['failed', 'stopped'].includes(session.state)).map(session => session.id),
      pendingSessionId,
      group.sessionId
    ].filter((id): id is string => Boolean(id)));
    const retired = (group.retiredSessionIds ??= new Set());
    for (const id of targets) retired.add(id);
    group.sessionId = undefined;
    group.sessionConfigKey = undefined;
    const stopped = new Set<string>();
    try {
      for (const id of targets) {
        await this.runtime.stop(id, { kind: 'channel', id: event.senderOpenId, appId: config.appId });
        stopped.add(id);
      }
    } catch (error) {
      // A rejected stop must remain visible in this scope. In particular, do
      // not silently select a new session around an unconfirmed old process.
      for (const id of targets) if (!stopped.has(id)) retired.delete(id);
      throw error;
    }
    return targets.size > 0;
  }

  /**
   * 汇总会话/Agent/工作区/排队状态，口径与 Web 保持一致：运行数与待执行指令数分开。
   *
   * 有实际会话时以**会话自己的** agentId / cwd 为准：配置可能在会话创建之后被改过，
   * 照着配置写会告诉用户一个它其实没在用的 Agent。配置与会话不一致时两者都列出来。
   */
  private async describeChatStatus(config: StoredLarkConfig, sessionId?: string, latestTask?: LarkTask): Promise<string> {
    const lines: string[] = [];
    const configuredAgent = config.defaultAgentId ?? 'Dutydeck';
    if (!sessionId) {
      lines.push(`**Agent**：${larkCommandEcho(configuredAgent, 64)}`);
      if (config.workspace) lines.push(`**工作区**：${larkCommandEcho(config.workspace, 160)}`);
      lines.push(larkExecutionIdentityLine());
      lines.push('这条消息不在已有任务话题中。请回原话题查询，或发送 `/tasks` 查看任务。');
      return lines.join('\n\n');
    }
    let session: Session | undefined;
    let sessionError = false;
    try {
      session = await this.runtime.getSession(sessionId);
    } catch (error) {
      this.log.warn({ error, sessionId }, '读取会话状态失败');
      sessionError = true;
    }
    lines.push(`**Agent**：${larkCommandEcho(session?.agentId ?? configuredAgent, 64)}`);
    if (session && session.agentId !== config.defaultAgentId) {
      lines.push(`**配置的 Agent**：${larkCommandEcho(configuredAgent, 64)}（下一个新会话生效）`);
    }
    const workspace = session?.cwd ?? config.workspace;
    if (workspace) lines.push(`**工作区**：${larkCommandEcho(workspace, 160)}`);
    if (session?.model) lines.push(`**模型**：${larkCommandEcho(session.model, 128)}`);
    if (session?.reasoningEffort) lines.push(`**推理强度**：${larkCommandEcho(session.reasoningEffort, 32)}`);
    if (session && config.workspace && session.cwd !== config.workspace) {
      lines.push(`**配置的工作区**：${larkCommandEcho(config.workspace, 160)}（下一个新会话生效）`);
    }
    lines.push(`**会话**：\`${larkCommandEcho(sessionId, 64)}\``);
    lines.push(larkExecutionIdentityLine());
    if (sessionError) lines.push('**运行状态**：读取失败，请前往 Dutydeck Web 查看。');
    else if (session) lines.push(`**运行状态**：${larkCommandEcho(session.state, 32)}`);
    else lines.push('**运行状态**：会话记录已不存在，发送新的请求会开启新会话。');
    if (this.runtime.getTasks) {
      try {
        const tasks = await this.runtime.getTasks(sessionId);
        const queued = tasks.filter(task => task.status === 'queued').length;
        const running = tasks.filter(task => task.status === 'running').length;
        // 排队运行数与待执行指令数是两个口径，必须分开表达，不混用。
        const unresolved = tasks.filter(task => ['reconcile_required', 'legacy_unresolved'].includes(task.status));
        lines.push(`**执行中的运行**：${running} 个　**待执行指令**：${queued} 条　**需要核对**：${unresolved.length} 条`);
        for (const task of [...unresolved, ...tasks.filter(task => task.status === 'queued')].slice(0, 3)) {
          const recovery = await describeLarkTaskRecovery(this.runtime, sessionId, task.id, task.status);
          lines.push(`${larkCommandEcho(task.prompt, 80)}\n\n${recovery.markdown}`);
        }
      } catch (error) {
        this.log.warn({ error, sessionId }, '读取任务队列失败');
      }
    }
    if (latestTask) lines.push(`**最近一轮**：${larkCommandEcho(latestTask.state, 32)}`);
    return lines.join('\n\n');
  }

  /**
   * 卡片操作人的访问权限校验，与 runTurn 中「谁可以使用 Agent」的配置保持一致：
   * - 未配置白名单时所有人均可操作
   * - 配置了 allowedUsers 时按 openId 匹配
   * - 仅配置 allowedEmails 时拉取操作人邮箱匹配
   */
  private async isTaskOperatorAllowed(config: StoredLarkConfig, event: LarkMessageEvent, target: { id: string; sessionId: string }, action: PolicyAction = 'run.interrupt') {
    let requester = [...this.tasks.values()].find(task => task.runtimeTaskId === target.id && task.sessionId === target.sessionId
      && task.config.appId === config.appId && task.event.chatId === event.chatId)?.event.senderOpenId;
    if (!requester) {
      for (const mapping of await this.cardMappings?.list(larkCardChannel(config.appId)) ?? []) {
        if (mapping.sessionId !== target.sessionId) continue;
        const saved = JSON.parse(mapping.extra ?? '{}') as PersistedLarkCardTask;
        if (saved.app_id === config.appId && saved.chat_id === event.chatId && saved.runtime_task_id === target.id) {
          requester = saved.sender_open_id;
          break;
        }
      }
    }
    // Historical records without a requester cannot establish own_runs authority.
    if (config.managedGroup && !requester) return false;
    return this.isOperatorAllowed(config, event.senderOpenId, event.chatId, target.sessionId, requester, action);
  }

  /** action 默认 run.interrupt（既有口径）；队列操作传 queue.cancel / queue.promote，走同一套判定。 */
  private async isOperatorAllowed(config: StoredLarkConfig, operatorOpenId?: string, chatId?: string, sessionId?: string, taskRequesterOpenId?: string, action: PolicyAction = 'run.interrupt'): Promise<boolean> {
    if (this.groupManager && chatId) {
      const decision = await this.groupManager.authorize(config.appId, chatId, operatorOpenId, action, sessionId, { taskRequesterOpenId });
      if (decision) return decision.allowed;
    }
    return this.isStaticOperatorAllowed(config, operatorOpenId, chatId);
  }

  /**
   * 部署级静态白名单口径（不经过托管群策略）：allowedUsers/allowedEmails/allowedBots。
   * 未配置任何白名单时维持「不限制」的既有默认；bot 身份（230001）按 peer bot 门处理。
   */
  private async isStaticOperatorAllowed(config: StoredLarkConfig, operatorOpenId?: string, chatId?: string): Promise<boolean> {
    const allowedUsers = config.allowedUsers ?? [];
    const allowedEmails = config.allowedEmails ?? [];
    const allowedBots = config.allowedBots ?? [];
    const peerBotsAllowed = config.peerBotsAllowed !== false;
    const accessRestricted = allowedUsers.length > 0 || allowedEmails.length > 0;
    if (!accessRestricted) return true;
    if (!operatorOpenId) return false;
    if (allowedUsers.some(user => user.openId === operatorOpenId)) return true;
    if (allowedBots.some(bot => bot.openId === operatorOpenId)) return true;
    try {
      const emails = await this.service.getUserEmails(operatorOpenId);
      return emails.some(email => allowedEmails.includes(email));
    } catch (error) {
      // 通讯录 API 找不到该 open_id 对应的用户（Feishu 错误码 230001），
      // 说明操作人是机器人——bot 不在企业通讯录中。
      // 白名单为"所有人"时已在上方放行；白名单受限则需校验是否为 peer bot 或已加入机器人白名单。
      const upstreamCode = error instanceof LarkServiceError ? Number(error.details?.upstreamCode) : undefined;
      if (upstreamCode === 230001) {
        return Boolean(peerBotsAllowed && config.groupToolsEnabled && chatId && await this.peerBotAuthorized?.(chatId, operatorOpenId));
      }
      this.log.warn({ error, operatorOpenId, upstreamCode }, '获取卡片操作人邮箱失败，按无权限处理');
      return false;
    }
  }

  /**
   * 安装级管理动作（当前仅 /repair 发布飞书应用版本，不可撤销、作用于整个应用而非单个任务）
   * 的鉴权。绝不能复用 run.interrupt 的 own_runs 语义：托管群开放模式下任何能发言的成员
   * 都有「操作本人任务」权，但那不构成发布应用的授权。
   *
   * - 托管群：必须通过 high_risk.execute 门（安装 owner，或被显式授予 highRisk 角色）；
   *   普通 can_talk / own_runs 成员拒绝，即使静态白名单为空。
   * - 非托管群（策略无绑定、authorize 返回 undefined）：回落部署级静态白名单，
   *   与该部署形态下任务操作的既有口径一致。
   */
  private async isInstallationOperatorAllowed(config: StoredLarkConfig, operatorOpenId?: string, chatId?: string): Promise<boolean> {
    if (!operatorOpenId) return false;
    if (this.groupManager && chatId) {
      const decision = await this.groupManager.authorize(config.appId, chatId, operatorOpenId, 'high_risk.execute');
      if (decision) return decision.allowed;
    }
    return this.isStaticOperatorAllowed(config, operatorOpenId, chatId);
  }

  /**
   * 撤销「请求已接入」的 OK reaction。
   * 设计契约（见 docs/interaction-design-2026-08-30.md §4.1）：reaction 只是回执，
   * 进度卡或失败回执一旦送达就必须移除，不允许 reaction 与卡片两个状态并存。
   * 撤销失败只记日志、不阻断任务执行；reactionId 先清空再调用，保证幂等——
   * 重复调用（正常路径 + 异常兜底）不会重复打 OpenAPI。
   */
  private async clearAcknowledgementReaction(task: LarkTask) {
    const reactionId = task.acknowledgementReactionId;
    task.acknowledgementReactionId = undefined;
    if (!reactionId) return;
    try { await this.service.deleteReaction(task.event.messageId, reactionId); }
    catch (error) { this.log.warn({ error, messageId: task.event.messageId, reactionId }, '撤销飞书确认表情失败'); }
  }

  private pushTaskError(task: LarkTask, message: string) {
    task.events.push({
      id: `lark-action-error-${task.id}-${Date.now()}`,
      sessionId: task.sessionId ?? '',
      sequence: Number.MAX_SAFE_INTEGER,
      type: 'error',
      timestamp: new Date().toISOString(),
      data: { message }
    });
  }

  /**
   * 从 runtime 实际能力 + 任务当前状态派生按钮能力，供渲染端与回调端共用。
   * 每一项都对应 handleAction 里真实的执行前置条件，因此界面上出现的按钮
   * 一定能被执行——这是「不发死按钮」的唯一保证方式。
   */
  private capabilitiesForTask(task: LarkTask): LarkCardCapabilities {
    const webBaseUrl = task.config.webBaseUrl?.trim().replace(/\/$/, '');
    return {
      // 与 handleAction 的 cancel 分支前置条件逐项对齐。
      canCancelQueued: Boolean(this.runtime.cancelQueued && task.sessionId && task.runtimeTaskId),
      canInterrupt: typeof this.runtime.interrupt === 'function' && Boolean(task.sessionId),
      canRetry: task.retryable !== false,
      // requestUpdate 在轮次结束时被清空，因此已结束的轮次不会出现「刷新」。
      canRefresh: typeof task.requestUpdate === 'function',
      ...(webBaseUrl
        ? { webUrl: `${webBaseUrl}/sessions${task.sessionId ? `/${encodeURIComponent(task.sessionId)}` : ''}` }
        : {})
    };
  }

  /**
   * 结果卡续问行的能力：一键续问与「每天 HH:MM 自动执行」。结果卡投递、对账补发、验证与验收重绘
   * 和回调端都从这里取，渲染出的按钮与后端接受的点击因此是同一个判断。只有已完成的卡才有续问行。
   */
  private async resultActionCapabilities(task: LarkTask, config: StoredLarkConfig, state: string): Promise<Pick<LarkCardCapabilities, 'canFollowUp' | 'dailySchedule'>> {
    if (state !== 'completed') return {};
    let continues = false;
    try { continues = await this.continuesSession(task, config); }
    catch (error) { this.log.warn({ error, taskId: task.id }, '确认会话能否续聊失败，本卡不给续问按钮'); }
    if (!continues) return {};
    const dailySchedule = await this.dailyScheduleView(task, config).catch(error => {
      this.log.warn({ error, taskId: task.id }, '判定重复请求失败，本卡不提议定时');
      return undefined;
    });
    return {
      // 续问要先落去重键、再由机器人在原位置代发这句话，缺持久化存储或回复接口就不给按钮。
      ...(this.inbox && typeof this.service.replyText === 'function' ? { canFollowUp: true } : {}),
      ...(dailySchedule ? { dailySchedule } : {})
    };
  }

  /**
   * 这张卡所属的会话此刻还能不能接着问：会话还在、没被 /new 结束，而且正是在原位置再发一句时
   * 会复用的那一条。配置变了会换新会话，那时「重新说一遍上面的结论」就没有上文了。
   */
  private async continuesSession(task: LarkTask, config: StoredLarkConfig) {
    if (!task.sessionId || !task.scopeId) return false;
    const session = await this.runtime.getSession(task.sessionId);
    if (!session || ['failed', 'stopped'].includes(session.state) || session.archivedAt) return false;
    const group = this.groups.get(larkGroupKey(task.event, task.scopeId, config.appId));
    if (group?.retiredSessionIds?.has(session.id)) return false;
    // 与 resolveLarkSession 同一个优先级：内存绑定优先，缺失时按持久化会话定位。
    if (group?.sessionId && !group.retiredSessionIds?.has(group.sessionId)) {
      return group.sessionId === session.id && Boolean(config.managedGroup || group.sessionConfigKey === larkSessionConfigKey(config));
    }
    return (await findPersistedLarkSession(this.runtime, config, task.event.chatId, task.event.chatType, task.scopeId, this.cardMappings))?.id === session.id;
  }

  /**
   * 重复请求时提议「每天 HH:MM 自动执行」：同一发起人在同一个聊天里、14 天内已有别的任务发过
   * 规范化后相同的请求，且这个话题还没有同样内容的已启用计划。时刻取本次任务的开始时间（北京时间）。
   * 这张卡已经建过计划、计划仍启用时返回 scheduled，按钮画成「已设为…」。
   */
  private async dailyScheduleView(task: LarkTask, config: StoredLarkConfig): Promise<LarkCardCapabilities['dailySchedule']> {
    const automation = this.workflowOptions.automation;
    const store = this.workflowOptions.store;
    const requester = task.event.senderOpenId;
    const startedAt = task.startedAt;
    if (!automation || !store?.compareAndSet || !this.cardMappings || !task.sessionId || !startedAt || !requester) return undefined;
    const request = larkRequestText(task.prompt, config.name);
    if (!request || isLarkCardFollowUpPrompt(task.prompt)) return undefined;
    const raw = await store.get(dailyScheduleKey(config.appId, resultActionDigest(task.id, task.turn)));
    const record = raw ? JSON.parse(raw) as LarkDailyScheduleRecord : undefined;
    if (record?.state !== 'created') {
      const repeated = (await this.cardMappings.list(larkCardChannel(config.appId))).some(mapping => {
        if (mapping.externalId === task.id) return false;
        try {
          const other = JSON.parse(mapping.extra ?? '{}') as PersistedLarkCardTask;
          return other.app_id === config.appId && other.chat_id === task.event.chatId && other.sender_open_id === requester
            && other.started_at <= startedAt && startedAt - other.started_at <= repeatedRequestWindowMs
            && larkRequestText(other.prompt ?? '', config.name) === request;
        } catch { return false; }
      });
      if (!repeated) return undefined;
    }
    const schedules = (await automation.listBySession(task.sessionId, requester)).schedules;
    if (record?.state === 'created') {
      return schedules.some(item => item.id === record.schedule_id && item.enabled) ? { time: record.time, scheduled: true } : undefined;
    }
    if (schedules.some(item => item.enabled && larkRequestText(item.prompt, config.name) === request)) return undefined;
    return { time: shanghaiClock(startedAt), scheduled: false };
  }

  /**
   * 续问行回调的目标。卡片上的值不可信：value 里的 task_id 只用来找持久化映射，随后核对被点的
   * 正是这一轮已经交付的结果卡；会话、群、话题与发起人一律取自服务端记录。
   */
  private async resultActionTarget(parsed: LarkCardActionValue, operatorOpenId?: string, context?: { messageId?: string; chatId?: string }): Promise<LarkResultActionTarget | { toast: { type: string; content: string } }> {
    const store = this.workflowOptions.store;
    if (!this.reconcileConfig || !this.cardMappings || !store?.compareAndSet || !operatorOpenId || !context?.messageId || !context.chatId) {
      return { toast: { type: 'error', content: '卡片身份不完整或已失效。' } };
    }
    const current = await readLarkConfig(store, this.reconcileConfig.appId);
    if (!current?.listening) return { toast: { type: 'warning', content: '机器人已停用，无法执行此操作' } };
    const mapping = await this.cardMappings.get(larkCardChannel(current.appId), parsed.taskId);
    const saved = mapping?.extra ? JSON.parse(mapping.extra) as PersistedLarkCardTask : undefined;
    if (!mapping || !saved || saved.app_id !== current.appId || saved.chat_id !== context.chatId || saved.final_message_id !== context.messageId
      || saved.state !== 'completed' || saved.final_delivery_state !== 'delivered' || !saved.scope_id) {
      return { toast: { type: 'warning', content: '此卡当前不可操作，请直接 @我 提问。' } };
    }
    if (parsed.turn !== saved.turn) return { toast: { type: 'warning', content: '任务已开始新一轮，请在最新的卡片上操作' } };
    const config = saved.chat_type === 'group' && this.groupManager ? await this.groupManager.resolved(current, saved.chat_id) : current;
    return { current, config, mapping, saved, task: this.restoredCardTask(config, mapping, saved), operator: operatorOpenId,
      scopeId: saved.scope_id, resultMessageId: context.messageId };
  }

  /**
   * 续问与定时的权限，返回拒绝理由。续问与在原话题里发一条消息完全一致：群策略 task.create、
   * 执行策略、部署白名单；定时与在原话题里发 /schedule 相同：再加命令白名单与任务操作权。
   * 两者都受续聊规则约束。handle、runTurn 与 SessionAutomationService 之后还会各自再判一遍。
   */
  private async resultActionDenied(target: LarkResultActionTarget, kind: 'follow_up' | 'schedule'): Promise<string | undefined> {
    const { config, saved, operator } = target;
    if (!larkScopeContinuesFor(target.scopeId, operator)) {
      return kind === 'follow_up' ? '这个会话只接发起人本人的追问，你可以直接 @我 提问。' : '这个会话只有发起人本人能设置定时任务。';
    }
    if (saved.chat_type === 'group' && this.groupManager) {
      // 被点的结果卡已核对过 chat 与 message_id，操作人就在这个群里：与收到一条群消息同一口径。
      const entry = await this.groupManager.authorize(config.appId, saved.chat_id, operator, 'task.create', undefined, { memberObserved: true });
      if (entry && !entry.allowed) return entry.code === 'talk_required' ? '当前账号没有此群的任务访问权限。' : entry.reason;
      if (kind === 'schedule') {
        const command = await this.groupManager.authorize(config.appId, saved.chat_id, operator, 'task.view_result');
        if (command && !command.allowed) return '当前账号不在机器人白名单中，无法执行 /schedule。';
      }
    }
    try { await this.requireExecution('listener', 'task.create'); }
    catch (error) { return error instanceof Error ? error.message : '机器人尚未获得运行权限。'; }
    if (kind === 'schedule') {
      return await this.isOperatorAllowed(config, operator, saved.chat_id, target.mapping.sessionId) ? undefined : '当前账号没有操作此任务的权限。';
    }
    return config.managedGroup || await this.isStaticOperatorAllowed(config, operator, saved.chat_id) ? undefined : '当前账号不在机器人白名单中，无法执行此操作';
  }

  /**
   * 一键续问：等同于操作人在原话题里回复一条固定文本。飞书回复接口只认真实消息，而任务的过程卡、
   * 结果投递与重启恢复都锚在「发起请求的那条消息」上，所以先由机器人在结果卡下代发这段话，
   * 再把它当作操作人的消息交给 handle，唤醒、授权、排队与会话复用全部走原路。
   * 请求原文与所属 scope 预先写进 inbox：handle 不会按代发消息的形态重新解析它，续问一定回到这张卡的会话。
   */
  private async submitResultFollowUp(parsed: LarkCardActionValue, operatorOpenId?: string, context?: { messageId?: string; chatId?: string }) {
    try {
      const target = await this.resultActionTarget(parsed, operatorOpenId, context);
      if ('toast' in target) return target.toast;
      const { current, config, saved, task, operator } = target;
      const denied = await this.resultActionDenied(target, 'follow_up');
      if (denied) return { type: 'warning', content: denied };
      const capabilities = { ...this.capabilitiesForTask(task), ...await this.resultActionCapabilities(task, config, 'completed') };
      if (!this.inbox || !isLarkCardActionAvailable(parsed.action, { state: 'completed', taskId: task.id, turn: task.turn, readOnly: true, capabilities })) {
        return { type: 'warning', content: '这个会话已结束或已换成新会话，无法接着问；请直接 @我 提问。' };
      }
      const store = this.workflowOptions.store!;
      const label = larkCardActionLabel(parsed.action, capabilities)!;
      const prompt = larkCardFollowUpPrompt(parsed.action)!;
      const digest = resultActionDigest(task.id, task.turn, parsed.action);
      const key = followUpClaimKey(config.appId, digest);
      const duplicate = { type: 'warning', content: `「${label}」已经提交过，请看下方的新一轮结果。` };
      const claim = JSON.stringify({ state: 'claimed', operator_open_id: operator, claimed_at: new Date().toISOString() });
      // 空串是放开后的去重键（配置存储没有删除接口），与「键不存在」一视同仁。
      if (!await store.compareAndSet!(key, undefined, claim) && !await store.compareAndSet!(key, '', claim)) return duplicate;
      let event: LarkMessageEvent;
      try {
        const echo = await this.service.replyText({ messageId: target.resultMessageId, ...(saved.thread_id ? { replyInThread: true } : {}),
          text: `「${label}」${prompt}`, idempotencyKey: `followup_${digest}` });
        event = {
          messageId: echo.messageId, chatId: saved.chat_id, chatType: saved.chat_type ?? 'group',
          ...(saved.thread_id ? { threadId: saved.thread_id } : {}), createTime: String(Date.now()),
          messageType: 'text', content: JSON.stringify({ text: `@_user_1 ${prompt}` }), senderOpenId: operator, senderType: 'user',
          // 按钮本身就是对机器人说话：带上 @机器人，唤醒走显式 @ 的原路，不必为 mentionPolicy 特判。
          mentions: [{ key: '@_user_1', name: config.name?.trim() || 'Dutydeck', ...(this.botOpenId ? { openId: this.botOpenId } : {}), mentionedType: 'bot' }]
        };
        if (!await this.inbox.seed(config.appId, event, { prompt, scopeId: target.scopeId, resources: [] })) return duplicate;
      } catch (error) {
        // 没能登记成待处理消息：放开去重键让用户能再点一次。代发消息带同一个幂等键，重点不会重复发出。
        await store.compareAndSet!(key, claim, '').catch(() => undefined);
        throw error;
      }
      await store.set(key, JSON.stringify({ ...JSON.parse(claim), state: 'submitted', message_id: event.messageId }))
        .catch(error => this.log.warn({ error, key }, '续问已登记，去重记录未更新'));
      void this.handle(event, current).catch(error => this.log.error({ error, messageId: event.messageId }, '处理结果卡续问失败'));
      return { type: 'success', content: `已提交「${label}」，新一轮结果稍后发在下方。` };
    } catch (error) {
      this.log.warn({ error, taskId: parsed.taskId, action: parsed.action }, '提交结果卡续问失败');
      return { type: 'error', content: '提交失败，请稍后重试。' };
    }
  }

  /**
   * 「每天 HH:MM 自动执行」：在这张卡所属的会话里用 cron 建一个每天执行同一请求的计划并启用，
   * 回报位置是原话题（与 /schedule 一样写 automation.delivery-target.*）。同一张卡只建一次：
   * 登记键先占位再建计划，建好后重绘结果卡，按钮改为「已设为…」。
   */
  private async scheduleResultDaily(parsed: LarkCardActionValue, operatorOpenId?: string, context?: { messageId?: string; chatId?: string }) {
    try {
      const target = await this.resultActionTarget(parsed, operatorOpenId, context);
      if ('toast' in target) return target.toast;
      const { config, mapping, saved, task, operator } = target;
      const automation = this.workflowOptions.automation;
      if (!automation) return { type: 'warning', content: '当前服务未接入定时任务。' };
      const denied = await this.resultActionDenied(target, 'schedule');
      if (denied) return { type: 'warning', content: denied };
      const actions = await this.resultActionCapabilities(task, config, 'completed');
      const view = actions.dailySchedule;
      if (view?.scheduled) return { type: 'success', content: `已设为每天 ${view.time} 自动执行。` };
      if (!view || !isLarkCardActionAvailable('schedule_daily', { state: 'completed', taskId: task.id, turn: task.turn, readOnly: true,
        capabilities: { ...this.capabilitiesForTask(task), ...actions } })) {
        return { type: 'warning', content: '这个话题已有同样内容的计划，或会话已结束，无法再设置。' };
      }
      const store = this.workflowOptions.store!;
      const digest = resultActionDigest(task.id, task.turn);
      const key = dailyScheduleKey(config.appId, digest);
      const claim = JSON.stringify({ state: 'creating', operator_open_id: operator, time: view.time } satisfies LarkDailyScheduleRecord);
      if (!await store.compareAndSet!(key, undefined, claim) && !await store.compareAndSet!(key, '', claim)) {
        return { type: 'warning', content: '定时任务正在设置，请勿重复点击。' };
      }
      let schedule: PublicSessionSchedule;
      try {
        const prompt = withoutLeadingBotMention(saved.prompt, config.name);
        const [hour, minute] = view.time.split(':').map(Number);
        schedule = await automation.createSchedule(mapping.sessionId, {
          name: prompt.slice(0, 100), prompt, trigger: { kind: 'cron', expression: `${minute} ${hour} * * *` },
          timezone: 'Asia/Shanghai', dstPolicy: { gap: 'skip', overlap: 'first' }, condition: { kind: 'always' }
        }, operator, {
          key: `${config.appId}:${task.id}:${task.turn}:daily`,
          prepareDelivery: async automationId => {
            await store.compareAndSet!(`automation.delivery-target.${automationId}`, undefined, JSON.stringify({ appId: config.appId, chatId: saved.chat_id, replyMessageId: task.id, replyInThread: saved.chat_type === 'group' }));
          }
        });
        if (!schedule.enabled) schedule = await automation.updateSchedule(mapping.sessionId, schedule.id, { expectedRevision: schedule.revision, enabled: true }, operator);
        await store.set(key, JSON.stringify({ state: 'created', operator_open_id: operator, time: view.time, schedule_id: schedule.id } satisfies LarkDailyScheduleRecord));
      } catch (error) {
        await store.compareAndSet!(key, claim, '').catch(() => undefined);
        this.log.warn({ error, taskId: task.id }, '设置每天自动执行失败');
        return { type: 'error', content: `设置失败：${error instanceof Error ? error.message : String(error)}` };
      }
      // 原样重绘同一张结果卡：验证状态行按最新记录重算，续问行里的定时按钮改为「已设为…」。
      if (saved.final_elements?.length) {
        await this.refreshResultVerification(task, config).catch(error => this.log.warn({ error, taskId: task.id }, '定时任务已建好，结果卡按钮未能更新'));
      }
      const nextDue = schedule.nextDueAt
        ? `${new Date(schedule.nextDueAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）` : '未排定';
      await sendTaskCard(this.service, { ...task.event, messageId: target.resultMessageId }, {
        state: 'completed', readOnly: true, retryable: false, taskId: task.id, taskName: '定时任务',
        markdown: `**已设为每天 ${view.time} 自动执行「${larkCommandEcho(schedule.name, 100)}」。**\n\n下一次：${nextDue}\n\n停用：\`/schedule disable ${schedule.id}\``,
        idempotencyKey: `daily_${digest}`
      }, this.log).catch(error => this.log.warn({ error, taskId: task.id }, '定时任务已建好，回执发送失败'));
      return { type: 'success', content: `已设为每天 ${view.time} 自动执行。` };
    } catch (error) {
      this.log.warn({ error, taskId: parsed.taskId }, '设置每天自动执行失败');
      return { type: 'error', content: '设置失败，请稍后重试。' };
    }
  }

  /** 同一个任务的验证正在跑；重复点击只回提示，不再起第二个进程。 */
  private readonly verifyInFlight = new Set<string>();

  /**
   * 结果卡的验证状态：没配验证命令时整行不渲染、按钮也不给——不能暗示一个不存在的能力。
   * canRun 与 canVerify 是同一个判断，渲染端与回调端因此不可能给出不同答案。
   */
  private async verificationView(task: LarkTask, config: StoredLarkConfig, state: LarkCardActionState): Promise<{ element?: LarkCardElement; canRun: boolean }> {
    const command = config.verificationCommand?.trim();
    if (!command) return { canRun: false };
    let latest: VerificationResponse | undefined;
    if (task.sessionId && this.runtime.getVerifications) {
      try { latest = (await this.runtime.getVerifications(task.sessionId))[0]; }
      catch (error) { this.log.warn({ error, taskId: task.id }, '读取验证记录失败，结果卡按未验证呈现'); }
    }
    // 只有「现有记录不能证明当前代码」时才给按钮：已验证且未失效的卡再跑一次没有意义，
    // 正在跑的也不能再起一个（runtime 会直接回 VERIFICATION_IN_PROGRESS）。
    const capable = Boolean(this.runtime.runVerification && task.sessionId
      && latest?.status !== 'running' && (!latest || latest.stale || latest.status !== 'passed'));
    // 最终仍由 card-actions 的能力表拍板（例如 cancelled 的卡不给验证入口）。
    // 文案里的「可点运行验证」必须与按钮同生同灭，否则就是在指一条不存在的路。
    const canRun = capable && isLarkCardActionAvailable('verify', {
      state, taskId: task.id, turn: task.turn, readOnly: true,
      ...(task.retryable !== undefined ? { retryable: task.retryable } : {}),
      capabilities: { ...this.capabilitiesForTask(task), canVerify: capable }
    });
    return { element: renderLarkVerificationElement({ command, latest, canRun }), canRun };
  }

  /** 验证跑完后原样重绘同一张结果卡，只整行替换验证状态，不改写已交付的结论。 */
  private async refreshResultVerification(task: LarkTask, config: StoredLarkConfig) {
    if (!task.finalCardInput || !task.finalMessageId || !task.finalElements) return;
    const verification = await this.verificationView(task, config, String(task.finalCardInput.state) as LarkCardActionState);
    const elements = [
      ...task.finalElements.filter(item => item.element_id !== LARK_VERIFICATION_ELEMENT_ID),
      ...(verification.element ? [verification.element] : [])
    ];
    await this.service.update({
      ...task.finalCardInput, messageId: task.finalMessageId, elements,
      capabilities: { ...this.capabilitiesForTask(task), canVerify: verification.canRun,
        ...await this.resultActionCapabilities(task, config, String(task.finalCardInput.state)) }
    });
    task.finalElements = elements;
    // 落库，让重启后再看到这张收据的人读到的也是刷新后的结论。
    await this.saveCardTask(task).catch(error => this.log.warn({ error, taskId: task.id }, '验证状态已更新到卡片，持久化待对账补齐'));
  }

  /** 正在后台执行 /repair 的「应用:确认卡消息」，防止同一张确认卡被重复点击触发多次发布。 */
  private repairInFlight = new Set<string>();

  /**
   * /repair 后台执行体：卡片回调在全部门禁通过后 3 秒内返回，真正的开放平台发布与结果卡
   * PATCH 在这里完成。任何失败都如实落到卡片，绝不抛出（调用方 fire-and-forget）。
   */
  private async executeRepairFlight(config: StoredLarkConfig, appId: string, messageId: string) {
    try {
      await this.service.update({
        messageId, taskId: messageId, taskName: '/repair 正在执行',
        state: 'running', readOnly: true, permissionMode: larkPermissionMode(config),
        markdown: '**正在执行修复**\n\n正在连接飞书开放平台，增量补齐权限、事件订阅与卡片回调；完成后会在本卡回报结果，请勿重复触发。'
      }).catch(error => this.log.warn({ error }, 'PATCH /repair 进行中状态失败'));
      // 缓存登录态命中时不进入扫码等待；缓存失效又无人扫码时，用有界等待快速失败，
      // 让结果卡回报「登录态过期」而不是长时间悬挂。
      const result = await runOpenPlatformRepair(
        {
          connectClient: async () => connectLarkOpenPlatformSession({ maxWaitMs: 30_000 }),
          // 斜杠命令走 tenant_access_token，而 this.service 正是本机器人的客户端。
          // 回调门禁已保证被修复的就是本应用（见上方 appId 比对）；万一不是，宁可交给
          // repair 的 env 回落去判，也绝不拿另一个应用的 token 去写命令菜单。
          ...(appId === config.appId ? { slashCommandClient: this.service } : {})
        },
        { appId, confirmed: true }
      );
      const rendered = renderRepairResultCard(result);
      const state = result.status === 'failed' ? 'failed' as const : 'completed' as const;
      await this.service.update({
        messageId, taskId: messageId, taskName: rendered.title,
        state, readOnly: true, permissionMode: larkPermissionMode(config),
        markdown: rendered.markdown, ...(rendered.elements.length ? { elements: rendered.elements } : {})
      });
    } catch (error) {
      this.log.warn({ error }, '后台执行 /repair 失败');
      await this.service.update({
        messageId, taskId: messageId, taskName: '/repair 修复失败',
        state: 'failed', readOnly: true, permissionMode: larkPermissionMode(config),
        markdown: '修复执行失败，请稍后重试；本次未完成发布。'
      }).catch(() => undefined);
    }
  }

  private async restoreQueuedCardAction(taskId: string, turn: number | undefined, context?: { messageId?: string; chatId?: string }): Promise<LarkTask | undefined> {
    const config = this.reconcileConfig;
    if (!config || !context?.messageId || !context.chatId) return;
    const mapping = await this.cardMappings?.get(larkCardChannel(config.appId), taskId);
    if (!mapping?.extra) return;
    const saved = JSON.parse(mapping.extra) as PersistedLarkCardTask;
    if (saved.app_id !== config.appId || saved.chat_id !== context.chatId || saved.card_message_id !== context.messageId
      || !saved.sender_open_id || !saved.runtime_task_id || (turn !== undefined && turn !== (saved.turn ?? 0))) return;
    const target = (await this.runtime.getTasks?.(mapping.sessionId))?.find(task => task.id === saved.runtime_task_id);
    if (target?.status !== 'queued') return;
    return { id: taskId, group: { tail: Promise.resolve() }, config, state: 'queued', turn: saved.turn ?? 0, epoch: 0,
      scopeId: saved.scope_id ?? '', prompt: saved.prompt, resources: [], events: [], sessionId: mapping.sessionId,
      runtimeTaskId: target.id, cardMessageId: saved.card_message_id, startedAt: saved.started_at,
      event: { messageId: taskId, chatId: saved.chat_id, chatType: saved.chat_type ?? 'group', messageType: 'text',
        content: '', mentions: [], senderOpenId: saved.sender_open_id, ...(saved.thread_id ? { threadId: saved.thread_id } : {}) },
      requestUpdate: async () => { await this.performReconcile(config); } };
  }

  /**
   * 结果卡是聊天记录里长期存在的收据，会活过守护进程；而回调只能在内存里找任务。
   * 「运行验证」是闭集里第一个画在这种卡上的操作，所以它必须能从持久化的卡片映射
   * 重建任务，否则重启后按钮还在、点了却只回一句和验证无关的提示——那正是死按钮。
   */
  private async restoreVerifyCardAction(taskId: string, turn: number | undefined, context?: { messageId?: string; chatId?: string }): Promise<LarkTask | undefined> {
    const config = this.reconcileConfig;
    if (!config || !context?.messageId || !context.chatId) return;
    const mapping = await this.cardMappings?.get(larkCardChannel(config.appId), taskId);
    if (!mapping?.extra) return;
    const saved = JSON.parse(mapping.extra) as PersistedLarkCardTask;
    if (saved.app_id !== config.appId || saved.chat_id !== context.chatId || saved.final_message_id !== context.messageId
      || !saved.final_card_input || (turn !== undefined && turn !== (saved.turn ?? 0))) return;
    return this.restoredCardTask(config, { externalId: taskId, sessionId: mapping.sessionId }, saved);
  }

  async handleAction(value: unknown, operatorOpenId?: string, context?: { messageId?: string; chatId?: string; actionTag?: string; option?: string }) {
    const workflow = value as Record<string, unknown> | null;
    if (workflow && workflow.dutydeck_export_trace === 'download') {
      if (!operatorOpenId || !context?.messageId || !context.chatId || !this.reconcileConfig || !this.cardMappings || !this.runtime.getEvents) {
        return { type: 'error', content: '记录入口已失效，请在原任务卡上操作。' };
      }
      try {
        const config = await readLarkConfig(this.workflowOptions.store, this.reconcileConfig.appId);
        if (!config?.listening) return { type: 'warning', content: '机器人已停用，无法导出记录。' };
        const mapping = (await this.cardMappings.list(larkCardChannel(config.appId))).find(item => item.externalId === workflow.task_id);
        const saved = mapping?.extra ? JSON.parse(mapping.extra) as PersistedLarkCardTask : undefined;
        if (!mapping || !saved?.runtime_task_id || saved.app_id !== config.appId || saved.chat_id !== context.chatId
          || ![saved.card_message_id, saved.final_message_id].includes(context.messageId)
          || saved.chat_type !== 'group' && saved.sender_open_id !== operatorOpenId
          || String(saved.turn) !== workflow.turn
          || !await this.currentAccess(config, saved.chat_id, saved.chat_type ?? 'group', operatorOpenId, 'task.view_result', mapping.sessionId, saved.sender_open_id)) {
          return { type: 'warning', content: '当前账号无权导出此任务记录，或卡片已失效。' };
        }
        const task = (await this.runtime.getTasks?.(mapping.sessionId))?.find(item => item.id === saved.runtime_task_id);
        if (!task) return { type: 'warning', content: '原任务记录不存在，无法导出。' };
        if (task.status === 'queued' || task.status === 'cancelled') {
          return { type: 'warning', content: '任务尚未执行，暂无执行记录可导出。' };
        }
        // The platform callback has a short deadline. Authorize first, then
        // deliver to the persisted chat/topic, never to callback-supplied IDs.
        void (async () => {
          try {
            const events = await this.runtime.getEvents!(mapping.sessionId);
            const start = events.findIndex(item => item.type === 'text' && (item.data as any)?.role === 'user' && (item.data as any)?.taskId === task.id);
            if (start < 0) throw new Error('原任务记录不完整，无法安全限定导出范围。');
            // Stop at the next user task as well as the terminal event: an
            // incomplete old turn must not export a later user's records.
            const end = events.findIndex((item, index) => index > start && (item.type === 'text' && (item.data as any)?.role === 'user'
              || item.type === 'task' && (item.data as any)?.task?.id === task.id && ['completed', 'failed', 'cancelled', 'interrupted'].includes((item.data as any)?.task?.status)));
            const text = renderLarkRecordExport(events.slice(start + 1, end < 0 ? undefined : end));
            const current = await readLarkConfig(this.workflowOptions.store, config.appId);
            if (!current?.listening || !await this.currentAccess(current, saved.chat_id, saved.chat_type ?? 'group', operatorOpenId, 'task.view_result', mapping.sessionId, saved.sender_open_id)) return;
            const key = `trace_${createHash('sha256').update([config.appId, task.id, text].join('\0')).digest('hex').slice(0, 40)}`;
            await sendLarkFile(this.service, { chatId: saved.chat_id,
              replyMessageId: saved.reply_message_id ?? saved.card_message_id, replyInThread: saved.reply_in_thread }, {
              data: Buffer.from(text, 'utf8'), filename: '公开执行记录.md', idempotencyKey: key
            }, this.log, this.workflowOptions.store);
          } catch (error) {
            this.log.warn({ error, taskId: task.id }, '导出执行记录失败');
            await sendTaskCard(this.service, { messageId: saved.card_message_id ?? task.id, chatId: saved.chat_id,
              chatType: saved.chat_type ?? 'group', threadId: saved.thread_id, messageType: 'text', content: '', mentions: [] }, {
              state: 'failed', readOnly: true, taskName: '记录未能导出',
              markdown: '未能获取或发送本轮完整公开记录，请稍后重试。'
            }, this.log).catch(() => undefined);
          }
        })();
        return { type: 'success', content: '正在导出公开执行记录，文件将发送到原任务会话。' };
      } catch (error) {
        this.log.warn({ error }, '受理记录导出失败');
        return { type: 'error', content: '暂时无法导出，请稍后重试。' };
      }
    }
    // P0-6：/repair 确认卡回调。发布飞书应用版本不可撤销，确认按钮是逐次显式确认的唯一载体；
    // 这里再串应用、门禁、人类校验三道，测试只能注入 mock client，开发/测试绝不真实发布。
    if (workflow && typeof workflow === 'object' && 'dutydeck_repair' in workflow) {
      const parsedRepair = parseRepairCardActionValue(value);
      if (!parsedRepair) return { type: 'error', content: '修复操作无法识别，请重新发送 /repair。' };
      if (!this.reconcileConfig || parsedRepair.appId !== this.reconcileConfig.appId) {
        return { type: 'error', content: '确认卡与当前飞书应用不匹配，请重新发送 /repair。' };
      }
      if (!context?.messageId || !context.chatId || !operatorOpenId) {
        return { type: 'error', content: '修复确认已失效，请重新发送 /repair。' };
      }
      try {
        const config = await readLarkConfig(this.workflowOptions.store, this.reconcileConfig.appId);
        if (!config?.listening) return { type: 'warning', content: '机器人已停用，无法执行修复。' };
        // /repair 发布的是整个飞书应用的新版本，属安装级动作，必须走 high_risk 门或部署静态
        // 白名单，不能复用「操作本人任务」的 own_runs 授权（开放发言群的普通成员也有后者）。
        if (!await this.isInstallationOperatorAllowed(config, operatorOpenId, context.chatId)) {
          return { type: 'warning', content: '当前账号无权执行 /repair：需要安装管理员权限。' };
        }
        // 卡片回调不携带发送者类型：bot 没有邮箱（平台 230001），借此把协作 bot 挡在发布动作外。
        const emails = await this.service.getUserEmails(operatorOpenId).catch(() => [] as string[]);
        if (!emails.length) return { type: 'warning', content: '/repair 只能由人类成员执行。' };
        // 发布链路含十余个开放平台串行写请求、耗时必然超过卡片回调 3 秒 SLA。
        // 所有门禁在此之前同步完成；通过后把发布与结果卡 PATCH 放到后台，回调立即回执。
        const flightKey = `${parsedRepair.appId}:${context.messageId}`;
        if (this.repairInFlight.has(flightKey)) {
          return { type: 'warning', content: '修复正在执行中，完成后会更新这张卡片，请勿重复点击。' };
        }
        this.repairInFlight.add(flightKey);
        void this.executeRepairFlight(config, parsedRepair.appId, context.messageId)
          .finally(() => this.repairInFlight.delete(flightKey));
        return { type: 'success', content: '已开始执行修复，完成后会更新这张卡片，请勿重复点击。' };
      } catch (error) {
        this.log.warn({ error }, '受理 /repair 失败');
        return { type: 'error', content: '修复操作受理失败，请稍后重试；本次未完成发布。' };
      }
    }
    // S2：/help 只读翻页。帮助内容与用户身份无关，无需持久化原消息；门禁与 /help 命令同权。
    if (workflow && typeof workflow === 'object' && 'dutydeck_help_page' in workflow) {
      const pageValue = parseLarkHelpPageValue(value);
      if (!pageValue) return { type: 'error', content: '无法识别帮助页码。' };
      if (!context?.messageId || !context.chatId || !operatorOpenId || !this.reconcileConfig || !this.workflowOptions.store) {
        return { type: 'error', content: '帮助卡片已失效，请重新发送 /help。' };
      }
      try {
        const config = await readLarkConfig(this.workflowOptions.store, this.reconcileConfig.appId);
        if (!config?.listening) return { type: 'warning', content: '机器人已停用，无法查看命令帮助。' };
        if (!await this.isOperatorAllowed(config, operatorOpenId, context.chatId)) {
          return { type: 'warning', content: '当前账号无权使用命令帮助。' };
        }
        const help = renderLarkCommandHelp(this.larkRouteCapabilities(), { page: pageValue.page });
        await this.service.update({ messageId: context.messageId, taskId: context.messageId, taskName: help.title,
          state: 'completed', readOnly: true, permissionMode: larkPermissionMode(config), markdown: help.text, elements: help.elements });
        return { type: 'success', content: `帮助第 ${help.page}/${help.totalPages} 页。` };
      } catch (error) {
        this.log.warn({ error }, '翻页命令帮助失败');
        return { type: 'error', content: '翻页失败，请稍后重试或重新发送 /help。' };
      }
    }
    if (workflow && typeof workflow === 'object' && 'dutydeck_task_dashboard' in workflow) {
      if (workflow.dutydeck_task_dashboard !== 'page' || typeof workflow.page !== 'number'
        || !Number.isSafeInteger(workflow.page) || workflow.page < 1) return { type: 'error', content: '无法识别任务列表页码。' };
      if (!context?.messageId || !context.chatId || !operatorOpenId || !this.reconcileConfig || !this.workflowOptions.store) {
        return { type: 'error', content: '任务列表已失效，请重新发送 /tasks。' };
      }
      try {
        const saved = await this.workflowOptions.store.get(`lark.task_dashboard.${this.reconcileConfig.appId}.${context.messageId}`);
        if (!saved) return { type: 'warning', content: '任务列表已失效，请重新发送 /tasks。' };
        const event = JSON.parse(saved) as LarkMessageEvent;
        if (event.chatId !== context.chatId || event.senderOpenId !== operatorOpenId) {
          return { type: 'warning', content: '请发送 /tasks 查看你自己的任务列表。' };
        }
        const config = await readLarkConfig(this.workflowOptions.store, this.reconcileConfig.appId);
        if (!config?.listening) return { type: 'warning', content: '机器人已停用，无法刷新任务列表。' };
        const elements = await this.taskDashboard(event, config, workflow.page);
        await this.service.update({ messageId: context.messageId, taskId: event.messageId, taskName: '任务导航',
          state: 'completed', readOnly: true, permissionMode: larkPermissionMode(config), elements });
        return { type: 'success', content: '任务列表已更新。' };
      } catch (error) {
        this.log.warn({ error }, '刷新任务列表失败');
        return { type: 'error', content: '刷新失败，请稍后重试或重新发送 /tasks。' };
      }
    }
    if (workflow && typeof workflow.dutydeck_work_item === 'string') {
      if (!this.workflowOptions.workbench || !this.reconcileConfig || !context) return { type: 'error', content: '目标卡片已失效。' };
      try { return { type: 'success', content: await this.workflowOptions.workbench.callback(workflow, operatorOpenId, context, this.reconcileConfig) }; }
      catch (error) { return { type: 'error', content: error instanceof Error ? error.message : String(error) }; }
    }
    // 按钮的 callback value 存在飞书服务器上，不在本地：改名前发出的审批卡带的是
    // dockmux_workflow，升级后仍挂在群里等人点。两个键都认，老卡片才不会变成死按钮。
    const workflowAction = workflow && typeof workflow.dutydeck_workflow === 'string'
      ? workflow.dutydeck_workflow
      : workflow && typeof workflow.dockmux_workflow === 'string' ? workflow.dockmux_workflow : undefined;
    if (workflow && workflowAction !== undefined) {
      if (!this.workflows || !context?.messageId || !context.chatId || !this.reconcileConfig) return { type: 'error', content: '卡片身份不完整或已失效。' };
      const action = workflowAction;
      if (!['approve', 'reject', 'accept', 'changes', 'answer'].includes(action)) return { type: 'error', content: '无法识别任务操作。' };
      // P0-1：overflow 菜单只承载唯一的回调选项（审批行的「拒绝」），其余点选一律拒绝，
      // 防止共用 behaviors.value 被误当成任意动作执行。
      if (context.actionTag === 'overflow' && !(action === 'reject' && context.option === 'reject')) {
        return { type: 'error', content: '该菜单不支持此操作。' };
      }
      try {
        const requestId = String(workflow.request_id ?? '');
        // 区分原审批卡回调与 /tasks 行内审批：后者记录的 cardId 是另一张审批卡，
        // 走斜杠形态（不做 cardId/generation 回调校验），但世代必须与渲染时一致。
        // 决议的一次性 CAS、liveness、授权仍全部由 respond 内部保证，不存在旁路。
        const record = (await this.workflows.list(this.reconcileConfig.appId)).find(item => item.id === requestId);
        const fromDashboard = !record?.cardId || record.cardId !== context.messageId;
        // 非原审批卡的回调只可能来自已登记的 /tasks 卡：行内按钮的 value 与原卡按钮同形，
        // 不验卡来源就等于接受任意 messageId 上的伪造回调。kv 在发送 /tasks 时持久化。
        if (fromDashboard) {
          const dashboardOrigin = await this.workflowOptions.store?.get(
            `lark.task_dashboard.${this.reconcileConfig.appId}.${context.messageId}`);
          if (!dashboardOrigin) return { type: 'error', content: '请在最新的审批卡片或 /tasks 卡片上操作。' };
        }
        if (fromDashboard && String(workflow.generation ?? '') !== record?.boot) {
          return { type: 'warning', content: '审批已失效，请刷新 /tasks 后重试。' };
        }
        let answer: { answer?: string; selected?: string[] } = {};
        if (action === 'answer') {
          if (workflow.multiple === true) {
            // 多选值由平台放在 form_value.answer（string[]）；容忍单值形态，过滤去重在 respond 内。
            const raw = (workflow.form_value as { answer?: unknown } | undefined)?.answer;
            answer = { selected: Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [] };
          } else {
            // 单选按钮直接带 answer；自由文本 input 的提交值在 form_value.answer。
            const formAnswer = (workflow.form_value as { answer?: unknown } | undefined)?.answer;
            answer = { answer: typeof workflow.answer === 'string' ? workflow.answer
              : typeof formAnswer === 'string' ? formAnswer : '' };
          }
        }
        const content = await this.workflows.respond({ appId: this.reconcileConfig.appId, chatId: context.chatId,
          actorId: operatorOpenId, requestId, action: action as 'answer' | 'approve' | 'reject' | 'accept' | 'changes',
          ...(fromDashboard ? {} : { cardId: context.messageId, generation: String(workflow.generation ?? ''), callback: true }),
          ...answer });
        if (action === 'accept' || action === 'changes') await this.refreshResultFeedback(this.reconcileConfig, requestId).catch(error => this.log.warn({ error }, '验收已记录，卡片刷新失败'));
        return { type: 'success', content };
      } catch (error) { return { type: 'error', content: error instanceof Error ? error.message : String(error) }; }
    }
    // 解析交给 card-actions.ts 的共享解析器：渲染端与回调端共用一套形状校验，
    // 不存在「一端认、另一端不认」的权限缝隙。同时兼容线上遗留的 {action, task_id}。
    const parsed = parseLarkCardActionValue(value);
    if (!parsed) return { type: 'error', content: '无法识别卡片操作' };
    // 结果卡续问行：任务从持久化映射取，不依赖内存里还有没有这条任务，重启后照样能点。
    if (parsed.action === 'ask_plain' || parsed.action === 'ask_reply' || parsed.action === 'ask_detail') return this.submitResultFollowUp(parsed, operatorOpenId, context);
    if (parsed.action === 'schedule_daily') return this.scheduleResultDaily(parsed, operatorOpenId, context);
    const action = parsed.action;
    const taskId = parsed.taskId;
    const task = this.tasks.get(taskId) ?? (action === 'cancel'
      ? await this.restoreQueuedCardAction(taskId, parsed.turn, context)
      : action === 'verify' ? await this.restoreVerifyCardAction(taskId, parsed.turn, context) : undefined);
    if (!task) return { type: 'warning', content: '此卡当前不可操作，请回原话题发送 /status 或 /cancel 查看和处理任务' };

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

    // 访问权限：操作人必须在机器人白名单中，与「谁可以使用 Agent」的配置一致。
    // 白名单内的成员均可取消 / 中断 / 重试任意任务，不再限制为任务发起人本人，
    // 避免 AI 协作链（上游 AI 触发下游 AI 任务）中人类无法干预的问题。
    const currentConfig = this.workflowOptions.store ? await readLarkConfig(this.workflowOptions.store, task.config.appId) : task.config;
    if (!currentConfig || (this.workflowOptions.store && !currentConfig.listening)) return { type: 'warning', content: '机器人已停用，无法执行此操作' };
    const effectiveConfig = task.event.chatType === 'group' && this.groupManager ? await this.groupManager.resolved(currentConfig, task.event.chatId) : currentConfig;
    const allowed = await this.isOperatorAllowed(effectiveConfig, operatorOpenId, task.event.chatId, task.sessionId, task.event.senderOpenId);
    if (!allowed) {
      return { type: 'warning', content: '当前账号不在机器人白名单中，无法执行此操作' };
    }
    // 鉴权本身是异步的，期间同样可能翻页。
    if (actionStale()) return { type: 'warning', content: '任务已开始新一轮，请在最新的卡片上操作' };

    // 刷新：卡片心跳受频率限制（含 per-app 限流），用户看到的可能是滞后画面。
    // 这里强制重绘一次当前状态，不改变任务状态机，因此对终态卡片无意义（按钮也不渲染）。
    if (action === 'refresh') {
      if (!isLarkCardActionAvailable('refresh', {
        state: task.state, taskId: task.id, turn: task.turn,
        ...(task.retryable !== undefined ? { retryable: task.retryable } : {}),
        capabilities: this.capabilitiesForTask(task)
      })) {
        return { type: 'warning', content: '当前状态无法刷新，任务已结束或心跳已停止' };
      }
      try {
        await task.requestUpdate?.(task.state === 'queued' ? 'queued' : 'running', false);
        return { type: 'success', content: '已拉取最新状态' };
      } catch (error) {
        this.log.warn({ error, taskId }, '刷新飞书卡片失败');
        return { type: 'error', content: '刷新失败，请稍后重试或前往 Dutydeck Web 查看' };
      }
    }

    // 运行验证：只读收据上唯一允许的操作。它在工作目录执行管理员配置的验证命令，
    // 新增一条带退出码与代码指纹的独立记录，卡上已交付的结论一个字都不改。
    // 命令必然超出卡片回调 3 秒 SLA，所以门禁同步走完、执行放后台，完成后重绘同一张卡。
    if (action === 'verify') {
      // 与渲染端同一个判断：verificationView 内部就走 isLarkCardActionAvailable，
      // 所以「界面上出现的按钮」与「后端接受的回调」严格等价，不存在死按钮也不存在旁路。
      if (!(await this.verificationView(task, effectiveConfig, task.state)).canRun) {
        return { type: 'warning', content: '当前没有可运行的验证命令，或这份验证记录已能证明当前代码。' };
      }
      if (this.verifyInFlight.has(task.id)) {
        return { type: 'warning', content: '验证正在执行中，完成后会更新这张卡片，请勿重复点击。' };
      }
      this.verifyInFlight.add(task.id);
      const command = effectiveConfig.verificationCommand!.trim();
      void (async () => {
        try { await this.runtime.runVerification!(task.sessionId!, { command }); }
        catch (error) { this.log.warn({ error, taskId: task.id }, '运行验证失败，卡片按最新记录呈现'); }
        finally {
          // 先把卡刷成最新结论再放开重入：否则这段空档里的第二次点击会再起一个真实进程。
          await this.refreshResultVerification(task, effectiveConfig)
            .catch(error => this.log.warn({ error, taskId: task.id }, '验证结果未能更新到结果卡'));
          this.verifyInFlight.delete(task.id);
        }
      })();
      return { type: 'success', content: '已开始运行验证，完成后会更新这张卡片。' };
    }

    // 旧版排队卡片会发 interrupt，仍按安全的单轮次取消处理，不中断当前运行任务。
    // P0-1：取消/中断/重试他人发起的任务时要求二次点击确认；发起人本人与身份缺失场景不拦。
    // 键绑定 操作人+任务+轮次+动作，60 秒内同一按钮第二次点击才真正执行，过期需重新确认。
    if (operatorOpenId && task.event.senderOpenId && operatorOpenId !== task.event.senderOpenId
      && (action === 'cancel' || action === 'interrupt' || action === 'retry')) {
      const now = Date.now();
      for (const [key, expiresAt] of this.foreignActionConfirmations) {
        if (expiresAt <= now) this.foreignActionConfirmations.delete(key);
      }
      const confirmationKey = `${operatorOpenId}|${taskId}|${actionTurn}|${action}`;
      if ((this.foreignActionConfirmations.get(confirmationKey) ?? 0) > now) {
        this.foreignActionConfirmations.delete(confirmationKey);
      } else {
        this.foreignActionConfirmations.set(confirmationKey, now + 60_000);
        return { type: 'warning', content: '该任务由他人发起，再次点击同一按钮以确认操作' };
      }
    }

    if (action === 'cancel' || (action === 'interrupt' && task.state === 'queued')) {
      if (task.state !== 'queued') return { type: 'warning', content: '任务已不在排队中' };
      if (!task.sessionId || !task.runtimeTaskId || !this.runtime.cancelQueued) return { type: 'warning', content: '排队任务当前不可取消' };
      task.state = 'interrupting';
      const sessionId = task.sessionId;
      const runtimeTaskId = task.runtimeTaskId;
      const cancelQueued = this.runtime.cancelQueued.bind(this.runtime);
      void (async () => {
        try {
          await cancelQueued(sessionId, runtimeTaskId, operatorOpenId);
          // 取消这一轮的排队期间可能已经 /retry 开了新一轮：旧点击不得改写新一轮状态，
          // 也不得触发新卡重绘。这一轮的实际终态由它自己的事件流负责。
          if (actionStale()) {
            this.log.info({ taskId, turn: actionTurn }, '排队取消完成时任务已进入新一轮，跳过旧轮次的状态改写');
            return;
          }
          task.state = 'cancelled';
          await task.requestUpdate?.('cancelled', false);
        } catch (error) {
          // 排队任务可能在点击时已转为运行态；绝不回退中断 Session，交由任务事件流对账实际状态。
          this.log.warn({ error, taskId, sessionId, runtimeTaskId }, '取消飞书排队任务失败');
          if (actionStale()) return;
          if (task.state === 'interrupting') task.state = 'queued';
          this.pushTaskError(task, `取消排队任务失败：${error instanceof Error ? error.message : String(error)}`);
          await task.requestUpdate?.(task.state === 'running' ? 'running' : 'queued', false).catch(() => undefined);
        }
      })();
      return { type: 'success', content: '正在取消排队任务' };
    }

    if (action === 'interrupt') {
      if (!task.sessionId || task.state !== 'running') return { type: 'warning', content: '任务当前不可中断' };
      const runtimeTaskId = task.runtimeTaskId;
      if (this.runtime.dispatch && !runtimeTaskId) return { type: 'warning', content: '任务尚未完成接收，请稍后再试' };
      task.state = 'interrupting';
      task.interruptRequested = true;
      const sessionId = task.sessionId;
      void (async () => {
        try {
          if (runtimeTaskId) await this.runtime.interrupt(sessionId, runtimeTaskId, operatorOpenId);
          else await this.runtime.interrupt(sessionId, undefined, operatorOpenId);
          // 中断返回时可能已经 /retry：新一轮正在跑，旧点击不能把它标成 interrupted。
          if (actionStale()) {
            this.log.info({ taskId, turn: actionTurn }, '中断完成时任务已进入新一轮，跳过旧轮次的状态改写');
            return;
          }
          // The signal is only an intent. Runtime's task event supplies the
          // confirmed terminal state; do not publish a cancellation receipt yet.
          await task.requestUpdate?.('running', false);
        } catch (error) {
          this.log.warn({ error, taskId, sessionId }, '中断飞书任务失败');
          if (actionStale()) return;
          task.state = 'running';
          task.interruptRequested = false;
          this.pushTaskError(task, `中断任务失败：${error instanceof Error ? error.message : String(error)}`);
          await task.requestUpdate?.('running', false).catch(() => undefined);
        }
      })();
      return { type: 'success', content: '正在取消任务' };
    }

    if (action === 'retry') {
      if (task.state !== 'failed' && task.state !== 'interrupted' && task.state !== 'cancelled') return { type: 'warning', content: '只有失败、已中断或已取消的任务可以重试' };
      if (!operatorOpenId) return { type: 'warning', content: '缺少操作人身份，无法重试' };
      const retryEvent = { ...task.event, senderOpenId: operatorOpenId, senderType: 'user', senderAppId: undefined };
      const previousState = task.state;
      task.state = 'queued';
      try {
        if (task.inbox) await this.inbox!.update(task.inbox, { event: retryEvent, state: 'received', turn: task.turn + 1, cardId: undefined, taskId: undefined, materials: undefined,
          ...(task.inbox.request ? { request: { ...task.inbox.request, materialPrompt: task.retryMaterialPrompt ?? task.prompt } } : {}) });
      } catch (error) {
        if (!actionStale()) task.state = previousState;
        return { type: 'warning', content: error instanceof Error ? error.message : '重试记录保存失败，请稍后重试' };
      }
      if (actionStale()) return { type: 'warning', content: '任务已开始新一轮，请在最新的卡片上操作' };
      task.event = retryEvent;
      task.config = effectiveConfig;
      // 生命周期字段在 runTurn 递增 turn 后再重置，避免上一轮在途的
      // 过程更新或结果发送把旧消息 ID 写进新一轮。
      task.group.tail = task.group.tail.then(() => this.runTurn(task)).catch(error => {
        this.log.error({ error, chatId: task.event.chatId, messageId: task.event.messageId }, '重试飞书任务失败');
        this.pushTaskError(task, `重试任务失败：${error instanceof Error ? error.message : String(error)}`);
        task.state = 'failed';
        task.requestUpdate?.('failed', false).catch(() => undefined);
      });
      return { type: 'success', content: '已开始重试' };
    }

    return { type: 'error', content: '不支持的卡片操作' };
  }

  stop() {
    this.stopped = true;
    this.workflows?.close();
    for (const cleanup of this.turnCleanups) cleanup();
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = undefined;
    if (this.taskAgentTimer) clearTimeout(this.taskAgentTimer);
    this.taskAgentTimer = undefined;
    this.reconcileConfig = undefined;
    this.groups.clear();
    this.tasks.clear();
    this.handledMessages.clear();
  }

  /**
   * 本轮是否已被 /new 作废。作废时给用户一张只读回执说明这条请求没有执行——
   * 静默丢弃会让用户看着一个 OK 表情永远等不到结果。
   * 若作废前已经建出会话，一并交给 /new 停掉，不留游离的新上下文。
   */
  private supersededTurn(task: LarkTask, session?: Session): boolean {
    if (task.epoch === (task.group.epoch ?? 0)) return false;
    if (session) {
      (task.group.retiredSessionIds ??= new Set()).add(session.id);
      if (task.group.sessionId === session.id) { task.group.sessionId = undefined; task.group.sessionConfigKey = undefined; }
      void Promise.resolve(this.runtime.stop?.(session.id)).catch(error =>
        this.log.warn({ error, sessionId: session.id }, '停止被 /new 作废的会话失败'));
    }
    task.state = 'interrupted';
    task.retryable = false;
    this.log.info({ taskId: task.id, chatId: task.event.chatId }, '本轮已被 /new 作废，不再派发');
    void (async () => {
      // P0-4：作废回执是独立新消息，群聊开启时与失败回执同口径 @ 发起人；私聊不 @。
      const mention = senderGroupMention(task.config.groupCardMention, task.event);
      await sendTaskCard(this.service, task.event, {
        state: 'failed', readOnly: true, retryable: false,
        taskId: task.id, taskName: '请求未执行',
        markdown: `${mention ? `${mention}\n\n` : ''}**这条请求没有执行：期间收到了 /new。**\n\n上一个会话已结束，请重新发送这条请求。`,
        idempotencyKey: `superseded_${task.id}`.slice(0, 50),
        ...(task.config.webBaseUrl ? { webBaseUrl: task.config.webBaseUrl } : {})
      }, this.log).catch(error => this.log.error({ error, taskId: task.id }, '发送 /new 作废回执失败'));
      await this.clearAcknowledgementReaction(task);
    })();
    return true;
  }

  private async validateNewSession(config: StoredLarkConfig, event: LarkMessageEvent, options: LarkLaunchOptions) {
    if (!this.cardMappings) throw new Error('当前运行时不支持保存首轮会话配置。');
    const actions: PolicyAction[] = [...(options.cwd ? ['run.change_cwd' as const] : []), ...(options.model || options.reasoningEffort ? ['run.change_model' as const] : []),
      ...(options.agentId ? ['run.change_agent' as const] : [])];
    for (const action of actions) {
      await this.requireExecution('session', action);
      if (config.managedGroup) {
        const decision = await this.groupManager?.authorize(config.appId, event.chatId, event.senderOpenId, action);
        if (!decision?.allowed) throw new Error(decision?.reason ?? '当前账号没有修改会话目录、Agent 或模型的权限。');
      }
    }
    const agents = await this.runtime.listAgents?.();
    // --agent 换执行者时，模型与推理强度必须按**被请求的** Agent 校验，不能拿机器人默认 Agent 的启动契约去判。
    const requested = options.agentId
      ? agents?.find(item => item.id === options.agentId)
      : agents?.find(item => item.id === config.defaultAgentId);
    if (!requested) {
      if (!options.agentId) throw new Error('机器人尚未配置可用的默认 Agent。');
      const available = (agents ?? []).map(item => item.id).join('、');
      throw new Error(`Dutydeck 上没有可用的 Agent「${larkCommandEcho(options.agentId, 64)}」。${available ? `当前可用：${available}。` : '当前本机没有探测到可用 Agent。'}`);
    }
    // 换了 Agent 就不要再把机器人默认模型当成它的模型基线：两者未必属于同一个供应商。
    const modelBaseline = options.agentId && options.agentId !== config.defaultAgentId ? undefined : config.defaultModel;
    return validateLarkLaunchOptions(options, { ...requested, ...(config.workspace ? { cwd: config.workspace } : {}),
      ...(modelBaseline ? { model: modelBaseline } : {}), permissionMode: larkPermissionMode(config) }, config.workspaceAliases);
  }

  private async sessionFor(group: LarkGroup, config: StoredLarkConfig, chatId: string, chatType: LarkMessageEvent['chatType'], scopeId: string, launchOptions?: LarkLaunchOptions) {
    // 建会话期间把 promise 挂到 group 上：并发的 /new 需要等它落地，才能把这条
    // 刚建出来的会话一起停掉，而不是让它在 /new 之后变成一个没人管的新上下文。
    const pending = resolveLarkSession(this.runtime, this.log, group, config, chatId, chatType, scopeId, this.cardMappings, launchOptions);
    const tracked = pending.catch(() => undefined);
    group.pendingSession = tracked;
    try { return await pending; }
    finally { if (group.pendingSession === tracked) group.pendingSession = undefined; }
  }

  /**
   * 空 @ 若引用同一用户自己的消息，沿用其中的明确请求；否则拉取最近聊天记录辅助澄清。
   */
  private async buildEmptyMessageFallback(event: LarkMessageEvent): Promise<string> {
    const referenceId = event.parentId?.trim() || (event.threadId?.trim() ? event.rootId?.trim() : undefined);
    if (event.chatType === 'group' && event.senderType === 'user' && event.senderOpenId && referenceId
      && this.botOpenId && event.mentions.some(mention => mention.openId === this.botOpenId)) {
      try {
        // 精确读取被回复的消息，不因最近 20 条历史缺少它而丢失原请求，也不越过 parent 去执行旧 root。
        const original = await this.service.getMessage(referenceId);
        if (original.messageId === referenceId && original.chatId === event.chatId && !original.deleted
          && original.sender.type === 'user' && original.sender.idType === 'open_id' && original.sender.id === event.senderOpenId
          && ['text', 'post', 'rich_text'].includes(original.messageType)) {
          const { prompt } = await parsePrompt({
            ...event, messageId: original.messageId, messageType: original.messageType, content: original.rawContent,
            mentions: original.mentions.map(mention => ({
              key: mention.key ?? '', name: mention.name ?? '',
              ...(mention.id && (mention.idType === 'open_id' || mention.id.startsWith('ou_')) ? { openId: mention.id } : {})
            }))
          }, this.botOpenId);
          if (prompt.trim()) return `[Dutydeck 引用请求唤醒]\n用户通过本次 @ 请求你处理下面自己发出的原消息（${referenceId}）。原消息包含明确请求时，直接沿用该请求继续处理，不要仅因本次消息只有 @ 而要求重复确认；原消息没有明确请求或指代仍不清楚时，才询问缺少的信息。其他聊天记录、引用和转发内容仅作参考，仍遵守既有权限与高风险操作确认要求。\n\n[用户引用的原消息]\n${prompt}`;
        }
      } catch (error) {
        this.log.warn({ error, messageId: event.messageId, referenceId }, '读取空 @ 引用的原请求失败，改为询问确认');
      }
    }
    const confirmationRule = '你可以使用上下文识别指代，但当前消息没有明确请求。必须先复述你对用户意图的理解并询问确认；在用户明确确认前，不得执行命令、写入文件、发送消息或触发其他副作用。';
    const fallback = `用户仅 @ 了机器人而未发送任何文字内容。${confirmationRule}`;
    try {
      // 话题内的空 @ 优先拉取该话题的消息，保证上下文不串到群里其他话题。
      const threadId = event.threadId?.trim();
      const result = await this.service.listChatMessages({
        ...(threadId ? { threadId } : { chatId: event.chatId }),
        pageSize: 20,
        order: 'desc'
      });
      const messages = result.items
        .filter(item => item.messageId !== event.messageId && !item.deleted)
        .sort((a, b) => Number(a.createTime) - Number(b.createTime));
      if (!messages.length) return fallback;
      const lines = await Promise.all(messages.map(async item => {
        const sender = item.sender.name || item.sender.id || '未知用户';
        // 合并转发消息不自动展开，只返回占位提示；Agent 可通过群协作工具按 message_id 拉取转发内容。
        const parsed = await parsePrompt({
          messageId: item.messageId,
          chatId: item.chatId ?? event.chatId,
          chatType: event.chatType,
          messageType: item.messageType,
          content: item.rawContent,
          mentions: item.mentions.map(mention => ({
            key: mention.key ?? '',
            name: mention.name ?? '',
            ...(mention.id && (mention.idType === 'open_id' || mention.id.startsWith('ou_')) ? { openId: mention.id } : {})
          }))
        }, this.botOpenId);
        const text = parsed.prompt;
        return `${sender}: ${text || '[图片/文件/卡片等非文字消息]'}`;
      }));
      return `[Dutydeck 空消息兜底]\n用户仅 @ 了机器人而未发送任何文字内容。以下是当前会话最近的聊天记录，仅用于识别指代。${confirmationRule}\n\n[最近聊天记录]\n${lines.join('\n')}`;
    } catch (error) {
      this.log.warn({ error, chatId: event.chatId, messageId: event.messageId }, '拉取飞书聊天记录为空消息兜底失败');
      return fallback;
    }
  }

  private async runTurn(task: LarkTask) {
    if (this.stopped) return;
    const resumeTask = task.resumeTask;
    task.resumeTask = undefined;
    const restoring = task.restoring;
    task.restoring = false;
    // 每次 runTurn 递增轮次编号，用于让上一轮的终态回调（finish）识别自己已过期，
    // 避免它在 await getEvents 期间被重试打断后，把 task.state 覆盖回终态。
    task.turn = (task.turn ?? 0) + 1;
    const currentTurn = task.turn;
    // 重试另建过程卡和结果消息，上一轮消息保留为历史。
    // 先递增 turn，再清理关联，防止旧轮在途请求覆盖新轮消息归属。
    if (currentTurn > 1 && !restoring) {
      if (task.inbox) await this.inbox!.update(task.inbox, { state: 'received', turn: currentTurn, cardId: undefined, taskId: undefined, materials: undefined });
      task.cardMessageId = undefined;
      task.finalMessageId = undefined;
      task.finalAttachmentMessageId = undefined;
      task.finalDeliveredTurn = undefined;
      // 留着会让新一轮在尚未交付时就写出 final_delivery_state: 'reaction'，
      // 而 reconciler 把它当作「已交付」且不要求 final_message_id，对账会永久跳过补发。
      task.finalDeliveryState = undefined;
      task.finalElements = undefined;
      task.finalCardInput = undefined;
      task.lastSuccessfulElements = undefined;
      task.runtimeTaskId = undefined;
      task.progressFrozen = undefined;
    }
    const { group, event, config } = task;
    // 群级呈现覆盖已由 groupManager.resolved() 折算进 config，这里直接读。
    /** 中间进展静默：不新建过程卡、不刷进展帧；提问卡/审批卡与最终结果不受影响。 */
    const silentProgress = config.silentProgress === true;
    /** 完成时只贴表情：成功终态不发结果卡，只对原消息贴一枚表情；失败终态不适用。 */
    const completionReactionOnly = config.completionReactionOnly === true;
    // P0-4：仅独立失败/拒绝新消息在开启群 @ 时前置 @ 发起人；排队卡、心跳、私聊永不经过这里。
    const withGroupMention = (markdown: string): string => {
      const mention = senderGroupMention(config.groupCardMention, event);
      return mention ? `${mention}\n\n${markdown}` : markdown;
    };
    if (!this.workflows && task.resources.length) {
      task.prompt = await materializeLarkResources(event.messageId, task.prompt, task.resources, this.service);
      task.resources = [];
    }
    const cardContext = { agentName: await this.resolveAgentName(config), permissionMode: larkPermissionMode(config), ...(config.workspace ? { workspace: config.workspace } : {}) };
    const clearAcknowledgement = () => this.clearAcknowledgementReaction(task);
    const failContextRead = async (error: unknown, activeSession?: Session) => {
      if (this.stopped || task.turn !== currentTurn || this.supersededTurn(task, activeSession)) return;
      this.log.warn({ error, chatId: event.chatId, messageId: event.messageId }, '执行前读取飞书上下文失败');
      task.state = 'failed'; task.retryable = false; task.startedAt = Date.now();
      const card = await sendTaskCard(this.service, event, { ...cardContext, state: 'failed', retryable: false, readOnly: true,
        taskId: task.id, taskName: '上下文读取失败', markdown: '上下文读取超时或失败，Agent 尚未执行。请稍后重新发送请求。',
        idempotencyKey: `context_failed_${task.id}`.slice(0, 50),
        ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) }, this.log);
      task.cardMessageId = card.messageId;
      if (task.inbox) await this.inbox!.update(task.inbox, { state: 'failed', error: '上下文读取超时或失败' });
      await clearAcknowledgement();
    };
    // 用户仅 @ 机器人而未发送文字时，拉取最近聊天记录作为上下文，让 Agent 判断用户意图。
    if (!task.prompt.trim()) {
      try { task.prompt = await withLarkContextReadTimeout(this.buildEmptyMessageFallback(event), '空 @ 上下文读取'); }
      catch (error) { await failContextRead(error); return; }
    }
    const prompt = task.prompt;
    const taskTitle = larkTaskTitle(prompt, config.name);
    if (task.inbox?.request && task.inbox.request.prompt !== prompt) await this.inbox!.update(task.inbox, { request: { ...task.inbox.request, prompt } });

    let actorEmails: string[] = [];
    const allowedUsers = config.allowedUsers ?? [];
    const allowedEmails = config.allowedEmails ?? [];
    const allowedBots = config.allowedBots ?? [];
    const peerBotsAllowed = config.peerBotsAllowed !== false;
    const highRiskAllowedUsers = config.highRiskAllowedUsers ?? [];
    const highRiskAllowedEmails = config.highRiskAllowedEmails ?? [];
    const highRiskPattern = config.highRiskPattern || defaultHighRiskPattern;
    const riskControlEnabled = config.riskControlMode !== 'off';
    const botSender = event.senderType === 'app' || event.senderType === 'bot';
    let trustedPeerBot = false;
    if (botSender) {
      try {
        trustedPeerBot = Boolean(config.groupToolsEnabled && event.senderOpenId && await this.peerBotAuthorized?.(event.chatId, event.senderOpenId));
      } catch (error) {
        task.state = 'failed'; task.retryable = false; task.startedAt = Date.now();
        const card = await sendTaskCard(this.service, event, { ...cardContext, state: 'failed', retryable: false, taskId: task.id, taskName: 'Agent 协作身份校验失败', markdown: withGroupMention(`**无法验证发起交接的 Agent。**\n\n${error instanceof Error ? error.message : String(error)}`), ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) }, this.log);
        task.cardMessageId = card.messageId;
        await clearAcknowledgement();
        return;
      }
    } else if ((!allowedUsers.length && allowedEmails.length) || (riskControlEnabled && !highRiskAllowedUsers.length && highRiskAllowedEmails.length)) {
      try {
        if (!event.senderOpenId) throw new Error('消息事件未包含发送人 open_id');
        actorEmails = await this.service.getUserEmails(event.senderOpenId);
        if (!actorEmails.length) throw new LarkServiceError('LARK_SENDER_EMAIL_EMPTY', '飞书没有返回当前发送人的邮箱字段', 409);
      } catch (error) {
        task.state = 'failed'; task.retryable = false; task.startedAt = Date.now();
        const card = await sendTaskCard(this.service, event, { ...cardContext, state: 'failed', retryable: false, taskId: task.id, taskName: '身份解析权限缺失', markdown: withGroupMention(larkIdentityPermissionHelp(error, config.appId)), ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) }, this.log);
        task.cardMessageId = card.messageId;
        await clearAcknowledgement();
        return;
      }
    }
    const senderOpenId = event.senderOpenId ?? '';
    const allowedUser = allowedUsers.find(user => user.openId === senderOpenId);
    const allowedBot = allowedBots.find(bot => bot.openId === senderOpenId);
    const highRiskAllowedUser = highRiskAllowedUsers.find(user => user.openId === senderOpenId);
    const accessRestricted = allowedUsers.length > 0 || allowedEmails.length > 0;
    const allowed = config.managedGroup ? true : botSender
      ? (!accessRestricted || (peerBotsAllowed && trustedPeerBot) || Boolean(allowedBot))
      : !accessRestricted || (allowedUsers.length ? Boolean(allowedUser) : actorEmails.some(email => allowedEmails.includes(email)));
    if (!allowed) {
      task.state = 'failed'; task.retryable = false; task.startedAt = Date.now();
      const card = await sendTaskCard(this.service, event, { ...cardContext, state: 'failed', retryable: false, taskId: task.id, taskName: '访问被拒绝', markdown: withGroupMention('**当前账号不在机器人白名单中。**\n\n如需使用，请联系机器人管理员添加你。'), ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) }, this.log);
      task.cardMessageId = card.messageId;
      await clearAcknowledgement();
      return;
    }
    const highRiskAuthorized = botSender
      ? false
      : (!riskControlEnabled || (!highRiskAllowedUsers.length && !highRiskAllowedEmails.length)
          ? allowed
          : highRiskAllowedUsers.length
            ? Boolean(highRiskAllowedUser)
            : actorEmails.some(email => highRiskAllowedEmails.includes(email)));
    const actorEmail = actorEmails[0];
    const riskPolicy: ToolRiskPolicy | undefined = config.riskControlMode === 'enforced' ? {
      enabled: true,
      authorized: highRiskAuthorized,
      pattern: highRiskPattern,
      ...(actorEmail ? { actorEmail } : {}),
      reason: '当前飞书发送人不在高危操作允许名单中'
    } : undefined;
    let session: Session;
    try {
      if (this.groupManager && event.chatType === 'group') {
        const decision = await this.groupManager.authorize(config.appId, event.chatId, event.senderOpenId, 'task.create', group.sessionId);
        if (decision && !decision.allowed) throw new LarkServiceError(decision.code, decision.reason, 403);
      }
      await this.requireExecution('session', 'task.create');
      if (riskPolicy) await this.requireExecution('high_risk', 'high_risk.execute');
      // 附件下载与身份解析都可能很慢，期间用户可能已经 /new。此刻建会话等于把旧请求
      // 送进一个用户已经宣布结束的上下文，还会顺带创建一条新会话污染新上下文。
      if (this.supersededTurn(task)) return;
      if (task.launchOptions && task.restoring && !resumeTask && !task.inbox?.sessionId) task.launchOptions = await this.validateNewSession(config, event, task.launchOptions);
      if (this.supersededTurn(task)) return;
      session = resumeTask ? (await this.runtime.getSession(resumeTask.sessionId))! : task.inbox?.sessionId ? (await this.runtime.getSession(task.inbox.sessionId))! : await this.sessionFor(group, config, event.chatId, event.chatType, task.scopeId, task.launchOptions);
      if (!session) throw new LarkServiceError('LARK_SESSION_MISSING', '原任务会话已不存在，请重新发送目标。', 409);
      // 建会话本身也可能卡住（runtime.start 未返回）。回来后再确认一次，
      // 并把这条会话交给 /new 收走，不留下一个游离的新上下文。
      if (this.supersededTurn(task, session)) return;
    }
    catch (error) {
      // Keep the durable inbox pending for the next daemon; lifecycle shutdown
      // is not an Agent startup failure.
      if (error instanceof RuntimeError && error.code === 'RUNTIME_SHUTTING_DOWN') return;
      task.state = 'failed'; task.startedAt = Date.now();
      const markdown = withGroupMention(`**Agent 启动失败**\n\n${error instanceof Error ? error.message : String(error)}`);
      const card = await sendTaskCard(this.service, event, { ...cardContext, state: 'failed', taskId: task.id, taskName: taskTitle, markdown, ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) }, this.log);
      task.cardMessageId = card.messageId;
      await clearAcknowledgement();
      return;
    }
    task.sessionId = session.id;
    const legacyUpgradeNote = task.group.legacyUpgradeSessionId === session.id
      ? '这是升级后创建的新上下文；旧会话历史仍可查看，但原上下文未自动恢复。'
      : undefined;
    if (legacyUpgradeNote) task.group.legacyUpgradeSessionId = undefined;
    // P0-7：ask 模式下 pty/pty-cli 任务的工具确认只能在电脑前响应，首卡、排队卡与每帧心跳都如实标注。
    const protocolNote = protocolModeNote(session.protocol, larkPermissionMode(config));
    // S3：未知命令近似提示只追加到卡面，绝不进入 prompt（materialPrompt 保持原文）。
    // S8：replayed 置位后排队 PATCH 也带恢复注记；心跳帧的同名元素在 update() 内另拼。
    const withCardNotes = (markdown: string): string =>
      [markdown, legacyUpgradeNote, protocolNote, task.replayedNote ? replayedRecoveryNote() : undefined, task.steerNote,
        task.commandSuggestion ? `${task.commandSuggestion} 原文仍会作为普通请求执行。` : undefined]
        .filter((part): part is string => Boolean(part)).join('\n\n');
    cardContext.workspace = session.cwd;
    await this.groupManager?.recordRun(session, config, event, task.scopeId);
    let materialPrompt = task.retryMaterialPrompt ?? prompt;
    let contextCommit: (() => Promise<void>) | undefined;
    if (this.workflowOptions.store && !resumeTask) {
      const contextKey = `lark.context.${config.appId}.${session.id}`;
      let snapshot = task.inbox?.materials;
      if (!snapshot) {
        const raw = await this.workflowOptions.store.get(contextKey);
        const previous = raw ? JSON.parse(raw) : {};
        if (task.retryMaterialPrompt) snapshot = { prompt: task.retryMaterialPrompt, ...previous, contextBefore: raw };
        else {
          let context: Awaited<ReturnType<typeof collectLarkTaskContext>>;
          try {
            context = await withLarkContextReadTimeout(collectLarkTaskContext({ event, prompt, resources: task.resources, service: this.service, ...previous }), '话题上下文读取');
          } catch (error) { await failContextRead(error, session); return; }
          if (this.stopped || task.turn !== currentTurn || this.supersededTurn(task, session)) return;
          materialPrompt = context.agentPrompt;
          for (const sourceId of new Set(context.resources.map(resource => resource.sourceMessageId))) {
            materialPrompt = await materializeLarkResources(sourceId, materialPrompt, context.resources.filter(resource => resource.sourceMessageId === sourceId), this.service);
          }
          snapshot = { prompt: materialPrompt, cursor: context.cursor, readMessageIds: context.readMessageIds, contextBefore: raw };
        }
        if (task.inbox) await this.inbox!.update(task.inbox, { sessionId: session.id, materials: snapshot });
      }
      materialPrompt = snapshot!.prompt;
      const acceptedSnapshot = snapshot!;
      contextCommit = async () => {
        const next = JSON.stringify({ cursor: acceptedSnapshot.cursor, readMessageIds: acceptedSnapshot.readMessageIds });
        // A replay may arrive after a later accepted turn. Never roll its cursor back.
        if (await this.workflowOptions.store!.get(contextKey) === next) return;
        await this.workflowOptions.store!.compareAndSet!(contextKey, acceptedSnapshot.contextBefore, next);
      };
    }
    task.retryMaterialPrompt = materialPrompt;
    const initialState = resumeTask?.status === 'running' ? 'running' : this.runtime.dispatch ? 'queued' : 'running';
    task.state = initialState;
    task.events = resumeTask
      ? await loadLarkTaskEvents(this.runtime, session.id, resumeTask.id, Math.max((config.traceLimit ?? defaultLarkTraceLimit) * 30, 500))
      : [];
    if (!resumeTask) task.startedAt = Date.now();
    task.interruptRequested = false;
    // An accepted task keeps its original card and mapping while reattaching.
    if (!resumeTask) {
      const initialElements = boundLarkCardElements(renderLarkProcessElements([], config));
      const initialMarkdown = withCardNotes(initialState === 'queued' ? '任务已接收，正在准备执行…' : '正在思考中…');
      // 首张卡也必须带本轮 turn：它的按钮回调把 turn 写进 value，缺省会渲染成 "0"，
      // 而本轮 turn 从 1 起算——回调随后会被轮次校验当成上一轮的点击拒掉，
      // 直到某次心跳重绘才恢复。UI 不变，只是把回调绑到正确的轮次上。
      // 「正在思考中…」这张卡本身就是一条中间进展消息：静默时既不新建、也不刷已有的那张
      // （重放到一半才打开开关的旧卡仍会在终态被冻结，不会永远停在执行中）。
      if (silentProgress) {
        this.log.info({ taskId: task.id, chatId: event.chatId }, '中间进展静默：本轮不发执行过程卡');
      } else if (task.cardMessageId) {
        await this.service.update({ ...cardContext, cardKind: 'process', messageId: task.cardMessageId, permissionMode: larkPermissionMode(config), state: initialState, statusLabel: initialState === 'queued' ? '已接收' : undefined, taskId: task.id, taskName: taskTitle, markdown: initialMarkdown, sessionId: task.sessionId, turn: currentTurn, ...(task.inbox ? { idempotencyKey: `task_${event.messageId}_${currentTurn}`.slice(0, 50) } : {}), ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) });
      } else {
        const card = await sendTaskCard(this.service, event, { ...cardContext, cardKind: 'process', ...(task.inbox ? { idempotencyKey: `task_${event.messageId}_${currentTurn}`.slice(0, 50) } : {}), state: initialState, statusLabel: initialState === 'queued' ? '已接收' : undefined, readOnly: initialState === 'queued', taskId: task.id, taskName: taskTitle, markdown: initialMarkdown, sessionId: task.sessionId, turn: currentTurn, ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) }, this.log);
        task.cardMessageId = card.messageId;
      }
      task.lastSuccessfulElements = initialElements;
      await this.saveCardTask(task);
      if (task.inbox) await this.inbox!.update(task.inbox, { sessionId: session.id, cardId: task.cardMessageId, turn: currentTurn });
      await clearAcknowledgement();
    }

    let timer: NodeJS.Timeout | undefined;
    let heartbeatActive = false;
    /** 一次卡片更新的真实结果。终态交付只认这里的 delivered，不认「链已 resolve」。 */
    type CardUpdateOutcome = { delivered: boolean; messageId?: string };
    type PendingCardUpdate = {
      input: Parameters<LarkCardService['update']>[0];
      terminal: boolean;
      /** 入队时的轮次；重试开了新一轮之后，这一条必须整条作废，不得再碰上一轮的卡。 */
      turn: number;
      settle: (outcome: CardUpdateOutcome) => void;
    };
    let pendingUpdate: PendingCardUpdate | undefined;
    let updateChain: Promise<void> | undefined;
    let cardRateLimitFailures = 0;
    let cardRateLimitedUntil = 0;
    const flushUpdates = () => {
      if (updateChain) return updateChain;
      updateChain = (async () => {
        while (pendingUpdate) {
          const pending = pendingUpdate;
          pendingUpdate = undefined;
          let lastError: unknown;
          let delivered = false;
          let contentRejected = false;
          const deliveredMessageId = pending.input.messageId;
          // 整条 entry 的处理都包在 try/finally 里：PATCH 成功但落库失败时，
          // 也必须把这条 entry 结算掉。否则调用方的 await 永久挂起，cleanup 不会执行。
          try {
          /**
           * 这一条更新是否还属于当前轮次。
           *
           * 必须在**每次 await 之后**重新判断，不能只在入口判一次：dispatch 模式下
           * executeTask 在 dispatch 建立订阅后就返回，group.tail 随即 resolve，因此
           * 用户点重试时新一轮会立刻开跑并递增 turn——而上一轮的终态 PATCH 可能
           * 还悬在 await 里。等它回来时，task 上的 cardMessageId、lastSuccessfulElements、
           * finalMessageId 已经属于新一轮，旧轮次再写就会污染新一轮的卡片与持久化。
           * 判据用 pending.turn（入队时的轮次），不是现读的 task.turn。
           */
          const stale = () => this.stopped || pending.turn !== task.turn;
          if (stale()) continue;
          // 过程卡已被永久冻结：停止向已确认永久不可更新的卡 PATCH，避免重复浪费 API 调用。
          if (task.progressFrozen && pending.input.messageId === task.cardMessageId) {
            continue;
          }
          // 终态卡片是交付契约的一部分，值得多试几次；运行态心跳丢一帧无所谓。
          // 注意与 api-gate 的分层关系：gate 在 HTTP 层已做 429/5xx 退避重试
          // （默认 3 次），这里是业务层重试。持续 429 时两层会相乘，单次终态更新
          // 最坏可能拉长到分钟级。若线上观察到终态交付过慢，优先下调
          // LARK_API_RETRY_MAX_ATTEMPTS，而不是削减这里的终态重试次数。
          const attempts = pending.terminal ? 3 : 1;
          for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
              await this.service.update(pending.input);
              lastError = undefined;
              delivered = true;
              // 更新本身打在旧卡上无害（那是它自己的卡），但快照属于新一轮，不能覆盖。
              if (pending.input.elements && !stale()) {
                // queue_summary 是该时刻的瞬态队列读数；若冻结进 last_successful_elements，
                // 守护进程重启后 reconciler 会在恢复卡上重放崩溃瞬间的陈旧「排队 N 条」。
                // protocol_hint / recovery_note 是持久事实，保留。
                task.lastSuccessfulElements = (pending.input.elements as LarkCardElement[])
                  .filter(element => element.element_id !== QUEUE_SUMMARY_ELEMENT_ID);
              }
              cardRateLimitFailures = 0;
              cardRateLimitedUntil = 0;
              break;
            } catch (error) {
              lastError = error;
              if (isLarkCardContentRejected(error)) { contentRejected = true; break; }
              if (isLarkMessageUnupdatable(error)) break;
              if (isLarkMessageRateLimit(error)) {
                cardRateLimitFailures += 1;
                cardRateLimitedUntil = Date.now() + larkRateLimitBackoffMs(cardRateLimitFailures);
              }
              this.log.warn({ error, messageId: pending.input.messageId, attempt, attempts }, '更新飞书服务卡片失败');
              // 轮次已翻页：不再为旧卡消耗重试预算，也不再制造新的在途请求。
              if (stale()) break;
              if (attempt < attempts) {
                const retryDelay = isLarkMessageRateLimit(error)
                  ? Math.max(0, cardRateLimitedUntil - Date.now())
                  : attempt * 300;
                await new Promise(resolve => setTimeout(resolve, retryDelay));
              }
            }
          }
          if (stale()) continue;
          // 过程卡内容被拒绝时保留上一次成功内容，结果消息独立交付。
          if (lastError && contentRejected && Array.isArray(task.lastSuccessfulElements) && task.lastSuccessfulElements.length) {
            const patchedElements = patchRejectedCardDelta(task.lastSuccessfulElements, pending.input.elements as LarkCardElement[] | undefined);
            try {
              await this.service.update({ ...pending.input, elements: patchedElements, markdown: undefined });
              delivered = true;
              lastError = undefined;
              if (!stale()) task.lastSuccessfulElements = patchedElements;
              this.log.warn({ messageId: pending.input.messageId, state: pending.input.state }, '飞书卡片增量被拒绝，已保留上次成功内容并原地修补');
            } catch (error) {
              lastError = error;
            }
          }
          if (stale()) continue;
          if (lastError) {
            if (isLarkMessageUnupdatable(lastError)) {
              // 异步失败处理必须捕获并核对当前 card id/轮次，旧卡失败不能冻结新卡/新任务。
              if (!this.stopped && pending.turn === task.turn && pending.input.messageId === task.cardMessageId) {
                task.progressFrozen = true;
                try {
                  await this.saveCardTask(task, pending.input.state ?? task.state);
                } catch (saveError) {
                  this.log.warn({ error: saveError, taskId: task.id, messageId: deliveredMessageId }, '持久化卡片冻结状态失败，等待对账');
                  this.scheduleReconcile();
                }
              } else {
                this.log.info({
                  taskId: task.id,
                  pendingTurn: pending.turn,
                  taskTurn: task.turn,
                  pendingMessageId: pending.input.messageId,
                  currentCardMessageId: task.cardMessageId
                }, '旧轮次或旧卡的不可更新错误，跳过冻结以保护当前卡片');
              }
            } else if (pending.terminal) {
              this.log.warn({ error: lastError, messageId: pending.input.messageId }, '执行过程卡更新失败，等待对账；结果仍将独立交付');
              this.scheduleReconcile();
            }
          }
          if (delivered && pending.input.state) {
            // 旧轮次不得写入新一轮的持久化：mapping 只有一行，写进去就把新一轮的
            // card_message_id / runtime_task_id 覆盖成上一轮的了。
            if (stale()) {
              this.log.info({ taskId: task.id, turn: pending.turn, messageId: deliveredMessageId }, '旧轮次终态已送达，但新一轮已开始，跳过持久化以免覆盖新一轮状态');
              continue;
            }
            if (pending.terminal) task.progressFrozen = true;
            // 落库失败不改变「卡片已经送达用户」这个事实，因此不回退 delivered：
            // 谎称未送达会让对账再交付一次。只补一次对账把持久化补上。
            try {
              await this.saveCardTask(task, pending.input.state);
            } catch (error) {
              this.log.warn({ error, taskId: task.id, messageId: deliveredMessageId }, '飞书卡片状态落库失败，卡片已送达，等待对账补齐持久化');
              this.scheduleReconcile();
            }
          }
          } finally {
            // 无论走哪条分支（含 continue 与异常）都必须结算，否则调用方永久挂起。
            pending.settle({ delivered, ...(delivered ? { messageId: deliveredMessageId } : {}) });
          }
        }
      })().finally(() => {
        updateChain = undefined;
        if (pendingUpdate) void flushUpdates();
      });
      return updateChain;
    };
    /**
     * 本轮是否已经请求过终态。终态一旦入队就固定这一轮的过程卡状态，
     * 之后到达的心跳/排队重绘不得把它挤掉，也不得在它之后再改写卡片。
     */
    let terminalLatched = false;
    /**
     * 入队一次卡片更新，返回的 promise 只在**这一条**更新有结果后才 resolve。
     *
     * 刻意不返回 updateChain：链的 finally 会为后到的 pendingUpdate 再起一次没人 await 的
     * flush，此时 await 旧链拿到的是「上一帧心跳写完了」，而不是「我的终态真的写进去了」。
     * 过程冻结必须以自己那次 PATCH 的真实结果为准，结果消息的交付另行记录。
     */
    const enqueueUpdate = (entry: Omit<PendingCardUpdate, 'settle'>) => {
      // 终态已经在队列里或已经写过：晚到的非终态重绘一律丢弃。
      // 心跳与终态可能同时在途（心跳的 PATCH 正在飞，终态紧接着入队），
      // 若允许覆盖，用户最终看到的会是一张停在「执行中」的卡。
      if (terminalLatched && !entry.terminal) return Promise.resolve({ delivered: false } as CardUpdateOutcome);
      if (entry.terminal) {
        terminalLatched = true;
        // 终态已定，心跳不能再排下一帧。
        heartbeatActive = false;
        if (timer) { clearTimeout(timer); timer = undefined; }
      }
      return new Promise<CardUpdateOutcome>(resolve => {
        // 被顶掉的那条永远不会执行，必须就地了结，否则它的 await 会永久挂起。
        pendingUpdate?.settle({ delivered: false });
        pendingUpdate = { ...entry, settle: resolve };
        void flushUpdates();
      });
    };

    const update = async (state: Exclude<LarkTaskState, 'interrupting'>) => {
      // Runtime running is monotonic for a turn. Late dispatch/cancel bookkeeping may
      // still report queued, but must never repaint an executing card backwards.
      if (state === 'queued' && task.state === 'running') return Promise.resolve({ delivered: false } as CardUpdateOutcome);
      const terminal = state === 'completed' || state === 'failed' || state === 'interrupted' || state === 'cancelled';
      const recovery = task.sessionId && task.runtimeTaskId && ['queued', 'reconcile_required', 'legacy_unresolved'].includes(state)
        ? await describeLarkTaskRecovery(this.runtime, task.sessionId, task.runtimeTaskId, state) : undefined;
      const notifyRecovery = () => recovery?.blocked && task.sessionId && task.runtimeTaskId ? notifyLarkTaskRecovery({
        service: this.service, store: this.workflowOptions.store, log: this.log, appId: config.appId,
        sessionId: task.sessionId, taskId: task.runtimeTaskId, turn: task.turn, recovery,
        target: { chatId: event.chatId, ...(event.chatType === 'group'
          ? { replyMessageId: event.messageId, replyInThread: Boolean(event.threadId?.trim()) } : {}) }
      }) : Promise.resolve(undefined);
      if (!task.cardMessageId || (!terminal && (silentProgress || task.progressFrozen))) {
        await notifyRecovery();
        return { delivered: false } as CardUpdateOutcome;
      }
      if (timer) { clearTimeout(timer); timer = undefined; }
      let elements: LarkCardElement[] = boundLarkCardElements(renderLarkProcessElements(task.events, config, terminal));
      if (recovery) elements = [{ tag: 'markdown', element_id: 'task_recovery', content: recovery.markdown }];
      if (!terminal) {
        // 非终态帧固定追加三枚只 PATCH、不新消息的注记元素；终态帧一律不带。
        // 排队摘要读取失败只丢本帧摘要，不影响心跳主链路。
        const frameNotes: LarkCardElement[] = [];
        if (protocolNote) frameNotes.push({ tag: 'markdown', element_id: 'protocol_hint', content: protocolNote, text_size: 'notation', margin: '0px' });
        if (task.replayedNote) frameNotes.push({ tag: 'markdown', element_id: 'recovery_note', content: replayedRecoveryNote(), text_size: 'notation', margin: '0px' });
        // /steer 的降级说明也要跟着心跳走：这一轮没排队直接开跑时没有排队卡，注记只能挂在这里。
        if (task.steerNote) frameNotes.push({ tag: 'markdown', element_id: 'steer_note', content: task.steerNote, text_size: 'notation', margin: '0px' });
        if (task.sessionId && this.runtime.getTasks) {
          try {
            // 排队摘要只数「排在前面的」任务：update('queued') 重绘帧里当前任务自身也是 queued，
            // 不过滤会把自己计入「排队 N 条」，与排队 PATCH 使用的 queuedAhead 口径不一致。
            const queuedTasks = (await this.runtime.getTasks(task.sessionId))
              .filter(item => item.status === 'queued' && item.id !== task.runtimeTaskId);
            const queueSummary = renderQueueSummaryElement(queuedTasks);
            if (queueSummary) frameNotes.push(queueSummary);
          } catch (error) {
            this.log.warn({ error, taskId: task.id }, '读取排队摘要失败，本帧跳过排队摘要');
          }
        }
        if (frameNotes.length) {
          elements = [
            ...elements.filter(element => element.element_id !== 'protocol_hint'
              && element.element_id !== 'recovery_note'
              && element.element_id !== 'steer_note'
              && element.element_id !== QUEUE_SUMMARY_ELEMENT_ID),
            ...frameNotes
          ];
        }
      }
      const outcome = await enqueueUpdate({
        terminal,
        turn: task.turn,
        input: {
          ...cardContext,
          cardKind: 'process',
          messageId: task.cardMessageId!,
          permissionMode: larkPermissionMode(config),
          state,
          ...(recovery ? { statusLabel: recovery.label } : task.state === 'interrupting' ? { statusLabel: '等待停止确认', actionState: 'interrupting' as const } : {}),
          taskId: task.id,
          taskName: taskTitle,
          elapsedSeconds: (Date.now() - task.startedAt!) / 1_000,
          sessionId: task.sessionId,
          // 按钮能力按 runtime 实际状态注入。终态同样按能力表渲染，而不是一刀切 readOnly：
          // 失败/中断的这张卡就是用户唯一的入口，重试必须留在上面。
          turn: task.turn,
          ...(terminal && task.retryable !== undefined ? { retryable: task.retryable } : {}),
          // 完成后的回执写不写「结果见下条」：只贴表情的模式下不会再发结果消息。
          ...(state === 'completed' && !completionReactionOnly ? { resultFollows: true } : {}),
          capabilities: this.capabilitiesForTask(task),
          ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
          elements
        }
      });
      if (task.progressFrozen) await notifyRecovery();
      return outcome;
    };
    let terminalDelivery: Promise<void> | undefined;
    let verifiedOutput: AgentEvent | undefined;
    // Freeze the process card, then send one immutable result. Neither operation
    // counts as success for the other; reconciliation retries only the missing part.
    const deliverTerminal = (state: 'completed' | 'failed' | 'interrupted' | 'cancelled', completed = false) => {
      if (task.finalDeliveredTurn === currentTurn && (task.finalMessageId || task.finalDeliveryState === 'reaction')) return Promise.resolve();
      if (terminalDelivery) return terminalDelivery;
      terminalDelivery = withExplicitFinalLock(this.workflowOptions.store, task.runtimeTaskId ?? task.id, async () => {
        await update(state);
        // 终态先撤置顶：轮次校验之后再撤，重试开的新一轮会让上一轮的进度卡永远挂在置顶里。
        await this.unpinTaskCard(task);
        if (this.stopped || task.turn !== currentTurn) return;
        const runtimeTask = state === 'completed' && task.sessionId && task.runtimeTaskId
          ? (await this.runtime.getTasks?.(task.sessionId))?.find(item => item.id === task.runtimeTaskId) : undefined;
        const finalContext = state === 'completed' && task.sessionId ? explicitFinalContext(
          { externalId: task.id, sessionId: task.sessionId }, {
            app_id: config.appId, chat_id: event.chatId, chat_type: event.chatType,
            runtime_task_id: task.runtimeTaskId, task_name: taskTitle, prompt,
            state, started_at: task.startedAt!, turn: currentTurn,
            ...(event.chatType === 'group' ? { reply_message_id: event.messageId, reply_in_thread: Boolean(event.threadId?.trim()) } : {})
          }, runtimeTask?.currentAttemptId) : undefined;
        const explicit = await hasExplicitFinal(this.workflowOptions.store, finalContext);
        // 完成时只贴表情：成功终态改为在原消息上贴一枚表情，不再发结果卡。
        // 只对成功终态生效——失败/中断/取消仍必须发结果卡，一个表情等于把失败藏起来。
        // 任务通道的合成事件没有可贴的原消息，只能照常发结果卡，否则用户什么也收不到。
        if (!explicit && completionReactionOnly && state === 'completed' && !larkTaskAgentGuid(event.messageId)) {
          const reacted = await deliverLarkCompletionReaction(this.service, { appId: config.appId, messageId: event.messageId }, this.log, this.workflowOptions.store);
          if (this.stopped || task.turn !== currentTurn) return;
          // 贴失败就不记「已交付」：这枚表情是用户唯一能看到的完成信号，交给对账重试。
          if (reacted) {
            task.finalDeliveredTurn = currentTurn;
            task.finalDeliveryState = 'reaction';
          } else this.scheduleReconcile();
          await this.saveCardTask(task, state);
          return;
        }
        const context = completed ? this.interactionContext(task) : undefined;
        // P0-4：完成/失败/被中断的独立新消息在群聊开启时 @ 发起人；超长结果转文件消息时
        // 长文的 @ 保留在摘要卡，附件不 @；reaction 不承担通知。
        const terminalMention = senderGroupMention(config.groupCardMention, event);
        // 「它说做完了，其实没做完」是这类产品最常见的失望。平台验证是可核对的反证，
        // 但此前只存在于 Web；结果卡上必须把「验证过没有」和 Agent 的自述分开写清楚。
        const verification = await this.verificationView(task, config, state);
        const resultActions = await this.resultActionCapabilities(task, config, state);
        const elements = [
          ...(explicit ? [] : renderLarkResultElements(verifiedOutput ? [verifiedOutput] : task.events)),
          ...(context && this.workflows ? await this.workflows.result(context, '') : []),
          ...(verification.element ? [verification.element] : []),
          ...(terminalMention ? [{ tag: 'markdown', element_id: 'group_mention', content: terminalMention }] : [])];
        if (this.stopped || task.turn !== currentTurn) return;
        const resultCardInput = {
          ...cardContext, cardKind: 'result' as const, state, taskId: task.id, taskName: taskTitle,
          sessionId: task.sessionId, turn: currentTurn, readOnly: true,
          elapsedSeconds: (Date.now() - task.startedAt!) / 1_000,
          capabilities: { ...this.capabilitiesForTask(task), canVerify: verification.canRun, ...resultActions },
          ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {})
        };
        const result = await completeExplicitFinal(this.workflowOptions.store, this.service, finalContext, resultCardInput, elements) ?? await sendLarkResult(this.service, {
          chatId: event.chatId,
          ...(event.chatType === 'group' ? { replyMessageId: event.messageId, replyInThread: Boolean(event.threadId?.trim()) } : {})
        }, { ...resultCardInput, elements, idempotencyKey: larkResultKey(task.cardMessageId ?? larkSilentResultAnchor(task.id, currentTurn)) }, this.log, this.workflowOptions.store);
        if (this.stopped || task.turn !== currentTurn) return;
        task.finalAttachmentMessageId = result.attachmentMessageId;
        task.finalMessageId = result.messageId;
        task.finalDeliveryState = 'delivered';
        task.finalDeliveredTurn = currentTurn;
        task.finalElements = result.elements;
        task.finalCardInput = resultCardInput;
        if (context && this.workflows) await this.workflows.result(context, result.messageId, result.attachmentMessageId ? [result.attachmentMessageId] : undefined).catch(error => {
          this.log.warn({ error, taskId: task.id }, '结果已送达，验收绑定等待对账补齐');
          this.scheduleReconcile();
        });
        if (this.stopped || task.turn !== currentTurn) return;
        await this.saveCardTask(task, state);
        if (context && this.workflows) {
          const feedback = (await this.workflows.list(config.appId)).find(item => item.kind === 'result' && item.taskId === context.taskId && ['accepted', 'needs_changes'].includes(item.state));
          if (feedback) await this.refreshResultFeedback(config, feedback.id);
        }
      }).catch(error => {
        this.log.error({ error, taskId: task.id, state }, '交付飞书执行结果失败，等待对账补偿');
        this.scheduleReconcile();
      }).finally(() => { terminalDelivery = undefined; });
      return terminalDelivery;
    };

    const closeSupersededPreparedTurn = async () => {
      if (task.epoch === (group.epoch ?? 0)) return false;
      this.pushTaskError(task, '这条请求没有执行：期间收到了 /new。请在新会话中重新发送。');
      task.state = 'interrupted'; task.retryable = false;
      await deliverTerminal('interrupted', false);
      if (task.inbox) await this.inbox!.update(task.inbox, { state: 'failed', error: '请求在执行前被 /new 作废' });
      return true;
    };

    const scheduleHeartbeat = () => {
      if (!heartbeatActive || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (!this.stopped && task.turn === currentTurn) {
          void this.observeLiveWaiters(task).catch(error => this.log.warn({ error, taskId: task.id }, '待处理问题卡暂未送达，将随心跳重试'));
          // 跑够长才置顶：短任务不该改写群成员的会话列表。失败已在管理器内兜底。
          void this.pinLongRunningCard(task);
        }
        void update('running').finally(scheduleHeartbeat);
      }, Math.max(config.pushIntervalMs, cardRateLimitedUntil - Date.now()));
    };
    task.requestUpdate = async (state, completed) => {
      if (state === 'completed' || state === 'failed' || state === 'interrupted' || state === 'cancelled') return deliverTerminal(state, completed);
      await update(state);
    };
    const injected: string[] = [];
    injected.push(`[Dutydeck 机器人身份]
- 机器人名称：${config.name ?? config.appId}
- App ID：${config.appId}${session.cwd ? `\n- 工作区：${session.cwd}` : ''}`);
    injected.push('[飞书结果说明] 最终回复先用一两句话说明用户目标已完成什么、还有什么未完成及需要用户做什么；有交付物再给入口。等待扫码、外部批准或用户操作时明确写出，不把本轮结束写成目标已完成；无需展开执行日志。');
    if (event.chatType === 'group' && this.workflowOptions.participation) {
      try {
        const observedContext = await withLarkContextReadTimeout(this.workflowOptions.participation.taskContext({ appId: config.appId, chatId: event.chatId }, prompt), '群上下文读取');
        if (observedContext) injected.push(observedContext);
        const instructions = await withLarkContextReadTimeout(this.workflowOptions.participation.instructions({ appId: config.appId, chatId: event.chatId }), '群长期指令读取');
        if (instructions.trim()) injected.push(`[Dutydeck 群长期指令 · 管理者配置]\n${instructions.trim()}`);
      } catch (error) {
        if (this.stopped || task.turn !== currentTurn || await closeSupersededPreparedTurn()) return;
        this.log.warn({ error, chatId: event.chatId, messageId: event.messageId }, '执行前读取群上下文失败');
        this.pushTaskError(task, '上下文读取超时或失败，Agent 尚未执行。请稍后重新发送请求。');
        task.state = 'failed'; task.retryable = false;
        await deliverTerminal('failed', false);
        if (task.inbox) await this.inbox!.update(task.inbox, { state: 'failed', error: '上下文读取超时或失败' });
        await clearAcknowledgement();
        return;
      }
    }
    if (this.stopped || task.turn !== currentTurn || await closeSupersededPreparedTurn()) return;
    if (config.preInjectPrompt?.trim()) injected.push(`[Dutydeck 预注入 Prompt]\n${config.preInjectPrompt.trim()}`);
    // 会话记忆随 agentPrompt 一起冻结进任务账本：事后能核对这一轮 Agent 看到的是哪几条记忆。
    // 读取失败只丢本轮注入并留日志，不阻断任务。
    if (config.memoryEnabled !== false && this.workflowOptions.memory) {
      try {
        const { store, projection, command } = this.workflowOptions.memory;
        const scope = { appId: config.appId, chatId: event.chatId };
        const [entries, state] = await withLarkContextReadTimeout(Promise.all([
          store.list(scope),
          store.getState(scope)
        ]), '会话记忆读取');
        const index = renderMemoryIndex(entries, state);
        const memoryBlock = renderLarkMemoryInjection(index.text, {
          command: command ?? 'dutydeck',
          directory: projection.directoryFor(scope)
        });
        if (memoryBlock) injected.push(memoryBlock);
      } catch (error) {
        this.log.warn({ error, appId: config.appId, chatId: event.chatId, taskId: task.id }, '读取飞书会话记忆失败，本轮不注入记忆');
        injected.push('[Dutydeck 会话记忆状态] 会话记忆读取超时或失败，本轮未注入记忆；不要把未读到的内容判断为不存在。');
      }
    }
    if (event.chatType === 'group' && config.groupToolsEnabled && config.groupToolsAllowSend) {
      injected.push(`[Dutydeck 飞书当前消息 · 系统上下文]
- 当前消息 message_id：${event.messageId}
- 当前消息 thread_id：${event.threadId?.trim() || '事件未提供'}
- 若要延续当前讨论或回答当前提问，使用 group send --reply-to ${event.messageId} --in-thread。
- 若内容是独立公告、新任务或不应归入当前讨论，使用 group send 且不要传 --reply-to/--in-thread。
- reply-to 只能使用 om_* message_id，不能使用 omt_* thread_id。`);
    }
    if (riskControlEnabled && !highRiskAuthorized) injected.push(`[Dutydeck 安全策略 · 自动注入]\n当前飞书发送人不在高危操作允许名单中。禁止执行匹配以下正则的操作，也不要通过脚本、子进程、MCP 或其他等价方式绕过：\n${highRiskPattern}\n如果用户要求此类操作，请明确说明已被 Dutydeck 安全策略阻止。`);
    const agentPrompt = injected.length ? `${injected.join('\n\n')}\n\n[用户请求]\n${materialPrompt}` : materialPrompt;

    if (this.stopped || task.turn !== currentTurn || await closeSupersededPreparedTurn()) return;

    const appendEvent = (agentEvent: AgentEvent) => {
      const previous = task.events.at(-1);
      const data = agentEvent.data as any;
      const previousData = previous?.data as any;
      if (agentEvent.type === 'text' && previous?.type === 'text'
        && (data?.role ?? 'assistant') === (previousData?.role ?? 'assistant')) {
        task.events[task.events.length - 1] = { ...previous, data: { ...previousData, text: `${previousData?.text ?? ''}${data?.text ?? ''}` } };
      } else task.events.push(agentEvent);
      // Bound activity history after merging streamed text, so a long answer
      // also stays complete for runtimes without durable event retrieval.
      const maxBufferedEvents = Math.max((config.traceLimit ?? defaultLarkTraceLimit) * 20, 200);
      if (task.events.length > maxBufferedEvents) task.events = task.events.slice(-maxBufferedEvents);
    };

    if (this.runtime.dispatch) {
      task.state = 'queued';
      let runtimeTaskId: string | undefined;
      let active = false;
      let settling = false;
      let settled = false;
      let buffered: AgentEvent[] = [];
      let unsubscribe = () => {};
      const cleanup = () => {
        this.turnCleanups.delete(cleanup);
        heartbeatActive = false;
        if (timer) clearTimeout(timer);
        unsubscribe();
        // 只清自己那一轮的句柄。旧轮次的 cleanup 可能在重试开跑之后才执行
        // （deliverTerminal 的 await 刚回来），此时 requestUpdate 已经属于新一轮，
        // 清掉会让新一轮的刷新/取消变成「任务已结束」——与非 dispatch 分支的 finally 同规则。
        if (task.turn === currentTurn) task.requestUpdate = undefined;
      };
      this.turnCleanups.add(cleanup);
      const finish = (state: 'completed' | 'failed' | 'interrupted' | 'cancelled') => {
        if (settling || settled) return;
        settling = true;
        heartbeatActive = false;
        void (async () => {
          if (runtimeTaskId && this.runtime.getRecentEvents) {
            try {
              const recentLimit = Math.max((config.traceLimit ?? defaultLarkTraceLimit) * 30, 500);
              const persistedEvents = await loadLarkTaskEvents(this.runtime, session.id, runtimeTaskId, recentLimit);
              // 读事件期间用户可能已经重试；旧轮次不得改写新一轮的事件缓冲。
              if (task.turn !== currentTurn) return;
              task.events = persistedEvents;
            } catch (error) {
              this.log.warn({ error, taskId: task.id, runtimeTaskId }, '读取任务最终事件失败，使用已接收事件生成终态卡片');
            }
          }
          // 若轮次已变（用户点击了重试并启动了新一轮），本轮终态回调不得覆盖新状态。
          if (task.turn !== currentTurn) return;
          verifiedOutput = state === 'completed' && runtimeTaskId
            ? await verifiedLarkRecoveryOutput(this.runtime, session.id, runtimeTaskId, task.events) : undefined;
          const resolvedState = state === 'completed' && !verifiedOutput && hasUnresolvedToolCalls(task.events) ? 'failed' : state;
          if (resolvedState !== state) this.log.warn({ taskId: task.id, runtimeTaskId }, '任务已结束但仍有工具未返回结果，按失败终态处理');
          settled = true;
          active = false;
          task.state = resolvedState;
          if (runtimeTaskId) await this.workflows?.expireTask(config.appId, runtimeTaskId);
          await deliverTerminal(resolvedState, resolvedState === 'completed').finally(cleanup);
          // 记忆提取排在终态交付之后，且只记真实 dispatch 过的完成轮次；失败只留日志。
          const memoryPipeline = this.workflowOptions.memory?.pipeline;
          if (memoryPipeline && resolvedState === 'completed' && runtimeTaskId) {
            void memoryPipeline.onTurnCompleted({ appId: config.appId, chatId: event.chatId }, { sessionId: session.id, taskId: runtimeTaskId, senderId: event.senderOpenId, senderKind: botSender ? 'bot' : 'human', sourceMessageId: event.messageId })
              .catch(error => this.log.warn({ error, appId: config.appId, chatId: event.chatId, taskId: runtimeTaskId }, '飞书会话记忆后台提取触发失败'));
          }
        })().catch(error => this.log.error({ error, taskId: task.id, runtimeTaskId }, '生成飞书任务终态失败'));
      };
      const receive = (agentEvent: AgentEvent) => {
        // 旧订阅可能在重试之后才送来事件（unsubscribe 发生在 cleanup，而 cleanup 排在
        // 终态交付之后）。这些事件属于上一轮，既不能推进新一轮状态，也不能混进它的缓冲。
        if (this.stopped || task.turn !== currentTurn) return;
        if (agentEvent.type === 'task') {
          const record = (agentEvent.data as any)?.task;
          if (!record || record.id !== runtimeTaskId) return;
          if (record.status === 'running') {
            active = true;
            heartbeatActive = true;
            task.state = 'running';
            if (!resumeTask) task.startedAt = Date.now();
            void update('running').finally(scheduleHeartbeat);
          } else if (record.status === 'reconcile_required' || record.status === 'legacy_unresolved') {
            active = false;
            heartbeatActive = false;
            task.state = record.status;
            void update(record.status)
              .then(() => this.saveCardTask(task, record.status))
              .catch(error => this.log.warn({ error, taskId: task.id, status: record.status }, '更新需要核对状态卡片失败'))
              .finally(() => this.scheduleReconcile());
          } else if (record.status === 'completed' || record.status === 'failed' || record.status === 'interrupted' || record.status === 'cancelled') finish(record.status);
          return;
        }
        if (!active || settled) return;
        appendEvent(agentEvent);
        const context = this.interactionContext(task);
        if (context) void this.workflows?.observe(context, agentEvent, this.workflowObserveOptions(task)).catch(error => this.log.error({ error, taskId: task.id }, '发送飞书工作请求失败'));
        if (!settling) scheduleHeartbeat();
      };
      unsubscribe = this.runtime.subscribe(session.id, agentEvent => {
        if (!runtimeTaskId) buffered.push(agentEvent);
        else receive(agentEvent);
      });
      try {
        const runtimeTask = resumeTask
          ? { ...((await this.runtime.getTasks!(session.id)).find(item => item.id === resumeTask!.id) ?? resumeTask), replayed: true, queuedAhead: 0 }
          : task.inbox
          ? await this.runtime.dispatch(session.id, prompt, 'queue', agentPrompt, riskPolicy, event.senderOpenId, `lark:${config.appId}:${event.messageId}:${currentTurn}`)
          : config.managedGroup
          ? await this.runtime.dispatch(session.id, prompt, 'queue', agentPrompt, riskPolicy, event.senderOpenId)
          : riskPolicy
          ? await this.runtime.dispatch(session.id, prompt, 'queue', agentPrompt, riskPolicy)
          : await this.runtime.dispatch(session.id, prompt, 'queue', agentPrompt);
        runtimeTaskId = runtimeTask.id;
        // S8：恢复接上的任务只置位一次；之后排队 PATCH 与每一帧非终态心跳都带重启注记。
        if (runtimeTask.replayed) task.replayedNote = true;
        // dispatch 期间用户可能已经重试（group.tail 在 dispatch 建立订阅后就 resolve 了）。
        // 旧轮次不得把自己的 runtime task 写成新一轮的，否则 mapping 里的任务归属就错了。
        if (task.turn !== currentTurn) return;
        task.runtimeTaskId = runtimeTask.id;
        // /steer 的降级：运行时没有「注入当前轮」的原语，只能把这条提到队首。
        // 注记按真实结果写：提升成功、提升失败、或本来就没有排队都各说各的，不预告成功。
        if (task.steer) {
          // 前面真的有东西才谈得上插队：只有自己一条时 steerQueued 无事可做，
          // 调了它再把异常写成「提升失败」，会把一个本来正常的情形说成出了问题。
          const ahead = this.runtime.getTasks
            ? (await this.runtime.getTasks(session.id).catch(() => []))
              .filter(item => item.id !== runtimeTask.id && (item.status === 'queued' || item.status === 'running'))
            : [];
          task.steerNote = runtimeTask.status !== 'queued' || !ahead.length
            ? '当前 Agent 不支持插话。此刻没有别的任务排在前面，这条内容会直接按顺序执行。'
            : !this.runtime.steerQueued
              ? '当前 Agent 不支持插话，运行时也无法调整队列顺序：这条内容按正常顺序排队。'
              // 派发要花上几秒（附件、建会话），期间正在执行的可能已经换成别人的任务：
              // 真正动手前重新过一次中断门，命令层那次检查不能替这一刻背书。
              // 这道门要查通讯录（isMember 会真打飞书接口），抛异常不能连累这条任务：
              // runtime 已经接收它、还会照跑，把它打成 failed 就是发一张与事实相反的终态卡。
              // 提升本身 fail closed：判不了就不提升。
              : !await this.canInterruptCurrentTurn(config, event, session.id).catch(() => false)
                ? '当前 Agent 不支持插话，且无法确认你有权中断正在执行的那一轮：这条内容按正常顺序排队。'
                : await this.runtime.steerQueued(session.id, runtimeTask.id, event.senderOpenId)
                .then(() => '当前 Agent 不支持插话。已把这条内容提到队首，当前正在执行的那一轮会被中断。')
                .catch(error => {
                  this.log.warn({ error, runtimeTaskId }, '插话降级：提升队首失败，任务按原顺序排队');
                  return '当前 Agent 不支持插话，且提升队首失败：这条内容按正常顺序排队。';
                });
        }
        const mappingCommitted = await this.saveCardTask(task, task.state).then(() => true, error => {
          this.log.error({ error, runtimeTaskId }, '任务已接收，卡片映射待重启对账'); return false;
        });
        const contextCommitted = await (contextCommit?.() ?? Promise.resolve()).then(() => true, error => {
          this.log.warn({ error, runtimeTaskId }, '任务已接收，材料水位待重启对账'); return false;
        });
        if (task.inbox && contextCommitted && mappingCommitted) await this.inbox!.update(task.inbox, { state: 'accepted', taskId: runtimeTask.id }).catch(error => this.log.error({ error, runtimeTaskId }, '任务已接收，入站记录待重启对账'));
        if (task.turn !== currentTurn) return;
        // 先提交 queued UI，再消费订阅期间缓存的 running 事件，杜绝 running→queued 闪回。
        if (runtimeTask.status === 'queued' && task.state === 'queued') {
          const recovery = await describeLarkTaskRecovery(this.runtime, session.id, runtimeTask.id, 'queued', runtimeTask.queuedAhead);
          const queueMarkdown = withCardNotes(recovery.markdown);
          // 此时 runtimeTaskId 已就位，取消排队才真正可执行，因此这一版卡片开始提供
          // 「取消」。首张「已接收」卡片刻意不提供（runtimeTaskId 尚未分配，点了必失败）。
          try {
            if (!task.cardMessageId || silentProgress || task.progressFrozen) await update('queued');
            else await this.service.update({ ...cardContext, cardKind: 'process', messageId: task.cardMessageId, permissionMode: larkPermissionMode(config), state: 'queued', statusLabel: recovery.label, taskId: task.id, taskName: taskTitle, markdown: queueMarkdown, sessionId: task.sessionId, turn: task.turn, capabilities: this.capabilitiesForTask(task), ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) });
            await this.saveCardTask(task, 'queued');
          } catch (error) {
            // Runtime already owns this task. A receipt/mapping outage must not
            // discard buffered events or report the accepted execution failed.
            this.log.warn({ error, runtimeTaskId }, '任务已接收，排队卡片待后续更新');
            this.scheduleReconcile();
          }
        }
        for (const agentEvent of buffered) receive(agentEvent);
        buffered = [];
        if (runtimeTask.replayed) {
          receive({ id: `replayed_${runtimeTask.id}`, sessionId: session.id, sequence: 0, timestamp: new Date().toISOString(), type: 'task', data: { task: runtimeTask } });
          if (runtimeTask.status === 'running') await this.observeLiveWaiters(task).catch(error => this.log.error({ error, runtimeTaskId }, '恢复任务待处理问题失败'));
        }
      } catch (error) {
        // dispatch 失败也可能是在重试之后才抛出的；旧轮次不得把新一轮打成 failed。
        if (task.turn !== currentTurn) return;
        if (error instanceof RuntimeError && error.code === 'RUNTIME_SHUTTING_DOWN') { cleanup(); return; }
        task.events.push({ id: `lark-error-${event.messageId}`, sessionId: session.id, sequence: Number.MAX_SAFE_INTEGER, type: 'error', timestamp: new Date().toISOString(), data: { message: error instanceof Error ? error.message : String(error) } });
        task.state = 'failed';
        await deliverTerminal('failed', false);
        cleanup();
      }
      return;
    }

    const unsubscribe = this.runtime.subscribe(session.id, agentEvent => {
      if (this.stopped || task.turn !== currentTurn) return;
      appendEvent(agentEvent);
      scheduleHeartbeat();
    });
    try {
      heartbeatActive = true;
      scheduleHeartbeat();
      if (config.managedGroup) await this.runtime.send(session.id, prompt, agentPrompt, riskPolicy, event.senderOpenId);
      else if (riskPolicy) await this.runtime.send(session.id, prompt, agentPrompt, riskPolicy);
      else if (agentPrompt === prompt) await this.runtime.send(session.id, prompt);
      else await this.runtime.send(session.id, prompt, agentPrompt);
      // 若轮次已变（用户在 send 期间点击了重试），本轮不得覆盖新状态。
      if (task.turn !== currentTurn) return;
      if (task.interruptRequested) {
        task.state = 'interrupted';
        await deliverTerminal('interrupted', false);
      } else {
        task.state = 'completed';
        await deliverTerminal('completed', true);
      }
    } catch (error) {
      if (task.turn !== currentTurn) return;
      if (task.interruptRequested) {
        task.state = 'interrupted';
        await deliverTerminal('interrupted', false);
      } else {
        if (!task.events.some(item => item.type === 'error')) task.events.push({ id: `lark-error-${event.messageId}`, sessionId: session.id, sequence: Number.MAX_SAFE_INTEGER, type: 'error', timestamp: new Date().toISOString(), data: { message: error instanceof Error ? error.message : String(error) } });
        task.state = 'failed';
        await deliverTerminal('failed', false);
      }
    } finally {
      heartbeatActive = false;
      if (timer) clearTimeout(timer);
      unsubscribe();
      if (task.turn === currentTurn) task.requestUpdate = undefined;
    }
  }
}
