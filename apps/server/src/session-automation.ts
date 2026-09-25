import { createHash, randomUUID } from 'node:crypto';
import {
  RuntimeError,
  canonicalExecutionJson,
  previewNextSchedule,
  type AttemptResultV1,
  type ExecutionActor,
  type PolicyDecision,
  type RepositoryBundle,
  type ScheduleDefinition,
  type Session,
  type TaskRecord,
  type TaskRequestV1,
  type TaskAdmissionV1
} from '@dutydeck/shared';
import {
  cancelCiInputSchema,
  ciSubscriptionSchema,
  createSessionScheduleInputSchema,
  sessionScheduleOccurrenceSchema,
  sessionScheduleOccurrenceV2Schema,
  sessionScheduleSchema,
  subscribeCiInputSchema,
  updateSessionScheduleInputSchema,
  ciSubscriptionV2Schema,
  type AutomationBlockReason,
  type CiSubscription,
  type CiSubscriptionV2,
  type CreateSessionScheduleInput,
  type PublicCiSubscription,
  type PublicSessionSchedule,
  type PublicSessionScheduleOccurrence,
  type SessionAutomationList,
  type SessionSchedule,
  type SessionScheduleOccurrence,
  type SessionScheduleOccurrenceV2,
  type SubscribeCiInput,
  type UpdateSessionScheduleInput
} from '@dutydeck/shared';
import { executionTaskId } from '@dutydeck/storage';
import { GithubActionsClient, resolveGithubHead, type GithubWorkflowRun } from './github-actions.js';
import { readAttemptResult } from './task-results.js';
import { z } from 'zod';

const SCHEDULE_PREFIX = 'session_automation/schedule/';
const OCCURRENCE_PREFIX = 'session_automation/occurrence/';
const CI_PREFIX = 'session_automation/ci/';
const TASK_BINDING_PREFIX = 'session_automation/task/';
const MAX_RECORDS = 1_000;
const CLAIM_TTL_MS = 30_000;
const DEFAULT_POLL_MS = 60_000;
const terminalTaskStatuses = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
const failureConclusions = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
/** 未决/阻塞来源持续挡下一次触发；其余 runStatus 为终态。 */
const openRunStatuses = new Set(['pending', 'accepted', 'blocked']);
/** CI 定义本身没有代际字段；binding 中的 generation 仅用于严格记录结构，取固定值。 */
const CI_BINDING_GENERATION = 1;

type ExecutionLedger = Pick<RepositoryBundle['execution'], 'getAcceptedTask' | 'getTaskExecution' | 'getAttemptEvents' | 'lookupAccepted'>;
type AutomationRepositories = Pick<RepositoryBundle, 'config' | 'sessions' | 'tasks'> & { execution: ExecutionLedger };
type AuthorizationResult = boolean | PolicyDecision;

export interface SessionAutomationRuntime {
  getSession(id: string): Promise<Session | undefined>;
  dispatch(
    sessionId: string,
    prompt: string,
    mode: 'queue',
    agentPrompt: string,
    riskPolicy: undefined,
    actorId: string | undefined,
    idempotencyKey: string,
    skillRequests?: string[],
    supplied?: TaskRequestV1
  ): Promise<{ id: string; status: string }>;
}

export interface SessionAutomationServiceOptions {
  repositories: AutomationRepositories;
  runtime: SessionAutomationRuntime;
  authorize?: (sessionId: string, actorId?: string) => AuthorizationResult | Promise<AuthorizationResult>;
  prepareDelivery?: (sessionId: string, automationId: string) => Promise<void>;
  deliver?: (sessionId: string, result: AttemptResultV1, occurrenceId: string, sourceId: string) => Promise<void>;
  githubToken?: string;
  githubFetch?: typeof fetch;
  clock?: () => Date;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function scheduleKey(id: string) { return `${SCHEDULE_PREFIX}${id}`; }
function occurrenceKey(id: string) { return `${OCCURRENCE_PREFIX}${id}`; }
function ciKey(id: string) { return `${CI_PREFIX}${id}`; }
function taskBindingKey(taskId: string) { return `${TASK_BINDING_PREFIX}${taskId}`; }
function iso(date: Date) { return date.toISOString(); }
function plus(date: Date, milliseconds: number) { return new Date(date.getTime() + milliseconds).toISOString(); }
function occurrenceId(schedule: SessionSchedule, scheduledForUtc: string) {
  return `occ_${createHash('sha256').update(`${schedule.id}\0${schedule.generation}\0${scheduledForUtc}`).digest('hex')}`;
}
export const scheduleRequestKey = (occurrenceIdValue: string) => `session-automation:schedule:${occurrenceIdValue}`;
export const ciRequestKey = (subscriptionId: string) => `session-automation:ci:${subscriptionId}`;
function canonicalTaskId(namespace: TaskRequestV1['namespace'], sessionId: string, key: string) {
  return executionTaskId(namespace, sessionId, key);
}
function isSessionRunnable(session: Session | undefined) {
  return Boolean(session && !session.archivedAt && !['stopped', 'failed'].includes(session.state));
}
function isAllowed(result: AuthorizationResult) { return result === true || typeof result === 'object' && result.allowed; }

/** 安装者只能映射到 installation_owner；平台用户必须带原 appId 域，域缺失即无法核对（undefined）。 */
function resolveAutomationActor(session: Session | undefined, actorId?: string): ExecutionActor | undefined {
  if (!actorId) return { kind: 'unspecified' };
  if (actorId === 'installation_owner') return { kind: 'installation_owner', id: 'installation_owner' };
  if (session?.source === 'lark') {
    const appId = session.sourceId?.split(':')[0];
    if (appId) return { kind: 'channel', id: actorId, appId };
  }
  return undefined;
}

function publicSchedule(value: SessionSchedule): PublicSessionSchedule {
  const { actorId: _actorId, taskStartOccurrenceId: _taskStartOccurrenceId, ...record } = value;
  return record;
}
function publicOccurrence(value: SessionScheduleOccurrence): PublicSessionScheduleOccurrence {
  const migrated = migrateOccurrence(value);
  const {
    taskStartedAt: _taskStartedAt,
    leaseOwner: _leaseOwner,
    leaseExpiresAt: _leaseExpiresAt,
    admission: _admission,
    actor: _actor,
    actorId: _actorId,
    ...record
  } = migrated;
  return record;
}
function publicSubscription(value: CiSubscription): PublicCiSubscription {
  const migrated = migrateCi(value);
  const {
    actorId: _actorId,
    actor: _actor,
    dispatchPrompt: _dispatchPrompt,
    taskStartedAt: _taskStartedAt,
    leaseOwner: _leaseOwner,
    leaseExpiresAt: _leaseExpiresAt,
    admission: _admission,
    ...record
  } = migrated;
  return record;
}

/** 严格 V1 reader：V1 记录只在原 CAS 写入时迁移为 V2，读取不破坏原始字段。 */
function migrateOccurrence(value: SessionScheduleOccurrence): SessionScheduleOccurrenceV2 {
  if (value.schemaVersion === 2) return value;
  const { schemaVersion: _schemaVersion, ...rest } = value;
  return sessionScheduleOccurrenceV2Schema.parse({ ...rest, schemaVersion: 2 });
}
function migrateCi(value: CiSubscription): CiSubscriptionV2 {
  if (value.schemaVersion === 2) return value;
  const { schemaVersion: _schemaVersion, ...rest } = value;
  return ciSubscriptionV2Schema.parse({ ...rest, schemaVersion: 2 });
}

const taskBindingV1ScheduleSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('schedule'), sessionId: z.string().min(1), occurrenceId: z.string().min(1) }).strict();
const taskBindingV1CiSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('ci'), sessionId: z.string().min(1), subscriptionId: z.string().min(1) }).strict();

const taskBindingV2ScheduleSchema = z.object({
  schemaVersion: z.literal(2), kind: z.literal('schedule'), sessionId: z.string().min(1), occurrenceId: z.string().min(1),
  scheduleId: z.string().min(1), taskId: z.string().min(1), taskIdVersion: z.enum(['v1', 'legacy']), generation: z.number().int().positive()
}).strict();
const taskBindingV2CiSchema = z.object({
  schemaVersion: z.literal(2), kind: z.literal('ci'), sessionId: z.string().min(1), subscriptionId: z.string().min(1),
  taskId: z.string().min(1), taskIdVersion: z.enum(['v1', 'legacy']), generation: z.number().int().positive()
}).strict();

const taskBindingSchema = z.union([taskBindingV1ScheduleSchema, taskBindingV1CiSchema, taskBindingV2ScheduleSchema, taskBindingV2CiSchema]);
type TaskBinding = z.infer<typeof taskBindingSchema>;

