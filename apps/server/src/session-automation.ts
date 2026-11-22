import {
  assertAdmissionMatchesAccepted,
  AutomationStore,
  CI_BINDING_GENERATION,
  CI_PREFIX,
  ciKey,
  ciRequestKey,
  CLAIM_TTL_MS,
  errorMessage,
  freshSessionId,
  iso,
  isSessionRunnable,
  legacyAdmission,
  migrateCi,
  migrateOccurrence,
  OCCURRENCE_PREFIX,
  occurrenceKey,
  openRunStatuses,
  plus,
  resolveAutomationActor,
  SCHEDULE_PREFIX,
  scheduleKey,
  scheduleRequestKey,
  taskBindingKey,
  taskBindingSchema,
  type SessionAutomationServiceOptions,
  type TickParseCache
} from './automation/store.js';
import {
  canonicalExecutionJson,
  ciSubscriptionSchema,
  ciSubscriptionV2Schema,
  isTerminalTaskStatus,
  previewSessionSchedule,
  readStoredSessionSchedule,
  readTaskReport,
  RuntimeError,
  sessionScheduleOccurrenceSchema,
  sessionScheduleOccurrenceV2Schema,
  sessionScheduleSchema,
  type AttemptResultV1,
  type AutomationBlockReason,
  type AutomationHistoryPage,
  type AutomationRunDetail,
  type AutomationSchedulePage,
  type AutomationScheduleQuery,
  type CiSubscription,
  type CiSubscriptionV2,
  type CreateSessionScheduleInput,
  type DeleteSessionScheduleInput,
  type PublicCiProvider,
  type PublicCiSubscription,
  type PublicSessionSchedule,
  type PublicSessionScheduleOccurrence,
  type RunSessionScheduleInput,
  type Session,
  type SessionAutomationList,
  type SessionSchedule,
  type SessionScheduleOccurrence,
  type SessionScheduleOccurrenceV2,
  type SubscribeCiInput,
  type TaskRecord,
  type UpdateSessionScheduleInput
} from '@dutydeck/shared';
import { AutomationPreconditions } from './automation/precondition.js';
import { AutomationDelivery, deliverySettled } from './automation/delivery.js';
import { AutomationCiPoll, DEFAULT_POLL_MS } from './automation/ci-poll.js';
import { acceptedActorId, OccurrenceRunner, scheduleTaskPrompt } from './automation/occurrence-runner.js';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { observeAdmittedTask } from './task-results.js';

export {
  type SessionAutomationRuntime,
  type ScheduleOverdueNotice,
  type AutomationDeliveryContext,
  type SessionAutomationServiceOptions,
  type ScheduleWorkTemplates,
  scheduleRequestKey,
  ciRequestKey
} from './automation/store.js';

export { scheduleTaskPrompt } from './automation/occurrence-runner.js';

const STOP_REQUEST_PREFIX = 'session_automation/stop_request/';

const stopRequestSchema = z.object({
  version: z.literal(1), taskId: z.string().min(1), attemptId: z.string().min(1), sessionId: z.string().min(1),
  occurrenceId: z.string().min(1), scheduleId: z.string().min(1), generation: z.number().int().positive(), actorId: z.string().min(1),
  status: z.enum(['pending', 'applied', 'rejected']), reason: z.string().optional()
}).strict();

/** 一轮扫描的时刻与迟到宽限：同一轮里排在后面的计划，不因前面开会话、派发花的时间被判迟到。 */
type ScanTiming = { observedAt: Date; graceMs: number };

function occurrenceId(schedule: SessionSchedule, scheduledForUtc: string) {
  return `occ_${createHash('sha256').update(`${schedule.id}\0${schedule.generation}\0${scheduledForUtc}`).digest('hex')}`;
}

interface ReconcileOutcome {
  status: 'pending' | 'cancelled' | 'settled' | 'blocked';
  result?: AttemptResultV1;
  reason?: AutomationBlockReason;
  message?: string;
}

class AutomationScheduler {
  readonly store: AutomationStore;
  readonly preconditions: AutomationPreconditions;
  readonly delivery: AutomationDelivery;
  readonly ci: AutomationCiPoll;
  readonly occurrences: OccurrenceRunner;

  readonly ownerId = `automation_${randomUUID()}`;
  readonly clock: () => Date;
  closed = false;
  private currentTick?: Promise<void>;
  private tickRequested = false;

  /** 上一轮扫描的耗时：扫描拖长时，下一轮判定计划时点是否迟到要放宽同样的时间。 */
  private lastTickMs = 0;
  private readonly subscriptions = new Map<string, () => void>();

  watchSession(sessionId: string) {
    if (this.closed || !this.options.runtime.subscribe || this.subscriptions.has(sessionId)) return;
    this.subscriptions.set(sessionId, this.options.runtime.subscribe(sessionId, event => {
      if (['status', 'task', 'completed', 'error'].includes(event.type)) {
        void this.service.tick().catch(() => { console.warn('SESSION_AUTOMATION_WAKE_FAILED', sessionId); });
      }
    }));
  }

  warn(details: Record<string, unknown>, message: string) {
    if (this.options.log) this.options.log.warn(details, message);
    else console.warn(message, JSON.stringify(details));
  }

  private async isolate(operation: () => Promise<void>) {
    try { await operation(); }
    catch (error) {
      console.warn('SESSION_AUTOMATION_ITEM_FAILED', error instanceof RuntimeError ? error.code : 'UNEXPECTED_ERROR');
    }
  }

  constructor(readonly options: SessionAutomationServiceOptions, readonly service: Pick<SessionAutomationService,
    'createSchedule' | 'getScheduleDefinition' | 'sourceSessionId' | 'tick' | 'updateSchedule'>) {
    this.clock = options.clock ?? (() => new Date());

    this.store = new AutomationStore(this);
    this.preconditions = new AutomationPreconditions(this);
    this.delivery = new AutomationDelivery(this);
    this.ci = new AutomationCiPoll(this);
    this.occurrences = new OccurrenceRunner(this);
  }

  /** 固定 number=1 Attempt 后读取唯一权威结果；不跟随 currentAttempt，不把 unknown 当 failed。 */
  private reconcileAdmission(sessionId: string, value: { admission?: SessionScheduleOccurrenceV2['admission']; runtimeAttemptId?: string }): ReconcileOutcome {
    const admission = value.admission;
    if (!admission) return { status: 'blocked', reason: 'admission_conflict', message: 'Source has no fixed task admission' };
    let read;
    try { read = observeAdmittedTask(this.store.execution, sessionId, admission.taskId, value.runtimeAttemptId, admission); }
    catch (error) {
      if (error instanceof RuntimeError && error.code === 'EXECUTION_AUTHORITY_LEGACY') {
        return { status: 'blocked', reason: 'reconcile_required', message: 'Execution ledger is unavailable' };
      }
      throw error;
    }
    if (read.status === 'not_claimed' || read.status === 'cancelled_before_claim' || (read.status === 'contradiction' && read.reason === 'missing_first_attempt')) {
      const status = read.status === 'not_claimed' ? 'queued' : read.taskStatus;
      if (status === 'queued') return { status: 'pending' };
      if (status === 'cancelled') return { status: 'cancelled' };
      return { status: 'blocked', reason: 'reconcile_required', message: `Task ${status} has no recorded attempt` };
    }
    if (read.status === 'contradiction') {
      if (read.reason === 'attempt_scope_mismatch') return { status: 'blocked', reason: 'reconcile_required', message: errorMessage(read.error) };
      if (read.reason === 'first_attempt_changed') return { status: 'blocked', reason: 'reconcile_required', message: 'Fixed number=1 attempt identity changed' };
      const messages = {
        task_missing: 'Accepted task is missing from the execution ledger', session_mismatch: 'Task belongs to another session',
        acceptance_missing: 'Accepted task is missing', acceptance_session_mismatch: 'Accepted task belongs to another session',
        request_mismatch: 'Accepted task request conflicts with source admission', task_id_changed: 'Accepted task request conflicts with source admission'
      };
      return { status: 'blocked', reason: 'admission_conflict', message: messages[read.reason] };
    }
    if (read.status === 'legacy_input_unverifiable') return { status: 'blocked', reason: 'legacy_input_unresolved', message: 'Accepted task input options cannot be verified (INPUT_OPTIONS_UNVERIFIABLE)' };
    if (read.status === 'in_progress') return { status: 'pending' };
    if (read.status === 'result_error') return { status: 'blocked', reason: 'reconcile_required', message: errorMessage(read.error) };
    if (read.status === 'result_blocked') return { status: 'blocked', reason: read.reason, message: read.reason };
    return { status: 'settled', result: read.result };
  }

