import type { AgentEvent } from '@dockmux/shared';
import type { StoredLarkConfig } from './config.js';
import { boundLarkCardElements, LarkServiceError } from './service.js';

// 卡片渲染与限流/拒绝判断辅助。
// 本文件从 listener.ts 原样拆分而来：trace 卡片是 Dockmux 飞书侧的必保特色，
// 所有渲染逻辑逐行搬运，不得改动任何视觉输出。

export type TraceEntry = { type: AgentEvent['type']; data: Record<string, any>; timestamp: string };
export type TraceGroup = { narratives: TraceEntry[]; actions: TraceEntry[] };
export type LarkCardElement = Record<string, any>;
type TraceToolKind = 'command' | 'read' | 'edit' | 'search' | 'web' | 'git' | 'test' | 'data' | 'agent' | 'tool';

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

export const hasUnresolvedToolCalls = (events: AgentEvent[]) => compactTrace(events).some(entry =>
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
