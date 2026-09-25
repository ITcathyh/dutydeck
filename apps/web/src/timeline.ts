import type { DockEvent, Task } from './api';

export type TimelineEvent = DockEvent & { data: DockEvent['data'] & { role?: 'user' | 'assistant' } };
export type TimelineActivityGroup = { id: string; label: string; events: TimelineEvent[]; startedAt: string; completedAt?: string };
export type TimelineSection =
  | { kind: 'event'; event: TimelineEvent; final: boolean }
  | { kind: 'activity'; id: string; groups: TimelineActivityGroup[]; hasAnswer: boolean; taskStatus: string; isLatestTurn: boolean; startedAt: string; completedAt?: string };

const isActivity = (event: TimelineEvent) => event.type === 'thinking' || event.type === 'tool_call' || event.type === 'tool_result';
const warningPrefix = /^warning:\s*/i;

function compactCommand(value: unknown) {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim() || undefined;
  if (Array.isArray(value) && value.every(part => ['string', 'number', 'boolean'].includes(typeof part))) return value.map(String).join(' ').replace(/\s+/g, ' ').trim() || undefined;
}

export function toolCommand(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const record = input as Record<string, unknown>;
  return compactCommand(record.command) ?? compactCommand(record.cmd);
}

export function toolDisplayName(data: TimelineEvent['data']) {
  return toolCommand(data.input) ?? (typeof data.name === 'string' && data.name.trim() ? data.name.trim() : '工具调用');
}

export function toolDescription(data: TimelineEvent['data']) {
  const input = data.input && typeof data.input === 'object' && !Array.isArray(data.input) ? data.input as Record<string, unknown> : undefined;
  const value = input?.description ?? data.description;
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() || undefined : undefined;
}

function mergedToolName(previous: unknown, current: unknown) {
  const before = typeof previous === 'string' ? previous.trim() : '';
  const after = typeof current === 'string' ? current.trim() : '';
  const specificity = (name: string) => /^(?:tool(?: call)?)$/i.test(name) ? 0 : /^terminal$/i.test(name) ? 1 : name ? 2 : -1;
  if (!after || specificity(after) < specificity(before)) return before || after || '工具调用';
  return after;
}

function warningText(event: TimelineEvent) {
  if (event.type !== 'text' || event.data.role === 'user' || typeof event.data.text !== 'string') return;
  const text = event.data.text.trim();
  if (!warningPrefix.test(text)) return;
  return text.replace(warningPrefix, '').trim();
}

