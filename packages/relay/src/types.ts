/**
 * 会话回传通道（relay）对外契约。
 *
 * 本包**与具体 IM 无关**：不 import 飞书、不 import storage、不 import fastify。
 * 所有外部依赖以「端口」（port）形式注入，由 apps/server 在装配处适配：
 *
 *  - RelaySessionLookup   —— 会话存活性查询（适配 repos.sessions）
 *  - RelayEventPublisher  —— 把回传消息投递进会话事件流（适配 runtime 的事件流）
 *  - RelaySecretStore     —— 签名密钥持久化（结构上兼容 storage 的 ConfigRepository）
 *
 * 这样 relay 可以被 Web 会话、飞书会话、以及将来任何来源的会话共用，
 * 而不像 lark/agent-tools.ts 那样把「必须有飞书绑定」焊死在入口。
 */

/** 回传消息类别：主动推送 / 提问 / 用户回答 */
export type RelayMessageKind = 'send' | 'ask' | 'answer';

/** 会话快照：relay 只关心「这个会话还能不能收消息」，不关心其它字段 */
export interface RelaySessionSnapshot {
  id: string;
  state: string;
  archivedAt?: string;
}

/** 会话查询端口 */
export interface RelaySessionLookup {
  get(sessionId: string): Promise<RelaySessionSnapshot | undefined>;
}

/** 投递进事件流的载荷 */
export interface RelayPublishInput {
  kind: RelayMessageKind;
  text: string;
  askId?: string;
}

/** 事件流投递端口 */
export interface RelayEventPublisher {
  publish(sessionId: string, input: RelayPublishInput): Promise<void>;
}

/** 签名密钥存储端口（storage 的 ConfigRepository 结构上兼容） */
export interface RelaySecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

/** 会话能力凭证 */
export interface RelayCapability {
  sessionId: string;
  token: string;
}

/** 提问的终态 */
export type RelayAskStatus = 'pending' | 'answering' | 'answered' | 'cancelled' | 'expired';

/** 提问记录（对外只读投影） */
export interface RelayAskRecord {
  id: string;
  sessionId: string;
  question: string;
  status: RelayAskStatus;
  createdAt: string;
  expiresAt: string;
  answer?: string;
  reason?: string;
}

export interface RelayAskStore {
  get(id: string): Promise<RelayAskRecord | undefined>;
  list(): Promise<RelayAskRecord[]>;
  compareAndSet(expected: RelayAskRecord | undefined, record: RelayAskRecord): Promise<boolean>;
}

/**
 * relay 错误。形态对齐 lark/agent-tools.ts 的 AgentGroupToolError：
 * 路由层直接 `reply.code(error.statusCode).send(error.response())`。
 */
export class RelayError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
    this.name = 'RelayError';
  }

  response() {
    return { error: { code: this.code, message: this.message } };
  }
}
