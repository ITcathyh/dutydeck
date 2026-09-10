import { z } from 'zod';

const utcTimestamp = z.string().datetime({ offset: true });
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/, 'Expected a local ISO date-time without an offset');

export const scheduleDefinitionStates = ['staged', 'disabled'] as const;
export const scheduleOwnerships = ['dutydeck', 'botmux'] as const;
export const scheduleDstGapPolicies = ['skip', 'shift_forward'] as const;
export const scheduleDstOverlapPolicies = ['first', 'second'] as const;

export const scheduleTriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('at'), localDateTime }).strict(),
  z.object({ kind: z.literal('interval'), everySeconds: z.number().int().min(60), anchorAt: utcTimestamp }).strict(),
  z.object({ kind: z.literal('cron'), expression: z.string().trim().min(9).max(256) }).strict()
]);
export type ScheduleTrigger = z.infer<typeof scheduleTriggerSchema>;

export const scheduleDeliverySchema = z.object({
  mode: z.enum(['chat', 'thread']),
  chatRef: z.string().min(1),
  rootMessageRef: z.string().min(1).optional(),
  continuation: z.enum(['same_thread', 'new_topic', 'chat_root'])
}).strict().superRefine((value, context) => {
  if (value.mode === 'thread' && !value.rootMessageRef) context.addIssue({ code: z.ZodIssueCode.custom, path: ['rootMessageRef'], message: 'Thread delivery requires a root message reference' });
});
export type ScheduleDelivery = z.infer<typeof scheduleDeliverySchema>;

export const scheduleDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  channelBotId: z.string().min(1),
  groupBindingId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2_000).optional(),
  trigger: scheduleTriggerSchema,
  timezone: z.string().min(1).max(100),
  dstPolicy: z.object({ gap: z.enum(scheduleDstGapPolicies), overlap: z.enum(scheduleDstOverlapPolicies) }).strict(),
  delivery: scheduleDeliverySchema,
  cwdRef: z.string().min(1).optional(),
  payloadRef: z.string().min(1),
  identityRef: z.string().min(1).optional(),
  secretRef: z.string().min(1).optional(),
  sourceOwnership: z.enum(scheduleOwnerships),
  sourceNamespace: z.string().min(1),
  sourceScheduleRef: z.string().min(1).optional(),
  sourceEnabled: z.boolean(),
  state: z.enum(scheduleDefinitionStates),
  desiredExecutorState: z.literal('disabled'),
  currentGeneration: z.number().int().positive(),
  createdAt: utcTimestamp,
  updatedAt: utcTimestamp
}).strict();
export type ScheduleDefinition = z.infer<typeof scheduleDefinitionSchema>;

export const createScheduleDefinitionInputSchema = scheduleDefinitionSchema.pick({
  id: true, channelBotId: true, groupBindingId: true, name: true, description: true, trigger: true,
  timezone: true, dstPolicy: true, delivery: true, cwdRef: true, payloadRef: true, identityRef: true,
  secretRef: true, sourceOwnership: true, sourceNamespace: true, sourceScheduleRef: true, sourceEnabled: true
}).strict();
export type CreateScheduleDefinitionInput = z.infer<typeof createScheduleDefinitionInputSchema>;

export const updateScheduleDefinitionInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2_000).nullable().optional(),
  trigger: scheduleTriggerSchema.optional(),
  timezone: z.string().min(1).max(100).optional(),
  dstPolicy: z.object({ gap: z.enum(scheduleDstGapPolicies), overlap: z.enum(scheduleDstOverlapPolicies) }).strict().optional(),
  delivery: scheduleDeliverySchema.optional(),
  cwdRef: z.string().min(1).nullable().optional(),
  payloadRef: z.string().min(1).optional(),
  identityRef: z.string().min(1).nullable().optional(),
  secretRef: z.string().min(1).nullable().optional(),
  state: z.enum(scheduleDefinitionStates).optional()
}).strict().refine(value => Object.keys(value).some(key => key !== 'expectedRevision'), { message: 'At least one field must be updated' });
export type UpdateScheduleDefinitionInput = z.infer<typeof updateScheduleDefinitionInputSchema>;

