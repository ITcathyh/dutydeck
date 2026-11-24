import type { DriverRegistry } from './driver-registry.js';
import type { AgentConfig, AgentDriver, AgentEvent, DriverResource, NormalizedDriverEvent, AttemptFence, AttemptRef, BoundExecutionRepository, CommitResult, ExecutionActor, ExecutionBlocker, ExecutionRecoveryDecision, PtyRetirementRecovery, PublicTaskRecord, RepositoryBundle, ResourceCheckRef, RuntimeControlClaim, Session, SessionFence, TaskAttempt, TaskExecutionProjection, TaskRecord, UnknownTaskFacts, UnknownTaskResolution } from '@dutydeck/shared';
import { RuntimeError, canonicalExecutionJson, clearTaskReportSafely, errorMessage, executionActorSchema, executionRecoveryDecisionSchema, makeId, now, ptyRetirementRecoverySchema, runtimeStateKeys, unknownTaskResolutionSchema } from '@dutydeck/shared';
import type { HumanWaits } from './human-waits.js';
import type { WorkspaceManager } from '../workspace.js';
import { localOnlyDriverContext } from '../driver-context.js';
import type { NativeContextIdentity } from '@dutydeck/shared';
import type { RuntimeHost } from './host-ports.js';
import { digest, executionOptionsOf, nativeTargetOf, type DriverConfigurationLedger, type ExecutionOptions, type LocalDriverLedger } from '../ledger.js';
import { RevokedOperation, type RevocationReason, type RuntimeSessionMutations } from '../ownership.js';
import type { SessionGate } from '../session-gate.js';

/** Validated durable evidence and driver configuration for reattaching an original turn. */
export interface RecoveredTurn {
  session: Session;
  task: TaskRecord;
  attempt: TaskAttempt;
  submission: NonNullable<TaskAttempt['submission']>;
  recovery: NonNullable<NonNullable<TaskAttempt['submission']>['recovery']>;
  resource: DriverResource;
  agent: AgentConfig;
  options: ExecutionOptions;
}

interface RecoveryDependencies {
  registry: DriverRegistry;
  workspaces: Pick<WorkspaceManager, 'get' | 'validate'>;
  humanWaits: Pick<HumanWaits, 'pendingPermissionCount'>;
  sessionGenerations: ReadonlyMap<string, number>;
  attachedTerminals: WeakSet<AgentDriver>;
  hasDrain(id: string): boolean;
  hasActiveTurn(id: string): boolean;
  onDriverEvent(session: Session, generation: number): (event: NormalizedDriverEvent) => void;
  subscribeInsightSources(session: Session, driver: AgentDriver, generation: number, resourceId: string): void;
  flushInsightSources(driver: AgentDriver): void;
  unsubscribeInsightSources(driver: AgentDriver): void;
  acceptedOptions(task: TaskRecord): ExecutionOptions;
  runRecoveredTurn(turn: RecoveredTurn): Promise<boolean>;
  repos: Pick<RepositoryBundle, 'sessions' | 'tasks' | 'execution' | 'config' | 'agents' | 'control'>;
  options: Pick<RuntimeHost, 'log' | 'launch' | 'policy'>;
  localResources: LocalDriverLedger;
  configurations: DriverConfigurationLedger;
  gate: SessionGate;
  adoptDriver(id: string, driver: AgentDriver): void;
  clearRecoveredStop(id: string): void;
  drivers: ReadonlyMap<string, AgentDriver>;
  queueBlocked: ReadonlySet<string>;
  runtimeInstanceId: string;
  claim(): RuntimeControlClaim | undefined;
  driverRetiring(id: string): boolean;
  active(id: string): Promise<{session: Session; driver?: AgentDriver}>;
  assertReady(): void;
  assertReplaceable(id: string): void;
  assertResources(id: string, reuse?: boolean): void;
  resourceBlockers(id: string, reuse?: boolean): ExecutionBlocker[];
  idleResourceChecks(): ResourceCheckRef[];
  recoveryInFlight(id: string): boolean;
  bound(): BoundExecutionRepository;
  wake<T extends CommitResult>(result: T): T;
  fence(session: Session): SessionFence;
  attemptFence(ref: AttemptRef & SessionFence): AttemptFence;
  publicTask(task: TaskRecord): PublicTaskRecord;
  emit(id: string, type: 'error' | 'status', data: unknown): Promise<AgentEvent>;
  wakeResourceQueues(): void;
  loadStopBlock(id: string): Promise<void>;
  retainStopBlock(id: string, reason: string): Promise<void>;
  reopenQueue(id: string): Promise<void>;
  nextSessionGeneration(id: string): number;
  notifyDriverExit(id: string, code: number | null): void;
  stopDriver(id: string, driver: AgentDriver): Promise<void>;
  revokeSession(id: string, reason: RevocationReason, cancelQueue: boolean, state: 'stopped'): Promise<void>;
  authorize(id: string, actorId?: string, activate?: boolean): Promise<void>;
  configureAgentForSession(agent: AgentConfig, session: Session): Promise<AgentConfig>;
  saveState(session: Session, state: Session['state']): Promise<void>;
  reconnect(session: Session, start: boolean, target: ExecutionOptions, repairConfiguration: boolean): Promise<AgentDriver>;
  driverOperation<T>(driver: AgentDriver, operation: () => Promise<T>): Promise<T>;
  patchSession(id: string, patch: Partial<Session>): Promise<Session>;
  warnCaught(location: string, sessionId: string, error: unknown): void;
}

export class RecoveryService {
  private readonly ptyRetirements = new Set<string>();

  constructor(private readonly mutations: RuntimeSessionMutations, private readonly deps: RecoveryDependencies) {}

  reservePtyRetirement(id: string) { this.ptyRetirements.add(id); }
  isRetiringPty(id: string) { return this.ptyRetirements.has(id); }

