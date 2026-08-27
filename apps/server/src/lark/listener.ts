import * as lark from '@larksuiteoapi/node-sdk';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { AgentEvent, ChannelMappingRepository, PermissionMode, Session, TaskRecord, ToolRiskPolicy } from '@dockmux/shared';
import { defaultHighRiskPattern, defaultLarkTraceLimit, type StoredLarkConfig } from './config.js';
import { parseLarkMessageContent, type LarkMessageResource } from './message-content.js';
import { boundLarkCardElements, createLarkCardService, larkIdentityPermissionHelp, LarkServiceError, type LarkCardService } from './service.js';

type ListenerLog = {
  info(details: unknown, message?: string): void;
  warn(details: unknown, message?: string): void;
  error(details: unknown, message?: string): void;
};

export interface LarkRuntime {
  start(input: { agentId: string; cwd?: string; model?: string; reasoningEffort?: string; permissionMode?: PermissionMode; source?: string; sourceId?: string }): Promise<Session>;
  listSessions?(): Promise<Session[]>;
  getSession(id: string): Promise<Session | undefined>;
  stop?(id: string): Promise<unknown>;
  setPermissionMode?(id: string, mode: PermissionMode): Promise<Session>;
  send(id: string, prompt: string, agentPrompt?: string): Promise<unknown>;
  dispatch?(id: string, prompt: string, mode?: 'queue' | 'interrupt', agentPrompt?: string, riskPolicy?: ToolRiskPolicy): Promise<{ id: string; status: string; queuedAhead?: number }>;
  getTasks?(id: string): Promise<TaskRecord[]>;
  getEvents?(id: string, afterSequence?: number): Promise<AgentEvent[]>;
  getRecentEvents?(id: string, limit: number): Promise<AgentEvent[]>;
  interrupt(id: string): Promise<unknown>;
  cancelQueued?(id: string, taskId: string): Promise<unknown>;
  setRiskPolicy?(id: string, policy?: ToolRiskPolicy): Promise<unknown>;
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

type TraceEntry = { type: AgentEvent['type']; data: Record<string, any>; timestamp: string };
type TraceGroup = { narratives: TraceEntry[]; actions: TraceEntry[] };
type LarkCardElement = Record<string, any>;
type LarkGroup = { sessionId?: string; sessionConfigKey?: string; tail: Promise<void> };
type LarkTaskState = 'queued' | 'running' | 'interrupting' | 'interrupted' | 'completed' | 'failed';
type LarkTask = {
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
  interruptRequested?: boolean;
  requestUpdate?: (state: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted', completed?: boolean) => Promise<void>;
  retryable?: boolean;
  /** 递增的轮次编号，用于防止上一轮的终态回调覆盖重试后的新状态。 */
  turn: number;
};
type PersistedLarkCardTask = {
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
};
const acknowledgementEmojis = ['OK', 'THUMBSUP', 'FINGERHEART', 'APPLAUSE', 'JIAYI', 'SMILE'] as const;

const larkCardChannel = (appId: string) => `lark-card:${appId}`;
const terminalTaskStates = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
const persistedCardTask = (value?: string | null): PersistedLarkCardTask | undefined => {
  if (!value) return;
  try {
    const parsed = JSON.parse(value) as Partial<PersistedLarkCardTask>;
    if (!parsed.app_id || !parsed.chat_id || !parsed.card_message_id || !parsed.task_name || !parsed.state || !Number.isFinite(parsed.started_at)) return;
    return parsed as PersistedLarkCardTask;
  } catch { return; }
};

const larkSessionConfigKey = (config: StoredLarkConfig) => JSON.stringify([
  config.defaultAgentId ?? null,
  config.defaultModel ?? null,
  config.defaultReasoningEffort ?? null,
  config.workspace ?? null
]);

// 群聊不能按 chat_id 复用同一个 Agent 会话，否则不同话题/提问人的历史和预注入 Prompt 会串在一起。
// 话题群优先按 thread_id 隔离，让同一话题内的连续追问复用同一会话；普通群聊没有 thread_id 时再按发送人隔离。
const larkGroupScopeId = (event: LarkMessageEvent) => {
  if (event.chatType !== 'group') return event.chatType;
  const thread = event.threadId?.trim();
  if (thread) return `thread:${thread}`;
  const actor = event.senderOpenId?.trim();
  if (actor) return `user:${actor}`;
  return `message:${event.messageId}`;
};

const larkGroupKey = (event: LarkMessageEvent) => `${event.chatId}:${larkGroupScopeId(event)}`;

const larkReplyContext = (event: LarkMessageEvent) => ({
  // 回复 API 的路径参数只能使用真实的 om_* 消息 ID。回复触发消息即可保留准确的上下文位置。
  messageId: event.messageId,
  // thread_id 只用于识别话题和隔离 Agent 会话，不可作为回复 API 的 messageId。
  ...(event.threadId?.trim() ? { replyInThread: true } : {})
});

const larkSourceId = (config: StoredLarkConfig, chatId: string, chatType: string, scopeId: string) => {
  const base = `${config.appId}:${chatId}:${chatType}`;
  // sourceId 会持久化到 runtime session；群聊追加 scopeId 后，私聊仍保持旧格式，群聊则能按话题或发送人复用会话。
  return chatType === 'group' ? `${base}:${scopeId}` : base;
};

async function parsePrompt(event: LarkMessageEvent) {
  // 合并转发（merge_forward）消息不自动展开，只返回带 message_id 的占位提示；
  // Agent 如需查看转发内容，可通过群协作工具按 message_id 拉取。
  const parsed = await parseLarkMessageContent(event.messageType, event.content, {
    messageId: event.messageId
  });
  let text = parsed.text;
  for (const mention of event.mentions) {
    text = text.replaceAll(mention.key, '').replace(new RegExp(`@${mention.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), '');
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

export const isLarkMessageRateLimit = (error: unknown): error is LarkServiceError => error instanceof LarkServiceError
  && Number(error.details?.upstreamCode) === 230020;

export const larkRateLimitBackoffMs = (failures: number) => Math.min(60_000, 5_000 * (2 ** Math.max(0, failures - 1)));

export const isLarkCardContentRejected = (error: unknown): error is LarkServiceError => error instanceof LarkServiceError
  && [230028, 230099].includes(Number(error.details?.upstreamCode));

export const isLarkMessageUnupdatable = (error: unknown): error is LarkServiceError => error instanceof LarkServiceError
  && [230012, 230030].includes(Number(error.details?.upstreamCode));

const rejectedDeltaElement = (changedCount: number): LarkCardElement => ({
  tag: 'markdown',
  element_id: 'dockmux_rejected_delta',
  content: `<font color='orange'>本次新增或变化的 ${Math.max(1, changedCount)} 个内容区块未通过飞书审核，已保留上一次成功内容；完整增量请在 Dockmux Web 查看。</font>`,
  text_size: 'notation',
  margin: '8px 0px 0px 0px'
});

export function patchRejectedCardDelta(previous: LarkCardElement[] = [], current: LarkCardElement[] = []): LarkCardElement[] {
  const baseline = previous.filter(element => element.element_id !== 'dockmux_rejected_delta');
  const same = (left: LarkCardElement, right: LarkCardElement) => JSON.stringify(left) === JSON.stringify(right);
  let prefix = 0;
  while (prefix < baseline.length && prefix < current.length && same(baseline[prefix]!, current[prefix]!)) prefix++;
  let suffix = 0;
  while (
    suffix < baseline.length - prefix
    && suffix < current.length - prefix
    && same(baseline[baseline.length - 1 - suffix]!, current[current.length - 1 - suffix]!)
  ) suffix++;
  const previousChangedEnd = baseline.length - suffix;
  const currentChangedCount = Math.max(1, current.length - prefix - suffix);
  return boundLarkCardElements([
    ...baseline.slice(0, prefix),
    ...baseline.slice(prefix, previousChangedEnd),
    rejectedDeltaElement(currentChangedCount),
    ...(suffix ? current.slice(current.length - suffix) : [])
  ]);
}

async function materializeLarkResources(messageId: string, prompt: string, resources: LarkMessageResource[], service: Pick<LarkCardService, 'downloadMessageResource'>) {
  if (!resources.length) return prompt;
  const directory = join(tmpdir(), 'dockmux', 'lark-resources', messageId.replace(/[^a-zA-Z0-9_-]/g, '_'));
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
  return `${prompt}\n\n[Dockmux 飞书附件处理结果]\n${notes.join('\n')}`.trim();
}

// 群消息统一回复触发消息；话题消息显式 reply_in_thread，避免卡片脱离提问人的话题。
async function sendTaskCard(
  service: Pick<LarkCardService, 'send' | 'reply'>,
  event: LarkMessageEvent,
  input: Omit<Parameters<LarkCardService['send']>[0], 'chatId'>,
  log?: { warn: (...args: any[]) => void }
) {
  if (event.chatType === 'group' && typeof service.reply === 'function') {
    try {
      return await service.reply({ ...larkReplyContext(event), ...input });
    } catch (error) {
      // 回复触发消息失败（例如消息已被删除）时，回退为群内发送，保证卡片仍能送达。
      log?.warn({ error, messageId: event.messageId, chatId: event.chatId }, '回复卡片失败，回退为群内发送');
      return await service.send({ chatId: event.chatId, ...input });
    }
  }
  return await service.send({ chatId: event.chatId, ...input });
}

// 进程重启后的 reconciliation 可能无法更新原 running 卡片，只能补发终态卡片。
// 持久化真实 reply_message_id 和话题标记，让进程重启后的终态补发仍回到原话题。
// 旧 root_message_id 仅在确实是 om_* 消息 ID 时兼容；omt_* 不能传给回复接口。
async function sendPersistedTaskCard(
  service: Pick<LarkCardService, 'send' | 'reply'>,
  persisted: Pick<PersistedLarkCardTask, 'chat_id' | 'reply_message_id' | 'reply_in_thread' | 'root_message_id'>,
  input: Omit<Parameters<LarkCardService['send']>[0], 'chatId'>,
  log?: { warn: (...args: any[]) => void }
) {
  const replyMessageId = persisted.reply_message_id?.trim()
    || (persisted.root_message_id?.trim().startsWith('om_') ? persisted.root_message_id.trim() : undefined);
  if (replyMessageId && typeof service.reply === 'function') {
    try {
      return await service.reply({ messageId: replyMessageId, ...(persisted.reply_in_thread ? { replyInThread: true } : {}), ...input });
    } catch (error) {
      // The original message may have been deleted while Dockmux was down.
      // Keep reconciliation deliverable by falling back to a top-level card.
      log?.warn({ error, messageId: replyMessageId, chatId: persisted.chat_id }, '恢复卡片回复失败，回退为群内发送');
    }
  }
  return await service.send({ chatId: persisted.chat_id, ...input });
}

function compactTrace(events: AgentEvent[]): TraceEntry[] {
  const result: TraceEntry[] = [];
  const tools = new Map<string, TraceEntry>();
  for (const event of events) {
    if (event.type === 'task' || event.type === 'completed' || event.type === 'status') continue;
    const data = event.data && typeof event.data === 'object' ? event.data as Record<string, any> : { value: event.data };
    if (event.type === 'text' && data.role === 'user') continue;
    if (event.type === 'raw_terminal' && typeof data.text === 'string') {
      try {
        const raw = JSON.parse(data.text);
        if (raw && typeof raw === 'object' && raw.type === 'status') continue;
      } catch { /* Non-JSON terminal output remains a visible execution record. */ }
    }
    const previous = result.at(-1);
    const role = data.role ?? 'assistant';
    if ((event.type === 'text' || event.type === 'thinking') && previous?.type === event.type && (previous.data.role ?? 'assistant') === role) {
      previous.data.text = `${previous.data.text ?? ''}${data.text ?? ''}`;
      continue;
    }
    if ((event.type === 'tool_call' || event.type === 'tool_result') && data.id) {
      const existing = tools.get(String(data.id));
      if (!existing) {
        const terminal = /completed|failed|error|cancelled|rejected/.test(String(data.status ?? '').toLowerCase()) || event.type === 'tool_result';
        const entry = { type: event.type, data: { ...data, startedAt: data.startedAt ?? event.timestamp, ...(terminal ? { completedAt: data.completedAt ?? event.timestamp } : {}) }, timestamp: event.timestamp };
        tools.set(String(data.id), entry);
        result.push(entry);
        continue;
      }
      const incomingName = String(data.name ?? '').trim();
      const existingName = String(existing.data.name ?? '').trim();
      const incomingGeneric = !incomingName || /^(?:tool|tool call)$/i.test(incomingName);
      existing.type = event.type;
      existing.data = {
        ...existing.data,
        ...data,
        name: incomingGeneric ? existingName || incomingName || 'tool' : incomingName,
        input: data.input ?? existing.data.input,
        output: data.output ?? existing.data.output,
        startedAt: existing.data.startedAt ?? existing.timestamp,
        ...(/completed|failed|error|cancelled|rejected/.test(String(data.status ?? '').toLowerCase()) || event.type === 'tool_result' ? { completedAt: data.completedAt ?? event.timestamp } : {})
      };
      existing.timestamp = event.timestamp;
      continue;
    }
    result.push({ type: event.type, data: { ...data }, timestamp: event.timestamp });
  }
  return result;
}

function eventsForRuntimeTask(events: AgentEvent[], taskId: string) {
  const start = events.findIndex(event => event.type === 'text' && (event.data as any)?.role === 'user' && (event.data as any)?.taskId === taskId);
  if (start < 0) return events;
  const endOffset = events.slice(start + 1).findIndex(event => {
    if (event.type !== 'task') return false;
    const task = (event.data as any)?.task;
    return task?.id === taskId && terminalTaskStates.has(task.status);
  });
  return events.slice(start + 1, endOffset < 0 ? undefined : start + 1 + endOffset);
}

const fenced = (value: unknown) => {
  if (value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return `\n\n\`\`\`text\n${text.replaceAll('```', '``\\`')}\n\`\`\``;
};

const truncate = (value: unknown, limit: number) => {
  const text = (typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}\n…（内容过长，已截断）`;
};
const truncateInline = (value: string, limit = 64) => {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
};
const traceElapsed = (startedAt?: string, completedAt?: string) => {
  if (!startedAt) return '';
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
  const milliseconds = end - start;
  if (milliseconds < 1_000) return `${Math.max(1, Math.round(milliseconds))}ms`;
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
};
const escapeCardInline = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const firstValue = (value: unknown, keys: string[]): string | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  for (const candidate of Object.values(record)) {
    const nested = firstValue(candidate, keys);
    if (nested) return nested;
  }
  return undefined;
};

type TraceToolKind = 'command' | 'read' | 'edit' | 'search' | 'web' | 'git' | 'test' | 'data' | 'agent' | 'tool';

const toolIcon = (kind: TraceToolKind) => ({
  command: 'command_outlined',
  read: 'file-link-text_outlined',
  edit: 'edit_outlined',
  search: 'search_outlined',
  web: 'web-card_outlined',
  git: 'code_outlined',
  test: 'doc-checklist_outlined',
  data: 'data-sheet_outlined',
  agent: 'robot_outlined',
  tool: 'setting_outlined'
}[kind]);

const toolPresentation = (entry: TraceEntry) => {
  const data = entry.data;
  const name = String(data.name ?? data.title ?? '工具').trim();
  const normalized = name.toLowerCase();
  const command = typeof data.input === 'string' ? data.input.trim() : firstValue(data.input, ['command', 'cmd']);
  const url = firstValue(data.input, ['url', 'href']);
  const path = firstValue(data.input, ['path', 'file_path', 'cwd']);
  const description = firstValue(data.input, ['description']) ?? (typeof data.description === 'string' ? data.description.trim() : undefined);
  let action = /^(?:tool|tool call)$/i.test(name) ? '工具调用' : name;
  let kind: TraceToolKind = 'tool';
  const haystack = `${normalized} ${command ?? ''}`;
  if (/\b(?:apply_patch|patch|edit|write|replace|create_file)\b/.test(haystack)) { action = '修改文件'; kind = 'edit'; }
  else if (/\b(?:read|cat|head|tail|sed\s+-n|open_file)\b/.test(haystack)) { action = '读取文件'; kind = 'read'; }
  else if (/\b(?:rg|grep|find|search|glob|query)\b/.test(haystack)) { action = '搜索内容'; kind = 'search'; }
  else if (url || /\b(?:browser|web|fetch|curl|wget|open_url)\b/.test(haystack)) { action = '访问网页'; kind = 'web'; }
  else if (/\bgit\b/.test(haystack)) { action = 'Git 操作'; kind = 'git'; }
  else if (/\b(?:vitest|jest|pytest|go\s+test|pnpm\s+test|npm\s+test|yarn\s+test)\b/.test(haystack)) { action = '运行测试'; kind = 'test'; }
  else if (/\b(?:sqlite|sql|database|postgres|mysql)\b/.test(haystack)) { action = '查询数据'; kind = 'data'; }
  else if (/\b(?:agent|spawn|delegate|group\s+(?:self|peers|messages|send|wait))\b/.test(haystack)) { action = 'Agent 协作'; kind = 'agent'; }
  else if (command || /shell|bash|terminal|exec|command/.test(normalized)) { action = '运行命令'; kind = 'command'; }
  const fullDetail = command ?? url ?? path ?? (/^(?:tool|tool call)$/i.test(name) ? '' : name);
  const detail = truncateInline(fullDetail);
  const status = String(data.status ?? (entry.type === 'tool_result' ? 'completed' : 'running')).toLowerCase();
  const failed = /fail|error|reject|cancel/.test(status);
  const running = /running|pending|started|in_progress/.test(status);
  return {
    kind,
    action,
    description,
    detail,
    statusLabel: failed ? '失败' : running ? '执行中' : '已完成',
    statusColor: failed ? 'yellow' : running ? 'orange' : 'green',
    indicatorColor: failed ? 'trace_failure' : running ? 'trace_running' : 'trace_success',
    elapsed: traceElapsed(data.startedAt ?? entry.timestamp, running ? undefined : data.completedAt ?? entry.timestamp),
    fullDetail,
    input: truncate(data.input, 250),
    output: truncate(data.output, 450)
  };
};

const hasUnresolvedToolCalls = (events: AgentEvent[]) => compactTrace(events).some(entry =>
  (entry.type === 'tool_call' || entry.type === 'tool_result') && toolPresentation(entry).statusLabel === '执行中'
);

const toolPanel = (entry: TraceEntry, index: string | number): LarkCardElement => {
  const tool = toolPresentation(entry);
  const description = escapeCardInline(truncateInline(tool.description || tool.action, 72));
  const detail = escapeCardInline(tool.detail || '');
  const detailSuffix = detail && detail !== description ? `　<font color='grey'>${detail}</font>` : '';
  const elapsedSuffix = tool.elapsed ? `　<font color='grey'>${tool.elapsed}</font>` : '';
  const stateLamp = `<font color='${tool.indicatorColor}'>●</font>　`;
  const sections = [
    tool.fullDetail && tool.fullDetail !== tool.detail && !tool.input ? `**完整内容**\n\n\`\`\`text\n${tool.fullDetail.replaceAll('```', '``\\`')}\n\`\`\`` : '',
    tool.input ? `**输入**\n\n\`\`\`text\n${tool.input.replaceAll('```', '``\\`')}\n\`\`\`` : '',
    tool.output ? `**结果**\n\n\`\`\`text\n${tool.output.replaceAll('```', '``\\`')}\n\`\`\`` : ''
  ].filter(Boolean);
  return {
    tag: 'collapsible_panel', element_id: `trace_tool_${index}`, expanded: false,
    direction: 'vertical', vertical_spacing: '4px', padding: '4px 0px 0px 0px', margin: '0px 0px 0px 20px',
    header: {
      title: { tag: 'markdown', content: `${stateLamp}${description}${detailSuffix}${elapsedSuffix}`, text_size: 'notation', icon: { tag: 'standard_icon', token: toolIcon(tool.kind), color: 'grey' } },
      vertical_align: 'center', icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '12px 12px' },
      icon_position: 'right', icon_expanded_angle: -180
    },
    elements: sections.length
      ? sections.map(content => ({ tag: 'markdown', content, text_size: 'notation', margin: '0px' }))
      : [{ tag: 'markdown', content: '<font color=\'grey\'>暂无可展示的输入或结果</font>', text_size: 'notation', margin: '0px' }]
  };
};

const traceGroups = (entries: TraceEntry[]): TraceGroup[] => {
  const groups: TraceGroup[] = [];
  let narratives: TraceEntry[] = [];
  let actions: TraceEntry[] = [];
  const flush = () => {
    if (narratives.length || actions.length) groups.push({ narratives, actions });
    narratives = [];
    actions = [];
  };
  for (const entry of entries) {
    if (entry.type === 'thinking' || entry.type === 'text') {
      if (actions.length) flush();
      narratives.push(entry);
      continue;
    }
    actions.push(entry);
  }
  flush();
  return groups;
};

const groupDescription = (group: TraceGroup) => {
  const narrative = [...group.narratives].reverse().find(entry => entry.type === 'text') ?? group.narratives.at(-1);
  const assistantNarrative = [...group.narratives].reverse().find(entry => entry.type === 'text');
  const narrativeText = String(assistantNarrative?.data.text ?? '').trim();
  if (narrativeText) return narrativeText;
  const tool = group.actions.find(entry => entry.type === 'tool_call' || entry.type === 'tool_result');
  if (tool) {
    const presentation = toolPresentation(tool);
    return presentation.description || presentation.fullDetail || presentation.action;
  }
  return narrative ? '思考过程' : '执行过程';
};

const groupPanel = (group: TraceGroup, index: number, terminal = false): LarkCardElement => {
  const visibleActions = group.actions;
  const tools = visibleActions.filter(entry => entry.type === 'tool_call' || entry.type === 'tool_result');
  const statuses = tools.map(entry => toolPresentation(entry));
  const failedCount = statuses.filter(item => item.statusLabel === '失败').length;
  const succeededCount = statuses.filter(item => item.statusLabel === '已完成').length;
  const hasErrorEvent = visibleActions.some(entry => entry.type === 'error');
  const status = hasErrorEvent || (failedCount > 0 && succeededCount > 0)
    ? { label: '有失败', color: 'trace_failure' }
    : failedCount > 0 ? { label: '失败', color: 'trace_failure' }
    : statuses.some(item => item.statusLabel === '执行中') ? { label: '执行中', color: 'trace_running' }
      : tools.length ? { label: '已完成', color: 'green' } : terminal ? { label: '已完成', color: 'green' } : { label: '执行中', color: 'trace_running' };
  const thinkingEntries = group.narratives.filter(entry => entry.type === 'thinking' && String(entry.data.text ?? '').trim());
  const actionElements = visibleActions.flatMap((entry, actionIndex): LarkCardElement[] => {
    if (entry.type === 'tool_call' || entry.type === 'tool_result') return [toolPanel(entry, `${index}_${actionIndex}`)];
    if (entry.type === 'permission_request') return [{ tag: 'markdown', content: `**权限请求**　<text_tag color='orange'>${entry.data.status ?? '待处理'}</text_tag>\n\n${truncate(entry.data.title, 800)}`, text_size: 'x-small', margin: '0px' }];
    if (entry.type === 'error') return [{ tag: 'markdown', content: `<text_tag color='yellow'>有错误</text_tag>\n\n${truncate(entry.data.message ?? 'Agent 执行未完全成功', 1_500)}`, text_size: 'x-small', margin: '0px' }];
    if (entry.type === 'raw_terminal') return [toolPanel({ ...entry, type: 'tool_result', data: { ...entry.data, name: 'terminal', output: entry.data.text, status: 'completed' } }, `${index}_${actionIndex}`)];
    return [];
  });
  const preview = escapeCardInline(truncateInline(groupDescription(group), 92));
  const first = group.narratives[0] ?? group.actions[0];
  const last = group.actions.at(-1) ?? group.narratives.at(-1);
  const elapsed = traceElapsed(first?.data.startedAt ?? first?.timestamp, last?.data.completedAt ?? last?.timestamp);
  const elapsedSuffix = elapsed ? `　<font color='grey'>${elapsed}</font>` : '';
  const stateSuffix = `　<font color='${status.color}'>● ${status.label}</font>`;
  const countParts = [thinkingEntries.length ? `${thinkingEntries.length} 段思考` : '', tools.length ? `${tools.length} 次工具调用` : ''].filter(Boolean);
  const summaryElements: LarkCardElement[] = countParts.length ? [{
    tag: 'div', width: 'auto', margin: '0px 0px 2px 0px',
    text: { tag: 'plain_text', content: countParts.join(' · '), text_size: 'notation', text_color: 'grey' },
    icon: { tag: 'standard_icon', token: 'setting_outlined', color: 'grey' }
  }] : [];
  const thinkingElements: LarkCardElement[] = thinkingEntries.map(entry => ({
    tag: 'markdown', content: `**思考过程**　<font color='grey'>${truncate(entry.data.text, 500)}</font>`, text_size: 'notation', margin: '0px 0px 2px 20px',
    icon: { tag: 'standard_icon', token: 'mindnote_outlined', color: 'grey' }
  }));
  return {
    tag: 'collapsible_panel', element_id: `trace_group_${index}`, expanded: false,
    direction: 'vertical', vertical_spacing: '2px', padding: '2px 0px 0px 0px', margin: '0px',
    header: {
      title: { tag: 'markdown', content: `${preview}${elapsedSuffix}${stateSuffix}`, text_size: 'notation' },
      vertical_align: 'center', icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '14px 14px' },
      icon_position: 'right', icon_expanded_angle: -180
    },
    elements: [...summaryElements, ...thinkingElements, ...actionElements]
  };
};

export function renderLarkCardElements(
  events: AgentEvent[],
  config: Pick<StoredLarkConfig, 'traceLimit'>,
  completed = false,
  compensation = false
): LarkCardElement[] {
  const entries = compactTrace(events);
  const lastIndex = (predicate: (entry: TraceEntry) => boolean) => {
    for (let index = entries.length - 1; index >= 0; index--) if (predicate(entries[index]!)) return index;
    return -1;
  };
  const finalMessageIndex = completed ? lastIndex(entry => entry.type === 'text' && entry.data.role !== 'user') : -1;
  // 与 runtime.turnHasFinalAssistantText 保持一致：thinking / 工具 / 权限等都算活动，
  // final 文本必须位于最后一次活动之后。工具调用前的阶段描述不得提升为 final_output。
  const lastActivityIndex = lastIndex(entry => entry.type !== 'text');
  const finalFollowsActivity = finalMessageIndex > lastActivityIndex;
  const finalMessage = finalMessageIndex >= 0 && finalFollowsActivity ? entries[finalMessageIndex] : undefined;
  const finalText = truncate(finalMessage?.data.text, 6_000);
  let activityEntries = entries.filter(entry => entry !== finalMessage || !finalFollowsActivity);
  // 先全量分组，再按 group 数量裁剪。
  // 若在 entry 级别切片，滑动窗口可能切断 group 边界，导致 group 数量随新事件到来而跳变。
  // 按 group 级别裁剪后，group 数量单调递增，超过 traceLimit 时才丢弃最旧的 group，计数稳定。
  const allGroups = traceGroups(activityEntries);
  const groups = config.traceLimit && allGroups.length > config.traceLimit
    ? allGroups.slice(-config.traceLimit)
    : allGroups;
  const elements: LarkCardElement[] = [];

  if (compensation) {
    elements.push({ tag: 'markdown', content: "<font color='orange'>原运行卡片未能更新，Dockmux 已补发终态结果。</font>", text_size: 'notation', margin: '0px 0px 8px 0px' });
  }
  if (finalText) {
    elements.push({ tag: 'markdown', element_id: 'final_output', content: completed ? finalText : `**当前进展**\n\n${finalText}`, text_align: 'left', text_size: 'normal_v2', margin: '0px' });
  } else if (completed) {
    elements.push({ tag: 'markdown', content: "<font color='orange'>Agent 未返回最终输出</font>", text_size: 'notation', margin: '0px' });
  }
  if (groups.length) {
    elements.push(...groups.map((group, index) => groupPanel(group, index, completed)));
  }
  if (!elements.length) elements.push({ tag: 'markdown', content: '正在思考中…', text_size: 'normal', margin: '0px' });
  return elements;
}

export function renderLarkTrace(events: AgentEvent[], config: Pick<StoredLarkConfig, 'traceLimit'>, _completed = false) {
  let entries = compactTrace(events);
  if (config.traceLimit) entries = entries.slice(-config.traceLimit);
  if (!entries.length) return '正在思考中…';
  return entries.map(entry => {
    const data = entry.data;
    if (entry.type === 'text') return `**Agent**\n\n${data.text ?? ''}`;
    if (entry.type === 'thinking') return `**思考**\n\n> ${String(data.text ?? '').replaceAll('\n', '\n> ')}`;
    if (entry.type === 'tool_call' || entry.type === 'tool_result') return `**工具 · ${data.name ?? 'tool'}** · ${data.status ?? (entry.type === 'tool_result' ? 'completed' : 'running')}${fenced(data.output ?? data.input)}`;
    if (entry.type === 'permission_request') return `**权限请求** · ${data.status ?? 'pending'}\n\n${data.title ?? ''}`;
    if (entry.type === 'error') return `**错误**\n\n${data.message ?? 'Agent 执行失败'}`;
    if (entry.type === 'raw_terminal') return `**终端**${fenced(data.text ?? '')}`;
    return '';
  }).filter(Boolean).join('\n\n---\n\n');
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
    private readonly random: () => number = Math.random,
    private readonly botOpenId?: string,
    private readonly peerBotAuthorized?: (chatId: string, senderOpenId: string) => Promise<boolean>,
    private readonly cardMappings?: ChannelMappingRepository
  ) {}

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
    if (!this.cardMappings || !this.runtime.getTasks || !this.runtime.getEvents) return 0;
    const mappings = await this.cardMappings.list(larkCardChannel(config.appId));
    let unresolved = 0;
    for (const mapping of mappings) {
      const persisted = persistedCardTask(mapping.extra);
      if (!persisted || terminalTaskStates.has(persisted.state)) continue;
      let runtimeTasks: TaskRecord[];
      try { runtimeTasks = await this.runtime.getTasks(mapping.sessionId); }
      catch (error) { unresolved++; this.log.warn({ error, sessionId: mapping.sessionId, externalId: mapping.externalId }, '读取待补偿飞书任务失败'); continue; }
      const runtimeTask = (persisted.runtime_task_id ? runtimeTasks.find(item => item.id === persisted.runtime_task_id) : undefined)
        ?? [...runtimeTasks].reverse().find(item => item.prompt === persisted.prompt && Date.parse(item.createdAt) >= persisted.started_at - 5_000);
      if (!runtimeTask || !terminalTaskStates.has(runtimeTask.status)) { unresolved++; continue; }
      let state: 'completed' | 'failed' | 'interrupted' = runtimeTask.status === 'completed'
        ? 'completed'
        : runtimeTask.status === 'failed' ? 'failed' : 'interrupted';
      const recentLimit = Math.max((config.traceLimit ?? defaultLarkTraceLimit) * 30, 500);
      const sessionEvents = await (this.runtime.getRecentEvents?.(mapping.sessionId, recentLimit) ?? this.runtime.getEvents!(mapping.sessionId)).catch(() => []);
      const events = eventsForRuntimeTask(sessionEvents, runtimeTask.id);
      if (state === 'completed' && hasUnresolvedToolCalls(events)) state = 'failed';
      const completed = state === 'completed';
      const elapsedSeconds = Math.max(0, (Date.parse(runtimeTask.updatedAt) - persisted.started_at) / 1_000);
      let updated = false;
      let lastError: unknown;
      let contentRejected = false;
      const currentElements = boundLarkCardElements(renderLarkCardElements(events, config, completed));
      let deliveredElements = currentElements;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this.service.update({
            messageId: persisted.card_message_id,
            state,
            taskId: mapping.externalId,
            taskName: persisted.task_name,
            elapsedSeconds,
            sessionId: mapping.sessionId,
            ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
            elements: currentElements
          });
          updated = true;
          break;
        } catch (error) {
          lastError = error;
          if (isLarkCardContentRejected(error)) { contentRejected = true; break; }
          if (attempt < 3) {
            const delay = isLarkMessageRateLimit(error) ? larkRateLimitBackoffMs(attempt) : attempt * 300;
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }
      if (!updated && contentRejected && Array.isArray(persisted.last_successful_elements) && persisted.last_successful_elements.length) {
        const patchedElements = patchRejectedCardDelta(persisted.last_successful_elements, currentElements);
        try {
          await this.service.update({
            messageId: persisted.card_message_id,
            state,
            taskId: mapping.externalId,
            taskName: persisted.task_name,
            elapsedSeconds,
            sessionId: mapping.sessionId,
            ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
            elements: patchedElements
          });
          updated = true;
          deliveredElements = patchedElements;
          lastError = undefined;
          this.log.warn({ messageId: persisted.card_message_id, state }, '飞书终态卡片增量被拒绝，已保留上次成功内容并原地修补');
        } catch (error) {
          lastError = error;
        }
      }
      let cardMessageId = persisted.card_message_id;
      if (!updated) {
        if (!isLarkMessageUnupdatable(lastError)) {
          this.log.warn({ error: lastError, messageId: persisted.card_message_id }, '飞书原卡暂时更新失败，保留原卡等待下次对账');
          unresolved++;
          continue;
        }
        try {
          const replacementElements = contentRejected
            ? patchRejectedCardDelta(persisted.last_successful_elements, currentElements)
            : boundLarkCardElements(renderLarkCardElements(events, config, completed, true));
          const replacement = await sendPersistedTaskCard(this.service, persisted, {
            state,
            taskId: mapping.externalId,
            taskName: persisted.task_name,
            elapsedSeconds,
            sessionId: mapping.sessionId,
            ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
            elements: replacementElements,
            idempotencyKey: `reconcile_${persisted.card_message_id}_${state}`.slice(0, 50)
          }, this.log);
          cardMessageId = replacement.messageId;
          deliveredElements = replacementElements;
        } catch (error) {
          if (isLarkCardContentRejected(error)) {
            try {
              const patchedElements = patchRejectedCardDelta(persisted.last_successful_elements, currentElements);
              const minimal = await sendPersistedTaskCard(this.service, persisted, {
                state,
                taskId: mapping.externalId,
                taskName: persisted.task_name,
                elapsedSeconds,
                sessionId: mapping.sessionId,
                ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
                elements: patchedElements,
                idempotencyKey: `reconcile_safe_${persisted.card_message_id}_${state}`.slice(0, 50)
              }, this.log);
              cardMessageId = minimal.messageId;
              deliveredElements = patchedElements;
              this.log.warn({ rejectedMessageId: persisted.card_message_id, replacementMessageId: cardMessageId, upstreamCode: error.details?.upstreamCode }, '飞书补发终态卡片内容被拒绝，已降级为最小安全卡片');
            } catch (fallbackError) {
              this.log.error({ error: fallbackError, contentError: error, updateError: lastError, messageId: persisted.card_message_id }, '飞书终态对账最小卡片补偿失败');
              unresolved++;
              continue;
            }
          } else {
            this.log.error({ error, updateError: lastError, messageId: persisted.card_message_id }, '飞书终态对账补偿失败');
            unresolved++;
            continue;
          }
        }
      }
      await this.cardMappings.save({
        ...mapping,
        extra: JSON.stringify({ ...persisted, card_message_id: cardMessageId, runtime_task_id: runtimeTask.id, state, last_successful_elements: deliveredElements })
      });
      this.log.info({ messageId: persisted.card_message_id, replacementMessageId: cardMessageId === persisted.card_message_id ? undefined : cardMessageId, state }, '飞书卡片终态对账完成');
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

  async handle(event: LarkMessageEvent, config: StoredLarkConfig) {
    const mentionsBot = this.botOpenId ? event.mentions.some(mention => mention.openId === this.botOpenId) : event.mentions.some(mention => mention.mentionedType === 'bot');
    const shouldWake = event.chatType === 'p2p' || (event.chatType === 'group' && mentionsBot);
    if (this.stopped || !shouldWake || this.handledMessages.has(event.messageId)) return;
    // 先标记已处理，避免异步解析期间同一条消息被重复入队。
    this.handledMessages.add(event.messageId);
    if (this.handledMessages.size > 5_000) this.handledMessages.delete(this.handledMessages.values().next().value!);
    const { prompt, resources } = await parsePrompt(event);
    // 空 @ 消息（仅 @ 机器人无文字）仍需创建任务，由 runTurn 拉取聊天记录做兜底意图判断。
    const groupKey = larkGroupKey(event);
    const group = this.groups.get(groupKey) ?? { tail: Promise.resolve() };
    const task: LarkTask = { id: event.messageId, group, event, prompt, resources, config, state: 'queued', events: [], turn: 0 };
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
          await task.requestUpdate?.('queued', false).catch(() => undefined);
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
    if (!config.defaultAgentId) throw new LarkServiceError('LARK_AGENT_CONFIG_REQUIRED', '机器人尚未配置默认 Agent，请在 Dockmux 飞书设置的“Agent 与门禁”中完成配置。', 409);
    const configKey = larkSessionConfigKey(config);
    const sourceId = larkSourceId(config, chatId, chatType, scopeId);
    if (group.sessionId) {
      const existing = await this.runtime.getSession(group.sessionId);
      const reusable = existing && !['failed', 'stopped'].includes(existing.state);
      if (reusable && group.sessionConfigKey === configKey) {
        if (existing.permissionMode !== 'full-trust' && this.runtime.setPermissionMode) return this.runtime.setPermissionMode(existing.id, 'full-trust');
        return existing;
      }
      if (reusable && group.sessionConfigKey !== configKey) {
        this.log.info({ sessionId: existing.id, appId: config.appId, chatId }, '飞书 Agent 配置已变更，停止旧 Session 并应用新配置');
        await this.runtime.stop?.(existing.id);
      }
      group.sessionId = undefined;
      group.sessionConfigKey = undefined;
    }
    if (this.runtime.listSessions) {
      const sessions = await this.runtime.listSessions();
      const existing = [...sessions].reverse().find(item => item.source === 'lark'
        && item.sourceId === sourceId
        && item.agentId === config.defaultAgentId
        && !item.archivedAt
        && !['failed', 'stopped'].includes(item.state)
        && (!config.workspace || item.cwd === config.workspace)
        && (!config.defaultModel || item.model === config.defaultModel)
        && (!config.defaultReasoningEffort || item.reasoningEffort === config.defaultReasoningEffort));
      if (existing) {
        group.sessionId = existing.id;
        group.sessionConfigKey = configKey;
        this.log.info({ sessionId: existing.id, appId: config.appId, chatId }, '复用已持久化的飞书 Session');
        if (existing.permissionMode !== 'full-trust' && this.runtime.setPermissionMode) return this.runtime.setPermissionMode(existing.id, 'full-trust');
        return existing;
      }
    }
    const session = await this.runtime.start({
      agentId: config.defaultAgentId,
      ...(config.workspace ? { cwd: config.workspace } : {}),
      ...(config.defaultModel ? { model: config.defaultModel } : {}),
      ...(config.defaultReasoningEffort ? { reasoningEffort: config.defaultReasoningEffort } : {}),
      permissionMode: 'full-trust',
      source: 'lark',
      sourceId
    });
    group.sessionId = session.id;
    group.sessionConfigKey = configKey;
    return session;
  }

  /**
   * 用户仅 @ 机器人而未发送任何文字时，拉取当前会话最近的聊天记录作为上下文，
   * 让 Agent 根据历史判断用户意图；若拉取失败则退化为纯提示，让 Agent 主动询问。
   */
  private async buildEmptyMessageFallback(event: LarkMessageEvent): Promise<string> {
    const fallback = '用户仅 @ 了机器人而未发送任何文字内容。请礼貌地询问用户需要什么帮助。';
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
      return `[Dockmux 空消息兜底]\n用户仅 @ 了机器人而未发送任何文字内容。以下是当前会话最近的聊天记录，请根据上下文判断用户的意图并回复。如果无法判断，请礼貌地询问用户需要什么帮助。\n\n[最近聊天记录]\n${lines.join('\n')}`;
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
    const firstAttempt = !task.cardMessageId;
    const emojiType = acknowledgementEmojis[Math.floor(this.random() * acknowledgementEmojis.length)] ?? acknowledgementEmojis[0];
    let reactionId: string | undefined;
    if (firstAttempt) {
      try {
        reactionId = (await this.service.addReaction(event.messageId, emojiType)).reactionId;
      } catch (error) {
        this.log.warn({ error, messageId: event.messageId }, '发送飞书确认表情失败，继续执行任务');
      }
    }

    let actorEmails: string[] = [];
    const allowedUsers = config.allowedUsers ?? [];
    const allowedEmails = config.allowedEmails ?? [];
    const allowedBots = config.allowedBots ?? [];
    const peerBotsAllowed = config.peerBotsAllowed !== false;
    const highRiskAllowedUsers = config.highRiskAllowedUsers ?? [];
    const highRiskAllowedEmails = config.highRiskAllowedEmails ?? [];
    const highRiskPattern = config.highRiskPattern || defaultHighRiskPattern;
    const gateEnabled = config.gateEnabled === true;
    const botSender = event.senderType === 'app' || event.senderType === 'bot';
    let trustedPeerBot = false;
    if (botSender) {
      try {
        trustedPeerBot = Boolean(config.groupToolsEnabled && event.senderOpenId && await this.peerBotAuthorized?.(event.chatId, event.senderOpenId));
      } catch (error) {
        task.state = 'failed'; task.retryable = false; task.startedAt = Date.now();
        const card = await sendTaskCard(this.service, event, { state: 'failed', retryable: false, taskId: task.id, taskName: 'Agent 协作身份校验失败', markdown: `**无法验证发起交接的 Agent。**\n\n${error instanceof Error ? error.message : String(error)}`, ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) }, this.log);
        task.cardMessageId = card.messageId;
        if (reactionId) await this.service.deleteReaction(event.messageId, reactionId).catch(() => undefined);
        return;
      }
    } else if ((!allowedUsers.length && allowedEmails.length) || (gateEnabled && !highRiskAllowedUsers.length && highRiskAllowedEmails.length)) {
      try {
        if (!event.senderOpenId) throw new Error('消息事件未包含发送人 open_id');
        actorEmails = await this.service.getUserEmails(event.senderOpenId);
        if (!actorEmails.length) throw new LarkServiceError('LARK_SENDER_EMAIL_EMPTY', '飞书没有返回当前发送人的邮箱字段', 409);
      } catch (error) {
        task.state = 'failed'; task.retryable = false; task.startedAt = Date.now();
        const card = await sendTaskCard(this.service, event, { state: 'failed', retryable: false, taskId: task.id, taskName: '身份解析权限缺失', markdown: larkIdentityPermissionHelp(error, config.appId), ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) }, this.log);
        task.cardMessageId = card.messageId;
        if (reactionId) await this.service.deleteReaction(event.messageId, reactionId).catch(() => undefined);
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
      const card = await sendTaskCard(this.service, event, { state: 'failed', retryable: false, taskId: task.id, taskName: '访问被拒绝', markdown: '**当前账号不在机器人白名单中。**\n\n如需使用，请联系机器人管理员添加你。', ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) }, this.log);
      task.cardMessageId = card.messageId;
      if (reactionId) await this.service.deleteReaction(event.messageId, reactionId).catch(() => undefined);
      return;
    }
    const highRiskAuthorized = botSender
      ? false
      : (!gateEnabled || (!highRiskAllowedUsers.length && !highRiskAllowedEmails.length)
          ? allowed
          : highRiskAllowedUsers.length
            ? Boolean(highRiskAllowedUser)
            : actorEmails.some(email => highRiskAllowedEmails.includes(email)));
    const actorEmail = actorEmails[0];
    const riskPolicy: ToolRiskPolicy = {
      enabled: gateEnabled && config.hardGateEnabled,
      authorized: highRiskAuthorized,
      pattern: highRiskPattern,
      ...(actorEmail ? { actorEmail } : {}),
      reason: '当前飞书发送人不在高危操作允许名单中'
    };
    let session: Session;
    try { session = await this.sessionFor(group, config, event.chatId, event.chatType, larkGroupScopeId(event)); }
    catch (error) {
      task.state = 'failed'; task.startedAt = Date.now();
      const markdown = `**Agent 启动失败**\n\n${error instanceof Error ? error.message : String(error)}`;
      const card = await sendTaskCard(this.service, event, { state: 'failed', taskId: task.id, taskName: prompt.slice(0, 80), markdown, ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) }, this.log);
      task.cardMessageId = card.messageId;
      if (reactionId) await this.service.deleteReaction(event.messageId, reactionId).catch(() => undefined);
      return;
    }
    task.sessionId = session.id;
    task.state = 'running';
    task.events = [];
    task.startedAt = Date.now();
    task.interruptRequested = false;
    const initialElements = boundLarkCardElements(renderLarkCardElements([], config));
    if (task.cardMessageId) {
      await this.service.update({ messageId: task.cardMessageId, state: 'running', taskId: task.id, taskName: prompt.slice(0, 80), markdown: '正在思考中…', sessionId: task.sessionId, ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) });
    } else {
      const card = await sendTaskCard(this.service, event, { state: 'running', taskId: task.id, taskName: prompt.slice(0, 80), markdown: '正在思考中…', sessionId: task.sessionId, ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) }, this.log);
      task.cardMessageId = card.messageId;
    }
    task.lastSuccessfulElements = initialElements;
    await this.saveCardTask(task);
    if (reactionId) {
      try { await this.service.deleteReaction(event.messageId, reactionId); }
      catch (error) { this.log.warn({ error, messageId: event.messageId, reactionId }, '撤销飞书确认表情失败'); }
    }

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
                : boundLarkCardElements(renderLarkCardElements(task.events, config, pending.completed, true));
              const replacement = await sendTaskCard(this.service, event, {
                state: pending.input.state,
                taskId: task.id,
                taskName: prompt.slice(0, 80),
                elapsedSeconds: pending.input.elapsedSeconds,
                sessionId: task.sessionId,
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
                    state: pending.input.state,
                    taskId: task.id,
                    taskName: prompt.slice(0, 80),
                    elapsedSeconds: pending.input.elapsedSeconds,
                    sessionId: task.sessionId,
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
          if (delivered && pending.input.state) await this.saveCardTask(task, pending.input.state);
        }
      })().finally(() => {
        updateChain = undefined;
        if (pendingUpdate) void flushUpdates();
      });
      return updateChain;
    };
    const update = (state: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted', completed = false) => {
      if (timer) { clearTimeout(timer); timer = undefined; }
      pendingUpdate = {
        terminal: state !== 'running',
        completed,
        input: {
          messageId: task.cardMessageId!,
          state,
          taskId: task.id,
          taskName: prompt.slice(0, 80),
          elapsedSeconds: (Date.now() - task.startedAt!) / 1_000,
          sessionId: task.sessionId,
          ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
          elements: boundLarkCardElements(renderLarkCardElements(task.events, config, completed))
        }
      };
      return flushUpdates();
    };
    const scheduleHeartbeat = () => {
      if (!heartbeatActive || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void update('running').finally(scheduleHeartbeat);
      }, Math.max(config.pushIntervalMs, cardRateLimitedUntil - Date.now()));
    };
    task.requestUpdate = update;
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
    if (gateEnabled && !highRiskAuthorized) injected.push(`[Dockmux 安全策略 · 自动注入]\n当前飞书发送人不在高危操作允许名单中。禁止执行匹配以下正则的操作，也不要通过脚本、子进程、MCP 或其他等价方式绕过：\n${highRiskPattern}\n如果用户要求此类操作，请明确说明已被 Dockmux 安全策略阻止。`);
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
          await update(resolvedState, resolvedState === 'completed').finally(cleanup);
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
        const runtimeTask = await this.runtime.dispatch(session.id, prompt, 'queue', agentPrompt, riskPolicy);
        runtimeTaskId = runtimeTask.id;
        task.runtimeTaskId = runtimeTask.id;
        await this.saveCardTask(task, runtimeTask.status === 'queued' ? 'queued' : task.state);
        for (const agentEvent of buffered) receive(agentEvent);
        buffered = [];
        if (runtimeTask.status === 'queued' && (runtimeTask.queuedAhead ?? 0) > 0 && task.state === 'queued') {
          await this.service.update({ messageId: task.cardMessageId!, state: 'queued', taskId: task.id, taskName: prompt.slice(0, 80), markdown: `正在排队，前面还有 ${runtimeTask.queuedAhead} 个任务…`, sessionId: task.sessionId, ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) });
          await this.saveCardTask(task, 'queued');
        }
      } catch (error) {
        task.events.push({ id: `lark-error-${event.messageId}`, sessionId: session.id, sequence: Number.MAX_SAFE_INTEGER, type: 'error', timestamp: new Date().toISOString(), data: { message: error instanceof Error ? error.message : String(error) } });
        task.state = 'failed';
        await update('failed', false);
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
      await this.runtime.setRiskPolicy?.(session.id, riskPolicy);
      if (agentPrompt === prompt) await this.runtime.send(session.id, prompt);
      else await this.runtime.send(session.id, prompt, agentPrompt);
      // 若轮次已变（用户在 send 期间点击了重试），本轮不得覆盖新状态。
      if (task.turn !== currentTurn) return;
      if (task.interruptRequested) {
        await update('interrupted', false);
        task.state = 'interrupted';
      } else {
        await update('completed', true);
        task.state = 'completed';
      }
    } catch (error) {
      if (task.turn !== currentTurn) return;
      if (task.interruptRequested) {
        await update('interrupted', false);
        task.state = 'interrupted';
      } else {
        if (!task.events.some(item => item.type === 'error')) task.events.push({ id: `lark-error-${event.messageId}`, sessionId: session.id, sequence: Number.MAX_SAFE_INTEGER, type: 'error', timestamp: new Date().toISOString(), data: { message: error instanceof Error ? error.message : String(error) } });
        await update('failed', false);
        task.state = 'failed';
      }
    } finally {
      heartbeatActive = false;
      if (timer) clearTimeout(timer);
      unsubscribe();
      if (task.turn === currentTurn) task.requestUpdate = undefined;
    }
  }
}

export interface LarkLongConnectionListenerOptions {
  runtime?: LarkRuntime;
  cardMappings?: ChannelMappingRepository;
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof globalThis.fetch;
  peerBotAuthorized?: (appId: string, chatId: string, senderOpenId: string) => Promise<boolean>;
}

export class LarkLongConnectionListener implements LarkListener {
  private client?: lark.WSClient;
  private coordinator?: LarkMessageCoordinator;
  private credentials?: string;
  private config?: StoredLarkConfig;
  listening = false;

  constructor(private readonly log: ListenerLog, private readonly options: LarkLongConnectionListenerOptions = {}) {}

  async start(config: StoredLarkConfig) {
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
    const coordinator = this.options.runtime ? new LarkMessageCoordinator(
      this.options.runtime,
      service,
      this.log,
      Math.random,
      botOpenId,
      (chatId, senderOpenId) => this.options.peerBotAuthorized?.(config.appId, chatId, senderOpenId) ?? Promise.resolve(false),
      this.options.cardMappings
    ) : undefined;
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
        const result = await coordinator?.handleAction(event.action?.value, operatorOpenId);
        if (!result) return;
        return { toast: result };
      }
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
    const enabled = new Map(configs.filter(config => config.listening).map(config => [config.appId, config]));
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
