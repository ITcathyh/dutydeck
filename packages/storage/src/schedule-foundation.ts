import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  RuntimeError,
  acquireScheduleLeaseInputSchema,
  archivedHammerIntegrationSchema,
  createArchivedHammerIntegrationInputSchema,
  createScheduleDefinitionInputSchema,
  fenceScheduleLeaseInputSchema,
  previewNextSchedule,
  renewScheduleLeaseInputSchema,
  scheduleDefinitionSchema,
  scheduleGenerationSchema,
  scheduleLeaseSchema,
  scheduleOccurrenceSchema,
  scheduleReadiness,
  scheduleWatermarkSchema,
  updateScheduleDefinitionInputSchema,
  type AcquireScheduleLeaseInput,
  type ArchivedHammerIntegration,
  type ArchivedHammerIntegrationRepository,
  type CreateArchivedHammerIntegrationInput,
  type CreateScheduleDefinitionInput,
  type FenceScheduleLeaseInput,
  type ScheduleDefinition,
  type ScheduleExecutionFence,
  type ScheduleDefinitionRepository,
  type ScheduleGeneration,
  type ScheduleGenerationRepository,
  type ScheduleLease,
  type ScheduleLeaseRepository,
  type ScheduleOccurrence,
  type ScheduleOccurrenceRepository,
  type ScheduleWatermark,
  type ScheduleWatermarkRepository,
  type RenewScheduleLeaseInput,
  type UpdateScheduleDefinitionInput
} from '@dutydeck/shared';

type ScheduleVersionKind = 'schedule_definition' | 'schedule_lease' | 'archived_integration';
type Versioned = ScheduleDefinition | ScheduleLease | ArchivedHammerIntegration;

interface DefinitionRow {
  id: string; schema_version: number; revision: number; channel_bot_id: string; group_binding_id: string | null;
  name: string; description: string | null; trigger_kind: string; at_local_datetime: string | null; interval_seconds: number | null;
  interval_anchor_at: string | null; cron_expression: string | null; timezone: string; dst_gap_policy: string; dst_overlap_policy: string;
  delivery_mode: string; chat_ref: string; root_message_ref: string | null; continuation_policy: string; cwd_ref: string | null;
  payload_ref: string; identity_ref: string | null; secret_ref: string | null; source_ownership: string; source_namespace: string;
  source_schedule_ref: string | null; source_enabled: number; state: string; desired_executor_state: string; current_generation: number;
  created_at: string; updated_at: string;
}
interface GenerationRow { id: string; schema_version: number; schedule_definition_id: string; generation: number; definition_revision: number; definition_hash: string; timezone: string; identity_ref: string | null; secret_ref: string | null; state: string; created_at: string }
interface OccurrenceRow { lease_key?: string | null; lease_fence_token?: number | null; holder_id?: string | null; error?: string | null; id: string; schema_version: number; revision: number; schedule_definition_id: string; schedule_generation_id: string; generation: number; scheduled_for_utc: string; idempotency_key: string; state: string; intent_kind: string; created_at: string; updated_at: string }
interface WatermarkRow { schedule_definition_id: string; schema_version: number; revision: number; last_planned_occurrence_key: string | null; last_claimed_occurrence_key: string | null; last_started_occurrence_key: string | null; last_settled_occurrence_key: string | null; next_due_at: string | null; updated_at: string }
interface LeaseRow { id: string; schema_version: number; revision: number; lease_key: string; generation: number; holder_id: string | null; holder_identity_ref: string | null; secret_ref: string | null; state: string; schedule_set_hash: string; fence_token: number; renewed_at: string | null; expires_at: string | null; created_at: string; updated_at: string }
interface HammerRow { id: string; schema_version: number; revision: number; channel_bot_id: string; kind: string; source_system: string; source_enabled: number; hammer_mode: string; enforce_gates: number; skills_injection: string; state: string; executor_state: string; blocker_code: string; created_at: string; updated_at: string }
interface VersionRow { before_json: string | null; after_hash: string }

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bounded = (limit = 200) => Math.max(1, Math.min(500, Number.isFinite(limit) ? Math.trunc(limit) : 200));
export const scheduleWriterLeaseKey = (channelBotId: string) => `schedule_writer:${channelBotId}`;

