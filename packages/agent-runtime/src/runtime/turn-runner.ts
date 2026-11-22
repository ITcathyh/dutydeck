import { turnSubmission } from './submission.js';
import type { DriverRegistry } from './driver-registry.js';
import type { AcceptedTaskInputV2, AgentConfig, AgentDriver, AgentEvent, AttemptFence, AttemptRef, BoundExecutionRepository, CommitResult, EventType, NormalizedDriverEvent, PromptAssemblyData, PromptSourceDiagnostics, PublicTaskRecord, RepositoryBundle, RuntimeControlClaim, Session, SessionFence, TaskAttempt, TaskRecord, ToolRiskPolicy } from '@dutydeck/shared';
import { canonicalExecutionJson, errorMessage, isTerminalTaskStatus, makeId, now, PROMPT_NOT_WRITTEN, redactCredentialText, RuntimeError } from '@dutydeck/shared';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentUnavailable } from '../agent-availability.js';
import { localOnlyDriverContext } from '../driver-context.js';
import type { RuntimeHost } from './host-ports.js';
import { type DriverConfigurationLedger, type LocalDriverLedger, nativeTargetOf, type ExecutionOptions } from '../ledger.js';
import type { RuntimeSessionMutations } from '../ownership.js';
import type { DriverSupervisor } from './driver-supervisor.js';
import type { EventIngest } from './event-ingest.js';
import type { HumanWaits } from './human-waits.js';
import type { RecoveredTurn } from './recovery-service.js';
import type { Scheduler } from './scheduler.js';

const isTaskFenceRevocation = (error: unknown): error is RuntimeError => error instanceof RuntimeError
  && (error.code === 'SESSION_AUTOMATION_TASK_REVOKED' || error.code === 'SESSION_AUTOMATION_TASK_STALE_HEAD' || error.code === 'WORK_ITEM_TASK_REVOKED');

interface TurnRunnerDependencies {
  acceptedInput: (task: TaskRecord) => AcceptedTaskInputV2;
  active: (id: string) => Promise<{ session: Session; driver: AgentDriver | undefined; }>;
  activeTasks: Map<string, TaskRecord>;
  activeTurns: Set<string>;
  agentUnavailable: Map<string, AgentUnavailable>;
  attemptFence: (ref: AttemptRef & SessionFence) => AttemptFence;
  authorize: (id: string, actorId?: string, activate?: boolean) => Promise<void>;
  bound: () => BoundExecutionRepository;
  claim(): RuntimeControlClaim | undefined;
  clearSessionTaskReports: (sessionId: string) => Promise<void>;
  configurations: DriverConfigurationLedger;
  configureAgentForSession: (agent: AgentConfig, session: Session) => Promise<AgentConfig>;
  emit: (sessionId: string, type: EventType, data: unknown, raw?: string, eventId?: string, sourceId?: string) => Promise<AgentEvent<unknown>>;
  events: EventIngest;
  exitedDriverGenerations: Map<string, number>;
  registry: DriverRegistry;
  fence: (session: Session) => SessionFence;
  flushInsightSources: (driver: AgentDriver) => void;
  humanWaits: HumanWaits;
  localResources: LocalDriverLedger;
  noteAgentFailure: (agentId: string, failure: { code?: unknown; detailCode?: unknown; message?: unknown; }) => Promise<void>;
  notifyDriverExit: (sessionId: string, code: number | null) => void;
  options: RuntimeHost;
  patchSession(id: string, patch: Partial<Session>): Promise<Session>;
  publicTask: (task: TaskRecord) => PublicTaskRecord;
  persistTerminalReceipt(session: Session, driver: AgentDriver): Promise<void>;
  repos: RepositoryBundle;
  scheduler: Scheduler;
  sessionGenerations: Map<string, number>;
  shuttingDown(): boolean;
  subscribeInsightSources(session: Session, driver: AgentDriver, generation: number, resourceId: string): void;
  supervisor: DriverSupervisor;
  turnProgressAt: Map<string, number>;
  unsubscribeInsightSources: (driver: AgentDriver) => void;
  wake: <T extends CommitResult>(result: T) => T;
  warnCaught: (location: string, sessionId: string | undefined, error: unknown) => void;
}