  async persistTerminalReceipt(session: Session, driver: AgentDriver): Promise<void> {
    if (!['herdr', 'tmux'].includes(session.terminalBackend ?? '')) return;
    const identity = await this.deps.registry.method(driver, 'persistentTerminalIdentity')?.(), record = this.deps.localResources.get(driver);
    const resource = record && this.deps.repos.execution.getResources(session.id).find(row => row.resourceId === record.resourceId);
    if (identity === undefined || !record?.creationSettled || record.controlled || resource?.stage !== 'created'
      || resource.identity?.identityId !== record.identityId) return;
    await this.deps.repos.config.set(runtimeStateKeys.idleTerminal.key(session.id), canonicalExecutionJson({ runId: session.runId,
      resourceId: resource.resourceId, identityId: record.identityId, options: record.options, identity }));
  }
  private async restoreIdlePersistentTerminal(session: Session): Promise<boolean> {
    if (!['herdr', 'tmux'].includes(session.terminalBackend ?? '') || !this.deps.registry.capabilities(session.protocol)?.persistentTerminal || session.archivedAt
      || !['idle', 'completed', 'interrupted'].includes(session.state) || this.deps.gate.stops.block(session.id) || this.deps.drivers.has(session.id)
      || this.deps.repos.execution.getUnresolvedTasks(session.id).length) return false;
    const raw = await this.mutations.wait(() => this.deps.repos.config.get(runtimeStateKeys.idleTerminal.key(session.id)));
    if (!raw) return false;
    let receipt: ReturnType<typeof runtimeStateKeys.idleTerminal.read>;
    try { receipt = runtimeStateKeys.idleTerminal.read(raw); } catch { return false; }
    const resource = this.deps.repos.execution.getResources(session.id).find(row => row.resourceId === receipt.resourceId);
    if (receipt.runId !== session.runId || !resource || resource.kind !== 'local_only' || resource.stage !== 'created'
      || resource.runId !== session.runId || resource.identity?.identityId !== receipt.identityId || resource.observations.at(-1)?.state === 'gone'
      || this.deps.resourceBlockers(session.id).some(block => block.code !== 'DRIVER_RESOURCE_UNSAFE' || block.resourceId !== resource.resourceId)) return false;
    const agent = await this.mutations.wait(() => this.deps.repos.agents.get(session.agentId)); if (!agent) return false;
    let driver: AgentDriver | undefined, generation: number | undefined;
    let attached = false;
    try {
      const configured = await this.deps.configureAgentForSession(agent, session);
      const options: ExecutionOptions = executionOptionsOf(configured);
      if (canonicalExecutionJson(receipt.options) !== canonicalExecutionJson(options)) return false;
      const workspace = await this.mutations.wait(() => this.deps.workspaces.get(session.id));
      if (workspace) await this.mutations.wait(() => this.deps.workspaces.validate(workspace));
      generation = this.deps.nextSessionGeneration(session.id); const lifecycle = this.mutations.owners.lifecycle(session.id);
      driver = this.deps.registry.create(configured, session, this.deps.onDriverEvent(session, generation),
        code => { if (this.mutations.valid(lifecycle) && this.deps.sessionGenerations.get(session.id) === generation) this.deps.notifyDriverExit(session.id, code); },
        localOnlyDriverContext(this.deps.fence(session), resource.resourceId));
      // attach 前订阅；attach 失败 / 未采纳时由 finally 取消。
      // local-only anchor 是子资源行 id（= resource.resourceId），不是 identity.identityId。
      this.mutations.run(lifecycle, () => this.deps.subscribeInsightSources(session, driver!, generation!, resource.resourceId));
      attached = await this.deps.driverOperation(driver, () => Promise.resolve(this.deps.registry.method(driver, 'attachTerminal')?.(receipt.identity) ?? false));
      if (!attached) return false;
      this.mutations.check();
      await this.mutations.write(session.id, async () => {
        const current = this.deps.repos.execution.getResources(session.id).find(row => row.resourceId === resource.resourceId);
        if (!current || current.revision !== resource.revision || current.identity?.identityId !== receipt.identityId) throw new RuntimeError('RESOURCE_IDENTITY_CONFLICT', 'Original idle terminal resource changed', 409);
        const observation = { observationId: makeId('observation'), identityId: current.identity?.identityId,
          state: 'live' as const, observedAt: now(), evidenceRef: `idle-terminal:${digest(receipt)}` };
        if (session.terminalBackend === 'tmux' && (this.deps.registry.method(driver, 'isIdle')?.() !== true || this.deps.registry.method(driver, 'hasBackgroundWork')?.() !== false || this.deps.humanWaits.pendingPermissionCount(session.id))) {
          throw new RuntimeError('IDLE_TERMINAL_ADOPTION_UNSAFE', 'Original tmux terminal is no longer idle', 409);
        }
        const observed = session.terminalBackend === 'tmux'
          ? this.deps.bound().adoptIdleTmux(this.deps.fence(session), resource.resourceId, resource.revision, raw, observation)
          : this.deps.bound().observed(this.deps.fence(session), resource.resourceId, resource.revision, observation);
        this.deps.localResources.adopt(this.deps.fence(session), options, observed, driver!);
        this.deps.adoptDriver(session.id, driver!); this.deps.attachedTerminals.add(driver!);
      });
      // attach 采纳提交后 flush 启动期 pending 观察。
      this.deps.flushInsightSources(driver);
      return true;
    } catch (error) {
      // 工作目录不见了由外层按会话跳过；其余失败只推迟这个终端，资源保持阻塞，不能让整个实例起不来。
      if (error instanceof RevokedOperation || error instanceof RuntimeError && error.code === 'WORKSPACE_UNAVAILABLE') throw error;
      this.deps.options.log?.warn({ sessionId: session.id, code: error instanceof RuntimeError ? error.code : 'TERMINAL_RECOVERY_FAILED', error }, 'Idle terminal recovery deferred');
      await this.deps.emit(session.id, 'status', { state: 'terminal_recovery_deferred', message: 'Original idle terminal identity could not be verified; resource remains blocked' })
        .catch(emitError => { if (emitError instanceof RevokedOperation) throw emitError; });
      return false;
    } finally {
      if (driver && this.deps.drivers.get(session.id) !== driver) {
        this.deps.unsubscribeInsightSources(driver);
        // 未采纳的临时 driver 不代表会话；放不掉时，它迟到的事件和退出回调也不能记到会话上。
        if (this.deps.sessionGenerations.get(session.id) === generation) this.deps.nextSessionGeneration(session.id);
        try { await this.deps.registry.method(driver, 'prepareForDaemonShutdown')?.(true); await driver.stop(); }
        catch (error) { this.deps.options.log?.warn({ sessionId: session.id, error }, 'Unadopted idle terminal driver could not be released; resource remains blocked'); }
      }
    }
  }

  private async recoverPersistentTurn(session: Session, task: TaskRecord): Promise<boolean> {
    const attempt = this.deps.repos.execution.getTaskExecution(task.id)?.currentAttempt;
    const submission = attempt?.submission, recovery = submission?.recovery;
    if (!this.deps.registry.capabilities(session.protocol)?.persistentTerminal || !attempt || !submission || !recovery || task.interruptedByActor
      || !['active', 'reconcile_required'].includes(attempt.state)
      || attempt.reconcileReason && !['PREVIOUS_RUNTIME_RESULT_UNKNOWN', 'DAEMON_SHUTDOWN'].includes(attempt.reconcileReason.code)
      || this.deps.gate.stops.block(session.id) || this.deps.drivers.has(session.id)
      || this.deps.bound().getPendingQueueActions(this.deps.fence(session)).some(action => action.target?.attemptId === attempt.attemptId)) return false;
    const resource = this.recoverableResource(session.id, session.runId, submission.resourceRefs);
    if (!resource) return false;
    const agent = await this.mutations.wait(() => this.deps.repos.agents.get(session.agentId));
    if (!agent) return false;
    const workspace = await this.mutations.wait(() => this.deps.workspaces.get(session.id));
    if (workspace) await this.mutations.wait(() => this.deps.workspaces.validate(workspace));
    const options = this.deps.acceptedOptions(task);
    await this.deps.authorize(session.id, task.executionContext?.actorId, true);
    await this.mutations.wait(() => this.deps.options.policy.authorize({ phase: 'prepare', session, task }));
    return this.deps.runRecoveredTurn({ session, task, attempt, submission, recovery, resource, agent, options });
  }

