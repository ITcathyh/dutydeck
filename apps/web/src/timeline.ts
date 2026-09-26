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

    // 插话并入正在执行的那一轮：不切断这一轮里的工具调用，也不和前后的消息拼成一条。
    if (current.type === 'text' && current.data.role === 'user' && !current.data.steering) toolIndexes.clear();

    if ((current.type === 'text' || current.type === 'thinking') && previous?.type === current.type && (previous.data.role ?? 'assistant') === role && !current.data.steering && !previous.data.steering) {
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

export function buildTimelineSections(timeline: TimelineEvent[], tasks: Task[] = [], latestTurn = true): TimelineSection[] {
  if (!timeline.length) return [];
  const turns: TimelineEvent[][] = [];
  for (const event of timeline) {
    // 插话不另起一轮，留在它并入的那一轮里。
    const userMessage = event.type === 'text' && event.data.role === 'user' && !event.data.steering;
    if (userMessage || !turns.length) turns.push([]);
    turns.at(-1)!.push(event);
  }

  const tasksById = new Map(tasks.map(task => [task.id, task]));
  return turns.flatMap((turn, turnIndex) => {
    const userMessage = turn.find(event => event.type === 'text' && event.data.role === 'user');
    // 插话并入了正在执行的那一轮，这一段的状态跟着那一轮走。
    const task = tasksById.get(userMessage?.data.steering?.target?.taskId ?? userMessage?.data.taskId ?? turn.find(event => event.taskId || event.data.taskId)?.taskId ?? turn.find(event => event.data.taskId)?.data.taskId);
    const terminal = task ? terminalTaskStatuses.has(task.status) : turnIndex < turns.length - 1 || !latestTurn;
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
      isLatestTurn: latestTurn && turnIndex === turns.length - 1,
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

/** Cache derived turns by their input references. Appending a token rebuilds
 * only its turn; old Markdown, tool groups and permission cards keep identity. */
export function createTimelineProjector() {
  type Cached = { source: DockEvent[]; task?: Task; latest: boolean; timeline: TimelineEvent[]; sections: TimelineSection[] };
  let cache = new Map<string, Cached>();
  let lastEvents: DockEvent[] | undefined;
  let lastTasks: Task[] | undefined;
  let lastHasOlder = false;
  let entries: Cached[] = [];
  let byTask = new Map<string, Task>();
  let hasSyntheticPrompts = false;
  const result = () => {
    let eventCount = 0, sectionCount = 0;
    for (let index = 0; index < entries.length; index++) {
      eventCount += entries[index]!.timeline.length; sectionCount += entries[index]!.sections.length;
    }
    const timeline = new Array<TimelineEvent>(eventCount), timelineSections = new Array<TimelineSection>(sectionCount);
    let eventIndex = 0, sectionIndex = 0;
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      for (let offset = 0; offset < entry.timeline.length; offset++) timeline[eventIndex++] = entry.timeline[offset]!;
      for (let offset = 0; offset < entry.sections.length; offset++) timelineSections[sectionIndex++] = entry.sections[offset]!;
    }
    return { timeline, timelineSections };
  };
  const taskFor = (source: DockEvent[]) => byTask.get(source.find(event => event.data.role === 'user')?.data.steering?.target?.taskId ?? source.find(event => event.data.role === 'user')?.data.taskId ?? source.find(event => event.taskId || event.data.taskId)?.taskId ?? source.find(event => event.data.taskId)?.data.taskId);
  return (events: DockEvent[], tasks: Task[] = [], hasOlder = false, delta?: { previousEvents?: DockEvent[]; changes?: DockEvent[] }) => {
    const changes = delta?.changes;
    const previous = entries.at(-1);
    // Appends carry their exact delta from the event cache. Avoid sorting,
    // grouping and comparing every historical input again on each live frame.
    if (previous && lastTasks === tasks && lastHasOlder === hasOlder && delta?.previousEvents === lastEvents && changes?.length
      && changes.every((event, index) => (index === 0 || event.timestamp >= changes[index - 1]!.timestamp) && event.sequence > (lastEvents?.at(-1)?.sequence ?? 0) && event.timestamp >= previous.source.at(-1)!.timestamp
        && event.type !== 'permission_request' && !warningText(event as TimelineEvent)
        && !(hasSyntheticPrompts && event.data.role === 'user'))) {
      const tail = [previous.source.slice()];
      for (const event of changes) {
        if (event.type === 'text' && event.data.role === 'user' && !event.data.steering) tail.push([]);
        tail.at(-1)!.push(event);
      }
      cache.delete(previous.source[0]!.id);
      entries.pop();
      for (let index = 0; index < tail.length; index++) {
        const source = tail[index]!, task = taskFor(source), latest = index === tail.length - 1;
        const timeline = buildTimeline(source);
        const entry = { source, task, latest, timeline, sections: buildTimelineSections(timeline, task ? [task] : [], latest) };
        entries.push(entry); cache.set(source[0]!.id, entry);
      }
      lastEvents = events;
      return result();
    }
    byTask = new Map(tasks.map(task => [task.id, task]));
    const source = [...events];
    // Missing legacy user messages are only synthesized inside the loaded range.
    const oldest = hasOlder ? events[0]?.timestamp : undefined;
    const taskIds = new Set(events.filter(event => event.data.role === 'user').map(event => event.data.taskId));
    const legacy = new Map<string, number>();
    for (const event of events) if (event.data.role === 'user' && !event.data.taskId) legacy.set(event.data.text, (legacy.get(event.data.text) ?? 0) + 1);
    hasSyntheticPrompts = false;
    for (const task of tasks) {
      if (task.status === 'queued' || task.status === 'cancelled' || taskIds.has(task.id) || (oldest && task.createdAt < oldest)) continue;
      const count = legacy.get(task.prompt) ?? 0;
      if (count) { legacy.set(task.prompt, count - 1); continue; }
      hasSyntheticPrompts = true;
      const id = `task-event-${task.id}`;
      const old = cache.get(id)?.source[0];
      source.push(old?.data.text === task.prompt ? old : { id, sequence: -1, type: 'text', timestamp: task.createdAt, data: { text: task.prompt, role: 'user', taskId: task.id } });
    }
    source.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sequence - b.sequence);
    const permissions = new Map<string, DockEvent>();
    for (const event of source) if (event.type === 'permission_request') permissions.set(String(event.data.id), event);
    const emittedPermissions = new Set<string>();
    const turns: DockEvent[][] = [];
    const warnings = new Set<string>();
    for (let event of source) {
      if (event.type === 'permission_request') {
        const permissionId = String(event.data.id);
        if (emittedPermissions.has(permissionId)) continue;
        emittedPermissions.add(permissionId); event = permissions.get(permissionId)!;
      }
      const warning = warningText(event as TimelineEvent)?.toLocaleLowerCase();
      if (warning && warnings.has(warning)) continue;
      if (warning) warnings.add(warning);
      if (!turns.length || (event.type === 'text' && event.data.role === 'user' && !event.data.steering)) turns.push([]);
      turns.at(-1)!.push(event);
    }
    const next = new Map<string, Cached>();
    const timeline: TimelineEvent[] = [];
    const sections: TimelineSection[] = [];
    for (let index = 0; index < turns.length; index++) {
      const source = turns[index]!;
      const key = source[0]!.id;
      const task = taskFor(source);
      const latest = index === turns.length - 1;
      let entry = cache.get(key);
      if (!entry || entry.task !== task || entry.latest !== latest || entry.source.length !== source.length || source.some((event, i) => entry!.source[i] !== event)) {
        const derived = buildTimeline(source);
        entry = { source, task, latest, timeline: derived, sections: buildTimelineSections(derived, task ? [task] : [], latest) };
      }
      next.set(key, entry);
      for (const event of entry.timeline) timeline.push(event); for (const section of entry.sections) sections.push(section);
    }
    cache = next; entries = [...next.values()]; lastEvents = events; lastTasks = tasks; lastHasOlder = hasOlder;
    return { timeline, timelineSections: sections };
  };
}
