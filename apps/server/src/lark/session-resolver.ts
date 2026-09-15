import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ChannelMappingRepository, Session } from '@dutydeck/shared';
import { LEGACY_RETIREMENT_NOTICE } from '@dutydeck/storage';
import type { LarkLaunchOptions } from './new-session.js';
import { larkExecutionConfirmed, larkPermissionMode, type StoredLarkConfig } from './config.js';
import { parseLarkMessageContent, type LarkMessageResource } from './message-content.js';
import { LarkServiceError, type LarkCardService } from './service.js';
import type { LarkChatMode } from './chat-mode.js';
import type { LarkGroup } from './coordinator.js';
import type { ListenerLog, LarkMessageEvent, LarkRuntime } from './listener.js';

// 会话路由与资源物化辅助（从 listener.ts 拆分）。
// 路由规则移植自 botmux 的 decideRouting：thread_id 是「是否真在话题里」的权威信号
// （root_id 可能被引用气泡误带），话题群种子消息按 message_id 开新话题，普通群按
// groupReplyMode 配置路由；配置缺失时保持 dutydeck legacy 行为。

/** 群形态查询函数（生产环境由 chat-mode.ts 的 getChatMode 注入，单测可注入 mock）。 */
export type LarkChatModeResolver = (appId: string, chatId: string) => Promise<LarkChatMode>;

const trimmed = (value?: string): string | undefined => {
  const text = value?.trim();
  return text || undefined;
};

export const larkSessionConfigKey = (config: StoredLarkConfig) => JSON.stringify([
  config.defaultAgentId ?? null,
  config.defaultModel ?? null,
  config.defaultReasoningEffort ?? null,
  config.workspace ?? null,
  config.fullTrustConfirmed === true,
  larkPermissionMode(config)
]);

// 群聊不能按 chat_id 复用同一个 Agent 会话，否则不同话题/提问人的历史和预注入 Prompt 会串在一起。
// 话题群优先按 thread_id 隔离，让同一话题内的连续追问复用同一会话；普通群聊没有 thread_id 时再按发送人隔离。
export const larkGroupScopeId = (event: LarkMessageEvent) => {
  if (event.chatType !== 'group') return event.chatType;
  const thread = event.threadId?.trim();
  if (thread) return `thread:${thread}`;
  const actor = event.senderOpenId?.trim();
  if (actor) return `user:${actor}`;
  return `message:${event.messageId}`;
};

/**
 * 群/话题串行化的内存 key。
 *
 * 必须带 appId：同一个聊天里可以同时装着两个 Dutydeck 机器人，它们各自持久化的
 * sourceId 本来就不同（见 {@link larkSourceId}），但 group key 少了 appId 就会让两个
 * 机器人共用同一条内存绑定——A 机器人建的会话会被 B 机器人直接复用，
 * /new 也会停错人的会话。
 */
export const larkGroupKey = (event: LarkMessageEvent, scopeId: string, appId: string) => `${appId}:${event.chatId}:${scopeId}`;

export const larkReplyContext = (event: LarkMessageEvent) => ({
  // 回复 API 的路径参数只能使用真实的 om_* 消息 ID。回复触发消息即可保留准确的上下文位置。
  messageId: event.messageId,
  // thread_id 只用于识别话题和隔离 Agent 会话，不可作为回复 API 的 messageId。
  ...(event.threadId?.trim() ? { replyInThread: true } : {}),
  // 话题根消息 id 一并带入回复上下文，让后续回复能锚到话题根；
  // service.ts 的回复 API 消费该字段前，它只是随上下文透传的额外字段。
  ...(event.rootId?.trim() ? { replyRootId: event.rootId.trim() } : {})
});

export const larkSourceId = (config: StoredLarkConfig, chatId: string, chatType: string, scopeId: string) => {
  const base = `${config.appId}:${chatId}:${chatType}`;
  // sourceId 会持久化到 runtime session。scopeId 与 chatType 相同时说明整个聊天只有一个
  // 会话（普通 p2p），保持旧格式以兼容既有持久化记录；其余情况（群聊，以及
  // p2pMode='thread' 下各自独立的私聊话题）必须把 scopeId 写进 sourceId，
  // 否则同一个私聊里的多个话题会共用一条持久化会话，重启后互相串上下文。
  return scopeId === chatType ? base : `${base}:${scopeId}`;
};