export const scheduleGenerationSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  scheduleDefinitionId: z.string().min(1),
  generation: z.number().int().positive(),
  definitionRevision: z.number().int().positive(),
  definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  timezone: z.string().min(1),
  identityRef: z.string().min(1).optional(),
  secretRef: z.string().min(1).optional(),
  state: z.literal('staged_disabled'),
  createdAt: utcTimestamp
}).strict();
export type ScheduleGeneration = z.infer<typeof scheduleGenerationSchema>;

export const scheduleOccurrenceStates = ['planned', 'source_owned_pending', 'settled', 'suppressed'] as const;
export const scheduleOccurrenceSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  scheduleDefinitionId: z.string().min(1),
  scheduleGenerationId: z.string().min(1),
  generation: z.number().int().positive(),
  scheduledForUtc: utcTimestamp,
  idempotencyKey: z.string().regex(/^occ_[a-f0-9]{64}$/),
  state: z.enum(scheduleOccurrenceStates),
  intentKind: z.literal('task_run_snapshot'),
  createdAt: utcTimestamp,
  updatedAt: utcTimestamp
}).strict();
export type ScheduleOccurrence = z.infer<typeof scheduleOccurrenceSchema>;

export const scheduleWatermarkSchema = z.object({
  schemaVersion: z.literal(1),
  scheduleDefinitionId: z.string().min(1),
  revision: z.number().int().positive(),
  lastPlannedOccurrenceKey: z.string().optional(),
  lastClaimedOccurrenceKey: z.string().optional(),
  lastStartedOccurrenceKey: z.string().optional(),
  lastSettledOccurrenceKey: z.string().optional(),
  nextDueAt: utcTimestamp.optional(),
  updatedAt: utcTimestamp
}).strict();
export type ScheduleWatermark = z.infer<typeof scheduleWatermarkSchema>;

export const scheduleLeaseStates = ['held', 'fenced', 'released'] as const;
export const scheduleLeaseSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  leaseKey: z.string().min(1),
  generation: z.number().int().nonnegative(),
  holderId: z.string().min(1).optional(),
  holderIdentityRef: z.string().min(1).optional(),
  secretRef: z.string().min(1).optional(),
  state: z.enum(scheduleLeaseStates),
  scheduleSetHash: z.string().regex(/^[a-f0-9]{64}$/),
  fenceToken: z.number().int().nonnegative(),
  renewedAt: utcTimestamp.optional(),
  expiresAt: utcTimestamp.optional(),
  createdAt: utcTimestamp,
  updatedAt: utcTimestamp
}).strict();
export type ScheduleLease = z.infer<typeof scheduleLeaseSchema>;

export const acquireScheduleLeaseInputSchema = z.object({
  id: z.string().min(1),
  leaseKey: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  expectedGeneration: z.number().int().nonnegative(),
  holderId: z.string().min(1),
  holderIdentityRef: z.string().min(1),
  secretRef: z.string().min(1),
  scheduleSetHash: z.string().regex(/^[a-f0-9]{64}$/),
  now: utcTimestamp,
  ttlMs: z.number().int().min(1_000).max(86_400_000)
}).strict();
export type AcquireScheduleLeaseInput = z.infer<typeof acquireScheduleLeaseInputSchema>;

export const renewScheduleLeaseInputSchema = z.object({
  expectedRevision: z.number().int().positive(), expectedGeneration: z.number().int().positive(),
  expectedFenceToken: z.number().int().nonnegative(), holderId: z.string().min(1), now: utcTimestamp,
  ttlMs: z.number().int().min(1_000).max(86_400_000)
}).strict();
export type RenewScheduleLeaseInput = z.infer<typeof renewScheduleLeaseInputSchema>;

