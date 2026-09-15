import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  RuntimeError,
  canonicalExecutionJson,
  botSnapshotSchema,
  botChangeRefSchema,
  sharedSecretChangeRefSchema,
  preparedCredentialRefSchema,
  botSecretRefMetadataSchema,
  createUnboundSecretInputSchema,
  rotateUnboundSecretInputSchema,
  removeUnboundSecretInputSchema,
  managementOperationSchema,
  secretRefKindsTuple,
  type BotSnapshot,
  type BotChangeRef,
  type SharedSecretChangeRef,
  type PreparedCredentialRef,
  type SecretRefMetadata,
  type SecretRefKind,
  type ManagementOperation,
  type ConfigurationRepository
} from '@dutydeck/shared';
import {
  runConfigurationCommand,
  nextConfigurationRevision,
  type ConfigurationCommand
} from './configuration-transaction.js';

export type BotCredentialCommands = Pick<
  ConfigurationRepository,
  'bindPreparedCredential' | 'rotateSharedSecret' | 'createUnboundSecret' | 'rotateUnboundSecret' | 'removeUnboundSecret'
>;

function fail(code: string, message: string, status = 409): never {
  throw new RuntimeError(code, `${code}: ${message}`, status);
}

function assertNoSecretReferences(db: Database.Database, secretId: string, action: string): void {
  if (db.prepare('SELECT 1 FROM channel_bots WHERE credential_ref = ? LIMIT 1').get(secretId)) {
    fail('CONFIGURATION_CONFLICT', `Cannot ${action} secret "${secretId}": referenced by channel_bots`);
  }
  if (db.prepare('SELECT 1 FROM remote_identity_facts WHERE credential_ref_id = ? LIMIT 1').get(secretId)) {
    fail('CONFIGURATION_CONFLICT', `Cannot ${action} secret "${secretId}": referenced by remote_identity_facts`);
  }
  if (db.prepare('SELECT 1 FROM remote_chat_facts WHERE credential_ref_id = ? LIMIT 1').get(secretId)) {
    fail('CONFIGURATION_CONFLICT', `Cannot ${action} secret "${secretId}": referenced by remote_chat_facts`);
  }
  if (db.prepare('SELECT 1 FROM schedule_definitions WHERE secret_ref = ? LIMIT 1').get(secretId)) {
    fail('CONFIGURATION_CONFLICT', `Cannot ${action} secret "${secretId}": referenced by schedule_definitions`);
  }
  if (db.prepare('SELECT 1 FROM schedule_generations WHERE secret_ref = ? LIMIT 1').get(secretId)) {
    fail('CONFIGURATION_CONFLICT', `Cannot ${action} secret "${secretId}": referenced by schedule_generations`);
  }
  if (db.prepare('SELECT 1 FROM schedule_leases WHERE secret_ref = ? LIMIT 1').get(secretId)) {
    fail('CONFIGURATION_CONFLICT', `Cannot ${action} secret "${secretId}": referenced by schedule_leases`);
  }
}

function invalidateBotFacts(db: Database.Database, botId: string, now: string, errorCode: string): void {
  const chatFacts = db.prepare(
    'SELECT id, revision FROM remote_chat_facts WHERE channel_bot_id = ? AND invalidated_at IS NULL'
  ).all(botId) as Array<{ id: string; revision: number }>;
  for (const fact of chatFacts) {
    const nextRev = nextConfigurationRevision(fact.revision);
    db.prepare(`
      UPDATE remote_chat_facts
      SET revision = ?, expires_at = ?, invalidated_at = ?, error_code = ?, updated_at = ?
      WHERE id = ?
    `).run(nextRev, now, now, errorCode, now, fact.id);
  }

  const idFacts = db.prepare(
    'SELECT id, revision FROM remote_identity_facts WHERE channel_bot_id = ?'
  ).all(botId) as Array<{ id: string; revision: number }>;
  for (const fact of idFacts) {
    const nextRev = nextConfigurationRevision(fact.revision);
    db.prepare(`
      UPDATE remote_identity_facts
      SET revision = ?, expires_at = CASE WHEN checked_at > ? THEN checked_at ELSE ? END, error_code = ?, updated_at = ?
      WHERE id = ?
    `).run(nextRev, now, now, errorCode, now, fact.id);
  }
}