const selfMentionMarker = '\u0000dutydeck-self-mention\u0000';

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const removeMentionToken = (text: string, token: string) => text.replace(
  new RegExp(`([^\\S\\r\\n]*)${escapeRegExp(token)}([^\\S\\r\\n]*)`, 'g'),
  (_match, before: string, after: string) => before && after ? ' ' : ''
);

const markSelfRichTextMentions = (content: string, botOpenId?: string) => {
  if (!botOpenId) return content;
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch { return content; }
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    const node = value as Record<string, unknown>;
    const property = node.property && typeof node.property === 'object' && !Array.isArray(node.property)
      ? node.property as Record<string, unknown>
      : undefined;
    const id = node.id && typeof node.id === 'object' && !Array.isArray(node.id)
      ? node.id as Record<string, unknown>
      : undefined;
    const openId = [node.user_id, node.open_id, id?.open_id, property?.user_id, property?.open_id]
      .find(candidate => typeof candidate === 'string');
    if (node.tag === 'at' && openId === botOpenId) return { tag: 'text', text: selfMentionMarker };
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, visit(child)]));
  };
  return JSON.stringify(visit(parsed));
};

export async function parsePrompt(event: LarkMessageEvent, botOpenId?: string) {
  if (event.mentions.some(mention => typeof mention.key !== 'string' || typeof mention.name !== 'string')) {
    throw new Error('飞书消息包含无效的 mention 数据');
  }
  // 合并转发（merge_forward）消息不自动展开，只返回带 message_id 的占位提示；
  // Agent 如需查看转发内容，可通过群协作工具按 message_id 拉取。
  const content = event.messageType === 'post' || event.messageType === 'rich_text'
    ? markSelfRichTextMentions(event.content, botOpenId)
    : event.content;
  const parsed = await parseLarkMessageContent(event.messageType, content, {
    messageId: event.messageId
  });
  let text = removeMentionToken(parsed.text, selfMentionMarker);
  // 飞书 text 消息用 mention key 占位。按 key 长度倒序替换，避免 @_user_1
  // 先破坏 @_user_10；只有 open_id 精确等于当前 bot 的占位才删除。
  for (const mention of [...event.mentions].sort((left, right) => right.key.length - left.key.length)) {
    const key = mention.key?.trim();
    if (!key) continue;
    if (botOpenId && mention.openId === botOpenId) {
      text = removeMentionToken(text, key);
      continue;
    }
    const name = mention.name?.trim();
    text = text.replaceAll(key, name ? `@${name}` : key);
  }
  return { prompt: text.trim(), resources: parsed.resources };
}

const resourceExtensions: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'audio/mpeg': '.mp3', 'video/mp4': '.mp4'
};

const safeResourceName = (resource: LarkMessageResource, contentType?: string) => {
  const hash = createHash('sha256').update(`${resource.type}:${resource.key}`).digest('hex').slice(0, 12);
  const supplied = resource.fileName ? basename(resource.fileName).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120) : '';
  return supplied ? `${hash}-${supplied}` : `${resource.type}-${hash}${resourceExtensions[contentType ?? ''] ?? ''}`;
};

const resourceFailureGuidance = (error: unknown) => {
  const upstreamCode = error instanceof LarkServiceError ? Number(error.details?.upstreamCode) : undefined;
  if (upstreamCode === 234002 || upstreamCode === 14005) {
    return '该错误通常表示机器人无权访问这条消息所在的会话，或附件已被删除，并非缺少 API scope；请用户重新上传附件，并确认机器人仍在对应会话中。';
  }
  const consoleUrl = error instanceof LarkServiceError && typeof error.details?.consoleUrl === 'string' ? error.details.consoleUrl : undefined;
  return `请管理员确认机器人已开通 \`im:message:readonly\` 权限${consoleUrl ? `，权限配置地址：${consoleUrl}` : ''}；如果权限已开通，请用户重新上传可能已过期或删除的附件。`;
};

export async function materializeLarkResources(messageId: string, prompt: string, resources: LarkMessageResource[], service: Pick<LarkCardService, 'downloadMessageResource'>) {
  if (!resources.length) return prompt;
  const directory = join(tmpdir(), 'dutydeck', 'lark-resources', messageId.replace(/[^a-zA-Z0-9_-]/g, '_'));
  const notes: string[] = [];
  for (const resource of resources) {
    try {
      const downloaded = await service.downloadMessageResource(messageId, resource.key, resource.type);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, safeResourceName(resource, downloaded.contentType));
      await writeFile(path, downloaded.data, { mode: 0o600 });
      notes.push(`- ${resource.label}已下载到本地：${path}。请使用本地文件读取工具查看。`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      notes.push(`- ${resource.label}下载失败：${reason}。你无法读取该附件；请在回复中明确告知用户。${resourceFailureGuidance(error)}`);
    }
  }
  return `${prompt}\n\n[Dutydeck 飞书附件处理结果]\n${notes.join('\n')}`.trim();
}