  inspectAgentQuiescence(id: string): 'idle' | 'busy' | 'unknown' {
    if (this.mutations.attempts.get(id) || this.deps.hasActiveTurn(id) || this.deps.hasDrain(id)) return 'busy';
    const driver = this.deps.drivers.get(id);
    if (driver) return !this.deps.registry.method(driver, 'isDetachedForShutdown')?.() && this.deps.registry.method(driver, 'isIdle')?.() ? 'idle' : 'unknown';
    if (this.deps.gate.stops.driver(id)) return 'unknown';
    return this.deps.repos.execution.getResources(id).every(resource => resource.kind === 'operation' || resource.purpose === 'acp_native_context'
      || resource.stage === 'not_created' || resource.observations.at(-1)?.state === 'gone') ? 'idle' : 'unknown';
  }

  /** A session with unresolved execution or unverifiable resources cannot resume its queue. */
  async restoreSession(session: Session, blockedVerifications: ReadonlyMap<string, string>) {
    await this.deps.loadStopBlock(session.id);
    if (session.archivedAt) return;
    const tasks = await this.mutations.wait(() => this.deps.repos.tasks.listBySession(session.id));
    for (const task of tasks) {
      const projection = this.deps.repos.execution.getTaskExecution(task.id);
      if (projection?.steering?.state === 'pending') {
        const operation = projection.steering;
        await this.mutations.write(session.id, async () => this.deps.wake(this.deps.bound().resolveQueuedSteering(this.deps.fence(session), operation.operationId, operation.controller, 'unknown')));
      }
      const current = projection?.currentAttempt;
      // An attempt still waiting on an earlier runtime's orphan record has no new evidence; re-recording it each restart only grows the ledger.
      const alreadyOrphaned = current?.state === 'reconcile_required' && current.reconcileReason?.reasonId.startsWith(`orphan:${current.attemptId}:`);
      if (current && !alreadyOrphaned && (!current.reconcileReason || ['PREVIOUS_RUNTIME_RESULT_UNKNOWN', 'DAEMON_SHUTDOWN'].includes(current.reconcileReason.code)) && current.submissionState !== 'not_submitted' && ['preparing', 'active', 'reconcile_required'].includes(current.state)
        && (current.controller.accessId !== this.deps.repos.control.accessId || current.controller.instanceId !== this.deps.runtimeInstanceId || current.controller.generation !== this.deps.claim()!.generation)) {
        await this.mutations.write(session.id, async () => this.deps.wake(this.deps.bound().markOrphanedAttempt(this.deps.attemptFence(current), { reasonId: `orphan:${current.attemptId}:${this.deps.claim()!.generation}`, code: current.reconcileReason?.code ?? 'PREVIOUS_RUNTIME_RESULT_UNKNOWN', evidenceRefs: [] })));
      }
    }
    await this.observeAbandonedResources(session);
    await this.retireDetachedPty(session);
    await this.clearVerifiedStopBlock(session);
    try { await this.mutations.wait(() => this.deps.configurations.assertClear(session.id)); }
    catch (error) {
      if (error instanceof RuntimeError && ['DRIVER_CONFIGURATION_BUSY', 'DRIVER_CONFIGURATION_UNKNOWN'].includes(error.code)) return;
      throw error;
    }
    if (!blockedVerifications.has(session.id)) {
      for (const task of tasks) {
        try { if (await this.recoverPersistentTurn(session, task)) return; }
        catch (error) {
          this.mutations.check();
          await this.deps.emit(session.id, 'error', { code: 'PTY_RECOVERY_DEFERRED', taskId: task.id,
            message: 'Original turn recovery is blocked; the submitted task remains unresolved',
            ...(error instanceof RuntimeError ? { reason: error.code } : {}) });
        }
      }
    }
    const restoredTerminal = !blockedVerifications.has(session.id) && await this.restoreIdlePersistentTerminal(session);
    // Unverified local_only and legacy resources remain blocked.
    if (this.deps.resourceBlockers(session.id, restoredTerminal).length || blockedVerifications.has(session.id)) return;
    for (const task of tasks) {
      const attempt = this.deps.repos.execution.getTaskExecution(task.id)?.currentAttempt;
      if (attempt?.state === 'preparing' && attempt.submissionState === 'not_submitted') {
        const safeResources: ResourceCheckRef[] = this.deps.repos.execution.getResources(session.id)
          .filter(resource => resource.kind !== 'operation' && resource.purpose !== 'acp_native_context' && resource.stage !== 'not_created')
          .map(resource => ({ resourceId: resource.resourceId, expectedRevision: resource.revision, observationId: resource.observations.at(-1)!.observationId }));
        this.deps.wake(this.deps.bound().recoverAttempt(this.deps.attemptFence(attempt), { kind: 'unsubmitted_preparation', decisionId: `recover:${attempt.attemptId}:${this.deps.claim()!.generation}`, safeResources }));
      }
    }
    if (this.deps.repos.execution.getUnresolvedTasks(session.id).length) return;
    return true;
  }

  /** The submission's single local PTY resource, if the original turn can still be taken over through it. */
  recoverableResource(sessionId: string, runId: string, refs: NonNullable<TaskAttempt['submission']>['resourceRefs']) {
    const resource = refs.length === 1 ? this.deps.repos.execution.getResources(sessionId).find(row => row.resourceId === refs[0]!.resourceId) : undefined;
    if (!resource || resource.kind !== 'local_only' || resource.stage !== 'created' || resource.runId !== runId
      || resource.identity?.identityId !== refs[0]!.identityId || resource.observations.at(-1)?.state === 'gone'
      || this.deps.resourceBlockers(sessionId).some(block => block.resourceId !== resource.resourceId)) return undefined;
    return resource;
  }

  async getTaskRecovery(id: string, taskId: string) { return this.readTaskRecovery(id, taskId).recovery; }

  readTaskRecovery(id: string, taskId: string) {
    const claim = this.deps.claim();
    const projection = this.deps.repos.execution.getTaskExecution(taskId, claim ? { claim, idleResources: this.deps.idleResourceChecks() } : undefined);
    if (!projection || projection.task.sessionId !== id) throw new RuntimeError('TASK_NOT_FOUND', 'Task not found in this session', 404);
    const active = this.deps.repos.execution.getUnresolvedTasks(id).find(task => task.id !== taskId);
    return { projection, recovery: this.taskRecovery(id, projection, active, this.deps.localResources.reusableIds(id)) };
  }

  /** One consistent traversal for callers checking every task in a session. */
  async getSessionTaskRecovery(id: string) {
    const claim = this.deps.claim();
    const projections = this.deps.repos.execution.getSessionExecutions(id, claim ? { claim, idleResources: this.deps.idleResourceChecks() } : undefined);
    const reusable = this.deps.localResources.reusableIds(id);
    const unresolved = projections.filter(value => value.steering && ['pending','unknown'].includes(value.steering.state) || value.attempts.some(attempt => ['preparing', 'active', 'reconcile_required', 'legacy_unresolved'].includes(attempt.state))).map(value => value.task);
    return projections.map(projection => ({ taskId: projection.task.id,
      ...this.taskRecovery(id, projection, unresolved[0]?.id === projection.task.id ? unresolved[1] : unresolved[0], reusable) }));
  }