  /** No schedule ID is accepted: only the current occurrence's durable host binding can request this. */
  async requestScheduleStop(sessionId: string, taskId: string, attemptId: string, actorId: string) {
    const revoked = () => new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Only the active scheduled occurrence may stop its own schedule', 403);
    const task = this.store.execution.getTaskExecutionState(taskId)?.task;
    const binding = (await this.store.getRecord(taskBindingKey(taskId), value => taskBindingSchema.parse(value)))?.value;
    if (!task || task.status !== 'running' || task.currentAttemptId !== attemptId || task.sessionId !== sessionId || binding?.kind !== 'schedule' || binding.sessionId !== sessionId) throw revoked();
    const occurrence = (await this.store.getRecord(occurrenceKey(binding.occurrenceId), value => migrateOccurrence(sessionScheduleOccurrenceSchema.parse(value))))?.value;
    const accepted = this.store.execution.getAcceptedTask(taskId);
    if (!occurrence || (occurrence.executionSessionId ?? occurrence.sessionId) !== sessionId || occurrence.admission?.taskId !== taskId || occurrence.triggerSource === 'manual' || occurrence.runtimeAttemptId && occurrence.runtimeAttemptId !== attemptId
      || binding.schemaVersion === 2 && (binding.taskId !== taskId || binding.scheduleId !== occurrence.scheduleId || binding.generation !== occurrence.generation)) throw revoked();
    assertAdmissionMatchesAccepted('Scheduled task', occurrence.admission, accepted);
    const originSessionId = occurrence.sessionId;
    const session = await this.store.requireSession(originSessionId);
    if (acceptedActorId('Scheduled task', accepted, occurrence.admission, occurrence.actor, session) !== actorId) throw revoked();
    await this.store.requireAuthorized(originSessionId, actorId);
    const schedule = (await this.store.getRecord(scheduleKey(occurrence.scheduleId), readStoredSessionSchedule))?.value;
    if (!schedule || schedule.sessionId !== originSessionId || !schedule.enabled || schedule.deletedAt || schedule.generation !== occurrence.generation || schedule.trigger.kind === 'at') throw revoked();
    const current = this.store.execution.getTaskExecutionState(taskId)?.task;
    if (!current || current.status !== 'running' || current.currentAttemptId !== attemptId || current.sessionId !== sessionId) throw revoked();
    const value = stopRequestSchema.parse({ version: 1, sessionId: originSessionId, taskId, attemptId, occurrenceId: occurrence.id, scheduleId: schedule.id, generation: occurrence.generation, actorId, status: 'pending' });
    const key = `${STOP_REQUEST_PREFIX}${taskId}`;
    if (!await this.store.createRecord(key, value)) {
      const existing = (await this.store.getRecord(key, input => stopRequestSchema.parse(input)))?.value;
      if (!existing) throw revoked();
      const { reason: _reason, status: _status, ...scope } = existing;
      const { status: _pending, ...expected } = value;
      if (canonicalExecutionJson(scope) !== canonicalExecutionJson(expected)) throw revoked();
    }
    return { pendingDelivery: true, scheduleId: schedule.id };
  }