// ----------------------------------------------------------------------------
// 1. bindPreparedCredential
// ----------------------------------------------------------------------------

const bindPreparedCredentialInputSchema = botChangeRefSchema.extend({
  prepared: preparedCredentialRefSchema
}).strict();
type BindPreparedCredentialInput = z.infer<typeof bindPreparedCredentialInputSchema>;

function bindPreparedCredentialCommand(db: Database.Database): ConfigurationCommand<BindPreparedCredentialInput, BotSnapshot> {
  return {
    action: 'bindPreparedCredential',
    inputSchema: bindPreparedCredentialInputSchema,
    resultSchema: botSnapshotSchema,
    operation: input => ({ operationId: input.operationId, actor: input.actor }),
    target: input => ({ botId: input.botId }),
    stablePayload(input) {
      const { expectedRevision: _botCas, prepared, ...rest } = input;
      const { expectedRevision: _pCas, ...stablePrepared } = prepared;
      return {
        ...rest,
        prepared: stablePrepared
      };
    },
    access: input => ({ kind: 'bot', botId: input.botId }),
    execute(input, context) {
      const original = context.before.get(input.botId)!;
      if (original.bot.state === 'deleted') {
        fail('CONFIGURATION_CONFLICT', `Cannot bind credential on deleted Bot "${input.botId}"`);
      }
      if (original.bot.revision !== input.expectedRevision) {
        fail('CONFIGURATION_REVISION_CONFLICT', `Bot revision mismatch: expected ${input.expectedRevision}, got ${original.bot.revision}`);
      }

      const cred = input.prepared;
      if (cred.expectedRevision === 0) {
        const existingSec = db.prepare('SELECT id FROM secret_refs WHERE id = ?').get(cred.secretId);
        if (existingSec) {
          fail('CONFIGURATION_CONFLICT', `SecretRef "${cred.secretId}" already exists for expectedRevision 0`);
        }
        db.prepare(`
          INSERT INTO secret_refs (
            id, schema_version, revision, kind, provider, reference_key, status, created_at, updated_at
          ) VALUES (?, 1, 1, 'lark_app_secret', ?, ?, 'configured', ?, ?)
        `).run(cred.secretId, cred.provider, cred.referenceKey, context.now, context.now);
      } else {
        const existingSec = db.prepare('SELECT * FROM secret_refs WHERE id = ?').get(cred.secretId) as {
          id: string;
          schema_version: number;
          revision: number;
          kind: string;
          provider: string;
          reference_key: string;
          status: string;
        } | undefined;
        if (!existingSec) {
          fail('CONFIGURATION_NOT_FOUND', `Referenced secret "${cred.secretId}" does not exist`, 404);
        }
        if (existingSec.revision !== cred.expectedRevision) {
          fail('CONFIGURATION_REVISION_CONFLICT', `SecretRef revision mismatch: expected ${cred.expectedRevision}, got ${existingSec.revision}`);
        }
        if (
          existingSec.kind !== 'lark_app_secret' ||
          existingSec.provider !== cred.provider ||
          existingSec.reference_key !== cred.referenceKey ||
          existingSec.status !== 'configured'
        ) {
          fail('CONFIGURATION_CONFLICT', `SecretRef metadata mismatch for "${cred.secretId}"`);
        }
        const mismatchedFingerprints = db.prepare(`
          SELECT DISTINCT credential_fingerprint AS fp FROM (
            SELECT credential_fingerprint FROM remote_identity_facts
            WHERE credential_ref_id = ? AND credential_revision = ? AND credential_fingerprint IS NOT NULL
            UNION ALL
            SELECT credential_fingerprint FROM remote_chat_facts
            WHERE credential_ref_id = ? AND credential_revision = ? AND credential_fingerprint IS NOT NULL
          ) WHERE fp != ?
        `).all(cred.secretId, existingSec.revision, cred.secretId, existingSec.revision, cred.fingerprint) as Array<{ fp: string }>;
        if (mismatchedFingerprints.length > 0) {
          fail('CONFIGURATION_CONFLICT', `Credential fingerprint mismatch for "${cred.secretId}"`);
        }
      }

      // No-op detection: reference unchanged and prepared metadata matches current configured state and facts
      if (original.bot.credentialRef === cred.secretId) {
        return original;
      }

      // Invalidate existing facts for this bot before binding new credential
      invalidateBotFacts(db, input.botId, context.now, 'CREDENTIAL_BINDING_CHANGED');

      db.prepare(`
        UPDATE channel_bots
        SET credential_ref = ?, updated_at = ?
        WHERE id = ?
      `).run(cred.secretId, context.now, input.botId);

      return context.recordChange(input.botId, { kind: 'updated', authorization: true, connection: true });
    }
  };
}