  private taskRecovery(id: string, projection: TaskExecutionProjection, active: { id: string; status: string } | undefined, reusable: Set<string>) {
    const blockers = projection.blockers.filter(block => !(block.code === 'DRIVER_RESOURCE_UNSAFE' && block.resourceId && reusable.has(block.resourceId)));
    if (active && active.status !== 'running') blockers.push({ code: 'PREVIOUS_RESULT_UNKNOWN', sessionId: id });
    if (projection.task.status === 'queued' && this.deps.queueBlocked.has(id)) blockers.push({ code: 'QUEUE_START_CHECK_FAILED', sessionId: id });
    return { status: projection.task.status, resolvedUnknown: projection.currentAttempt?.state === 'settled' && projection.currentAttempt.outcome === 'unknown', blockers: [...new Map(blockers.map(block => {
      const external = Boolean(block.sessionId && block.sessionId !== id);
      return [JSON.stringify([block.code, external]), { code: block.code, ...(external ? { external: true } : {}) }];
    })).values()],
      ...(projection.currentAttempt?.state === 'settled' && projection.currentAttempt.outcome === 'completed' && projection.currentAttempt.settlement?.kind === 'manual' && projection.currentAttempt.settlement.verifiedOutput ? { verifiedOutput: projection.currentAttempt.settlement.verifiedOutput } : {}),
      ...(active ? { activeTaskId: active.id } : {}) };
  }

  requireRecoveryOwner(actor: ExecutionActor) {
    if (executionActorSchema.parse(actor).kind !== 'installation_owner') throw new RuntimeError('RECOVERY_OWNER_REQUIRED', 'Installation owner authorization is required', 403);
  }
  async inspectExecutionRecovery(id: string, actor: ExecutionActor) {
    this.deps.assertReady(); this.requireRecoveryOwner(actor);
    const session = await this.deps.repos.sessions.get(id);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', 'Session not found', 404);
    const tasks = (await this.deps.repos.tasks.listBySession(id)).map(task => this.deps.repos.execution.getTaskExecutionState(task.id)!).filter(Boolean);
    const resources = this.deps.repos.execution.getResources(id);
    return { sessionId: id, runId: session.runId, state: session.state,
      tasks: tasks.map(({ task, currentAttempt, steering }) => ({ steering, taskId: task.id, status: task.status, revision: task.revision,
        attempt: currentAttempt, resolvedUnknown: currentAttempt?.state === 'settled' && currentAttempt.outcome === 'unknown' })),
      resources, blockers: [...this.deps.repos.execution.getSessionResourceBlockers(id), ...tasks.flatMap(({steering}) => steering && ['pending','unknown'].includes(steering.state) ? [{code:'STEERING_DELIVERY_UNKNOWN',sessionId:id,taskId:steering.taskId}] : [])],
      stopBlock: await this.deps.repos.config.get(runtimeStateKeys.driverStopBlock.key(id)) ?? null,
      resourceChecks: resources.filter(resource => resource.kind !== 'operation' && resource.purpose !== 'acp_native_context' && resource.stage !== 'not_created')
        .flatMap(resource => resource.observations.at(-1) ? [{ resourceId: resource.resourceId, expectedRevision: resource.revision, observationId: resource.observations.at(-1)!.observationId }] : []),
      unverifiedResourceIds: resources.filter(resource => ['local_only', 'legacy'].includes(resource.kind) && resource.observations.at(-1)?.state !== 'gone').map(resource => resource.resourceId)
    };
  }
  async clearVerifiedStopBlock(session: Session) {
    if (this.deps.recoveryInFlight(session.id)) return false;
    const raw = await this.mutations.wait(() => this.deps.repos.config.get(runtimeStateKeys.driverStopBlock.key(session.id)));
    if (!raw) return false;
    try {
      const cleared = await this.mutations.write(session.id, async () => this.deps.bound().clearVerifiedStopBlock(this.deps.fence(session), raw));
      if (cleared) {

        this.deps.clearRecoveredStop(session.id);
      }
      return cleared;
    } catch (error) {
      if (error instanceof RuntimeError && ['SESSION_RESOURCE_BLOCKED', 'DRIVER_STOP_BLOCK_INVALID', 'SESSION_RUN_CONFLICT'].includes(error.code)) return false;
      throw error;
    }
  }
  async probeExecutionRecovery(id: string, runId: string, actor: ExecutionActor) {
    this.deps.assertReady(); this.requireRecoveryOwner(actor);
    return this.mutations.run(this.mutations.owners.ownerOf(id), async () => {
      const { session } = await this.deps.active(id);
      if (session.runId !== runId) throw new RuntimeError('SESSION_RUN_CONFLICT', 'Session run changed', 409);
      if (this.deps.recoveryInFlight(id)) throw new RuntimeError('RECOVERY_EXECUTION_ACTIVE', 'Original execution still has an in-flight owner', 409);
      await this.observeAbandonedResources(session);
      await this.clearVerifiedStopBlock(session);
      if (!this.deps.resourceBlockers(id).length) {
        await this.deps.reopenQueue(id);
      }
      return this.inspectExecutionRecovery(id, actor);
    });
  }
  async retirePtyExecution(id: string, raw: PtyRetirementRecovery, actor: ExecutionActor) {
    this.deps.assertReady(); this.requireRecoveryOwner(actor);
    const input = ptyRetirementRecoverySchema.parse(raw);
    return this.mutations.run(this.mutations.owners.ownerOf(id), async () => {
      const { session } = await this.deps.active(id);
      const control = this.deps.options.launch.ptyRetirement ?? this.deps.registry.for(session.protocol)?.retirement;
      if (!control) throw new RuntimeError('PTY_RETIREMENT_UNAVAILABLE', 'Trusted PTY recovery is not configured', 503);
      if (session.runId !== input.runId) throw new RuntimeError('SESSION_RUN_CONFLICT', 'Session run changed', 409);
      const key = runtimeStateKeys.ptyRetirement.key(id, input.decisionId);
      const observationId = `pty_retirement_${digest({ sessionId: id, ...input })}`;
      type Receipt = { input: PtyRetirementRecovery; actor: ExecutionActor; identity: unknown; snapshot: unknown; absent?: true };
      let receipt: Receipt | undefined;
      let replayed = false, reserved = false;
      const checkScope = async () => {
        const current = await this.deps.repos.sessions.get(id); this.mutations.check();
        if (current?.runId !== input.runId) throw new RuntimeError('SESSION_RUN_CONFLICT', 'Session run changed', 409);
      };
      const checkResource = () => {
        this.mutations.check();
        const resource = this.deps.repos.execution.getResources(id).find(item => item.resourceId === input.resourceId);
        if (!resource || resource.runId !== input.runId || resource.kind !== 'local_only' || !resource.identity || resource.identity.locator === null) throw new RuntimeError('RESOURCE_SCOPE_CONFLICT', 'The exact local PTY resource is required', 409);
        if (receipt && canonicalExecutionJson(resource.identity) !== canonicalExecutionJson(receipt.identity)) throw new RuntimeError('RESOURCE_IDENTITY_CONFLICT', 'Original resource identity changed', 409);
        const observed = resource.observations.find(item => item.observationId === observationId);
        if (receipt && observed && observed.state === 'gone' && resource.revision === input.expectedRevision + 1 && observed.evidenceRef === `pty-retirement:${digest(receipt)}`) return { resource, recorded: true };
        if (resource.revision !== input.expectedRevision) throw new RuntimeError('RESOURCE_REVISION_CONFLICT', 'Resource revision changed', 409);
        return { resource, recorded: false };
      };
      await this.mutations.write(id, async () => {
        const persisted = await this.deps.repos.config.get(key);
        if (persisted) {
          receipt = JSON.parse(persisted) as Receipt;
          if (canonicalExecutionJson(receipt.input) !== canonicalExecutionJson(input) || canonicalExecutionJson(receipt.actor) !== canonicalExecutionJson(actor)) throw new RuntimeError('EXECUTION_OPERATION_CONFLICT', 'Retirement decision was reused with different input', 409);
        }
        await checkScope();
        const checked = checkResource(); replayed = checked.recorded;
        if (replayed) return;
        if (this.deps.recoveryInFlight(id)) throw new RuntimeError('RECOVERY_EXECUTION_ACTIVE', 'Original execution or queue drain still has an in-flight owner', 409);
        if (checked.resource.stage !== 'created' || checked.resource.observations.at(-1)?.state === 'gone') throw new RuntimeError('PTY_RETIREMENT_RESOURCE_UNSAFE', 'Only the original live or unverified created PTY resource can be retired', 409);
        const resources = this.deps.repos.execution.getResources(id);
        if (resources.some(resource => resource.kind === 'local_only' && resource.resourceId !== input.resourceId && resource.stage !== 'not_created' && resource.observations.at(-1)?.state !== 'gone')
          || resources.some(resource => resource.kind === 'operation' && ['pending', 'unknown'].includes(resource.stage) && !resource.creationClosure)) throw new RuntimeError('PTY_RETIREMENT_RESOURCE_AMBIGUOUS', 'Another PTY resource or unfinished creation prevents unambiguous retirement', 409);
        this.reservePtyRetirement(id); reserved = true;
        if (!await this.deps.repos.config.get(runtimeStateKeys.driverStopBlock.key(id))) await this.deps.retainStopBlock(id, 'Explicit PTY retirement requires verified physical exit');
      }).catch(error => { if (reserved) this.ptyRetirements.delete(id); throw error; });
      if (replayed) return { replayed: true, recovery: await this.inspectExecutionRecovery(id, actor) };
      try {
        if (!receipt) {
          // 原终端已不存在时改用不存在证明；它只在所有者运行时已退出时才被账本接受（observeDetachedLocalResource）。
          const absence = control.captureAbsence ? await this.mutations.wait(() => control.captureAbsence!(session)) : undefined;
          const snapshot = absence ?? await this.mutations.wait(() => Promise.resolve(control.capture(session)));
          canonicalExecutionJson(snapshot);
          await this.mutations.write(id, async () => {
            await checkScope(); const { resource } = checkResource();
            receipt = { input, actor, identity: resource.identity!, snapshot, ...(absence !== undefined ? { absent: true as const } : {}) };
            await this.deps.repos.config.set(key, canonicalExecutionJson(receipt));
          });
        }
        if (!receipt!.absent && !await this.mutations.wait(() => Promise.resolve(control.verify(session, receipt!.snapshot)))) {
          const persistSnapshot = async (snapshot: unknown) => {
            canonicalExecutionJson(snapshot);
            await this.mutations.write(id, async () => {
              await checkScope(); checkResource(); receipt = { ...receipt!, snapshot };
              await this.deps.repos.config.set(key, canonicalExecutionJson(receipt));
            });
          };
          await persistSnapshot(await this.mutations.wait(() => control.stop(session, receipt!.snapshot, persistSnapshot)));
        }
        await this.mutations.write(id, async () => {
          await checkScope(); const { resource } = checkResource();
          if (!await this.mutations.wait(() => Promise.resolve(control.verify(session, receipt!.snapshot)))) throw new RuntimeError('PTY_EXIT_UNVERIFIED', 'Original PTY processes have not all been proven gone', 409);
          const observation = { observationId, state: 'gone' as const, identityId: resource.identity!.identityId, observedAt: now(), evidenceRef: `pty-retirement:${digest(receipt)}` };
          if (receipt!.absent) this.deps.bound().observeDetachedLocalResource(this.deps.fence(session), resource.resourceId, input.expectedRevision, observation);
          else this.deps.bound().observed(this.deps.fence(session), resource.resourceId, input.expectedRevision, observation);
        });
      } finally { this.ptyRetirements.delete(id); }
      await this.clearVerifiedStopBlock(session);
      if (!this.deps.resourceBlockers(id).length) {
        await this.deps.reopenQueue(id);
      }
      return { replayed, recovery: await this.inspectExecutionRecovery(id, actor) };
    });
  }

