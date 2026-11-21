import { RuntimeError, runtimeStateKeys, timeLoop, unknownTaskActionLabels, type AgentDriver, type ExecutionActor, type RepositoryBundle, type Session, type TaskAttempt, type TaskRecord } from '@dutydeck/shared';
import type { DutydeckRuntime, RuntimeOptions } from '../index.js';
import { digest } from '../digest.js';
import type { RuntimeSessionMutations } from '../ownership.js';
import type { SessionGate } from '../session-gate.js';
import type { Notices } from './notices.js';

/** 结果未知的一轮开始超过这么久还没人处理，在原话题提醒一次怎么处理。 */
const UNKNOWN_TASK_REMIND_MS = 24 * 60 * 60_000;
/** 超过这么久仍没人处理、且能证明执行进程已退出时，自动按「结果未知、已放弃」结案。 */
const UNKNOWN_TASK_ABANDON_MS = 7 * 24 * 60 * 60_000;

interface MaintenanceDependencies {
  reclaimIdleDrivers(at: number): Promise<void>;
  recoveryActor: ExecutionActor;
  repos: Pick<RepositoryBundle, 'sessions' | 'execution'>;
  options: Pick<RuntimeOptions, 'driverIdleTimeoutMs' | 'driverIdleCpuAction' | 'log'>;
  drivers: ReadonlyMap<string, AgentDriver>;
  notices: Notices;
  gate: SessionGate;
  shuttingDown(): boolean;
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

  private async cleanupIdleDriversOnce(at: number) {
    await this.deps.reclaimIdleDrivers(at);
    await this.reviewUnknownTasks(at);
  }

  async cleanupIdleDrivers(at = Date.now()) {
    if (this.cleanupRun) return this.cleanupRun;
    const run = this.cleanupIdleDriversOnce(at); this.cleanupRun = run;
    try { await run; } finally { if (this.cleanupRun === run) this.cleanupRun = undefined; }
  }
}