export class TurnRunner {
  constructor(private readonly mutations: RuntimeSessionMutations, private readonly deps: TurnRunnerDependencies) {
    this.settlement = new TurnSettlement(mutations, deps);
  }
  private readonly settlement: TurnSettlement;

  readonly taskRuns = new Set<Promise<unknown>>();
  runTask(id: string, task: TaskRecord, attempt: TaskAttempt) {
    const token = this.mutations.current()!;
    this.mutations.attemptRefs.set(token, { sessionId: id, runId: attempt.runId, taskId: task.id, attemptId: attempt.attemptId });
    this.mutations.attempts.set(id, token); this.deps.activeTasks.set(id, task); this.deps.turnProgressAt.set(id, Date.now());
    const run = this.executeTask(id, task);
    this.taskRuns.add(run);
    const cleanup = () => { this.taskRuns.delete(run); };
    void run.then(cleanup, cleanup); return run;
  }
  async executeTask(id: string, task: TaskRecord) {
    const token = this.mutations.current()!;
    const ref = this.mutations.attemptRefs.get(token)!;
    this.deps.activeTurns.add(id); this.deps.events.startTurn(ref.attemptId); this.deps.humanWaits.clearOscWait(ref.attemptId);
    let agentId: string | undefined;
    let settledSession: Session | undefined;
    let ended: Session | undefined;
    let observed: Session | undefined;
    const observeEnd = async () => {
      const session = observed;
      observed = undefined;
      // best-effort: the host hook must not block turn settlement on failure.
      if (session) {
        ended = session;
        await this.deps.options.beforeSettlement?.(session, task.id).catch(() => {});
      }
    };
    try {
      const { session } = await this.deps.active(id);
      agentId = session.agentId; settledSession = session;
      await this.deps.clearSessionTaskReports(id);
      const input = this.deps.acceptedInput(task);
      await this.deps.authorize(id, task.executionContext?.actorId, true);
      await this.mutations.wait(() => this.deps.options.policy.authorize({ phase: 'prepare', session, task }));
      const driver = await this.configureTaskDriver(session, input.executionOptions);
      await this.applyRiskPolicy(session, driver, task.executionContext?.riskPolicy);
      const assembled = await this.mutations.wait(() => Promise.resolve(this.deps.options.prompts.atExecute(session, input.executionContext.agentPrompt, input.executionContext,
        { taskId: task.id, attemptId: ref.attemptId, actorId: task.executionContext?.actorId })));
      const prompt = typeof assembled === 'string' ? assembled : assembled.prompt;
      await this.recordPrompt(id, input.executionContext.agentPrompt, 'accepted_input', 'send', task.id, undefined, input.executionContext.promptDiagnostics);
      await this.recordPrompt(id, prompt, 'session_context', 'send', task.id, undefined, typeof assembled === 'string' ? undefined : assembled.diagnostics);
      const compactHours = input.executionContext.idleCompactHours;
      const previousTasks = compactHours === undefined ? [] : await this.mutations.wait(() => this.deps.repos.tasks.listBySession(id));
      const previousActivity = Math.max(...previousTasks.filter(item => item.id !== task.id && ['completed', 'interrupted', 'failed'].includes(item.status)).map(item => Date.parse(item.updatedAt)));
      const compactDue = compactHours !== undefined && Number.isFinite(previousActivity) && Date.now() - previousActivity >= compactHours * 3_600_000;
      const compact = async (submission?: import('@dutydeck/shared').DriverSubmission) => {
        if (!compactDue) return true;
        const cancellationVersion = this.deps.events.compactionVersion(id);
        const outcome = this.deps.registry.supports(driver, 'compact') ? await driver.compact(submission) : 'unsupported';
        if (!this.deps.registry.supports(driver, 'compact')) await this.deps.emit(id, 'status', { state: 'compaction', phase: 'unsupported', proactive: true });
        this.mutations.check();
        const interrupted = this.deps.bound().getPendingQueueActions(this.deps.fence(session)).some(action => action.interrupt && action.target?.attemptId === ref.attemptId);
        if (outcome === 'cancelled' || interrupted) {
          // Built-in drivers emit cancelled themselves; a custom driver may only
          // return it. Fill in exactly when this maintenance emitted no event.
          if (this.deps.events.compactionVersion(id) === cancellationVersion) {
            await this.deps.emit(id, 'status', { state: 'compaction', phase: 'cancelled', proactive: true });
          }
          // The maintenance stream is quiescent; finish the logical task without submitting its user prompt.
          await this.deps.events.consume(session, { type: 'completed', data: { stopReason: 'cancelled' } }, makeId('evt'));
          return false;
        }
        return true;
      };
      const submissionId = makeId('submission');
      const submissionInput=Object.freeze({taskId:ref.taskId,attemptId:ref.attemptId,submissionId,prompt,executionOptions:Object.freeze({...input.executionOptions})});
      const submission = turnSubmission(this.deps.localResources, driver, submissionInput, key => this.deps.registry.supports(driver, key));
      const run = (operation: () => Promise<void>) => this.deps.supervisor.driverOperation(driver, operation);
      if (submission.prepare) await submission.prepare(() => this.mutations.valid(token), run);
      await this.deps.authorize(id, task.executionContext?.actorId, true);
      await this.mutations.wait(() => this.deps.options.policy.authorize({ phase: 'submit', session, task }));
      const beforeSubmit = this.deps.repos.execution.getAttempt(ref);
      if (!beforeSubmit || beforeSubmit.state !== 'preparing' || beforeSubmit.submissionState !== 'not_submitted') {
        throw new RuntimeError('ATTEMPT_NOT_PREPARING', 'The attempt was cancelled or changed while awaiting submission authorization', 409);
      }
      if (this.deps.options.events.observed || this.deps.options.beforeSettlement) {
        // best-effort: host observation is independent of submission.
        await this.mutations.wait(() => this.deps.options.events.publish({ type: 'turn.started', session, taskId: task.id }).catch(() => {}));
        observed = session;
      }
      await this.deps.events.flushDriverEvents(id);
      await this.deps.emit(id, 'text', { text: task.prompt, role: 'user', taskId: task.id });
      this.mutations.check();
      await this.mutations.write(id, async () => {
        await this.deps.configurations.assertClear(id); this.mutations.check();
        const intent = await submission.freeze(() => this.mutations.check());
        this.mutations.check();
        if (this.deps.supervisor.drivers.get(id) !== driver || this.deps.exitedDriverGenerations.get(id) === this.deps.sessionGenerations.get(id)) throw new RuntimeError('DRIVER_EXITED_BEFORE_SUBMISSION', 'Agent exited before submission; input was not sent', 409);
        this.deps.wake(this.deps.bound().markSubmissionPending(this.deps.attemptFence(ref), intent));
      });
      await submission.send(run, compact, receipt => {
        this.deps.wake(this.deps.bound().markSubmitted(this.deps.attemptFence(ref), receipt));
      });
      const result = await this.settlement.driverResult(ref, submissionId, { capacityRetry: 'if_safe', observeEnd });
      if (result.status === 'completed') this.deps.agentUnavailable.delete(session.agentId);
    } catch (error) {
      if (agentId) await this.deps.noteAgentFailure(agentId, { message: errorMessage(error), code: (error as { code?: unknown } | undefined)?.code });
      // Stop owns revoked attempts and retains its claim until this cleanup finishes.
      if (this.mutations.valid(token)) {
        const exitDriver = this.deps.supervisor.drivers.get(id), exitSource = this.deps.registry.method(exitDriver, 'drainExitedOutput')?.();
        const exitDrain = exitDriver && exitSource ? this.deps.events.settleExitedDriver(id, exitDriver, exitSource) : undefined;
        if (!exitDrain) await this.deps.events.flushDriverEvents(id).catch(failure => this.deps.warnCaught('executeTask.flushDriverEvents', id, failure));
        this.deps.events.markEventsFlushed(ref.attemptId);
        await observeEnd();
        await (exitDrain ?? this.deps.events.settleExitedDriver(id, this.deps.supervisor.drivers.get(id)));
        // 提交前失败时 Agent 没产生任何事件，原因只记在结算上；先补一条错误事件，结果卡和 Web 才写得出为什么失败。
        const unsubmitted = this.deps.repos.execution.getTaskExecution(task.id)?.attempts.find(item => item.attemptId === ref.attemptId);
        const failureCode = (error as { code?: unknown } | undefined)?.code;
        this.deps.options.log?.warn({ sessionId: id, taskId: task.id, attemptId: ref.attemptId,
          submissionState: unsubmitted?.submissionState, error: redactCredentialText(errorMessage(error)),
          ...(error instanceof Error && error.stack ? { stack: redactCredentialText(error.stack) } : {}),
          ...(typeof failureCode === 'string' && /^[A-Z0-9_]+$/.test(failureCode) ? { code: failureCode } : {}),
        }, 'Agent task execution failed');
        // 驱动确认 prompt 没写入（PROMPT_NOT_WRITTEN）时，记过的提交意图不算提交：同样按未提交、可重试结算。
        const notWritten = failureCode === PROMPT_NOT_WRITTEN;
        if (unsubmitted && unsubmitted.state !== 'settled' && (unsubmitted.submissionState === 'not_submitted' || notWritten && unsubmitted.submissionState === 'intent_recorded') && !isTaskFenceRevocation(error)) {
          await this.deps.emit(id, 'error', { message: errorMessage(error) }).catch(failure => this.deps.warnCaught('executeTask.publishFailure', id, failure));
        }
        await this.mutations.write(id, async () => {
          const attempt = this.deps.repos.execution.getTaskExecution(task.id)?.attempts.find(item => item.attemptId === ref.attemptId);
          if (!attempt || attempt.state === 'settled') return;
          if (attempt.submissionState === 'not_submitted') this.deps.wake(this.deps.bound().settleAttempt(this.deps.attemptFence(ref), `preparation:${ref.attemptId}`, { kind: 'not_submitted', outcome: isTaskFenceRevocation(error) ? 'cancelled' : 'failed', reason: errorMessage(error) }));
          else if (notWritten && attempt.submissionState === 'intent_recorded' && attempt.submission) this.deps.wake(this.deps.bound().settleAttempt(this.deps.attemptFence(ref), `preparation:${ref.attemptId}`, { kind: 'not_submitted', outcome: 'failed', reason: errorMessage(error), submissionId: attempt.submission.submissionId }));
          else this.deps.wake(this.deps.bound().markReconcileRequired(this.deps.attemptFence(ref), { reasonId: `unknown:${ref.attemptId}`, code: error instanceof RuntimeError || error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? String(error.code) : 'DRIVER_RESULT_UNKNOWN', evidenceRefs: [] }));
        });
      }
    } finally {
      await this.settlement.release(ref, 'ordinary');
    }
    if (ended) await this.deps.options.events.publish({ type: 'turn.ended', session: ended, taskId: task.id }).catch(() => {});
    return this.settlement.taskResult(task, settledSession);
  }
  async runRecoveredTurn({ session, task, attempt, submission, recovery, resource, agent, options }: RecoveredTurn): Promise<boolean> {
    const lifecycle = this.mutations.owners.lifecycle(session.id), token = this.mutations.turnOwner(session.id);
    const ref = { sessionId: session.id, runId: attempt.runId, taskId: task.id, attemptId: attempt.attemptId };
    const generation = this.deps.supervisor.nextSessionGeneration(session.id);
    const buffered: NormalizedDriverEvent[] = [];
    let attached = false;
    const emit = this.deps.events.onDriverEvent(session, generation);
    const driver = this.deps.registry.create({ ...await this.deps.configureAgentForSession(agent, session), ...options }, session,
      event => { if (attached) emit(event); else buffered.push(event); },
      code => {
        if (!attached || !this.mutations.valid(lifecycle) || this.deps.sessionGenerations.get(session.id) !== generation) return;
        this.deps.exitedDriverGenerations.set(session.id, generation);
        this.deps.notifyDriverExit(session.id, code);
      },
      localOnlyDriverContext(this.deps.fence(session), resource.resourceId));
    if (!this.deps.registry.supports(driver, 'recover')) return false;
    // attach/recover 前订阅；未采纳（!attached）时在 finally 取消。
    // local-only anchor 是子资源行 id（= resource.resourceId），不是 identity.identityId。
    this.mutations.run(token, () => this.deps.subscribeInsightSources(session, driver, generation, resource.resourceId));
    let notifyAttached!: () => void;
    const ready = new Promise<void>(resolve => { notifyAttached = resolve; });
    let settledHere = false;
    const running = this.mutations.run(token, async () => {
      try {
        await this.applyRiskPolicy(session, driver, task.executionContext?.riskPolicy);
        await this.deps.supervisor.driverOperation(driver, () => driver.recover!(recovery, async () => {
          await this.mutations.write(session.id, async () => {
            const original = this.deps.repos.execution.getResources(session.id).find(row => row.resourceId === resource.resourceId)!;
            const observed = this.deps.bound().observed(this.deps.fence(session), original.resourceId, original.revision, {
              observationId: makeId('observation'), identityId: resource.identity!.identityId,
              state: 'live', observedAt: now(), evidenceRef: `pty-turn:${recovery.turnId}`,
            });
            this.deps.wake(this.deps.bound().recoverAttempt(this.deps.attemptFence(attempt), {
              kind: 'original_turn', decisionId: `attach:${attempt.attemptId}:${this.deps.claim()!.generation}`,
              submissionId: submission.submissionId, recovery, attached: true,
              resources: [{ resourceId: observed.resourceId, expectedRevision: observed.revision, observationId: observed.observations.at(-1)!.observationId }],
            }));
            this.deps.localResources.adopt(this.deps.fence(session), options, observed, driver);
            this.deps.supervisor.adopt(session.id, driver);
            task.status = 'running';
            this.mutations.attemptRefs.set(token, ref); this.mutations.attempts.set(session.id, token); this.deps.activeTasks.set(session.id, task);
            this.deps.activeTurns.add(session.id); this.deps.turnProgressAt.set(session.id, Date.now());
            this.deps.events.restoreAttemptTools(attempt.attemptId);
            attached = true;
            for (const event of buffered.splice(0)) emit(event);
            notifyAttached();
          });
        }));
        if (!attached) return;
        // recover 采纳提交后（资源 live、driver 已入 this.deps.supervisor.drivers）flush 启动期 pending 观察。
        this.deps.flushInsightSources(driver);
        await this.settlement.driverResult(ref, submission.submissionId, { capacityRetry: 'disabled_after_recovery' });
        settledHere = true;
      } catch (error) {
        if (attached && this.mutations.valid(token)) await this.mutations.write(session.id, async () => this.deps.wake(this.deps.bound().markReconcileRequired(this.deps.attemptFence(ref), {
          reasonId: `recovery_failed:${attempt.attemptId}:${this.deps.claim()!.generation}`, code: 'DRIVER_RECOVERY_UNKNOWN', evidenceRefs: [],
        })));
        if (!attached && this.mutations.valid(token)) await this.deps.emit(session.id, 'error', { code: 'PTY_RECOVERY_DEFERRED', taskId: task.id,
          message: 'Original PTY identity or transcript could not be verified; the submitted task remains unresolved' });
        // Failed handshake cleanup detaches its temporary capture and never kills the original pane.
      } finally {
        // 未采纳的临时 driver 不进 this.deps.supervisor.drivers，其来源订阅在此取消，杜绝迟到回调。
        if (!attached) this.deps.unsubscribeInsightSources(driver);
        await this.settlement.release(ref, 'recovered');
        if (attached && !this.deps.shuttingDown()) await this.mutations.scoped(session.id, async () => {
          await this.deps.scheduler.projectQueue(session.id); this.deps.scheduler.unblockQueue(session.id); this.deps.scheduler.scheduleQueue(session.id);
        });
      }
      // Only the run that durably settled this attempt notifies; stop, failed handshakes and later restarts do not.
      if (settledHere) this.settlement.taskResult(task, session);
    });
    this.taskRuns.add(running);
    void running.finally(() => this.taskRuns.delete(running)).catch(error => this.deps.warnCaught('recoverPersistentTurn', session.id, error));
    await Promise.race([ready, running]);
    return attached;
  }
  private async configureTaskDriver(session: Session, options: ExecutionOptions) {
    await this.mutations.wait(() => this.deps.configurations.assertClear(session.id));
    let existing = this.deps.supervisor.drivers.get(session.id);
    if (this.deps.registry.capabilities(session.protocol)?.persistentTerminal && !['ask', 'full-trust'].includes(options.permissionMode)) {
      // deny-all 只作任务级选项（先出计划）出现，由 Claude 家族终端的 PreToolUse 守卫拦写操作。
      const agent = ['approve-reads', 'deny-all'].includes(options.permissionMode) ? await this.deps.repos.agents.get(session.agentId) : undefined;
      if (!agent || !this.deps.registry.capabilities(session.protocol, agent)?.remoteApproval) throw new RuntimeError('PERMISSION_MODE_UNSUPPORTED', 'PTY CLI cannot enforce the requested permission mode', 422);
    }
    if (existing && this.deps.exitedDriverGenerations.get(session.id) === this.deps.sessionGenerations.get(session.id)) {
      // Only an unsubmitted Attempt reaches here. Retain the normal physical
      // exit proof and native recovery checks before constructing its replacement.
      await this.deps.supervisor.stopDriver(session.id, existing);
      this.mutations.check(); existing = undefined;
    }
    if (!existing) return this.deps.supervisor.reconnect(session, true, options);
    const owned=this.deps.localResources.get(existing);
    if(owned?.controlled&&owned.options.permissionMode!==options.permissionMode){await this.deps.supervisor.stopDriver(session.id,existing);this.mutations.check();return this.deps.supervisor.reconnect(session,true,options);}
    await this.deps.events.flushDriverEvents(session.id);
    await this.changeDriverConfiguration(session, existing, () => options);
    return existing;
  }
  async applyRiskPolicy(session: Session, driver: AgentDriver | undefined, policy?: ToolRiskPolicy) {
    if (this.deps.options.policy.riskPolicy) policy = await this.mutations.wait(() => this.deps.options.policy.riskPolicy!(session.id, policy));
    this.mutations.check();
    await this.mutations.write(session.id, async () => { this.deps.registry.method(driver, 'setRiskPolicy')?.(policy); });
    const directory = join(session.cwd, '.dutydeck', 'security', 'sessions');
    await this.mutations.wait(() => mkdir(directory, { recursive: true }));
    await this.mutations.write(session.id, async () => {
      // Hooks read this file concurrently: never expose a partial write, and replace a symlink rather than follow it.
      const target = join(directory, `${session.id}.json`);
      const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(policy ?? { enabled: false }), { mode: 0o600, flag: 'wx' });
        await rename(temp, target);
      } catch (error) {
        // best-effort: the temporary file may already be gone.
        await unlink(temp).catch(() => {}); throw error;
      }
    });
  }
  async changeDriverConfiguration(session: Session, driver: AgentDriver, targetOptions: (current: ExecutionOptions) => ExecutionOptions, defaults?: Partial<ExecutionOptions>, forceNativeProof=false) {
    const token = this.mutations.current();
    const owned = this.deps.localResources.get(driver);
    if (!owned) throw new RuntimeError('DRIVER_RESOURCE_MISSING', 'The existing driver has no resource owner', 409);
    const operation = await this.mutations.write(session.id, async () => {
      await this.deps.configurations.assertClear(session.id); this.mutations.check();
      if (this.deps.supervisor.drivers.get(session.id) !== driver || this.mutations.attempts.has(session.id) && this.mutations.attempts.get(session.id) !== token) throw new RuntimeError('TURN_IN_PROGRESS', 'Another Attempt owns this driver', 409);
      if (this.deps.supervisor.driverOperations.get(driver)?.size || this.deps.humanWaits.pendingPermissionCount(session.id)) throw new RuntimeError('DRIVER_CONFIGURATION_BUSY', 'A previous driver operation has not finished', 409);
      const target = targetOptions(owned.options);
      if (canonicalExecutionJson(owned.options) === canonicalExecutionJson(target)&&!forceNativeProof) {
        if (defaults) Object.assign(session, await this.deps.patchSession(session.id, defaults));
        return undefined;
      }
      if (owned.options.permissionMode !== target.permissionMode && !this.deps.registry.supports(driver, 'setPermissionMode') || !this.deps.registry.supports(driver, 'configureNative') && (owned.options.model !== target.model && (!target.model || !this.deps.registry.supports(driver, 'setModel'))
        || owned.options.reasoningEffort !== target.reasoningEffort && (!target.reasoningEffort || !this.deps.registry.supports(driver, 'setReasoningEffort')))) throw new RuntimeError('TASK_OPTIONS_UNSUPPORTED', 'This driver cannot prove a context-preserving configuration reset before submission', 422);
      return this.deps.configurations.begin(session.id, owned.identityId, target);
    });
    if (!operation) return;
    const changing = (async () => {
      // 驱动在第一次写入前明确拒绝（CONFIGURATION_REJECTED）时原生配置没动，清掉这次意图即可；之后的任何失败都说不准，保留 unknown。
      let applied = false;
      try {
        this.mutations.check(token);
        const target = operation.target;
        if (owned.options.permissionMode !== target.permissionMode) { applied = true; driver.setPermissionMode!(target.permissionMode); }
        if(owned.controlled&&this.deps.registry.supports(driver, 'configureNative')) {
          const nativeTarget=nativeTargetOf(target);
          const proof=await driver.configureNative({operationId:operation.operationId,target:nativeTarget});
          const selected=this.deps.repos.execution.getNativeContext(session.id);
          if(!selected||proof.operationId!==operation.operationId||proof.driverInstanceId!==owned.controlled.driverInstanceId||canonicalExecutionJson(proof.context)!==canonicalExecutionJson(selected.selection.context)||canonicalExecutionJson(proof.target)!==canonicalExecutionJson(nativeTarget))throw new RuntimeError('DRIVER_CONFIGURATION_UNKNOWN','Configuration ACK does not identify the original operation and target',409);
        } else {
          if (owned.options.model !== target.model) { await driver.setModel!(target.model!); applied = true; }
          this.mutations.check(token);
          if (owned.options.reasoningEffort !== target.reasoningEffort) await driver.setReasoningEffort!(target.reasoningEffort!);
        }
        applied = true;
        await this.mutations.write(session.id, async () => {
          this.mutations.check(token);
          if (this.deps.supervisor.drivers.get(session.id) !== driver || this.deps.localResources.get(driver)?.identityId !== operation.driverIdentity) throw new RuntimeError('DRIVER_CONFIGURATION_UNKNOWN', 'Original driver identity changed during configuration', 409);
          // Keep pending durable until defaults and the exact confirmed in-memory options agree.
          if (defaults) Object.assign(session, await this.deps.patchSession(session.id, defaults));
          owned.options = { ...target };
          await this.deps.configurations.finish(operation, true);
          await this.deps.persistTerminalReceipt(session, driver);
        });
      } catch (error) {
        const rejected = !applied && (error as { code?: unknown } | null)?.code === 'CONFIGURATION_REJECTED';
        await this.mutations.run(undefined, () => this.mutations.write(session.id, () => this.deps.configurations.finish(operation, rejected)));
        throw error;
      }
    })();
    await this.deps.supervisor.observeDriverOperation(driver, changing);
  }
  async recordPrompt(sessionId: string, prompt: string, stage: 'accepted_input' | 'session_context', mode: 'send' | 'steer', inputTaskId: string, operationId?: string, sources?: PromptSourceDiagnostics) {
    const data: PromptAssemblyData = {
      state: 'prompt_assembly', version: 1, stage,
      source: stage === 'accepted_input' ? 'execution_context.agent_prompt' : 'runtime.session_prompt',
      mode, phase: 'prepared', chars: prompt.length, charUnit: 'utf16_code_units',
      sha256: createHash('sha256').update(prompt, 'utf8').digest('hex'), inputTaskId,
      ...(operationId ? { operationId } : {}), ...(sources ? { sources } : {})
    };
    // best-effort: prompt assembly is diagnostic.
    await this.deps.emit(sessionId, 'status', data).catch(() => {});
  }
}

