import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  type ConfigRepository,
  RuntimeError,
  canonicalExecutionJson,
  previewSessionSchedule,
  type AttemptResultV1,
  type ExecutionActor,
  type PolicyDecision,
  type RepositoryBundle,
  parseLarkSourceId,
  type AcceptedTask,
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
  readStoredSessionSchedule,
  scheduleTriggerSchema,
  subscribeCiInputSchema,
  updateSessionScheduleInputSchema,
  runSessionScheduleInputSchema,
  deleteSessionScheduleInputSchema,
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
  type UpdateSessionScheduleInput,
  type RunSessionScheduleInput,
  type DeleteSessionScheduleInput,
  LEGACY_GITHUB_PROVIDER_ID,
  type CiProvider,
  type CiRepository,
  type CiRun,
  type PublicCiProvider,
  type AutomationSchedulePage,
  type AutomationScheduleQuery,
  type AutomationScheduleSummary,
  type AutomationHistoryPage,
  type AutomationRunDetail,
  type AgentEvent,
  type StartSessionInput
} from '@dutydeck/shared';
import { executionTaskId } from '@dutydeck/storage';
import { CiProviderRegistry, ciProviderLabel, resolveCiHead, type CiHead } from './ci-providers.js';
import type { CiWebhookService } from './ci-webhook.js';
import type { PullRequestService } from './pull-requests.js';
import { readTaskAttemptResult } from './task-results.js';
import { z } from 'zod';

const SCHEDULE_PREFIX = 'session_automation/schedule/';
const OCCURRENCE_PREFIX = 'session_automation/occurrence/';
const CI_PREFIX = 'session_automation/ci/';
const TASK_BINDING_PREFIX = 'session_automation/task/';
const STOP_REQUEST_PREFIX = 'session_automation/stop_request/';
const stopRequestSchema = z.object({
  version: z.literal(1), taskId: z.string().min(1), attemptId: z.string().min(1), sessionId: z.string().min(1),
  occurrenceId: z.string().min(1), scheduleId: z.string().min(1), generation: z.number().int().positive(), actorId: z.string().min(1),
  status: z.enum(['pending', 'applied', 'rejected']), reason: z.string().optional()
}).strict();
const MAX_RECORDS = 1_000;
const CLAIM_TTL_MS = 30_000;
const MAX_DELIVERIES = 4;
const DEFAULT_POLL_MS = 60_000;
const runStatuses = new Set(['queued', 'running', 'completed']);
/** 未决/阻塞来源持续挡下一次触发；其余 runStatus 为终态。 */
const openRunStatuses = new Set(['pending', 'accepted', 'blocked']);
const settledTaskStatuses = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
/** CI 定义本身没有代际字段；binding 中的 generation 仅用于严格记录结构，取固定值。 */
const CI_BINDING_GENERATION = 1;

type ExecutionLedger = Pick<RepositoryBundle['execution'], 'getAcceptedTask' | 'getTaskExecution' | 'getAttemptEvents' | 'lookupAccepted'>;
type AutomationRepositories = Pick<RepositoryBundle, 'config' | 'sessions' | 'tasks'> & { execution: ExecutionLedger };
type AuthorizationResult = boolean | PolicyDecision;

export interface SessionAutomationRuntime {
  getSession(id: string): Promise<Session | undefined>;
  dispatchRequest(request: TaskRequestV1): Promise<{ id: string; status: string }>;
  startScheduleSession?(input: StartSessionInput, stableSessionId: string, beforeStart: () => Promise<void>): Promise<Session>;
  /** 归档上一次 fresh 执行用过的会话；缺省时只靠空闲进程清理。 */
  archive?(sessionId: string): Promise<unknown>;
  subscribe?(sessionId: string, listener: (event: AgentEvent) => void): () => void;
}

export interface AutomationDeliveryContext {
  signal: AbortSignal;
  /** Recheck the exact source and lease before each outbound delivery step. */
  assertCurrent(): Promise<void>;
}

type DeliveryRecord = SessionScheduleOccurrenceV2 | CiSubscriptionV2;
type TickParseCache = {
  occurrences: Map<string, SessionScheduleOccurrence>;
  subscriptions: Map<string, CiSubscription>;
};

export interface SessionAutomationServiceOptions {
  repositories: AutomationRepositories;
  runtime: SessionAutomationRuntime;
  authorize?: (sessionId: string, actorId?: string) => AuthorizationResult | Promise<AuthorizationResult>;
  prepareDelivery?: (sessionId: string, automationId: string) => Promise<void>;
  deliver?: (sessionId: string, result: AttemptResultV1, occurrenceId: string, sourceId: string, context?: AutomationDeliveryContext) => Promise<void>;
  onScheduleDisabled?: (schedule: SessionSchedule, reason: string, beforeSend?: () => Promise<void>) => Promise<void | 'not_requested'>;
  reconcileDisabledNotification?: (schedule: SessionSchedule) => Promise<boolean>;
  /** 已加载插件注册的 CI 提供方；没有 CI 插件时为空，CI 等待与「出现新的失败构建」不可用。 */
  ciProviders?: CiProviderRegistry;
  /** webhook 驱动的 CI 续作与修复；没有配置 webhook 的提供方时不注入。 */
  ciWebhook?: CiWebhookService;
  /** `/pr` 与 Web「开 PR」：会话改动开 PR 并跟进。 */
  pullRequests?: PullRequestService;
  clock?: () => Date;
  pollIntervalMs?: number;
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
function receiptScheduleId(sessionId: string, actorId: string | undefined, key: string) {
  return `schedule_${createHash('sha256').update(JSON.stringify([sessionId, actorId, key])).digest('hex')}`;
}
/** fresh 计划每次触发的执行会话：由触发编号派生，同一次触发重试拿回同一个会话。 */
function freshSessionId(scheduleId: string, occurrence: string) {
  return `ses_schedule_${createHash('sha256').update(`fresh\0${scheduleId}\0${occurrence}`).digest('hex')}`;
}
/** 冻结来源会话的执行配置；fresh 沿用来源会话的目录（共享工作区），不另建 worktree。 */
function freshExecutionContext(session: Session): NonNullable<SessionSchedule['executionContext']> {
  return { cwd: session.cwd, agentId: session.agentId,
    ...(session.model ? { model: session.model } : {}), ...(session.codexProfile ? { codexProfile: session.codexProfile } : {}),
    ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
    ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}), contextMode: 'prompt_only' };
}
/** 间隔触发按间隔比较：代建请求每次带新的锚点，不能据此判为改动。 */
function sameTrigger(left: SessionSchedule['trigger'], right: SessionSchedule['trigger']) {
  if (left.kind === 'interval' && right.kind === 'interval') return left.everySeconds === right.everySeconds;
  return canonicalExecutionJson(left) === canonicalExecutionJson(right);
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
    const { appId } = parseLarkSourceId(session.sourceId);
    if (appId) return { kind: 'channel', id: actorId, appId };
  }
  return undefined;
}

function legacyAdmission(accepted: AcceptedTask, taskId = accepted.task.id): TaskAdmissionV1 {
  return {
    version: 1,
    kind: 'legacy_partial',
    taskIdVersion: accepted.task.digestVersion === 'v1' ? 'v1' : 'legacy',
    taskId,
    ...(accepted.request ? { request: accepted.request } : {})
  };
}

/** 已有接受事实时沿用其 ID（请求不完整固定为 legacy_partial）；确认未接受时以候选请求 canonical 准入。 */
function admissionFor(candidate: TaskRequestV1, existing: AcceptedTask | undefined, newTaskId: string): TaskAdmissionV1 {
  if (!existing) return { version: 1, kind: 'canonical', taskIdVersion: 'v1', taskId: newTaskId, request: candidate };
  if (existing.replayValidation === 'legacy_partial' || !existing.request || existing.task.digestVersion !== 'v1') return legacyAdmission(existing);
  return { version: 1, kind: 'canonical', taskIdVersion: 'v1', taskId: existing.task.id, request: existing.request };
}

type AutomationTaskLabel = 'Scheduled task' | 'CI continuation';

