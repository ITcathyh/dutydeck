import type Database from 'better-sqlite3';
import {
  RuntimeError,
  collaborationActionSchema,
  collaborationActivitySchema,
  collaborationBootstrapSchema,
  collaborationDecisionSchema,
  collaborationFeedbackSchema,
  collaborationFollowupSchema,
  collaborationMandateSchema,
  collaborationObservationSchema,
  collaborationSettingsSchema,
  collaborationSnapshotSchema,
  beginActionInputSchema,
  createFollowupInputSchema,
  createMandateInputSchema,
  createFeedbackInputSchema,
  listObservationsOptionsSchema,
  observeCollaborationInputSchema,
  updateActionInputSchema,
  updateCollaborationSettingsInputSchema,
  updateDecisionInputSchema,
  updateFollowupInputSchema,
  updateMandateInputSchema,
  type ActionStatus,
  type BeginActionInput,
  type CollaborationAction,
  type CollaborationActivity,
  type CollaborationBootstrap,
  type CollaborationDecision,
  type CollaborationFeedback,
  type CollaborationFollowup,
  type CollaborationMandate,
  type CollaborationObservation,
  type CollaborationRepository,
  type CollaborationScope,
  type CollaborationSettings,
  type CollaborationSnapshot,
  type CreateFollowupInput,
  type CreateMandateInput,
  type CreateFeedbackInput,
  type ListObservationsOptions,
  type ObserveCollaborationInput,
  type UpdateActionInput,
  type UpdateCollaborationSettingsInput,
  type UpdateDecisionInput,
  type UpdateFollowupInput,
  type UpdateMandateInput
} from '@dutydeck/shared';

const DEFAULT_SETTINGS_UPDATED_AT = '1970-01-01T00:00:00.000Z';
const DEFAULT_OBSERVATION_WINDOW = 30;

const ALLOWED_ACTION_TRANSITIONS: Record<ActionStatus, readonly ActionStatus[]> = {
  intent: ['sending', 'suppressed', 'failed'],
  sending: ['succeeded', 'failed', 'unknown', 'suppressed'],
  unknown: ['succeeded', 'failed', 'suppressed'],
  succeeded: [],
  failed: [],
  suppressed: []
} as const;

