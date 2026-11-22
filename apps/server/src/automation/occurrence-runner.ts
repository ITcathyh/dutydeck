import type { SessionAutomationService } from '../session-automation.js';
import { z } from 'zod';
import {
  canonicalExecutionJson,
  ciSubscriptionSchema,
  LEGACY_GITHUB_PROVIDER_ID,
  parseLarkSourceId,
  readStoredSessionSchedule,
  runSessionScheduleInputSchema,
  RuntimeError,
  scheduleTriggerSchema,
  sessionScheduleOccurrenceSchema,
  sessionScheduleOccurrenceV2Schema,
  sessionScheduleSchema,
  type AcceptedTask,
  type ExecutionActor,
  type PublicSessionScheduleOccurrence,
  type RunSessionScheduleInput,
  type Session,
  type SessionSchedule,
  type SessionScheduleOccurrence,
  type SessionScheduleOccurrenceV2,
  type TaskAdmissionV1,
  type TaskRecord,
  type TaskRequestV1
} from '@dutydeck/shared';
import { createHash } from 'node:crypto';
import {
  activeWorkItemStatuses,
  assertAdmissionMatchesAccepted,
  CI_BINDING_GENERATION,
  ciKey,
  CLAIM_TTL_MS,
  errorCode,
  errorMessage,
  freezeAdmission,
  freshExecutionContext,
  freshSessionId,
  iso,
  isSessionRunnable,
  migrateCi,
  migrateOccurrence,
  OCCURRENCE_PREFIX,
  occurrenceActorId,
  occurrenceKey,
  plus,
  publicOccurrence,
  resolveAutomationActor,
  scheduleKey,
  scheduleRequestKey,
  streakKey,
  streakSchema,
  taskBindingKey,
  taskBindingSchema,
  type AutomationTaskLabel,
  type RunStreak,
  type TaskBinding
} from './store.js';
import { MattersService } from '../matters.js';
import type { CiHead } from '../ci-providers.js';
import { sameHead } from './ci-poll.js';
import { workItemId } from '../work-items.js';
import { recordAutomationAuthorization } from '../task-authorization.js';

const STREAK_PAUSE = 3;

/** 会话暂不可用：这次改在干净的新会话里、同一话题重跑一次，不直接判失败。 */
const SESSION_UNAVAILABLE_CODES = new Set(['OPERATION_REVOKED', 'DRIVER_STOP_UNVERIFIED', 'DRIVER_STOP_BLOCKED', 'SESSION_NOT_ACTIVE', 'SESSION_STOPPING', 'SESSION_RESOURCE_BLOCKED']);
/** Agent 命令或运行环境暂不可用：本次漏跑，保留计划等下一正常日程，不换会话重放也不按连续失败停用。 */
const ENVIRONMENT_UNAVAILABLE_CODES = new Set(['AGENT_UNAVAILABLE']);
const RETRY_OCCURRENCE_PREFIX = 'occ_retry_';
/**
 * 换新会话重跑前计划原来的模式：重跑要借 fresh 模式开会话，下一次触发前按这里改回去。
 * 单独存一条记录，不加进计划本身，切回旧版本时旧程序照常读计划（只是不再改回）。
 */
const FRESH_RETRY_PREFIX = 'session_automation/fresh_retry/';
const freshRetrySchema = z.object({
  version: z.literal(1), occurrenceId: z.string().min(1), generation: z.number().int().positive(), mode: z.literal('session').optional()
}).strict();

const errorReasons: Record<string, string> = {
  OPERATION_REVOKED: '执行会话被锁住了', DRIVER_STOP_UNVERIFIED: '执行会话上次没能确认已停下', DRIVER_STOP_BLOCKED: '执行会话上次没能确认已停下',
  SESSION_NOT_ACTIVE: '执行会话已不可用', SESSION_STOPPING: '执行会话正在停止', SESSION_RESOURCE_BLOCKED: '执行会话的终端还没收干净',
  AGENT_UNAVAILABLE: 'Agent 环境暂不可用'
};

/** 有完成条件的循环计划：每次运行在指令后附上完成条件与截止时间，告知 Agent 达成时用 stop-self 请求停用。 */
export function scheduleTaskPrompt(schedule: Pick<SessionSchedule, 'prompt' | 'completionCondition' | 'deadlineAt' | 'timezone'>): string {
  if (!schedule.completionCondition) return schedule.prompt;
  const lines = [schedule.prompt, '', '---', '这是一个「一直跟进，直到办完」的定时计划。', `完成条件：${schedule.completionCondition}`,
    '每次运行先核对完成条件。确认已经达成时，用本轮提供的 `schedule stop-self` 命令请求停用本计划，并在结果里写明达成依据；宿主只在本轮成功且结果确认送达后才停用。'
    + '未达成或无法确认时照常汇报进展和下一步，不要调用。本轮没有提供这个命令时，在结果开头写明「已达成完成条件」，由用户停用。'];
  if (schedule.deadlineAt) lines.push(`截止时间：${new Date(schedule.deadlineAt).toLocaleString('zh-CN', { timeZone: schedule.timezone, hour12: false })}（${schedule.timezone}）。到点仍未确认完成，宿主会自动停用本计划。`);
  return lines.join('\n');
}

/** fresh 计划每次触发的执行会话：由触发编号派生，同一次触发重试拿回同一个会话。 */
/** 会话暂不可用时的那次重跑：由原触发编号派生，同一次触发最多重跑一次。 */
function retryOccurrenceId(original: string) {
  return `${RETRY_OCCURRENCE_PREFIX}${createHash('sha256').update(original).digest('hex')}`;
}
/** CI 条件出错时在原话题里给的原因。 */
function conditionErrorReason(error: string | undefined) {
  return error?.startsWith('CI repository or HEAD changed')
    ? '工作区的仓库或当前提交已经变了，这条计划盯的还是创建时那个提交的 CI，请按新提交重新设置'
    : `检查 CI 失败：${(error ?? '未知错误').slice(0, 160)}`;
}

/** 核验真实接受 actor 与来源 actor 一致：authorizer 必须使用核实后的原 actor，禁止借用其他 actor */
export function acceptedActorId(label: AutomationTaskLabel, accepted: AcceptedTask | undefined, admission: TaskAdmissionV1, sourceActor: ExecutionActor | undefined, session: Session | undefined) {
  const actualActor = accepted?.request?.actor ?? admission.request?.actor;
  if (!actualActor) {
    throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', `${label} actor cannot be resolved`, 403);
  }
  if (sourceActor && canonicalExecutionJson(sourceActor) !== canonicalExecutionJson(actualActor)) {
    throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', `${label} source actor does not match accepted actor`, 403);
  }
  if (actualActor.kind === 'channel') {
    const sessionAppId = session?.source === 'lark' ? parseLarkSourceId(session.sourceId).appId : undefined;
    if (!sessionAppId || actualActor.appId !== sessionAppId) {
      throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Actor app does not match session', 403);
    }
  }
  return actualActor.kind === 'installation_owner' ? 'installation_owner'
    : actualActor.kind === 'channel' ? actualActor.id : undefined;
}

type Dependencies = Pick<SessionAutomationService['scheduler'],
  'advanceSchedule' | 'ci' | 'clock' | 'closed' | 'delivery' | 'disableSchedule' | 'freshReservation'
  | 'hasPendingOccurrence' | 'materializeOccurrence' | 'options' | 'ownerId' | 'preconditions' | 'recovery'
  | 'store' | 'warn' | 'watchSession'>;

export class OccurrenceRunner {
  readonly manualRuns = new Set<Promise<PublicSessionScheduleOccurrence>>();

  constructor(private readonly automation: Dependencies) {}

