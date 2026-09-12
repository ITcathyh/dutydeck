import type { SessionAutomationService } from '../session-automation.js';
import type { RelayAskBroker } from '@dutydeck/relay';
import * as lark from '@larksuiteoapi/node-sdk';
import type { AgentConfig, AgentEvent, ChannelMappingRepository, ConfigRepository, PermissionRequestData, PermissionMode, PolicyAction, PolicyDecision, Session, TaskRecord, ToolRiskPolicy } from '@dutydeck/shared';
import type { LarkGroupManager } from './group-management.js';
import type { StoredLarkConfig } from './config.js';
import { createLarkCardService, LarkServiceError } from './service.js';
import { setLarkGateLog } from './api-gate.js';
import { getChatMode } from './chat-mode.js';
import { LarkMessageCoordinator } from './coordinator.js';

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
  stop?(id: string): Promise<unknown>;
  send(id: string, prompt: string, agentPrompt?: string, riskPolicy?: ToolRiskPolicy, actorId?: string): Promise<unknown>;
  dispatch?(id: string, prompt: string, mode?: 'queue' | 'interrupt', agentPrompt?: string, riskPolicy?: ToolRiskPolicy, actorId?: string, idempotencyKey?: string): Promise<{ id: string; status: string; queuedAhead?: number; replayed?: boolean }>;
  getPendingPermissions?(id: string): PermissionRequestData[] | Promise<PermissionRequestData[]>;
  resolvePermission?(id: string, requestId: string, approved: boolean): Promise<unknown>;
  getTasks?(id: string): Promise<TaskRecord[]>;
  getEvents?(id: string, afterSequence?: number): Promise<AgentEvent[]>;
  getRecentEvents?(id: string, limit: number): Promise<AgentEvent[]>;
  interrupt(id: string, expectedTaskId?: string): Promise<unknown>;
  cancelQueued?(id: string, taskId: string): Promise<unknown>;
  subscribe(sessionId: string, listener: (event: AgentEvent) => void): () => void;
}

export interface LarkMessageEvent {
  messageId: string;
  chatId: string;
  chatType: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
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
  automation?: SessionAutomationService;
  workflowStore?: ConfigRepository;
  relayBroker?: RelayAskBroker;
  groupManager?: LarkGroupManager;
  runtime?: LarkRuntime;
  cardMappings?: ChannelMappingRepository;
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof globalThis.fetch;
  peerBotAuthorized?: (appId: string, chatId: string, senderOpenId: string) => Promise<boolean>;
  /** 群形态查询（话题群 vs 普通群）；未注入时默认走 chat-mode.ts 的 getChatMode（带缓存）。 */
  chatModeResolver?: (appId: string, chatId: string) => Promise<'topic' | 'group' | 'p2p'>;
  /** Existing StoredLarkConfig listeners are always explicitly legacy_unmanaged. */
  executionPolicy?: {
    integrationMode: 'legacy_unmanaged';
    authorize(boundary: 'listener' | 'session' | 'high_risk', action: PolicyAction): Promise<PolicyDecision>;
  };
}

export class LarkLongConnectionListener implements LarkListener {
  private client?: lark.WSClient;
  private coordinator?: LarkMessageCoordinator;
  private credentials?: string;
  private config?: StoredLarkConfig;
  listening = false;

  constructor(private readonly log: ListenerLog, private readonly options: LarkLongConnectionListenerOptions = {}) {}

