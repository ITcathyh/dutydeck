import {
  activeWorkItemStatuses,
  assertAdmissionMatchesAccepted,
  AutomationStore,
  CI_BINDING_GENERATION,
  CI_PREFIX,
  ciKey,
  ciRequestKey,
  CLAIM_TTL_MS,
  errorCode,
  errorMessage,
  freezeAdmission,
  freshExecutionContext,
  freshSessionId,
  iso,
  isSessionRunnable,
  legacyAdmission,
  migrateCi,
  migrateOccurrence,
  OCCURRENCE_PREFIX,
  occurrenceActorId,
  occurrenceKey,
  openRunStatuses,
  plus,
  publicOccurrence,
  publicSubscription,
  resolveAutomationActor,
  SCHEDULE_PREFIX,
  scheduleKey,
  scheduleRequestKey,
  streakKey,
  streakSchema,
  taskBindingKey,
  taskBindingSchema,
  type AutomationTaskLabel,
  type RunStreak,
  type SessionAutomationServiceOptions,
  type TaskBinding,
  type TickParseCache
} from './automation/store.js';
import {
  cancelCiInputSchema,
  canonicalExecutionJson,
  ciSubscriptionSchema,
  ciSubscriptionV2Schema,
  isTerminalTaskStatus,
  LEGACY_GITHUB_PROVIDER_ID,
  parseLarkSourceId,
  previewSessionSchedule,
  readStoredSessionSchedule,
  readTaskReport,
  runSessionScheduleInputSchema,
  RuntimeError,
  scheduleTriggerSchema,
  sessionScheduleOccurrenceSchema,
  sessionScheduleOccurrenceV2Schema,
  sessionScheduleSchema,
  subscribeCiInputSchema,
  type AcceptedTask,
  type AttemptResultV1,
  type AutomationBlockReason,
  type AutomationHistoryPage,
  type AutomationRunDetail,
  type AutomationSchedulePage,
  type AutomationScheduleQuery,
  type CiProvider,
  type CiRepository,
  type CiRun,
  type CiSubscription,
  type CiSubscriptionV2,
  type CreateSessionScheduleInput,
  type DeleteSessionScheduleInput,
  type ExecutionActor,
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
  type TaskAdmissionV1,
  type TaskRecord,
  type TaskRequestV1,
  type UpdateSessionScheduleInput
} from '@dutydeck/shared';
import { AutomationPreconditions } from './automation/precondition.js';
import { AutomationDelivery, deliverySettled } from './automation/delivery.js';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { ciProviderLabel, CiProviderRegistry, resolveCiHead, type CiHead } from './ci-providers.js';
import { observeAdmittedTask } from './task-results.js';
import { MattersService } from './matters.js';
import { workItemId } from './work-items.js';
import { recordAutomationAuthorization } from './task-authorization.js';

export {
  type SessionAutomationRuntime,
  type ScheduleOverdueNotice,
  type AutomationDeliveryContext,
  type SessionAutomationServiceOptions,
  type ScheduleWorkTemplates,
  scheduleRequestKey,
  ciRequestKey
} from './automation/store.js';

const STOP_REQUEST_PREFIX = 'session_automation/stop_request/';

const stopRequestSchema = z.object({
  version: z.literal(1), taskId: z.string().min(1), attemptId: z.string().min(1), sessionId: z.string().min(1),
  occurrenceId: z.string().min(1), scheduleId: z.string().min(1), generation: z.number().int().positive(), actorId: z.string().min(1),
  status: z.enum(['pending', 'applied', 'rejected']), reason: z.string().optional()
}).strict();

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

const DEFAULT_POLL_MS = 60_000;
const runStatuses = new Set(['queued', 'running', 'completed']);

/** 一轮扫描的时刻与迟到宽限：同一轮里排在后面的计划，不因前面开会话、派发花的时间被判迟到。 */
type ScanTiming = { observedAt: Date; graceMs: number };

/** 有完成条件的循环计划：每次运行在指令后附上完成条件与截止时间，告知 Agent 达成时用 stop-self 请求停用。 */
export function scheduleTaskPrompt(schedule: Pick<SessionSchedule, 'prompt' | 'completionCondition' | 'deadlineAt' | 'timezone'>): string {
  if (!schedule.completionCondition) return schedule.prompt;
  const lines = [schedule.prompt, '', '---', '这是一个「一直跟进，直到办完」的定时计划。', `完成条件：${schedule.completionCondition}`,
    '每次运行先核对完成条件。确认已经达成时，用本轮提供的 `schedule stop-self` 命令请求停用本计划，并在结果里写明达成依据；宿主只在本轮成功且结果确认送达后才停用。'
    + '未达成或无法确认时照常汇报进展和下一步，不要调用。本轮没有提供这个命令时，在结果开头写明「已达成完成条件」，由用户停用。'];
  if (schedule.deadlineAt) lines.push(`截止时间：${new Date(schedule.deadlineAt).toLocaleString('zh-CN', { timeZone: schedule.timezone, hour12: false })}（${schedule.timezone}）。到点仍未确认完成，宿主会自动停用本计划。`);
  return lines.join('\n');
}

