import { z } from 'zod';
import { previewNextSchedule, type ScheduleDefinition, scheduleTriggerSchema, storedScheduleTriggerSchema, scheduleDstGapPolicies, scheduleDstOverlapPolicies } from './schedule-foundation.js';
import {
  attemptResultV1Schema,
  executionActorSchema,
  taskAdmissionV1Schema,
  type AttemptResultV1,
  type ExecutionActor,
  type TaskAdmissionV1
} from './task-execution.js';

const observedRunAttempts = z.array(z.object({ id: z.number().int().nonnegative(), attempt: z.number().int().positive() }).strict()).max(100);
const timestamp = z.string().datetime({ offset: true });
const repository = z.object({ owner: z.string().min(1), name: z.string().min(1), slug: z.string().min(3) }).strict();
const delivery = z.object({
  status: z.enum(['not_requested', 'pending', 'delivered', 'error']),
  attempts: z.number().int().nonnegative(),
  error: z.string().optional(),
  updatedAt: timestamp
}).strict();

export const automationBlockReasons = [
  'reconcile_required',
  'legacy_output_unresolved',
  'legacy_input_unresolved',
  'admission_conflict'
] as const;
export type AutomationBlockReason = (typeof automationBlockReasons)[number];

const providerId = z.string().trim().min(1).max(64);

/**
 * CI 提供方插件化之前只有 GitHub，条件写作 `github_new_failure`。旧记录和旧客户端的输入在读入时
 * 换成 `ci_new_failure` + `provider: 'github'`，写回时只写新形式。
 */
export const LEGACY_GITHUB_PROVIDER_ID = 'github';
const legacyCondition = (value: unknown) => value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'github_new_failure'
  ? { ...value, kind: 'ci_new_failure', provider: LEGACY_GITHUB_PROVIDER_ID }
  : value;

export const sessionScheduleConditionSchema = z.preprocess(legacyCondition, z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('always') }).strict(),
  z.object({
    kind: z.literal('ci_new_failure'),
    provider: providerId,
    workflow: z.string().trim().min(1).max(255).optional(),
    repository,
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
    observedRunIds: z.array(z.number().int().nonnegative()).max(100),
    observedRunAttempts: observedRunAttempts.optional()
  }).strict()
]));
export type SessionScheduleCondition = z.infer<typeof sessionScheduleConditionSchema>;

/** 输入里的 provider 可省略：按工作区 origin 匹配已安装的 CI 插件。 */
const scheduleConditionInputSchema = z.preprocess(legacyCondition, z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('always') }).strict(),
  z.object({ kind: z.literal('ci_new_failure'), provider: providerId.optional(), workflow: z.string().trim().min(1).max(255).optional() }).strict()
]));

const scheduleMisfireSchema = z.object({
  policy: z.enum(['skip', 'coalesce']), from: timestamp, to: timestamp, reason: z.string()
}).strict();

const executionContextSchema = z.object({
  cwd: z.string().min(1), sourceCwd: z.string().min(1).optional(), agentId: z.string().min(1), model: z.string().optional(),
  codexProfile: z.string().optional(), reasoningEffort: z.string().optional(),
  permissionMode: z.enum(['ask', 'approve-reads', 'full-trust', 'deny-all']).optional(),
  contextMode: z.literal('prompt_only')
}).strict();
const disableNotificationSchema = z.object({
  status: z.enum(['pending', 'sending', 'delivered', 'error', 'unknown', 'not_requested']),
  attempts: z.number().int().nonnegative(), updatedAt: timestamp,
  name: z.string().optional(),
  nextAttemptAt: timestamp.optional(), owner: z.string().optional(), error: z.string().optional()
}).strict();

export const sessionScheduleSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  generation: z.number().int().positive(),
  sessionId: z.string().min(1),
  actorId: z.string().min(1).optional(),
  mode: z.enum(['session', 'independent']).optional(),
  misfirePolicy: z.enum(['skip', 'coalesce']).optional(),
  maxLatenessSeconds: z.number().int().positive().optional(),
  executionSessionId: z.string().min(1).optional(),
  executionContext: executionContextSchema.optional(),
  disabledReason: z.string().optional(),
  disabledAt: timestamp.optional(),
  disableNotification: disableNotificationSchema.optional(),
  name: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(20_000),
  trigger: scheduleTriggerSchema,
  timezone: z.string().min(1).max(100),
  dstPolicy: z.object({ gap: z.enum(scheduleDstGapPolicies), overlap: z.enum(scheduleDstOverlapPolicies) }).strict(),
  condition: sessionScheduleConditionSchema,
  enabled: z.boolean(),
  deletedAt: timestamp.optional(),
  nextDueAt: timestamp.optional(),
  taskStartOccurrenceId: z.string().optional(),
  /** Acknowledges the exact self-stop CAS, including recovery after an interrupted request acknowledgment. */
  stopRequestId: z.string().optional(),
  /** Durable single execution slot, written before the occurrence itself. */
  pendingOccurrence: z.object({
    id: z.string().min(1), generation: z.number().int().positive(), scheduledForUtc: timestamp,
    triggerSource: z.literal('manual').optional(), actor: executionActorSchema.optional(),
    misfireDecision: z.object({ action: z.enum(['skip', 'run']), misfire: scheduleMisfireSchema.optional() }).strict().optional()
  }).strict().optional(),
  createdAt: timestamp,
  updatedAt: timestamp
}).strict();
export type SessionSchedule = z.infer<typeof sessionScheduleSchema>;

