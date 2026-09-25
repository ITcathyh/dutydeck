import { sendExplicitFinal, withExplicitFinalLock, type ExplicitFinalContext, type ExplicitFinalScope } from './explicit-final.js';
import { collaborationAgentPrompt } from '../collaboration-cli.js';
import { layeredWorkbenchPrompt, workbenchAgentPrompt } from '../work-item-tools.js';
import type { LarkGroupManager } from './group-management.js';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { deliverArtifact, type ArtifactClient } from './artifact-delivery.js';
import { workPlanConfirmationRequired, type CollaborationObservation, type CollaborationScope, type CollaborationTeamContext, type ConfigRepository, type PolicyAction, type PolicyDecision, type Session, type SessionRepository, type TaskRecord, type TaskRepository } from '@dutydeck/shared';
import { readAttemptResult, type AttemptResultRepositories } from '../task-results.js';
import { withLarkContextReadTimeout } from './context-read-timeout.js';
import type { LarkTeamContextReader } from './team-context.js';
import { parseLarkMessageContent } from './message-content.js';
import { larkMemoryToolsPrompt } from './memory.js';
import { readLarkConfig, readLarkConfigs, type StoredLarkConfig } from './config.js';
import {
  createLarkCardService,
  LarkServiceError,
  type LarkBotInfo,
  type LarkCardService,
  type LarkChatMember,
  type LarkChatMessage,
  type LarkChatMessagesInput,
  type LarkMessageResult
} from './service.js';

const groupToolPath = '/api/lark/agent-tools';
export const groupToolsSigningSecretConfigKey = 'lark.group_tools.signing_secret';
const maxMessageLimit = 50;
const maxWaitTimeoutMs = 30_000;
const historyScanLimit = 500;
const teamSearchEntryLimit = 30;
const teamSearchTextLimit = 8_000;

export interface LarkAgentSessionBinding { sessionId: string; appId: string; chatId: string; chatType: 'group' | 'p2p'; threadId?: string; threadRootMessageId?: string }

export function larkAgentSessionBinding(session: Pick<Session, 'id' | 'source' | 'sourceId'>): LarkAgentSessionBinding | undefined {
  if (session.source !== 'lark' || !session.sourceId) return;
  const parts = session.sourceId.split(':');
  if (parts.length < 3) return;
  const appId = parts[0]!;
  const chatId = parts[1]!;
  const chatType = parts[2];
  if (!appId.startsWith('cli_')) return;
  // 飞书 message event 的 chat_id（包括 p2p）是 oc_*；兼容早期把对方 open_id
  // 持久化为 chatId 的 ou_* 记录，避免升级后旧会话突然失去工具能力。
  if (chatType === 'group') {
    if (!chatId.startsWith('oc_')) return;
    // thread 路由可锚到根消息 om_*，不能直接作为原生话题 omt_* 查询。
    const scope = parts[3] === 'thread' ? parts[4] : undefined;
    return { sessionId: session.id, appId, chatId, chatType: 'group',
      ...(scope?.startsWith('om_') ? { threadRootMessageId: scope } : scope ? { threadId: scope } : {}) };
  }
  if (chatType === 'p2p') {
    if (!chatId.startsWith('oc_') && !chatId.startsWith('ou_')) return;
    return { sessionId: session.id, appId, chatId, chatType: 'p2p' };
  }
  return;
}

export class AgentGroupToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AgentGroupToolError';
  }

  response() {
    return { error: { ...this.details, code: this.code, message: this.message } };
  }
}

type Capability = LarkAgentSessionBinding & { token: string };

export class LarkAgentToolCapabilityRegistry {
  private readonly byToken = new Map<string, Capability>();
  private readonly bySession = new Map<string, Capability>();

  constructor(
    private readonly sessions: SessionRepository,
    private readonly apiBaseUrl: string,
    private readonly signingSecret = randomBytes(32).toString('base64url')
  ) {}

  private tokenFor(binding: LarkAgentSessionBinding) {
    const digest = createHmac('sha256', this.signingSecret)
      .update(`dutydeck-group-tools-v1\0${binding.sessionId}\0${binding.appId}\0${binding.chatId}`)
      .digest('base64url');
    return `v1.${digest}`;
  }

  finalTurnToken(sessionId: string, taskId: string, attemptId: string) {
    return createHmac('sha256', this.signingSecret).update(`dutydeck-final-turn-v1\0${sessionId}\0${taskId}\0${attemptId}`).digest('base64url');
  }

