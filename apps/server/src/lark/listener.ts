import type { LarkGroupParticipation } from './group-participation.js';
import type { ExecutionActor, ExecutionRecoveryDecision } from '@dutydeck/shared';
import type { SessionAutomationService } from '../session-automation.js';
import type { RelayAskBroker } from '@dutydeck/relay';
import * as lark from '@larksuiteoapi/node-sdk';
import type { AgentConfig, AgentEvent, ChannelMappingRepository, ConfigRepository, PermissionRequestData, PermissionMode, PolicyAction, PolicyDecision, Session, TaskRecord, ToolRiskPolicy, VerificationCommandInput, VerificationResponse } from '@dutydeck/shared';
import type { LarkGroupManager } from './group-management.js';
import type { StoredLarkConfig } from './config.js';
import { createLarkCardService, LarkServiceError } from './service.js';
import { setLarkGateLog } from './api-gate.js';
import { getChatMode } from './chat-mode.js';
import { larkCommandCapabilities } from './commands.js';
import { LarkMessageCoordinator } from './coordinator.js';
import type { LarkMemoryStore } from './memory.js';
import type { LarkMemoryProjection } from './memory-view.js';
import type { LarkMemoryPipeline } from './memory-pipeline.js';
import { createLarkWelcomeService, type LarkWelcomeService } from './welcome.js';
import { describeWebBaseUrlReachability, larkExecutionConfirmed } from './config.js';
import { buildEditedMessageEvent } from './edited-message.js';
import { LarkCardCallbackDeduper, larkCardCallbackKeys } from './card-callback-dedup.js';
import type { LoginLinkStore } from '../auth/auth.js';

// 飞书长连接监听：只负责 WebSocket 事件接入、事件组装与协调器装配。
// 消息协调见 coordinator.ts，卡片渲染见 card-renderer.ts，会话路由见 session-resolver.ts，
// 卡片终态对账见 reconciler.ts。本文件同时 re-export 上述模块的公开符号，
// 保持既有 import 路径（'./listener.js'）不变。

export type ListenerLog = {
  info(details: unknown, message?: string): void;
  warn(details: unknown, message?: string): void;
  error(details: unknown, message?: string): void;
};

export interface LarkRuntime {
  start(input: { agentId: string; cwd?: string; model?: string; reasoningEffort?: string; permissionMode?: PermissionMode; workspaceMode?: 'shared' | 'worktree'; source?: string; sourceId?: string }): Promise<Session>;
  listAgents?(): Promise<Array<Pick<AgentConfig, 'id' | 'name'> & Partial<AgentConfig>>>;
  listSessions?(): Promise<Session[]>;
  getSession(id: string): Promise<Session | undefined>;
  stop?(id: string, actor?: ExecutionActor): Promise<unknown>;
  send(id: string, prompt: string, agentPrompt?: string, riskPolicy?: ToolRiskPolicy, actorId?: string): Promise<unknown>;
  dispatch?(id: string, prompt: string, mode?: 'queue' | 'interrupt', agentPrompt?: string, riskPolicy?: ToolRiskPolicy, actorId?: string, idempotencyKey?: string): Promise<{ id: string; status: string; queuedAhead?: number; replayed?: boolean }>;
  getPendingPermissions?(id: string): PermissionRequestData[] | Promise<PermissionRequestData[]>;
  resolvePermission?(id: string, requestId: string, approved: boolean): Promise<unknown>;
  getTasks?(id: string): Promise<TaskRecord[]>;
  getTaskRecovery?(id: string, taskId: string): Promise<{ status: string; blockers: Array<{ code: string }>; activeTaskId?: string; resolvedUnknown?: boolean; verifiedOutput?: { eventId: string; digest: string } }>;
  getEvents?(id: string, afterSequence?: number): Promise<AgentEvent[]>;
  getRecentEvents?(id: string, limit: number): Promise<AgentEvent[]>;
  interrupt(id: string, expectedTaskId?: string, actor?: string): Promise<unknown>;
  cancelQueued?(id: string, taskId: string, actorId?: string): Promise<unknown>;
  /** 把排队中的一轮提到队首（会中断当前正在执行的那一轮）。/queue top 与 /steer 的唯一原语。 */
  steerQueued?(id: string, taskId: string, actorId?: string): Promise<unknown>;
  /** 平台验证记录，最新在前，含代码指纹与 stale 判定。 */
  getVerifications?(id: string): Promise<VerificationResponse[]>;
  runVerification?(id: string, input: VerificationCommandInput, actorId?: string): Promise<VerificationResponse>;
  subscribe(sessionId: string, listener: (event: AgentEvent) => void): () => void;
  /**
   * 安装者身份的执行恢复读写，与 `dutydeck recovery` 同一组原语。服务重启切断的一轮自动重投时用：
   * 读原因码、阻塞与资源核对，把旧一轮记为结果未知。
   */
  inspectExecutionRecovery?(id: string, actor: ExecutionActor): Promise<{
    runId: string; blockers: unknown[]; stopBlock: unknown; resourceChecks: ExecutionRecoveryDecision['resourceChecks'];
    tasks: Array<{ taskId: string; attempt?: { attemptId: string; revision: number; state: string; reconcileReason?: { code: string }; createdAt?: string } }>;
  }>;
  confirmExecutionRecovery?(id: string, decision: ExecutionRecoveryDecision, actor: ExecutionActor): Promise<unknown>;
  /** 往会话时间线写一条说明（Web 上能看到），不属于任何一轮的执行输出。 */
  publishSessionEvent?(sessionId: string, type: 'text', data: unknown): Promise<unknown>;
}