type DriverResultPolicy =
  | { capacityRetry: 'if_safe'; observeEnd: () => Promise<void> }
  | { capacityRetry: 'disabled_after_recovery' };

class TurnSettlement {
  constructor(private readonly mutations: RuntimeSessionMutations, private readonly deps: TurnRunnerDependencies) {}

  async driverResult(ref: AttemptRef & SessionFence, submissionId: string, policy: DriverResultPolicy) {
    await this.deps.events.flushDriverEvents(ref.sessionId);
    if ('observeEnd' in policy) {
      this.deps.events.markEventsFlushed(ref.attemptId);
      // Result cards read the diff as soon as settlement publishes the terminal event.
      await this.mutations.wait(policy.observeEnd);
    }
    if (!this.deps.events.hasCompleted(ref.attemptId)) {
      const message = 'observeEnd' in policy ? 'Driver returned without a completed result' : 'Recovered turn has no completed result';
      throw new RuntimeError('DRIVER_RESULT_INCOMPLETE', message, 409);
    }
    await this.deps.humanWaits.closeTurnPermissions(ref);
    const result = this.deps.events.turnOutput(ref);
    await this.mutations.write(ref.sessionId, async () => {
      const evidence = { kind: 'driver_result' as const, submissionId, outcome: result.status, outputDigest: result.outputDigest, stopReason: result.stopReason, complete: true as const };
      if (policy.capacityRetry === 'if_safe' && result.status === 'failed') {
        try { this.deps.wake(this.deps.bound().settleCapacityRetry(this.deps.attemptFence(ref), `settlement:${submissionId}`, evidence)); return; }
        catch (error) { if (!(error instanceof RuntimeError) || !['CAPACITY_RETRY_NOT_SAFE', 'CAPACITY_RETRY_SUPERSEDED'].includes(error.code)) throw error; }
      }
      this.deps.wake(this.deps.bound().settleAttempt(this.deps.attemptFence(ref), `settlement:${submissionId}`, evidence));
    });
    return result;
  }

