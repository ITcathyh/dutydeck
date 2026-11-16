type Task = { id: string; toolUseId: string; kind: 'agent' | 'shell' | 'monitor'; originInputId?: string; state: string; expiresAt?: number };
type Generation = { sinceMs?: number; resumed: boolean };
type Run = { sinceMs?: number; endedAtMs?: number; endPosition?: TranscriptPosition; active: Generation[]; notices: NoticeIndex };
type NoticeShape = 'queue' | 'user' | 'attachment';
type NoticeOccurrence = { id: number; mask: number; natives: Set<string>; lineage: string };
type NoticeBucket = { pending: number; missing: Map<string, Map<number, NoticeOccurrence>>[] };
type NoticeIndex = { buckets: Map<string, NoticeBucket>; seen: Set<string>; nextId: number; pending: number };

const NOTICE_INDEX_MAX = 20_000;
const ORPHAN_NOTICES_MAX = 20_000;
const shapes: NoticeShape[] = ['queue', 'user', 'attachment'];
const shapeBit = (shape: NoticeShape) => 1 << shapes.indexOf(shape);

function emptyNoticeIndex(): NoticeIndex {
  return { buckets: new Map(), seen: new Set(), nextId: 0, pending: 0 };
}

function noticeLineage(natives: Set<string>): string {
  return natives.size === 1 ? natives.values().next().value! : `\0${JSON.stringify([...natives].sort())}`;
}

function addCandidate(bucket: NoticeBucket, occurrence: NoticeOccurrence, shape: NoticeShape): void {
  const groups = bucket.missing[shapes.indexOf(shape)]!;
  let queue = groups.get(occurrence.lineage);
  if (!queue) { queue = new Map(); groups.set(occurrence.lineage, queue); }
  queue.set(occurrence.id, occurrence);
}

function removeCandidate(bucket: NoticeBucket, occurrence: NoticeOccurrence, shape: NoticeShape): void {
  const groups = bucket.missing[shapes.indexOf(shape)]!;
  const queue = groups.get(occurrence.lineage);
  if (!queue) return;
  queue.delete(occurrence.id);
  if (queue.size === 0) groups.delete(occurrence.lineage);
}

function createOccurrence(index: NoticeIndex, bucket: NoticeBucket, shape: NoticeShape, nativeKey: string): NoticeOccurrence {
  const occurrence: NoticeOccurrence = { id: index.nextId++, mask: shapeBit(shape), natives: new Set([nativeKey]), lineage: nativeKey };
  for (const other of shapes) if (other !== shape) addCandidate(bucket, occurrence, other);
  bucket.pending++;
  index.pending++;
  return occurrence;
}

function taskNotificationText(entry: any): string | undefined {
  const content = entry?.message?.content;
  return entry?.type === 'queue-operation' && entry.operation === 'enqueue' ? entry.content
    : entry?.attachment?.type === 'queued_command' && entry.attachment.commandMode === 'task-notification' ? entry.attachment.prompt
    : entry?.turnOrigin === 'task_notification' || entry?.origin?.kind === 'task-notification'
      ? typeof content === 'string' ? content : content?.filter?.((block: any) => block.type === 'text').map((block: any) => block.text).join('\n') : undefined;
}