export const fenceScheduleLeaseInputSchema = z.object({
  expectedRevision: z.number().int().positive(), expectedGeneration: z.number().int().nonnegative(),
  expectedFenceToken: z.number().int().nonnegative(), now: utcTimestamp
}).strict();
export type FenceScheduleLeaseInput = z.infer<typeof fenceScheduleLeaseInputSchema>;

export const archivedHammerIntegrationSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().min(1), revision: z.number().int().positive(),
  channelBotId: z.string().min(1), kind: z.literal('hammer'), sourceSystem: z.literal('botmux'),
  sourceEnabled: z.boolean(), mode: z.enum(['full', 'lite', 'unknown']), enforceGates: z.boolean(),
  skillsInjection: z.enum(['prompt', 'runtime', 'none', 'unknown']), state: z.literal('archived'),
  executorState: z.literal('unavailable'), blockerCode: z.literal('hammer_executor_unavailable'),
  createdAt: utcTimestamp, updatedAt: utcTimestamp
}).strict();
export type ArchivedHammerIntegration = z.infer<typeof archivedHammerIntegrationSchema>;

export const createArchivedHammerIntegrationInputSchema = archivedHammerIntegrationSchema.pick({
  id: true, channelBotId: true, sourceEnabled: true, mode: true, enforceGates: true, skillsInjection: true
}).strict();
export type CreateArchivedHammerIntegrationInput = z.infer<typeof createArchivedHammerIntegrationInputSchema>;

export const scheduleBlockerCodes = [
  'schedule_staged_disabled', 'schedule_generation_missing', 'schedule_generation_stale', 'schedule_lease_required',
  'schedule_lease_not_held', 'schedule_lease_expired', 'schedule_identity_required', 'schedule_identity_mismatch',
  'schedule_secret_ref_required', 'schedule_secret_ref_invalid', 'schedule_secret_ref_mismatch',
  'botmux_source_schedule_enabled', 'schedule_executor_unavailable'
] as const;
export type ScheduleBlockerCode = typeof scheduleBlockerCodes[number];
export interface ScheduleBlocker { code: ScheduleBlockerCode; message: string; action: string }

export interface ScheduleReadiness {
  executionEligible: false;
  nextOccurrence?: SchedulePreview;
  blockers: ScheduleBlocker[];
}

export interface SchedulePreview {
  scheduledForUtc: string;
  localLabel: string;
  timezone: string;
  dstResolution: 'exact' | 'gap_shifted' | 'overlap_first' | 'overlap_second';
}

export interface ScheduleTaskRunIntent {
  schemaVersion: 1;
  kind: 'task_run_snapshot_intent';
  idempotencyKey: string;
  scheduleDefinitionId: string;
  scheduleGenerationId: string;
  generation: number;
  scheduledForUtc: string;
  task: { source: 'schedule'; payloadRef: string; status: 'intent_only' };
  runSnapshot: {
    sourceKind: 'schedule';
    sourceDefinitionRevision: number;
    sourceGeneration: number;
    channelBotId: string;
    groupBindingId?: string;
    identityRef?: string;
    secretRef?: string;
  };
  dispatchAllowed: false;
  blockerCodes: ScheduleBlockerCode[];
}