  async release(ref: AttemptRef & SessionFence, path: 'ordinary' | 'recovered') {
    const id = ref.sessionId, token = this.mutations.current()!;
    if (this.mutations.attempts.get(id) === token) {
      this.mutations.attempts.delete(id);
      this.deps.activeTasks.delete(id);
      this.deps.activeTurns.delete(id);
      if (path === 'ordinary') {
        token.revoke({ code: 'attempt_finished', by: 'DutydeckRuntime.executeTask' });
        this.deps.supervisor.touch(id);
      }
    }
    if (path === 'recovered') token.revoke({ code: 'recovery_finished', by: 'DutydeckRuntime.recoverPersistentTurn' });
    this.deps.events.forgetTurn(ref.attemptId);
    this.deps.humanWaits.clearOscWait(ref.attemptId);
    try { await this.deps.humanWaits.dropAttemptPermissions(ref.attemptId); }
    finally { this.deps.scheduler.wakeResourceQueues(); }
  }

  taskResult(task: TaskRecord, session?: Session): PublicTaskRecord {
    const settled = this.deps.publicTask(this.deps.repos.execution.getTaskExecution(task.id)?.task ?? task);
    if (session && this.deps.options.events.observed && isTerminalTaskStatus(settled.status)) {
      // best-effort: notification follows durable task settlement.
      void Promise.resolve().then(() => this.deps.options.events.publish({ type: 'task.settled', session, task: settled })).catch(() => {});
    }
    return settled;
  }
}
