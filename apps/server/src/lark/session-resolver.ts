import { redactTraceText } from './secret-redaction.js';
import { larkAgentUnavailableReason } from './agent-fallback.js';
import { larkReliability } from './task-recovery.js';
import { larkMessageAnchor } from './message-anchor.js';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { supportsRemoteApproval, type ChannelMappingRepository, type Session } from '@dutydeck/shared';
import { LEGACY_RETIREMENT_NOTICE } from '@dutydeck/storage';
import { larkHookStatus } from './security-hooks.js';
import type { LarkLaunchOptions } from './new-session.js';
import { larkExecutionConfirmed, larkPermissionMode, type StoredLarkConfig } from './config.js';
import { parseLarkMessageContent, type LarkMessageResource } from './message-content.js';
import { withLarkContextReadTimeout } from './context-read-timeout.js';
import { holdLarkResourceDirectory, larkResourceRoot } from '../resource-retention.js';
import { ResourceRangeError } from './resource-range-download.js';
import { detectImageFormat, gifSequenceHint } from './image-format.js';
import { LarkServiceError, type LarkCardService } from './service.js';
import type { LarkChatMode } from './chat-mode.js';
import type { LarkGroup } from './coordinator.js';
import { parseCardTask } from './persisted-card-task.js';
import type { ListenerLog, LarkMessageEvent, LarkRuntime } from './listener.js';

// 会话路由与资源物化辅助（从 listener.ts 拆分）。Third-party attribution: see THIRD_PARTY_NOTICES.md.
// 路由规则：thread_id 是「是否真在话题里」的权威信号
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

/**
 * 会话的工具确认能否在飞书逐项审批：ACP 会话，或能接权限 hook 的终端模式 CLI（Claude 家族）。
 * 终端模式按会话所属 Agent 的适配器判断；运行时列不出 Agent 时按 Agent ID 当适配器。
 */
async function larkApprovalSupported(runtime: LarkRuntime, session: Session) {
  if (session.protocol === 'acp') return true;
  if (session.protocol !== 'pty-cli') return false;
  const agent = (await runtime.listAgents?.())?.find(item => item.id === session.agentId);
  return supportsRemoteApproval({ id: session.agentId, adapterId: agent?.adapterId, protocol: 'pty-cli' });
}

/** 终端模式 Agent 不支持飞书审批时给出的两条修法。 */
const larkApprovalUnsupported = (config: StoredLarkConfig) => new LarkServiceError('LARK_APPROVAL_UNSUPPORTED',
  `Agent ${config.defaultAgentId} 是终端模式，工具确认只能在终端里点，飞书无法逐项审批。二选一：`
  + `① 改为完全信任：dutydeck settings bot set ${config.appId} permissionMode=full-trust fullTrustConfirmed=true；`
  + '② 换一个支持飞书审批的 Agent（ACP Agent，或 Claude Code 终端模式），在 Dutydeck 飞书设置里修改默认 Agent。', 422);