  async confirmExecutionRecovery(id: string, raw: ExecutionRecoveryDecision, actor: ExecutionActor) {
    this.deps.assertReady(); this.requireRecoveryOwner(actor);
    const input = executionRecoveryDecisionSchema.parse(raw);
    return this.mutations.run(this.mutations.owners.ownerOf(id), async () => {
      const { session } = await this.deps.active(id);
      if (session.runId !== input.runId) throw new RuntimeError('SESSION_RUN_CONFLICT', 'Session run changed', 409);
      const original = this.deps.repos.execution.getTaskExecution(input.taskId)?.attempts.find(attempt => attempt.attemptId === input.attemptId);
      const replay = original?.settlement?.kind === 'manual' && original.settlement.decision.decisionId === input.decisionId;
      if (!replay && this.deps.recoveryInFlight(id)) throw new RuntimeError('RECOVERY_EXECUTION_ACTIVE', 'Original execution still has an in-flight owner', 409);
      const f = { sessionId: id, runId: input.runId, taskId: input.taskId, attemptId: input.attemptId, expectedRevision: input.expectedRevision };
      const decision = { decisionId: input.decisionId, actor, action: input.action, evidenceRefs: input.evidenceRefs, resourceChecks: input.resourceChecks,
        ...(input.action === 'retry' ? { allowDuplicateEffects: true } : {}) };
      const result = await this.mutations.write(id, async () => this.deps.wake(input.action === 'retry'
        ? this.deps.bound().retryAttempt(f, decision, input.resourceChecks)
        : this.deps.bound().confirmAttemptRecovery(f, `recovery:${input.decisionId}`, { kind: 'manual', outcome: input.outcome, decision }, input.verifiedOutputText)));
      if (!result.replayed) {
        await clearTaskReportSafely(this.deps.repos.config, input.taskId);
        await this.deps.reopenQueue(id);
      }
      return { replayed: result.replayed, task: this.deps.publicTask(result.task!), recovery: await this.inspectExecutionRecovery(id, actor) };
    });
  }


