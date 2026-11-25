import type { DriverRegistry } from './driver-registry.js';
import type { AgentDriver, AttemptRef, BoundExecutionRepository, CommitResult, ExecutionActor, PublicTaskRecord, RepositoryBundle, ResourceCheckRef, Session, SessionFence, TaskAttempt, TaskRecord } from '@dutydeck/shared';
import { backgroundKindFor, executionActorSchema, RuntimeError } from '@dutydeck/shared';
import type { RuntimeHost } from './host-ports.js';
import { digest, LocalDriverLedger } from '../ledger.js';
import { RuntimeSessionMutations, type Owner } from '../ownership.js';
import { SessionGate } from '../session-gate.js';
import { DriverSupervisor } from './driver-supervisor.js';
import { HumanWaits } from './human-waits.js';
import { Notices } from './notices.js';

/** 排队超过这么久仍未开始的消息，轮到它时不再执行，改为取消。 */
const QUEUED_TASK_EXPIRE_MS = 24 * 60 * 60_000;
/** 同会话上一条任务由 Agent 跑完不到这么久，视为按顺序轮到排头，不按过期处理。 */
const QUEUE_HANDOFF_MS = 15 * 60_000;

interface SchedulerDependencies {
  registry: DriverRegistry;
  activeTasks: Map<string, TaskRecord>;
  attachedTerminals: WeakSet<AgentDriver>;
  bound: () => BoundExecutionRepository;
  fence: (session: Session) => SessionFence;
  gate: Pick<SessionGate, 'reasons'>;
  hasBinding(): boolean;
  executionProcessesGone(id: string): boolean;
  humanWaits: HumanWaits;
  interruptOwnedAttempt(ref: AttemptRef & SessionFence, operationId: string): Promise<void>;
  localResources: LocalDriverLedger;
  notices: Notices;
  options: Pick<RuntimeHost, 'log'>;
  recoveryActor: ExecutionActor;
  repos: RepositoryBundle;
  runTask(id: string, task: TaskRecord, attempt: TaskAttempt): Promise<PublicTaskRecord>;
  shuttingDown(): boolean;
  steeringActive(id: string): boolean;
  supervisor: Pick<DriverSupervisor, 'drivers' | 'driverOperations' | 'retiringDrivers' | 'pendingApprovalRetirements' | 'stopDriver'>;
  verifyingSessions: Set<string>;
  wake: <T extends CommitResult>(result: T) => T;
  warnCaught: (location: string, sessionId: string | undefined, error: unknown) => void;
}

export class Scheduler {
  constructor(private readonly mutations: RuntimeSessionMutations, private readonly deps: SchedulerDependencies) {}