export const larkReplyContext = (event: LarkMessageEvent) => ({
  // 回复 API 的路径参数只能使用真实的 om_* 消息 ID。回复触发消息即可保留准确的上下文位置。
  messageId: larkMessageAnchor(event),
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
  // 合并转发（merge_forward）消息在 parsePrompt 中保持占位提示，
  // 转发的具体聊天记录由 collectLarkTaskContext 展开为任务参考材料。
  const content = event.messageType === 'post' || event.messageType === 'rich_text'
    ? markSelfRichTextMentions(event.content, botOpenId)
    : event.content;
  const parsed = await parseLarkMessageContent(event.messageType, content, {
    messageId: larkMessageAnchor(event)
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

/** 按文件头识别出的真实扩展名替换文件名扩展名；原文件没有扩展名时直接追加。 */
const withExtension = (fileName: string, extension: string) => {
  const current = extname(fileName);
  return (current ? fileName.slice(0, -current.length) : fileName) + extension;
};

const resourceFailureGuidance = (error: unknown) => {
  if (error instanceof ResourceRangeError) return '请重新提供可完整下载且不超过 512 MiB 的文件。';
  const upstreamCode = error instanceof LarkServiceError ? Number(error.details?.upstreamCode) : undefined;
  if (upstreamCode === 234002 || upstreamCode === 14005) {
    return '该错误通常表示机器人无权访问这条消息所在的会话，或附件已被删除，并非缺少 API scope；请用户重新上传附件，并确认机器人仍在对应会话中。';
  }
  const consoleUrl = error instanceof LarkServiceError && typeof error.details?.consoleUrl === 'string' ? error.details.consoleUrl : undefined;
  return `请管理员确认机器人已开通 \`im:message:readonly\` 权限${consoleUrl ? `，权限配置地址：${consoleUrl}` : ''}；如果权限已开通，请用户重新上传可能已过期或删除的附件。`;
};

const fallbackResourceRoot = larkResourceRoot(':memory:');

export async function materializeLarkResources(messageId: string, prompt: string, resources: LarkMessageResource[], service: Pick<LarkCardService, 'downloadMessageResource' | 'downloadMessageResourceToFile'>, signal?: AbortSignal, retention: { root: string; retain(directory: string): Promise<void> } = { root: fallbackResourceRoot, retain: async () => {} }) {
  signal?.throwIfAborted();
  if (!resources.length) return prompt;
  await mkdir(retention.root, { recursive: true, mode: 0o700 });
  if (!(await lstat(retention.root)).isDirectory() || await realpath(retention.root) !== resolve(retention.root)) throw new Error('Unsafe attachment resource root');
  const directory = await mkdtemp(join(retention.root, `${messageId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}-`));
  const release = holdLarkResourceDirectory(directory);
  try {
    await retention.retain(directory);
    const notes: string[] = [];
    let failedCardImages = 0;
    for (const resource of resources) {
      signal?.throwIfAborted();
      try {
        if (resource.type === 'file') {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const staging = join(directory, `.download-${randomUUID()}`);
          const abort = new AbortController();
          const downloadSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
          const download = service.downloadMessageResourceToFile(messageId, resource.key, staging, downloadSignal);
          try {
            let downloaded: { contentType?: string };
            try { downloaded = await withLarkContextReadTimeout(download, '附件下载', undefined, signal); }
            catch (error) {
              abort.abort(error);
              await download.catch(() => {});
              throw error;
            }
            downloadSignal.throwIfAborted();
            const path = join(directory, safeResourceName(resource, downloaded.contentType));
            await rename(staging, path);
            notes.push(`- ${resource.label}已下载到本地：${path}。请使用本地文件读取工具查看。`);
          } finally { await rm(staging, { force: true }); }
          continue;
        }
        const downloaded = await withLarkContextReadTimeout(readSignal => service.downloadMessageResource(messageId, resource.key, resource.type, readSignal), '附件下载', undefined, signal);
        signal?.throwIfAborted();
        // 图片按文件头识别真实格式：下载接口的 contentType 与资源自带扩展名都可能与实际字节不符。
        let fileName = safeResourceName(resource, downloaded.contentType);
        let gifHint: string | undefined;
        if (resource.type === 'image') {
          const format = detectImageFormat(downloaded.data);
          if (format) {
            fileName = withExtension(fileName, format.extension);
            gifHint = gifSequenceHint(format.mimeType);
          }
        }
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, fileName);
        const staging = join(directory, `.download-${randomUUID()}`);
        try {
          await writeFile(staging, downloaded.data, { mode: 0o600, signal });
          signal?.throwIfAborted();
          await rename(staging, path);
        } finally { await rm(staging, { force: true }); }
        notes.push(`- ${resource.label}已下载到本地：${path}。请使用本地文件读取工具查看。${gifHint ? ` ${gifHint}` : ''}`);
      } catch (error) {
        signal?.throwIfAborted();
        const reason = error instanceof Error ? error.message : String(error);
        // 卡片图片只是附带的配图：汇总成一句，不要求 Agent 逐张向用户道歉。
        if (resource.fromCard) { failedCardImages++; continue; }
        notes.push(`- ${resource.label}下载失败：${reason}。你无法读取该附件；请在回复中明确告知用户。${resourceFailureGuidance(error)}`);
      }
    }
    signal?.throwIfAborted();
    if (failedCardImages) notes.push(`- 卡片图片 ${failedCardImages} 张未能下载，请仅依据卡片文字继续，不必中断任务。`);
    return `${prompt}\n\n[Dutydeck 飞书附件处理结果]\n${notes.join('\n')}`.trim();
  } finally { release(); }
}

/**
 * 计算消息的会话隔离 scope（基于路由决策规则）：
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
      return `thread:${larkMessageAnchor(event)}`;
    }
    return event.chatType;
  }
  // 群聊：root_id + thread_id 同时存在才是真实话题回复，锚点为话题根消息 id（规则 1）。
  if (rootId && threadId) return `thread:${rootId}`;
  // 话题群：顶层消息（含只有 thread_id 的话题种子）一律开新话题（规则 4）。
  if (chatModeResolver) {
    try {
      const mode = await chatModeResolver(config.appId, event.chatId);
      if (mode === 'topic') return `thread:${larkMessageAnchor(event)}`;
    } catch {
      // 群形态查询失败时降级为普通群路由，不能阻塞消息处理。
    }
  }
  // 普通群：按 groupReplyMode 路由（规则 5）；未设置走 dutydeck legacy。
  switch (config.groupReplyMode) {
    case 'new-topic':
      return `thread:${larkMessageAnchor(event)}`;
    case 'chat':
    case 'shared':
      return `chat:${event.chatId}`;
    case 'chat-topic':
      // 顶层平铺；但 omt_ 开头的原生话题种子各自独立会话。
      return threadId?.startsWith('omt_') ? `thread:${larkMessageAnchor(event)}` : `chat:${event.chatId}`;
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

/** A started routing candidate may not yet have its durable launch binding. */
const routingRecoveryConfig = (config: StoredLarkConfig, session: Session): StoredLarkConfig =>
  (session.agentId === config.fallbackAgentId || config.defaultAgentWeights?.some(row => row.agentId === session.agentId))
    ? { ...config, defaultAgentId: session.agentId, ...(session.agentId !== config.defaultAgentId ? { defaultModel: undefined, defaultReasoningEffort: undefined } : {}) }
    : config;

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
  return sessions.filter(session => larkSessionMatchesScope(session, launch ? config : routingRecoveryConfig(config, session), sourceId, launch?.sessionId));
}

/** Draw only when a new primary session is needed; persisted bindings keep later turns sticky. */
export function selectLarkAgent(config: StoredLarkConfig, random = Math.random): string | undefined {
  const rows = config.defaultAgentWeights;
  if (!rows?.length) return config.defaultAgentId;
  let remaining = random() * rows.reduce((total, row) => total + row.weight, 0);
  for (const row of rows) {
    remaining -= row.weight;
    if (remaining < 0) return row.agentId;
  }
  return rows[rows.length - 1]!.agentId;
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
  launchOptions?: LarkLaunchOptions,
  beforeStart?: () => Promise<LarkLaunchOptions>
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
  const compatible = async (session: Session) => session.permissionMode === larkPermissionMode(config)
    && (larkPermissionMode(config) === 'full-trust' || await larkApprovalSupported(runtime, session));
  const configKey = larkSessionConfigKey(config);
  const sourceId = larkSourceId(config, chatId, chatType, scopeId);
  const binding = await mappings?.get(`lark-launch:${config.appId}`, sourceId);
  const launch = binding?.channel === `lark-launch:${config.appId}` && binding.externalId === sourceId ? binding : undefined;
  const launchConfigKey = launch?.extra ? (JSON.parse(launch.extra) as { baseConfigKey?: string }).baseConfigKey : undefined;
  const launchCompatible = (session: Session) => session.id !== launch?.sessionId || launchConfigKey === configKey;
  const saveLaunchBinding = async (session: Session) => {
    if (!launchOptions && !launch && !config.defaultAgentWeights?.length && (!config.fallbackAgentId || session.agentId !== config.fallbackAgentId)) return;
    if (launch?.sessionId === session.id && launchConfigKey === configKey) return;
    try {
      if (!mappings) throw new Error('当前运行时不支持保存首轮会话配置。');
      await mappings.save({ id: `lark-launch:${sourceId}`, channel: `lark-launch:${config.appId}`, externalId: sourceId,
        sessionId: session.id, extra: JSON.stringify({ baseConfigKey: configKey, explicitAgent: Boolean(explicitAgentId && !launchOptions?.automaticFallback) }), createdAt: new Date().toISOString() });
    } catch (error) {
      await runtime.stop?.(session.id);
      throw error;
    }
  };
  // A model/effort without --agent was validated against the configured default Agent.
  const explicitAgentId = launchOptions?.agentId ?? (launchOptions?.model || launchOptions?.reasoningEffort || launchOptions?.nativeForkSessionId ? config.defaultAgentId : undefined);
  const useAgentDefaults = launchOptions?.useAgentDefaults || (explicitAgentId && explicitAgentId !== config.defaultAgentId);
  const requestedConfig = launchOptions ? { ...config, workspace: launchOptions.cwd ?? config.workspace,
    defaultAgentId: explicitAgentId ?? config.defaultAgentId,
    defaultModel: useAgentDefaults ? launchOptions.model : launchOptions.model ?? config.defaultModel, defaultReasoningEffort: useAgentDefaults ? launchOptions.reasoningEffort : launchOptions.reasoningEffort ?? config.defaultReasoningEffort } : config;
  const matchesRequest = (session: Session) => {
    // A process may have started before its launch binding was committed. Recover only
    // current routing candidates within this exact scope, without another random draw.
    const expected = !launch && !explicitAgentId ? routingRecoveryConfig(requestedConfig, session) : requestedConfig;
    return larkSessionMatchesScope(session, launchOptions ? { ...expected, managedGroup: undefined } : expected, sourceId, launchOptions && explicitAgentId ? undefined : launch?.sessionId)
      && (!launchOptions?.cwd || (session.workspaceSourceCwd ?? session.cwd) === launchOptions.cwd);
  };

  // 旧会话没能沿用的原因，新建会话时写进首卡。/new 结束的会话登记在 retiredSessionIds 里，不算意外。
  let replacedReason: string | undefined;
  if (group.sessionId && !group.retiredSessionIds?.has(group.sessionId)) {
    const existing = await runtime.getSession(group.sessionId);
    const reusable = existing && !['failed', 'stopped'].includes(existing.state);
    if (existing && !reusable) replacedReason = endedSessionReason(existing);
    if (reusable && (config.managedGroup || group.sessionConfigKey === configKey)) {
      if (await compatible(existing) && launchCompatible(existing) && (!launchOptions || matchesRequest(existing))) {
        await saveLaunchBinding(existing);
        return existing;
      }
      log.info({ sessionId: existing.id, appId: config.appId, chatId }, '飞书权限姿态已变更，停止旧 Session 并创建新运行');
      await stopForConfiguration(existing);
      replacedReason = configChangedReason;
    }
    if (reusable && !config.managedGroup && group.sessionConfigKey !== configKey) {
      log.info({ sessionId: existing.id, appId: config.appId, chatId }, '飞书 Agent 配置已变更，停止旧 Session 并应用新配置');
      await stopForConfiguration(existing);
      replacedReason = configChangedReason;
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
      if (await compatible(existing) && launchCompatible(existing)) {
        await saveLaunchBinding(existing);
        group.sessionId = existing.id;
        group.sessionConfigKey = configKey;
        log.info({ sessionId: existing.id, appId: config.appId, chatId }, '复用已持久化的飞书 Session');
        return existing;
      }
      log.info({ sessionId: existing.id, appId: config.appId, chatId }, '持久化飞书 Session 的权限姿态不匹配，停止旧 Session 并创建新运行');
      await stopForConfiguration(existing);
      replacedReason = configChangedReason;
    }
    // 重启后没有内存绑定：看本 scope 最近一条会话为什么没被选中。还活着却没选中，只能是配置对不上了。
    const previous = [...sessions].reverse().find(item => item.source === 'lark' && item.sourceId === sourceId && !item.archivedAt);
    if (!replacedReason && previous && !group.retiredSessionIds?.has(previous.id)) {
      replacedReason = ['failed', 'stopped'].includes(previous.state) ? endedSessionReason(previous) : configChangedReason;
    }
  }
  // Revalidate restored first-turn options before choosing an Agent or starting a process.
  if (beforeStart) launchOptions = await beforeStart();
  let agentId = launchOptions?.agentId ?? (launchOptions?.model || launchOptions?.reasoningEffort || launchOptions?.nativeForkSessionId
    ? config.defaultAgentId : selectLarkAgent(config));
  let fallbackNote: string | undefined;
  let automaticFallback = false;
  const canFallback = !explicitAgentId && !launchOptions?.useAgentDefaults && config.fallbackAgentId && config.fallbackAgentId !== agentId;
  const start = async (): Promise<Session> => {
    const reliability = larkReliability(runtime);
    const known = reliability.getAgentAvailability?.(agentId!)
      ? await reliability.checkAgentAvailability?.(agentId!).catch(() => reliability.getAgentAvailability?.(agentId!)) : undefined;
    if (known) throw new LarkServiceError('AGENT_UNAVAILABLE', known.reason, 503);
    const agents = await runtime.listAgents?.();
    const configuredAgent = agents?.find(item => item.id === agentId);
    const executionConfig = { ...config, defaultAgentId: agentId };
    if (agents && !configuredAgent) throw new LarkServiceError('LARK_AGENT_NOT_FOUND', `Agent「${agentId}」不存在，可能随提供它的插件停用或卸载了。请在 Dutydeck 飞书设置的“Agent 与风险控制”中改选其他 Agent。`, 409);
    if (larkPermissionMode(config) !== 'full-trust' && configuredAgent?.protocol === 'pty-cli'
      && !supportsRemoteApproval({ id: configuredAgent.id, adapterId: configuredAgent.adapterId, protocol: 'pty-cli' })) throw larkApprovalUnsupported(executionConfig);
    if (config.riskControlMode === 'enforced') {
      const hook = await larkHookStatus(agentId, launchOptions?.cwd ?? config.workspace, configuredAgent);
      if (!hook.supported || !hook.installed || !hook.writable || hook.nativeReady === false) throw new LarkServiceError('RISK_CONTROL_HOOK_NOT_READY', hook.reason ?? `Agent ${agentId} 尚未配置可写 Hook。`, 409);
    }
    const inheritModel = agentId === config.defaultAgentId && !launchOptions?.useAgentDefaults;
    const session = await runtime.start({
      ...(config.workspace ? { cwd: config.workspace } : {}),
      ...(inheritModel && config.defaultModel ? { model: config.defaultModel } : {}),
      ...(inheritModel && config.defaultReasoningEffort ? { reasoningEffort: config.defaultReasoningEffort } : {}),
      ...launchOptions,
      ...(automaticFallback && config.fallbackModel ? { model: config.fallbackModel } : {}),
      agentId: agentId!,
      permissionMode: larkPermissionMode(config),
      source: 'lark',
      sourceId
    });
    if (larkPermissionMode(config) !== 'full-trust' && !await larkApprovalSupported(runtime, session)) {
      await runtime.stop?.(session.id);
      throw larkApprovalUnsupported(config);
    }
    return session;
  };
  let session: Session;
  try { session = await start(); }
  catch (error) {
    const reason = larkAgentUnavailableReason(error);
    if (!canFallback || !reason) throw error;
    const primary = agentId;
    agentId = config.fallbackAgentId;
    automaticFallback = true;
    try { session = await start(); }
    catch (fallbackError) {
      const detail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new LarkServiceError('LARK_AGENT_FALLBACK_FAILED', `主 Agent ${primary} 不可用（${redactTraceText(reason).slice(0, 200)}）；兜底 Agent ${agentId} 启动失败：${redactTraceText(detail).slice(0, 200)}`, 503);
    }
    fallbackNote = `Agent ${primary} 不可用，已切换到兜底 Agent ${agentId}（${redactTraceText(reason).slice(0, 200)}）。使用新会话，原生对话历史未迁移。`;
  }
  await saveLaunchBinding(session);
  group.sessionId = session.id;
  group.sessionConfigKey = configKey;
  if (retiredLegacy) group.legacyUpgradeSessionId = session.id;
  // 带首轮参数说明是 /new 主动要求的新会话；升级退休另有注记。
  if (fallbackNote) newSessionNotes.set(session, fallbackNote);
  else if (replacedReason && !launchOptions && !retiredLegacy) newSessionNotes.set(session, `已开新会话（${replacedReason}）。`);
  return session;
}

const configChangedReason = '机器人配置已变更';
const endedSessionReason = (session: Session) => session.state === 'failed' ? '原会话已异常结束' : '原会话已被停止';
const newSessionNotes = new WeakMap<Session, string>();

/**
 * 取走 {@link resolveLarkSession} 这次意外新建会话的首卡注记。
 * 按返回的 Session 对象记，只有拿到这次返回值的那一轮能取到，取走即清，后续轮次不再重复。
 */
export const takeLarkNewSessionNote = (session: Session) => {
  const note = newSessionNotes.get(session);
  newSessionNotes.delete(session);
  return note;
};

/**
 * 普通群的话题是否续接发起人自己的顶层任务；是则返回那条任务所在、仍可沿用的会话。
 *
 * 顶层消息按发送人、话题按话题各自建会话（见 {@link larkGroupScopeId}）。发起人改在自己顶层任务
 * 消息的话题里回复时，不续接就会开一个空白会话，原来的上下文和等待中的提问都接不上。
 * 对应关系只认任务卡映射：话题根就是那条任务消息，映射记着它跑在哪个会话里。任何一环查不到都
 * 返回 undefined，调用方按原逻辑给话题新建会话。话题已有自己的会话时不续接。
 * 续接后话题共享这个会话：别人的消息在进程内跟着 group 绑定走，重启后靠话题里已经跑在
 * 这个会话上的任务卡认回来。托管群、话题群（顶层本来就是话题作用域）与私聊都不涉及。
 */
export async function findLarkThreadContinuation(
  runtime: LarkRuntime,
  config: StoredLarkConfig,
  event: LarkMessageEvent,
  scopeId: string,
  mappings?: ChannelMappingRepository
): Promise<Session | undefined> {
  const rootId = trimmed(event.rootId);
  if (event.chatType !== 'group' || config.managedGroup || !mappings || !runtime.listSessions
    || !rootId || !trimmed(event.threadId) || scopeId !== `thread:${rootId}`) return undefined;
  const channel = `lark-card:${config.appId}`;
  const root = await mappings.get(channel, rootId);
  if (root?.channel !== channel || root.externalId !== rootId || !root.extra) return undefined;
  const task = parseCardTask(root.extra);
  const owner = task.sender_open_id;
  if (task.app_id !== config.appId || task.chat_id !== event.chatId || task.chat_type !== 'group' || task.thread_id
    || !owner || task.scope_id !== `user:${owner}`) return undefined;
  const threadSourceId = larkSourceId(config, event.chatId, 'group', scopeId);
  if ((await runtime.listSessions()).some(item => item.source === 'lark' && item.sourceId === threadSourceId && !item.archivedAt)) return undefined;
  // 与顶层消息复用会话同一份判据：会话结束了、配置或权限姿态对不上了，话题也不续接。
  const session = (await listPersistedLarkSessions(runtime, config, event.chatId, 'group', task.scope_id, mappings))
    .find(item => item.id === root.sessionId);
  const mode = larkPermissionMode(config);
  if (!session || ['failed', 'stopped'].includes(session.state)
    || session.permissionMode !== mode || (mode !== 'full-trust' && !await larkApprovalSupported(runtime, session))) return undefined;
  if (event.senderOpenId === owner) return session;
  const continued = (await mappings.list(channel)).some(row => {
    if (row.sessionId !== session.id || !row.extra) return false;
    const saved = parseCardTask(row.extra);
    return saved.app_id === config.appId && saved.chat_id === event.chatId && saved.scope_id === scopeId;
  });
  return continued ? session : undefined;
}
