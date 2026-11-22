import type { DriverRegistry } from './driver-registry.js';
import type { AgentCapabilities, AgentConfig, AttemptFence, AttemptRef, BoundExecutionRepository, CommitResult, NormalizedDriverEvent, RuntimeControlClaim, SessionFence } from '@dutydeck/shared';
import { RuntimeError, runtimeStateKeys, sameIdleCpuProof, withTimeout, type AgentDriver, type ExecutionActor, type RepositoryBundle, type Session } from '@dutydeck/shared';
import { commandExists } from '@dutydeck/shared/execution';
import { digest } from '../digest.js';
import { IDLE_CPU_MIN_IDLE_MS, IdleCpuWindow } from '../idle-cpu.js';
import type { RuntimeHost } from './host-ports.js';
import { DriverConfigurationLedger, executionOptionsOf, LocalDriverLedger, type ExecutionOptions } from '../ledger.js';
import type { Owner, RevocationReason, RuntimeSessionMutations } from '../ownership.js';
import { RevokedOperation } from '../ownership.js';
import type { SessionGate } from '../session-gate.js';
import { DriverStopState } from '../session-gate.js';
import { VerificationManager } from '../verification.js';
import { WorkspaceManager } from '../workspace.js';
import { HumanWaits, type PendingPermission } from './human-waits.js';
import type { Notices } from './notices.js';

/** 空闲回收没能核实终端进程已退出时，隔这么久后台复核一次，之后每次加倍，最长隔 30 分钟。 */
const STOP_RECHECK_MS = 45_000;
const STOP_RECHECK_MAX_MS = 30 * 60_000;
/** 一次复核里等驱动探测或再停一次的上限；超时按「还没证明退出」处理，照常排下一次复核。 */
const STOP_RECHECK_PROBE_MS = 30_000;
/** 空闲回收前确认不了原生会话的终端（比如卡在启动确认框），闲置超过回收时限再加这么久，就不再保留、照常回收。 */
const IDLE_RETIREMENT_UNPREPARED_MS = 18 * 60 * 60_000;

interface DriverSupervisorDependencies {
  assertResources: (id: string, reuseOwned?: boolean) => void;
  assertVerificationRecoverySafe: (sessionId: string) => void;
  attachedTerminals: WeakSet<AgentDriver>;
  attemptFence: (ref: AttemptRef & SessionFence) => AttemptFence;
  blockedVerificationSessions: Map<string, string>;
  bound: () => BoundExecutionRepository;
  cancelSessionQueue: (id: string, suppliedActor?: ExecutionActor) => Promise<boolean>;
  cancelCapacityTimer(id: string): void;
  changeDriverConfiguration: (session: Session, driver: AgentDriver, targetOptions: (current: ExecutionOptions) => ExecutionOptions, defaults?: Partial<ExecutionOptions>, forceNativeProof?: boolean) => Promise<void>;
  claim(): RuntimeControlClaim | undefined;
  commandSwapWindow: () => Promise<void>;
  configurations: DriverConfigurationLedger;
  configureAgentForSession: (agent: AgentConfig, session: Session) => Promise<AgentConfig>;
  drainSessionEvents(id: string): Promise<void>;
  exitedDriverGenerations: Map<string, number>;
  registry: DriverRegistry;
  fence: (session: Session) => SessionFence;
  flushInsightSources: (driver: AgentDriver) => void;
  gate: SessionGate;
  humanWaits(): HumanWaits;
  localResources: LocalDriverLedger;
  notices: Notices;
  notifyDriverExit: (sessionId: string, code: number | null) => void;
  onDriverEvent: (session: Session, generation: number) => (event: NormalizedDriverEvent) => void;
  options: RuntimeHost;
  persistTerminalReceipt(session: Session, driver: AgentDriver): Promise<void>;
  probe: (agent: AgentConfig) => AgentCapabilities;
  releaseSteeringDriver(driver: AgentDriver): void;
  reopenQueue: (id: string) => Promise<void>;
  repos: RepositoryBundle;
  saveState: (session: Session, state: Session["state"], error?: string) => Promise<void>;
  scheduleQueue: (id: string) => void;
  sessionGenerations: Map<string, number>;
  settleExitedDriver: (sessionId: string, driver: AgentDriver | undefined, source?: Promise<void> | undefined) => Promise<unknown>;
  shuttingDown(): boolean;
  subscribeInsightSources(session: Session, driver: AgentDriver, generation: number, resourceId: string): void;
  unsubscribeInsightSources: (driver: AgentDriver) => void;
  verifications: VerificationManager;
  wake: <T extends CommitResult>(result: T) => T;
  wakeResourceQueues: () => void;
  warnCaught: (location: string, sessionId: string | undefined, error: unknown) => void;
  workspaces: WorkspaceManager;
}

