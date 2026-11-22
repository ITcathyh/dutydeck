import type { AgentDriver, AgentEvent, AttemptRef, EventType, NormalizedDriverEvent, RepositoryBundle, Session, SessionFence, ToolCallData } from '@dutydeck/shared';
import { canonicalExecutionJson, deferredConfirmationId, eventHasContent, isBackgroundFollowup, makeId, normalizeEventContent, now, RuntimeError, withTimeout } from '@dutydeck/shared';
import type { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { RuntimeHost } from './host-ports.js';
import { digest, eventJson } from '../ledger.js';
import type { RuntimeSessionMutations, Owner } from '../ownership.js';
import type { SessionGate } from '../session-gate.js';
import { isAttemptRef } from './attempt-ref.js';
import type { DriverSupervisor } from './driver-supervisor.js';
import type { HumanWaits } from './human-waits.js';
import type { Scheduler } from './scheduler.js';

const EXIT_DRAIN_TIMEOUT_MS = 5_000;

const settledToolStatus = (status?: ToolCallData['status']) => status === 'completed' || status === 'failed';

function mergeToolCall(data: ToolCallData, previous?: ToolCallData): ToolCallData {
  const merged = { ...previous, ...data, name: data.name ?? previous?.name ?? 'tool', startedAt: previous?.startedAt ?? data.startedAt ?? now() };
  // 工具结束后 Agent 还会补发不带状态的更新（codex-acp 实测晚 35 秒），ACP 里这表示状态不变，
  // 归一化层却记成 running；已结束的工具不能退回执行中，否则整轮收尾时会被当成工具没返回而判失败。
  if (settledToolStatus(previous?.status) && !settledToolStatus(data.status)) merged.status = previous!.status;
  if (settledToolStatus(merged.status)) merged.completedAt = data.completedAt ?? previous?.completedAt ?? now();
  else delete merged.completedAt;
  return merged;
}

interface AttemptTools {
  calls: Map<string, { sequence: number; data: ToolCallData; projected: boolean }>;
  events: Map<string, { inputDigest: string; data: ToolCallData }>;
  replayData?: Map<string, ToolCallData>;
}

interface EventIngestDependencies {
  artifact<K extends 'saveError' | 'saveToolCall'>(method: K, ...args: Parameters<RepositoryBundle['artifacts'][K]>): Promise<unknown>;
  currentRef: (id: string) => (AttemptRef & SessionFence) | SessionFence | undefined;
  emit: (sessionId: string, type: EventType, data: unknown, raw?: string, eventId?: string, sourceId?: string) => Promise<AgentEvent<unknown>>;
  eventScope: AsyncLocalStorage<SessionFence | (AttemptRef & SessionFence)>;
  fence: (session: Session) => SessionFence;
  gate: SessionGate;
  humanWaits: HumanWaits;
  noteAgentFailure: (agentId: string, failure: { code?: unknown; detailCode?: unknown; message?: unknown; }) => Promise<void>;
  options: Pick<RuntimeHost, 'log' | 'events'>;
  repos: RepositoryBundle;
  saveState: (session: Session, state: Session["state"], error?: string) => Promise<void>;
  scheduler: Pick<Scheduler, 'sessionHeld' | 'wakeResourceQueues'>;
  sessionGenerations: ReadonlyMap<string, number>;
  shuttingDown(): boolean;
  supervisor: Pick<DriverSupervisor, 'drivers' | 'touch'>;
  turnProgressAt: Map<string, number>;
}

export class EventIngest {
  constructor(private readonly mutations: RuntimeSessionMutations, private readonly deps: EventIngestDependencies) {}

  private readonly completedTurns = new Set<string>();
  private readonly attemptTools = new Map<string, AttemptTools>();
  private readonly driverEventChains = new Map<string, Promise<void>>();
  private readonly exitedDriverDrains = new WeakMap<AgentDriver, { source: Promise<void>; settled: Promise<unknown> }>();
  private readonly exitDrainAdmissions = new Map<string, { driver: AgentDriver; generation: number; settled: Promise<unknown> }>();
  private readonly compactionCancellationVersions = new Map<string, number>();
  private readonly driverEventErrors = new Map<string, unknown>();
  /** Attempts whose last in-turn event flush has run: a later event error can no longer fail them, nor the next turn. */
  private readonly eventFlushedAttempts = new Set<string>();
  private readonly driverStopReasons = new Map<string, string>();
  private readonly turnErrors = new Map<string, string>();
  private enqueueDriverEvent(session: Session, event: NormalizedDriverEvent, generation: number, token: Owner) {
    const ref = this.mutations.attemptRefs.get(token) ?? this.deps.fence(session);
    const eventId = event.sourceId ? this.driverEventId(ref, event.sourceId) : makeId('evt');
    const previous = this.driverEventChains.get(session.id) ?? Promise.resolve();
    const next = previous.then(() => this.mutations.run(token, async () => {
      if (this.deps.sessionGenerations.get(session.id) !== generation || !this.mutations.valid(token)) return;
      // 插件审批钩子可能一直等到超时，不能占着会话写锁；同一会话之后的驱动事件仍按顺序排在它后面。
      const hostDecision = await this.deps.humanWaits.reviewHostPermission(session, ref, event);
      if (this.deps.sessionGenerations.get(session.id) !== generation) return;
      await this.deps.eventScope.run(ref, () => this.mutations.write(session.id, () => this.consume(session, event, eventId, hostDecision)));
      if (isAttemptRef(ref)) await this.recordUsage(session, ref, event);
    })).catch(error => {
      if (!this.mutations.valid(token) || this.deps.sessionGenerations.get(session.id) !== generation) return;
      // 只有轮次内的事件错误留给当轮结算；两轮之间的事件与下一条消息无关，记日志后丢弃。
      if (isAttemptRef(ref) && !this.eventFlushedAttempts.has(ref.attemptId)) { if (!this.driverEventErrors.has(session.id)) this.driverEventErrors.set(session.id, error); return; }
      this.deps.options.log?.warn({ sessionId: session.id, eventType: event.type, code: error instanceof RuntimeError ? error.code : 'DRIVER_EVENT_FAILED', error }, 'Idle driver event could not be recorded');
    });
    this.driverEventChains.set(session.id, next);
    // A held session gives no idle proof; releasing the hold wakes the queues itself.
    void next.finally(() => { if (this.driverEventChains.get(session.id) === next) this.driverEventChains.delete(session.id); if ((event.type === 'status' || event.type === 'completed') && !this.deps.scheduler.sessionHeld(session.id)) this.deps.scheduler.wakeResourceQueues(); });
  }
  private async recordUsage(session: Session, ref: AttemptRef, event: NormalizedDriverEvent) {
    const usage = event.type === 'status' && event.data?.state === 'turn_usage';
    if (!this.deps.options.events.observed || !usage && event.type !== 'completed') return;
    // best-effort: usage accounting is separate from turn settlement.
    await this.deps.options.events.publish({ type: 'usage.reading', session, attempt: { taskId: ref.taskId, attemptId: ref.attemptId }, reading: usage ? event.data : undefined }).catch(() => {});
  }
  async flushDriverEvents(sessionId: string) {
    while (true) {
      this.mutations.check();
      const pending = this.driverEventChains.get(sessionId);
      if (!pending) break;
      await this.mutations.wait(() => pending);
      if (this.driverEventChains.get(sessionId) === pending) break;
    }
    this.mutations.check();
    const error = this.driverEventErrors.get(sessionId);
    this.driverEventErrors.delete(sessionId);
    if (error) throw error;
  }
  /** Share one bounded driver-tail and Runtime-persistence drain before either error cleanup or stop revokes ownership. */
  settleExitedDriver(sessionId: string, driver: AgentDriver | undefined, source = driver?.drainExitedOutput?.()): Promise<unknown> {
    if (!driver || !source) return Promise.resolve(undefined);
    const cached = this.exitedDriverDrains.get(driver);
    if (cached?.source === source) return cached.settled;
    const settled = (async () => {
      let failure: unknown;
      const persisted = (async () => { await source; await this.flushDriverEvents(sessionId); })();
      try { await withTimeout(persisted, EXIT_DRAIN_TIMEOUT_MS, () => new RuntimeError('DRIVER_EXIT_DRAIN_TIMEOUT', 'Agent exit output drain timed out; late terminal events remain fenced', 409)); }
      catch (error) { failure = error; }
      if (failure) this.deps.options.log?.warn({ sessionId, code: failure instanceof RuntimeError ? failure.code : 'DRIVER_EXIT_DRAIN_FAILED', error: failure }, 'Agent exit output drain did not settle');
      return failure;
    })();
    this.exitedDriverDrains.set(driver, { source, settled });
    const admission = { driver, generation: this.deps.sessionGenerations.get(sessionId) ?? 0, settled };
    this.exitDrainAdmissions.set(sessionId, admission);
    void settled.then(() => { if (this.exitDrainAdmissions.get(sessionId) === admission) this.exitDrainAdmissions.delete(sessionId); });
    return settled;
  }
  private static isTruncatedStopReason(reason?: string) {
    return reason === 'max_tokens' || reason === 'truncated';
  }
  turnOutput(ref: AttemptRef) {
    const events: AgentEvent[] = [];
    let afterSequence = 0;
    for (;;) {
      const page = this.deps.repos.execution.getAttemptEvents(ref.attemptId, { afterSequence, limit: 200 });
      events.push(...page);
      if (page.length < 200) break;
      afterSequence = page.at(-1)!.sequence;
    }
    const firstToolCall = new Map<string, number>();
    // driverEventData 会把缺失 id 字符串化并加轮次前缀；这些事件仍必须作为分隔符。
    const missingToolCallIds = new Set(['', 'undefined', 'null'].map(id => this.scopedId(ref, id)));
    for (const [index, event] of events.entries()) {
      if (event.type !== 'tool_call') continue;
      const id = (event.data as { id?: unknown }).id;
      if (typeof id === 'string' && id && !missingToolCallIds.has(id) && !firstToolCall.has(id)) firstToolCall.set(id, index);
    }
    let finalContent = false;
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]!;
      if (event.type === 'thinking' || event.type === 'tool_result') break;
      if (event.type === 'tool_call') {
        const data = event.data as { id?: unknown; status?: ToolCallData['status'] };
        const first = typeof data.id === 'string' && !missingToolCallIds.has(data.id) ? firstToolCall.get(data.id) : undefined;
        if (first === undefined || first === index || settledToolStatus(data.status)) break;
        continue;
      }
      if (event.type === 'text' && (event.data as { role?: string })?.role !== 'user' && eventHasContent(event.data as { text?: unknown; parts?: unknown })) finalContent = true;
    }
    const confirmation = deferredConfirmationId(events, ref.taskId);
    const stopReason = confirmation ? `deferred:${confirmation}` : this.driverStopReasons.get(ref.attemptId) ?? 'end_turn';
    const error = this.turnErrors.get(ref.attemptId);
    const status = confirmation ? 'cancelled' : stopReason === 'cancelled' ? 'interrupted'
      : error || EventIngest.isTruncatedStopReason(stopReason) || !finalContent ? 'failed' : 'completed';
    const text = events.filter(event => event.type === 'text').map(event => event.data as { role?: string; text?: unknown })
      .filter(data => data.role !== 'user' && typeof data.text === 'string').map(data => data.text).join('');
    const messages = events.filter(event => event.type === 'text' && (event.data as { role?: string })?.role !== 'user');
    const structured = messages.some(event => normalizeEventContent((event.data as { parts?: unknown })?.parts).some(part => part.type !== 'text'));
    // Keep legacy text receipts stable; structured receipts cover the persisted content and its trusted event identity.
    const output = structured ? canonicalExecutionJson(messages.map(event => ({ id: event.id, sequence: event.sequence, text: (event.data as { text?: unknown }).text ?? '', parts: normalizeEventContent((event.data as { parts?: unknown }).parts) }))) : text;
    return { status, stopReason, confirmation, outputDigest: createHash('sha256').update(output, 'utf8').digest('hex') } as const;
  }
  onDriverEvent(session: Session, generation: number) {
    const lifecycle = this.mutations.owners.lifecycle(session.id);
    return (event: NormalizedDriverEvent) => {
      const admission = this.exitDrainAdmissions.get(session.id);
      const currentDriver = this.deps.supervisor.drivers.get(session.id) ?? this.deps.gate.stops.driver(session.id)?.driver;
      const admittedDuringShutdown = admission && admission.driver === currentDriver && admission.generation === generation;
      if ((this.deps.shuttingDown() && !admittedDuringShutdown) || !this.mutations.valid(lifecycle) || this.deps.sessionGenerations.get(session.id) !== generation) return;
      if (event.type === 'status' && event.data?.state === 'compaction' && event.data.phase === 'cancelled') {
        this.compactionCancellationVersions.set(session.id, (this.compactionCancellationVersions.get(session.id) ?? 0) + 1);
      }
      // A background follow-up is a run-level event: it neither extends nor joins the active Attempt.
      const attempt = isBackgroundFollowup(event) ? undefined : this.mutations.attempts.get(session.id);
      if (attempt && !(event.type === 'status' && event.data?.state === 'prompt_assembly')) this.deps.turnProgressAt.set(session.id, Date.now());
      this.enqueueDriverEvent(session, event, generation, attempt ?? lifecycle);
    };
  }
  private driverEventId(ref: SessionFence | (SessionFence & AttemptRef), sourceId: string) {
    return `evt_v1_${digest([ref.sessionId, isAttemptRef(ref) ? ['attempt', ref.attemptId] : ['run', ref.runId], sourceId])}`;
  }
  private scopedId(scope: SessionFence | AttemptRef | undefined, nativeId: string): string {
    return scope && isAttemptRef(scope) ? `turn_${digest([scope.taskId, scope.attemptId, nativeId])}` : nativeId;
  }
  /** 驱动事件写入账本前的形态：内容归一化，轮次内的原生 id 加上轮次前缀。 */
  driverEventData(scope: SessionFence | undefined, event: NormalizedDriverEvent) {
    let data = event.data;
    if (data && Array.isArray(data.parts)) data = { ...data, parts: normalizeEventContent(data.parts) };
    if (event.type !== 'permission_request' && event.type !== 'tool_call' && event.type !== 'tool_result') return data;
    return { ...data, id: this.scopedId(scope, String(data.id)), ...(data.toolCallId ? { toolCallId: this.scopedId(scope, String(data.toolCallId)) } : {}) };
  }
  async consume(session: Session, event: NormalizedDriverEvent, eventId: string, hostDecision?: 'allow' | 'deny') {
    const scope = this.deps.currentRef(session.id);
    if (event.type === 'status' && event.data?.state === 'prompt_assembly') {
      // Diagnostic persistence must neither refresh idleness nor fail the turn.
      await this.deps.emit(session.id, 'status', event.data, undefined, eventId, event.sourceId).catch(() => {});
      return;
    }
    this.deps.supervisor.touch(session.id);
    if (event.type === 'completed') {
      if (scope && isAttemptRef(scope)) {
        this.deps.humanWaits.clearOscWait(scope.attemptId);
        this.completedTurns.add(scope.attemptId);
        if (typeof event.data?.stopReason === 'string') this.driverStopReasons.set(scope.attemptId, event.data.stopReason);
      }
      return;
    }
    let data = this.driverEventData(scope, event);
    if (event.type === 'permission_request') data = this.deps.humanWaits.annotate(session.id, data);
    let tools: AttemptTools | undefined;
    if ((event.type === 'tool_call' || event.type === 'tool_result') && scope && isAttemptRef(scope)) {
      tools = this.attemptTools.get(scope.attemptId);
      if (!tools) { tools = { calls: new Map(), events: new Map() }; this.attemptTools.set(scope.attemptId, tools); }
      const input = eventJson(data) as unknown as ToolCallData;
      const inputDigest = digest({ type: event.type, data: input, raw: event.raw ?? null });
      const cached = tools.events.get(eventId);
      if (cached && cached.inputDigest !== inputDigest) throw new RuntimeError('EVENT_IDEMPOTENCY_CONFLICT', 'A tool event identity was reused with a different payload', 409);
      data = cached?.data ?? mergeToolCall(input, tools.replayData?.get(eventId) ?? tools.calls.get(input.id)?.data);
      // Stable provider replays must reuse the original enrichment, even after a lost write ACK.
      if (event.sourceId && !cached) tools.events.set(eventId, { inputDigest, data });
    }
    const rememberTool = (stored: AgentEvent) => {
      if (!tools) return true;
      const saved = stored.data as ToolCallData;
      // Replaying an earlier call must not regress the completed tool artifact or Session state.
      const previous = tools.calls.get(saved.id);
      if (previous && (previous.sequence > stored.sequence || previous.sequence === stored.sequence && previous.projected)) return false;
      if (!previous || previous.sequence < stored.sequence) tools.calls.set(saved.id, { sequence: stored.sequence, data: saved, projected: false });
      return true;
    };
    if (hostDecision && event.type === 'permission_request' && scope && isAttemptRef(scope)) {
      this.deps.humanWaits.applyHostDecision(session, scope, event, data, eventId, hostDecision);
      return;
    }
    let stored: AgentEvent;
    try { stored = await this.deps.emit(session.id, event.type, data, event.raw, eventId, event.sourceId); }
    catch (error) {
      if (tools && scope && isAttemptRef(scope)) {
        // A failed return may follow a committed append. Only durable matching data can seed later results.
        try {
          const expected = digest({ type: event.type, data: eventJson(data), raw: event.raw ?? null });
          let afterSequence = 0;
          for (;;) {
            const page = this.deps.repos.execution.getAttemptEvents(scope.attemptId, { afterSequence, limit: 200 });
            const saved = page.find(item => item.id === eventId);
            if (saved) {
              if (digest({ type: saved.type, data: saved.data, raw: saved.raw ?? null }) === expected) rememberTool(saved);
              break;
            }
            if (page.length < 200) break;
            afterSequence = page.at(-1)!.sequence;
          }
        } catch (readError) { throw new AggregateError([error, readError], 'Driver event write failed and its durable result could not be read back'); }
      }
      throw error;
    }
    if (event.type === 'tool_call' || event.type === 'tool_result') {
      if (!rememberTool(stored)) return;
      if (scope && isAttemptRef(scope)) await this.deps.saveState(session, (this.deps.humanWaits.oscWaiting(scope.attemptId) || this.deps.humanWaits.pendingPermissionCount(session.id)) ? 'waiting_for_permission' : event.type === 'tool_result' ? 'thinking' : 'running_tool');
      // best-effort: the canonical driver event has already been persisted.
      await this.deps.artifact('saveToolCall', session.id, data).catch(() => {});
      if (tools) tools.calls.get(data.id)!.projected = true;
    } else if (event.type === 'thinking' && scope && isAttemptRef(scope)) await this.deps.saveState(session, (this.deps.humanWaits.oscWaiting(scope.attemptId) || this.deps.humanWaits.pendingPermissionCount(session.id)) ? 'waiting_for_permission' : 'thinking');
    else if (event.type === 'permission_request' && scope && isAttemptRef(scope)) {
      await this.deps.humanWaits.recordPermission(session, scope, String(event.data.id), data);
    } else if (event.type === 'status' && scope && isAttemptRef(scope)
      && ((data.state === 'program_status' || data.state === 'program_status_fallback') && data.source === 'osc7501' || data.state === 'turn_timeout')) {
      await this.deps.humanWaits.recordProgramStatus(session, scope, data);
    } else if (event.type === 'error') {
      if (scope && isAttemptRef(scope)) this.turnErrors.set(scope.attemptId, data.message);
      await this.deps.noteAgentFailure(session.agentId, data);
      // best-effort: the canonical driver event has already been persisted.
      await this.deps.artifact('saveError', session.id, data.message, data.detail).catch(() => {});
    }
  }

  hasCompleted(attemptId: string) { return this.completedTurns.has(attemptId); }
  startTurn(attemptId: string) { this.completedTurns.delete(attemptId); }
  markEventsFlushed(attemptId: string) { this.eventFlushedAttempts.add(attemptId); }
  compactionVersion(id: string) { return this.compactionCancellationVersions.get(id) ?? 0; }
  async drainSession(id: string) {
    while (this.driverEventChains.has(id)) await this.driverEventChains.get(id);
  }
  async drainAll() {
    while (this.driverEventChains.size) await Promise.allSettled([...this.driverEventChains.values()]);
  }
  hasExitedDrain(driver: AgentDriver) { return this.exitedDriverDrains.has(driver); }
  hasExitAdmission(id: string) { return this.exitDrainAdmissions.has(id); }

  restoreAttemptTools(attemptId: string) {
    const tools: AttemptTools = { calls: new Map(), events: new Map(), replayData: new Map() };
    let afterSequence = 0;
    for (;;) {
      const events = this.deps.repos.execution.getAttemptEvents(attemptId, { afterSequence, limit: 200 });
      for (const event of events) if (event.type === 'tool_call' || event.type === 'tool_result') {
        const data = event.data as ToolCallData;
        tools.replayData!.set(event.id, data);
        tools.calls.set(data.id, { sequence: event.sequence, data, projected: true });
      }
      if (events.length < 200) break;
      afterSequence = events.at(-1)!.sequence;
    }
    this.attemptTools.set(attemptId, tools);
  }

  forgetTurn(attemptId: string) {
    this.completedTurns.delete(attemptId); this.driverStopReasons.delete(attemptId); this.turnErrors.delete(attemptId); this.eventFlushedAttempts.delete(attemptId);
    this.attemptTools.delete(attemptId);
  }
}