  assertFinalTurn(sessionId: string, taskId: string, attemptId: string, presented?: string) {
    const expected = Buffer.from(this.finalTurnToken(sessionId, taskId, attemptId));
    const actual = Buffer.from(typeof presented === 'string' ? presented : '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new AgentGroupToolError('FINAL_TURN_EXPIRED', '最终答复凭证不属于当前任务轮次，请使用本轮提供的命令。', 403);
  }

  workbenchTurnToken(sessionId: string, taskId: string) {
    return createHmac('sha256', this.signingSecret).update(`dutydeck-work-turn-v1\0${sessionId}\0${taskId}`).digest('base64url');
  }

  assertWorkbenchTurn(sessionId: string, taskId: string, presented?: string) {
    const expected = Buffer.from(this.workbenchTurnToken(sessionId, taskId));
    const actual = Buffer.from(typeof presented === 'string' ? presented : '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new AgentGroupToolError('WORK_ITEM_TURN_EXPIRED', '编排凭证不属于当前指令，请使用本轮提供的 work 命令。', 403);
  }

  environmentFor(session: Session): Record<string, string> {
    const binding = larkAgentSessionBinding(session);
    if (!binding) return {};
    const existing = this.bySession.get(session.id);
    const capability = existing?.appId === binding.appId && existing.chatId === binding.chatId
      ? existing
      : { ...binding, token: this.tokenFor(binding) };
    if (existing && existing !== capability) this.byToken.delete(existing.token);
    this.bySession.set(session.id, capability);
    this.byToken.set(capability.token, capability);
    return {
      dutydeck_group_tools_url: `${this.apiBaseUrl.replace(/\/$/, '')}${groupToolPath}`,
      dutydeck_group_tools_token: capability.token
    };
  }

  async resolve(token: string | undefined): Promise<LarkAgentSessionBinding> {
    const capability = token ? this.byToken.get(token) : undefined;
    if (!capability) throw new AgentGroupToolError('GROUP_TOOL_UNAUTHORIZED', '群协作工具凭证缺失或无效。该工具只能在 Dutydeck 飞书会话内使用。', 401);
    const session = await this.sessions.get(capability.sessionId);
    const binding = session ? larkAgentSessionBinding(session) : undefined;
    if (!session || !binding || binding.appId !== capability.appId || binding.chatId !== capability.chatId || session.archivedAt || ['failed', 'stopped'].includes(session.state)) {
      throw new AgentGroupToolError('GROUP_TOOL_SESSION_EXPIRED', '当前 Dutydeck 飞书会话已结束，群协作工具凭证不再有效。', 401);
    }
    return binding;
  }

  async resolveSession(token: string | undefined): Promise<{ binding: LarkAgentSessionBinding; session: Session }> {
    const binding = await this.resolve(token);
    const session = await this.sessions.get(binding.sessionId);
    if (!session) throw new AgentGroupToolError('GROUP_TOOL_SESSION_EXPIRED', '当前 Dutydeck 飞书会话已结束，群协作工具凭证不再有效。', 401);
    return { binding, session };
  }

  close() {
    this.byToken.clear();
    this.bySession.clear();
  }
}

export async function loadOrCreateGroupToolsSigningSecret(configs: ConfigRepository) {
  const existing = (await configs.get(groupToolsSigningSecretConfigKey))?.trim();
  if (existing) return existing;
  const created = randomBytes(32).toString('base64url');
  await configs.set(groupToolsSigningSecretConfigKey, created);
  return created;
}

export interface LarkGroupToolClient {
  getBotInfo(): Promise<LarkBotInfo>;
  listChatMembers(input: { chatId: string; memberTypes?: Array<'user' | 'bot'>; pageSize?: number; pageToken?: string }): Promise<{ items: LarkChatMember[]; hasMore: boolean; pageToken?: string; securityLimited: boolean }>;
  listChatMessages(input: LarkChatMessagesInput): Promise<{ items: LarkChatMessage[]; hasMore: boolean; pageToken?: string }>;
  getMessage(messageId: string): Promise<LarkChatMessage>;
  getMessageItems(messageId: string): Promise<LarkChatMessage[]>;
  sendText(input: { chatId: string; text: string; idempotencyKey?: string }): Promise<LarkMessageResult>;
  replyText(input: { messageId: string; text: string; replyInThread?: boolean; idempotencyKey?: string }): Promise<LarkMessageResult>;
  uploadFile?: ArtifactClient['uploadFile']; uploadImage?: ArtifactClient['uploadImage'];
  sendFile?: (input: { chatId: string; fileKey: string; idempotencyKey: string }) => Promise<LarkMessageResult>;
  sendImage?: (input: { chatId: string; imageKey: string; idempotencyKey: string }) => Promise<LarkMessageResult>;
  replyFile?: (input: { messageId: string; replyInThread?: boolean; fileKey: string; idempotencyKey: string }) => Promise<LarkMessageResult>;
  replyImage?: (input: { messageId: string; replyInThread?: boolean; imageKey: string; idempotencyKey: string }) => Promise<LarkMessageResult>;
  send?: LarkCardService['send']; reply?: LarkCardService['reply']; update?: LarkCardService['update'];
  readDocument?(url: string): Promise<{ url: string; title?: string; text: string }>;
}

export interface LarkAgentToolsOptions {
  authorizeTool?: (sessionId: string, action: 'group_tools.read' | 'group_tools.discover' | 'group_tools.send' | 'memory') => Promise<{ actorId: string } | void>;
  workbenchTask?: (sessionId: string) => { taskId: string; attemptId?: string } | undefined;
  finalTaskContext?: (binding: LarkAgentSessionBinding, task: { taskId: string; attemptId: string }) => Promise<ExplicitFinalContext | undefined>;
  groupManager?: LarkGroupManager;
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof globalThis.fetch;
  clientFactory?: (config: StoredLarkConfig) => LarkGroupToolClient;
  pollIntervalMs?: number;
  groupToolsCommand?: string;
  /** history list/show：只读会话、任务与执行账本。 */
  history?: AttemptResultRepositories & { sessions: Pick<SessionRepository, 'list'>; tasks: Pick<TaskRepository, 'listBySession'> };
  /** group team-search；群协作集成尚未就绪时返回 undefined。 */
  teamSearch?: () => { reader: Pick<LarkTeamContextReader, 'read' | 'authorize' | 'scorer'>; available(scope: CollaborationScope): Promise<boolean> } | undefined;
  /** Stored Lark sessions are explicitly legacy_unmanaged during WP1b. */
  executionPolicy?: {
    integrationMode: 'legacy_unmanaged';
    authorize(boundary: 'group_tools', action: PolicyAction): Promise<PolicyDecision>;
  };
}

type ToolContext = LarkAgentSessionBinding & { config: StoredLarkConfig; client: LarkGroupToolClient };
export interface AgentGroupPeer { appId: string; name: string; agentId?: string; memberId: string; openId?: string }
export interface AgentGroupMember { name: string; memberId: string; openId?: string }
export interface AgentGroupMessage {
  messageId: string;
  messageType: string;
  createTime: string;
  sender: LarkChatMessage['sender'];
  content: string;
  mentions: LarkChatMessage['mentions'];
  deleted: boolean;
  updated: boolean;
  threadId?: string;
}
export interface AgentGroupMessagesResult {
  chatId: string;
  messages: AgentGroupMessage[];
  cursor?: string;
  timedOut?: boolean;
  scanned?: number;
  truncated?: boolean;
}

class GroupMessageCursor {
  private constructor(readonly createTime: number, readonly messageId: string) {}

  static parse(value?: string) {
    if (!value) return undefined;
    try {
      const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { v?: number; t?: number; id?: string };
      if (decoded.v !== 1 || !Number.isFinite(decoded.t) || decoded.t! < 0 || typeof decoded.id !== 'string') throw new Error('invalid cursor');
      return new GroupMessageCursor(decoded.t!, decoded.id);
    } catch {
      throw new AgentGroupToolError('INVALID_GROUP_CURSOR', 'after 必须使用 messages 或 wait 返回的 cursor。', 400);
    }
  }

  static fromMessage(message: LarkChatMessage) {
    return new GroupMessageCursor(Number(message.createTime) || 0, message.messageId);
  }

  static at(createTime: number) {
    return new GroupMessageCursor(createTime, '');
  }

  includes(message: LarkChatMessage) {
    const time = Number(message.createTime) || 0;
    return time > this.createTime || (time === this.createTime && message.messageId > this.messageId);
  }

  encode() {
    return Buffer.from(JSON.stringify({ v: 1, t: this.createTime, id: this.messageId })).toString('base64url');
  }
}

const operationScopes = {
  peers: ['im:chat.members:read'],
  members: ['im:chat.members:read'],
  messages: ['im:message:readonly', 'im:chat:read'],
  message: ['im:message:readonly'],
  send: ['im:message'],
  reply: ['im:message', 'im:message:readonly']
} as const;

function isPermissionError(error: unknown) {
  if (!(error instanceof LarkServiceError)) return false;
  const upstreamCode = Number(error.details?.upstreamCode);
  return Boolean(error.statusCode === 403 || error.details?.consoleUrl || error.details?.permissionViolations
    || [99991661, 99991663, 99991668, 99991672, 99991679].includes(upstreamCode)
    || /permission|forbidden|access denied|权限|无权/i.test(error.message));
}

function authorizationError(context: ToolContext, operation: keyof typeof operationScopes, error: LarkServiceError) {
  const requiredScopes = [...operationScopes[operation]];
  const authorizationUrl = typeof error.details?.consoleUrl === 'string'
    ? error.details.consoleUrl
    : `https://open.larkoffice.com/app/${encodeURIComponent(context.appId)}/auth`;
  const instruction = `当前机器人「${context.config.name ?? context.appId}」缺少飞书 bot 权限：${requiredScopes.join('、')}。请让管理员在飞书开放平台开通权限并发布应用版本，然后重试。bot 身份不能通过 lark-cli auth login 补权；不要向用户索要 App Secret 或访问令牌。授权地址：${authorizationUrl}`;
  return new AgentGroupToolError('GROUP_TOOL_AUTHORIZATION_REQUIRED', instruction, 403, {
    requiredScopes,
    authorizationUrl,
    instruction,
    upstream: error.message
  });
}

function groupLarkError(operation: string, error: LarkServiceError) {
  return new AgentGroupToolError('GROUP_TOOL_LARK_ERROR', error.message, error.statusCode, {
    operation,
    ...(error.details?.upstreamCode !== undefined ? { upstreamCode: error.details.upstreamCode } : {})
  });
}

async function renderMessageContent(message: LarkChatMessage): Promise<string> {
  try {
    // 合并转发（merge_forward）消息不自动展开，只返回带 message_id 的占位提示；
    // Agent 如需查看转发内容，可调用 group message <message_id> 工具拉取。
    const parsed = await parseLarkMessageContent(message.messageType, message.rawContent, {
      messageId: message.messageId
    });
    return parsed.text;
  } catch { return message.rawContent; }
}

const normalizeLimit = (value?: number) => {
  const resolved = value ?? 20;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maxMessageLimit) throw new AgentGroupToolError('INVALID_GROUP_MESSAGE_LIMIT', `limit 必须是 1-${maxMessageLimit} 的整数。`, 400);
  return resolved;
};

function parseTimestampMs(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid timestamp');
    return value <= 1e11 ? Math.floor(value * 1000) : Math.floor(value);
  }
  if (typeof value !== 'string') throw new Error('Invalid timestamp type');
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Empty timestamp');
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (!Number.isFinite(num) || num < 0) throw new Error('Invalid timestamp');
    return num <= 1e11 ? Math.floor(num * 1000) : Math.floor(num);
  }
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) throw new Error('Invalid date format');
  return ms;
}

/** 截断到 limit 个字符以内（含省略号），不切断代理对。 */
const clip = (text: string, limit: number) => {
  if (text.length <= limit) return text;
  const end = /[\uD800-\uDBFF]/.test(text[limit - 2]!) ? limit - 2 : limit - 1;
  return `${text.slice(0, end)}…`;
};
const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
const clockFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const clock = (iso: string) => {
  const parts = Object.fromEntries(clockFormat.formatToParts(new Date(iso)).map(part => [part.type, part.value]));
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};

/** 同一机器人、同一聊天的飞书任务会话；群参与的后台委托会话除外（记忆、判定、leader 会话的 source 不是 lark）。 */
function inChat(session: Pick<Session, 'source' | 'sourceId'>, binding: LarkAgentSessionBinding) {
  if (session.source !== 'lark' || !session.sourceId) return false;
  const [appId, chatId, chatType, kind] = session.sourceId.split(':');
  return appId === binding.appId && chatId === binding.chatId && chatType === binding.chatType && kind !== 'collaboration';
}

/** 取法同记忆提取管线：number=1 Attempt 正常完成时的助手文本；未完成或读不到时没有回答。 */
function taskAnswer(repos: AttemptResultRepositories, task: TaskRecord): string | undefined {
  try {
    const attemptId = repos.execution.getTaskExecution(task.id)?.attempts.find(item => item.number === 1)?.attemptId;
    if (!attemptId) return undefined;
    const read = readAttemptResult(repos, task.sessionId, task.id, attemptId);
    return read.status === 'settled' && read.result.outcome === 'completed' ? read.result.output.text.trim() || undefined : undefined;
  } catch { return undefined; }
}

function teamSearchLine(item: CollaborationObservation) {
  if (item.source === 'lark.team.followup') {
    try {
      const followup = JSON.parse(item.text) as { goal?: string; status?: string; progress?: string; result?: string };
      return { sender: '事项', body: flat([`[${followup.status}] ${followup.goal}`, followup.progress && `进展：${followup.progress}`, followup.result && `结果：${followup.result}`].filter(Boolean).join('；')) };
    } catch { /* 按原文展示 */ }
  }
  return { sender: `${item.senderId ?? '未知'}(${item.senderKind})`, body: flat(item.text) };
}

