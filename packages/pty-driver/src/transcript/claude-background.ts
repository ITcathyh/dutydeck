type Task = { id: string; toolUseId: string; kind: 'agent' | 'shell' | 'monitor'; originInputId?: string; state: string; expiresAt?: number };
type Generation = { sinceMs?: number; resumed: boolean };
type Run = { sinceMs?: number; endedAtMs?: number; endPosition?: TranscriptPosition; active: Generation[] };
type MirrorSlot = { key: string; generation?: Generation };

const MIRROR_SLOTS_MAX = 20_000;

/** Native Claude task lifecycle metadata; tool-result prose is never a launch receipt. */
export class ClaudeBackgroundTasks {
  private readonly calls = new Map<string, { name: string; originInputId?: string }>();
  private readonly tasks = new Map<string, Task>();
  private readonly runs = new Map<string, Run>();
  private readonly observedPositions = new Set<string>();
  private readonly settledNotifications = new Set<string>();
  private readonly mirrorSlots: MirrorSlot[] = [];
  private mirrorOverflow = false;
  private inputId?: string;
  private readonly inputEntries = new Set<string>();
  private readonly notificationEntries = new Set<string>();
  private notification = false;
  private ended = false;

  observe(entry: any, position?: TranscriptPosition): boolean {
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
    if (this.inputEntries.has(entry.parentUuid)) this.notification = false;
    else if (this.notificationEntries.has(entry.parentUuid)) this.notification = true;
    const notificationText = entry.type === 'queue-operation' && entry.operation === 'enqueue' ? entry.content
      : entry.attachment?.type === 'queued_command' && entry.attachment.commandMode === 'task-notification' ? entry.attachment.prompt
      : entry.turnOrigin === 'task_notification' || entry.origin?.kind === 'task-notification'
        ? typeof content === 'string' ? content : content?.filter?.((block: any) => block.type === 'text').map((block: any) => block.text).join('\n') : undefined;
    if (typeof notificationText === 'string' && notificationText.trimStart().startsWith('<task-notification>')) {
      const ids = [...notificationText.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map(match => match[1]!.trim());
      if (entry.type === 'user') this.notification = ids.some(id => {
        const task = this.tasks.get(id);
        return task && (this.ended || task.originInputId !== this.inputId);
      });
      const state = /<status>(completed|failed|killed|stopped)<\/status>/.exec(notificationText)?.[1];
      const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(notificationText)?.[1]?.trim();
      const nativeSessionId = typeof entry.sessionId === 'string' && entry.sessionId ? entry.sessionId
        : typeof entry.session_id === 'string' && entry.session_id ? entry.session_id : undefined;
      const sourceShape = entry.type === 'queue-operation' ? 'queue' : entry.type === 'user' ? 'user' : 'attachment';
      if (state) for (const id of ids) {
        const mirrorKey = nativeSessionId && toolUseId && id
          ? JSON.stringify([nativeSessionId, id, toolUseId, state, notificationText]) : undefined;
        const fingerprint = JSON.stringify([nativeSessionId, sourceShape, id, toolUseId, state, atMs, notificationText]);
        if (entry.type === 'user' && mirrorKey && this.consumeMirrorSlot(mirrorKey)) {
          // The queue already settled (or deliberately did not settle) this exact notice.
          this.rememberNotification(fingerprint);
          continue;
        }
        // Once evidence has been evicted, an unmatched user may be an old mirror.
        // Keep the generation running rather than guessing that it is a new result.
        if (entry.type === 'user' && this.mirrorOverflow) continue;
        const task = this.tasks.get(id);
        let generation: Generation | undefined;
        if (task && (!toolUseId || task.toolUseId === toolUseId)
          && (task.kind !== 'agent' || !this.settledNotifications.has(fingerprint))) {
          generation = this.settle(task, state, atMs, position, false);
          if (generation && task.kind === 'agent') this.rememberNotification(fingerprint);
        }
        // Every eligible queue enqueue owns one slot, including no-op and late replay.
        if (entry.type === 'queue-operation' && mirrorKey) this.addMirrorSlot(mirrorKey, generation);
      }
    } else if (claudeInputText(entry) !== undefined && !entry.isMeta) {
      this.inputId = entry.uuid; this.notification = false; this.ended = false;
      this.inputEntries.clear();
    }
    if (typeof entry.uuid === 'string') {
      if (this.notification) this.notificationEntries.add(entry.uuid);
      else this.inputEntries.add(entry.uuid);
    }
    if (entry.type === 'assistant' && Array.isArray(content) && !this.notification) {
      for (const block of content) if (block.type === 'tool_use' && typeof block.id === 'string') this.calls.set(block.id, { name: block.name, originInputId: this.inputId });
      if (entry.message?.stop_reason === 'end_turn' && content.some((block: any) => block.type === 'text' && block.text?.trim())) this.ended = true;
    }
    if (entry.type === 'user' && Array.isArray(content)) {
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
          const run = this.runs.get(task.id) ?? { active: [] };
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

  private addMirrorSlot(key: string, generation: Generation | undefined): void {
    this.mirrorSlots.push({ key, generation });
    if (this.mirrorSlots.length > MIRROR_SLOTS_MAX) {
      this.mirrorSlots.shift();
      this.mirrorOverflow = true;
    }
  }

  private consumeMirrorSlot(key: string): boolean {
    const index = this.mirrorSlots.findIndex(slot => slot.key === key);
    if (index < 0) return false;
    this.mirrorSlots.splice(index, 1);
    return true;
  }

  private rememberNotification(fingerprint: string): void {
    this.settledNotifications.add(fingerprint);
    while (this.settledNotifications.size > 20_000) this.settledNotifications.delete(this.settledNotifications.values().next().value!);
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