function taskNotificationIds(text: string): string[] {
  return [...text.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map(match => match[1]!.trim());
}

/** Native Claude task lifecycle metadata; tool-result prose is never a launch receipt. */
export class ClaudeBackgroundTasks {
  private readonly calls = new Map<string, { name: string; originInputId?: string }>();
  private readonly tasks = new Map<string, Task>();
  private readonly runs = new Map<string, Run>();
  private readonly observedPositions = new Set<string>();
  private readonly orphanNotices = new Map<string, NoticeIndex>();
  private orphanNoticeWeight = 0;
  private inputId?: string;
  private readonly inputEntries = new Set<string>();
  private readonly notificationEntries = new Set<string>();
  private notification = false;
  private ended = false;

  observe(entry: any, position?: TranscriptPosition): boolean {
    return this.observeEntry(entry, position, false);
  }

  /** A sibling transcript can prove only lifecycle for identities already owned here. */
  observeLifecycle(entry: any, position?: TranscriptPosition): boolean {
    if (!['queue-operation', 'user', 'attachment'].includes(entry?.type)) return false;
    const text = taskNotificationText(entry);
    if (typeof text !== 'string' || !text.trimStart().startsWith('<task-notification>')) return false;
    const state = /<status>(completed|failed|killed|stopped)<\/status>/.exec(text)?.[1];
    const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(text)?.[1]?.trim();
    const ids = taskNotificationIds(text);
    const task = ids.length === 1 ? this.tasks.get(ids[0]!) : undefined;
    if (!state || !task || (toolUseId !== undefined && task.toolUseId !== toolUseId)) return false;
    return this.observeEntry(entry, position, true);
  }

  private observeEntry(entry: any, position: TranscriptPosition | undefined, lifecycleOnly: boolean): boolean {
    if (entry?.isSidechain === true) return false;
    // A physical replay is not a new launch. Include the record because a
    // truncated sibling can legitimately reuse an offset for different bytes.
    const positionKey = position ? createHash('sha256').update(JSON.stringify([position, entry])).digest('base64') : undefined;
    if (positionKey && this.observedPositions.has(positionKey)) return false;
    if (positionKey) {
      this.observedPositions.add(positionKey);
      while (this.observedPositions.size > 20_000) this.observedPositions.delete(this.observedPositions.values().next().value!);
    }
    const parsedAt = Date.parse(entry.timestamp);
    const atMs = Number.isFinite(parsedAt) ? parsedAt : undefined;
    const before = JSON.stringify(this.snapshot());
    const content = entry.message?.content;
    // A late notification can interleave with an already accepted input.
    // Parent ancestry takes precedence over the last no-parent legacy record.
    if (!lifecycleOnly) {
      if (this.inputEntries.has(entry.parentUuid)) this.notification = false;
      else if (this.notificationEntries.has(entry.parentUuid)) this.notification = true;
    }
    const notificationText = taskNotificationText(entry);
    if (typeof notificationText === 'string' && notificationText.trimStart().startsWith('<task-notification>')) {
      const ids = taskNotificationIds(notificationText);
      if (!lifecycleOnly && entry.type === 'user') this.notification = ids.some(id => {
        const task = this.tasks.get(id);
        return task && (this.ended || task.originInputId !== this.inputId);
      });
      const state = /<status>(completed|failed|killed|stopped)<\/status>/.exec(notificationText)?.[1];
      const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(notificationText)?.[1]?.trim();
      const nativeSessionId = typeof entry.sessionId === 'string' && entry.sessionId ? entry.sessionId
        : typeof entry.session_id === 'string' && entry.session_id ? entry.session_id : undefined;
      const sourceShape: NoticeShape = entry.type === 'queue-operation' ? 'queue' : entry.type === 'user' ? 'user' : 'attachment';
      if (state) for (const id of ids) {
        const task = this.tasks.get(id);
        const run = task ? this.runs.get(id) : undefined;
        if (lifecycleOnly && (!task || !run)) continue;
        const canonicalKey = createHash('sha256').update(JSON.stringify([toolUseId ?? null, state, notificationText])).digest('base64');
        const observationKey = createHash('sha256').update(JSON.stringify([sourceShape, toolUseId ?? null, state, atMs ?? null, notificationText])).digest('base64');
        const outcome = run ? this.observeNotice(run.notices, canonicalKey, observationKey, sourceShape, nativeSessionId ?? '')
          : this.observeOrphanNotice(id, canonicalKey, observationKey, sourceShape, nativeSessionId ?? '');
        // A first, unambiguous observation may settle one generation. Mirrors,
        // same-shape replays and ambiguous owners only add structural evidence.
        if (outcome === 'new' && task && run && (!toolUseId || task.toolUseId === toolUseId)) {
          this.settle(task, state, atMs, position, false);
        }
      }
    } else if (!lifecycleOnly && claudeInputText(entry) !== undefined && !entry.isMeta) {
      this.inputId = entry.uuid; this.notification = false; this.ended = false;
      this.inputEntries.clear();
    }
    if (!lifecycleOnly && typeof entry.uuid === 'string') {
      if (this.notification) this.notificationEntries.add(entry.uuid);
      else this.inputEntries.add(entry.uuid);
    }
    if (!lifecycleOnly && entry.type === 'assistant' && Array.isArray(content) && !this.notification) {
      for (const block of content) if (block.type === 'tool_use' && typeof block.id === 'string') this.calls.set(block.id, { name: block.name, originInputId: this.inputId });
      if (entry.message?.stop_reason === 'end_turn' && content.some((block: any) => block.type === 'text' && block.text?.trim())) this.ended = true;
    }
    if (!lifecycleOnly && entry.type === 'user' && Array.isArray(content)) {
      const result = entry.toolUseResult;
      for (const block of content) {
        const call = this.calls.get(block.tool_use_id);
        if (block.type !== 'tool_result' || block.is_error || !call || !result || typeof result !== 'object') continue;
        let task: { id: string; kind: Task['kind']; expiresAt?: number } | undefined;
        let resumed = false;
        if (['Agent', 'Task'].includes(call.name) && result.isAsync === true && typeof result.agentId === 'string') task = { id: result.agentId, kind: 'agent' };
        else if (call.name === 'Bash' && typeof result.backgroundTaskId === 'string') task = { id: result.backgroundTaskId, kind: 'shell' };
        else if (call.name === 'Monitor' && typeof result.taskId === 'string' && typeof result.persistent === 'boolean' && Number.isFinite(result.timeoutMs)) {
          task = { id: result.taskId, kind: 'monitor', ...(!result.persistent && result.timeoutMs > 0 && atMs !== undefined ? { expiresAt: atMs + result.timeoutMs } : {}) };
        } else if (call.name === 'SendMessage' && result.success !== false) {
          const id = typeof result.resumedAgentId === 'string' && result.resumedAgentId ? result.resumedAgentId
            : typeof result.revivedAgentId === 'string' && result.revivedAgentId ? result.revivedAgentId : undefined;
          if (id) { task = { id, kind: 'agent' }; resumed = true; }
        } else if (call.name === 'TaskStop' && typeof result.task_id === 'string' && typeof result.task_type === 'string') {
          const stopped = this.tasks.get(result.task_id); if (stopped) this.settle(stopped, 'stopped', atMs, position, stopped.kind === 'agent');
        }
        if (task?.id) {
          const existing = this.tasks.get(task.id);
          const run = this.runs.get(task.id) ?? { active: [], notices: this.adoptOrphanNotices(task.id) };
          if (resumed) {
            // Every accepted resume adds a generation and must be strictly
            // newer than both the latest start and latest end.
            if (atMs !== undefined && (run.sinceMs === undefined || atMs > run.sinceMs)
              && (run.endedAtMs === undefined || atMs > run.endedAtMs)
              && (existing?.state === 'running' || !existing || run.endedAtMs !== undefined)) {
              this.tasks.set(task.id, {
                ...task, toolUseId: existing ? existing.toolUseId : block.tool_use_id,
                originInputId: call.originInputId, state: 'running',
              });
              this.runs.set(task.id, { ...run, sinceMs: atMs, active: [...run.active, { sinceMs: atMs, resumed: true }] });
            }
          } else {
            this.tasks.set(task.id, { ...task, toolUseId: block.tool_use_id, originInputId: call.originInputId, state: 'running' });
            this.runs.set(task.id, { ...run, sinceMs: atMs, active: [{ sinceMs: atMs, resumed: false }] });
          }
        }
        this.calls.delete(block.tool_use_id);
      }
    }
    // Metadata is bounded independently of session length; retain live tasks.
    if (this.tasks.size > 1000) for (const [id, task] of this.tasks) {
      if (task.state !== 'running') { this.tasks.delete(id); this.runs.delete(id); }
      if (this.tasks.size <= 1000) break;
    }
    while (this.calls.size > 1000) this.calls.delete(this.calls.keys().next().value!);
    while (this.notificationEntries.size > 20_000) this.notificationEntries.delete(this.notificationEntries.values().next().value!);
    return this.tasks.size > 0 && before !== JSON.stringify(this.snapshot());
  }

  private observeNotice(index: NoticeIndex, key: string, observation: string, shape: NoticeShape, nativeKey: string,
    orphan = false): 'new' | 'mirror' | 'replay' | 'ambiguous' | 'saturated' {
    const replay = index.seen.has(observation);
    if (!replay && index.seen.size >= NOTICE_INDEX_MAX) return 'saturated';
    let bucket = index.buckets.get(key);
    const groups = bucket?.missing[shapes.indexOf(shape)];
    const exact = groups?.get(nativeKey);
    const only = groups?.size === 1 ? groups.values().next().value! : undefined;
    const candidates = exact?.size ? exact : only;
    if (!replay && index.pending >= NOTICE_INDEX_MAX && !candidates) return 'saturated';
    if (replay && index.pending >= NOTICE_INDEX_MAX) return 'saturated';
    if (!replay) {
      index.seen.add(observation);
      if (orphan) this.orphanNoticeWeight++;
    }
    if (!bucket) {
      bucket = { pending: 0, missing: [new Map(), new Map(), new Map()] };
      index.buckets.set(key, bucket);
    }
    if (!replay && candidates) {
      const occurrence = candidates.values().next().value!;
      removeCandidate(bucket, occurrence, shape);
      occurrence.mask |= shapeBit(shape);
      occurrence.natives.add(nativeKey);
      const lineage = noticeLineage(occurrence.natives);
      if (lineage !== occurrence.lineage) {
        for (const other of shapes) if ((occurrence.mask & shapeBit(other)) === 0) removeCandidate(bucket, occurrence, other);
        occurrence.lineage = lineage;
        for (const other of shapes) if ((occurrence.mask & shapeBit(other)) === 0) addCandidate(bucket, occurrence, other);
      }
      if (occurrence.mask === 7) {
        bucket.pending--; index.pending--;
        if (orphan) this.orphanNoticeWeight--;
        if (bucket.pending === 0) index.buckets.delete(key);
      }
      return 'mirror';
    }
    createOccurrence(index, bucket, shape, nativeKey);
    if (orphan) this.orphanNoticeWeight++;
    return replay ? 'replay' : groups?.size && !candidates ? 'ambiguous' : 'new';
  }

  private observeOrphanNotice(id: string, key: string, observation: string, shape: NoticeShape, nativeKey: string): 'new' | 'mirror' | 'replay' | 'ambiguous' | 'saturated' {
    let index = this.orphanNotices.get(id);
    if (!index) {
      if (this.orphanNoticeWeight >= ORPHAN_NOTICES_MAX) return 'saturated';
      index = emptyNoticeIndex();
      this.orphanNotices.set(id, index);
    }
    // Unknown-task compatibility is bounded without evicting old evidence. A
    // task launch adopts its index; known runs never share this global limit.
    if (this.orphanNoticeWeight >= ORPHAN_NOTICES_MAX) return 'saturated';
    return this.observeNotice(index, key, observation, shape, nativeKey, true);
  }

  private adoptOrphanNotices(id: string): NoticeIndex {
    const orphan = this.orphanNotices.get(id);
    if (!orphan) return emptyNoticeIndex();
    this.orphanNoticeWeight -= orphan.seen.size + orphan.pending;
    this.orphanNotices.delete(id);
    return orphan;
  }

  private settle(task: Task, state: string, atMs: number | undefined, position: TranscriptPosition | undefined, allAgentGenerations = false): Generation | undefined {
    const run = this.runs.get(task.id);
    if (!run) return undefined;
    let settled: Generation | undefined;
    if (allAgentGenerations) {
      if (run.active.length === 0) return undefined;
      run.active.length = 0;
    } else {
      // Assign a notice to the oldest generation its own timestamp can settle.
      const generationIndex = run.active.findIndex(generation => generation.resumed
        ? atMs !== undefined && generation.sinceMs !== undefined && atMs > generation.sinceMs
        : generation.sinceMs === undefined || atMs === undefined || atMs >= generation.sinceMs);
      if (generationIndex < 0) return undefined;
      settled = run.active.splice(generationIndex, 1)[0];
    }
    if (allAgentGenerations || run.endedAtMs === undefined || (atMs !== undefined && atMs > run.endedAtMs)) {
      run.endedAtMs = atMs;
      run.endPosition = position;
    }
    task.state = run.active.length > 0 ? 'running' : state;
    return settled;
  }

  snapshot() {
    const tasks = [...this.tasks.values()].map(task => task.state === 'running' && task.expiresAt !== undefined && task.expiresAt <= Date.now() ? { ...task, state: 'expired' } : { ...task });
    return { state: 'background_work', count: tasks.filter(task => task.state === 'running').length, mainTurnEnded: this.ended, tasks };
  }
  isNotificationContinuation(): boolean { return this.notification; }
  independent(): boolean { return this.ended && this.snapshot().count > 0; }
}
import { createHash } from 'node:crypto';
import { claudeInputText } from './input-receipt.js';
import type { TranscriptPosition } from './tail.js';
