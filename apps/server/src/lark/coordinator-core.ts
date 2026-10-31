import { larkMessageAnchor } from './message-anchor.js';
import type { LarkGroupParticipation } from './group-participation.js';
import { randomUUID } from 'node:crypto';
import type { RelayAskBroker, RelayAskContext, RelayDeferredAsk } from '@dutydeck/relay';
import { LarkWorkflowInteractions, type LarkInteraction, type LarkInteractionContext } from './workflow-interactions.js';
import { LarkTaskInbox, type LarkInboxRecord } from './task-inbox.js';
import type { LarkLaunchOptions } from './new-session.js';
import { LarkMemoryStore } from './memory.js';
import type { LarkMemoryPipeline } from './memory-pipeline.js';
import type { LarkGroupManager } from './group-management.js';
import { deferredConfirmationId, parseLarkSourceId } from '@dutydeck/shared';
import type { ChannelMappingRepository, ConfigRepository, PolicyAction, PolicyDecision } from '@dutydeck/shared';
import { defaultHighRiskPattern, readLarkConfig, type StoredLarkConfig } from './config.js';
import { LarkServiceError, type LarkCardService } from './service.js';
import { isLarkReplyTargetUnavailable } from './api-gate.js';
import type { LarkHeldCause, LarkRedispatchInfo } from './turn-redispatch.js';
import { larkNotice } from './notify-tier.js';
import { LarkPinManager } from './pin-manager.js';
import type { LoginLinkStore } from '../auth/auth.js';
import { larkReplyContext, type LarkChatModeResolver } from './session-resolver.js';
import { larkCardFollowUpTitle } from './card-actions.js';
import { larkCommandEcho } from './commands.js';
import { escapeLarkPromptEcho } from './queue-summary.js';
import type { ListenerLog, LarkMessageEvent, LarkRuntime } from './listener.js';
import type { LarkGroup, LarkTask } from './coordinator.js';
import { parseCardTask } from './persisted-card-task.js';
import { loadLarkTaskEvents } from './card-renderer.js';

// 飞书消息协调器 · 公共层：实例状态与构造、各层共用的权限判定和工具函数。分层说明见 coordinator.ts。

export type LarkCommandPrompt = { prompt: string; suggestion?: string; materialPrompt?: string; launchOptions?: LarkLaunchOptions; epoch?: number; steer?: boolean };

export const larkCardChannel = (appId: string) => `lark-card:${appId}`;
export type LarkRelaunchAction = 'run_in_new_session' | 'rerun_in_new_session';
/**
 * 「在新会话中执行」的持久化认领，键按 App + 原消息 + 轮次：重复点击、重复投递、重启后的重复回调读到的都是这一条。
 * claimed：正在转交（boot 不是本进程，说明上一个进程半路退出，下一次点击可以接手）；
 * moved：原请求已交给入站记录在新会话中执行，之后的点击只回执；failed：已回滚，可以再点。
 *
 * 服务重启切断那一轮的重投（redispatchInterruptedTurn）复用同一形状，存在 redispatchKey 下并带 redispatch：
 * held：停下等人在卡上选「重新执行」「放弃」；abandoned：点了「放弃」。静默进展下没有过程卡，cardMessageId 为空串。
 */
export type LarkRelaunchClaim = {
  id: string; boot: string; phase: 'claimed' | 'moved' | 'failed' | 'held' | 'abandoned'; action: LarkRelaunchAction;
  appId: string; taskId: string; turn: number; chatId: string; cardMessageId: string; taskName: string;
  sessionId: string; runtimeTaskId: string; operatorOpenId: string; newSessionId?: string;
  redispatch?: LarkRedispatchInfo & Omit<LarkHeldCause, 'count'>;
};
/**
 * 转交或 /new 时作废、留给管理员核对的旧会话。它的执行进程未确认停止：/new 不去停它，续聊与之后的转交都不再选回它。
 * 键按 App + 会话落库，重启后仍成立；判断只看键在不在，值只是来源记录。
 */