const storedSessionScheduleSchema = sessionScheduleSchema.extend({ trigger: storedScheduleTriggerSchema });
/** Keep old calendar mistakes editable, but revoke automatic and reserved execution on read. */
export function readStoredSessionSchedule(input: unknown): SessionSchedule {
  const schedule = storedSessionScheduleSchema.parse(input);
  if (scheduleTriggerSchema.safeParse(schedule.trigger).success) return schedule;
  return { ...schedule, enabled: false, nextDueAt: undefined, pendingOccurrence: undefined };
}

export const createSessionScheduleInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(20_000),
  trigger: scheduleTriggerSchema,
  timezone: z.string().min(1).max(100),
  dstPolicy: z.object({ gap: z.enum(scheduleDstGapPolicies), overlap: z.enum(scheduleDstOverlapPolicies) }).strict(),
  condition: scheduleConditionInputSchema,
  mode: z.enum(['session', 'independent']).optional(),
  misfirePolicy: z.enum(['skip', 'coalesce']).optional(),
  maxLatenessSeconds: z.number().int().positive().optional()
}).strict();
export type CreateSessionScheduleInput = z.infer<typeof createSessionScheduleInputSchema>;

export const updateSessionScheduleInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  name: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().trim().min(1).max(20_000).optional(),
  trigger: scheduleTriggerSchema.optional(),
  timezone: z.string().min(1).max(100).optional(),
  dstPolicy: z.object({ gap: z.enum(scheduleDstGapPolicies), overlap: z.enum(scheduleDstOverlapPolicies) }).strict().optional(),
  condition: scheduleConditionInputSchema.optional(),
  enabled: z.boolean().optional(),
  misfirePolicy: z.enum(['skip', 'coalesce']).optional(),
  maxLatenessSeconds: z.number().int().positive().nullable().optional()
}).strict().refine(value => Object.keys(value).some(key => key !== 'expectedRevision'), { message: 'At least one field must be updated' });
export type UpdateSessionScheduleInput = z.infer<typeof updateSessionScheduleInputSchema>;

export const runSessionScheduleInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(200)
}).strict();
export type RunSessionScheduleInput = z.infer<typeof runSessionScheduleInputSchema>;
export const deleteSessionScheduleInputSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
export type DeleteSessionScheduleInput = z.infer<typeof deleteSessionScheduleInputSchema>;

export const sessionScheduleOccurrenceV1Schema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  scheduleId: z.string().min(1),
  sessionId: z.string().min(1),
  generation: z.number().int().positive(),
  scheduledForUtc: timestamp,
  conditionStatus: z.enum(['pending', 'passed', 'skipped', 'error', 'invalidated']),
  conditionObservedRunIds: z.array(z.number().int().nonnegative()).max(100).optional(),
  runStatus: z.enum(['pending', 'accepted', 'completed', 'failed', 'interrupted', 'skipped', 'error', 'invalidated']),
  taskId: z.string().optional(),
  taskStartedAt: timestamp.optional(),
  error: z.string().optional(),
  delivery,
  leaseOwner: z.string().optional(),
  leaseExpiresAt: timestamp.optional(),
  createdAt: timestamp,
  updatedAt: timestamp
}).strict();
export type SessionScheduleOccurrenceV1 = z.infer<typeof sessionScheduleOccurrenceV1Schema>;