// ----------------------------------------------------------------------------
// 2. rotateSharedSecret
// ----------------------------------------------------------------------------

const rotateSharedSecretInputSchema = sharedSecretChangeRefSchema.extend({
  prepared: preparedCredentialRefSchema
}).strict().superRefine((val: z.infer<typeof sharedSecretChangeRefSchema> & { prepared: PreparedCredentialRef }, ctx: z.RefinementCtx) => {
  if (val.prepared.secretId !== val.secretId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['prepared', 'secretId'],
      message: `prepared.secretId "${val.prepared.secretId}" must match ref.secretId "${val.secretId}"`
    });
  }
  if (val.prepared.expectedRevision !== val.expectedSecretRevision) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['prepared', 'expectedRevision'],
      message: `prepared.expectedRevision "${val.prepared.expectedRevision}" must match ref.expectedSecretRevision "${val.expectedSecretRevision}"`
    });
  }
});
type RotateSharedSecretInput = z.infer<typeof rotateSharedSecretInputSchema>;

function rotateSharedSecretCommand(db: Database.Database): ConfigurationCommand<RotateSharedSecretInput, BotSnapshot[]> {
  return {
    action: 'rotateSharedSecret',
    inputSchema: rotateSharedSecretInputSchema,
    resultSchema: z.array(botSnapshotSchema),
    operation: input => ({ operationId: input.operationId, actor: input.actor }),
    target: input => ({ secretId: input.secretId }),
    stablePayload(input) {
      const sortedBotIds = input.bots.map((b: { botId: string; expectedRevision: number }) => b.botId).sort();
      const { expectedRevision: _pCas, ...stablePrepared } = input.prepared;
      return {
        operationId: input.operationId,
        actor: input.actor,
        secretId: input.secretId,
        botIds: sortedBotIds,
        prepared: stablePrepared
      };
    },
    access(input) {
      const hasScheduleRef =
        db.prepare('SELECT 1 FROM schedule_definitions WHERE secret_ref = ? LIMIT 1').get(input.secretId) !== undefined ||
        db.prepare('SELECT 1 FROM schedule_generations WHERE secret_ref = ? LIMIT 1').get(input.secretId) !== undefined ||
        db.prepare('SELECT 1 FROM schedule_leases WHERE secret_ref = ? LIMIT 1').get(input.secretId) !== undefined;

      if (hasScheduleRef) {
        const rows = db.prepare('SELECT id FROM channel_bots WHERE credential_ref = ? ORDER BY id ASC').all(input.secretId) as Array<{ id: string }>;
        const botIds = rows.map(r => r.id);
        return { kind: 'owner', botIds };
      }
      return { kind: 'shared_secret', secretId: input.secretId };
    },
    execute(input, context) {
      // Find all bots referencing this secretId in the database (unbounded query, including tombstone/deleted bots)
      const actualBots = db.prepare(
        'SELECT id, revision, state FROM channel_bots WHERE credential_ref = ? ORDER BY id ASC'
      ).all(input.secretId) as Array<{ id: string; revision: number; state: string }>;

      // Validate ref.bots has no duplicates
      const refBotIds = input.bots.map((b: { botId: string; expectedRevision: number }) => b.botId);
      if (new Set(refBotIds).size !== refBotIds.length) {
        fail('CONFIGURATION_DUPLICATE_TARGET', 'Duplicate botId in ref.bots');
      }

      // Complete equality check between actual referencing bots and ref.bots
      if (actualBots.length !== input.bots.length) {
        fail('CONFIGURATION_CONFLICT', 'Referenced bot set mismatch');
      }
      const refBotMap = new Map(input.bots.map((b: { botId: string; expectedRevision: number }) => [b.botId, b.expectedRevision]));
      for (const actual of actualBots) {
        if (!refBotMap.has(actual.id)) {
          fail('CONFIGURATION_CONFLICT', 'Referenced bot set mismatch');
        }
        const expectedRev = refBotMap.get(actual.id)!;
        if (actual.revision !== expectedRev) {
          fail(
            'CONFIGURATION_REVISION_CONFLICT',
            `Bot revision mismatch for ${actual.id}: expected ${expectedRev}, got ${actual.revision}`
          );
        }
      }

      const existingSec = db.prepare('SELECT * FROM secret_refs WHERE id = ?').get(input.secretId) as {
        id: string;
        schema_version: number;
        revision: number;
        kind: string;
        provider: string;
        reference_key: string;
        status: string;
      } | undefined;
      if (!existingSec) {
        fail('CONFIGURATION_NOT_FOUND', `SecretRef "${input.secretId}" not found`, 404);
      }
      if (existingSec.revision !== input.expectedSecretRevision) {
        fail(
          'CONFIGURATION_REVISION_CONFLICT',
          `SecretRef revision mismatch: expected ${input.expectedSecretRevision}, got ${existingSec.revision}`
        );
      }

      // No-op check: provider/key matches and status is configured
      const isSameLocationAndConfigured =
        existingSec.status === 'configured' &&
        existingSec.provider === input.prepared.provider &&
        existingSec.reference_key === input.prepared.referenceKey;

      if (isSameLocationAndConfigured) {
        // If current revision has facts with fingerprint, check for fingerprint conflict
        const mismatchedFingerprints = db.prepare(`
          SELECT DISTINCT credential_fingerprint AS fp FROM (
            SELECT credential_fingerprint FROM remote_identity_facts
            WHERE credential_ref_id = ? AND credential_revision = ? AND credential_fingerprint IS NOT NULL
            UNION ALL
            SELECT credential_fingerprint FROM remote_chat_facts
            WHERE credential_ref_id = ? AND credential_revision = ? AND credential_fingerprint IS NOT NULL
          ) WHERE fp != ?
        `).all(input.secretId, existingSec.revision, input.secretId, existingSec.revision, input.prepared.fingerprint) as Array<{ fp: string }>;

        if (mismatchedFingerprints.length > 0) {
          fail('CONFIGURATION_CONFLICT', 'Fingerprint conflict on identical provider/key, trusted service must prepare new key');
        }

        // Return snapshots in botId order without bumping any revisions or recording history
        return actualBots.map(b => context.before.get(b.id)!);
      }

      // Real rotation (or restoration from invalid/missing):
      // Retain secretId and kind, update provider/key, set status='configured', bump revision
      const nextSecretRev = nextConfigurationRevision(existingSec.revision);
      db.prepare(`
        UPDATE secret_refs
        SET revision = ?, provider = ?, reference_key = ?, status = 'configured', updated_at = ?
        WHERE id = ?
      `).run(nextSecretRev, input.prepared.provider, input.prepared.referenceKey, context.now, input.secretId);

      // Invalidate all facts associated with the old credential revision (including facts from unlinked bots)
      const chatFacts = db.prepare(
        'SELECT id, revision FROM remote_chat_facts WHERE credential_ref_id = ? AND credential_revision = ? AND invalidated_at IS NULL'
      ).all(input.secretId, existingSec.revision) as Array<{ id: string; revision: number }>;
      for (const fact of chatFacts) {
        const nextRev = nextConfigurationRevision(fact.revision);
        db.prepare(`
          UPDATE remote_chat_facts
          SET revision = ?, expires_at = ?, invalidated_at = ?, error_code = 'CREDENTIAL_ROTATED', updated_at = ?
          WHERE id = ?
        `).run(nextRev, context.now, context.now, context.now, fact.id);
      }

      const idFacts = db.prepare(
        'SELECT id, revision FROM remote_identity_facts WHERE credential_ref_id = ? AND credential_revision = ?'
      ).all(input.secretId, existingSec.revision) as Array<{ id: string; revision: number }>;
      for (const fact of idFacts) {
        const nextRev = nextConfigurationRevision(fact.revision);
        db.prepare(`
          UPDATE remote_identity_facts
          SET revision = ?, expires_at = CASE WHEN checked_at > ? THEN checked_at ELSE ? END, error_code = 'CREDENTIAL_ROTATED', updated_at = ?
          WHERE id = ?
        `).run(nextRev, context.now, context.now, context.now, fact.id);
      }

      // For every referencing bot (sorted by id), bump 3 versions and record secret_rotated history
      const snapshots: BotSnapshot[] = [];
      for (const b of actualBots) {
        const snapshot = context.recordChange(b.id, { kind: 'secret_rotated', authorization: true, connection: true });
        snapshots.push(snapshot);
      }
      return snapshots;
    }
  };
}

