import type { AgentEvent, ChannelMappingRepository, PolicyAction, PolicyDecision, Session, ToolRiskPolicy } from '@dockmux/shared';
import { defaultHighRiskPattern, defaultLarkTraceLimit, type StoredLarkConfig } from './config.js';
import { parseLarkMessageContent, type LarkMessageResource } from './message-content.js';
import { boundLarkCardElements, larkIdentityPermissionHelp, LarkServiceError, type LarkCardService } from './service.js';
import {
  eventsForRuntimeTask,
  hasUnresolvedToolCalls,
  isLarkCardContentRejected,
  isLarkMessageRateLimit,
  isLarkMessageUnupdatable,
  larkRateLimitBackoffMs,
  patchRejectedCardDelta,
  renderLarkCardElements,
  type LarkCardElement
} from './card-renderer.js';
import { performLarkCardReconcile } from './reconciler.js';
import {
  larkGroupKey,
  larkReplyContext,
  materializeLarkResources,
  parsePrompt,
  resolveLarkScopeId,
  resolveLarkSession,
  type LarkChatModeResolver
} from './session-resolver.js';
import type { ListenerLog, LarkMessageEvent, LarkRuntime } from './listener.js';

// 飞书消息协调器（从 listener.ts 拆分）：按群/话题串行化任务轮次、驱动 Agent 会话、
// 渲染并更新服务卡片。卡片终态对账见 reconciler.ts，会话路由见 session-resolver.ts。

