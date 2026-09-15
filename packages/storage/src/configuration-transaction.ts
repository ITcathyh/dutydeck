import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import {
  RuntimeError, canonicalExecutionJson, managementOperationSchema,
  type BotSnapshot, type BotConfigChangeKind, type ManagementOperation, type ManagementActor
} from '@dutydeck/shared';
import { createConfigurationReader, canonicalSnapshotJson, computeSnapshotDigest } from './bot-configuration-reader.js';

// Internal command implementation contract; never expose this callback through RepositoryBundle.
export type ConfigurationAccess =
  | { kind: 'owner'; botIds: string[] }
  | { kind: 'bot'; botId: string; bindingIds?: string[] }
  | { kind: 'shared_secret'; secretId: string }
  | { kind: 'unbound_secret'; secretId: string };

export interface ConfigurationChange {
  kind: BotConfigChangeKind;
  authorization: boolean;
  connection: boolean;
}

export interface ConfigurationCommandContext {
  readonly now: string;
  /** Complete, immutable snapshots from before any command writes. */
  readonly before: ReadonlyMap<string, BotSnapshot | undefined>;
  /** Call once per changed Bot, after validated entity writes, before forming the result. */
  recordChange(botId: string, change: ConfigurationChange): BotSnapshot;
}

export interface ConfigurationCommand<I, R> {
  action: string;
  inputSchema: { parse(value: unknown): I };
  resultSchema: { parse(value: unknown): R };
  operation(input: I): ManagementOperation;
  target(input: I): unknown;
  /** Omit only the concrete command's first-execution CAS fields. */
  stablePayload(input: I): unknown;
  /** Resolve any stored target membership inside the command's write transaction. */
  access(input: I): ConfigurationAccess;
  execute(input: I, context: ConfigurationCommandContext): R;
}

function fail(code: string, message: string, status = 409): never {
  throw new RuntimeError(code, `${code}: ${message}`, status);
}

function jsonCopy<T>(value: T): T {
  return JSON.parse(canonicalExecutionJson(value)) as T;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

export function configurationIds(ids: readonly string[]): string[] {
  if (ids.some(id => typeof id !== 'string' || !id.length) || new Set(ids).size !== ids.length) {
    fail('CONFIGURATION_DUPLICATE_TARGET', 'Targets must be distinct nonempty IDs');
  }
  return [...ids].sort();
}

export function nextConfigurationRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision === Number.MAX_SAFE_INTEGER) {
    fail('CONFIGURATION_REVISION_OVERFLOW', 'A configuration revision cannot be incremented');
  }
  return revision + 1;
}

function assertOwner(actor: ManagementActor): void {
  if (actor.kind !== 'installation_owner') fail('CONFIGURATION_FORBIDDEN', 'Installation owner required', 403);
}

function assertAdmin(snapshot: BotSnapshot, actor: ManagementActor, now: string, bindings?: string[]): void {
  const ids = bindings === undefined ? undefined : configurationIds(bindings);
  if (ids && (!ids.length || ids.some(id => !snapshot.bindings.some(binding => binding.id === id)))) {
    fail('CONFIGURATION_INVALID_TARGET', 'Every group target must belong to the current Bot');
  }
  if (actor.kind === 'installation_owner') return;
  if (actor.channelBotId !== snapshot.bot.id) fail('CONFIGURATION_FORBIDDEN', 'Actor belongs to another Bot', 403);
  const roles = snapshot.roles.filter(role => role.principalId === actor.principalId && role.role === 'admin'
    && role.state === 'active' && (!role.expiresAt || Date.parse(role.expiresAt) > Date.parse(now)));
  if (roles.some(role => role.groupBindingId === undefined)) return;
  if (ids?.every(id => roles.some(role => role.groupBindingId === id))) return;
  fail('CONFIGURATION_FORBIDDEN', 'Current management roles do not cover every target', 403);
}

interface OperationRow {
  action: string;
  actor_json: string;
  target_json: string | null;
  payload_digest: string;
  result_json: string;
}

function resultJson<R>(schema: { parse(value: unknown): R }, value: unknown): { result: R; json: string } {
  const original = canonicalExecutionJson(value);
  const result = schema.parse(JSON.parse(original));
  const json = canonicalExecutionJson(result);
  if (json !== original) fail('CONFIGURATION_INVALID_RESULT', 'Result parsing must not repair or discard stored fields', 500);
  return { result, json };
}

