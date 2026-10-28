import type { DockEvent } from './api';
import { stateLabels } from './components/ui';

export const TRACE_PAGE_SIZE = 100;
export const traceCategories = ['all', 'system', 'user', 'assistant', 'context', 'tool', 'error'] as const;
export type TraceCategory = typeof traceCategories[number];
export const traceLabels: Record<TraceCategory, string> = { all: '全部', system: '系统', user: '用户', assistant: '助手', context: '上下文', tool: '工具', error: '错误' };
export type TraceRow = {
  event: DockEvent;
  category: Exclude<TraceCategory, 'all'>;
  label: string;
  summary: string;
  turn: string;
  toolKey?: string;
  failed: boolean;
  at?: number;
  start?: number;
  end?: number;
  duration?: number;
};

const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const string = (value: unknown) => typeof value === 'string' && value ? value : undefined;
export const traceTime = (value: unknown) => {
  const parsed = typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
const preview = (value: unknown): string => {
  if (typeof value === 'string') return value.slice(0, 500).replace(/\s+/g, ' ').trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.slice(0, 5).map(part => preview(record(part).text ?? record(part).uri ?? part)).filter(Boolean).join(' · ');
  if (!value || typeof value !== 'object') return '';
  const data = record(value);
  return ['command', 'cmd', 'path', 'query', 'text', 'message', 'uri'].map(key => preview(data[key])).filter(Boolean).join(' · ');
};

function describe(event: DockEvent): Pick<TraceRow, 'category' | 'label' | 'summary' | 'failed'> {
  const data = record(event.data);
  const failed = event.type === 'error' || data.status === 'failed';
  if (event.type === 'tool_call' || event.type === 'tool_result') return { category: 'tool', label: event.type === 'tool_call' ? '工具调用' : '工具结果', summary: [string(data.name), preview(data.input), preview(data.output)].filter(Boolean).join(' · ') || '工具更新', failed };
  if (event.type === 'task') {
    const task = record(data.task);
    const status = string(task.status);
    return { category: 'system', label: '任务状态', summary: [status ? stateLabels[status] ?? status : '', preview(task.prompt)].filter(Boolean).join(' · ') || '任务状态', failed };
  }
  const summary = preview(data.text) || preview(data.message) || preview(data.prompt) || preview(data.parts) || preview(data.output) || preview(data.state) || preview(data.status) || event.type;
  if (event.type === 'text') return { category: data.role === 'user' ? 'user' : data.role === 'system' ? 'system' : 'assistant', label: data.role === 'user' ? data.steering ? '插话' : '用户输入' : '消息', summary, failed };
  if (event.type === 'thinking') return { category: 'assistant', label: '思考', summary, failed };
  if (event.type === 'error') return { category: 'error', label: '错误', summary, failed };
  if (event.type === 'status' && ['prompt_assembly', 'usage', 'compaction'].includes(data.state)) return { category: 'context', label: data.state === 'prompt_assembly' ? '提示词组装' : data.state === 'compaction' ? '上下文压缩' : '上下文用量', summary, failed };
  const labels: Record<string, string> = { status: '会话状态', completed: '轮次结束', permission_request: '权限请求', raw_terminal: '终端输出' };
  return { category: 'system', label: labels[event.type] ?? event.type, summary, failed };
}

/** Keep persisted events intact. Only pair tool IDs inside the same task/attempt;
 * names and neighbouring events provide no evidence of execution duration. */
export function buildTraceRows(events: DockEvent[]): TraceRow[] {
  const source = [...new Map(events.map(event => [event.sequence, event])).values()].sort((a, b) => a.sequence - b.sequence);
  const calls = new Map<string, TraceRow>();
  let currentTurn = 'unassigned';
  return source.map(event => {
    const data = record(event.data);
    const explicitTask = string(event.taskId) ?? string(data.taskId) ?? (event.type === 'task' ? string(record(data.task).id) : undefined);
    const steeringTask = string(record(record(data.steering).target).taskId);
    const user = event.type === 'text' && data.role === 'user' && !data.steering;
    if (user) currentTurn = explicitTask ? `task:${explicitTask}` : `input:${event.sequence}`;
    const turn = steeringTask ? `task:${steeringTask}` : explicitTask ? `task:${explicitTask}` : currentTurn;
    const row: TraceRow = { event, ...describe(event), turn, at: traceTime(event.timestamp) };
    if (event.type === 'tool_call' || event.type === 'tool_result') {
      const id = string(data.id);
      const attempt = string(event.attemptId) ?? string(data.attemptId);
      row.toolKey = JSON.stringify([turn, attempt ?? '', id ?? `event:${event.sequence}`]);
      const call = id ? calls.get(row.toolKey) : undefined;
      const start = traceTime(data.startedAt) ?? call?.start;
      const end = traceTime(data.completedAt);
      // Runtime timestamps are preferred; matching call/result receipt times
      // provide an observed interval, never model execution time.
      row.start = start ?? (event.type === 'tool_call' ? row.at : undefined);
      row.end = end ?? (event.type === 'tool_result' && call ? row.at : undefined);
      if (row.start !== undefined && row.end !== undefined && row.end >= row.start) row.duration = row.end - row.start;
      if (id && event.type === 'tool_call') calls.set(row.toolKey, call ?? row);
    }
    if (event.type === 'completed' && (!explicitTask || turn === currentTurn)) currentTurn = 'unassigned';
    return row;
  });
}

export function filterTraceRows(rows: TraceRow[], category: TraceCategory, query: string, newest: boolean): TraceRow[] {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = rows.filter(row => (category === 'all' || (category === 'error' ? row.failed : row.category === category))
    && (!needle || [row.summary, row.label, row.event.type, row.turn, row.event.id, row.event.attemptId, row.event.sequence, record(row.event.data).id].join(' ').toLocaleLowerCase().includes(needle)));
  return newest ? filtered.reverse() : filtered;
}

export function groupTraceRows(rows: TraceRow[], grouped: boolean): { id: string; rows: TraceRow[] }[] {
  if (!grouped) return [{ id: 'all', rows }];
  const groups = new Map<string, TraceRow[]>();
  for (const row of rows) {
    if (!groups.has(row.turn)) groups.set(row.turn, []);
    groups.get(row.turn)!.push(row);
  }
  return [...groups].map(([id, rows]) => ({ id, rows }));
}

export function traceDuration(ms: number | undefined) {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} m ${Math.floor(ms % 60_000 / 1000)} s`;
}