export interface ScheduleDefinitionRepository {
  list(limit?: number): Promise<ScheduleDefinition[]>;
  get(id: string): Promise<ScheduleDefinition | undefined>;
  create(input: CreateScheduleDefinitionInput): Promise<ScheduleDefinition>;
  update(id: string, input: UpdateScheduleDefinitionInput): Promise<ScheduleDefinition>;
  rollbackLast(id: string, expectedRevision: number): Promise<ScheduleDefinition>;
  readiness(id: string, now?: string): Promise<ScheduleReadiness>;
}
export interface ScheduleGenerationRepository { get(id: string): Promise<ScheduleGeneration | undefined>; listByDefinition(id: string, limit?: number): Promise<ScheduleGeneration[]> }
export interface ScheduleOccurrenceRepository {
  get(id: string): Promise<ScheduleOccurrence | undefined>;
  listByDefinition(id: string, limit?: number): Promise<ScheduleOccurrence[]>;
  recordPlanned(definitionId: string, scheduledForUtc: string, nextDueAt?: string): Promise<{ occurrence: ScheduleOccurrence; created: boolean }>;
}
export interface ScheduleWatermarkRepository { get(definitionId: string): Promise<ScheduleWatermark | undefined> }
export interface ScheduleLeaseRepository {
  getByKey(leaseKey: string): Promise<ScheduleLease | undefined>;
  acquire(input: AcquireScheduleLeaseInput): Promise<ScheduleLease>;
  renew(leaseKey: string, input: RenewScheduleLeaseInput): Promise<ScheduleLease>;
  fence(leaseKey: string, input: FenceScheduleLeaseInput): Promise<ScheduleLease>;
}
export interface ArchivedHammerIntegrationRepository {
  listByChannelBot(channelBotId: string, limit?: number): Promise<ArchivedHammerIntegration[]>;
  create(input: CreateArchivedHammerIntegrationInput): Promise<ArchivedHammerIntegration>;
}

function isValidTimezone(timezone: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0)); return true; }
  catch { return false; }
}

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number }
const weekdayByShort: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function zonedParts(date: Date, timezone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second), weekday: weekdayByShort[parts.weekday ?? 'Sun'] ?? 0 };
}

function localEpoch(parts: Omit<LocalParts, 'weekday'>): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}
function parseLocal(value: string): Omit<LocalParts, 'weekday'> {
  const [date = '', time = ''] = value.split('T');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute, second = 0] = time.split(':').map(Number);
  return { year: year!, month: month!, day: day!, hour: hour!, minute: minute!, second: second! };
}
function sameLocal(left: Omit<LocalParts, 'weekday'>, right: LocalParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day && left.hour === right.hour && left.minute === right.minute && left.second === right.second;
}

function resolveLocal(parts: Omit<LocalParts, 'weekday'>, timezone: string): Date[] {
  const naive = localEpoch(parts);
  const offsets = new Set<number>();
  for (let minutes = -2_160; minutes <= 2_160; minutes += 30) {
    const instant = new Date(naive + minutes * 60_000);
    const local = zonedParts(instant, timezone);
    offsets.add(localEpoch(local) - instant.getTime());
  }
  return [...offsets]
    .map(offset => new Date(naive - offset))
    .filter(candidate => sameLocal(parts, zonedParts(candidate, timezone)))
    .sort((left, right) => left.getTime() - right.getTime());
}

function label(parts: Omit<LocalParts, 'weekday'>): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

function resolveWithDst(parts: Omit<LocalParts, 'weekday'>, definition: ScheduleDefinition): SchedulePreview | undefined {
  let candidates = resolveLocal(parts, definition.timezone);
  let resolution: SchedulePreview['dstResolution'] = 'exact';
  let resolvedParts = parts;
  if (candidates.length === 0) {
    if (definition.dstPolicy.gap === 'skip') return undefined;
    for (let minute = 1; minute <= 180 && candidates.length === 0; minute += 1) {
      const shifted = new Date(localEpoch(parts) + minute * 60_000);
      resolvedParts = { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(), second: shifted.getUTCSeconds() };
      candidates = resolveLocal(resolvedParts, definition.timezone);
    }
    if (candidates.length === 0) return undefined;
    resolution = 'gap_shifted';
  } else if (candidates.length > 1) {
    resolution = definition.dstPolicy.overlap === 'first' ? 'overlap_first' : 'overlap_second';
  }
  const selected = candidates[definition.dstPolicy.overlap === 'second' && candidates.length > 1 ? candidates.length - 1 : 0]!;
  return { scheduledForUtc: selected.toISOString(), localLabel: label(resolvedParts), timezone: definition.timezone, dstResolution: resolution };
}