export type LarkGroup = { sessionId?: string; sessionConfigKey?: string; tail: Promise<void> };
export type LarkTaskState = 'queued' | 'running' | 'interrupting' | 'interrupted' | 'completed' | 'failed';
export type LarkTask = {
  id: string;
  group: LarkGroup;
  event: LarkMessageEvent;
  prompt: string;
  resources: LarkMessageResource[];
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
  finalDeliveredTurn?: number;
  progressFrozen?: boolean;
  interruptRequested?: boolean;
  requestUpdate?: (state: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted', completed?: boolean) => Promise<void>;
  retryable?: boolean;
  /** 递增的轮次编号，用于防止上一轮的终态回调覆盖重试后的新状态。 */
  turn: number;
  /** 本条消息解析出的会话隔离 scope（与 group key 一致），sessionFor 复用。 */
  scopeId: string;
};
export type PersistedLarkCardTask = {
  app_id: string;
  chat_id: string;
  reply_message_id?: string;
  reply_in_thread?: boolean;
  /** @deprecated 兼容旧记录；历史版本可能错误地写入 omt_* thread_id。 */
  root_message_id?: string;
  card_message_id: string;
  runtime_task_id?: string;
  task_name: string;
  prompt: string;
  state: LarkTaskState;
  started_at: number;
  last_successful_elements?: LarkCardElement[];
  /** Daemon recovery already removed stale in-memory card actions. */
  recovery_read_only?: boolean;
  chat_type?: LarkMessageEvent['chatType'];
  final_message_id?: string;
  final_delivery_state?: 'delivered';
  progress_frozen?: boolean;
  turn?: number;
};

const larkCardChannel = (appId: string) => `lark-card:${appId}`;

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
  ) {}

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
    if (!this.cardMappings || !task.sessionId || !task.cardMessageId || !task.startedAt) return;
    const extra: PersistedLarkCardTask = {
      app_id: task.config.appId,
      chat_id: task.event.chatId,
      card_message_id: task.cardMessageId,
      ...(task.runtimeTaskId ? { runtime_task_id: task.runtimeTaskId } : {}),
      task_name: task.prompt.slice(0, 80),
      prompt: task.prompt,
      state,
      chat_type: task.event.chatType,
      turn: task.turn,
      ...(task.finalMessageId ? { final_message_id: task.finalMessageId, final_delivery_state: 'delivered' as const } : {}),
      ...(task.progressFrozen ? { progress_frozen: true } : {}),
      ...(task.lastSuccessfulElements?.length ? { last_successful_elements: task.lastSuccessfulElements } : {}),
      ...(task.event.chatType === 'group' ? {
        reply_message_id: task.event.messageId,
        ...(task.event.threadId?.trim() ? { reply_in_thread: true } : {})
      } : {}),
      started_at: task.startedAt
    };
    await this.cardMappings.save({
      id: `${larkCardChannel(task.config.appId)}:${task.id}`,
      channel: larkCardChannel(task.config.appId),
      externalId: task.id,
      sessionId: task.sessionId,
      extra: JSON.stringify(extra),
      createdAt: new Date(task.startedAt).toISOString()
    });
  }

  private async performReconcile(config: StoredLarkConfig) {
    if (!this.cardMappings) return 0;
    return performLarkCardReconcile({
      runtime: this.runtime,
      service: this.service,
      cardMappings: this.cardMappings,
      log: this.log,
      config,
      channel: larkCardChannel(config.appId)
    });
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
    this.reconcileIntervalMs = Math.max(50, intervalMs);
    if (this.reconcileTimer) { clearTimeout(this.reconcileTimer); this.reconcileTimer = undefined; }
    const unresolved = await this.reconcile(config);
    if (unresolved > 0) this.scheduleReconcile();
    return unresolved;
  }

  async handle(event: LarkMessageEvent, config: StoredLarkConfig) {
    const mentionsBot = this.botOpenId ? event.mentions.some(mention => mention.openId === this.botOpenId) : event.mentions.some(mention => mention.mentionedType === 'bot');
    const shouldWake = event.chatType === 'p2p' || (event.chatType === 'group' && mentionsBot);
    if (this.stopped || !shouldWake || this.handledMessages.has(event.messageId)) return;
    await this.requireExecution('listener', 'task.create');
    // 先标记已处理，避免异步解析期间同一条消息被重复入队。
    this.handledMessages.add(event.messageId);
    if (this.handledMessages.size > 5_000) this.handledMessages.delete(this.handledMessages.values().next().value!);
    // 事件接入后立即给出稳定、单义的接收确认。解析、附件下载和会话路由均可能较慢，
    // 不应让用户在这些步骤中面对无反馈的聊天界面。
    let acknowledgementReactionId: string | undefined;
    try {
      acknowledgementReactionId = (await this.service.addReaction(event.messageId, 'OK')).reactionId;
    } catch (error) {
      this.log.warn({ error, messageId: event.messageId }, '发送飞书确认表情失败，继续处理消息');
    }
    let prompt: string;
    let resources: LarkMessageResource[];
    let scopeId: string;
    try {
      ({ prompt, resources } = await parsePrompt(event));
      // 路由解析（话题群种子 / 普通群回复模式 / legacy）与 group key 共用同一 scopeId，
      // 保证同一会话的消息串行化到同一个 group。
      scopeId = await resolveLarkScopeId(event, config, this.chatModeResolver);
    } catch (error) {
      this.log.warn({ error, chatId: event.chatId, messageId: event.messageId }, '解析飞书消息失败，已向用户回执');
      await sendTaskCard(this.service, event, {
        state: 'failed', retryable: false, readOnly: true,
        taskId: event.messageId, taskName: '消息接收失败',
        markdown: `**消息未能解析，Agent 尚未执行。**\n\n${error instanceof Error ? error.message : String(error)}\n\n请检查消息内容或附件后重新发送。`,
        idempotencyKey: `parse_failed_${event.messageId}`.slice(0, 50),
        ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {})
      }, this.log).catch(cardError => this.log.error({ error: cardError, messageId: event.messageId }, '发送飞书解析失败回执失败'));
      if (acknowledgementReactionId) await this.service.deleteReaction(event.messageId, acknowledgementReactionId).catch(() => undefined);
      return;
    }
    // 空 @ 消息（仅 @ 机器人无文字）仍需创建任务，由 runTurn 拉取聊天记录做兜底意图判断。
    const groupKey = larkGroupKey(event, scopeId);
    const group = this.groups.get(groupKey) ?? { tail: Promise.resolve() };
    const task: LarkTask = { id: event.messageId, group, event, prompt, resources, config, state: 'queued', events: [], turn: 0, scopeId, acknowledgementReactionId };
    this.tasks.set(task.id, task);
    if (this.tasks.size > 5_000) this.tasks.delete(this.tasks.keys().next().value!);
    group.tail = group.tail.then(() => this.runTurn(task)).catch(error => {
      this.log.error({ error, chatId: event.chatId, messageId: event.messageId }, '处理飞书唤醒消息失败');
    });
    this.groups.set(groupKey, group);
  }

  /**
   * 卡片操作人的访问权限校验，与 runTurn 中「谁可以使用 Agent」的配置保持一致：
   * - 未配置白名单时所有人均可操作
   * - 配置了 allowedUsers 时按 openId 匹配
   * - 仅配置 allowedEmails 时拉取操作人邮箱匹配
   */
  private async isOperatorAllowed(config: StoredLarkConfig, operatorOpenId?: string, chatId?: string): Promise<boolean> {
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

  async handleAction(value: unknown, operatorOpenId?: string) {
    let parsed = value;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch { return { type: 'error', content: '无法识别卡片操作' }; }
    }
    if (!parsed || typeof parsed !== 'object') return { type: 'error', content: '无法识别卡片操作' };
    const action = String((parsed as any).action ?? '');
    const taskId = String((parsed as any).task_id ?? (parsed as any).taskId ?? '');
    const task = this.tasks.get(taskId);
    if (!task) return { type: 'warning', content: '任务已过期，请重新发送消息' };

    // 访问权限：操作人必须在机器人白名单中，与「谁可以使用 Agent」的配置一致。
    // 白名单内的成员均可取消 / 中断 / 重试任意任务，不再限制为任务发起人本人，
    // 避免 AI 协作链（上游 AI 触发下游 AI 任务）中人类无法干预的问题。
    const allowed = await this.isOperatorAllowed(task.config, operatorOpenId, task.event.chatId);
    if (!allowed) {
      return { type: 'warning', content: '当前账号不在机器人白名单中，无法执行此操作' };
    }

    // 旧版排队卡片会发 interrupt，仍按安全的单轮次取消处理，不中断当前运行任务。
    if (action === 'cancel' || (action === 'interrupt' && task.state === 'queued')) {
      if (task.state !== 'queued') return { type: 'warning', content: '任务已不在排队中' };
      if (!task.sessionId || !task.runtimeTaskId || !this.runtime.cancelQueued) return { type: 'warning', content: '排队任务当前不可取消' };
      task.state = 'interrupting';
      const sessionId = task.sessionId;
      const runtimeTaskId = task.runtimeTaskId;
      const cancelQueued = this.runtime.cancelQueued.bind(this.runtime);
      void (async () => {
        try {
          await cancelQueued(sessionId, runtimeTaskId);
          task.state = 'interrupted';
          await task.requestUpdate?.('interrupted', false);
        } catch (error) {
          // 排队任务可能在点击时已转为运行态；绝不回退中断 Session，交由任务事件流对账实际状态。
          if (task.state === 'interrupting') task.state = 'queued';
          this.log.warn({ error, taskId, sessionId, runtimeTaskId }, '取消飞书排队任务失败');
          this.pushTaskError(task, `取消排队任务失败：${error instanceof Error ? error.message : String(error)}`);
          await task.requestUpdate?.(task.state === 'running' ? 'running' : 'queued', false).catch(() => undefined);
        }
      })();
      return { type: 'success', content: '正在取消排队任务' };
    }

    if (action === 'interrupt') {
      if (!task.sessionId || task.state !== 'running') return { type: 'warning', content: '任务当前不可中断' };
      task.state = 'interrupting';
      task.interruptRequested = true;
      const sessionId = task.sessionId;
      void (async () => {
        try {
          await this.runtime.interrupt(sessionId);
          task.state = 'interrupted';
          await task.requestUpdate?.('interrupted', false);
        } catch (error) {
          task.state = 'running';
          task.interruptRequested = false;
          this.log.warn({ error, taskId, sessionId }, '中断飞书任务失败');
          this.pushTaskError(task, `中断任务失败：${error instanceof Error ? error.message : String(error)}`);
          await task.requestUpdate?.('running', false).catch(() => undefined);
        }
      })();
      return { type: 'success', content: '正在取消任务' };
    }

    if (action === 'retry') {
      if (task.state !== 'failed' && task.state !== 'interrupted') return { type: 'warning', content: '只有失败或已中断的任务可以重试' };
      task.state = 'queued';
      // 终态卡片是不可变收据；重试必须创建一张新的进度卡，不能复用或覆盖旧收据。
      task.cardMessageId = undefined;
      task.finalMessageId = undefined;
      task.finalDeliveredTurn = undefined;
      task.lastSuccessfulElements = undefined;
      task.runtimeTaskId = undefined;
      task.progressFrozen = undefined;
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
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = undefined;
    this.reconcileConfig = undefined;
    this.groups.clear();
    this.tasks.clear();
    this.handledMessages.clear();
  }

  private async sessionFor(group: LarkGroup, config: StoredLarkConfig, chatId: string, chatType: LarkMessageEvent['chatType'], scopeId: string) {
    return resolveLarkSession(this.runtime, this.log, group, config, chatId, chatType, scopeId);
  }

  /**
   * 用户仅 @ 机器人而未发送任何文字时，拉取当前会话最近的聊天记录作为上下文，
   * 让 Agent 根据历史判断用户意图；若拉取失败则退化为纯提示，让 Agent 主动询问。
   */
  private async buildEmptyMessageFallback(event: LarkMessageEvent): Promise<string> {
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
        const parsed = await parseLarkMessageContent(item.messageType, item.rawContent, {
          messageId: item.messageId
        });
        let text = parsed.text;
        for (const mention of item.mentions) {
          if (mention.key) text = text.replaceAll(mention.key, '');
          if (mention.name) text = text.replace(new RegExp(`@${mention.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), '');
        }
        text = text.trim();
        return `${sender}: ${text || '[图片/文件/卡片等非文字消息]'}`;
      }));
      return `[Dockmux 空消息兜底]\n用户仅 @ 了机器人而未发送任何文字内容。以下是当前会话最近的聊天记录，仅用于识别指代。${confirmationRule}\n\n[最近聊天记录]\n${lines.join('\n')}`;
    } catch (error) {
      this.log.warn({ error, chatId: event.chatId, messageId: event.messageId }, '拉取飞书聊天记录为空消息兜底失败');
      return fallback;
    }
  }

  private async runTurn(task: LarkTask) {
    if (this.stopped) return;
    // 每次 runTurn 递增轮次编号，用于让上一轮的终态回调（finish）识别自己已过期，
    // 避免它在 await getEvents 期间被重试打断后，把 task.state 覆盖回终态。
    task.turn = (task.turn ?? 0) + 1;
    const currentTurn = task.turn;
    const { group, event, config } = task;
    if (task.resources.length) {
      task.prompt = await materializeLarkResources(event.messageId, task.prompt, task.resources, this.service);
      task.resources = [];
    }
    // 用户仅 @ 机器人而未发送文字时，拉取最近聊天记录作为上下文，让 Agent 判断用户意图。
    if (!task.prompt.trim()) {
      task.prompt = await this.buildEmptyMessageFallback(event);
    }
    const prompt = task.prompt;
    let agentName = config.defaultAgentId ?? 'Dockmux';
    try {
      agentName = (await this.runtime.listAgents?.())?.find(agent => agent.id === config.defaultAgentId)?.name ?? agentName;
    } catch (error) {
      this.log.warn({ error, agentId: config.defaultAgentId }, '读取 Agent 展示名失败，使用 Agent ID 渲染卡片');
    }
    const cardContext = { agentName, ...(config.workspace ? { workspace: config.workspace } : {}) };
    const clearAcknowledgement = async () => {
      const reactionId = task.acknowledgementReactionId;
      task.acknowledgementReactionId = undefined;
      if (!reactionId) return;
      try { await this.service.deleteReaction(event.messageId, reactionId); }
      catch (error) { this.log.warn({ error, messageId: event.messageId, reactionId }, '撤销飞书确认表情失败'); }
    };

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
        const card = await sendTaskCard(this.service, event, { ...cardContext, state: 'failed', retryable: false, taskId: task.id, taskName: 'Agent 协作身份校验失败', markdown: `**无法验证发起交接的 Agent。**\n\n${error instanceof Error ? error.message : String(error)}`, ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) }, this.log);
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
        const card = await sendTaskCard(this.service, event, { ...cardContext, state: 'failed', retryable: false, taskId: task.id, taskName: '身份解析权限缺失', markdown: larkIdentityPermissionHelp(error, config.appId), ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) }, this.log);
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
    const allowed = botSender
      ? (!accessRestricted || (peerBotsAllowed && trustedPeerBot) || Boolean(allowedBot))
      : !accessRestricted || (allowedUsers.length ? Boolean(allowedUser) : actorEmails.some(email => allowedEmails.includes(email)));
    if (!allowed) {
      task.state = 'failed'; task.retryable = false; task.startedAt = Date.now();
      const card = await sendTaskCard(this.service, event, { ...cardContext, state: 'failed', retryable: false, taskId: task.id, taskName: '访问被拒绝', markdown: '**当前账号不在机器人白名单中。**\n\n如需使用，请联系机器人管理员添加你。', ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) }, this.log);
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
      await this.requireExecution('session', 'task.create');
      if (riskPolicy) await this.requireExecution('high_risk', 'high_risk.execute');
      session = await this.sessionFor(group, config, event.chatId, event.chatType, task.scopeId);
    }
    catch (error) {
      task.state = 'failed'; task.startedAt = Date.now();
      const markdown = `**Agent 启动失败**\n\n${error instanceof Error ? error.message : String(error)}`;
      const card = await sendTaskCard(this.service, event, { ...cardContext, state: 'failed', taskId: task.id, taskName: prompt.slice(0, 80), markdown, ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) }, this.log);
      task.cardMessageId = card.messageId;
      await clearAcknowledgement();
      return;
    }
    task.sessionId = session.id;
    const initialState = this.runtime.dispatch ? 'queued' : 'running';
    task.state = initialState;
    task.events = [];
    task.startedAt = Date.now();
    task.interruptRequested = false;
    const initialElements = boundLarkCardElements(renderLarkCardElements([], config, false, false, event.chatType));
    if (task.cardMessageId) {
      await this.service.update({ ...cardContext, messageId: task.cardMessageId, permissionMode: 'full-trust', state: initialState, statusLabel: initialState === 'queued' ? '已接收' : undefined, taskId: task.id, taskName: prompt.slice(0, 80), markdown: initialState === 'queued' ? '任务已接收，正在准备执行…' : '正在思考中…', sessionId: task.sessionId, ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) });
    } else {
      const card = await sendTaskCard(this.service, event, { ...cardContext, state: initialState, statusLabel: initialState === 'queued' ? '已接收' : undefined, readOnly: initialState === 'queued', taskId: task.id, taskName: prompt.slice(0, 80), markdown: initialState === 'queued' ? '任务已接收，正在准备执行…' : '正在思考中…', sessionId: task.sessionId, ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) }, this.log);
      task.cardMessageId = card.messageId;
    }
    task.lastSuccessfulElements = initialElements;
    await this.saveCardTask(task);
    await clearAcknowledgement();

    let timer: NodeJS.Timeout | undefined;
    let heartbeatActive = false;
    type PendingCardUpdate = {
      input: Parameters<LarkCardService['update']>[0];
      terminal: boolean;
      completed: boolean;
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
          const attempts = pending.terminal ? 3 : 1;
          for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
              await this.service.update(pending.input);
              lastError = undefined;
              delivered = true;
              if (pending.input.elements) task.lastSuccessfulElements = pending.input.elements as LarkCardElement[];
              cardRateLimitFailures = 0;
              cardRateLimitedUntil = 0;
              break;
            } catch (error) {
              lastError = error;
              if (isLarkCardContentRejected(error)) { contentRejected = true; break; }
              if (isLarkMessageRateLimit(error)) {
                cardRateLimitFailures += 1;
                cardRateLimitedUntil = Date.now() + larkRateLimitBackoffMs(cardRateLimitFailures);
              }
              this.log.warn({ error, messageId: pending.input.messageId, attempt, attempts }, '更新飞书服务卡片失败');
              if (attempt < attempts) {
                const retryDelay = isLarkMessageRateLimit(error)
                  ? Math.max(0, cardRateLimitedUntil - Date.now())
                  : attempt * 300;
                await new Promise(resolve => setTimeout(resolve, retryDelay));
              }
            }
          }
          if (lastError && contentRejected && Array.isArray(task.lastSuccessfulElements) && task.lastSuccessfulElements.length) {
            const patchedElements = patchRejectedCardDelta(task.lastSuccessfulElements, pending.input.elements as LarkCardElement[] | undefined);
            try {
              await this.service.update({ ...pending.input, elements: patchedElements, markdown: undefined });
              delivered = true;
              lastError = undefined;
              task.lastSuccessfulElements = patchedElements;
              this.log.warn({ messageId: pending.input.messageId, state: pending.input.state }, '飞书卡片增量被拒绝，已保留上次成功内容并原地修补');
            } catch (error) {
              lastError = error;
            }
          }
          if (lastError && pending.terminal) {
            if (!isLarkMessageUnupdatable(lastError)) {
              this.log.warn({ error: lastError, messageId: pending.input.messageId }, '飞书原卡暂时更新失败，保留原卡等待终态对账');
              this.scheduleReconcile();
              continue;
            }
            try {
              const replacementElements = contentRejected
                ? patchRejectedCardDelta(task.lastSuccessfulElements, pending.input.elements as LarkCardElement[] | undefined)
                : boundLarkCardElements((pending.input.elements ?? []) as LarkCardElement[]);
              const replacement = await sendTaskCard(this.service, event, {
                ...cardContext,
                state: pending.input.state,
                taskId: task.id,
                taskName: prompt.slice(0, 80),
                elapsedSeconds: pending.input.elapsedSeconds,
                sessionId: task.sessionId,
                readOnly: true,
                ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
                elements: replacementElements,
                idempotencyKey: `comp_${pending.input.messageId}_${pending.input.state}`.slice(0, 50)
              }, this.log);
              task.cardMessageId = replacement.messageId;
              task.lastSuccessfulElements = replacementElements;
              delivered = true;
              this.log.info({ previousMessageId: pending.input.messageId, replacementMessageId: replacement.messageId, state: pending.input.state }, '已补发飞书终态卡片');
            } catch (compensationError) {
              if (isLarkCardContentRejected(compensationError)) {
                try {
                  const patchedElements = patchRejectedCardDelta(task.lastSuccessfulElements, pending.input.elements as LarkCardElement[] | undefined);
                  const minimal = await sendTaskCard(this.service, event, {
                    ...cardContext,
                    state: pending.input.state,
                    taskId: task.id,
                    taskName: prompt.slice(0, 80),
                    elapsedSeconds: pending.input.elapsedSeconds,
                    sessionId: task.sessionId,
                    readOnly: true,
                    ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
                    elements: patchedElements,
                    idempotencyKey: `comp_safe_${pending.input.messageId}_${pending.input.state}`.slice(0, 50)
                  }, this.log);
                  task.cardMessageId = minimal.messageId;
                  task.lastSuccessfulElements = patchedElements;
                  delivered = true;
                  this.log.warn({ previousMessageId: pending.input.messageId, replacementMessageId: minimal.messageId, upstreamCode: compensationError.details?.upstreamCode }, '飞书补发终态卡片增量被拒绝，已保留上次成功内容');
                } catch (fallbackError) {
                  this.log.error({ error: fallbackError, contentError: compensationError, updateError: lastError, messageId: pending.input.messageId }, '补发飞书终态最小卡片失败');
                }
              } else {
                this.log.error({ error: compensationError, updateError: lastError, messageId: pending.input.messageId }, '补发飞书终态卡片失败');
              }
            }
          }
          if (delivered && pending.input.state) {
            if (pending.terminal) task.progressFrozen = true;
            await this.saveCardTask(task, pending.input.state);
          }
        }
      })().finally(() => {
        updateChain = undefined;
        if (pendingUpdate) void flushUpdates();
      });
      return updateChain;
    };
    const update = (state: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted', completed = false, freezeReceipt = false) => {
      // Runtime running is monotonic for a turn. Late dispatch/cancel bookkeeping may
      // still report queued, but must never repaint an executing card backwards.
      if (state === 'queued' && task.state === 'running') return Promise.resolve();
      if (timer) { clearTimeout(timer); timer = undefined; }
      const terminal = state === 'completed' || state === 'failed' || state === 'interrupted';
      const receiptElements: LarkCardElement[] = [{
        tag: 'markdown', element_id: 'terminal_receipt',
        content: state === 'completed'
          ? '**任务已完成。**\n\n最终结果已作为新消息发送。'
          : state === 'failed'
            ? '**任务执行失败。**\n\n失败原因和恢复建议已作为新消息发送。'
            : '**任务已取消。**\n\n本轮已停止，后续操作已作为新消息发送。',
        text_size: 'normal', margin: '0px'
      }];
      pendingUpdate = {
        terminal,
        completed,
        input: {
          ...cardContext,
          messageId: task.cardMessageId!,
          permissionMode: 'full-trust',
          state,
          taskId: task.id,
          taskName: prompt.slice(0, 80),
          elapsedSeconds: (Date.now() - task.startedAt!) / 1_000,
          sessionId: task.sessionId,
          ...(freezeReceipt ? { readOnly: true } : {}),
          ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
          elements: freezeReceipt
            ? receiptElements
            : boundLarkCardElements(renderLarkCardElements(task.events, config, completed, false, event.chatType))
        }
      };
      return flushUpdates();
    };
    let terminalDelivery: Promise<void> | undefined;
    const deliverTerminal = (state: 'completed' | 'failed' | 'interrupted', completed = false) => {
      if (task.finalDeliveredTurn === currentTurn && task.finalMessageId) return Promise.resolve();
      if (terminalDelivery) return terminalDelivery;
      terminalDelivery = (async () => {
        // Mutable progress card becomes an immutable receipt. The actual result is a fresh
        // reply so Lark generates a new notification instead of silently PATCHing history.
        await update(state, completed, true);
        if (task.turn !== currentTurn || (task.finalDeliveredTurn === currentTurn && task.finalMessageId)) return;
        const finalElements = boundLarkCardElements(renderLarkCardElements(task.events, config, completed, false, event.chatType));
        const finalInput = {
          ...cardContext,
          state,
          taskId: task.id,
          taskName: prompt.slice(0, 80),
          elapsedSeconds: (Date.now() - task.startedAt!) / 1_000,
          sessionId: task.sessionId,
          retryable: task.retryable,
          ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
          elements: finalElements,
          idempotencyKey: `final_${task.id}_${currentTurn}_${state}`.slice(0, 50)
        } as const;
        let finalCard;
        try {
          finalCard = await sendTaskCard(this.service, event, finalInput, this.log);
        } catch (error) {
          if (!isLarkCardContentRejected(error)) throw error;
          finalCard = await sendTaskCard(this.service, event, {
            ...finalInput,
            elements: [{
              tag: 'markdown', element_id: 'final_delivery_safe_fallback',
              content: '**任务已结束，但结果内容未通过飞书安全检查。**\n\n请在 Dockmux Web 查看完整结果，或调整请求后重试。',
              text_size: 'normal', margin: '0px'
            }]
          }, this.log);
          this.log.warn({ taskId: task.id, state }, '飞书终态新消息内容被拒绝，已发送安全降级通知');
        }
        task.finalMessageId = finalCard.messageId;
        task.finalDeliveredTurn = currentTurn;
        await this.saveCardTask(task, state);
      })().catch(error => {
        this.log.error({ error, taskId: task.id, state }, '发送飞书终态新消息失败，等待对账补偿');
        this.scheduleReconcile();
        throw error;
      }).finally(() => { terminalDelivery = undefined; });
      return terminalDelivery;
    };
    const scheduleHeartbeat = () => {
      if (!heartbeatActive || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void update('running').finally(scheduleHeartbeat);
      }, Math.max(config.pushIntervalMs, cardRateLimitedUntil - Date.now()));
    };
    task.requestUpdate = (state, completed) => state === 'completed' || state === 'failed' || state === 'interrupted'
      ? deliverTerminal(state, completed)
      : update(state, completed);
    const injected: string[] = [];
    injected.push(`[Dockmux 机器人身份]
- 机器人名称：${config.name ?? config.appId}
- App ID：${config.appId}${config.workspace ? `\n- 工作区：${config.workspace}` : ''}`);
    if (config.preInjectPrompt?.trim()) injected.push(`[Dockmux 预注入 Prompt]\n${config.preInjectPrompt.trim()}`);
    if (event.chatType === 'group' && config.groupToolsEnabled && config.groupToolsAllowSend) {
      injected.push(`[Dockmux 飞书当前消息 · 系统上下文]
- 当前消息 message_id：${event.messageId}
- 当前消息 thread_id：${event.threadId?.trim() || '事件未提供'}
- 若要延续当前讨论或回答当前提问，使用 group send --reply-to ${event.messageId} --in-thread。
- 若内容是独立公告、新任务或不应归入当前讨论，使用 group send 且不要传 --reply-to/--in-thread。
- reply-to 只能使用 om_* message_id，不能使用 omt_* thread_id。`);
    }
    if (riskControlEnabled && !highRiskAuthorized) injected.push(`[Dockmux 安全策略 · 自动注入]\n当前飞书发送人不在高危操作允许名单中。禁止执行匹配以下正则的操作，也不要通过脚本、子进程、MCP 或其他等价方式绕过：\n${highRiskPattern}\n如果用户要求此类操作，请明确说明已被 Dockmux 安全策略阻止。`);
    const agentPrompt = injected.length ? `${injected.join('\n\n')}\n\n[用户请求]\n${prompt}` : prompt;

    if (this.runtime.dispatch) {
      task.state = 'queued';
      let runtimeTaskId: string | undefined;
      let active = false;
      let settling = false;
      let settled = false;
      let buffered: AgentEvent[] = [];
      let unsubscribe = () => {};
      const cleanup = () => {
        heartbeatActive = false;
        if (timer) clearTimeout(timer);
        unsubscribe();
        task.requestUpdate = undefined;
      };
      const finish = (state: 'completed' | 'failed' | 'interrupted') => {
        if (settling || settled) return;
        settling = true;
        heartbeatActive = false;
        void (async () => {
          if (runtimeTaskId && this.runtime.getRecentEvents) {
            try {
              // 终态卡片仅需最终回复 + 最近 traceLimit 条活动，倒序加载足够原始事件即可，
              // 避免长会话全量加载导致内存峰值。
              const recentLimit = Math.max((config.traceLimit ?? defaultLarkTraceLimit) * 30, 500);
              const persistedEvents = await this.runtime.getRecentEvents(session.id, recentLimit);
              task.events = eventsForRuntimeTask(persistedEvents, runtimeTaskId);
            } catch (error) {
              this.log.warn({ error, taskId: task.id, runtimeTaskId }, '读取任务最终事件失败，使用已接收事件生成终态卡片');
            }
          }
          // 若轮次已变（用户点击了重试并启动了新一轮），本轮终态回调不得覆盖新状态。
          if (task.turn !== currentTurn) return;
          const resolvedState = state === 'completed' && hasUnresolvedToolCalls(task.events) ? 'failed' : state;
          if (resolvedState !== state) this.log.warn({ taskId: task.id, runtimeTaskId }, '任务已结束但仍有工具未返回结果，按失败终态处理');
          settled = true;
          active = false;
          task.state = resolvedState;
          await deliverTerminal(resolvedState, resolvedState === 'completed').finally(cleanup);
        })().catch(error => this.log.error({ error, taskId: task.id, runtimeTaskId }, '生成飞书任务终态失败'));
      };
      const receive = (agentEvent: AgentEvent) => {
        if (agentEvent.type === 'task') {
          const record = (agentEvent.data as any)?.task;
          if (!record || record.id !== runtimeTaskId) return;
          if (record.status === 'running') {
            active = true;
            heartbeatActive = true;
            task.state = 'running';
            task.startedAt = Date.now();
            void update('running').finally(scheduleHeartbeat);
          } else if (record.status === 'completed' || record.status === 'failed' || record.status === 'interrupted' || record.status === 'cancelled') finish(record.status === 'cancelled' ? 'interrupted' : record.status);
          return;
        }
        if (!active || settled) return;
        task.events.push(agentEvent);
        // 仅保留最近 N 条原始事件用于心跳渲染，避免长任务内存无限增长；
        // 终态卡片会从 DB 倒序加载足够事件，不依赖此缓冲。
        const maxBufferedEvents = Math.max((config.traceLimit ?? defaultLarkTraceLimit) * 20, 200);
        if (task.events.length > maxBufferedEvents) {
          task.events = task.events.slice(-maxBufferedEvents);
        }
        if (!settling) scheduleHeartbeat();
      };
      unsubscribe = this.runtime.subscribe(session.id, agentEvent => {
        if (!runtimeTaskId) buffered.push(agentEvent);
        else receive(agentEvent);
      });
      try {
        const runtimeTask = riskPolicy
          ? await this.runtime.dispatch(session.id, prompt, 'queue', agentPrompt, riskPolicy)
          : await this.runtime.dispatch(session.id, prompt, 'queue', agentPrompt);
        runtimeTaskId = runtimeTask.id;
        task.runtimeTaskId = runtimeTask.id;
        await this.saveCardTask(task, task.state);
        // 先提交 queued UI，再消费订阅期间缓存的 running 事件，杜绝 running→queued 闪回。
        if (runtimeTask.status === 'queued' && task.state === 'queued') {
          const queueMarkdown = (runtimeTask.queuedAhead ?? 0) > 0
            ? `正在排队，前面还有 ${runtimeTask.queuedAhead} 个任务…`
            : '已进入执行队列，等待 Agent 开始…';
          await this.service.update({ ...cardContext, messageId: task.cardMessageId!, permissionMode: 'full-trust', state: 'queued', statusLabel: '排队中', taskId: task.id, taskName: prompt.slice(0, 80), markdown: queueMarkdown, sessionId: task.sessionId, ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) });
          await this.saveCardTask(task, 'queued');
        }
        for (const agentEvent of buffered) receive(agentEvent);
        buffered = [];
      } catch (error) {
        task.events.push({ id: `lark-error-${event.messageId}`, sessionId: session.id, sequence: Number.MAX_SAFE_INTEGER, type: 'error', timestamp: new Date().toISOString(), data: { message: error instanceof Error ? error.message : String(error) } });
        task.state = 'failed';
        await deliverTerminal('failed', false);
        cleanup();
      }
      return;
    }

    const unsubscribe = this.runtime.subscribe(session.id, agentEvent => {
      task.events.push(agentEvent);
      const maxBufferedEvents = Math.max((config.traceLimit ?? defaultLarkTraceLimit) * 20, 200);
      if (task.events.length > maxBufferedEvents) {
        task.events = task.events.slice(-maxBufferedEvents);
      }
      scheduleHeartbeat();
    });
    try {
      heartbeatActive = true;
      scheduleHeartbeat();
      if (riskPolicy) await this.runtime.send(session.id, prompt, agentPrompt, riskPolicy);
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
