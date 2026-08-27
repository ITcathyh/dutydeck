import type { TimelineEvent } from './timeline';
import { toolCommand, toolDescription, toolDisplayName } from './timeline';
export { toolDescription } from './timeline';

export type ToolKind = 'terminal' | 'read' | 'edit' | 'search' | 'web' | 'git' | 'test' | 'database' | 'agent' | 'tool';
export type ToolActivityRow =
  | { kind: 'event'; event: TimelineEvent }
  | { kind: 'batch'; id: string; description: string; events: TimelineEvent[] };

const genericNames = new Set(['tool', 'tool call', 'terminal']);

function stringField(input: unknown, keys: string[]) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const record = input as Record<string, unknown>;
  for (const key of keys) if (typeof record[key] === 'string' && record[key].trim()) return record[key].trim();
}

export function groupToolActivityRows(events: TimelineEvent[]): ToolActivityRow[] {
  const rows: ToolActivityRow[] = [];
  for (const event of events) {
    const isTool = event.type === 'tool_call' || event.type === 'tool_result';
    const description = isTool ? toolDescription(event.data) : undefined;
    const previous = rows.at(-1);
    if (description && previous?.kind === 'batch' && previous.description === description) {
      previous.events.push(event);
      continue;
    }
    if (description) {
      rows.push({ kind: 'batch', id: `tool-batch-${event.id}`, description, events: [event] });
      continue;
    }
    rows.push({ kind: 'event', event });
  }
  return rows.flatMap(row => row.kind === 'batch' && row.events.length === 1 ? [{ kind: 'event' as const, event: row.events[0]! }] : [row]);
}

export function toolPresentation(data: TimelineEvent['data']): { kind: ToolKind; label: string; detail?: string } {
  const command = toolCommand(data.input);
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  const haystack = `${name} ${command ?? ''}`.toLowerCase();
  const path = stringField(data.input, ['path', 'file_path', 'filePath', 'filename']);
  const query = stringField(data.input, ['query', 'pattern']);
  const detail = command ?? path ?? query ?? (!genericNames.has(name.toLowerCase()) ? name : undefined);

  if (/\b(?:apply_patch|patch|edit|write|replace|create_file)\b/.test(haystack)) return { kind: 'edit', label: '编辑文件', detail };
  if (/\b(?:read|cat|head|tail|sed\s+-n|open_file)\b/.test(haystack)) return { kind: 'read', label: '读取文件', detail };
  if (/\b(?:rg|grep|find|search|glob)\b/.test(haystack)) return { kind: 'search', label: '搜索内容', detail };
  if (/\b(?:curl|wget|fetch|web|search_query|open_url)\b/.test(haystack)) return { kind: 'web', label: '访问网页', detail };
  if (/\bgit\b/.test(haystack)) return { kind: 'git', label: 'Git 操作', detail };
  if (/\b(?:vitest|jest|pytest|go\s+test|pnpm\s+test|npm\s+test|yarn\s+test)\b/.test(haystack)) return { kind: 'test', label: '运行测试', detail };
  if (/\b(?:sqlite|sql|database|postgres|mysql)\b/.test(haystack)) return { kind: 'database', label: '查询数据', detail };
  if (/\bgroup\s+(?:self|peers|messages|send|wait)\b/.test(haystack)) return { kind: 'agent', label: 'Agent 群协作', detail };
  if (/\b(?:agent|task|spawn|delegate)\b/.test(haystack)) return { kind: 'agent', label: '调用 Agent', detail };
  if (command || /\b(?:terminal|shell|exec|command)\b/.test(haystack)) return { kind: 'terminal', label: '运行命令', detail: command ?? detail };
  return { kind: 'tool', label: toolDisplayName(data), detail };
}

export function summarizeTools(events: TimelineEvent[]) {
  const counts = new Map<ToolKind, { count: number; label: string }>();
  for (const event of events) {
    if (event.type !== 'tool_call' && event.type !== 'tool_result') continue;
    const presentation = toolPresentation(event.data);
    const current = counts.get(presentation.kind);
    counts.set(presentation.kind, { count: (current?.count ?? 0) + 1, label: presentation.label });
  }
  return [...counts].map(([kind, { count, label }]) => {
    if (kind === 'terminal') return `运行了${count > 1 ? ` ${count} 条` : ''}命令`;
    if (kind === 'read') return `读取了${count > 1 ? ` ${count} 个` : ''}文件`;
    if (kind === 'edit') return `编辑了${count > 1 ? ` ${count} 个` : ''}文件`;
    if (kind === 'search') return `搜索了${count > 1 ? ` ${count} 次` : ''}内容`;
    if (kind === 'web') return `访问了${count > 1 ? ` ${count} 个` : ''}网页`;
    if (kind === 'git') return `执行了${count > 1 ? ` ${count} 次` : ''} Git 操作`;
    if (kind === 'test') return `运行了${count > 1 ? ` ${count} 次` : ''}测试`;
    if (kind === 'database') return `查询了${count > 1 ? ` ${count} 次` : ''}数据`;
    if (kind === 'agent') return label === 'Agent 群协作' ? `进行了${count > 1 ? ` ${count} 次` : ''} Agent 群协作` : `调用了${count > 1 ? ` ${count} 个` : ''} Agent`;
    return `使用了${count > 1 ? ` ${count} 次` : ''}${label}`;
  }).join(' · ');
}

export function toolActionLabel(presentation: ReturnType<typeof toolPresentation>, terminal: boolean) {
  const prefix = terminal ? '已' : '正在';
  if (presentation.kind === 'terminal') return `${prefix}运行命令`;
  if (presentation.kind === 'read') return `${prefix}读取文件`;
  if (presentation.kind === 'edit') return `${prefix}编辑文件`;
  if (presentation.kind === 'search') return `${prefix}搜索内容`;
  if (presentation.kind === 'web') return `${prefix}访问网页`;
  if (presentation.kind === 'git') return `${prefix}执行 Git 操作`;
  if (presentation.kind === 'test') return `${prefix}运行测试`;
  if (presentation.kind === 'database') return `${prefix}查询数据`;
  if (presentation.kind === 'agent') return presentation.label === 'Agent 群协作' ? (terminal ? '已完成 Agent 群协作' : '正在进行 Agent 群协作') : `${prefix}调用 Agent`;
  return `${prefix}调用${presentation.label}`;
}

export function elapsedMilliseconds(startedAt?: string, completedAt?: string, now = Date.now()) {
  if (!startedAt) return;
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return;
  return end - start;
}

export function formatElapsed(milliseconds?: number) {
  if (milliseconds === undefined) return;
  if (milliseconds < 1_000) return `${Math.max(1, Math.round(milliseconds))} 毫秒`;
  const totalSeconds = Math.round(milliseconds / 1_000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
}
