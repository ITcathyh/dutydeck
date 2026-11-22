import type { AutomationScheduler } from './scheduler.js';
import { z } from 'zod';
import {
  canonicalExecutionJson,
  ciSubscriptionSchema,
  ciSubscriptionV2Schema,
  createSessionScheduleInputSchema,
  deleteSessionScheduleInputSchema,
  isTerminalTaskStatus,
  LEGACY_GITHUB_PROVIDER_ID,
  parseLarkSourceId,
  previewSessionSchedule,
  readStoredSessionSchedule,
  RuntimeError,
  sessionScheduleOccurrenceSchema,
  sessionScheduleOccurrenceV2Schema,
  sessionScheduleSchema,
  updateSessionScheduleInputSchema,
  type AcceptedTask,
  type AgentEvent,
  type AttemptResultV1,
  type AutomationHistoryPage,
  type AutomationRunDetail,
  type AutomationSchedulePage,
  type AutomationScheduleQuery,
  type AutomationScheduleSummary,
  type CiSubscription,
  type CiSubscriptionV2,
  type ConfigRepository,
  type CreateSessionScheduleInput,
  type DeleteSessionScheduleInput,
  type ExecutionActor,
  type PolicyDecision,
  type PublicCiSubscription,
  type PublicSessionSchedule,
  type PublicSessionScheduleOccurrence,
  type RepositoryBundle,
  type ScheduleRunState,
  type Session,
  type SessionAutomationList,
  type SessionSchedule,
  type SessionScheduleOccurrence,
  type SessionScheduleOccurrenceV2,
  type StartSessionInput,
  type TaskAdmissionV1,
  type TaskRecord,
  type TaskRequestV1,
  type UpdateSessionScheduleInput
} from '@dutydeck/shared';
import type { CiProviderRegistry } from '../ci-providers.js';
import type { CiWebhookService } from '../ci-webhook.js';
import type { PullRequestService } from '../pull-requests.js';
import { createHash, randomUUID } from 'node:crypto';
import { executionTaskId } from '@dutydeck/storage/helpers';
import { MattersService } from '../matters.js';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

export const SCHEDULE_PREFIX = 'session_automation/schedule/';
export const OCCURRENCE_PREFIX = 'session_automation/occurrence/';
export const CI_PREFIX = 'session_automation/ci/';
const TASK_BINDING_PREFIX = 'session_automation/task/';

/**
 * 计划连续没做成的记录：成功一次清零；同一原因（触发出错按错误码，Agent 收尾按「受阻」「等你决定」，执行失败算一类）
 * 第 2 次起不再发新消息，改上一条为「已连续 N 次」；连续 STREAK_PAUSE 次自动停用。
 */
const STREAK_PREFIX = 'session_automation/streak/';
export const streakSchema = z.object({
  version: z.literal(1), occurrenceId: z.string().min(1).optional(), count: z.number().int().nonnegative(),
  /** 最近一次触发出错（开会话或派发失败）的错误码；运行记录里的错误原文不变。 */
  triggerError: z.object({ occurrenceId: z.string().min(1), code: z.string().min(1) }).strict().optional(),
  reasonKey: z.string().optional(), reason: z.string().optional(), messageId: z.string().optional(),
  notice: z.object({ occurrenceId: z.string().min(1), status: z.enum(['pending', 'error', 'sent']), attempts: z.number().int().nonnegative(),
    nextAttemptAt: z.string().optional(), updatedAt: z.string() }).strict().optional(),
  updatedAt: z.string()
}).strict();
export type RunStreak = z.infer<typeof streakSchema>;

export const NOTICE_MAX_ATTEMPTS = 3;

const MAX_RECORDS = 1_000;
export const CLAIM_TTL_MS = 30_000;

/** 未决/阻塞来源持续挡下一次触发；其余 runStatus 为终态。 */
export const openRunStatuses = new Set(['pending', 'accepted', 'blocked']);
/** CI 定义本身没有代际字段；binding 中的 generation 仅用于严格记录结构，取固定值。 */
export const CI_BINDING_GENERATION = 1;

type ExecutionLedger = Pick<RepositoryBundle['execution'], 'getAcceptedTask' | 'getTaskExecution' | 'getTaskExecutionState' | 'getAttemptEvents' | 'lookupAccepted' | 'readTransaction'>;
type AutomationRepositories = Pick<RepositoryBundle, 'config' | 'sessions' | 'tasks' | 'matters'> & { execution: ExecutionLedger };
type AuthorizationResult = boolean | PolicyDecision;

export interface SessionAutomationRuntime {
  getSession(id: string): Promise<Session | undefined>;
  dispatchRequest(request: TaskRequestV1): Promise<{ id: string; status: string }>;
  startScheduleSession?(input: StartSessionInput, stableSessionId: string, beforeStart: () => Promise<void>): Promise<Session>;
  /** 归档上一次 fresh 执行用过的会话；缺省时只靠空闲进程清理。 */
  archive?(sessionId: string): Promise<unknown>;
  subscribe?(sessionId: string, listener: (event: AgentEvent) => void): () => void;
}

/** 某次触发超过一个周期还没开始或没结束；reason 是能取到的卡点说明。 */
export interface ScheduleOverdueNotice { occurrenceId: string; scheduledForUtc: string; reason: string }

export interface AutomationDeliveryContext {
  signal: AbortSignal;
  /** Recheck the exact source and lease before each outbound delivery step. */
  assertCurrent(): Promise<void>;
}

export type TickParseCache = {
  occurrences: Map<string, SessionScheduleOccurrence>;
  subscriptions: Map<string, CiSubscription>;
};