  /**
   * 结果未知的一轮，在会话的驱动还连着、确认空闲时收口（飞书「在原对话继续」、Agent 已停下的自动收口）。
   * 人工收口（confirmExecutionRecovery）要求执行进程都已停下，而连着的驱动正是这个会话接着要用的进程；
   * 这里只在驱动确认空闲、没有在途操作、除本会话可复用的驱动外没有不安全资源时，以安装者身份记一次收口，其余情况拒绝。
   */
  async settleIdleAttempt(id: string, input: { taskId: string; decisionId: string; outcome: 'unknown' | 'interrupted' | 'failed'; evidenceRefs: string[] }, actor: ExecutionActor) {
    this.deps.assertReady(); this.requireRecoveryOwner(actor);
    return this.mutations.run(this.mutations.owners.ownerOf(id), async () => {
      const { session, driver } = await this.deps.active(id);
      const attempt = this.deps.repos.execution.getTaskExecution(input.taskId)?.currentAttempt;
      if (!attempt || attempt.sessionId !== id) throw new RuntimeError('TASK_NOT_FOUND', 'Task not found in this session', 404);
      if (attempt.state === 'settled' && attempt.settlement?.kind === 'manual' && attempt.settlement.decision.decisionId === input.decisionId) return { replayed: true };
      if (attempt.state !== 'reconcile_required') throw new RuntimeError('ATTEMPT_NOT_RECONCILE_REQUIRED', 'Only a result-unknown attempt can be settled here', 409);
      if (this.deps.recoveryInFlight(id) || !driver || this.deps.registry.method(driver, 'isDetachedForShutdown')?.() || !this.deps.registry.method(driver, 'isIdle')?.()) throw new RuntimeError('RECOVERY_EXECUTION_ACTIVE', 'The agent has not confirmed it is idle', 409);
      this.deps.assertResources(id, true);
      const f = this.deps.attemptFence({ sessionId: id, runId: session.runId, taskId: input.taskId, attemptId: attempt.attemptId });
      await this.mutations.write(id, async () => this.deps.wake(this.deps.bound().settleAttempt(f, `recovery:${input.decisionId}`, { kind: 'manual', outcome: input.outcome,
        decision: { decisionId: input.decisionId, actor, action: 'confirm_result', evidenceRefs: input.evidenceRefs, resourceChecks: [] } })));
      await this.deps.reopenQueue(id);
      return { replayed: false };
    });
  }

  /**
   * 结果未知任务的已知事实（飞书提醒卡、Web 共用）：最后状态、有没有提交给 Agent、最后输出时间，以及有没有人处理过。
   * 不给 target 时看当前停在结果未知的那次执行或插话；给了就看那一次（卡上记着的那一次），已被换掉时 actionable 为 false。
   */
  async inspectUnknownTask(id: string, taskId: string, target?: string): Promise<UnknownTaskFacts> {
    this.deps.assertReady();
    const projection = this.deps.repos.execution.getTaskExecution(taskId);
    if (!projection || projection.task.sessionId !== id) throw new RuntimeError('TASK_NOT_FOUND', 'Task not found in this session', 404);
    const { task, currentAttempt, steering } = projection;
    const open = task.status === 'reconcile_required' && currentAttempt?.state === 'reconcile_required' ? currentAttempt.attemptId
      : task.status === 'reconcile_required' && !task.currentAttemptId && steering?.taskId === task.id && ['pending', 'unknown'].includes(steering.state) ? steering.operationId
      : undefined;
    const targetId = target ?? open ?? currentAttempt?.attemptId ?? steering?.operationId;
    const attempt = projection.attempts.find(item => item.attemptId === targetId);
    const operation = !attempt && steering?.operationId === targetId ? steering : undefined;
    const settlement = attempt?.settlement?.kind === 'manual' ? attempt.settlement : undefined;
    const resolution: UnknownTaskFacts['resolution'] = settlement
      ? { action: settlement.decision.action === 'retry' ? 'retry' : settlement.outcome === 'completed' || settlement.outcome === 'failed' ? settlement.outcome : 'other',
        decisionId: settlement.decision.decisionId, at: attempt!.updatedAt }
      : operation?.decisionId && ['delivered', 'not_delivered', 'abandoned'].includes(operation.state)
        ? { action: operation.state === 'delivered' ? 'completed' : operation.state === 'not_delivered' ? 'retry' : 'failed', decisionId: operation.decisionId, at: operation.updatedAt }
        : undefined;
    const lastOutputAt = attempt && this.deps.repos.execution.getLastAttemptOutputAt(attempt.attemptId);
    return { taskId, status: task.status, actionable: open !== undefined && open === targetId,
      ...(attempt ? { kind: 'attempt' as const, target: attempt.attemptId, submission: attempt.submissionState, startedAt: attempt.createdAt,
        ...(attempt.reconcileReason ? { reasonCode: attempt.reconcileReason.code } : {}), ...(lastOutputAt ? { lastOutputAt } : {}) }
        : operation ? { kind: 'steering' as const, target: operation.operationId, reasonCode: 'STEERING_DELIVERY_UNKNOWN', startedAt: operation.createdAt } : {}),
      ...(resolution ? { resolution } : {}) };
  }

  /**
   * 人工处理结果未知的任务：重新执行（同一任务按原请求排回队列）、标为已完成、标为失败。
   * 用的是 `dutydeck recovery` 同一组账本原语（执行：retryAttempt / confirmAttemptRecovery；插话：confirmSteeringRecovery），
   * 决定写进 recovery_decisions，版本号保证并发点击、重启后的重复回调只有一个生效；同一 decisionId 再来只回放。
   * 驱动确认空闲时可以复用；状态不明时先停止并核实退出。没有驱动时严格核对原执行资源。
   */
  async resolveUnknownTask(id: string, raw: UnknownTaskResolution, actor: ExecutionActor) {
    this.deps.assertReady(); this.requireRecoveryOwner(actor);
    const input = unknownTaskResolutionSchema.parse(raw);
    const decisionOwner = this.mutations.owners.ownerOf(id);
    // Keep the physical exit observation even if a concurrent stop revokes the decision.
    return this.mutations.run(undefined, () => this.mutations.write(id, async () => {
      const { session, driver } = await this.deps.active(id);
      const facts = await this.inspectUnknownTask(id, input.taskId, input.target);
      const projection = this.deps.repos.execution.getTaskExecution(input.taskId)!;
      if (facts.resolution?.decisionId === input.decisionId) return { replayed: true, task: this.deps.publicTask(projection.task) };
      if (!facts.actionable) throw new RuntimeError('TASK_NOT_RESULT_UNKNOWN', 'This attempt is no longer waiting for a decision', 409);
      if (input.action === 'completed' && facts.kind === 'attempt' && input.verifiedOutputText === undefined) throw new RuntimeError('RECOVERY_OUTPUT_REQUIRED', 'Completed recovery requires verified output', 400);
      this.mutations.check(decisionOwner);
      if (this.deps.driverRetiring(id) || this.deps.recoveryInFlight(id)) throw new RuntimeError('RECOVERY_EXECUTION_ACTIVE', 'Original execution still has an in-flight owner', 409);
      const state = this.deps.registry.method(driver, 'quiescence')?.().state ?? (this.deps.registry.method(driver, 'isIdle')?.() ? 'idle' : 'busy');
      const reuseOwned = !!driver && state === 'idle';
      const stoppedOriginal = !!driver && state === 'unknown';
      if (driver && (this.deps.registry.method(driver, 'isDetachedForShutdown')?.() || state === 'busy')) throw new RuntimeError('RECOVERY_EXECUTION_ACTIVE', 'The agent is still active', 409);
      if (reuseOwned) this.deps.assertResources(id, true);
      else {
        if (driver) {
          this.deps.nextSessionGeneration(id);
          await this.deps.stopDriver(id, driver);
          // The original exit callback was fenced before stopping. Close its terminal streams after verified exit.
          this.deps.notifyDriverExit(id, null);
        }
        await this.observeAbandonedResources(session);
        await this.clearVerifiedStopBlock(session);
      }
      const resourceChecks = reuseOwned ? [] : (await this.inspectExecutionRecovery(id, actor)).resourceChecks;
      const evidenceRefs = stoppedOriginal ? [...input.evidenceRefs, 'stopped_original_driver'] : input.evidenceRefs;
      const evidence = { decisionId: input.decisionId, actor, evidenceRefs, resourceChecks };
      this.mutations.check(decisionOwner);
      let result;
      if (facts.kind === 'steering') {
        const operation = projection.steering!;
        result = this.deps.wake(this.deps.bound().confirmSteeringRecovery(this.deps.fence(session), { runId: session.runId, taskId: input.taskId, operationId: operation.operationId,
          expectedRevision: operation.revision, decisionId: input.decisionId, evidenceRefs, resourceChecks,
          ...(input.action === 'retry' ? { action: 'not_delivered' as const, allowDuplicateEffects: true as const } : { action: input.action === 'completed' ? 'delivered' as const : 'abandon' as const }) }, actor, reuseOwned));
      } else {
        const attempt = projection.currentAttempt!;
        const f = { sessionId: id, runId: session.runId, taskId: input.taskId, attemptId: attempt.attemptId, expectedRevision: attempt.revision };
        result = this.deps.wake(input.action === 'retry'
          ? this.deps.bound().retryAttempt(f, { ...evidence, action: 'retry', allowDuplicateEffects: true }, resourceChecks, reuseOwned)
          : this.deps.bound().confirmAttemptRecovery(f, `recovery:${input.decisionId}`, { kind: 'manual', outcome: input.action, decision: { ...evidence, action: 'confirm_result' } },
            input.action === 'completed' ? input.verifiedOutputText : undefined, reuseOwned));
      }
      if (!result.replayed) { await clearTaskReportSafely(this.deps.repos.config, input.taskId); await this.deps.reopenQueue(id); }
      return { replayed: result.replayed, task: this.deps.publicTask(result.task!), ...(stoppedOriginal ? { stoppedOriginal: true as const } : {}) };
    }));
  }