export interface LarkMessageEvent {
  messageId: string;
  chatId: string;
  chatType: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  createTime?: string;
  messageType: string;
  content: string;
  senderOpenId?: string;
  senderType?: string;
  mentions: Array<{ key: string; name: string; openId?: string; mentionedType?: string }>;
}

export interface LarkListener {
  readonly listening: boolean;
  start(config: StoredLarkConfig): Promise<void>;
  stop(): void;
}

export interface LarkLongConnectionListenerOptions {
  participation?: LarkGroupParticipation;
  automation?: SessionAutomationService;
  workbench?: import('./workbench.js').LarkWorkbench;
  workflowStore?: ConfigRepository;
  relayBroker?: RelayAskBroker;
  groupManager?: LarkGroupManager;
  runtime?: LarkRuntime;
  cardMappings?: ChannelMappingRepository;
  /**
   * 欢迎语去重标记的 kv 存储（必须持久化，保证重启不重发）；
   * 缺省时回退复用 workflowStore，两者都没有则不启用欢迎语。
   */
  welcomeStore?: ConfigRepository;
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof globalThis.fetch;
  peerBotAuthorized?: (appId: string, chatId: string, senderOpenId: string) => Promise<boolean>;
  /** 群形态查询（话题群 vs 普通群）；未注入时默认走 chat-mode.ts 的 getChatMode（带缓存）。 */
  chatModeResolver?: (appId: string, chatId: string) => Promise<'topic' | 'group' | 'p2p'>;
  memory?: {
    store: LarkMemoryStore;
    projection: LarkMemoryProjection;
    command?: string;
    pipeline?: LarkMemoryPipeline;
  };
  /** Existing StoredLarkConfig listeners are always explicitly legacy_unmanaged. */
  executionPolicy?: {
    integrationMode: 'legacy_unmanaged';
    authorize(boundary: 'listener' | 'session' | 'high_risk', action: PolicyAction): Promise<PolicyDecision>;
  };
  /** Web 要求登录时提供；卡片「查看详情」改为给管理员私信一次性登录链接。 */
  loginLinks?: LoginLinkStore;
}

export class LarkLongConnectionListener implements LarkListener {
  private client?: lark.WSClient;
  private coordinator?: LarkMessageCoordinator;
  private welcome?: LarkWelcomeService;
  private credentials?: string;
  private config?: StoredLarkConfig;
  private readonly cardCallbacks = new LarkCardCallbackDeduper();
  listening = false;

  constructor(private readonly log: ListenerLog, private readonly options: LarkLongConnectionListenerOptions = {}) {}

