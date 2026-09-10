import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  RuntimeError,
  channelBotFoundationSchema,
  createChannelBotInputSchema,
  createSecretRefInputSchema,
  getChannelBotFoundationReadiness,
  secretRefMetadataSchema,
  updateChannelBotInputSchema,
  updateSecretRefInputSchema,
  type ChannelBotFoundation,
  type ChannelBotFoundationReadiness,
  type ChannelBotFoundationRepository,
  type CreateChannelBotInput,
  type CreateSecretRefInput,
  type FoundationEntityKind,
  type FoundationRepository,
  type FoundationRollbackResult,
  type FoundationTransactionContext,
  type SecretRefMetadata,
  type SecretRefRepository,
  type UpdateChannelBotInput,
  type UpdateSecretRefInput
} from '@dutydeck/shared';

interface SecretRefRow {
  id: string;
  schema_version: number;
  revision: number;
  kind: string;
  provider: string;
  reference_key: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface ChannelBotRow {
  id: string;
  schema_version: number;
  revision: number;
  channel: string;
  external_app_id: string;
  display_name: string;
  brand: string;
  credential_ref: string | null;
  state: string;
  desired_listener_state: string;
  full_trust_confirmed: number;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  before_json: string | null;
  after_hash: string;
}

function decodeSecretRef(row: SecretRefRow): SecretRefMetadata {
  return secretRefMetadataSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    revision: row.revision,
    kind: row.kind,
    provider: row.provider,
    referenceKey: row.reference_key,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function decodeChannelBot(row: ChannelBotRow): ChannelBotFoundation {
  return channelBotFoundationSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    revision: row.revision,
    channel: row.channel,
    externalAppId: row.external_app_id,
    displayName: row.display_name,
    brand: row.brand,
    credentialRef: row.credential_ref ?? undefined,
    state: row.state,
    desiredListenerState: row.desired_listener_state,
    fullTrustConfirmed: Boolean(row.full_trust_confirmed),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function entityHash(entity: SecretRefMetadata | ChannelBotFoundation): string {
  return createHash('sha256').update(JSON.stringify(entity)).digest('hex');
}

function notFound(entityKind: FoundationEntityKind, entityId: string): RuntimeError {
  return new RuntimeError('FOUNDATION_NOT_FOUND', `${entityKind} ${entityId} was not found`, 404);
}

function revisionConflict(entityKind: FoundationEntityKind, entityId: string, expectedRevision: number): RuntimeError {
  return new RuntimeError('FOUNDATION_REVISION_CONFLICT', `${entityKind} ${entityId} is no longer at revision ${expectedRevision}`, 409);
}

function naturalKeyConflict(entityKind: FoundationEntityKind, identity: string): RuntimeError {
  return new RuntimeError('FOUNDATION_NATURAL_KEY_CONFLICT', `${entityKind} already exists for ${identity}`, 409);
}

function rollbackConflict(entityKind: FoundationEntityKind, entityId: string): RuntimeError {
  return new RuntimeError('FOUNDATION_ROLLBACK_CONFLICT', `${entityKind} ${entityId} changed after the rollback point`, 409);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof (value as { then?: unknown }).then === 'function';
}

export interface FoundationRepositories {
  secretRefs: SecretRefRepository;
  channelBots: ChannelBotFoundationRepository;
  foundation: FoundationRepository;
}

export function createFoundationRepositories(sqlite: Database.Database): FoundationRepositories {
  const selectSecretRef = sqlite.prepare('SELECT * FROM secret_refs WHERE id = ?');
  const selectChannelBot = sqlite.prepare('SELECT * FROM channel_bots WHERE id = ?');
  const insertVersion = sqlite.prepare(`
    INSERT INTO foundation_entity_versions (
      entity_kind, entity_id, from_revision, to_revision, before_json, after_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const getSecretRef = (id: string): SecretRefMetadata | undefined => {
    const row = selectSecretRef.get(id) as SecretRefRow | undefined;
    return row ? decodeSecretRef(row) : undefined;
  };

  const getChannelBot = (id: string): ChannelBotFoundation | undefined => {
    const row = selectChannelBot.get(id) as ChannelBotRow | undefined;
    return row ? decodeChannelBot(row) : undefined;
  };

  const recordVersion = (
    entityKind: FoundationEntityKind,
    entityId: string,
    fromRevision: number | null,
    entity: SecretRefMetadata | ChannelBotFoundation,
    before?: SecretRefMetadata | ChannelBotFoundation
  ): void => {
    insertVersion.run(
      entityKind,
      entityId,
      fromRevision,
      entity.revision,
      before ? JSON.stringify(before) : null,
      entityHash(entity),
      new Date().toISOString()
    );
  };

  const invalidateRemoteFactsForCredential = (credentialRefId: string, currentRevision: number, invalidatedAt: string): void => {
    // Keep invalidation in the caller's SQLite transaction. A credential
    // metadata revision is the fencing version: facts bound to an older
    // revision must never become current again.
    sqlite.prepare(`
      UPDATE remote_chat_facts
      SET revision = revision + 1, expires_at = ?, invalidated_at = ?, error_code = 'REMOTE_CREDENTIAL_ROTATED', updated_at = ?
      WHERE credential_ref_id = ? AND credential_revision = ? AND invalidated_at IS NULL
    `).run(invalidatedAt, invalidatedAt, invalidatedAt, credentialRefId, currentRevision);
    sqlite.prepare(`
      UPDATE remote_identity_facts
      SET revision = revision + 1,
          expires_at = CASE WHEN checked_at > ? THEN checked_at ELSE ? END,
          error_code = 'REMOTE_CREDENTIAL_ROTATED', updated_at = ?
      WHERE credential_ref_id = ? AND credential_revision = ?
    `).run(invalidatedAt, invalidatedAt, invalidatedAt, credentialRefId, currentRevision);
  };

  const invalidateRemoteFactsForBot = (channelBotId: string, invalidatedAt: string, errorCode: 'REMOTE_CHANNEL_BOT_BINDING_CHANGED' | 'REMOTE_APP_ID_CHANGED'): void => {
    sqlite.prepare(`
      UPDATE remote_chat_facts
      SET revision = revision + 1, expires_at = ?, invalidated_at = ?, error_code = ?, updated_at = ?
      WHERE channel_bot_id = ? AND invalidated_at IS NULL
    `).run(invalidatedAt, invalidatedAt, errorCode, invalidatedAt, channelBotId);
    sqlite.prepare(`
      UPDATE remote_identity_facts
      SET revision = revision + 1,
          expires_at = CASE WHEN checked_at > ? THEN checked_at ELSE ? END,
          error_code = ?, updated_at = ?
      WHERE channel_bot_id = ?
    `).run(invalidatedAt, invalidatedAt, errorCode, invalidatedAt, channelBotId);
  };

  const createSecretRef = (rawInput: CreateSecretRefInput): SecretRefMetadata => {
    const input = createSecretRefInputSchema.parse(rawInput);
    if (getSecretRef(input.id)) throw naturalKeyConflict('secret_ref', input.id);
    const timestamp = new Date().toISOString();
    const entity = secretRefMetadataSchema.parse({ ...input, schemaVersion: 1, revision: 1, createdAt: timestamp, updatedAt: timestamp });
    sqlite.prepare(`
      INSERT INTO secret_refs (
        id, schema_version, revision, kind, provider, reference_key, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entity.id, entity.schemaVersion, entity.revision, entity.kind, entity.provider, entity.referenceKey, entity.status, entity.createdAt, entity.updatedAt);
    recordVersion('secret_ref', entity.id, null, entity);
    return entity;
  };

  const updateSecretRef = (id: string, rawInput: UpdateSecretRefInput): SecretRefMetadata => {
    const input = updateSecretRefInputSchema.parse(rawInput);
    const current = getSecretRef(id);
    if (!current) throw notFound('secret_ref', id);
    if (current.revision !== input.expectedRevision) throw revisionConflict('secret_ref', id, input.expectedRevision);
    const next = secretRefMetadataSchema.parse({
      ...current,
      revision: current.revision + 1,
      kind: input.kind ?? current.kind,
      provider: input.provider ?? current.provider,
      referenceKey: input.referenceKey ?? current.referenceKey,
      status: input.status ?? current.status,
      updatedAt: new Date().toISOString()
    });
    const result = sqlite.prepare(`
      UPDATE secret_refs SET revision = ?, kind = ?, provider = ?, reference_key = ?, status = ?, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(next.revision, next.kind, next.provider, next.referenceKey, next.status, next.updatedAt, id, input.expectedRevision);
    if (result.changes !== 1) throw revisionConflict('secret_ref', id, input.expectedRevision);
    invalidateRemoteFactsForCredential(id, current.revision, next.updatedAt);
    recordVersion('secret_ref', id, current.revision, next, current);
    return next;
  };

  const removeSecretRef = (id: string, expectedRevision: number): SecretRefMetadata => {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw revisionConflict('secret_ref', id, expectedRevision);
    const current = getSecretRef(id);
    if (!current) throw notFound('secret_ref', id);
    if (current.revision !== expectedRevision) throw revisionConflict('secret_ref', id, expectedRevision);
    const references = sqlite.prepare(`SELECT (
      (SELECT COUNT(*) FROM channel_bots WHERE credential_ref = ?) +
      (SELECT COUNT(*) FROM remote_identity_facts WHERE credential_ref_id = ?) +
      (SELECT COUNT(*) FROM remote_chat_facts WHERE credential_ref_id = ?)
    ) AS count`).get(id, id, id) as { count: number };
    if (references.count > 0) throw new RuntimeError('FOUNDATION_SECRET_REF_REFERENCED', `SecretRef ${id} is still referenced by a ChannelBot`, 409);
    const deleted = sqlite.prepare('DELETE FROM secret_refs WHERE id = ? AND revision = ?').run(id, expectedRevision);
    if (deleted.changes !== 1) throw revisionConflict('secret_ref', id, expectedRevision);
    sqlite.prepare('DELETE FROM foundation_entity_versions WHERE entity_kind = ? AND entity_id = ?').run('secret_ref', id);
    return current;
  };

  const assertCredentialRef = (credentialRef: string | undefined): void => {
    if (credentialRef && !getSecretRef(credentialRef)) {
      throw new RuntimeError('FOUNDATION_SECRET_REF_NOT_FOUND', `SecretRef ${credentialRef} was not found`, 409);
    }
  };

  const findChannelBotByNaturalKey = (channel: string, externalAppId: string): ChannelBotFoundation | undefined => {
    const row = sqlite.prepare('SELECT * FROM channel_bots WHERE channel = ? AND external_app_id = ?').get(channel, externalAppId) as ChannelBotRow | undefined;
    return row ? decodeChannelBot(row) : undefined;
  };

  const createChannelBot = (rawInput: CreateChannelBotInput): ChannelBotFoundation => {
    const input = createChannelBotInputSchema.parse(rawInput);
    if (getChannelBot(input.id)) throw naturalKeyConflict('channel_bot', input.id);
    if (findChannelBotByNaturalKey(input.channel, input.externalAppId)) throw naturalKeyConflict('channel_bot', `${input.channel}/${input.externalAppId}`);
    assertCredentialRef(input.credentialRef);
    const timestamp = new Date().toISOString();
    const entity = channelBotFoundationSchema.parse({
      ...input,
      schemaVersion: 1,
      revision: 1,
      desiredListenerState: 'disabled',
      fullTrustConfirmed: false,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    sqlite.prepare(`
      INSERT INTO channel_bots (
        id, schema_version, revision, channel, external_app_id, display_name, brand, credential_ref,
        state, desired_listener_state, full_trust_confirmed, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entity.id,
      entity.schemaVersion,
      entity.revision,
      entity.channel,
      entity.externalAppId,
      entity.displayName,
      entity.brand,
      entity.credentialRef ?? null,
      entity.state,
      entity.desiredListenerState,
      0,
      entity.createdAt,
      entity.updatedAt
    );
    recordVersion('channel_bot', entity.id, null, entity);
    return entity;
  };

  const updateChannelBot = (id: string, rawInput: UpdateChannelBotInput): ChannelBotFoundation => {
    const input = updateChannelBotInputSchema.parse(rawInput);
    const current = getChannelBot(id);
    if (!current) throw notFound('channel_bot', id);
    if (current.revision !== input.expectedRevision) throw revisionConflict('channel_bot', id, input.expectedRevision);
    const credentialRef = input.credentialRef === null ? undefined : input.credentialRef ?? current.credentialRef;
    assertCredentialRef(credentialRef);
    const externalAppId = input.externalAppId ?? current.externalAppId;
    const conflictingBot = findChannelBotByNaturalKey(current.channel, externalAppId);
    if (conflictingBot && conflictingBot.id !== id) throw naturalKeyConflict('channel_bot', `${current.channel}/${externalAppId}`);
    const next = channelBotFoundationSchema.parse({
      ...current,
      revision: current.revision + 1,
      externalAppId,
      displayName: input.displayName ?? current.displayName,
      brand: input.brand ?? current.brand,
      credentialRef,
      state: input.state ?? current.state,
      updatedAt: new Date().toISOString()
    });
    const result = sqlite.prepare(`
      UPDATE channel_bots SET revision = ?, external_app_id = ?, display_name = ?, brand = ?, credential_ref = ?, state = ?, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(next.revision, next.externalAppId, next.displayName, next.brand, next.credentialRef ?? null, next.state, next.updatedAt, id, input.expectedRevision);
    if (result.changes !== 1) throw revisionConflict('channel_bot', id, input.expectedRevision);
    if (current.credentialRef !== next.credentialRef) invalidateRemoteFactsForBot(id, next.updatedAt, 'REMOTE_CHANNEL_BOT_BINDING_CHANGED');
    else if (current.externalAppId !== next.externalAppId) invalidateRemoteFactsForBot(id, next.updatedAt, 'REMOTE_APP_ID_CHANGED');
    recordVersion('channel_bot', id, current.revision, next, current);
    return next;
  };

  const transactionContext: FoundationTransactionContext = {
    secretRefs: { get: getSecretRef, create: createSecretRef, update: updateSecretRef, remove: removeSecretRef },
    channelBots: { get: getChannelBot, create: createChannelBot, update: updateChannelBot }
  };

  const transact = async <T>(work: (repositories: FoundationTransactionContext) => T): Promise<T> => {
    let value!: T;
    sqlite.transaction(() => {
      const candidate = work(transactionContext);
      if (isThenable(candidate)) {
        throw new RuntimeError('FOUNDATION_ASYNC_TRANSACTION_UNSUPPORTED', 'Foundation transaction callbacks must be synchronous', 400);
      }
      value = candidate;
    })();
    return value;
  };

  const rollbackLast = async (
    entityKind: FoundationEntityKind,
    entityId: string,
    expectedRevision: number
  ): Promise<FoundationRollbackResult> => {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw revisionConflict(entityKind, entityId, expectedRevision);
    let outcome!: FoundationRollbackResult;
    sqlite.transaction(() => {
      const current = entityKind === 'secret_ref' ? getSecretRef(entityId) : getChannelBot(entityId);
      if (!current) throw notFound(entityKind, entityId);
      if (current.revision !== expectedRevision) throw revisionConflict(entityKind, entityId, expectedRevision);
      const version = sqlite.prepare(`
        SELECT before_json, after_hash FROM foundation_entity_versions
        WHERE entity_kind = ? AND entity_id = ? AND to_revision = ?
      `).get(entityKind, entityId, expectedRevision) as VersionRow | undefined;
      if (!version || version.after_hash !== entityHash(current)) throw rollbackConflict(entityKind, entityId);

      if (version.before_json === null) {
        if (entityKind === 'secret_ref') {
          const references = sqlite.prepare(`SELECT (
            (SELECT COUNT(*) FROM channel_bots WHERE credential_ref = ?) +
            (SELECT COUNT(*) FROM remote_identity_facts WHERE credential_ref_id = ?) +
            (SELECT COUNT(*) FROM remote_chat_facts WHERE credential_ref_id = ?)
          ) AS count`).get(entityId, entityId, entityId) as { count: number };
          if (references.count > 0) {
            throw new RuntimeError('FOUNDATION_ROLLBACK_REFERENCED', `SecretRef ${entityId} is still referenced`, 409);
          }
          sqlite.prepare('DELETE FROM secret_refs WHERE id = ? AND revision = ?').run(entityId, expectedRevision);
        } else {
          sqlite.prepare('DELETE FROM channel_bots WHERE id = ? AND revision = ?').run(entityId, expectedRevision);
        }
        sqlite.prepare('DELETE FROM foundation_entity_versions WHERE entity_kind = ? AND entity_id = ?').run(entityKind, entityId);
        outcome = { entityKind, entityId, action: 'deleted', deletedRevision: expectedRevision };
        return;
      }

      if (entityKind === 'secret_ref') {
        const before = secretRefMetadataSchema.parse(JSON.parse(version.before_json));
        const restored = updateSecretRef(entityId, {
          expectedRevision,
          kind: before.kind,
          provider: before.provider,
          referenceKey: before.referenceKey,
          status: before.status
        });
        outcome = { entityKind, entityId, action: 'restored', revision: restored.revision };
      } else {
        const before = channelBotFoundationSchema.parse(JSON.parse(version.before_json));
        const restored = updateChannelBot(entityId, {
          expectedRevision,
          externalAppId: before.externalAppId,
          displayName: before.displayName,
          brand: before.brand,
          credentialRef: before.credentialRef ?? null,
          state: before.state
        });
        outcome = { entityKind, entityId, action: 'restored', revision: restored.revision };
      }
    })();
    return outcome;
  };

  return {
    secretRefs: {
      async list() { return (sqlite.prepare('SELECT * FROM secret_refs ORDER BY created_at, id').all() as SecretRefRow[]).map(decodeSecretRef); },
      async get(id) { return getSecretRef(id); },
      async create(input) { return transact(repositories => repositories.secretRefs.create(input)); },
      async update(id, input) { return transact(repositories => repositories.secretRefs.update(id, input)); },
      async remove(id, expectedRevision) { return transact(repositories => repositories.secretRefs.remove(id, expectedRevision)); }
    },
    channelBots: {
      async list() { return (sqlite.prepare('SELECT * FROM channel_bots ORDER BY created_at, id').all() as ChannelBotRow[]).map(decodeChannelBot); },
      async get(id) { return getChannelBot(id); },
      async create(input) { return transact(repositories => repositories.channelBots.create(input)); },
      async update(id, input) { return transact(repositories => repositories.channelBots.update(id, input)); },
      async readiness(id): Promise<ChannelBotFoundationReadiness> {
        const bot = getChannelBot(id);
        if (!bot) throw notFound('channel_bot', id);
        return getChannelBotFoundationReadiness(bot, bot.credentialRef ? getSecretRef(bot.credentialRef) : undefined);
      }
    },
    foundation: { transact, rollbackLast }
  };
}
