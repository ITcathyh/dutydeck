import type { AutomationScheduler } from './scheduler.js';
import {
  ciSubscriptionSchema,
  ciSubscriptionV2Schema,
  readStoredSessionSchedule,
  readTaskReport,
  RuntimeError,
  sessionScheduleOccurrenceSchema,
  sessionScheduleOccurrenceV2Schema,
  type AttemptResultV1,
  type AutomationBlockReason,
  type CiSubscription,
  type CiSubscriptionV2,
  type SessionSchedule,
  type SessionScheduleOccurrence,
  type SessionScheduleOccurrenceV2
} from '@dutydeck/shared';
import { observeAdmittedTask } from '../task-results.js';
import {
  CI_BINDING_GENERATION,
  CI_PREFIX,
  ciKey,
  ciRequestKey,
  errorMessage,
  iso,
  legacyAdmission,
  migrateCi,
  migrateOccurrence,
  OCCURRENCE_PREFIX,
  occurrenceKey,
  openRunStatuses,
  resolveAutomationActor,
  SCHEDULE_PREFIX,
  scheduleKey,
  scheduleRequestKey,
  type TickParseCache
} from './store.js';
import { scheduleTaskPrompt } from './occurrence-runner.js';

interface ReconcileOutcome {
  status: 'pending' | 'cancelled' | 'settled' | 'blocked';
  result?: AttemptResultV1;
  reason?: AutomationBlockReason;
  message?: string;
}

type Dependencies = Pick<AutomationScheduler,
  'ci' | 'clock' | 'closed' | 'delivery' | 'isolate' | 'occurrences' | 'options' | 'store'>;

export class AutomationRecovery {
  constructor(private readonly automation: Dependencies) {}