  /** Restart drain: accepted Tasks stay durable and queued; no new Attempt is claimed until released or the next process. */
  private queueHeld = false;
  private readonly queues = new Map<string, TaskRecord[]>();
  readonly queueRuns = new Map<string, Promise<void>>();
  readonly queueBlocked = new Set<string>();
  readonly resourceQueueBlocked = new Set<string>();
  private resourceQueueRevision = 0;
  private resourceQueueRetryPending = false;
  private readonly capacityTimers = new Map<string, { taskId: string; timer: ReturnType<typeof setTimeout> }>();
  /** Hold or release claiming of queued Tasks. Admission is unchanged; release reschedules every projected queue. */
  setQueueHeld(held: boolean) {
    if (this.queueHeld === held) return;
    this.queueHeld = held;
    if (!held) for (const id of [...this.queues.keys()]) this.mutations.run(undefined, () => this.scheduleQueue(id));
  }
  isQueueHeld() { return this.queueHeld; }
  rememberQueued(task: TaskRecord) {
    // A committed Task keeps scheduling alive if the derived queue read fails. claimNext owns order.
    if (task.status !== 'queued') return;
    const queue = this.queues.get(task.sessionId) ?? [];
    if (!queue.some(item => item.id === task.id)) this.queues.set(task.sessionId, [...queue, task]);
  }
  async queuedTasks(id: string) {
    return this.deps.repos.tasks.listQueued ? this.deps.repos.tasks.listQueued(id)
      : (await this.deps.repos.tasks.listBySession(id)).filter(task => task.status === 'queued');
  }
  async projectQueue(id: string) {
    const queue = await this.queuedTasks(id);
    this.mutations.check();
    if (queue.length) this.queues.set(id, queue); else this.queues.delete(id);
  }
  scheduleQueue(id: string) {
    const [block] = this.deps.gate.reasons(id, 'drain', { firstOnly: true });
    const delayed = this.capacityTimers.get(id);
    if (delayed && block?.code !== 'capacity_wait') { clearTimeout(delayed.timer); this.capacityTimers.delete(id); }
    if (block) return;
    const token = this.mutations.turnOwner(id); this.mutations.drains.set(id, token);
    const run = this.mutations.run(token, () => this.drainQueue(id)); this.queueRuns.set(id, run);
    const finish = () => {
      if (this.mutations.drains.get(id) !== token) return;
      this.mutations.drains.delete(id); token.revoke({ code: 'queue_drain_finished', by: 'DutydeckRuntime.scheduleQueue' });
      if (this.queueRuns.get(id) === run) this.queueRuns.delete(id);
      this.mutations.run(undefined, () => this.scheduleQueue(id));
    };
    void run.then(finish, finish);
  }
  /** A turn, steering, verification, stop or driver retirement still owns the session. */
  sessionHeld(id: string): boolean {
    return this.deps.gate.reasons(id, 'held', { firstOnly: true }).length > 0;
  }
  riskBackgroundCleared(id: string) {
    if (this.deps.supervisor.pendingApprovalRetirements.has(id)) return false;
    const driver = this.deps.supervisor.drivers.get(id);
    if (!driver) return this.deps.executionProcessesGone(id);
    return this.deps.registry.method(driver, 'hasBackgroundWork')?.() !== true && !this.deps.supervisor.retiringDrivers.has(id) && !this.deps.supervisor.driverOperations.get(driver)?.size
      && !this.deps.humanWaits.pendingPermissionCount(id) && !this.deps.registry.method(driver, 'isDetachedForShutdown')?.()
      && this.deps.registry.foregroundIdle(driver) && this.deps.registry.method(driver, 'backgroundWorkCleared')?.() === true;
  }
  /** Ephemeral proof from the original adapters; no idle evidence survives a runtime restart. */
  idleResourceChecks(): ResourceCheckRef[] {
    const checks: ResourceCheckRef[] = [];
    for (const [id, driver] of this.deps.supervisor.drivers) {
      if (this.sessionHeld(id) || this.deps.supervisor.driverOperations.get(driver)?.size
        || this.deps.humanWaits.pendingPermissionCount(id) || this.deps.registry.method(driver, 'isDetachedForShutdown')?.() || this.deps.registry.method(driver, 'hasBackgroundWork')?.() !== false) continue;
      if (this.deps.registry.method(driver, 'isIdle')?.() !== true) {
        const original = this.deps.localResources.get(driver);
        // A new control channel may not have a screen snapshot yet. Preserve its native
        // context only if this original ready driver has never received any submission.
        if (!original?.creationSettled || this.deps.attachedTerminals.has(driver) || original.context.mode === 'attach'
          || this.deps.repos.execution.getSessionExecutions(id).some(value => value.steering
            || value.task.status === 'reconcile_required' || value.attempts.some(attempt => attempt.submissionState !== 'not_submitted'))) continue;
      }
      const reusable = this.deps.localResources.reusableIds(id);
      for (const r of this.deps.repos.execution.getResources(id)) {
        const last = r.observations.at(-1);
        if (reusable.has(r.resourceId) && last?.state === 'live') checks.push({resourceId:r.resourceId,expectedRevision:r.revision,observationId:last.observationId});
      }
    }
    return checks;
  }
  private async closeUnprovenIdleCompetitors(id: string, taskId: string, allowProofRetry: boolean): Promise<boolean> {
    const blockers = this.deps.repos.execution.getTaskExecution(taskId)?.blockers ?? [];
    let closed = false;
    // Idle proof covers every driver, so one pass serves all competitors until the next await lets driver state move.
    let fresh: ResourceCheckRef[] | undefined;
    for (const otherId of new Set(blockers.filter(value => value.code === 'WORKSPACE_PHYSICAL_RESOURCE_UNSAFE').map(value => value.sessionId))) {
      if (otherId === id || this.deps.repos.execution.getUnresolvedTasks(otherId).length || this.sessionHeld(otherId)
        || blockers.some(value => value.sessionId === otherId && value.code !== 'WORKSPACE_PHYSICAL_RESOURCE_UNSAFE')) continue;
      const driver = this.deps.supervisor.drivers.get(otherId);
      if (!driver || this.deps.registry.method(driver, 'hasBackgroundWork')?.() === true || this.deps.supervisor.driverOperations.get(driver)?.size || this.deps.humanWaits.pendingPermissionCount(otherId)) continue;
      const proof = fresh ??= this.idleResourceChecks();
      const resources = this.deps.repos.execution.getResources(otherId);
      const disputed = blockers.filter(value => value.sessionId === otherId && value.code === 'WORKSPACE_PHYSICAL_RESOURCE_UNSAFE');
      if (disputed.every(block => {
        const r = resources.find(value => value.resourceId === block.resourceId);
        const parent = resources.find(value => value.resourceId === r?.parentResourceId);
        return r && proof.some(check => check.resourceId === r.resourceId)
          && (r.kind === 'local_only' || r.kind === 'process' && parent?.stage === 'created' && ['lifecycle','strict-context-restore'].includes(parent.operationScope?.kind ?? ''));
      })) { if (allowProofRetry) closed = true; continue; }
      fresh = undefined;
      // Adapters without a reliable background-empty proof must prove physical stop on contention.
      if (this.deps.registry.supports(driver, 'prepareForIdleRetirement') && !await driver.prepareForIdleRetirement()) continue;
      try { await this.mutations.run(undefined, () => this.deps.supervisor.stopDriver(otherId,driver)); closed = true; }
      catch (error) { this.deps.warnCaught('closeUnprovenIdleCompetitors.stopDriver', otherId, error); }
    }
    return closed;
  }
  async drainQueue(id: string) {
    let admissionRechecked = false;
    while (this.mutations.valid() && !this.deps.shuttingDown() && !this.queueHeld && !this.deps.supervisor.retiringDrivers.has(id) && !this.mutations.attempts.has(id) && !this.deps.verifyingSessions.has(id) && !this.deps.steeringActive(id)) {
      const session = await this.mutations.wait(() => this.deps.repos.sessions.get(id));
      if (!session) return;
      let next: TaskRecord | undefined;
      let ordinaryWhileWaiting: string | undefined;
      try {
        const queue = await this.queuedTasks(id);
        next = queue[0];
        if (next?.executionContext?.riskPolicy?.approvalRequestId && !this.riskBackgroundCleared(id)) {
          const ordinary = queue.find(task => !task.executionContext?.riskPolicy?.approvalRequestId);
          if (ordinary) { next = ordinary; ordinaryWhileWaiting = ordinary.id; }
        }
      }
      catch (error) { this.deps.warnCaught('drainQueue.readQueuedTasks', id, error); this.queueBlocked.add(id); return; }
      if (next && this.deps.repos.execution.getAcceptedTask(next.id)?.input?.version !== 2) { this.queueBlocked.add(id); return; }
      const retry = next && this.deps.repos.execution.getTaskExecution(next.id)?.currentAttempt?.automaticRetry;
      if (next && retry && Date.parse(retry.dueAt) > Date.now()) {
        const timer = setTimeout(() => {
          this.capacityTimers.delete(id);
          this.mutations.run(undefined, () => this.scheduleQueue(id));
        }, Math.min(2_147_483_647, Date.parse(retry.dueAt) - Date.now()));
        timer.unref(); this.capacityTimers.set(id, { taskId: next.id, timer }); return;
      }
      let expired = false;
      try { expired = !!next && await this.expireStaleQueued(session, next); }
      catch (error) {
        // 取消没成功也不能把旧消息交给 Agent。
        this.deps.options.log?.warn({ sessionId: id, taskId: next!.id, error }, 'Expiring a stale queued task failed');
        this.queueBlocked.add(id); return;
      }
      if (expired) continue;
      let claimed: CommitResult | undefined;
      let token: Owner | undefined;
      const resourceRevision = this.resourceQueueRevision;
      try {
        await this.mutations.write(id, async () => {
          if (this.deps.supervisor.retiringDrivers.has(id)) throw new RuntimeError('WORKSPACE_RESOURCE_BLOCKED', 'The original idle driver is still closing', 409);
          const cleared = next?.executionContext?.riskPolicy?.approvalRequestId && this.riskBackgroundCleared(id) ? next.id : undefined;
          claimed = this.wakeOptional(this.deps.bound().claimNext(this.deps.fence(session), this.idleResourceChecks(), cleared, ordinaryWhileWaiting));
          if (claimed?.task && claimed.attempt) {
            token = this.mutations.turnOwner(id);
            this.mutations.attemptRefs.set(token, { sessionId: id, runId: claimed.attempt.runId, taskId: claimed.task.id, attemptId: claimed.attempt.attemptId });
            this.mutations.attempts.set(id, token); this.deps.activeTasks.set(id, claimed.task);
          }
        });
      } catch (error) {
        if (error instanceof RuntimeError && error.code === 'RISK_APPROVAL_WAITING' && next) {
          const timer = setTimeout(() => {
            this.capacityTimers.delete(id);
            this.mutations.run(undefined, () => this.scheduleQueue(id));
          }, 1000);
          timer.unref();
          this.capacityTimers.set(id, { taskId: next.id, timer });
          return;
        }
        if (error instanceof RuntimeError && error.code === 'WORK_ITEM_CAPACITY_BLOCKED') {
          // A release may race the rejected claim's promise continuation. Recheck that wake once.
          this.blockOnResources(id, resourceRevision);
          return;
        }
        if (error instanceof RuntimeError && error.code === 'WORKSPACE_RESOURCE_BLOCKED') {
          if (next && await this.closeUnprovenIdleCompetitors(id,next.id,!admissionRechecked)) { admissionRechecked = true; continue; }
          if (next) await this.deps.notices.noteWorkspaceBlocked(session, next.id, error.details)
            .catch(noteError => this.deps.options.log?.warn({ sessionId: id, taskId: next.id, error: String(noteError) }, 'Workspace blocked notice failed'));
          this.blockOnResources(id, resourceRevision);
          return;
        }
        this.queueBlocked.add(id); return;
      }
      this.deps.notices.clearWorkspaceBlock(id);
      if (!claimed?.task || !claimed.attempt || !token) { this.queues.delete(id); return; }
      admissionRechecked = false;
      // No await separates claiming the durable activity slot from registering its local owner.
      const running = this.mutations.run(token, () => this.deps.runTask(id, claimed!.task!, claimed!.attempt!));
      await this.mutations.wait(() => running);
      await this.projectQueue(id);
      await this.applyQueueActions(session);
    }
  }
  private wakeOptional(result: CommitResult | undefined) { return result ? this.deps.wake(result) : undefined; }
  /** A wake that landed while this claim was failing goes through the shared retry pass instead of an immediate re-drain. */
  private blockOnResources(id: string, revision: number) {
    this.resourceQueueBlocked.add(id);
    if (revision !== this.resourceQueueRevision) this.retryResourceQueues();
  }
  /**
   * 排头任务从未开始、已排队超过 24 小时，又不是同会话上一条任务刚由 Agent 跑完、按顺序轮到它：多半是被挡了很久的旧消息，
   * 现在执行会出乎发送者意料。以安装所有者身份取消，并提醒需要时重发。
   */
  private async expireStaleQueued(session: Session, task: TaskRecord) {
    // 记忆管线管理自己的超时与重试；通用取消会被它当作失败并重新建作业。
    if (backgroundKindFor(session.source)?.managesQueueExpiry) return false;
    const now = Date.now();
    if (now - Date.parse(task.createdAt) <= QUEUED_TASK_EXPIRE_MS) return false;
    const current = this.deps.repos.execution.getTaskExecution(task.id);
    const attempt = current?.currentAttempt;
    if (!current || attempt && (attempt.submissionState !== 'not_submitted' || attempt.automaticRetry || attempt.manualRetry)) return false;
    const handedOff = (await this.deps.repos.tasks.listBySession(session.id)).some(item => now - Date.parse(item.updatedAt) < QUEUE_HANDOFF_MS
      && this.deps.repos.execution.getTaskExecution(item.id)?.currentAttempt?.settlement?.kind === 'driver_result');
    if (handedOff) return false;
    await this.mutations.write(session.id, async () => this.deps.wake(this.deps.bound().cancelQueued(this.deps.fence(session), task.id, current.task.revision,
      { decisionId: `queue_expired:${task.id}`, actor: this.deps.recoveryActor, action: 'cancel', evidenceRefs: ['runtime:queue-expired', `task_created:${task.createdAt}`], resourceChecks: [] })));
    await this.projectQueue(session.id);
    this.deps.options.log?.warn({ sessionId: session.id, taskId: task.id, createdAt: task.createdAt }, 'Cancelled a queued task that waited over 24 hours without starting');
    await this.deps.notices.sessionNotice(session, { id: `notice_${digest(['queue_expired', task.id])}`, taskId: task.id, sessionIds: [session.id] }, { kind: 'queue_expired' });
    return true;
  }
  async applyQueueActions(session: Session) {
    for (const action of this.deps.bound().getPendingQueueActions(this.deps.fence(session))) {
      const target = action.target;
      if (!target) continue;
      const targetAttempt = this.deps.repos.execution.getTaskExecution(target.taskId)?.attempts.find(item => item.attemptId === target.attemptId);
      const token = this.mutations.attempts.get(session.id);
      const ref = token && this.mutations.attemptRefs.get(token);
      if (targetAttempt?.state === 'settled') {
        this.deps.bound().settleQueueAction(this.deps.fence(session), action.operationId, action.revision, { evidenceId: `queue_settled:${action.operationId}`, state: 'applied', reason: 'original_attempt_settled', resourceChecks: [] });
      } else if (ref?.attemptId === target.attemptId && this.mutations.valid(token)) {
        await this.deps.interruptOwnedAttempt(ref, action.operationId);
      } else if (action.state === 'pending') this.deps.bound().settleQueueAction(this.deps.fence(session), action.operationId, action.revision, { evidenceId: `queue_blocked:${action.operationId}`, state: 'blocked', reason: 'original_attempt_not_owned', resourceChecks: [] });
    }
  }
  wakeResourceQueues() {
    this.resourceQueueRevision++;
    this.retryResourceQueues();
  }
  /** One pending pass per burst: each pass re-runs full workspace admission for every blocked session. */
  private retryResourceQueues() {
    if (this.resourceQueueRetryPending || !this.resourceQueueBlocked.size) return;
    this.resourceQueueRetryPending = true;
    queueMicrotask(() => {
      this.resourceQueueRetryPending = false;
      const waiting = [...this.resourceQueueBlocked]; this.resourceQueueBlocked.clear();
      if (!this.deps.shuttingDown() && this.deps.hasBinding()) for (const id of waiting) this.mutations.run(undefined, () => this.scheduleQueue(id));
    });
  }