export interface SessionAutomationServiceOptions {
  repositories: AutomationRepositories;
  runtime: SessionAutomationRuntime;
  authorize?: (sessionId: string, actorId?: string) => AuthorizationResult | Promise<AuthorizationResult>;
  prepareDelivery?: (sessionId: string, automationId: string) => Promise<void>;
  /** 返回送达的消息编号时，计划连续没做成会改这条消息而不是另发。 */
  deliver?: (sessionId: string, result: AttemptResultV1, occurrenceId: string, sourceId: string, context?: AutomationDeliveryContext) => Promise<void | { messageId?: string }>;
  onScheduleDisabled?: (schedule: SessionSchedule, reason: string, beforeSend?: () => Promise<void>) => Promise<void | 'not_requested'>;
  reconcileDisabledNotification?: (schedule: SessionSchedule) => Promise<boolean>;
  /** 在计划的回报位置提醒一次某次触发卡住了；返回 `not_requested` 表示没有回报位置，不再重试。 */
  onScheduleOverdue?: (schedule: SessionSchedule, notice: ScheduleOverdueNotice) => Promise<void | 'not_requested'>;
  /** 在计划的回报位置说一句这次没做成；给了 messageId 时先改那条消息，改不了再回一条短的。返回实际那条消息的编号。 */
  onScheduleProblem?: (schedule: SessionSchedule, notice: { occurrenceId: string; text: string; messageId?: string }) => Promise<void | 'not_requested' | { messageId?: string }>;
  log?: { warn: (details: Record<string, unknown>, message: string) => void };
  /** 已加载插件注册的 CI 提供方；没有 CI 插件时为空，CI 等待与「出现新的失败构建」不可用。 */
  ciProviders?: CiProviderRegistry;
  /** webhook 驱动的 CI 续作与修复；没有配置 webhook 的提供方时不注入。 */
  ciWebhook?: CiWebhookService;
  /** `/pr` 与 Web「开 PR」：会话改动开 PR 并跟进。 */
  pullRequests?: PullRequestService;
  /** 执行会话里是否有未处理的权限审批或 Agent 提问；用于把计划显示为「等待人工」。 */
  awaitingHuman?: (sessionId: string) => boolean;
  /** 计划可选择每次启动一个已保存的工作项模板；启动沿用模板启动的权限与确认规则。 */
  workTemplates?: ScheduleWorkTemplates;
  clock?: () => Date;
  /** Milliseconds counted as one configured pre-check timeout second. */
  preconditionSecondMs?: number;
  pollIntervalMs?: number;
}

export interface ScheduleWorkTemplates {
  list(parentSessionId: string, actorId?: string): Promise<Array<{ id: string; version: number }>>;
  /** 同一幂等键重试返回同一工作项；首次写入须原子核对 admissionChecks，覆盖模板内部异步准备。 */
  run(parentSessionId: string, templateId: string, version: number, goal: string, idempotencyKey: string, actorId: string | undefined, admissionChecks: Array<{ key: string; expected: string }>): Promise<{ id: string; status: string }>;
  /**
   * 内部进度查询，不做授权：编号只来自触发记录或按启动者派生，不受计划改归属或会话授权变化影响。
   * 工作项不存在时返回 undefined；存在但读不出状态时返回 'unknown'。
   */
  progress(workItemId: string): Promise<string | undefined>;
}
/** 一次触发启动工作项时用的身份：手动运行用点运行的人，其余用计划所有者。 */
export const occurrenceActorId = (schedule: SessionSchedule, occurrence: Pick<SessionScheduleOccurrenceV2, 'triggerSource' | 'actor' | 'actorId'>) =>
  occurrence.actorId ?? (occurrence.triggerSource === 'manual' && occurrence.actor?.kind !== 'unspecified' ? occurrence.actor?.id : schedule.actorId);
/** 仍在进行、尚需人或系统推进的工作项状态；上一次没结束时不再启动新的。 */
export const activeWorkItemStatuses = new Set(['awaiting_confirmation', 'running', 'waiting', 'blocked', 'cancelling']);

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

export const errorCode = (error: unknown) => error instanceof RuntimeError ? error.code : 'DISPATCH_FAILED';
export function clipTail(text: string, limit: number) {
  const flat = text.trim();
  return flat.length > limit ? `…${flat.slice(-limit)}` : flat;
}
export function streakKey(scheduleId: string) { return `${STREAK_PREFIX}${scheduleId}`; }
export function scheduleKey(id: string) { return `${SCHEDULE_PREFIX}${id}`; }
export function occurrenceKey(id: string) { return `${OCCURRENCE_PREFIX}${id}`; }

export function ciKey(id: string) { return `${CI_PREFIX}${id}`; }

export function taskBindingKey(taskId: string) { return `${TASK_BINDING_PREFIX}${taskId}`; }
export function iso(date: Date) { return date.toISOString(); }
export function plus(date: Date, milliseconds: number) { return new Date(date.getTime() + milliseconds).toISOString(); }

function receiptScheduleId(sessionId: string, actorId: string | undefined, key: string) {
  return `schedule_${createHash('sha256').update(JSON.stringify([sessionId, actorId, key])).digest('hex')}`;
}