function now(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

const ACTIVITY_SUMMARY_MAX = 1000;

/** Activity summaries only display the goal; truncate so a 2000-char goal cannot violate the 1000-char column bound. */
function summarize(prefix: string, goal: string): string {
  const summary = `${prefix}${goal}`;
  return summary.length > ACTIVITY_SUMMARY_MAX ? summary.slice(0, ACTIVITY_SUMMARY_MAX) : summary;
}

interface ScopeCounterRow {
  last_sequence: number;
  context_revision: number;
}

function getOrCreateScope(db: Database.Database, scope: CollaborationScope): ScopeCounterRow {
  const existing = db
    .prepare('SELECT last_sequence, context_revision FROM collaboration_scopes WHERE app_id = ? AND chat_id = ?')
    .get(scope.appId, scope.chatId) as ScopeCounterRow | undefined;
  if (existing) {
    return existing;
  }
  db.prepare(
    'INSERT OR IGNORE INTO collaboration_scopes (app_id, chat_id, last_sequence, context_revision) VALUES (?, ?, 0, 0)'
  ).run(scope.appId, scope.chatId);
  return db
    .prepare('SELECT last_sequence, context_revision FROM collaboration_scopes WHERE app_id = ? AND chat_id = ?')
    .get(scope.appId, scope.chatId) as ScopeCounterRow;
}

function nextContextSequence(db: Database.Database, scope: CollaborationScope): number {
  getOrCreateScope(db, scope);
  const updated = db
    .prepare(`
      UPDATE collaboration_scopes
      SET context_revision = context_revision + 1,
          last_sequence = context_revision + 1
      WHERE app_id = ? AND chat_id = ?
      RETURNING context_revision
    `)
    .get(scope.appId, scope.chatId) as { context_revision: number };
  return updated.context_revision;
}

function advanceContextRevision(db: Database.Database, scope: CollaborationScope): number {
  return nextContextSequence(db, scope);
}

function recordActivity(db: Database.Database, activity: CollaborationActivity): void {
  collaborationActivitySchema.parse(activity);
  db.prepare(`
    INSERT INTO collaboration_activities (
      id, app_id, chat_id, entity_kind, entity_id, revision, actor_id, source_refs_json, provenance, summary, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    activity.id,
    activity.scope.appId,
    activity.scope.chatId,
    activity.entityKind,
    activity.entityId,
    activity.revision,
    activity.actorId,
    JSON.stringify(activity.sourceRefs),
    activity.provenance,
    activity.summary,
    activity.createdAt
  );
}

interface ObservationRow {
  id: string;
  app_id: string;
  chat_id: string;
  sequence: number;
  source: string;
  event_id: string;
  occurred_at: string;
  received_at: string;
  sender_id: string | null;
  sender_kind: 'human' | 'bot' | 'system';
  thread_id: string | null;
  message_id: string | null;
  text: string;
  refs_json: string;
  origin: 'live' | 'history' | 'external';
  missing_json: string;
  revision: number;
}

function rowToObservation(row: ObservationRow): CollaborationObservation {
  return collaborationObservationSchema.parse({
    id: row.id,
    scope: { appId: row.app_id, chatId: row.chat_id },
    sequence: row.sequence,
    source: row.source,
    eventId: row.event_id,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    senderId: row.sender_id ?? undefined,
    senderKind: row.sender_kind,
    threadId: row.thread_id ?? undefined,
    messageId: row.message_id ?? undefined,
    text: row.text,
    refs: JSON.parse(row.refs_json),
    origin: row.origin,
    missing: JSON.parse(row.missing_json),
    revision: row.revision
  });
}

interface SettingsRow {
  app_id: string;
  chat_id: string;
  revision: number;
  participation: 'off' | 'observe' | 'selective';
  participation_inherited: number;
  instructions: string;
  notifications_paused: number;
  max_proactive_per_hour: number;
  max_decisions_per_hour: number;
  retention_days: number;
  policy_version: string;
  updated_at: string;
}

function rowToSettings(row: SettingsRow): CollaborationSettings {
  return collaborationSettingsSchema.parse({
    scope: { appId: row.app_id, chatId: row.chat_id },
    revision: row.revision,
    participation: row.participation,
    inheritParticipation: row.participation_inherited === 1,
    instructions: row.instructions,
    notificationsPaused: row.notifications_paused === 1,
    maxProactivePerHour: row.max_proactive_per_hour,
    maxDecisionsPerHour: row.max_decisions_per_hour,
    retentionDays: row.retention_days,
    policyVersion: row.policy_version,
    updatedAt: row.updated_at
  });
}

interface BootstrapRow {
  app_id: string;
  chat_id: string;
  status: 'pending' | 'running' | 'complete' | 'partial' | 'failed';
  cursor: string | null;
  last_event_at: string | null;
  missing_json: string;
  updated_at: string;
}

function rowToBootstrap(row: BootstrapRow): CollaborationBootstrap {
  return collaborationBootstrapSchema.parse({
    scope: { appId: row.app_id, chatId: row.chat_id },
    status: row.status,
    cursor: row.cursor ?? undefined,
    lastEventAt: row.last_event_at ?? undefined,
    missing: JSON.parse(row.missing_json),
    updatedAt: row.updated_at
  });
}

interface FollowupRow {
  id: string;
  app_id: string;
  chat_id: string;
  revision: number;
  goal: string;
  status: 'open' | 'completed' | 'cancelled';
  progress: string;
  steps_json: string;
  owner_id: string | null;
  due_at: string | null;
  result: string | null;
  source_refs_json: string;
  task_ids_json: string;
  external_refs_json: string;
  fields_json: string;
  created_by: string;
  updated_by: string;
  provenance: 'observed' | 'inferred' | 'confirmed';
  created_at: string;
  updated_at: string;
}

function rowToFollowup(row: FollowupRow): CollaborationFollowup {
  return collaborationFollowupSchema.parse({
    id: row.id,
    scope: { appId: row.app_id, chatId: row.chat_id },
    revision: row.revision,
    goal: row.goal,
    status: row.status,
    progress: row.progress,
    steps: JSON.parse(row.steps_json),
    ownerId: row.owner_id ?? undefined,
    dueAt: row.due_at ?? undefined,
    result: row.result ?? undefined,
    sourceRefs: JSON.parse(row.source_refs_json),
    taskIds: JSON.parse(row.task_ids_json),
    externalRefs: JSON.parse(row.external_refs_json),
    fields: JSON.parse(row.fields_json),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    provenance: row.provenance,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

interface MandateRow {
  id: string;
  app_id: string;
  chat_id: string;
  revision: number;
  goal: string;
  status: 'active' | 'paused' | 'cancelled' | 'completed';
  requester_id: string;
  source_refs_json: string;
  followup_id: string | null;
  schedule_definition_id: string;
  mode: 'notify' | 'agent';
  prompt: string;
  condition: 'always' | 'followup_open' | 'no_progress';
  delivery_paused: number;
  catchup_policy: 'skip' | 'coalesce';
  last_progress_revision: number | null;
  created_at: string;
  updated_at: string;
}

function rowToMandate(row: MandateRow): CollaborationMandate {
  return collaborationMandateSchema.parse({
    id: row.id,
    scope: { appId: row.app_id, chatId: row.chat_id },
    revision: row.revision,
    goal: row.goal,
    status: row.status,
    requesterId: row.requester_id,
    sourceRefs: JSON.parse(row.source_refs_json),
    followupId: row.followup_id ?? undefined,
    scheduleDefinitionId: row.schedule_definition_id,
    mode: row.mode,
    prompt: row.prompt,
    condition: row.condition,
    deliveryPaused: row.delivery_paused === 1,
    catchupPolicy: row.catchup_policy,
    lastProgressRevision: row.last_progress_revision ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

interface DecisionRow {
  id: string;
  app_id: string;
  chat_id: string;
  context_revision: number;
  policy_version: string;
  action: 'silent' | 'reply' | 'act';
  reason: string;
  evidence_ids_json: string;
  status: 'candidate' | 'suppressed' | 'sent' | 'failed';
  response: string | null;
  input_snapshot_json: string;
  created_at: string;
}

function rowToDecision(row: DecisionRow): CollaborationDecision {
  return collaborationDecisionSchema.parse({
    id: row.id,
    scope: { appId: row.app_id, chatId: row.chat_id },
    contextRevision: row.context_revision,
    policyVersion: row.policy_version,
    action: row.action,
    reason: row.reason,
    evidenceIds: JSON.parse(row.evidence_ids_json),
    status: row.status,
    response: row.response ?? undefined,
    inputSnapshot: JSON.parse(row.input_snapshot_json),
    createdAt: row.created_at
  });
}

interface FeedbackRow {
  id: string;
  app_id: string;
  chat_id: string;
  decision_id: string;
  actor_id: string;
  correction: string;
  expected_action: 'silent' | 'reply' | 'act' | null;
  created_at: string;
}

function rowToFeedback(row: FeedbackRow): CollaborationFeedback {
  return collaborationFeedbackSchema.parse({
    id: row.id,
    scope: { appId: row.app_id, chatId: row.chat_id },
    decisionId: row.decision_id,
    actorId: row.actor_id,
    correction: row.correction,
    expectedAction: row.expected_action ?? undefined,
    createdAt: row.created_at
  });
}

interface ActionRow {
  id: string;
  app_id: string;
  chat_id: string;
  revision: number;
  kind: string;
  mandate_id: string | null;
  mandate_revision: number | null;
  schedule_generation: number | null;
  context_revision: number | null;
  followup_revision: number | null;
  requester_id: string;
  input_digest: string;
  payload_json: string;
  status: ActionStatus;
  receipt: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToAction(row: ActionRow): CollaborationAction {
  return collaborationActionSchema.parse({
    id: row.id,
    scope: { appId: row.app_id, chatId: row.chat_id },
    revision: row.revision,
    kind: row.kind,
    mandateId: row.mandate_id ?? undefined,
    mandateRevision: row.mandate_revision ?? undefined,
    scheduleGeneration: row.schedule_generation ?? undefined,
    contextRevision: row.context_revision ?? undefined,
    followupRevision: row.followup_revision ?? undefined,
    requesterId: row.requester_id,
    inputDigest: row.input_digest,
    payload: JSON.parse(row.payload_json),
    status: row.status,
    receipt: row.receipt ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

interface ActivityRow {
  id: string;
  app_id: string;
  chat_id: string;
  entity_kind: 'followup' | 'mandate' | 'settings';
  entity_id: string;
  revision: number;
  actor_id: string;
  source_refs_json: string;
  provenance: 'observed' | 'inferred' | 'confirmed';
  summary: string;
  created_at: string;
}

function rowToActivity(row: ActivityRow): CollaborationActivity {
  return collaborationActivitySchema.parse({
    id: row.id,
    scope: { appId: row.app_id, chatId: row.chat_id },
    entityKind: row.entity_kind,
    entityId: row.entity_id,
    revision: row.revision,
    actorId: row.actor_id,
    sourceRefs: JSON.parse(row.source_refs_json),
    provenance: row.provenance,
    summary: row.summary,
    createdAt: row.created_at
  });
}

export function createCollaborationRepository(sqlite: Database.Database): CollaborationRepository {
  return {
    async getSettings(scope: CollaborationScope): Promise<CollaborationSettings> {
      const row = sqlite
        .prepare('SELECT * FROM collaboration_settings WHERE app_id = ? AND chat_id = ?')
        .get(scope.appId, scope.chatId) as SettingsRow | undefined;
      if (!row) {
        return collaborationSettingsSchema.parse({
          scope,
          revision: 0,
          participation: 'off',
          inheritParticipation: true,
          instructions: '',
          notificationsPaused: false,
          maxProactivePerHour: 6,
          retentionDays: 30,
          policyVersion: 'v1',
          updatedAt: DEFAULT_SETTINGS_UPDATED_AT
        });
      }
      return rowToSettings(row);
    },

    async updateSettings(
      scope: CollaborationScope,
      patch: UpdateCollaborationSettingsInput,
      actorId: string
    ): Promise<CollaborationSettings> {
      const validatedPatch = updateCollaborationSettingsInputSchema.parse(patch);
      return sqlite.transaction(() => {
        const existingRow = sqlite
          .prepare('SELECT * FROM collaboration_settings WHERE app_id = ? AND chat_id = ?')
          .get(scope.appId, scope.chatId) as SettingsRow | undefined;
        const currentSettings = existingRow
          ? rowToSettings(existingRow)
          : collaborationSettingsSchema.parse({
              scope,
              revision: 0,
              participation: 'off',
              inheritParticipation: true,
              instructions: '',
              notificationsPaused: false,
              maxProactivePerHour: 6,
              retentionDays: 30,
              policyVersion: 'v1',
              updatedAt: DEFAULT_SETTINGS_UPDATED_AT
            });

        if (validatedPatch.expectedRevision !== currentSettings.revision) {
          throw new RuntimeError(
            'COLLABORATION_REVISION_CONFLICT',
            `Settings revision conflict: expected ${validatedPatch.expectedRevision}, current ${currentSettings.revision}`,
            409
          );
        }

        const newRevision = currentSettings.revision + 1;
        const updatedTime = now();
        const newSettings = collaborationSettingsSchema.parse({
          scope,
          revision: newRevision,
          participation: validatedPatch.participation ?? currentSettings.participation,
          inheritParticipation: validatedPatch.inheritParticipation
            ?? (validatedPatch.participation === undefined ? currentSettings.inheritParticipation : false),
          instructions: validatedPatch.instructions ?? currentSettings.instructions,
          notificationsPaused: validatedPatch.notificationsPaused ?? currentSettings.notificationsPaused,
          maxProactivePerHour: validatedPatch.maxProactivePerHour ?? currentSettings.maxProactivePerHour,
          maxDecisionsPerHour: validatedPatch.maxDecisionsPerHour ?? currentSettings.maxDecisionsPerHour,
          retentionDays: validatedPatch.retentionDays ?? currentSettings.retentionDays,
          policyVersion: validatedPatch.policyVersion ?? currentSettings.policyVersion,
          updatedAt: updatedTime
        });

        sqlite.prepare(`
          INSERT INTO collaboration_settings (
            app_id, chat_id, revision, participation, participation_inherited, instructions, notifications_paused,
            max_proactive_per_hour, max_decisions_per_hour, retention_days, policy_version, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(app_id, chat_id) DO UPDATE SET
            revision = excluded.revision,
            participation = excluded.participation,
            participation_inherited = excluded.participation_inherited,
            instructions = excluded.instructions,
            notifications_paused = excluded.notifications_paused,
            max_proactive_per_hour = excluded.max_proactive_per_hour,
            max_decisions_per_hour = excluded.max_decisions_per_hour,
            retention_days = excluded.retention_days,
            policy_version = excluded.policy_version,
            updated_at = excluded.updated_at
        `).run(
          scope.appId,
          scope.chatId,
          newSettings.revision,
          newSettings.participation,
          newSettings.inheritParticipation ? 1 : 0,
          newSettings.instructions,
          newSettings.notificationsPaused ? 1 : 0,
          newSettings.maxProactivePerHour,
          newSettings.maxDecisionsPerHour,
          newSettings.retentionDays,
          newSettings.policyVersion,
          newSettings.updatedAt
        );

        recordActivity(sqlite, {
          id: makeId('act'),
          scope,
          entityKind: 'settings',
          entityId: `${scope.appId}:${scope.chatId}`,
          revision: newRevision,
          actorId,
          sourceRefs: [],
          provenance: 'confirmed',
          summary: 'Updated collaboration settings',
          createdAt: updatedTime
        });

        advanceContextRevision(sqlite, scope);
        return newSettings;
      })();
    },

    async observe(
      input: ObserveCollaborationInput
    ): Promise<{ observation: CollaborationObservation; created: boolean; changed: boolean; contextRevision: number }> {
      const validatedInput = observeCollaborationInputSchema.parse(input);
      const scope = validatedInput.scope;

      return sqlite.transaction(() => {
        const existingRow = sqlite
          .prepare('SELECT * FROM collaboration_observations WHERE app_id = ? AND chat_id = ? AND source = ? AND event_id = ?')
          .get(scope.appId, scope.chatId, validatedInput.source, validatedInput.eventId) as ObservationRow | undefined;

        if (existingRow) {
          const existing = rowToObservation(existingRow);

          // History backfill race: an already-live observation must never be touched
          // by a history re-read. Return it atomically, unchanged — stale history must
          // not overwrite newer live text/identity/refs, and no sequence advances.
          if (existing.origin === 'live' && validatedInput.origin === 'history') {
            const currentCounter = getOrCreateScope(sqlite, scope);
            return {
              observation: existing,
              created: false,
              changed: false,
              contextRevision: currentCounter.context_revision
            };
          }

          // Only receivedAt differs (delivery redelivery): receivedAt is excluded from
          // the change comparison, so sequence/contextRevision do not advance.
          const hasContentChanged =
            existing.text !== validatedInput.text ||
            (existing.senderId ?? null) !== (validatedInput.senderId ?? null) ||
            existing.senderKind !== validatedInput.senderKind ||
            (existing.threadId ?? null) !== (validatedInput.threadId ?? null) ||
            (existing.messageId ?? null) !== (validatedInput.messageId ?? null) ||
            JSON.stringify(existing.refs) !== JSON.stringify(validatedInput.refs) ||
            existing.origin !== validatedInput.origin ||
            JSON.stringify(existing.missing) !== JSON.stringify(validatedInput.missing) ||
            existing.occurredAt !== validatedInput.occurredAt;

          if (!hasContentChanged) {
            const currentCounter = getOrCreateScope(sqlite, scope);
            return {
              observation: existing,
              created: false,
              changed: false,
              contextRevision: currentCounter.context_revision
            };
          }

          // Genuine live/external edit: move the row to the next monotonic sequence.
          const newRevision = existing.revision + 1;
          const newSeq = nextContextSequence(sqlite, scope);

          sqlite.prepare(`
            UPDATE collaboration_observations SET
              sequence = ?,
              occurred_at = ?,
              received_at = ?,
              sender_id = ?,
              sender_kind = ?,
              thread_id = ?,
              message_id = ?,
              text = ?,
              refs_json = ?,
              origin = ?,
              missing_json = ?,
              revision = ?
            WHERE id = ?
          `).run(
            newSeq,
            validatedInput.occurredAt,
            validatedInput.receivedAt,
            validatedInput.senderId ?? null,
            validatedInput.senderKind,
            validatedInput.threadId ?? null,
            validatedInput.messageId ?? null,
            validatedInput.text,
            JSON.stringify(validatedInput.refs),
            validatedInput.origin,
            JSON.stringify(validatedInput.missing),
            newRevision,
            existing.id
          );

          const updatedObs = collaborationObservationSchema.parse({
            id: existing.id,
            scope,
            sequence: newSeq,
            source: validatedInput.source,
            eventId: validatedInput.eventId,
            occurredAt: validatedInput.occurredAt,
            receivedAt: validatedInput.receivedAt,
            senderId: validatedInput.senderId,
            senderKind: validatedInput.senderKind,
            threadId: validatedInput.threadId,
            messageId: validatedInput.messageId,
            text: validatedInput.text,
            refs: validatedInput.refs,
            origin: validatedInput.origin,
            missing: validatedInput.missing,
            revision: newRevision
          });

          return {
            observation: updatedObs,
            created: false,
            changed: true,
            contextRevision: newSeq
          };
        }

        const seq = nextContextSequence(sqlite, scope);
        const id = validatedInput.id ?? makeId('obs');
        const revision = 1;

        sqlite.prepare(`
          INSERT INTO collaboration_observations (
            id, app_id, chat_id, sequence, source, event_id, occurred_at, received_at,
            sender_id, sender_kind, thread_id, message_id, text, refs_json, origin, missing_json, revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          scope.appId,
          scope.chatId,
          seq,
          validatedInput.source,
          validatedInput.eventId,
          validatedInput.occurredAt,
          validatedInput.receivedAt,
          validatedInput.senderId ?? null,
          validatedInput.senderKind,
          validatedInput.threadId ?? null,
          validatedInput.messageId ?? null,
          validatedInput.text,
          JSON.stringify(validatedInput.refs),
          validatedInput.origin,
          JSON.stringify(validatedInput.missing),
          revision
        );

        const createdObs = collaborationObservationSchema.parse({
          id,
          scope,
          sequence: seq,
          source: validatedInput.source,
          eventId: validatedInput.eventId,
          occurredAt: validatedInput.occurredAt,
          receivedAt: validatedInput.receivedAt,
          senderId: validatedInput.senderId,
          senderKind: validatedInput.senderKind,
          threadId: validatedInput.threadId,
          messageId: validatedInput.messageId,
          text: validatedInput.text,
          refs: validatedInput.refs,
          origin: validatedInput.origin,
          missing: validatedInput.missing,
          revision
        });

        return {
          observation: createdObs,
          created: true,
          changed: true,
          contextRevision: seq
        };
      })();
    },

    async listObservations(
      scope: CollaborationScope,
      options: ListObservationsOptions = {}
    ): Promise<CollaborationObservation[]> {
      const validatedOptions = listObservationsOptionsSchema.parse(options);
      const limit = Math.max(1, Math.min(1000, validatedOptions.limit ?? 100));

      const conditions: string[] = ['app_id = ?', 'chat_id = ?'];
      const params: unknown[] = [scope.appId, scope.chatId];

      if (validatedOptions.afterSequence !== undefined) {
        conditions.push('sequence > ?');
        params.push(validatedOptions.afterSequence);
      }
      if (validatedOptions.threadId !== undefined) {
        conditions.push('thread_id = ?');
        params.push(validatedOptions.threadId);
      }

      params.push(limit);
      const query = `
        SELECT * FROM collaboration_observations
        WHERE ${conditions.join(' AND ')}
        ORDER BY sequence ASC
        LIMIT ?
      `;
      const rows = sqlite.prepare(query).all(...params) as ObservationRow[];
      return rows.map(rowToObservation);
    },

    async snapshot(scope: CollaborationScope, limit?: number): Promise<CollaborationSnapshot> {
      const obsLimit = limit !== undefined && Number.isFinite(limit) && limit > 0 ? Math.min(500, Math.trunc(limit)) : DEFAULT_OBSERVATION_WINDOW;

      return sqlite.transaction(() => {
        const counter = getOrCreateScope(sqlite, scope);
        const settingsRow = sqlite
          .prepare('SELECT * FROM collaboration_settings WHERE app_id = ? AND chat_id = ?')
          .get(scope.appId, scope.chatId) as SettingsRow | undefined;
        const settings = settingsRow
          ? rowToSettings(settingsRow)
          : collaborationSettingsSchema.parse({
              scope,
              revision: 0,
              participation: 'off',
              inheritParticipation: true,
              instructions: '',
              notificationsPaused: false,
              maxProactivePerHour: 6,
              retentionDays: 30,
              policyVersion: 'v1',
              updatedAt: DEFAULT_SETTINGS_UPDATED_AT
            });

        const obsRowsDesc = sqlite.prepare(`
          SELECT * FROM collaboration_observations
          WHERE app_id = ? AND chat_id = ?
          ORDER BY sequence DESC
          LIMIT ?
        `).all(scope.appId, scope.chatId, obsLimit) as ObservationRow[];
        const observations = obsRowsDesc.reverse().map(rowToObservation);

        const followupRows = sqlite.prepare(`
          SELECT * FROM collaboration_followups
          WHERE app_id = ? AND chat_id = ? AND status = 'open'
          ORDER BY created_at ASC
        `).all(scope.appId, scope.chatId) as FollowupRow[];
        const followups = followupRows.map(rowToFollowup);

        const mandateRows = sqlite.prepare(`
          SELECT * FROM collaboration_mandates
          WHERE app_id = ? AND chat_id = ? AND status IN ('active', 'paused')
          ORDER BY created_at ASC
        `).all(scope.appId, scope.chatId) as MandateRow[];
        const mandates = mandateRows.map(rowToMandate);

        const bootstrapRow = sqlite.prepare(`
          SELECT * FROM collaboration_bootstraps
          WHERE app_id = ? AND chat_id = ?
        `).get(scope.appId, scope.chatId) as BootstrapRow | undefined;
        const bootstrap = bootstrapRow ? rowToBootstrap(bootstrapRow) : undefined;

        return collaborationSnapshotSchema.parse({
          scope,
          contextRevision: counter.context_revision,
          settings,
          observations,
          followups,
          mandates,
          bootstrap
        });
      })();
    },

    async getBootstrap(scope: CollaborationScope): Promise<CollaborationBootstrap | undefined> {
      const row = sqlite
        .prepare('SELECT * FROM collaboration_bootstraps WHERE app_id = ? AND chat_id = ?')
        .get(scope.appId, scope.chatId) as BootstrapRow | undefined;
      return row ? rowToBootstrap(row) : undefined;
    },

    async saveBootstrap(input: CollaborationBootstrap): Promise<CollaborationBootstrap> {
      const validated = collaborationBootstrapSchema.parse(input);
      sqlite.prepare(`
        INSERT INTO collaboration_bootstraps (
          app_id, chat_id, status, cursor, last_event_at, missing_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(app_id, chat_id) DO UPDATE SET
          status = excluded.status,
          cursor = excluded.cursor,
          last_event_at = excluded.last_event_at,
          missing_json = excluded.missing_json,
          updated_at = excluded.updated_at
      `).run(
        validated.scope.appId,
        validated.scope.chatId,
        validated.status,
        validated.cursor ?? null,
        validated.lastEventAt ?? null,
        JSON.stringify(validated.missing),
        validated.updatedAt
      );
      return validated;
    },

    async pruneObservations(before: string, scope?: CollaborationScope): Promise<number> {
      if (scope) {
        const result = sqlite
          .prepare('DELETE FROM collaboration_observations WHERE occurred_at < ? AND app_id = ? AND chat_id = ?')
          .run(before, scope.appId, scope.chatId);
        return result.changes;
      }
      const result = sqlite.prepare('DELETE FROM collaboration_observations WHERE occurred_at < ?').run(before);
      return result.changes;
    },

    async createFollowup(input: CreateFollowupInput): Promise<CollaborationFollowup> {
      const validated = createFollowupInputSchema.parse(input);
      const scope = validated.scope;
      const id = validated.id ?? makeId('fol');
      const createdAt = now();
      const updatedAt = createdAt;
      const revision = 1;

      return sqlite.transaction(() => {
        sqlite.prepare(`
          INSERT INTO collaboration_followups (
            id, app_id, chat_id, revision, goal, status, progress, steps_json,
            owner_id, due_at, result, source_refs_json, task_ids_json, external_refs_json,
            fields_json, created_by, updated_by, provenance, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          scope.appId,
          scope.chatId,
          revision,
          validated.goal,
          validated.status,
          validated.progress,
          JSON.stringify(validated.steps),
          validated.ownerId ?? null,
          validated.dueAt ?? null,
          validated.result ?? null,
          JSON.stringify(validated.sourceRefs),
          JSON.stringify(validated.taskIds),
          JSON.stringify(validated.externalRefs),
          JSON.stringify(validated.fields),
          validated.createdBy,
          validated.updatedBy ?? validated.createdBy,
          validated.provenance,
          createdAt,
          updatedAt
        );

        recordActivity(sqlite, {
          id: makeId('act'),
          scope,
          entityKind: 'followup',
          entityId: id,
          revision,
          actorId: validated.createdBy,
          sourceRefs: validated.sourceRefs,
          provenance: validated.provenance,
          summary: summarize('Created followup: ', validated.goal),
          createdAt
        });

        advanceContextRevision(sqlite, scope);

        return collaborationFollowupSchema.parse({
          id,
          scope,
          revision,
          goal: validated.goal,
          status: validated.status,
          progress: validated.progress,
          steps: validated.steps,
          ownerId: validated.ownerId,
          dueAt: validated.dueAt,
          result: validated.result,
          sourceRefs: validated.sourceRefs,
          taskIds: validated.taskIds,
          externalRefs: validated.externalRefs,
          fields: validated.fields,
          createdBy: validated.createdBy,
          updatedBy: validated.updatedBy ?? validated.createdBy,
          provenance: validated.provenance,
          createdAt,
          updatedAt
        });
      })();
    },

    async getFollowup(scope: CollaborationScope, id: string): Promise<CollaborationFollowup | undefined> {
      const row = sqlite
        .prepare('SELECT * FROM collaboration_followups WHERE id = ? AND app_id = ? AND chat_id = ?')
        .get(id, scope.appId, scope.chatId) as FollowupRow | undefined;
      return row ? rowToFollowup(row) : undefined;
    },

    async listFollowups(scope: CollaborationScope): Promise<CollaborationFollowup[]> {
      const rows = sqlite
        .prepare('SELECT * FROM collaboration_followups WHERE app_id = ? AND chat_id = ? ORDER BY created_at ASC')
        .all(scope.appId, scope.chatId) as FollowupRow[];
      return rows.map(rowToFollowup);
    },

    async updateFollowup(
      scope: CollaborationScope,
      id: string,
      patch: UpdateFollowupInput,
      actorId: string
    ): Promise<CollaborationFollowup> {
      const validatedPatch = updateFollowupInputSchema.parse(patch);

      return sqlite.transaction(() => {
        const row = sqlite
          .prepare('SELECT * FROM collaboration_followups WHERE id = ?')
          .get(id) as FollowupRow | undefined;

        if (!row || row.app_id !== scope.appId || row.chat_id !== scope.chatId) {
          throw new RuntimeError('COLLABORATION_NOT_FOUND', `Followup '${id}' not found in scope`, 404);
        }

        const existing = rowToFollowup(row);
        if (validatedPatch.expectedRevision !== existing.revision) {
          throw new RuntimeError(
            'COLLABORATION_REVISION_CONFLICT',
            `Followup revision conflict: expected ${validatedPatch.expectedRevision}, current ${existing.revision}`,
            409
          );
        }

        const newRevision = existing.revision + 1;
        const updatedAt = now();
        const goal = validatedPatch.goal ?? existing.goal;
        const status = validatedPatch.status ?? existing.status;
        const progress = validatedPatch.progress ?? existing.progress;
        const steps = validatedPatch.steps ?? existing.steps;
        const ownerId = validatedPatch.ownerId !== undefined ? (validatedPatch.ownerId ?? undefined) : existing.ownerId;
        const dueAt = validatedPatch.dueAt !== undefined ? (validatedPatch.dueAt ?? undefined) : existing.dueAt;
        const result = validatedPatch.result !== undefined ? (validatedPatch.result ?? undefined) : existing.result;
        const sourceRefs = validatedPatch.sourceRefs ?? existing.sourceRefs;
        const taskIds = validatedPatch.taskIds ?? existing.taskIds;
        const externalRefs = validatedPatch.externalRefs ?? existing.externalRefs;
        const fields = validatedPatch.fields ?? existing.fields;
        const provenance = validatedPatch.provenance ?? existing.provenance;

        sqlite.prepare(`
          UPDATE collaboration_followups SET
            revision = ?,
            goal = ?,
            status = ?,
            progress = ?,
            steps_json = ?,
            owner_id = ?,
            due_at = ?,
            result = ?,
            source_refs_json = ?,
            task_ids_json = ?,
            external_refs_json = ?,
            fields_json = ?,
            updated_by = ?,
            provenance = ?,
            updated_at = ?
          WHERE id = ?
        `).run(
          newRevision,
          goal,
          status,
          progress,
          JSON.stringify(steps),
          ownerId ?? null,
          dueAt ?? null,
          result ?? null,
          JSON.stringify(sourceRefs),
          JSON.stringify(taskIds),
          JSON.stringify(externalRefs),
          JSON.stringify(fields),
          actorId,
          provenance,
          updatedAt,
          id
        );

        recordActivity(sqlite, {
          id: makeId('act'),
          scope,
          entityKind: 'followup',
          entityId: id,
          revision: newRevision,
          actorId,
          sourceRefs,
          provenance,
          summary: summarize('Updated followup: ', goal),
          createdAt: updatedAt
        });

        advanceContextRevision(sqlite, scope);

        return collaborationFollowupSchema.parse({
          id,
          scope,
          revision: newRevision,
          goal,
          status,
          progress,
          steps,
          ownerId,
          dueAt,
          result,
          sourceRefs,
          taskIds,
          externalRefs,
          fields,
          createdBy: existing.createdBy,
          updatedBy: actorId,
          provenance,
          createdAt: existing.createdAt,
          updatedAt
        });
      })();
    },

    async createMandate(input: CreateMandateInput): Promise<CollaborationMandate> {
      const validated = createMandateInputSchema.parse(input);
      const scope = validated.scope;
      const id = validated.id ?? makeId('man');
      const createdAt = now();
      const updatedAt = createdAt;
      const revision = 1;

      return sqlite.transaction(() => {
        if (validated.followupId) {
          const followupExists = sqlite
            .prepare('SELECT 1 FROM collaboration_followups WHERE id = ? AND app_id = ? AND chat_id = ?')
            .get(validated.followupId, scope.appId, scope.chatId);
          if (!followupExists) {
            throw new RuntimeError(
              'COLLABORATION_NOT_FOUND',
              `Followup '${validated.followupId}' not found in mandate scope`,
              404
            );
          }
        }

        sqlite.prepare(`
          INSERT INTO collaboration_mandates (
            id, app_id, chat_id, revision, goal, status, requester_id, source_refs_json,
            followup_id, schedule_definition_id, mode, prompt, condition, delivery_paused,
            catchup_policy, last_progress_revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          scope.appId,
          scope.chatId,
          revision,
          validated.goal,
          validated.status,
          validated.requesterId,
          JSON.stringify(validated.sourceRefs),
          validated.followupId ?? null,
          validated.scheduleDefinitionId,
          validated.mode,
          validated.prompt,
          validated.condition,
          validated.deliveryPaused ? 1 : 0,
          validated.catchupPolicy,
          validated.lastProgressRevision ?? null,
          createdAt,
          updatedAt
        );

        recordActivity(sqlite, {
          id: makeId('act'),
          scope,
          entityKind: 'mandate',
          entityId: id,
          revision,
          actorId: validated.requesterId,
          sourceRefs: validated.sourceRefs,
          provenance: 'confirmed',
          summary: summarize('Created mandate: ', validated.goal),
          createdAt
        });

        advanceContextRevision(sqlite, scope);

        return collaborationMandateSchema.parse({
          id,
          scope,
          revision,
          goal: validated.goal,
          status: validated.status,
          requesterId: validated.requesterId,
          sourceRefs: validated.sourceRefs,
          followupId: validated.followupId,
          scheduleDefinitionId: validated.scheduleDefinitionId,
          mode: validated.mode,
          prompt: validated.prompt,
          condition: validated.condition,
          deliveryPaused: validated.deliveryPaused,
          catchupPolicy: validated.catchupPolicy,
          lastProgressRevision: validated.lastProgressRevision,
          createdAt,
          updatedAt
        });
      })();
    },

    async getMandate(scope: CollaborationScope, id: string): Promise<CollaborationMandate | undefined> {
      const row = sqlite
        .prepare('SELECT * FROM collaboration_mandates WHERE id = ? AND app_id = ? AND chat_id = ?')
        .get(id, scope.appId, scope.chatId) as MandateRow | undefined;
      return row ? rowToMandate(row) : undefined;
    },

    async listMandates(scope?: CollaborationScope): Promise<CollaborationMandate[]> {
      if (scope) {
        const rows = sqlite
          .prepare('SELECT * FROM collaboration_mandates WHERE app_id = ? AND chat_id = ? ORDER BY created_at ASC')
          .all(scope.appId, scope.chatId) as MandateRow[];
        return rows.map(rowToMandate);
      }
      const rows = sqlite.prepare('SELECT * FROM collaboration_mandates ORDER BY created_at ASC').all() as MandateRow[];
      return rows.map(rowToMandate);
    },

    async updateMandate(
      scope: CollaborationScope,
      id: string,
      patch: UpdateMandateInput,
      actorId: string
    ): Promise<CollaborationMandate> {
      const validatedPatch = updateMandateInputSchema.parse(patch);

      return sqlite.transaction(() => {
        const row = sqlite.prepare('SELECT * FROM collaboration_mandates WHERE id = ?').get(id) as MandateRow | undefined;
        if (!row || row.app_id !== scope.appId || row.chat_id !== scope.chatId) {
          throw new RuntimeError('COLLABORATION_NOT_FOUND', `Mandate '${id}' not found in scope`, 404);
        }

        const existing = rowToMandate(row);
        if (validatedPatch.expectedRevision !== existing.revision) {
          throw new RuntimeError(
            'COLLABORATION_REVISION_CONFLICT',
            `Mandate revision conflict: expected ${validatedPatch.expectedRevision}, current ${existing.revision}`,
            409
          );
        }

        const followupId = validatedPatch.followupId !== undefined
          ? (validatedPatch.followupId ?? undefined)
          : existing.followupId;

        if (followupId) {
          const followupExists = sqlite
            .prepare('SELECT 1 FROM collaboration_followups WHERE id = ? AND app_id = ? AND chat_id = ?')
            .get(followupId, scope.appId, scope.chatId);
          if (!followupExists) {
            throw new RuntimeError(
              'COLLABORATION_NOT_FOUND',
              `Followup '${followupId}' not found in mandate scope`,
              404
            );
          }
        }

        const newRevision = existing.revision + 1;
        const updatedAt = now();
        const goal = validatedPatch.goal ?? existing.goal;
        const status = validatedPatch.status ?? existing.status;
        const scheduleDefinitionId = validatedPatch.scheduleDefinitionId ?? existing.scheduleDefinitionId;
        const mode = validatedPatch.mode ?? existing.mode;
        const prompt = validatedPatch.prompt ?? existing.prompt;
        const condition = validatedPatch.condition ?? existing.condition;
        const deliveryPaused = validatedPatch.deliveryPaused ?? existing.deliveryPaused;
        const catchupPolicy = validatedPatch.catchupPolicy ?? existing.catchupPolicy;
        const lastProgressRevision = validatedPatch.lastProgressRevision !== undefined
          ? (validatedPatch.lastProgressRevision ?? undefined)
          : existing.lastProgressRevision;
        const sourceRefs = validatedPatch.sourceRefs ?? existing.sourceRefs;

        sqlite.prepare(`
          UPDATE collaboration_mandates SET
            revision = ?,
            goal = ?,
            status = ?,
            followup_id = ?,
            schedule_definition_id = ?,
            mode = ?,
            prompt = ?,
            condition = ?,
            delivery_paused = ?,
            catchup_policy = ?,
            last_progress_revision = ?,
            source_refs_json = ?,
            updated_at = ?
          WHERE id = ?
        `).run(
          newRevision,
          goal,
          status,
          followupId ?? null,
          scheduleDefinitionId,
          mode,
          prompt,
          condition,
          deliveryPaused ? 1 : 0,
          catchupPolicy,
          lastProgressRevision ?? null,
          JSON.stringify(sourceRefs),
          updatedAt,
          id
        );

        recordActivity(sqlite, {
          id: makeId('act'),
          scope,
          entityKind: 'mandate',
          entityId: id,
          revision: newRevision,
          actorId,
          sourceRefs,
          provenance: 'confirmed',
          summary: summarize('Updated mandate: ', goal),
          createdAt: updatedAt
        });

        advanceContextRevision(sqlite, scope);

        return collaborationMandateSchema.parse({
          id,
          scope,
          revision: newRevision,
          goal,
          status,
          requesterId: existing.requesterId,
          sourceRefs,
          followupId,
          scheduleDefinitionId,
          mode,
          prompt,
          condition,
          deliveryPaused,
          catchupPolicy,
          lastProgressRevision,
          createdAt: existing.createdAt,
          updatedAt
        });
      })();
    },

    async recordDecision(input: CollaborationDecision): Promise<CollaborationDecision> {
      const validated = collaborationDecisionSchema.parse(input);
      const scope = validated.scope;

      return sqlite.transaction(() => {
        const existingRow = sqlite
          .prepare('SELECT * FROM collaboration_decisions WHERE id = ?')
          .get(validated.id) as DecisionRow | undefined;
        if (existingRow) {
          return rowToDecision(existingRow);
        }

        sqlite.prepare(`
          INSERT INTO collaboration_decisions (
            id, app_id, chat_id, context_revision, policy_version, action, reason,
            evidence_ids_json, status, response, input_snapshot_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          validated.id,
          scope.appId,
          scope.chatId,
          validated.contextRevision,
          validated.policyVersion,
          validated.action,
          validated.reason,
          JSON.stringify(validated.evidenceIds),
          validated.status,
          validated.response ?? null,
          JSON.stringify(validated.inputSnapshot),
          validated.createdAt
        );

        return validated;
      })();
    },

    async getDecision(scope: CollaborationScope, id: string): Promise<CollaborationDecision | undefined> {
      const row = sqlite
        .prepare('SELECT * FROM collaboration_decisions WHERE id = ? AND app_id = ? AND chat_id = ?')
        .get(id, scope.appId, scope.chatId) as DecisionRow | undefined;
      return row ? rowToDecision(row) : undefined;
    },

    async listDecisions(scope: CollaborationScope, limit?: number): Promise<CollaborationDecision[]> {
      const maxLimit = limit !== undefined && Number.isFinite(limit) && limit > 0 ? Math.min(500, Math.trunc(limit)) : 50;
      const rows = sqlite.prepare(`
        SELECT * FROM collaboration_decisions
        WHERE app_id = ? AND chat_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(scope.appId, scope.chatId, maxLimit) as DecisionRow[];
      return rows.map(rowToDecision);
    },

    async updateDecision(
      scope: CollaborationScope,
      id: string,
      patch: UpdateDecisionInput
    ): Promise<CollaborationDecision> {
      const validatedPatch = updateDecisionInputSchema.parse(patch);

      return sqlite.transaction(() => {
        const row = sqlite
          .prepare('SELECT * FROM collaboration_decisions WHERE id = ?')
          .get(id) as DecisionRow | undefined;
        if (!row || row.app_id !== scope.appId || row.chat_id !== scope.chatId) {
          throw new RuntimeError('COLLABORATION_NOT_FOUND', `Decision '${id}' not found in scope`, 404);
        }

        const newResponse = validatedPatch.response !== undefined
          ? (validatedPatch.response ?? null)
          : row.response;

        sqlite.prepare(`
          UPDATE collaboration_decisions
          SET status = ?, response = ?
          WHERE id = ?
        `).run(validatedPatch.status, newResponse, id);

        const updatedRow = sqlite
          .prepare('SELECT * FROM collaboration_decisions WHERE id = ?')
          .get(id) as DecisionRow;
        return rowToDecision(updatedRow);
      })();
    },

    async addFeedback(input: CollaborationFeedback): Promise<CollaborationFeedback> {
      const validated = collaborationFeedbackSchema.parse(input);
      const scope = validated.scope;

      return sqlite.transaction(() => {
        const decisionRow = sqlite
          .prepare('SELECT 1 FROM collaboration_decisions WHERE id = ? AND app_id = ? AND chat_id = ?')
          .get(validated.decisionId, scope.appId, scope.chatId);
        if (!decisionRow) {
          throw new RuntimeError(
            'COLLABORATION_NOT_FOUND',
            `Decision '${validated.decisionId}' not found in scope`,
            404
          );
        }

        sqlite.prepare(`
          INSERT INTO collaboration_feedbacks (
            id, app_id, chat_id, decision_id, actor_id, correction, expected_action, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          validated.id,
          scope.appId,
          scope.chatId,
          validated.decisionId,
          validated.actorId,
          validated.correction,
          validated.expectedAction ?? null,
          validated.createdAt
        );

        return validated;
      })();
    },

    async listFeedback(scope: CollaborationScope, decisionId?: string): Promise<CollaborationFeedback[]> {
      if (decisionId) {
        const rows = sqlite.prepare(`
          SELECT * FROM collaboration_feedbacks
          WHERE app_id = ? AND chat_id = ? AND decision_id = ?
          ORDER BY created_at ASC
        `).all(scope.appId, scope.chatId, decisionId) as FeedbackRow[];
        return rows.map(rowToFeedback);
      }
      const rows = sqlite.prepare(`
        SELECT * FROM collaboration_feedbacks
        WHERE app_id = ? AND chat_id = ?
        ORDER BY created_at ASC
      `).all(scope.appId, scope.chatId) as FeedbackRow[];
      return rows.map(rowToFeedback);
    },

    async beginAction(input: BeginActionInput): Promise<{ action: CollaborationAction; created: boolean }> {
      const validated = beginActionInputSchema.parse(input);
      const scope = validated.scope;

      return sqlite.transaction(() => {
        const existingRow = sqlite
          .prepare('SELECT * FROM collaboration_actions WHERE id = ?')
          .get(validated.id) as ActionRow | undefined;

        if (existingRow) {
          const existing = rowToAction(existingRow);
          const sameScope = existing.scope.appId === scope.appId && existing.scope.chatId === scope.chatId;
          const sameKind = existing.kind === validated.kind;
          const sameRequester = existing.requesterId === validated.requesterId;
          const sameDigest = existing.inputDigest === validated.inputDigest;
          const sameMandateId = (existing.mandateId ?? null) === (validated.mandateId ?? null);
          const sameMandateRevision = (existing.mandateRevision ?? null) === (validated.mandateRevision ?? null);
          const sameScheduleGeneration = (existing.scheduleGeneration ?? null) === (validated.scheduleGeneration ?? null);
          const sameContextRevision = (existing.contextRevision ?? null) === (validated.contextRevision ?? null);
          const sameFollowupRevision = (existing.followupRevision ?? null) === (validated.followupRevision ?? null);
          const samePayload = JSON.stringify(existing.payload) === JSON.stringify(validated.payload);

          const matches =
            sameScope &&
            sameKind &&
            sameRequester &&
            sameDigest &&
            sameMandateId &&
            sameMandateRevision &&
            sameScheduleGeneration &&
            sameContextRevision &&
            sameFollowupRevision &&
            samePayload;

          if (!matches) {
            throw new RuntimeError(
              'COLLABORATION_ACTION_CONFLICT',
              `Action '${validated.id}' exists with conflicting identity or payload parameters`,
              409
            );
          }

          return { action: existing, created: false };
        }

        const createdAt = now();
        const updatedAt = createdAt;
        const revision = 1;
        const status: ActionStatus = 'intent';

        sqlite.prepare(`
          INSERT INTO collaboration_actions (
            id, app_id, chat_id, revision, kind, mandate_id, mandate_revision,
            schedule_generation, context_revision, followup_revision, requester_id,
            input_digest, payload_json, status, receipt, error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          validated.id,
          scope.appId,
          scope.chatId,
          revision,
          validated.kind,
          validated.mandateId ?? null,
          validated.mandateRevision ?? null,
          validated.scheduleGeneration ?? null,
          validated.contextRevision ?? null,
          validated.followupRevision ?? null,
          validated.requesterId,
          validated.inputDigest,
          JSON.stringify(validated.payload),
          status,
          null,
          null,
          createdAt,
          updatedAt
        );

        const createdAction = collaborationActionSchema.parse({
          id: validated.id,
          scope,
          revision,
          kind: validated.kind,
          mandateId: validated.mandateId,
          mandateRevision: validated.mandateRevision,
          scheduleGeneration: validated.scheduleGeneration,
          contextRevision: validated.contextRevision,
          followupRevision: validated.followupRevision,
          requesterId: validated.requesterId,
          inputDigest: validated.inputDigest,
          payload: validated.payload,
          status,
          createdAt,
          updatedAt
        });

        return { action: createdAction, created: true };
      })();
    },

    async getAction(scope: CollaborationScope, id: string): Promise<CollaborationAction | undefined> {
      const row = sqlite
        .prepare('SELECT * FROM collaboration_actions WHERE id = ? AND app_id = ? AND chat_id = ?')
        .get(id, scope.appId, scope.chatId) as ActionRow | undefined;
      return row ? rowToAction(row) : undefined;
    },

    async listActions(scope?: CollaborationScope, limit?: number): Promise<CollaborationAction[]> {
      const maxLimit = limit !== undefined && Number.isFinite(limit) && limit > 0 ? Math.min(500, Math.trunc(limit)) : 50;
      if (scope) {
        const rows = sqlite.prepare(`
          SELECT * FROM collaboration_actions
          WHERE app_id = ? AND chat_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        `).all(scope.appId, scope.chatId, maxLimit) as ActionRow[];
        return rows.map(rowToAction);
      }
      const rows = sqlite.prepare(`
        SELECT * FROM collaboration_actions
        ORDER BY created_at DESC
        LIMIT ?
      `).all(maxLimit) as ActionRow[];
      return rows.map(rowToAction);
    },

    async listPendingActions(appId: string, kind: string): Promise<CollaborationAction[]> {
      const rows = sqlite.prepare(`
        SELECT * FROM collaboration_actions
        WHERE app_id = ? AND kind = ? AND status IN ('intent', 'sending', 'unknown')
        ORDER BY created_at ASC, id ASC
      `).all(appId, kind) as ActionRow[];
      return rows.map(rowToAction);
    },

    async updateAction(scope: CollaborationScope, id: string, patch: UpdateActionInput): Promise<CollaborationAction> {
      const validatedPatch = updateActionInputSchema.parse(patch);

      return sqlite.transaction(() => {
        const row = sqlite
          .prepare('SELECT * FROM collaboration_actions WHERE id = ?')
          .get(id) as ActionRow | undefined;
        if (!row || row.app_id !== scope.appId || row.chat_id !== scope.chatId) {
          throw new RuntimeError('COLLABORATION_NOT_FOUND', `Action '${id}' not found in scope`, 404);
        }

        const existing = rowToAction(row);
        if (validatedPatch.expectedRevision !== existing.revision) {
          throw new RuntimeError(
            'COLLABORATION_REVISION_CONFLICT',
            `Action revision conflict: expected ${validatedPatch.expectedRevision}, current ${existing.revision}`,
            409
          );
        }

        const incomingReceipt = validatedPatch.receipt !== undefined
          ? (validatedPatch.receipt ?? undefined)
          : existing.receipt;
        const incomingError = validatedPatch.error !== undefined
          ? (validatedPatch.error ?? undefined)
          : existing.error;
        const receiptChanged = (existing.receipt ?? null) !== (incomingReceipt ?? null);
        const errorChanged = (existing.error ?? null) !== (incomingError ?? null);

        if (validatedPatch.status === existing.status) {
          const isTerminal = ['succeeded', 'failed', 'suppressed'].includes(existing.status);
          if (isTerminal) {
            if (receiptChanged || errorChanged) {
              throw new RuntimeError(
                'COLLABORATION_ACTION_CONFLICT',
                `Cannot modify confirmed receipt or error on terminal action '${id}' with status '${existing.status}'`,
                409
              );
            }
            return existing;
          }

          if (!receiptChanged && !errorChanged) {
            return existing;
          }
        } else {
          const allowed = ALLOWED_ACTION_TRANSITIONS[existing.status];
          if (!allowed.includes(validatedPatch.status)) {
            throw new RuntimeError(
              'COLLABORATION_ACTION_INVALID_TRANSITION',
              `Invalid action status transition from '${existing.status}' to '${validatedPatch.status}'`,
              400
            );
          }
        }

        const newRevision = existing.revision + 1;
        const updatedAt = now();
        const receipt = incomingReceipt;
        const error = incomingError;

        sqlite.prepare(`
          UPDATE collaboration_actions SET
            revision = ?,
            status = ?,
            receipt = ?,
            error = ?,
            updated_at = ?
          WHERE id = ?
        `).run(newRevision, validatedPatch.status, receipt ?? null, error ?? null, updatedAt, id);

        return collaborationActionSchema.parse({
          id,
          scope,
          revision: newRevision,
          kind: existing.kind,
          mandateId: existing.mandateId,
          mandateRevision: existing.mandateRevision,
          scheduleGeneration: existing.scheduleGeneration,
          contextRevision: existing.contextRevision,
          followupRevision: existing.followupRevision,
          requesterId: existing.requesterId,
          inputDigest: existing.inputDigest,
          payload: existing.payload,
          status: validatedPatch.status,
          receipt,
          error,
          createdAt: existing.createdAt,
          updatedAt
        });
      })();
    },

    async listActivities(scope: CollaborationScope, limit?: number): Promise<CollaborationActivity[]> {
      const maxLimit = limit !== undefined && Number.isFinite(limit) && limit > 0 ? Math.min(500, Math.trunc(limit)) : 50;
      const rows = sqlite.prepare(`
        SELECT * FROM collaboration_activities
        WHERE app_id = ? AND chat_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(scope.appId, scope.chatId, maxLimit) as ActivityRow[];
      return rows.map(rowToActivity);
    }
  };
}
