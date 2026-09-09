import type { AgentEvent } from '@dockmux/shared';
import type { StoredLarkConfig } from './config.js';
import { boundLarkCardElements, LarkServiceError } from './service.js';

// 卡片渲染与限流/拒绝判断辅助。
// 飞书只展示可观察的阶段摘要、工具活动和最终结果；模型 thinking 属于内部推理，
// 只能用于计数和阶段状态判断，不得把原文写入卡片或降级 Markdown。

export type TraceEntry = { type: AgentEvent['type']; data: Record<string, any>; timestamp: string };
export type TraceGroup = { narratives: TraceEntry[]; actions: TraceEntry[] };
export type LarkCardElement = Record<string, any>;
type TraceToolKind = 'command' | 'read' | 'edit' | 'search' | 'web' | 'git' | 'test' | 'data' | 'agent' | 'tool';
const visibleTraceGroupLimit = 5;

// 任务终态集合：reconcile 与 trace 渲染共用（runtime task 状态机的终态判定）。
export const terminalTaskStates = new Set(['completed', 'failed', 'interrupted', 'cancelled']);

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

function compactTrace(events: AgentEvent[]): TraceEntry[] {
  const result: TraceEntry[] = [];
  const tools = new Map<string, TraceEntry>();
  const permissions = new Map<string, TraceEntry>();
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
    if (event.type === 'permission_request' && data.id) {
      const permissionId = String(data.id);
      const existing = permissions.get(permissionId);
      if (existing) {
        existing.data = { ...existing.data, ...data };
        existing.timestamp = event.timestamp;
      } else {
        const entry = { type: event.type, data: { ...data }, timestamp: event.timestamp };
        permissions.set(permissionId, entry);
        result.push(entry);
      }
      continue;
    }
    result.push({ type: event.type, data: { ...data }, timestamp: event.timestamp });
  }
  return result;
}

export function eventsForRuntimeTask(events: AgentEvent[], taskId: string) {
  const start = events.findIndex(event => event.type === 'text' && (event.data as any)?.role === 'user' && (event.data as any)?.taskId === taskId);
  if (start < 0) return events;
  const endOffset = events.slice(start + 1).findIndex(event => {
    if (event.type !== 'task') return false;
    const task = (event.data as any)?.task;
    return task?.id === taskId && terminalTaskStates.has(task.status);
  });
  return events.slice(start + 1, endOffset < 0 ? undefined : start + 1 + endOffset);
}