function triggerFromRow(row: DefinitionRow): ScheduleDefinition['trigger'] {
  if (row.trigger_kind === 'at') return { kind: 'at', localDateTime: row.at_local_datetime! };
  if (row.trigger_kind === 'interval') return { kind: 'interval', everySeconds: row.interval_seconds!, anchorAt: row.interval_anchor_at! };
  return { kind: 'cron', expression: row.cron_expression! };
}
function decodeDefinition(row: DefinitionRow): ScheduleDefinition {
  return scheduleDefinitionSchema.parse({
    schemaVersion: row.schema_version, id: row.id, revision: row.revision, channelBotId: row.channel_bot_id,
    groupBindingId: row.group_binding_id ?? undefined, name: row.name, description: row.description ?? undefined,
    trigger: triggerFromRow(row), timezone: row.timezone, dstPolicy: { gap: row.dst_gap_policy, overlap: row.dst_overlap_policy },
    delivery: { mode: row.delivery_mode, chatRef: row.chat_ref, rootMessageRef: row.root_message_ref ?? undefined, continuation: row.continuation_policy },
    cwdRef: row.cwd_ref ?? undefined, payloadRef: row.payload_ref, identityRef: row.identity_ref ?? undefined,
    secretRef: row.secret_ref ?? undefined, sourceOwnership: row.source_ownership, sourceNamespace: row.source_namespace,
    sourceScheduleRef: row.source_schedule_ref ?? undefined, sourceEnabled: Boolean(row.source_enabled), state: row.state,
    desiredExecutorState: row.desired_executor_state, currentGeneration: row.current_generation,
    createdAt: row.created_at, updatedAt: row.updated_at
  });
}
function decodeGeneration(row: GenerationRow): ScheduleGeneration {
  return scheduleGenerationSchema.parse({ schemaVersion: row.schema_version, id: row.id, scheduleDefinitionId: row.schedule_definition_id, generation: row.generation, definitionRevision: row.definition_revision, definitionHash: row.definition_hash, timezone: row.timezone, identityRef: row.identity_ref ?? undefined, secretRef: row.secret_ref ?? undefined, state: row.state, createdAt: row.created_at });
}
function decodeOccurrence(row: OccurrenceRow): ScheduleOccurrence {
  return scheduleOccurrenceSchema.parse({ schemaVersion: row.schema_version, id: row.id, revision: row.revision, scheduleDefinitionId: row.schedule_definition_id, scheduleGenerationId: row.schedule_generation_id, generation: row.generation, scheduledForUtc: row.scheduled_for_utc, idempotencyKey: row.idempotency_key, state: row.state, intentKind: row.intent_kind, leaseKey: row.lease_key ?? undefined, leaseFenceToken: row.lease_fence_token ?? undefined, holderId: row.holder_id ?? undefined, error: row.error ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at });
}
function decodeWatermark(row: WatermarkRow): ScheduleWatermark {
  return scheduleWatermarkSchema.parse({ schemaVersion: row.schema_version, scheduleDefinitionId: row.schedule_definition_id, revision: row.revision, lastPlannedOccurrenceKey: row.last_planned_occurrence_key ?? undefined, lastClaimedOccurrenceKey: row.last_claimed_occurrence_key ?? undefined, lastStartedOccurrenceKey: row.last_started_occurrence_key ?? undefined, lastSettledOccurrenceKey: row.last_settled_occurrence_key ?? undefined, nextDueAt: row.next_due_at ?? undefined, updatedAt: row.updated_at });
}
function decodeLease(row: LeaseRow): ScheduleLease {
  return scheduleLeaseSchema.parse({ schemaVersion: row.schema_version, id: row.id, revision: row.revision, leaseKey: row.lease_key, generation: row.generation, holderId: row.holder_id ?? undefined, holderIdentityRef: row.holder_identity_ref ?? undefined, secretRef: row.secret_ref ?? undefined, state: row.state, scheduleSetHash: row.schedule_set_hash, fenceToken: row.fence_token, renewedAt: row.renewed_at ?? undefined, expiresAt: row.expires_at ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at });
}
function decodeHammer(row: HammerRow): ArchivedHammerIntegration {
  return archivedHammerIntegrationSchema.parse({ schemaVersion: row.schema_version, id: row.id, revision: row.revision, channelBotId: row.channel_bot_id, kind: row.kind, sourceSystem: row.source_system, sourceEnabled: Boolean(row.source_enabled), mode: row.hammer_mode, enforceGates: Boolean(row.enforce_gates), skillsInjection: row.skills_injection, state: row.state, executorState: row.executor_state, blockerCode: row.blocker_code, createdAt: row.created_at, updatedAt: row.updated_at });
}

function definitionSemantic(definition: ScheduleDefinition) {
  const { schemaVersion, id, revision, currentGeneration, createdAt, updatedAt, ...semantic } = definition;
  return { schemaVersion, id, ...semantic };
}
function generationId(definitionId: string, generation: number) { return `schedule_generation_${hash(`${definitionId}\0${generation}`).slice(0, 24)}`; }
function occurrenceIdentity(definition: ScheduleDefinition, scheduledForUtc: string) {
  const sourceId = (definition.sourceScheduleRef ?? definition.id) + (definition.sourceNamespace === 'collaboration' ? `:${definition.currentGeneration}` : '');
  const digest = hash(`${definition.sourceNamespace}\0${sourceId}\0${scheduledForUtc}`);
  return { idempotencyKey: `occ_${digest}`, id: `schedule_occurrence_${digest.slice(0, 24)}` };
}
function notFound(kind: string, id: string) { return new RuntimeError('SCHEDULE_FOUNDATION_NOT_FOUND', `${kind} ${id} was not found`, 404); }
function revisionConflict(kind: string, id: string) { return new RuntimeError('SCHEDULE_REVISION_CONFLICT', `${kind} ${id} changed concurrently`, 409); }
function leaseConflict(message: string) { return new RuntimeError('SCHEDULE_LEASE_CONFLICT', message, 409); }

