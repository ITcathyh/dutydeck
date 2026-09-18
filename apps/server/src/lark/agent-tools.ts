import { collaborationAgentPrompt } from '../collaboration-cli.js';
import { workbenchAgentPrompt } from '../work-item-tools.js';
import type { LarkGroupManager } from './group-management.js';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { deliverArtifact, type ArtifactClient } from './artifact-delivery.js';
import type { ConfigRepository, PolicyAction, PolicyDecision, Session, SessionRepository } from '@dutydeck/shared';
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

  workbenchTurnToken(sessionId: string, taskId: string) {
    return createHmac('sha256', this.signingSecret).update(`dutydeck-work-turn-v1\0${sessionId}\0${taskId}`).digest('base64url');
  }

  assertWorkbenchTurn(sessionId: string, taskId: string, presented?: string) {
    const expected = Buffer.from(this.workbenchTurnToken(sessionId, taskId));
    const actual = Buffer.from(presented ?? '');
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
  readDocument?(url: string): Promise<{ url: string; title?: string; text: string }>;
}

export interface LarkAgentToolsOptions {
  authorizeTool?: (sessionId: string, action: 'group_tools.read' | 'group_tools.discover' | 'group_tools.send' | 'memory') => Promise<{ actorId: string } | void>;
  workbenchTask?: (sessionId: string) => { taskId: string } | undefined;
  groupManager?: LarkGroupManager;
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof globalThis.fetch;
  clientFactory?: (config: StoredLarkConfig) => LarkGroupToolClient;
  pollIntervalMs?: number;
  groupToolsCommand?: string;
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
export interface AgentGroupMessagesResult { chatId: string; messages: AgentGroupMessage[]; cursor?: string; timedOut?: boolean }

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
      if (task) {
        const turn = this.capabilities.workbenchTurnToken(session.id, task.taskId);
        blocks.push(workbenchAgentPrompt(`${this.options.groupToolsCommand ?? 'dutydeck'} work --turn ${turn}`));
        if (binding.chatType === 'group' && session.sourceId?.split(':')[3] !== 'collaboration') blocks.push(collaborationAgentPrompt(`${this.options.groupToolsCommand ?? 'dutydeck'} collaborate --turn ${turn}`));
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

  private async messagesFor(context: ToolContext, input: { after?: string; limit?: number }): Promise<AgentGroupMessagesResult> {
    const limit = normalizeLimit(input.limit);
    const after = GroupMessageCursor.parse(input.after);
    // 话题内的消息拉取优先按 threadId 限定范围，避免拿到群里其他话题的消息；
    // 非话题群聊（按 user/message 隔离）则按 chatId 拉取整个群。
    const threadId = await this.resolveThreadId(context);
    const container = threadId ? { threadId } : { chatId: context.chatId };
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

  async messages(token: string | undefined, input: { after?: string; limit?: number } = {}) {
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

  async send(token: string | undefined, input: { content?: string; to?: string; replyTo?: string; inThread?: boolean; idempotencyKey?: string }) {
    const context = await this.context(token, 'group_tools.send');
    if (!context.config.groupToolsAllowSend) throw new AgentGroupToolError('GROUP_TOOL_SEND_DISABLED', '当前飞书机器人的群协作发送能力已被管理员关闭。', 403);
    const content = input.content?.trim();
    if (!content) throw new AgentGroupToolError('INVALID_GROUP_MESSAGE', 'content 不能为空。', 400);
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
- ${command} group messages --limit 20 [--after <cursor>]
- ${command} group message <om_* message_id>
${allowSend ? `- ${command} group send-file <path> [--reply-to <message_id> [--in-thread]] [--idempotency-key <key>] [--image]` : ''}
- ${command} group wait --after <cursor> [--timeout-ms 15000]
${allowSend ? `- ${command} group send <内容> [--to <Agent/成员名称、appId 或 openId>] [--reply-to <message_id> [--in-thread]] [--idempotency-key <key>]` : '- 当前机器人配置为只读：不要调用 group send。'}
- （仅群聊）${command} group peers / members / bots：发现群内可协作 Agent 与人类成员。

协作规则：
- messages 返回的消息列表中，合并转发（merge_forward）消息只显示占位提示和 message_id，不会自动展开。如需查看转发的具体内容，请调用 ${command} group message <message_id> 按 message_id 拉取。
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