  async observeAbandonedResources(session:Session) {
    const f=this.deps.fence(session);
    for(const resource of this.deps.repos.execution.getResources(session.id)) {
      if(resource.runId!==f.runId)continue;
      if(resource.kind==='operation'&&resource.creationProvenance&&!resource.creationClosure&&['pending','unknown'].includes(resource.stage)) {
        try{this.deps.bound().closeAbandonedCreation(f,resource.resourceId,resource.revision);}catch(error){if(!(error instanceof RuntimeError&&error.code==='RESOURCE_CREATOR_NOT_PROVEN_DEAD'))throw error;}
      } else if(resource.kind==='process'&&resource.identity&&resource.observations.at(-1)?.state!=='gone') {
        this.deps.bound().probePhysicalResource(f,resource.resourceId,resource.revision);
      }
    }
    for(const resource of this.deps.repos.execution.getResources(session.id)) {
      if(resource.runId!==f.runId||resource.purpose!=='acp_native_context'||resource.stage!=='pending'||resource.nativeReplacement||!resource.nativeExpected)continue;
      const readNativeCreationRecord = this.deps.registry.readNativeCreationRecord(session);
      if (!readNativeCreationRecord) continue;
      let identity: NativeContextIdentity | undefined;
      try{identity=await this.mutations.wait(()=>readNativeCreationRecord(resource.nativeExpected!));}
      catch(error){if(error instanceof RevokedOperation)throw error;await this.deps.emit(session.id,'error',{code:'NATIVE_CONTEXT_RECEIPT_UNVERIFIABLE',resourceId:resource.resourceId,message:'The original native creation receipt cannot be verified; its pending resource is retained'});continue;}
      if(identity){try{this.deps.bound().confirmRecoveredNativeContext(f,resource.resourceId,resource.revision,identity);}catch(error){if(!(error instanceof RuntimeError&&error.code==='SESSION_RESOURCE_BLOCKED'))throw error;}}
    }
  }
  /**
   * 上一个运行时留下、仍标为存活的 PTY 终端记录：宿主核实这个会话的 tmux 会话已不存在，且记录的所有者运行时已退出时，
   * 记为已消失（不存在证明写进账本），不结束任何进程。终端还在、查不准或所有者还在，都原样保留。返回写入的证据引用。
   */
  async retireDetachedPty(session: Session): Promise<string[]> {
    const control = this.deps.options.launch.ptyRetirement ?? this.deps.registry.for(session.protocol)?.retirement, id = session.id;
    if (!control?.captureAbsence || !this.deps.registry.capabilities(session.protocol)?.persistentTerminal || this.deps.drivers.has(id) || this.deps.gate.stops.driver(id) || this.deps.recoveryInFlight(id)) return [];
    const candidates = this.deps.repos.execution.getResources(id).filter(r => r.runId === session.runId && r.kind === 'local_only' && r.stage === 'created'
      && r.identity && r.observations.at(-1)?.state !== 'gone');
    if (!candidates.length) return [];
    let absence: unknown;
    try { absence = await this.mutations.wait(() => control.captureAbsence!(session)); }
    catch (error) { if (error instanceof RevokedOperation) throw error; return []; }
    if (absence === undefined) return [];
    const evidenceRef = `pty-absent:${digest(absence)}`, refs: string[] = [];
    for (const r of candidates) await this.mutations.write(id, async () => {
      if (!await this.mutations.wait(() => Promise.resolve(control.verify(session, absence)))) return;
      try {
        this.deps.bound().observeDetachedLocalResource(this.deps.fence(session), r.resourceId, r.revision, { observationId: `pty_absent_${digest([r.resourceId, r.revision, evidenceRef])}`,
          state: 'gone', identityId: r.identity!.identityId, observedAt: now(), evidenceRef });
        refs.push(`${evidenceRef}:${r.resourceId}`);
      } catch (error) {
        if (!(error instanceof RuntimeError && ['RESOURCE_OWNER_NOT_PROVEN_EXITED', 'RESOURCE_OBSERVATION_CONFLICT', 'RESOURCE_SCOPE_CONFLICT'].includes(error.code))) throw error;
      }
    });
    if (refs.length) this.deps.options.log?.info?.({ sessionId: id, resources: refs }, 'Retired PTY records whose terminal and owner runtime are gone');
    return refs;
  }
  async probeNativeResources(id:string,actor:ExecutionActor) {
    this.deps.assertReady();
    if(this.mutations.owners.lifecycle(id).revoked){this.mutations.run(undefined,()=>this.deps.assertReplaceable(id));this.mutations.owners.renew(id,this.mutations.owners.transition(id));}
    return this.mutations.scoped(id,async()=>{const {session}=await this.deps.active(id);this.deps.bound().authorizeNativeContextControl(this.deps.fence(session),actor);await this.deps.authorize(id,actor.kind==='unspecified'?undefined:actor.id);await this.observeAbandonedResources(session);return this.deps.repos.execution.getSessionResourceBlockers(id);});
  }
  async replaceNativeContext(id:string,actor:ExecutionActor,resourceId:string,expectedRevision:number,decisionId:string,expectedRunId?:string) {
    if(expectedRunId!==undefined)this.requireRecoveryOwner(actor);
    return this.prepareNativeContext(id,actor,{resourceId,expectedRevision,decisionId},expectedRunId);
  }
  /** 配置结果不明（DRIVER_CONFIGURATION_UNKNOWN）时，用原生会话重新下发并核实当前配置；给了 expectedRunId 即管理员恢复入口。 */
  async restoreNativeConfiguration(id:string,actor:ExecutionActor,expectedRunId?:string) {
    if(expectedRunId!==undefined)this.requireRecoveryOwner(actor);
    return this.prepareNativeContext(id,actor,undefined,expectedRunId);
  }
  private async prepareNativeContext(id:string,actor:ExecutionActor,replacement?:{resourceId:string;expectedRevision:number;decisionId:string},expectedRunId?:string) {
    this.deps.assertReady();
    const original=await this.deps.repos.sessions.get(id);if(!original)throw new RuntimeError('SESSION_NOT_FOUND','Unknown Session',404);
    if(expectedRunId!==undefined&&original.runId!==expectedRunId)throw new RuntimeError('SESSION_RUN_CONFLICT','Session run changed',409);
    this.deps.bound().authorizeNativeContextControl(this.deps.fence(original),actor);await this.deps.authorize(id,actor.kind==='unspecified'?undefined:actor.id);
    if(!replacement&&!await this.deps.repos.config.get(runtimeStateKeys.driverConfiguration.key(id)))throw new RuntimeError('DRIVER_CONFIGURATION_REPAIR_NOT_REQUIRED','No configuration blocker exists',409);
    if(!replacement&&!this.deps.repos.execution.getNativeContext(id))throw new RuntimeError('NATIVE_CONTEXT_PROOF_REQUIRED','The original native context is required',409);
    if(expectedRunId!==undefined&&(await this.deps.repos.sessions.get(id))?.runId!==expectedRunId)throw new RuntimeError('SESSION_RUN_CONFLICT','Session run changed',409);
    // Retain queued requests and unknown submitted Attempts. This operation never prompts.
    try{await this.deps.revokeSession(id,{code:replacement?'native_context_replacement':'configuration_change',by:'DutydeckRuntime.prepareNativeContext'},false,'stopped');}catch(error){
      const blockers=this.deps.repos.execution.getSessionResourceBlockers(id);
      if(!replacement||!(error instanceof RuntimeError&&error.code==='SESSION_RESOURCE_BLOCKED')||!blockers.length||blockers.some(block=>block.resourceId!==replacement.resourceId))throw error;
    }
    const lifecycle=this.mutations.owners.renew(id,this.mutations.owners.transition(id));
    return this.mutations.run(lifecycle,async()=>{
      const {session}=await this.deps.active(id);
      if(expectedRunId!==undefined&&session.runId!==expectedRunId)throw new RuntimeError('SESSION_RUN_CONFLICT','Session run changed',409);
      this.deps.bound().authorizeNativeContextControl(this.deps.fence(session),actor);this.deps.assertReplaceable(id);
      if(replacement)await this.mutations.write(id,async()=>this.deps.bound().replaceNativeContext(this.deps.fence(session),{...replacement,actor}));
      this.deps.assertResources(id);
      const expected=await this.mutations.wait(()=>this.deps.repos.config.get(runtimeStateKeys.driverConfiguration.key(id)));
      if(!replacement&&!this.deps.repos.execution.getNativeContext(id))throw new RuntimeError('NATIVE_CONTEXT_PROOF_REQUIRED','The original native context is required',409);
      const unresolved=(await this.mutations.wait(()=>this.deps.repos.tasks.listBySession(id))).some(task=>this.deps.repos.execution.getTaskExecution(task.id)?.attempts.some(attempt=>['preparing','active','reconcile_required','legacy_unresolved'].includes(attempt.state)));
      const agent=await this.mutations.wait(()=>this.deps.repos.agents.get(session.agentId));if(!agent)throw new RuntimeError('AGENT_NOT_FOUND','Unknown agent',404);
      const configured=await this.deps.configureAgentForSession(agent,session),target:ExecutionOptions=executionOptionsOf(configured);
      if(!unresolved)await this.deps.saveState(session,'starting');
      let driver:AgentDriver|undefined;
      let operation:Awaited<ReturnType<DriverConfigurationLedger['beginRepair']>>|undefined;
      try {
        driver=await this.deps.reconnect(session,true,target,Boolean(expected));
        if(!expected){if(!unresolved)await this.deps.saveState(session,'idle');return session;}
        const owned=this.deps.localResources.get(driver)!;
        if(!owned.controlled||!this.deps.registry.supports(driver, 'configureNative'))throw new RuntimeError('NATIVE_CONFIGURATION_REPAIR_UNSUPPORTED','Driver cannot prove original-context configuration',422);
        operation=await this.mutations.write(id,()=>this.deps.configurations.beginRepair(id,owned.identityId,target,expected,actor));
        const nativeTarget=nativeTargetOf(target);
        const proof=await this.deps.driverOperation(driver,()=>driver!.configureNative!({operationId:operation!.operationId,target:nativeTarget}));
        await this.mutations.write(id,async()=>{
          this.mutations.check(lifecycle);this.deps.bound().authorizeNativeContextControl(this.deps.fence(session),actor);
          if(this.deps.drivers.get(id)!==driver||proof.driverInstanceId!==owned.identityId||proof.operationId!==operation!.operationId||canonicalExecutionJson(proof.target)!==canonicalExecutionJson(nativeTarget)||canonicalExecutionJson(proof.context)!==canonicalExecutionJson(this.deps.repos.execution.getNativeContext(id)?.selection.context))throw new RuntimeError('DRIVER_CONFIGURATION_UNKNOWN','Native configuration proof no longer belongs to this operation',409);
          owned.options={...target};await this.deps.configurations.finish(operation!,true);
        });
        if(!unresolved)Object.assign(session,await this.deps.patchSession(id,{state:'idle',error:undefined}));return session;
      } catch(error) {
        if(operation)await this.mutations.run(undefined,()=>this.mutations.write(id,()=>this.deps.configurations.finish(operation!,false))).catch(failure=>this.deps.warnCaught('prepareNativeContext.finishConfiguration',id,failure));
        if(driver)await this.mutations.run(undefined,()=>this.deps.stopDriver(id,driver!)).catch(failure=>this.deps.warnCaught('prepareNativeContext.stopDriver',id,failure));
        const code=(error as {code?:unknown}|null)?.code;
        if(!replacement&&this.deps.registry.for(session.protocol)?.readNativeCreationRecord&&error instanceof Error&&!(error instanceof RuntimeError)
          &&(typeof code==='number'||/^(ACP_NATIVE_CONTEXT_|ACP_LAUNCHER_VERSION_CHANGED:|NATIVE_CONTEXT_PROTOCOL_UNSUPPORTED)/.test(error.message))) {
          const failure=new RuntimeError('NATIVE_CONFIGURATION_RESTORE_FAILED',`Original native configuration could not be verified (${code ?? 'ACP'}): ${error.message}. Configuration remains unknown; restore the original native context or inspect recovery and explicitly replace it. No prompt was sent.`,409);
          throw Object.assign(failure,{cause:error});
        }
        throw error;
      }
    }).catch(async error=>{
      // Do not overwrite a later stop/restart or an unresolved task's state.
      if(!replacement&&this.mutations.valid(lifecycle))await this.mutations.run(lifecycle,()=>this.mutations.write(id,async()=>{
        const current=await this.deps.repos.sessions.get(id);
        if(current?.runId===original.runId&&!current.archivedAt&&!this.deps.repos.execution.getUnresolvedTasks(id).length) {
          await this.deps.patchSession(id,{state:original.state==='starting'?'failed':original.state,
            error:original.state==='starting'?(errorMessage(error)):original.error});
        }
      }));
      throw error;
    });
  }
}