// ----------------------------------------------------------------------------
// 3. createUnboundSecret
// ----------------------------------------------------------------------------

type CreateUnboundSecretInput = z.infer<typeof createUnboundSecretInputSchema>;

function createUnboundSecretCommand(db: Database.Database): ConfigurationCommand<CreateUnboundSecretInput, SecretRefMetadata> {
  return {
    action: 'createUnboundSecret',
    inputSchema: createUnboundSecretInputSchema,
    resultSchema: botSecretRefMetadataSchema,
    operation: input => ({ operationId: input.op.operationId, actor: input.op.actor }),
    target: input => ({ secretId: input.prepared.secretId }),
    stablePayload(input) {
      const { expectedRevision: _pCas, ...stablePrepared } = input.prepared;
      return {
        op: input.op,
        kind: input.kind,
        prepared: stablePrepared
      };
    },
    access: input => ({ kind: 'unbound_secret', secretId: input.prepared.secretId }),
    execute(input, context) {
      const existingSec = db.prepare('SELECT id FROM secret_refs WHERE id = ?').get(input.prepared.secretId);
      if (existingSec) {
        fail('CONFIGURATION_CONFLICT', `SecretRef "${input.prepared.secretId}" already exists`);
      }

      assertNoSecretReferences(db, input.prepared.secretId, 'create');

      db.prepare(`
        INSERT INTO secret_refs (
          id, schema_version, revision, kind, provider, reference_key, status, created_at, updated_at
        ) VALUES (?, 1, 1, ?, ?, ?, 'configured', ?, ?)
      `).run(input.prepared.secretId, input.kind, input.prepared.provider, input.prepared.referenceKey, context.now, context.now);

      return {
        schemaVersion: 1,
        id: input.prepared.secretId,
        revision: 1,
        kind: input.kind,
        provider: input.prepared.provider,
        referenceKey: input.prepared.referenceKey,
        status: 'configured',
        createdAt: context.now,
        updatedAt: context.now
      };
    }
  };
}

