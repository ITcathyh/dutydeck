import type { DriverRegistry } from './driver-registry.js';
import type { RuntimeHost } from './host-ports.js';
import type { SteeringOutcome, SteeringResult } from '../index.js';
import { clearTaskReportSafely } from '@dutydeck/shared';
import type { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentDriver, AgentEvent, EventType, PromptSourceDiagnostics, PublicTaskRecord, RepositoryBundle, Session, TaskRecord } from '@dutydeck/shared';
import { steeringRecoveryDecisionSchema, steerableTaskNamespace, makeId, errorMessage, RuntimeError } from '@dutydeck/shared';
import type { SteeringRecoveryDecision, SteeringOperation, AcceptedTaskInputV2, AttemptRef, BoundExecutionRepository, CommitResult, DriverSteeringOutcome, ExecutionActor, ResourceCheckRef, SessionFence, TaskExecutionProjection } from '@dutydeck/shared';
import { digest } from '../ledger.js';
import type { RecoveryService } from './recovery-service.js';
import { RevokedOperation, type RuntimeSessionMutations } from '../ownership.js';

/** The acknowledgement deadline does not cancel remote delivery or permit replay. */
const STEERING_TIMEOUT_MS = 30_000;

interface SteeringServiceDependencies {
  registry: DriverRegistry;
  acceptedInput: (task: TaskRecord) => AcceptedTaskInputV2;
  active: (id: string) => Promise<{ session: Session; driver: AgentDriver | undefined; }>;
  actor: (session: Session, actorId?: string) => ExecutionActor;
  applyQueueActions: (session: Session) => Promise<void>;
  assertReady: () => void;
  authorize: (id: string, actorId?: string, activate?: boolean) => Promise<void>;
  bound: () => BoundExecutionRepository;
  driverOperation: <T>(driver: AgentDriver, operation: () => Promise<T>) => Promise<T>;
  emit: (sessionId: string, type: EventType, data: unknown, raw?: string, eventId?: string, sourceId?: string) => Promise<AgentEvent<unknown>>;
  eventScope: AsyncLocalStorage<SessionFence | (AttemptRef & SessionFence)>;
  fence: (session: Session) => SessionFence;
  hasBinding(): boolean;
  idleResourceChecks: () => ResourceCheckRef[];
  inspectRecovery: RecoveryService['inspectExecutionRecovery'];
  isQueueHeld: () => boolean;
  logTaskRejection: <T>(id: string, operation: Promise<T>) => Promise<T>;
  options: Pick<RuntimeHost, 'prompts' | 'policy'>;
  projectQueue: (id: string) => Promise<void>;
  publicTask: (task: TaskRecord) => PublicTaskRecord;
  unblockQueue(id: string): void;
  recordPrompt: (sessionId: string, prompt: string, stage: "accepted_input" | "session_context", mode: "send" | "steer", inputTaskId: string, operationId?: string, sources?: PromptSourceDiagnostics) => Promise<void>;
  recoveryInFlight: (id: string, includeQueueDrain?: boolean) => boolean;
  reopenQueue: (id: string) => Promise<void>;
  repos: RepositoryBundle;
  requireRecoveryOwner(actor: ExecutionActor): void;
  scheduleQueue: (id: string) => void;
  turnOutput: (ref: AttemptRef) => { readonly status: "interrupted" | "completed" | "failed" | "cancelled"; readonly stopReason: string; readonly confirmation: string | undefined; readonly outputDigest: string; };
  wake: <T extends CommitResult>(result: T) => T;
  wakeResourceQueues: () => void;
  warnTaskRejection: (sessionId: string, error: unknown) => void;
}

export class SteeringService {
  constructor(private readonly mutations: RuntimeSessionMutations, private readonly deps: SteeringServiceDependencies) {}