export const relaunchRetainedPrefix = (appId: string) => `lark.relaunch_retained.${appId}.`;
export const relaunchRetainedKey = (appId: string, sessionId: string) => relaunchRetainedPrefix(appId) + sessionId;
/** 去掉开头对本机器人的 @（可能连着好几个）。卡片标题与重复请求判定共用。 */
export const withoutLeadingBotMention = (prompt: string, botName?: string) => {
  const mention = botName?.trim() ? `@${botName.trim()}` : '';
  let text = prompt.trim();
  // 名字后面必须是空白或结尾：@bdev-flashy 不是在 @ bdev-flash。
  while (mention && text.startsWith(mention) && !/^\S/.test(text.slice(mention.length))) text = text.slice(mention.length).trimStart();
  return text;
};
/**
 * 过程卡标题：用户原话，去掉对本机器人的所有 @ 和「[图片]」这类占位——卡片回复在原消息下面，
 * 标题里读到机器人自己的名字、一串占位都是噪声；@ 别人是原话的一部分，保留。
 * 一键续问代发的固定提示词不当标题，用那个按钮的名字（「对外回复版」「详细版」）。
 */
export const larkTaskTitle = (prompt: string, botName?: string) => {
  const plain = withoutLeadingBotMention(prompt, botName) || prompt.trim();
  const followUp = larkCardFollowUpTitle(plain);
  if (followUp) return followUp;
  const mention = botName?.trim() ? `@${botName.trim()}` : '';
  // 整词比较：@bdev-flashy 不是在 @ bdev-flash。
  const cleaned = plain.replace(/\[(?:图片|文件|视频|语音|表情|表情包)\]/g, ' ')
    .split(/\s+/).filter(word => !mention || word !== mention).join(' ').trim();
  // 去掉之后什么都不剩（只发了一张图、只 @ 了机器人）时给个中性的名字，不把占位写回标题。
  return (cleaned || '新请求').slice(0, 80);
};
/**
 * 续聊规则与在原位置发言一致：按发送人隔离的会话（user:）只有发起人本人发言才会回到它；
 * 话题、整群与私聊会话由在原位置发言的人共用。message: 是缺身份时的一次性会话，谁也续不上。
 */
export const larkScopeContinuesFor = (scopeId: string, operatorOpenId: string) =>
  scopeId.startsWith('user:') ? scopeId === `user:${operatorOpenId}` : !scopeId.startsWith('message:');

// 群消息统一回复触发消息；话题消息显式 reply_in_thread，避免卡片脱离提问人的话题。
export async function sendTaskCard(
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
      // 只有平台明确说触发消息不能再回复（已撤回、不可见等）才回退为群内发送。超时、断连、5xx 时回复可能已经送达，
      // 换接口会多出一张卡、首张过程卡永远停在「已接收」；原样抛出，由调用方用同一 UUID 重发同一个回复。
      if (!isLarkReplyTargetUnavailable(error)) throw error;
      log?.warn({ error, messageId: event.messageId, chatId: event.chatId }, '回复卡片失败，回退为群内发送');
      return await service.send({ chatId: event.chatId, ...executionInput });
    }
  }
  return await service.send({ chatId: event.chatId, ...executionInput });
}

export abstract class LarkCoordinatorCore {
  protected readonly groups = new Map<string, LarkGroup>();
  protected readonly tasks = new Map<string, LarkTask>();
  protected readonly handledMessages = new Set<string>();
  protected reconcileTimer?: NodeJS.Timeout;
  protected reconcileRun?: Promise<number>;
  protected reconcileConfig?: StoredLarkConfig;
  protected reconcileIntervalMs = 5_000;
  protected stopped = false;
  protected readonly turnCleanups = new Set<() => void>();
  /** P0-1：他人任务取消/中断/重试的二次确认键 → 过期时间戳（60s），惰性清理。 */
  protected readonly foreignActionConfirmations = new Map<string, number>();
  protected readonly workflows?: LarkWorkflowInteractions;
  protected readonly inbox?: LarkTaskInbox;
  /** 长任务进度卡置顶。默认关闭（见 config.pinLongTasks），但对账在关闭后仍要能撤掉僵尸置顶。 */
  protected readonly pins?: LarkPinManager;
  protected taskAgentTimer?: NodeJS.Timeout;
  protected taskAgentRun?: Promise<number>;
  /** 已写回飞书任务记录的 `${guid}:${turn}:${state}`，避免同一状态被心跳重复写。 */
  protected readonly writtenTaskSteps = new Set<string>();
  /** 会话记忆：与 inbox / workflows 共用 workflowStore，缺存储时三条记忆命令收敛为 unavailable，也不注入。 */
  protected readonly memory?: LarkMemoryStore;
  /** 本进程的转交世代：认领上的 boot 不是它，说明那次转交随上一个进程中断了。 */
  protected readonly relaunchBoot = randomUUID();