function asPreviewDefinition(schedule: Pick<SessionSchedule, 'id' | 'name' | 'trigger' | 'timezone' | 'dstPolicy'>): ScheduleDefinition {
  return {
    schemaVersion: 1,
    id: schedule.id,
    revision: 1,
    channelBotId: 'session_automation',
    name: schedule.name,
    trigger: schedule.trigger,
    timezone: schedule.timezone,
    dstPolicy: schedule.dstPolicy,
    delivery: { mode: 'chat', chatRef: 'session', continuation: 'chat_root' },
    payloadRef: 'session_prompt',
    sourceOwnership: 'dutydeck',
    sourceNamespace: 'session_automation',
    sourceEnabled: false,
    state: 'disabled',
    desiredExecutorState: 'disabled',
    currentGeneration: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

function nextDue(schedule: Pick<SessionSchedule, 'id' | 'name' | 'trigger' | 'timezone' | 'dstPolicy'>, after: Date) {
  return previewNextSchedule(asPreviewDefinition(schedule), after)?.scheduledForUtc;
}

function formatCiPrompt(basePrompt: string, repository: string, headSha: string, runs: GithubWorkflowRun[]): string {
  const lines = runs.map(run => `- ${run.name.slice(0, 80)}: ${(run.conclusion ?? 'completed').slice(0, 40)} (run ${run.id}, ${run.htmlUrl.slice(0, 400)})`);
  return `${basePrompt}\n\nGitHub Actions completed for ${repository} at ${headSha}:\n${lines.join('\n')}`;
}

interface ReconcileOutcome {
  status: 'pending' | 'cancelled' | 'settled' | 'blocked';
  result?: AttemptResultV1;
  reason?: AutomationBlockReason;
  message?: string;
}

export class SessionAutomationService {
  private readonly ownerId = `automation_${randomUUID()}`;
  private readonly clock: () => Date;
  private readonly github: GithubActionsClient;
  private readonly pollIntervalMs: number;
  private closed = false;
  private currentTick?: Promise<void>;

  constructor(private readonly options: SessionAutomationServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.pollIntervalMs = Math.max(60_000, Math.min(60 * 60_000, options.pollIntervalMs ?? DEFAULT_POLL_MS));
    this.github = new GithubActionsClient({ token: options.githubToken, fetch: options.githubFetch, requestTimeoutMs: options.requestTimeoutMs });
  }

  private requireStore() {
    if (!this.options.repositories.config.compareAndSet || !this.options.repositories.config.list) {
      throw new RuntimeError('SESSION_AUTOMATION_STORAGE_UNAVAILABLE', 'Session automation requires durable list and compare-and-set storage', 503);
    }
    return this.options.repositories.config as Required<Pick<typeof this.options.repositories.config, 'compareAndSet' | 'list'>> & typeof this.options.repositories.config;
  }

  private get execution() { return this.options.repositories.execution; }

  private async requireAuthorized(sessionId: string, actorId?: string) {
    if (!this.options.authorize) throw new RuntimeError('SESSION_AUTOMATION_AUTH_UNWIRED', 'Session automation authorization is not configured', 403);
    if (!isAllowed(await this.options.authorize(sessionId, actorId))) throw new RuntimeError('SESSION_AUTOMATION_FORBIDDEN', 'Session automation access was denied', 403);
  }

  private async requireSession(sessionId: string) {
    const session = await this.options.runtime.getSession(sessionId);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', 'Session not found', 404);
    return session;
  }

  private async listRecords<T>(prefix: string, parse: (input: unknown) => T): Promise<Array<{ raw: string; value: T }>> {
    const rows = await this.requireStore().list(prefix);
    const parsed: Array<{ raw: string; value: T }> = [];
    for (const row of rows) {
      try { parsed.push({ raw: row.value, value: parse(JSON.parse(row.value)) }); }
      catch { throw new RuntimeError('SESSION_AUTOMATION_RECORD_INVALID', 'Stored session automation record is invalid', 500); }
    }
    return parsed;
  }

  private async getRecord<T>(key: string, parse: (input: unknown) => T): Promise<{ raw: string; value: T } | undefined> {
    const raw = await this.options.repositories.config.get(key);
    if (!raw) return undefined;
    try { return { raw, value: parse(JSON.parse(raw)) }; }
    catch { throw new RuntimeError('SESSION_AUTOMATION_RECORD_INVALID', 'Stored session automation record is invalid', 500); }
  }

  private async replace(key: string, raw: string, value: unknown) {
    return this.requireStore().compareAndSet(key, raw, JSON.stringify(value));
  }

  private async createRecord(key: string, value: unknown) {
    return this.requireStore().compareAndSet(key, undefined, JSON.stringify(value));
  }

  /** 幂等补齐同一授权 binding：来源 CAS 之后、dispatch 之前；崩溃重开补同一映射。 */
  private async ensureTaskBinding(taskId: string, binding: TaskBinding) {
    if (await this.createRecord(taskBindingKey(taskId), binding)) return;
    const existing = await this.getRecord(taskBindingKey(taskId), value => taskBindingSchema.parse(value));
    if (!existing) throw new RuntimeError('SESSION_AUTOMATION_TASK_BINDING_CONFLICT', 'Automation task binding disappeared', 409);

    if (existing.value.schemaVersion === 2 && binding.schemaVersion === 2) {
      if (existing.value.kind === 'schedule' && binding.kind === 'schedule'
        && existing.value.sessionId === binding.sessionId
        && existing.value.occurrenceId === binding.occurrenceId
        && existing.value.scheduleId === binding.scheduleId
        && existing.value.taskId === binding.taskId
        && existing.value.taskIdVersion === binding.taskIdVersion
        && existing.value.generation === binding.generation) {
        return;
      }
      if (existing.value.kind === 'ci' && binding.kind === 'ci'
        && existing.value.sessionId === binding.sessionId
        && existing.value.subscriptionId === binding.subscriptionId
        && existing.value.taskId === binding.taskId
        && existing.value.taskIdVersion === binding.taskIdVersion
        && existing.value.generation === binding.generation) {
        return;
      }
      throw new RuntimeError('SESSION_AUTOMATION_TASK_BINDING_CONFLICT', 'Automation task binding changed', 409);
    }

    if (existing.value.schemaVersion === 1 && binding.schemaVersion === 2) {
      const accepted = this.execution.getAcceptedTask(taskId);
      if (!accepted || accepted.task.sessionId !== binding.sessionId) {
        throw new RuntimeError('SESSION_AUTOMATION_TASK_BINDING_CONFLICT', 'Existing legacy task cannot be verified for binding upgrade', 409);
      }
      if (existing.value.kind === 'schedule' && binding.kind === 'schedule'
        && existing.value.sessionId === binding.sessionId
        && existing.value.occurrenceId === binding.occurrenceId) {
        if (await this.replace(taskBindingKey(taskId), existing.raw, binding)) return;
        const recheck = await this.getRecord(taskBindingKey(taskId), value => taskBindingSchema.parse(value));
        if (recheck?.value.schemaVersion === 2 && recheck.value.kind === 'schedule'
          && recheck.value.sessionId === binding.sessionId
          && recheck.value.occurrenceId === binding.occurrenceId
          && recheck.value.scheduleId === binding.scheduleId
          && recheck.value.taskId === binding.taskId
          && recheck.value.taskIdVersion === binding.taskIdVersion
          && recheck.value.generation === binding.generation) {
          return;
        }
      } else if (existing.value.kind === 'ci' && binding.kind === 'ci'
        && existing.value.sessionId === binding.sessionId
        && existing.value.subscriptionId === binding.subscriptionId) {
        if (await this.replace(taskBindingKey(taskId), existing.raw, binding)) return;
        const recheck = await this.getRecord(taskBindingKey(taskId), value => taskBindingSchema.parse(value));
        if (recheck?.value.schemaVersion === 2 && recheck.value.kind === 'ci'
          && recheck.value.sessionId === binding.sessionId
          && recheck.value.subscriptionId === binding.subscriptionId
          && recheck.value.taskId === binding.taskId
          && recheck.value.taskIdVersion === binding.taskIdVersion
          && recheck.value.generation === binding.generation) {
          return;
        }
      }
    }
    throw new RuntimeError('SESSION_AUTOMATION_TASK_BINDING_CONFLICT', 'Automation task binding changed', 409);
  }

  /** 固定 number=1 Attempt 后读取唯一权威结果；不跟随 currentAttempt，不把 unknown 当 failed。 */
  private reconcileAdmission(sessionId: string, value: { admission?: SessionScheduleOccurrenceV2['admission']; runtimeAttemptId?: string }): ReconcileOutcome {
    const admission = value.admission;
    if (!admission) return { status: 'blocked', reason: 'admission_conflict', message: 'Source has no fixed task admission' };
    let projection;
    try { projection = this.execution.getTaskExecution(admission.taskId); }
    catch (error) {
      if (error instanceof RuntimeError && error.code === 'EXECUTION_AUTHORITY_LEGACY') {
        return { status: 'blocked', reason: 'reconcile_required', message: 'Execution ledger is unavailable' };
      }
      throw error;
    }
    if (!projection) return { status: 'blocked', reason: 'admission_conflict', message: 'Accepted task is missing from the execution ledger' };
    if (projection.task.sessionId !== sessionId) return { status: 'blocked', reason: 'admission_conflict', message: 'Task belongs to another session' };
    const accepted = this.execution.getAcceptedTask(admission.taskId);
    if (!accepted) return { status: 'blocked', reason: 'admission_conflict', message: 'Accepted task is missing' };
    if (accepted.task.sessionId !== sessionId) return { status: 'blocked', reason: 'admission_conflict', message: 'Accepted task belongs to another session' };
    if (admission.kind === 'canonical') {
      if (!accepted.request || canonicalExecutionJson(accepted.request) !== canonicalExecutionJson(admission.request)) {
        return { status: 'blocked', reason: 'admission_conflict', message: 'Accepted task request conflicts with source admission' };
      }
    } else if (admission.kind === 'legacy_partial') {
      if (accepted.request && admission.request && canonicalExecutionJson(accepted.request) !== canonicalExecutionJson(admission.request)) {
        return { status: 'blocked', reason: 'admission_conflict', message: 'Accepted task request conflicts with source admission' };
      }
    }
    // queued/running 缺冻结 V2 选项输入不能透明提交。
    if (projection.task.status === 'queued' || projection.task.status === 'running') {
      if (accepted?.input?.version !== 2) return { status: 'blocked', reason: 'legacy_input_unresolved', message: 'Accepted task input options cannot be verified (INPUT_OPTIONS_UNVERIFIABLE)' };
    }
    const first = projection.attempts.find(item => item.number === 1);
    if (!first) {
      if (projection.task.status === 'cancelled') return { status: 'cancelled' };
      if (projection.task.status === 'queued') return { status: 'pending' };
      return { status: 'blocked', reason: 'reconcile_required', message: `Task ${projection.task.status} has no recorded attempt` };
    }
    if (value.runtimeAttemptId && value.runtimeAttemptId !== first.attemptId) {
      return { status: 'blocked', reason: 'reconcile_required', message: 'Fixed number=1 attempt identity changed' };
    }
    let read;
    try { read = readAttemptResult({ execution: this.execution }, sessionId, admission.taskId, first.attemptId); }
    catch (error) {
      return { status: 'blocked', reason: 'reconcile_required', message: errorMessage(error) };
    }
    if (read.status === 'pending') return { status: 'pending' };
    if (read.status === 'blocked') {
      return {
        status: 'blocked',
        reason: read.reason === 'admission_conflict' ? 'admission_conflict'
          : read.reason === 'reconcile_required' ? 'reconcile_required'
          : 'legacy_output_unresolved',
        message: read.reason
      };
    }
    return { status: 'settled', result: read.result };
  }

  async listBySession(sessionId: string, actorId?: string): Promise<SessionAutomationList> {
    await this.requireAuthorized(sessionId, actorId);
    await this.requireSession(sessionId);
    const [schedules, subscriptions, occurrences] = await Promise.all([
      this.listRecords(SCHEDULE_PREFIX, value => sessionScheduleSchema.parse(value)),
      this.listRecords(CI_PREFIX, value => ciSubscriptionSchema.parse(value)),
      this.listRecords(OCCURRENCE_PREFIX, value => sessionScheduleOccurrenceSchema.parse(value))
    ]);
    return {
      schedules: schedules.map(item => item.value).filter(item => item.sessionId === sessionId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-MAX_RECORDS).map(publicSchedule),
      subscriptions: subscriptions.map(item => item.value).filter(item => item.sessionId === sessionId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-MAX_RECORDS).map(publicSubscription),
      occurrences: occurrences.map(item => item.value).filter(item => item.sessionId === sessionId).sort((a, b) => a.scheduledForUtc.localeCompare(b.scheduledForUtc)).slice(-MAX_RECORDS).map(publicOccurrence)
    };
  }

  private async githubCondition(session: Session, input: { kind: 'github_new_failure'; workflow?: string }) {
    const resolved = await resolveGithubHead(session.cwd);
    const runs = await this.github.listCompletedRuns(resolved.repository, resolved.headSha, input.workflow);
    return {
      kind: 'github_new_failure' as const,
      ...(input.workflow ? { workflow: input.workflow } : {}),
      repository: resolved.repository,
      headSha: resolved.headSha,
      observedRunIds: runs.map(run => run.id)
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

  async createSchedule(sessionId: string, rawInput: CreateSessionScheduleInput, actorId?: string, receipt?: { key: string; prepareDelivery?: (id: string) => Promise<void> }): Promise<PublicSessionSchedule> {
    await this.requireAuthorized(sessionId, actorId);
    const session = await this.requireSession(sessionId);
    if (!isSessionRunnable(session)) throw new RuntimeError('SESSION_NOT_ACTIVE', 'Session is not active', 409);
    const input = createSessionScheduleInputSchema.parse(rawInput);
    const id = receipt ? `schedule_${createHash('sha256').update(JSON.stringify([sessionId, actorId, receipt.key])).digest('hex')}` : `schedule_${randomUUID()}`;
    const existing = receipt ? await this.getRecord(scheduleKey(id), value => sessionScheduleSchema.parse(value)) : undefined;
    if (existing) return publicSchedule(existing.value);
    const now = iso(this.clock());
    const condition = input.condition.kind === 'always' ? input.condition : await this.githubCondition(session, input.condition);
    await receipt?.prepareDelivery?.(id);
    await this.options.prepareDelivery?.(sessionId, id);
    const schedule = sessionScheduleSchema.parse({
      schemaVersion: 1,
      id,
      revision: 1,
      generation: 1,
      sessionId,
      ...(actorId ? { actorId } : {}),
      name: input.name,
      prompt: input.prompt,
      trigger: input.trigger,
      timezone: input.timezone,
      dstPolicy: input.dstPolicy,
      condition,
      enabled: false,
      createdAt: now,
      updatedAt: now
    });
    nextDue(schedule, this.clock());
    if (!await this.createRecord(scheduleKey(schedule.id), schedule)) {
      if (receipt) {
        const saved = await this.getRecord(scheduleKey(id), value => sessionScheduleSchema.parse(value));
        if (saved) return publicSchedule(saved.value);
      }
      throw new RuntimeError('SESSION_AUTOMATION_CONFLICT', 'Schedule identifier already exists', 409);
    }
    return publicSchedule(schedule);
  }

  async updateSchedule(sessionId: string, id: string, rawInput: UpdateSessionScheduleInput, actorId?: string): Promise<PublicSessionSchedule> {
    await this.requireAuthorized(sessionId, actorId);
    const session = await this.requireSession(sessionId);
    const input = updateSessionScheduleInputSchema.parse(rawInput);
    const stored = await this.getRecord(scheduleKey(id), value => sessionScheduleSchema.parse(value));
    if (!stored || stored.value.sessionId !== sessionId) throw new RuntimeError('SESSION_AUTOMATION_SCHEDULE_NOT_FOUND', 'Session schedule not found', 404);
    if (stored.value.revision !== input.expectedRevision) throw new RuntimeError('SESSION_AUTOMATION_REVISION_CONFLICT', 'Session schedule revision changed', 409);
    if (input.enabled === true && !isSessionRunnable(session)) throw new RuntimeError('SESSION_NOT_ACTIVE', 'Session is not active', 409);
    let condition = stored.value.condition;
    if (input.condition) condition = input.condition.kind === 'always' ? input.condition : await this.githubCondition(session, input.condition);
    const now = this.clock();
    const candidate = {
      ...stored.value,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.dstPolicy !== undefined ? { dstPolicy: input.dstPolicy } : {}),
      condition,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      revision: stored.value.revision + 1,
      generation: stored.value.generation + 1,
      ...(actorId ? { actorId } : {}),
      updatedAt: iso(now)
    };
    const schedule = sessionScheduleSchema.parse({
      ...candidate,
      nextDueAt: candidate.enabled ? nextDue(candidate, now) : undefined
    });
    if (!await this.replace(scheduleKey(id), stored.raw, schedule)) throw new RuntimeError('SESSION_AUTOMATION_REVISION_CONFLICT', 'Session schedule revision changed', 409);
    return publicSchedule(schedule);
  }

  async subscribeCi(sessionId: string, rawInput: SubscribeCiInput, actorId?: string): Promise<PublicCiSubscription> {
    await this.requireAuthorized(sessionId, actorId);
    const session = await this.requireSession(sessionId);
    if (!isSessionRunnable(session)) throw new RuntimeError('SESSION_NOT_ACTIVE', 'Session is not active', 409);
    const input = subscribeCiInputSchema.parse(rawInput);
    const resolved = await resolveGithubHead(session.cwd);
    const now = this.clock();
    const id = `ci_${randomUUID()}`;
    await this.options.prepareDelivery?.(sessionId, id);
    const record = ciSubscriptionSchema.parse({
      schemaVersion: 1,
      id,
      revision: 1,
      sessionId,
      ...(actorId ? { actorId } : {}),
      repository: resolved.repository,
      headSha: resolved.headSha,
      ...(input.workflow ? { workflow: input.workflow } : {}),
      prompt: input.prompt ?? 'Review the completed GitHub Actions result and continue the task.',
      status: 'waiting',
      expiresAt: plus(now, input.ttlSeconds * 1_000),
      nextPollAt: iso(now),
      delivery: { status: this.options.deliver ? 'pending' : 'not_requested', attempts: 0, updatedAt: iso(now) },
      createdAt: iso(now),
      updatedAt: iso(now)
    });
    if (!await this.createRecord(ciKey(record.id), record)) throw new RuntimeError('SESSION_AUTOMATION_CONFLICT', 'CI subscription identifier already exists', 409);
    return publicSubscription(record);
  }

  async cancelCi(sessionId: string, id: string, rawInput: { expectedRevision: number }, actorId?: string): Promise<PublicCiSubscription> {
    await this.requireAuthorized(sessionId, actorId);
    await this.requireSession(sessionId);
    const input = cancelCiInputSchema.parse(rawInput);
    const stored = await this.getRecord(ciKey(id), value => ciSubscriptionSchema.parse(value));
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
    if (!await this.replace(ciKey(id), stored.raw, cancelled)) throw new RuntimeError('SESSION_AUTOMATION_REVISION_CONFLICT', 'CI subscription revision changed', 409);
    return publicSubscription(cancelled);
  }

  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.currentTick) return this.currentTick;
    const operation = this.runTick().finally(() => { if (this.currentTick === operation) this.currentTick = undefined; });
    this.currentTick = operation;
    return operation;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.currentTick) await this.currentTick;
  }

  async authorizeTask(task: TaskRecord, phase: 'prepare' | 'submit' = 'prepare'): Promise<void> {
    const bindingStored = await this.getRecord(taskBindingKey(task.id), value => taskBindingSchema.parse(value));
    if (!bindingStored) return;
    const binding = bindingStored.value;
    if (binding.sessionId !== task.sessionId) throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Automation task binding does not match its session', 403);
    const accepted = this.execution.getAcceptedTask(task.id);
    if (accepted && (accepted.task.sessionId !== task.sessionId || accepted.task.id !== task.id)) {
      throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Accepted task identity does not match current task', 403);
    }
    if (binding.kind === 'schedule') {
      const occurrenceStored = await this.getRecord(occurrenceKey(binding.occurrenceId), value => sessionScheduleOccurrenceSchema.parse(value));
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
      if (accepted) {
        if (occurrence.admission.kind === 'canonical') {
          if (!accepted.request || canonicalExecutionJson(accepted.request) !== canonicalExecutionJson(occurrence.admission.request)) {
            throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task admission conflicts with accepted request', 403);
          }
        } else if (accepted.request && occurrence.admission.request) {
          if (canonicalExecutionJson(accepted.request) !== canonicalExecutionJson(occurrence.admission.request)) {
            throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task admission conflicts with accepted request', 403);
          }
        }
      }
      const schedule = await this.getRecord(scheduleKey(occurrence.scheduleId), value => sessionScheduleSchema.parse(value));
      if (!schedule) throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task definition is missing', 403);
      const started = Boolean(occurrence.taskStartedAt || schedule.value.taskStartOccurrenceId === occurrence.id);
      if (!started && (schedule.value.generation !== occurrence.generation || !schedule.value.enabled || occurrence.conditionStatus !== 'passed' || !['pending', 'accepted'].includes(occurrence.runStatus))) {
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
      // 核验真实接受 actor 与来源 actor 一致：authorizer 必须使用核实后的原 actor，禁止借用其他 actor
      const actualActor = accepted?.request?.actor ?? occurrence.admission.request?.actor;
      if (!actualActor) {
        throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task actor cannot be resolved', 403);
      }
      if (occurrence.actor && canonicalExecutionJson(occurrence.actor) !== canonicalExecutionJson(actualActor)) {
        throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task source actor does not match accepted actor', 403);
      }
      if (actualActor.kind === 'channel') {
        const sessionAppId = session?.source === 'lark' ? session.sourceId?.split(':')[0] : undefined;
        if (!sessionAppId || actualActor.appId !== sessionAppId) {
          throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Actor app does not match session', 403);
        }
      }
      const actorId = actualActor.kind === 'installation_owner' ? 'installation_owner'
        : actualActor.kind === 'channel' ? actualActor.id : undefined;
      try { await this.requireAuthorized(task.sessionId, actorId); }
      catch (error) {
        if (!started) {
          await this.disableSchedule(schedule);
          await this.finishOccurrence(occurrenceStored, { conditionStatus: 'error', runStatus: 'error', error: errorMessage(error) });
        }
        throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task authorization was revoked', 403);
      }
      // 首次尚未提交时继续真正 HEAD 核验，删掉以 !accepted 为条件的 HEAD 绕过。
      if (!started && schedule.value.condition.kind === 'github_new_failure') {
        let resolved: Awaited<ReturnType<typeof resolveGithubHead>>;
        try { resolved = await resolveGithubHead(session!.cwd); }
        catch (error) {
          await this.finishOccurrence(occurrenceStored, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: errorMessage(error) });
          throw new RuntimeError('SESSION_AUTOMATION_TASK_STALE_HEAD', 'Scheduled task GitHub HEAD is unavailable before execution', 409);
        }
        if (resolved.repository.slug.toLowerCase() !== schedule.value.condition.repository.slug.toLowerCase() || resolved.headSha !== schedule.value.condition.headSha) {
          await this.finishOccurrence(occurrenceStored, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Scheduled task GitHub HEAD changed before execution' });
          throw new RuntimeError('SESSION_AUTOMATION_TASK_STALE_HEAD', 'Scheduled task GitHub HEAD changed before execution', 409);
        }
      }
      if (phase === 'submit' && !started) {
        const startedSchedule = sessionScheduleSchema.parse({
          ...schedule.value,
          taskStartOccurrenceId: occurrence.id,
          ...(!schedule.value.nextDueAt ? { enabled: false } : {})
        });
        if (!await this.replace(scheduleKey(schedule.value.id), schedule.raw, startedSchedule)) {
          const latestSchedule = await this.getRecord(scheduleKey(schedule.value.id), value => sessionScheduleSchema.parse(value));
          if (latestSchedule?.value.taskStartOccurrenceId !== occurrence.id) {
            const latest = await this.getRecord(occurrenceKey(occurrence.id), value => sessionScheduleOccurrenceSchema.parse(value));
            if (latest) await this.finishOccurrence(latest, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Schedule changed before submission' });
            throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task changed before submission', 409);
          }
        }
        const currentOccurrence = await this.getRecord(occurrenceKey(occurrence.id), value => sessionScheduleOccurrenceSchema.parse(value));
        if (!currentOccurrence || !['passed'].includes(currentOccurrence.value.conditionStatus) || !['pending', 'accepted'].includes(currentOccurrence.value.runStatus)) {
          throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled occurrence changed before submission', 409);
        }
        const marked = sessionScheduleOccurrenceSchema.parse({ ...migrateOccurrence(currentOccurrence.value), revision: currentOccurrence.value.revision + 1, taskStartedAt: iso(this.clock()), updatedAt: iso(this.clock()) });
        if (!await this.replace(occurrenceKey(occurrence.id), currentOccurrence.raw, marked)) {
          const latestOccurrence = await this.getRecord(occurrenceKey(occurrence.id), value => sessionScheduleOccurrenceSchema.parse(value));
          const latestVal = latestOccurrence ? migrateOccurrence(latestOccurrence.value) : undefined;
          if (!latestVal || !latestVal.taskStartedAt || latestVal.scheduleId !== schedule.value.id || latestVal.generation !== occurrence.generation || !['passed'].includes(latestVal.conditionStatus) || !['pending', 'accepted'].includes(latestVal.runStatus)) {
            throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled occurrence changed before submission', 409);
          }
        }
      }
      return;
    }
    const subscriptionStored = await this.getRecord(ciKey(binding.subscriptionId), value => ciSubscriptionSchema.parse(value));
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
    if (accepted) {
      if (subscription.admission.kind === 'canonical') {
        if (!accepted.request || canonicalExecutionJson(accepted.request) !== canonicalExecutionJson(subscription.admission.request)) {
          throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation admission conflicts with accepted request', 403);
        }
      } else if (accepted.request && subscription.admission.request) {
        if (canonicalExecutionJson(accepted.request) !== canonicalExecutionJson(subscription.admission.request)) {
          throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation admission conflicts with accepted request', 403);
        }
      }
    }
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
    const actualCiActor = accepted?.request?.actor ?? subscription.admission.request?.actor;
    if (!actualCiActor) {
      throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation actor cannot be resolved', 403);
    }
    if (subscription.actor && canonicalExecutionJson(subscription.actor) !== canonicalExecutionJson(actualCiActor)) {
      throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation source actor does not match accepted actor', 403);
    }
    if (actualCiActor.kind === 'channel') {
      const sessionAppId = session?.source === 'lark' ? session.sourceId?.split(':')[0] : undefined;
      if (!sessionAppId || actualCiActor.appId !== sessionAppId) {
        throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Actor app does not match session', 403);
      }
    }
    const ciActorId = actualCiActor.kind === 'installation_owner' ? 'installation_owner'
      : actualCiActor.kind === 'channel' ? actualCiActor.id : undefined;
    try { await this.requireAuthorized(task.sessionId, ciActorId); }
    catch (error) {
      if (!started) await this.finishCi(subscriptionStored, 'revoked', errorMessage(error));
      throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation authorization was revoked', 403);
    }
    // 首次尚未提交时继续真正 HEAD 核验，删掉以 !accepted 为条件的 HEAD 绕过。
    if (!started) {
      let resolved: Awaited<ReturnType<typeof resolveGithubHead>>;
      try { resolved = await resolveGithubHead(session!.cwd); }
      catch (error) {
        await this.finishCi(subscriptionStored, 'stale_head', errorMessage(error));
        throw new RuntimeError('SESSION_AUTOMATION_TASK_STALE_HEAD', 'CI continuation GitHub HEAD is unavailable before execution', 409);
      }
      if (resolved.repository.slug.toLowerCase() !== subscription.repository.slug.toLowerCase() || resolved.headSha !== subscription.headSha) {
        await this.finishCi(subscriptionStored, 'stale_head', 'CI continuation GitHub HEAD changed before execution');
        throw new RuntimeError('SESSION_AUTOMATION_TASK_STALE_HEAD', 'CI continuation GitHub HEAD changed before execution', 409);
      }
    }
    if (phase === 'submit' && !started) {
      const current = await this.getRecord(ciKey(subscription.id), value => ciSubscriptionSchema.parse(value));
      const currentValue = current ? migrateCi(current.value) : undefined;
      if (!current || !currentValue || currentValue.taskStartedAt || !['dispatching', 'accepted'].includes(currentValue.status) || new Date(currentValue.expiresAt) <= this.clock()) {
        throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation changed before submission', 409);
      }
      const marked = ciSubscriptionSchema.parse({ ...currentValue, revision: currentValue.revision + 1, taskStartedAt: iso(this.clock()), updatedAt: iso(this.clock()) });
      if (!await this.replace(ciKey(subscription.id), current.raw, marked)) {
        const latest = await this.getRecord(ciKey(subscription.id), value => ciSubscriptionSchema.parse(value));
        const latestVal = latest ? migrateCi(latest.value) : undefined;
        if (!latestVal || !latestVal.taskStartedAt || !['dispatching', 'accepted'].includes(latestVal.status) || new Date(latestVal.expiresAt) <= this.clock()) {
          throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation changed before submission', 409);
        }
      }
    }
  }

  private async runTick() {
    this.requireStore();
    await this.refreshAcceptedWork();
    if (this.closed) return;
    const [schedules, occurrences, subscriptions] = await Promise.all([
      this.listRecords(SCHEDULE_PREFIX, value => sessionScheduleSchema.parse(value)),
      this.listRecords(OCCURRENCE_PREFIX, value => sessionScheduleOccurrenceSchema.parse(value)),
      this.listRecords(CI_PREFIX, value => ciSubscriptionSchema.parse(value))
    ]);
    for (const item of occurrences) {
      if (this.closed) return;
      if (item.value.runStatus === 'pending' && (!item.value.leaseExpiresAt || new Date(item.value.leaseExpiresAt) <= this.clock())) await this.claimAndProcessOccurrence(item);
    }
    const occurrencesBySchedule = new Map<string, SessionScheduleOccurrence[]>();
    for (const item of occurrences) {
      const grouped = occurrencesBySchedule.get(item.value.scheduleId) ?? [];
      grouped.push(item.value);
      occurrencesBySchedule.set(item.value.scheduleId, grouped);
    }
    for (const item of schedules) {
      if (this.closed) return;
      await this.planSchedule(item.value, occurrencesBySchedule.get(item.value.id) ?? []);
    }
    for (const item of subscriptions) {
      if (this.closed) return;
      const value = migrateCi(item.value);
      if (value.status === 'waiting' && (!value.nextPollAt || new Date(value.nextPollAt) <= this.clock())) await this.claimAndPollCi(item);
      else if (value.status === 'dispatching' && (!value.leaseExpiresAt || new Date(value.leaseExpiresAt) <= this.clock())) await this.recoverDispatchingCi(item);
      else if (value.status === 'accepted' && new Date(value.expiresAt) <= this.clock() && value.taskId) {
        const task = await this.options.repositories.tasks.get?.(value.taskId);
        if (task?.status === 'queued' && !value.taskStartedAt) await this.finishCi(item, 'expired', 'CI continuation expired before execution');
      }
    }
  }

  private async planSchedule(schedule: SessionSchedule, existing: SessionScheduleOccurrence[]) {
    if (!schedule.enabled || !schedule.nextDueAt || new Date(schedule.nextDueAt) > this.clock()) return;
    // blocked/未决来源持续挡下一次触发，即便同一 Task 后来 Attempt 2 已成功。
    for (const occurrence of existing) {
      if (openRunStatuses.has(occurrence.runStatus)) return;
    }
    const id = occurrenceId(schedule, schedule.nextDueAt);
    const already = await this.getRecord(occurrenceKey(id), value => sessionScheduleOccurrenceSchema.parse(value));
    if (already) {
      if (!openRunStatuses.has(already.value.runStatus)) await this.advanceSchedule(schedule, schedule.nextDueAt);
      return;
    }
    const now = this.clock();
    const occurrence = sessionScheduleOccurrenceSchema.parse({
      schemaVersion: 2,
      id,
      revision: 1,
      scheduleId: schedule.id,
      sessionId: schedule.sessionId,
      generation: schedule.generation,
      scheduledForUtc: schedule.nextDueAt,
      conditionStatus: 'pending',
      runStatus: 'pending',
      delivery: { status: this.options.deliver ? 'pending' : 'not_requested', attempts: 0, updatedAt: iso(now) },
      leaseOwner: this.ownerId,
      leaseExpiresAt: plus(now, CLAIM_TTL_MS),
      createdAt: iso(now),
      updatedAt: iso(now)
    });
    if (await this.createRecord(occurrenceKey(id), occurrence)) {
      existing.push(occurrence);
      await this.processOccurrence({ raw: JSON.stringify(occurrence), value: occurrence });
    }
  }

  private async claimAndProcessOccurrence(stored: { raw: string; value: SessionScheduleOccurrence }) {
    const now = this.clock();
    const base = migrateOccurrence(stored.value);
    const claimed = sessionScheduleOccurrenceV2Schema.parse({ ...base, revision: base.revision + 1, leaseOwner: this.ownerId, leaseExpiresAt: plus(now, CLAIM_TTL_MS), updatedAt: iso(now) });
    if (await this.replace(occurrenceKey(stored.value.id), stored.raw, claimed)) await this.processOccurrence({ raw: JSON.stringify(claimed), value: claimed });
  }

  private async renewOccurrenceLease(stored: { raw: string; value: SessionScheduleOccurrence }) {
    const now = this.clock();
    const base = migrateOccurrence(stored.value);
    const renewed = sessionScheduleOccurrenceV2Schema.parse({ ...base, revision: base.revision + 1, leaseOwner: this.ownerId, leaseExpiresAt: plus(now, CLAIM_TTL_MS), updatedAt: iso(now) });
    return await this.replace(occurrenceKey(stored.value.id), stored.raw, renewed) ? { raw: JSON.stringify(renewed), value: renewed } : undefined;
  }

  private async processOccurrence(stored: { raw: string; value: SessionScheduleOccurrence }) {
    const occurrence = migrateOccurrence(stored.value);
    const scheduleStored = await this.getRecord(scheduleKey(occurrence.scheduleId), value => sessionScheduleSchema.parse(value));
    if (!scheduleStored || scheduleStored.value.generation !== occurrence.generation || !scheduleStored.value.enabled) {
      await this.finishOccurrence({ raw: stored.raw, value: occurrence }, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Schedule generation changed before dispatch' });
      return;
    }
    let schedule = scheduleStored.value;
    const sessionMaybe = await this.options.runtime.getSession(schedule.sessionId);
    if (!isSessionRunnable(sessionMaybe)) {
      await this.disableSchedule(scheduleStored);
      await this.finishOccurrence({ raw: stored.raw, value: occurrence }, { conditionStatus: 'error', runStatus: 'error', error: 'Session is no longer active' });
      return;
    }
    const session = sessionMaybe!;
    try { await this.requireAuthorized(schedule.sessionId, schedule.actorId); }
    catch (error) {
      await this.disableSchedule(scheduleStored);
      await this.finishOccurrence({ raw: stored.raw, value: occurrence }, { conditionStatus: 'error', runStatus: 'error', error: errorMessage(error) });
      return;
    }

    let working: { raw: string; value: SessionScheduleOccurrenceV2 } = { raw: stored.raw, value: occurrence };
    let conditionStatus: SessionScheduleOccurrenceV2['conditionStatus'] = occurrence.conditionStatus === 'pending' ? 'passed' : occurrence.conditionStatus;
    let conditionError = occurrence.error;
    if (occurrence.conditionStatus === 'pending' && schedule.condition.kind === 'github_new_failure') {
      let observed: number[] | undefined;
      try {
        const condition = schedule.condition;
        const resolved = await resolveGithubHead(session!.cwd);
        if (resolved.repository.slug.toLowerCase() !== condition.repository.slug.toLowerCase() || resolved.headSha !== condition.headSha) {
          throw new Error('GitHub repository or HEAD changed after the schedule generation was created');
        }
        const runs = await this.github.listCompletedRuns(condition.repository, condition.headSha, condition.workflow);
        const seen = new Set(condition.observedRunIds);
        const newRuns = runs.filter(run => !seen.has(run.id));
        conditionStatus = newRuns.some(run => run.conclusion && failureConclusions.has(run.conclusion)) ? 'passed' : 'skipped';
        observed = runs.map(run => run.id);
      } catch (error) {
        conditionStatus = 'error';
        conditionError = errorMessage(error);
      }
      const renewed = await this.renewOccurrenceLease(working);
      if (!renewed) return;
      working = renewed;
      const currentSchedule = await this.getRecord(scheduleKey(schedule.id), value => sessionScheduleSchema.parse(value));
      if (!currentSchedule || currentSchedule.raw !== scheduleStored.raw || currentSchedule.value.generation !== occurrence.generation || !currentSchedule.value.enabled) {
        await this.finishOccurrence(working, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Schedule changed while its condition was evaluated' });
        return;
      }
      const evaluated = sessionScheduleOccurrenceV2Schema.parse({
        ...working.value,
        revision: working.value.revision + 1,
        conditionStatus,
        ...(observed !== undefined ? { conditionObservedRunIds: observed } : {}),
        ...(conditionError ? { error: conditionError } : {}),
        updatedAt: iso(this.clock())
      });
      if (!await this.replace(occurrenceKey(occurrence.id), working.raw, evaluated)) return;
      working = { raw: JSON.stringify(evaluated), value: evaluated };
    }
    const persistedCondition = schedule.condition;
    if (persistedCondition.kind === 'github_new_failure' && working.value.conditionObservedRunIds?.some(id => !persistedCondition.observedRunIds.includes(id))) {
      const observedRunIds = [...new Set([...persistedCondition.observedRunIds, ...working.value.conditionObservedRunIds])].sort((a, b) => a - b).slice(-100);
      const updated = sessionScheduleSchema.parse({ ...schedule, condition: { ...persistedCondition, observedRunIds } });
      if (!await this.replace(scheduleKey(schedule.id), scheduleStored.raw, updated)) {
        await this.finishOccurrence(working, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Schedule changed while its condition was evaluated' });
        return;
      }
      schedule = updated;
    }
    try { await this.requireAuthorized(schedule.sessionId, schedule.actorId); }
    catch (error) {
      const currentSchedule = await this.getRecord(scheduleKey(schedule.id), value => sessionScheduleSchema.parse(value));
      if (currentSchedule?.value.generation === schedule.generation) await this.disableSchedule(currentSchedule);
      await this.finishOccurrence(working, { conditionStatus: 'error', runStatus: 'error', error: errorMessage(error) });
      return;
    }
    if (conditionStatus !== 'passed') {
      await this.finishOccurrence(working, { conditionStatus, runStatus: conditionStatus === 'skipped' ? 'skipped' : conditionStatus === 'invalidated' ? 'invalidated' : 'error', ...(conditionError ? { error: conditionError } : {}), admission: undefined });
      await this.advanceSchedule(schedule, occurrence.scheduledForUtc);
      return;
    }

    const accepted = sessionScheduleOccurrenceV2Schema.parse({ ...working.value, revision: working.value.revision + 1, conditionStatus: 'passed', updatedAt: iso(this.clock()) });
    if (!await this.replace(occurrenceKey(occurrence.id), working.raw, accepted)) return;
    const actor = working.value.actor ?? resolveAutomationActor(session, schedule.actorId);
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
      request = working.value.admission.request ?? this.buildRequest(session, 'schedule', scheduleRequestKey(occurrence.id), schedule.prompt, actor);
      taskId = working.value.admission.taskId;
      taskIdVersion = working.value.admission.taskIdVersion;
      occurrenceWithAdmission = { raw: JSON.stringify(accepted), value: accepted };
    } else {
      // 首次无 admission：先构造候选请求，复用真实仓储 execution.lookupAccepted(request)
      const candidateRequest = this.buildRequest(session, 'schedule', scheduleRequestKey(occurrence.id), schedule.prompt, actor);
      let existingAccepted;
      try {
        existingAccepted = this.execution.lookupAccepted(candidateRequest);
      } catch (err) {
        await this.finishOccurrence({ raw: JSON.stringify(accepted), value: accepted }, { runStatus: 'blocked', blockReason: 'admission_conflict', error: errorMessage(err) });
        await this.advanceSchedule(schedule, occurrence.scheduledForUtc);
        return;
      }
      if (existingAccepted) {
        taskId = existingAccepted.task.id;
        taskIdVersion = existingAccepted.task.digestVersion === 'v1' ? 'v1' : 'legacy';
        request = existingAccepted.request ?? candidateRequest;
        const admission: TaskAdmissionV1 = (existingAccepted.replayValidation === 'legacy_partial' || !existingAccepted.request || existingAccepted.task.digestVersion !== 'v1')
          ? {
              version: 1,
              kind: 'legacy_partial',
              taskIdVersion,
              taskId,
              ...(existingAccepted.request ? { request: existingAccepted.request } : {})
            }
          : {
              version: 1,
              kind: 'canonical',
              taskIdVersion: 'v1',
              taskId,
              request: existingAccepted.request
            };
        const withAdmission = sessionScheduleOccurrenceV2Schema.parse({
          ...accepted,
          revision: accepted.revision + 1,
          admission,
          actor,
          taskId,
          updatedAt: iso(this.clock())
        });
        if (!await this.replace(occurrenceKey(occurrence.id), JSON.stringify(accepted), withAdmission)) return;
        occurrenceWithAdmission = { raw: JSON.stringify(withAdmission), value: withAdmission };
      } else {
        // 确认未接受且未冻结 admission：CAS 保存 canonical 请求再补 binding/dispatch
        taskId = canonicalTaskId('schedule', schedule.sessionId, candidateRequest.key);
        request = candidateRequest;
        const admission = {
          version: 1 as const,
          kind: 'canonical' as const,
          taskIdVersion: 'v1' as const,
          taskId,
          request: candidateRequest
        };
        const withAdmission = sessionScheduleOccurrenceV2Schema.parse({
          ...accepted,
          revision: accepted.revision + 1,
          admission,
          actor,
          updatedAt: iso(this.clock())
        });
        if (!await this.replace(occurrenceKey(occurrence.id), JSON.stringify(accepted), withAdmission)) return;
        occurrenceWithAdmission = { raw: JSON.stringify(withAdmission), value: withAdmission };
      }
    }
    await this.dispatchOccurrence(occurrenceWithAdmission, schedule, request, taskId, taskIdVersion, actor);
    await this.advanceSchedule(schedule, occurrence.scheduledForUtc);
  }

  private async dispatchOccurrence(
    stored: { raw: string; value: SessionScheduleOccurrenceV2 },
    schedule: SessionSchedule,
    request: TaskRequestV1,
    taskId: string,
    taskIdVersion: 'v1' | 'legacy',
    actor: ExecutionActor
  ) {
    const occurrence = stored.value;
    // 重投先查接受事实，命中只补同一映射，不再读 HEAD/材料、不重拼 prompt。
    const acceptedBefore = this.execution.getAcceptedTask(taskId);
    if (acceptedBefore) {
      if (acceptedBefore.request && canonicalRequestDigest(acceptedBefore.request) !== canonicalRequestDigest(request)) {
        await this.finishOccurrence(stored, { runStatus: 'blocked', blockReason: 'admission_conflict', error: 'The task key already belongs to a different accepted request' });
        return;
      }
      await this.ensureTaskBinding(taskId, {
        schemaVersion: 2,
        kind: 'schedule',
        sessionId: occurrence.sessionId,
        occurrenceId: occurrence.id,
        scheduleId: occurrence.scheduleId,
        taskId,
        taskIdVersion,
        generation: occurrence.generation
      });
      await this.markOccurrenceAccepted(stored, taskId);
      return;
    }
    await this.ensureTaskBinding(taskId, {
      schemaVersion: 2,
      kind: 'schedule',
      sessionId: occurrence.sessionId,
      occurrenceId: occurrence.id,
      scheduleId: occurrence.scheduleId,
      taskId,
      taskIdVersion,
      generation: occurrence.generation
    });
    const actorId = actor.kind === 'unspecified' ? undefined : actor.id;
    try {
      const task = await this.options.runtime.dispatch(occurrence.sessionId, request.prompt, 'queue', request.prompt, undefined, actorId, request.key, request.skills, request);
      if (task.id !== taskId) throw new RuntimeError('SESSION_AUTOMATION_TASK_CONFLICT', 'Runtime task identity did not match the fixed admission', 409);
      await this.markOccurrenceAccepted(stored, task.id);
    } catch (error) {
      if (this.closed) return;
      const durable = this.execution.getAcceptedTask(taskId);
      if (durable) {
        if (durable.request && canonicalRequestDigest(durable.request) === canonicalRequestDigest(request)) {
          await this.markOccurrenceAccepted(stored, taskId);
          return;
        }
        await this.finishOccurrence(stored, { runStatus: 'blocked', blockReason: 'admission_conflict', error: 'Accepted task request conflicts with source admission' });
        return;
      }
      await this.finishOccurrence(stored, { runStatus: 'error', error: errorMessage(error) });
    }
  }

  private async markOccurrenceAccepted(stored: { raw: string; value: SessionScheduleOccurrence }, taskId: string) {
    const current = await this.getRecord(occurrenceKey(stored.value.id), input => sessionScheduleOccurrenceSchema.parse(input));
    if (!current) return;
    const currentValue = migrateOccurrence(current.value);
    if (currentValue.runStatus !== 'pending') return;
    if (currentValue.scheduleId !== stored.value.scheduleId || currentValue.generation !== stored.value.generation) return;
    // CAS 核原来源身份/代际：冻结 admission 的 taskId 必须与实际接受 Task 一致，不借最新 pending 绑定不同请求。
    const frozenTaskId = currentValue.admission?.taskId ?? migrateOccurrence(stored.value).admission?.taskId;
    if (frozenTaskId && frozenTaskId !== taskId) return;
    const updated = sessionScheduleOccurrenceV2Schema.parse({ ...currentValue, revision: currentValue.revision + 1, runStatus: 'accepted', taskId, leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: iso(this.clock()) });
    await this.replace(occurrenceKey(stored.value.id), current.raw, updated);
  }

  private async finishOccurrence(stored: { raw: string; value: SessionScheduleOccurrence }, patch: Partial<SessionScheduleOccurrenceV2>) {
    const base = migrateOccurrence(stored.value);
    const noTask = !base.taskId && patch.runStatus && !['pending', 'accepted'].includes(patch.runStatus);
    const blocked = patch.runStatus === 'blocked';
    const shouldResetDelivery = (noTask || blocked) && base.delivery.status !== 'delivered';
    const updated = sessionScheduleOccurrenceV2Schema.parse({
      ...base,
      ...patch,
      schemaVersion: 2,
      revision: base.revision + 1,
      ...(shouldResetDelivery ? { delivery: { status: 'not_requested', attempts: base.delivery.attempts, updatedAt: iso(this.clock()) } } : {}),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: iso(this.clock())
    });
    await this.replace(occurrenceKey(base.id), stored.raw, updated);
  }

  private async advanceSchedule(schedule: SessionSchedule, due: string) {
    const current = await this.getRecord(scheduleKey(schedule.id), value => sessionScheduleSchema.parse(value));
    if (!current || current.value.generation !== schedule.generation || current.value.nextDueAt !== due) return;
    const upcoming = nextDue(current.value, this.clock());
    const updated = sessionScheduleSchema.parse({ ...current.value, enabled: current.value.enabled, nextDueAt: upcoming, updatedAt: current.value.updatedAt });
    await this.replace(scheduleKey(schedule.id), current.raw, updated);
  }

  private async disableSchedule(stored: { raw: string; value: SessionSchedule }) {
    if (!stored.value.enabled) return;
    const disabled = sessionScheduleSchema.parse({
      ...stored.value,
      revision: stored.value.revision + 1,
      generation: stored.value.generation + 1,
      enabled: false,
      nextDueAt: undefined,
      updatedAt: iso(this.clock())
    });
    await this.replace(scheduleKey(stored.value.id), stored.raw, disabled);
  }

  private async claimAndPollCi(stored: { raw: string; value: CiSubscription }) {
    const now = this.clock();
    const base = migrateCi(stored.value);
    if (new Date(base.expiresAt) <= now) {
      const expired = ciSubscriptionV2Schema.parse({ ...base, revision: base.revision + 1, schemaVersion: 2, status: 'expired', nextPollAt: undefined, updatedAt: iso(now) });
      await this.replace(ciKey(base.id), stored.raw, expired);
      return;
    }
    if (base.leaseExpiresAt && new Date(base.leaseExpiresAt) > now) return;
    const claimed = ciSubscriptionV2Schema.parse({ ...base, revision: base.revision + 1, schemaVersion: 2, leaseOwner: this.ownerId, leaseExpiresAt: plus(now, CLAIM_TTL_MS), updatedAt: iso(now) });
    if (!await this.replace(ciKey(base.id), stored.raw, claimed)) return;
    await this.pollCi({ raw: JSON.stringify(claimed), value: claimed });
  }

  private async pollCi(stored: { raw: string; value: CiSubscription }) {
    const current0 = migrateCi(stored.value);
    let runs: GithubWorkflowRun[];
    try { runs = await this.github.listRuns(current0.repository, current0.headSha, current0.workflow); }
    catch (error) {
      await this.returnCiToWaiting(stored, errorMessage(error));
      return;
    }
    if (runs.length === 0 || runs.some(run => run.status !== 'completed')) {
      await this.returnCiToWaiting(stored);
      return;
    }
    const current = await this.getRecord(ciKey(current0.id), value => ciSubscriptionSchema.parse(value));
    if (!current) return;
    const currentValue = migrateCi(current.value);
    if (currentValue.status !== 'waiting' || currentValue.leaseOwner !== this.ownerId) return;
    const session = await this.options.runtime.getSession(currentValue.sessionId);
    if (!isSessionRunnable(session)) {
      await this.finishCi(current, 'session_inactive', 'Session is no longer active');
      return;
    }
    let resolved: Awaited<ReturnType<typeof resolveGithubHead>>;
    try { resolved = await resolveGithubHead(session!.cwd); }
    catch (error) { await this.finishCi(current, 'stale_head', errorMessage(error)); return; }
    if (resolved.repository.slug.toLowerCase() !== currentValue.repository.slug.toLowerCase() || resolved.headSha !== currentValue.headSha) {
      await this.finishCi(current, 'stale_head', 'Session repository or HEAD changed while waiting for CI');
      return;
    }
    try { await this.requireAuthorized(currentValue.sessionId, currentValue.actorId); }
    catch (error) { await this.finishCi(current, 'revoked', errorMessage(error)); return; }
    // 首次 dispatchPrompt 在收到完成 run 列表后冻结；恢复使用原文本，不再拼接新 GitHub 返回。
    const dispatchPrompt = formatCiPrompt(currentValue.prompt, currentValue.repository.slug, currentValue.headSha, runs);
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
    if (!await this.replace(ciKey(currentValue.id), current.raw, dispatching)) return;
    await this.dispatchCi({ raw: JSON.stringify(dispatching), value: dispatching }, session!);
  }

  private async recoverDispatchingCi(stored: { raw: string; value: CiSubscription }) {
    const claimed0 = migrateCi(stored.value);
    if (!claimed0.dispatchPrompt) {
      await this.finishCi(stored, 'error', 'Persisted CI continuation prompt is missing');
      return;
    }
    const now = this.clock();
    if (new Date(claimed0.expiresAt) <= now) { await this.finishCi(stored, 'expired'); return; }

    // 统一来源恢复前序：先读原 admission/明确 taskId，在任何新 HEAD/材料/当前默认配置前核实际接受事实。
    if (claimed0.admission) {
      const accepted = this.execution.getAcceptedTask(claimed0.admission.taskId);
      if (accepted) {
        // 恢复命中已接受事实：完整接受 request 必须与冻结 admission 相等，否则持久 blocked，不借 ID 补映射。
        if (accepted.request && claimed0.admission.request && canonicalRequestDigest(accepted.request) !== canonicalRequestDigest(claimed0.admission.request)) {
          await this.finishCi(stored, 'blocked', 'The accepted task request conflicts with the frozen CI admission');
          return;
        }
        await this.ensureTaskBinding(claimed0.admission.taskId, {
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

    const claimedBase = ciSubscriptionV2Schema.parse({ ...claimed0, schemaVersion: 2, revision: claimed0.revision + 1, leaseOwner: this.ownerId, leaseExpiresAt: plus(now, CLAIM_TTL_MS), updatedAt: iso(now) });
    if (!await this.replace(ciKey(claimed0.id), stored.raw, claimedBase)) return;
    const claimed: { raw: string; value: CiSubscriptionV2 } = { raw: JSON.stringify(claimedBase), value: claimedBase };
    const session = await this.options.runtime.getSession(claimed.value.sessionId);
    if (!isSessionRunnable(session)) { await this.finishCi(claimed, 'session_inactive', 'Session is no longer active'); return; }
    try {
      await this.requireAuthorized(claimed.value.sessionId, claimed.value.actorId);
    } catch (error) {
      await this.finishCi(claimed, 'revoked', errorMessage(error));
      return;
    }
    await this.dispatchCi(claimed, session!);
  }

  private async dispatchCi(dispatching: { value: CiSubscriptionV2; raw?: string }, session: Session) {
    let record = dispatching.value;
    const prompt = record.dispatchPrompt;
    if (!prompt) throw new RuntimeError('SESSION_AUTOMATION_CI_PROMPT_MISSING', 'Persisted CI continuation prompt is missing', 500);
    const actor = record.actor ?? resolveAutomationActor(session, record.actorId);
    if (!actor) { await this.finishCi({ raw: dispatching.raw ?? JSON.stringify(record), value: record }, 'error', 'CI actor domain cannot be verified'); return; }

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
        existingAccepted = this.execution.lookupAccepted(candidateRequest);
      } catch (err) {
        await this.finishCi({ raw: dispatching.raw ?? JSON.stringify(record), value: record }, 'blocked', errorMessage(err));
        return;
      }
      if (existingAccepted) {
        taskId = existingAccepted.task.id;
        taskIdVersion = existingAccepted.task.digestVersion === 'v1' ? 'v1' : 'legacy';
        request = existingAccepted.request ?? candidateRequest;
        const admission: TaskAdmissionV1 = (existingAccepted.replayValidation === 'legacy_partial' || !existingAccepted.request || existingAccepted.task.digestVersion !== 'v1')
          ? {
              version: 1,
              kind: 'legacy_partial',
              taskIdVersion,
              taskId,
              ...(existingAccepted.request ? { request: existingAccepted.request } : {})
            }
          : {
              version: 1,
              kind: 'canonical',
              taskIdVersion: 'v1',
              taskId,
              request: existingAccepted.request
            };
        const withAdmission = ciSubscriptionV2Schema.parse({
          ...record,
          schemaVersion: 2,
          revision: record.revision + 1,
          admission,
          actor,
          taskId,
          updatedAt: iso(this.clock())
        });
        const raw = dispatching.raw ?? JSON.stringify(record);
        if (!await this.replace(ciKey(record.id), raw, withAdmission)) return;
        record = withAdmission;
      } else {
        taskId = canonicalTaskId('automation', record.sessionId, candidateRequest.key);
        request = candidateRequest;
        const admission = {
          version: 1 as const,
          kind: 'canonical' as const,
          taskIdVersion: 'v1' as const,
          taskId,
          request: candidateRequest
        };
        const withAdmission = ciSubscriptionV2Schema.parse({
          ...record,
          schemaVersion: 2,
          revision: record.revision + 1,
          admission,
          actor,
          updatedAt: iso(this.clock())
        });
        const raw = dispatching.raw ?? JSON.stringify(record);
        if (!await this.replace(ciKey(record.id), raw, withAdmission)) return;
        record = withAdmission;
      }
    }

    const stored: { raw: string; value: CiSubscriptionV2 } = { raw: JSON.stringify(record), value: record };
    // 重投先查接受事实，命中只补同一映射，不再读 HEAD/材料、不重拼 prompt。
    const acceptedBefore = this.execution.getAcceptedTask(taskId);
    if (acceptedBefore) {
      if (acceptedBefore.request && canonicalRequestDigest(acceptedBefore.request) !== canonicalRequestDigest(request)) {
        await this.finishCi(stored, 'blocked', 'The task key already belongs to a different accepted request');
        return;
      }
      await this.ensureTaskBinding(taskId, {
        schemaVersion: 2,
        kind: 'ci',
        sessionId: record.sessionId,
        subscriptionId: record.id,
        taskId,
        taskIdVersion,
        generation: CI_BINDING_GENERATION
      });
      await this.markCiAccepted(record.id, taskId);
      return;
    }
    await this.ensureTaskBinding(taskId, {
      schemaVersion: 2,
      kind: 'ci',
      sessionId: record.sessionId,
      subscriptionId: record.id,
      taskId,
      taskIdVersion,
      generation: CI_BINDING_GENERATION
    });
    const actorId = actor.kind === 'unspecified' ? undefined : actor.id;
    try {
      const task = await this.options.runtime.dispatch(record.sessionId, request.prompt, 'queue', request.prompt, undefined, actorId, request.key, request.skills, request);
      if (task.id !== taskId) throw new RuntimeError('SESSION_AUTOMATION_TASK_CONFLICT', 'Runtime task identity did not match the fixed admission', 409);
      await this.markCiAccepted(record.id, task.id);
    } catch (error) {
      if (this.closed) return;
      const durable = this.execution.getAcceptedTask(taskId);
      if (durable) {
        if (durable.request && canonicalRequestDigest(durable.request) === canonicalRequestDigest(request)) {
          await this.markCiAccepted(record.id, taskId);
          return;
        }
        await this.finishCi(stored, { status: 'blocked', blockReason: 'admission_conflict', error: 'Accepted task request conflicts with source admission' });
        return;
      }
      const latest = await this.getRecord(ciKey(record.id), value => ciSubscriptionSchema.parse(value));
      if (latest) await this.finishCi(latest, { status: 'error', error: errorMessage(error) });
    }
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
    await this.replace(ciKey(base.id), stored.raw, waiting);
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
      ...(shouldResetDelivery ? { delivery: { status: 'not_requested', attempts: base.delivery.attempts, updatedAt: iso(this.clock()) } } : {}),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: iso(this.clock())
    });
    await this.replace(ciKey(base.id), stored.raw, updated);
  }

  private async markCiAccepted(id: string, taskId: string) {
    const current = await this.getRecord(ciKey(id), value => ciSubscriptionSchema.parse(value));
    if (!current) return;
    const currentValue = migrateCi(current.value);
    if (currentValue.status !== 'dispatching') return;
    // CAS 核原来源身份：冻结 admission 的 taskId 必须与实际接受 Task 一致，不借最新 dispatching 记录绑定不同请求。
    if (currentValue.admission && currentValue.admission.taskId !== taskId) return;
    const accepted = ciSubscriptionV2Schema.parse({ ...currentValue, schemaVersion: 2, revision: currentValue.revision + 1, status: 'accepted', taskId, leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: iso(this.clock()) });
    await this.replace(ciKey(id), current.raw, accepted);
  }

  private async refreshAcceptedWork() {
    const [occurrences, subscriptions] = await Promise.all([
      this.listRecords(OCCURRENCE_PREFIX, value => sessionScheduleOccurrenceSchema.parse(value)),
      this.listRecords(CI_PREFIX, value => ciSubscriptionSchema.parse(value))
    ]);
    for (const item of occurrences) {
      if (this.closed) return;
      await this.refreshOccurrence(item);
    }
    for (const item of subscriptions) {
      if (this.closed) return;
      await this.refreshCi(item);
    }
  }

  /**
   * V1 来源记录迁移：若记录上已有实际接受 Task，则固定为 legacy_partial 并保留其旧 ID，
   * 不改成 canonical；映射冲突持久 blocked。尚未接受的 V1 记录不在这里造新 request（交给新触发流程）。
   */
  private async fixOccurrenceAdmission(item: { raw: string; value: SessionScheduleOccurrence }): Promise<{ raw: string; value: SessionScheduleOccurrenceV2 } | undefined> {
    const value = migrateOccurrence(item.value);
    if (value.admission) return { raw: item.raw, value };
    if (value.taskId) {
      const accepted = this.execution.getAcceptedTask(value.taskId);
      if (!accepted) return undefined;
      if (accepted.task.sessionId !== value.sessionId) {
        const blocked = sessionScheduleOccurrenceV2Schema.parse({ ...value, schemaVersion: 2, revision: value.revision + 1, runStatus: 'blocked', blockReason: 'admission_conflict', error: 'Accepted task belongs to another session', delivery: { status: 'not_requested', attempts: value.delivery.attempts, updatedAt: iso(this.clock()) }, updatedAt: iso(this.clock()) });
        await this.replace(occurrenceKey(value.id), item.raw, blocked);
        return { raw: JSON.stringify(blocked), value: blocked };
      }
      const admission = { version: 1 as const, kind: 'legacy_partial' as const, taskIdVersion: accepted.task.digestVersion === 'v1' ? 'v1' as const : 'legacy' as const, taskId: value.taskId, ...(accepted.request ? { request: accepted.request } : {}) };
      const fixed = sessionScheduleOccurrenceV2Schema.parse({ ...value, schemaVersion: 2, revision: value.revision + 1, admission, updatedAt: iso(this.clock()) });
      if (!(await this.replace(occurrenceKey(value.id), item.raw, fixed))) return undefined;
      return { raw: JSON.stringify(fixed), value: fixed };
    }
    // 若 V1 来源没有 taskId（接受响应丢失或旧版未记），通过 lookupAccepted 查找已存在的接受事实
    const scheduleStored = await this.getRecord(scheduleKey(value.scheduleId), v => sessionScheduleSchema.parse(v));
    if (scheduleStored) {
      const session = await this.options.runtime.getSession(value.sessionId);
      const actor = resolveAutomationActor(session, scheduleStored.value.actorId);
      if (session && actor) {
        const candidateRequest = this.buildRequest(session, 'schedule', scheduleRequestKey(value.id), scheduleStored.value.prompt, actor);
        let accepted;
        try { accepted = this.execution.lookupAccepted(candidateRequest); } catch { /* conflict */ }
        if (accepted && accepted.task.sessionId === value.sessionId) {
          const admission: TaskAdmissionV1 = {
            version: 1,
            kind: 'legacy_partial',
            taskIdVersion: accepted.task.digestVersion === 'v1' ? 'v1' : 'legacy',
            taskId: accepted.task.id,
            ...(accepted.request ? { request: accepted.request } : {})
          };
          const fixed = sessionScheduleOccurrenceV2Schema.parse({
            ...value,
            schemaVersion: 2,
            revision: value.revision + 1,
            taskId: accepted.task.id,
            admission,
            actor,
            updatedAt: iso(this.clock())
          });
          if (await this.replace(occurrenceKey(value.id), item.raw, fixed)) {
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
      const accepted = this.execution.getAcceptedTask(value.taskId);
      if (!accepted) return undefined;
      if (accepted.task.sessionId !== value.sessionId) {
        const blocked = ciSubscriptionV2Schema.parse({ ...value, schemaVersion: 2, revision: value.revision + 1, status: 'blocked', error: 'Accepted task belongs to another session', delivery: { status: 'not_requested', attempts: value.delivery.attempts, updatedAt: iso(this.clock()) }, updatedAt: iso(this.clock()) });
        await this.replace(ciKey(value.id), item.raw, blocked);
        return { raw: JSON.stringify(blocked), value: blocked };
      }
      const admission = { version: 1 as const, kind: 'legacy_partial' as const, taskIdVersion: accepted.task.digestVersion === 'v1' ? 'v1' as const : 'legacy' as const, taskId: value.taskId, ...(accepted.request ? { request: accepted.request } : {}) };
      const fixed = ciSubscriptionV2Schema.parse({ ...value, schemaVersion: 2, revision: value.revision + 1, admission, updatedAt: iso(this.clock()) });
      if (!(await this.replace(ciKey(value.id), item.raw, fixed))) return undefined;
      return { raw: JSON.stringify(fixed), value: fixed };
    }
    const session = await this.options.runtime.getSession(value.sessionId);
    const actor = resolveAutomationActor(session, value.actorId);
    if (session && actor && value.dispatchPrompt) {
      const candidateRequest = this.buildRequest(session, 'automation', ciRequestKey(value.id), value.dispatchPrompt, actor);
      let accepted;
      try { accepted = this.execution.lookupAccepted(candidateRequest); } catch { /* conflict */ }
      if (accepted && accepted.task.sessionId === value.sessionId) {
        const admission: TaskAdmissionV1 = {
          version: 1,
          kind: 'legacy_partial',
          taskIdVersion: accepted.task.digestVersion === 'v1' ? 'v1' : 'legacy',
          taskId: accepted.task.id,
          ...(accepted.request ? { request: accepted.request } : {})
        };
        const fixed = ciSubscriptionV2Schema.parse({
          ...value,
          schemaVersion: 2,
          revision: value.revision + 1,
          taskId: accepted.task.id,
          admission,
          actor,
          updatedAt: iso(this.clock())
        });
        if (await this.replace(ciKey(value.id), item.raw, fixed)) {
          return { raw: JSON.stringify(fixed), value: fixed };
        }
      }
    }
    return undefined;
  }

  private async refreshOccurrence(item: { raw: string; value: SessionScheduleOccurrence }) {
    const fixed = await this.fixOccurrenceAdmission(item);
    if (!fixed || !fixed.value.admission) return;
    // 仍在派发阶段（pending，acceptance 在途或响应丢失、尚无接受事实）时不做结果对账，
    // 由 processOccurrence 重投/恢复，避免把在途来源误判为 blocked。
    // 派发时就被拒（error，例如月度成本上限）同样没有接受事实：保留原因，不对账成 blocked，否则会挡住之后每一次触发。
    if (['pending', 'error'].includes(fixed.value.runStatus) && !this.execution.getAcceptedTask(fixed.value.admission.taskId)) return;
    let working = fixed;
    let value = working.value;

    // 双 KV 中断恢复：来源已固定 admission 且接受事实存在，但第二授权 KV 丢失时，幂等补回同一 binding。
    const fixedAdmission = fixed.value.admission;
    if (this.execution.getAcceptedTask(fixedAdmission.taskId)) {
      try {
        await this.ensureTaskBinding(fixedAdmission.taskId, {
          schemaVersion: 2, kind: 'schedule', sessionId: fixed.value.sessionId, occurrenceId: fixed.value.id,
          scheduleId: fixed.value.scheduleId, taskId: fixedAdmission.taskId, taskIdVersion: fixedAdmission.taskIdVersion, generation: fixed.value.generation
        });
      } catch (err) {
        await this.finishOccurrence(working, { runStatus: 'blocked', blockReason: 'admission_conflict', error: errorMessage(err) });
        return;
      }
    }

    // refresh 先保护既有 delivered 历史，缺新 result 不能降 blocked/not_requested 或重发。
    if (value.delivery.status === 'delivered') return;

    // 来源 blocked/reconcile_required 时仍仅重读已固定 number=1：原 Attempt 经明确人工结算后可更新同一来源；Attempt 2 成功不能代替。
    if (value.runStatus === 'blocked') {
      if (value.blockReason !== 'reconcile_required' || !value.runtimeAttemptId) return;
    }

    // 先在自身 CAS 固定 number=1 Attempt.id，再读结果。
    if (!value.runtimeAttemptId) {
      const projection = this.execution.getTaskExecution(value.admission!.taskId);
      const first = projection?.attempts.find(attempt => attempt.number === 1);
      if (first) {
        const fixedAttempt = sessionScheduleOccurrenceV2Schema.parse({ ...value, revision: value.revision + 1, runtimeAttemptId: first.attemptId, updatedAt: iso(this.clock()) });
        if (await this.replace(occurrenceKey(value.id), working.raw, fixedAttempt)) working = { raw: JSON.stringify(fixedAttempt), value: fixedAttempt };
        else return;
        value = working.value;
      }
    }
    const outcome = this.reconcileAdmission(value.sessionId, value);
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
          delivery: { status: 'not_requested', attempts: working.value.delivery.attempts, updatedAt: iso(this.clock()) }
        });
      }
      return;
    }
    const result = outcome.result!;
    const settlingNow = working.value.runStatus === 'accepted' || working.value.runStatus === 'pending' || working.value.runStatus === 'blocked';
    let terminal = working.value;
    if (settlingNow) {
      const runStatus = result.outcome === 'completed' ? 'completed' : result.outcome === 'cancelled' ? 'interrupted' : result.outcome === 'interrupted' ? 'interrupted' : 'failed';
      const settled = sessionScheduleOccurrenceV2Schema.parse({
        ...working.value,
        revision: working.value.revision + 1,
        runStatus,
        result,
        resultBoundary: 'verified',
        blockReason: undefined,
        error: undefined,
        // 来源恢复时死 owner 租约必须清除，否则交付租约领取会被未过期租约挡住。
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        ...(result.outcome === 'cancelled' ? { delivery: { status: 'not_requested', attempts: working.value.delivery.attempts, updatedAt: iso(this.clock()) } } : {}),
        updatedAt: iso(this.clock())
      });
      if (!await this.replace(occurrenceKey(value.id), working.raw, settled)) return;
      terminal = settled;
    } else if (!working.value.result) {
      // 旧 pending/error 终态缺可靠结果：blocked，不重造 pending。
      if (['pending', 'error'].includes(working.value.runStatus)) {
        await this.finishOccurrence(working, { runStatus: 'blocked', blockReason: 'legacy_output_unresolved', resultBoundary: 'legacy_output_unresolved' });
      }
      return;
    }
    if (['pending', 'error'].includes(terminal.delivery.status) && terminal.result) await this.attemptOccurrenceDelivery(terminal);
  }

  private async refreshCi(item: { raw: string; value: CiSubscription }) {
    const fixed = await this.fixCiAdmission(item);
    if (!fixed || !fixed.value.admission) return;
    // 仍在派发阶段（dispatching，acceptance 在途或响应丢失）时不做结果对账；
    // 交由 recoverDispatchingCi 用原冻结 prompt 重投，避免误判为 blocked。
    if (fixed.value.status === 'dispatching' && !this.execution.getAcceptedTask(fixed.value.admission.taskId)) return;
    let working = fixed;
    let value = working.value;

    // 双 KV 中断恢复：CI 来源已固定 admission 且接受事实存在，但第二授权 KV 丢失时，幂等补回同一 binding。
    if (this.execution.getAcceptedTask(value.admission!.taskId)) {
      try {
        await this.ensureTaskBinding(value.admission!.taskId, {
          schemaVersion: 2, kind: 'ci', sessionId: value.sessionId, subscriptionId: value.id,
          taskId: value.admission!.taskId, taskIdVersion: value.admission!.taskIdVersion, generation: CI_BINDING_GENERATION
        });
      } catch (err) {
        await this.finishCi(working, { status: 'blocked', blockReason: 'admission_conflict', error: errorMessage(err) });
        return;
      }
    }

    if (value.delivery.status === 'delivered') return;

    if (value.status === 'blocked') {
      if (value.blockReason !== 'reconcile_required' || !value.runtimeAttemptId) return;
    }
    if (!value.runtimeAttemptId) {
      const projection = this.execution.getTaskExecution(value.admission!.taskId);
      const first = projection?.attempts.find(attempt => attempt.number === 1);
      if (first) {
        const fixedAttempt = ciSubscriptionV2Schema.parse({ ...value, revision: value.revision + 1, runtimeAttemptId: first.attemptId, updatedAt: iso(this.clock()) });
        if (await this.replace(ciKey(value.id), working.raw, fixedAttempt)) working = { raw: JSON.stringify(fixedAttempt), value: fixedAttempt };
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
    const settlingNow = working.value.status === 'accepted' || working.value.status === 'dispatching' || working.value.status === 'blocked';
    let terminal = working.value;
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
        ...(result.outcome === 'cancelled' ? { delivery: { status: 'not_requested', attempts: working.value.delivery.attempts, updatedAt: iso(this.clock()) } } : {}),
        updatedAt: iso(this.clock())
      });
      if (!await this.replace(ciKey(value.id), working.raw, completed)) return;
      terminal = completed;
    } else if (!working.value.result) {
      if (['waiting', 'dispatching', 'error'].includes(working.value.status)) {
        await this.finishCi(working, 'blocked', 'Historical terminal CI continuation has no verifiable result');
      }
      return;
    }
    if (['pending', 'error'].includes(terminal.delivery.status) && terminal.result) await this.attemptCiDelivery(terminal);
  }

  private async attemptOccurrenceDelivery(value: SessionScheduleOccurrenceV2) {
    if (!this.options.deliver || !['pending', 'error'].includes(value.delivery.status) || !value.result) return;
    const before = await this.getRecord(occurrenceKey(value.id), input => sessionScheduleOccurrenceSchema.parse(input));
    if (!before) return;
    const beforeValue = migrateOccurrence(before.value);
    if (beforeValue.delivery.status === 'delivered' || beforeValue.leaseExpiresAt && new Date(beforeValue.leaseExpiresAt) > this.clock()) return;
    const frozen = beforeValue.result;
    if (!frozen) return;
    const claimed = sessionScheduleOccurrenceV2Schema.parse({ ...beforeValue, schemaVersion: 2, revision: beforeValue.revision + 1, leaseOwner: this.ownerId, leaseExpiresAt: plus(this.clock(), CLAIM_TTL_MS), updatedAt: iso(this.clock()) });
    if (!await this.replace(occurrenceKey(value.id), before.raw, claimed)) return;
    let deliveryError: string | undefined;
    try { await this.options.deliver(value.sessionId, frozen, value.id, value.scheduleId); }
    catch (cause) { deliveryError = errorMessage(cause); }
    const current = await this.getRecord(occurrenceKey(value.id), input => sessionScheduleOccurrenceSchema.parse(input));
    if (!current) return;
    const currentValue = migrateOccurrence(current.value);
    // CAS 前核对同一来源、lease owner、原 task/attempt/settlement/throughSequence/digest；迟到回执不覆盖新结果。
    if (currentValue.leaseOwner !== this.ownerId) return;
    if (currentValue.sessionId !== value.sessionId || currentValue.scheduleId !== value.scheduleId || currentValue.generation !== value.generation) return;
    if (!['completed', 'failed', 'interrupted'].includes(currentValue.runStatus)) return;
    if (currentValue.delivery.status === 'not_requested') return;
    if (!sameResult(currentValue.result, frozen)) return;
    if (currentValue.delivery.status === 'delivered') return;
    const updated = sessionScheduleOccurrenceV2Schema.parse({
      ...currentValue,
      schemaVersion: 2,
      revision: currentValue.revision + 1,
      delivery: { status: deliveryError ? 'error' : 'delivered', attempts: currentValue.delivery.attempts + 1, ...(deliveryError ? { error: deliveryError } : { error: undefined }), updatedAt: iso(this.clock()) },
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: iso(this.clock())
    });
    await this.replace(occurrenceKey(value.id), current.raw, updated);
  }

  private async attemptCiDelivery(value: CiSubscriptionV2) {
    if (!this.options.deliver || !['pending', 'error'].includes(value.delivery.status) || !value.result) return;
    const before = await this.getRecord(ciKey(value.id), input => ciSubscriptionSchema.parse(input));
    if (!before) return;
    const beforeValue = migrateCi(before.value);
    if (beforeValue.delivery.status === 'delivered' || beforeValue.leaseExpiresAt && new Date(beforeValue.leaseExpiresAt) > this.clock()) return;
    const frozen = beforeValue.result;
    if (!frozen) return;
    const claimed = ciSubscriptionV2Schema.parse({ ...beforeValue, schemaVersion: 2, revision: beforeValue.revision + 1, leaseOwner: this.ownerId, leaseExpiresAt: plus(this.clock(), CLAIM_TTL_MS), updatedAt: iso(this.clock()) });
    if (!await this.replace(ciKey(value.id), before.raw, claimed)) return;
    let deliveryError: string | undefined;
    try { await this.options.deliver(value.sessionId, frozen, value.id, value.id); }
    catch (cause) { deliveryError = errorMessage(cause); }
    const current = await this.getRecord(ciKey(value.id), input => ciSubscriptionSchema.parse(input));
    if (!current) return;
    const currentValue = migrateCi(current.value);
    if (currentValue.leaseOwner !== this.ownerId) return;
    if (currentValue.sessionId !== value.sessionId) return;
    if (currentValue.status === 'cancelled') return;
    if (!sameResult(currentValue.result, frozen)) return;
    if (currentValue.delivery.status === 'delivered') return;
    const updated = ciSubscriptionV2Schema.parse({
      ...currentValue,
      schemaVersion: 2,
      revision: currentValue.revision + 1,
      delivery: { status: deliveryError ? 'error' : 'delivered', attempts: currentValue.delivery.attempts + 1, ...(deliveryError ? { error: deliveryError } : { error: undefined }), updatedAt: iso(this.clock()) },
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: iso(this.clock())
    });
    await this.replace(ciKey(value.id), current.raw, updated);
  }
}

function canonicalRequestDigest(request: TaskRequestV1): string {
  // 复用与账本一致的稳定 JSON 比较，避免键序差异。
  return canonicalExecutionJson(request);
}

function sameResult(a?: AttemptResultV1, b?: AttemptResultV1): boolean {
  if (!a || !b) return false;
  return a.taskId === b.taskId
    && a.attemptId === b.attemptId
    && a.settlementId === b.settlementId
    && a.throughSequence === b.throughSequence
    && a.output.digest === b.output.digest;
}