/** Owns the outer write transaction; recursive commands and caller transactions are rejected. */
export function runConfigurationCommand<I, R>(db: Database.Database, raw: unknown, command: ConfigurationCommand<I, R>): R {
  const input = freeze(jsonCopy(command.inputSchema.parse(jsonCopy(raw))));
  const op = managementOperationSchema.parse(jsonCopy(command.operation(input)));
  if (!command.action.length) fail('CONFIGURATION_INVALID_COMMAND', 'Action is required');
  const actorJson = canonicalExecutionJson(op.actor);
  const targetJson = canonicalExecutionJson(command.target(input));
  const digest = createHash('sha256').update(canonicalExecutionJson(command.stablePayload(input))).digest('hex');
  if (db.inTransaction) fail('CONFIGURATION_OUTER_TRANSACTION', 'Configuration commands require their own BEGIN IMMEDIATE');

  return db.transaction(() => {
    const reader = createConfigurationReader(db);
    if (reader.authority() !== 'v2') fail('CONFIGURATION_LEGACY_AUTHORITY', 'Configuration commands require V2 authority');
    const access = freeze(jsonCopy(command.access(input)));
    const now = new Date().toISOString();
    const before = new Map<string, BotSnapshot | undefined>();
    const load = (botId: string, required: boolean): BotSnapshot | undefined => {
      const snapshot = reader.read(botId);
      if (!snapshot && required) fail('CONFIGURATION_NOT_FOUND', 'Target Bot does not exist', 404);
      before.set(botId, snapshot ? freeze(snapshot) : undefined);
      return snapshot;
    };
    if (access.kind === 'owner') {
      assertOwner(op.actor);
      for (const id of configurationIds(access.botIds)) load(id, false);
    } else if (access.kind === 'bot') {
      assertAdmin(load(access.botId, true)!, op.actor, now, access.bindingIds);
    } else if (access.kind === 'unbound_secret') {
      assertOwner(op.actor);
    } else {
      const references = db.prepare('SELECT id FROM channel_bots WHERE credential_ref = ? ORDER BY id').all(access.secretId) as { id: string }[];
      if (!references.length) assertOwner(op.actor);
      for (const { id } of references) assertAdmin(load(id, true)!, op.actor, now);
    }

    // Current authorization precedes replay; first-execution entity CAS belongs in execute.
    const saved = db.prepare('SELECT action, actor_json, target_json, payload_digest, result_json FROM configuration_operations WHERE operation_id = ?').get(op.operationId) as OperationRow | undefined;
    if (saved) {
      let storedActor: string;
      let storedTarget: string;
      try {
        const actor = JSON.parse(saved.actor_json) as unknown;
        managementOperationSchema.parse({ operationId: op.operationId, actor });
        storedActor = canonicalExecutionJson(actor);
        storedTarget = canonicalExecutionJson(saved.target_json === null ? null : JSON.parse(saved.target_json));
        if (!/^[a-f0-9]{64}$/.test(saved.payload_digest)) throw new Error('Invalid digest');
      } catch {
        fail('CONFIGURATION_CORRUPTED_RECORD', 'Stored operation metadata is invalid', 500);
      }
      if (saved.action !== command.action || storedActor !== actorJson || storedTarget !== targetJson || saved.payload_digest !== digest) {
        fail('CONFIGURATION_OPERATION_CONFLICT', 'Operation ID already belongs to another request');
      }
      try { return resultJson(command.resultSchema, JSON.parse(saved.result_json)).result; }
      catch { fail('CONFIGURATION_CORRUPTED_RECORD', 'Stored operation result is invalid', 500); }
    }

    // Versions have a non-deferred operation FK. This placeholder is private to this transaction.
    db.prepare('INSERT INTO configuration_operations (operation_id, action, actor_json, target_json, payload_digest, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(op.operationId, command.action, actorJson, targetJson, digest, 'null', now);
    const recorded = new Set<string>();
    let active = true;
    const context: ConfigurationCommandContext = {
      now, before: new Map(before),
      recordChange(botId, change) {
        if (!active || !db.inTransaction) fail('CONFIGURATION_TRANSACTION_CLOSED', 'The command transaction has ended');
        if (!before.has(botId)) fail('CONFIGURATION_INVALID_TARGET', 'Changed Bot was not included in current authorization');
        if (recorded.has(botId)) fail('CONFIGURATION_DUPLICATE_TARGET', 'A command records each Bot only once');
        const previous = before.get(botId);
        const current = reader.read(botId);
        if (!current) fail('CONFIGURATION_NOT_FOUND', 'Changed Bot must exist', 404);
        if (previous) {
          const old = previous.bot;
          if (change.kind === 'created' || current.bot.revision !== old.revision
            || current.bot.authorizationRevision !== old.authorizationRevision || current.bot.connectionGeneration !== old.connectionGeneration) {
            fail('CONFIGURATION_REVISION_CONFLICT', 'Entity writers must preserve the original Bot versions');
          }
          const revision = nextConfigurationRevision(old.revision);
          const authorization = change.authorization ? nextConfigurationRevision(old.authorizationRevision) : old.authorizationRevision;
          const connection = change.connection ? nextConfigurationRevision(old.connectionGeneration) : old.connectionGeneration;
          db.prepare('UPDATE channel_bots SET revision = ?, authorization_revision = ?, connection_generation = ?, updated_at = ? WHERE id = ?')
            .run(revision, authorization, connection, now, botId);
        } else if (change.kind !== 'created' || current.bot.revision !== 1 || current.bot.authorizationRevision !== 1 || current.bot.connectionGeneration !== 1) {
          fail('CONFIGURATION_REVISION_CONFLICT', 'A new Bot starts all versions at one');
        }
        const snapshot = reader.read(botId)!;
        const snapshotJson = canonicalSnapshotJson(snapshot);
        const row = db.prepare('INSERT INTO configuration_changes (bot_id, change_kind, revision, authorization_revision, connection_generation, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
          .run(botId, change.kind, snapshot.bot.revision, snapshot.bot.authorizationRevision, snapshot.bot.connectionGeneration, now);
        const sequence = Number(row.lastInsertRowid);
        if (!Number.isSafeInteger(sequence) || sequence < 1) fail('CONFIGURATION_REVISION_OVERFLOW', 'Change sequence is outside the safe integer range');
        db.prepare('INSERT INTO configuration_versions (version_id, bot_id, revision, change_sequence, change_kind, operation_id, created_at, snapshot_digest, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(`configuration_version_${randomUUID()}`, botId, snapshot.bot.revision, sequence, change.kind, op.operationId, now, computeSnapshotDigest(snapshot), snapshotJson);
        recorded.add(botId);
        return snapshot;
      }
    };
    try {
      const { result, json } = resultJson(command.resultSchema, command.execute(input, context));
      db.prepare('UPDATE configuration_operations SET result_json = ? WHERE operation_id = ?').run(json, op.operationId);
      return result;
    } finally { active = false; }
  }).immediate();
}
