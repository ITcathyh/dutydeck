import type { RelayAskBroker } from '@dockmux/relay';
import { LarkWorkflowInteractions, type LarkInteraction, type LarkInteractionContext } from './workflow-interactions.js';
import { LarkTaskInbox, type LarkInboxRecord } from './task-inbox.js';
import { collectLarkTaskContext } from './task-context.js';
import { buildLarkTaskDashboard, type LarkTaskDashboardEntry } from './task-dashboard.js';
import type { LarkGroupManager } from './group-management.js';
import type { AgentEvent, ChannelMappingRepository, ConfigRepository, PolicyAction, PolicyDecision, Session, TaskRecord, ToolRiskPolicy } from '@dockmux/shared';
import { defaultHighRiskPattern, defaultLarkTraceLimit, larkPermissionMode, readLarkConfig, type StoredLarkConfig } from './config.js';
import { parseLarkMessageContent, type LarkMessageResource } from './message-content.js';
import { boundLarkCardElements, larkIdentityPermissionHelp, LarkServiceError, type LarkCardService } from './service.js';
import {
  eventsForRuntimeTask,
  hasUnresolvedToolCalls,
  isLarkCardContentRejected,
  isLarkMessageRateLimit,
  isLarkMessageUnupdatable,
  larkRateLimitBackoffMs,
  larkTerminalReplacementKey,
  patchRejectedCardDelta,
  renderLarkCardElements,
  type LarkCardElement
} from './card-renderer.js';
import { performLarkCardReconcile } from './reconciler.js';
import { isLarkCardActionAvailable, parseLarkCardActionValue, type LarkCardCapabilities } from './card-actions.js';
import {
  larkCommandCapabilities,
  larkCommandEcho,
  parseSlashCommand,
  routeLarkCommand,
  type LarkCommandRoute
} from './commands.js';
import {
  findPersistedLarkSession,
  larkGroupKey,
  larkReplyContext,
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
type LarkRetryPrompt = { prompt: string; materialPrompt: string };
export type LarkTaskState = 'queued' | 'running' | 'interrupting' | 'interrupted' | 'completed' | 'failed';
export type LarkTask = {
  id: string;
  group: LarkGroup;
  event: LarkMessageEvent;
  prompt: string;
  resources: LarkMessageResource[];
  inbox?: LarkInboxRecord;
  resumeTask?: TaskRecord;
  retryMaterialPrompt?: string;
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
  finalDeliveredTurn?: number;
  progressFrozen?: boolean;
  interruptRequested?: boolean;
  requestUpdate?: (state: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted', completed?: boolean) => Promise<void>;
  retryable?: boolean;
  /** 递增的轮次编号，用于防止上一轮的终态回调覆盖重试后的新状态。 */
  turn: number;
  /** 本条消息解析出的会话隔离 scope（与 group key 一致），sessionFor 复用。 */
  scopeId: string;
  /** 入队时所属的上下文代数；与 group.epoch 不符说明本轮已被 /new 作废。 */
  epoch: number;
};
export type PersistedLarkCardTask = {
  result_feedback_state?: string;
  retry_material_prompt?: string;
  sender_open_id?: string;
  thread_id?: string;
  scope_id?: string;
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
  private readonly turnCleanups = new Set<() => void>();
  private readonly workflows?: LarkWorkflowInteractions;
  private readonly inbox?: LarkTaskInbox;

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
    private readonly workflowOptions: { store?: ConfigRepository; broker?: RelayAskBroker } = {},
  ) {
    if (workflowOptions.store) {
      this.inbox = new LarkTaskInbox(workflowOptions.store);
      this.workflows = new LarkWorkflowInteractions(workflowOptions.store, runtime, service, workflowOptions.broker,
        (record, actor, action) => this.authorizeInteraction(record, actor, action));
    }
  }

  async initializeWorkflows(config: StoredLarkConfig) {
    this.reconcileConfig = config;
    await this.workflows?.initialize(config.appId);
    for (const record of await this.inbox?.orphanedCommands(config.appId) ?? []) {
      await this.inbox!.update(record, { state: 'failed', error: '重启后无法确认命令是否完成；如未生效，请重新发送。' });
      const actor = record.event.senderOpenId;
      if (actor && await this.currentAccess(config, record.event.chatId, record.event.chatType, actor, 'task.view_result')) {
        await this.workflowReply(record.event, config, '重启后无法确认这条命令是否完成。如结果未生效，请重新发送该命令。').catch(error => this.log.warn({ error }, '命令恢复回执发送失败'));
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
        retryMaterialPrompt: saved.retry_material_prompt, sessionId: mapping.sessionId, cardMessageId: saved.card_message_id, resumeTask: runtimeTask, restoring: true };
      this.tasks.set(task.id, task);
      this.handledMessages.add(task.id);
      group.tail = group.tail.then(() => this.runTurn(task)).catch(error => this.log.error({ error, taskId: task.id }, '恢复飞书任务交互失败'));
    }
  }

  private async observeLiveWaiters(task: LarkTask) {
    const context = this.interactionContext(task);
    if (!context || !this.workflows) return;
    for (const permission of await this.runtime.getPendingPermissions?.(context.sessionId) ?? []) {
      await this.workflows.observe(context, { id: permission.id, sessionId: context.sessionId, sequence: 0,
        timestamp: new Date().toISOString(), type: 'permission_request', data: permission });
    }
    for (const ask of this.workflowOptions.broker?.listPending(context.sessionId) ?? []) {
      await this.workflows.observe(context, { id: ask.id, sessionId: context.sessionId, sequence: 0,
        timestamp: new Date().toISOString(), type: 'text', data: { relay: 'ask', askId: ask.id } });
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

  private async workflowReply(event: LarkMessageEvent, config: StoredLarkConfig, markdown: string, elements?: LarkCardElement[]) {
    await sendTaskCard(this.service, event, { taskId: event.messageId, taskName: '任务操作', state: 'completed', readOnly: true,
      permissionMode: larkPermissionMode(config), markdown, ...(elements ? { elements } : {}),
      idempotencyKey: `workflow_reply_${event.messageId}`.slice(0, 50) }, this.log);
  }

  private async taskDashboard(event: LarkMessageEvent, config: StoredLarkConfig, page: number) {
    if (!event.senderOpenId) throw new LarkServiceError('LARK_IDENTITY_REQUIRED', '缺少当前成员身份。', 403);
    const entries: LarkTaskDashboardEntry[] = [];
    const interactions = await this.workflows?.list(config.appId) ?? [];
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
      entries.push({ taskId: task.id, title: saved.task_name, workspace: session.cwd, status: pending && task.status === 'running'
        ? pending.kind === 'ask' ? 'waiting_for_answer' : 'waiting_for_permission' : task.status, updatedAt: task.updatedAt, url: url.toString(), ...(result && ['pending', 'accepted', 'needs_changes'].includes(result.state) ? { feedback: result.state as 'pending' | 'accepted' | 'needs_changes' } : {}) });
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
      await this.workflowReply(event, config, '任务操作需由人类成员发起。'); return true;
    }
    try {
      if (parsed?.name === 'tasks') {
        await this.workflowReply(event, config, '任务导航', await this.taskDashboard(event, config, Number(parsed.args[0] ?? 1))); return true;
      }
      if (quoted?.kind === 'result' && (!parsed || !names.includes(parsed.name))) {
        if (!event.senderOpenId || !await this.authorizeInteraction(quoted, event.senderOpenId, 'run.interrupt')) throw new LarkServiceError('LARK_INTERACTION_DENIED', '当前账号无权修改此任务。', 403);
        const mapping = (await this.cardMappings!.list(larkCardChannel(config.appId))).find(item => item.externalId === quoted.event.messageId)!;
        const saved = JSON.parse(mapping.extra!) as PersistedLarkCardTask;
        if (!saved.scope_id) throw new LarkServiceError('LARK_CONTEXT_MISSING', '原任务上下文不可恢复，请发送新的任务目标。', 409);
        if (quoted.state === 'pending') {
          await this.workflows!.respond({ appId: config.appId, chatId: event.chatId, actorId: event.senderOpenId, requestId: quoted.id, action: 'changes' });
          await this.refreshResultFeedback(config.appId, quoted.id).catch(error => this.log.warn({ error }, '修改要求已记录，卡片刷新失败'));
        }
        // A follow-up after acceptance is a new task in the same context; the
        // accepted result remains an accurate record of the previous version.
        scope.id = saved.scope_id;
        return false;
      }
      const action = parsed && ['answer', 'approve', 'reject'].includes(parsed.name) ? parsed.name as 'answer' | 'approve' | 'reject' : 'answer';
      if (quoted && quoted.kind !== 'ask' && action === 'answer') throw new LarkServiceError('LARK_APPROVAL_EXPLICIT', '审批请使用按钮或明确的 /approve、/reject 命令。', 400);
      const requestId = parsed && names.includes(parsed.name) ? parsed.args[0] : quoted?.id;
      if (!requestId) throw new LarkServiceError('LARK_REQUEST_REQUIRED', '请填写问题卡上显示的请求编号。', 400);
      const answer = parsed?.name === 'answer' ? parsed.argsText.slice(parsed.args[0]?.length ?? 0).trim() : prompt;
      const result = await this.workflows.respond({ appId: config.appId, chatId: event.chatId, actorId: event.senderOpenId, requestId, action, answer });
      await this.workflowReply(event, config, result);
    } catch (error) {
      await this.workflowReply(event, config, error instanceof Error ? error.message : String(error));
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
    if (!this.cardMappings || !task.sessionId || !task.cardMessageId || !task.startedAt) return;
    const extra: PersistedLarkCardTask = {
      app_id: task.config.appId,
      sender_open_id: task.event.senderOpenId,
      thread_id: task.event.threadId,
      scope_id: task.scopeId,
      chat_id: task.event.chatId,
      card_message_id: task.cardMessageId,
      ...(task.runtimeTaskId ? { runtime_task_id: task.runtimeTaskId } : {}),
      task_name: task.prompt.slice(0, 80),
      prompt: task.prompt,
      ...(task.retryMaterialPrompt ? { retry_material_prompt: task.retryMaterialPrompt } : {}),
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

  private async refreshResultFeedback(appId: string, requestId: string) {
    const record = (await this.workflows?.list(appId))?.find(item => item.id === requestId && item.kind === 'result');
    if (!record?.cardId) return;
    const mapping = (await this.cardMappings?.list(larkCardChannel(appId)))?.find(item => item.externalId === record.event.messageId);
    if (!mapping) return;
    const saved = JSON.parse(mapping.extra ?? '{}') as PersistedLarkCardTask;
    if (saved.state !== 'completed' || saved.final_delivery_state !== 'delivered' || saved.card_message_id !== record.cardId
      || saved.final_message_id !== record.cardId || saved.runtime_task_id !== record.taskId || saved.turn !== record.turn) return;
    if (saved.result_feedback_state === record.state) return;
    const elements = [...(saved.last_successful_elements ?? []).filter(item => !['workflow_accept', 'workflow_changes', 'workflow_result_status'].includes(String(item.element_id))),
      ...await this.workflows!.result(record, record.cardId)];
    await this.service.update({ messageId: record.cardId, taskId: mapping.externalId, taskName: saved.task_name, state: 'completed', readOnly: true, elements });
    const current = (await this.cardMappings!.list(larkCardChannel(appId))).find(item => item.id === mapping.id);
    if (current?.extra !== mapping.extra) return;
    await this.cardMappings!.save({ ...mapping, extra: JSON.stringify({ ...saved, result_feedback_state: record.state, last_successful_elements: elements }) });
  }

  private async reconciledResult(mapping: { externalId: string; sessionId: string }, saved: PersistedLarkCardTask, cardId: string) {
    if (!this.workflows || !saved.sender_open_id || !saved.runtime_task_id || !saved.turn) return [];
    return this.workflows.result({ appId: saved.app_id, sessionId: mapping.sessionId, taskId: saved.runtime_task_id, turn: saved.turn,
      event: { messageId: mapping.externalId, chatId: saved.chat_id, chatType: saved.chat_type ?? 'group', senderOpenId: saved.sender_open_id,
        threadId: saved.thread_id, messageType: 'text', content: JSON.stringify({ text: saved.prompt }), mentions: [] } }, cardId);
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
      ...(this.workflows ? { resultElements: (mapping, saved, cardId) => this.reconciledResult(mapping, saved, cardId) } : {})
    });
    for (const record of await this.workflows?.list(config.appId) ?? []) {
      if (record.kind !== 'result' || !['accepted', 'needs_changes'].includes(record.state)) continue;
      try { await this.refreshResultFeedback(config.appId, record.id); }
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
    this.reconcileIntervalMs = Math.max(50, intervalMs);
    if (this.reconcileTimer) { clearTimeout(this.reconcileTimer); this.reconcileTimer = undefined; }
    const unresolved = await this.reconcile(config);
    if (unresolved > 0) this.scheduleReconcile();
    return unresolved;
  }

  async handle(event: LarkMessageEvent, config: StoredLarkConfig, recovering = false) {
    if (this.workflowOptions.store) {
      const current = await readLarkConfig(this.workflowOptions.store, config.appId);
      if (!current?.listening) return;
      config = current;
    }
    const quotedWorkflow = await this.workflows?.quoted(config.appId, event);
    const mentionsBot = this.botOpenId ? event.mentions.some(mention => mention.openId === this.botOpenId) : event.mentions.some(mention => mention.mentionedType === 'bot');
    if (this.stopped || this.handledMessages.has(event.messageId)) return;
    if (event.chatType === 'group' && this.groupManager) config = await this.groupManager.resolved(config, event.chatId);
    const mentionPolicy = config.mentionPolicy ?? 'always';
    const continuedTopic = mentionPolicy === 'topic' && this.groupManager
      ? await this.groupManager.ownsTopic(config, event, await resolveLarkScopeId(event, config, this.chatModeResolver)) : false;
    const botSender = event.senderType === 'app' || event.senderType === 'bot';
    const shouldWake = Boolean(quotedWorkflow) || event.chatType === 'p2p' || (event.chatType === 'group' && (mentionsBot || !botSender && (continuedTopic || mentionPolicy === 'never' || mentionPolicy === 'ambient')));
    if (shouldWake && event.chatType === 'group' && this.groupManager) {
      const decision = await this.groupManager.authorize(config.appId, event.chatId, event.senderOpenId, 'task.create', undefined, { memberObserved: !recovering });
      if (decision && !decision.allowed) return;
    }
    if (this.stopped || !shouldWake || this.handledMessages.has(event.messageId)) return;
    if (recovering && (!event.senderOpenId || !await this.currentAccess(config, event.chatId, event.chatType, event.senderOpenId, 'task.create', undefined, event.senderOpenId))) return;
    await this.requireExecution('listener', 'task.create');
    const inbox = await this.inbox?.claim(config.appId, event);
    if (this.inbox && !inbox) return;
    if (inbox) event = inbox.event;
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
      if (inbox) await this.inbox!.update(inbox, { state: 'failed', error: '消息解析失败' });
      return;
    }
    if (inbox?.request) { prompt = inbox.request.prompt; resources = inbox.request.resources; scopeId = inbox.request.scopeId; }
    const workflowScope = { id: scopeId };
    if (!inbox?.request && await this.routeWorkflow(event, config, prompt, workflowScope)) {
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
    if (typeof commandRoute === 'string') prompt = commandRoute;
    else if (commandRoute) { prompt = commandRoute.prompt; retryMaterialPrompt = commandRoute.materialPrompt; }
    if (inbox && !inbox.request) await this.inbox!.update(inbox, { state: 'received', request: { prompt, scopeId, resources, ...(retryMaterialPrompt ? { materialPrompt: retryMaterialPrompt } : {}) } });
    // 空 @ 消息（仅 @ 机器人无文字）仍需创建任务，由 runTurn 拉取聊天记录做兜底意图判断。
    const task: LarkTask = { id: event.messageId, group, event, prompt, resources, inbox, retryMaterialPrompt, ...(inbox?.cardId ? { cardMessageId: inbox.cardId } : {}), config, state: 'queued', events: [], restoring: recovering, turn: (inbox?.turn ?? 1) - 1, scopeId, epoch: group.epoch ?? 0, acknowledgementReactionId };
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
  private async routeChatCommand(
    event: LarkMessageEvent,
    config: StoredLarkConfig,
    prompt: string,
    group: LarkGroup,
    scopeId: string,
    acknowledgementReactionId?: string
  ): Promise<'handled' | string | LarkRetryPrompt | undefined> {
    if (!parseSlashCommand(prompt)) return undefined;
    const botSender = event.senderType === 'app' || event.senderType === 'bot';
    const commandAccess = event.chatType === 'group' ? await this.groupManager?.authorize(config.appId, event.chatId, event.senderOpenId, 'task.view_result') : undefined;
    const allowlisted = commandAccess?.allowed ?? await this.isOperatorAllowed(config, event.senderOpenId, event.chatId, group.sessionId);
    const route = routeLarkCommand(prompt, {
      capabilities: { ...larkCommandCapabilities(this.runtime), tasks: Boolean(this.workflows && this.cardMappings && this.runtime.getTasks), answer: Boolean(this.workflows && this.workflowOptions.broker), approval: Boolean(this.workflows && this.runtime.resolvePermission && this.runtime.getPendingPermissions) },
      operator: { kind: botSender ? 'bot' : 'user', allowlisted }
    });
    if (route.kind === 'not_a_command') return undefined;
    // 未识别命令交回主流程当普通请求处理，命令层已做归一化防止再被当成内置命令。
    if (route.kind === 'unknown_command') return route.promptText;

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

    if (route.kind === 'reply') {
      await replyCard('命令帮助', route.text, { elements: route.elements });
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
  ): Promise<'handled' | string | LarkRetryPrompt> {
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

      if (route.command === 'status') {
        await replyCard('任务状态', await this.describeChatStatus(config, sessionId, latestTask));
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
            await replyCard('/cancel 未执行', '**当前 Dockmux 运行时无法取消排队任务。**\n\n请前往 Dockmux Web 处理。', { failed: true });
            return 'handled';
          }
          await this.runtime.cancelQueued(target.sessionId, target.id);
        } else {
          await this.runtime.interrupt(target.sessionId, target.id);
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
        const memoryTask = !runtimeTasks?.length && latestTask && ['failed', 'interrupted'].includes(latestTask.state)
          ? latestTask
          : undefined;
        if (!target && !memoryTask) {
          await replyCard('/retry 未执行', '**只有失败或已中断的任务可以重试。**\n\n当前没有可重试的任务，请直接发送新的请求。', { failed: true });
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
        const goal = route.argsText.trim();
        const retired = await this.retireScopeSession(group, config, event, scopeId);
        if (goal) {
          // reaction 仍挂在原消息上，交给随后的建任务链路按正常节奏撤销——
          // 这里不发命令回执，因为用户马上会收到这条新任务的进度卡。
          return goal;
        }
        await replyCard(
          '/new 已受理',
          retired
            ? '**已结束当前会话，下一条消息将开启全新上下文。**\n\n历史记录仍可在 Dockmux Web 查看。'
            : '**当前没有已绑定的会话，下一条消息会直接开启新会话。**'
        );
        return 'handled';
      }
    } catch (error) {
      this.log.warn({ error, command: route.command, messageId: event.messageId }, '执行飞书聊天命令失败');
      await replyCard(`/${route.command} 执行失败`, `**命令未能完成。**\n\n${error instanceof Error ? error.message : String(error)}\n\n可稍后重试，或前往 Dockmux Web 处理。`, { failed: true });
    }
    return 'handled';
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
    return latest && (latest.status === 'failed' || latest.status === 'interrupted') ? latest : undefined;
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
  ): Promise<LarkRetryPrompt | undefined> {
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
    const session = await findPersistedLarkSession(this.runtime, config, event.chatId, event.chatType, scopeId);
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
    group.epoch = (group.epoch ?? 0) + 1;
    // 查询失败不吞：调用方会把异常变成一条「命令执行失败」的回执。
    const persisted = await listPersistedLarkSessions(this.runtime, config, event.chatId, event.chatType, scopeId);
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
    for (const id of targets) await this.runtime.stop?.(id);
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
    const configuredAgent = config.defaultAgentId ?? 'Dockmux';
    if (!sessionId) {
      lines.push(`**Agent**：${larkCommandEcho(configuredAgent, 64)}`);
      if (config.workspace) lines.push(`**工作区**：${larkCommandEcho(config.workspace, 160)}`);
      lines.push('**会话**：尚未创建，发送请求即可开始一轮执行。');
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
    if (session && config.workspace && session.cwd !== config.workspace) {
      lines.push(`**配置的工作区**：${larkCommandEcho(config.workspace, 160)}（下一个新会话生效）`);
    }
    lines.push(`**会话**：\`${larkCommandEcho(sessionId, 64)}\``);
    if (sessionError) lines.push('**运行状态**：读取失败，请前往 Dockmux Web 查看。');
    else if (session) lines.push(`**运行状态**：${larkCommandEcho(session.state, 32)}`);
    else lines.push('**运行状态**：会话记录已不存在，发送新的请求会开启新会话。');
    if (this.runtime.getTasks) {
      try {
        const tasks = await this.runtime.getTasks(sessionId);
        const queued = tasks.filter(task => task.status === 'queued').length;
        const running = tasks.filter(task => task.status === 'running').length;
        // 排队运行数与待执行指令数是两个口径，必须分开表达，不混用。
        lines.push(`**执行中的运行**：${running} 个　**待执行指令**：${queued} 条`);
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
  private async isTaskOperatorAllowed(config: StoredLarkConfig, event: LarkMessageEvent, target: { id: string; sessionId: string }) {
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
    return this.isOperatorAllowed(config, event.senderOpenId, event.chatId, target.sessionId, requester);
  }

  private async isOperatorAllowed(config: StoredLarkConfig, operatorOpenId?: string, chatId?: string, sessionId?: string, taskRequesterOpenId?: string): Promise<boolean> {
    if (this.groupManager && chatId) {
      const decision = await this.groupManager.authorize(config.appId, chatId, operatorOpenId, 'run.interrupt', sessionId, { taskRequesterOpenId });
      if (decision) return decision.allowed;
    }
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

  async handleAction(value: unknown, operatorOpenId?: string, context?: { messageId?: string; chatId?: string }) {
    const workflow = value as Record<string, unknown> | null;
    if (workflow && typeof workflow.dockmux_workflow === 'string') {
      if (!this.workflows || !context?.messageId || !context.chatId || !this.reconcileConfig) return { type: 'error', content: '卡片身份不完整或已失效。' };
      const action = workflow.dockmux_workflow;
      if (!['approve', 'reject', 'accept', 'changes'].includes(action)) return { type: 'error', content: '无法识别任务操作。' };
      try {
        const content = await this.workflows.respond({ appId: this.reconcileConfig.appId, chatId: context.chatId, cardId: context.messageId,
          actorId: operatorOpenId, requestId: String(workflow.request_id ?? ''), generation: String(workflow.generation ?? ''),
          callback: true, action: action as 'approve' | 'reject' | 'accept' | 'changes' });
        if (action === 'accept' || action === 'changes') await this.refreshResultFeedback(this.reconcileConfig.appId, String(workflow.request_id)).catch(error => this.log.warn({ error }, '验收已记录，卡片刷新失败'));
        return { type: 'success', content };
      } catch (error) { return { type: 'error', content: error instanceof Error ? error.message : String(error) }; }
    }
    // 解析交给 card-actions.ts 的共享解析器：渲染端与回调端共用一套形状校验，
    // 不存在「一端认、另一端不认」的权限缝隙。同时兼容线上遗留的 {action, task_id}。
    const parsed = parseLarkCardActionValue(value);
    if (!parsed) return { type: 'error', content: '无法识别卡片操作' };
    const action = parsed.action;
    const taskId = parsed.taskId;
    const task = this.tasks.get(taskId);
    if (!task) return { type: 'warning', content: '任务已过期，请重新发送消息' };

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
        return { type: 'error', content: '刷新失败，请稍后重试或前往 Dockmux Web 查看' };
      }
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
          // 取消这一轮的排队期间可能已经 /retry 开了新一轮：旧点击不得改写新一轮状态，
          // 也不得触发新卡重绘。这一轮的实际终态由它自己的事件流负责。
          if (actionStale()) {
            this.log.info({ taskId, turn: actionTurn }, '排队取消完成时任务已进入新一轮，跳过旧轮次的状态改写');
            return;
          }
          task.state = 'interrupted';
          await task.requestUpdate?.('interrupted', false);
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
          if (runtimeTaskId) await this.runtime.interrupt(sessionId, runtimeTaskId);
          else await this.runtime.interrupt(sessionId);
          // 中断返回时可能已经 /retry：新一轮正在跑，旧点击不能把它标成 interrupted。
          if (actionStale()) {
            this.log.info({ taskId, turn: actionTurn }, '中断完成时任务已进入新一轮，跳过旧轮次的状态改写');
            return;
          }
          task.state = 'interrupted';
          await task.requestUpdate?.('interrupted', false);
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
      if (task.state !== 'failed' && task.state !== 'interrupted') return { type: 'warning', content: '只有失败或已中断的任务可以重试' };
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
      // 卡片生命周期字段刻意**不**在这里重置。上一轮可能还有在途的补发（原卡不可更新时
      // 正在发替代卡），它会在 await 之后写回 cardMessageId；在这里清空只会被它重新填上，
      // 于是新一轮把上一轮的终态卡当成自己的进度卡改写。重置放在新一轮 runTurn 的开头，
      // 那时 turn 已经递增，上一轮的续跑会被 turn 守卫挡在门外。
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
      await sendTaskCard(this.service, task.event, {
        state: 'failed', readOnly: true, retryable: false,
        taskId: task.id, taskName: '请求未执行',
        markdown: '**这条请求没有执行：期间收到了 /new。**\n\n上一个会话已结束，请重新发送这条请求。',
        idempotencyKey: `superseded_${task.id}`.slice(0, 50),
        ...(task.config.webBaseUrl ? { webBaseUrl: task.config.webBaseUrl } : {})
      }, this.log).catch(error => this.log.error({ error, taskId: task.id }, '发送 /new 作废回执失败'));
      await this.clearAcknowledgementReaction(task);
    })();
    return true;
  }

  private async sessionFor(group: LarkGroup, config: StoredLarkConfig, chatId: string, chatType: LarkMessageEvent['chatType'], scopeId: string) {
    // 建会话期间把 promise 挂到 group 上：并发的 /new 需要等它落地，才能把这条
    // 刚建出来的会话一起停掉，而不是让它在 /new 之后变成一个没人管的新上下文。
    const pending = resolveLarkSession(this.runtime, this.log, group, config, chatId, chatType, scopeId);
    const tracked = pending.catch(() => undefined);
    group.pendingSession = tracked;
    try { return await pending; }
    finally { if (group.pendingSession === tracked) group.pendingSession = undefined; }
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
    const resumeTask = task.resumeTask;
    task.resumeTask = undefined;
    const restoring = task.restoring;
    task.restoring = false;
    // 每次 runTurn 递增轮次编号，用于让上一轮的终态回调（finish）识别自己已过期，
    // 避免它在 await getEvents 期间被重试打断后，把 task.state 覆盖回终态。
    task.turn = (task.turn ?? 0) + 1;
    const currentTurn = task.turn;
    // 重试开新一轮：上一轮的卡已经带着它自己的终态结论交付给用户，是不可改写的历史。
    // 在这里（turn 已递增之后）才切断与它的关联，上一轮任何在途的补发都会被 turn 守卫
    // 挡住，不可能再把它的 message_id 写回来变成新一轮的进度卡。
    if (currentTurn > 1 && !restoring) {
      if (task.inbox) await this.inbox!.update(task.inbox, { state: 'received', turn: currentTurn, cardId: undefined, taskId: undefined, materials: undefined });
      task.cardMessageId = undefined;
      task.finalMessageId = undefined;
      task.finalDeliveredTurn = undefined;
      task.lastSuccessfulElements = undefined;
      task.runtimeTaskId = undefined;
      task.progressFrozen = undefined;
    }
    const { group, event, config } = task;
    if (!this.workflows && task.resources.length) {
      task.prompt = await materializeLarkResources(event.messageId, task.prompt, task.resources, this.service);
      task.resources = [];
    }
    // 用户仅 @ 机器人而未发送文字时，拉取最近聊天记录作为上下文，让 Agent 判断用户意图。
    if (!task.prompt.trim()) {
      task.prompt = await this.buildEmptyMessageFallback(event);
    }
    const prompt = task.prompt;
    if (task.inbox?.request && task.inbox.request.prompt !== prompt) await this.inbox!.update(task.inbox, { request: { ...task.inbox.request, prompt } });
    let agentName = config.defaultAgentId ?? 'Dockmux';
    try {
      agentName = (await this.runtime.listAgents?.())?.find(agent => agent.id === config.defaultAgentId)?.name ?? agentName;
    } catch (error) {
      this.log.warn({ error, agentId: config.defaultAgentId }, '读取 Agent 展示名失败，使用 Agent ID 渲染卡片');
    }
    const cardContext = { agentName, permissionMode: larkPermissionMode(config), ...(config.workspace ? { workspace: config.workspace } : {}) };
    const clearAcknowledgement = () => this.clearAcknowledgementReaction(task);

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
    const allowed = config.managedGroup ? true : botSender
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
      if (this.groupManager && event.chatType === 'group') {
        const decision = await this.groupManager.authorize(config.appId, event.chatId, event.senderOpenId, 'task.create', group.sessionId);
        if (decision && !decision.allowed) throw new LarkServiceError(decision.code, decision.reason, 403);
      }
      await this.requireExecution('session', 'task.create');
      if (riskPolicy) await this.requireExecution('high_risk', 'high_risk.execute');
      // 附件下载与身份解析都可能很慢，期间用户可能已经 /new。此刻建会话等于把旧请求
      // 送进一个用户已经宣布结束的上下文，还会顺带创建一条新会话污染新上下文。
      if (this.supersededTurn(task)) return;
      session = resumeTask ? (await this.runtime.getSession(resumeTask.sessionId))! : task.inbox?.sessionId ? (await this.runtime.getSession(task.inbox.sessionId))! : await this.sessionFor(group, config, event.chatId, event.chatType, task.scopeId);
      if (!session) throw new LarkServiceError('LARK_SESSION_MISSING', '原任务会话已不存在，请重新发送目标。', 409);
      // 建会话本身也可能卡住（runtime.start 未返回）。回来后再确认一次，
      // 并把这条会话交给 /new 收走，不留下一个游离的新上下文。
      if (this.supersededTurn(task, session)) return;
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
          const context = await collectLarkTaskContext({ event, prompt, resources: task.resources, service: this.service, ...previous });
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
    const initialState = this.runtime.dispatch ? 'queued' : 'running';
    task.state = initialState;
    task.events = [];
    task.startedAt = Date.now();
    task.interruptRequested = false;
    const initialElements = boundLarkCardElements(renderLarkCardElements([], config, false, false, event.chatType));
    // 首张卡也必须带本轮 turn：它的按钮回调把 turn 写进 value，缺省会渲染成 "0"，
    // 而本轮 turn 从 1 起算——回调随后会被轮次校验当成上一轮的点击拒掉，
    // 直到某次心跳重绘才恢复。UI 不变，只是把回调绑到正确的轮次上。
    if (task.cardMessageId) {
      await this.service.update({ ...cardContext, messageId: task.cardMessageId, permissionMode: larkPermissionMode(config), state: initialState, statusLabel: initialState === 'queued' ? '已接收' : undefined, taskId: task.id, taskName: prompt.slice(0, 80), markdown: initialState === 'queued' ? '任务已接收，正在准备执行…' : '正在思考中…', sessionId: task.sessionId, turn: currentTurn, ...(task.inbox ? { idempotencyKey: `task_${event.messageId}_${currentTurn}`.slice(0, 50) } : {}), ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) });
    } else {
      const card = await sendTaskCard(this.service, event, { ...cardContext, ...(task.inbox ? { idempotencyKey: `task_${event.messageId}_${currentTurn}`.slice(0, 50) } : {}), state: initialState, statusLabel: initialState === 'queued' ? '已接收' : undefined, readOnly: initialState === 'queued', taskId: task.id, taskName: prompt.slice(0, 80), markdown: initialState === 'queued' ? '任务已接收，正在准备执行…' : '正在思考中…', sessionId: task.sessionId, turn: currentTurn, ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) }, this.log);
      task.cardMessageId = card.messageId;
    }
    task.lastSuccessfulElements = initialElements;
    await this.saveCardTask(task);
    if (task.inbox) await this.inbox!.update(task.inbox, { sessionId: session.id, cardId: task.cardMessageId, turn: currentTurn });
    await clearAcknowledgement();

    let timer: NodeJS.Timeout | undefined;
    let heartbeatActive = false;
    /** 一次卡片更新的真实结果。终态交付只认这里的 delivered，不认「链已 resolve」。 */
    type CardUpdateOutcome = { delivered: boolean; messageId?: string };
    type PendingCardUpdate = {
      input: Parameters<LarkCardService['update']>[0];
      terminal: boolean;
      completed: boolean;
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
          let deliveredMessageId = pending.input.messageId;
          // 整条 entry 的处理都包在 try/finally 里：PATCH 成功但落库失败时，
          // 也必须把这条 entry 结算掉。否则调用方的 await 永久挂起，cleanup 不会执行。
          try {
          /**
           * 这一条更新是否还属于当前轮次。
           *
           * 必须在**每次 await 之后**重新判断，不能只在入口判一次：dispatch 模式下
           * executeTask 在 dispatch 建立订阅后就返回，group.tail 随即 resolve，因此
           * 用户点重试时新一轮会立刻开跑并递增 turn——而上一轮的终态 PATCH / 补发可能
           * 还悬在 await 里。等它回来时，task 上的 cardMessageId、lastSuccessfulElements、
           * finalMessageId 已经属于新一轮，旧轮次再写就会污染新一轮的卡片与持久化。
           * 判据用 pending.turn（入队时的轮次），不是现读的 task.turn。
           */
          const stale = () => this.stopped || pending.turn !== task.turn;
          if (stale()) continue;
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
              if (pending.input.elements && !stale()) task.lastSuccessfulElements = pending.input.elements as LarkCardElement[];
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
          // 内容被拒绝只允许原地降级，绝不允许因此多发一条消息：原卡仍然存在且可更新，
          // 再发一条就又变回「收据 + 结果」两条消息。
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
          if (lastError && pending.terminal) {
            // 暂时性失败（网络、限流、5xx）：原卡还在，结论尚未送达。保持未交付并交给对账重试
            // 同一个 message_id，绝不补发第二条消息——补发就是又一次「两条消息」。
            if (!isLarkMessageUnupdatable(lastError)) {
              this.log.warn({ error: lastError, messageId: pending.input.messageId }, '飞书原卡暂时更新失败，保留原卡等待终态对账');
              this.scheduleReconcile();
              continue;
            }
            // 只有原消息确定不可更新（已删除 / 超出可更新期）才补发，且补发的就是最终结论本身，
            // 不存在「替代收据 + 终态卡」两条。
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
                turn: pending.turn,
                ...(task.retryable !== undefined ? { retryable: task.retryable } : {}),
                capabilities: this.capabilitiesForTask(task),
                ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
                elements: replacementElements,
                idempotencyKey: larkTerminalReplacementKey(pending.input.messageId, pending.input.state)
              }, this.log);
              deliveredMessageId = replacement.messageId;
              delivered = true;
              // 补发期间用户可能已经重试。这张补发卡属于**旧**轮次，绝不能变成新一轮的进度卡。
              if (stale()) {
                this.log.info({ replacementMessageId: replacement.messageId, turn: pending.turn }, '旧轮次的终态补发已送达，但新一轮已开始，不改写当前卡片归属');
              } else {
                task.cardMessageId = replacement.messageId;
                task.lastSuccessfulElements = replacementElements;
              }
              this.log.info({ previousMessageId: pending.input.messageId, replacementMessageId: replacement.messageId, state: pending.input.state }, '已补发飞书终态卡片');
            } catch (compensationError) {
              /*
                补发的 await 已经回来了，这期间可能已经 /retry。降级补发要用
                task.sessionId / retryable / capabilities 组卡，而它们此刻属于**新**一轮：
                再发就是拿新一轮的运行态信息，去补一张旧轮次的终态卡。
                旧轮次到此为止，未交付的部分交给对账。
              */
              if (stale()) {
                this.log.info({ error: compensationError, messageId: pending.input.messageId, turn: pending.turn }, '旧轮次终态补发失败且新一轮已开始，不再降级补发');
              } else if (isLarkCardContentRejected(compensationError)) {
                try {
                  const patchedElements = patchRejectedCardDelta(task.lastSuccessfulElements, pending.input.elements as LarkCardElement[] | undefined);
                  const minimal = await sendTaskCard(this.service, event, {
                    ...cardContext,
                    state: pending.input.state,
                    taskId: task.id,
                    taskName: prompt.slice(0, 80),
                    elapsedSeconds: pending.input.elapsedSeconds,
                    sessionId: task.sessionId,
                    turn: pending.turn,
                    ...(task.retryable !== undefined ? { retryable: task.retryable } : {}),
                    capabilities: this.capabilitiesForTask(task),
                    ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
                    elements: patchedElements,
                    idempotencyKey: larkTerminalReplacementKey(pending.input.messageId, pending.input.state, true)
                  }, this.log);
                  deliveredMessageId = minimal.messageId;
                  delivered = true;
                  if (!stale()) {
                    task.cardMessageId = minimal.messageId;
                    task.lastSuccessfulElements = patchedElements;
                  }
                  this.log.warn({ previousMessageId: pending.input.messageId, replacementMessageId: minimal.messageId, upstreamCode: compensationError.details?.upstreamCode }, '飞书补发终态卡片增量被拒绝，已保留上次成功内容');
                } catch (fallbackError) {
                  this.log.error({ error: fallbackError, contentError: compensationError, updateError: lastError, messageId: pending.input.messageId }, '补发飞书终态最小卡片失败');
                }
              } else {
                this.log.error({ error: compensationError, updateError: lastError, messageId: pending.input.messageId }, '补发飞书终态卡片失败');
              }
            }
            if (!delivered && !stale()) this.scheduleReconcile();
          }
          if (delivered && pending.input.state) {
            // 旧轮次不得写入新一轮的持久化：mapping 只有一行，写进去就把新一轮的
            // card_message_id / runtime_task_id 覆盖成上一轮的了。
            if (stale()) {
              this.log.info({ taskId: task.id, turn: pending.turn, messageId: deliveredMessageId }, '旧轮次终态已送达，但新一轮已开始，跳过持久化以免覆盖新一轮状态');
              continue;
            }
            // 单卡契约：终态就是这张卡自己，因此 final_message_id === card_message_id。
            // 只有真正成功的那次更新才允许标记已交付。
            if (pending.terminal) {
              task.progressFrozen = true;
              task.finalMessageId = deliveredMessageId;
              task.finalDeliveredTurn = pending.turn;
              if (pending.completed && this.workflows && this.interactionContext(task)) {
                await this.workflows.result(this.interactionContext(task)!, deliveredMessageId).catch(error => this.log.warn({ error, taskId: task.id }, '结果已交付，验收卡绑定保存失败'));
              }
            }
            // 落库失败不改变「卡片已经送达用户」这个事实，因此不回退 delivered：
            // 谎称未送达会让对账再交付一次。只补一次对账把持久化补上。
            try {
              await this.saveCardTask(task, pending.input.state);
              if (pending.completed && this.workflows) {
                const feedback = (await this.workflows.list(config.appId)).find(item => item.kind === 'result' && item.taskId === task.runtimeTaskId && ['accepted', 'needs_changes'].includes(item.state));
                if (feedback) await this.refreshResultFeedback(config.appId, feedback.id);
              }
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
     * 本轮是否已经请求过终态。终态一旦入队就是这一轮的最终结论，
     * 之后到达的心跳/排队重绘不得把它挤掉，也不得在它之后再改写卡片。
     */
    let terminalLatched = false;
    /**
     * 入队一次卡片更新，返回的 promise 只在**这一条**更新有结果后才 resolve。
     *
     * 刻意不返回 updateChain：链的 finally 会为后到的 pendingUpdate 再起一次没人 await 的
     * flush，此时 await 旧链拿到的是「上一帧心跳写完了」，而不是「我的终态真的写进去了」。
     * 终态交付必须以自己那次 PATCH 的真实结果为准，否则会把未送达的结论记成已交付。
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

    const update = async (state: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted', completed = false) => {
      // Runtime running is monotonic for a turn. Late dispatch/cancel bookkeeping may
      // still report queued, but must never repaint an executing card backwards.
      if (state === 'queued' && task.state === 'running') return Promise.resolve({ delivered: false } as CardUpdateOutcome);
      if (timer) { clearTimeout(timer); timer = undefined; }
      const terminal = state === 'completed' || state === 'failed' || state === 'interrupted';
      return enqueueUpdate({
        terminal,
        completed,
        turn: task.turn,
        input: {
          ...cardContext,
          messageId: task.cardMessageId!,
          permissionMode: larkPermissionMode(config),
          state,
          taskId: task.id,
          taskName: prompt.slice(0, 80),
          elapsedSeconds: (Date.now() - task.startedAt!) / 1_000,
          sessionId: task.sessionId,
          // 按钮能力按 runtime 实际状态注入。终态同样按能力表渲染，而不是一刀切 readOnly：
          // 失败/中断的这张卡就是用户唯一的入口，重试必须留在上面。
          turn: task.turn,
          ...(terminal && task.retryable !== undefined ? { retryable: task.retryable } : {}),
          capabilities: this.capabilitiesForTask(task),
          ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
          elements: boundLarkCardElements([ ...renderLarkCardElements(task.events, config, completed, false, event.chatType),
            ...(completed && this.workflows && this.interactionContext(task) ? await this.workflows.result(this.interactionContext(task)!, task.cardMessageId!) : []) ])
        }
      });
    };
    let terminalDelivery: Promise<void> | undefined;
    /**
     * 单卡终态交付：把真实结论 PATCH 回这一轮自己的那张卡。
     *
     * 不再「冻结收据 + 另发一条结果」——那会让一轮任务留下两条消息。原卡更新失败时
     * 保持未交付（对账重试同一个 message_id）；只有原卡确定不可更新时才补发唯一一张。
     */
    const deliverTerminal = (state: 'completed' | 'failed' | 'interrupted', completed = false) => {
      if (task.finalDeliveredTurn === currentTurn && task.finalMessageId) return Promise.resolve();
      if (terminalDelivery) return terminalDelivery;
      terminalDelivery = (async () => {
        const outcome = await update(state, completed);
        // 未送达不是错误路径，而是「还没交付」：flushUpdates 已经安排了对账重试同一张卡。
        // 这里不抛异常，避免调用方把它当成需要补发新消息的失败。
        if (!outcome.delivered) return;
      })().catch(error => {
        this.log.error({ error, taskId: task.id, state }, '交付飞书终态卡片失败，等待对账补偿');
        this.scheduleReconcile();
        throw error;
      }).finally(() => { terminalDelivery = undefined; });
      return terminalDelivery;
    };

    const scheduleHeartbeat = () => {
      if (!heartbeatActive || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (!this.stopped && task.turn === currentTurn) void this.observeLiveWaiters(task).catch(error => this.log.warn({ error, taskId: task.id }, '待处理问题卡暂未送达，将随心跳重试'));
        void update('running').finally(scheduleHeartbeat);
      }, Math.max(config.pushIntervalMs, cardRateLimitedUntil - Date.now()));
    };
    task.requestUpdate = async (state, completed) => {
      if (state === 'completed' || state === 'failed' || state === 'interrupted') return deliverTerminal(state, completed);
      await update(state, completed);
    };
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
    const agentPrompt = injected.length ? `${injected.join('\n\n')}\n\n[用户请求]\n${materialPrompt}` : materialPrompt;

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
              // 读事件期间用户可能已经重试；旧轮次不得改写新一轮的事件缓冲。
              if (task.turn !== currentTurn) return;
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
          if (runtimeTaskId) await this.workflows?.expireTask(config.appId, runtimeTaskId);
          await deliverTerminal(resolvedState, resolvedState === 'completed').finally(cleanup);
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
            task.startedAt = Date.now();
            void update('running').finally(scheduleHeartbeat);
          } else if (record.status === 'completed' || record.status === 'failed' || record.status === 'interrupted' || record.status === 'cancelled') finish(record.status === 'cancelled' ? 'interrupted' : record.status);
          return;
        }
        if (!active || settled) return;
        task.events.push(agentEvent);
        const context = this.interactionContext(task);
        if (context) void this.workflows?.observe(context, agentEvent).catch(error => this.log.error({ error, taskId: task.id }, '发送飞书工作请求失败'));
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
        // dispatch 期间用户可能已经重试（group.tail 在 dispatch 建立订阅后就 resolve 了）。
        // 旧轮次不得把自己的 runtime task 写成新一轮的，否则 mapping 里的任务归属就错了。
        if (task.turn !== currentTurn) return;
        task.runtimeTaskId = runtimeTask.id;
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
          const queueMarkdown = (runtimeTask.queuedAhead ?? 0) > 0
            ? `正在排队，前面还有 ${runtimeTask.queuedAhead} 个任务…`
            : '已进入执行队列，等待 Agent 开始…';
          // 此时 runtimeTaskId 已就位，取消排队才真正可执行，因此这一版卡片开始提供
          // 「取消」。首张「已接收」卡片刻意不提供（runtimeTaskId 尚未分配，点了必失败）。
          try {
            await this.service.update({ ...cardContext, messageId: task.cardMessageId!, permissionMode: larkPermissionMode(config), state: 'queued', statusLabel: '排队中', taskId: task.id, taskName: prompt.slice(0, 80), markdown: queueMarkdown, sessionId: task.sessionId, turn: task.turn, capabilities: this.capabilitiesForTask(task), ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) });
            await this.saveCardTask(task, 'queued');
          } catch (error) {
            // Runtime already owns this task. A receipt/mapping outage must not
            // discard buffered events or report the accepted execution failed.
            this.log.warn({ error, runtimeTaskId }, '任务已接收，排队卡片待后续更新');
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