interface CronMatcher { minute: Set<number>; hour: Set<number>; day: Set<number>; month: Set<number>; weekday: Set<number>; dayWildcard: boolean; weekdayWildcard: boolean }
function cronField(raw: string, minimum: number, maximum: number, sunday = false): Set<number> {
  const values = new Set<number>();
  for (const item of raw.split(',')) {
    const [rangeRaw = '', stepRaw] = item.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isSafeInteger(step) || step < 1) throw new Error('Invalid cron step');
    const [start, end] = rangeRaw === '*' ? [minimum, maximum] : rangeRaw.includes('-') ? rangeRaw.split('-').map(Number) : [Number(rangeRaw), Number(rangeRaw)];
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start! < minimum || end! > maximum || start! > end!) throw new Error('Invalid cron range');
    for (let value = start!; value <= end!; value += step) values.add(sunday && value === 7 ? 0 : value);
  }
  return values;
}
function parseCron(expression: string): CronMatcher {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Cron expressions must contain five fields');
  return { minute: cronField(fields[0]!, 0, 59), hour: cronField(fields[1]!, 0, 23), day: cronField(fields[2]!, 1, 31), month: cronField(fields[3]!, 1, 12), weekday: cronField(fields[4]!, 0, 7, true), dayWildcard: fields[2] === '*', weekdayWildcard: fields[4] === '*' };
}
function cronMatches(matcher: CronMatcher, parts: LocalParts): boolean {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const weekday = date.getUTCDay();
  const dayMatch = matcher.day.has(parts.day);
  const weekdayMatch = matcher.weekday.has(weekday);
  const calendarDay = matcher.dayWildcard ? weekdayMatch : matcher.weekdayWildcard ? dayMatch : dayMatch || weekdayMatch;
  return matcher.minute.has(parts.minute) && matcher.hour.has(parts.hour) && matcher.month.has(parts.month) && calendarDay;
}

export function previewNextSchedule(definition: ScheduleDefinition, after = new Date()): SchedulePreview | undefined {
  scheduleDefinitionSchema.parse(definition);
  if (!isValidTimezone(definition.timezone)) throw new Error('Invalid IANA timezone');
  if (definition.trigger.kind === 'interval') {
    const anchor = new Date(definition.trigger.anchorAt).getTime();
    const everyMs = definition.trigger.everySeconds * 1_000;
    const next = after.getTime() < anchor ? anchor : anchor + (Math.floor((after.getTime() - anchor) / everyMs) + 1) * everyMs;
    const instant = new Date(next);
    const parts = zonedParts(instant, definition.timezone);
    return { scheduledForUtc: instant.toISOString(), localLabel: label(parts), timezone: definition.timezone, dstResolution: 'exact' };
  }
  if (definition.trigger.kind === 'at') {
    const preview = resolveWithDst(parseLocal(definition.trigger.localDateTime), definition);
    return preview && new Date(preview.scheduledForUtc) > after ? preview : undefined;
  }
  const matcher = parseCron(definition.trigger.expression);
  const afterLocal = zonedParts(after, definition.timezone);
  let cursor = new Date(Date.UTC(afterLocal.year, afterLocal.month - 1, afterLocal.day, afterLocal.hour, afterLocal.minute, 0) + 60_000);
  const limit = cursor.getTime() + 2 * 366 * 24 * 60 * 60_000;
  while (cursor.getTime() <= limit) {
    const local: LocalParts = { year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1, day: cursor.getUTCDate(), hour: cursor.getUTCHours(), minute: cursor.getUTCMinutes(), second: 0, weekday: cursor.getUTCDay() };
    if (cronMatches(matcher, local)) {
      const preview = resolveWithDst(local, definition);
      if (preview && new Date(preview.scheduledForUtc) > after) return preview;
    }
    cursor = new Date(cursor.getTime() + 60_000);
  }
  return undefined;
}

