import { z } from 'zod';
import { scheduleTriggerSchema, scheduleDstGapPolicies, scheduleDstOverlapPolicies } from './schedule-foundation.js';
import {
  attemptResultV1Schema,
  executionActorSchema,
  taskAdmissionV1Schema,
  type AttemptResultV1,
  type ExecutionActor,
  type TaskAdmissionV1
} from './task-execution.js';

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

export const sessionScheduleConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('always') }).strict(),
  z.object({
    kind: z.literal('github_new_failure'),
    workflow: z.string().trim().min(1).max(255).optional(),
    repository,
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
    observedRunIds: z.array(z.number().int().nonnegative()).max(100)
  }).strict()
]);
export type SessionScheduleCondition = z.infer<typeof sessionScheduleConditionSchema>;

export const sessionScheduleSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  generation: z.number().int().positive(),
  sessionId: z.string().min(1),
  actorId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(20_000),
  trigger: scheduleTriggerSchema,
  timezone: z.string().min(1).max(100),
  dstPolicy: z.object({ gap: z.enum(scheduleDstGapPolicies), overlap: z.enum(scheduleDstOverlapPolicies) }).strict(),
  condition: sessionScheduleConditionSchema,
  enabled: z.boolean(),
  nextDueAt: timestamp.optional(),
  taskStartOccurrenceId: z.string().optional(),
  createdAt: timestamp,
  updatedAt: timestamp
}).strict();
export type SessionSchedule = z.infer<typeof sessionScheduleSchema>;

export const createSessionScheduleInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(20_000),
  trigger: scheduleTriggerSchema,
  timezone: z.string().min(1).max(100),
  dstPolicy: z.object({ gap: z.enum(scheduleDstGapPolicies), overlap: z.enum(scheduleDstOverlapPolicies) }).strict(),
  condition: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('always') }).strict(),
    z.object({ kind: z.literal('github_new_failure'), workflow: z.string().trim().min(1).max(255).optional() }).strict()
  ])
}).strict();
export type CreateSessionScheduleInput = z.infer<typeof createSessionScheduleInputSchema>;

export const updateSessionScheduleInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  name: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().trim().min(1).max(20_000).optional(),
  trigger: scheduleTriggerSchema.optional(),
  timezone: z.string().min(1).max(100).optional(),
  dstPolicy: z.object({ gap: z.enum(scheduleDstGapPolicies), overlap: z.enum(scheduleDstOverlapPolicies) }).strict().optional(),
  condition: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('always') }).strict(),
    z.object({ kind: z.literal('github_new_failure'), workflow: z.string().trim().min(1).max(255).optional() }).strict()
  ]).optional(),
  enabled: z.boolean().optional()
}).strict().refine(value => Object.keys(value).some(key => key !== 'expectedRevision'), { message: 'At least one field must be updated' });
export type UpdateSessionScheduleInput = z.infer<typeof updateSessionScheduleInputSchema>;

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
  conditionStatus: z.enum(['pending', 'passed', 'skipped', 'error', 'invalidated']),
  conditionObservedRunIds: z.array(z.number().int().nonnegative()).max(100).optional(),
  runStatus: z.enum(['pending', 'accepted', 'completed', 'failed', 'interrupted', 'skipped', 'error', 'invalidated', 'blocked']),
  taskId: z.string().optional(),
  taskStartedAt: timestamp.optional(),
  error: z.string().optional(),
  delivery,
  leaseOwner: z.string().optional(),
  leaseExpiresAt: timestamp.optional(),
  admission: taskAdmissionV1Schema.optional(),
  runtimeAttemptId: z.string().optional(),
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
  prompt: z.string().trim().min(1).max(20_000).optional(),
  workflow: z.string().trim().min(1).max(255).optional(),
  ttlSeconds: z.number().int().min(60).max(7 * 24 * 60 * 60).default(24 * 60 * 60)
}).strict();
export type SubscribeCiInput = z.input<typeof subscribeCiInputSchema>;

export const cancelCiInputSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
export type CancelCiInput = z.infer<typeof cancelCiInputSchema>;

export type PublicSessionSchedule = Omit<SessionSchedule, 'actorId' | 'dispatchPrompt' | 'taskStartOccurrenceId'>;
export type PublicCiSubscription = Omit<
  CiSubscriptionV2,
  'actorId' | 'actor' | 'dispatchPrompt' | 'taskStartedAt' | 'leaseOwner' | 'leaseExpiresAt' | 'admission'
> & { schemaVersion: 1 | 2 };
export type PublicSessionScheduleOccurrence = Omit<
  SessionScheduleOccurrenceV2,
  'taskStartedAt' | 'leaseOwner' | 'leaseExpiresAt' | 'admission' | 'actor' | 'actorId'
> & { schemaVersion: 1 | 2 };

export interface SessionAutomationList {
  schedules: PublicSessionSchedule[];
  subscriptions: PublicCiSubscription[];
  occurrences: PublicSessionScheduleOccurrence[];
}