  async start(config: StoredLarkConfig) {
    // api-gate 是模块级单例（per-appId 限流状态必须跨会话共享），没有构造注入点。
    // 在监听装配处接上真实日志，让限流等待、退避重试和熔断跳闸可观测。
    setLarkGateLog(this.log);
    // S7：webBaseUrl 留空/仅本机可达时，审批问答卡没有手机可达的网页出口。
    // 每次启动（含同凭证早退路径）都明示，不静默降级成「看似可用」。
    const webReachability = describeWebBaseUrlReachability(config.webBaseUrl);
    if (webReachability.kind !== 'public' && webReachability.message) {
      this.log.warn({ appId: config.appId, kind: webReachability.kind }, webReachability.message);
    }
    const credentials = `${config.appId}\u0000${config.appSecret}`;
    if (this.listening && this.credentials === credentials) {
      const participationChanged = this.config?.defaultGroupParticipation !== config.defaultGroupParticipation;
      this.config = config;
      try { await this.coordinator?.startReconciliation(config); }
      catch (error) { this.log.warn({ error, appId: config.appId }, '飞书卡片终态对账刷新失败，继续保持消息监听'); }
      if (participationChanged) void this.options.participation?.refresh(config.appId).catch(error => this.log.warn({ error, appId: config.appId }, '默认群参与刷新失败'));
      return;
    }
    this.stop();

    const service = createLarkCardService(this.options.env ?? process.env, this.options.fetcher ?? globalThis.fetch, { appId: config.appId, appSecret: config.appSecret });
    let botOpenId: string;
    try { botOpenId = await service.getBotOpenId(); }
    catch (error) { throw new LarkServiceError('LARK_LISTENER_START_FAILED', `Failed to resolve Lark bot identity: ${error instanceof Error ? error.message : String(error)}`, 502); }
    // 话题群种子消息需要按群形态路由：默认用带缓存的 getChatMode，也允许注入（测试/自定义路由）。
    const chatModeResolver = this.options.chatModeResolver ?? ((appId: string, chatId: string) => getChatMode(appId, config.appSecret, chatId));
    const coordinator = this.options.runtime ? new LarkMessageCoordinator(
      this.options.runtime,
      service,
      this.log,
      Math.random,
      botOpenId,
      (chatId, senderOpenId) => this.options.peerBotAuthorized?.(config.appId, chatId, senderOpenId) ?? Promise.resolve(false),
      this.options.cardMappings,
      chatModeResolver,
      this.options.executionPolicy,
      this.options.groupManager,
      { store: this.options.workflowStore, broker: this.options.relayBroker, automation: this.options.automation, workbench: this.options.workbench, memory: this.options.memory, participation: this.options.participation, loginLinks: this.options.loginLinks },
    ) : undefined;
    await coordinator?.initializeWorkflows(config);
    if (coordinator) this.options.participation?.setDispatcher(config.appId, (event, current) => coordinator.adopt(event, current));
    void this.options.participation?.recover(config.appId).catch(error => this.log.warn({ error, appId: config.appId }, '群观察恢复失败'));
    try { await coordinator?.startReconciliation(config); }
    catch (error) { this.log.warn({ error, appId: config.appId }, '飞书卡片终态对账启动失败，继续建立消息监听'); }
    // 欢迎语：kv 必须是持久化存储，重启后才能靠标记不重发；无存储则不启用。
    const welcomeKv = this.options.welcomeStore ?? this.options.workflowStore;
    if (welcomeKv) {
      const capabilities = this.options.runtime
        ? {
          ...larkCommandCapabilities(this.options.runtime),
          // 与 coordinator.routeChatCommand 的 /tasks 能力判定保持同源。
          tasks: Boolean(this.options.workflowStore && this.options.cardMappings && this.options.runtime.getTasks)
        }
        : undefined;
      this.welcome = createLarkWelcomeService({
        appId: config.appId,
        kv: welcomeKv,
        routing: async (chatId, chatType) => {
          const current = this.config ?? config;
          try {
            if (chatType === 'group') await this.options.groupManager?.ensureParticipationGroup(current.appId, chatId);
            const effective = chatType === 'group' && this.options.groupManager
              ? await this.options.groupManager.resolved(current, chatId) : current;
            // 身份边界文案的触发条件：托管群看生效的 access（值班群等同全员），
            // 未托管群看部署级白名单是否为空——两种形态下「全员都能使唤」的判据不同。
            const access = chatType === 'group' && this.options.groupManager
              ? await this.options.groupManager.groupAccess(current.appId, chatId) : undefined;
            const allChatMembers = access
              ? access.oncall || access.effective.mode === 'all_chat_members'
              : !current.allowedUsers.length && !current.allowedEmails.length;
            return { ...effective, ...(chatType === 'group' ? { chatMode: await chatModeResolver(current.appId, chatId), allChatMembers,
              participation: await this.options.participation?.mode({ appId: current.appId, chatId }) } : {}) };
          } catch {
            return { ...current, unavailableReason: '无法确认当前群配置与触发方式。' };
          }
        },
        ...(capabilities ? { capabilities } : {}),
        log: this.log,
        send: (chatId, content) => service.send({
          chatId,
          state: 'completed',
          readOnly: true,
          retryable: false,
          taskName: content.title,
          elements: content.elements,
          idempotencyKey: `lark_welcome_${chatId}`.slice(0, 50)
        }).then(() => undefined)
      });
    }
    const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.warn }).register({
      'im.message.receive_v1': event => {
        const message = event.message;
        this.log.info({ messageId: message.message_id, chatId: message.chat_id, chatType: message.chat_type }, '收到飞书消息事件');
        // 私聊首次消息欢迎：只发一次（kv 去重），失败不抛错，且绝不等待它、不阻断消息 dispatch。
        // 群聊普通消息不发欢迎；bot 入群欢迎走 im.chat.member.bot.added_v1。
        if (message.chat_type === 'p2p' && message.chat_id) {
          this.welcome?.welcomeP2pChat(message.chat_id).catch(error => {
            this.log.error({ error, chatId: message.chat_id }, '处理飞书私聊欢迎失败，继续派发消息');
          });
        }
        coordinator?.handle({
          messageId: message.message_id,
          chatId: message.chat_id,
          chatType: message.chat_type,
          ...(message.root_id ? { rootId: message.root_id } : {}),
          ...(message.parent_id ? { parentId: message.parent_id } : {}),
          ...(message.thread_id ? { threadId: message.thread_id } : {}),
          ...(message.create_time ? { createTime: message.create_time } : {}),
          messageType: message.message_type,
          content: message.content,
          ...(event.sender?.sender_id?.open_id ? { senderOpenId: event.sender.sender_id.open_id } : {}),
          ...(event.sender?.sender_type ? { senderType: event.sender.sender_type } : {}),
          mentions: (message.mentions ?? []).map(mention => ({ key: mention.key, name: mention.name, ...(mention.id.open_id ? { openId: mention.id.open_id } : {}), ...(mention.mentioned_type ? { mentionedType: mention.mentioned_type } : {}) }))
        }, this.config ?? config).catch(error => {
          this.log.error({ error, messageId: message.message_id, chatId: message.chat_id }, '处理飞书消息事件失败');
        });
      },
      // 平台重复推送的同一次点击只处理一次，重推直接返回第一次的结果。
      'card.action.trigger': (event: any) => this.cardCallbacks.run(larkCardCallbackKeys(event), async () => {
        const operatorOpenId = event.operator?.open_id;
        // JSON 2.0 表单（结构化问答的多选/自由文本、workbench 步骤答题）提交值在 form_value，
        // 按钮回调值在 action.value；合并后下游统一读 value，表单值挂在 value.form_value。
        // 未合并时表单类回调必然拿不到答案，属 fail-closed 接线点。
        const actionValue = event.action?.value;
        const formValue = event.action?.form_value;
        const value = formValue ? { ...actionValue, form_value: formValue } : actionValue;
        const result = await coordinator?.handleAction(value, operatorOpenId, {
          messageId: event.context?.open_message_id ?? event.open_message_id,
          chatId: event.context?.open_chat_id ?? event.open_chat_id,
          // overflow 菜单：behaviors.value 全组共用，被点选项只在 action.option。
          // 传给主控做白名单门（目前只放行 'reject'），防 multi_url 等未证实项误触发回调。
          ...(event.action?.tag === 'overflow' ? { actionTag: 'overflow', option: event.action.option } : {})
        });
        if (!result) return;
        return { toast: result };
      }),
      // bot 被拉入群：发一次入群欢迎卡（welcome 内部 kv 去重，重复事件/重启不重发）。
      // 存量应用需先经 /repair 增量订阅该事件并发布通过审核后才能收到。
      'im.chat.member.bot.added_v1': (event: any) => {
        const chatId = typeof event?.chat_id === 'string' ? event.chat_id : '';
        this.log.info({ chatId, eventId: event?.event_id }, '收到飞书机器人入群事件');
        if (!chatId) return;
        void this.options.participation?.bootstrap({ appId: config.appId, chatId }).catch(error => this.log.warn({ error, chatId }, '入群上下文初始化失败'));
        this.welcome?.welcomeBotAdded(chatId).catch(error => {
          this.log.error({ error, chatId }, '处理飞书机器人入群欢迎失败');
        });
      },
      // 入站 reaction 显式登记为 no-op：机器人自己加/撤 `OK` 回执会回流成事件，
      // 用户手动贴表情也会。两者都不得驱动任务，也不应落到未知事件分支产生日志噪音。
      // reaction 在本产品里只是「请求已接入」的单向回执，不是可交互的控制面。
      'im.message.reaction.created_v1': () => undefined,
      'im.message.reaction.deleted_v1': () => undefined,
      // 消息「修改」事件：解决「原消息发出时没 @ 本 bot（从未触发任务），用户编辑补 @」。
      // 事件 payload 的正文/mentions 不可靠，一律只取 message_id 回读权威消息；原作者、
      // 正文、mentions、话题字段全部以详情为准，编辑操作者绝不进入事件。是否已触发由
      // coordinator 的持久 inbox 幂等保证：未唤醒时不 claim，已 claim 的消息不会重跑。
      'im.message.updated_v1': (event: any) => {
        if (!coordinator) return;
        const eventMessageId = typeof event?.message?.message_id === 'string' ? event.message.message_id : '';
        if (!eventMessageId) {
          this.log.warn({ eventId: event?.event_id }, '飞书消息编辑事件缺少 message_id，忽略');
          return;
        }
        return (async () => {
          let detail;
          try {
            detail = await service.getMessage(eventMessageId);
          } catch (error) {
            // 权限错误/网络错误都不绕过：@ 状态无从确认，降级为忽略并记日志。
            this.log.warn({ error, messageId: eventMessageId }, '回读编辑消息详情失败，忽略编辑事件');
            return;
          }
          let editedEvent: LarkMessageEvent | undefined;
          try {
            editedEvent = await buildEditedMessageEvent({
              eventMessageId, detail, botOpenId, appId: config.appId,
              resolveChatType: chatModeResolver
            });
          } catch (error) {
            // 群形态查询失败等：不猜测 chatType，不触发。
            this.log.warn({ error, messageId: eventMessageId }, '解析编辑消息上下文失败，忽略编辑事件');
            return;
          }
          if (!editedEvent) {
            this.log.info({ messageId: eventMessageId }, '编辑消息不满足触发条件（已删除/非人类/未显式@本bot等），忽略');
            return;
          }
          await coordinator.handle(editedEvent, this.config ?? config).catch(error => {
            this.log.error({ error, messageId: eventMessageId, chatId: editedEvent!.chatId }, '处理飞书消息编辑事件失败');
          });
        })();
      }
    });
    let connected!: () => void;
    let connectionFailed!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { connected = resolve; connectionFailed = reject; });
    const client = new lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: lark.LoggerLevel.warn,
      autoReconnect: true,
      // 握手超时：避免 TCP 已建立但 WebSocket 升级无响应时，重连循环的 connect() 永远挂起。
      handshakeTimeoutMs: 15_000,
      // 存活检测：超过该时长未收到任何入站帧（含 pong）则主动断开并触发重连，
      // 防止连接半开（TCP 看起来正常但实际已不通）时监听静默失效。
      wsConfig: { pingTimeout: 120 },
      onReady: () => { connected(); this.log.info({ appId: config.appId }, '飞书消息监听已连接'); },
      onReconnecting: () => this.log.warn({ appId: config.appId }, '飞书消息监听正在重连'),
      onReconnected: () => this.log.info({ appId: config.appId }, '飞书消息监听已恢复'),
      onError: error => { connectionFailed(error); this.log.error({ error, appId: config.appId }, '飞书消息监听异常'); }
    });
    const connectionTimeout = setTimeout(() => connectionFailed(new Error('WebSocket connection readiness timed out')), 20_000);
    try {
      // SDK start() returns before the handshake; only onReady confirms it.
      await Promise.all([client.start({ eventDispatcher: dispatcher }), ready]);
      this.client = client;
      this.coordinator = coordinator;
      this.credentials = credentials;
      this.config = config;
      this.listening = true;
    } catch (error) {
      client.close();
      coordinator?.stop();
      throw new LarkServiceError('LARK_LISTENER_START_FAILED', `Failed to start Lark listener: ${error instanceof Error ? error.message : String(error)}`, 502);
    } finally { clearTimeout(connectionTimeout); }
  }

  stop() {
    if (this.config) this.options.participation?.closeApp(this.config.appId);
    this.client?.close();
    this.coordinator?.stop();
    this.client = undefined;
    this.coordinator = undefined;
    this.welcome = undefined;
    this.credentials = undefined;
    this.config = undefined;
    this.listening = false;
  }
}