  async applyScheduleStops() {
    for (const stored of await this.store.listRecords(STOP_REQUEST_PREFIX, value => stopRequestSchema.parse(value))) {
      await this.isolate(async () => {
        const request = stored.value;
        if (request.status !== 'pending') return;
        const key = `${STOP_REQUEST_PREFIX}${request.taskId}`;
        const finish = (status: 'applied' | 'rejected', reason?: string) => this.store.replace(key, stored.raw, { ...request, status, ...(reason ? { reason } : {}) });
        const schedule = await this.store.getRecord(scheduleKey(request.scheduleId), readStoredSessionSchedule);
        if (schedule?.value.stopRequestId === request.taskId && !schedule.value.enabled) { await finish('applied'); return; }
        if (!schedule || schedule.value.sessionId !== request.sessionId || schedule.value.generation !== request.generation || schedule.value.deletedAt || !schedule.value.enabled) { await finish('rejected', 'schedule_changed'); return; }
        const occurrence = (await this.store.getRecord(occurrenceKey(request.occurrenceId), value => migrateOccurrence(sessionScheduleOccurrenceSchema.parse(value))))?.value;
        const task = this.store.execution.getTaskExecutionState(request.taskId)?.task;
        if (!occurrence || occurrence.sessionId !== request.sessionId || occurrence.scheduleId !== request.scheduleId || occurrence.generation !== request.generation || occurrence.admission?.taskId !== request.taskId) { await finish('rejected', 'binding_changed'); return; }
        // Agent 收尾报了受阻或等人决定时计划层记为没做成（runStatus=failed），同样不算完成。
        if (['failed', 'interrupted', 'cancelled'].includes(task?.status ?? '') || occurrence.result && (occurrence.result.outcome !== 'completed' || occurrence.runStatus !== 'completed')) { await finish('rejected', 'task_not_successful'); return; }
        if (!task || task.status !== 'completed' || task.currentAttemptId !== request.attemptId || occurrence.runtimeAttemptId !== request.attemptId || occurrence.result?.outcome !== 'completed' || !deliverySettled(occurrence.delivery)) return;
        const accepted = this.store.execution.getAcceptedTask(request.taskId);
        const session = await this.options.runtime.getSession(request.sessionId);
        try {
          assertAdmissionMatchesAccepted('Scheduled task', occurrence.admission, accepted);
          if (acceptedActorId('Scheduled task', accepted, occurrence.admission, occurrence.actor, session) !== request.actorId) throw new Error('actor changed');
          await this.store.requireAuthorized(request.sessionId, request.actorId);
        }
        catch { await finish('rejected', 'authorization_revoked'); return; }
        const stopped = sessionScheduleSchema.parse({ ...schedule.value, revision: schedule.value.revision + 1, generation: schedule.value.generation + 1,
          enabled: false, nextDueAt: undefined, stopRequestId: request.taskId, outcome: { kind: 'completed', at: iso(this.clock()) }, updatedAt: iso(this.clock()),
          // 结果没送到也照样停用，否则计划会一直跑下去；停用原因和停用告知要说明这一点。
          ...occurrence.delivery.status !== 'delivered' ? {
            disabledReason: occurrence.delivery.status === 'error' ? `已确认完成，但结果投递 ${occurrence.delivery.attempts} 次都失败` : '已确认完成，但这一轮的结果没有投递',
            disabledAt: iso(this.clock()),
            ...this.options.onScheduleDisabled ? { disableNotification: { status: 'pending', attempts: 0, name: schedule.value.name, updatedAt: iso(this.clock()) } } : {}
          } : {} });
        if (await this.store.replace(scheduleKey(request.scheduleId), schedule.raw, stopped)) await finish('applied');
      });
    }
  }

  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.tickRequested = true;
    if (this.currentTick) return this.currentTick;
    const operation = (async () => {
      while (this.tickRequested && !this.closed) {
        this.tickRequested = false;
        const startedAt = this.clock();
        const timing = { observedAt: startedAt, graceMs: DEFAULT_POLL_MS + this.lastTickMs };
        await this.runTick(timing).finally(() => { this.lastTickMs = Math.max(0, this.clock().getTime() - startedAt.getTime()); });
      }
    })().finally(() => {
      if (this.currentTick === operation) this.currentTick = undefined;
      // A completion event can land after the loop exits but before this cleanup microtask.
      if (this.tickRequested && !this.closed) return this.service.tick();
    });
    this.currentTick = operation;
    return operation;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.preconditions.preconditionAbort.abort();
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    for (const { controller } of this.delivery.deliveries.values()) controller.abort();
    try { if (this.currentTick) await this.currentTick; }
    finally { await Promise.allSettled([...this.occurrences.manualRuns, ...this.preconditions.preconditionRuns.values(), ...[...this.delivery.deliveries.values()].map(item => item.run)]); }
  }

  private async runTick(timing: ScanTiming) {
    this.store.requireStore();
    this.store.quarantinedSchedules.clear();
    // Re-read storage at each phase; only reuse decoding for byte-identical rows within this tick.
    const parsed: TickParseCache = { occurrences: new Map(), subscriptions: new Map() };
    await this.refreshAcceptedWork(parsed);
    await this.applyScheduleStops();
    if (this.closed) return;
    const [schedules, occurrences, subscriptions] = await Promise.all([
      this.store.listRecords(SCHEDULE_PREFIX, readStoredSessionSchedule),
      this.store.listRecords(OCCURRENCE_PREFIX, value => sessionScheduleOccurrenceSchema.parse(value), parsed.occurrences, { field: 'runStatus', values: ['pending'] }),
      this.store.listRecords(CI_PREFIX, value => ciSubscriptionSchema.parse(value), parsed.subscriptions, { field: 'status', values: ['waiting', 'dispatching', 'accepted'] })
    ]);
    for (const item of occurrences) {
      if (this.closed) return;
      if (item.value.runStatus === 'pending' && (!item.value.leaseExpiresAt || new Date(item.value.leaseExpiresAt) <= this.clock())) await this.isolate(async () => {
        const claimed = await this.occurrences.renewOccurrenceLease(item);
        if (claimed) await this.occurrences.processOccurrence(claimed);
      });
    }
    for (const item of schedules) {
      if (this.closed) return;
      if (!item.value.deletedAt) {
        this.watchSession(item.value.sessionId);
        if (item.value.executionSessionId) this.watchSession(item.value.executionSessionId);
      }
      await this.isolate(() => this.synchronizeLifecycle(item));
      await this.isolate(() => this.enforceDeadline(item.value));
      await this.isolate(() => this.planSchedule(item.value, timing));
      await this.isolate(() => this.occurrences.followUpOccurrence(item.value.id));
      await this.isolate(() => this.delivery.remindOverdue(item.value));
      await this.isolate(() => this.delivery.sendRunNotice(item.value));
    }
    for (const item of subscriptions) {
      if (this.closed) return;
      await this.isolate(async () => {
        const value = migrateCi(item.value);
        if (value.status === 'waiting' && (!value.nextPollAt || new Date(value.nextPollAt) <= this.clock())) await this.ci.claimAndPollCi(item);
        else if (value.status === 'dispatching' && (!value.leaseExpiresAt || new Date(value.leaseExpiresAt) <= this.clock())) await this.ci.recoverDispatchingCi(item);
        else if (value.status === 'accepted' && new Date(value.expiresAt) <= this.clock() && value.taskId) {
          const task = await this.options.repositories.tasks.get?.(value.taskId);
          if (task?.status === 'queued' && !value.taskStartedAt) await this.ci.finishCi(item, 'expired', 'CI continuation expired before execution');
        }
      });
    }
    await this.delivery.startPendingDeliveries(parsed);
  }

  /**
   * 到截止时间仍启用的计划：停用（不再生成新的触发）并按停用告知发到回报位置，结论记为「已到截止，未确认完成」。
   * 已提交的那一轮照常收尾；计划已换代，它之后的 stop-self 不再改变结论。
   */
  private async enforceDeadline(snapshot: SessionSchedule) {
    if (!snapshot.deadlineAt || !snapshot.enabled || snapshot.deletedAt || Date.parse(snapshot.deadlineAt) > this.clock().getTime()) return;
    const stored = await this.store.getRecord(scheduleKey(snapshot.id), readStoredSessionSchedule);
    const deadlineAt = stored?.value.deadlineAt;
    if (!stored || !deadlineAt || !stored.value.enabled || stored.value.deletedAt || Date.parse(deadlineAt) > this.clock().getTime()) return;
    const label = new Date(deadlineAt).toLocaleString('zh-CN', { timeZone: stored.value.timezone, hour12: false });
    if (await this.disableSchedule(stored, `已到截止时间 ${label}（${stored.value.timezone}），未确认完成`, { kind: 'deadline_reached', at: iso(this.clock()) })) {
      this.warn({ scheduleId: stored.value.id, deadlineAt }, '定时计划已到截止时间，已自动停用');
    }
  }

  /** fresh 计划每次占用执行槽时同一次 CAS 换上这次触发的会话编号；槽是独占的，上一次已结束。 */
  freshReservation(schedule: SessionSchedule, occurrence: string) {
    return schedule.mode === 'fresh' ? { executionSessionId: freshSessionId(schedule.id, occurrence) } : {};
  }

  /**
   * 归档本计划不再使用的 fresh 会话（只读保留历史），保留当前执行会话。
   * 会话里还有排队、执行中或未结算的任务（例如用户在里面追加的对话）时不归档，等下一次触发或恢复时再试；失败只告警。
   */
  async retireFreshSessions(schedule: SessionSchedule) {
    if (!this.options.runtime.archive) return;
    const keep = schedule.mode === 'fresh' ? schedule.executionSessionId : undefined;
    const sessions = (await this.options.repositories.sessions.list())
      .filter(item => item.source === 'schedule' && item.sourceId === schedule.id && !item.archivedAt && item.id !== keep);
    for (const session of sessions) {
      const tasks = await this.options.repositories.tasks.listBySession(session.id);
      if (tasks.some(task => !isTerminalTaskStatus(task.status) || this.store.execution.getTaskExecutionState(task.id)?.attempts.some(attempt => attempt.state !== 'settled'))) continue;
      this.subscriptions.get(session.id)?.();
      this.subscriptions.delete(session.id);
      try { await this.options.runtime.archive(session.id); }
      catch (error) { console.warn('SESSION_AUTOMATION_FRESH_ARCHIVE_FAILED', error instanceof RuntimeError ? error.code : 'UNEXPECTED_ERROR'); }
    }
  }

  async hasPendingOccurrence(schedule: SessionSchedule) {
    if (this.store.quarantinedSchedules.has(schedule.id)) return true;
    if (schedule.pendingOccurrence) {
      const stored = await this.store.getRecord(occurrenceKey(schedule.pendingOccurrence.id), value => sessionScheduleOccurrenceSchema.parse(value));
      if (!stored || openRunStatuses.has(stored.value.runStatus)) return true;
      // 这一轮成功并请求了 stop-self、结果还在投递：停用要等投递有结论，期间不开下一轮。
      const occurrence = migrateOccurrence(stored.value);
      const taskId = occurrence.runStatus === 'completed' && !deliverySettled(occurrence.delivery) ? occurrence.admission?.taskId : undefined;
      const stop = taskId ? (await this.store.getRecord(`${STOP_REQUEST_PREFIX}${taskId}`, value => stopRequestSchema.parse(value)))?.value : undefined;
      if (stop?.status === 'pending' && stop.scheduleId === schedule.id && stop.generation === schedule.generation) return true;
    }
    // Legacy sources have no reservation, and blocked/unknown work must continue to hold the slot.
    return (await this.store.listRecords(OCCURRENCE_PREFIX, value => sessionScheduleOccurrenceSchema.parse(value), undefined, { field: 'runStatus', values: [...openRunStatuses], scheduleId: schedule.id }))
      .some(item => item.value.scheduleId === schedule.id && openRunStatuses.has(item.value.runStatus));
  }

  async materializeOccurrence(schedule: SessionSchedule) {
    const reservation = schedule.pendingOccurrence!;
    const existing = await this.store.getRecord(occurrenceKey(reservation.id), value => sessionScheduleOccurrenceSchema.parse(value));
    if (existing) return { ...existing, created: false };
    // 新执行会话已随预留写入；在建出这次触发的记录前收尾旧会话，重启后从预留恢复时也会走到这里。
    if (schedule.mode === 'fresh') await this.retireFreshSessions(schedule);
    const now = this.clock();
    const { misfireDecision, ...identity } = reservation;
    const skipped = misfireDecision?.action === 'skip';
    const occurrence = sessionScheduleOccurrenceV2Schema.parse({
      schemaVersion: 2,
      ...identity,
      revision: 1,
      scheduleId: schedule.id,
      sessionId: schedule.sessionId,
      ...(schedule.executionSessionId ? { executionSessionId: schedule.executionSessionId } : {}),
      conditionStatus: skipped ? 'skipped' : 'pending',
      runStatus: skipped ? 'skipped' : 'pending',
      ...(misfireDecision?.misfire ? { misfire: misfireDecision.misfire } : {}),
      delivery: { status: !skipped && this.options.deliver ? 'pending' : 'not_requested', attempts: 0, updatedAt: iso(now) },
      ...(!skipped ? { leaseOwner: this.ownerId, leaseExpiresAt: plus(now, CLAIM_TTL_MS) } : {}),
      createdAt: iso(now),
      updatedAt: iso(now)
    });
    if (await this.store.createRecord(occurrenceKey(occurrence.id), occurrence)) return { raw: JSON.stringify(occurrence), value: occurrence, created: true };
    return { ...(await this.store.getRecord(occurrenceKey(occurrence.id), value => sessionScheduleOccurrenceSchema.parse(value)))!, created: false };
  }

  private async planSchedule(snapshot: SessionSchedule, timing: ScanTiming) {
    const stored = await this.store.getRecord(scheduleKey(snapshot.id), readStoredSessionSchedule);
    if (!stored) return;
    let schedule = stored.value;
    if (schedule.pendingOccurrence) {
      const occurrence = await this.materializeOccurrence(schedule);
      if (occurrence.created && occurrence.value.runStatus === 'pending') await this.occurrences.processOccurrence(occurrence);
      if (openRunStatuses.has(occurrence.value.runStatus)) return;
    }
    if (!schedule.enabled || schedule.deletedAt) return;
    if (!schedule.nextDueAt && schedule.trigger.kind !== 'at') {
      if (await this.hasPendingOccurrence(schedule)) return;
      let nextDueAt: string | undefined;
      try { nextDueAt = previewSessionSchedule(schedule, this.clock())?.scheduledForUtc; }
      catch { return; } // Invalid legacy triggers must not be reactivated by recovery.
      if (nextDueAt) await this.store.replace(scheduleKey(schedule.id), stored.raw, sessionScheduleSchema.parse({ ...schedule, nextDueAt }));
      return;
    }
    if (!schedule.nextDueAt || new Date(schedule.nextDueAt) > this.clock() || await this.hasPendingOccurrence(schedule)) return;
    const id = occurrenceId(schedule, schedule.nextDueAt);
    const already = await this.store.getRecord(occurrenceKey(id), value => sessionScheduleOccurrenceSchema.parse(value));
    if (already) {
      if (!openRunStatuses.has(already.value.runStatus)) await this.advanceSchedule(schedule, schedule.nextDueAt);
      return;
    }
    const lateBy = timing.observedAt.getTime() - new Date(schedule.nextDueAt).getTime();
    // 有效期短于扫描宽限时按宽限算：扫描本身就可能晚这么久才看到这个时点，否则准点的触发也会被判过期。
    const validMs = schedule.maxLatenessSeconds === undefined ? undefined : Math.max(schedule.maxLatenessSeconds * 1_000, timing.graceMs);
    const expired = validMs !== undefined && lateBy > validMs;
    const skip = schedule.misfirePolicy === 'skip' && lateBy > timing.graceMs || expired;
    const misfire = skip || lateBy > timing.graceMs ? {
      policy: schedule.misfirePolicy ?? 'coalesce',
      from: schedule.nextDueAt, to: iso(this.clock()),
      reason: skip ? expired ? 'lateness_window_expired' : 'missed_time_skipped' : 'missed_times_coalesced'
    } : undefined;
    const restored = await this.occurrences.restoreAfterFreshRetry(schedule);
    schedule = sessionScheduleSchema.parse({ ...schedule, ...restored ?? this.freshReservation(schedule, id), pendingOccurrence: {
      id, generation: schedule.generation, scheduledForUtc: schedule.nextDueAt,
      misfireDecision: { action: skip ? 'skip' : 'run', ...(misfire ? { misfire } : {}) }
    } });
    if (!await this.store.replace(scheduleKey(schedule.id), stored.raw, schedule)) return;
    // 改回原模式后，重跑用过的新会话不再是执行会话：没有未结束任务的归档。
    if (restored) await this.retireFreshSessions(schedule);
    const occurrence = await this.materializeOccurrence(schedule);
    if (occurrence.created && occurrence.value.runStatus === 'pending') await this.occurrences.processOccurrence(occurrence);
    if (!openRunStatuses.has(occurrence.value.runStatus)) await this.advanceSchedule(schedule, schedule.nextDueAt!);
  }

  async advanceSchedule(schedule: SessionSchedule, due: string) {
    const current = await this.store.getRecord(scheduleKey(schedule.id), readStoredSessionSchedule);
    if (!current || current.value.generation !== schedule.generation || current.value.nextDueAt !== due) return;
    const upcoming = previewSessionSchedule(current.value, this.clock())?.scheduledForUtc;
    const updated = sessionScheduleSchema.parse({ ...current.value, nextDueAt: upcoming });
    await this.store.replace(scheduleKey(schedule.id), current.raw, updated);
  }

  private async synchronizeLifecycle(snapshot: { raw: string; value: SessionSchedule }) {
    let stored = await this.store.getRecord(scheduleKey(snapshot.value.id), readStoredSessionSchedule);
    if (!stored) return;
    if (stored.value.enabled && !stored.value.pendingOccurrence) stored = await this.occurrences.fallbackToFresh(stored);
    if (stored.value.mode !== 'independent' && stored.value.mode !== 'fresh' && stored.value.enabled
      && !isSessionRunnable(await this.options.runtime.getSession(stored.value.sessionId))) {
      await this.disableSchedule(stored, 'Session is no longer active');
      stored = await this.store.getRecord(scheduleKey(snapshot.value.id), readStoredSessionSchedule);
    }
    if (!stored?.value.disableNotification || !this.options.onScheduleDisabled) return;
    const notice = stored.value.disableNotification;
    if (notice.status === 'delivered' || notice.status === 'not_requested') return;
    if ((stored.value.enabled || stored.value.deletedAt) && ['pending', 'error'].includes(notice.status)) {
      await this.store.replace(scheduleKey(stored.value.id), stored.raw, sessionScheduleSchema.parse({
        ...stored.value, disableNotification: { ...notice, status: 'not_requested', updatedAt: iso(this.clock()) }
      }));
      return;
    }
    if (notice.status === 'sending' || notice.status === 'unknown') {
      const confirmed = await this.options.reconcileDisabledNotification?.(stored.value).catch(() => false);
      if (confirmed || notice.status === 'sending' && notice.owner !== this.ownerId) {
        await this.store.replace(scheduleKey(stored.value.id), stored.raw, sessionScheduleSchema.parse({
          ...stored.value, disableNotification: { ...notice, status: confirmed ? 'delivered' : 'unknown', owner: undefined, updatedAt: iso(this.clock()) }
        }));
      }
      return;
    }
    if (notice.attempts >= 3 || notice.nextAttemptAt && notice.nextAttemptAt > iso(this.clock())) return;
    let sent = false;
    const beforeSend = async () => {
      if (this.closed) throw new RuntimeError('SESSION_AUTOMATION_CLOSED', 'Automation is closed', 503);
      const current = await this.store.getRecord(scheduleKey(stored!.value.id), readStoredSessionSchedule);
      if (!current || current.value.disabledAt !== stored!.value.disabledAt) throw new RuntimeError('DISABLE_NOTICE_STALE', 'Disable notice changed', 409);
      if (sent) {
        if (current.value.disableNotification?.owner !== this.ownerId || current.value.disableNotification.status !== 'sending') throw new RuntimeError('DISABLE_NOTICE_STALE', 'Disable notice ownership changed', 409);
        return;
      }
      if (current.value.disableNotification?.status !== notice.status || current.value.disableNotification.attempts !== notice.attempts) throw new RuntimeError('DISABLE_NOTICE_STALE', 'Disable notice ownership changed', 409);
      const next = sessionScheduleSchema.parse({ ...current.value, disableNotification: {
        ...notice, status: 'sending', attempts: notice.attempts + 1, owner: this.ownerId, updatedAt: iso(this.clock())
      } });
      if (!await this.store.replace(scheduleKey(next.id), current.raw, next)) throw new RuntimeError('DISABLE_NOTICE_STALE', 'Disable notice ownership changed', 409);
      sent = true;
    };
    let failed = false;
    let notRequested = false;
    try { notRequested = await this.options.onScheduleDisabled(stored.value, stored.value.disabledReason ?? 'Session is no longer active', beforeSend) === 'not_requested'; }
    catch { failed = true; }
    const current = await this.store.getRecord(scheduleKey(stored.value.id), readStoredSessionSchedule);
    if (!current || current.value.disabledAt !== stored.value.disabledAt) return;
    if (sent && current.value.disableNotification?.owner !== this.ownerId) return;
    if (!sent && current.raw !== stored.raw) return;
    const attempts = notice.attempts + 1;
    await this.store.replace(scheduleKey(current.value.id), current.raw, sessionScheduleSchema.parse({
      ...current.value, disableNotification: {
        ...notice, status: failed ? sent ? 'unknown' : 'error' : notRequested ? 'not_requested' : 'delivered', owner: undefined, attempts, updatedAt: iso(this.clock()),
        ...(failed && !sent ? { nextAttemptAt: plus(this.clock(), 60_000 * attempts), error: 'Notification failed before submission' } : {}),
        ...(failed && sent ? { error: 'Notification submission has no confirmed receipt' } : {})
      }
    }));
  }

  async disableSchedule(stored: { raw: string; value: SessionSchedule }, reason = 'Schedule authorization is no longer available', outcome?: SessionSchedule['outcome']): Promise<boolean> {
    if (!stored.value.enabled) return false;
    const disabled = sessionScheduleSchema.parse({
      ...stored.value,
      ...(outcome ? { outcome } : {}),
      revision: stored.value.revision + 1,
      generation: stored.value.generation + 1,
      enabled: false,
      nextDueAt: undefined,
      disabledReason: reason,
      disabledAt: iso(this.clock()),
      ...(this.options.onScheduleDisabled ? { disableNotification: { status: 'pending', attempts: 0, name: stored.value.name, updatedAt: iso(this.clock()) } } : {}),
      updatedAt: iso(this.clock())
    });
    return await this.store.replace(scheduleKey(stored.value.id), stored.raw, disabled);
  }

  private async refreshAcceptedWork(parsed: TickParseCache) {
    // 已结算的历史不再变化（结果投递另按投递状态扫描）：每个 tick 只读还可能推进的记录，开销不随历史增长。
    const [occurrences, subscriptions, records] = await Promise.all([
      this.store.listRecords(OCCURRENCE_PREFIX, value => sessionScheduleOccurrenceSchema.parse(value), parsed.occurrences, { field: 'runStatus', values: [...openRunStatuses, 'error'] }),
      this.store.listRecords(CI_PREFIX, value => ciSubscriptionSchema.parse(value), parsed.subscriptions, { field: 'status', values: ['waiting', 'dispatching', 'accepted', 'blocked', 'error'] }),
      this.store.listRecords(SCHEDULE_PREFIX, readStoredSessionSchedule)
    ]);
    const schedules = new Map(records.map(item => [item.value.id, item]));
    for (const item of occurrences) {
      if (this.closed) return;
      await this.isolate(() => this.refreshOccurrence(item, schedules));
    }
    for (const item of subscriptions) {
      if (this.closed) return;
      await this.isolate(() => this.refreshCi(item));
    }
  }

  /**
   * V1 来源记录迁移：若记录上已有实际接受 Task，则固定为 legacy_partial 并保留其旧 ID，
   * 不改成 canonical；映射冲突持久 blocked。尚未接受的 V1 记录不在这里造新 request（交给新触发流程）。
   */
  async fixOccurrenceAdmission(item: { raw: string; value: SessionScheduleOccurrence }, schedules: Map<string, { raw: string; value: SessionSchedule }>): Promise<{ raw: string; value: SessionScheduleOccurrenceV2 } | undefined> {
    const value = migrateOccurrence(item.value);
    if (value.admission) return { raw: item.raw, value };
    if (value.taskId) {
      const accepted = this.store.execution.getAcceptedTask(value.taskId);
      if (!accepted) return undefined;
      if (accepted.task.sessionId !== (value.executionSessionId ?? value.sessionId)) {
        const blocked = sessionScheduleOccurrenceV2Schema.parse({ ...value, schemaVersion: 2, revision: value.revision + 1, runStatus: 'blocked', blockReason: 'admission_conflict', error: 'Accepted task belongs to another session', delivery: this.delivery.undelivered(value.delivery), updatedAt: iso(this.clock()) });
        await this.store.replace(occurrenceKey(value.id), item.raw, blocked);
        return { raw: JSON.stringify(blocked), value: blocked };
      }
      const admission = legacyAdmission(accepted, value.taskId);
      const fixed = sessionScheduleOccurrenceV2Schema.parse({ ...value, schemaVersion: 2, revision: value.revision + 1, admission, updatedAt: iso(this.clock()) });
      if (!(await this.store.replace(occurrenceKey(value.id), item.raw, fixed))) return undefined;
      return { raw: JSON.stringify(fixed), value: fixed };
    }
    // 若 V1 来源没有 taskId（接受响应丢失或旧版未记），通过 lookupAccepted 查找已存在的接受事实
    const scheduleStored = schedules.get(value.scheduleId);
    if (value.workItemId || scheduleStored?.value.workTemplate) return undefined;
    if (scheduleStored) {
      const session = await this.options.runtime.getSession(value.sessionId);
      const actor = resolveAutomationActor(session, scheduleStored.value.actorId);
      if (session && actor) {
        const candidateRequest = this.occurrences.buildRequest(session, 'schedule', scheduleRequestKey(value.id), scheduleTaskPrompt(scheduleStored.value), actor);
        let accepted;
        try { accepted = this.store.execution.lookupAccepted(candidateRequest); }
        catch (error) {
          const blocked = sessionScheduleOccurrenceV2Schema.parse({ ...value, revision: value.revision + 1, runStatus: 'blocked', blockReason: 'admission_conflict',
            error: errorMessage(error), delivery: this.delivery.undelivered(value.delivery) });
          if (!await this.store.replace(occurrenceKey(value.id), item.raw, blocked)) return undefined;
          return { raw: JSON.stringify(blocked), value: blocked };
        }
        if (accepted && accepted.task.sessionId === value.sessionId) {
          // A concurrently edited definition must be reconsidered with its new request on the next tick.
          if (await this.options.repositories.config.get(scheduleKey(value.scheduleId)) !== scheduleStored.raw) return undefined;
          const admission = legacyAdmission(accepted);
          const fixed = sessionScheduleOccurrenceV2Schema.parse({
            ...value,
            schemaVersion: 2,
            revision: value.revision + 1,
            taskId: accepted.task.id,
            admission,
            actor,
            updatedAt: iso(this.clock())
          });
          if (await this.store.replace(occurrenceKey(value.id), item.raw, fixed)) {
            return { raw: JSON.stringify(fixed), value: fixed };
          }
        }
      }
    }
    return undefined;
  }

  private async fixCiAdmission(item: { raw: string; value: CiSubscription }): Promise<{ raw: string; value: CiSubscriptionV2 } | undefined> {
    const value = migrateCi(item.value);
    if (value.admission) return { raw: item.raw, value };
    if (value.taskId) {
      const accepted = this.store.execution.getAcceptedTask(value.taskId);
      if (!accepted) return undefined;
      if (accepted.task.sessionId !== value.sessionId) {
        const blocked = ciSubscriptionV2Schema.parse({ ...value, schemaVersion: 2, revision: value.revision + 1, status: 'blocked', error: 'Accepted task belongs to another session', delivery: this.delivery.undelivered(value.delivery), updatedAt: iso(this.clock()) });
        await this.store.replace(ciKey(value.id), item.raw, blocked);
        return { raw: JSON.stringify(blocked), value: blocked };
      }
      const admission = legacyAdmission(accepted, value.taskId);
      const fixed = ciSubscriptionV2Schema.parse({ ...value, schemaVersion: 2, revision: value.revision + 1, admission, updatedAt: iso(this.clock()) });
      if (!(await this.store.replace(ciKey(value.id), item.raw, fixed))) return undefined;
      return { raw: JSON.stringify(fixed), value: fixed };
    }
    const session = await this.options.runtime.getSession(value.sessionId);
    const actor = resolveAutomationActor(session, value.actorId);
    if (session && actor && value.dispatchPrompt) {
      const candidateRequest = this.occurrences.buildRequest(session, 'automation', ciRequestKey(value.id), value.dispatchPrompt, actor);
      let accepted;
      try { accepted = this.store.execution.lookupAccepted(candidateRequest); } catch { /* conflict */ }
      if (accepted && accepted.task.sessionId === value.sessionId) {
        const admission = legacyAdmission(accepted);
        const fixed = ciSubscriptionV2Schema.parse({
          ...value,
          schemaVersion: 2,
          revision: value.revision + 1,
          taskId: accepted.task.id,
          admission,
          actor,
          updatedAt: iso(this.clock())
        });
        if (await this.store.replace(ciKey(value.id), item.raw, fixed)) {
          return { raw: JSON.stringify(fixed), value: fixed };
        }
      }
    }
    return undefined;
  }

  private async refreshOccurrence(item: { raw: string; value: SessionScheduleOccurrence }, schedules: Map<string, { raw: string; value: SessionSchedule }>) {
    const fixed = await this.fixOccurrenceAdmission(item, schedules);
    if (!fixed || !fixed.value.admission) return;
    // 仍在派发阶段（pending，acceptance 在途或响应丢失、尚无接受事实）时不做结果对账，
    // 由 processOccurrence 重投/恢复，避免把在途来源误判为 blocked。
    // 派发时就被拒（error，例如月度成本上限）同样没有接受事实：保留原因，不对账成 blocked，否则会挡住之后每一次触发。
    if (['pending', 'error'].includes(fixed.value.runStatus) && !this.store.execution.getAcceptedTask(fixed.value.admission.taskId)) return;
    let working = fixed;
    let value = working.value;

    // 双 KV 中断恢复：来源已固定 admission 且接受事实存在，但第二授权 KV 丢失时，幂等补回同一 binding。
    const fixedAdmission = fixed.value.admission;
    if (this.store.execution.getAcceptedTask(fixedAdmission.taskId)) {
      try {
        await this.store.ensureTaskBinding(fixedAdmission.taskId, {
          schemaVersion: 2, kind: 'schedule', sessionId: fixed.value.executionSessionId ?? fixed.value.sessionId, occurrenceId: fixed.value.id,
          scheduleId: fixed.value.scheduleId, taskId: fixedAdmission.taskId, taskIdVersion: fixedAdmission.taskIdVersion, generation: fixed.value.generation
        });
      } catch (err) {
        await this.occurrences.finishOccurrence(working, { runStatus: 'blocked', blockReason: 'admission_conflict', error: errorMessage(err) });
        return;
      }
    }

    // refresh 先保护既有 delivered 历史，缺新 result 不能降 blocked/not_requested 或重发。
    if (value.delivery.status === 'delivered') return;

    const recoverLegacyCapacity = value.runStatus === 'blocked' && value.blockReason === 'legacy_output_unresolved' && Boolean(value.runtimeAttemptId);
    // 历史 legacy 阻塞只重新核验冻结首 Attempt 的严格自动容量链，不解除其他阻塞。
    if (value.runStatus === 'blocked') {
      if (!value.runtimeAttemptId || value.blockReason !== 'reconcile_required' && !recoverLegacyCapacity) return;
    }

    // 先在自身 CAS 固定 number=1 Attempt.id，再读结果。
    if (!value.runtimeAttemptId) {
      const projection = this.store.execution.getTaskExecutionState(value.admission!.taskId);
      const first = projection?.attempts.find(attempt => attempt.number === 1);
      if (first) {
        const fixedAttempt = sessionScheduleOccurrenceV2Schema.parse({ ...value, revision: value.revision + 1, runtimeAttemptId: first.attemptId, updatedAt: iso(this.clock()) });
        if (await this.store.replace(occurrenceKey(value.id), working.raw, fixedAttempt)) working = { raw: JSON.stringify(fixedAttempt), value: fixedAttempt };
        else return;
        value = working.value;
      }
    }
    const outcome = this.reconcileAdmission(value.executionSessionId ?? value.sessionId, value);
    if (outcome.status === 'pending') return;
    if (outcome.status === 'blocked') {
      if (working.value.runStatus !== 'blocked') {
        await this.occurrences.finishOccurrence(working, {
          runStatus: 'blocked',
          ...(outcome.reason ? { blockReason: outcome.reason } : {}),
          ...(outcome.reason === 'legacy_output_unresolved' ? { resultBoundary: 'legacy_output_unresolved' } : {}),
          error: outcome.message
        });
      }
      return;
    }
    if (outcome.status === 'cancelled') {
      // 无 Attempt 的已取消 queued 任务：按原不交付语义收口。
      if (working.value.runStatus === 'accepted' || working.value.runStatus === 'pending') {
        await this.occurrences.finishOccurrence(working, {
          runStatus: 'interrupted',
          error: 'Selected task was cancelled before execution',
          delivery: this.delivery.undelivered(working.value.delivery)
        });
      }
      return;
    }
    const result = outcome.result!;
    // 原首 Attempt 补齐边界不能解除历史 legacy 阻塞，只有已验证的自动后继结果可以恢复。
    if (recoverLegacyCapacity && result.attemptId === value.runtimeAttemptId) return;
    const settlingNow = working.value.runStatus === 'accepted' || working.value.runStatus === 'pending' || working.value.runStatus === 'blocked';
    if (settlingNow) {
      let runStatus: SessionScheduleOccurrenceV2['runStatus'] = result.outcome === 'completed' ? 'completed' : result.outcome === 'cancelled' ? 'interrupted' : result.outcome === 'interrupted' ? 'interrupted' : 'failed';
      // Agent 收尾报了受阻或等人决定：执行账本照旧是完成，计划层记这次没做成。
      let problem: { key: string; kind: 'result'; reason: string } | undefined;
      if (runStatus === 'completed') {
        const report = await readTaskReport(this.options.repositories.config, result.taskId).catch(() => undefined);
        if (report?.status === 'blocked' || report?.status === 'waiting') {
          runStatus = 'failed';
          problem = { key: `report:${report.status}`, kind: 'result', reason: report.status === 'waiting' ? `等你决定：${report.question}` : `受阻：${report.summary}` };
        }
      } else if (runStatus === 'failed') problem = { key: 'result:failed', kind: 'result', reason: '执行失败' };
      const streak = runStatus !== 'interrupted' && value.triggerSource !== 'manual' ? await this.occurrences.recordOutcome(value, problem) : undefined;
      const settled = sessionScheduleOccurrenceV2Schema.parse({
        ...working.value,
        revision: working.value.revision + 1,
        runStatus,
        result,
        resultBoundary: 'verified',
        blockReason: undefined,
        error: problem?.reason,
        // 来源恢复时死 owner 租约必须清除，否则交付租约领取会被未过期租约挡住。
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        ...(recoverLegacyCapacity && working.value.delivery.status === 'not_requested' && this.options.deliver
          ? { delivery: { status: 'pending', attempts: working.value.delivery.attempts, updatedAt: iso(this.clock()) } } : {}),
        ...(result.outcome === 'cancelled' ? { delivery: this.delivery.undelivered(working.value.delivery) } : {}),
        // 同因第 2 次起不再另发结果卡，由 sendRunNotice 改上一条。
        ...(streak && streak.count > 1 && working.value.delivery.status !== 'delivered' ? { delivery: this.delivery.undelivered(working.value.delivery) } : {}),
        updatedAt: iso(this.clock())
      });
      if (!await this.store.replace(occurrenceKey(value.id), working.raw, settled)) return;
    } else if (!working.value.result) {
      // 旧 pending/error 终态缺可靠结果：blocked，不重造 pending。
      if (['pending', 'error'].includes(working.value.runStatus)) {
        await this.occurrences.finishOccurrence(working, { runStatus: 'blocked', blockReason: 'legacy_output_unresolved', resultBoundary: 'legacy_output_unresolved' });
      }
      return;
    }
  }

  private async refreshCi(item: { raw: string; value: CiSubscription }) {
    const fixed = await this.fixCiAdmission(item);
    if (!fixed || !fixed.value.admission) return;
    // 仍在派发阶段（dispatching，acceptance 在途或响应丢失）时不做结果对账；
    // 交由 recoverDispatchingCi 用原冻结 prompt 重投，避免误判为 blocked。
    // 派发时就被拒（error，例如会话停止或月度成本上限）同样没有接受事实：保留原因，不对账成 blocked。
    if (['dispatching', 'error'].includes(fixed.value.status) && !this.store.execution.getAcceptedTask(fixed.value.admission.taskId)) return;
    let working = fixed;
    let value = working.value;

    // 双 KV 中断恢复：CI 来源已固定 admission 且接受事实存在，但第二授权 KV 丢失时，幂等补回同一 binding。
    if (this.store.execution.getAcceptedTask(value.admission!.taskId)) {
      try {
        await this.store.ensureTaskBinding(value.admission!.taskId, {
          schemaVersion: 2, kind: 'ci', sessionId: value.sessionId, subscriptionId: value.id,
          taskId: value.admission!.taskId, taskIdVersion: value.admission!.taskIdVersion, generation: CI_BINDING_GENERATION
        });
      } catch (err) {
        await this.ci.finishCi(working, { status: 'blocked', blockReason: 'admission_conflict', error: errorMessage(err) });
        return;
      }
    }

    if (value.delivery.status === 'delivered') return;

    const recoverLegacyCapacity = value.status === 'blocked' && value.blockReason === 'legacy_output_unresolved' && Boolean(value.runtimeAttemptId);
    if (value.status === 'blocked') {
      if (!value.runtimeAttemptId || value.blockReason !== 'reconcile_required' && !recoverLegacyCapacity) return;
    }
    if (!value.runtimeAttemptId) {
      const projection = this.store.execution.getTaskExecutionState(value.admission!.taskId);
      const first = projection?.attempts.find(attempt => attempt.number === 1);
      if (first) {
        const fixedAttempt = ciSubscriptionV2Schema.parse({ ...value, revision: value.revision + 1, runtimeAttemptId: first.attemptId, updatedAt: iso(this.clock()) });
        if (await this.store.replace(ciKey(value.id), working.raw, fixedAttempt)) working = { raw: JSON.stringify(fixedAttempt), value: fixedAttempt };
        else return;
        value = working.value;
      }
    }
    const outcome = this.reconcileAdmission(value.sessionId, value);
    if (outcome.status === 'pending') return;
    if (outcome.status === 'blocked') {
      if (working.value.status !== 'blocked') {
        await this.ci.finishCi(working, {
          status: 'blocked',
          ...(outcome.reason ? { blockReason: outcome.reason } : {}),
          ...(outcome.reason === 'legacy_output_unresolved' ? { resultBoundary: 'legacy_output_unresolved' } : {}),
          error: outcome.message
        });
      }
      return;
    }
    if (outcome.status === 'cancelled') {
      if (working.value.status === 'accepted' || working.value.status === 'dispatching') await this.ci.finishCi(working, 'cancelled');
      return;
    }
    const result = outcome.result!;
    if (recoverLegacyCapacity && result.attemptId === value.runtimeAttemptId) return;
    const settlingNow = working.value.status === 'accepted' || working.value.status === 'dispatching' || working.value.status === 'blocked';
    if (settlingNow) {
      // 完成/失败/中断都收口为 completed 来源状态，具体 outcome 由冻结 result 表达并驱动卡片状态。
      const status: CiSubscriptionV2['status'] = result.outcome === 'cancelled' ? 'cancelled' : 'completed';
      const completed = ciSubscriptionV2Schema.parse({
        ...working.value,
        revision: working.value.revision + 1,
        status,
        result,
        resultBoundary: 'verified',
        blockReason: undefined,
        error: undefined,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        ...(recoverLegacyCapacity && working.value.delivery.status === 'not_requested' && this.options.deliver
          ? { delivery: { status: 'pending', attempts: working.value.delivery.attempts, updatedAt: iso(this.clock()) } } : {}),
        ...(result.outcome === 'cancelled' ? { delivery: this.delivery.undelivered(working.value.delivery) } : {}),
        updatedAt: iso(this.clock())
      });
      if (!await this.store.replace(ciKey(value.id), working.raw, completed)) return;
    } else if (!working.value.result) {
      if (['waiting', 'dispatching', 'error'].includes(working.value.status)) {
        await this.ci.finishCi(working, 'blocked', 'Historical terminal CI continuation has no verifiable result');
      }
      return;
    }
  }
}