export async function loadLarkTaskEvents(
  runtime: { getEvents?(id: string): Promise<AgentEvent[]>; getRecentEvents?(id: string, limit: number): Promise<AgentEvent[]> },
  sessionId: string, taskId: string, limit: number
) {
  if (!runtime.getRecentEvents) return eventsForRuntimeTask(await runtime.getEvents!(sessionId), taskId);
  // A long streamed answer can span more events than the trace window. Expand
  // until the task boundary is present so the result cannot lose its beginning.
  for (;;) {
    const events = await runtime.getRecentEvents(sessionId, limit);
    if (events.length < limit || events.some(event => event.type === 'text' && (event.data as any)?.role === 'user' && (event.data as any)?.taskId === taskId)) {
      return eventsForRuntimeTask(events, taskId);
    }
    limit *= 2;
  }
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
const sensitiveTraceKey = /(?:authorization|api[_-]?key|access[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)$/i;
const redactTraceText = (value: string) => value
  // Treat a truncated PEM as sensitive through end-of-input; logs often cut
  // output before the END marker arrives.
  .replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)* PRIVATE KEY-----|$)/g, '[REDACTED_PRIVATE_KEY]')
  // URL userinfo can contain both a user name and password. Keep only the destination URL shape.
  .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
  // Authorization is handled before generic assignments so "Bearer token" is removed as one value.
  .replace(/(\bauthorization\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n"',;&}]+)/gi, '$1[REDACTED]')
  .replace(/\bbearer\s+[^"'\s,;}&]+/gi, 'Bearer [REDACTED]')
  // Common CLI flags use a following argument instead of key=value.
  .replace(/(^|[^A-Za-z0-9_-])((?:--?)(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd)\s+)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gim, '$1$2[REDACTED]')
  .replace(/((?:\b(?:api[_-]?key|access[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd)|\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|API_KEY)[A-Z0-9_]*)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, '$1[REDACTED]');

const redactTraceValue = (value: unknown, seen = new WeakSet<object>(), depth = 0): unknown => {
  if (typeof value === 'string') return redactTraceText(value);
  if (!value || typeof value !== 'object') return value;
  if (depth >= 12) return '[REDACTED: nested value]';
  if (seen.has(value)) return '[REDACTED: circular value]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => redactTraceValue(item, seen, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    sensitiveTraceKey.test(key) ? '[REDACTED]' : redactTraceValue(item, seen, depth + 1)
  ]));
};

const truncateTrace = (value: unknown, limit: number) => truncate(redactTraceValue(value), limit);
const truncateInline = (value: string, limit = 64) => {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
};
// 耗时只在「值得注意」时才占用标题里的一段位置。毫秒级和一两秒的步骤是绝大多数，
// 读者不会因为一条 1ms 改变任何判断，但每一条都会挤掉真正要读的命令。
const notableElapsedMs = 3_000;
const traceElapsed = (startedAt?: string, completedAt?: string) => {
  if (!startedAt) return '';
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
  const milliseconds = end - start;
  if (milliseconds < notableElapsedMs) return '';
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
  const fullDetail = redactTraceText(command ?? url ?? path ?? (/^(?:tool|tool call)$/i.test(name) ? '' : name));
  const detail = truncateInline(fullDetail);
  // 标题已经完整展示了唯一的输入字段时，展开区里的「输入」只是把同一条内容再用
  // JSON 包一层：三行括号讲一件标题上已经写着的事。只有输入里还有标题没覆盖的字段，
  // 或标题被截断（fullDetail !== detail）时，展开才有内容可看。
  //
  // 字段名必须在白名单内，因为隐藏输入会连字段名一起隐藏。cwd 就是反例：
  // `{cwd:'/srv/repo'}` 的标题是「运行命令 /srv/repo」，把工作目录读成了被执行的命令，
  // 此时那层 JSON 是唯一能说清「这是 cwd」的东西，不能省。
  const selfEvidentInputKeys = new Set(['command', 'cmd', 'path', 'file_path', 'url', 'href']);
  const inputEntries = data.input && typeof data.input === 'object' && !Array.isArray(data.input)
    ? Object.entries(data.input as Record<string, unknown>)
    : [];
  const soleEntry = inputEntries.length === 1 ? inputEntries[0]! : undefined;
  const titleCoversInput = Boolean(fullDetail) && fullDetail === detail && (
    typeof data.input === 'string'
      ? redactTraceText(data.input.trim()) === fullDetail
      : Boolean(soleEntry) && selfEvidentInputKeys.has(soleEntry![0])
        && typeof soleEntry![1] === 'string' && redactTraceText((soleEntry![1] as string).trim()) === fullDetail
  );
  const status = String(data.status ?? (entry.type === 'tool_result' ? 'completed' : 'running')).toLowerCase();
  const failed = /fail|error|reject|cancel/.test(status);
  const running = /running|pending|started|in_progress/.test(status);
  return {
    kind,
    action: redactTraceText(action),
    description: description ? redactTraceText(description) : description,
    detail,
    statusLabel: failed ? '失败' : running ? '执行中' : '已完成',
    statusColor: failed ? 'yellow' : running ? 'orange' : 'green',
    indicatorColor: failed ? 'trace_failure' : running ? 'trace_running' : 'trace_success',
    elapsed: traceElapsed(data.startedAt ?? entry.timestamp, running ? undefined : data.completedAt ?? entry.timestamp),
    fullDetail,
    titleCoversInput,
    input: truncateTrace(data.input, 250),
    output: truncateTrace(data.output, 450)
  };
};

export const hasUnresolvedToolCalls = (events: AgentEvent[]) => compactTrace(events).some(entry =>
  (entry.type === 'tool_call' || entry.type === 'tool_result') && toolPresentation(entry).statusLabel === '执行中'
);

type StageRecord = { kind: 'tool'; entry: TraceEntry } | { kind: 'terminal'; entries: TraceEntry[] };

// 终端回显不是工具调用。把每一条 raw_terminal 都套成工具，会得到一排完全相同、
// 零信息量的「运行命令 · terminal」标题，真正的输出反而被压进折叠层——一次翻页拉取
// 就是 18 个同名面板。连续回显合并成一段终端输出，由一个折叠面板承载全部内容。
const stageRecords = (actions: TraceEntry[]): StageRecord[] => {
  const records: StageRecord[] = [];
  for (const entry of actions) {
    if (entry.type === 'raw_terminal') {
      // PTY 每吐一个提示符就是一条纯空白回显。它们不值得占一个面板，也不该被算进条数。
      if (!String(entry.data.text ?? '').trim()) continue;
      const last = records.at(-1);
      if (last?.kind === 'terminal') last.entries.push(entry);
      else records.push({ kind: 'terminal', entries: [entry] });
      continue;
    }
    if (entry.type === 'tool_call' || entry.type === 'tool_result') records.push({ kind: 'tool', entry });
  }
  return records;
};

// 头尾都要保留：命令回显和第一条报错在开头，当前进度在结尾，中间是翻页噪声。
// 只留尾部会让「FAIL src/critical.test.ts」这类只出现一次的关键行彻底消失。
const terminalHeadLimit = 300;
const terminalTailLimit = 600;
// 被掐掉的中间段里，报错行和翻页噪声不等权：一整屏 PASS 里那一行 FAIL 是读者
// 唯一要读的东西，按字符位置一起丢掉，卡上就只剩「1 failed」而看不到失败在哪。
const terminalAlertPattern = /(?:\bFAIL(?:ED)?\b|\bERROR\b|\bTraceback\b|\bpanic:|error:)/i;
const terminalAlertLimit = 5;
const clipTerminalText = (text: string) => {
  if (text.length <= terminalHeadLimit + terminalTailLimit) return text;
  const middle = text.slice(terminalHeadLimit, text.length - terminalTailLimit);
  const alerts = middle.split('\n').map(line => line.trim())
    .filter(line => terminalAlertPattern.test(line)).slice(0, terminalAlertLimit);
  const notice = alerts.length
    ? `…（已省略中间 ${middle.length} 个字符，其中的报错行保留如下）`
    : `…（已省略中间 ${middle.length} 个字符）`;
  return [text.slice(0, terminalHeadLimit), notice, ...alerts, text.slice(-terminalTailLimit)].join('\n');
};
const terminalPanel = (entries: TraceEntry[], index: string | number, margin = '0px 0px 0px 20px'): LarkCardElement => {
  // 拼完再脱敏，不能逐条脱敏后拼接。stderr 是逐行发事件的，一份多行私钥必然被切成
  // 多条：逐条脱敏时只有带 BEGIN 标记的那一条被替换，密钥体所在的那几条一个规则都不
  // 命中，会原样进群消息。代价是一条含 BEGIN 字样、又没等到 END 的输出会把它后面的
  // 内容一起吞成 [REDACTED_PRIVATE_KEY]——宁可让读者去 Web 看全文，不能漏密钥。
  const text = redactTraceText(entries.map(entry => String(entry.data.text ?? '')).join('\n')).trim();
  const clipped = clipTerminalText(text);
  return {
    tag: 'collapsible_panel', element_id: `trace_tool_${index}`, expanded: false,
    direction: 'vertical', vertical_spacing: '4px', padding: '4px 0px 0px 0px', margin,
    header: {
      title: {
        tag: 'markdown',
        content: entries.length > 1 ? `终端输出（${entries.length} 条）` : '终端输出',
        text_size: 'notation',
        icon: { tag: 'standard_icon', token: toolIcon('command'), color: 'grey' }
      },
      vertical_align: 'center', icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '12px 12px' },
      icon_position: 'right', icon_expanded_angle: -180
    },
    elements: [{ tag: 'markdown', content: `\`\`\`text\n${clipped.replaceAll('```', '``\\`')}\n\`\`\``, text_size: 'notation', margin: '0px' }]
  };
};

const stageRecordPanel = (record: StageRecord, index: string | number, margin = '0px 0px 0px 20px'): LarkCardElement =>
  record.kind === 'terminal' ? terminalPanel(record.entries, index, margin) : toolPanel(record.entry, index, margin);

const toolPanel = (entry: TraceEntry, index: string | number, margin = '0px 0px 0px 20px'): LarkCardElement => {
  const tool = toolPresentation(entry);
  const description = escapeCardInline(truncateInline(tool.description || tool.action, 72));
  const detail = escapeCardInline(tool.detail || '');
  const detailSuffix = detail && detail !== description ? `　<font color='grey'>${detail}</font>` : '';
  const elapsedSuffix = tool.elapsed ? `　<font color='grey'>${tool.elapsed}</font>` : '';
  const stateLamp = `<font color='${tool.indicatorColor}'>●</font>　`;
  // 零参工具的 input 会被序列化成 `{}`，那是个真值但没有内容——展开只会看到一对括号。
  const showInput = Boolean(tool.input) && !['{}', '[]'].includes(tool.input) && !tool.titleCoversInput;
  const parts: Array<{ label: string; text: string }> = [];
  // 标题被截断且没有输入区兜底时，展开区必须还能拿到完整命令。
  if (tool.fullDetail && tool.fullDetail !== tool.detail && !showInput) parts.push({ label: '完整内容', text: tool.fullDetail });
  if (showInput) parts.push({ label: '输入', text: tool.input });
  if (tool.output) parts.push({ label: '结果', text: tool.output });
  // 只有一段内容时省掉标签：面板标题已经说明这是哪个工具，一个「结果」字样只多占一行。
  const sections = parts.map(part => {
    const fenced = `\`\`\`text\n${part.text.replaceAll('```', '``\\`')}\n\`\`\``;
    return parts.length > 1 ? `${part.label}\n\n${fenced}` : fenced;
  });
  const title = {
    tag: 'markdown',
    content: `${stateLamp}${description}${detailSuffix}${elapsedSuffix}`,
    text_size: 'notation',
    icon: { tag: 'standard_icon', token: toolIcon(tool.kind), color: 'grey' }
  };
  // 没有可展开内容时不给折叠面板：一个点开只显示「暂无内容」的箭头是空承诺。
  // 正在执行、还没拿到结果的工具本来就只有标题这一行信息，直接平铺即可。
  if (!sections.length) return { ...title, element_id: `trace_tool_${index}`, margin };
  return {
    tag: 'collapsible_panel', element_id: `trace_tool_${index}`, expanded: false,
    direction: 'vertical', vertical_spacing: '4px', padding: '4px 0px 0px 0px', margin,
    header: {
      title,
      vertical_align: 'center', icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '12px 12px' },
      icon_position: 'right', icon_expanded_angle: -180
    },
    elements: sections.map(content => ({ tag: 'markdown', content, text_size: 'notation', margin: '0px' }))
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

const historyGroupPanel = (
  group: TraceGroup,
  index: number,
  showElapsed = false,
  expanded = false
): LarkCardElement => {
  const records = stageRecords(group.actions);
  const tools = records.flatMap(record => record.kind === 'tool' ? [record.entry] : []);
  const statuses = tools.map(entry => toolPresentation(entry));
  const failedCount = statuses.filter(item => item.statusLabel === '失败').length;
  const succeededCount = statuses.filter(item => item.statusLabel === '已完成').length;
  const runningCount = statuses.filter(item => item.statusLabel === '执行中').length;
  const hasErrorEvent = group.actions.some(entry => entry.type === 'error');
  const hasFailed = hasErrorEvent || failedCount > 0;
  const status = hasFailed && succeededCount > 0
    ? { label: '有失败', color: 'trace_failure' }
    : hasFailed
      ? { label: '失败', color: 'trace_failure' }
      : runningCount > 0 ? { label: '执行中', color: 'trace_running' }
      : { label: '已完成', color: 'green' };

  const assistantNarrative = [...group.narratives].reverse().find(entry => entry.type === 'text');
  const narrativeText = assistantNarrative?.data.text ? redactTraceText(String(assistantNarrative.data.text)).trim() : '';

  const primaryTool = statuses[0];
  const mainTitle = narrativeText
    || (primaryTool ? `${primaryTool.action}${primaryTool.detail ? ` · ${primaryTool.detail}` : ''}` : '')
    || (records.some(record => record.kind === 'terminal') ? '终端输出' : '')
    || (group.narratives.some(e => e.type === 'thinking') ? '分析与规划' : '执行过程');

  const first = group.narratives[0] ?? group.actions[0];
  const last = group.actions.at(-1) ?? group.narratives.at(-1);
  const elapsed = showElapsed ? traceElapsed(first?.data.startedAt ?? first?.timestamp, last?.data.completedAt ?? last?.timestamp) : '';

  const preview = escapeCardInline(truncateInline(mainTitle, 92));
  const elapsedSuffix = elapsed ? `　<font color='grey'>${elapsed}</font>` : '';
  // 成功是默认预期，不需要标注。一次顺利的执行会有五个阶段，五个绿点「已完成」
  // 只是在重复「没有异常」这件事，同时把失败的那一个淹掉。
  const stateSuffix = status.label === '已完成' ? '' : `　<font color='${status.color}'>● ${status.label}</font>`;
  const headerTitle = `${preview}${elapsedSuffix}${stateSuffix}`;

  let actionElements: LarkCardElement[] = [];
  // 单条记录（一个工具、或一段合并后的终端输出）直接摊平：阶段本身已经是一层折叠，
  // 再套一层意味着读者要点三次才能看到内容。
  if (records.length === 1) {
    const panel = stageRecordPanel(records[0]!, `${index}_0`, '0px');
    // 无内容的工具已经是一行纯文本，没有 header/elements 可以摊平。
    actionElements = panel.tag === 'collapsible_panel' ? [{
      tag: 'interactive_container',
      element_id: panel.element_id,
      behaviors: [],
      has_border: false,
      padding: '0px',
      margin: '0px',
      direction: 'vertical',
      vertical_spacing: '4px',
      elements: [
        panel.header.title,
        ...panel.elements
      ]
    }] : [panel];
  } else if (records.length) {
    actionElements = records.map((record, actionIndex) => stageRecordPanel(record, `${index}_${actionIndex}`));
  } else if (narrativeText) {
    actionElements = [{
      tag: 'markdown',
      content: escapeCardInline(truncateTrace(narrativeText, 1_500)),
      text_size: 'notation',
      margin: '0px'
    }];
  } else if (group.narratives.some(e => e.type === 'thinking')) {
    actionElements = [{
      tag: 'markdown',
      content: "<font color='grey'>内部分析已完成</font>",
      text_size: 'notation',
      margin: '0px'
    }];
  }

  const extraElements = group.actions.flatMap((entry): LarkCardElement[] => {
    if (entry.type === 'permission_request') {
      return [{ tag: 'markdown', content: `**权限请求**　<text_tag color='orange'>${entry.data.status ?? '待处理'}</text_tag>\n\n${truncateTrace(entry.data.title, 800)}`, text_size: 'x-small', margin: '0px' }];
    }
    if (entry.type === 'error') {
      return [{ tag: 'markdown', content: `<text_tag color='yellow'>有错误</text_tag>\n\n${truncateTrace(entry.data.message ?? 'Agent 执行未完全成功', 1_500)}`, text_size: 'x-small', margin: '0px' }];
    }
    return [];
  });

  // 一个阶段可能什么都没留下：纯空白终端回显被跳过，又没有叙述或思考。
  // 折叠面板在这种时候只是一个点开是空的箭头，直接退化成标题行。
  if (!actionElements.length && !extraElements.length) {
    return { tag: 'markdown', element_id: `trace_group_${index}`, content: headerTitle, text_size: 'notation', margin: '0px' };
  }

  return {
    tag: 'collapsible_panel',
    element_id: `trace_group_${index}`,
    expanded,
    direction: 'vertical',
    vertical_spacing: '2px',
    padding: '2px 0px 0px 0px',
    margin: '0px',
    header: {
      title: { tag: 'markdown', content: headerTitle, text_size: 'notation' },
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '14px 14px' },
      icon_position: 'right',
      icon_expanded_angle: -180
    },
    elements: [...actionElements, ...extraElements]
  };
};

const currentRunningStagePanel = (group: TraceGroup, index: number): LarkCardElement => {
  const records = stageRecords(group.actions);
  const tools = records.flatMap(record => record.kind === 'tool' ? [record.entry] : []);
  const assistantNarrative = [...group.narratives].reverse().find(entry => entry.type === 'text');
  const narrativeText = assistantNarrative?.data.text ? redactTraceText(String(assistantNarrative.data.text)).trim() : '';

  const toolPresentations = tools.map(toolPresentation);
  const primaryTool = toolPresentations[0];

  const currentTitle = narrativeText
    ? truncateInline(narrativeText, 92)
    : (primaryTool ? `${primaryTool.action}${primaryTool.detail ? ` · ${primaryTool.detail}` : ''}` : '正在执行…');

  const failedCount = toolPresentations.filter(item => item.statusLabel === '失败').length;
  const succeededCount = toolPresentations.filter(item => item.statusLabel === '已完成').length;
  const hasErrorEvent = group.actions.some(entry => entry.type === 'error');
  const hasFailed = hasErrorEvent || failedCount > 0;
  const stageStatus = hasFailed && succeededCount > 0
    ? { label: '有失败', color: 'trace_failure' }
    : hasFailed
      ? { label: '失败', color: 'trace_failure' }
      : toolPresentations.some(item => item.statusLabel === '执行中') ? { label: '执行中', color: 'trace_running' }
      : { label: '已完成', color: 'green' };

  const statusSuffix = hasFailed
    ? `　<font color='${stageStatus.color}'>● ${stageStatus.label}</font>`
    : '';

  const elements: LarkCardElement[] = [
    {
      tag: 'markdown',
      element_id: 'current_title',
      // 「Agent 此刻在做什么」是运行态卡片的信息主体，用正文字号；
      // 用 notation 会让最该读的一行成为卡上最小的字。
      content: `${escapeCardInline(currentTitle)}${statusSuffix}`,
      text_size: 'normal',
      margin: '0px'
    }
  ];

  for (let actionIndex = 0; actionIndex < records.length; actionIndex++) {
    elements.push(stageRecordPanel(records[actionIndex]!, `${index}_${actionIndex}`, '0px'));
  }

  return {
    tag: 'interactive_container',
    element_id: `trace_group_${index}`,
    behaviors: [],
    background_style: 'current_bg',
    has_border: false,
    corner_radius: '8px',
    padding: '8px 10px 8px 10px',
    margin: '0px',
    direction: 'vertical',
    vertical_spacing: '4px',
    elements
  };
};

// 「N 个工具已结束」是纯计数：任务进入终态本身就意味着步骤都结束了，这一行不改变
// 任何判断，却挂在最终答案正下方跟答案抢注意力——结果卡上尤其明显。
// 只有失败数要求读者做点什么，所以只在有失败时才出现。
const buildEvidenceElement = (allGroups: TraceGroup[]): LarkCardElement | undefined => {
  const failedCount = allGroups.flatMap(group => group.actions)
    .filter(entry => entry.type === 'tool_call' || entry.type === 'tool_result')
    .map(toolPresentation)
    .filter(tool => tool.statusLabel === '失败').length;
  if (!failedCount) return undefined;
  return {
    tag: 'markdown',
    element_id: 'evidence',
    // 不写「详情见执行记录」：失败数按全部阶段统计，而卡片只渲染最近五个阶段，
    // 失败发生在更早的阶段时，那句指引会把读者送到一份没有失败记录的执行记录里。
    content: `<font color='orange'>${failedCount} 个步骤执行失败</font>`,
    text_size: 'notation',
    margin: '4px 0px 0px 0px',
    icon: { tag: 'standard_icon', token: 'warning_outlined', color: 'orange' }
  };
};

const permissionAlert = (entry: TraceEntry, index: number): LarkCardElement => {
  const status = String(entry.data.status ?? 'pending').toLowerCase();
  const pending = /pending|waiting|requested/.test(status);
  const rejected = /reject|denied|blocked|cancel/.test(status);
  const title = truncateTrace(entry.data.title ?? 'Agent 请求执行受保护操作', 800);
  const highRisk = /高危|风险|danger|risk/i.test(title);
  const tagColor = pending ? 'orange' : rejected ? 'red' : 'green';
  const tagLabel = pending ? (highRisk ? '高风险待确认' : '等待审批') : rejected ? '已安全拦截' : '授权已处理';
  const headline = pending
    ? '任务已暂停，需要人工确认'
    : rejected ? '受保护操作未执行' : '任务已恢复执行';
  const guidance = pending
    ? '请在 Dockmux 工作台中查看详情并审批；处理后卡片会继续同步。'
    : rejected ? '可调整指令后重试，或由有权限的成员重新发起。' : '无需额外操作。';
  const visualStatus = pending ? 'pending' : rejected ? 'rejected' : 'resolved';
  return {
    tag: 'markdown', element_id: `risk_alert_${visualStatus}_${index}`,
    content: `<text_tag color='${tagColor}'>${tagLabel}</text_tag>　**${headline}**\n\n${title}\n\n<font color='grey'>${guidance}</font>`,
    text_size: 'normal', margin: '6px 0px 8px 0px'
  };
};

const errorAlert = (entry: TraceEntry, index: number): LarkCardElement => ({
  tag: 'markdown', element_id: `execution_alert_${index}`,
  content: `<text_tag color='red'>执行异常</text_tag>　**需要关注**\n\n${truncateTrace(entry.data.message ?? 'Agent 执行未完全成功', 1_500)}`,
  text_size: 'normal', margin: '6px 0px 8px 0px'
});

export function renderLarkCardElements(
  events: AgentEvent[],
  config: Pick<StoredLarkConfig, 'traceLimit' | 'hideTraceOnComplete'>,
  completed = false,
  compensation = false,
  /** 保留入参以免改动全部调用点；下一步提示移除后渲染不再按会话类型分叉。 */
  _chatType?: string,
  view: 'combined' | 'process' | 'result' = 'combined'
): LarkCardElement[] {
  const entries = compactTrace(events);
  const lastIndex = (predicate: (entry: TraceEntry) => boolean) => {
    for (let index = entries.length - 1; index >= 0; index--) if (predicate(entries[index]!)) return index;
    return -1;
  };
  const finalMessageIndex = completed ? lastIndex(entry => entry.type === 'text' && entry.data.role !== 'user') : -1;
  // final 文本必须位于最后一次**活动**之后：工具调用前的阶段描述不得提升为 final_output，
  // 未决的 permission_request / error 也必须继续挡住提升。
  // raw_terminal 例外——它是屏幕回显，不是活动。PTY 形态的 Agent 给出最终答复之后，
  // 屏幕上必然还会再吐一个提示符；把它算作活动会让真实答复失去 final 资格，
  // 而 hideTraceOnComplete 默认隐去 trace，用户最终一个字都看不到。
  const lastActivityIndex = lastIndex(entry => entry.type !== 'text' && entry.type !== 'raw_terminal');
  const finalFollowsActivity = finalMessageIndex > lastActivityIndex;
  const finalMessage = finalMessageIndex >= 0 && finalFollowsActivity ? entries[finalMessageIndex] : undefined;
  const finalText = view === 'result' ? redactTraceText(String(finalMessage?.data.text ?? '')).trim() : truncateTrace(finalMessage?.data.text, 6_000);
  const activityEntries = entries.filter(entry => entry !== finalMessage || !finalFollowsActivity);
  const permissionEntries = activityEntries.filter(entry => entry.type === 'permission_request');
  const errorEntries = activityEntries.filter(entry => entry.type === 'error');
  const traceEntries = activityEntries.filter(entry => entry.type !== 'permission_request' && entry.type !== 'error');
  // 先全量分组，再只展示最近五组有效活动。traceLimit 控制上游取样/对账规模，
  // 不控制卡片视觉密度；否则默认 50 会把运行态重新变成日志墙。
  // 若在 entry 级别切片，滑动窗口可能切断 group 边界，导致 group 数量随新事件到来而跳变。
  // 按 group 级别裁剪后，卡片始终保留最近且完整的阶段。
  const allGroups = traceGroups(traceEntries);
  const groups = allGroups.slice(-visibleTraceGroupLimit);
  const omittedGroupCount = allGroups.length - groups.length;
  const elements: LarkCardElement[] = [];

  if (compensation) {
    elements.push({ tag: 'markdown', content: "<font color='orange'>原运行卡片未能更新，Dockmux 已补发终态结果。</font>", text_size: 'notation', margin: '0px 0px 8px 0px' });
  }
  elements.push(...permissionEntries.map(permissionAlert));
  elements.push(...errorEntries.map(errorAlert));
  if (finalText && view !== 'process') {
    elements.push({ tag: 'markdown', element_id: 'final_output', content: completed ? finalText : `**当前进展**\n\n${finalText}`, text_align: 'left', text_size: 'normal_v2', margin: '0px' });
  } else if (completed && view !== 'process') {
    elements.push({ tag: 'markdown', element_id: 'result_missing', content: "<text_tag color='orange'>结果不完整</text_tag>　Agent 未返回最终输出，可直接要求 Agent 总结本轮结论。", text_size: 'normal', margin: '4px 0px' });
  }

  if (completed && view !== 'process') {
    const evidence = buildEvidenceElement(allGroups);
    if (evidence) elements.push(evidence);
  }

  if (view === 'result') return elements;

  if (groups.length) {
    if (completed) {
      if (omittedGroupCount) {
        elements.push({
          tag: 'markdown', element_id: 'trace_omission',
          content: `<font color='grey'>仅展示最近 ${groups.length} 个阶段，另有 ${omittedGroupCount} 个阶段；完整记录请在 Dockmux Web 查看。</font>`,
          text_size: 'notation', margin: '0px 0px 4px 0px'
        });
      }
      const expanded = config.hideTraceOnComplete === false;
      elements.push(...groups.map((group, index) => historyGroupPanel(group, index, false, expanded)));
    } else {
      const historyGroups = groups.slice(0, -1);
      const currentGroup = groups.at(-1)!;

      if (historyGroups.length > 0) {
        // 省略提示并进「此前阶段」这一行。两条灰字紧挨着说的是同一件事——
        // 下面是历史，而且历史不全——分成两行只是把当前阶段往下推。
        const omission = omittedGroupCount
          ? `（另有 ${omittedGroupCount} 个更早阶段未展示，完整记录见 Dockmux Web）`
          : '';
        elements.push({
          tag: 'markdown', element_id: 'history_label',
          content: `<font color='grey'>此前阶段${omission}</font>`,
          text_size: 'notation', margin: '4px 0px 2px 0px'
        });
        // 「此前阶段」只在运行态布局里被渲染。queued 之类的非运行态把所有阶段收进
        // 「执行记录」，那条路径读的是 trace_omission，缺了它省略提示会整行消失。
        if (omittedGroupCount) elements.push({
          tag: 'markdown', element_id: 'trace_omission',
          content: "<font color='grey'>另有 " + omittedGroupCount + " 个更早阶段未展示，完整记录见 Dockmux Web</font>",
          text_size: 'notation', margin: '0px'
        });
        elements.push(...historyGroups.map((group, index) => historyGroupPanel(group, index, true, false)));
      }
      elements.push(currentRunningStagePanel(currentGroup, groups.length - 1));
    }
  }
  if (!elements.length) elements.push({ tag: 'markdown', content: completed ? '执行过程已结束，结果见单独的结果消息。' : '正在思考中…', text_size: 'normal', margin: '0px' });
  return elements;
}

export const renderLarkProcessElements = (events: AgentEvent[], config: Pick<StoredLarkConfig, 'traceLimit' | 'hideTraceOnComplete'>, terminal = false) =>
  renderLarkCardElements(events, config, terminal, false, undefined, 'process');

export const renderLarkResultElements = (events: AgentEvent[]) =>
  renderLarkCardElements(events, { hideTraceOnComplete: true }, true, false, undefined, 'result');

export function renderLarkTrace(events: AgentEvent[], config: Pick<StoredLarkConfig, 'traceLimit'>, _completed = false) {
  let entries = compactTrace(events);
  if (config.traceLimit) entries = entries.slice(-config.traceLimit);
  if (!entries.length) return '正在思考中…';
  return entries.map(entry => {
    const data = entry.data;
    if (entry.type === 'text') return `**Agent**\n\n${redactTraceText(String(data.text ?? ''))}`;
    if (entry.type === 'thinking') return '**内部分析**\n\n> Agent 已完成内部分析（推理原文不展示）';
    if (entry.type === 'tool_call' || entry.type === 'tool_result') return `**工具 · ${redactTraceText(String(data.name ?? 'tool'))}** · ${data.status ?? (entry.type === 'tool_result' ? 'completed' : 'running')}${fenced(redactTraceValue(data.output ?? data.input))}`;
    if (entry.type === 'permission_request') return `**权限请求** · ${data.status ?? 'pending'}\n\n${redactTraceText(String(data.title ?? ''))}`;
    if (entry.type === 'error') return `**错误**\n\n${redactTraceText(String(data.message ?? 'Agent 执行失败'))}`;
    if (entry.type === 'raw_terminal') return `**终端**${fenced(redactTraceText(String(data.text ?? '')))}`;
    return '';
  }).filter(Boolean).join('\n\n---\n\n');
}