export interface LarkListenerPool {
  readonly listening: boolean;
  readonly activeAppIds: string[];
  sync(configs: StoredLarkConfig[]): Promise<void>;
  stop(): void;
}

export class LarkLongConnectionListenerPool implements LarkListenerPool {
  private readonly listeners = new Map<string, LarkLongConnectionListener>();
  private syncTail: Promise<void> = Promise.resolve();

  constructor(private readonly log: ListenerLog, private readonly options: LarkLongConnectionListenerOptions = {}) {}

  get listening() { return this.listeners.size > 0; }
  get activeAppIds() { return [...this.listeners.keys()]; }

  sync(configs: StoredLarkConfig[]): Promise<void> {
    const synced = this.syncTail.then(() => this.syncConfiguredListeners(configs));
    this.syncTail = synced.catch(() => {});
    return synced;
  }

  private async syncConfiguredListeners(configs: StoredLarkConfig[]) {
    const enabled = new Map(configs.filter(config => config.listening && larkExecutionConfirmed(config)).map(config => [config.appId, config]));
    for (const [appId, listener] of this.listeners) {
      if (enabled.has(appId)) continue;
      listener.stop();
      this.listeners.delete(appId);
    }
    const failures: unknown[] = [];
    for (const [appId, config] of enabled) {
      const listener = this.listeners.get(appId) ?? new LarkLongConnectionListener(this.log, this.options);
      try {
        await listener.start(config);
        this.listeners.set(appId, listener);
      } catch (error) {
        listener.stop();
        this.listeners.delete(appId);
        failures.push(error);
      }
    }
    if (failures.length) throw failures[0];
  }