export class DriverSupervisor {
  constructor(private readonly mutations: RuntimeSessionMutations, private readonly deps: DriverSupervisorDependencies) {}

  get drivers(): ReadonlyMap<string, AgentDriver> { return this.connectedDrivers; }
  private readonly connectedDrivers = new Map<string, AgentDriver>();
  private readonly stopIntents = new Map<string, { cancelQueue: boolean; actor?: ExecutionActor }>();
  readonly stopRuns = new Map<string, Promise<void>>();
  readonly driverOperations = new Map<AgentDriver, Set<Promise<unknown>>>();
  readonly factoryCleanups = new Map<string, Promise<void>>();
  private readonly driverStops = new WeakMap<AgentDriver, Promise<void>>();
  readonly retiringDrivers = new Set<string>();
  /** Sessions whose persistent pane is gone; cleared when a driver is next built for them. */
  private readonly missingTerminals = new Set<string>();
  private readonly lastActivity = new Map<string, number>();
  getDriverStopBlock(id: string) { return this.stops.reason(id); }
  /** 只读访问当前内存中的 driver 实例（如终端 WS 代理取 createTerminalStream）；未连接/已释放时返回 undefined。 */
  getDriver(sessionId: string): AgentDriver | undefined {
    if (this.deps.blockedVerificationSessions.has(sessionId) || this.stops.block(sessionId) || this.stops.driver(sessionId) || !this.mutations.valid(this.mutations.owners.lifecycle(sessionId))) return undefined;
    return this.drivers.get(sessionId);
  }
  /** Restore an idle persistent terminal for viewing without resuming a task. */
  async getTerminalDriver(id: string): Promise<AgentDriver | undefined> {
    return this.mutations.scoped(id, async () => {
      this.deps.assertVerificationRecoverySafe(id);
      if (this.deps.shuttingDown()) return undefined;
      this.mutations.check();
      await this.mutations.wait(() => this.deps.configurations.assertClear(id));
      this.deps.assertResources(id, true);
      const existing = this.drivers.get(id); if (existing) return existing;
      // The terminal tab retries while open; each rebuild would add two closed ledger rows.
      if (this.missingTerminals.has(id)) return undefined;
      const session = await this.mutations.wait(() => this.deps.repos.sessions.get(id));
      if (!session || session.archivedAt || !this.deps.registry.capabilities(session.protocol)?.persistentTerminal || !['idle', 'completed', 'interrupted'].includes(session.state)) return undefined;
      const driver = await this.reconnect(session, false);
      this.mutations.check();
      if (this.deps.attachedTerminals.has(driver)) return driver;
      let attached: boolean;
      try { attached = await this.deps.registry.method(driver, 'attachTerminal')?.() ?? false; }
      catch (error) { await this.discardUnattachedTerminal(id, driver); throw error; }
      if (attached) { this.deps.localResources.ready(driver); await this.deps.persistTerminalReceipt(session, driver); this.deps.attachedTerminals.add(driver); this.deps.flushInsightSources(driver); return driver; }
      await this.discardUnattachedTerminal(id, driver); this.missingTerminals.add(id); return undefined;
    }).catch(error => { if (error instanceof RevokedOperation) return undefined; throw error; });
  }
  /**
   * A terminal view that attached nothing owns no process, so there is no exit to prove.
   * Shutdown retires idle panes whose native history can resume; revoking the view's
   * driver here demanded a stop proof it can never give, and the retained stop block
   * then refused every later task in the session. The session state is left untouched.
   */
  private async discardUnattachedTerminal(id: string, driver: AgentDriver) {
    this.nextSessionGeneration(id);
    if (this.drivers.get(id) === driver) this.connectedDrivers.delete(id);
    try { await driver.stop(); } catch { /* Nothing was attached. */ }
    await this.mutations.write(id, async () => this.deps.localResources.gone(driver, 'terminal-attach-found-no-pane'));
  }
  async reconnect(session: Session, start = true, executionOptions?: ExecutionOptions, repairConfiguration = false, nativeForkSessionId?: string, discardOnFailure = false) {
    this.mutations.check(); this.deps.assertVerificationRecoverySafe(session.id);
    if(!repairConfiguration)await this.mutations.wait(() => this.deps.configurations.assertClear(session.id));
    await this.loadStopBlock(session.id); this.assertReplaceable(session.id);
    this.deps.assertResources(session.id, true);
    const existing = this.drivers.get(session.id);
    if (existing) return existing;
    const agent = await this.mutations.wait(() => this.deps.repos.agents.get(session.agentId));
    if (!agent) throw new RuntimeError('AGENT_NOT_FOUND', 'Unknown agent', 404);
    const workspace = await this.mutations.wait(() => this.deps.workspaces.get(session.id));
    if (workspace) await this.mutations.wait(() => this.deps.workspaces.validate(workspace));
    this.assertReplaceable(session.id); this.deps.assertResources(session.id, true);
    const connected = this.drivers.get(session.id); if (connected) return connected;
    const configured = await this.deps.configureAgentForSession(agent, session);
    this.assertReplaceable(session.id); this.deps.assertResources(session.id, true);
    const resolved = this.drivers.get(session.id); if (resolved) return resolved;
    if (start && this.deps.registry.capabilities(session.protocol)?.persistentTerminal && !this.deps.probe(configured).available) {
      if (!commandExists(configured.command)) await this.deps.commandSwapWindow();
      this.assertReplaceable(session.id); this.deps.assertResources(session.id, true);
      const raced = this.drivers.get(session.id); if (raced) return raced;
    }
    const options: ExecutionOptions = executionOptions ?? executionOptionsOf(configured);
    const generation = this.nextSessionGeneration(session.id), lifecycle = this.mutations.owners.lifecycle(session.id),startupOwner=this.mutations.current();
    const resource = this.deps.localResources.begin(this.deps.fence(session), options, this.deps.registry.controlled(session.protocol) ? {startupValid:()=>this.mutations.valid(startupOwner),valid:()=>this.mutations.valid(lifecycle)&&this.deps.sessionGenerations.get(session.id)===generation,repairConfiguration,executionDomain:`${session.source ?? 'local'}:${session.sourceId ?? ''}`} : undefined);
    let driver:AgentDriver;
    try {driver = this.deps.registry.create({ ...configured, model: options.model, reasoningEffort: options.reasoningEffort, permissionMode: options.permissionMode }, session, this.deps.onDriverEvent(session, generation), code => {
      if (!this.mutations.valid(lifecycle) || this.deps.sessionGenerations.get(session.id) !== generation) return;
      if (this.deps.registry.capabilities(session.protocol)?.persistentTerminal) this.deps.exitedDriverGenerations.set(session.id, generation);
      this.deps.notifyDriverExit(session.id, code);
      // An executing turn owns its result. A lifecycle exit never overwrites it.
      if (code && !this.mutations.attempts.has(session.id)) void this.mutations.run(lifecycle, () => this.deps.saveState(session, 'failed', `Agent exited with code ${code}`)).catch(error => this.deps.warnCaught('reconnect.saveExitState', session.id, error));
    }, nativeForkSessionId ? { ...resource.context, nativeForkSessionId } : resource.context);} catch(error) {
      if(resource.controlled){
        const cleanup=resource.controlled.abortFactory();this.factoryCleanups.set(session.id,cleanup);
        const release=()=>{if(this.factoryCleanups.get(session.id)===cleanup)this.factoryCleanups.delete(session.id);};
        void cleanup.then(release,release);
        try{await cleanup;}catch(failure){this.deps.warnCaught('reconnect.abortFactory',session.id,failure);}
      }
      this.mutations.check();throw error;
    }
    this.connectedDrivers.set(session.id, driver); this.missingTerminals.delete(session.id);
    let startBegan = false;
    try {
      this.deps.localResources.returned(resource, driver);
      // start() 前订阅来源观察。driverInstanceId 必须与 T2 anchor 严格一致：
      // controlled 是 lifecycle operation 行 id（context.driverInstanceId）；
      // local-only 是 local_only 子资源行 id（localOnlyDriverContext 传入的 resourceId，
      // 同样等于 context.driverInstanceId），不是资源 identity.identityId。
      this.mutations.run(lifecycle, () => this.deps.subscribeInsightSources(session, driver, generation, resource.context.driverInstanceId));
      if (start) {
        startBegan = true;
        const starting = Promise.resolve().then(() => driver.start());
        const settled = starting.then(async () => {
          this.deps.localResources.settled(driver);
          await this.mutations.run(undefined, () => this.mutations.write(session.id, async () => { this.deps.localResources.ready(driver); await this.deps.persistTerminalReceipt(session, driver); }));
          // 资源 created 事务提交后，flush 启动期 pending 的 launch/native 观察。
          this.deps.flushInsightSources(driver);
        }, error => { this.deps.localResources.settled(driver); throw error; });
        await this.driverOperation(driver, () => settled);
      } else this.deps.localResources.settled(driver);
      if(resource.controlled&&start&&!repairConfiguration) {
        const actual=this.deps.registry.method(driver, 'nativeConfiguration')?.();
        if(actual)resource.options={permissionMode:options.permissionMode,...actual};
        await this.deps.changeDriverConfiguration(session,driver,()=>options,undefined,true);
      }
      this.mutations.check(); this.touch(session.id); return driver;
    } catch (error) {
      if (!startBegan) this.deps.localResources.settled(driver);
      if (this.mutations.valid()) {
        const reason = 'Driver startup is unresolved; original resource cleanup must finish before replacement';
        this.stops.setDriver(session.id, { driver, reason }); await this.retainStopBlock(session.id, reason);
      }
      // reconnect may reject before its caller receives the original driver handle.
      // 启动失败的驱动当场核实退出：核实了就清掉阻塞，下一条消息重新拉起；核实不了交给后台复核，不让会话一直挡着。
      // 显式停止或重启撤销了这次启动时，驱动归那次停止处理，不排启动失败复核。
      const revoked = error instanceof RevokedOperation || !this.mutations.valid();
      await this.mutations.run(undefined,()=>this.stopDriver(session.id,driver,discardOnFailure)).catch(()=>{
        if(!revoked&&!this.deps.shuttingDown()&&this.stops.driver(session.id)?.driver===driver&&!this.stops.recheck(session.id))this.scheduleStopRecheck(session.id,driver,STOP_RECHECK_MS,new Date().toISOString(),'startup');
      });
      throw error;
    }
  }
  async driverOperation<T>(driver: AgentDriver, operation: () => Promise<T>) {
    this.mutations.check();
    return this.observeDriverOperation(driver, operation());
  }
  observeDriverOperation<T>(driver: AgentDriver, pending: Promise<T>) {
    const operations = this.driverOperations.get(driver) ?? new Set<Promise<unknown>>();
    operations.add(pending); this.driverOperations.set(driver, operations);
    const cleanup = () => { operations.delete(pending); if (!operations.size) { this.driverOperations.delete(driver); this.deps.wakeResourceQueues(); } };
    void pending.then(cleanup, cleanup);
    return this.mutations.wait(pending);
  }
  touch(sessionId: string) { this.lastActivity.set(sessionId, Date.now()); }
  nextSessionGeneration(sessionId: string) {
    const generation = (this.deps.sessionGenerations.get(sessionId) ?? 0) + 1;
    this.deps.sessionGenerations.set(sessionId, generation);
    return generation;
  }
  assertReplaceable(id: string) {
    this.mutations.check();
    const blocked = this.stops.block(id) ?? this.stops.driver(id);
    if (blocked) throw new RuntimeError('DRIVER_STOP_UNVERIFIED', blocked.reason, 409);
    if (this.stopRuns.has(id)) throw new RuntimeError('SESSION_STOPPING', 'Session cleanup is still running', 409);
  }
  async loadStopBlock(id: string) {
    const version = this.stops.version(id);
    const raw = await this.mutations.wait(() => this.deps.repos.config.get(runtimeStateKeys.driverStopBlock.key(id)));
    if (!raw || this.stops.version(id) !== version) return;
    let block: ReturnType<typeof runtimeStateKeys.driverStopBlock.read>;
    try {
      block = runtimeStateKeys.driverStopBlock.read(raw);
      if (block.sessionId !== id) throw new Error('invalid stop block');
    } catch { block = { sessionId: id, runId: '', reason: 'Persisted driver stop evidence is invalid; resource verification is required' }; }
    this.mutations.check(); this.stops.load(id, block);
  }
  async retainStopBlock(id: string, reason: string) {
    await this.mutations.write(id, async () => {
      const session = await this.deps.repos.sessions.get(id);
      this.mutations.check();
      const block = { sessionId: id, runId: session?.runId ?? '', reason };
      this.stops.setBlock(id, block);
      await this.deps.repos.config.set(runtimeStateKeys.driverStopBlock.key(id), JSON.stringify(block));
    });
  }
  private async clearStopBlock(id: string) {
    await this.mutations.write(id, async () => {
      if (this.stops.block(id)) await this.deps.repos.config.set(runtimeStateKeys.driverStopBlock.key(id), '');
      this.stops.setBlock(id); this.deps.wakeResourceQueues();
    });
  }
  async stopDriver(id: string, driver: AgentDriver, discardSession = false, shutdown = false) {
    const pending = this.driverStops.get(driver);
    if (pending) return pending;
    this.retiringDrivers.add(id);
    const stopping = this.stopDriverOnce(id,driver,discardSession,shutdown);
    this.driverStops.set(driver,stopping);
    try { await stopping; } finally {
      if (this.driverStops.get(driver) === stopping) this.driverStops.delete(driver);
      this.retiringDrivers.delete(id); this.deps.wakeResourceQueues();
      if (!this.deps.shuttingDown() && this.deps.claim()) this.mutations.run(undefined, () => this.deps.scheduleQueue(id));
    }
  }
  private async stopDriverOnce(id: string, driver: AgentDriver, discardSession = false, shutdown = false) {
    this.deps.localResources.get(driver)?.controlled?.revoke({ code: 'driver_stop', by: 'DutydeckRuntime.stopDriverOnce' });
    this.deps.unsubscribeInsightSources(driver);
    let stopError: unknown;
    try { await driver.stop(discardSession ? { discardSession: true } : undefined); } catch (error) { stopError = error; }
    while (this.driverOperations.get(driver)?.size) await Promise.allSettled([...this.driverOperations.get(driver)!]);
    if (shutdown && this.deps.registry.method(driver, 'isDetachedForShutdown')?.()) {
      if (this.drivers.get(id) === driver) this.connectedDrivers.delete(id);
      return;
    }
    let proven = false;
    try { proven = await this.deps.registry.method(driver, 'isStopped')?.() === true; } catch (error) { stopError ??= error; }
    if (!proven) {
      const reason = stopError instanceof Error ? stopError.message : 'Driver physical resource exit is unverified';
      this.stops.setDriver(id, { driver, reason }); await this.retainStopBlock(id, reason);
      throw new RuntimeError('DRIVER_STOP_UNVERIFIED', reason, 409);
    }
    await this.retireStoppedDriver(id, driver);
  }
  /** 驱动已证明原进程都已退出：资源记为已退出，清掉停止受阻。 */
  private async retireStoppedDriver(id: string, driver: AgentDriver) {
    await this.mutations.write(id, async () => this.deps.localResources.gone(driver));
    this.deps.localResources.retire(driver);
    this.deps.releaseSteeringDriver(driver);
    await this.clearStopBlock(id);
    if (this.drivers.get(id) === driver) this.connectedDrivers.delete(id);
    this.stops.setDriver(id); this.deps.wakeResourceQueues();
  }
  revokeSession(id: string, reason: RevocationReason, cancelQueue: boolean, state: 'stopped' | 'interrupted', shutdown = false, discardSession = false, beforeResourceCleanup?: Promise<void>, actor?: ExecutionActor): Promise<void> {
    this.deps.cancelCapacityTimer(id);
    const pending = this.stopRuns.get(id);
    if (pending) { if (cancelQueue) this.stopIntents.get(id)!.cancelQueue = true; if (actor) this.stopIntents.get(id)!.actor = actor; return pending; }
    const intent = { cancelQueue, actor };  this.stopIntents.set(id, intent);
    const token = this.mutations.attempts.get(id), ref = token && this.mutations.attemptRefs.get(token);
    const driver = this.drivers.get(id) ?? this.stops.driver(id)?.driver;
    const exitDrain = this.deps.registry.method(driver, 'drainExitedOutput')?.();
    const run = this.mutations.run(undefined, async () => {
      const drainError = exitDrain ? await this.deps.settleExitedDriver(id, driver, exitDrain) : undefined;
      this.mutations.owners.lifecycle(id).revoke(reason); token?.revoke(reason); this.mutations.drains.get(id)?.revoke(reason);
      this.nextSessionGeneration(id);
      // Start teardown before waiting for a turn which may be waiting on permission.
      const stopping = (async () => { await beforeResourceCleanup; await this.factoryCleanups.get(id); if (driver) await this.stopDriver(id, driver, discardSession, shutdown); })();
      // best-effort: observe early rejection until teardown awaits the same promise below.
      void stopping.catch(() => {});
      let factError: unknown;
      let actorRequired = false;
      let stoppedPermissions: PendingPermission[] = [];
      try {
      await this.deps.verifications.stopSession(id);
      await this.mutations.write(id, async () => {
        if (!shutdown) {
          const session = await this.deps.repos.sessions.get(id);
          if (session) for (const committed of this.deps.bound().cancelCapacityRetries(this.deps.fence(session), 'session_stopped_capacity_retry')) this.deps.wake(committed);
        }
        if (ref) {
          const attempt = this.deps.repos.execution.getAttempt(ref);
          if (attempt && !['settled', 'suspended'].includes(attempt.state)) {
            if (attempt.submissionState === 'not_submitted') {
              if (shutdown) this.deps.wake(this.deps.bound().suspendUnsubmitted(this.deps.attemptFence(ref)));
              else this.deps.wake(this.deps.bound().settleAttempt(this.deps.attemptFence(ref), `stop:${ref.attemptId}`, { kind: 'not_submitted', outcome: 'cancelled', reason: 'session_stop_before_submission' }));
            } else this.deps.wake(this.deps.bound().markReconcileRequired(this.deps.attemptFence(ref), { reasonId: `${shutdown ? 'daemon_shutdown' : 'stop_unknown'}:${ref.attemptId}:${this.deps.claim()!.generation}`, code: shutdown ? 'DAEMON_SHUTDOWN' : 'STOP_RESULT_UNKNOWN', evidenceRefs: [] }));
          }
        }
        if (intent.cancelQueue) actorRequired = !await this.deps.cancelSessionQueue(id, intent.actor);
        stoppedPermissions = this.deps.humanWaits().takeSessionPermissions(id);
      });
      } catch (error) { factError = error; }
      let stopError: unknown;
      try { await stopping; } catch (error) { stopError = error; }
      await this.deps.drainSessionEvents(id);
      if (!factError && intent.cancelQueue) actorRequired = !await this.mutations.write(id, () => this.deps.cancelSessionQueue(id, intent.actor));
      if (!shutdown && !discardSession) await this.deps.humanWaits().closeLeftoverPermissions(stoppedPermissions);
      await this.mutations.barrier(id);
      if (!shutdown && !stopError && !factError) {
        const session = await this.deps.repos.sessions.get(id);
        const unresolved = this.deps.repos.execution.getUnresolvedTasks(id).length > 0;
        if (session && !unresolved) await this.deps.saveState(session, state);
      }
      if (factError) throw factError;
      if (stopError) throw stopError;
      if (drainError) throw drainError;
      if (actorRequired) throw new RuntimeError('ACTOR_REQUIRED', 'Execution stopped; queued tasks remain until a named actor cancels them', 403);
    });
    this.stopRuns.set(id, run);
    const finish = () => { if (this.stopRuns.get(id) === run) this.stopRuns.delete(id); this.mutations.drains.delete(id); this.deps.wakeResourceQueues(); };
    void run.then(finish, finish); return run;
  }
  private readonly idleCpuWindows = new Map<string, { driver: AgentDriver; window: IdleCpuWindow }>();