/**
 * 计算消息的会话隔离 scope（移植 botmux decideRouting）：
 *   - root_id + thread_id     → thread:${rootId}（真实话题回复，锚到话题根；所有模式一致）
 *   - 话题群 + 无真实话题      → thread:${messageId}（话题群种子消息）
 *   - p2pMode === 'thread'    → 每条顶层 DM 是新话题 thread:${messageId}；
 *                               thread_id-only 的回复回退锚到 thread_id
 *   - 普通群 groupReplyMode    → 'new-topic' 顶层开新话题；'chat'/'shared' 全群一个会话；
 *                               'chat-topic' 顶层平铺、omt_ 原生话题种子独立会话
 *   - 未设置配置               → dutydeck legacy：thread_id → thread:${threadId}，
 *                               否则按发送人 user:${openId}，再否则 message:${messageId}
 *
 * thread_id 是权威信号：Lark 客户端的引用气泡/快速回复有时会给顶层消息塞 root_id 但不塞
 * thread_id，只看 root_id 会把用户从平铺会话里误拽进孤立 thread 会话。
 */
export async function resolveLarkScopeId(
  event: LarkMessageEvent,
  config: StoredLarkConfig,
  chatModeResolver?: LarkChatModeResolver
): Promise<string> {
  const rootId = trimmed(event.rootId);
  const threadId = trimmed(event.threadId);
  if (event.chatType !== 'group') {
    // 私聊：默认（'chat'/未设）整段 DM 共用一个连续会话；'thread' 时每条顶层 DM 是新话题。
    if (config.p2pMode === 'thread') {
      if (rootId && threadId) return `thread:${rootId}`;
      if (threadId) return `thread:${threadId}`;
      return `thread:${event.messageId}`;
    }
    return event.chatType;
  }
  // 群聊：root_id + thread_id 同时存在才是真实话题回复，锚点为话题根消息 id（规则 1）。
  if (rootId && threadId) return `thread:${rootId}`;
  // 话题群：顶层消息（含只有 thread_id 的话题种子）一律开新话题（规则 4）。
  if (chatModeResolver) {
    try {
      const mode = await chatModeResolver(config.appId, event.chatId);
      if (mode === 'topic') return `thread:${event.messageId}`;
    } catch {
      // 群形态查询失败时降级为普通群路由，不能阻塞消息处理。
    }
  }
  // 普通群：按 groupReplyMode 路由（规则 5）；未设置走 dutydeck legacy。
  switch (config.groupReplyMode) {
    case 'new-topic':
      return `thread:${event.messageId}`;
    case 'chat':
    case 'shared':
      return `chat:${event.chatId}`;
    case 'chat-topic':
      // 顶层平铺；但 omt_ 开头的原生话题种子各自独立会话。
      return threadId?.startsWith('omt_') ? `thread:${event.messageId}` : `chat:${event.chatId}`;
    default:
      // legacy：有 thread_id 按话题隔离（无 root_id 时锚点回退 thread_id），否则按发送人，再否则按消息。
      return larkGroupScopeId(event);
  }
}

/**
 * 一条持久化会话是否属于「当前 App + 聊天 + scope」。
 *
 * 普通消息（{@link resolveLarkSession}）与聊天命令（/status、/new）必须用同一份判据，
 * 否则会出现「/new 说没有绑定会话、下一条消息却复用了旧上下文」这种自相矛盾的行为。
 * 判据刻意不含 state：命令需要能看见失败/已停止的会话并如实报告，是否可复用由调用方决定。
 */
export const larkSessionMatchesScope = (session: Session, config: StoredLarkConfig, sourceId: string, launchSessionId?: string) =>
  session.source === 'lark'
  && session.sourceId === sourceId
  && (session.id === launchSessionId || config.managedGroup || session.agentId === config.defaultAgentId)
  && !session.archivedAt
  && (session.id === launchSessionId || config.managedGroup || !config.workspace || (session.workspaceSourceCwd ?? session.cwd) === config.workspace)
  && (session.id === launchSessionId || config.managedGroup || !config.defaultModel || session.model === config.defaultModel)
  && Boolean(session.id === launchSessionId || config.managedGroup || !config.defaultReasoningEffort || session.reasoningEffort === config.defaultReasoningEffort);