// ----------------------------------------------------------------------------
// 4. rotateUnboundSecret
// ----------------------------------------------------------------------------

type RotateUnboundSecretInput = z.infer<typeof rotateUnboundSecretInputSchema>;

function rotateUnboundSecretCommand(db: Database.Database): ConfigurationCommand<RotateUnboundSecretInput, SecretRefMetadata> {
  return {
    action: 'rotateUnboundSecret',
    inputSchema: rotateUnboundSecretInputSchema,
    resultSchema: botSecretRefMetadataSchema,
    operation: input => ({ operationId: input.op.operationId, actor: input.op.actor }),
    target: input => ({ secretId: input.prepared.secretId }),
    stablePayload(input) {
      const { expectedRevision: _pCas, ...stablePrepared } = input.prepared;
      return {
        op: input.op,
        prepared: stablePrepared
      };
    },
    access: input => ({ kind: 'unbound_secret', secretId: input.prepared.secretId }),
    execute(input, context) {
      assertNoSecretReferences(db, input.prepared.secretId, 'rotate');

      const existingSec = db.prepare('SELECT * FROM secret_refs WHERE id = ?').get(input.prepared.secretId) as {
        id: string;
        schema_version: number;
        revision: number;
        kind: string;
        provider: string;
        reference_key: string;
        status: string;
        created_at: string;
        updated_at: string;
      } | undefined;
      if (!existingSec) {
        fail('CONFIGURATION_NOT_FOUND', `SecretRef "${input.prepared.secretId}" not found`, 404);
      }
      if (existingSec.revision !== input.prepared.expectedRevision) {
        fail(
          'CONFIGURATION_REVISION_CONFLICT',
          `SecretRef revision mismatch: expected ${input.prepared.expectedRevision}, got ${existingSec.revision}`
        );
      }

      // No-op check: provider/key matches and status is configured
      if (
        existingSec.status === 'configured' &&
        existingSec.provider === input.prepared.provider &&
        existingSec.reference_key === input.prepared.referenceKey
      ) {
        return {
          schemaVersion: 1,
          id: existingSec.id,
          revision: existingSec.revision,
          kind: existingSec.kind as SecretRefKind,
          provider: existingSec.provider,
          referenceKey: existingSec.reference_key,
          status: existingSec.status as 'configured' | 'invalid',
          createdAt: existingSec.created_at,
          updatedAt: existingSec.updated_at
        };
      }

      // Real rotation (or recovery from invalid): retain kind, bump revision
      const nextRev = nextConfigurationRevision(existingSec.revision);
      db.prepare(`
        UPDATE secret_refs
        SET revision = ?, provider = ?, reference_key = ?, status = 'configured', updated_at = ?
        WHERE id = ?
      `).run(nextRev, input.prepared.provider, input.prepared.referenceKey, context.now, input.prepared.secretId);

      return {
        schemaVersion: 1,
        id: existingSec.id,
        revision: nextRev,
        kind: existingSec.kind as SecretRefKind,
        provider: input.prepared.provider,
        referenceKey: input.prepared.referenceKey,
        status: 'configured',
        createdAt: existingSec.created_at,
        updatedAt: context.now
      };
    }
  };
}