export interface ScheduleFoundationRepositories {
  scheduleDefinitions: ScheduleDefinitionRepository;
  scheduleGenerations: ScheduleGenerationRepository;
  scheduleOccurrences: ScheduleOccurrenceRepository;
  scheduleWatermarks: ScheduleWatermarkRepository;
  scheduleLeases: ScheduleLeaseRepository;
  archivedHammerIntegrations: ArchivedHammerIntegrationRepository;
}

export function createScheduleFoundationRepositories(sqlite: Database.Database): ScheduleFoundationRepositories {
  const getDefinition = (id: string) => { const row = sqlite.prepare('SELECT * FROM schedule_definitions WHERE id = ?').get(id) as DefinitionRow | undefined; return row ? decodeDefinition(row) : undefined; };
  const getGeneration = (id: string) => { const row = sqlite.prepare('SELECT * FROM schedule_generations WHERE id = ?').get(id) as GenerationRow | undefined; return row ? decodeGeneration(row) : undefined; };
  const getCurrentGeneration = (definition: ScheduleDefinition) => getGeneration(generationId(definition.id, definition.currentGeneration));
  const getOccurrence = (id: string) => { const row = sqlite.prepare('SELECT * FROM schedule_occurrences WHERE id = ?').get(id) as OccurrenceRow | undefined; return row ? decodeOccurrence(row) : undefined; };
  const getWatermark = (id: string) => { const row = sqlite.prepare('SELECT * FROM schedule_watermarks WHERE schedule_definition_id = ?').get(id) as WatermarkRow | undefined; return row ? decodeWatermark(row) : undefined; };
  const getLease = (key: string) => { const row = sqlite.prepare('SELECT * FROM schedule_leases WHERE lease_key = ?').get(key) as LeaseRow | undefined; return row ? decodeLease(row) : undefined; };
  const assertBot = (id: string) => { if (!sqlite.prepare('SELECT 1 FROM channel_bots WHERE id = ?').get(id)) throw new RuntimeError('SCHEDULE_CHANNEL_BOT_NOT_FOUND', `ChannelBot ${id} was not found`, 409); };
  const assertBinding = (id: string | undefined, botId: string) => {
    if (!id) return;
    const row = sqlite.prepare('SELECT channel_bot_id FROM group_bindings WHERE id = ?').get(id) as { channel_bot_id: string } | undefined;
    if (!row || row.channel_bot_id !== botId) throw new RuntimeError('SCHEDULE_GROUP_BINDING_NOT_FOUND', `GroupBinding ${id} is not scoped to the ChannelBot`, 409);
  };
  const secretStatus = (id: string | undefined): 'configured' | 'invalid' | 'missing' => {
    if (!id) return 'missing';
    const row = sqlite.prepare('SELECT status FROM secret_refs WHERE id = ?').get(id) as { status: string } | undefined;
    return row?.status === 'configured' ? 'configured' : row ? 'invalid' : 'missing';
  };
  const assertSecret = (id: string | undefined) => {
    if (id && secretStatus(id) === 'missing') throw new RuntimeError('SCHEDULE_SECRET_REF_NOT_FOUND', `SecretRef ${id} was not found`, 409);
  };
  const recordVersion = (kind: ScheduleVersionKind, entity: Versioned, before?: Versioned) => {
    sqlite.prepare('INSERT INTO schedule_entity_versions (entity_kind, entity_id, from_revision, to_revision, before_json, after_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(kind, entity.id, before?.revision ?? null, entity.revision, before ? JSON.stringify(before) : null, hash(entity), new Date().toISOString());
  };
  const insertGeneration = (definition: ScheduleDefinition) => {
    const entity = scheduleGenerationSchema.parse({ schemaVersion: 1, id: generationId(definition.id, definition.currentGeneration), scheduleDefinitionId: definition.id, generation: definition.currentGeneration, definitionRevision: definition.revision, definitionHash: hash(definitionSemantic(definition)), timezone: definition.timezone, identityRef: definition.identityRef, secretRef: definition.secretRef, state: definition.state === 'enabled' ? 'enabled' : 'staged_disabled', createdAt: definition.updatedAt });
    sqlite.prepare('INSERT INTO schedule_generations (id, schema_version, schedule_definition_id, generation, definition_revision, definition_hash, timezone, identity_ref, secret_ref, state, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(entity.id, entity.scheduleDefinitionId, entity.generation, entity.definitionRevision, entity.definitionHash, entity.timezone, entity.identityRef ?? null, entity.secretRef ?? null, entity.state, entity.createdAt);
    return entity;
  };

  const insertDefinition = (definition: ScheduleDefinition) => {
    const trigger = definition.trigger;
    sqlite.prepare(`INSERT INTO schedule_definitions (
      id, schema_version, revision, channel_bot_id, group_binding_id, name, description, trigger_kind, at_local_datetime,
      interval_seconds, interval_anchor_at, cron_expression, timezone, dst_gap_policy, dst_overlap_policy, delivery_mode,
      chat_ref, root_message_ref, continuation_policy, cwd_ref, payload_ref, identity_ref, secret_ref, source_ownership,
      source_namespace, source_schedule_ref, source_enabled, state, desired_executor_state, current_generation, created_at, updated_at
    ) VALUES (@id, 1, @revision, @channel_bot_id, @group_binding_id, @name, @description, @trigger_kind, @at_local_datetime,
      @interval_seconds, @interval_anchor_at, @cron_expression, @timezone, @dst_gap_policy, @dst_overlap_policy, @delivery_mode,
      @chat_ref, @root_message_ref, @continuation_policy, @cwd_ref, @payload_ref, @identity_ref, @secret_ref, @source_ownership,
      @source_namespace, @source_schedule_ref, @source_enabled, @state, 'disabled', @current_generation, @created_at, @updated_at)`)
      .run({
        id: definition.id, revision: definition.revision, channel_bot_id: definition.channelBotId,
        group_binding_id: definition.groupBindingId ?? null, name: definition.name, description: definition.description ?? null,
        trigger_kind: trigger.kind, at_local_datetime: trigger.kind === 'at' ? trigger.localDateTime : null,
        interval_seconds: trigger.kind === 'interval' ? trigger.everySeconds : null,
        interval_anchor_at: trigger.kind === 'interval' ? trigger.anchorAt : null,
        cron_expression: trigger.kind === 'cron' ? trigger.expression : null, timezone: definition.timezone,
        dst_gap_policy: definition.dstPolicy.gap, dst_overlap_policy: definition.dstPolicy.overlap,
        delivery_mode: definition.delivery.mode, chat_ref: definition.delivery.chatRef,
        root_message_ref: definition.delivery.rootMessageRef ?? null, continuation_policy: definition.delivery.continuation,
        cwd_ref: definition.cwdRef ?? null, payload_ref: definition.payloadRef, identity_ref: definition.identityRef ?? null,
        secret_ref: definition.secretRef ?? null, source_ownership: definition.sourceOwnership,
        source_namespace: definition.sourceNamespace, source_schedule_ref: definition.sourceScheduleRef ?? null,
        source_enabled: definition.sourceEnabled ? 1 : 0, state: definition.state,
        current_generation: definition.currentGeneration, created_at: definition.createdAt, updated_at: definition.updatedAt
      });
  };

  const createDefinition = (raw: CreateScheduleDefinitionInput): ScheduleDefinition => {
    const input = createScheduleDefinitionInputSchema.parse(raw);
    assertBot(input.channelBotId); assertBinding(input.groupBindingId, input.channelBotId); assertSecret(input.secretRef);
    if (getDefinition(input.id)) throw new RuntimeError('SCHEDULE_NATURAL_KEY_CONFLICT', `ScheduleDefinition ${input.id} already exists`, 409);
    if (input.sourceScheduleRef && sqlite.prepare('SELECT 1 FROM schedule_definitions WHERE source_namespace = ? AND source_schedule_ref = ?').get(input.sourceNamespace, input.sourceScheduleRef)) throw new RuntimeError('SCHEDULE_NATURAL_KEY_CONFLICT', 'The source Schedule is already mapped', 409);
    const timestamp = new Date().toISOString();
    const definition = scheduleDefinitionSchema.parse({ ...input, schemaVersion: 1, revision: 1, state: 'staged', desiredExecutorState: 'disabled', currentGeneration: 1, createdAt: timestamp, updatedAt: timestamp });
    previewNextSchedule(definition, new Date(0)); // validates timezone and trigger grammar; no timer is started
    insertDefinition(definition); insertGeneration(definition);
    sqlite.prepare('INSERT INTO schedule_watermarks (schedule_definition_id, schema_version, revision, updated_at) VALUES (?, 1, 1, ?)').run(definition.id, timestamp);
    recordVersion('schedule_definition', definition);
    return definition;
  };

  const updateDefinition = (id: string, raw: UpdateScheduleDefinitionInput): ScheduleDefinition => {
    const input = updateScheduleDefinitionInputSchema.parse(raw);
    const current = getDefinition(id);
    if (!current) throw notFound('ScheduleDefinition', id);
    if (current.revision !== input.expectedRevision) throw revisionConflict('ScheduleDefinition', id);
    const next = scheduleDefinitionSchema.parse({
      ...current, revision: current.revision + 1, currentGeneration: current.currentGeneration + 1,
      name: input.name ?? current.name, description: input.description === null ? undefined : input.description ?? current.description,
      trigger: input.trigger ?? current.trigger, timezone: input.timezone ?? current.timezone, dstPolicy: input.dstPolicy ?? current.dstPolicy,
      delivery: input.delivery ?? current.delivery, cwdRef: input.cwdRef === null ? undefined : input.cwdRef ?? current.cwdRef,
      payloadRef: input.payloadRef ?? current.payloadRef, identityRef: input.identityRef === null ? undefined : input.identityRef ?? current.identityRef,
      secretRef: input.secretRef === null ? undefined : input.secretRef ?? current.secretRef, state: input.state ?? current.state,
      desiredExecutorState: (input.state ?? current.state) === 'enabled' ? 'enabled' : 'disabled', updatedAt: new Date().toISOString()
    });
    if (next.state === 'enabled' && (next.sourceNamespace !== 'collaboration' || next.sourceOwnership !== 'dutydeck' || !next.identityRef || secretStatus(next.secretRef) !== 'configured')) throw new RuntimeError('SCHEDULE_ENABLE_FORBIDDEN', 'Only validated collaboration schedules can be enabled', 409);
    assertSecret(next.secretRef); previewNextSchedule(next, new Date(0));
    const trigger = next.trigger;
    const result = sqlite.prepare(`UPDATE schedule_definitions SET revision = ?, name = ?, description = ?, trigger_kind = ?, at_local_datetime = ?, interval_seconds = ?, interval_anchor_at = ?, cron_expression = ?, timezone = ?, dst_gap_policy = ?, dst_overlap_policy = ?, delivery_mode = ?, chat_ref = ?, root_message_ref = ?, continuation_policy = ?, cwd_ref = ?, payload_ref = ?, identity_ref = ?, secret_ref = ?, state = ?, desired_executor_state = ?, current_generation = ?, updated_at = ? WHERE id = ? AND revision = ?`)
      .run(next.revision, next.name, next.description ?? null, trigger.kind, trigger.kind === 'at' ? trigger.localDateTime : null,
        trigger.kind === 'interval' ? trigger.everySeconds : null, trigger.kind === 'interval' ? trigger.anchorAt : null,
        trigger.kind === 'cron' ? trigger.expression : null, next.timezone, next.dstPolicy.gap, next.dstPolicy.overlap,
        next.delivery.mode, next.delivery.chatRef, next.delivery.rootMessageRef ?? null, next.delivery.continuation, next.cwdRef ?? null,
        next.payloadRef, next.identityRef ?? null, next.secretRef ?? null, next.state, next.desiredExecutorState, next.currentGeneration, next.updatedAt, id, input.expectedRevision);
    if (result.changes !== 1) throw revisionConflict('ScheduleDefinition', id);
    insertGeneration(next); recordVersion('schedule_definition', next, current);
    if (next.sourceNamespace === 'collaboration') {
      const nextDue = next.state === 'enabled' ? (input.nextDueAt !== undefined ? input.nextDueAt : previewNextSchedule(next, new Date(next.updatedAt))?.scheduledForUtc) : undefined;
      sqlite.prepare('UPDATE schedule_watermarks SET revision=revision+1,next_due_at=?,updated_at=? WHERE schedule_definition_id=?').run(nextDue ?? null,next.updatedAt,id);
      sqlite.prepare("UPDATE schedule_occurrences SET state='suppressed',revision=revision+1,error='Schedule generation changed',updated_at=? WHERE schedule_definition_id=? AND state IN ('planned','claimed')").run(next.updatedAt,id);
    }
    return next;
  };

  const transact = <T>(work: () => T): T => sqlite.transaction(work)();
  const rollbackDefinition = (id: string, expectedRevision: number) => transact(() => {
    const current = getDefinition(id);
    if (!current) throw notFound('ScheduleDefinition', id);
    if (current.revision !== expectedRevision) throw revisionConflict('ScheduleDefinition', id);
    const version = sqlite.prepare('SELECT before_json, after_hash FROM schedule_entity_versions WHERE entity_kind = ? AND entity_id = ? AND to_revision = ?').get('schedule_definition', id, expectedRevision) as VersionRow | undefined;
    if (!version || version.after_hash !== hash(current)) throw new RuntimeError('SCHEDULE_ROLLBACK_CONFLICT', 'ScheduleDefinition changed after the rollback point', 409);
    if (!version.before_json) throw new RuntimeError('SCHEDULE_ROLLBACK_ROOT_UNSUPPORTED', 'The initial ScheduleDefinition is retained as disabled audit data', 409);
    const before = scheduleDefinitionSchema.parse(JSON.parse(version.before_json));
    return updateDefinition(id, { expectedRevision, name: before.name, description: before.description ?? null, trigger: before.trigger, timezone: before.timezone, dstPolicy: before.dstPolicy, delivery: before.delivery, cwdRef: before.cwdRef ?? null, payloadRef: before.payloadRef, identityRef: before.identityRef ?? null, secretRef: before.secretRef ?? null, state: 'disabled' });
  });

  const acquireLease = (raw: AcquireScheduleLeaseInput): ScheduleLease => {
    const input = acquireScheduleLeaseInputSchema.parse(raw); assertSecret(input.secretRef);
    if (secretStatus(input.secretRef) !== 'configured') throw new RuntimeError('SCHEDULE_SECRET_REF_INVALID', 'Lease SecretRef must be configured', 409);
    const current = getLease(input.leaseKey);
    const expiresAt = new Date(new Date(input.now).getTime() + input.ttlMs).toISOString();
    if (!current) {
      if (input.expectedRevision !== 0 || input.expectedGeneration !== 0) throw leaseConflict('New lease requires expected revision and generation 0');
      const entity = scheduleLeaseSchema.parse({ schemaVersion: 1, id: input.id, revision: 1, leaseKey: input.leaseKey, generation: 1, holderId: input.holderId, holderIdentityRef: input.holderIdentityRef, secretRef: input.secretRef, state: 'held', scheduleSetHash: input.scheduleSetHash, fenceToken: 1, renewedAt: input.now, expiresAt, createdAt: input.now, updatedAt: input.now });
      sqlite.prepare('INSERT INTO schedule_leases (id, schema_version, revision, lease_key, generation, holder_id, holder_identity_ref, secret_ref, state, schedule_set_hash, fence_token, renewed_at, expires_at, created_at, updated_at) VALUES (?, 1, 1, ?, 1, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)')
        .run(entity.id, entity.leaseKey, entity.holderId, entity.holderIdentityRef, entity.secretRef, entity.state, entity.scheduleSetHash, entity.renewedAt, entity.expiresAt, entity.createdAt, entity.updatedAt);
      recordVersion('schedule_lease', entity); return entity;
    }
    if (current.revision !== input.expectedRevision || current.generation !== input.expectedGeneration) throw leaseConflict('Lease revision or generation does not match');
    if (current.state === 'held') throw leaseConflict('Held leases must be fenced before another acquire; expiry is not an automatic steal');
    const next = scheduleLeaseSchema.parse({ ...current, revision: current.revision + 1, generation: current.generation + 1, holderId: input.holderId, holderIdentityRef: input.holderIdentityRef, secretRef: input.secretRef, state: 'held', scheduleSetHash: input.scheduleSetHash, fenceToken: current.fenceToken + 1, renewedAt: input.now, expiresAt, updatedAt: input.now });
    const result = sqlite.prepare(`UPDATE schedule_leases SET revision = ?, generation = ?, holder_id = ?, holder_identity_ref = ?, secret_ref = ?, state = 'held', schedule_set_hash = ?, fence_token = ?, renewed_at = ?, expires_at = ?, updated_at = ? WHERE lease_key = ? AND revision = ? AND generation = ?`)
      .run(next.revision, next.generation, next.holderId, next.holderIdentityRef, next.secretRef, next.scheduleSetHash, next.fenceToken, next.renewedAt, next.expiresAt, next.updatedAt, input.leaseKey, input.expectedRevision, input.expectedGeneration);
    if (result.changes !== 1) throw leaseConflict('Lease changed concurrently');
    recordVersion('schedule_lease', next, current); return next;
  };

  const renewLease = (leaseKey: string, raw: RenewScheduleLeaseInput): ScheduleLease => {
    const input = renewScheduleLeaseInputSchema.parse(raw); const current = getLease(leaseKey);
    if (!current) throw notFound('ScheduleLease', leaseKey);
    if (current.revision !== input.expectedRevision || current.generation !== input.expectedGeneration || current.fenceToken !== input.expectedFenceToken || current.holderId !== input.holderId || current.state !== 'held') throw leaseConflict('Lease proof does not match the held writer');
    if (!current.expiresAt || new Date(current.expiresAt) <= new Date(input.now)) throw leaseConflict('Expired leases cannot renew; fence explicitly before reacquiring');
    const next = scheduleLeaseSchema.parse({ ...current, revision: current.revision + 1, renewedAt: input.now, expiresAt: new Date(new Date(input.now).getTime() + input.ttlMs).toISOString(), updatedAt: input.now });
    const result = sqlite.prepare('UPDATE schedule_leases SET revision = ?, renewed_at = ?, expires_at = ?, updated_at = ? WHERE lease_key = ? AND revision = ? AND generation = ? AND fence_token = ? AND holder_id = ? AND state = ?')
      .run(next.revision, next.renewedAt, next.expiresAt, next.updatedAt, leaseKey, input.expectedRevision, input.expectedGeneration, input.expectedFenceToken, input.holderId, 'held');
    if (result.changes !== 1) throw leaseConflict('Lease changed concurrently'); recordVersion('schedule_lease', next, current); return next;
  };

  const fenceLease = (leaseKey: string, raw: FenceScheduleLeaseInput): ScheduleLease => {
    const input = fenceScheduleLeaseInputSchema.parse(raw); const current = getLease(leaseKey);
    if (!current) throw notFound('ScheduleLease', leaseKey);
    if (current.revision !== input.expectedRevision || current.generation !== input.expectedGeneration || current.fenceToken !== input.expectedFenceToken) throw leaseConflict('Lease fence proof does not match');
    const next = scheduleLeaseSchema.parse({ ...current, revision: current.revision + 1, holderId: undefined, holderIdentityRef: undefined, secretRef: undefined, state: 'fenced', fenceToken: current.fenceToken + 1, renewedAt: undefined, expiresAt: input.now, updatedAt: input.now });
    const result = sqlite.prepare(`UPDATE schedule_leases SET revision = ?, holder_id = NULL, holder_identity_ref = NULL, secret_ref = NULL, state = 'fenced', fence_token = ?, renewed_at = NULL, expires_at = ?, updated_at = ? WHERE lease_key = ? AND revision = ? AND generation = ? AND fence_token = ?`)
      .run(next.revision, next.fenceToken, next.expiresAt, next.updatedAt, leaseKey, input.expectedRevision, input.expectedGeneration, input.expectedFenceToken);
    if (result.changes !== 1) throw leaseConflict('Lease changed concurrently'); recordVersion('schedule_lease', next, current); return next;
  };

  const advanceOccurrence = (id: string, expectedRevision: number, state: ScheduleOccurrence['state'], fence: ScheduleExecutionFence, error?: string) => transact(() => {
    const current = getOccurrence(id); if (!current) throw notFound('ScheduleOccurrence', id);
    if (current.revision !== expectedRevision) throw revisionConflict('ScheduleOccurrence', id);
    const definition = getDefinition(current.scheduleDefinitionId)!;
    const lease = getLease(fence.leaseKey);
    if (fence.leaseKey !== scheduleWriterLeaseKey(definition.channelBotId) || !lease || lease.state !== 'held' || lease.holderId !== fence.holderId || lease.fenceToken !== fence.fenceToken || !lease.expiresAt || lease.expiresAt <= fence.now) throw leaseConflict('Occurrence requires a current writer fence');
    if (definition.sourceNamespace !== 'collaboration' || definition.sourceOwnership !== 'dutydeck') throw new RuntimeError('SCHEDULE_EXECUTOR_UNAVAILABLE', 'Legacy schedules cannot execute', 409);
    const transitions: Record<string, string[]> = { planned: ['claimed','suppressed'], claimed: ['claimed','running','suppressed'], running: ['running','settled','failed','unknown','suppressed'], unknown: ['running','settled','failed','suppressed'] };
    if (!transitions[current.state]?.includes(state)) throw new RuntimeError('SCHEDULE_OCCURRENCE_STATE_CONFLICT', 'Invalid occurrence transition', 409);
    if (['claimed','running'].includes(state) && (current.generation !== definition.currentGeneration || definition.state !== 'enabled')) throw new RuntimeError('SCHEDULE_GENERATION_STALE', 'Schedule changed before execution', 409);
    const next = scheduleOccurrenceSchema.parse({ ...current, revision: current.revision + 1, state, leaseKey: fence.leaseKey, leaseFenceToken: fence.fenceToken, holderId: fence.holderId, error, updatedAt: fence.now });
    sqlite.prepare('UPDATE schedule_occurrences SET revision=?,state=?,lease_key=?,lease_fence_token=?,holder_id=?,error=?,updated_at=? WHERE id=? AND revision=?').run(next.revision,state,fence.leaseKey,fence.fenceToken,fence.holderId,error ?? null,fence.now,id,expectedRevision);
    const column = state === 'claimed' ? 'last_claimed_occurrence_key' : state === 'running' ? 'last_started_occurrence_key' : 'last_settled_occurrence_key';
    if (state !== 'unknown') sqlite.prepare(`UPDATE schedule_watermarks SET revision=revision+1,${column}=?,updated_at=? WHERE schedule_definition_id=?`).run(next.idempotencyKey,fence.now,definition.id);
    return next;
  });

  return {
    scheduleDefinitions: {
      async list(limit) { return (sqlite.prepare('SELECT * FROM schedule_definitions ORDER BY updated_at DESC, id LIMIT ?').all(bounded(limit)) as DefinitionRow[]).map(decodeDefinition); },
      async get(id) { return getDefinition(id); },
      async create(input) { return transact(() => createDefinition(input)); },
      async update(id, input) { return transact(() => updateDefinition(id, input)); },
      async rollbackLast(id, revision) { return rollbackDefinition(id, revision); },
      async readiness(id, now = new Date().toISOString()) {
        const definition = getDefinition(id); if (!definition) throw notFound('ScheduleDefinition', id);
        return scheduleReadiness(definition, getCurrentGeneration(definition), getLease(scheduleWriterLeaseKey(definition.channelBotId)), secretStatus(definition.secretRef), new Date(now));
      }
    },
    scheduleGenerations: {
      async get(id) { return getGeneration(id); },
      async listByDefinition(id, limit) { return (sqlite.prepare('SELECT * FROM schedule_generations WHERE schedule_definition_id = ? ORDER BY generation DESC LIMIT ?').all(id, bounded(limit)) as GenerationRow[]).map(decodeGeneration); }
    },
    scheduleOccurrences: {
      async listUnsettled(id) { return (sqlite.prepare("SELECT * FROM schedule_occurrences WHERE schedule_definition_id=? AND state IN ('planned','claimed','running','unknown') ORDER BY scheduled_for_utc").all(id) as OccurrenceRow[]).map(decodeOccurrence); },
      async advance(id, revision, state, fence, error) { return advanceOccurrence(id, revision, state, fence, error); },
      async get(id) { return getOccurrence(id); },
      async listByDefinition(id, limit) { return (sqlite.prepare('SELECT * FROM schedule_occurrences WHERE schedule_definition_id = ? ORDER BY scheduled_for_utc DESC LIMIT ?').all(id, bounded(limit)) as OccurrenceRow[]).map(decodeOccurrence); },
      async recordPlanned(definitionId, scheduledForUtc, nextDueAt, expectedGeneration) {
        return transact(() => {
          const definition = getDefinition(definitionId); if (!definition) throw notFound('ScheduleDefinition', definitionId);
          if (expectedGeneration !== undefined && definition.currentGeneration !== expectedGeneration) throw new RuntimeError('SCHEDULE_GENERATION_STALE', 'Schedule generation changed before planning', 409);
          const generation = getCurrentGeneration(definition); if (!generation) throw new RuntimeError('SCHEDULE_GENERATION_MISSING', 'Current Schedule generation is missing', 409);
          const utc = new Date(scheduledForUtc); if (!Number.isFinite(utc.getTime()) || utc.toISOString() !== scheduledForUtc) throw new RuntimeError('SCHEDULE_OCCURRENCE_TIME_INVALID', 'Occurrence must use canonical UTC ISO time', 400);
          if (nextDueAt !== undefined) {
            const due = new Date(nextDueAt);
            if (!Number.isFinite(due.getTime()) || due.toISOString() !== nextDueAt) throw new RuntimeError('SCHEDULE_WATERMARK_TIME_INVALID', 'Watermark next due time must use canonical UTC ISO time', 400);
          }
          const identity = occurrenceIdentity(definition, scheduledForUtc);
          const existing = sqlite.prepare('SELECT * FROM schedule_occurrences WHERE idempotency_key = ?').get(identity.idempotencyKey) as OccurrenceRow | undefined;
          if (existing) return { occurrence: decodeOccurrence(existing), created: false };
          const timestamp = new Date().toISOString();
          const occurrence = scheduleOccurrenceSchema.parse({ schemaVersion: 1, id: identity.id, revision: 1, scheduleDefinitionId: definition.id, scheduleGenerationId: generation.id, generation: generation.generation, scheduledForUtc, idempotencyKey: identity.idempotencyKey, state: definition.sourceOwnership === 'botmux' && definition.sourceEnabled ? 'source_owned_pending' : 'planned', intentKind: 'task_run_snapshot', createdAt: timestamp, updatedAt: timestamp });
          sqlite.prepare('INSERT INTO schedule_occurrences (id, schema_version, revision, schedule_definition_id, schedule_generation_id, generation, scheduled_for_utc, idempotency_key, state, intent_kind, created_at, updated_at) VALUES (?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(occurrence.id, occurrence.scheduleDefinitionId, occurrence.scheduleGenerationId, occurrence.generation, occurrence.scheduledForUtc, occurrence.idempotencyKey, occurrence.state, occurrence.intentKind, occurrence.createdAt, occurrence.updatedAt);
          const watermark = getWatermark(definition.id)!;
          sqlite.prepare('UPDATE schedule_watermarks SET revision = ?, last_planned_occurrence_key = ?, next_due_at = ?, updated_at = ? WHERE schedule_definition_id = ? AND revision = ?')
            .run(watermark.revision + 1, occurrence.idempotencyKey, nextDueAt ?? null, timestamp, definition.id, watermark.revision);
          return { occurrence, created: true };
        });
      }
    },
    scheduleWatermarks: { async get(id) { return getWatermark(id); } },
    scheduleLeases: {
      async getByKey(key) { return getLease(key); },
      async acquire(input) { return transact(() => acquireLease(input)); },
      async renew(key, input) { return transact(() => renewLease(key, input)); },
      async fence(key, input) { return transact(() => fenceLease(key, input)); }
    },
    archivedHammerIntegrations: {
      async listByChannelBot(botId, limit) { return (sqlite.prepare('SELECT * FROM archived_integrations WHERE channel_bot_id = ? ORDER BY created_at, id LIMIT ?').all(botId, bounded(limit)) as HammerRow[]).map(decodeHammer); },
      async create(raw: CreateArchivedHammerIntegrationInput) {
        return transact(() => {
          const input = createArchivedHammerIntegrationInputSchema.parse(raw); assertBot(input.channelBotId);
          if (sqlite.prepare('SELECT 1 FROM archived_integrations WHERE id = ? OR (channel_bot_id = ? AND kind = ?)').get(input.id, input.channelBotId, 'hammer')) throw new RuntimeError('SCHEDULE_NATURAL_KEY_CONFLICT', 'Hammer archived metadata already exists for this ChannelBot', 409);
          const timestamp = new Date().toISOString();
          const entity = archivedHammerIntegrationSchema.parse({ ...input, schemaVersion: 1, revision: 1, kind: 'hammer', sourceSystem: 'botmux', state: 'archived', executorState: 'unavailable', blockerCode: 'hammer_executor_unavailable', createdAt: timestamp, updatedAt: timestamp });
          sqlite.prepare(`INSERT INTO archived_integrations (id, schema_version, revision, channel_bot_id, kind, source_system, source_enabled, hammer_mode, enforce_gates, skills_injection, state, executor_state, blocker_code, created_at, updated_at) VALUES (?, 1, 1, ?, 'hammer', 'botmux', ?, ?, ?, ?, 'archived', 'unavailable', 'hammer_executor_unavailable', ?, ?)`)
            .run(entity.id, entity.channelBotId, entity.sourceEnabled ? 1 : 0, entity.mode, entity.enforceGates ? 1 : 0, entity.skillsInjection, entity.createdAt, entity.updatedAt);
          recordVersion('archived_integration', entity); return entity;
        });
      }
    }
  };
}