export function buildTimeline(events: DockEvent[] = [], tasks: Task[] = []): TimelineEvent[] {
  const timeline: TimelineEvent[] = [];
  const toolIndexes = new Map<string, number>();
  const seenWarnings = new Set<string>();
  const eventTaskIds = new Set(events.filter(event => event.data?.role === 'user' && event.data?.taskId).map(event => event.data.taskId));
  const legacyPrompts = new Map<string, number>();
  for (const event of events) if (event.data?.role === 'user' && !event.data?.taskId) legacyPrompts.set(event.data.text, (legacyPrompts.get(event.data.text) ?? 0) + 1);
  const taskEvents: DockEvent[] = [];
  for (const task of tasks) {
    if (task.status === 'queued' || task.status === 'cancelled') continue;
    if (eventTaskIds.has(task.id)) continue;
    const legacyCount = legacyPrompts.get(task.prompt) ?? 0;
    if (legacyCount > 0) { legacyPrompts.set(task.prompt, legacyCount - 1); continue; }
    taskEvents.push({ id: `task-event-${task.id}`, sequence: -1, type: 'text', timestamp: task.createdAt, data: { text: task.prompt, role: 'user', taskId: task.id } });
  }
  const source = [...events, ...taskEvents].sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.sequence - right.sequence);
  for (const event of source) {
    if (event.type === 'status' || event.type === 'task' || event.type === 'completed' || event.type === 'raw_terminal') continue;
    const current = { ...event, data: { ...event.data } } as TimelineEvent;
    const warning = warningText(current);
    if (warning) {
      const fingerprint = warning.toLocaleLowerCase();
      if (seenWarnings.has(fingerprint)) continue;
      seenWarnings.add(fingerprint);
      current.type = 'warning';
      current.data = { ...current.data, text: warning, warningKind: /\bskills?\b/i.test(warning) ? 'skill' : 'agent' };
    }
    const previous = timeline.at(-1);
    const role = current.data.role ?? 'assistant';

    if (current.type === 'text' && current.data.role === 'user') toolIndexes.clear();

    if ((current.type === 'text' || current.type === 'thinking') && previous?.type === current.type && (previous.data.role ?? 'assistant') === role) {
      previous.data.text = `${previous.data.text ?? ''}${current.data.text ?? ''}`;
      previous.sequence = current.sequence;
      previous.timestamp = current.timestamp;
      continue;
    }

    if (current.type === 'tool_call' || current.type === 'tool_result') {
      const toolId = typeof current.data.id === 'string' && current.data.id ? current.data.id : undefined;
      const existingIndex = toolId === undefined ? undefined : toolIndexes.get(toolId);
      if (existingIndex !== undefined) {
        const existing = timeline[existingIndex];
        const completed = current.data.status === 'completed' || current.data.status === 'failed';
        existing.type = current.type;
        existing.data = {
          ...existing.data,
          ...current.data,
          name: mergedToolName(existing.data.name, current.data.name),
          input: current.data.input ?? existing.data.input,
          output: current.data.output ?? existing.data.output,
          startedAt: existing.data.startedAt ?? existing.timestamp,
          ...(completed ? { completedAt: current.timestamp } : {})
        };
        existing.sequence = current.sequence;
        continue;
      }
      current.data.startedAt = current.timestamp;
      if (current.data.status === 'completed' || current.data.status === 'failed') current.data.completedAt = current.timestamp;
      if (toolId) toolIndexes.set(toolId, timeline.length);
    }

    if (current.type === 'permission_request') {
      const existing = timeline.findIndex(item => item.type === 'permission_request' && item.data.id === current.data.id);
      if (existing >= 0) { timeline[existing] = current; continue; }
    }
    timeline.push(current);
  }
  return timeline;
}