export function freshSessionId(scheduleId: string, occurrence: string) {
  return `ses_schedule_${createHash('sha256').update(`fresh\0${scheduleId}\0${occurrence}`).digest('hex')}`;
}
/** 冻结来源会话的执行配置；fresh 沿用来源会话的目录（共享工作区），不另建 worktree。 */
export function freshExecutionContext(session: Session): NonNullable<SessionSchedule['executionContext']> {
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
export function isSessionRunnable(session: Session | undefined) {
  return Boolean(session && !session.archivedAt && !['stopped', 'failed'].includes(session.state));
}
function isAllowed(result: AuthorizationResult) { return result === true || typeof result === 'object' && result.allowed; }
/** 时间规则往后再没有触发时点（单次时间已过或落在按策略跳过的夏令时空档、cron 永远不匹配）：存成启用也永远不会执行，创建和启用时直接拒绝。 */
function requireNextRun(schedule: Parameters<typeof previewSessionSchedule>[0], after: Date) {
  const next = previewSessionSchedule(schedule, after);
  if (!next) throw new RuntimeError('SESSION_AUTOMATION_NO_NEXT_RUN', 'This schedule has no upcoming run time (the one-time time has passed or falls in a skipped DST gap, or the cron never matches); change the time rule', 409);
  return next;
}

/** 安装者只能映射到 installation_owner；平台用户必须带原 appId 域，域缺失即无法核对（undefined）。 */
export function resolveAutomationActor(session: Session | undefined, actorId?: string): ExecutionActor | undefined {
  if (!actorId) return { kind: 'unspecified' };
  if (actorId === 'installation_owner') return { kind: 'installation_owner', id: 'installation_owner' };
  if (session?.source === 'lark') {
    const { appId } = parseLarkSourceId(session.sourceId);
    if (appId) return { kind: 'channel', id: actorId, appId };
  }
  return undefined;
}

export function legacyAdmission(accepted: AcceptedTask, taskId = accepted.task.id): TaskAdmissionV1 {
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
/** 首次冻结 admission：返回要用的请求和要写入记录的字段；已接受过的沿用其 taskId。 */
export function freezeAdmission(namespace: TaskRequestV1['namespace'], sessionId: string, candidate: TaskRequestV1, existing: AcceptedTask | undefined, actor: ExecutionActor) {
  const admission = admissionFor(candidate, existing, executionTaskId(namespace, sessionId, candidate.key));
  return { admission, request: existing?.request ?? candidate, fields: { admission, actor, ...(existing ? { taskId: admission.taskId } : {}) } };
}

export type AutomationTaskLabel = 'Scheduled task' | 'CI continuation';

export function assertAdmissionMatchesAccepted(label: AutomationTaskLabel, admission: TaskAdmissionV1, accepted: AcceptedTask | undefined) {
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

function publicSchedule(value: SessionSchedule): PublicSessionSchedule {
  const { actorId: _actorId, taskStartOccurrenceId: _taskStartOccurrenceId, stopRequestId: _stopRequestId, pendingOccurrence: _pendingOccurrence, ...record } = value;
  return record;
}
export function publicOccurrence(value: SessionScheduleOccurrence): PublicSessionScheduleOccurrence {
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
export function publicSubscription(value: CiSubscription): PublicCiSubscription {
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
export function migrateOccurrence(value: SessionScheduleOccurrence): SessionScheduleOccurrenceV2 {
  if (value.schemaVersion === 2) return value;
  const { schemaVersion: _schemaVersion, ...rest } = value;
  return sessionScheduleOccurrenceV2Schema.parse({ ...rest, schemaVersion: 2 });
}
export function migrateCi(value: CiSubscription): CiSubscriptionV2 {
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

export const taskBindingSchema = z.union([taskBindingV1ScheduleSchema, taskBindingV1CiSchema, taskBindingV2ScheduleSchema, taskBindingV2CiSchema]);
export type TaskBinding = z.infer<typeof taskBindingSchema>;
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

type Dependencies = Pick<AutomationScheduler,
  'ci' | 'clock' | 'hasPendingOccurrence' | 'occurrences' | 'options' | 'preconditions'
  | 'retireFreshSessions' | 'service' | 'watchSession'>;

export class AutomationStore {
  readonly quarantinedSchedules = new Set<string>();

  constructor(private readonly automation: Dependencies) {}

  private invalidRecord(key: string, raw: string) {
    // Record identifiers are enough for repair. Never log the stored payload or parser issues.
    console.warn('SESSION_AUTOMATION_RECORD_INVALID', key);
    try {
      const value = JSON.parse(raw) as { scheduleId?: unknown };
      if (typeof value?.scheduleId === 'string') this.quarantinedSchedules.add(value.scheduleId);
    } catch { /* A reservation still keeps an unreadable occurrence occupied. */ }
  }

  requireStore() {
    if (!this.automation.options.repositories.config.compareAndSet || !this.automation.options.repositories.config.list) {
      throw new RuntimeError('SESSION_AUTOMATION_STORAGE_UNAVAILABLE', 'Session automation requires durable list and compare-and-set storage', 503);
    }
    return this.automation.options.repositories.config as Required<Pick<typeof this.automation.options.repositories.config, 'compareAndSet' | 'list'>> & typeof this.automation.options.repositories.config;
  }

  get execution() { return this.automation.options.repositories.execution; }

  async requireAuthorized(sessionId: string, actorId?: string) {
    if (!this.automation.options.authorize) throw new RuntimeError('SESSION_AUTOMATION_AUTH_UNWIRED', 'Session automation authorization is not configured', 403);
    if (!isAllowed(await this.automation.options.authorize(sessionId, actorId))) throw new RuntimeError('SESSION_AUTOMATION_FORBIDDEN', 'Session automation access was denied', 403);
  }

  async requireSession(sessionId: string) {
    const session = await this.automation.options.runtime.getSession(sessionId);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', 'Session not found', 404);
    return session;
  }

  async listRecords<T>(prefix: string, parse: (input: unknown) => T, cache?: Map<string, T>, filter?: Parameters<NonNullable<ConfigRepository['listByJsonField']>>[1]): Promise<Array<{ raw: string; value: T }>> {
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

  async getRecord<T>(key: string, parse: (input: unknown) => T): Promise<{ raw: string; value: T } | undefined> {
    const raw = await this.automation.options.repositories.config.get(key);
    if (!raw) return undefined;
    try { return { raw, value: parse(JSON.parse(raw)) }; }
    catch { this.invalidRecord(key, raw); throw new RuntimeError('SESSION_AUTOMATION_RECORD_INVALID', 'Stored session automation record is invalid', 500); }
  }

  async replace(key: string, raw: string, value: unknown) {
    return this.requireStore().compareAndSet(key, raw, JSON.stringify(value));
  }

  async createRecord(key: string, value: unknown) {
    return this.requireStore().compareAndSet(key, undefined, JSON.stringify(value));
  }

  /** 幂等补齐同一授权 binding：来源 CAS 之后、dispatch 之前；崩溃重开补同一映射。 */
  async ensureTaskBinding(taskId: string, binding: TaskBinding) {
    // Every tick re-checks the bindings of all open occurrences; they almost always exist,
    // so read first instead of paying for a failing insert CAS each time.
    let existing = await this.getRecord(taskBindingKey(taskId), value => taskBindingSchema.parse(value));
    if (!existing) {
      if (await this.createRecord(taskBindingKey(taskId), binding)) return;
      existing = await this.getRecord(taskBindingKey(taskId), value => taskBindingSchema.parse(value));
      if (!existing) throw new RuntimeError('SESSION_AUTOMATION_TASK_BINDING_CONFLICT', 'Automation task binding disappeared', 409);
    }

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

  private async matterSessionIds(sessionId: string, actorId?: string) {
    const matter = this.automation.options.repositories.matters?.find('session', sessionId);
    const ids = matter ? this.automation.options.repositories.matters!.links(matter.id).filter(link => link.kind === 'session').map(link => link.refId) : [sessionId];
    const visible: string[] = [];
    for (const id of ids) {
      try { await this.requireAuthorized(id, actorId); visible.push(id); } catch { /* 沿用每个源会话的权限。 */ }
    }
    return visible;
  }

  async listBySession(sessionId: string, actorId?: string): Promise<SessionAutomationList> {
    await this.requireAuthorized(sessionId, actorId);
    const session = await this.requireSession(sessionId);
    const sessionIds = await this.matterSessionIds(sessionId, actorId);
    const [schedules, subscriptions, occurrences] = await Promise.all([
      this.listRecords(SCHEDULE_PREFIX, readStoredSessionSchedule, undefined, { field: 'sessionId', values: sessionIds }),
      this.listRecords(CI_PREFIX, value => ciSubscriptionSchema.parse(value), undefined, { field: 'sessionId', values: [sessionId] }),
      this.listRecords(OCCURRENCE_PREFIX, value => sessionScheduleOccurrenceSchema.parse(value), undefined, { field: 'sessionId', values: sessionIds })
    ]);
    const publicSchedules = schedules.map(item => item.value).filter(item => sessionIds.includes(item.sessionId) && !item.deletedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-MAX_RECORDS).map(publicSchedule);
    const deliveryTargets: NonNullable<SessionAutomationList['deliveryTargets']> = {};
    await Promise.all(publicSchedules.map(async schedule => {
      const owner = schedule.sessionId === sessionId ? session : await this.automation.options.runtime.getSession(schedule.sessionId);
      const ownerSource = parseLarkSourceId(owner?.sourceId);
      if (owner?.source !== 'lark') { deliveryTargets[schedule.id] = { kind: 'task', sessionId: schedule.sessionId }; return; }
      const raw = await this.automation.options.repositories.config.get(`automation.delivery-target.${schedule.id}`);
      let target: unknown;
      try { target = raw ? JSON.parse(raw) : undefined; } catch { target = undefined; }
      const parsed = z.object({ appId: z.string().min(1), chatId: z.string().min(1), replyMessageId: z.string().startsWith('om_'), replyInThread: z.boolean() }).safeParse(target);
      deliveryTargets[schedule.id] = parsed.success && ownerSource.appId === parsed.data.appId && ownerSource.chatId === parsed.data.chatId
        ? { kind: 'lark', ...parsed.data }
        : { kind: 'unavailable' };
    }));
    const runStates: NonNullable<SessionAutomationList['runStates']> = {};
    for (const schedule of schedules.map(item => item.value).filter(item => publicSchedules.some(visible => visible.id === item.id))) {
      const history = occurrences.map(item => item.value).filter(item => item.scheduleId === schedule.id).sort((a, b) => b.scheduledForUtc.localeCompare(a.scheduledForUtc) || b.id.localeCompare(a.id));
      runStates[schedule.id] = await this.runState(schedule, history);
    }
    const preconditions: NonNullable<SessionAutomationList['preconditions']> = {};
    await Promise.all(publicSchedules.map(async schedule => {
      const precondition = await this.automation.preconditions.publicPrecondition(schedule.id);
      if (precondition) preconditions[schedule.id] = precondition;
    }));
    return {
      deliveryTargets,
      runStates,
      preconditions,
      schedules: publicSchedules,
      subscriptions: subscriptions.map(item => item.value).filter(item => item.sessionId === sessionId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-MAX_RECORDS).map(publicSubscription),
      occurrences: occurrences.map(item => item.value).filter(item => sessionIds.includes(item.sessionId)).sort((a, b) => a.scheduledForUtc.localeCompare(b.scheduledForUtc)).slice(-MAX_RECORDS).map(publicOccurrence)
    };
  }

  /** 计划跟进到哪一步；history 按计划时间从新到旧。 */
  private async runState(schedule: SessionSchedule, history: SessionScheduleOccurrence[]): Promise<ScheduleRunState> {
    if (!schedule.enabled) return schedule.outcome?.kind ?? 'disabled';
    const open = history.find(item => openRunStatuses.has(item.runStatus));
    if (open) {
      const value = migrateOccurrence(open);
      const unknown = value.taskId && this.execution.getTaskExecutionState(value.taskId)?.attempts.some(attempt => attempt.state === 'reconcile_required' || attempt.state === 'legacy_unresolved');
      return value.runStatus === 'blocked' || unknown || value.taskId && this.automation.options.awaitingHuman?.(value.executionSessionId ?? value.sessionId) ? 'awaiting_human' : 'running';
    }
    const latest = history[0] && migrateOccurrence(history[0]);
    // 被跳过的触发不带工作项；看最近一次真正启动的工作项。
    const started = history.map(migrateOccurrence).find(item => item.workItemId);
    if (started?.workItemId && this.automation.options.workTemplates) {
      const status = await this.automation.options.workTemplates.progress(started.workItemId).catch(() => undefined);
      if (status === 'awaiting_confirmation' || status === 'blocked') return 'awaiting_human';
      if (status && activeWorkItemStatuses.has(status)) return 'running';
      if (status === 'failed') return 'failed';
    }
    return latest && ['failed', 'interrupted', 'error'].includes(latest.runStatus) ? 'failed' : 'waiting';
  }

  private async assertMatterScheduleAvailable(sessionId: string, input: CreateSessionScheduleInput, actorId?: string) {
    if (input.trigger.kind !== 'at' && !input.additional) {
      const ids = await this.matterSessionIds(sessionId, actorId);
      const records = await this.listRecords(SCHEDULE_PREFIX, readStoredSessionSchedule, undefined, { field: 'sessionId', values: ids });
      const active = records.map(item => item.value).filter(item => ids.includes(item.sessionId) && item.enabled && !item.deletedAt && item.trigger.kind !== 'at');
      if (active.length) throw new RuntimeError('MATTER_SCHEDULE_EXISTS', `本事项已有生效的循环计划：${active.map(item => `${item.name}（${item.id}）`).join('、')}。修改请用 schedule update <编号>；确需再建请加 --additional。`, 409);
    }
  }

  /** 完成条件、截止时间与工作项模板的组合规则；模板须是来源任务里计划身份可见的已保存版本。 */
  private async assertFollowUpSettings(sessionId: string, candidate: Pick<SessionSchedule, 'trigger' | 'mode' | 'workTemplate' | 'completionCondition' | 'deadlineAt' | 'enabled'> & { condition: { kind: string } }, actorId: string | undefined, changed: { deadline: boolean; template: boolean }) {
    if ((candidate.completionCondition || candidate.deadlineAt) && candidate.trigger.kind === 'at') throw new RuntimeError('SESSION_AUTOMATION_FOLLOW_UP_REQUIRES_RECURRING', 'Completion conditions and deadlines apply only to recurring schedules', 400);
    if (candidate.deadlineAt && changed.deadline && Date.parse(candidate.deadlineAt) <= this.automation.clock().getTime()) throw new RuntimeError('SESSION_AUTOMATION_DEADLINE_PASSED', 'The schedule deadline has already passed; set a later deadline or clear it', 409);
    if (!candidate.workTemplate) return;
    if (candidate.completionCondition) throw new RuntimeError('SESSION_AUTOMATION_TEMPLATE_UNSUPPORTED', 'A completion condition needs a scheduled agent turn that can call stop-self; work-template schedules support only a deadline', 400);
    if (candidate.mode === 'independent' || candidate.mode === 'fresh') throw new RuntimeError('SESSION_AUTOMATION_TEMPLATE_UNSUPPORTED', 'Work-template schedules start the work item in the source task; use session mode', 400);
    if (candidate.condition.kind !== 'always') throw new RuntimeError('SESSION_AUTOMATION_TEMPLATE_UNSUPPORTED', 'Work-template schedules support only the always condition', 400);
    if (!changed.template) return;
    if (!this.automation.options.workTemplates) throw new RuntimeError('WORK_TEMPLATE_UNAVAILABLE', 'Work templates are unavailable on this instance', 503);
    const { id, version } = candidate.workTemplate;
    if (!(await this.automation.options.workTemplates.list(sessionId, actorId)).some(item => item.id === id && item.version === version)) throw new RuntimeError('WORK_TEMPLATE_NOT_FOUND', `Work template ${id} version ${version} is not available in this task`, 404);
  }

  async createSchedule(sessionId: string, rawInput: CreateSessionScheduleInput, actorId?: string, receipt?: { key: string; prepareDelivery?: (id: string) => Promise<void> }): Promise<PublicSessionSchedule> {
    await this.requireAuthorized(sessionId, actorId);
    const session = await this.requireSession(sessionId);
    if (!isSessionRunnable(session)) throw new RuntimeError('SESSION_NOT_ACTIVE', 'Session is not active', 409);
    const input = createSessionScheduleInputSchema.parse(rawInput);
    const id = receipt ? receiptScheduleId(sessionId, actorId, receipt.key) : `schedule_${randomUUID()}`;
    const existing = receipt ? await this.getRecord(scheduleKey(id), readStoredSessionSchedule) : undefined;
    if (existing) return publicSchedule(existing.value);
    await new MattersService(this.automation.options.repositories).session(sessionId, { title: input.prompt });
    await this.assertNameAvailable(sessionId, input.name);
    await this.assertMatterScheduleAvailable(sessionId, input, actorId);
    const now = iso(this.automation.clock());
    const deadlineAt = input.deadlineAt ? new Date(input.deadlineAt).toISOString() : undefined;
    await this.assertFollowUpSettings(sessionId, { ...input, mode: input.mode ?? 'session', deadlineAt, enabled: false }, actorId, { deadline: true, template: true });
    this.automation.preconditions.assertPreconditionInput(input.precondition, actorId);
    this.automation.preconditions.assertPreconditionCondition(input.condition, Boolean(input.precondition));
    const condition = input.condition.kind === 'always' ? input.condition : await this.automation.ci.ciCondition(session, input.condition);
    await receipt?.prepareDelivery?.(id);
    if (input.mode === 'fresh' && !this.automation.options.runtime.startScheduleSession) throw new RuntimeError('FRESH_SCHEDULE_UNAVAILABLE', 'Fresh-session schedules are unavailable on this instance', 503);
    if (input.mode === 'independent') {
      if (!this.automation.options.runtime.startScheduleSession) throw new RuntimeError('INDEPENDENT_SCHEDULE_UNAVAILABLE', 'Independent schedules are unavailable on this instance', 503);
      try { await promisify(execFile)('git', ['-C', session.cwd, 'rev-parse', '--git-common-dir']); }
      catch { throw new RuntimeError('INDEPENDENT_WORKSPACE_UNSUPPORTED', 'Independent schedules require a managed Git worktree; use session mode for this directory', 422); }
    }
    await this.automation.options.prepareDelivery?.(sessionId, id);
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
      ...(input.workTemplate ? { workTemplate: input.workTemplate } : {}),
      ...(input.completionCondition ? { completionCondition: input.completionCondition } : {}),
      ...(deadlineAt ? { deadlineAt } : {}),
      ...(input.mode === 'independent' ? {
        executionSessionId: `ses_schedule_${createHash('sha256').update(id).digest('hex')}`,
        executionContext: { cwd: session.workspaceSourceCwd ?? session.cwd, sourceCwd: session.workspaceSourceCwd ?? session.cwd, agentId: session.agentId,
          ...(session.model ? { model: session.model } : {}), ...(session.codexProfile ? { codexProfile: session.codexProfile } : {}),
          ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
          ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}), contextMode: 'prompt_only' }
      } : {}),
      ...(input.mode !== 'independent' ? { executionContext: freshExecutionContext(session) } : {}),
      enabled: false,
      createdAt: now,
      updatedAt: now
    });
    requireNextRun(schedule, this.automation.clock());
    if (!await (input.precondition ? this.automation.preconditions.saveWithPrecondition(schedule.id, undefined, schedule, input.precondition) : this.createRecord(scheduleKey(schedule.id), schedule))) {
      if (receipt) {
        const saved = await this.getRecord(scheduleKey(id), readStoredSessionSchedule);
        if (saved) return publicSchedule(saved.value);
      }
      throw new RuntimeError('SESSION_AUTOMATION_CONFLICT', 'Schedule identifier already exists', 409);
    }
    try {
      const matter = this.automation.options.repositories.matters?.find('session', sessionId);
      if (matter) this.automation.options.repositories.matters!.link({ matterId: matter.id, kind: 'schedule', refId: schedule.id, relation: 'created_in' });
    } catch { console.warn('MATTER_LINK_FAILED'); }
    this.automation.watchSession(sessionId);
    if (schedule.mode === 'independent') {
      await this.automation.occurrences.executionSession(schedule);
      const current = await this.getRecord(scheduleKey(id), readStoredSessionSchedule);
      return publicSchedule(current!.value);
    }
    return publicSchedule(schedule);
  }

  /**
   * 聊天里代建计划：同事项已有生效循环计划时拒绝新建；已停用同名计划保留兼容更新，不新建第二条。
   * 有实际改动时一并停用，等用户在确认卡上重新启用；没有改动时原样返回。同一请求重试拿回同一结果。
   * `newMode` 只在新建、请求没写模式、且本实例能开新会话时作为缺省；更新同名计划时不改它的模式。
   */
  async requestSchedule(sessionId: string, rawInput: CreateSessionScheduleInput, actorId: string, receipt: { key: string; newMode?: 'fresh'; prepareDelivery?: (id: string) => Promise<void> }): Promise<{ schedule: PublicSessionSchedule; updated?: { changed: boolean; wasEnabled: boolean } }> {
    await this.requireAuthorized(sessionId, actorId);
    const input = createSessionScheduleInputSchema.parse(rawInput);
    // 聊天代建与飞书确认卡不开放前置命令：命令只由安装管理员在 Web 或本机 CLI 设置。
    if (input.precondition) throw new RuntimeError('SESSION_AUTOMATION_PRECONDITION_FORBIDDEN', 'Pre-check commands cannot be requested from chat; set them from the Web schedule panel or the local dutydeck schedule CLI', 400);
    const own = await this.getRecord(scheduleKey(receiptScheduleId(sessionId, actorId, receipt.key)), readStoredSessionSchedule);
    if (own) return { schedule: publicSchedule(own.value) };
    await this.assertMatterScheduleAvailable(sessionId, input, actorId);
    // 兼容旧会话对停用同名计划的请求；修改生效循环计划须显式用 update。
    const [existing] = (await this.sameNameSchedules(sessionId, input.name, undefined, actorId))
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.updatedAt.localeCompare(a.updatedAt));
    if (!existing || input.additional) return { schedule: await this.automation.service.createSchedule(sessionId, input.mode || !receipt.newMode || !this.automation.options.runtime.startScheduleSession ? input : { ...input, mode: receipt.newMode }, actorId, receipt) };
    if (input.mode === 'independent' && existing.mode !== 'independent') throw new RuntimeError('SESSION_AUTOMATION_MODE_IMMUTABLE', 'An existing schedule cannot switch to independent mode', 409);
    // 兼容更新不改工作项模板：模板不一致时不静默保留或丢掉，让 Agent 显式改用 update 或换名称。
    if (input.workTemplate?.id !== existing.workTemplate?.id || input.workTemplate?.version !== existing.workTemplate?.version) {
      throw new RuntimeError('SESSION_AUTOMATION_TEMPLATE_MISMATCH', `已有同名计划「${existing.name}」的工作项模板与这次请求不一致；要改原计划请用 schedule update ${existing.id}，要另建请换一个名称`, 409);
    }
    const mode = input.mode === 'independent' ? undefined : input.mode;
    const patch: Omit<UpdateSessionScheduleInput, 'expectedRevision'> = {
      ...(input.prompt !== existing.prompt ? { prompt: input.prompt } : {}),
      ...(!sameTrigger(input.trigger, existing.trigger) ? { trigger: input.trigger } : {}),
      ...(input.timezone !== existing.timezone ? { timezone: input.timezone } : {}),
      ...(canonicalExecutionJson(input.dstPolicy) !== canonicalExecutionJson(existing.dstPolicy) ? { dstPolicy: input.dstPolicy } : {}),
      ...(input.condition.kind !== existing.condition.kind ? { condition: input.condition } : {}),
      ...(mode && mode !== existing.mode ? { mode } : {}),
      ...((input.completionCondition ?? undefined) !== existing.completionCondition ? { completionCondition: input.completionCondition ?? null } : {}),
      ...((input.deadlineAt ? new Date(input.deadlineAt).toISOString() : undefined) !== existing.deadlineAt ? { deadlineAt: input.deadlineAt ?? null } : {})
    };
    const changed = Object.keys(patch).length > 0;
    const schedule = changed
      ? await this.automation.service.updateSchedule(existing.sessionId, existing.id, { expectedRevision: existing.revision, ...patch, enabled: false }, actorId)
      : publicSchedule(existing);
    return { schedule, updated: { changed, wasEnabled: existing.enabled } };
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
    const session = await this.automation.options.runtime.getSession(sessionId);
    if (session?.source !== 'schedule') return false;
    const schedule = session.sourceId ? await this.getRecord(scheduleKey(session.sourceId), readStoredSessionSchedule) : undefined;
    if (!schedule || (schedule.value.mode !== 'independent' && schedule.value.mode !== 'fresh') || schedule.value.actorId !== actorId || !await this.ownsExecutionSession(schedule.value, session)) {
      throw new RuntimeError('INDEPENDENT_SCHEDULE_REVOKED', 'Independent schedule execution authority is unavailable', 403);
    }
    await this.requireAuthorized(schedule.value.sessionId, actorId);
    return true;
  }

  async sourceSessionId(sessionId: string): Promise<string | undefined> {
    const session = await this.automation.options.runtime.getSession(sessionId);
    if (session?.source !== 'schedule' || !session.sourceId) return undefined;
    const record = await this.getRecord(scheduleKey(session.sourceId), readStoredSessionSchedule);
    return record && await this.ownsExecutionSession(record.value, session) ? record.value.sessionId : undefined;
  }

  /**
   * 计划每次在新会话执行、结果回原话题；这里补上两处衔接，只在这个会话还没用过这份结果时给：
   * 计划的新会话第一轮带上一次的结果摘要；原话题的会话在那次运行之后第一次接到消息时带最近一次的结果，用户多半是在跟进它。
   */
  async resultContext(session: Session): Promise<string | undefined> {
    const scheduleIds = session.source === 'schedule'
      ? session.sourceId ? [session.sourceId] : []
      : (await this.listRecords(SCHEDULE_PREFIX, readStoredSessionSchedule, undefined, { field: 'sessionId', values: [session.id] }))
        .map(item => item.value).filter(item => item.sessionId === session.id && item.mode === 'fresh' && !item.deletedAt).map(item => item.id);
    if (!scheduleIds.length) return undefined;
    const [latest] = (await this.listRecords(OCCURRENCE_PREFIX, value => migrateOccurrence(sessionScheduleOccurrenceSchema.parse(value)), undefined, { field: 'scheduleId', values: scheduleIds }))
      .map(item => item.value)
      // 计划会话认上一次在哪跑的都行（含改成新会话之前在来源会话里跑的）；原话题会话只认在别的会话里跑的，自己跑过的已在上下文里。
      .filter(item => scheduleIds.includes(item.scheduleId) && item.result && ['completed', 'failed'].includes(item.runStatus)
        && (session.source === 'schedule' ? (item.executionSessionId ?? item.sessionId) !== session.id : Boolean(item.executionSessionId) && item.executionSessionId !== session.id))
      .sort((a, b) => b.scheduledForUtc.localeCompare(a.scheduledForUtc) || b.updatedAt.localeCompare(a.updatedAt));
    if (!latest) return undefined;
    const settled = (await this.automation.options.repositories.tasks.listBySession(session.id)).filter(task => isTerminalTaskStatus(task.status));
    if (session.source === 'schedule' ? settled.length : settled.some(task => task.createdAt > latest.updatedAt)) return undefined;
    const schedule = await this.getRecord(scheduleKey(latest.scheduleId), readStoredSessionSchedule);
    const when = new Date(latest.scheduledForUtc).toLocaleString('zh-CN', { timeZone: schedule?.value.timezone, hour12: false });
    const outcome = latest.runStatus === 'completed' ? '完成' : `没做成（${latest.error ?? '执行失败'}）`;
    return session.source === 'schedule'
      ? `上一次运行（${when}，${outcome}）的结果摘要，只作参考，这次照计划重新做：\n${clipTail(latest.result!.output.text, 500)}`
      : `本话题的定时计划『${schedule?.value.name ?? latest.scheduleId}』最近一次（${when}）在单独的会话里运行，${outcome}，结果如下；用户接下来的话可能是在跟进它：\n${clipTail(latest.result!.output.text, 1500)}`;
  }

  async getScheduleDefinition(sessionId: string, id: string, actorId?: string): Promise<PublicSessionSchedule> {
    await this.requireAuthorized(sessionId, actorId);
    await this.requireSession(sessionId);
    const stored = await this.getRecord(scheduleKey(id), readStoredSessionSchedule);
    if (!stored || stored.value.sessionId !== sessionId) throw new RuntimeError('SESSION_AUTOMATION_SCHEDULE_NOT_FOUND', 'Session schedule not found', 404);
    return publicSchedule(stored.value);
  }

  async getScheduleHistory(sessionId: string, id: string, actorId?: string): Promise<PublicSessionScheduleOccurrence[]> {
    await this.automation.service.getScheduleDefinition(sessionId, id, actorId);
    const occurrences = await this.listRecords(OCCURRENCE_PREFIX, value => sessionScheduleOccurrenceSchema.parse(value), undefined, { field: 'scheduleId', values: [id], sessionId });
    return occurrences.map(item => item.value).filter(item => item.sessionId === sessionId && item.scheduleId === id)
      .sort((a, b) => b.scheduledForUtc.localeCompare(a.scheduledForUtc) || b.id.localeCompare(a.id)).slice(0, MAX_RECORDS).map(publicOccurrence);
  }

  async listSchedules(query: AutomationScheduleQuery, authorize: (sessionId: string) => Promise<boolean | { actorId?: string }>): Promise<AutomationSchedulePage> {
    const records = await this.listRecords(SCHEDULE_PREFIX, readStoredSessionSchedule);
    const allowed = new Map<string, boolean>();
    const canRead = async (sessionId: string) => {
      sessionId = await this.automation.service.sourceSessionId(sessionId) ?? sessionId;
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
        const session = await this.automation.options.runtime.getSession(value.sessionId);
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
        : latest?.delivery.status === 'pending' || latest?.delivery.status === 'error' && latest.delivery.attempts < NOTICE_MAX_ATTEMPTS ? 'delivery'
        : latest && (['failed', 'interrupted', 'error'].includes(latest.runStatus) || latest.delivery.status === 'error') ? 'error' : 'ready';
      let blocker: AutomationScheduleSummary['blocker'];
      if (open) {
        if (!sessionTasks.has(executionSessionId)) sessionTasks.set(executionSessionId, await this.automation.options.repositories.tasks.listBySession(executionSessionId));
        const blockingTask = sessionTasks.get(executionSessionId)!.find(item => ['running', 'reconcile_required', 'legacy_unresolved'].includes(item.status));
        const blockedBy = projection?.blockers.find(item => item.taskId && item.taskId !== taskId || item.code.startsWith('WORKSPACE_'));
        const blockingSessionId = blockedBy?.sessionId ?? executionSessionId;
        const actualId = blockedBy?.taskId ?? blockingTask?.id ?? taskId;
        if (actualId) {
          let canView = allowed.get(blockingSessionId);
          if (canView === undefined) { canView = await canRead(blockingSessionId); allowed.set(blockingSessionId, canView); }
          const blocking = canView ? this.execution.getTaskExecutionState(actualId) : undefined;
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
        health, runState: await this.runState(schedule, history), ...(latest ? { latestOccurrence: publicOccurrence(latest) } : {}), ...(blocker ? { blocker } : {}),
        ...(schedule.enabled && schedule.nextDueAt && schedule.nextDueAt < iso(this.automation.clock()) ? { overdue: { from: schedule.nextDueAt, to: iso(this.automation.clock()) } } : {})
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
    await this.automation.service.getScheduleDefinition(sessionId, id, actorId);
    const records = await this.listRecords(OCCURRENCE_PREFIX, value => sessionScheduleOccurrenceSchema.parse(value), undefined, { field: 'scheduleId', values: [id], sessionId });
    const all = records.map(item => item.value).filter(item => item.sessionId === sessionId && item.scheduleId === id)
      .sort((a, b) => b.scheduledForUtc.localeCompare(a.scheduledForUtc) || b.id.localeCompare(a.id)).map(publicOccurrence);
    return { occurrences: all.slice(offset, offset + limit), total: all.length, offset, limit };
  }

  async getScheduleRun(sessionId: string, scheduleId: string, id: string, actorId?: string): Promise<AutomationRunDetail> {
    const schedule = await this.automation.service.getScheduleDefinition(sessionId, scheduleId, actorId);
    const stored = await this.getRecord(occurrenceKey(id), value => sessionScheduleOccurrenceSchema.parse(value));
    if (!stored || stored.value.sessionId !== sessionId || stored.value.scheduleId !== scheduleId) {
      throw new RuntimeError('SESSION_AUTOMATION_RUN_NOT_FOUND', 'This schedule run is unavailable', 404);
    }
    const occurrence = migrateOccurrence(stored.value);
    const executionSessionId = occurrence.executionSessionId ?? sessionId;
    const projection = occurrence.taskId ? this.execution.getTaskExecutionState(occurrence.taskId) : undefined;
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
    if (input.enabled === true && stored.value.mode !== 'independent' && stored.value.mode !== 'fresh' && !this.automation.options.runtime.startScheduleSession && !isSessionRunnable(session)) throw new RuntimeError('SESSION_NOT_ACTIVE', 'Session is not active', 409);
    if (input.name !== undefined && input.name !== stored.value.name) await this.assertNameAvailable(sessionId, input.name, id);
    const currentMode = stored.value.mode ?? 'session';
    const modeChanged = input.mode !== undefined && input.mode !== currentMode;
    if (modeChanged) {
      if (currentMode === 'independent') throw new RuntimeError('SESSION_AUTOMATION_MODE_IMMUTABLE', 'Independent schedules cannot switch mode; create a new schedule instead', 409);
      if (input.mode === 'fresh' && !this.automation.options.runtime.startScheduleSession) throw new RuntimeError('FRESH_SCHEDULE_UNAVAILABLE', 'Fresh-session schedules are unavailable on this instance', 503);
      // 正在执行的那次仍归属原会话；等它结束再切换，避免它的回执失去归属。
      if (await this.automation.hasPendingOccurrence(stored.value)) throw new RuntimeError('SESSION_AUTOMATION_SCHEDULE_BUSY', 'This schedule already has unfinished work', 409);
    }
    const followUp = {
      workTemplate: input.workTemplate === undefined ? stored.value.workTemplate : input.workTemplate ?? undefined,
      completionCondition: input.completionCondition === undefined ? stored.value.completionCondition : input.completionCondition ?? undefined,
      deadlineAt: input.deadlineAt === undefined ? stored.value.deadlineAt : input.deadlineAt ? new Date(input.deadlineAt).toISOString() : undefined
    };
    const reenabled = input.enabled === true && !stored.value.enabled;
    await this.assertFollowUpSettings(sessionId, { trigger: input.trigger ?? stored.value.trigger, mode: modeChanged ? input.mode : currentMode, condition: input.condition ?? stored.value.condition, ...followUp, enabled: input.enabled ?? stored.value.enabled },
      actorId ?? stored.value.actorId, { deadline: input.deadlineAt !== undefined || reenabled, template: input.workTemplate !== undefined && input.workTemplate !== null || reenabled });
    this.automation.preconditions.assertPreconditionInput(input.precondition, actorId);
    this.automation.preconditions.assertPreconditionCondition(input.condition ?? stored.value.condition, input.precondition !== undefined ? Boolean(input.precondition)
      : Boolean((await this.automation.preconditions.readPrecondition(id))?.value.command));
    let condition = stored.value.condition;
    if (input.condition) condition = input.condition.kind === 'always' ? input.condition : await this.automation.ci.ciCondition(session, input.condition);
    const now = this.automation.clock();
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
      // 没存模式的旧计划按 session 执行，但会被自动改成新会话；用户明确选了就记下来，之后不再自动改。
      ...(input.mode !== undefined && !modeChanged ? { mode: input.mode } : {}),
      revision: stored.value.revision + 1,
      generation: stored.value.generation + (executionChanged ? 1 : 0),
      ...(executionChanged && actorId && stored.value.mode !== 'independent' ? { actorId } : {}),
      ...(input.misfirePolicy !== undefined ? { misfirePolicy: input.misfirePolicy } : {}),
      ...(input.maxLatenessSeconds !== undefined ? { maxLatenessSeconds: input.maxLatenessSeconds ?? undefined } : {}),
      ...followUp,
      // 重新启用开始新一段跟进：上一段的完成或到截止结论不再适用。
      ...(reenabled ? { outcome: undefined } : {}),
      updatedAt: iso(now)
    };
    const schedule = sessionScheduleSchema.parse({
      ...candidate,
      nextDueAt: executionChanged ? candidate.enabled ? requireNextRun(candidate, now).scheduledForUtc : undefined : stored.value.nextDueAt
    });
    if (!await (input.precondition !== undefined ? this.automation.preconditions.saveWithPrecondition(id, stored.raw, schedule, input.precondition) : this.replace(scheduleKey(id), stored.raw, schedule))) throw new RuntimeError('SESSION_AUTOMATION_REVISION_CONFLICT', 'Session schedule revision changed', 409);
    if (modeChanged) await this.automation.retireFreshSessions(schedule);
    if (schedule.enabled && !stored.value.enabled) await this.automation.occurrences.resetStreak(id);
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
    const now = iso(this.automation.clock());
    const deleted = readStoredSessionSchedule({ ...stored.value, revision: stored.value.revision + 1, generation: stored.value.generation + 1, enabled: false, nextDueAt: undefined, deletedAt: now, updatedAt: now });
    if (!await this.replace(scheduleKey(id), stored.raw, deleted)) throw new RuntimeError('SESSION_AUTOMATION_REVISION_CONFLICT', 'Session schedule revision changed', 409);
    return publicSchedule(deleted);
  }

  /** 同一会话里未删除的计划按名称唯一；停用的也算，避免同名计划并存。 */
  private async sameNameSchedules(sessionId: string, name: string, exceptId?: string, actorId?: string) {
    const ids = actorId ? await this.matterSessionIds(sessionId, actorId) : [sessionId];
    const records = await this.listRecords(SCHEDULE_PREFIX, readStoredSessionSchedule, undefined, { field: 'sessionId', values: ids });
    return records.map(item => item.value).filter(item => ids.includes(item.sessionId) && !item.deletedAt && item.name === name.trim() && item.id !== exceptId);
  }

  private async assertNameAvailable(sessionId: string, name: string, exceptId?: string) {
    const [existing] = await this.sameNameSchedules(sessionId, name, exceptId);
    if (existing) throw new RuntimeError('SESSION_AUTOMATION_SCHEDULE_NAME_CONFLICT', `This session already has a schedule named "${existing.name}" (${existing.id}); update that schedule instead`, 409);
  }

  async readStreak(scheduleId: string) {
    try { return await this.getRecord(streakKey(scheduleId), value => streakSchema.parse(value)); }
    catch { return undefined; }
  }
}