/**
 * 只读定位当前上下文的持久化会话，供聊天命令在 coordinator 重建后使用。
 *
 * 与 {@link resolveLarkSession} 的区别：不创建、不停止、不写 group 绑定，
 * 并且**允许**返回 failed/stopped 的会话——/status 要如实报告状态，
 * /new 要能真正结束它。取最近创建的一条，绝不跨话题/用户/App/Web 会话或归档会话。
 */
export async function findPersistedLarkSession(
  runtime: LarkRuntime,
  config: StoredLarkConfig,
  chatId: string,
  chatType: LarkMessageEvent['chatType'],
  scopeId: string,
  mappings?: ChannelMappingRepository
): Promise<Session | undefined> {
  const sessions = await listPersistedLarkSessions(runtime, config, chatId, chatType, scopeId, mappings);
  return sessions[sessions.length - 1];
}

/**
 * 当前上下文里**全部**持久化会话，按创建顺序返回。
 *
 * /new 需要它：只看最近一条不够——最近一条可能已经是 stopped，而更早那条 idle
 * 仍会被下一条普通消息选回来，「已结束当前会话」就成了假话。
 */
export async function listPersistedLarkSessions(
  runtime: LarkRuntime,
  config: StoredLarkConfig,
  chatId: string,
  chatType: LarkMessageEvent['chatType'],
  scopeId: string,
  mappings?: ChannelMappingRepository
): Promise<Session[]> {
  if (!runtime.listSessions || !config.defaultAgentId) return [];
  const sourceId = larkSourceId(config, chatId, chatType, scopeId);
  const binding = await mappings?.get(`lark-launch:${config.appId}`, sourceId);
  const launch = binding?.channel === `lark-launch:${config.appId}` && binding.externalId === sourceId ? binding : undefined;
  const sessions = await runtime.listSessions();
  return sessions.filter(session => larkSessionMatchesScope(session, config, sourceId, launch?.sessionId));
}