export const sessionScheduleOccurrenceV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  scheduleId: z.string().min(1),
  sessionId: z.string().min(1),
  generation: z.number().int().positive(),
  scheduledForUtc: timestamp,
  triggerSource: z.literal('manual').optional(),
  conditionStatus: z.enum(['pending', 'passed', 'skipped', 'error', 'invalidated']),
  conditionObservedRunIds: z.array(z.number().int().nonnegative()).max(100).optional(),
  conditionObservedRunAttempts: observedRunAttempts.optional(),
  runStatus: z.enum(['pending', 'accepted', 'completed', 'failed', 'interrupted', 'skipped', 'error', 'invalidated', 'blocked']),
  taskId: z.string().optional(),
  taskStartedAt: timestamp.optional(),
  error: z.string().optional(),
  delivery,
  leaseOwner: z.string().optional(),
  leaseExpiresAt: timestamp.optional(),
  admission: taskAdmissionV1Schema.optional(),
  runtimeAttemptId: z.string().optional(),
  executionSessionId: z.string().optional(),
  acceptedAt: timestamp.optional(),
  misfire: scheduleMisfireSchema.optional(),
  result: attemptResultV1Schema.optional(),
  resultBoundary: z.enum(['verified', 'legacy_output_unresolved']).optional(),
  blockReason: z.enum(automationBlockReasons).optional(),
  actor: executionActorSchema.optional(),
  actorId: z.string().min(1).optional(),
  createdAt: timestamp,
  updatedAt: timestamp
}).strict();
export type SessionScheduleOccurrenceV2 = z.infer<typeof sessionScheduleOccurrenceV2Schema>;

export const sessionScheduleOccurrenceSchema = z.discriminatedUnion('schemaVersion', [
  sessionScheduleOccurrenceV1Schema,
  sessionScheduleOccurrenceV2Schema
]);
export type SessionScheduleOccurrence = SessionScheduleOccurrenceV1 | SessionScheduleOccurrenceV2;

export const ciSubscriptionStatuses = [
  'waiting',
  'dispatching',
  'accepted',
  'completed',
  'cancelled',
  'expired',
  'stale_head',
  'session_inactive',
  'revoked',
  'error',
  'blocked'
] as const;
export type CiSubscriptionStatus = (typeof ciSubscriptionStatuses)[number];

export const ciSubscriptionV1Schema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  sessionId: z.string().min(1),
  actorId: z.string().min(1).optional(),
  /** 缺省表示插件化之前的记录，即 GitHub。 */
  provider: providerId.optional(),
  repository,
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  workflow: z.string().trim().min(1).max(255).optional(),
  prompt: z.string().trim().min(1).max(20_000),
  dispatchPrompt: z.string().trim().min(1).max(70_000).optional(),
  status: z.enum(['waiting', 'dispatching', 'accepted', 'completed', 'cancelled', 'expired', 'stale_head', 'session_inactive', 'revoked', 'error']),
  expiresAt: timestamp,
  nextPollAt: timestamp.optional(),
  taskId: z.string().optional(),
  taskStartedAt: timestamp.optional(),
  error: z.string().optional(),
  completedRunIds: z.array(z.number().int().nonnegative()).max(100).optional(),
  delivery,
  leaseOwner: z.string().optional(),
  leaseExpiresAt: timestamp.optional(),
  createdAt: timestamp,
  updatedAt: timestamp
}).strict();
export type CiSubscriptionV1 = z.infer<typeof ciSubscriptionV1Schema>;

export const ciSubscriptionV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  sessionId: z.string().min(1),
  actorId: z.string().min(1).optional(),
  /** 缺省表示插件化之前的记录，即 GitHub。 */
  provider: providerId.optional(),
  repository,
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  workflow: z.string().trim().min(1).max(255).optional(),
  prompt: z.string().trim().min(1).max(20_000),
  dispatchPrompt: z.string().trim().min(1).max(70_000).optional(),
  status: z.enum(ciSubscriptionStatuses),
  expiresAt: timestamp,
  nextPollAt: timestamp.optional(),
  taskId: z.string().optional(),
  taskStartedAt: timestamp.optional(),
  error: z.string().optional(),
  completedRunIds: z.array(z.number().int().nonnegative()).max(100).optional(),
  delivery,
  leaseOwner: z.string().optional(),
  leaseExpiresAt: timestamp.optional(),
  admission: taskAdmissionV1Schema.optional(),
  runtimeAttemptId: z.string().optional(),
  result: attemptResultV1Schema.optional(),
  resultBoundary: z.enum(['verified', 'legacy_output_unresolved']).optional(),
  blockReason: z.enum(automationBlockReasons).optional(),
  actor: executionActorSchema.optional(),
  createdAt: timestamp,
  updatedAt: timestamp
}).strict();
export type CiSubscriptionV2 = z.infer<typeof ciSubscriptionV2Schema>;

export const ciSubscriptionSchema = z.discriminatedUnion('schemaVersion', [
  ciSubscriptionV1Schema,
  ciSubscriptionV2Schema
]);
export type CiSubscription = CiSubscriptionV1 | CiSubscriptionV2;