  stop() {
    for (const listener of this.listeners.values()) listener.stop();
    this.listeners.clear();
  }
}

// 保持既有 import 路径（'./listener.js'）不变的 re-export。
export {
  isLarkMessageRateLimit,
  larkRateLimitBackoffMs,
  isLarkCardContentRejected,
  isLarkMessageUnupdatable,
  patchRejectedCardDelta,
  renderLarkCardElements,
  renderLarkTrace
} from './card-renderer.js';
export type { TraceEntry, TraceGroup, LarkCardElement } from './card-renderer.js';
export { LarkMessageCoordinator } from './coordinator.js';
export type { LarkGroup, LarkTask, LarkTaskState, PersistedLarkCardTask } from './coordinator.js';
export {
  larkSessionConfigKey,
  larkGroupScopeId,
  larkGroupKey,
  larkReplyContext,
  larkSourceId,
  larkSessionMatchesScope,
  findPersistedLarkSession,
  listPersistedLarkSessions,
  parsePrompt,
  materializeLarkResources,
  resolveLarkScopeId,
  resolveLarkSession
} from './session-resolver.js';
export type {
  LarkChatModeResolver
} from './session-resolver.js';
export { performLarkCardReconcile } from './reconciler.js';
export { getChatMode, getCachedChatMode, clearLarkChatModeCache } from './chat-mode.js';
export type { LarkChatMode } from './chat-mode.js';