const terminalTaskStatuses = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
const assistantDescription = (event: TimelineEvent) => event.type === 'text' && event.data.role !== 'user';
const previewText = (value: unknown, limit = 100) => {
  const text = typeof value === 'string' ? value
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_~`>#]+/g, '')
    .replace(/^\s*(?:[-+]|\d+[.)])\s+/gm, '')
    .replace(/\s+/g, ' ').trim() : '';
  return text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
};

function activityLabel(events: TimelineEvent[]) {
  const description = [...events].reverse().find(event => event.type === 'text' && event.data.role !== 'user');
  const descriptionText = previewText(description?.data.text);
  if (descriptionText) return descriptionText;
  const tool = events.find(event => event.type === 'tool_call' || event.type === 'tool_result');
  if (tool) return toolDescription(tool.data) ?? toolDisplayName(tool.data);
  const thinking = [...events].reverse().find(event => event.type === 'thinking');
  return thinking ? '思考过程' : '执行过程';
}

/** 时间线里最新一条仍待处理的权限请求 id；同一请求后来的决议已在 buildTimeline 里合并成最终状态。 */
export function pendingPermissionId(timeline: TimelineEvent[]) {
  for (let index = timeline.length - 1; index >= 0; index--) {
    const event = timeline[index]!;
    if (event.type === 'permission_request' && event.data.status === 'pending') return String(event.data.id ?? event.id);
  }
  return undefined;
}

export function buildTimelineSections(timeline: TimelineEvent[], tasks: Task[] = []): TimelineSection[] {
  if (!timeline.length) return [];
  const turns: TimelineEvent[][] = [];
  for (const event of timeline) {
    const userMessage = event.type === 'text' && event.data.role === 'user';
    if (userMessage || !turns.length) turns.push([]);
    turns.at(-1)!.push(event);
  }

  return turns.flatMap((turn, turnIndex) => {
    const userMessage = turn.find(event => event.type === 'text' && event.data.role === 'user');
    const task = tasks.find(item => item.id === userMessage?.data.taskId);
    const terminal = task ? terminalTaskStatuses.has(task.status) : turnIndex < turns.length - 1;
    const lastActivityIndex = turn.reduce((latest, event, index) => isActivity(event) ? index : latest, -1);
    const lastAssistantTextIndex = turn.reduce((latest, event, index) => event.type === 'text' && event.data.role !== 'user' ? index : latest, -1);
    const finalIndex = terminal && lastAssistantTextIndex > lastActivityIndex ? lastAssistantTextIndex : -1;
    const hasAnswer = finalIndex >= 0;
    type Piece = { kind: 'event'; event: TimelineEvent; final: boolean } | { kind: 'group'; group: TimelineActivityGroup };
    const pieces: Piece[] = [];
    let currentEvents: TimelineEvent[] = [];
    let pendingThinking: TimelineEvent[] = [];
    const flushActivity = () => {
      const events = currentEvents;
      if (events.length) pieces.push({ kind: 'group', group: {
        id: `group-${events[0]!.id}`, label: activityLabel(events), events,
        startedAt: events[0]!.timestamp,
        completedAt: typeof events.at(-1)?.data.completedAt === 'string' ? events.at(-1)!.data.completedAt : events.at(-1)?.timestamp
      } });
      currentEvents = [];
    };
    const appendPendingThinking = () => {
      if (pendingThinking.length) currentEvents.push(...pendingThinking);
      pendingThinking = [];
    };
    for (const [eventIndex, event] of turn.entries()) {
      if (eventIndex === finalIndex) { appendPendingThinking(); flushActivity(); pieces.push({ kind: 'event', event, final: true }); continue; }
      if (assistantDescription(event)) {
        flushActivity();
        currentEvents = [...pendingThinking, event];
        pendingThinking = [];
        continue;
      }
      if (event.type === 'thinking') { pendingThinking.push(event); continue; }
      if (isActivity(event)) { appendPendingThinking(); currentEvents.push(event); continue; }
      appendPendingThinking();
      flushActivity();
      pieces.push({ kind: 'event', event, final: false });
    }
    appendPendingThinking();
    flushActivity();
    const groups = pieces.flatMap(piece => piece.kind === 'group' ? [piece.group] : []);
    if (!groups.length) return pieces.filter((piece): piece is Extract<Piece, { kind: 'event' }> => piece.kind === 'event');
    const firstGroupIndex = pieces.findIndex(piece => piece.kind === 'group');
    const lastGroup = groups.at(-1)!;
    const completedAt = terminal && task?.updatedAt
      ? task.updatedAt
      : hasAnswer ? turn[finalIndex]?.timestamp : lastGroup.completedAt;
    const reportedTaskStatus = task?.status ?? (terminal ? 'completed' : 'running');
    const taskStatus = reportedTaskStatus === 'completed' && !hasAnswer ? 'incomplete' : reportedTaskStatus;
    const activity: TimelineSection = {
      kind: 'activity', id: `activity-${groups[0]!.id}`, groups, hasAnswer,
      taskStatus,
      isLatestTurn: turnIndex === turns.length - 1,
      startedAt: userMessage?.timestamp ?? groups[0]!.startedAt,
      ...(completedAt ? { completedAt } : {})
    };
    const sections: TimelineSection[] = [];
    for (const [index, piece] of pieces.entries()) {
      if (index === firstGroupIndex) sections.push(activity);
      if (piece.kind === 'event') sections.push(piece);
    }
    return sections;
  });
}