  constructor(
    protected readonly runtime: LarkRuntime,
    protected readonly service: LarkCardService,
    protected readonly log: ListenerLog,
    private readonly _random: () => number = Math.random,
    protected readonly botOpenId?: string,
    protected readonly peerBotAuthorized?: (chatId: string, senderOpenId: string) => Promise<boolean>,
    protected readonly cardMappings?: ChannelMappingRepository,
    protected readonly chatModeResolver?: LarkChatModeResolver,
    private readonly executionPolicy?: {
      integrationMode: 'legacy_unmanaged';
      authorize(boundary: 'listener' | 'session' | 'high_risk', action: PolicyAction): Promise<PolicyDecision>;
    },
    protected readonly groupManager?: LarkGroupManager,
    protected readonly workflowOptions: {
      participation?: LarkGroupParticipation;
      scheduleRequests?: import('../agent-schedule-request.js').LarkScheduleRequests;
      saveBotConfig?(input: import('./config.js').SaveLarkConfigInput): Promise<unknown>;
      usage?: Pick<import('../usage-ledger.js').UsageLedger, 'describe'>;
      store?: ConfigRepository;
      resourceRoot?: string;
      broker?: RelayAskBroker;
      automation?: import('../session-automation.js').SessionAutomationService;
      workbench?: import('./workbench.js').LarkWorkbench;
      memory?: {
        store: LarkMemoryStore;
        pipeline?: LarkMemoryPipeline;
      };
      /** Web 要求登录时提供；「查看详情」据此改为给管理员私信一次性登录链接。 */
      loginLinks?: Pick<LoginLinkStore, 'issue'>;
    } = {},
  ) {
    this.memory = workflowOptions.memory?.store;
    if (workflowOptions.store) {
      this.inbox = new LarkTaskInbox(workflowOptions.store);
      this.workflows = new LarkWorkflowInteractions(workflowOptions.store, runtime, service, workflowOptions.broker,
        (record, actor, action) => this.authorizeInteraction(record, actor, action),
        { log: this.log, approverCandidates: record => this.groupManager?.highRiskOpenIds(record.appId, record.event.chatId) ?? Promise.resolve([]),
          onPlanDecision: record => this.submitPlanDecision(record),
          onConfirmation: record => this.submitConfirmation(record), confirmationAvailable: record => this.confirmationAvailable(record) });
      const unregister = workflowOptions.broker?.addDeferredHandler((input, context) => this.deferConfirmation(input, context));
      if (unregister) this.turnCleanups.add(unregister);
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
  protected applyReminderSettings(config: StoredLarkConfig) {
    this.workflows?.configureUrgent(config.urgentEnabled === true
      ? {
        enabled: true,
        ...(config.urgentThresholdMs !== undefined ? { thresholdMs: config.urgentThresholdMs } : {}),
        ...(config.urgentMaxPerHourPerChat !== undefined ? { maxPerHourPerChat: config.urgentMaxPerHourPerChat } : {}),
        ...(config.notifyQuietHours ? { quietHours: config.notifyQuietHours } : {})
      }
      : false);
  }

  /** 结构化问答/群 @ 等 observe 渲染开关统一取自任务配置，三处 observe 调用共用同一口径。 */
  protected workflowObserveOptions(task: LarkTask) {
    return {
      adhdMode: task.config.adhdMode === true,
      structuredAskCards: task.config.structuredAskCards !== false,
      ...(task.config.webBaseUrl ? { webBaseUrl: task.config.webBaseUrl } : {}),
      groupMention: larkNotice('permission_card', task.config, task.event).mentionAllowed,
      highRiskPattern: task.config.highRiskPattern || defaultHighRiskPattern,
      // 按「本会话允许」自动批准的请求不另发卡：在进度卡原来那条权限记录上标注，随下一帧原位刷新。
      onSessionAllowed: (permissionId: string) => {
        task.events.push({ id: `session_allowed_${permissionId}`, sessionId: task.sessionId ?? '', sequence: 0, timestamp: new Date().toISOString(),
          type: 'permission_request', data: { id: permissionId, sessionAllowed: true } });
      }
    };
  }

  protected async authorizeFinalRelay(scope: import('./explicit-final.js').ExplicitFinalScope, actorId: string) {
    const stored = this.workflowOptions.store && await readLarkConfig(this.workflowOptions.store, scope.app_id);
    const config = stored && (await this.groupManager?.resolved(stored, scope.chat_id) ?? stored);
    if (!config || !config.listening || !config.groupToolsEnabled || !config.groupToolsAllowSend
      || !await this.isOperatorAllowed(config, actorId, scope.chat_id, scope.session_id, actorId, 'group_tools.send')) {
      throw new LarkServiceError('FINAL_RELAY_REVOKED', '原执行身份的回传权限已撤销。', 403);
    }
  }

  protected async currentAccess(config: StoredLarkConfig, chatId: string, chatType: string, actor: string, action: PolicyAction, sessionId?: string, requester?: string) {
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

  async repairClosedCards(appId: string) { await this.workflows?.repairClosedCards(appId); }
  async endDurableConfirmations(appId: string) {
    for (const record of await this.workflows?.list(appId) ?? []) {
      if (record.durable && ['pending', 'resolving'].includes(record.state)) await this.workflows!.endConfirmation(appId, record.id);
    }
  }
  protected async confirmationInputAllowed(inbox: LarkInboxRecord | undefined) {
    if (!inbox?.event.messageId.startsWith('confirmation_') || !inbox.workflowRequestId) return true;
    const record = (await this.workflows?.list(inbox.appId))?.find(item => item.id === inbox.workflowRequestId && item.durable);
    const allowed = Boolean(record && ['resolving', 'answered'].includes(record.state) && inbox.sessionId === record.sessionId
      && inbox.event.senderOpenId === record.actorId && record.actorId && await this.confirmationAvailable(record)
      && await this.authorizeInteraction(record, record.actorId, 'run.interrupt'));
    if (!allowed) {
      await this.workflows?.endConfirmation(inbox.appId, inbox.workflowRequestId);
      if (this.inbox && inbox.state === 'received') await this.inbox.update(inbox, { state: 'failed', error: '已结束，未执行' });
    }
    return allowed;
  }
  protected async confirmationAvailable(record: LarkInteraction) {
    const config = await readLarkConfig(this.workflowOptions.store, record.appId);
    const session = await this.runtime.getSession(record.sessionId);
    if (this.stopped || !config?.listening || !session || session.archivedAt || ['stopped', 'failed'].includes(session.state) || !record.event.senderOpenId) return false;
    try { await this.requireExecution('listener', 'task.create'); } catch { return false; }
    return this.currentAccess(config, record.event.chatId, record.event.chatType, record.event.senderOpenId, 'run.interrupt', record.sessionId, record.event.senderOpenId);
  }
  protected async isDeferredTask(sessionId: string, taskId: string) {
    // Confirmations registered before the host marker was introduced still own their original request.
    const appId = this.reconcileConfig?.appId;
    if (appId && (await this.workflows?.list(appId))?.some(record => record.kind === 'ask' && record.durable
      && record.sessionId === sessionId && record.taskId === taskId)) return true;
    if (this.runtime.getDeferredConfirmationId) return Boolean(await this.runtime.getDeferredConfirmationId(sessionId, taskId));
    if (!this.runtime.getEvents && !this.runtime.getRecentEvents) return false;
    return Boolean(deferredConfirmationId(await loadLarkTaskEvents(this.runtime, sessionId, taskId, 500), taskId));
  }

  protected taskTitle(task: LarkTask, prompt = task.prompt, titleConfig = task.config) {
    return task.config.adhdMode === true && task.id.startsWith('confirmation_')
      ? task.displayName || '已确认' : larkTaskTitle(prompt, titleConfig.name);
  }

  protected async taskDisplayPrompt(config: StoredLarkConfig, chatId: string, sessionId: string, task: { id: string; prompt: string }) {
    if (config.adhdMode !== true) return task.prompt;
    const origin = await this.larkTaskOrigin(config, chatId, { id: task.id, sessionId });
    return origin?.confirmation ? origin.title : task.prompt;
  }

  protected async prepareConfirmationTitle(task: LarkTask) {
    if (task.config.adhdMode !== true || !task.id.startsWith('confirmation_')) return;
    const record = (await this.workflows?.list(task.config.appId))?.find(item => item.durable
      && item.id === task.inbox?.workflowRequestId && task.id === `confirmation_${item.id}` && item.sessionId === task.inbox?.sessionId);
    const original = record?.durable?.snapshot?.prompt;
    task.displayName = typeof original === 'string' && original.trim() && !original.startsWith('持久确认记录 ID：')
      ? larkTaskTitle(original, task.config.name) : '已确认';
  }

  private async deferConfirmation(input: RelayDeferredAsk, context: RelayAskContext) {
    const appId = this.reconcileConfig?.appId;
    if (this.stopped || !appId || !this.workflows || !this.inbox) return undefined;
    const config = await readLarkConfig(this.workflowOptions.store, appId);
    if (!config?.listening || config.adhdMode !== true) return undefined;
    const session = await this.runtime.getSession(input.sessionId);
    if (session?.source !== 'lark' || parseLarkSourceId(session.sourceId).appId !== appId) return undefined;
    if (!context.taskId || context.signal?.aborted) throw new LarkServiceError('LARK_CONFIRMATION_ENDED', '已结束，未执行', 409);
    const mapping = (await this.cardMappings?.list(larkCardChannel(appId)))?.find(item => item.sessionId === input.sessionId
      && parseCardTask(item.extra ?? '{}').runtime_task_id === context.taskId);
    if (!mapping) throw new LarkServiceError('LARK_CONFIRMATION_ENDED', '已结束，未执行', 409);
    const saved = parseCardTask(mapping.extra ?? '{}');
    const original = await this.inbox.lookup(appId, mapping.externalId);
    const task = (await this.runtime.getTasks?.(input.sessionId))?.find(item => item.id === context.taskId);
    if (context.signal?.aborted || task?.status !== 'running' || !original || !saved.scope_id || !session || session.archivedAt) throw new LarkServiceError('LARK_CONFIRMATION_ENDED', '已结束，未执行', 409);
    return this.workflows.defer({ appId, sessionId: input.sessionId, taskId: context.taskId, turn: saved.turn ?? 1,
      event: original.event, taskName: original.event.messageId.startsWith('confirmation_') ? saved.task_name : larkTaskTitle(saved.prompt, config.name) }, input,
      { prompt: saved.prompt, cwd: session.cwd, scopeId: saved.scope_id }, context.signal);
  }
  protected async authorizeInteraction(record: LarkInteraction, actor: string, action: PolicyAction) {
    const config = await readLarkConfig(this.workflowOptions.store, record.appId);
    if (!config?.listening || !record.event.senderOpenId) return false;
    const mapping = await this.cardMappings?.get(larkCardChannel(record.appId), record.event.messageId);
    if (!mapping || mapping.sessionId !== record.sessionId) return false;
    const saved = parseCardTask(mapping.extra ?? '{}');
    if (saved.app_id !== record.appId || saved.chat_id !== record.event.chatId || saved.runtime_task_id !== record.taskId
      || saved.turn !== record.turn || saved.sender_open_id !== record.event.senderOpenId) return false;
    const task = (await this.runtime.getTasks?.(record.sessionId))?.find(item => item.id === record.taskId);
    if (record.durable) {
      if (!await this.confirmationAvailable(record)) return false;
      const requester = record.event.senderOpenId;
      if (actor === requester) return this.currentAccess(config, saved.chat_id, record.event.chatType, actor, 'run.interrupt', record.sessionId, requester);
      const users = config.highRiskAllowedUsers ?? [];
      const emails = config.highRiskAllowedEmails ?? [];
      const listed = users.some(user => user.openId === actor) || (emails.length > 0 && (await this.service.getUserEmails(actor)).some(email => emails.includes(email)))
        || (await this.groupManager?.highRiskOpenIds(record.appId, saved.chat_id) ?? []).includes(actor);
      return listed && this.currentAccess(config, saved.chat_id, record.event.chatType, actor, 'high_risk.execute', record.sessionId, actor);
    }
    if (!task || (record.kind === 'result' || record.kind === 'plan' ? task.status !== 'completed' : task.status !== 'running')) return false;
    return this.currentAccess(config, saved.chat_id, record.event.chatType, actor, action, record.sessionId, saved.sender_open_id);
  }

  /** 计划卡上批准或提修改意见后提交下一轮（见 coordinator-cards）。 */
  protected abstract submitPlanDecision(record: LarkInteraction): Promise<void>;
  protected abstract submitConfirmation(record: LarkInteraction): Promise<void>;

  protected interactionContext(task: LarkTask): LarkInteractionContext | undefined {
    return task.sessionId && task.runtimeTaskId ? { appId: task.config.appId, sessionId: task.sessionId,
      taskId: task.runtimeTaskId, taskName: this.taskTitle(task), turn: task.turn, event: task.event } : undefined;
  }

  protected async requireExecution(boundary: 'listener' | 'session' | 'high_risk', action: PolicyAction) {
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

  protected async resolveSessionAgentName(config: StoredLarkConfig, sessionId: string) {
    return this.resolveAgentName(config, (await this.runtime.getSession(sessionId))?.agentId);
  }

  /** 执行宿主名不进持久化，每次渲染时重新解析：Agent 可能被改名或删除，卡上应显示当前的名字。 */
  protected async resolveAgentName(config: StoredLarkConfig, agentId = config.defaultAgentId) {
    try {
      return (await this.runtime.listAgents?.())?.find(agent => agent.id === agentId)?.name ?? agentId ?? 'Dutydeck';
    } catch (error) {
      this.log.warn({ error, agentId: agentId }, '读取 Agent 展示名失败，使用 Agent ID 渲染卡片');
      return agentId ?? 'Dutydeck';
    }
  }

  /**
   * 飞书任务智能体通道的轮询周期。
   *
   * 60 秒：派活是人的动作，任务界面上指派一条任务到机器人接单之间隔一分钟，与这条通道
   * 的使用节奏相称；聊天入口本来就是实时的，这条是补充入口，不必也不该按秒抢。代价这边，
   * 每轮最多一次列表请求（只有翻页才追加），对租户级限流可以忽略。通道关闭时
   * claimLarkTaskDispatches 在三道门里直接返回，一个请求都不会发出去，定时器空转而已。
   */
  protected readonly taskAgentIntervalMs = 60_000;

  /**
   * 修改本群授权（/grant、/revoke）的鉴权。
   *
   * - 托管群：先按 grant.create / grant.revoke 策略动作判定（owner 或 admin 角色）。
   *   本部署形态下 admin 角色只能由安装管理员在 Web 授予，因此未通过时回落到与 /repair
   *   同一道安装级门（high_risk.execute）——改「谁能使唤机器人」至少和跑一条高风险命令同级。
   * - 非托管群：回落部署级静态白名单，与该形态下其他管理动作口径一致。
   */
  protected async isGrantOperatorAllowed(config: StoredLarkConfig, operatorOpenId: string | undefined, chatId: string, action: PolicyAction): Promise<boolean> {
    if (!operatorOpenId) return false;
    const decision = await this.groupManager?.authorize(config.appId, chatId, operatorOpenId, action);
    if (decision?.allowed) return true;
    return this.isInstallationOperatorAllowed(config, operatorOpenId, chatId);
  }

  /**
   * 卡片操作人的访问权限校验，与 runTurn 中「谁可以使用 Agent」的配置保持一致：
   * - 未配置白名单时所有人均可操作
   * - 配置了 allowedUsers 时按 openId 匹配
   * - 仅配置 allowedEmails 时拉取操作人邮箱匹配
   */
  protected async isTaskOperatorAllowed(config: StoredLarkConfig, event: LarkMessageEvent, target: { id: string; sessionId: string }, action: PolicyAction = 'run.interrupt') {
    const requester = (await this.larkTaskOrigin(config, event.chatId, target))?.requester;
    // Historical records without a requester cannot establish own_runs authority.
    if (config.managedGroup && !requester) return false;
    return this.isOperatorAllowed(config, event.senderOpenId, event.chatId, target.sessionId, requester, action);
  }

  /**
   * 一轮 runtime 任务在飞书这边的发起人、标题与开始时间：内存里的任务优先，重启后从本群的卡片映射读。
   * 都找不到时返回 undefined（历史记录，或不是从飞书消息派发的任务）。
   */
  protected async larkTaskOrigin(config: StoredLarkConfig, chatId: string, target: { id: string; sessionId: string }): Promise<{ requester?: string; title: string; startedAt?: number; confirmation?: boolean } | undefined> {
    const live = [...this.tasks.values()].find(task => task.runtimeTaskId === target.id && task.sessionId === target.sessionId
      && task.config.appId === config.appId && task.event.chatId === chatId);
    if (live?.event.senderOpenId) return { requester: live.event.senderOpenId, title: this.taskTitle(live, live.prompt, config), startedAt: live.startedAt,
      ...(config.adhdMode === true && live.id.startsWith('confirmation_') ? { confirmation: true } : {}) };
    for (const mapping of await this.cardMappings?.list(larkCardChannel(config.appId)) ?? []) {
      if (mapping.sessionId !== target.sessionId) continue;
      const saved = parseCardTask(mapping.extra ?? '{}');
      if (saved.app_id === config.appId && saved.chat_id === chatId && saved.runtime_task_id === target.id) {
        return { requester: saved.sender_open_id, title: saved.task_name, startedAt: saved.started_at,
          ...(config.adhdMode === true && mapping.externalId.startsWith('confirmation_') ? { confirmation: true } : {}) };
      }
    }
    return live ? { title: this.taskTitle(live, live.prompt, config), startedAt: live.startedAt } : undefined;
  }

  /**
   * 「只有发起人和管理员能……」的拒绝说明：写真实原因和本轮发起人（不 @）。显示名只取机器人配置里登记过的成员名，
   * 查不到就只写「本轮发起人」，不为此另查通讯录（名单里没填名字时存的是 open_id 本身，不算显示名）。中断类的拒绝另外说明部署者还能在 Web 上停。
   */
  protected requesterOnlyReason(config: StoredLarkConfig, requesterOpenId: string | undefined, operation: string, interrupting = false) {
    const name = [...config.allowedUsers ?? [], ...config.highRiskAllowedUsers ?? []].find(user => user.openId === requesterOpenId && user.name?.trim() && user.name.trim() !== requesterOpenId)?.name?.trim();
    return `只有本轮发起人${name ? ` ${escapeLarkPromptEcho(larkCommandEcho(name, 40))} ` : ''}和管理员能${operation}。${interrupting ? '部署者可在 Web 停止。' : ''}`;
  }

  /** action 默认 run.interrupt（既有口径）；队列操作传 queue.cancel / queue.promote，走同一套判定。 */
  protected async isOperatorAllowed(config: StoredLarkConfig, operatorOpenId?: string, chatId?: string, sessionId?: string, taskRequesterOpenId?: string, action: PolicyAction = 'run.interrupt'): Promise<boolean> {
    if (this.groupManager && chatId) {
      const decision = await this.groupManager.authorize(config.appId, chatId, operatorOpenId, action, sessionId, { taskRequesterOpenId });
      if (decision) return decision.allowed;
    }
    return this.isStaticOperatorAllowed(config, operatorOpenId, chatId);
  }

  /** 中断按钮仅允许任务发起人或管理员；可使用机器人、can_operate 均不代表管理员。 */
  protected async isInterruptOperatorAllowed(config: StoredLarkConfig, operatorOpenId: string | undefined, chatId: string, sessionId: string | undefined, taskRequesterOpenId: string | undefined): Promise<boolean> {
    if (!operatorOpenId) return false;
    const isRequester = operatorOpenId === taskRequesterOpenId;
    const decision = await this.groupManager?.authorize(config.appId, chatId, operatorOpenId, 'run.interrupt', sessionId, { taskRequesterOpenId });
    if (decision) return decision.allowed && (isRequester || decision.source === 'owner' || decision.source === 'admin');
    return isRequester && await this.isStaticOperatorAllowed(config, operatorOpenId, chatId);
  }

  /**
   * 部署级静态白名单口径（不经过托管群策略）：allowedUsers/allowedEmails/allowedBots。
   * 未配置任何白名单时维持「不限制」的既有默认；bot 身份（230001）按 peer bot 门处理。
   */
  protected async isStaticOperatorAllowed(config: StoredLarkConfig, operatorOpenId?: string, chatId?: string): Promise<boolean> {
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
  protected async isInstallationOperatorAllowed(config: StoredLarkConfig, operatorOpenId?: string, chatId?: string): Promise<boolean> {
    if (!operatorOpenId) return false;
    if (this.groupManager && chatId) {
      const decision = await this.groupManager.authorize(config.appId, chatId, operatorOpenId, 'high_risk.execute');
      if (decision) return decision.allowed;
    }
    return this.isStaticOperatorAllowed(config, operatorOpenId, chatId);
  }

  /**
   * /repair 操作的鉴权：
   * - 托管群：groupManager.authorize(..., 'high_risk.execute') 有明确结论时沿用；
   * - 其它情况（非托管群或无策略绑定）：仅当部署级静态白名单非空且操作人在白名单中时才允许。
   */
  protected async isRepairOperatorAllowed(config: StoredLarkConfig, operatorOpenId?: string, chatId?: string): Promise<{ allowed: boolean; reason?: 'managed_group_denied' | 'unconfigured' | 'unauthorized' }> {
    if (!operatorOpenId) return { allowed: false, reason: 'unauthorized' };
    if (this.groupManager && chatId) {
      const decision = await this.groupManager.authorize(config.appId, chatId, operatorOpenId, 'high_risk.execute');
      if (decision) return { allowed: decision.allowed, reason: decision.allowed ? undefined : 'managed_group_denied' };
    }
    const allowedUsers = config.allowedUsers ?? [];
    const allowedEmails = config.allowedEmails ?? [];
    const accessRestricted = allowedUsers.length > 0 || allowedEmails.length > 0;
    if (!accessRestricted) return { allowed: false, reason: 'unconfigured' };
    const allowed = await this.isStaticOperatorAllowed(config, operatorOpenId, chatId);
    return { allowed, reason: allowed ? undefined : 'unauthorized' };
  }

  private readonly acknowledgements = new Map<NonNullable<LarkTask['acknowledgement']>, LarkMessageEvent>();
  private readonly acknowledgementFlights = new Map<string, Promise<void>>();

  /** 原接收点立即启动反馈；同消息的首卡重试等待旧反馈收敛，不阻塞路由或派发。 */
  protected beginAcknowledgementReaction(event: LarkMessageEvent): NonNullable<LarkTask['acknowledgement']> {
    const acknowledgement: NonNullable<LarkTask['acknowledgement']> = { clearRequested: false };
    this.acknowledgements.set(acknowledgement, event);
    const previous = this.acknowledgementFlights.get(event.messageId);
    // This object belongs to this inbound message, including results arriving after its task was removed.
    const pending = (async () => {
      try {
        // A first-card retry can reuse the same message and platform reaction ID.
        // Finish the previous add/late cleanup before posting its replacement.
        if (previous) await previous;
        if (acknowledgement.clearRequested || this.stopped) {
          await this.clearAcknowledgementReaction({ event, acknowledgement });
          return;
        }
        acknowledgement.reactionId = (await this.service.addReaction(larkMessageAnchor(event), 'OK')).reactionId;
        if (acknowledgement.clearRequested || this.stopped) await this.clearAcknowledgementReaction({ event, acknowledgement });
      } catch (error) { this.log.warn({ error, messageId: event.messageId }, '发送飞书确认表情失败，继续处理消息'); }
    })();
    this.acknowledgementFlights.set(event.messageId, pending);
    void pending.then(() => { if (this.acknowledgementFlights.get(event.messageId) === pending) this.acknowledgementFlights.delete(event.messageId); });
    return acknowledgement;
  }

  /** 进度/失败回执送达后撤销；静默时保留到终态。先登记清理意图，再幂等删除已知 ID。 */
  protected async clearAcknowledgementReaction(task: Pick<LarkTask, 'event' | 'acknowledgement'>) {
    if (task.acknowledgement) {
      task.acknowledgement.clearRequested = true;
      this.acknowledgements.delete(task.acknowledgement);
    }
    const reactionId = task.acknowledgement?.reactionId;
    if (task.acknowledgement) task.acknowledgement.reactionId = undefined;
    if (!reactionId) return;
    try { await this.service.deleteReaction(larkMessageAnchor(task.event), reactionId); }
    catch (error) { this.log.warn({ error, messageId: task.event.messageId, reactionId }, '撤销飞书确认表情失败'); }
  }

  protected pushTaskError(task: LarkTask, message: string) {
    task.events.push({
      id: `lark-action-error-${task.id}-${Date.now()}`,
      sessionId: task.sessionId ?? '',
      sequence: Number.MAX_SAFE_INTEGER,
      type: 'error',
      timestamp: new Date().toISOString(),
      data: { message }
    });
  }

  /** 同一个任务的验证正在跑；重复点击只回提示，不再起第二个进程。 */
  protected readonly verifyInFlight = new Set<string>();

  /** 正在后台执行 /repair 的「应用:确认卡消息」，防止同一张确认卡被重复点击触发多次发布。 */
  protected repairInFlight = new Set<string>();

  /** 他人发起的任务与取消、重试他人任务同一口径：60 秒内再点一次同一按钮才执行。 */
  protected foreignActionConfirmed(operatorOpenId: string, requesterOpenId: string | undefined, target: string) {
    if (!requesterOpenId || operatorOpenId === requesterOpenId) return true;
    const now = Date.now();
    for (const [key, expiresAt] of this.foreignActionConfirmations) {
      if (expiresAt <= now) this.foreignActionConfirmations.delete(key);
    }
    const confirmationKey = `${operatorOpenId}|${target}`;
    if ((this.foreignActionConfirmations.get(confirmationKey) ?? 0) > now) {
      this.foreignActionConfirmations.delete(confirmationKey);
      return true;
    }
    this.foreignActionConfirmations.set(confirmationKey, now + 60_000);
    return false;
  }

  stop() {
    this.stopped = true;
    for (const [acknowledgement, event] of this.acknowledgements) void this.clearAcknowledgementReaction({ event, acknowledgement });
    for (const task of this.tasks.values()) {
      task.contextReadAbort?.abort(new DOMException('Lark coordinator is stopped', 'AbortError'));
      void this.clearAcknowledgementReaction(task);
    }
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
}