// ----------------------------------------------------------------------------
// 5. removeUnboundSecret
// ----------------------------------------------------------------------------

type RemoveUnboundSecretInput = z.infer<typeof removeUnboundSecretInputSchema>;

function removeUnboundSecretCommand(db: Database.Database): ConfigurationCommand<RemoveUnboundSecretInput, SecretRefMetadata> {
  return {
    action: 'removeUnboundSecret',
    inputSchema: removeUnboundSecretInputSchema,
    resultSchema: botSecretRefMetadataSchema,
    operation: input => ({ operationId: input.op.operationId, actor: input.op.actor }),
    target: input => ({ secretId: input.secretId }),
    stablePayload(input) {
      const { expectedRevision: _cas, ...rest } = input;
      return rest;
    },
    access: input => ({ kind: 'unbound_secret', secretId: input.secretId }),
    execute(input, _context) {
      assertNoSecretReferences(db, input.secretId, 'remove');

      const existingSec = db.prepare('SELECT * FROM secret_refs WHERE id = ?').get(input.secretId) as {
        id: string;
        schema_version: number;
        revision: number;
        kind: string;
        provider: string;
        reference_key: string;
        status: string;
        created_at: string;
        updated_at: string;
      } | undefined;
      if (!existingSec) {
        fail('CONFIGURATION_NOT_FOUND', `SecretRef "${input.secretId}" not found`, 404);
      }
      if (existingSec.revision !== input.expectedRevision) {
        fail(
          'CONFIGURATION_REVISION_CONFLICT',
          `SecretRef revision mismatch: expected ${input.expectedRevision}, got ${existingSec.revision}`
        );
      }

      db.prepare('DELETE FROM secret_refs WHERE id = ?').run(input.secretId);

      return {
        schemaVersion: 1,
        id: existingSec.id,
        revision: existingSec.revision,
        kind: existingSec.kind as SecretRefKind,
        provider: existingSec.provider,
        referenceKey: existingSec.reference_key,
        status: existingSec.status as 'configured' | 'invalid',
        createdAt: existingSec.created_at,
        updatedAt: existingSec.updated_at
      };
    }
  };
}