const escapeAtName = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// 无显式幂等键时，按「会话 + 群 + 发送目标（--to 对象 / --reply-to 回复目标）+ 归一化内容」派生
// 确定性 UUIDv5 形态的去重键，让无 key 的失败重试也命中飞书平台 uuid 去重。
// 作用域是同一会话内的重试：chat_id 只按应用隔离、不按会话隔离，因此必须纳入 sessionId，
// 避免同群两个不同会话输出相同内容（如两条「已完成」）被平台折叠。
// 任一维度不同摘要即不同，绝不会把不同消息合并。空白归一化与发送路由保持一致，防止空格绕过合并。
const deterministicSendUuid = (input: { sessionId: string; chatId: string; content: string; to: string; replyTo: string; inThread: boolean }) => {
  const fingerprint = JSON.stringify({
    session: input.sessionId,
    chat: input.chatId,
    ...(input.to ? { to: input.to } : {}),
    ...(input.replyTo ? { replyTo: input.replyTo, ...(input.inThread ? { thread: true } : {}) } : {}),
    content: input.content
  });
  const hex = createHash('sha256').update(fingerprint).digest('hex');
  // 组装为合法 UUID：第三段首位置版本号 5，第四段首两位置 RFC 4122 variant 10。
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export const stripLeadingMentions = (text: string): string => {
  let result = text.trim();
  let changed = true;
  while (changed) {
    changed = false;
    const atTagMatch = result.match(/^<at[^>]*>.*?<\/at>\s*/i);
    if (atTagMatch) {
      result = result.slice(atTagMatch[0].length).trim();
      changed = true;
      continue;
    }
    const atTextMatch = result.match(/^@[^\s]+\s*/);
    if (atTextMatch) {
      result = result.slice(atTextMatch[0].length).trim();
      changed = true;
      continue;
    }
  }
  return result;
};

export const deterministicAgentActionKey = (input: {
  sessionId: string;
  taskId: string;
  attemptId: string;
  action: 'handoff' | 'reply-agent';
  targetId: string;
  content: string;
}): string => {
  const fingerprint = JSON.stringify({
    session: input.sessionId,
    task: input.taskId,
    attempt: input.attemptId,
    action: input.action,
    target: input.targetId,
    content: input.content.trim()
  });
  const hash = createHash('sha256').update(fingerprint).digest('hex');
  const prefix = input.action === 'handoff' ? 'ah_' : 'ar_';
  return `${prefix}${hash.slice(0, 42)}`;
};

export class LarkAgentToolsService {
  private readonly clients = new Map<string, { secret: string; client: LarkGroupToolClient }>();
  private readonly identities = new Map<string, { secret: string; info: Promise<LarkBotInfo> }>();
  private readonly pollIntervalMs: number;

  constructor(
    private readonly capabilities: LarkAgentToolCapabilityRegistry,
    private readonly configs: ConfigRepository,
    private readonly options: LarkAgentToolsOptions = {}
  ) {
    this.pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 1_000);
  }

  private clientFor(config: StoredLarkConfig) {
    const cached = this.clients.get(config.appId);
    if (cached?.secret === config.appSecret) return cached.client;
    const client = this.options.clientFactory?.(config) ?? createLarkCardService(this.options.env ?? process.env, this.options.fetcher ?? globalThis.fetch, { appId: config.appId, appSecret: config.appSecret }) as LarkCardService;
    this.clients.set(config.appId, { secret: config.appSecret, client });
    this.identities.delete(config.appId);
    return client;
  }

  private identityFor(config: StoredLarkConfig) {
    const cached = this.identities.get(config.appId);
    if (cached?.secret === config.appSecret) return cached.info;
    const info = this.clientFor(config).getBotInfo();
    this.identities.set(config.appId, { secret: config.appSecret, info });
    void info.catch(() => { if (this.identities.get(config.appId)?.info === info) this.identities.delete(config.appId); });
    return info;
  }

  private async context(token: string | undefined, action: 'group_tools.read' | 'group_tools.discover' | 'group_tools.send'): Promise<ToolContext> {
    const binding = await this.capabilities.resolve(token);
    const toolAuthority = await this.options.authorizeTool?.(binding.sessionId, action);
    if (this.options.executionPolicy) {
      const decision = await this.options.executionPolicy.authorize('group_tools', action);
      if (!decision.allowed) throw new AgentGroupToolError(decision.code, decision.reason, 403, {
        boundary: 'group_tools',
        integrationMode: this.options.executionPolicy.integrationMode,
      });
    }
    let config = await readLarkConfig(this.configs, binding.appId);
    if (!config) throw new AgentGroupToolError('GROUP_TOOL_BOT_NOT_FOUND', `当前会话关联的飞书机器人 ${binding.appId} 已被删除。`, 404);
    if (this.options.groupManager) {
      const decision = toolAuthority
        ? await this.options.groupManager.authorize(binding.appId, binding.chatId, toolAuthority.actorId === 'installation_owner' ? undefined : toolAuthority.actorId, action, undefined, { installationOwner: toolAuthority.actorId === 'installation_owner' })
        : await this.options.groupManager.authorizeSession(binding.sessionId, action) ?? await this.options.groupManager.authorize(binding.appId, binding.chatId, undefined, action, binding.sessionId);
      if (decision && !decision.allowed) throw new AgentGroupToolError(decision.code, decision.reason, 403);
      config = await this.options.groupManager.resolved(config, binding.chatId);
    }
    if (!config.groupToolsEnabled) throw new AgentGroupToolError('GROUP_TOOLS_DISABLED', '当前飞书机器人的 Agent 群协作工具已被管理员关闭。', 403);
    return { ...binding, config, client: this.clientFor(config) };
  }

  private async authorized<T>(context: ToolContext, operation: keyof typeof operationScopes, action: () => Promise<T>) {
    try { return await action(); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'FINAL_CONTENT_CONFLICT') throw new AgentGroupToolError('FINAL_CONTENT_CONFLICT', error.message, 409);
      if (isPermissionError(error)) throw authorizationError(context, operation, error as LarkServiceError);
      if (error instanceof LarkServiceError) throw groupLarkError(operation, error);
      throw error;
    }
  }

  assertWorkbenchTurn(sessionId: string, taskId: string, presented?: string) { this.capabilities.assertWorkbenchTurn(sessionId, taskId, presented); }

  async workbenchContext(token?: string) {
    const context = await this.context(token, 'group_tools.read');
    return { sessionId: context.sessionId };
  }

  /**
   * 会话记忆工具的上下文：只要求 capability 仍指向一条存活的飞书会话、机器人仍存在。
   * 不经过群协作开关与 group_tools 策略——记忆读写的对象是本聊天自己的记忆，不是群消息。
   */
  async memoryContext(token?: string): Promise<LarkAgentSessionBinding> {
    const binding = await this.capabilities.resolve(token);
    await this.options.authorizeTool?.(binding.sessionId, 'memory');
    const config = await readLarkConfig(this.configs, binding.appId);
    if (!config) {
      throw new AgentGroupToolError('GROUP_TOOL_BOT_NOT_FOUND', `当前会话关联的飞书机器人 ${binding.appId} 已被删除。`, 404);
    }
    if (config.memoryEnabled === false) {
      throw new AgentGroupToolError('MEMORY_DISABLED', '当前飞书机器人已关闭会话记忆。', 403);
    }
    return binding;
  }

  async self(token?: string) {
    const context = await this.context(token, 'group_tools.read');
    let bot: LarkBotInfo;
    try { bot = await context.client.getBotInfo(); }
    catch (error) {
      if (error instanceof LarkServiceError) throw groupLarkError('self', error);
      throw error;
    }
    return {
      sessionId: context.sessionId,
      chatId: context.chatId,
      bot: { appId: context.appId, name: context.config.name ?? bot.appName, openId: bot.openId, agentId: context.config.defaultAgentId },
      policy: { canRead: true, canDiscoverPeers: true, canSend: context.config.groupToolsAllowSend }
    };
  }

  private async allChatMembers(context: ToolContext, memberTypes: Array<'user' | 'bot'>, operation: 'peers' | 'members') {
    const members: LarkChatMember[] = [];
    let pageToken: string | undefined;
    let securityLimited = false;
    for (let page = 0; page < 10; page++) {
      const result = await this.authorized(context, operation, () => context.client.listChatMembers({ chatId: context.chatId, memberTypes, pageSize: 100, ...(pageToken ? { pageToken } : {}) }));
      members.push(...result.items);
      securityLimited ||= result.securityLimited;
      if (!result.hasMore || !result.pageToken) return { members, securityLimited };
      pageToken = result.pageToken;
    }
    return { members, securityLimited: true };
  }

  private async peersFor(context: ToolContext) {
    const { members, securityLimited } = await this.allChatMembers(context, ['bot'], 'peers');
    const configs = (await readLarkConfigs(this.configs)).filter(config => config.appId !== context.appId && config.defaultAgentId && config.groupToolsEnabled);
    const configByAppId = new Map(configs.map(config => [config.appId, config]));
    // 本实例管理但未直接按 appId 匹配到的 bot，需要通过身份解析按 openId 匹配。
    const resolved = await Promise.all(configs.map(async config => {
      const directMember = members.find(member => member.appId === config.appId);
      if (directMember) return { config, member: directMember };
      try { return { config, info: await this.identityFor(config) }; }
      catch { return undefined; }
    }));
    const memberByOpenId = new Map(members.flatMap(member => {
      const openId = member.openId ?? (member.memberId.startsWith('ou_') ? member.memberId : undefined);
      return openId ? [[openId, member] as const] : [];
    }));
    // 收集本实例管理的 peer（有 agentId），按 memberId 索引。
    const managedByMemberId = new Map<string, AgentGroupPeer>();
    for (const item of resolved) {
      if (!item) continue;
      const member = item.member ?? memberByOpenId.get(item.info!.openId);
      if (!member) continue;
      managedByMemberId.set(member.memberId, {
        appId: item.config.appId,
        name: item.config.name ?? item.info?.appName ?? member.name,
        agentId: item.config.defaultAgentId,
        memberId: member.memberId,
        openId: member.openId ?? item.info?.openId
      });
    }
    // 返回群内所有机器人：本实例管理的带 agentId，其余不带 agentId。
    const peers = members
      .filter(member => member.appId !== context.appId)
      .map(member => managedByMemberId.get(member.memberId) ?? {
        appId: member.appId ?? member.memberId,
        name: member.name,
        memberId: member.memberId,
        ...(member.openId ? { openId: member.openId } : {})
      });
    return { chatId: context.chatId, peers, securityLimited };
  }

  async peers(token?: string) {
    return this.peersFor(await this.context(token, 'group_tools.discover'));
  }

  async bots(token?: string) {
    return this.peersFor(await this.context(token, 'group_tools.discover'));
  }

  private async membersFor(context: ToolContext) {
    const { members, securityLimited } = await this.allChatMembers(context, ['user'], 'members');
    return {
      chatId: context.chatId,
      members: members.map((member): AgentGroupMember => ({
        name: member.name,
        memberId: member.memberId,
        ...(member.openId ? { openId: member.openId } : {})
      })),
      securityLimited
    };
  }

  async members(token?: string) {
    return this.membersFor(await this.context(token, 'group_tools.discover'));
  }

  async promptForSession(session: Session, prompt: string) {
    const binding = larkAgentSessionBinding(session);
    if (!binding) return prompt;
    const config = await readLarkConfig(this.configs, binding.appId);
    if (!config) return prompt;
    const blocks: string[] = [];
    if (config.memoryEnabled !== false) {
      blocks.push(larkMemoryToolsPrompt(this.options.groupToolsCommand));
    }
    if (config.groupToolsEnabled) {
      blocks.push(larkGroupToolsPrompt(config.groupToolsAllowSend, this.options.groupToolsCommand));
      const task = this.options.workbenchTask?.(session.id);
      if (task?.attemptId && config.groupToolsAllowSend && this.options.finalTaskContext) {
        const finalTurn = this.capabilities.finalTurnToken(session.id, task.taskId, task.attemptId);
        blocks.push(`主动交付本轮最终答复：${this.options.groupToolsCommand ?? 'dutydeck'} group send '<完整答复>' --final --turn ${finalTurn}。发送目标由本轮任务绑定；不要指定 --to 或自定义幂等键。普通进展和交接不要加 --final。映射尚未就绪时稍后重试。`);
        if (binding.chatType === 'group') {
          const cmd = this.options.groupToolsCommand ?? 'dutydeck';
          blocks.push(`单次 Agent 任务交接与回传（仅限群聊，绑定当前任务轮次与原话题）：
- 向同群其他机器人交接任务：${cmd} group handoff <目标bot名称/appId/openId> '<交接内容>' --turn ${finalTurn}
  交接时请在内容中附带明确目标、代码版本、实际工作区、只读/可写边界和验收标准；系统会自动 @目标 机器人并添加 [Agent 交接] 标记。
- 收到交接后向发起方回传结果：${cmd} group reply-agent '<交付结果>' --turn ${finalTurn}
  回传会自动回复发起方机器人并在原话题内回传一次，添加 [Agent 结果] 标记。
规则：只给任务/实质结果 @机器人；收到或谢谢等礼貌确认切勿 @机器人，避免唤醒死循环。多轮审查返修请走 work 命令，不放大普通机器人门禁。`);
        }
      }
      if (task) {
        const turn = this.capabilities.workbenchTurnToken(session.id, task.taskId);
        const collaborationSession = session.sourceId?.split(':')[3] === 'collaboration';
        // 分层协作只在群聊生效：单聊里目标无法固定交付位置（work create 同样被拒），保持单 Agent 提示。
        const workbench = config.executionMode === 'layered' && binding.chatType === 'group' && !collaborationSession ? layeredWorkbenchPrompt : workbenchAgentPrompt;
        blocks.push(workbench(`${this.options.groupToolsCommand ?? 'dutydeck'} work --turn ${turn}`, workPlanConfirmationRequired(session)));
        if (binding.chatType === 'group' && !collaborationSession) blocks.push(collaborationAgentPrompt(`${this.options.groupToolsCommand ?? 'dutydeck'} collaborate --turn ${turn}`));
      }
    }
    return blocks.length ? `${blocks.join('\n\n')}\n\n${prompt}` : prompt;
  }

  async isConfiguredPeer(appId: string, chatId: string, senderOpenId: string) {
    const config = await readLarkConfig(this.configs, appId);
    if (!config?.groupToolsEnabled || !chatId.startsWith('oc_') || !senderOpenId.startsWith('ou_')) return false;
    const context: ToolContext = { sessionId: '', appId, chatId, chatType: 'group', config, client: this.clientFor(config) };
    const { peers } = await this.peersFor(context);
    // 只有本实例管理的 peer（带 agentId）才是可信任的协作 Agent。
    return peers.some(peer => peer.agentId && (peer.openId === senderOpenId || peer.memberId === senderOpenId));
  }

  private async normalizeMessages(items: LarkChatMessage[]): Promise<AgentGroupMessage[]> {
    const messages: AgentGroupMessage[] = [];
    for (const message of items) {
      messages.push({
        messageId: message.messageId,
        messageType: message.messageType,
        createTime: message.createTime,
        sender: message.sender,
        content: await renderMessageContent(message),
        mentions: message.mentions,
        deleted: message.deleted,
        updated: message.updated,
        ...(message.threadId ? { threadId: message.threadId } : {})
      });
    }
    return messages;
  }

  private async messagesFor(
    context: ToolContext,
    input: { after?: string; limit?: number; since?: string; until?: string; query?: string }
  ): Promise<AgentGroupMessagesResult> {
    const limit = normalizeLimit(input.limit);
    if (input.after && (input.since !== undefined || input.until !== undefined || input.query !== undefined)) {
      throw new AgentGroupToolError('GROUP_MESSAGES_INVALID_RANGE', '--after 不能与 --since/--until/--query 同时使用。', 400);
    }

    let startTime: number | undefined;
    let endTime: number | undefined;
    let sinceMs: number | undefined;
    let untilMs: number | undefined;

    if (input.since !== undefined) {
      try {
        sinceMs = parseTimestampMs(input.since);
        startTime = Math.max(0, Math.floor(sinceMs / 1000));
      } catch {
        throw new AgentGroupToolError('GROUP_MESSAGES_INVALID_RANGE', 'since 时间格式无法解析。', 400);
      }
    }

    if (input.until !== undefined) {
      try {
        untilMs = parseTimestampMs(input.until);
        endTime = Math.max(0, Math.floor(untilMs / 1000));
      } catch {
        throw new AgentGroupToolError('GROUP_MESSAGES_INVALID_RANGE', 'until 时间格式无法解析。', 400);
      }
    }

    if (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs) {
      throw new AgentGroupToolError('GROUP_MESSAGES_INVALID_RANGE', 'since 不能晚于 until。', 400);
    }

    // 话题内的消息拉取优先按 threadId 限定范围，避免拿到群里其他话题的消息；
    // 非话题群聊（按 user/message 隔离）则按 chatId 拉取整个群。
    const threadId = await this.resolveThreadId(context);
    const container = threadId ? { threadId } : { chatId: context.chatId };

    const hasTimeWindow = startTime !== undefined || endTime !== undefined;
    const hasQuery = input.query !== undefined;

    if (!hasTimeWindow && !hasQuery) {
      const after = GroupMessageCursor.parse(input.after);
      if (!after) {
        const requestStartedAt = Date.now();
        const result = await this.authorized(context, 'messages', () => context.client.listChatMessages({ ...container, order: 'desc', pageSize: limit }));
        const items = [...result.items].sort((left, right) => Number(left.createTime) - Number(right.createTime) || left.messageId.localeCompare(right.messageId));
        const latest = items.at(-1);
        return { chatId: context.chatId, messages: await this.normalizeMessages(items), cursor: (latest ? GroupMessageCursor.fromMessage(latest) : GroupMessageCursor.at(requestStartedAt)).encode() };
      }

      const items: LarkChatMessage[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 10 && items.length < limit; page++) {
        const result = await this.authorized(context, 'messages', () => context.client.listChatMessages({
          ...container,
          order: 'asc',
          pageSize: maxMessageLimit,
          startTime: Math.max(0, Math.floor(after.createTime / 1_000) - 1),
          ...(pageToken ? { pageToken } : {})
        }));
        items.push(...result.items.filter(message => after.includes(message)).slice(0, limit - items.length));
        if (!result.hasMore || !result.pageToken) break;
        pageToken = result.pageToken;
      }
      items.sort((left, right) => Number(left.createTime) - Number(right.createTime) || left.messageId.localeCompare(right.messageId));
      const latest = items.at(-1);
      return { chatId: context.chatId, messages: await this.normalizeMessages(items), cursor: latest ? GroupMessageCursor.fromMessage(latest).encode() : input.after };
    }

    const queryTerms = hasQuery
      ? input.query!.trim().toLowerCase().split(/\s+/).filter(Boolean)
      : [];

    const requestStartedAt = Date.now();
    const items: LarkChatMessage[] = [];
    let scannedCount = 0;
    let pageToken: string | undefined;
    let pageCount = 0;
    let lastHasMore = false;

    for (let page = 0; page < 10 && items.length < limit; page++) {
      pageCount++;
      const result = await this.authorized(context, 'messages', () => context.client.listChatMessages({
        ...container,
        order: 'desc',
        pageSize: maxMessageLimit,
        ...(startTime !== undefined ? { startTime } : {}),
        ...(endTime !== undefined ? { endTime } : {}),
        ...(pageToken ? { pageToken } : {})
      }));
      lastHasMore = result.hasMore === true;

      for (const message of result.items) {
        scannedCount++;
        if (hasQuery) {
          const content = await renderMessageContent(message);
          const lowerContent = content.toLowerCase();
          if (!queryTerms.every(term => lowerContent.includes(term))) {
            continue;
          }
        }
        items.push(message);
        if (items.length >= limit) break;
      }

      if (items.length >= limit) break;
      if (!result.hasMore || !result.pageToken) break;
      pageToken = result.pageToken;
    }

    items.sort((left, right) => Number(left.createTime) - Number(right.createTime) || left.messageId.localeCompare(right.messageId));
    const latest = items.at(-1);
    const isTruncated = hasQuery && pageCount === 10 && lastHasMore && items.length < limit;

    return {
      chatId: context.chatId,
      messages: await this.normalizeMessages(items),
      cursor: (latest ? GroupMessageCursor.fromMessage(latest) : GroupMessageCursor.at(requestStartedAt)).encode(),
      ...(hasQuery ? { scanned: scannedCount } : {}),
      ...(isTruncated ? { truncated: true } : {})
    };
  }

  async messages(token: string | undefined, input: { after?: string; limit?: number; since?: string; until?: string; query?: string } = {}) {
    return this.messagesFor(await this.context(token, 'group_tools.read'), input);
  }

  async message(token: string | undefined, input: { messageId: string }) {
    const context = await this.context(token, 'group_tools.read');
    const messageId = input.messageId?.trim();
    if (!messageId) throw new AgentGroupToolError('GROUP_MESSAGE_ID_REQUIRED', 'messageId 不能为空。', 400);
    if (!messageId.startsWith('om_')) {
      throw new AgentGroupToolError('INVALID_GROUP_MESSAGE_ID', 'messageId 只能使用 om_* 消息 ID。', 400);
    }
    const message = await this.authorized(context, 'message', () => context.client.getMessage(messageId));
    await this.assertMessageScope(context, message);
    // 拉取单条消息时，若为合并转发（merge_forward），展开其转发的子消息内容。
    const parsed = await parseLarkMessageContent(message.messageType, message.rawContent, {
      messageId: message.messageId,
      fetchMessageItems: (id) => context.client.getMessageItems(id).then(items => items.map(item => ({
        messageId: item.messageId,
        messageType: item.messageType,
        content: item.rawContent,
        sender: item.sender,
        upperMessageId: item.upperMessageId
      })))
    });
    return {
      messageId: message.messageId,
      messageType: message.messageType,
      createTime: message.createTime,
      sender: message.sender,
      content: parsed.text,
      mentions: message.mentions,
      ...(message.threadId ? { threadId: message.threadId } : {})
    };
  }

  /** 本聊天全部任务，新到旧。 */
  private async chatTasks(context: ToolContext) {
    const repos = this.options.history;
    if (!repos) throw new AgentGroupToolError('HISTORY_UNAVAILABLE', '当前服务未接入会话历史。', 503);
    const tasks: TaskRecord[] = [];
    for (const session of await repos.sessions.list()) {
      if (inChat(session, context)) tasks.push(...await repos.tasks.listBySession(session.id));
    }
    return { repos, tasks: tasks.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)) };
  }

  async history(token: string | undefined, input: { limit?: number; since?: string; until?: string; query?: string } = {}) {
    const context = await this.context(token, 'group_tools.read');
    const limit = normalizeLimit(input.limit);
    const bound = (value: string | undefined, name: string) => {
      if (value === undefined) return undefined;
      try { return parseTimestampMs(value); }
      catch { throw new AgentGroupToolError('HISTORY_INVALID_RANGE', `${name} 时间格式无法解析。`, 400); }
    };
    const since = bound(input.since, 'since'), until = bound(input.until, 'until');
    if (since !== undefined && until !== undefined && since > until) throw new AgentGroupToolError('HISTORY_INVALID_RANGE', 'since 不能晚于 until。', 400);
    const terms = input.query?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    const { repos, tasks } = await this.chatTasks(context);
    // 正在执行本命令的这一轮总会命中自己的关键词，不列出。
    const current = this.options.workbenchTask?.(context.sessionId)?.taskId;
    const items = [];
    let scanned = 0, truncated = false;
    for (const task of tasks) {
      if (items.length >= limit) break;
      const at = Date.parse(task.createdAt);
      if (task.id === current || (since !== undefined && at < since) || (until !== undefined && at > until)) continue;
      if (terms.length && scanned >= historyScanLimit) { truncated = true; break; }
      scanned++;
      const answer = taskAnswer(repos, task);
      if (terms.length) {
        const text = `${task.prompt}\n${answer ?? ''}`.toLowerCase();
        if (!terms.every(term => text.includes(term))) continue;
      }
      items.push({
        taskId: task.id, createdAt: task.createdAt, status: task.status,
        ...(task.executionContext?.actorId ? { actorId: task.executionContext.actorId } : {}),
        request: clip(flat(task.prompt), 200),
        ...(answer ? { answer: clip(flat(answer), 300) } : {})
      });
    }
    return { chatId: context.chatId, tasks: items, ...(terms.length ? { scanned } : {}), ...(truncated ? { truncated: true } : {}) };
  }

  async historyTask(token: string | undefined, input: { taskId?: string }) {
    const context = await this.context(token, 'group_tools.read');
    const taskId = input.taskId?.trim();
    if (!taskId) throw new AgentGroupToolError('HISTORY_TASK_ID_REQUIRED', 'taskId 不能为空。', 400);
    const { repos, tasks } = await this.chatTasks(context);
    const task = tasks.find(item => item.id === taskId);
    // 其他聊天的任务与不存在的任务同样返回 404，不泄露存在性。
    if (!task) throw new AgentGroupToolError('HISTORY_TASK_NOT_FOUND', `本聊天没有编号为 ${taskId} 的任务。`, 404);
    const answer = taskAnswer(repos, task);
    // 回答是整轮助手文本的拼接，结论在末尾：超长时保留末尾。
    const answerClipped = answer !== undefined && answer.length > 8_000;
    return {
      chatId: context.chatId, taskId: task.id, createdAt: task.createdAt, status: task.status,
      ...(task.executionContext?.actorId ? { actorId: task.executionContext.actorId } : {}),
      request: clip(task.prompt, 4_000),
      ...(answer ? { answer: answerClipped ? `…${answer.slice(-(8_000 - 1)).replace(/^[\uDC00-\uDFFF]/, '')}` : answer } : {}),
      ...(answerClipped ? { answerClipped: true } : {})
    };
  }

  async teamSearch(token: string | undefined, input: { query?: string }) {
    const context = await this.context(token, 'group_tools.read');
    const query = input.query?.trim();
    if (!query) throw new AgentGroupToolError('GROUP_TEAM_SEARCH_QUERY_REQUIRED', 'team-search 需要关键词。', 400);
    const scope = { appId: context.appId, chatId: context.chatId };
    const search = this.options.teamSearch?.();
    // 与原先预注入跨群资料的条件相同：只有开启了群参与的群聊可用。
    if (context.chatType !== 'group' || !search || !await search.available(scope)) {
      throw new AgentGroupToolError('GROUP_TEAM_SEARCH_UNAVAILABLE', '跨群资料检索只在开启了群参与的群聊里可用；当前聊天不是群聊或未开启群参与。', 403);
    }
    let found: CollaborationTeamContext;
    try { found = await withLarkContextReadTimeout(search.reader.read(scope, query), '跨群资料读取'); }
    catch (error) { throw new AgentGroupToolError('GROUP_TEAM_SEARCH_FAILED', `跨群资料读取失败：${error instanceof Error ? error.message : String(error)}`, 502); }
    let allowed = false;
    try { allowed = await withLarkContextReadTimeout(search.reader.authorize(scope, found), '跨群资料授权复核'); } catch { /* 超时按未通过处理 */ }
    // 复核未通过时整份资料作废，连来源群名也不返回。
    if (!allowed) throw new AgentGroupToolError('GROUP_TEAM_SEARCH_DENIED', '跨群资料的读取权限复核未通过（来源群的成员关系或读取授权已变化），本次不返回其他群的内容。', 403);
    const score = search.reader.scorer(query);
    const sources = found.sources.map(source => ({ name: source.name || source.scope.chatId, chatId: source.scope.chatId, status: source.status, missing: source.missing, entries: [] as string[] }));
    let matched = 0, returned = 0, length = 0, truncated = false;
    for (const item of found.observations) {
      const { sender, body } = teamSearchLine(item);
      const source = sources.find(entry => entry.chatId === item.scope.chatId);
      if (!source || !body || score(body) <= 0) continue;
      matched++;
      const line = `[${item.missing.includes('event_time_unavailable') ? '时间未知' : clock(item.occurredAt)}] ${sender}: ${clip(body, 300)}`;
      if (returned >= teamSearchEntryLimit || length + line.length > teamSearchTextLimit) { truncated = true; continue; }
      source.entries.push(line); returned++; length += line.length;
    }
    const read = sources.filter(source => source.status !== 'unavailable').map(source => source.name);
    const unread = sources.filter(source => source.status === 'unavailable').map(source => `${source.name}（${source.missing.join('、') || '原因未知'}）`);
    const coverage = `已读来源：${read.join('、') || '无'}；未能读取的来源：${unread.join('、') || '无'}。每个来源只覆盖本地缓存与最近 50 条消息。`;
    return {
      query, matched, ...(truncated ? { truncated: true } : {}), sources,
      note: !matched ? `没有找到与「${query}」有词面重合的条目。${coverage}未命中不代表其他群没有相关内容。`
        : truncated ? `${coverage}结果超过 ${teamSearchEntryLimit} 条或 ${teamSearchTextLimit} 字，已截断，可换更具体的关键词。` : coverage
    };
  }

  private async resolveThreadId(context: ToolContext): Promise<string | undefined> {
    if (context.threadId || !context.threadRootMessageId) return context.threadId;
    const root = await this.authorized(context, 'message', () => context.client.getMessage(context.threadRootMessageId!));
    if (root.chatId !== context.chatId) throw new AgentGroupToolError('GROUP_MESSAGE_OUT_OF_SCOPE', '话题根消息不属于当前飞书群，已拒绝读取。', 403);
    if (!root.threadId?.startsWith('omt_')) throw new AgentGroupToolError('GROUP_THREAD_UNAVAILABLE', '当前根消息尚无可读取的原生话题，已拒绝扩大到全群读取。', 409);
    context.threadId = root.threadId;
    return root.threadId;
  }

  private async assertMessageScope(context: ToolContext, message: LarkChatMessage, reply = false) {
    const code = reply ? 'GROUP_REPLY_OUT_OF_SCOPE' : 'GROUP_MESSAGE_OUT_OF_SCOPE';
    if (message.chatId !== context.chatId) throw new AgentGroupToolError(code, '消息不属于当前飞书群，已拒绝访问。', 403);
    if (context.threadRootMessageId === message.messageId) return;
    const threadId = await this.resolveThreadId(context);
    if (threadId && message.threadId !== threadId) throw new AgentGroupToolError(code, '消息不属于当前绑定话题，已拒绝访问。', 403);
  }

  async wait(token: string | undefined, input: { after?: string; limit?: number; timeoutMs?: number } = {}) {
    const context = await this.context(token, 'group_tools.read');
    if (!input.after) throw new AgentGroupToolError('GROUP_WAIT_CURSOR_REQUIRED', 'wait 必须传入 messages 或上一次 wait 返回的 --after cursor。', 400);
    const timeoutMs = input.timeoutMs ?? 15_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > maxWaitTimeoutMs) throw new AgentGroupToolError('INVALID_GROUP_WAIT_TIMEOUT', `timeoutMs 必须是 0-${maxWaitTimeoutMs} 的整数。`, 400);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const result = await this.messagesFor(context, input);
      if (result.messages.length) return result;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ...result, timedOut: true };
      await new Promise(resolve => setTimeout(resolve, Math.min(this.pollIntervalMs, remaining)));
    }
  }

  async send(token: string | undefined, input: { final?: boolean; turn?: string; content?: string; to?: string; replyTo?: string; inThread?: boolean; idempotencyKey?: string }) {
    const context = await this.context(token, 'group_tools.send');
    if (!context.config.groupToolsAllowSend) throw new AgentGroupToolError('GROUP_TOOL_SEND_DISABLED', '当前飞书机器人的群协作发送能力已被管理员关闭。', 403);
    const content = input.content?.trim();
    if (!content) throw new AgentGroupToolError('INVALID_GROUP_MESSAGE', 'content 不能为空。', 400);
    if (input.final !== undefined && typeof input.final !== 'boolean') throw new AgentGroupToolError('INVALID_FINAL_FLAG', 'final 必须是布尔值。');
    if (input.turn && !input.final) throw new AgentGroupToolError('FINAL_FLAG_REQUIRED', '--turn 只能与 --final 一起使用。');
    if (input.final) {
      const active = this.options.workbenchTask?.(context.sessionId);
      if (!active?.attemptId) throw new AgentGroupToolError('FINAL_NO_ACTIVE_TASK', '没有可交付最终答复的活跃任务。', 409);
      return withExplicitFinalLock(this.configs, active.taskId, async () => {
        const current = await this.context(token, 'group_tools.send');
        if (!current.config.groupToolsAllowSend) throw new AgentGroupToolError('GROUP_TOOL_SEND_DISABLED', '发送能力已关闭。', 403);
        const task = this.options.workbenchTask?.(current.sessionId);
        if (!task?.attemptId || task.taskId !== active.taskId) throw new AgentGroupToolError('FINAL_TURN_EXPIRED', '任务轮次已结束。', 403);
        this.capabilities.assertFinalTurn(current.sessionId, task.taskId, task.attemptId, input.turn);
        const target = await this.options.finalTaskContext?.(current, { taskId: task.taskId, attemptId: task.attemptId });
        if (!target) throw new AgentGroupToolError('FINAL_MAPPING_UNAVAILABLE', '本轮消息映射尚未就绪或没有合法消息路由，请稍后重试。', 409);
        const scope = target.scope;
        if (scope.app_id !== current.appId || scope.session_id !== current.sessionId || scope.runtime_task_id !== task.taskId
          || scope.attempt_id !== task.attemptId || scope.chat_id !== current.chatId || scope.chat_type !== current.chatType
          || input.to !== undefined || input.idempotencyKey !== undefined
          || (input.replyTo !== undefined && input.replyTo.trim() !== scope.reply_message_id)
          || (input.inThread !== undefined && input.inThread !== scope.reply_in_thread)) throw new AgentGroupToolError('FINAL_TARGET_MISMATCH', '最终答复只能交付到当前任务绑定的原始消息位置。', 400);
        const latest = this.options.workbenchTask?.(current.sessionId);
        if (latest?.taskId !== task.taskId || latest.attemptId !== task.attemptId) throw new AgentGroupToolError('FINAL_TURN_EXPIRED', '任务轮次已结束。', 403);
        if (!current.client.send || !current.client.update || !current.client.uploadFile
          || (scope.reply_message_id ? !current.client.reply || !current.client.replyFile : !current.client.sendFile)) throw new AgentGroupToolError('FINAL_CLIENT_UNSUPPORTED', '当前客户端不支持最终答复卡片。', 503);
        return this.authorized(current, scope.reply_message_id ? 'reply' : 'send', () => sendExplicitFinal(this.configs, current.client as LarkCardService, target, content));
      });
    }
    if (content.length > 20_000) throw new AgentGroupToolError('INVALID_GROUP_MESSAGE', 'content 不能超过 20000 个字符。', 400);
    const idempotencyKey = input.idempotencyKey?.trim() || deterministicSendUuid({
      sessionId: context.sessionId,
      chatId: context.chatId,
      content,
      // --to 的匹配规则是 trim 后大小写不敏感，指纹做同样归一化，避免空白/大小写差异绕过合并。
      to: input.to?.trim().toLowerCase() ?? '',
      replyTo: input.replyTo?.trim() ?? '',
      inThread: input.inThread === true
    });
    if (idempotencyKey.length > 50) throw new AgentGroupToolError('INVALID_IDEMPOTENCY_KEY', 'idempotencyKey 不能超过 50 个字符。', 400);
    if (input.inThread && !input.replyTo?.trim()) {
      throw new AgentGroupToolError('GROUP_THREAD_REPLY_TARGET_REQUIRED', '话题内回复必须同时传入 replyTo；请使用当前消息或 messages 返回的 om_* messageId。', 400);
    }
    if (input.replyTo?.trim() && !input.replyTo.trim().startsWith('om_')) {
      throw new AgentGroupToolError('INVALID_GROUP_REPLY_TARGET', 'replyTo 只能使用 om_* messageId，不能使用 omt_* threadId。', 400);
    }

    let text = content;
    if (input.to?.trim()) {
      const target = input.to.trim().toLowerCase();
      const [{ peers }, { members }] = await Promise.all([this.peersFor(context), this.membersFor(context)]);
      const candidates = [
        ...peers.map(peer => ({ name: peer.name, memberId: peer.memberId, openId: peer.openId, identifiers: [peer.appId, peer.agentId, peer.memberId, peer.openId] })),
        ...members.map(member => ({ name: member.name, memberId: member.memberId, openId: member.openId, identifiers: [member.memberId, member.openId] }))
      ];
      const idMatches = candidates.filter(candidate => candidate.identifiers.some(value => value?.toLowerCase() === target));
      const matches = idMatches.length ? idMatches : candidates.filter(candidate => candidate.name.toLowerCase() === target);
      if (!matches.length) throw new AgentGroupToolError('GROUP_TARGET_NOT_FOUND', `当前群内没有找到目标：${input.to.trim()}。请先调用 peers 或 members 获取可用目标。`, 404);
      if (matches.length > 1) throw new AgentGroupToolError('GROUP_TARGET_AMBIGUOUS', `目标 ${input.to.trim()} 对应多个群成员，请改用 appId 或 openId。`, 409);
      const match = matches[0]!;
      const mentionId = match.openId ?? match.memberId;
      text = `<at user_id="${mentionId}">${escapeAtName(match.name)}</at> ${content}`;
    }

    if (input.replyTo?.trim()) {
      const replyTo = input.replyTo.trim();
      const original = await this.authorized(context, 'reply', () => context.client.getMessage(replyTo));
      await this.assertMessageScope(context, original, true);
      return this.authorized(context, 'reply', () => context.client.replyText({
        messageId: replyTo, text, ...(input.inThread ? { replyInThread: true } : {}), idempotencyKey
      }));
    }
    return this.authorized(context, 'send', () => context.client.sendText({ chatId: context.chatId, text, idempotencyKey }));
  }

  async sendFile(token: string | undefined, input: { path?: string; replyTo?: string; inThread?: boolean; idempotencyKey?: string; image?: boolean }) {
    const context = await this.context(token, 'group_tools.send');
    if (!context.config.groupToolsAllowSend) throw new AgentGroupToolError('GROUP_TOOL_SEND_DISABLED', '当前飞书机器人的群协作发送能力已被管理员关闭。', 403);
    const path = input.path?.trim(); if (!path) throw new AgentGroupToolError('ARTIFACT_PATH_REQUIRED', 'path 不能为空。', 400);
    if (input.inThread && !input.replyTo?.trim()) throw new AgentGroupToolError('GROUP_THREAD_REPLY_TARGET_REQUIRED', '话题内回复必须同时传入 replyTo。', 400);
    if (input.replyTo) { const original = await this.authorized(context, 'reply', () => context.client.getMessage(input.replyTo!.trim())); await this.assertMessageScope(context, original); }
    const { session } = await this.capabilities.resolveSession(token);
    const client = context.client;
    const target = input.replyTo ? { chatId: context.chatId, replyTo: input.replyTo.trim(), ...(input.inThread ? { inThread: true } : {}) } : { chatId: context.chatId };
    const required = input.image ? [client.uploadImage, input.replyTo ? client.replyImage : client.sendImage] : [client.uploadFile, input.replyTo ? client.replyFile : client.sendFile];
    if (required.some(method => !method)) throw new AgentGroupToolError('ARTIFACT_CLIENT_UNSUPPORTED', '当前飞书客户端不支持这一类文件交付。', 503);
    const artifactClient: ArtifactClient = {
      uploadFile: value => this.authorized(context, 'send', () => client.uploadFile!(value)), uploadImage: value => this.authorized(context, 'send', () => client.uploadImage!(value)),
      sendFile: value => value.replyTo ? this.authorized(context, 'reply', () => client.replyFile!({ messageId: value.replyTo!, replyInThread: value.inThread, fileKey: value.fileKey, idempotencyKey: value.idempotencyKey })) : this.authorized(context, 'send', () => client.sendFile!({ chatId: value.chatId, fileKey: value.fileKey, idempotencyKey: value.idempotencyKey })),
      sendImage: value => value.replyTo ? this.authorized(context, 'reply', () => client.replyImage!({ messageId: value.replyTo!, replyInThread: value.inThread, imageKey: value.imageKey, idempotencyKey: value.idempotencyKey })) : this.authorized(context, 'send', () => client.sendImage!({ chatId: value.chatId, imageKey: value.imageKey, idempotencyKey: value.idempotencyKey }))
    };
    return deliverArtifact({ configs: this.configs, sessionId: context.sessionId, cwd: session.cwd, client: artifactClient, path, target, image: input.image === true, idempotencyKey: input.idempotencyKey });
  }

  private async resolveHandoffScope(token: string | undefined, turn?: string): Promise<{
    context: ToolContext;
    task: { taskId: string; attemptId: string };
    scope: ExplicitFinalScope;
  }> {
    const context = await this.context(token, 'group_tools.send');
    if (context.chatType !== 'group') {
      throw new AgentGroupToolError('GROUP_TOOL_CHAT_TYPE_INVALID', '交接工具仅支持群聊会话使用。', 400);
    }
    if (!context.config.groupToolsAllowSend) {
      throw new AgentGroupToolError('GROUP_TOOL_SEND_DISABLED', '当前飞书机器人的群协作发送能力已被管理员关闭。', 403);
    }
    if (!turn?.trim()) {
      throw new AgentGroupToolError('FINAL_FLAG_REQUIRED', '--turn 凭证不能为空。', 400);
    }
    const active = this.options.workbenchTask?.(context.sessionId);
    if (!active?.attemptId) {
      throw new AgentGroupToolError('FINAL_NO_ACTIVE_TASK', '没有可交接的活跃任务。', 409);
    }
    this.capabilities.assertFinalTurn(context.sessionId, active.taskId, active.attemptId, turn);
    const target = await this.options.finalTaskContext?.(context, { taskId: active.taskId, attemptId: active.attemptId });
    if (!target) {
      throw new AgentGroupToolError('FINAL_MAPPING_UNAVAILABLE', '本轮消息映射尚未就绪，请稍后重试。', 409);
    }
    const scope = target.scope;
    if (
      scope.app_id !== context.appId ||
      scope.session_id !== context.sessionId ||
      scope.runtime_task_id !== active.taskId ||
      scope.attempt_id !== active.attemptId ||
      scope.chat_id !== context.chatId ||
      scope.chat_type !== context.chatType ||
      scope.chat_type !== 'group' ||
      !scope.origin_message_id?.startsWith('om_')
    ) {
      throw new AgentGroupToolError('FINAL_TARGET_MISMATCH', '当前任务作用域与会话不匹配。', 400);
    }
    return { context, task: { taskId: active.taskId, attemptId: active.attemptId }, scope };
  }

  private async commitAgentAction(
    token: string | undefined,
    context: ToolContext,
    active: { taskId: string; attemptId: string },
    expectedScope: ExplicitFinalScope,
    targetPeer: AgentGroupPeer,
    text: string,
    idempotencyKey: string
  ) {
    // 1. 最终映射异步检查，在最后一次 context(send) 授权之前完成
    const finalTarget = await this.options.finalTaskContext?.(context, { taskId: active.taskId, attemptId: active.attemptId });
    if (!finalTarget || JSON.stringify(finalTarget.scope) !== JSON.stringify(expectedScope)) {
      throw new AgentGroupToolError('FINAL_TURN_EXPIRED', '任务轮次或映射已失效。', 403);
    }

    // 2. 最后一次 context(send) 授权
    const freshContext = await this.context(token, 'group_tools.send');
    if (!freshContext.config.groupToolsAllowSend) {
      throw new AgentGroupToolError('GROUP_TOOL_SEND_DISABLED', '当前飞书机器人的群协作发送能力已被管理员关闭。', 403);
    }

    // 3. 所有异步查询结束后立即同步重读 active task/attempt
    const currentTask = this.options.workbenchTask?.(freshContext.sessionId);
    if (!currentTask?.attemptId || currentTask.taskId !== active.taskId || currentTask.attemptId !== active.attemptId) {
      throw new AgentGroupToolError('FINAL_TURN_EXPIRED', '任务轮次已结束。', 403);
    }

    // 4. 同步校验通过，立即发送（中间无任何 await）
    const result = await this.authorized(freshContext, 'reply', () => freshContext.client.replyText({
      messageId: expectedScope.origin_message_id,
      text,
      replyInThread: true,
      idempotencyKey
    }));

    return {
      messageId: result.messageId,
      chatId: result.chatId ?? freshContext.chatId,
      target: {
        appId: targetPeer.appId,
        name: targetPeer.name,
        ...(targetPeer.openId ? { openId: targetPeer.openId } : {})
      },
      replyTo: expectedScope.origin_message_id
    };
  }

  async handoff(token: string | undefined, input: { to?: string; content?: string; turn?: string }) {
    const to = input.to?.trim();
    if (!to) throw new AgentGroupToolError('HANDOFF_TARGET_REQUIRED', 'to 目标机器人不能为空。', 400);
    const content = input.content?.trim();
    if (!content) throw new AgentGroupToolError('INVALID_GROUP_MESSAGE', 'content 不能为空。', 400);
    if (content.length > 20_000) throw new AgentGroupToolError('INVALID_GROUP_MESSAGE', 'content 不能超过 20000 个字符。', 400);

    const { context, task, scope } = await this.resolveHandoffScope(token, input.turn);

    const original = await this.authorized(context, 'reply', () => context.client.getMessage(scope.origin_message_id));
    await this.assertMessageScope(context, original, true);

    const botInfo = await this.identityFor(context.config);
    const selfIdentifiers = new Set<string>();
    if (context.appId) selfIdentifiers.add(context.appId.toLowerCase());
    if (botInfo.openId) selfIdentifiers.add(botInfo.openId.toLowerCase());
    const isSelfIdentifier = (id?: string) => Boolean(id && selfIdentifiers.has(id.toLowerCase()));
    const isSelfPeer = (p: AgentGroupPeer) => isSelfIdentifier(p.appId) || isSelfIdentifier(p.memberId) || isSelfIdentifier(p.openId);

    const targetLower = to.toLowerCase();
    if (isSelfIdentifier(targetLower)) {
      throw new AgentGroupToolError('HANDOFF_TARGET_SELF_FORBIDDEN', '不允许向自己交接任务。', 400);
    }

    const { peers } = await this.peersFor(context);
    const botCandidates = peers.map(peer => ({
      peer,
      name: peer.name,
      identifiers: [peer.appId, peer.agentId, peer.memberId, peer.openId].filter(Boolean) as string[]
    }));
    const idMatches = botCandidates.filter(c => c.identifiers.some(id => id.toLowerCase() === targetLower));
    const matches = idMatches.length ? idMatches : botCandidates.filter(c => c.name.toLowerCase() === targetLower);
    if (!matches.length) {
      const { members } = await this.membersFor(context);
      const humanMatches = members.filter(m => [m.memberId, m.openId].some(id => id?.toLowerCase() === targetLower) || m.name.toLowerCase() === targetLower);
      if (humanMatches.length > 0) {
        throw new AgentGroupToolError('HANDOFF_TARGET_HUMAN_FORBIDDEN', `目标 ${to} 是群内人类成员；交接只能交接给机器人。`, 400);
      }
      throw new AgentGroupToolError('GROUP_TARGET_NOT_FOUND', `当前群内没有找到目标机器人：${to}。请先调用 peers 获取可用机器人。`, 404);
    }
    if (matches.length > 1) {
      throw new AgentGroupToolError('GROUP_TARGET_AMBIGUOUS', `目标机器人 ${to} 对应多个机器人，请改用 appId 或 openId。`, 409);
    }
    const targetPeer = matches[0]!.peer;

    if (isSelfPeer(targetPeer)) {
      throw new AgentGroupToolError('HANDOFF_TARGET_SELF_FORBIDDEN', '不允许向自己交接任务。', 400);
    }

    const senderBotName = context.config.name ?? botInfo.appName ?? context.appId;
    const mentionId = targetPeer.openId ?? targetPeer.memberId;
    const text = `<at user_id="${mentionId}">${escapeAtName(targetPeer.name)}</at> [Agent 交接] 来自 ${escapeAtName(senderBotName)} (${context.appId})\n请在原话题内完成任务并使用 reply-agent 回传实质结果（一次回传，无须重复确认）：\n\n${content}`;

    const targetId = targetPeer.openId ?? targetPeer.appId ?? targetPeer.memberId;
    const idempotencyKey = deterministicAgentActionKey({
      sessionId: context.sessionId,
      taskId: task.taskId,
      attemptId: task.attemptId,
      action: 'handoff',
      targetId,
      content
    });

    return this.commitAgentAction(token, context, task, scope, targetPeer, text, idempotencyKey);
  }

  async replyAgent(token: string | undefined, input: { content?: string; turn?: string }) {
    const content = input.content?.trim();
    if (!content) throw new AgentGroupToolError('INVALID_GROUP_MESSAGE', 'content 不能为空。', 400);
    if (content.length > 20_000) throw new AgentGroupToolError('INVALID_GROUP_MESSAGE', 'content 不能超过 20000 个字符。', 400);

    const { context, task, scope } = await this.resolveHandoffScope(token, input.turn);

    const original = await this.authorized(context, 'reply', () => context.client.getMessage(scope.origin_message_id));
    await this.assertMessageScope(context, original, true);

    const sender = original.sender;
    if (!sender || (sender.type !== 'app' && (sender as any).type !== 'bot')) {
      throw new AgentGroupToolError('REPLY_AGENT_ORIGIN_NOT_BOT', '当前任务原始消息不是由机器人发起，无法使用 reply-agent 回传。', 400);
    }
    if (!sender.id) {
      throw new AgentGroupToolError('REPLY_AGENT_SENDER_UNRESOLVABLE', '原始消息缺少有效的发送方标识。', 400);
    }

    const botInfo = await this.identityFor(context.config);
    const selfIdentifiers = new Set<string>();
    if (context.appId) selfIdentifiers.add(context.appId.toLowerCase());
    if (botInfo.openId) selfIdentifiers.add(botInfo.openId.toLowerCase());
    const isSelfIdentifier = (id?: string) => Boolean(id && selfIdentifiers.has(id.toLowerCase()));
    const isSelfPeer = (p: AgentGroupPeer) => isSelfIdentifier(p.appId) || isSelfIdentifier(p.memberId) || isSelfIdentifier(p.openId);

    const senderId = sender.id.toLowerCase();
    if (isSelfIdentifier(senderId)) {
      throw new AgentGroupToolError('REPLY_AGENT_TARGET_SELF_FORBIDDEN', '无法向自己回传结果。', 400);
    }

    const originalText = await renderMessageContent(original);
    const strippedText = stripLeadingMentions(originalText);
    if (strippedText.startsWith('[Agent 结果]')) {
      throw new AgentGroupToolError('AGENT_REPLY_ALREADY_COMPLETED', '当前消息已是 [Agent 结果]，无需再次回传，避免循环确认。', 400);
    }

    const { peers } = await this.peersFor(context);
    const matchedPeers = peers.filter(peer =>
      [peer.openId, peer.memberId, peer.appId].some(id => id?.toLowerCase() === senderId)
    );
    if (!matchedPeers.length) {
      throw new AgentGroupToolError('REPLY_AGENT_SENDER_NOT_IN_PEERS', '发起交接的机器人不在当前群内或无法解析为当前群机器人。', 400);
    }
    if (matchedPeers.length > 1) {
      throw new AgentGroupToolError('GROUP_TARGET_AMBIGUOUS', '发起交接的机器人对应多个群机器人，存在歧义。', 409);
    }
    const targetPeer = matchedPeers[0]!;

    if (isSelfPeer(targetPeer)) {
      throw new AgentGroupToolError('REPLY_AGENT_TARGET_SELF_FORBIDDEN', '无法向自己回传结果。', 400);
    }

    const mentionId = targetPeer.openId ?? targetPeer.memberId;
    const text = `<at user_id="${mentionId}">${escapeAtName(targetPeer.name)}</at> [Agent 结果]\n任务交付结果如下（这是最终结果，请勿为“收到/谢谢”等礼貌确认再次唤醒）：\n\n${content}`;

    const targetId = targetPeer.openId ?? targetPeer.appId ?? targetPeer.memberId;
    const idempotencyKey = deterministicAgentActionKey({
      sessionId: context.sessionId,
      taskId: task.taskId,
      attemptId: task.attemptId,
      action: 'reply-agent',
      targetId,
      content
    });

    return this.commitAgentAction(token, context, task, scope, targetPeer, text, idempotencyKey);
  }
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const dutydeckGroupToolsCommand = (entrypoint: string, execPath = process.execPath, tsxLoader?: string) => {
  const absoluteEntrypoint = resolve(entrypoint);
  const loader = absoluteEntrypoint.endsWith('.ts') ? tsxLoader ?? import.meta.resolve('tsx') : undefined;
  return `${shellQuote(execPath)}${loader ? ` --import ${shellQuote(loader)}` : ''} ${shellQuote(absoluteEntrypoint)}`;
};