export async function resolveLarkSession(
  runtime: LarkRuntime,
  log: ListenerLog,
  group: LarkGroup,
  config: StoredLarkConfig,
  chatId: string,
  chatType: LarkMessageEvent['chatType'],
  scopeId: string,
  mappings?: ChannelMappingRepository,
  launchOptions?: LarkLaunchOptions
): Promise<Session> {
  if (!config.defaultAgentId) throw new LarkServiceError('LARK_AGENT_CONFIG_REQUIRED', '机器人尚未配置默认 Agent，请在 Dutydeck 飞书设置的“Agent 与风险控制”中完成配置。', 409);
  if (!larkExecutionConfirmed(config)) throw new LarkServiceError('LARK_FULL_TRUST_CONFIRMATION_REQUIRED', '飞书无人值守任务尚未获得完全信任确认，请在 Dutydeck 飞书设置中确认后重试。', 409);
  const stopForConfiguration = async (session: Session) => {
    if (['thinking', 'running_tool', 'waiting_for_permission', 'interrupting'].includes(session.state)
      || (await runtime.getTasks?.(session.id))?.some(task => ['queued', 'running'].includes(task.status))) {
      throw new LarkServiceError('LARK_CONFIGURATION_BUSY', '当前会话仍有任务。请等待结束或取消任务后，再应用新的 Agent 或审批模式。', 409);
    }
    if (!runtime.stop) throw new LarkServiceError('LARK_CONFIGURATION_UNSUPPORTED', '当前运行时无法结束旧会话以应用配置。', 409);
    await runtime.stop(session.id);
  };
  const compatible = (session: Session) => session.permissionMode === larkPermissionMode(config)
    && (larkPermissionMode(config) !== 'ask' || session.protocol === 'acp');
  const configKey = larkSessionConfigKey(config);
  const sourceId = larkSourceId(config, chatId, chatType, scopeId);
  const binding = await mappings?.get(`lark-launch:${config.appId}`, sourceId);
  const launch = binding?.channel === `lark-launch:${config.appId}` && binding.externalId === sourceId ? binding : undefined;
  const launchConfigKey = launch?.extra ? (JSON.parse(launch.extra) as { baseConfigKey?: string }).baseConfigKey : undefined;
  const launchCompatible = (session: Session) => session.id !== launch?.sessionId || launchConfigKey === configKey;
  const saveLaunchBinding = async (session: Session) => {
    if (!launchOptions && !launch) return;
    if (launch?.sessionId === session.id && launchConfigKey === configKey) return;
    try {
      if (!mappings) throw new Error('当前运行时不支持保存首轮会话配置。');
      await mappings.save({ id: `lark-launch:${sourceId}`, channel: `lark-launch:${config.appId}`, externalId: sourceId,
        sessionId: session.id, extra: JSON.stringify({ baseConfigKey: configKey }), createdAt: new Date().toISOString() });
    } catch (error) {
      await runtime.stop?.(session.id);
      throw error;
    }
  };
  const requestedConfig = launchOptions ? { ...config, workspace: launchOptions.cwd ?? config.workspace,
    defaultModel: launchOptions.model ?? config.defaultModel, defaultReasoningEffort: launchOptions.reasoningEffort ?? config.defaultReasoningEffort } : config;
  const matchesRequest = (session: Session) => larkSessionMatchesScope(session, launchOptions ? { ...requestedConfig, managedGroup: undefined } : config, sourceId, launchOptions ? undefined : launch?.sessionId);
  if (group.sessionId && !group.retiredSessionIds?.has(group.sessionId)) {
    const existing = await runtime.getSession(group.sessionId);
    const reusable = existing && !['failed', 'stopped'].includes(existing.state);
    if (reusable && (config.managedGroup || group.sessionConfigKey === configKey)) {
      if (compatible(existing) && launchCompatible(existing) && (!launchOptions || matchesRequest(existing))) {
        await saveLaunchBinding(existing);
        return existing;
      }
      log.info({ sessionId: existing.id, appId: config.appId, chatId }, '飞书权限姿态已变更，停止旧 Session 并创建新运行');
      await stopForConfiguration(existing);
    }
    if (reusable && !config.managedGroup && group.sessionConfigKey !== configKey) {
      log.info({ sessionId: existing.id, appId: config.appId, chatId }, '飞书 Agent 配置已变更，停止旧 Session 并应用新配置');
      await stopForConfiguration(existing);
    }
  }
  group.sessionId = undefined;
  group.sessionConfigKey = undefined;
  let retiredLegacy = false;
  if (runtime.listSessions) {
    const sessions = await runtime.listSessions();
    retiredLegacy = sessions.some(item => item.archivedAt && item.state === 'stopped'
      && item.error?.includes(LEGACY_RETIREMENT_NOTICE)
      && item.source === 'lark' && item.sourceId === sourceId);
    // A recovered first turn may have started successfully before its binding was saved.
    const existing = [...sessions].reverse().find(item => matchesRequest(item)
      && !['failed', 'stopped'].includes(item.state)
      // /new 退休掉的会话不得再被复用：runtime.stop 可能尚未落库（会话仍是 idle），
      // 此时并发到达的消息会把用户刚要求结束的上下文重新绑回来。
      && !group.retiredSessionIds?.has(item.id));
    if (existing) {
      if (compatible(existing) && launchCompatible(existing)) {
        await saveLaunchBinding(existing);
        group.sessionId = existing.id;
        group.sessionConfigKey = configKey;
        log.info({ sessionId: existing.id, appId: config.appId, chatId }, '复用已持久化的飞书 Session');
        return existing;
      }
      log.info({ sessionId: existing.id, appId: config.appId, chatId }, '持久化飞书 Session 的权限姿态不匹配，停止旧 Session 并创建新运行');
      await stopForConfiguration(existing);
    }
  }
  const session = await runtime.start({
    agentId: config.defaultAgentId,
    ...(config.workspace ? { cwd: config.workspace } : {}),
    ...(config.defaultModel ? { model: config.defaultModel } : {}),
    ...(config.defaultReasoningEffort ? { reasoningEffort: config.defaultReasoningEffort } : {}),
    ...launchOptions,
    permissionMode: larkPermissionMode(config),
    source: 'lark',
    sourceId
  });
  if (larkPermissionMode(config) === 'ask' && session.protocol !== 'acp') {
    await runtime.stop?.(session.id);
    throw new LarkServiceError('LARK_APPROVAL_UNSUPPORTED', '飞书逐项确认仅支持 ACP Agent；此 Agent 的原生确认需在终端完成。', 422);
  }
  await saveLaunchBinding(session);
  group.sessionId = session.id;
  group.sessionConfigKey = configKey;
  if (retiredLegacy) group.legacyUpgradeSessionId = session.id;
  return session;
}