export class SessionAutomationService {
  private readonly scheduler: AutomationScheduler;

  constructor(private readonly options: SessionAutomationServiceOptions) {
    this.scheduler = new AutomationScheduler(options, this);
  }

  /** 至少装了一个 CI 插件；/ci 据此判断「未安装 CI 插件」。 */
  get ciConfigured() {
    return this.scheduler.ci.ciConfigured;
  }

  get ciWebhook() { return this.options.ciWebhook; }

  get pullRequests() { return this.options.pullRequests; }

  listCiProviders(): PublicCiProvider[] {
    return this.scheduler.ci.listCiProviders();
  }

  /** 群委托的确认卡与产出卡按钮处理；群协作集成装配好后挂上，飞书卡片回调经此进入。 */
  mandateCards?: { callback(appId: string, value: Record<string, unknown>, operatorId: string | undefined, context: { messageId?: string; chatId?: string }): Promise<string> };

  listBySession(sessionId: string, actorId?: string): Promise<SessionAutomationList> {
    return this.scheduler.store.listBySession(sessionId, actorId);
  }

  createSchedule(sessionId: string, rawInput: CreateSessionScheduleInput, actorId?: string, receipt?: { key: string; prepareDelivery?: (id: string) => Promise<void> }): Promise<PublicSessionSchedule> {
    return this.scheduler.store.createSchedule(sessionId, rawInput, actorId, receipt);
  }