  idleCpuBlocked(id: string, driver: AgentDriver): boolean {
    return this.deps.gate.reasons(id, 'idle_reclaim', { driver, firstOnly: true }).length > 0;
  }

  private async inspectIdleCpu(id: string, driver: AgentDriver, at: number): Promise<void> {
    const reset = () => { this.idleCpuWindows.delete(id); };
    if (!this.deps.registry.supports(driver, 'idleCpuProof') || !this.deps.registry.supports(driver, 'beginIdleCpuRetirement') || this.idleCpuBlocked(id, driver)
      || at - (this.lastActivity.get(id) ?? at) < IDLE_CPU_MIN_IDLE_MS) { reset(); return; }
    const session = await this.deps.repos.sessions.get(id);
    if (!session || session.archivedAt || !['idle', 'completed', 'interrupted'].includes(session.state)
      || this.idleCpuBlocked(id, driver)) { reset(); return; }
    const proof = driver.idleCpuProof();
    if (!proof || at - proof.lastInputAt < IDLE_CPU_MIN_IDLE_MS) { reset(); return; }
    let entry = this.idleCpuWindows.get(id);
    if (entry?.driver !== driver) { entry = { driver, window: new IdleCpuWindow() }; this.idleCpuWindows.set(id, entry); }
    const high = entry.window.sample(proof, proof.sampledAt);
    if (!high) return;
    const action = this.deps.options.driverIdleCpuAction ?? 'diagnose';
    if (high.report) this.deps.options.log?.warn({ sessionId: id, code: 'IDLE_CPU_HIGH', action, ratio: high.ratio },
      'An idle, resumable CLI is continuously using CPU');
    if (action !== 'retire') return;
    if (!this.deps.registry.supports(driver, 'prepareForIdleRetirement') || !await driver.prepareForIdleRetirement()) {
      this.deps.options.log?.info?.({ sessionId: id, code: 'IDLE_CPU_SKIPPED', reason: 'native-recovery-unprepared' }, 'Idle CPU retirement skipped');
      reset(); return;
    }
    const current = driver.idleCpuProof();
    if (!current || !sameIdleCpuProof(proof, current) || this.idleCpuBlocked(id, driver)) { reset(); return; }
    // No await between the final driver input fence and revoking the runtime
    // lifecycle. New terminal input or queued tasks cannot slip into teardown.
    if (!driver.beginIdleCpuRetirement(current)) { reset(); return; }
    reset();
    await this.finishIdleRetirement(id, driver, this.mutations.owners.lifecycle(id));
    this.deps.options.log?.info?.({ sessionId: id, code: this.drivers.get(id) === driver || this.stops.driver(id)?.driver === driver ? 'IDLE_CPU_EXIT_UNVERIFIED' : 'IDLE_CPU_RETIRED', ratio: high.ratio },
      'Idle CPU retirement finished');
  }