  async start(config: StoredLarkConfig) {
    // api-gate 是模块级单例（per-appId 限流状态必须跨会话共享），没有构造注入点。
    // 在监听装配处接上真实日志，让限流等待、退避重试和熔断跳闸可观测。
    setLarkGateLog(this.log);
    const credentials = `${config.appId}\u0000${config.appSecret}`;
    if (this.listening && this.credentials === credentials) {
      this.config = config;
      try { await this.coordinator?.startReconciliation(config); }
      catch (error) { this.log.warn({ error, appId: config.appId }, '飞书卡片终态对账刷新失败，继续保持消息监听'); }
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
      { store: this.options.workflowStore, broker: this.options.relayBroker, automation: this.options.automation },
    ) : undefined;
    await coordinator?.initializeWorkflows(config);
    try { await coordinator?.startReconciliation(config); }
    catch (error) { this.log.warn({ error, appId: config.appId }, '飞书卡片终态对账启动失败，继续建立消息监听'); }
    const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.warn }).register({
      'im.message.receive_v1': event => {
        const message = event.message;
        this.log.info({ messageId: message.message_id, chatId: message.chat_id, chatType: message.chat_type }, '收到飞书消息事件');
        coordinator?.handle({
          messageId: message.message_id,
          chatId: message.chat_id,
          chatType: message.chat_type,
          ...(message.root_id ? { rootId: message.root_id } : {}),
          ...(message.parent_id ? { parentId: message.parent_id } : {}),
          ...(message.thread_id ? { threadId: message.thread_id } : {}),
          messageType: message.message_type,
          content: message.content,
          ...(event.sender?.sender_id?.open_id ? { senderOpenId: event.sender.sender_id.open_id } : {}),
          ...(event.sender?.sender_type ? { senderType: event.sender.sender_type } : {}),
          mentions: (message.mentions ?? []).map(mention => ({ key: mention.key, name: mention.name, ...(mention.id.open_id ? { openId: mention.id.open_id } : {}), ...(mention.mentioned_type ? { mentionedType: mention.mentioned_type } : {}) }))
        }, this.config ?? config).catch(error => {
          this.log.error({ error, messageId: message.message_id, chatId: message.chat_id }, '处理飞书消息事件失败');
        });
      },
      'card.action.trigger': async (event: any) => {
        const operatorOpenId = event.operator?.open_id;
        const result = await coordinator?.handleAction(event.action?.value, operatorOpenId, { messageId: event.context?.open_message_id ?? event.open_message_id, chatId: event.context?.open_chat_id ?? event.open_chat_id });
        if (!result) return;
        return { toast: result };
      },
      // 入站 reaction 显式登记为 no-op：机器人自己加/撤 `OK` 回执会回流成事件，
      // 用户手动贴表情也会。两者都不得驱动任务，也不应落到未知事件分支产生日志噪音。
      // reaction 在本产品里只是「请求已接入」的单向回执，不是可交互的控制面。
      'im.message.reaction.created_v1': () => undefined,
      'im.message.reaction.deleted_v1': () => undefined
    });
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
      onReady: () => this.log.info({ appId: config.appId }, '飞书消息监听已连接'),
      onReconnecting: () => this.log.warn({ appId: config.appId }, '飞书消息监听正在重连'),
      onReconnected: () => this.log.info({ appId: config.appId }, '飞书消息监听已恢复'),
      onError: error => this.log.error({ error, appId: config.appId }, '飞书消息监听异常')
    });
    try {
      await client.start({ eventDispatcher: dispatcher });
      this.client = client;
      this.coordinator = coordinator;
      this.credentials = credentials;
      this.config = config;
      this.listening = true;
    } catch (error) {
      client.close();
      coordinator?.stop();
      throw new LarkServiceError('LARK_LISTENER_START_FAILED', `Failed to start Lark listener: ${error instanceof Error ? error.message : String(error)}`, 502);
    }
  }

  stop() {
    this.client?.close();
    this.coordinator?.stop();
    this.client = undefined;
    this.coordinator = undefined;
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

  constructor(private readonly log: ListenerLog, private readonly options: LarkLongConnectionListenerOptions = {}) {}

  get listening() { return this.listeners.size > 0; }
  get activeAppIds() { return [...this.listeners.keys()]; }

  async sync(configs: StoredLarkConfig[]) {
    const enabled = new Map(configs.filter(config => config.listening && config.fullTrustConfirmed === true).map(config => [config.appId, config]));
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