  /**
   * 聊天里代建计划：同事项已有生效循环计划时拒绝新建；已停用同名计划保留兼容更新，不新建第二条。
   * 有实际改动时一并停用，等用户在确认卡上重新启用；没有改动时原样返回。同一请求重试拿回同一结果。
   * `newMode` 只在新建、请求没写模式、且本实例能开新会话时作为缺省；更新同名计划时不改它的模式。
   */
  requestSchedule(sessionId: string, rawInput: CreateSessionScheduleInput, actorId: string, receipt: { key: string; newMode?: 'fresh'; prepareDelivery?: (id: string) => Promise<void> }): Promise<{ schedule: PublicSessionSchedule; updated?: { changed: boolean; wasEnabled: boolean } }> {
    return this.scheduler.store.requestSchedule(sessionId, rawInput, actorId, receipt);
  }

  /** Map internal schedule execution back to its frozen source authority. */
  authorizeExecutionSession(sessionId: string, actorId?: string): Promise<boolean> {
    return this.scheduler.store.authorizeExecutionSession(sessionId, actorId);
  }

  sourceSessionId(sessionId: string): Promise<string | undefined> {
    return this.scheduler.store.sourceSessionId(sessionId);
  }

  /**
   * 计划每次在新会话执行、结果回原话题；这里补上两处衔接，只在这个会话还没用过这份结果时给：
   * 计划的新会话第一轮带上一次的结果摘要；原话题的会话在那次运行之后第一次接到消息时带最近一次的结果，用户多半是在跟进它。
   */
  resultContext(session: Session): Promise<string | undefined> {
    return this.scheduler.store.resultContext(session);
  }

