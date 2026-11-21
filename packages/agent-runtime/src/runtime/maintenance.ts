import { RuntimeError, runtimeStateKeys, sameIdleCpuProof, timeLoop, unknownTaskActionLabels, withTimeout, type AgentDriver, type ExecutionActor, type RepositoryBundle, type Session, type TaskAttempt, type TaskRecord } from '@dutydeck/shared';
import type { DutydeckRuntime, RuntimeOptions } from '../index.js';
import { digest } from '../digest.js';
import { IdleCpuWindow, IDLE_CPU_MIN_IDLE_MS } from '../idle-cpu.js';
import type { Owner, RevocationReason, RuntimeSessionMutations } from '../ownership.js';
import type { SessionGate } from '../session-gate.js';
import type { Notices } from './notices.js';

/** 空闲回收没能核实终端进程已退出时，隔这么久后台复核一次，之后每次加倍，最长隔 30 分钟。 */
export const STOP_RECHECK_MS = 45_000;
const STOP_RECHECK_MAX_MS = 30 * 60_000;
/** 一次复核里等驱动探测或再停一次的上限；超时按「还没证明退出」处理，照常排下一次复核。 */
const STOP_RECHECK_PROBE_MS = 30_000;
/** 空闲回收前确认不了原生会话的终端（比如卡在启动确认框），闲置超过回收时限再加这么久，就不再保留、照常回收。 */
const IDLE_RETIREMENT_UNPREPARED_MS = 18 * 60 * 60_000;
/** 结果未知的一轮开始超过这么久还没人处理，在原话题提醒一次怎么处理。 */
const UNKNOWN_TASK_REMIND_MS = 24 * 60 * 60_000;
/** 超过这么久仍没人处理、且能证明执行进程已退出时，自动按「结果未知、已放弃」结案。 */
const UNKNOWN_TASK_ABANDON_MS = 7 * 24 * 60 * 60_000;

interface MaintenanceDependencies {
  recoveryActor: ExecutionActor;
  repos: Pick<RepositoryBundle, 'sessions' | 'execution'>;
  options: Pick<RuntimeOptions, 'driverIdleTimeoutMs' | 'driverIdleCpuAction' | 'log'>;
  drivers: ReadonlyMap<string, AgentDriver>;
  lastActivity: ReadonlyMap<string, number>;
  notices: Notices;
  gate: SessionGate;
  hasAttempt(id: string): boolean;
  stopRunning(id: string): boolean;
  shuttingDown(): boolean;
  revokeSession(id: string, reason: RevocationReason, cancelQueue: boolean, state: 'interrupted'): Promise<void>;
  warnCaught(location: string, sessionId: string, error: unknown): void;
  retireStoppedDriver(id: string, driver: AgentDriver): Promise<void>;
  stopDriver(id: string, driver: AgentDriver): Promise<void>;
  saveState(session: Session, state: Session['state']): Promise<void>;
  reopenQueue(id: string): Promise<void>;
  recoveryInFlight(id: string): boolean;
  queuedTasks(id: string): Promise<TaskRecord[]>;
  active(id: string): Promise<{session: Session}>;
  observeAbandonedResources(session: Session): Promise<void>;
  retireDetachedPty(session: Session): Promise<string[]>;
  clearVerifiedStopBlock(session: Session): Promise<boolean>;
  inspectExecutionRecovery: DutydeckRuntime['inspectExecutionRecovery'];
  confirmExecutionRecovery: DutydeckRuntime['confirmExecutionRecovery'];
}

export class Maintenance {
  /** 自动结案没做成的结果未知执行，每个进程只记一次日志。 */
  private readonly unknownTaskFailures = new Set<string>();
  /** 自动结案条件还不满足（进程没证明退出、有排队）的执行，下次再核对的时间；只在进程内，避免每轮维护都去探测终端。 */
  private readonly unknownTaskRecheckAt = new Map<string, number>();
  private cleanupTimer?: NodeJS.Timeout;
  private cleanupRun?: Promise<void>;

  constructor(private readonly mutations: RuntimeSessionMutations, private readonly deps: MaintenanceDependencies) {}