export const subscribeCiInputSchema = z.object({
  /** 省略时按工作区 origin 匹配。 */
  provider: providerId.optional(),
  prompt: z.string().trim().min(1).max(20_000).optional(),
  workflow: z.string().trim().min(1).max(255).optional(),
  ttlSeconds: z.number().int().min(60).max(7 * 24 * 60 * 60).default(24 * 60 * 60)
}).strict();
export type SubscribeCiInput = z.input<typeof subscribeCiInputSchema>;

export const cancelCiInputSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
export type CancelCiInput = z.infer<typeof cancelCiInputSchema>;

export type PublicSessionSchedule = Omit<SessionSchedule, 'actorId' | 'dispatchPrompt' | 'taskStartOccurrenceId' | 'pendingOccurrence'>;
export type PublicCiSubscription = Omit<
  CiSubscriptionV2,
  'actorId' | 'actor' | 'dispatchPrompt' | 'taskStartedAt' | 'leaseOwner' | 'leaseExpiresAt' | 'admission'
> & { schemaVersion: 1 | 2 };
export type PublicSessionScheduleOccurrence = Omit<
  SessionScheduleOccurrenceV2,
  'taskStartedAt' | 'leaseOwner' | 'leaseExpiresAt' | 'admission' | 'actor' | 'actorId'
> & { schemaVersion: 1 | 2 };

/** Web 与飞书展示用的已加载 CI 提供方。 */
export interface PublicCiProvider {
  id: string;
  displayName: string;
  /** 能否查询构建状态（等待 CI、「出现新的失败构建」条件）。 */
  polling: boolean;
  /** 是否配置了 webhook（事件驱动的续作与修复）。 */
  webhook: boolean;
}

export type AutomationDeliveryTarget =
  | { kind: 'task'; sessionId: string }
  | { kind: 'lark'; appId: string; chatId: string; replyMessageId: string; replyInThread: boolean }
  | { kind: 'unavailable' };

export interface SessionAutomationList {
  /** Read-only projection of each plan's frozen destination; absent on older instances. */
  deliveryTargets?: Record<string, AutomationDeliveryTarget>;
  schedules: PublicSessionSchedule[];
  subscriptions: PublicCiSubscription[];
  occurrences: PublicSessionScheduleOccurrence[];
}

export type AutomationScheduleHealth = 'blocked' | 'queued' | 'running' | 'delivery' | 'disabled' | 'ready' | 'error';
export interface AutomationScheduleSummary {
  engine: 'session';
  schedule: PublicSessionSchedule;
  session: { id: string; title: string; agentId: string; state: string; archivedAt?: string };
  health: AutomationScheduleHealth;
  latestOccurrence?: PublicSessionScheduleOccurrence;
  blocker?: { sessionId?: string; taskId?: string; attemptId?: string; status: string; waitingSince: string; restricted?: boolean };
  overdue?: { from: string; to: string };
  deliveryTarget?: AutomationDeliveryTarget;
}
export interface AutomationSchedulePage { engine: 'session'; counts: Record<AutomationScheduleHealth, number>; items: AutomationScheduleSummary[]; total: number; offset: number; limit: number }
export interface AutomationScheduleQuery {
  offset?: number; limit?: number; name?: string; sessionId?: string; agentId?: string;
  enabled?: boolean; health?: AutomationScheduleHealth; sort?: 'attention' | 'due' | 'name';
}
export interface AutomationHistoryPage { occurrences: PublicSessionScheduleOccurrence[]; total: number; offset: number; limit: number }
export interface AutomationRunDetail {
  schedule: PublicSessionSchedule;
  occurrence: PublicSessionScheduleOccurrence;
  input?: { prompt: string; cwd?: string; agentId?: string; model?: string; permissionMode?: string };
  attempts: Array<{
    attemptId: string; taskId: string; number: number; state: string; outcome?: string; createdAt: string; updatedAt: string;
    manualRetry?: { causeAttemptId: string; decisionId: string };
    automaticRetry?: { causeAttemptId: string; reason: string };
    decision?: { decisionId: string; actor: ExecutionActor; action: string; evidenceRefs: string[] };
  }>;
  times: { scheduledForUtc: string; discoveredAt: string; acceptedAt?: string; startedAt?: string; settledAt?: string; deliveryUpdatedAt: string };
  executionSessionId: string;
  sourceSessionId: string;
}

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

export function previewSessionSchedule(schedule: Pick<SessionSchedule, 'id' | 'name' | 'trigger' | 'timezone' | 'dstPolicy'>, after: Date) {
  return previewNextSchedule(asPreviewDefinition(schedule), after);
}