// ----------------------------------------------------------------------------
// Export Factory
// ----------------------------------------------------------------------------

export function createBotCredentialCommands(
  db: Database.Database
): BotCredentialCommands {
  const bindCmd = bindPreparedCredentialCommand(db);
  const rotSharedCmd = rotateSharedSecretCommand(db);
  const createUnboundCmd = createUnboundSecretCommand(db);
  const rotUnboundCmd = rotateUnboundSecretCommand(db);
  const remUnboundCmd = removeUnboundSecretCommand(db);

  return {
    bindPreparedCredential(ref: BotChangeRef, prepared: PreparedCredentialRef): BotSnapshot {
      canonicalExecutionJson(ref);
      canonicalExecutionJson(prepared);
      if (Object.prototype.hasOwnProperty.call(ref, 'prepared')) {
        fail('CONFIGURATION_INVALID_INPUT', 'ref must not contain prepared property');
      }
      botChangeRefSchema.parse(JSON.parse(canonicalExecutionJson(ref)));
      preparedCredentialRefSchema.parse(JSON.parse(canonicalExecutionJson(prepared)));
      return runConfigurationCommand(db, { ...ref, prepared }, bindCmd);
    },

    rotateSharedSecret(ref: SharedSecretChangeRef, prepared: PreparedCredentialRef): BotSnapshot[] {
      canonicalExecutionJson(ref);
      canonicalExecutionJson(prepared);
      if (Object.prototype.hasOwnProperty.call(ref, 'prepared')) {
        fail('CONFIGURATION_INVALID_INPUT', 'ref must not contain prepared property');
      }
      sharedSecretChangeRefSchema.parse(JSON.parse(canonicalExecutionJson(ref)));
      preparedCredentialRefSchema.parse(JSON.parse(canonicalExecutionJson(prepared)));
      return runConfigurationCommand(db, { ...ref, prepared }, rotSharedCmd);
    },

    createUnboundSecret(op: ManagementOperation, kind: SecretRefKind, prepared: PreparedCredentialRef): SecretRefMetadata {
      canonicalExecutionJson(op);
      canonicalExecutionJson(prepared);
      if (Object.prototype.hasOwnProperty.call(op, 'kind') || Object.prototype.hasOwnProperty.call(op, 'prepared')) {
        fail('CONFIGURATION_INVALID_INPUT', 'op must not contain kind or prepared property');
      }
      managementOperationSchema.parse(JSON.parse(canonicalExecutionJson(op)));
      z.enum(secretRefKindsTuple).parse(kind);
      preparedCredentialRefSchema.parse(JSON.parse(canonicalExecutionJson(prepared)));
      return runConfigurationCommand(db, { op, kind, prepared }, createUnboundCmd);
    },

    rotateUnboundSecret(op: ManagementOperation, prepared: PreparedCredentialRef): SecretRefMetadata {
      canonicalExecutionJson(op);
      canonicalExecutionJson(prepared);
      if (Object.prototype.hasOwnProperty.call(op, 'prepared')) {
        fail('CONFIGURATION_INVALID_INPUT', 'op must not contain prepared property');
      }
      managementOperationSchema.parse(JSON.parse(canonicalExecutionJson(op)));
      preparedCredentialRefSchema.parse(JSON.parse(canonicalExecutionJson(prepared)));
      return runConfigurationCommand(db, { op, prepared }, rotUnboundCmd);
    },

    removeUnboundSecret(op: ManagementOperation, secretId: string, expectedRevision: number): SecretRefMetadata {
      canonicalExecutionJson(op);
      if (Object.prototype.hasOwnProperty.call(op, 'secretId') || Object.prototype.hasOwnProperty.call(op, 'expectedRevision')) {
        fail('CONFIGURATION_INVALID_INPUT', 'op must not contain secretId or expectedRevision property');
      }
      managementOperationSchema.parse(JSON.parse(canonicalExecutionJson(op)));
      z.string().min(1).parse(secretId);
      z.number().int().positive().safe().parse(expectedRevision);
      return runConfigurationCommand(db, { op, secretId, expectedRevision }, remUnboundCmd);
    }
  };
}