  async reclaimIdleDrivers(at: number) {
    const timeout = this.deps.options.driverIdleTimeoutMs ?? 6 * 60 * 60_000;
    for (const id of this.idleCpuWindows.keys()) if (!this.drivers.has(id)) this.idleCpuWindows.delete(id);
    if (this.deps.options.driverIdleCpuAction !== 'off') for (const [id, driver] of this.drivers) {
      try { await this.inspectIdleCpu(id, driver, at); }
      catch (error) { this.idleCpuWindows.delete(id); this.deps.options.log?.warn({ sessionId: id, code: 'IDLE_CPU_CHECK_FAILED', error }, 'Idle CPU check failed'); }
    }
    // 单个会话出错只跳过它自己：其余会话照常回收，结果未知提醒照常检查。
    if (timeout > 0) for (const [sessionId, driver] of this.drivers) {
      try { await this.retireIdleDriver(sessionId, driver, at, timeout); }
      catch (error) { this.deps.options.log?.warn({ sessionId, code: error instanceof RuntimeError ? error.code : 'IDLE_RETIREMENT_ERROR', error }, 'Idle driver check failed'); }
    }
  }
  private async retireIdleDriver(sessionId: string, driver: AgentDriver, at: number, timeout: number) {
    // Native background work counts as running for the restart drain too; it may stay silent past the timeout.
    // A stop-blocked driver belongs to its background recheck.
    if (this.mutations.attempts.has(sessionId) || this.stops.driver(sessionId) || this.deps.registry.method(driver, 'hasBackgroundWork')?.() || at - (this.lastActivity.get(sessionId) ?? at) < timeout) return;
    const lifecycle = this.mutations.owners.lifecycle(sessionId);
    const session = await this.deps.repos.sessions.get(sessionId);
    if (!session || this.drivers.get(sessionId) !== driver || this.mutations.owners.lifecycle(sessionId) !== lifecycle || this.mutations.attempts.has(sessionId) || this.deps.registry.method(driver, 'hasBackgroundWork')?.() || !['idle', 'completed', 'interrupted'].includes(session.state)) return;
    if (this.deps.registry.supports(driver, 'prepareForIdleRetirement') && !await driver.prepareForIdleRetirement()) {
      // 一直确认不了原生会话的多半卡在启动阶段，没有可续的上下文；原生记录留在磁盘上，回收只结束进程。
      const idleMs = at - (this.lastActivity.get(sessionId) ?? at);
      if (idleMs < timeout + IDLE_RETIREMENT_UNPREPARED_MS) return;
      this.deps.options.log?.warn({ sessionId, code: 'IDLE_RETIREMENT_UNPREPARED', idleMs }, 'Retiring an idle driver whose native session could not be confirmed');
    }
    if (this.drivers.get(sessionId) !== driver || this.mutations.attempts.has(sessionId) || this.deps.registry.method(driver, 'hasBackgroundWork')?.() || this.mutations.owners.lifecycle(sessionId) !== lifecycle) return;
    await this.finishIdleRetirement(sessionId, driver, lifecycle);
  }
  private async finishIdleRetirement(sessionId: string, driver: AgentDriver, lifecycle: Owner) {
    const reason = { code: 'idle_retirement', by: 'DutydeckRuntime.finishIdleRetirement' };
    const transition = this.mutations.owners.transition(sessionId, reason), startedAt = Date.now();
    try {
      try {
        await this.revokeSession(sessionId, reason, false, 'interrupted');
      } finally {
        // Reopen under the same transition before handling the stop evidence, without yielding.
        if (!this.deps.shuttingDown() && this.mutations.valid(transition) && this.mutations.owners.lifecycle(sessionId) === lifecycle) this.mutations.owners.renew(sessionId, transition);
      }
    } catch (error) {
      this.deps.options.log?.warn({ sessionId, code: error instanceof RuntimeError ? error.code : 'IDLE_RETIREMENT_FAILED', error, elapsedMs: Date.now() - startedAt },
        'Idle driver retirement could not verify process exit');
      if (!this.deps.shuttingDown() && this.stops.driver(sessionId)?.driver === driver) this.scheduleStopRecheck(sessionId, driver, STOP_RECHECK_MS, new Date().toISOString());
    }
  }
  scheduleStopRecheck(id: string, driver: AgentDriver, delay: number, since: string, cause: 'idle' | 'startup' = 'idle') {
    const timer = setTimeout(() => {
      void this.recheckStop(id, driver, delay, since, cause).catch(error => this.deps.warnCaught('recheckStop', id, error));
    }, delay);
    timer.unref?.();
    this.stops.setRecheck(id, { timer, since });
  }
  /**
   * 空闲回收或启动失败后退出未核实的复核：先用驱动已有的退出证明核实，核实不了才沿用停止重试再停一次
   * （上次停止可能根本没结束终端，例如忙碌的 tmux 会话）。证明原进程都已退出，就把资源记为已退出、清掉停止受阻，
   * 再重开会话；否则按退避继续复核。复核不撤销会话、不取消排队任务、不中止验证。
   * 第一次复核仍未通过时在会话里提醒一次；驱动报告退出永远无法核实时提醒需要人工核对，不再复核。
   */
  private async recheckStop(id: string, driver: AgentDriver, delay: number, since: string, cause: 'idle' | 'startup') {
    const entry = this.stops.recheck(id);
    if (entry?.since !== since) return;
    // 复核结束前一直保留条目：新消息照常收到 DRIVER_STOP_UNVERIFIED，探测挂住也不会让复核链断掉。
    // 改排下一次复核时条目已换成新的，结束时不会误删。
    try { await this.recheckStopOnce(id, driver, delay, since, cause); }
    finally { if (this.stops.recheck(id) === entry) this.stops.setRecheck(id); }
  }
  private async recheckStopOnce(id: string, driver: AgentDriver, delay: number, since: string, cause: 'idle' | 'startup') {
    if (this.deps.shuttingDown() || this.stops.driver(id)?.driver !== driver) return;
    // 每个 await 之后都可能已有显式停止、重启换了 transition、会话锁或驱动；只用探测前取得的 owner，失效就不再动这个会话。
    const token = this.mutations.owners.ownerOf(id), lifecycle = this.mutations.owners.lifecycle(id);
    const current = () => !this.deps.shuttingDown() && this.mutations.valid(token) && this.mutations.owners.lifecycle(id) === lifecycle && !this.stopRuns.has(id)
      && this.stops.driver(id)?.driver === driver && (this.drivers.get(id) ?? driver) === driver;
    const bounded = <T>(operation: () => Promise<T>) =>
      withTimeout(operation(), STOP_RECHECK_PROBE_MS, () => new RuntimeError('DRIVER_STOP_UNVERIFIED', 'Driver exit check timed out', 409));
    let error: unknown;
    try {
      // 探测在停止流程外：挂起时不占用 stopRuns，显式停止或重启不会排在它后面。
      const proven = await bounded(async () => await this.deps.registry.method(driver, 'isStopped')?.() === true).catch(failure => { this.deps.warnCaught('recheckStop.probeExit', id, failure); return false; });
      if (current()) {
        // 再停一次时驱动合并已有的退出证明，不会退回启动时的进程身份。
        await this.mutations.run(token, () => proven ? this.retireStoppedDriver(id, driver) : bounded(() => this.stopDriver(id, driver)));
        await this.mutations.run(token, async () => {
          const session = await this.deps.repos.sessions.get(id);
          if (cause === 'idle' && session && !this.deps.repos.execution.getUnresolvedTasks(id).length) await this.deps.saveState(session, 'interrupted');
          await this.deps.reopenQueue(id);
        });
        this.deps.options.log?.info?.({ sessionId: id, cause, blockedSince: since }, 'Driver exit verified on recheck; session reopened');
        return;
      }
    } catch (failure) { error = failure; }
    if (this.deps.shuttingDown() || this.stops.driver(id)?.driver !== driver) return;
    // 退出永远无法核实（例如看不到进程表）：不再承诺自动恢复。新消息照常排队，等恢复流程解除停止受阻后执行。
    const unverifiable = this.deps.registry.method(driver, 'stopUnverifiable')?.() === true;
    if (delay === STOP_RECHECK_MS || unverifiable) {
      this.deps.options.log?.warn({ sessionId: id, code: error instanceof RuntimeError ? error.code : 'DRIVER_STOP_UNVERIFIED', cause, blockedSince: since, unverifiable }, 'Driver exit is still unverified');
      const session = await this.deps.repos.sessions.get(id);
      const kind = unverifiable ? 'stop_unverifiable' : 'stop_unverified';
      if (session && this.stops.driver(id)?.driver === driver) await this.mutations.run(undefined, () => this.deps.notices.sessionNotice(session, { id: `notice_${digest([kind, id, since])}`, taskId: '', sessionIds: [id] }, { kind: 'stop_unverified', cause, unverifiable },
        { key: runtimeStateKeys.notice.key(kind, id), value: since })).catch(failure => this.deps.warnCaught('recheckStop.publishNotice', id, failure));
    }
    if (unverifiable) return;
    if (!this.deps.shuttingDown() && this.stops.driver(id)?.driver === driver) this.scheduleStopRecheck(id, driver, Math.min(delay * 2, STOP_RECHECK_MAX_MS), since, cause);
  }


  private readonly stops = new DriverStopState((driver, key) => this.deps.registry.method(driver, key));
  get stopFacts(): Pick<DriverStopState, 'block' | 'driver' | 'reason' | 'recheckingReason'> { return this.stops; }
  clearStopRechecks() { this.stops.clearRechecks(); }
  holdInterruptedDriver(id: string, driver: AgentDriver) {
    this.stops.setDriver(id, { driver, reason: 'Interrupted preparation is still closing its original driver' });
  }
  adopt(id: string, driver: AgentDriver) { this.connectedDrivers.set(id, driver); }
  clearDrivers() { this.connectedDrivers.clear(); }
  clearRecoveredStop(id: string) {
    this.stops.setBlock(id);
    this.connectedDrivers.delete(id);
    this.stops.setDriver(id);
    this.deps.wakeResourceQueues();
  }
}