  static async getSchedule(store: Pick<import('@dutydeck/shared').ConfigRepository, 'get'>, scheduleId: string): Promise<Pick<SessionSchedule, 'id' | 'name' | 'sessionId'> | undefined> {
    const raw = await store.get(scheduleKey(scheduleId));
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      const strict = sessionScheduleSchema.safeParse(parsed);
      if (strict.success) {
        return { id: strict.data.id, name: strict.data.name, sessionId: strict.data.sessionId };
      }
      if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string' && typeof parsed.name === 'string' && typeof parsed.sessionId === 'string') {
        return { id: parsed.id, name: parsed.name, sessionId: parsed.sessionId };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  async getSchedule(scheduleId: string): Promise<Pick<SessionSchedule, 'id' | 'name' | 'sessionId'> | undefined> {
    return SessionAutomationService.getSchedule(this.options.repositories.config, scheduleId);
  }

  getScheduleDefinition(sessionId: string, id: string, actorId?: string): Promise<PublicSessionSchedule> {
    return this.scheduler.store.getScheduleDefinition(sessionId, id, actorId);
  }

  getScheduleHistory(sessionId: string, id: string, actorId?: string): Promise<PublicSessionScheduleOccurrence[]> {
    return this.scheduler.store.getScheduleHistory(sessionId, id, actorId);
  }

  listSchedules(query: AutomationScheduleQuery, authorize: (sessionId: string) => Promise<boolean | { actorId?: string }>): Promise<AutomationSchedulePage> {
    return this.scheduler.store.listSchedules(query, authorize);
  }

  getScheduleHistoryPage(sessionId: string, id: string, offset: number, limit: number, actorId?: string): Promise<AutomationHistoryPage> {
    return this.scheduler.store.getScheduleHistoryPage(sessionId, id, offset, limit, actorId);
  }

  getScheduleRun(sessionId: string, scheduleId: string, id: string, actorId?: string): Promise<AutomationRunDetail> {
    return this.scheduler.store.getScheduleRun(sessionId, scheduleId, id, actorId);
  }

  updateSchedule(sessionId: string, id: string, rawInput: UpdateSessionScheduleInput, actorId?: string): Promise<PublicSessionSchedule> {
    return this.scheduler.store.updateSchedule(sessionId, id, rawInput, actorId);
  }

  deleteSchedule(sessionId: string, id: string, rawInput: DeleteSessionScheduleInput, actorId?: string): Promise<PublicSessionSchedule> {
    return this.scheduler.store.deleteSchedule(sessionId, id, rawInput, actorId);
  }

  runSchedule(sessionId: string, id: string, rawInput: RunSessionScheduleInput, actorId?: string): Promise<PublicSessionScheduleOccurrence> {
    return this.scheduler.occurrences.runSchedule(sessionId, id, rawInput, actorId);
  }

  subscribeCi(sessionId: string, rawInput: SubscribeCiInput, actorId?: string): Promise<PublicCiSubscription> {
    return this.scheduler.ci.subscribeCi(sessionId, rawInput, actorId);
  }

  cancelCi(sessionId: string, id: string, rawInput: { expectedRevision: number }, actorId?: string): Promise<PublicCiSubscription> {
    return this.scheduler.ci.cancelCi(sessionId, id, rawInput, actorId);
  }

  /** No schedule ID is accepted: only the current occurrence's durable host binding can request this. */
  requestScheduleStop(sessionId: string, taskId: string, attemptId: string, actorId: string) {
    return this.scheduler.requestScheduleStop(sessionId, taskId, attemptId, actorId);
  }

  tick(): Promise<void> {
    return this.scheduler.tick();
  }

  close(): Promise<void> {
    return this.scheduler.close();
  }

  authorizeTask(task: TaskRecord, phase: 'prepare' | 'submit' = 'prepare'): Promise<void> {
    return this.scheduler.occurrences.authorizeTask(task, phase);
  }
}