  /** 固定 number=1 Attempt 后读取唯一权威结果；不跟随 currentAttempt，不把 unknown 当 failed。 */
  private reconcileAdmission(sessionId: string, value: { admission?: SessionScheduleOccurrenceV2['admission']; runtimeAttemptId?: string }): ReconcileOutcome {
    const admission = value.admission;
    if (!admission) return { status: 'blocked', reason: 'admission_conflict', message: 'Source has no fixed task admission' };
    let read;
    try { read = observeAdmittedTask(this.automation.store.execution, sessionId, admission.taskId, value.runtimeAttemptId, admission); }
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

  async refreshAcceptedWork(parsed: TickParseCache) {
    // 已结算的历史不再变化（结果投递另按投递状态扫描）：每个 tick 只读还可能推进的记录，开销不随历史增长。
    const [occurrences, subscriptions, records] = await Promise.all([
      this.automation.store.listRecords(OCCURRENCE_PREFIX, value => sessionScheduleOccurrenceSchema.parse(value), parsed.occurrences, { field: 'runStatus', values: [...openRunStatuses, 'error'] }),
      this.automation.store.listRecords(CI_PREFIX, value => ciSubscriptionSchema.parse(value), parsed.subscriptions, { field: 'status', values: ['waiting', 'dispatching', 'accepted', 'blocked', 'error'] }),
      this.automation.store.listRecords(SCHEDULE_PREFIX, readStoredSessionSchedule)
    ]);
    const schedules = new Map(records.map(item => [item.value.id, item]));
    for (const item of occurrences) {
      if (this.automation.closed) return;
      await this.automation.isolate(() => this.refreshOccurrence(item, schedules));
    }
    for (const item of subscriptions) {
      if (this.automation.closed) return;
      await this.automation.isolate(() => this.refreshCi(item));
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
      const accepted = this.automation.store.execution.getAcceptedTask(value.taskId);
      if (!accepted) return undefined;
      if (accepted.task.sessionId !== (value.executionSessionId ?? value.sessionId)) {
        const blocked = sessionScheduleOccurrenceV2Schema.parse({ ...value, schemaVersion: 2, revision: value.revision + 1, runStatus: 'blocked', blockReason: 'admission_conflict', error: 'Accepted task belongs to another session', delivery: this.automation.delivery.undelivered(value.delivery), updatedAt: iso(this.automation.clock()) });
        await this.automation.store.replace(occurrenceKey(value.id), item.raw, blocked);
        return { raw: JSON.stringify(blocked), value: blocked };
      }
      const admission = legacyAdmission(accepted, value.taskId);
      const fixed = sessionScheduleOccurrenceV2Schema.parse({ ...value, schemaVersion: 2, revision: value.revision + 1, admission, updatedAt: iso(this.automation.clock()) });
      if (!(await this.automation.store.replace(occurrenceKey(value.id), item.raw, fixed))) return undefined;
      return { raw: JSON.stringify(fixed), value: fixed };
    }
    // 若 V1 来源没有 taskId（接受响应丢失或旧版未记），通过 lookupAccepted 查找已存在的接受事实
    const scheduleStored = schedules.get(value.scheduleId);
    if (value.workItemId || scheduleStored?.value.workTemplate) return undefined;
    if (scheduleStored) {
      const session = await this.automation.options.runtime.getSession(value.sessionId);
      const actor = resolveAutomationActor(session, scheduleStored.value.actorId);
      if (session && actor) {
        const candidateRequest = this.automation.occurrences.buildRequest(session, 'schedule', scheduleRequestKey(value.id), scheduleTaskPrompt(scheduleStored.value), actor);
        let accepted;
        try { accepted = this.automation.store.execution.lookupAccepted(candidateRequest); }
        catch (error) {
          const blocked = sessionScheduleOccurrenceV2Schema.parse({ ...value, revision: value.revision + 1, runStatus: 'blocked', blockReason: 'admission_conflict',
            error: errorMessage(error), delivery: this.automation.delivery.undelivered(value.delivery) });
          if (!await this.automation.store.replace(occurrenceKey(value.id), item.raw, blocked)) return undefined;
          return { raw: JSON.stringify(blocked), value: blocked };
        }
        if (accepted && accepted.task.sessionId === value.sessionId) {
          // A concurrently edited definition must be reconsidered with its new request on the next tick.
          if (await this.automation.options.repositories.config.get(scheduleKey(value.scheduleId)) !== scheduleStored.raw) return undefined;
          const admission = legacyAdmission(accepted);
          const fixed = sessionScheduleOccurrenceV2Schema.parse({
            ...value,
            schemaVersion: 2,
            revision: value.revision + 1,
            taskId: accepted.task.id,
            admission,
            actor,
            updatedAt: iso(this.automation.clock())
          });
          if (await this.automation.store.replace(occurrenceKey(value.id), item.raw, fixed)) {
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
      const accepted = this.automation.store.execution.getAcceptedTask(value.taskId);
      if (!accepted) return undefined;
      if (accepted.task.sessionId !== value.sessionId) {
        const blocked = ciSubscriptionV2Schema.parse({ ...value, schemaVersion: 2, revision: value.revision + 1, status: 'blocked', error: 'Accepted task belongs to another session', delivery: this.automation.delivery.undelivered(value.delivery), updatedAt: iso(this.automation.clock()) });
        await this.automation.store.replace(ciKey(value.id), item.raw, blocked);
        return { raw: JSON.stringify(blocked), value: blocked };
      }
      const admission = legacyAdmission(accepted, value.taskId);
      const fixed = ciSubscriptionV2Schema.parse({ ...value, schemaVersion: 2, revision: value.revision + 1, admission, updatedAt: iso(this.automation.clock()) });
      if (!(await this.automation.store.replace(ciKey(value.id), item.raw, fixed))) return undefined;
      return { raw: JSON.stringify(fixed), value: fixed };
    }
    const session = await this.automation.options.runtime.getSession(value.sessionId);
    const actor = resolveAutomationActor(session, value.actorId);
    if (session && actor && value.dispatchPrompt) {
      const candidateRequest = this.automation.occurrences.buildRequest(session, 'automation', ciRequestKey(value.id), value.dispatchPrompt, actor);
      let accepted;
      try { accepted = this.automation.store.execution.lookupAccepted(candidateRequest); } catch { /* conflict */ }
      if (accepted && accepted.task.sessionId === value.sessionId) {
        const admission = legacyAdmission(accepted);
        const fixed = ciSubscriptionV2Schema.parse({
          ...value,
          schemaVersion: 2,
          revision: value.revision + 1,
          taskId: accepted.task.id,
          admission,
          actor,
          updatedAt: iso(this.automation.clock())
        });
        if (await this.automation.store.replace(ciKey(value.id), item.raw, fixed)) {
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
    if (['pending', 'error'].includes(fixed.value.runStatus) && !this.automation.store.execution.getAcceptedTask(fixed.value.admission.taskId)) return;
    let working = fixed;
    let value = working.value;

    // 双 KV 中断恢复：来源已固定 admission 且接受事实存在，但第二授权 KV 丢失时，幂等补回同一 binding。
    const fixedAdmission = fixed.value.admission;
    if (this.automation.store.execution.getAcceptedTask(fixedAdmission.taskId)) {
      try {
        await this.automation.store.ensureTaskBinding(fixedAdmission.taskId, {
          schemaVersion: 2, kind: 'schedule', sessionId: fixed.value.executionSessionId ?? fixed.value.sessionId, occurrenceId: fixed.value.id,
          scheduleId: fixed.value.scheduleId, taskId: fixedAdmission.taskId, taskIdVersion: fixedAdmission.taskIdVersion, generation: fixed.value.generation
        });
      } catch (err) {
        await this.automation.occurrences.finishOccurrence(working, { runStatus: 'blocked', blockReason: 'admission_conflict', error: errorMessage(err) });
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
      const projection = this.automation.store.execution.getTaskExecutionState(value.admission!.taskId);
      const first = projection?.attempts.find(attempt => attempt.number === 1);
      if (first) {
        const fixedAttempt = sessionScheduleOccurrenceV2Schema.parse({ ...value, revision: value.revision + 1, runtimeAttemptId: first.attemptId, updatedAt: iso(this.automation.clock()) });
        if (await this.automation.store.replace(occurrenceKey(value.id), working.raw, fixedAttempt)) working = { raw: JSON.stringify(fixedAttempt), value: fixedAttempt };
        else return;
        value = working.value;
      }
    }
    const outcome = this.reconcileAdmission(value.executionSessionId ?? value.sessionId, value);
    if (outcome.status === 'pending') return;
    if (outcome.status === 'blocked') {
      if (working.value.runStatus !== 'blocked') {
        await this.automation.occurrences.finishOccurrence(working, {
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
        await this.automation.occurrences.finishOccurrence(working, {
          runStatus: 'interrupted',
          error: 'Selected task was cancelled before execution',
          delivery: this.automation.delivery.undelivered(working.value.delivery)
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
        const report = await readTaskReport(this.automation.options.repositories.config, result.taskId).catch(() => undefined);
        if (report?.status === 'blocked' || report?.status === 'waiting') {
          runStatus = 'failed';
          problem = { key: `report:${report.status}`, kind: 'result', reason: report.status === 'waiting' ? `等你决定：${report.question}` : `受阻：${report.summary}` };
        }
      } else if (runStatus === 'failed') problem = { key: 'result:failed', kind: 'result', reason: '执行失败' };
      const streak = runStatus !== 'interrupted' && value.triggerSource !== 'manual' ? await this.automation.occurrences.recordOutcome(value, problem) : undefined;
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
        ...(recoverLegacyCapacity && working.value.delivery.status === 'not_requested' && this.automation.options.deliver
          ? { delivery: { status: 'pending', attempts: working.value.delivery.attempts, updatedAt: iso(this.automation.clock()) } } : {}),
        ...(result.outcome === 'cancelled' ? { delivery: this.automation.delivery.undelivered(working.value.delivery) } : {}),
        // 同因第 2 次起不再另发结果卡，由 sendRunNotice 改上一条。
        ...(streak && streak.count > 1 && working.value.delivery.status !== 'delivered' ? { delivery: this.automation.delivery.undelivered(working.value.delivery) } : {}),
        updatedAt: iso(this.automation.clock())
      });
      if (!await this.automation.store.replace(occurrenceKey(value.id), working.raw, settled)) return;
    } else if (!working.value.result) {
      // 旧 pending/error 终态缺可靠结果：blocked，不重造 pending。
      if (['pending', 'error'].includes(working.value.runStatus)) {
        await this.automation.occurrences.finishOccurrence(working, { runStatus: 'blocked', blockReason: 'legacy_output_unresolved', resultBoundary: 'legacy_output_unresolved' });
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
    if (['dispatching', 'error'].includes(fixed.value.status) && !this.automation.store.execution.getAcceptedTask(fixed.value.admission.taskId)) return;
    let working = fixed;
    let value = working.value;

    // 双 KV 中断恢复：CI 来源已固定 admission 且接受事实存在，但第二授权 KV 丢失时，幂等补回同一 binding。
    if (this.automation.store.execution.getAcceptedTask(value.admission!.taskId)) {
      try {
        await this.automation.store.ensureTaskBinding(value.admission!.taskId, {
          schemaVersion: 2, kind: 'ci', sessionId: value.sessionId, subscriptionId: value.id,
          taskId: value.admission!.taskId, taskIdVersion: value.admission!.taskIdVersion, generation: CI_BINDING_GENERATION
        });
      } catch (err) {
        await this.automation.ci.finishCi(working, { status: 'blocked', blockReason: 'admission_conflict', error: errorMessage(err) });
        return;
      }
    }

    if (value.delivery.status === 'delivered') return;

    const recoverLegacyCapacity = value.status === 'blocked' && value.blockReason === 'legacy_output_unresolved' && Boolean(value.runtimeAttemptId);
    if (value.status === 'blocked') {
      if (!value.runtimeAttemptId || value.blockReason !== 'reconcile_required' && !recoverLegacyCapacity) return;
    }
    if (!value.runtimeAttemptId) {
      const projection = this.automation.store.execution.getTaskExecutionState(value.admission!.taskId);
      const first = projection?.attempts.find(attempt => attempt.number === 1);
      if (first) {
        const fixedAttempt = ciSubscriptionV2Schema.parse({ ...value, revision: value.revision + 1, runtimeAttemptId: first.attemptId, updatedAt: iso(this.automation.clock()) });
        if (await this.automation.store.replace(ciKey(value.id), working.raw, fixedAttempt)) working = { raw: JSON.stringify(fixedAttempt), value: fixedAttempt };
        else return;
        value = working.value;
      }
    }
    const outcome = this.reconcileAdmission(value.sessionId, value);
    if (outcome.status === 'pending') return;
    if (outcome.status === 'blocked') {
      if (working.value.status !== 'blocked') {
        await this.automation.ci.finishCi(working, {
          status: 'blocked',
          ...(outcome.reason ? { blockReason: outcome.reason } : {}),
          ...(outcome.reason === 'legacy_output_unresolved' ? { resultBoundary: 'legacy_output_unresolved' } : {}),
          error: outcome.message
        });
      }
      return;
    }
    if (outcome.status === 'cancelled') {
      if (working.value.status === 'accepted' || working.value.status === 'dispatching') await this.automation.ci.finishCi(working, 'cancelled');
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
        ...(recoverLegacyCapacity && working.value.delivery.status === 'not_requested' && this.automation.options.deliver
          ? { delivery: { status: 'pending', attempts: working.value.delivery.attempts, updatedAt: iso(this.automation.clock()) } } : {}),
        ...(result.outcome === 'cancelled' ? { delivery: this.automation.delivery.undelivered(working.value.delivery) } : {}),
        updatedAt: iso(this.automation.clock())
      });
      if (!await this.automation.store.replace(ciKey(value.id), working.raw, completed)) return;
    } else if (!working.value.result) {
      if (['waiting', 'dispatching', 'error'].includes(working.value.status)) {
        await this.automation.ci.finishCi(working, 'blocked', 'Historical terminal CI continuation has no verifiable result');
      }
      return;
    }
  }
}