export const larkGroupToolsPrompt = (allowSend: boolean, command = 'dutydeck') => `[Dutydeck 飞书会话工具]
${allowSend ? '当前会话可读取和发送' : '当前会话可只读访问'}当前飞书会话的消息。必须使用以下当前服务绑定命令，不要改用 PATH 中的其他 dutydeck：
- ${command} group self
- ${command} group messages --limit 20 [--after <cursor>] [--since <时间> --until <时间>] [--query '<关键词>']
- ${command} group message <om_* message_id>
- ${command} history list [--since <时间>] [--until <时间>] [--query '<关键词>'] [--limit 20]、${command} history show <taskId>：本聊天以前的任务请求与最终回答
- （仅群聊）${command} group team-search '<关键词>'：检索同一机器人所在其他群的相关消息
${allowSend ? `- ${command} group send-file <path> [--reply-to <message_id> [--in-thread]] [--idempotency-key <key>] [--image]` : ''}
- ${command} group wait --after <cursor> [--timeout-ms 15000]
${allowSend ? `- ${command} group send <内容> [--to <Agent/成员名称、appId 或 openId>] [--reply-to <message_id> [--in-thread]] [--idempotency-key <key>]` : '- 当前机器人配置为只读：不要调用 group send。'}
- （仅群聊）${command} group peers / members / bots：发现群内可协作 Agent 与人类成员。

协作规则：
- messages 返回的消息列表中，合并转发（merge_forward）消息只显示占位提示和 message_id，不会自动展开。如需查看转发的具体内容，请调用 ${command} group message <message_id> 按 message_id 拉取。
- 要翻较早的讨论，用 --since/--until 限定时间，再用 --query 过滤；结果带 truncated=true 时表示只扫描了 500 条，没扫到的部分不能推断为不存在。
- 用户问以前、上次、之前讨论过的结论时，先用 history list --query '<关键词>' 找到本聊天以前的任务，再用 history show <taskId> 读原文；没找到时说明查过的时间和关键词，不要断定没讨论过。
- 用户问其他群、别的群的信息时，用 group team-search '<关键词>'；仅开启了群参与的群可用，只返回和关键词有字面重合的条目，未能读取的来源不能推断成不存在。
- ${allowSend ? `需要其他 Agent 协助时先调用 peers 或 bots；返回的机器人中，带 agentId 字段的是本 Dutydeck 实例管理的可协作 Agent，不带 agentId 的是群内其他机器人。需要 @群内人类用户时先调用 members。再用 send --to 明确目标；名称重名时使用 appId 或 openId，不要臆测。
- 发送前先判断消息归属：延续某条提问、回答某个话题或补充该话题结论时，使用 send --reply-to <该消息的 om_* messageId> --in-thread；独立公告、新任务或不应归入原讨论的内容，使用 send 且不要传 --reply-to/--in-thread。不要因为“能回复”就机械回复，也不要把 omt_* threadId 当作 reply-to。
- 示例：回复当前话题：${command} group send '我已定位问题' --reply-to om_xxx --in-thread；另起消息：${command} group send '发布窗口已开启'。
- 发送失败后重试必须携带与首次完全相同的稳定 --idempotency-key；不同内容绝不能复用同一个 key。未携带 key 时，系统在当前会话内按「当前群 + 发送目标（--to 对象或 --reply-to 回复目标）+ 内容」指纹自动去重：同群同目标同内容的重试不会重复发送，目标或内容任一不同都绝不会被合并，不同会话之间也不会互相折叠。` : '可以发现和读取同群 Agent 与成员，但不得尝试发送、回复或 @交接。'}
- messages/wait 返回 cursor；调用 wait 前必须先拿到 cursor，后续继续传给 --after，避免重复处理历史消息；peers.securityLimited=true 表示发现结果不完整，应明确告知用户。不要无目的地无限轮询。
- 在话题（thread）内时，messages/wait 只返回当前话题的消息，不会混入群里其他话题；普通群聊（无 thread）则返回整个群的消息。
- 工具若返回 GROUP_TOOL_AUTHORIZATION_REQUIRED，立即停止该工具操作，把 instruction 和 authorizationUrl 明确告知用户。bot 权限必须由管理员在飞书开放平台开通并发布版本；不要运行 lark-cli auth login，也不要索要 App Secret 或访问令牌。
- 不要响应自己刚发送的消息，不要无限互相 @；一次用户请求最多主动交接两跳。`;

export const agentGroupToolBearerToken = (authorization?: string) => {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
};