  buildRequest(session: Session, namespace: TaskRequestV1['namespace'], key: string, prompt: string, actor: ExecutionActor): TaskRequestV1 {
    return {
      version: 1,
      namespace,
      key,
      sessionId: session.id,
      actor,
      prompt,
      mode: 'queue',
      skills: [],
      options: { ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}) },
      sources: [],
      sourcePayload: { agentPrompt: prompt, skills: [] }
    };
  }

  async executionSession(schedule: SessionSchedule): Promise<Session> {
    if (schedule.mode !== 'independent' && schedule.mode !== 'fresh') return this.automation.store.requireSession(schedule.sessionId);
    if (!schedule.executionSessionId || !schedule.executionContext || !this.automation.options.runtime.startScheduleSession) {
      throw new RuntimeError('INDEPENDENT_SCHEDULE_UNAVAILABLE', 'Independent execution context is unavailable', 409);
    }
    const context = schedule.executionContext;
    const fresh = schedule.mode === 'fresh';
    const session = await this.automation.options.runtime.startScheduleSession({
      agentId: context.agentId, cwd: fresh ? context.cwd : context.sourceCwd ?? context.cwd,
      model: context.model, codexProfile: context.codexProfile, reasoningEffort: context.reasoningEffort,
      permissionMode: context.permissionMode, source: 'schedule', sourceId: schedule.id, workspaceMode: fresh ? 'shared' : 'worktree'
    }, schedule.executionSessionId, async () => {
      await this.automation.store.requireAuthorized(schedule.sessionId, schedule.actorId);
      const current = await this.automation.store.getRecord(scheduleKey(schedule.id), readStoredSessionSchedule);
      if (!current || current.value.executionSessionId !== schedule.executionSessionId || current.value.deletedAt) {
        throw new RuntimeError('INDEPENDENT_SCHEDULE_REVOKED', 'Independent schedule changed before workspace creation', 403);
      }
    });
    await new MattersService(this.automation.options.repositories).session(session.id, { sourceSessionId: schedule.sessionId, relation: 'schedule_run', title: schedule.prompt });
    this.automation.watchSession(session.id);
    if (fresh) return session;
    if (context.cwd !== session.cwd) {
      const stored = await this.automation.store.getRecord(scheduleKey(schedule.id), readStoredSessionSchedule);
      if (stored && context.cwd === context.sourceCwd) {
        await this.automation.store.replace(scheduleKey(schedule.id), stored.raw, sessionScheduleSchema.parse({
          ...stored.value, executionContext: { ...context, cwd: session.cwd }
        }));
      } else if (context.cwd !== session.cwd) {
        throw new RuntimeError('INDEPENDENT_CONTEXT_CHANGED', 'Independent schedule workspace no longer matches its frozen context', 409);
      }
    }
    return session;
  }

  runSchedule(sessionId: string, id: string, rawInput: RunSessionScheduleInput, actorId?: string): Promise<PublicSessionScheduleOccurrence> {
    if (this.automation.closed) return Promise.reject(new RuntimeError('SESSION_AUTOMATION_CLOSED', 'Session automation is shutting down', 503));
    const operation = this.runScheduleOperation(sessionId, id, rawInput, actorId);
    this.manualRuns.add(operation);
    void operation.finally(() => this.manualRuns.delete(operation)).catch(() => {});
    return operation;
  }

  private async runScheduleOperation(sessionId: string, id: string, rawInput: RunSessionScheduleInput, actorId?: string): Promise<PublicSessionScheduleOccurrence> {
    await this.automation.store.requireAuthorized(sessionId, actorId);
    const session = await this.automation.store.requireSession(sessionId);
    const input = runSessionScheduleInputSchema.parse(rawInput);
    let stored = await this.automation.store.getRecord(scheduleKey(id), readStoredSessionSchedule);
    if (!stored || stored.value.sessionId !== sessionId) throw new RuntimeError('SESSION_AUTOMATION_SCHEDULE_NOT_FOUND', 'Session schedule not found', 404);
    const manualId = `occ_${createHash('sha256').update(JSON.stringify([id, 'manual', input.idempotencyKey])).digest('hex')}`;
    const existing = await this.automation.store.getRecord(occurrenceKey(manualId), value => sessionScheduleOccurrenceSchema.parse(value));
    if (existing) return publicOccurrence(existing.value);
    // Repair a response lost between reservation and occurrence creation, even after a later edit.
    if (stored.value.pendingOccurrence?.id === manualId) {
      return this.runReservedOccurrence(stored.value);
    }
    if (stored.value.deletedAt) throw new RuntimeError('SESSION_AUTOMATION_SCHEDULE_DELETED', 'Session schedule was deleted', 409);
    if (stored.value.revision !== input.expectedRevision) throw new RuntimeError('SESSION_AUTOMATION_REVISION_CONFLICT', 'Session schedule revision changed', 409);
    stored = await this.fallbackToFresh(stored);
    if (stored.value.mode !== 'independent' && stored.value.mode !== 'fresh' && !isSessionRunnable(session)) throw new RuntimeError('SESSION_NOT_ACTIVE', 'Session is not active', 409);
    if (await this.automation.hasPendingOccurrence(stored.value)) throw new RuntimeError('SESSION_AUTOMATION_SCHEDULE_BUSY', 'This schedule already has unfinished work', 409);
    // 专用执行会话的任务只接受计划冻结的 actor（账本按计划核对），手动执行也以它的身份运行。
    const actor = resolveAutomationActor(session, stored.value.mode === 'independent' || stored.value.mode === 'fresh' ? stored.value.actorId : actorId);
    if (!actor) throw new RuntimeError('SESSION_AUTOMATION_FORBIDDEN', 'Schedule actor domain cannot be verified', 403);
    const reserved = sessionScheduleSchema.parse({ ...stored.value, ...this.automation.freshReservation(stored.value, manualId),
      pendingOccurrence: { id: manualId, generation: stored.value.generation, scheduledForUtc: iso(this.automation.clock()), triggerSource: 'manual', actor } });
    if (!await this.automation.store.replace(scheduleKey(id), stored.raw, reserved)) {
      const latest = await this.automation.store.getRecord(scheduleKey(id), readStoredSessionSchedule);
      if (latest?.value.pendingOccurrence?.id === manualId) return this.runReservedOccurrence(latest.value);
      throw new RuntimeError('SESSION_AUTOMATION_REVISION_CONFLICT', 'Session schedule changed while reserving execution', 409);
    }
    return this.runReservedOccurrence(reserved);
  }

  private async runReservedOccurrence(schedule: SessionSchedule) {
    const occurrence = await this.automation.materializeOccurrence(schedule);
    if (occurrence.created) await this.processOccurrence(occurrence);
    const latest = await this.automation.store.getRecord(occurrenceKey(occurrence.value.id), value => sessionScheduleOccurrenceSchema.parse(value));
    return publicOccurrence(latest!.value);
  }

  async authorizeTask(task: TaskRecord, phase: 'prepare' | 'submit' = 'prepare'): Promise<void> {
    const bindingStored = await this.automation.store.getRecord(taskBindingKey(task.id), value => taskBindingSchema.parse(value));
    if (!bindingStored) return;
    const binding = bindingStored.value;
    if (binding.sessionId !== task.sessionId) throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Automation task binding does not match its session', 403);
    const accepted = this.automation.store.execution.getAcceptedTask(task.id);
    if (accepted && (accepted.task.sessionId !== task.sessionId || accepted.task.id !== task.id)) {
      throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Accepted task identity does not match current task', 403);
    }
    if (binding.kind === 'schedule') {
      const occurrenceStored = await this.automation.store.getRecord(occurrenceKey(binding.occurrenceId), value => sessionScheduleOccurrenceSchema.parse(value));
      const occurrence = occurrenceStored ? migrateOccurrence(occurrenceStored.value) : undefined;
      if (!occurrenceStored || !occurrence) throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task binding is invalid', 403);
      if (!occurrence.admission || occurrence.admission.taskId !== task.id) {
        throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task admission is invalid', 403);
      }
      if (binding.schemaVersion === 2) {
        if (
          binding.taskId !== task.id ||
          binding.occurrenceId !== occurrence.id ||
          binding.scheduleId !== occurrence.scheduleId ||
          binding.generation !== occurrence.generation ||
          binding.sessionId !== task.sessionId ||
          binding.taskIdVersion !== occurrence.admission.taskIdVersion
        ) {
          throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task binding is invalid', 403);
        }
      } else {
        if (binding.occurrenceId !== occurrence.id || binding.sessionId !== task.sessionId) {
          throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task binding is invalid', 403);
        }
        const fixedTaskId = occurrence.taskId;
        if (!fixedTaskId || fixedTaskId !== task.id) throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task binding is invalid', 403);
      }
      assertAdmissionMatchesAccepted('Scheduled task', occurrence.admission, accepted);
      const schedule = await this.automation.store.getRecord(scheduleKey(occurrence.scheduleId), readStoredSessionSchedule);
      if (!schedule) throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task definition is missing', 403);
      const started = Boolean(occurrence.taskStartedAt || schedule.value.taskStartOccurrenceId === occurrence.id);
      if (!started && (!scheduleTriggerSchema.safeParse(schedule.value.trigger).success || schedule.value.generation !== occurrence.generation || schedule.value.deletedAt || !schedule.value.enabled && occurrence.triggerSource !== 'manual' || occurrence.conditionStatus !== 'passed' || !['pending', 'accepted'].includes(occurrence.runStatus))) {
        await this.finishOccurrence(occurrenceStored, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Schedule changed before task execution' });
        throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task is no longer authorized to run', 403);
      }
      const session = await this.automation.options.runtime.getSession(task.sessionId);
      if (!isSessionRunnable(session)) {
        if (!started) {
          await this.automation.disableSchedule(schedule);
          await this.finishOccurrence(occurrenceStored, { conditionStatus: 'error', runStatus: 'error', error: 'Session is no longer active' });
        }
        throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task session is no longer active', 403);
      }
      const origin = await this.automation.options.runtime.getSession(schedule.value.sessionId);
      const actorId = acceptedActorId('Scheduled task', accepted, occurrence.admission, occurrence.actor, origin);
      try { await this.automation.store.requireAuthorized(schedule.value.sessionId, actorId); }
      catch (error) {
        if (!started) {
          await this.automation.disableSchedule(schedule);
          await this.finishOccurrence(occurrenceStored, { conditionStatus: 'error', runStatus: 'error', error: errorMessage(error) });
        }
        throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task authorization was revoked', 403);
      }
      // 首次尚未提交时继续真正 HEAD 核验，删掉以 !accepted 为条件的 HEAD 绕过。
      if (!started && schedule.value.condition.kind === 'ci_new_failure') {
        const condition = schedule.value.condition;
        let resolved: CiHead;
        try { resolved = await this.automation.ci.ciHead(session!.cwd, condition.provider); }
        catch (error) {
          await this.finishOccurrence(occurrenceStored, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: errorMessage(error) });
          throw new RuntimeError('SESSION_AUTOMATION_TASK_STALE_HEAD', 'Scheduled task CI HEAD is unavailable before execution', 409);
        }
        if (!sameHead(resolved, condition.provider, condition.repository, condition.headSha)) {
          await this.finishOccurrence(occurrenceStored, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Scheduled task CI HEAD changed before execution' });
          throw new RuntimeError('SESSION_AUTOMATION_TASK_STALE_HEAD', 'Scheduled task CI HEAD changed before execution', 409);
        }
      }
      if (phase === 'submit' && !started) {
        let candidate = schedule;
        for (;;) {
          const startedSchedule = sessionScheduleSchema.parse({
            ...candidate.value,
            taskStartOccurrenceId: occurrence.id,
            ...(!candidate.value.nextDueAt && occurrence.triggerSource !== 'manual' ? { enabled: false } : {})
          });
          if (await this.automation.store.replace(scheduleKey(candidate.value.id), candidate.raw, startedSchedule)) break;
          const latestSchedule = await this.automation.store.getRecord(scheduleKey(schedule.value.id), readStoredSessionSchedule);
          const latest = latestSchedule?.value;
          if (!latest || latest.generation !== occurrence.generation || latest.deletedAt
            || latest.sessionId !== schedule.value.sessionId || latest.actorId !== schedule.value.actorId
            || latest.executionSessionId !== schedule.value.executionSessionId || latest.mode !== schedule.value.mode
            || canonicalExecutionJson(latest.executionContext ?? null) !== canonicalExecutionJson(schedule.value.executionContext ?? null)
            || !latest.enabled && occurrence.triggerSource !== 'manual' && latest.taskStartOccurrenceId !== occurrence.id
            || !isSessionRunnable(await this.automation.options.runtime.getSession(task.sessionId))) {
            const current = await this.automation.store.getRecord(occurrenceKey(occurrence.id), value => sessionScheduleOccurrenceSchema.parse(value));
            if (current) await this.finishOccurrence(current, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Schedule changed before submission' });
            throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task changed before submission', 409);
          }
          await this.automation.store.requireAuthorized(latest.sessionId, actorId);
          if (latest.taskStartOccurrenceId === occurrence.id) break;
          candidate = latestSchedule!;
        }
        const currentOccurrence = await this.automation.store.getRecord(occurrenceKey(occurrence.id), value => sessionScheduleOccurrenceSchema.parse(value));
        if (!currentOccurrence || !['passed'].includes(currentOccurrence.value.conditionStatus) || !['pending', 'accepted'].includes(currentOccurrence.value.runStatus)) {
          throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled occurrence changed before submission', 409);
        }
        const marked = sessionScheduleOccurrenceSchema.parse({ ...migrateOccurrence(currentOccurrence.value), revision: currentOccurrence.value.revision + 1, taskStartedAt: iso(this.automation.clock()), updatedAt: iso(this.automation.clock()) });
        if (!await this.automation.store.replace(occurrenceKey(occurrence.id), currentOccurrence.raw, marked)) {
          const latestOccurrence = await this.automation.store.getRecord(occurrenceKey(occurrence.id), value => sessionScheduleOccurrenceSchema.parse(value));
          const latestVal = latestOccurrence ? migrateOccurrence(latestOccurrence.value) : undefined;
          if (!latestVal || !latestVal.taskStartedAt || latestVal.scheduleId !== schedule.value.id || latestVal.generation !== occurrence.generation || !['passed'].includes(latestVal.conditionStatus) || !['pending', 'accepted'].includes(latestVal.runStatus)) {
            throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled occurrence changed before submission', 409);
          }
        }
      }
      return;
    }
    const subscriptionStored = await this.automation.store.getRecord(ciKey(binding.subscriptionId), value => ciSubscriptionSchema.parse(value));
    const subscription = subscriptionStored ? migrateCi(subscriptionStored.value) : undefined;
    if (!subscriptionStored || !subscription) throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation task binding is invalid', 403);
    if (!subscription.admission || subscription.admission.taskId !== task.id) {
      throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation admission is invalid', 403);
    }
    if (binding.schemaVersion === 2) {
      if (
        binding.taskId !== task.id ||
        binding.subscriptionId !== subscription.id ||
        binding.generation !== CI_BINDING_GENERATION ||
        binding.sessionId !== task.sessionId ||
        binding.taskIdVersion !== subscription.admission.taskIdVersion
      ) {
        throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation task binding is invalid', 403);
      }
    } else {
      if (binding.subscriptionId !== subscription.id || binding.sessionId !== task.sessionId) {
        throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation task binding is invalid', 403);
      }
      const fixedTaskId = subscription.taskId;
      if (!fixedTaskId || fixedTaskId !== task.id) throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation task binding is invalid', 403);
    }
    assertAdmissionMatchesAccepted('CI continuation', subscription.admission, accepted);
    const started = Boolean(subscription.taskStartedAt);
    if (!started && (!['dispatching', 'accepted'].includes(subscription.status) || new Date(subscription.expiresAt) <= this.automation.clock())) {
      if (['dispatching', 'accepted'].includes(subscription.status) && new Date(subscription.expiresAt) <= this.automation.clock()) await this.automation.ci.finishCi(subscriptionStored, 'expired', 'CI continuation expired before execution');
      throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation is no longer authorized to run', 403);
    }
    const session = await this.automation.options.runtime.getSession(task.sessionId);
    if (!isSessionRunnable(session)) {
      if (!started) await this.automation.ci.finishCi(subscriptionStored, 'session_inactive', 'Session is no longer active');
      throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation session is no longer active', 403);
    }
    const ciActorId = acceptedActorId('CI continuation', accepted, subscription.admission, subscription.actor, session);
    try { await this.automation.store.requireAuthorized(task.sessionId, ciActorId); }
    catch (error) {
      if (!started) await this.automation.ci.finishCi(subscriptionStored, 'revoked', errorMessage(error));
      throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation authorization was revoked', 403);
    }
    // 首次尚未提交时继续真正 HEAD 核验，删掉以 !accepted 为条件的 HEAD 绕过。
    if (!started) {
      const providerId = subscription.provider ?? LEGACY_GITHUB_PROVIDER_ID;
      let resolved: CiHead;
      try { resolved = await this.automation.ci.ciHead(session!.cwd, providerId); }
      catch (error) {
        await this.automation.ci.finishCi(subscriptionStored, 'stale_head', errorMessage(error));
        throw new RuntimeError('SESSION_AUTOMATION_TASK_STALE_HEAD', 'CI continuation HEAD is unavailable before execution', 409);
      }
      if (!sameHead(resolved, providerId, subscription.repository, subscription.headSha)) {
        await this.automation.ci.finishCi(subscriptionStored, 'stale_head', 'CI continuation HEAD changed before execution');
        throw new RuntimeError('SESSION_AUTOMATION_TASK_STALE_HEAD', 'CI continuation HEAD changed before execution', 409);
      }
    }
    if (phase === 'submit' && !started) {
      const current = await this.automation.store.getRecord(ciKey(subscription.id), value => ciSubscriptionSchema.parse(value));
      const currentValue = current ? migrateCi(current.value) : undefined;
      if (!current || !currentValue || currentValue.taskStartedAt || !['dispatching', 'accepted'].includes(currentValue.status) || new Date(currentValue.expiresAt) <= this.automation.clock()) {
        throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation changed before submission', 409);
      }
      const marked = ciSubscriptionSchema.parse({ ...currentValue, revision: currentValue.revision + 1, taskStartedAt: iso(this.automation.clock()), updatedAt: iso(this.automation.clock()) });
      if (!await this.automation.store.replace(ciKey(subscription.id), current.raw, marked)) {
        const latest = await this.automation.store.getRecord(ciKey(subscription.id), value => ciSubscriptionSchema.parse(value));
        const latestVal = latest ? migrateCi(latest.value) : undefined;
        if (!latestVal || !latestVal.taskStartedAt || !['dispatching', 'accepted'].includes(latestVal.status) || new Date(latestVal.expiresAt) <= this.automation.clock()) {
          throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation changed before submission', 409);
        }
      }
    }
  }

  async renewOccurrenceLease(stored: { raw: string; value: SessionScheduleOccurrence }) {
    const now = this.automation.clock();
    const base = migrateOccurrence(stored.value);
    const renewed = sessionScheduleOccurrenceV2Schema.parse({ ...base, revision: base.revision + 1, leaseOwner: this.automation.ownerId, leaseExpiresAt: plus(now, CLAIM_TTL_MS), updatedAt: iso(now) });
    return await this.automation.store.replace(occurrenceKey(stored.value.id), stored.raw, renewed) ? { raw: JSON.stringify(renewed), value: renewed } : undefined;
  }

  async processOccurrence(stored: { raw: string; value: SessionScheduleOccurrence }) {
    let occurrence = migrateOccurrence(stored.value);
    // 账本已接受（派发后崩溃、关闭或补记 CAS 落败）时先认接受事实，再做计划、会话和授权检查：作废会丢结果，下一轮还会重叠执行。
    const admission = occurrence.admission;
    const acceptedTask = admission && this.automation.store.execution.getAcceptedTask(admission.taskId);
    if (admission && acceptedTask) {
      if (acceptedTask.request && admission.request && canonicalExecutionJson(acceptedTask.request) !== canonicalExecutionJson(admission.request)) {
        await this.finishOccurrence(stored, { runStatus: 'blocked', blockReason: 'admission_conflict', error: 'Accepted task request conflicts with source admission' });
        return;
      }
      try {
        await this.automation.store.ensureTaskBinding(admission.taskId, {
          schemaVersion: 2, kind: 'schedule', sessionId: occurrence.executionSessionId ?? occurrence.sessionId, occurrenceId: occurrence.id,
          scheduleId: occurrence.scheduleId, taskId: admission.taskId, taskIdVersion: admission.taskIdVersion, generation: occurrence.generation
        });
      } catch (error) {
        await this.finishOccurrence(stored, { runStatus: 'blocked', blockReason: 'admission_conflict', error: errorMessage(error) });
        return;
      }
      await this.markOccurrenceAccepted(stored, admission.taskId);
      return;
    }
    let scheduleStored = await this.automation.store.getRecord(scheduleKey(occurrence.scheduleId), readStoredSessionSchedule);
    if (scheduleStored && !occurrence.admission && !occurrence.taskId) {
      scheduleStored = await this.fallbackToFresh(scheduleStored, occurrence.id);
      const latestOccurrence = await this.automation.store.getRecord(occurrenceKey(occurrence.id), value => sessionScheduleOccurrenceSchema.parse(value));
      if (latestOccurrence?.raw !== stored.raw) return;
      if (scheduleStored.value.mode === 'fresh' && occurrence.executionSessionId !== scheduleStored.value.executionSessionId) {
        const next = sessionScheduleOccurrenceV2Schema.parse({ ...occurrence, executionSessionId: scheduleStored.value.executionSessionId, revision: occurrence.revision + 1 });
        if (!await this.automation.store.replace(occurrenceKey(occurrence.id), stored.raw, next)) return;
        occurrence = next; stored = { raw: JSON.stringify(next), value: next };
      }
    }
    if (!scheduleStored || !scheduleTriggerSchema.safeParse(scheduleStored.value.trigger).success || scheduleStored.value.generation !== occurrence.generation || scheduleStored.value.deletedAt || !scheduleStored.value.enabled && occurrence.triggerSource !== 'manual'
      || scheduleStored.value.mode === 'fresh' && occurrence.executionSessionId !== scheduleStored.value.executionSessionId) {
      await this.finishOccurrence({ raw: stored.raw, value: occurrence }, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Schedule generation changed before dispatch' });
      return;
    }
    // 前置命令在开执行会话、启动工作项模板之前判定；没通过就不唤醒 Agent。
    if (!await this.automation.preconditions.preconditionGate(scheduleStored, { raw: stored.raw, value: occurrence })) return;
    if (scheduleStored.value.workTemplate) {
      await this.startWorkTemplate(scheduleStored, { raw: stored.raw, value: occurrence });
      return;
    }
    let schedule = scheduleStored.value;
    const origin = await this.automation.options.runtime.getSession(schedule.sessionId);
    let sessionMaybe: Session | undefined;
    try { sessionMaybe = schedule.mode === 'independent' || schedule.mode === 'fresh' ? await this.executionSession(schedule) : origin; }
    catch (error) {
      const accepted = occurrence.admission && this.automation.store.execution.getAcceptedTask(occurrence.admission.taskId);
      if (error instanceof RuntimeError && ENVIRONMENT_UNAVAILABLE_CODES.has(error.code)) {
        this.automation.warn({ scheduleId: schedule.id, occurrenceId: occurrence.id, sessionId: schedule.executionSessionId, code: error.code }, '定时触发时 Agent 环境暂不可用');
        // 已接受的任务仍按原账本对账；只有确认未接受才记录这次环境漏跑。
        if (!accepted) await this.noteTriggerError(schedule.id, occurrence.id, error.code);
      } else {
        // 新会话暂时开不出来不停用计划：记为触发出错，由 followUpOccurrence 重跑一次或在原话题说明。
        const unavailable = !accepted && error instanceof RuntimeError && SESSION_UNAVAILABLE_CODES.has(error.code);
        if (unavailable) {
          this.automation.warn({ scheduleId: schedule.id, occurrenceId: occurrence.id, sessionId: schedule.executionSessionId, code: error.code }, '定时触发时执行会话暂不可用');
          await this.noteTriggerError(schedule.id, occurrence.id, error.code);
        } else await this.automation.disableSchedule(scheduleStored, errorMessage(error));
      }
      await this.finishOccurrence(stored, { conditionStatus: 'error', runStatus: accepted ? 'blocked' : 'error',
        ...(accepted ? { blockReason: 'admission_conflict' as const } : {}), error: errorMessage(error) });
      return;
    }
    if (!isSessionRunnable(sessionMaybe)) {
      await this.automation.disableSchedule(scheduleStored, 'Session is no longer active');
      await this.finishOccurrence({ raw: stored.raw, value: occurrence }, { conditionStatus: 'error', runStatus: 'error', error: 'Session is no longer active' });
      return;
    }
    const session = sessionMaybe!;
    const actorId = occurrence.triggerSource === 'manual' && occurrence.actor?.kind !== 'unspecified' ? occurrence.actor?.id : schedule.actorId;
    try { await this.automation.store.requireAuthorized(schedule.sessionId, actorId); }
    catch (error) {
      await this.automation.disableSchedule(scheduleStored);
      await this.finishOccurrence({ raw: stored.raw, value: occurrence }, { conditionStatus: 'error', runStatus: 'error', error: errorMessage(error) });
      return;
    }

    let working: { raw: string; value: SessionScheduleOccurrenceV2 } = { raw: stored.raw, value: occurrence };
    let conditionStatus: SessionScheduleOccurrenceV2['conditionStatus'] = occurrence.conditionStatus === 'pending' ? 'passed' : occurrence.conditionStatus;
    let conditionError = occurrence.error;
    if (occurrence.conditionStatus === 'pending' && schedule.condition.kind === 'ci_new_failure') {
      let observed: number[] | undefined;
      let observedAttempts: SessionScheduleOccurrenceV2['conditionObservedRunAttempts'];
      try {
        const condition = schedule.condition;
        const resolved = await this.automation.ci.ciHead(session!.cwd, condition.provider);
        if (!sameHead(resolved, condition.provider, condition.repository, condition.headSha)) {
          throw new Error('CI repository or HEAD changed after the schedule generation was created');
        }
        const runs = await this.automation.ci.listRuns(condition.provider, condition.repository, condition.headSha, condition.workflow, true);
        const seen = new Set(condition.observedRunIds);
        const attempts = new Map(condition.observedRunAttempts?.map(run => [run.id, run.attempt]));
        // 旧记录只有 ID：首轮为这些 ID 补齐当前 attempt，不重放历史失败。
        const newRuns = runs.filter(run => !seen.has(run.id) || attempts.has(run.id) && run.attempt > attempts.get(run.id)!);
        conditionStatus = newRuns.some(run => run.result === 'failed') ? 'passed' : 'skipped';
        observed = runs.map(run => run.id);
        observedAttempts = runs.map(run => ({ id: run.id, attempt: run.attempt }));
      } catch (error) {
        conditionStatus = 'error';
        conditionError = errorMessage(error);
      }
      const renewed = await this.renewOccurrenceLease(working);
      if (!renewed) return;
      working = renewed;
      const currentSchedule = await this.automation.store.getRecord(scheduleKey(schedule.id), readStoredSessionSchedule);
      if (!currentSchedule || currentSchedule.value.generation !== occurrence.generation || currentSchedule.value.deletedAt || !currentSchedule.value.enabled && occurrence.triggerSource !== 'manual') {
        await this.finishOccurrence(working, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Schedule changed while its condition was evaluated' });
        return;
      }
      const evaluated = sessionScheduleOccurrenceV2Schema.parse({
        ...working.value,
        revision: working.value.revision + 1,
        conditionStatus,
        ...(observed !== undefined ? { conditionObservedRunIds: observed, conditionObservedRunAttempts: observedAttempts } : {}),
        ...(conditionError ? { error: conditionError } : {}),
        updatedAt: iso(this.automation.clock())
      });
      if (!await this.automation.store.replace(occurrenceKey(occurrence.id), working.raw, evaluated)) return;
      working = { raw: JSON.stringify(evaluated), value: evaluated };
    }
    const persistedCondition = schedule.condition;
    if (persistedCondition.kind === 'ci_new_failure' && working.value.conditionObservedRunIds) {
      const observedRunIds = [...new Set([...persistedCondition.observedRunIds, ...working.value.conditionObservedRunIds])].sort((a, b) => a - b).slice(-100);
      const attempts = new Map(persistedCondition.observedRunAttempts?.map(run => [run.id, run.attempt]));
      for (const run of working.value.conditionObservedRunAttempts ?? []) attempts.set(run.id, Math.max(attempts.get(run.id) ?? 0, run.attempt));
      const observedRunAttempts = observedRunIds.filter(id => attempts.has(id)).map(id => ({ id, attempt: attempts.get(id)! }));
      const latestSchedule = await this.automation.store.getRecord(scheduleKey(schedule.id), readStoredSessionSchedule);
      if (!latestSchedule || latestSchedule.value.generation !== occurrence.generation) return;
      const updated = sessionScheduleSchema.parse({ ...latestSchedule.value, condition: { ...persistedCondition, observedRunIds, observedRunAttempts } });
      if (!await this.automation.store.replace(scheduleKey(schedule.id), latestSchedule.raw, updated)) {
        await this.finishOccurrence(working, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Schedule changed while its condition was evaluated' });
        return;
      }
      schedule = updated;
    }
    try { await this.automation.store.requireAuthorized(schedule.sessionId, actorId); }
    catch (error) {
      const currentSchedule = await this.automation.store.getRecord(scheduleKey(schedule.id), readStoredSessionSchedule);
      if (currentSchedule?.value.generation === schedule.generation) await this.automation.disableSchedule(currentSchedule);
      await this.finishOccurrence(working, { conditionStatus: 'error', runStatus: 'error', error: errorMessage(error) });
      return;
    }
    if (conditionStatus !== 'passed') {
      await this.finishOccurrence(working, { conditionStatus, runStatus: conditionStatus === 'skipped' ? 'skipped' : conditionStatus === 'invalidated' ? 'invalidated' : 'error', ...(conditionError ? { error: conditionError } : {}), admission: undefined });
      // 条件查不了（例如工作区换了提交）算一次没做成：在原话题说明，连续 STREAK_PAUSE 次自动停用。
      if (conditionStatus === 'error' && occurrence.triggerSource !== 'manual') {
        await this.recordOutcome(working.value, { key: 'condition:error', kind: 'error', reason: conditionErrorReason(conditionError) });
      }
      if (occurrence.triggerSource !== 'manual') await this.automation.advanceSchedule(schedule, occurrence.scheduledForUtc);
      return;
    }

    const accepted = sessionScheduleOccurrenceV2Schema.parse({ ...working.value, revision: working.value.revision + 1, conditionStatus: 'passed', updatedAt: iso(this.automation.clock()) });
    if (!await this.automation.store.replace(occurrenceKey(occurrence.id), working.raw, accepted)) return;
    const actor = working.value.actor ?? resolveAutomationActor(origin, schedule.actorId);
    if (!actor) {
      await this.finishOccurrence({ raw: JSON.stringify(accepted), value: accepted }, { runStatus: 'blocked', blockReason: 'admission_conflict', error: 'Schedule actor domain cannot be verified' });
      return;
    }
    // 统一来源恢复前序：先读原 admission/明确 taskId，在任何新 HEAD/材料/当前默认配置前核实际接受事实。
    // 已有 request/taskId/actor 只原样使用，永不 buildRequest 覆盖。
    let request: TaskRequestV1;
    let taskId: string;
    let taskIdVersion: 'v1' | 'legacy' = 'v1';
    let occurrenceWithAdmission: { raw: string; value: SessionScheduleOccurrenceV2 };

    if (working.value.admission) {
      request = working.value.admission.request ?? this.buildRequest(session, 'schedule', scheduleRequestKey(occurrence.id), scheduleTaskPrompt(schedule), actor);
      taskId = working.value.admission.taskId;
      taskIdVersion = working.value.admission.taskIdVersion;
      occurrenceWithAdmission = { raw: JSON.stringify(accepted), value: accepted };
    } else {
      // 首次无 admission：先构造候选请求，复用真实仓储 execution.lookupAccepted(request)
      const candidateRequest = this.buildRequest(session, 'schedule', scheduleRequestKey(occurrence.id), scheduleTaskPrompt(schedule), actor);
      let existingAccepted;
      try {
        existingAccepted = this.automation.store.execution.lookupAccepted(candidateRequest);
      } catch (err) {
        await this.finishOccurrence({ raw: JSON.stringify(accepted), value: accepted }, { runStatus: 'blocked', blockReason: 'admission_conflict', error: errorMessage(err) });
        if (occurrence.triggerSource !== 'manual') await this.automation.advanceSchedule(schedule, occurrence.scheduledForUtc);
        return;
      }
      const frozen = freezeAdmission('schedule', session.id, candidateRequest, existingAccepted, actor);
      ({ request } = frozen);
      ({ taskId, taskIdVersion } = frozen.admission);
      const withAdmission = sessionScheduleOccurrenceV2Schema.parse({
        ...accepted,
        revision: accepted.revision + 1,
        ...frozen.fields,
        updatedAt: iso(this.automation.clock())
      });
      if (!await this.automation.store.replace(occurrenceKey(occurrence.id), JSON.stringify(accepted), withAdmission)) return;
      occurrenceWithAdmission = { raw: JSON.stringify(withAdmission), value: withAdmission };
    }
    await this.dispatchOccurrence(occurrenceWithAdmission, request, taskId, taskIdVersion);
    if (occurrence.triggerSource !== 'manual') await this.automation.advanceSchedule(schedule, occurrence.scheduledForUtc);
  }

  /**
   * 模板计划的一次触发：以计划指令为目标、按触发编号作幂等键启动已保存的工作项模板，确认规则沿用模板启动。
   * 上一次启动的工作项还没结束时跳过这次；模板被删或不可用时这次记为出错并在回报位置说明。
   */
  private async startWorkTemplate(scheduleStored: { raw: string; value: SessionSchedule }, stored: { raw: string; value: SessionScheduleOccurrenceV2 }) {
    const schedule = scheduleStored.value;
    let occurrence = stored.value;
    const template = schedule.workTemplate!;
    const actorId = occurrenceActorId(schedule, occurrence);
    const fail = async (code: string, message: string) => {
      await this.finishOccurrence(stored, { conditionStatus: 'passed', runStatus: 'error', error: message });
      if (occurrence.triggerSource !== 'manual') {
        await this.recordOutcome(occurrence, { key: `error:${code}`, kind: ENVIRONMENT_UNAVAILABLE_CODES.has(code) ? 'environment' : 'error', reason: message });
        await this.automation.advanceSchedule(schedule, occurrence.scheduledForUtc);
      }
    };
    try { await this.automation.store.requireAuthorized(schedule.sessionId, actorId); }
    catch (error) {
      await this.automation.disableSchedule(scheduleStored);
      await this.finishOccurrence(stored, { conditionStatus: 'error', runStatus: 'error', error: errorMessage(error) });
      return;
    }
    if (!this.automation.options.workTemplates) { await fail('WORK_TEMPLATE_UNAVAILABLE', '本实例没有启用工作项模板，无法启动'); return; }
    const workTemplates = this.automation.options.workTemplates;
    // 启动前记下启动者：计划之后改归属，也能按原身份派生和核对这次的工作项；重试沿用同一身份。
    if (actorId && !occurrence.actorId) {
      const withActor = sessionScheduleOccurrenceV2Schema.parse({ ...occurrence, revision: occurrence.revision + 1, actorId, updatedAt: iso(this.automation.clock()) });
      if (!await this.automation.store.replace(occurrenceKey(occurrence.id), stored.raw, withActor)) return;
      stored = { raw: JSON.stringify(withActor), value: withActor };
      occurrence = withActor;
    }
    const records = (await this.automation.store.listRecords(OCCURRENCE_PREFIX, value => sessionScheduleOccurrenceSchema.parse(value), undefined, { field: 'runStatus', values: ['completed', 'error'], scheduleId: schedule.id }))
      .map(item => migrateOccurrence(item.value)).filter(item => item.scheduleId === schedule.id && item.id !== occurrence.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    // 最近一次带工作项的启动，加上它之后出错的启动：出错时工作项可能其实已建好，按派生编号一并核对。
    const lastStarted = records.findIndex(item => item.runStatus === 'completed' && item.workItemId);
    const previous = records.slice(0, lastStarted < 0 ? undefined : lastStarted + 1)
      .filter(item => item.workItemId || item.runStatus === 'error')
      .map(item => item.workItemId ?? workItemId(schedule.sessionId, occurrenceActorId(schedule, item), `schedule:${item.id}`));
    for (const id of previous) {
      // 只有确认不存在才算已结束；读不出状态按没结束处理，宁可少启动一次。
      const status = await workTemplates.progress(id).catch(() => 'unknown');
      if (status && (status === 'unknown' || activeWorkItemStatuses.has(status))) {
        await this.finishOccurrence(stored, { conditionStatus: 'skipped', runStatus: 'skipped', error: `上一次启动的工作项 ${id} 还没结束` });
        if (occurrence.triggerSource !== 'manual') await this.automation.advanceSchedule(schedule, occurrence.scheduledForUtc);
        return;
      }
    }
    let item: { id: string; status: string };
    const key = `schedule:${occurrence.id}`;
    try { item = await workTemplates.run(schedule.sessionId, template.id, template.version, schedule.prompt, key, actorId, [
      { key: scheduleKey(schedule.id), expected: scheduleStored.raw },
      { key: occurrenceKey(occurrence.id), expected: stored.raw }
    ]); }
    catch (error) {
      // 工作项已经建好（如响应丢失后重试冲突）时按成功记录，避免下次重叠启动。
      const id = workItemId(schedule.sessionId, actorId, key);
      if (await workTemplates.progress(id).catch(() => undefined) !== undefined) item = { id, status: 'unknown' };
      else if (errorCode(error) === 'WORK_ITEM_ADMISSION_REVOKED') {
        const current = (await this.automation.store.getRecord(scheduleKey(schedule.id), readStoredSessionSchedule))?.value;
        // 仅改名等不换代际的写入也会输掉精确 CAS；保留 pending，下次按新快照重试。
        if (current && current.generation === occurrence.generation && !current.deletedAt && (current.enabled || occurrence.triggerSource === 'manual')) {
          await this.automation.store.replace(occurrenceKey(occurrence.id), stored.raw, sessionScheduleOccurrenceV2Schema.parse({ ...occurrence, revision: occurrence.revision + 1, leaseExpiresAt: iso(this.automation.clock()), updatedAt: iso(this.automation.clock()) }));
          return;
        }
        await this.finishOccurrence(stored, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Schedule changed before work-item creation' });
        return;
      } else {
        const code = errorCode(error);
        await fail(code, code === 'WORK_TEMPLATE_NOT_FOUND' ? `工作项模板 ${template.id}（版本 ${template.version}）已删除或不可用，这次没有启动` : `工作项模板没能启动：${errorMessage(error)}`);
        return;
      }
    }
    await this.finishOccurrence(stored, { conditionStatus: 'passed', runStatus: 'completed', workItemId: item.id });
    if (occurrence.triggerSource !== 'manual') {
      await this.recordOutcome(occurrence);
      await this.automation.advanceSchedule(schedule, occurrence.scheduledForUtc);
    }
  }

  private async dispatchOccurrence(
    stored: { raw: string; value: SessionScheduleOccurrenceV2 },
    request: TaskRequestV1,
    taskId: string,
    taskIdVersion: 'v1' | 'legacy'
  ) {
    const occurrence = stored.value;
    await this.dispatchAdmitted(request, taskId, {
      schemaVersion: 2,
      kind: 'schedule',
      sessionId: request.sessionId,
      occurrenceId: occurrence.id,
      scheduleId: occurrence.scheduleId,
      taskId,
      taskIdVersion,
      generation: occurrence.generation
    }, {
      accepted: id => this.markOccurrenceAccepted(stored, id),
      conflict: error => this.finishOccurrence(stored, { runStatus: 'blocked', blockReason: 'admission_conflict', error }),
      failed: async error => {
        this.automation.warn({ scheduleId: occurrence.scheduleId, occurrenceId: occurrence.id, sessionId: request.sessionId, code: errorCode(error) }, '定时触发派发失败');
        if (occurrence.triggerSource !== 'manual') await this.noteTriggerError(occurrence.scheduleId, occurrence.id, errorCode(error));
        await this.finishOccurrence(stored, { runStatus: 'error', error: errorMessage(error) });
      }
    });
  }

  /**
   * 按已固定的准入派发一条自动化任务。重投先查接受事实，命中只补同一映射，不再读 HEAD/材料、不重拼 prompt；
   * 派发报错时以执行账本是否已接受为准。结算交给调用方：accepted 记接受，conflict 记准入冲突（afterDispatch 区分派发前后），failed 记派发失败。
   */
  async dispatchAdmitted(request: TaskRequestV1, taskId: string, binding: TaskBinding, settle: {
    accepted: (taskId: string) => Promise<unknown>;
    conflict: (error: string, afterDispatch: boolean) => Promise<unknown>;
    failed: (error: unknown) => Promise<unknown>;
  }) {
    const acceptedBefore = this.automation.store.execution.getAcceptedTask(taskId);
    if (acceptedBefore?.request && canonicalExecutionJson(acceptedBefore.request) !== canonicalExecutionJson(request)) {
      await settle.conflict('The task key already belongs to a different accepted request', false);
      return;
    }
    await recordAutomationAuthorization(this.automation.options.repositories.config, request, taskId);
    await this.automation.store.ensureTaskBinding(taskId, binding);
    if (acceptedBefore) {
      await settle.accepted(taskId);
      return;
    }
    try {
      const task = await this.automation.options.runtime.dispatchRequest(request);
      if (task.id !== taskId) throw new RuntimeError('SESSION_AUTOMATION_TASK_CONFLICT', 'Runtime task identity did not match the fixed admission', 409);
      await settle.accepted(task.id);
    } catch (error) {
      if (this.automation.closed) return;
      const durable = this.automation.store.execution.getAcceptedTask(taskId);
      if (!durable) {
        await settle.failed(error);
        return;
      }
      if (durable.request && canonicalExecutionJson(durable.request) === canonicalExecutionJson(request)) await settle.accepted(taskId);
      else await settle.conflict('Accepted task request conflicts with source admission', true);
    }
  }

  private async markOccurrenceAccepted(stored: { raw: string; value: SessionScheduleOccurrence }, taskId: string) {
    // 并发写入（如 submit 写 taskStartedAt）让 CAS 落败时重读重试；仍未写成的由下次 processOccurrence 按账本补记。
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.automation.store.getRecord(occurrenceKey(stored.value.id), input => sessionScheduleOccurrenceSchema.parse(input));
      if (!current) return;
      const currentValue = migrateOccurrence(current.value);
      if (currentValue.runStatus !== 'pending') return;
      if (currentValue.scheduleId !== stored.value.scheduleId || currentValue.generation !== stored.value.generation) return;
      // CAS 核原来源身份/代际：冻结 admission 的 taskId 必须与实际接受 Task 一致，不借最新 pending 绑定不同请求。
      const frozenTaskId = currentValue.admission?.taskId ?? migrateOccurrence(stored.value).admission?.taskId;
      if (frozenTaskId && frozenTaskId !== taskId) return;
      const updated = sessionScheduleOccurrenceV2Schema.parse({ ...currentValue, revision: currentValue.revision + 1, runStatus: 'accepted', taskId, acceptedAt: currentValue.acceptedAt ?? iso(this.automation.clock()), leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: iso(this.automation.clock()) });
      if (await this.automation.store.replace(occurrenceKey(stored.value.id), current.raw, updated)) return;
    }
  }

  async finishOccurrence(stored: { raw: string; value: SessionScheduleOccurrence }, patch: Partial<SessionScheduleOccurrenceV2>): Promise<boolean> {
    const base = migrateOccurrence(stored.value);
    const noTask = !base.taskId && patch.runStatus && !['pending', 'accepted'].includes(patch.runStatus);
    const blocked = patch.runStatus === 'blocked';
    const shouldResetDelivery = (noTask || blocked) && base.delivery.status !== 'delivered';
    const updated = sessionScheduleOccurrenceV2Schema.parse({
      ...base,
      ...patch,
      schemaVersion: 2,
      revision: base.revision + 1,
      ...(shouldResetDelivery ? { delivery: this.automation.delivery.undelivered(base.delivery) } : {}),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: iso(this.automation.clock())
    });
    return this.automation.store.replace(occurrenceKey(base.id), stored.raw, updated);
  }

  /**
   * 计划改成每次新会话：来源会话没了或被替换；飞书会话里没写模式的旧循环计划（每次带着全部历史跑，上下文越积越大；
   * 结果仍回原话题，衔接见 resultContext）；或 force（来源会话暂不可用，这次要换新会话重跑，下一次触发前改回原模式）。明确选了 session 的不动。
   */
  async fallbackToFresh(stored: { raw: string; value: SessionSchedule }, occurrenceId?: string, force = false) {
    const schedule = stored.value;
    if (schedule.mode === 'independent' || schedule.mode === 'fresh' || schedule.workTemplate || !this.automation.options.runtime.startScheduleSession) return stored;
    const origin = await this.automation.options.runtime.getSession(schedule.sessionId);
    const legacyLoop = schedule.mode === undefined && origin?.source === 'lark' && schedule.trigger.kind !== 'at';
    let replaced = false;
    try {
      const matter = this.automation.options.repositories.matters?.find('session', schedule.sessionId);
      replaced = Boolean(matter && this.automation.options.repositories.matters!.links(matter.id).some(link => link.kind === 'reply_target' && link.refId === `session:${schedule.sessionId}`));
    } catch (error) { console.warn('MATTER_LOOKUP_FAILED', error instanceof RuntimeError ? error.code : 'UNEXPECTED_ERROR'); }
    if (isSessionRunnable(origin) && !replaced && !legacyLoop && !force) return stored;
    const context = schedule.executionContext ?? (origin ? freshExecutionContext(origin) : undefined);
    if (!context) return stored;
    // 已有 admission 的触发归属不可改；结果未知仍占用原执行槽。
    const pendingId = occurrenceId ?? schedule.pendingOccurrence?.id;
    if (pendingId) {
      const pending = await this.automation.store.getRecord(occurrenceKey(pendingId), value => sessionScheduleOccurrenceSchema.parse(value));
      if (pending) {
        const fixed = await this.automation.recovery.fixOccurrenceAdmission(pending, new Map([[schedule.id, stored]]));
        if (fixed?.value.admission || fixed?.value.runStatus === 'blocked' || pending.value.taskId) return stored;
      }
    }
    const next = sessionScheduleSchema.parse({ ...schedule, mode: 'fresh', executionContext: context,
      ...(occurrenceId ? { executionSessionId: freshSessionId(schedule.id, occurrenceId) } : {}), updatedAt: iso(this.automation.clock()) });
    if (!await this.automation.store.replace(scheduleKey(schedule.id), stored.raw, next)) return (await this.automation.store.getRecord(scheduleKey(schedule.id), readStoredSessionSchedule))!;
    return { raw: JSON.stringify(next), value: next };
  }

  /**
   * 计划最近一次触发出错（开会话或派发就失败，没有任务）之后：会话暂不可用时换新会话、按同一计划时间重跑一次；
   * 其余情况（含重跑仍失败）记一次没做成，由 sendRunNotice 在原话题说明。手动执行的错误直接回给发起人，不在这里处理。
   */
  async followUpOccurrence(scheduleId: string) {
    const stored = await this.automation.store.getRecord(scheduleKey(scheduleId), readStoredSessionSchedule);
    const pending = stored?.value.pendingOccurrence;
    if (!stored || !pending || pending.triggerSource === 'manual') return;
    const streak = await this.automation.store.readStreak(scheduleId);
    const code = streak?.value.triggerError?.occurrenceId === pending.id && streak.value.occurrenceId !== pending.id ? streak.value.triggerError.code : undefined;
    if (!code) return;
    const occurrenceStored = await this.automation.store.getRecord(occurrenceKey(pending.id), value => sessionScheduleOccurrenceSchema.parse(value));
    const occurrence = occurrenceStored && migrateOccurrence(occurrenceStored.value);
    if (!occurrence || occurrence.runStatus !== 'error' || occurrence.taskId) return;
    const schedule = stored.value;
    const environmentUnavailable = ENVIRONMENT_UNAVAILABLE_CODES.has(code);
    if (!environmentUnavailable && SESSION_UNAVAILABLE_CODES.has(code) && !occurrence.id.startsWith(RETRY_OCCURRENCE_PREFIX) && schedule.mode !== 'independent'
      && schedule.enabled && !schedule.deletedAt && schedule.generation === occurrence.generation && await this.retryInFreshSession(stored, occurrence)) return;
    await this.recordOutcome(occurrence, { key: `error:${code}`, kind: environmentUnavailable ? 'environment' : 'error', reason: errorReasons[code] ?? (occurrence.error ?? code).slice(0, 160) });
  }

  /** 记下这次触发出错的错误码，供 followUpOccurrence 判断重跑和是否同因；同一计划只留最近一次。 */
  private async noteTriggerError(scheduleId: string, occurrenceId: string, code: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const prior = await this.automation.store.readStreak(scheduleId);
      const next = streakSchema.parse({ ...(prior?.value ?? { version: 1, count: 0 }), triggerError: { occurrenceId, code }, updatedAt: iso(this.automation.clock()) });
      if (await (prior ? this.automation.store.replace(streakKey(scheduleId), prior.raw, next) : this.automation.store.createRecord(streakKey(scheduleId), next))) return;
    }
  }

  /**
   * 原触发保留为出错；以派生编号在新会话里重跑同一个计划时间，结果照常回原话题。
   * 重跑借用 fresh 模式开会话；原来不是 fresh 的，先记下原模式，下一次触发前由 restoreAfterFreshRetry 改回。
   */
  private async retryInFreshSession(stored: { raw: string; value: SessionSchedule }, original: SessionScheduleOccurrenceV2) {
    const id = retryOccurrenceId(original.id);
    if (stored.value.mode !== 'fresh') {
      await this.automation.options.repositories.config.set(FRESH_RETRY_PREFIX + stored.value.id, JSON.stringify(freshRetrySchema.parse({
        version: 1, occurrenceId: id, generation: stored.value.generation, ...(stored.value.mode ? { mode: stored.value.mode } : {})
      })));
    }
    const converted = await this.fallbackToFresh(stored, id, true);
    if (converted.value.mode !== 'fresh' || converted.value.generation !== original.generation || converted.value.pendingOccurrence?.id !== original.id) return false;
    const reserved = sessionScheduleSchema.parse({ ...converted.value, ...this.automation.freshReservation(converted.value, id),
      pendingOccurrence: { id, generation: converted.value.generation, scheduledForUtc: original.scheduledForUtc } });
    if (!await this.automation.store.replace(scheduleKey(reserved.id), converted.raw, reserved)) return true;
    this.automation.warn({ scheduleId: reserved.id, occurrenceId: original.id, retryOccurrenceId: id }, '定时触发改在新会话重跑');
    const occurrence = await this.automation.materializeOccurrence(reserved);
    if (occurrence.created && occurrence.value.runStatus === 'pending') await this.processOccurrence(occurrence);
    return true;
  }

  /** 只为那次重跑才改成 fresh 的计划（重跑后没被编辑过）：返回改回原模式的字段；其余返回 undefined。 */
  async restoreAfterFreshRetry(schedule: SessionSchedule): Promise<Partial<SessionSchedule> | undefined> {
    if (schedule.mode !== 'fresh' || !schedule.executionSessionId) return undefined;
    let marker: z.infer<typeof freshRetrySchema> | undefined;
    try { marker = (await this.automation.store.getRecord(FRESH_RETRY_PREFIX + schedule.id, value => freshRetrySchema.parse(value)))?.value; }
    catch { return undefined; }
    if (!marker || marker.generation !== schedule.generation || freshSessionId(schedule.id, marker.occurrenceId) !== schedule.executionSessionId) return undefined;
    return { mode: marker.mode, executionSessionId: undefined, executionContext: undefined };
  }

  /**
   * 记一次触发的结果（同一触发只记一次）：成功清零；没做成且原因与上一次相同则累计，否则从 1 开始。
   * 触发出错或第 2 次起要在原话题说明；连续 STREAK_PAUSE 次停用计划（停用告知照常发）。
   * 环境暂不可用只累计和提示，不因累计次数停用。返回记下的状态。
   */
  async recordOutcome(occurrence: SessionScheduleOccurrenceV2, problem?: { key: string; kind: 'error' | 'result' | 'environment'; reason: string }): Promise<RunStreak | undefined> {
    const key = streakKey(occurrence.scheduleId);
    for (let attempt = 0; attempt < 3; attempt++) {
      const prior = await this.automation.store.readStreak(occurrence.scheduleId);
      if (prior?.value.occurrenceId === occurrence.id) return prior.value;
      const same = Boolean(problem && prior?.value.count && prior.value.reasonKey === problem.key);
      const count = problem ? same ? prior!.value.count + 1 : 1 : 0;
      const now = iso(this.automation.clock());
      const next = streakSchema.parse({ version: 1, occurrenceId: occurrence.id, count, updatedAt: now,
        ...(problem ? { reasonKey: problem.key, reason: problem.reason.trim().replace(/[。.!！;；,，\s]+$/u, '').slice(0, 300) } : {}),
        ...(same && prior!.value.messageId ? { messageId: prior!.value.messageId } : {}),
        ...(problem && (problem.kind !== 'result' || count > 1) ? { notice: { occurrenceId: occurrence.id, status: 'pending', attempts: 0, updatedAt: now } } : {}) });
      if (!await (prior ? this.automation.store.replace(key, prior.raw, next) : this.automation.store.createRecord(key, next))) continue;
      if (problem?.kind !== 'environment' && count >= STREAK_PAUSE) {
        const schedule = await this.automation.store.getRecord(scheduleKey(occurrence.scheduleId), readStoredSessionSchedule);
        if (schedule?.value.generation === occurrence.generation && await this.automation.disableSchedule(schedule, `连续 ${count} 次没做成（${next.reason}）`)) {
          this.automation.warn({ scheduleId: occurrence.scheduleId, occurrenceId: occurrence.id, reasonKey: problem!.key, count }, '定时计划连续没做成，已自动停用');
        }
      }
      return next;
    }
    return undefined;
  }

  /** 停用后重新启用：之前的连续没做成不再累计。 */
  async resetStreak(scheduleId: string) {
    const stored = await this.automation.store.readStreak(scheduleId);
    if (stored?.value.count) await this.automation.store.replace(streakKey(scheduleId), stored.raw, streakSchema.parse({ version: 1, occurrenceId: stored.value.occurrenceId, count: 0, updatedAt: iso(this.automation.clock()) }));
  }
}