  get currentRun() { return this.cleanupRun; }
  stopTimer() { if (this.cleanupTimer) clearInterval(this.cleanupTimer); }
  startTimer(interval: number, ready: () => boolean, tick: () => Promise<void>) {
    // 通用闲置回收、空闲 CPU 检查和结果未知任务的提醒、老化结案共用这个维护循环。
    if (interval > 0) {
      this.cleanupTimer = setInterval(() => { if (ready()) void timeLoop('runtime.cleanup-idle-drivers', this.deps.options.log, tick).catch(error => {
        this.deps.options.log?.warn({ code: error instanceof RuntimeError ? error.code : 'RUNTIME_MAINTENANCE_FAILED', error }, 'Runtime maintenance loop failed');
      }); }, interval);
      this.cleanupTimer.unref();
    }
  }

  private readonly idleCpuWindows = new Map<string, { driver: AgentDriver; window: IdleCpuWindow }>();

  idleCpuBlocked(id: string, driver: AgentDriver): boolean {
    return this.deps.gate.reasons(id, 'idle_reclaim', { driver, firstOnly: true }).length > 0;
  }

  private async inspectIdleCpu(id: string, driver: AgentDriver, at: number): Promise<void> {
    const reset = () => { this.idleCpuWindows.delete(id); };
    if (!driver.idleCpuProof || !driver.beginIdleCpuRetirement || this.idleCpuBlocked(id, driver)
      || at - (this.deps.lastActivity.get(id) ?? at) < IDLE_CPU_MIN_IDLE_MS) { reset(); return; }
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
    if (!driver.prepareForIdleRetirement || !await driver.prepareForIdleRetirement()) {
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
    this.deps.options.log?.info?.({ sessionId: id, code: this.deps.drivers.get(id) === driver || this.deps.gate.stops.driver(id)?.driver === driver ? 'IDLE_CPU_EXIT_UNVERIFIED' : 'IDLE_CPU_RETIRED', ratio: high.ratio },
      'Idle CPU retirement finished');
  }

  private async cleanupIdleDriversOnce(at: number) {
    const timeout = this.deps.options.driverIdleTimeoutMs ?? 6 * 60 * 60_000;
    for (const id of this.idleCpuWindows.keys()) if (!this.deps.drivers.has(id)) this.idleCpuWindows.delete(id);
    if (this.deps.options.driverIdleCpuAction !== 'off') for (const [id, driver] of this.deps.drivers) {
      try { await this.inspectIdleCpu(id, driver, at); }
      catch (error) { this.idleCpuWindows.delete(id); this.deps.options.log?.warn({ sessionId: id, code: 'IDLE_CPU_CHECK_FAILED', error }, 'Idle CPU check failed'); }
    }
    // 单个会话出错只跳过它自己：其余会话照常回收，结果未知提醒照常检查。
    if (timeout > 0) for (const [sessionId, driver] of this.deps.drivers) {
      try { await this.retireIdleDriver(sessionId, driver, at, timeout); }
      catch (error) { this.deps.options.log?.warn({ sessionId, code: error instanceof RuntimeError ? error.code : 'IDLE_RETIREMENT_ERROR', error }, 'Idle driver check failed'); }
    }
    await this.reviewUnknownTasks(at);
  }
  private async retireIdleDriver(sessionId: string, driver: AgentDriver, at: number, timeout: number) {
    // Native background work counts as running for the restart drain too; it may stay silent past the timeout.
    // A stop-blocked driver belongs to its background recheck.
    if (this.deps.hasAttempt(sessionId) || this.deps.gate.stops.driver(sessionId) || driver.hasBackgroundWork?.() || at - (this.deps.lastActivity.get(sessionId) ?? at) < timeout) return;
    const lifecycle = this.mutations.owners.lifecycle(sessionId);
    const session = await this.deps.repos.sessions.get(sessionId);
    if (!session || this.deps.drivers.get(sessionId) !== driver || this.mutations.owners.lifecycle(sessionId) !== lifecycle || this.deps.hasAttempt(sessionId) || driver.hasBackgroundWork?.() || !['idle', 'completed', 'interrupted'].includes(session.state)) return;
    if (driver.prepareForIdleRetirement && !await driver.prepareForIdleRetirement()) {
      // 一直确认不了原生会话的多半卡在启动阶段，没有可续的上下文；原生记录留在磁盘上，回收只结束进程。
      const idleMs = at - (this.deps.lastActivity.get(sessionId) ?? at);
      if (idleMs < timeout + IDLE_RETIREMENT_UNPREPARED_MS) return;
      this.deps.options.log?.warn({ sessionId, code: 'IDLE_RETIREMENT_UNPREPARED', idleMs }, 'Retiring an idle driver whose native session could not be confirmed');
    }
    if (this.deps.drivers.get(sessionId) !== driver || this.deps.hasAttempt(sessionId) || driver.hasBackgroundWork?.() || this.mutations.owners.lifecycle(sessionId) !== lifecycle) return;
    await this.finishIdleRetirement(sessionId, driver, lifecycle);
  }
  private async finishIdleRetirement(sessionId: string, driver: AgentDriver, lifecycle: Owner) {
    const reason = { code: 'idle_retirement', by: 'DutydeckRuntime.finishIdleRetirement' };
    const transition = this.mutations.owners.transition(sessionId, reason), startedAt = Date.now();
    try {
      try {
        await this.deps.revokeSession(sessionId, reason, false, 'interrupted');
      } finally {
        // Reopen under the same transition before handling the stop evidence, without yielding.
        if (!this.deps.shuttingDown() && this.mutations.valid(transition) && this.mutations.owners.lifecycle(sessionId) === lifecycle) this.mutations.owners.renew(sessionId, transition);
      }
    } catch (error) {
      this.deps.options.log?.warn({ sessionId, code: error instanceof RuntimeError ? error.code : 'IDLE_RETIREMENT_FAILED', error, elapsedMs: Date.now() - startedAt },
        'Idle driver retirement could not verify process exit');
      if (!this.deps.shuttingDown() && this.deps.gate.stops.driver(sessionId)?.driver === driver) this.scheduleStopRecheck(sessionId, driver, STOP_RECHECK_MS, new Date().toISOString());
    }
  }
  scheduleStopRecheck(id: string, driver: AgentDriver, delay: number, since: string, cause: 'idle' | 'startup' = 'idle') {
    const timer = setTimeout(() => {
      void this.recheckStop(id, driver, delay, since, cause).catch(error => this.deps.warnCaught('recheckStop', id, error));
    }, delay);
    timer.unref?.();
    this.deps.gate.stops.setRecheck(id, { timer, since });
  }
  /**
   * 空闲回收或启动失败后退出未核实的复核：先用驱动已有的退出证明核实，核实不了才沿用停止重试再停一次
   * （上次停止可能根本没结束终端，例如忙碌的 tmux 会话）。证明原进程都已退出，就把资源记为已退出、清掉停止受阻，
   * 再重开会话；否则按退避继续复核。复核不撤销会话、不取消排队任务、不中止验证。
   * 第一次复核仍未通过时在会话里提醒一次；驱动报告退出永远无法核实时提醒需要人工核对，不再复核。
   */
  private async recheckStop(id: string, driver: AgentDriver, delay: number, since: string, cause: 'idle' | 'startup') {
    const entry = this.deps.gate.stops.recheck(id);
    if (entry?.since !== since) return;
    // 复核结束前一直保留条目：新消息照常收到 DRIVER_STOP_UNVERIFIED，探测挂住也不会让复核链断掉。
    // 改排下一次复核时条目已换成新的，结束时不会误删。
    try { await this.recheckStopOnce(id, driver, delay, since, cause); }
    finally { if (this.deps.gate.stops.recheck(id) === entry) this.deps.gate.stops.setRecheck(id); }
  }
  private async recheckStopOnce(id: string, driver: AgentDriver, delay: number, since: string, cause: 'idle' | 'startup') {
    if (this.deps.shuttingDown() || this.deps.gate.stops.driver(id)?.driver !== driver) return;
    // 每个 await 之后都可能已有显式停止、重启换了 transition、会话锁或驱动；只用探测前取得的 owner，失效就不再动这个会话。
    const token = this.mutations.owners.ownerOf(id), lifecycle = this.mutations.owners.lifecycle(id);
    const current = () => !this.deps.shuttingDown() && this.mutations.valid(token) && this.mutations.owners.lifecycle(id) === lifecycle && !this.deps.stopRunning(id)
      && this.deps.gate.stops.driver(id)?.driver === driver && (this.deps.drivers.get(id) ?? driver) === driver;
    const bounded = <T>(operation: () => Promise<T>) =>
      withTimeout(operation(), STOP_RECHECK_PROBE_MS, () => new RuntimeError('DRIVER_STOP_UNVERIFIED', 'Driver exit check timed out', 409));
    let error: unknown;
    try {
      // 探测在停止流程外：挂起时不占用 stopRuns，显式停止或重启不会排在它后面。
      const proven = await bounded(async () => await driver.isStopped?.() === true).catch(failure => { this.deps.warnCaught('recheckStop.probeExit', id, failure); return false; });
      if (current()) {
        // 再停一次时驱动合并已有的退出证明，不会退回启动时的进程身份。
        await this.mutations.run(token, () => proven ? this.deps.retireStoppedDriver(id, driver) : bounded(() => this.deps.stopDriver(id, driver)));
        await this.mutations.run(token, async () => {
          const session = await this.deps.repos.sessions.get(id);
          if (cause === 'idle' && session && !this.deps.repos.execution.getUnresolvedTasks(id).length) await this.deps.saveState(session, 'interrupted');
          await this.deps.reopenQueue(id);
        });
        this.deps.options.log?.info?.({ sessionId: id, cause, blockedSince: since }, 'Driver exit verified on recheck; session reopened');
        return;
      }
    } catch (failure) { error = failure; }
    if (this.deps.shuttingDown() || this.deps.gate.stops.driver(id)?.driver !== driver) return;
    // 退出永远无法核实（例如看不到进程表）：不再承诺自动恢复。新消息照常排队，等恢复流程解除停止受阻后执行。
    const unverifiable = driver.stopUnverifiable?.() === true;
    if (delay === STOP_RECHECK_MS || unverifiable) {
      this.deps.options.log?.warn({ sessionId: id, code: error instanceof RuntimeError ? error.code : 'DRIVER_STOP_UNVERIFIED', cause, blockedSince: since, unverifiable }, 'Driver exit is still unverified');
      const session = await this.deps.repos.sessions.get(id);
      const kind = unverifiable ? 'stop_unverifiable' : 'stop_unverified';
      if (session && this.deps.gate.stops.driver(id)?.driver === driver) await this.mutations.run(undefined, () => this.deps.notices.sessionNotice(session, { id: `notice_${digest([kind, id, since])}`, kind: 'stop_unverified', taskId: '', sessionIds: [id],
        message: unverifiable ? '这个会话的 Agent 进程没法确认是否已经退出，后台不会再自动复核。新消息会先排队，请管理员核对进程后在执行恢复里解除。'
          : cause === 'startup' ? '这个会话启动 Agent 失败后，没能确认启动到一半的进程已经退出，暂时不能接新消息。后台会定时复核，确认退出后自动恢复。'
          : '这个会话闲置关闭时，没能确认它的终端进程已经退出，暂时不能接新消息。后台会定时复核，确认退出后自动恢复。' },
        { key: runtimeStateKeys.notice.key(kind, id), value: since })).catch(failure => this.deps.warnCaught('recheckStop.publishNotice', id, failure));
    }
    if (unverifiable) return;
    if (!this.deps.shuttingDown() && this.deps.gate.stops.driver(id)?.driver === driver) this.scheduleStopRecheck(id, driver, Math.min(delay * 2, STOP_RECHECK_MAX_MS), since, cause);
  }

  /**
   * 结果未知、没人处理的执行：开始超过 24 小时在原话题提醒一次怎么处理；超过 7 天且能证明执行进程已退出时，
   * 按「结果未知、已放弃」结案（不重试、不算成功，决定和证据记进账本），再提醒一次。结案不了的留给人处理，每个进程只记一次日志。
   */
  private async reviewUnknownTasks(at: number) {
    for (const attempt of this.deps.repos.execution.getReconcileRequiredAttempts()) {
      if (this.deps.shuttingDown()) return;
      const age = at - Date.parse(attempt.createdAt);
      if (!(age >= UNKNOWN_TASK_REMIND_MS)) continue;
      try {
        const session = await this.deps.repos.sessions.get(attempt.sessionId);
        if (!session || session.archivedAt) continue;
        await this.mutations.run(undefined, async () => {
          const due = age >= UNKNOWN_TASK_ABANDON_MS && (this.unknownTaskRecheckAt.get(attempt.attemptId) ?? 0) <= at;
          const abandoned = due && await this.abandonUnknownAttempt(session, attempt);
          if (due && !abandoned) this.unknownTaskRecheckAt.set(attempt.attemptId, at + 60 * 60_000);
          if (abandoned) {
            await this.deps.notices.sessionNotice(session, { id: `notice_${digest(['unknown_task_abandoned', attempt.attemptId])}`, kind: 'unknown_task_abandoned', taskId: attempt.taskId, attemptId: attempt.attemptId, sessionIds: [session.id],
              message: '这一轮的结果未知，超过 7 天没人处理，执行它的进程也已确认退出。Dutydeck 已按「结果未知、已放弃」结案：没有重做，也不算完成，不再挡住同一仓库的其他任务。\n\n还需要做的话，请重新发一条消息。' },
              { key: runtimeStateKeys.notice.key('unknown_task_abandoned', attempt.attemptId), value: 'sent' });
            return;
          }
          const labels = unknownTaskActionLabels;
          await this.deps.notices.sessionNotice(session, { id: `notice_${digest(['unknown_task_overdue', attempt.attemptId])}`, kind: 'unknown_task_overdue', taskId: attempt.taskId, attemptId: attempt.attemptId, sessionIds: [session.id],
            message: ['这一轮的结果未知，已经超过 24 小时没人处理。它会挡住这个会话后面的消息，也会挡住同一仓库里其他会话的任务。',
              `处理方法：在 Web 打开这个会话，在执行记录下方选「${labels.retry}」「${labels.completed}」或「${labels.failed}」；原话题里如果有「结果未知」提醒卡，也可以直接点。`,
              '超过 7 天仍没人处理、且确认执行它的进程已退出时，Dutydeck 会自动按「结果未知、已放弃」结案，不会重做。'].join('\n\n') },
            { key: runtimeStateKeys.notice.key('unknown_task_overdue', attempt.attemptId), value: 'sent' });
        });
      } catch (error) {
        this.unknownTaskRecheckAt.set(attempt.attemptId, at + 60 * 60_000);
        if (this.unknownTaskFailures.has(attempt.attemptId)) continue;
        this.unknownTaskFailures.add(attempt.attemptId);
        this.deps.options.log?.warn({ sessionId: attempt.sessionId, taskId: attempt.taskId, attemptId: attempt.attemptId, error }, 'Result-unknown task review failed');
      }
    }
  }
  /**
   * 按「结果未知、已放弃」结案，走人工核对同一组账本原语。只在执行进程已证明退出时做：这个进程里没有连着的驱动，
   * 上一个进程留下的进程资源经观测已退出，PTY 终端记录按 retireDetachedPty 的判据回收，最后没有任何未证明退出的资源。
   * 会话还有排队的消息时不结案（结案后它们会马上开始执行），留给人决定。
   */
  private async abandonUnknownAttempt(session: Session, attempt: TaskAttempt) {
    const id = session.id;
    if (this.deps.drivers.has(id) || this.deps.gate.stops.driver(id) || this.deps.recoveryInFlight(id) || (await this.deps.queuedTasks(id)).length) return false;
    const retired = await this.mutations.run(this.mutations.owners.ownerOf(id), async () => {
      const { session: current } = await this.deps.active(id);
      if (current.runId !== attempt.runId) return undefined;
      await this.deps.observeAbandonedResources(current);
      const refs = await this.deps.retireDetachedPty(current);
      await this.deps.clearVerifiedStopBlock(current);
      return refs;
    });
    if (!retired) return false;
    const inspection = await this.deps.inspectExecutionRecovery(id, this.deps.recoveryActor);
    const current = inspection.tasks.find(task => task.taskId === attempt.taskId)?.attempt;
    if (current?.attemptId !== attempt.attemptId || current.state !== 'reconcile_required' || inspection.blockers.length || inspection.stopBlock) return false;
    await this.deps.confirmExecutionRecovery(id, { runId: inspection.runId, taskId: attempt.taskId, attemptId: attempt.attemptId, expectedRevision: current.revision,
      decisionId: `unknown_task_expired:${attempt.attemptId}`, action: 'confirm_result', outcome: 'unknown',
      evidenceRefs: [`unknown_task_started:${attempt.createdAt}`, 'unknown_task_unattended:7d', ...retired], resourceChecks: inspection.resourceChecks }, this.deps.recoveryActor);
    return true;
  }

  async cleanupIdleDrivers(at = Date.now()) {
    if (this.cleanupRun) return this.cleanupRun;
    const run = this.cleanupIdleDriversOnce(at); this.cleanupRun = run;
    try { await run; } finally { if (this.cleanupRun === run) this.cleanupRun = undefined; }
  }
}