export function scheduleReadiness(
  definition: ScheduleDefinition,
  generation: ScheduleGeneration | undefined,
  lease: ScheduleLease | undefined,
  secretStatus: 'configured' | 'invalid' | 'missing',
  now = new Date()
): ScheduleReadiness {
  const blockers: ScheduleBlocker[] = [];
  const add = (code: ScheduleBlockerCode, message: string, action: string) => blockers.push({ code, message, action });
  add('schedule_staged_disabled', 'Schedule is staged and disabled', 'Review the definition; this foundation cannot enable it');
  if (!generation) add('schedule_generation_missing', 'No immutable generation is pinned', 'Create a disabled generation from the current revision');
  else if (generation.generation !== definition.currentGeneration || generation.definitionRevision !== definition.revision) add('schedule_generation_stale', 'Pinned generation does not match the current definition revision', 'Create a new disabled generation');
  if (!definition.identityRef) add('schedule_identity_required', 'A validated App identity reference is required', 'Complete identity preflight and attach its reference');
  else if (generation?.identityRef !== definition.identityRef) add('schedule_identity_mismatch', 'Generation identity pin differs from the definition', 'Create a new generation after identity validation');
  if (!definition.secretRef) add('schedule_secret_ref_required', 'A SecretRef is required', 'Attach configured SecretRef metadata without exposing its value');
  else if (secretStatus !== 'configured') add('schedule_secret_ref_invalid', 'The referenced SecretRef is unavailable or invalid', 'Repair SecretRef metadata');
  else if (generation?.secretRef !== definition.secretRef) add('schedule_secret_ref_mismatch', 'Generation SecretRef pin differs from the definition', 'Create a new generation after fixing SecretRef');
  if (!lease) add('schedule_lease_required', 'No Schedule writer lease exists', 'Establish externally fenced single-writer ownership');
  else if (lease.state !== 'held') add('schedule_lease_not_held', 'Schedule writer lease is not held', 'Keep execution blocked until a fenced holder is established');
  else if (!lease.expiresAt || new Date(lease.expiresAt) <= now) add('schedule_lease_expired', 'Schedule writer lease is expired', 'Renew using matching revision, generation and fence token');
  if (definition.sourceOwnership === 'botmux' && definition.sourceEnabled) add('botmux_source_schedule_enabled', 'Botmux still owns an enabled source Schedule', 'Fence and drain the source writer before any future handoff');
  add('schedule_executor_unavailable', 'Schedule executor has not been implemented', 'Keep this definition disabled until a separately reviewed executor exists');
  let nextOccurrence: SchedulePreview | undefined;
  try { nextOccurrence = previewNextSchedule(definition, now); } catch { /* surfaced as no preview by the management layer */ }
  return { executionEligible: false, ...(nextOccurrence ? { nextOccurrence } : {}), blockers };
}

export function buildScheduleTaskRunIntent(definition: ScheduleDefinition, generation: ScheduleGeneration, occurrence: ScheduleOccurrence, blockers: ScheduleBlocker[]): ScheduleTaskRunIntent {
  return {
    schemaVersion: 1, kind: 'task_run_snapshot_intent', idempotencyKey: occurrence.idempotencyKey,
    scheduleDefinitionId: definition.id, scheduleGenerationId: generation.id, generation: generation.generation,
    scheduledForUtc: occurrence.scheduledForUtc,
    task: { source: 'schedule', payloadRef: definition.payloadRef, status: 'intent_only' },
    runSnapshot: { sourceKind: 'schedule', sourceDefinitionRevision: generation.definitionRevision, sourceGeneration: generation.generation, channelBotId: definition.channelBotId, ...(definition.groupBindingId ? { groupBindingId: definition.groupBindingId } : {}), ...(generation.identityRef ? { identityRef: generation.identityRef } : {}), ...(generation.secretRef ? { secretRef: generation.secretRef } : {}) },
    dispatchAllowed: false,
    blockerCodes: blockers.map(blocker => blocker.code)
  };
}