function assertAdmissionMatchesAccepted(label: AutomationTaskLabel, admission: TaskAdmissionV1, accepted: AcceptedTask | undefined) {
  if (!accepted) return;
  if (admission.kind === 'canonical') {
    if (!accepted.request || canonicalExecutionJson(accepted.request) !== canonicalExecutionJson(admission.request)) {
      throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', `${label} admission conflicts with accepted request`, 403);
    }
  } else if (accepted.request && admission.request) {
    if (canonicalExecutionJson(accepted.request) !== canonicalExecutionJson(admission.request)) {
      throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', `${label} admission conflicts with accepted request`, 403);
    }
  }
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

function publicSchedule(value: SessionSchedule): PublicSessionSchedule {
  const { actorId: _actorId, taskStartOccurrenceId: _taskStartOccurrenceId, stopRequestId: _stopRequestId, pendingOccurrence: _pendingOccurrence, ...record } = value;
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
  return { ...record, provider: record.provider ?? LEGACY_GITHUB_PROVIDER_ID };
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
type TaskBindingV2 = Extract<TaskBinding, { schemaVersion: 2 }>;

function sameV2Binding(a: TaskBindingV2, b: TaskBindingV2) {
  if (a.kind === 'schedule' && b.kind === 'schedule') {
    return a.sessionId === b.sessionId
      && a.occurrenceId === b.occurrenceId
      && a.scheduleId === b.scheduleId
      && a.taskId === b.taskId
      && a.taskIdVersion === b.taskIdVersion
      && a.generation === b.generation;
  }
  if (a.kind === 'ci' && b.kind === 'ci') {
    return a.sessionId === b.sessionId
      && a.subscriptionId === b.subscriptionId
      && a.taskId === b.taskId
      && a.taskIdVersion === b.taskIdVersion
      && a.generation === b.generation;
  }
  return false;
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

export class SessionAutomationService {
  private readonly ownerId = `automation_${randomUUID()}`;
  private readonly clock: () => Date;
  private readonly providers: CiProviderRegistry;
  private readonly pollIntervalMs: number;
  private closed = false;
  private currentTick?: Promise<void>;
  private readonly deliveries = new Map<string, { controller: AbortController; run: Promise<void> }>();
  private readonly manualRuns = new Set<Promise<PublicSessionScheduleOccurrence>>();
  private lastDeliveryKey?: string;
  private tickRequested = false;
  private readonly subscriptions = new Map<string, () => void>();
  private readonly quarantinedSchedules = new Set<string>();

  private invalidRecord(key: string, raw: string) {
    // Record identifiers are enough for repair. Never log the stored payload or parser issues.
    console.warn('SESSION_AUTOMATION_RECORD_INVALID', key);
    try {
      const value = JSON.parse(raw) as { scheduleId?: unknown };
      if (typeof value?.scheduleId === 'string') this.quarantinedSchedules.add(value.scheduleId);
    } catch { /* A reservation still keeps an unreadable occurrence occupied. */ }
  }

  private watchSession(sessionId: string) {
    if (this.closed || !this.options.runtime.subscribe || this.subscriptions.has(sessionId)) return;
    this.subscriptions.set(sessionId, this.options.runtime.subscribe(sessionId, event => {
      if (['status', 'task', 'completed', 'error'].includes(event.type)) {
        void this.tick().catch(() => { console.warn('SESSION_AUTOMATION_WAKE_FAILED', sessionId); });
      }
    }));
  }

  private async isolate(operation: () => Promise<void>) {
    try { await operation(); }
    catch (error) {
      console.warn('SESSION_AUTOMATION_ITEM_FAILED', error instanceof RuntimeError ? error.code : 'UNEXPECTED_ERROR');
    }
  }


  constructor(private readonly options: SessionAutomationServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.pollIntervalMs = Math.max(60_000, Math.min(60 * 60_000, options.pollIntervalMs ?? DEFAULT_POLL_MS));
    this.providers = options.ciProviders ?? new CiProviderRegistry();
  }

  /** 至少装了一个 CI 插件；/ci 据此判断「未安装 CI 插件」。 */
  get ciConfigured() { return this.providers.size > 0; }
  get ciWebhook() { return this.options.ciWebhook; }
  get pullRequests() { return this.options.pullRequests; }
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
  /** 群委托的确认卡与产出卡按钮处理；群协作集成装配好后挂上，飞书卡片回调经此进入。 */
  mandateCards?: { callback(appId: string, value: Record<string, unknown>, operatorId: string | undefined, context: { messageId?: string; chatId?: string }): Promise<string> };

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

  private async listRecords<T>(prefix: string, parse: (input: unknown) => T, cache?: Map<string, T>, filter?: Parameters<NonNullable<ConfigRepository['listByJsonField']>>[1]): Promise<Array<{ raw: string; value: T }>> {
    const store = this.requireStore();
    const rows = filter && store.listByJsonField ? await store.listByJsonField(prefix, filter) : await store.list(prefix);
    const parsed: Array<{ raw: string; value: T }> = [];
    for (const row of rows) {
      try {
        const value = cache?.get(row.value) ?? parse(JSON.parse(row.value));
        cache?.set(row.value, value);
        parsed.push({ raw: row.value, value });
      }
      catch { this.invalidRecord(row.key, row.value); }
    }
    return parsed;
  }

  private async getRecord<T>(key: string, parse: (input: unknown) => T): Promise<{ raw: string; value: T } | undefined> {
    const raw = await this.options.repositories.config.get(key);
    if (!raw) return undefined;
    try { return { raw, value: parse(JSON.parse(raw)) }; }
    catch { this.invalidRecord(key, raw); throw new RuntimeError('SESSION_AUTOMATION_RECORD_INVALID', 'Stored session automation record is invalid', 500); }
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
      if (sameV2Binding(existing.value, binding)) return;
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
        if (recheck?.value.schemaVersion === 2 && sameV2Binding(recheck.value, binding)) return;
      } else if (existing.value.kind === 'ci' && binding.kind === 'ci'
        && existing.value.sessionId === binding.sessionId
        && existing.value.subscriptionId === binding.subscriptionId) {
        if (await this.replace(taskBindingKey(taskId), existing.raw, binding)) return;
        const recheck = await this.getRecord(taskBindingKey(taskId), value => taskBindingSchema.parse(value));
        if (recheck?.value.schemaVersion === 2 && sameV2Binding(recheck.value, binding)) return;
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
    try { read = readTaskAttemptResult({ execution: this.execution }, sessionId, admission.taskId, first.attemptId); }
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
    const session = await this.requireSession(sessionId);
    const [schedules, subscriptions, occurrences] = await Promise.all([
      this.listRecords(SCHEDULE_PREFIX, readStoredSessionSchedule, undefined, { field: 'sessionId', values: [sessionId] }),
      this.listRecords(CI_PREFIX, value => ciSubscriptionSchema.parse(value), undefined, { field: 'sessionId', values: [sessionId] }),
      this.listRecords(OCCURRENCE_PREFIX, value => sessionScheduleOccurrenceSchema.parse(value), undefined, { field: 'sessionId', values: [sessionId] })
    ]);
    const publicSchedules = schedules.map(item => item.value).filter(item => item.sessionId === sessionId && !item.deletedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-MAX_RECORDS).map(publicSchedule);
    const deliveryTargets: NonNullable<SessionAutomationList['deliveryTargets']> = {};
    const source = parseLarkSourceId(session.sourceId);
    await Promise.all(publicSchedules.map(async schedule => {
      if (session.source !== 'lark') { deliveryTargets[schedule.id] = { kind: 'task', sessionId }; return; }
      const raw = await this.options.repositories.config.get(`automation.delivery-target.${schedule.id}`);
      let target: unknown;
      try { target = raw ? JSON.parse(raw) : undefined; } catch { target = undefined; }
      const parsed = z.object({ appId: z.string().min(1), chatId: z.string().min(1), replyMessageId: z.string().startsWith('om_'), replyInThread: z.boolean() }).safeParse(target);
      deliveryTargets[schedule.id] = parsed.success && source.appId === parsed.data.appId && source.chatId === parsed.data.chatId
        ? { kind: 'lark', ...parsed.data }
        : { kind: 'unavailable' };
    }));
    return {
      deliveryTargets,
      schedules: publicSchedules,
      subscriptions: subscriptions.map(item => item.value).filter(item => item.sessionId === sessionId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-MAX_RECORDS).map(publicSubscription),
      occurrences: occurrences.map(item => item.value).filter(item => item.sessionId === sessionId).sort((a, b) => a.scheduledForUtc.localeCompare(b.scheduledForUtc)).slice(-MAX_RECORDS).map(publicOccurrence)
    };
  }

  private async ciCondition(session: Session, input: { kind: 'ci_new_failure'; provider?: string; workflow?: string }) {
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

  async createSchedule(sessionId: string, rawInput: CreateSessionScheduleInput, actorId?: string, receipt?: { key: string; prepareDelivery?: (id: string) => Promise<void> }): Promise<PublicSessionSchedule> {
    await this.requireAuthorized(sessionId, actorId);
    const session = await this.requireSession(sessionId);
    if (!isSessionRunnable(session)) throw new RuntimeError('SESSION_NOT_ACTIVE', 'Session is not active', 409);
    const input = createSessionScheduleInputSchema.parse(rawInput);
    const id = receipt ? receiptScheduleId(sessionId, actorId, receipt.key) : `schedule_${randomUUID()}`;
    const existing = receipt ? await this.getRecord(scheduleKey(id), readStoredSessionSchedule) : undefined;
    if (existing) return publicSchedule(existing.value);
    await this.assertNameAvailable(sessionId, input.name);
    const now = iso(this.clock());
    const condition = input.condition.kind === 'always' ? input.condition : await this.ciCondition(session, input.condition);
    await receipt?.prepareDelivery?.(id);
    if (input.mode === 'fresh' && !this.options.runtime.startScheduleSession) throw new RuntimeError('FRESH_SCHEDULE_UNAVAILABLE', 'Fresh-session schedules are unavailable on this instance', 503);
    if (input.mode === 'independent') {
      if (!this.options.runtime.startScheduleSession) throw new RuntimeError('INDEPENDENT_SCHEDULE_UNAVAILABLE', 'Independent schedules are unavailable on this instance', 503);
      try { await promisify(execFile)('git', ['-C', session.cwd, 'rev-parse', '--git-common-dir']); }
      catch { throw new RuntimeError('INDEPENDENT_WORKSPACE_UNSUPPORTED', 'Independent schedules require a managed Git worktree; use session mode for this directory', 422); }
    }
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
      mode: input.mode ?? 'session',
      misfirePolicy: input.misfirePolicy ?? 'coalesce',
      ...(input.maxLatenessSeconds ? { maxLatenessSeconds: input.maxLatenessSeconds } : {}),
      ...(input.mode === 'independent' ? {
        executionSessionId: `ses_schedule_${createHash('sha256').update(id).digest('hex')}`,
        executionContext: { cwd: session.workspaceSourceCwd ?? session.cwd, sourceCwd: session.workspaceSourceCwd ?? session.cwd, agentId: session.agentId,
          ...(session.model ? { model: session.model } : {}), ...(session.codexProfile ? { codexProfile: session.codexProfile } : {}),
          ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
          ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}), contextMode: 'prompt_only' }
      } : {}),
      ...(input.mode === 'fresh' ? { executionContext: freshExecutionContext(session) } : {}),
      enabled: false,
      createdAt: now,
      updatedAt: now
    });
    previewSessionSchedule(schedule, this.clock());
    if (!await this.createRecord(scheduleKey(schedule.id), schedule)) {
      if (receipt) {
        const saved = await this.getRecord(scheduleKey(id), readStoredSessionSchedule);
        if (saved) return publicSchedule(saved.value);
      }
      throw new RuntimeError('SESSION_AUTOMATION_CONFLICT', 'Schedule identifier already exists', 409);
    }
    this.watchSession(sessionId);
    if (schedule.mode === 'independent') {
      await this.executionSession(schedule);
      const current = await this.getRecord(scheduleKey(id), readStoredSessionSchedule);
      return publicSchedule(current!.value);
    }
    return publicSchedule(schedule);
  }

  /**
   * 聊天里代建计划：同一会话已有同名计划（含已停用，不含已删除）时改为更新它，不再新建第二条。
   * 有实际改动时一并停用，等用户在确认卡上重新启用；没有改动时原样返回。同一请求重试拿回同一结果。
   */
  async requestSchedule(sessionId: string, rawInput: CreateSessionScheduleInput, actorId: string, receipt: { key: string; prepareDelivery?: (id: string) => Promise<void> }): Promise<{ schedule: PublicSessionSchedule; updated?: { changed: boolean; wasEnabled: boolean } }> {
    await this.requireAuthorized(sessionId, actorId);
    const input = createSessionScheduleInputSchema.parse(rawInput);
    const own = await this.getRecord(scheduleKey(receiptScheduleId(sessionId, actorId, receipt.key)), readStoredSessionSchedule);
    if (own) return { schedule: publicSchedule(own.value) };
    // 旧数据里可能已有多条同名：先改仍在启用的那条，其次最近改过的。
    const [existing] = (await this.sameNameSchedules(sessionId, input.name))
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.updatedAt.localeCompare(a.updatedAt));
    if (!existing) return { schedule: await this.createSchedule(sessionId, input, actorId, receipt) };
    if (input.mode === 'independent' && existing.mode !== 'independent') throw new RuntimeError('SESSION_AUTOMATION_MODE_IMMUTABLE', 'An existing schedule cannot switch to independent mode', 409);
    const mode = input.mode === 'independent' ? undefined : input.mode;
    const patch: Omit<UpdateSessionScheduleInput, 'expectedRevision'> = {
      ...(input.prompt !== existing.prompt ? { prompt: input.prompt } : {}),
      ...(!sameTrigger(input.trigger, existing.trigger) ? { trigger: input.trigger } : {}),
      ...(input.timezone !== existing.timezone ? { timezone: input.timezone } : {}),
      ...(canonicalExecutionJson(input.dstPolicy) !== canonicalExecutionJson(existing.dstPolicy) ? { dstPolicy: input.dstPolicy } : {}),
      ...(input.condition.kind !== existing.condition.kind ? { condition: input.condition } : {}),
      ...(mode && mode !== (existing.mode ?? 'session') ? { mode } : {})
    };
    const changed = Object.keys(patch).length > 0;
    const schedule = changed
      ? await this.updateSchedule(sessionId, existing.id, { expectedRevision: existing.revision, ...patch, enabled: false }, actorId)
      : publicSchedule(existing);
    return { schedule, updated: { changed, wasEnabled: existing.enabled } };
  }

  private async executionSession(schedule: SessionSchedule): Promise<Session> {
    if (schedule.mode !== 'independent' && schedule.mode !== 'fresh') return this.requireSession(schedule.sessionId);
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
      await this.requireAuthorized(schedule.sessionId, schedule.actorId);
      const current = await this.getRecord(scheduleKey(schedule.id), readStoredSessionSchedule);
      if (!current || current.value.executionSessionId !== schedule.executionSessionId || current.value.deletedAt) {
        throw new RuntimeError('INDEPENDENT_SCHEDULE_REVOKED', 'Independent schedule changed before workspace creation', 403);
      }
    });
    this.watchSession(session.id);
    if (fresh) return session;
    if (context.cwd !== session.cwd) {
      const stored = await this.getRecord(scheduleKey(schedule.id), readStoredSessionSchedule);
      if (stored && context.cwd === context.sourceCwd) {
        await this.replace(scheduleKey(schedule.id), stored.raw, sessionScheduleSchema.parse({
          ...stored.value, executionContext: { ...context, cwd: session.cwd }
        }));
      } else if (context.cwd !== session.cwd) {
        throw new RuntimeError('INDEPENDENT_CONTEXT_CHANGED', 'Independent schedule workspace no longer matches its frozen context', 409);
      }
    }
    return session;
  }

  /**
   * 计划仍在用的执行会话，或 fresh 计划之前触发留下、因有未结束任务而未归档的会话。
   * 后者须由某次触发的持久记录证明是这个计划按触发编号建出的；计划删除或会话归档后不再算。
   * 存储层接单与队列管理（scheduleScope）按同一条件判定，两层不能各认各的。
   */
  private async ownsExecutionSession(schedule: SessionSchedule, session: Session) {
    if (schedule.executionSessionId === session.id) return true;
    if (schedule.mode !== 'fresh' || schedule.deletedAt || session.archivedAt) return false;
    const occurrences = await this.listRecords(OCCURRENCE_PREFIX, value => migrateOccurrence(sessionScheduleOccurrenceSchema.parse(value)), undefined, { field: 'scheduleId', values: [schedule.id], sessionId: schedule.sessionId });
    return occurrences.some(({ value }) => value.scheduleId === schedule.id && value.sessionId === schedule.sessionId
      && value.executionSessionId === session.id && freshSessionId(schedule.id, value.id) === session.id);
  }

  /** Map internal schedule execution back to its frozen source authority. */
  async authorizeExecutionSession(sessionId: string, actorId?: string): Promise<boolean> {
    const session = await this.options.runtime.getSession(sessionId);
    if (session?.source !== 'schedule') return false;
    const schedule = session.sourceId ? await this.getRecord(scheduleKey(session.sourceId), readStoredSessionSchedule) : undefined;
    if (!schedule || (schedule.value.mode !== 'independent' && schedule.value.mode !== 'fresh') || schedule.value.actorId !== actorId || !await this.ownsExecutionSession(schedule.value, session)) {
      throw new RuntimeError('INDEPENDENT_SCHEDULE_REVOKED', 'Independent schedule execution authority is unavailable', 403);
    }
    await this.requireAuthorized(schedule.value.sessionId, actorId);
    return true;
  }

  async sourceSessionId(sessionId: string): Promise<string | undefined> {
    const session = await this.options.runtime.getSession(sessionId);
    if (session?.source !== 'schedule' || !session.sourceId) return undefined;
    const record = await this.getRecord(scheduleKey(session.sourceId), readStoredSessionSchedule);
    return record && await this.ownsExecutionSession(record.value, session) ? record.value.sessionId : undefined;
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

  async getScheduleDefinition(sessionId: string, id: string, actorId?: string): Promise<PublicSessionSchedule> {
    await this.requireAuthorized(sessionId, actorId);
    await this.requireSession(sessionId);
    const stored = await this.getRecord(scheduleKey(id), readStoredSessionSchedule);
    if (!stored || stored.value.sessionId !== sessionId) throw new RuntimeError('SESSION_AUTOMATION_SCHEDULE_NOT_FOUND', 'Session schedule not found', 404);
    return publicSchedule(stored.value);
  }

  async getScheduleHistory(sessionId: string, id: string, actorId?: string): Promise<PublicSessionScheduleOccurrence[]> {
    await this.getScheduleDefinition(sessionId, id, actorId);
    const occurrences = await this.listRecords(OCCURRENCE_PREFIX, value => sessionScheduleOccurrenceSchema.parse(value), undefined, { field: 'scheduleId', values: [id], sessionId });
    return occurrences.map(item => item.value).filter(item => item.sessionId === sessionId && item.scheduleId === id)
      .sort((a, b) => b.scheduledForUtc.localeCompare(a.scheduledForUtc) || b.id.localeCompare(a.id)).slice(0, MAX_RECORDS).map(publicOccurrence);
  }

  async listSchedules(query: AutomationScheduleQuery, authorize: (sessionId: string) => Promise<boolean | { actorId?: string }>): Promise<AutomationSchedulePage> {
    const records = await this.listRecords(SCHEDULE_PREFIX, readStoredSessionSchedule);
    const allowed = new Map<string, boolean>();
    const canRead = async (sessionId: string) => {
      sessionId = await this.sourceSessionId(sessionId) ?? sessionId;
      const granted = await authorize(sessionId);
      if (!granted) return false;
      try { await this.requireAuthorized(sessionId, typeof granted === 'object' ? granted.actorId : undefined); return true; }
      catch (error) { if (error instanceof RuntimeError && error.statusCode === 403) return false; throw error; }
    };
    const sessions = new Map<string, Session>();
    for (const { value } of records) {
      if (value.deletedAt || allowed.has(value.sessionId)) continue;
      const granted = await canRead(value.sessionId);
      allowed.set(value.sessionId, Boolean(granted));
      if (granted) {
        const session = await this.options.runtime.getSession(value.sessionId);
        if (session) sessions.set(session.id, session);
      }
    }
    // Decode each history row once, only after the source session is authorized.
    const occurrences = (await this.listRecords(OCCURRENCE_PREFIX, value => sessionScheduleOccurrenceSchema.parse(value), undefined, { field: 'sessionId', values: [...sessions.keys()] }))
      .map(item => item.value).filter(item => sessions.has(item.sessionId));
    const histories = new Map<string, SessionScheduleOccurrence[]>();
    for (const occurrence of occurrences) {
      const group = histories.get(occurrence.scheduleId) ?? [];
      group.push(occurrence); histories.set(occurrence.scheduleId, group);
    }
    const sessionTasks = new Map<string, TaskRecord[]>();
    const counts: AutomationSchedulePage['counts'] = { blocked: 0, queued: 0, running: 0, delivery: 0, disabled: 0, ready: 0, error: 0 };
    const items: AutomationScheduleSummary[] = [];
    for (const { value: schedule } of records) {
      const session = sessions.get(schedule.sessionId);
      if (!session || schedule.deletedAt) continue;
      const history = (histories.get(schedule.id) ?? []).sort((a, b) => b.scheduledForUtc.localeCompare(a.scheduledForUtc) || b.id.localeCompare(a.id));
      const latest = history[0];
      const open = history.find(item => openRunStatuses.has(item.runStatus));
      const executionSessionId = schedule.executionSessionId ?? session.id;
      const taskId = open?.taskId;
      const projection = taskId ? this.execution.getTaskExecution(taskId) : undefined;
      let health: AutomationScheduleSummary['health'] = !schedule.enabled ? 'disabled'
        : open?.runStatus === 'blocked' ? 'blocked'
        : projection?.task.status === 'running' ? 'running'
        : open ? 'queued'
        : latest?.delivery.status === 'pending' || latest?.delivery.status === 'error' ? 'delivery'
        : latest && ['failed', 'interrupted', 'error'].includes(latest.runStatus) ? 'error' : 'ready';
      let blocker: AutomationScheduleSummary['blocker'];
      if (open) {
        if (!sessionTasks.has(executionSessionId)) sessionTasks.set(executionSessionId, await this.options.repositories.tasks.listBySession(executionSessionId));
        const blockingTask = sessionTasks.get(executionSessionId)!.find(item => ['running', 'reconcile_required', 'legacy_unresolved'].includes(item.status));
        const blockedBy = projection?.blockers.find(item => item.taskId && item.taskId !== taskId || item.code.startsWith('WORKSPACE_'));
        const blockingSessionId = blockedBy?.sessionId ?? executionSessionId;
        const actualId = blockedBy?.taskId ?? blockingTask?.id ?? taskId;
        if (actualId) {
          let canView = allowed.get(blockingSessionId);
          if (canView === undefined) { canView = await canRead(blockingSessionId); allowed.set(blockingSessionId, canView); }
          const blocking = canView ? this.execution.getTaskExecution(actualId) : undefined;
          const attempt = blocking?.attempts.find(item => item.state === 'reconcile_required' || item.state === 'legacy_unresolved') ?? blocking?.currentAttempt;
          const status = blockedBy && !['reconcile_required', 'legacy_unresolved'].includes(blocking?.task.status ?? '') ? 'resource_blocked' : blocking?.task.status ?? open.runStatus;
          blocker = { status, waitingSince: open.createdAt,
            ...(canView ? { sessionId: blockingSessionId, taskId: actualId, ...(attempt ? { attemptId: attempt.attemptId } : {}) } : { restricted: true }) };
          if (['reconcile_required', 'legacy_unresolved', 'resource_blocked'].includes(status)) health = 'blocked';
        }
      }
      counts[health]++;
      const summary: AutomationScheduleSummary = {
        engine: 'session', schedule: publicSchedule(schedule),
        session: { id: session.id, title: session.name ?? session.id, agentId: schedule.executionContext?.agentId ?? session.agentId, state: session.state, ...(session.archivedAt ? { archivedAt: session.archivedAt } : {}) },
        health, ...(latest ? { latestOccurrence: publicOccurrence(latest) } : {}), ...(blocker ? { blocker } : {}),
        ...(schedule.enabled && schedule.nextDueAt && schedule.nextDueAt < iso(this.clock()) ? { overdue: { from: schedule.nextDueAt, to: iso(this.clock()) } } : {})
      };
      if (query.name && !schedule.name.toLocaleLowerCase().includes(query.name.toLocaleLowerCase())
        || query.sessionId && schedule.sessionId !== query.sessionId
        || query.agentId && (schedule.executionContext?.agentId ?? session.agentId) !== query.agentId
        || query.enabled !== undefined && schedule.enabled !== query.enabled
        || query.health && health !== query.health) continue;
      items.push(summary);
    }
    const rank = { blocked: 0, error: 1, delivery: 2, queued: 3, running: 4, ready: 5, disabled: 6 };
    items.sort((a, b) => (query.sort === 'name' ? a.schedule.name.localeCompare(b.schedule.name)
      : query.sort === 'due' ? (a.schedule.nextDueAt ?? '~').localeCompare(b.schedule.nextDueAt ?? '~')
      : rank[a.health] - rank[b.health] || (a.schedule.nextDueAt ?? '~').localeCompare(b.schedule.nextDueAt ?? '~'))
      || a.schedule.id.localeCompare(b.schedule.id));
    const offset = query.offset ?? 0, limit = query.limit ?? 20;
    return { engine: 'session', counts, items: items.slice(offset, offset + limit), total: items.length, offset, limit };
  }

  async getScheduleHistoryPage(sessionId: string, id: string, offset: number, limit: number, actorId?: string): Promise<AutomationHistoryPage> {
    await this.getScheduleDefinition(sessionId, id, actorId);
    const records = await this.listRecords(OCCURRENCE_PREFIX, value => sessionScheduleOccurrenceSchema.parse(value), undefined, { field: 'scheduleId', values: [id], sessionId });
    const all = records.map(item => item.value).filter(item => item.sessionId === sessionId && item.scheduleId === id)
      .sort((a, b) => b.scheduledForUtc.localeCompare(a.scheduledForUtc) || b.id.localeCompare(a.id)).map(publicOccurrence);
    return { occurrences: all.slice(offset, offset + limit), total: all.length, offset, limit };
  }

  async getScheduleRun(sessionId: string, scheduleId: string, id: string, actorId?: string): Promise<AutomationRunDetail> {
    const schedule = await this.getScheduleDefinition(sessionId, scheduleId, actorId);
    const stored = await this.getRecord(occurrenceKey(id), value => sessionScheduleOccurrenceSchema.parse(value));
    if (!stored || stored.value.sessionId !== sessionId || stored.value.scheduleId !== scheduleId) {
      throw new RuntimeError('SESSION_AUTOMATION_RUN_NOT_FOUND', 'This schedule run is unavailable', 404);
    }
    const occurrence = migrateOccurrence(stored.value);
    const executionSessionId = occurrence.executionSessionId ?? sessionId;
    const projection = occurrence.taskId ? this.execution.getTaskExecution(occurrence.taskId) : undefined;
    const accepted = occurrence.taskId ? this.execution.getAcceptedTask(occurrence.taskId) : undefined;
    if (projection && projection.task.sessionId !== executionSessionId) throw new RuntimeError('SESSION_AUTOMATION_RUN_NOT_FOUND', 'Run task ownership is unavailable', 404);
    if (accepted && occurrence.admission) assertAdmissionMatchesAccepted('Scheduled task', occurrence.admission, accepted);
    const fixed = projection?.attempts.find(item => item.attemptId === occurrence.result?.attemptId);
    const settledEvent = fixed?.settlementId ? this.execution.getAttemptEvents(fixed.attemptId, {
      afterSequence: (occurrence.result?.throughSequence ?? 1) - 1, limit: 1, direction: 'forward'
    }).find(event => event.type === 'completed' && event.settlementId === fixed.settlementId && event.sequence === occurrence.result?.throughSequence) : undefined;
    const options = accepted?.input?.version === 2 ? accepted.input.executionOptions : undefined;
    return {
      schedule, occurrence: publicOccurrence(occurrence),
      ...(accepted?.request ? { input: { prompt: accepted.request.prompt, ...(schedule.executionContext ? { cwd: schedule.executionContext.cwd, agentId: schedule.executionContext.agentId } : {}),
        ...(options?.model ? { model: options.model } : {}), ...(options?.permissionMode ? { permissionMode: options.permissionMode } : {}) } } : {}),
      attempts: (projection?.attempts ?? []).map(attempt => ({
        attemptId: attempt.attemptId, taskId: attempt.taskId, number: attempt.number, state: attempt.state,
        ...(attempt.outcome ? { outcome: attempt.outcome } : {}), createdAt: attempt.createdAt, updatedAt: attempt.updatedAt,
        ...(attempt.manualRetry ? { manualRetry: { causeAttemptId: attempt.manualRetry.causeAttemptId, decisionId: attempt.manualRetry.decisionId } } : {}),
        ...(attempt.automaticRetry ? { automaticRetry: { causeAttemptId: attempt.automaticRetry.causeAttemptId, reason: attempt.automaticRetry.reason } } : {}),
        ...(attempt.settlement?.kind === 'manual' ? { decision: {
          decisionId: attempt.settlement.decision.decisionId, actor: attempt.settlement.decision.actor,
          action: attempt.settlement.decision.action, evidenceRefs: attempt.settlement.decision.evidenceRefs
        } } : {})
      })), sourceSessionId: sessionId, executionSessionId,
      times: { scheduledForUtc: occurrence.scheduledForUtc, discoveredAt: occurrence.createdAt,
        ...(occurrence.acceptedAt ? { acceptedAt: occurrence.acceptedAt } : {}),
        ...(occurrence.taskStartedAt ? { startedAt: occurrence.taskStartedAt } : {}),
        ...(settledEvent ? { settledAt: settledEvent.timestamp } : {}),
        deliveryUpdatedAt: occurrence.delivery.updatedAt }
    };
  }

  async updateSchedule(sessionId: string, id: string, rawInput: UpdateSessionScheduleInput, actorId?: string): Promise<PublicSessionSchedule> {
    await this.requireAuthorized(sessionId, actorId);
    const session = await this.requireSession(sessionId);
    const input = updateSessionScheduleInputSchema.parse(rawInput);
    const stored = await this.getRecord(scheduleKey(id), readStoredSessionSchedule);
    if (!stored || stored.value.sessionId !== sessionId) throw new RuntimeError('SESSION_AUTOMATION_SCHEDULE_NOT_FOUND', 'Session schedule not found', 404);
    if (stored.value.deletedAt) throw new RuntimeError('SESSION_AUTOMATION_SCHEDULE_DELETED', 'Session schedule was deleted', 409);
    if (stored.value.revision !== input.expectedRevision) throw new RuntimeError('SESSION_AUTOMATION_REVISION_CONFLICT', 'Session schedule revision changed', 409);
    if (input.enabled === true && stored.value.mode !== 'independent' && !isSessionRunnable(session)) throw new RuntimeError('SESSION_NOT_ACTIVE', 'Session is not active', 409);
    if (input.name !== undefined && input.name !== stored.value.name) await this.assertNameAvailable(sessionId, input.name, id);
    const currentMode = stored.value.mode ?? 'session';
    const modeChanged = input.mode !== undefined && input.mode !== currentMode;
    if (modeChanged) {
      if (currentMode === 'independent') throw new RuntimeError('SESSION_AUTOMATION_MODE_IMMUTABLE', 'Independent schedules cannot switch mode; create a new schedule instead', 409);
      if (input.mode === 'fresh' && !this.options.runtime.startScheduleSession) throw new RuntimeError('FRESH_SCHEDULE_UNAVAILABLE', 'Fresh-session schedules are unavailable on this instance', 503);
      // 正在执行的那次仍归属原会话；等它结束再切换，避免它的回执失去归属。
      if (await this.hasPendingOccurrence(stored.value)) throw new RuntimeError('SESSION_AUTOMATION_SCHEDULE_BUSY', 'This schedule already has unfinished work', 409);
    }
    let condition = stored.value.condition;
    if (input.condition) condition = input.condition.kind === 'always' ? input.condition : await this.ciCondition(session, input.condition);
    const now = this.clock();
    const executionChanged = Object.keys(input).some(key => !['name', 'expectedRevision'].includes(key));
    const candidate = {
      ...stored.value,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.dstPolicy !== undefined ? { dstPolicy: input.dstPolicy } : {}),
      condition,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(modeChanged ? { mode: input.mode, executionSessionId: undefined, executionContext: input.mode === 'fresh' ? freshExecutionContext(session) : undefined } : {}),
      revision: stored.value.revision + 1,
      generation: stored.value.generation + (executionChanged ? 1 : 0),
      ...(executionChanged && actorId && stored.value.mode !== 'independent' ? { actorId } : {}),
      ...(input.misfirePolicy !== undefined ? { misfirePolicy: input.misfirePolicy } : {}),
      ...(input.maxLatenessSeconds !== undefined ? { maxLatenessSeconds: input.maxLatenessSeconds ?? undefined } : {}),
      updatedAt: iso(now)
    };
    const schedule = sessionScheduleSchema.parse({
      ...candidate,
      nextDueAt: executionChanged ? candidate.enabled ? previewSessionSchedule(candidate, now)?.scheduledForUtc : undefined : stored.value.nextDueAt
    });
    if (!await this.replace(scheduleKey(id), stored.raw, schedule)) throw new RuntimeError('SESSION_AUTOMATION_REVISION_CONFLICT', 'Session schedule revision changed', 409);
    if (modeChanged) await this.retireFreshSessions(schedule);
    return publicSchedule(schedule);
  }

  async deleteSchedule(sessionId: string, id: string, rawInput: DeleteSessionScheduleInput, actorId?: string): Promise<PublicSessionSchedule> {
    await this.requireAuthorized(sessionId, actorId);
    await this.requireSession(sessionId);
    const input = deleteSessionScheduleInputSchema.parse(rawInput);
    const stored = await this.getRecord(scheduleKey(id), readStoredSessionSchedule);
    if (!stored || stored.value.sessionId !== sessionId) throw new RuntimeError('SESSION_AUTOMATION_SCHEDULE_NOT_FOUND', 'Session schedule not found', 404);
    if (stored.value.revision !== input.expectedRevision) throw new RuntimeError('SESSION_AUTOMATION_REVISION_CONFLICT', 'Session schedule revision changed', 409);
    if (stored.value.deletedAt) return publicSchedule(stored.value);
    const now = iso(this.clock());
    const deleted = readStoredSessionSchedule({ ...stored.value, revision: stored.value.revision + 1, generation: stored.value.generation + 1, enabled: false, nextDueAt: undefined, deletedAt: now, updatedAt: now });
    if (!await this.replace(scheduleKey(id), stored.raw, deleted)) throw new RuntimeError('SESSION_AUTOMATION_REVISION_CONFLICT', 'Session schedule revision changed', 409);
    return publicSchedule(deleted);
  }

  runSchedule(sessionId: string, id: string, rawInput: RunSessionScheduleInput, actorId?: string): Promise<PublicSessionScheduleOccurrence> {
    if (this.closed) return Promise.reject(new RuntimeError('SESSION_AUTOMATION_CLOSED', 'Session automation is shutting down', 503));
    const operation = this.runScheduleOperation(sessionId, id, rawInput, actorId);
    this.manualRuns.add(operation);
    void operation.finally(() => this.manualRuns.delete(operation)).catch(() => {});
    return operation;
  }

  private async runScheduleOperation(sessionId: string, id: string, rawInput: RunSessionScheduleInput, actorId?: string): Promise<PublicSessionScheduleOccurrence> {
    await this.requireAuthorized(sessionId, actorId);
    const session = await this.requireSession(sessionId);
    const input = runSessionScheduleInputSchema.parse(rawInput);
    const stored = await this.getRecord(scheduleKey(id), readStoredSessionSchedule);
    if (!stored || stored.value.sessionId !== sessionId) throw new RuntimeError('SESSION_AUTOMATION_SCHEDULE_NOT_FOUND', 'Session schedule not found', 404);
    const manualId = `occ_${createHash('sha256').update(JSON.stringify([id, 'manual', input.idempotencyKey])).digest('hex')}`;
    const existing = await this.getRecord(occurrenceKey(manualId), value => sessionScheduleOccurrenceSchema.parse(value));
    if (existing) return publicOccurrence(existing.value);
    // Repair a response lost between reservation and occurrence creation, even after a later edit.
    if (stored.value.pendingOccurrence?.id === manualId) {
      return this.runReservedOccurrence(stored.value);
    }
    if (stored.value.deletedAt) throw new RuntimeError('SESSION_AUTOMATION_SCHEDULE_DELETED', 'Session schedule was deleted', 409);
    if (stored.value.revision !== input.expectedRevision) throw new RuntimeError('SESSION_AUTOMATION_REVISION_CONFLICT', 'Session schedule revision changed', 409);
    if (stored.value.mode !== 'independent' && !isSessionRunnable(session)) throw new RuntimeError('SESSION_NOT_ACTIVE', 'Session is not active', 409);
    if (await this.hasPendingOccurrence(stored.value)) throw new RuntimeError('SESSION_AUTOMATION_SCHEDULE_BUSY', 'This schedule already has unfinished work', 409);
    // 专用执行会话的任务只接受计划冻结的 actor（账本按计划核对），手动执行也以它的身份运行。
    const actor = resolveAutomationActor(session, stored.value.mode === 'independent' || stored.value.mode === 'fresh' ? stored.value.actorId : actorId);
    if (!actor) throw new RuntimeError('SESSION_AUTOMATION_FORBIDDEN', 'Schedule actor domain cannot be verified', 403);
    const reserved = sessionScheduleSchema.parse({ ...stored.value, ...this.freshReservation(stored.value, manualId),
      pendingOccurrence: { id: manualId, generation: stored.value.generation, scheduledForUtc: iso(this.clock()), triggerSource: 'manual', actor } });
    if (!await this.replace(scheduleKey(id), stored.raw, reserved)) {
      const latest = await this.getRecord(scheduleKey(id), readStoredSessionSchedule);
      if (latest?.value.pendingOccurrence?.id === manualId) return this.runReservedOccurrence(latest.value);
      throw new RuntimeError('SESSION_AUTOMATION_REVISION_CONFLICT', 'Session schedule changed while reserving execution', 409);
    }
    return this.runReservedOccurrence(reserved);
  }

  private async runReservedOccurrence(schedule: SessionSchedule) {
    const occurrence = await this.materializeOccurrence(schedule);
    if (occurrence.created) await this.processOccurrence(occurrence);
    const latest = await this.getRecord(occurrenceKey(occurrence.value.id), value => sessionScheduleOccurrenceSchema.parse(value));
    return publicOccurrence(latest!.value);
  }

  async subscribeCi(sessionId: string, rawInput: SubscribeCiInput, actorId?: string): Promise<PublicCiSubscription> {
    await this.requireAuthorized(sessionId, actorId);
    const session = await this.requireSession(sessionId);
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

  /** No schedule ID is accepted: only the current occurrence's durable host binding can request this. */
  async requestScheduleStop(sessionId: string, taskId: string, attemptId: string, actorId: string) {
    const revoked = () => new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Only the active scheduled occurrence may stop its own schedule', 403);
    const task = this.execution.getTaskExecution(taskId)?.task;
    const binding = (await this.getRecord(taskBindingKey(taskId), value => taskBindingSchema.parse(value)))?.value;
    if (!task || task.status !== 'running' || task.currentAttemptId !== attemptId || task.sessionId !== sessionId || binding?.kind !== 'schedule' || binding.sessionId !== sessionId) throw revoked();
    const occurrence = (await this.getRecord(occurrenceKey(binding.occurrenceId), value => migrateOccurrence(sessionScheduleOccurrenceSchema.parse(value))))?.value;
    const accepted = this.execution.getAcceptedTask(taskId);
    if (!occurrence || (occurrence.executionSessionId ?? occurrence.sessionId) !== sessionId || occurrence.admission?.taskId !== taskId || occurrence.triggerSource === 'manual' || occurrence.runtimeAttemptId && occurrence.runtimeAttemptId !== attemptId
      || binding.schemaVersion === 2 && (binding.taskId !== taskId || binding.scheduleId !== occurrence.scheduleId || binding.generation !== occurrence.generation)) throw revoked();
    assertAdmissionMatchesAccepted('Scheduled task', occurrence.admission, accepted);
    const originSessionId = occurrence.sessionId;
    const session = await this.requireSession(originSessionId);
    if (acceptedActorId('Scheduled task', accepted, occurrence.admission, occurrence.actor, session) !== actorId) throw revoked();
    await this.requireAuthorized(originSessionId, actorId);
    const schedule = (await this.getRecord(scheduleKey(occurrence.scheduleId), readStoredSessionSchedule))?.value;
    if (!schedule || schedule.sessionId !== originSessionId || !schedule.enabled || schedule.deletedAt || schedule.generation !== occurrence.generation || schedule.trigger.kind === 'at') throw revoked();
    const current = this.execution.getTaskExecution(taskId)?.task;
    if (!current || current.status !== 'running' || current.currentAttemptId !== attemptId || current.sessionId !== sessionId) throw revoked();
    const value = stopRequestSchema.parse({ version: 1, sessionId: originSessionId, taskId, attemptId, occurrenceId: occurrence.id, scheduleId: schedule.id, generation: occurrence.generation, actorId, status: 'pending' });
    const key = `${STOP_REQUEST_PREFIX}${taskId}`;
    if (!await this.createRecord(key, value)) {
      const existing = (await this.getRecord(key, input => stopRequestSchema.parse(input)))?.value;
      if (!existing) throw revoked();
      const { reason: _reason, status: _status, ...scope } = existing;
      const { status: _pending, ...expected } = value;
      if (canonicalExecutionJson(scope) !== canonicalExecutionJson(expected)) throw revoked();
    }
    return { pendingDelivery: true, scheduleId: schedule.id };
  }

  private async applyScheduleStops() {
    for (const stored of await this.listRecords(STOP_REQUEST_PREFIX, value => stopRequestSchema.parse(value))) {
      await this.isolate(async () => {
        const request = stored.value;
        if (request.status !== 'pending') return;
        const key = `${STOP_REQUEST_PREFIX}${request.taskId}`;
        const finish = (status: 'applied' | 'rejected', reason?: string) => this.replace(key, stored.raw, { ...request, status, ...(reason ? { reason } : {}) });
        const schedule = await this.getRecord(scheduleKey(request.scheduleId), readStoredSessionSchedule);
        if (schedule?.value.stopRequestId === request.taskId && !schedule.value.enabled) { await finish('applied'); return; }
        if (!schedule || schedule.value.sessionId !== request.sessionId || schedule.value.generation !== request.generation || schedule.value.deletedAt || !schedule.value.enabled) { await finish('rejected', 'schedule_changed'); return; }
        const occurrence = (await this.getRecord(occurrenceKey(request.occurrenceId), value => migrateOccurrence(sessionScheduleOccurrenceSchema.parse(value))))?.value;
        const task = this.execution.getTaskExecution(request.taskId)?.task;
        if (!occurrence || occurrence.sessionId !== request.sessionId || occurrence.scheduleId !== request.scheduleId || occurrence.generation !== request.generation || occurrence.admission?.taskId !== request.taskId) { await finish('rejected', 'binding_changed'); return; }
        if (['failed', 'interrupted', 'cancelled'].includes(task?.status ?? '') || occurrence.result && occurrence.result.outcome !== 'completed') { await finish('rejected', 'task_not_successful'); return; }
        if (!task || task.status !== 'completed' || task.currentAttemptId !== request.attemptId || occurrence.runtimeAttemptId !== request.attemptId || occurrence.result?.outcome !== 'completed' || occurrence.delivery.status !== 'delivered') return;
        const accepted = this.execution.getAcceptedTask(request.taskId);
        const session = await this.options.runtime.getSession(request.sessionId);
        try {
          assertAdmissionMatchesAccepted('Scheduled task', occurrence.admission, accepted);
          if (acceptedActorId('Scheduled task', accepted, occurrence.admission, occurrence.actor, session) !== request.actorId) throw new Error('actor changed');
          await this.requireAuthorized(request.sessionId, request.actorId);
        }
        catch { await finish('rejected', 'authorization_revoked'); return; }
        const stopped = sessionScheduleSchema.parse({ ...schedule.value, revision: schedule.value.revision + 1, generation: schedule.value.generation + 1,
          enabled: false, nextDueAt: undefined, stopRequestId: request.taskId, updatedAt: iso(this.clock()) });
        if (await this.replace(scheduleKey(request.scheduleId), schedule.raw, stopped)) await finish('applied');
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
        await this.runTick();
      }
    })().finally(() => {
      if (this.currentTick === operation) this.currentTick = undefined;
      // A completion event can land after the loop exits but before this cleanup microtask.
      if (this.tickRequested && !this.closed) return this.tick();
    });
    this.currentTick = operation;
    return operation;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    for (const { controller } of this.deliveries.values()) controller.abort();
    try { if (this.currentTick) await this.currentTick; }
    finally { await Promise.allSettled([...this.manualRuns, ...[...this.deliveries.values()].map(item => item.run)]); }
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
      assertAdmissionMatchesAccepted('Scheduled task', occurrence.admission, accepted);
      const schedule = await this.getRecord(scheduleKey(occurrence.scheduleId), readStoredSessionSchedule);
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
      try { await this.requireAuthorized(schedule.value.sessionId, actorId); }
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
          if (await this.replace(scheduleKey(candidate.value.id), candidate.raw, startedSchedule)) break;
          const latestSchedule = await this.getRecord(scheduleKey(schedule.value.id), readStoredSessionSchedule);
          const latest = latestSchedule?.value;
          if (!latest || latest.generation !== occurrence.generation || latest.deletedAt
            || latest.sessionId !== schedule.value.sessionId || latest.actorId !== schedule.value.actorId
            || latest.executionSessionId !== schedule.value.executionSessionId || latest.mode !== schedule.value.mode
            || canonicalExecutionJson(latest.executionContext ?? null) !== canonicalExecutionJson(schedule.value.executionContext ?? null)
            || !latest.enabled && occurrence.triggerSource !== 'manual' && latest.taskStartOccurrenceId !== occurrence.id
            || !isSessionRunnable(await this.options.runtime.getSession(task.sessionId))) {
            const current = await this.getRecord(occurrenceKey(occurrence.id), value => sessionScheduleOccurrenceSchema.parse(value));
            if (current) await this.finishOccurrence(current, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Schedule changed before submission' });
            throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task changed before submission', 409);
          }
          await this.requireAuthorized(latest.sessionId, actorId);
          if (latest.taskStartOccurrenceId === occurrence.id) break;
          candidate = latestSchedule!;
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
    try { await this.requireAuthorized(task.sessionId, ciActorId); }
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
    this.quarantinedSchedules.clear();
    // Re-read storage at each phase; only reuse decoding for byte-identical rows within this tick.
    const parsed: TickParseCache = { occurrences: new Map(), subscriptions: new Map() };
    await this.refreshAcceptedWork(parsed);
    await this.applyScheduleStops();
    if (this.closed) return;
    const [schedules, occurrences, subscriptions] = await Promise.all([
      this.listRecords(SCHEDULE_PREFIX, readStoredSessionSchedule),
      this.listRecords(OCCURRENCE_PREFIX, value => sessionScheduleOccurrenceSchema.parse(value), parsed.occurrences, { field: 'runStatus', values: ['pending'] }),
      this.listRecords(CI_PREFIX, value => ciSubscriptionSchema.parse(value), parsed.subscriptions, { field: 'status', values: ['waiting', 'dispatching', 'accepted'] })
    ]);
    for (const item of occurrences) {
      if (this.closed) return;
      if (item.value.runStatus === 'pending' && (!item.value.leaseExpiresAt || new Date(item.value.leaseExpiresAt) <= this.clock())) await this.isolate(() => this.claimAndProcessOccurrence(item));
    }
    for (const item of schedules) {
      if (this.closed) return;
      this.watchSession(item.value.sessionId);
      if (item.value.executionSessionId) this.watchSession(item.value.executionSessionId);
      await this.isolate(() => this.synchronizeLifecycle(item));
      await this.isolate(() => this.planSchedule(item.value));
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
    await this.startPendingDeliveries(parsed);
  }

  /** fresh 计划每次占用执行槽时同一次 CAS 换上这次触发的会话编号；槽是独占的，上一次已结束。 */
  private freshReservation(schedule: SessionSchedule, occurrence: string) {
    return schedule.mode === 'fresh' ? { executionSessionId: freshSessionId(schedule.id, occurrence) } : {};
  }

  /**
   * 归档本计划不再使用的 fresh 会话（只读保留历史），保留当前执行会话。
   * 会话里还有排队、执行中或未结算的任务（例如用户在里面追加的对话）时不归档，等下一次触发或恢复时再试；失败只告警。
   */
  private async retireFreshSessions(schedule: SessionSchedule) {
    if (!this.options.runtime.archive) return;
    const keep = schedule.mode === 'fresh' ? schedule.executionSessionId : undefined;
    const sessions = (await this.options.repositories.sessions.list())
      .filter(item => item.source === 'schedule' && item.sourceId === schedule.id && !item.archivedAt && item.id !== keep);
    for (const session of sessions) {
      const tasks = await this.options.repositories.tasks.listBySession(session.id);
      if (tasks.some(task => !settledTaskStatuses.has(task.status) || this.execution.getTaskExecution(task.id)?.attempts.some(attempt => attempt.state !== 'settled'))) continue;
      this.subscriptions.get(session.id)?.();
      this.subscriptions.delete(session.id);
      try { await this.options.runtime.archive(session.id); }
      catch (error) { console.warn('SESSION_AUTOMATION_FRESH_ARCHIVE_FAILED', error instanceof RuntimeError ? error.code : 'UNEXPECTED_ERROR'); }
    }
  }

  /** 同一会话里未删除的计划按名称唯一；停用的也算，避免同名计划并存。 */
  private async sameNameSchedules(sessionId: string, name: string, exceptId?: string) {
    const records = await this.listRecords(SCHEDULE_PREFIX, readStoredSessionSchedule, undefined, { field: 'sessionId', values: [sessionId] });
    return records.map(item => item.value).filter(item => item.sessionId === sessionId && !item.deletedAt && item.name === name.trim() && item.id !== exceptId);
  }

  private async assertNameAvailable(sessionId: string, name: string, exceptId?: string) {
    const [existing] = await this.sameNameSchedules(sessionId, name, exceptId);
    if (existing) throw new RuntimeError('SESSION_AUTOMATION_SCHEDULE_NAME_CONFLICT', `This session already has a schedule named "${existing.name}" (${existing.id}); update that schedule instead`, 409);
  }

  private async hasPendingOccurrence(schedule: SessionSchedule) {
    if (this.quarantinedSchedules.has(schedule.id)) return true;
    if (schedule.pendingOccurrence) {
      const stored = await this.getRecord(occurrenceKey(schedule.pendingOccurrence.id), value => sessionScheduleOccurrenceSchema.parse(value));
      if (!stored || openRunStatuses.has(stored.value.runStatus)) return true;
    }
    // Legacy sources have no reservation, and blocked/unknown work must continue to hold the slot.
    return (await this.listRecords(OCCURRENCE_PREFIX, value => sessionScheduleOccurrenceSchema.parse(value), undefined, { field: 'runStatus', values: [...openRunStatuses], scheduleId: schedule.id }))
      .some(item => item.value.scheduleId === schedule.id && openRunStatuses.has(item.value.runStatus));
  }

  private async materializeOccurrence(schedule: SessionSchedule) {
    const reservation = schedule.pendingOccurrence!;
    const existing = await this.getRecord(occurrenceKey(reservation.id), value => sessionScheduleOccurrenceSchema.parse(value));
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
    if (await this.createRecord(occurrenceKey(occurrence.id), occurrence)) return { raw: JSON.stringify(occurrence), value: occurrence, created: true };
    return { ...(await this.getRecord(occurrenceKey(occurrence.id), value => sessionScheduleOccurrenceSchema.parse(value)))!, created: false };
  }

  private async planSchedule(snapshot: SessionSchedule) {
    const stored = await this.getRecord(scheduleKey(snapshot.id), readStoredSessionSchedule);
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
      if (nextDueAt) await this.replace(scheduleKey(schedule.id), stored.raw, sessionScheduleSchema.parse({ ...schedule, nextDueAt }));
      return;
    }
    if (!schedule.nextDueAt || new Date(schedule.nextDueAt) > this.clock() || await this.hasPendingOccurrence(schedule)) return;
    const id = occurrenceId(schedule, schedule.nextDueAt);
    const already = await this.getRecord(occurrenceKey(id), value => sessionScheduleOccurrenceSchema.parse(value));
    if (already) {
      if (!openRunStatuses.has(already.value.runStatus)) await this.advanceSchedule(schedule, schedule.nextDueAt);
      return;
    }
    const lateBy = this.clock().getTime() - new Date(schedule.nextDueAt).getTime();
    const skip = schedule.misfirePolicy === 'skip' && lateBy > DEFAULT_POLL_MS
      || schedule.maxLatenessSeconds !== undefined && lateBy > schedule.maxLatenessSeconds * 1_000;
    const misfire = skip || lateBy > DEFAULT_POLL_MS ? {
      policy: schedule.misfirePolicy ?? 'coalesce',
      from: schedule.nextDueAt, to: iso(this.clock()),
      reason: skip ? schedule.maxLatenessSeconds !== undefined && lateBy > schedule.maxLatenessSeconds * 1000 ? 'lateness_window_expired' : 'missed_time_skipped' : 'missed_times_coalesced'
    } : undefined;
    schedule = sessionScheduleSchema.parse({ ...schedule, ...this.freshReservation(schedule, id), pendingOccurrence: {
      id, generation: schedule.generation, scheduledForUtc: schedule.nextDueAt,
      misfireDecision: { action: skip ? 'skip' : 'run', ...(misfire ? { misfire } : {}) }
    } });
    if (!await this.replace(scheduleKey(schedule.id), stored.raw, schedule)) return;
    const occurrence = await this.materializeOccurrence(schedule);
    if (occurrence.created && occurrence.value.runStatus === 'pending') await this.processOccurrence(occurrence);
    if (!openRunStatuses.has(occurrence.value.runStatus)) await this.advanceSchedule(schedule, schedule.nextDueAt!);
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
    const scheduleStored = await this.getRecord(scheduleKey(occurrence.scheduleId), readStoredSessionSchedule);
    if (!scheduleStored || !scheduleTriggerSchema.safeParse(scheduleStored.value.trigger).success || scheduleStored.value.generation !== occurrence.generation || scheduleStored.value.deletedAt || !scheduleStored.value.enabled && occurrence.triggerSource !== 'manual'
      || scheduleStored.value.mode === 'fresh' && occurrence.executionSessionId !== scheduleStored.value.executionSessionId) {
      await this.finishOccurrence({ raw: stored.raw, value: occurrence }, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Schedule generation changed before dispatch' });
      return;
    }
    let schedule = scheduleStored.value;
    const origin = await this.options.runtime.getSession(schedule.sessionId);
    let sessionMaybe: Session | undefined;
    try { sessionMaybe = schedule.mode === 'independent' || schedule.mode === 'fresh' ? await this.executionSession(schedule) : origin; }
    catch (error) {
      await this.disableSchedule(scheduleStored, errorMessage(error));
      const accepted = occurrence.admission && this.execution.getAcceptedTask(occurrence.admission.taskId);
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
    try { await this.requireAuthorized(schedule.sessionId, actorId); }
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
      const currentSchedule = await this.getRecord(scheduleKey(schedule.id), readStoredSessionSchedule);
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
      if (!await this.replace(occurrenceKey(occurrence.id), working.raw, evaluated)) return;
      working = { raw: JSON.stringify(evaluated), value: evaluated };
    }
    const persistedCondition = schedule.condition;
    if (persistedCondition.kind === 'ci_new_failure' && working.value.conditionObservedRunIds) {
      const observedRunIds = [...new Set([...persistedCondition.observedRunIds, ...working.value.conditionObservedRunIds])].sort((a, b) => a - b).slice(-100);
      const attempts = new Map(persistedCondition.observedRunAttempts?.map(run => [run.id, run.attempt]));
      for (const run of working.value.conditionObservedRunAttempts ?? []) attempts.set(run.id, Math.max(attempts.get(run.id) ?? 0, run.attempt));
      const observedRunAttempts = observedRunIds.filter(id => attempts.has(id)).map(id => ({ id, attempt: attempts.get(id)! }));
      const latestSchedule = await this.getRecord(scheduleKey(schedule.id), readStoredSessionSchedule);
      if (!latestSchedule || latestSchedule.value.generation !== occurrence.generation) return;
      const updated = sessionScheduleSchema.parse({ ...latestSchedule.value, condition: { ...persistedCondition, observedRunIds, observedRunAttempts } });
      if (!await this.replace(scheduleKey(schedule.id), latestSchedule.raw, updated)) {
        await this.finishOccurrence(working, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Schedule changed while its condition was evaluated' });
        return;
      }
      schedule = updated;
    }
    try { await this.requireAuthorized(schedule.sessionId, actorId); }
    catch (error) {
      const currentSchedule = await this.getRecord(scheduleKey(schedule.id), readStoredSessionSchedule);
      if (currentSchedule?.value.generation === schedule.generation) await this.disableSchedule(currentSchedule);
      await this.finishOccurrence(working, { conditionStatus: 'error', runStatus: 'error', error: errorMessage(error) });
      return;
    }
    if (conditionStatus !== 'passed') {
      await this.finishOccurrence(working, { conditionStatus, runStatus: conditionStatus === 'skipped' ? 'skipped' : conditionStatus === 'invalidated' ? 'invalidated' : 'error', ...(conditionError ? { error: conditionError } : {}), admission: undefined });
      if (occurrence.triggerSource !== 'manual') await this.advanceSchedule(schedule, occurrence.scheduledForUtc);
      return;
    }

    const accepted = sessionScheduleOccurrenceV2Schema.parse({ ...working.value, revision: working.value.revision + 1, conditionStatus: 'passed', updatedAt: iso(this.clock()) });
    if (!await this.replace(occurrenceKey(occurrence.id), working.raw, accepted)) return;
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
        if (occurrence.triggerSource !== 'manual') await this.advanceSchedule(schedule, occurrence.scheduledForUtc);
        return;
      }
      const admission = admissionFor(candidateRequest, existingAccepted, canonicalTaskId('schedule', session.id, candidateRequest.key));
      taskId = admission.taskId;
      taskIdVersion = admission.taskIdVersion;
      request = existingAccepted?.request ?? candidateRequest;
      const withAdmission = sessionScheduleOccurrenceV2Schema.parse({
        ...accepted,
        revision: accepted.revision + 1,
        admission,
        actor,
        ...(existingAccepted ? { taskId } : {}),
        updatedAt: iso(this.clock())
      });
      if (!await this.replace(occurrenceKey(occurrence.id), JSON.stringify(accepted), withAdmission)) return;
      occurrenceWithAdmission = { raw: JSON.stringify(withAdmission), value: withAdmission };
    }
    await this.dispatchOccurrence(occurrenceWithAdmission, request, taskId, taskIdVersion);
    if (occurrence.triggerSource !== 'manual') await this.advanceSchedule(schedule, occurrence.scheduledForUtc);
  }

  private async dispatchOccurrence(
    stored: { raw: string; value: SessionScheduleOccurrenceV2 },
    request: TaskRequestV1,
    taskId: string,
    taskIdVersion: 'v1' | 'legacy'
  ) {
    const occurrence = stored.value;
    // 重投先查接受事实，命中只补同一映射，不再读 HEAD/材料、不重拼 prompt。
    const acceptedBefore = this.execution.getAcceptedTask(taskId);
    if (acceptedBefore?.request && canonicalRequestDigest(acceptedBefore.request) !== canonicalRequestDigest(request)) {
      await this.finishOccurrence(stored, { runStatus: 'blocked', blockReason: 'admission_conflict', error: 'The task key already belongs to a different accepted request' });
      return;
    }
    await this.ensureTaskBinding(taskId, {
      schemaVersion: 2,
      kind: 'schedule',
      sessionId: request.sessionId,
      occurrenceId: occurrence.id,
      scheduleId: occurrence.scheduleId,
      taskId,
      taskIdVersion,
      generation: occurrence.generation
    });
    if (acceptedBefore) {
      await this.markOccurrenceAccepted(stored, taskId);
      return;
    }
    try {
      const task = await this.options.runtime.dispatchRequest(request);
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
    const updated = sessionScheduleOccurrenceV2Schema.parse({ ...currentValue, revision: currentValue.revision + 1, runStatus: 'accepted', taskId, acceptedAt: currentValue.acceptedAt ?? iso(this.clock()), leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: iso(this.clock()) });
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
    const current = await this.getRecord(scheduleKey(schedule.id), readStoredSessionSchedule);
    if (!current || current.value.generation !== schedule.generation || current.value.nextDueAt !== due) return;
    const upcoming = previewSessionSchedule(current.value, this.clock())?.scheduledForUtc;
    const updated = sessionScheduleSchema.parse({ ...current.value, enabled: current.value.enabled, nextDueAt: upcoming, updatedAt: current.value.updatedAt });
    await this.replace(scheduleKey(schedule.id), current.raw, updated);
  }

  private async synchronizeLifecycle(snapshot: { raw: string; value: SessionSchedule }) {
    let stored = await this.getRecord(scheduleKey(snapshot.value.id), readStoredSessionSchedule);
    if (!stored) return;
    if (stored.value.mode !== 'independent' && stored.value.enabled
      && !isSessionRunnable(await this.options.runtime.getSession(stored.value.sessionId))) {
      await this.disableSchedule(stored, 'Session is no longer active');
      stored = await this.getRecord(scheduleKey(snapshot.value.id), readStoredSessionSchedule);
    }
    if (!stored?.value.disableNotification || !this.options.onScheduleDisabled) return;
    const notice = stored.value.disableNotification;
    if (notice.status === 'delivered' || notice.status === 'not_requested') return;
    if ((stored.value.enabled || stored.value.deletedAt) && ['pending', 'error'].includes(notice.status)) {
      await this.replace(scheduleKey(stored.value.id), stored.raw, sessionScheduleSchema.parse({
        ...stored.value, disableNotification: { ...notice, status: 'not_requested', updatedAt: iso(this.clock()) }
      }));
      return;
    }
    if (notice.status === 'sending' || notice.status === 'unknown') {
      const confirmed = await this.options.reconcileDisabledNotification?.(stored.value).catch(() => false);
      if (confirmed || notice.status === 'sending' && notice.owner !== this.ownerId) {
        await this.replace(scheduleKey(stored.value.id), stored.raw, sessionScheduleSchema.parse({
          ...stored.value, disableNotification: { ...notice, status: confirmed ? 'delivered' : 'unknown', owner: undefined, updatedAt: iso(this.clock()) }
        }));
      }
      return;
    }
    if (notice.attempts >= 3 || notice.nextAttemptAt && notice.nextAttemptAt > iso(this.clock())) return;
    let sent = false;
    const beforeSend = async () => {
      if (this.closed) throw new RuntimeError('SESSION_AUTOMATION_CLOSED', 'Automation is closed', 503);
      const current = await this.getRecord(scheduleKey(stored!.value.id), readStoredSessionSchedule);
      if (!current || current.value.disabledAt !== stored!.value.disabledAt) throw new RuntimeError('DISABLE_NOTICE_STALE', 'Disable notice changed', 409);
      if (sent) {
        if (current.value.disableNotification?.owner !== this.ownerId || current.value.disableNotification.status !== 'sending') throw new RuntimeError('DISABLE_NOTICE_STALE', 'Disable notice ownership changed', 409);
        return;
      }
      if (current.value.disableNotification?.status !== notice.status || current.value.disableNotification.attempts !== notice.attempts) throw new RuntimeError('DISABLE_NOTICE_STALE', 'Disable notice ownership changed', 409);
      const next = sessionScheduleSchema.parse({ ...current.value, disableNotification: {
        ...notice, status: 'sending', attempts: notice.attempts + 1, owner: this.ownerId, updatedAt: iso(this.clock())
      } });
      if (!await this.replace(scheduleKey(next.id), current.raw, next)) throw new RuntimeError('DISABLE_NOTICE_STALE', 'Disable notice ownership changed', 409);
      sent = true;
    };
    let failed = false;
    let notRequested = false;
    try { notRequested = await this.options.onScheduleDisabled(stored.value, stored.value.disabledReason ?? 'Session is no longer active', beforeSend) === 'not_requested'; }
    catch { failed = true; }
    const current = await this.getRecord(scheduleKey(stored.value.id), readStoredSessionSchedule);
    if (!current || current.value.disabledAt !== stored.value.disabledAt) return;
    if (sent && current.value.disableNotification?.owner !== this.ownerId) return;
    if (!sent && current.raw !== stored.raw) return;
    const attempts = notice.attempts + 1;
    await this.replace(scheduleKey(current.value.id), current.raw, sessionScheduleSchema.parse({
      ...current.value, disableNotification: {
        ...notice, status: failed ? sent ? 'unknown' : 'error' : notRequested ? 'not_requested' : 'delivered', owner: undefined, attempts, updatedAt: iso(this.clock()),
        ...(failed && !sent ? { nextAttemptAt: plus(this.clock(), 60_000 * attempts), error: 'Notification failed before submission' } : {}),
        ...(failed && sent ? { error: 'Notification submission has no confirmed receipt' } : {})
      }
    }));
  }

  private async disableSchedule(stored: { raw: string; value: SessionSchedule }, reason = 'Schedule authorization is no longer available'): Promise<boolean> {
    if (!stored.value.enabled) return false;
    const disabled = sessionScheduleSchema.parse({
      ...stored.value,
      revision: stored.value.revision + 1,
      generation: stored.value.generation + 1,
      enabled: false,
      nextDueAt: undefined,
      disabledReason: reason,
      disabledAt: iso(this.clock()),
      ...(this.options.onScheduleDisabled ? { disableNotification: { status: 'pending', attempts: 0, name: stored.value.name, updatedAt: iso(this.clock()) } } : {}),
      updatedAt: iso(this.clock())
    });
    return await this.replace(scheduleKey(stored.value.id), stored.raw, disabled);
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
    const current = await this.getRecord(ciKey(current0.id), value => ciSubscriptionSchema.parse(value));
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
    try { await this.requireAuthorized(currentValue.sessionId, currentValue.actorId); }
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
      const admission = admissionFor(candidateRequest, existingAccepted, canonicalTaskId('automation', record.sessionId, candidateRequest.key));
      taskId = admission.taskId;
      taskIdVersion = admission.taskIdVersion;
      request = existingAccepted?.request ?? candidateRequest;
      const withAdmission = ciSubscriptionV2Schema.parse({
        ...record,
        schemaVersion: 2,
        revision: record.revision + 1,
        admission,
        actor,
        ...(existingAccepted ? { taskId } : {}),
        updatedAt: iso(this.clock())
      });
      const raw = dispatching.raw ?? JSON.stringify(record);
      if (!await this.replace(ciKey(record.id), raw, withAdmission)) return;
      record = withAdmission;
    }

    const stored: { raw: string; value: CiSubscriptionV2 } = { raw: JSON.stringify(record), value: record };
    // 重投先查接受事实，命中只补同一映射，不再读 HEAD/材料、不重拼 prompt。
    const acceptedBefore = this.execution.getAcceptedTask(taskId);
    if (acceptedBefore?.request && canonicalRequestDigest(acceptedBefore.request) !== canonicalRequestDigest(request)) {
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
    if (acceptedBefore) {
      await this.markCiAccepted(record.id, taskId);
      return;
    }
    try {
      const task = await this.options.runtime.dispatchRequest(request);
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

  private async refreshAcceptedWork(parsed: TickParseCache) {
    const [occurrences, subscriptions, records] = await Promise.all([
      this.listRecords(OCCURRENCE_PREFIX, value => sessionScheduleOccurrenceSchema.parse(value), parsed.occurrences),
      this.listRecords(CI_PREFIX, value => ciSubscriptionSchema.parse(value), parsed.subscriptions),
      this.listRecords(SCHEDULE_PREFIX, readStoredSessionSchedule)
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
      const accepted = this.execution.getAcceptedTask(value.taskId);
      if (!accepted) return undefined;
      if (accepted.task.sessionId !== (value.executionSessionId ?? value.sessionId)) {
        const blocked = sessionScheduleOccurrenceV2Schema.parse({ ...value, schemaVersion: 2, revision: value.revision + 1, runStatus: 'blocked', blockReason: 'admission_conflict', error: 'Accepted task belongs to another session', delivery: { status: 'not_requested', attempts: value.delivery.attempts, updatedAt: iso(this.clock()) }, updatedAt: iso(this.clock()) });
        await this.replace(occurrenceKey(value.id), item.raw, blocked);
        return { raw: JSON.stringify(blocked), value: blocked };
      }
      const admission = legacyAdmission(accepted, value.taskId);
      const fixed = sessionScheduleOccurrenceV2Schema.parse({ ...value, schemaVersion: 2, revision: value.revision + 1, admission, updatedAt: iso(this.clock()) });
      if (!(await this.replace(occurrenceKey(value.id), item.raw, fixed))) return undefined;
      return { raw: JSON.stringify(fixed), value: fixed };
    }
    // 若 V1 来源没有 taskId（接受响应丢失或旧版未记），通过 lookupAccepted 查找已存在的接受事实
    const scheduleStored = schedules.get(value.scheduleId);
    if (scheduleStored) {
      const session = await this.options.runtime.getSession(value.sessionId);
      const actor = resolveAutomationActor(session, scheduleStored.value.actorId);
      if (session && actor) {
        const candidateRequest = this.buildRequest(session, 'schedule', scheduleRequestKey(value.id), scheduleStored.value.prompt, actor);
        let accepted;
        try { accepted = this.execution.lookupAccepted(candidateRequest); } catch { /* conflict */ }
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
      const admission = legacyAdmission(accepted, value.taskId);
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
        if (await this.replace(ciKey(value.id), item.raw, fixed)) {
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
    if (['pending', 'error'].includes(fixed.value.runStatus) && !this.execution.getAcceptedTask(fixed.value.admission.taskId)) return;
    let working = fixed;
    let value = working.value;

    // 双 KV 中断恢复：来源已固定 admission 且接受事实存在，但第二授权 KV 丢失时，幂等补回同一 binding。
    const fixedAdmission = fixed.value.admission;
    if (this.execution.getAcceptedTask(fixedAdmission.taskId)) {
      try {
        await this.ensureTaskBinding(fixedAdmission.taskId, {
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
      const projection = this.execution.getTaskExecution(value.admission!.taskId);
      const first = projection?.attempts.find(attempt => attempt.number === 1);
      if (first) {
        const fixedAttempt = sessionScheduleOccurrenceV2Schema.parse({ ...value, revision: value.revision + 1, runtimeAttemptId: first.attemptId, updatedAt: iso(this.clock()) });
        if (await this.replace(occurrenceKey(value.id), working.raw, fixedAttempt)) working = { raw: JSON.stringify(fixedAttempt), value: fixedAttempt };
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
          delivery: { status: 'not_requested', attempts: working.value.delivery.attempts, updatedAt: iso(this.clock()) }
        });
      }
      return;
    }
    const result = outcome.result!;
    // 原首 Attempt 补齐边界不能解除历史 legacy 阻塞，只有已验证的自动后继结果可以恢复。
    if (recoverLegacyCapacity && result.attemptId === value.runtimeAttemptId) return;
    const settlingNow = working.value.runStatus === 'accepted' || working.value.runStatus === 'pending' || working.value.runStatus === 'blocked';
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
        ...(recoverLegacyCapacity && working.value.delivery.status === 'not_requested' && this.options.deliver
          ? { delivery: { status: 'pending', attempts: working.value.delivery.attempts, updatedAt: iso(this.clock()) } } : {}),
        ...(result.outcome === 'cancelled' ? { delivery: { status: 'not_requested', attempts: working.value.delivery.attempts, updatedAt: iso(this.clock()) } } : {}),
        updatedAt: iso(this.clock())
      });
      if (!await this.replace(occurrenceKey(value.id), working.raw, settled)) return;
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

    const recoverLegacyCapacity = value.status === 'blocked' && value.blockReason === 'legacy_output_unresolved' && Boolean(value.runtimeAttemptId);
    if (value.status === 'blocked') {
      if (!value.runtimeAttemptId || value.blockReason !== 'reconcile_required' && !recoverLegacyCapacity) return;
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
        ...(result.outcome === 'cancelled' ? { delivery: { status: 'not_requested', attempts: working.value.delivery.attempts, updatedAt: iso(this.clock()) } } : {}),
        updatedAt: iso(this.clock())
      });
      if (!await this.replace(ciKey(value.id), working.raw, completed)) return;
    } else if (!working.value.result) {
      if (['waiting', 'dispatching', 'error'].includes(working.value.status)) {
        await this.finishCi(working, 'blocked', 'Historical terminal CI continuation has no verifiable result');
      }
      return;
    }
  }

  private async readDelivery(key: string) {
    return key.startsWith(OCCURRENCE_PREFIX)
      ? this.getRecord(key, input => migrateOccurrence(sessionScheduleOccurrenceSchema.parse(input)))
      : this.getRecord(key, input => migrateCi(ciSubscriptionSchema.parse(input)));
  }

  private deliverable(value: DeliveryRecord): boolean {
    return ['pending', 'error'].includes(value.delivery.status) && Boolean(value.result && value.admission && value.runtimeAttemptId)
      && ('runStatus' in value ? ['completed', 'failed', 'interrupted'].includes(value.runStatus) : value.status === 'completed');
  }

  private ownsDelivery(current: DeliveryRecord, expected: DeliveryRecord): boolean {
    return this.deliverable(current) && current.leaseOwner === expected.leaseOwner
      && Boolean(current.leaseExpiresAt && new Date(current.leaseExpiresAt) > this.clock())
      && current.sessionId === expected.sessionId && sameResult(current.result, expected.result)
      && canonicalExecutionJson(current.admission ?? null) === canonicalExecutionJson(expected.admission ?? null)
      && canonicalExecutionJson(current.actor ?? null) === canonicalExecutionJson(expected.actor ?? null)
      && (!('scheduleId' in expected) || 'scheduleId' in current && current.scheduleId === expected.scheduleId && current.generation === expected.generation);
  }

  private async startPendingDeliveries(parsed: TickParseCache) {
    if (this.closed || !this.options.deliver || this.deliveries.size >= MAX_DELIVERIES) return;
    const [occurrences, subscriptions] = await Promise.all([
      this.listRecords(OCCURRENCE_PREFIX, input => sessionScheduleOccurrenceSchema.parse(input), parsed.occurrences, { field: 'delivery.status', values: ['pending', 'error'] }),
      this.listRecords(CI_PREFIX, input => ciSubscriptionSchema.parse(input), parsed.subscriptions, { field: 'delivery.status', values: ['pending', 'error'] })
    ]);
    const candidates = [
      ...occurrences.map(item => ({ key: occurrenceKey(item.value.id), raw: item.raw, value: migrateOccurrence(item.value) })),
      ...subscriptions.map(item => ({ key: ciKey(item.value.id), raw: item.raw, value: migrateCi(item.value) }))
    ].filter(item => this.deliverable(item.value)).sort((a, b) => a.key.localeCompare(b.key));
    const start = candidates.findIndex(item => item.key > (this.lastDeliveryKey ?? ''));
    for (const candidate of [...candidates.slice(start < 0 ? 0 : start), ...candidates.slice(0, start < 0 ? 0 : start)]) {
      if (this.closed || this.deliveries.size >= MAX_DELIVERIES) break;
      this.lastDeliveryKey = candidate.key;
      if (this.deliveries.has(candidate.key)) continue;
      const stored = await this.readDelivery(candidate.key);
      if (!stored || !this.deliverable(stored.value) || stored.value.leaseExpiresAt && new Date(stored.value.leaseExpiresAt) > this.clock()) continue;
      const claimed = { ...stored.value, revision: stored.value.revision + 1,
        leaseOwner: `automation_delivery_${randomUUID()}`, leaseExpiresAt: plus(this.clock(), CLAIM_TTL_MS), updatedAt: iso(this.clock()) };
      if (this.closed || !await this.replace(candidate.key, stored.raw, claimed)) continue;
      const controller = new AbortController();
      // Reserve before any outbound continuation; the same source cannot reenter on the next tick.
      const run = Promise.resolve().then(() => this.runDelivery(candidate.key, claimed, controller))
        .catch(() => { /* A storage failure leaves the durable lease to expire and retry. */ })
        .finally(() => { this.deliveries.delete(candidate.key); });
      this.deliveries.set(candidate.key, { controller, run });
      if (this.closed) controller.abort();
    }
  }

  private async runDelivery(key: string, claimed: DeliveryRecord, controller: AbortController) {
    const stale = () => new RuntimeError('SESSION_AUTOMATION_DELIVERY_STALE', 'Automatic result delivery no longer owns its source lease', 409);
    const context: AutomationDeliveryContext = {
      signal: controller.signal,
      assertCurrent: async () => {
        controller.signal.throwIfAborted();
        const current = await this.readDelivery(key);
        if (!current || !this.ownsDelivery(current.value, claimed)) throw stale();
        controller.signal.throwIfAborted();
      }
    };
    let renewing: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (renewing || controller.signal.aborted) return;
      renewing = (async () => {
        const current = await this.readDelivery(key);
        if (!current || !this.ownsDelivery(current.value, claimed)) throw stale();
        const renewed = { ...current.value, revision: current.value.revision + 1, leaseExpiresAt: plus(this.clock(), CLAIM_TTL_MS), updatedAt: iso(this.clock()) };
        if (!await this.replace(key, current.raw, renewed)) throw stale();
      })().catch(error => { controller.abort(error); }).finally(() => { renewing = undefined; });
    }, CLAIM_TTL_MS / 3);
    heartbeat.unref();
    let deliveryError: string | undefined;
    try {
      await context.assertCurrent();
      await this.options.deliver!(claimed.sessionId, claimed.result!, claimed.id, 'scheduleId' in claimed ? claimed.scheduleId : claimed.id, context);
      await context.assertCurrent();
    } catch (cause) { deliveryError = errorMessage(cause); }
    finally { clearInterval(heartbeat); await renewing; }
    const current = await this.readDelivery(key);
    if (!current || !this.ownsDelivery(current.value, claimed)) return;
    const updated = { ...current.value, revision: current.value.revision + 1,
      delivery: { status: deliveryError ? 'error' as const : 'delivered' as const, attempts: current.value.delivery.attempts + 1,
        ...(deliveryError ? { error: deliveryError } : {}), updatedAt: iso(this.clock()) },
      leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: iso(this.clock()) };
    if (await this.replace(key, current.raw, updated)) await this.applyScheduleStops();
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