function occurrenceId(schedule: SessionSchedule, scheduledForUtc: string) {
  return `occ_${createHash('sha256').update(`${schedule.id}\0${schedule.generation}\0${scheduledForUtc}`).digest('hex')}`;
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
function acceptedActorId(label: AutomationTaskLabel, accepted: AcceptedTask | undefined, admission: TaskAdmissionV1, sourceActor: ExecutionActor | undefined, session: Session | undefined) {
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

function formatCiPrompt(basePrompt: string, providerName: string, repository: string, headSha: string, runs: CiRun[]): string {
  const lines = runs.map(run => `- ${run.name.slice(0, 80)}: ${(run.conclusion ?? run.result ?? 'completed').slice(0, 40)} (run ${run.id}, ${run.url.slice(0, 400)})`);
  return `${basePrompt}\n\n${providerName} completed for ${repository} at ${headSha}:\n${lines.join('\n')}`;
}

/** 提供方返回的构建进提示词之前做一次形状检查：只留这个提交的、字段齐全的构建，同一 id 取最新一次重跑。 */
function normalizeRuns(runs: unknown, headSha: string, completedOnly = false): CiRun[] {
  if (!Array.isArray(runs)) throw new RuntimeError('CI_PROVIDER_RESPONSE_INVALID', 'CI 提供方返回的构建列表格式不正确', 502);
  const latest = new Map<number, CiRun>();
  for (const value of runs.slice(0, 100) as Array<Partial<CiRun>>) {
    if (!value || !Number.isSafeInteger(value.id) || (value.id as number) < 0 || typeof value.name !== 'string' || typeof value.url !== 'string') continue;
    if (typeof value.headSha !== 'string' || value.headSha.toLowerCase() !== headSha || !runStatuses.has(String(value.status))) continue;
    if (completedOnly && value.status !== 'completed') continue;
    const attempt = Number.isSafeInteger(value.attempt) && (value.attempt as number) > 0 ? value.attempt as number : 1;
    const run: CiRun = { id: value.id as number, name: value.name, attempt, headSha, status: value.status as CiRun['status'], url: value.url,
      ...(value.result ? { result: value.result } : {}), ...(typeof value.conclusion === 'string' ? { conclusion: value.conclusion } : {}) };
    if (!latest.has(run.id) || latest.get(run.id)!.attempt < run.attempt) latest.set(run.id, run);
  }
  return [...latest.values()].sort((left, right) => left.id - right.id);
}

const sameHead = (resolved: CiHead, provider: string, repository: CiRepository, headSha: string) =>
  resolved.provider.id === provider && resolved.repository.slug.toLowerCase() === repository.slug.toLowerCase() && resolved.headSha === headSha;

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

  readonly ownerId = `automation_${randomUUID()}`;
  readonly clock: () => Date;
  private readonly providers: CiProviderRegistry;
  private readonly pollIntervalMs: number;
  closed = false;
  private currentTick?: Promise<void>;
  private readonly manualRuns = new Set<Promise<PublicSessionScheduleOccurrence>>();
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
    this.pollIntervalMs = Math.max(60_000, Math.min(60 * 60_000, options.pollIntervalMs ?? DEFAULT_POLL_MS));
    this.providers = options.ciProviders ?? new CiProviderRegistry();

    this.store = new AutomationStore(this);
    this.preconditions = new AutomationPreconditions(this);
    this.delivery = new AutomationDelivery(this);
  }

  /** 至少装了一个 CI 插件；/ci 据此判断「未安装 CI 插件」。 */
  get ciConfigured() { return this.providers.size > 0; }

  listCiProviders(): PublicCiProvider[] { return this.providers.describe(); }

  private pollingProvider(id: string): CiProvider & Required<Pick<CiProvider, 'getPipelineStatus'>> {
    const provider = this.providers.get(id);
    if (!provider) throw new RuntimeError('CI_PROVIDER_UNAVAILABLE', `CI 插件提供方 ${id} 没有加载`, 409);
    if (typeof provider.getPipelineStatus !== 'function') throw new RuntimeError('CI_PROVIDER_POLLING_UNSUPPORTED', `${provider.displayName} 不支持查询构建状态`, 400);
    return provider as CiProvider & Required<Pick<CiProvider, 'getPipelineStatus'>>;
  }

  private async listRuns(providerId: string, repository: CiRepository, headSha: string, workflow?: string, completedOnly = false): Promise<CiRun[]> {
    const status = await this.pollingProvider(providerId).getPipelineStatus({ repository, sha: headSha, ...(workflow ? { workflow } : {}), ...(completedOnly ? { completedOnly } : {}) });
    return normalizeRuns(status?.runs, headSha, completedOnly);
  }

  /** 只在能查询构建状态的提供方里按 origin 匹配。 */
  private ciHead(cwd: string, providerId?: string) {
    return resolveCiHead(cwd, this.providers, providerId, provider => typeof provider.getPipelineStatus === 'function');
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

  async ciCondition(session: Session, input: { kind: 'ci_new_failure'; provider?: string; workflow?: string }) {
    const resolved = await this.ciHead(session.cwd, input.provider);
    const runs = await this.listRuns(resolved.provider.id, resolved.repository, resolved.headSha, input.workflow, true);
    return {
      kind: 'ci_new_failure' as const,
      provider: resolved.provider.id,
      ...(input.workflow ? { workflow: input.workflow } : {}),
      repository: resolved.repository,
      headSha: resolved.headSha,
      observedRunIds: runs.map(run => run.id),
      observedRunAttempts: runs.map(run => ({ id: run.id, attempt: run.attempt }))
    };
  }

  private buildRequest(session: Session, namespace: TaskRequestV1['namespace'], key: string, prompt: string, actor: ExecutionActor): TaskRequestV1 {
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
    if (schedule.mode !== 'independent' && schedule.mode !== 'fresh') return this.store.requireSession(schedule.sessionId);
    if (!schedule.executionSessionId || !schedule.executionContext || !this.options.runtime.startScheduleSession) {
      throw new RuntimeError('INDEPENDENT_SCHEDULE_UNAVAILABLE', 'Independent execution context is unavailable', 409);
    }
    const context = schedule.executionContext;
    const fresh = schedule.mode === 'fresh';
    const session = await this.options.runtime.startScheduleSession({
      agentId: context.agentId, cwd: fresh ? context.cwd : context.sourceCwd ?? context.cwd,
      model: context.model, codexProfile: context.codexProfile, reasoningEffort: context.reasoningEffort,
      permissionMode: context.permissionMode, source: 'schedule', sourceId: schedule.id, workspaceMode: fresh ? 'shared' : 'worktree'
    }, schedule.executionSessionId, async () => {
      await this.store.requireAuthorized(schedule.sessionId, schedule.actorId);
      const current = await this.store.getRecord(scheduleKey(schedule.id), readStoredSessionSchedule);
      if (!current || current.value.executionSessionId !== schedule.executionSessionId || current.value.deletedAt) {
        throw new RuntimeError('INDEPENDENT_SCHEDULE_REVOKED', 'Independent schedule changed before workspace creation', 403);
      }
    });
    await new MattersService(this.options.repositories).session(session.id, { sourceSessionId: schedule.sessionId, relation: 'schedule_run', title: schedule.prompt });
    this.watchSession(session.id);
    if (fresh) return session;
    if (context.cwd !== session.cwd) {
      const stored = await this.store.getRecord(scheduleKey(schedule.id), readStoredSessionSchedule);
      if (stored && context.cwd === context.sourceCwd) {
        await this.store.replace(scheduleKey(schedule.id), stored.raw, sessionScheduleSchema.parse({
          ...stored.value, executionContext: { ...context, cwd: session.cwd }
        }));
      } else if (context.cwd !== session.cwd) {
        throw new RuntimeError('INDEPENDENT_CONTEXT_CHANGED', 'Independent schedule workspace no longer matches its frozen context', 409);
      }
    }
    return session;
  }

  runSchedule(sessionId: string, id: string, rawInput: RunSessionScheduleInput, actorId?: string): Promise<PublicSessionScheduleOccurrence> {
    if (this.closed) return Promise.reject(new RuntimeError('SESSION_AUTOMATION_CLOSED', 'Session automation is shutting down', 503));
    const operation = this.runScheduleOperation(sessionId, id, rawInput, actorId);
    this.manualRuns.add(operation);
    void operation.finally(() => this.manualRuns.delete(operation)).catch(() => {});
    return operation;
  }

  private async runScheduleOperation(sessionId: string, id: string, rawInput: RunSessionScheduleInput, actorId?: string): Promise<PublicSessionScheduleOccurrence> {
    await this.store.requireAuthorized(sessionId, actorId);
    const session = await this.store.requireSession(sessionId);
    const input = runSessionScheduleInputSchema.parse(rawInput);
    let stored = await this.store.getRecord(scheduleKey(id), readStoredSessionSchedule);
    if (!stored || stored.value.sessionId !== sessionId) throw new RuntimeError('SESSION_AUTOMATION_SCHEDULE_NOT_FOUND', 'Session schedule not found', 404);
    const manualId = `occ_${createHash('sha256').update(JSON.stringify([id, 'manual', input.idempotencyKey])).digest('hex')}`;
    const existing = await this.store.getRecord(occurrenceKey(manualId), value => sessionScheduleOccurrenceSchema.parse(value));
    if (existing) return publicOccurrence(existing.value);
    // Repair a response lost between reservation and occurrence creation, even after a later edit.
    if (stored.value.pendingOccurrence?.id === manualId) {
      return this.runReservedOccurrence(stored.value);
    }
    if (stored.value.deletedAt) throw new RuntimeError('SESSION_AUTOMATION_SCHEDULE_DELETED', 'Session schedule was deleted', 409);
    if (stored.value.revision !== input.expectedRevision) throw new RuntimeError('SESSION_AUTOMATION_REVISION_CONFLICT', 'Session schedule revision changed', 409);
    stored = await this.fallbackToFresh(stored);
    if (stored.value.mode !== 'independent' && stored.value.mode !== 'fresh' && !isSessionRunnable(session)) throw new RuntimeError('SESSION_NOT_ACTIVE', 'Session is not active', 409);
    if (await this.hasPendingOccurrence(stored.value)) throw new RuntimeError('SESSION_AUTOMATION_SCHEDULE_BUSY', 'This schedule already has unfinished work', 409);
    // 专用执行会话的任务只接受计划冻结的 actor（账本按计划核对），手动执行也以它的身份运行。
    const actor = resolveAutomationActor(session, stored.value.mode === 'independent' || stored.value.mode === 'fresh' ? stored.value.actorId : actorId);
    if (!actor) throw new RuntimeError('SESSION_AUTOMATION_FORBIDDEN', 'Schedule actor domain cannot be verified', 403);
    const reserved = sessionScheduleSchema.parse({ ...stored.value, ...this.freshReservation(stored.value, manualId),
      pendingOccurrence: { id: manualId, generation: stored.value.generation, scheduledForUtc: iso(this.clock()), triggerSource: 'manual', actor } });
    if (!await this.store.replace(scheduleKey(id), stored.raw, reserved)) {
      const latest = await this.store.getRecord(scheduleKey(id), readStoredSessionSchedule);
      if (latest?.value.pendingOccurrence?.id === manualId) return this.runReservedOccurrence(latest.value);
      throw new RuntimeError('SESSION_AUTOMATION_REVISION_CONFLICT', 'Session schedule changed while reserving execution', 409);
    }
    return this.runReservedOccurrence(reserved);
  }

  private async runReservedOccurrence(schedule: SessionSchedule) {
    const occurrence = await this.materializeOccurrence(schedule);
    if (occurrence.created) await this.processOccurrence(occurrence);
    const latest = await this.store.getRecord(occurrenceKey(occurrence.value.id), value => sessionScheduleOccurrenceSchema.parse(value));
    return publicOccurrence(latest!.value);
  }

  async subscribeCi(sessionId: string, rawInput: SubscribeCiInput, actorId?: string): Promise<PublicCiSubscription> {
    await this.store.requireAuthorized(sessionId, actorId);
    const session = await this.store.requireSession(sessionId);
    if (!isSessionRunnable(session)) throw new RuntimeError('SESSION_NOT_ACTIVE', 'Session is not active', 409);
    const input = subscribeCiInputSchema.parse(rawInput);
    const resolved = await this.ciHead(session.cwd, input.provider);
    const now = this.clock();
    const id = `ci_${randomUUID()}`;
    await this.options.prepareDelivery?.(sessionId, id);
    const record = ciSubscriptionSchema.parse({
      schemaVersion: 1,
      id,
      revision: 1,
      sessionId,
      ...(actorId ? { actorId } : {}),
      provider: resolved.provider.id,
      repository: resolved.repository,
      headSha: resolved.headSha,
      ...(input.workflow ? { workflow: input.workflow } : {}),
      prompt: input.prompt ?? `Review the completed ${resolved.provider.displayName} result and continue the task.`,
      status: 'waiting',
      expiresAt: plus(now, input.ttlSeconds * 1_000),
      nextPollAt: iso(now),
      delivery: { status: this.options.deliver ? 'pending' : 'not_requested', attempts: 0, updatedAt: iso(now) },
      createdAt: iso(now),
      updatedAt: iso(now)
    });
    if (!await this.store.createRecord(ciKey(record.id), record)) throw new RuntimeError('SESSION_AUTOMATION_CONFLICT', 'CI subscription identifier already exists', 409);
    return publicSubscription(record);
  }

  async cancelCi(sessionId: string, id: string, rawInput: { expectedRevision: number }, actorId?: string): Promise<PublicCiSubscription> {
    await this.store.requireAuthorized(sessionId, actorId);
    await this.store.requireSession(sessionId);
    const input = cancelCiInputSchema.parse(rawInput);
    const stored = await this.store.getRecord(ciKey(id), value => ciSubscriptionSchema.parse(value));
    if (!stored || stored.value.sessionId !== sessionId) throw new RuntimeError('SESSION_AUTOMATION_CI_NOT_FOUND', 'CI subscription not found', 404);
    if (stored.value.taskStartedAt) throw new RuntimeError('SESSION_AUTOMATION_CI_ALREADY_STARTED', 'CI continuation has already started', 409);
    if (stored.value.revision !== input.expectedRevision) throw new RuntimeError('SESSION_AUTOMATION_REVISION_CONFLICT', 'CI subscription revision changed', 409);
    if (!['waiting', 'dispatching', 'accepted'].includes(stored.value.status)) return publicSubscription(stored.value);
    const now = iso(this.clock());
    const cancelled = ciSubscriptionSchema.parse({
      ...stored.value,
      revision: stored.value.revision + 1,
      status: 'cancelled',
      nextPollAt: undefined,
      delivery: { status: 'not_requested', attempts: stored.value.delivery.attempts, updatedAt: now },
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now
    });
    if (!await this.store.replace(ciKey(id), stored.raw, cancelled)) throw new RuntimeError('SESSION_AUTOMATION_REVISION_CONFLICT', 'CI subscription revision changed', 409);
    return publicSubscription(cancelled);
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
    finally { await Promise.allSettled([...this.manualRuns, ...this.preconditions.preconditionRuns.values(), ...[...this.delivery.deliveries.values()].map(item => item.run)]); }
  }

  async authorizeTask(task: TaskRecord, phase: 'prepare' | 'submit' = 'prepare'): Promise<void> {
    const bindingStored = await this.store.getRecord(taskBindingKey(task.id), value => taskBindingSchema.parse(value));
    if (!bindingStored) return;
    const binding = bindingStored.value;
    if (binding.sessionId !== task.sessionId) throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Automation task binding does not match its session', 403);
    const accepted = this.store.execution.getAcceptedTask(task.id);
    if (accepted && (accepted.task.sessionId !== task.sessionId || accepted.task.id !== task.id)) {
      throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Accepted task identity does not match current task', 403);
    }
    if (binding.kind === 'schedule') {
      const occurrenceStored = await this.store.getRecord(occurrenceKey(binding.occurrenceId), value => sessionScheduleOccurrenceSchema.parse(value));
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
      const schedule = await this.store.getRecord(scheduleKey(occurrence.scheduleId), readStoredSessionSchedule);
      if (!schedule) throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task definition is missing', 403);
      const started = Boolean(occurrence.taskStartedAt || schedule.value.taskStartOccurrenceId === occurrence.id);
      if (!started && (!scheduleTriggerSchema.safeParse(schedule.value.trigger).success || schedule.value.generation !== occurrence.generation || schedule.value.deletedAt || !schedule.value.enabled && occurrence.triggerSource !== 'manual' || occurrence.conditionStatus !== 'passed' || !['pending', 'accepted'].includes(occurrence.runStatus))) {
        await this.finishOccurrence(occurrenceStored, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Schedule changed before task execution' });
        throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task is no longer authorized to run', 403);
      }
      const session = await this.options.runtime.getSession(task.sessionId);
      if (!isSessionRunnable(session)) {
        if (!started) {
          await this.disableSchedule(schedule);
          await this.finishOccurrence(occurrenceStored, { conditionStatus: 'error', runStatus: 'error', error: 'Session is no longer active' });
        }
        throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task session is no longer active', 403);
      }
      const origin = await this.options.runtime.getSession(schedule.value.sessionId);
      const actorId = acceptedActorId('Scheduled task', accepted, occurrence.admission, occurrence.actor, origin);
      try { await this.store.requireAuthorized(schedule.value.sessionId, actorId); }
      catch (error) {
        if (!started) {
          await this.disableSchedule(schedule);
          await this.finishOccurrence(occurrenceStored, { conditionStatus: 'error', runStatus: 'error', error: errorMessage(error) });
        }
        throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task authorization was revoked', 403);
      }
      // 首次尚未提交时继续真正 HEAD 核验，删掉以 !accepted 为条件的 HEAD 绕过。
      if (!started && schedule.value.condition.kind === 'ci_new_failure') {
        const condition = schedule.value.condition;
        let resolved: CiHead;
        try { resolved = await this.ciHead(session!.cwd, condition.provider); }
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
          if (await this.store.replace(scheduleKey(candidate.value.id), candidate.raw, startedSchedule)) break;
          const latestSchedule = await this.store.getRecord(scheduleKey(schedule.value.id), readStoredSessionSchedule);
          const latest = latestSchedule?.value;
          if (!latest || latest.generation !== occurrence.generation || latest.deletedAt
            || latest.sessionId !== schedule.value.sessionId || latest.actorId !== schedule.value.actorId
            || latest.executionSessionId !== schedule.value.executionSessionId || latest.mode !== schedule.value.mode
            || canonicalExecutionJson(latest.executionContext ?? null) !== canonicalExecutionJson(schedule.value.executionContext ?? null)
            || !latest.enabled && occurrence.triggerSource !== 'manual' && latest.taskStartOccurrenceId !== occurrence.id
            || !isSessionRunnable(await this.options.runtime.getSession(task.sessionId))) {
            const current = await this.store.getRecord(occurrenceKey(occurrence.id), value => sessionScheduleOccurrenceSchema.parse(value));
            if (current) await this.finishOccurrence(current, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Schedule changed before submission' });
            throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task changed before submission', 409);
          }
          await this.store.requireAuthorized(latest.sessionId, actorId);
          if (latest.taskStartOccurrenceId === occurrence.id) break;
          candidate = latestSchedule!;
        }
        const currentOccurrence = await this.store.getRecord(occurrenceKey(occurrence.id), value => sessionScheduleOccurrenceSchema.parse(value));
        if (!currentOccurrence || !['passed'].includes(currentOccurrence.value.conditionStatus) || !['pending', 'accepted'].includes(currentOccurrence.value.runStatus)) {
          throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled occurrence changed before submission', 409);
        }
        const marked = sessionScheduleOccurrenceSchema.parse({ ...migrateOccurrence(currentOccurrence.value), revision: currentOccurrence.value.revision + 1, taskStartedAt: iso(this.clock()), updatedAt: iso(this.clock()) });
        if (!await this.store.replace(occurrenceKey(occurrence.id), currentOccurrence.raw, marked)) {
          const latestOccurrence = await this.store.getRecord(occurrenceKey(occurrence.id), value => sessionScheduleOccurrenceSchema.parse(value));
          const latestVal = latestOccurrence ? migrateOccurrence(latestOccurrence.value) : undefined;
          if (!latestVal || !latestVal.taskStartedAt || latestVal.scheduleId !== schedule.value.id || latestVal.generation !== occurrence.generation || !['passed'].includes(latestVal.conditionStatus) || !['pending', 'accepted'].includes(latestVal.runStatus)) {
            throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled occurrence changed before submission', 409);
          }
        }
      }
      return;
    }
    const subscriptionStored = await this.store.getRecord(ciKey(binding.subscriptionId), value => ciSubscriptionSchema.parse(value));
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
    if (!started && (!['dispatching', 'accepted'].includes(subscription.status) || new Date(subscription.expiresAt) <= this.clock())) {
      if (['dispatching', 'accepted'].includes(subscription.status) && new Date(subscription.expiresAt) <= this.clock()) await this.finishCi(subscriptionStored, 'expired', 'CI continuation expired before execution');
      throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation is no longer authorized to run', 403);
    }
    const session = await this.options.runtime.getSession(task.sessionId);
    if (!isSessionRunnable(session)) {
      if (!started) await this.finishCi(subscriptionStored, 'session_inactive', 'Session is no longer active');
      throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation session is no longer active', 403);
    }
    const ciActorId = acceptedActorId('CI continuation', accepted, subscription.admission, subscription.actor, session);
    try { await this.store.requireAuthorized(task.sessionId, ciActorId); }
    catch (error) {
      if (!started) await this.finishCi(subscriptionStored, 'revoked', errorMessage(error));
      throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation authorization was revoked', 403);
    }
    // 首次尚未提交时继续真正 HEAD 核验，删掉以 !accepted 为条件的 HEAD 绕过。
    if (!started) {
      const providerId = subscription.provider ?? LEGACY_GITHUB_PROVIDER_ID;
      let resolved: CiHead;
      try { resolved = await this.ciHead(session!.cwd, providerId); }
      catch (error) {
        await this.finishCi(subscriptionStored, 'stale_head', errorMessage(error));
        throw new RuntimeError('SESSION_AUTOMATION_TASK_STALE_HEAD', 'CI continuation HEAD is unavailable before execution', 409);
      }
      if (!sameHead(resolved, providerId, subscription.repository, subscription.headSha)) {
        await this.finishCi(subscriptionStored, 'stale_head', 'CI continuation HEAD changed before execution');
        throw new RuntimeError('SESSION_AUTOMATION_TASK_STALE_HEAD', 'CI continuation HEAD changed before execution', 409);
      }
    }
    if (phase === 'submit' && !started) {
      const current = await this.store.getRecord(ciKey(subscription.id), value => ciSubscriptionSchema.parse(value));
      const currentValue = current ? migrateCi(current.value) : undefined;
      if (!current || !currentValue || currentValue.taskStartedAt || !['dispatching', 'accepted'].includes(currentValue.status) || new Date(currentValue.expiresAt) <= this.clock()) {
        throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation changed before submission', 409);
      }
      const marked = ciSubscriptionSchema.parse({ ...currentValue, revision: currentValue.revision + 1, taskStartedAt: iso(this.clock()), updatedAt: iso(this.clock()) });
      if (!await this.store.replace(ciKey(subscription.id), current.raw, marked)) {
        const latest = await this.store.getRecord(ciKey(subscription.id), value => ciSubscriptionSchema.parse(value));
        const latestVal = latest ? migrateCi(latest.value) : undefined;
        if (!latestVal || !latestVal.taskStartedAt || !['dispatching', 'accepted'].includes(latestVal.status) || new Date(latestVal.expiresAt) <= this.clock()) {
          throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation changed before submission', 409);
        }
      }
    }
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
        const claimed = await this.renewOccurrenceLease(item);
        if (claimed) await this.processOccurrence(claimed);
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
      await this.isolate(() => this.followUpOccurrence(item.value.id));
      await this.isolate(() => this.delivery.remindOverdue(item.value));
      await this.isolate(() => this.delivery.sendRunNotice(item.value));
    }
    for (const item of subscriptions) {
      if (this.closed) return;
      await this.isolate(async () => {
        const value = migrateCi(item.value);
        if (value.status === 'waiting' && (!value.nextPollAt || new Date(value.nextPollAt) <= this.clock())) await this.claimAndPollCi(item);
        else if (value.status === 'dispatching' && (!value.leaseExpiresAt || new Date(value.leaseExpiresAt) <= this.clock())) await this.recoverDispatchingCi(item);
        else if (value.status === 'accepted' && new Date(value.expiresAt) <= this.clock() && value.taskId) {
          const task = await this.options.repositories.tasks.get?.(value.taskId);
          if (task?.status === 'queued' && !value.taskStartedAt) await this.finishCi(item, 'expired', 'CI continuation expired before execution');
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
  private freshReservation(schedule: SessionSchedule, occurrence: string) {
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

  private async materializeOccurrence(schedule: SessionSchedule) {
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
      if (occurrence.created && occurrence.value.runStatus === 'pending') await this.processOccurrence(occurrence);
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
    const restored = await this.restoreAfterFreshRetry(schedule);
    schedule = sessionScheduleSchema.parse({ ...schedule, ...restored ?? this.freshReservation(schedule, id), pendingOccurrence: {
      id, generation: schedule.generation, scheduledForUtc: schedule.nextDueAt,
      misfireDecision: { action: skip ? 'skip' : 'run', ...(misfire ? { misfire } : {}) }
    } });
    if (!await this.store.replace(scheduleKey(schedule.id), stored.raw, schedule)) return;
    // 改回原模式后，重跑用过的新会话不再是执行会话：没有未结束任务的归档。
    if (restored) await this.retireFreshSessions(schedule);
    const occurrence = await this.materializeOccurrence(schedule);
    if (occurrence.created && occurrence.value.runStatus === 'pending') await this.processOccurrence(occurrence);
    if (!openRunStatuses.has(occurrence.value.runStatus)) await this.advanceSchedule(schedule, schedule.nextDueAt!);
  }

  async renewOccurrenceLease(stored: { raw: string; value: SessionScheduleOccurrence }) {
    const now = this.clock();
    const base = migrateOccurrence(stored.value);
    const renewed = sessionScheduleOccurrenceV2Schema.parse({ ...base, revision: base.revision + 1, leaseOwner: this.ownerId, leaseExpiresAt: plus(now, CLAIM_TTL_MS), updatedAt: iso(now) });
    return await this.store.replace(occurrenceKey(stored.value.id), stored.raw, renewed) ? { raw: JSON.stringify(renewed), value: renewed } : undefined;
  }

  async processOccurrence(stored: { raw: string; value: SessionScheduleOccurrence }) {
    let occurrence = migrateOccurrence(stored.value);
    // 账本已接受（派发后崩溃、关闭或补记 CAS 落败）时先认接受事实，再做计划、会话和授权检查：作废会丢结果，下一轮还会重叠执行。
    const admission = occurrence.admission;
    const acceptedTask = admission && this.store.execution.getAcceptedTask(admission.taskId);
    if (admission && acceptedTask) {
      if (acceptedTask.request && admission.request && canonicalExecutionJson(acceptedTask.request) !== canonicalExecutionJson(admission.request)) {
        await this.finishOccurrence(stored, { runStatus: 'blocked', blockReason: 'admission_conflict', error: 'Accepted task request conflicts with source admission' });
        return;
      }
      try {
        await this.store.ensureTaskBinding(admission.taskId, {
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
    let scheduleStored = await this.store.getRecord(scheduleKey(occurrence.scheduleId), readStoredSessionSchedule);
    if (scheduleStored && !occurrence.admission && !occurrence.taskId) {
      scheduleStored = await this.fallbackToFresh(scheduleStored, occurrence.id);
      const latestOccurrence = await this.store.getRecord(occurrenceKey(occurrence.id), value => sessionScheduleOccurrenceSchema.parse(value));
      if (latestOccurrence?.raw !== stored.raw) return;
      if (scheduleStored.value.mode === 'fresh' && occurrence.executionSessionId !== scheduleStored.value.executionSessionId) {
        const next = sessionScheduleOccurrenceV2Schema.parse({ ...occurrence, executionSessionId: scheduleStored.value.executionSessionId, revision: occurrence.revision + 1 });
        if (!await this.store.replace(occurrenceKey(occurrence.id), stored.raw, next)) return;
        occurrence = next; stored = { raw: JSON.stringify(next), value: next };
      }
    }
    if (!scheduleStored || !scheduleTriggerSchema.safeParse(scheduleStored.value.trigger).success || scheduleStored.value.generation !== occurrence.generation || scheduleStored.value.deletedAt || !scheduleStored.value.enabled && occurrence.triggerSource !== 'manual'
      || scheduleStored.value.mode === 'fresh' && occurrence.executionSessionId !== scheduleStored.value.executionSessionId) {
      await this.finishOccurrence({ raw: stored.raw, value: occurrence }, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Schedule generation changed before dispatch' });
      return;
    }
    // 前置命令在开执行会话、启动工作项模板之前判定；没通过就不唤醒 Agent。
    if (!await this.preconditions.preconditionGate(scheduleStored, { raw: stored.raw, value: occurrence })) return;
    if (scheduleStored.value.workTemplate) {
      await this.startWorkTemplate(scheduleStored, { raw: stored.raw, value: occurrence });
      return;
    }
    let schedule = scheduleStored.value;
    const origin = await this.options.runtime.getSession(schedule.sessionId);
    let sessionMaybe: Session | undefined;
    try { sessionMaybe = schedule.mode === 'independent' || schedule.mode === 'fresh' ? await this.executionSession(schedule) : origin; }
    catch (error) {
      const accepted = occurrence.admission && this.store.execution.getAcceptedTask(occurrence.admission.taskId);
      if (error instanceof RuntimeError && ENVIRONMENT_UNAVAILABLE_CODES.has(error.code)) {
        this.warn({ scheduleId: schedule.id, occurrenceId: occurrence.id, sessionId: schedule.executionSessionId, code: error.code }, '定时触发时 Agent 环境暂不可用');
        // 已接受的任务仍按原账本对账；只有确认未接受才记录这次环境漏跑。
        if (!accepted) await this.noteTriggerError(schedule.id, occurrence.id, error.code);
      } else {
        // 新会话暂时开不出来不停用计划：记为触发出错，由 followUpOccurrence 重跑一次或在原话题说明。
        const unavailable = !accepted && error instanceof RuntimeError && SESSION_UNAVAILABLE_CODES.has(error.code);
        if (unavailable) {
          this.warn({ scheduleId: schedule.id, occurrenceId: occurrence.id, sessionId: schedule.executionSessionId, code: error.code }, '定时触发时执行会话暂不可用');
          await this.noteTriggerError(schedule.id, occurrence.id, error.code);
        } else await this.disableSchedule(scheduleStored, errorMessage(error));
      }
      await this.finishOccurrence(stored, { conditionStatus: 'error', runStatus: accepted ? 'blocked' : 'error',
        ...(accepted ? { blockReason: 'admission_conflict' as const } : {}), error: errorMessage(error) });
      return;
    }
    if (!isSessionRunnable(sessionMaybe)) {
      await this.disableSchedule(scheduleStored, 'Session is no longer active');
      await this.finishOccurrence({ raw: stored.raw, value: occurrence }, { conditionStatus: 'error', runStatus: 'error', error: 'Session is no longer active' });
      return;
    }
    const session = sessionMaybe!;
    const actorId = occurrence.triggerSource === 'manual' && occurrence.actor?.kind !== 'unspecified' ? occurrence.actor?.id : schedule.actorId;
    try { await this.store.requireAuthorized(schedule.sessionId, actorId); }
    catch (error) {
      await this.disableSchedule(scheduleStored);
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
        const resolved = await this.ciHead(session!.cwd, condition.provider);
        if (!sameHead(resolved, condition.provider, condition.repository, condition.headSha)) {
          throw new Error('CI repository or HEAD changed after the schedule generation was created');
        }
        const runs = await this.listRuns(condition.provider, condition.repository, condition.headSha, condition.workflow, true);
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
      const currentSchedule = await this.store.getRecord(scheduleKey(schedule.id), readStoredSessionSchedule);
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
        updatedAt: iso(this.clock())
      });
      if (!await this.store.replace(occurrenceKey(occurrence.id), working.raw, evaluated)) return;
      working = { raw: JSON.stringify(evaluated), value: evaluated };
    }
    const persistedCondition = schedule.condition;
    if (persistedCondition.kind === 'ci_new_failure' && working.value.conditionObservedRunIds) {
      const observedRunIds = [...new Set([...persistedCondition.observedRunIds, ...working.value.conditionObservedRunIds])].sort((a, b) => a - b).slice(-100);
      const attempts = new Map(persistedCondition.observedRunAttempts?.map(run => [run.id, run.attempt]));
      for (const run of working.value.conditionObservedRunAttempts ?? []) attempts.set(run.id, Math.max(attempts.get(run.id) ?? 0, run.attempt));
      const observedRunAttempts = observedRunIds.filter(id => attempts.has(id)).map(id => ({ id, attempt: attempts.get(id)! }));
      const latestSchedule = await this.store.getRecord(scheduleKey(schedule.id), readStoredSessionSchedule);
      if (!latestSchedule || latestSchedule.value.generation !== occurrence.generation) return;
      const updated = sessionScheduleSchema.parse({ ...latestSchedule.value, condition: { ...persistedCondition, observedRunIds, observedRunAttempts } });
      if (!await this.store.replace(scheduleKey(schedule.id), latestSchedule.raw, updated)) {
        await this.finishOccurrence(working, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Schedule changed while its condition was evaluated' });
        return;
      }
      schedule = updated;
    }
    try { await this.store.requireAuthorized(schedule.sessionId, actorId); }
    catch (error) {
      const currentSchedule = await this.store.getRecord(scheduleKey(schedule.id), readStoredSessionSchedule);
      if (currentSchedule?.value.generation === schedule.generation) await this.disableSchedule(currentSchedule);
      await this.finishOccurrence(working, { conditionStatus: 'error', runStatus: 'error', error: errorMessage(error) });
      return;
    }
    if (conditionStatus !== 'passed') {
      await this.finishOccurrence(working, { conditionStatus, runStatus: conditionStatus === 'skipped' ? 'skipped' : conditionStatus === 'invalidated' ? 'invalidated' : 'error', ...(conditionError ? { error: conditionError } : {}), admission: undefined });
      // 条件查不了（例如工作区换了提交）算一次没做成：在原话题说明，连续 STREAK_PAUSE 次自动停用。
      if (conditionStatus === 'error' && occurrence.triggerSource !== 'manual') {
        await this.recordOutcome(working.value, { key: 'condition:error', kind: 'error', reason: conditionErrorReason(conditionError) });
      }
      if (occurrence.triggerSource !== 'manual') await this.advanceSchedule(schedule, occurrence.scheduledForUtc);
      return;
    }

    const accepted = sessionScheduleOccurrenceV2Schema.parse({ ...working.value, revision: working.value.revision + 1, conditionStatus: 'passed', updatedAt: iso(this.clock()) });
    if (!await this.store.replace(occurrenceKey(occurrence.id), working.raw, accepted)) return;
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
        existingAccepted = this.store.execution.lookupAccepted(candidateRequest);
      } catch (err) {
        await this.finishOccurrence({ raw: JSON.stringify(accepted), value: accepted }, { runStatus: 'blocked', blockReason: 'admission_conflict', error: errorMessage(err) });
        if (occurrence.triggerSource !== 'manual') await this.advanceSchedule(schedule, occurrence.scheduledForUtc);
        return;
      }
      const frozen = freezeAdmission('schedule', session.id, candidateRequest, existingAccepted, actor);
      ({ request } = frozen);
      ({ taskId, taskIdVersion } = frozen.admission);
      const withAdmission = sessionScheduleOccurrenceV2Schema.parse({
        ...accepted,
        revision: accepted.revision + 1,
        ...frozen.fields,
        updatedAt: iso(this.clock())
      });
      if (!await this.store.replace(occurrenceKey(occurrence.id), JSON.stringify(accepted), withAdmission)) return;
      occurrenceWithAdmission = { raw: JSON.stringify(withAdmission), value: withAdmission };
    }
    await this.dispatchOccurrence(occurrenceWithAdmission, request, taskId, taskIdVersion);
    if (occurrence.triggerSource !== 'manual') await this.advanceSchedule(schedule, occurrence.scheduledForUtc);
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
        await this.advanceSchedule(schedule, occurrence.scheduledForUtc);
      }
    };
    try { await this.store.requireAuthorized(schedule.sessionId, actorId); }
    catch (error) {
      await this.disableSchedule(scheduleStored);
      await this.finishOccurrence(stored, { conditionStatus: 'error', runStatus: 'error', error: errorMessage(error) });
      return;
    }
    if (!this.options.workTemplates) { await fail('WORK_TEMPLATE_UNAVAILABLE', '本实例没有启用工作项模板，无法启动'); return; }
    const workTemplates = this.options.workTemplates;
    // 启动前记下启动者：计划之后改归属，也能按原身份派生和核对这次的工作项；重试沿用同一身份。
    if (actorId && !occurrence.actorId) {
      const withActor = sessionScheduleOccurrenceV2Schema.parse({ ...occurrence, revision: occurrence.revision + 1, actorId, updatedAt: iso(this.clock()) });
      if (!await this.store.replace(occurrenceKey(occurrence.id), stored.raw, withActor)) return;
      stored = { raw: JSON.stringify(withActor), value: withActor };
      occurrence = withActor;
    }
    const records = (await this.store.listRecords(OCCURRENCE_PREFIX, value => sessionScheduleOccurrenceSchema.parse(value), undefined, { field: 'runStatus', values: ['completed', 'error'], scheduleId: schedule.id }))
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
        if (occurrence.triggerSource !== 'manual') await this.advanceSchedule(schedule, occurrence.scheduledForUtc);
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
        const current = (await this.store.getRecord(scheduleKey(schedule.id), readStoredSessionSchedule))?.value;
        // 仅改名等不换代际的写入也会输掉精确 CAS；保留 pending，下次按新快照重试。
        if (current && current.generation === occurrence.generation && !current.deletedAt && (current.enabled || occurrence.triggerSource === 'manual')) {
          await this.store.replace(occurrenceKey(occurrence.id), stored.raw, sessionScheduleOccurrenceV2Schema.parse({ ...occurrence, revision: occurrence.revision + 1, leaseExpiresAt: iso(this.clock()), updatedAt: iso(this.clock()) }));
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
      await this.advanceSchedule(schedule, occurrence.scheduledForUtc);
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
        this.warn({ scheduleId: occurrence.scheduleId, occurrenceId: occurrence.id, sessionId: request.sessionId, code: errorCode(error) }, '定时触发派发失败');
        if (occurrence.triggerSource !== 'manual') await this.noteTriggerError(occurrence.scheduleId, occurrence.id, errorCode(error));
        await this.finishOccurrence(stored, { runStatus: 'error', error: errorMessage(error) });
      }
    });
  }

  /**
   * 按已固定的准入派发一条自动化任务。重投先查接受事实，命中只补同一映射，不再读 HEAD/材料、不重拼 prompt；
   * 派发报错时以执行账本是否已接受为准。结算交给调用方：accepted 记接受，conflict 记准入冲突（afterDispatch 区分派发前后），failed 记派发失败。
   */
  private async dispatchAdmitted(request: TaskRequestV1, taskId: string, binding: TaskBinding, settle: {
    accepted: (taskId: string) => Promise<unknown>;
    conflict: (error: string, afterDispatch: boolean) => Promise<unknown>;
    failed: (error: unknown) => Promise<unknown>;
  }) {
    const acceptedBefore = this.store.execution.getAcceptedTask(taskId);
    if (acceptedBefore?.request && canonicalExecutionJson(acceptedBefore.request) !== canonicalExecutionJson(request)) {
      await settle.conflict('The task key already belongs to a different accepted request', false);
      return;
    }
    await recordAutomationAuthorization(this.options.repositories.config, request, taskId);
    await this.store.ensureTaskBinding(taskId, binding);
    if (acceptedBefore) {
      await settle.accepted(taskId);
      return;
    }
    try {
      const task = await this.options.runtime.dispatchRequest(request);
      if (task.id !== taskId) throw new RuntimeError('SESSION_AUTOMATION_TASK_CONFLICT', 'Runtime task identity did not match the fixed admission', 409);
      await settle.accepted(task.id);
    } catch (error) {
      if (this.closed) return;
      const durable = this.store.execution.getAcceptedTask(taskId);
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
      const current = await this.store.getRecord(occurrenceKey(stored.value.id), input => sessionScheduleOccurrenceSchema.parse(input));
      if (!current) return;
      const currentValue = migrateOccurrence(current.value);
      if (currentValue.runStatus !== 'pending') return;
      if (currentValue.scheduleId !== stored.value.scheduleId || currentValue.generation !== stored.value.generation) return;
      // CAS 核原来源身份/代际：冻结 admission 的 taskId 必须与实际接受 Task 一致，不借最新 pending 绑定不同请求。
      const frozenTaskId = currentValue.admission?.taskId ?? migrateOccurrence(stored.value).admission?.taskId;
      if (frozenTaskId && frozenTaskId !== taskId) return;
      const updated = sessionScheduleOccurrenceV2Schema.parse({ ...currentValue, revision: currentValue.revision + 1, runStatus: 'accepted', taskId, acceptedAt: currentValue.acceptedAt ?? iso(this.clock()), leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: iso(this.clock()) });
      if (await this.store.replace(occurrenceKey(stored.value.id), current.raw, updated)) return;
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
      ...(shouldResetDelivery ? { delivery: this.delivery.undelivered(base.delivery) } : {}),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: iso(this.clock())
    });
    return this.store.replace(occurrenceKey(base.id), stored.raw, updated);
  }

  async advanceSchedule(schedule: SessionSchedule, due: string) {
    const current = await this.store.getRecord(scheduleKey(schedule.id), readStoredSessionSchedule);
    if (!current || current.value.generation !== schedule.generation || current.value.nextDueAt !== due) return;
    const upcoming = previewSessionSchedule(current.value, this.clock())?.scheduledForUtc;
    const updated = sessionScheduleSchema.parse({ ...current.value, nextDueAt: upcoming });
    await this.store.replace(scheduleKey(schedule.id), current.raw, updated);
  }

  /**
   * 计划改成每次新会话：来源会话没了或被替换；飞书会话里没写模式的旧循环计划（每次带着全部历史跑，上下文越积越大；
   * 结果仍回原话题，衔接见 resultContext）；或 force（来源会话暂不可用，这次要换新会话重跑，下一次触发前改回原模式）。明确选了 session 的不动。
   */
  private async fallbackToFresh(stored: { raw: string; value: SessionSchedule }, occurrenceId?: string, force = false) {
    const schedule = stored.value;
    if (schedule.mode === 'independent' || schedule.mode === 'fresh' || schedule.workTemplate || !this.options.runtime.startScheduleSession) return stored;
    const origin = await this.options.runtime.getSession(schedule.sessionId);
    const legacyLoop = schedule.mode === undefined && origin?.source === 'lark' && schedule.trigger.kind !== 'at';
    let replaced = false;
    try {
      const matter = this.options.repositories.matters?.find('session', schedule.sessionId);
      replaced = Boolean(matter && this.options.repositories.matters!.links(matter.id).some(link => link.kind === 'reply_target' && link.refId === `session:${schedule.sessionId}`));
    } catch (error) { console.warn('MATTER_LOOKUP_FAILED', error instanceof RuntimeError ? error.code : 'UNEXPECTED_ERROR'); }
    if (isSessionRunnable(origin) && !replaced && !legacyLoop && !force) return stored;
    const context = schedule.executionContext ?? (origin ? freshExecutionContext(origin) : undefined);
    if (!context) return stored;
    // 已有 admission 的触发归属不可改；结果未知仍占用原执行槽。
    const pendingId = occurrenceId ?? schedule.pendingOccurrence?.id;
    if (pendingId) {
      const pending = await this.store.getRecord(occurrenceKey(pendingId), value => sessionScheduleOccurrenceSchema.parse(value));
      if (pending) {
        const fixed = await this.fixOccurrenceAdmission(pending, new Map([[schedule.id, stored]]));
        if (fixed?.value.admission || fixed?.value.runStatus === 'blocked' || pending.value.taskId) return stored;
      }
    }
    const next = sessionScheduleSchema.parse({ ...schedule, mode: 'fresh', executionContext: context,
      ...(occurrenceId ? { executionSessionId: freshSessionId(schedule.id, occurrenceId) } : {}), updatedAt: iso(this.clock()) });
    if (!await this.store.replace(scheduleKey(schedule.id), stored.raw, next)) return (await this.store.getRecord(scheduleKey(schedule.id), readStoredSessionSchedule))!;
    return { raw: JSON.stringify(next), value: next };
  }

  /**
   * 计划最近一次触发出错（开会话或派发就失败，没有任务）之后：会话暂不可用时换新会话、按同一计划时间重跑一次；
   * 其余情况（含重跑仍失败）记一次没做成，由 sendRunNotice 在原话题说明。手动执行的错误直接回给发起人，不在这里处理。
   */
  private async followUpOccurrence(scheduleId: string) {
    const stored = await this.store.getRecord(scheduleKey(scheduleId), readStoredSessionSchedule);
    const pending = stored?.value.pendingOccurrence;
    if (!stored || !pending || pending.triggerSource === 'manual') return;
    const streak = await this.store.readStreak(scheduleId);
    const code = streak?.value.triggerError?.occurrenceId === pending.id && streak.value.occurrenceId !== pending.id ? streak.value.triggerError.code : undefined;
    if (!code) return;
    const occurrenceStored = await this.store.getRecord(occurrenceKey(pending.id), value => sessionScheduleOccurrenceSchema.parse(value));
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
      const prior = await this.store.readStreak(scheduleId);
      const next = streakSchema.parse({ ...(prior?.value ?? { version: 1, count: 0 }), triggerError: { occurrenceId, code }, updatedAt: iso(this.clock()) });
      if (await (prior ? this.store.replace(streakKey(scheduleId), prior.raw, next) : this.store.createRecord(streakKey(scheduleId), next))) return;
    }
  }

  /**
   * 原触发保留为出错；以派生编号在新会话里重跑同一个计划时间，结果照常回原话题。
   * 重跑借用 fresh 模式开会话；原来不是 fresh 的，先记下原模式，下一次触发前由 restoreAfterFreshRetry 改回。
   */
  private async retryInFreshSession(stored: { raw: string; value: SessionSchedule }, original: SessionScheduleOccurrenceV2) {
    const id = retryOccurrenceId(original.id);
    if (stored.value.mode !== 'fresh') {
      await this.options.repositories.config.set(FRESH_RETRY_PREFIX + stored.value.id, JSON.stringify(freshRetrySchema.parse({
        version: 1, occurrenceId: id, generation: stored.value.generation, ...(stored.value.mode ? { mode: stored.value.mode } : {})
      })));
    }
    const converted = await this.fallbackToFresh(stored, id, true);
    if (converted.value.mode !== 'fresh' || converted.value.generation !== original.generation || converted.value.pendingOccurrence?.id !== original.id) return false;
    const reserved = sessionScheduleSchema.parse({ ...converted.value, ...this.freshReservation(converted.value, id),
      pendingOccurrence: { id, generation: converted.value.generation, scheduledForUtc: original.scheduledForUtc } });
    if (!await this.store.replace(scheduleKey(reserved.id), converted.raw, reserved)) return true;
    this.warn({ scheduleId: reserved.id, occurrenceId: original.id, retryOccurrenceId: id }, '定时触发改在新会话重跑');
    const occurrence = await this.materializeOccurrence(reserved);
    if (occurrence.created && occurrence.value.runStatus === 'pending') await this.processOccurrence(occurrence);
    return true;
  }

  /** 只为那次重跑才改成 fresh 的计划（重跑后没被编辑过）：返回改回原模式的字段；其余返回 undefined。 */
  private async restoreAfterFreshRetry(schedule: SessionSchedule): Promise<Partial<SessionSchedule> | undefined> {
    if (schedule.mode !== 'fresh' || !schedule.executionSessionId) return undefined;
    let marker: z.infer<typeof freshRetrySchema> | undefined;
    try { marker = (await this.store.getRecord(FRESH_RETRY_PREFIX + schedule.id, value => freshRetrySchema.parse(value)))?.value; }
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
      const prior = await this.store.readStreak(occurrence.scheduleId);
      if (prior?.value.occurrenceId === occurrence.id) return prior.value;
      const same = Boolean(problem && prior?.value.count && prior.value.reasonKey === problem.key);
      const count = problem ? same ? prior!.value.count + 1 : 1 : 0;
      const now = iso(this.clock());
      const next = streakSchema.parse({ version: 1, occurrenceId: occurrence.id, count, updatedAt: now,
        ...(problem ? { reasonKey: problem.key, reason: problem.reason.trim().replace(/[。.!！;；,，\s]+$/u, '').slice(0, 300) } : {}),
        ...(same && prior!.value.messageId ? { messageId: prior!.value.messageId } : {}),
        ...(problem && (problem.kind !== 'result' || count > 1) ? { notice: { occurrenceId: occurrence.id, status: 'pending', attempts: 0, updatedAt: now } } : {}) });
      if (!await (prior ? this.store.replace(key, prior.raw, next) : this.store.createRecord(key, next))) continue;
      if (problem?.kind !== 'environment' && count >= STREAK_PAUSE) {
        const schedule = await this.store.getRecord(scheduleKey(occurrence.scheduleId), readStoredSessionSchedule);
        if (schedule?.value.generation === occurrence.generation && await this.disableSchedule(schedule, `连续 ${count} 次没做成（${next.reason}）`)) {
          this.warn({ scheduleId: occurrence.scheduleId, occurrenceId: occurrence.id, reasonKey: problem!.key, count }, '定时计划连续没做成，已自动停用');
        }
      }
      return next;
    }
    return undefined;
  }

  /** 停用后重新启用：之前的连续没做成不再累计。 */
  async resetStreak(scheduleId: string) {
    const stored = await this.store.readStreak(scheduleId);
    if (stored?.value.count) await this.store.replace(streakKey(scheduleId), stored.raw, streakSchema.parse({ version: 1, occurrenceId: stored.value.occurrenceId, count: 0, updatedAt: iso(this.clock()) }));
  }

  private async synchronizeLifecycle(snapshot: { raw: string; value: SessionSchedule }) {
    let stored = await this.store.getRecord(scheduleKey(snapshot.value.id), readStoredSessionSchedule);
    if (!stored) return;
    if (stored.value.enabled && !stored.value.pendingOccurrence) stored = await this.fallbackToFresh(stored);
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

  private async claimAndPollCi(stored: { raw: string; value: CiSubscription }) {
    const now = this.clock();
    const base = migrateCi(stored.value);
    if (new Date(base.expiresAt) <= now) {
      const expired = ciSubscriptionV2Schema.parse({ ...base, revision: base.revision + 1, schemaVersion: 2, status: 'expired', nextPollAt: undefined, updatedAt: iso(now) });
      await this.store.replace(ciKey(base.id), stored.raw, expired);
      return;
    }
    if (base.leaseExpiresAt && new Date(base.leaseExpiresAt) > now) return;
    const claimed = await this.claimCiLease(stored.raw, base, now);
    if (!claimed) return;
    await this.pollCi(claimed);
  }

  /** 以 CAS 领取 CI 订阅租约；被他人改过返回 undefined。 */
  private async claimCiLease(raw: string, base: CiSubscriptionV2, now: Date) {
    const claimed = ciSubscriptionV2Schema.parse({ ...base, revision: base.revision + 1, schemaVersion: 2, leaseOwner: this.ownerId, leaseExpiresAt: plus(now, CLAIM_TTL_MS), updatedAt: iso(now) });
    return await this.store.replace(ciKey(base.id), raw, claimed) ? { raw: JSON.stringify(claimed), value: claimed } : undefined;
  }

  private async pollCi(stored: { raw: string; value: CiSubscription }) {
    const current0 = migrateCi(stored.value);
    const providerId = current0.provider ?? LEGACY_GITHUB_PROVIDER_ID;
    let runs: CiRun[];
    try { runs = await this.listRuns(providerId, current0.repository, current0.headSha, current0.workflow); }
    catch (error) {
      await this.returnCiToWaiting(stored, errorMessage(error));
      return;
    }
    if (runs.length === 0 || runs.some(run => run.status !== 'completed')) {
      await this.returnCiToWaiting(stored);
      return;
    }
    const current = await this.store.getRecord(ciKey(current0.id), value => ciSubscriptionSchema.parse(value));
    if (!current) return;
    const currentValue = migrateCi(current.value);
    if (currentValue.status !== 'waiting' || currentValue.leaseOwner !== this.ownerId) return;
    const session = await this.options.runtime.getSession(currentValue.sessionId);
    if (!isSessionRunnable(session)) {
      await this.finishCi(current, 'session_inactive', 'Session is no longer active');
      return;
    }
    let resolved: CiHead;
    try { resolved = await this.ciHead(session!.cwd, providerId); }
    catch (error) { await this.finishCi(current, 'stale_head', errorMessage(error)); return; }
    if (!sameHead(resolved, providerId, currentValue.repository, currentValue.headSha)) {
      await this.finishCi(current, 'stale_head', 'Session repository or HEAD changed while waiting for CI');
      return;
    }
    try { await this.store.requireAuthorized(currentValue.sessionId, currentValue.actorId); }
    catch (error) { await this.finishCi(current, 'revoked', errorMessage(error)); return; }
    // 首次 dispatchPrompt 在收到完成 run 列表后冻结；恢复使用原文本，不再拼接提供方新的返回。
    const dispatchPrompt = formatCiPrompt(currentValue.prompt, ciProviderLabel(this.providers, providerId), currentValue.repository.slug, currentValue.headSha, runs);
    const dispatching = ciSubscriptionV2Schema.parse({
      ...currentValue,
      schemaVersion: 2,
      revision: currentValue.revision + 1,
      status: 'dispatching',
      completedRunIds: runs.map(run => run.id),
      dispatchPrompt,
      nextPollAt: undefined,
      updatedAt: iso(this.clock())
    });
    if (!await this.store.replace(ciKey(currentValue.id), current.raw, dispatching)) return;
    await this.dispatchCi({ raw: JSON.stringify(dispatching), value: dispatching }, session!);
  }

  private async recoverDispatchingCi(stored: { raw: string; value: CiSubscription }) {
    const claimed0 = migrateCi(stored.value);
    if (!claimed0.dispatchPrompt) {
      await this.finishCi(stored, 'error', 'Persisted CI continuation prompt is missing');
      return;
    }
    const now = this.clock();
    const expired = new Date(claimed0.expiresAt) <= now;

    // 统一来源恢复前序：先读原 admission/明确 taskId，在任何新 HEAD/材料/当前默认配置前核实际接受事实。
    if (claimed0.admission) {
      const accepted = this.store.execution.getAcceptedTask(claimed0.admission.taskId);
      if (accepted) {
        // 恢复命中已接受事实：完整接受 request 必须与冻结 admission 相等，否则持久 blocked，不借 ID 补映射。
        if (accepted.request && claimed0.admission.request && canonicalExecutionJson(accepted.request) !== canonicalExecutionJson(claimed0.admission.request)) {
          await this.finishCi(stored, 'blocked', 'The accepted task request conflicts with the frozen CI admission');
          return;
        }
        // TTL 只拒绝尚未获得提交授权的工作；已开始的任务即使 accepted 回写丢失也要收尾投递。
        if (expired && !claimed0.taskStartedAt) { await this.finishCi(stored, 'expired', 'CI continuation expired before execution'); return; }
        await this.store.ensureTaskBinding(claimed0.admission.taskId, {
          schemaVersion: 2,
          kind: 'ci',
          sessionId: claimed0.sessionId,
          subscriptionId: claimed0.id,
          taskId: claimed0.admission.taskId,
          taskIdVersion: claimed0.admission.taskIdVersion,
          generation: CI_BINDING_GENERATION
        });
        await this.markCiAccepted(claimed0.id, claimed0.admission.taskId);
        return;
      }
    }

    const claimed = await this.claimCiLease(stored.raw, claimed0, now);
    if (!claimed) return;
    const session = await this.options.runtime.getSession(claimed.value.sessionId);
    if (!isSessionRunnable(session)) { await this.finishCi(claimed, 'session_inactive', 'Session is no longer active'); return; }
    try {
      await this.store.requireAuthorized(claimed.value.sessionId, claimed.value.actorId);
    } catch (error) {
      await this.finishCi(claimed, 'revoked', errorMessage(error));
      return;
    }
    await this.dispatchCi(claimed, session!);
  }

  private async dispatchCi(dispatching: { value: CiSubscriptionV2; raw: string }, session: Session) {
    let record = dispatching.value;
    const prompt = record.dispatchPrompt;
    if (!prompt) throw new RuntimeError('SESSION_AUTOMATION_CI_PROMPT_MISSING', 'Persisted CI continuation prompt is missing', 500);
    const actor = record.actor ?? resolveAutomationActor(session, record.actorId);
    if (!actor) { await this.finishCi({ raw: dispatching.raw, value: record }, 'error', 'CI actor domain cannot be verified'); return; }

    let request: TaskRequestV1;
    let taskId: string;
    let taskIdVersion: 'v1' | 'legacy' = 'v1';

    if (record.admission) {
      // 原样使用已冻结的 request，绝不用新默认值覆盖！
      request = record.admission.request ?? this.buildRequest(session, 'automation', ciRequestKey(record.id), prompt, actor);
      taskId = record.admission.taskId;
      taskIdVersion = record.admission.taskIdVersion;
    } else {
      const candidateRequest = this.buildRequest(session, 'automation', ciRequestKey(record.id), prompt, actor);
      let existingAccepted;
      try {
        existingAccepted = this.store.execution.lookupAccepted(candidateRequest);
      } catch (err) {
        await this.finishCi({ raw: dispatching.raw, value: record }, 'blocked', errorMessage(err));
        return;
      }
      const frozen = freezeAdmission('automation', record.sessionId, candidateRequest, existingAccepted, actor);
      ({ request } = frozen);
      ({ taskId, taskIdVersion } = frozen.admission);
      const withAdmission = ciSubscriptionV2Schema.parse({
        ...record,
        schemaVersion: 2,
        revision: record.revision + 1,
        ...frozen.fields,
        updatedAt: iso(this.clock())
      });
      if (!await this.store.replace(ciKey(record.id), dispatching.raw, withAdmission)) return;
      record = withAdmission;
    }

    const stored: { raw: string; value: CiSubscriptionV2 } = { raw: JSON.stringify(record), value: record };
    const subscriptionId = record.id;
    await this.dispatchAdmitted(request, taskId, {
      schemaVersion: 2,
      kind: 'ci',
      sessionId: record.sessionId,
      subscriptionId,
      taskId,
      taskIdVersion,
      generation: CI_BINDING_GENERATION
    }, {
      accepted: id => this.markCiAccepted(subscriptionId, id),
      conflict: (error, afterDispatch) => afterDispatch
        ? this.finishCi(stored, { status: 'blocked', blockReason: 'admission_conflict', error })
        : this.finishCi(stored, 'blocked', error),
      failed: async error => {
        const latest = await this.store.getRecord(ciKey(subscriptionId), value => ciSubscriptionSchema.parse(value));
        if (latest) await this.finishCi(latest, { status: 'error', error: errorMessage(error) });
      }
    });
  }

  private async returnCiToWaiting(stored: { raw: string; value: CiSubscription }, error?: string) {
    const now = this.clock();
    const base = migrateCi(stored.value);
    const waiting = ciSubscriptionV2Schema.parse({
      ...base,
      schemaVersion: 2,
      revision: base.revision + 1,
      status: 'waiting',
      nextPollAt: plus(now, this.pollIntervalMs),
      ...(error ? { error } : { error: undefined }),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: iso(now)
    });
    await this.store.replace(ciKey(base.id), stored.raw, waiting);
  }

  private async finishCi(stored: { raw: string; value: CiSubscription }, patchOrStatus: CiSubscriptionV2['status'] | Partial<CiSubscriptionV2>, error?: string) {
    const patch: Partial<CiSubscriptionV2> = typeof patchOrStatus === 'string'
      ? { status: patchOrStatus, ...(error ? { error } : {}) }
      : { ...patchOrStatus, ...(error ? { error } : {}) };
    const base = migrateCi(stored.value);
    const status = patch.status ?? base.status;
    const noDelivery = !['waiting', 'dispatching', 'accepted', 'completed'].includes(status);
    const shouldResetDelivery = noDelivery && base.delivery.status !== 'delivered';
    const updated = ciSubscriptionV2Schema.parse({
      ...base,
      ...patch,
      schemaVersion: 2,
      revision: base.revision + 1,
      status,
      nextPollAt: undefined,
      ...(shouldResetDelivery ? { delivery: this.delivery.undelivered(base.delivery) } : {}),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: iso(this.clock())
    });
    await this.store.replace(ciKey(base.id), stored.raw, updated);
  }

  private async markCiAccepted(id: string, taskId: string) {
    const current = await this.store.getRecord(ciKey(id), value => ciSubscriptionSchema.parse(value));
    if (!current) return;
    const currentValue = migrateCi(current.value);
    if (currentValue.status !== 'dispatching') return;
    // CAS 核原来源身份：冻结 admission 的 taskId 必须与实际接受 Task 一致，不借最新 dispatching 记录绑定不同请求。
    if (currentValue.admission && currentValue.admission.taskId !== taskId) return;
    const accepted = ciSubscriptionV2Schema.parse({ ...currentValue, schemaVersion: 2, revision: currentValue.revision + 1, status: 'accepted', taskId, leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: iso(this.clock()) });
    await this.store.replace(ciKey(id), current.raw, accepted);
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
  private async fixOccurrenceAdmission(item: { raw: string; value: SessionScheduleOccurrence }, schedules: Map<string, { raw: string; value: SessionSchedule }>): Promise<{ raw: string; value: SessionScheduleOccurrenceV2 } | undefined> {
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
        const candidateRequest = this.buildRequest(session, 'schedule', scheduleRequestKey(value.id), scheduleTaskPrompt(scheduleStored.value), actor);
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
      const candidateRequest = this.buildRequest(session, 'automation', ciRequestKey(value.id), value.dispatchPrompt, actor);
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
        await this.finishOccurrence(working, { runStatus: 'blocked', blockReason: 'admission_conflict', error: errorMessage(err) });
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
        await this.finishOccurrence(working, {
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
        await this.finishOccurrence(working, {
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
      const streak = runStatus !== 'interrupted' && value.triggerSource !== 'manual' ? await this.recordOutcome(value, problem) : undefined;
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
        await this.finishOccurrence(working, { runStatus: 'blocked', blockReason: 'legacy_output_unresolved', resultBoundary: 'legacy_output_unresolved' });
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
        await this.finishCi(working, { status: 'blocked', blockReason: 'admission_conflict', error: errorMessage(err) });
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
        await this.finishCi(working, {
          status: 'blocked',
          ...(outcome.reason ? { blockReason: outcome.reason } : {}),
          ...(outcome.reason === 'legacy_output_unresolved' ? { resultBoundary: 'legacy_output_unresolved' } : {}),
          error: outcome.message
        });
      }
      return;
    }
    if (outcome.status === 'cancelled') {
      if (working.value.status === 'accepted' || working.value.status === 'dispatching') await this.finishCi(working, 'cancelled');
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
        await this.finishCi(working, 'blocked', 'Historical terminal CI continuation has no verifiable result');
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
    return this.scheduler.ciConfigured;
  }

  get ciWebhook() { return this.options.ciWebhook; }

  get pullRequests() { return this.options.pullRequests; }

  listCiProviders(): PublicCiProvider[] {
    return this.scheduler.listCiProviders();
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
    return this.scheduler.runSchedule(sessionId, id, rawInput, actorId);
  }

  subscribeCi(sessionId: string, rawInput: SubscribeCiInput, actorId?: string): Promise<PublicCiSubscription> {
    return this.scheduler.subscribeCi(sessionId, rawInput, actorId);
  }

  cancelCi(sessionId: string, id: string, rawInput: { expectedRevision: number }, actorId?: string): Promise<PublicCiSubscription> {
    return this.scheduler.cancelCi(sessionId, id, rawInput, actorId);
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
    return this.scheduler.authorizeTask(task, phase);
  }
}