  /** A steering request is in flight (session -> Task): the queue must not claim, and cancel must not retract, the Task being injected. */
  private readonly steeringSessions = new Map<string, string>();
  private readonly steeringReplies = new Map<string, {sessionId: string; driver: AgentDriver}>();
  async steerQueued(id: string, taskId: string, actorId?: string, expectedRevision?: number, operationId = makeId('promote')) {
    return this.deps.logTaskRejection(id, this.mutations.scoped(id, async () => {
      const { session } = await this.deps.active(id);
      const task = this.deps.repos.execution.getTaskExecution(taskId)?.task;
      if (!task) throw new RuntimeError('QUEUED_TASK_NOT_FOUND', 'Queued task is missing', 404);
      const committed = await this.mutations.write(id, async () => {
        const owner = this.mutations.attempts.get(id);
        const ref = owner && this.mutations.attemptRefs.get(owner);
        if (ref && this.deps.repos.execution.getTaskExecution(ref.taskId)?.task.executionContext?.riskPolicy?.approvalRequestId) return { task };
        return this.deps.wake(this.deps.bound().promoteQueued(this.deps.fence(session), taskId, expectedRevision ?? task.revision, { operationId, actor: this.deps.actor(session, actorId), interrupt: true }));
      });
      await this.deps.projectQueue(id); await this.deps.applyQueueActions(session); this.deps.unblockQueue(id); this.deps.scheduleQueue(id);
      return this.deps.publicTask(committed.task!);
    }));
  }
  /** 插话：先持久记录投递意图；没有明确回执时禁止普通队列重发。 */
  async injectQueued(id: string, taskId: string, actorId?: string, operationId = makeId('steering'), expectedTarget?: { taskId: string; attemptId?: string }): Promise<SteeringResult> {
    return this.deps.logTaskRejection(id, this.mutations.scoped(id, async () => {
      const {session,driver} = await this.deps.active(id);
      await this.deps.authorize(id,actorId);
      const projection = this.deps.repos.execution.getTaskExecution(taskId);
      const result = (projection: TaskExecutionProjection, outcome: SteeringOutcome, error?: string): SteeringResult => {
        const target = projection.steering?.operationId === operationId ? projection.steering.target : undefined;
        return { task: this.deps.publicTask(projection.task), outcome,
          ...(target ? { target: { taskId: target.taskId, attemptId: target.attemptId } } : {}),
          ...(error ? { error } : {}) };
      };
      if (projection?.task.sessionId === id && projection.steering?.operationId === operationId) {
        return result(projection, projection.steering.outcome ?? 'failed');
      }
      const task = projection?.task;
      if (!task || task.sessionId !== id || task.status !== 'queued') throw new RuntimeError('QUEUED_TASK_NOT_FOUND','Queued task is missing',404);
      const skipped = (outcome: SteeringOutcome, error?: string): SteeringResult => result(this.deps.repos.execution.getTaskExecution(taskId)!, outcome, error);
      if (!this.deps.registry.supports(driver, 'steer') || this.deps.repos.execution.getAcceptedTask(taskId)?.request?.namespace !== steerableTaskNamespace) return skipped('unsupported');
      const running = () => {
        const token = this.mutations.attempts.get(id);
        const ref = token && this.mutations.attemptRefs.get(token);
        const execution = ref && this.deps.repos.execution.getTaskExecution(ref.taskId);
        const attempt = execution?.attempts.find(item => item.attemptId === ref!.attemptId);
        return ref && execution && attempt?.state === 'active' && attempt.submissionState !== 'not_submitted' ? {ref,task:execution.task} : undefined;
      };
      const target = running();
      if (!target || expectedTarget && (target.ref.taskId !== expectedTarget.taskId
        || expectedTarget.attemptId !== undefined && target.ref.attemptId !== expectedTarget.attemptId)) return skipped('promptRequired');
      if (target.task.executionContext?.riskPolicy?.approvalRequestId || task.executionContext?.riskPolicy?.approvalRequestId) return skipped('incompatible');
      const input = this.deps.acceptedInput(task);
      if (task.currentAttemptId || digest(input.executionOptions) !== digest(this.deps.acceptedInput(target.task).executionOptions)
        || digest(task.executionContext?.riskPolicy ?? null) !== digest(target.task.executionContext?.riskPolicy ?? null)) return skipped('incompatible');
      if (this.steeringSessions.has(id)) throw new RuntimeError('STEERING_IN_PROGRESS','A steering delivery is already pending',409);
      this.steeringSessions.set(id,taskId);
      let operation: SteeringOperation | undefined;
      const record = async (outcome: DriverSteeringOutcome | 'unknown') => this.mutations.run(undefined, async () => {
        if (!operation || !this.deps.hasBinding()) return;
        const committed = await this.mutations.write(id, async () => this.deps.wake(this.deps.bound().resolveQueuedSteering({sessionId:id,runId:operation!.runId},operationId,operation!.controller,outcome)));
        await this.deps.projectQueue(id);
        if (!committed.replayed) this.deps.unblockQueue(id);
        this.deps.scheduleQueue(id);
      });
      try {
        await this.deps.authorize(id,task.executionContext?.actorId);
        await this.mutations.wait(() => this.deps.options.policy.authorize({ phase: 'submit', session, task }));
        if (this.deps.isQueueHeld() || running()?.ref.attemptId !== target.ref.attemptId) return skipped('promptRequired');
        const reserved = await this.mutations.write(id, async () => this.deps.wake(this.deps.bound().beginQueuedSteering(this.deps.fence(session),taskId,task.revision,
          {operationId,actor:this.deps.actor(session,actorId),target:{taskId:target.ref.taskId,attemptId:target.ref.attemptId}},this.deps.idleResourceChecks())));
        operation = this.deps.repos.execution.getTaskExecution(taskId)!.steering!;
        if (reserved.replayed) return skipped(operation.outcome ?? 'failed');
        await this.deps.projectQueue(id);
        const steerContext = { ...input.executionContext, promptPolicyVersion: target.task.executionContext?.promptPolicyVersion ?? 'legacy-v1' as const };
        const assembled = steerContext.promptPolicyVersion === 'optimized-v1'
          ? await this.mutations.wait(() => Promise.resolve(this.deps.options.prompts.atExecute(session, input.executionContext.agentPrompt, steerContext,
            { taskId: target.ref.taskId, attemptId: target.ref.attemptId, actorId: target.task.executionContext?.actorId })))
          : input.executionContext.agentPrompt;
        const steeringPrompt = typeof assembled === 'string' ? assembled : assembled.prompt;
        await this.deps.recordPrompt(id, input.executionContext.agentPrompt, 'accepted_input', 'steer', task.id, operationId, input.executionContext.promptDiagnostics);
        if (typeof assembled !== 'string') await this.deps.recordPrompt(id, steeringPrompt, 'session_context', 'steer', task.id, operationId, assembled.diagnostics);
        // No await separates this final ownership check from initiating the remote operation.
        this.mutations.check();
        if (this.deps.isQueueHeld() || running()?.ref.attemptId !== target.ref.attemptId) { await record('promptRequired'); return skipped('promptRequired'); }
        let timer: NodeJS.Timeout | undefined, finishObservation: (()=>void) | undefined;
        try {
          const outcome = await this.deps.driverOperation(driver, () => {
            this.steeringReplies.set(operationId,{sessionId:id,driver});
            let reply: Promise<DriverSteeringOutcome>;
            try { reply = driver.steer!(steeringPrompt); } catch (error) { reply = Promise.reject(error); }
            const observed = reply.then(async outcome => {
              if (this.steeringReplies.has(operationId)) await record(outcome);
              return outcome;
            }, async error => {
              if (this.steeringReplies.has(operationId)) await record('unknown');
              throw error;
            }).finally(() => { this.steeringReplies.delete(operationId); });
            const timeout = new Promise<never>((_resolve,reject) => { timer=setTimeout(() => reject(new Error(`Steering request got no answer within ${STEERING_TIMEOUT_MS/1000}s`)),STEERING_TIMEOUT_MS); });
            // Releasing the local observer does not cancel remote delivery. The raw reply remains tracked until it settles or physical stop is proven.
            const cancelled = new Promise<never>((_resolve,reject) => { finishObservation=()=>reject(new RevokedOperation()); });
            return Promise.race([observed,timeout,cancelled]);
          });
          return skipped(outcome);
        } catch (error) {
          this.deps.warnTaskRejection(id, error);
          await record('unknown');
          return skipped('failed',errorMessage(error));
        } finally { finishObservation?.(); clearTimeout(timer); }
      } catch (error) {
        if (operation) await record('unknown');
        throw error;
      } finally {
        if (this.steeringSessions.get(id) === taskId) this.steeringSessions.delete(id);
        this.deps.wakeResourceQueues(); this.deps.scheduleQueue(id);
      }
    }));
  }
  /** Persist the confirmation handoff before returning it; ACK later cancels only this original turn. */
  async deferTurn(id: string, expectedTaskId: string, askId: string, stop: boolean, expectedAttemptId: string) {
    return this.mutations.scoped(id, async () => {
      const { driver } = await this.deps.active(id);
      const token = this.mutations.attempts.get(id), ref = token && this.mutations.attemptRefs.get(token);
      if (!ref || ref.taskId !== expectedTaskId || ref.attemptId !== expectedAttemptId) throw new RuntimeError('TASK_NOT_ACTIVE', 'The requested task is no longer active', 409);
      const confirmation = this.deps.turnOutput(ref).confirmation;
      if (confirmation && confirmation !== askId) throw new RuntimeError('DEFERRED_CONFIRMATION_CONFLICT', 'This turn already registered a confirmation', 409);
      if (!confirmation) await this.deps.eventScope.run(ref, () => this.deps.emit(id, 'status', { state: 'confirmation_deferred', askId }, undefined, `deferred:${ref.attemptId}`));
      // Cancellation is a host handoff, with no user interrupt intent or actor.
      // Settlement still waits for the driver's actual terminal result.
      if (stop && driver && this.mutations.attempts.get(id) === token) await this.deps.driverOperation(driver, () => driver.interrupt());
    });
  }
  async confirmSteeringRecovery(id: string, raw: SteeringRecoveryDecision, actor: ExecutionActor) {
    this.deps.assertReady(); this.deps.requireRecoveryOwner(actor);
    const input = steeringRecoveryDecisionSchema.parse(raw);
    return this.mutations.run(this.mutations.owners.ownerOf(id), async () => {
      const {session} = await this.deps.active(id);
      if (session.runId !== input.runId) throw new RuntimeError('SESSION_RUN_CONFLICT', 'Session run changed', 409);
      const operation = this.deps.repos.execution.getTaskExecution(input.taskId)?.steering;
      const replay = operation?.operationId === input.operationId && operation.decisionId === input.decisionId;
      if (!replay && this.deps.recoveryInFlight(id)) throw new RuntimeError('RECOVERY_EXECUTION_ACTIVE', 'Original execution still has an in-flight owner', 409);
      const result = await this.mutations.write(id, async () => this.deps.wake(this.deps.bound().confirmSteeringRecovery(this.deps.fence(session), input, actor)));
      if (!result.replayed) {
        await clearTaskReportSafely(this.deps.repos.config, input.taskId);
        await this.deps.reopenQueue(id);
      }
      return {replayed: result.replayed, task: this.deps.publicTask(result.task!), recovery: await this.deps.inspectRecovery(id,actor)};
    });
  }

  isActive(id: string) { return this.steeringSessions.has(id); }
  activeSessions() { return this.steeringSessions.keys(); }
  pendingTask(id: string) { return this.steeringSessions.get(id); }
  awaitingReply(id: string) { return [...this.steeringReplies.values()].some(reply => reply.sessionId === id); }
  releaseDriver(driver: AgentDriver) {
    for (const [operationId, reply] of this.steeringReplies) if (reply.driver === driver) this.steeringReplies.delete(operationId);
  }
}