  cancelCapacityTimer(id: string) {
    const delayed = this.capacityTimers.get(id);
    if (delayed) { clearTimeout(delayed.timer); this.capacityTimers.delete(id); }
  }

  projected(id: string): readonly TaskRecord[] | undefined { return this.queues.get(id); }
  clearQueues() { this.queues.clear(); }
  unblockQueue(id: string) { this.queueBlocked.delete(id); }
  capacityWaiting(id: string) {
      const delayed = this.capacityTimers.get(id);
      const current = delayed && this.deps.repos.execution.getTaskExecution(delayed.taskId);
      return current?.task.status === 'queued' && !!current.currentAttempt?.automaticRetry && Date.parse(current.currentAttempt.automaticRetry.dueAt) > Date.now();
  }

  async removeCancelled(id: string, taskId: string) {
    const queue = this.queues.get(id);
    if (queue) {
      const next = queue.filter(item => item.id !== taskId);
      if (next.length) this.queues.set(id, next);
      else this.queues.delete(id);
    }
    try {
      await this.projectQueue(id);
    } catch {
      this.queueBlocked.add(id);
    }
  }

  async cancelSessionQueue(id: string, suppliedActor?: ExecutionActor): Promise<boolean> {
    const session = await this.deps.repos.sessions.get(id);
    if (!session) return true;
    const queued = await this.queuedTasks(id);
    const actor = executionActorSchema.parse(suppliedActor ?? { kind: 'unspecified' });
    if (queued.length && actor.kind === 'unspecified') return false;
    for (const task of queued) {
      const current = this.deps.repos.execution.getTaskExecution(task.id)!.task;
      this.deps.wake(this.deps.bound().cancelQueued(this.deps.fence(session), task.id, current.revision, { decisionId: `stop_cancel:${task.id}:${current.revision}`, actor, action: 'cancel', evidenceRefs: ['runtime:session-stop'], resourceChecks: [] }));
    }
    this.queues.delete(id); return true;
  }
}
