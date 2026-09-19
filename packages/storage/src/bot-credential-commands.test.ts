import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RuntimeError,
  type ManagementActor,
  type PreparedCredentialRef,
  type BotChangeRef,
  type SharedSecretChangeRef
} from '@dutydeck/shared';
import { runMigrations } from './migrations.js';
import { createConfigurationReader } from './bot-configuration-reader.js';
import { createConfigurationCommands } from './bot-configuration-commands.js';
import { createBotCredentialCommands } from './bot-credential-commands.js';
import { createScheduleFoundationRepositories } from './schedule-foundation.js';

const owner: ManagementActor = { kind: 'installation_owner', principalId: 'principal_installation_owner' };
const adminActor: ManagementActor = { kind: 'principal', principalId: 'principal_admin', channelBotId: 'bot_test' };
const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dutydeck-cred-commands-test-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'database.sqlite');
  let db = new Database(path);
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  db.prepare("UPDATE configuration_authority SET authority='v2' WHERE id=1").run();
  cleanup.push(() => {
    if (db.open) db.close();
  });
  const reopen = () => {
    db.close();
    db = new Database(path);
    db.pragma('foreign_keys=ON');
    cleanup.push(() => {
      if (db.open) db.close();
    });
    return db;
  };
  return { db, path, reopen };
}

function samplePolicyInput() {
  const human = { mode: 'owner_only' as const };
  const bots = { mode: 'allowlist' as const, selectors: [], peerEnabled: false };
  const risk = { mode: 'entry_authorized' as const };
  return {
    defaults: { model: 'test-model' },
    routingDefaults: { p2pMode: 'chat' as const, groupReplyMode: 'runtime_default' as const, mentionPolicy: 'always' as const },
    accessPolicy: {
      humanTalk: { p2p: human, managedGroup: human, newGroup: human },
      botTalk: { p2p: bots, managedGroup: bots, newGroup: bots },
      defaultOperate: { rules: [] },
      p2pOperate: { mode: 'none' as const }
    },
    execution: {
      permissionMode: 'ask' as const,
      preInjectPrompt: null,
      highRiskAccess: { p2p: risk, managedGroup: risk, newGroup: risk },
      riskControlMode: 'off' as const,
      highRiskPattern: '.*'
    },
    presentation: {
      webBaseUrl: null,
      structuredAskCards: false,
      groupCardMention: false,
      pushIntervalMs: 1000,
      traceLimit: 10,
      hideTraceOnComplete: false,
      completionReactionOnly: false,
      silentProgress: false
    },
    groupToolsPolicy: {
      readCeiling: false,
      discoverCeiling: false,
      sendCeiling: false,
      readDefault: false,
      discoverDefault: false,
      sendDefault: false
    }
  };
}

function seedBot(db: Database.Database, botId: string, appId: string, secret?: { id: string; rev?: number }) {
  const commands = createConfigurationCommands(db);
  const input: Parameters<typeof commands.create>[0] = {
    operationId: `op_create_${botId}`,
    actor: owner,
    botId,
    externalAppId: appId,
    expectedAppState: 'absent',
    bot: { displayName: `Bot ${botId}`, brand: 'feishu', state: 'staged', desiredListenerState: 'paused' },
    policy: samplePolicyInput()
  };
  if (secret) {
    input.preparedCredential = {
      secretId: secret.id,
      expectedRevision: secret.rev ?? 0,
      provider: 'vault',
      referenceKey: `keys/${secret.id}`,
      fingerprint: 'a'.repeat(64)
    };
  }
  return commands.create(input);
}

function seedAdminRole(db: Database.Database, botId: string, principalId: string) {
  db.prepare(`
    INSERT INTO role_assignments (
      id, schema_version, revision, channel_bot_id, group_binding_id, scope_key,
      principal_id, role, operate_scope, action_gates_json, state, expires_at, created_at, updated_at
    ) VALUES (
      ?, 1, 1, ?, NULL, 'bot',
      ?, 'admin', 'none', '{"terminalWrite":false,"highRisk":false,"groupToolsSend":false}', 'active', NULL,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    )
  `).run(`role_admin_${botId}_${principalId}`, botId, principalId);
}

const dump = (db: Database.Database) =>
  Object.fromEntries(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
      .map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '" ORDER BY rowid').all()])
  );

describe('bot-credential-commands', () => {
  describe('1. bindPreparedCredential', () => {
    it('binds new secret with revision 0 to existing bot without credential', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1');
      const credCommands = createBotCredentialCommands(db);

      const prepared: PreparedCredentialRef = {
        secretId: 'sec_new',
        expectedRevision: 0,
        provider: 'vault_provider',
        referenceKey: 'vault_key_1',
        fingerprint: '1'.repeat(64)
      };

      const ref: BotChangeRef = {
        operationId: 'op_bind_1',
        actor: owner,
        botId: 'bot_1',
        expectedRevision: 1
      };

      const snapshot = credCommands.bindPreparedCredential(ref, prepared);
      expect(snapshot.bot.id).toBe('bot_1');
      expect(snapshot.bot.credentialRef).toBe('sec_new');
      expect(snapshot.bot.revision).toBe(2);
      expect(snapshot.bot.authorizationRevision).toBe(2);
      expect(snapshot.bot.connectionGeneration).toBe(2);
      expect(snapshot.credential).toBeDefined();
      expect(snapshot.credential?.id).toBe('sec_new');
      expect(snapshot.credential?.kind).toBe('lark_app_secret');
      expect(snapshot.credential?.status).toBe('configured');
      expect(snapshot.credential?.revision).toBe(1);

      // Verify versions and changes
      const reader = createConfigurationReader(db);
      const changes = reader.listChanges(0, 10);
      expect(changes.length).toBe(2); // create + updated
      expect(changes[1]?.changeKind).toBe('updated');
      expect(changes[1]?.revision).toBe(2);

      const versions = reader.listVersions('bot_1');
      expect(versions.length).toBe(2);
      expect(versions[0]?.changeKind).toBe('updated');
      expect(versions[0]?.revision).toBe(2);
    });

    it('binds existing configured secret with positive revision', () => {
      const { db } = fixture();
      // Create bot_1 with secret_shared
      seedBot(db, 'bot_1', 'cli_app_1', { id: 'secret_shared' });
      // Create bot_2 without credential
      seedBot(db, 'bot_2', 'cli_app_2');

      const credCommands = createBotCredentialCommands(db);
      const prepared: PreparedCredentialRef = {
        secretId: 'secret_shared',
        expectedRevision: 1,
        provider: 'vault',
        referenceKey: 'keys/secret_shared',
        fingerprint: 'a'.repeat(64)
      };

      const snapshot = credCommands.bindPreparedCredential({
        operationId: 'op_bind_bot2',
        actor: owner,
        botId: 'bot_2',
        expectedRevision: 1
      }, prepared);

      expect(snapshot.bot.credentialRef).toBe('secret_shared');
      expect(snapshot.bot.revision).toBe(2);
      expect(snapshot.credential?.id).toBe('secret_shared');
      expect(snapshot.credential?.revision).toBe(1);
    });

    it('treats identical configured reference as no-op without bumping versions', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1', { id: 'sec_1' });
      const credCommands = createBotCredentialCommands(db);

      const prepared: PreparedCredentialRef = {
        secretId: 'sec_1',
        expectedRevision: 1,
        provider: 'vault',
        referenceKey: 'keys/sec_1',
        fingerprint: 'a'.repeat(64)
      };

      const beforeReader = createConfigurationReader(db);
      const initialSnapshot = beforeReader.read('bot_1')!;

      const result = credCommands.bindPreparedCredential({
        operationId: 'op_bind_noop',
        actor: owner,
        botId: 'bot_1',
        expectedRevision: 1
      }, prepared);

      expect(result.bot.revision).toBe(1);
      expect(result.bot.authorizationRevision).toBe(1);
      expect(result.bot.connectionGeneration).toBe(1);
      expect(result).toEqual(initialSnapshot);

      // Verify operation audit written, but no change record written
      const opRow = db.prepare('SELECT * FROM configuration_operations WHERE operation_id = ?').get('op_bind_noop');
      expect(opRow).toBeDefined();

      const changes = beforeReader.listChanges(0, 10);
      expect(changes.length).toBe(1); // Only initial creation
    });

    it('rejects revision 0 when secretId already exists in database', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1', { id: 'sec_exists' });
      seedBot(db, 'bot_2', 'cli_app_2');
      const credCommands = createBotCredentialCommands(db);

      expect(() =>
        credCommands.bindPreparedCredential({
          operationId: 'op_bind_conflict_0',
          actor: owner,
          botId: 'bot_2',
          expectedRevision: 1
        }, {
          secretId: 'sec_exists',
          expectedRevision: 0,
          provider: 'vault',
          referenceKey: 'keys/sec_exists',
          fingerprint: 'a'.repeat(64)
        })
      ).toThrow(RuntimeError);
    });

    it('rejects positive revision when secretId does not exist', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1');
      const credCommands = createBotCredentialCommands(db);

      expect(() =>
        credCommands.bindPreparedCredential({
          operationId: 'op_bind_not_found',
          actor: owner,
          botId: 'bot_1',
          expectedRevision: 1
        }, {
          secretId: 'sec_nonexistent',
          expectedRevision: 1,
          provider: 'vault',
          referenceKey: 'keys/nonexistent',
          fingerprint: 'a'.repeat(64)
        })
      ).toThrow(RuntimeError);
    });

    it('rejects positive revision on secret CAS revision mismatch', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1', { id: 'sec_1' });
      seedBot(db, 'bot_2', 'cli_app_2');
      const credCommands = createBotCredentialCommands(db);

      expect(() =>
        credCommands.bindPreparedCredential({
          operationId: 'op_bind_sec_cas_mismatch',
          actor: owner,
          botId: 'bot_2',
          expectedRevision: 1
        }, {
          secretId: 'sec_1',
          expectedRevision: 99, // mismatch, current is 1
          provider: 'vault',
          referenceKey: 'keys/sec_1',
          fingerprint: 'a'.repeat(64)
        })
      ).toThrow(RuntimeError);
    });

    it('rejects positive revision on metadata mismatch (cannot alter shared metadata via bind)', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1', { id: 'sec_1' });
      seedBot(db, 'bot_2', 'cli_app_2');
      const credCommands = createBotCredentialCommands(db);

      expect(() =>
        credCommands.bindPreparedCredential({
          operationId: 'op_bind_meta_mismatch',
          actor: owner,
          botId: 'bot_2',
          expectedRevision: 1
        }, {
          secretId: 'sec_1',
          expectedRevision: 1,
          provider: 'different_provider',
          referenceKey: 'keys/sec_1',
          fingerprint: 'a'.repeat(64)
        })
      ).toThrow(RuntimeError);
    });

    it('rejects bind when existing fact for current secret revision has conflicting fingerprint', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1', { id: 'sec_1' });
      seedBot(db, 'bot_2', 'cli_app_2');
      // Insert a remote identity fact with fingerprint 'b' for credential revision 1
      db.prepare(`
        INSERT INTO remote_identity_facts (
          id, schema_version, revision, channel_bot_id, credential_ref_id, credential_revision,
          credential_fingerprint, app_fingerprint, bot_identity_ref, tenant_ref, app_id_match,
          checked_at, expires_at, created_at, updated_at
        ) VALUES (
          'fact_id_1', 1, 1, 'bot_1', 'sec_1', 1,
          ?, ?, 'remote_bot_1', NULL, 1,
          '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `).run('b'.repeat(64), 'a'.repeat(64));

      const credCommands = createBotCredentialCommands(db);
      expect(() =>
        credCommands.bindPreparedCredential({
          operationId: 'op_bind_fp_conflict',
          actor: owner,
          botId: 'bot_2',
          expectedRevision: 1
        }, {
          secretId: 'sec_1',
          expectedRevision: 1,
          provider: 'vault',
          referenceKey: 'keys/sec_1',
          fingerprint: 'a'.repeat(64) // conflicts with fact's 'b'
        })
      ).toThrow(RuntimeError);
    });

    it('rejects bind on deleted tombstone bot', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1');
      const baseCommands = createConfigurationCommands(db);
      baseCommands.delete({
        operationId: 'op_del',
        actor: owner,
        botId: 'bot_1',
        expectedRevision: 1
      });

      const credCommands = createBotCredentialCommands(db);
      expect(() =>
        credCommands.bindPreparedCredential({
          operationId: 'op_bind_deleted',
          actor: owner,
          botId: 'bot_1',
          expectedRevision: 2
        }, {
          secretId: 'sec_new',
          expectedRevision: 0,
          provider: 'vault',
          referenceKey: 'keys/sec_new',
          fingerprint: 'a'.repeat(64)
        })
      ).toThrow(RuntimeError);
    });

    it('invalidates existing facts when credential binding changes', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1', { id: 'sec_old' });
      // Seed facts for bot_1 under sec_old
      db.prepare(`
        INSERT INTO remote_chat_facts (
          id, schema_version, revision, channel_bot_id, external_chat_id,
          membership_state, chat_type, credential_ref_id, credential_revision, credential_fingerprint,
          observed_at, expires_at, created_at, updated_at
        ) VALUES (
          'chat_fact_1', 1, 1, 'bot_1', 'oc_chat_1',
          'member', 'group', 'sec_old', 1, ?,
          '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `).run('a'.repeat(64));

      const credCommands = createBotCredentialCommands(db);
      credCommands.bindPreparedCredential({
        operationId: 'op_bind_change',
        actor: owner,
        botId: 'bot_1',
        expectedRevision: 1
      }, {
        secretId: 'sec_new',
        expectedRevision: 0,
        provider: 'vault',
        referenceKey: 'keys/sec_new',
        fingerprint: 'b'.repeat(64)
      });

      const fact = db.prepare('SELECT * FROM remote_chat_facts WHERE id = ?').get('chat_fact_1') as {
        revision: number;
        invalidated_at: string | null;
        error_code: string | null;
      };
      expect(fact.revision).toBe(2);
      expect(fact.invalidated_at).not.toBeNull();
      expect(fact.error_code).toBe('CREDENTIAL_BINDING_CHANGED');
    });
  });

  describe('2. rotateSharedSecret', () => {
    it('rotates shared secret across multiple bots and invalidates past facts', () => {
      const { db } = fixture();
      seedBot(db, 'bot_a', 'cli_app_a', { id: 'sec_shared', rev: 0 });
      seedBot(db, 'bot_b', 'cli_app_b', { id: 'sec_shared', rev: 1 });

      // Seed facts for both bots
      db.prepare(`
        INSERT INTO remote_identity_facts (
          id, schema_version, revision, channel_bot_id, credential_ref_id, credential_revision,
          credential_fingerprint, app_fingerprint, bot_identity_ref, tenant_ref, app_id_match,
          checked_at, expires_at, created_at, updated_at
        ) VALUES (
          'fact_id_a', 1, 1, 'bot_a', 'sec_shared', 1,
          ?, ?, 'remote_bot_a', NULL, 1,
          '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `).run('a'.repeat(64), 'a'.repeat(64));

      db.prepare(`
        INSERT INTO remote_chat_facts (
          id, schema_version, revision, channel_bot_id, external_chat_id,
          membership_state, chat_type, credential_ref_id, credential_revision, credential_fingerprint,
          observed_at, expires_at, created_at, updated_at
        ) VALUES (
          'fact_chat_b', 1, 1, 'bot_b', 'oc_chat_b',
          'member', 'group', 'sec_shared', 1, ?,
          '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `).run('a'.repeat(64));

      const credCommands = createBotCredentialCommands(db);

      const ref: SharedSecretChangeRef = {
        operationId: 'op_rot_shared_1',
        actor: owner,
        secretId: 'sec_shared',
        expectedSecretRevision: 1,
        bots: [
          { botId: 'bot_a', expectedRevision: 1 },
          { botId: 'bot_b', expectedRevision: 1 }
        ]
      };

      const prepared: PreparedCredentialRef = {
        secretId: 'sec_shared',
        expectedRevision: 1,
        provider: 'new_vault',
        referenceKey: 'keys/sec_shared_v2',
        fingerprint: 'f'.repeat(64)
      };

      const snapshots = credCommands.rotateSharedSecret(ref, prepared);
      expect(snapshots.length).toBe(2);

      expect(snapshots[0]?.bot.id).toBe('bot_a');
      expect(snapshots[0]?.bot.revision).toBe(2);
      expect(snapshots[0]?.bot.authorizationRevision).toBe(2);
      expect(snapshots[0]?.bot.connectionGeneration).toBe(2);
      expect(snapshots[0]?.credential?.revision).toBe(2);
      expect(snapshots[0]?.credential?.provider).toBe('new_vault');
      expect(snapshots[0]?.credential?.referenceKey).toBe('keys/sec_shared_v2');

      expect(snapshots[1]?.bot.id).toBe('bot_b');
      expect(snapshots[1]?.bot.revision).toBe(2);
      expect(snapshots[1]?.bot.authorizationRevision).toBe(2);
      expect(snapshots[1]?.bot.connectionGeneration).toBe(2);

      // Secret record in DB
      const secRow = db.prepare('SELECT * FROM secret_refs WHERE id = ?').get('sec_shared') as {
        revision: number;
        provider: string;
        reference_key: string;
        status: string;
      };
      expect(secRow.revision).toBe(2);
      expect(secRow.provider).toBe('new_vault');
      expect(secRow.reference_key).toBe('keys/sec_shared_v2');
      expect(secRow.status).toBe('configured');

      // Facts invalidated with CREDENTIAL_ROTATED
      const idFact = db.prepare('SELECT * FROM remote_identity_facts WHERE id = ?').get('fact_id_a') as {
        revision: number;
        error_code: string | null;
      };
      expect(idFact.revision).toBe(2);
      expect(idFact.error_code).toBe('CREDENTIAL_ROTATED');

      const chatFact = db.prepare('SELECT * FROM remote_chat_facts WHERE id = ?').get('fact_chat_b') as {
        revision: number;
        invalidated_at: string | null;
        error_code: string | null;
      };
      expect(chatFact.revision).toBe(2);
      expect(chatFact.invalidated_at).not.toBeNull();
      expect(chatFact.error_code).toBe('CREDENTIAL_ROTATED');
    });

    it('rotates shared secret when one referencing bot is a tombstone (deleted)', () => {
      const { db } = fixture();
      seedBot(db, 'bot_live', 'cli_app_live', { id: 'sec_shared', rev: 0 });
      seedBot(db, 'bot_dead', 'cli_app_dead', { id: 'sec_shared', rev: 1 });

      const baseCommands = createConfigurationCommands(db);
      baseCommands.delete({
        operationId: 'op_del_dead',
        actor: owner,
        botId: 'bot_dead',
        expectedRevision: 1
      });

      const credCommands = createBotCredentialCommands(db);
      // ref.bots must include tombstone bot with its updated revision (2)
      const snapshots = credCommands.rotateSharedSecret({
        operationId: 'op_rot_with_tombstone',
        actor: owner,
        secretId: 'sec_shared',
        expectedSecretRevision: 1,
        bots: [
          { botId: 'bot_dead', expectedRevision: 2 },
          { botId: 'bot_live', expectedRevision: 1 }
        ]
      }, {
        secretId: 'sec_shared',
        expectedRevision: 1,
        provider: 'vault_rot',
        referenceKey: 'keys/sec_shared_new',
        fingerprint: 'c'.repeat(64)
      });

      expect(snapshots.length).toBe(2);
      const deadSnapshot = snapshots.find(s => s.bot.id === 'bot_dead')!;
      expect(deadSnapshot.bot.state).toBe('deleted');
      expect(deadSnapshot.bot.revision).toBe(3);

      const liveSnapshot = snapshots.find(s => s.bot.id === 'bot_live')!;
      expect(liveSnapshot.bot.state).toBe('staged');
      expect(liveSnapshot.bot.revision).toBe(2);
    });

    it('rejects rotation if ref.bots omits a tombstone bot referencing the secret', () => {
      const { db } = fixture();
      seedBot(db, 'bot_live', 'cli_app_live', { id: 'sec_shared', rev: 0 });
      seedBot(db, 'bot_dead', 'cli_app_dead', { id: 'sec_shared', rev: 1 });

      const baseCommands = createConfigurationCommands(db);
      baseCommands.delete({
        operationId: 'op_del_dead',
        actor: owner,
        botId: 'bot_dead',
        expectedRevision: 1
      });

      const credCommands = createBotCredentialCommands(db);
      // Omit bot_dead from ref.bots -> must fail
      expect(() =>
        credCommands.rotateSharedSecret({
          operationId: 'op_rot_omit_dead',
          actor: owner,
          secretId: 'sec_shared',
          expectedSecretRevision: 1,
          bots: [{ botId: 'bot_live', expectedRevision: 1 }]
        }, {
          secretId: 'sec_shared',
          expectedRevision: 1,
          provider: 'vault_rot',
          referenceKey: 'keys/sec_shared_new',
          fingerprint: 'c'.repeat(64)
        })
      ).toThrow(RuntimeError);
    });

    it('invalidates facts of unlinked bots that previously referenced this secret revision', () => {
      const { db } = fixture();
      seedBot(db, 'bot_active', 'cli_app_active', { id: 'sec_shared', rev: 0 });
      seedBot(db, 'bot_unlinked', 'cli_app_unlinked', { id: 'sec_shared', rev: 1 });

      // bot_unlinked changes credential to another secret
      const credCommands = createBotCredentialCommands(db);
      credCommands.bindPreparedCredential({
        operationId: 'op_rebind_unlinked',
        actor: owner,
        botId: 'bot_unlinked',
        expectedRevision: 1
      }, {
        secretId: 'sec_other',
        expectedRevision: 0,
        provider: 'vault',
        referenceKey: 'keys/sec_other',
        fingerprint: '9'.repeat(64)
      });

      // Manually simulate an orphaned fact still pointing to sec_shared at revision 1 for bot_unlinked
      db.prepare(`
        INSERT INTO remote_chat_facts (
          id, schema_version, revision, channel_bot_id, external_chat_id,
          membership_state, chat_type, credential_ref_id, credential_revision, credential_fingerprint,
          observed_at, expires_at, created_at, updated_at
        ) VALUES (
          'fact_orphaned', 1, 1, 'bot_unlinked', 'oc_chat_orphaned',
          'member', 'group', 'sec_shared', 1, ?,
          '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `).run('a'.repeat(64));

      // Now rotate sec_shared; actual referencing bots is ONLY bot_active
      credCommands.rotateSharedSecret({
        operationId: 'op_rot_with_unlinked_fact',
        actor: owner,
        secretId: 'sec_shared',
        expectedSecretRevision: 1,
        bots: [{ botId: 'bot_active', expectedRevision: 1 }]
      }, {
        secretId: 'sec_shared',
        expectedRevision: 1,
        provider: 'vault_rot',
        referenceKey: 'keys/sec_shared_v2',
        fingerprint: '8'.repeat(64)
      });

      // Orphaned fact from unlinked bot must also be invalidated!
      const orphanedFact = db.prepare('SELECT * FROM remote_chat_facts WHERE id = ?').get('fact_orphaned') as {
        revision: number;
        invalidated_at: string | null;
        error_code: string | null;
      };
      expect(orphanedFact.revision).toBe(2);
      expect(orphanedFact.invalidated_at).not.toBeNull();
      expect(orphanedFact.error_code).toBe('CREDENTIAL_ROTATED');
    });

    it('allows recovering from invalid status to configured', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1', { id: 'sec_invalid' });
      // Set secret status to invalid
      db.prepare("UPDATE secret_refs SET status = 'invalid' WHERE id = 'sec_invalid'").run();

      const credCommands = createBotCredentialCommands(db);
      const snapshots = credCommands.rotateSharedSecret({
        operationId: 'op_rot_recovery',
        actor: owner,
        secretId: 'sec_invalid',
        expectedSecretRevision: 1,
        bots: [{ botId: 'bot_1', expectedRevision: 1 }]
      }, {
        secretId: 'sec_invalid',
        expectedRevision: 1,
        provider: 'vault',
        referenceKey: 'keys/sec_recovered',
        fingerprint: '7'.repeat(64)
      });

      expect(snapshots[0]?.credential?.status).toBe('configured');
      expect(snapshots[0]?.credential?.revision).toBe(2);
    });

    it('treats identical location and status configured as no-op', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1', { id: 'sec_1' });
      const credCommands = createBotCredentialCommands(db);

      const snapshots = credCommands.rotateSharedSecret({
        operationId: 'op_rot_noop',
        actor: owner,
        secretId: 'sec_1',
        expectedSecretRevision: 1,
        bots: [{ botId: 'bot_1', expectedRevision: 1 }]
      }, {
        secretId: 'sec_1',
        expectedRevision: 1,
        provider: 'vault',
        referenceKey: 'keys/sec_1',
        fingerprint: 'a'.repeat(64)
      });

      expect(snapshots[0]?.bot.revision).toBe(1);
      expect(snapshots[0]?.credential?.revision).toBe(1);

      const changes = createConfigurationReader(db).listChanges(0, 10);
      expect(changes.length).toBe(1); // Only creation change
    });

    it('rejects no-op on identical provider/key if existing facts have conflicting fingerprint', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1', { id: 'sec_1' });
      db.prepare(`
        INSERT INTO remote_identity_facts (
          id, schema_version, revision, channel_bot_id, credential_ref_id, credential_revision,
          credential_fingerprint, app_fingerprint, bot_identity_ref, tenant_ref, app_id_match,
          checked_at, expires_at, created_at, updated_at
        ) VALUES (
          'fact_fp_diff', 1, 1, 'bot_1', 'sec_1', 1,
          ?, ?, 'remote_bot_1', NULL, 1,
          '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `).run('e'.repeat(64), 'a'.repeat(64));

      const credCommands = createBotCredentialCommands(db);
      expect(() =>
        credCommands.rotateSharedSecret({
          operationId: 'op_rot_fp_conflict',
          actor: owner,
          secretId: 'sec_1',
          expectedSecretRevision: 1,
          bots: [{ botId: 'bot_1', expectedRevision: 1 }]
        }, {
          secretId: 'sec_1',
          expectedRevision: 1,
          provider: 'vault',
          referenceKey: 'keys/sec_1',
          fingerprint: 'f'.repeat(64) // mismatch with fact's e
        })
      ).toThrow(RuntimeError);
    });

    it('rejects rotation on duplicate botId in ref.bots', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1', { id: 'sec_1' });
      const credCommands = createBotCredentialCommands(db);

      expect(() =>
        credCommands.rotateSharedSecret({
          operationId: 'op_rot_dup_bots',
          actor: owner,
          secretId: 'sec_1',
          expectedSecretRevision: 1,
          bots: [
            { botId: 'bot_1', expectedRevision: 1 },
            { botId: 'bot_1', expectedRevision: 1 }
          ]
        }, {
          secretId: 'sec_1',
          expectedRevision: 1,
          provider: 'vault_new',
          referenceKey: 'keys/new',
          fingerprint: 'a'.repeat(64)
        })
      ).toThrow(RuntimeError);
    });
  });

  describe('3. unbound secret commands (create, rotate, remove)', () => {
    it('creates unbound secret with real kind', () => {
      const { db } = fixture();
      const credCommands = createBotCredentialCommands(db);

      const metadata = credCommands.createUnboundSecret(
        { operationId: 'op_unbound_create', actor: owner },
        'agent_env',
        {
          secretId: 'sec_unbound_1',
          expectedRevision: 0,
          provider: 'env_store',
          referenceKey: 'ENV_API_KEY',
          fingerprint: '2'.repeat(64)
        }
      );

      expect(metadata.id).toBe('sec_unbound_1');
      expect(metadata.kind).toBe('agent_env');
      expect(metadata.revision).toBe(1);
      expect(metadata.status).toBe('configured');

      const row = db.prepare('SELECT * FROM secret_refs WHERE id = ?').get('sec_unbound_1') as {
        kind: string;
        provider: string;
        reference_key: string;
      };
      expect(row.kind).toBe('agent_env');
      expect(row.provider).toBe('env_store');
      expect(row.reference_key).toBe('ENV_API_KEY');
    });

    it('rejects unbound create if secretId already exists', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1', { id: 'sec_exists' });
      const credCommands = createBotCredentialCommands(db);

      expect(() =>
        credCommands.createUnboundSecret(
          { operationId: 'op_unbound_create_dup', actor: owner },
          'generic',
          {
            secretId: 'sec_exists',
            expectedRevision: 0,
            provider: 'vault',
            referenceKey: 'keys/sec_exists',
            fingerprint: '2'.repeat(64)
          }
        )
      ).toThrow(RuntimeError);
    });

    it('rotates unbound secret preserving kind', () => {
      const { db } = fixture();
      const credCommands = createBotCredentialCommands(db);

      credCommands.createUnboundSecret(
        { operationId: 'op_unbound_create', actor: owner },
        'generic',
        {
          secretId: 'sec_unbound_gen',
          expectedRevision: 0,
          provider: 'provider_1',
          referenceKey: 'key_1',
          fingerprint: '3'.repeat(64)
        }
      );

      const rotated = credCommands.rotateUnboundSecret(
        { operationId: 'op_unbound_rotate', actor: owner },
        {
          secretId: 'sec_unbound_gen',
          expectedRevision: 1,
          provider: 'provider_2',
          referenceKey: 'key_2',
          fingerprint: '4'.repeat(64)
        }
      );

      expect(rotated.id).toBe('sec_unbound_gen');
      expect(rotated.kind).toBe('generic');
      expect(rotated.revision).toBe(2);
      expect(rotated.provider).toBe('provider_2');
      expect(rotated.referenceKey).toBe('key_2');
    });

    it('rejects unbound rotate if secret is referenced by a bot (including tombstone)', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1', { id: 'sec_referenced' });
      const credCommands = createBotCredentialCommands(db);

      expect(() =>
        credCommands.rotateUnboundSecret(
          { operationId: 'op_unbound_rot_ref_err', actor: owner },
          {
            secretId: 'sec_referenced',
            expectedRevision: 1,
            provider: 'provider_new',
            referenceKey: 'key_new',
            fingerprint: '5'.repeat(64)
          }
        )
      ).toThrow(RuntimeError);
    });

    it('rejects unbound rotate if secret has only fact references', () => {
      const { db } = fixture();
      const credCommands = createBotCredentialCommands(db);
      credCommands.createUnboundSecret(
        { operationId: 'op_create_fact_only', actor: owner },
        'lark_app_secret',
        {
          secretId: 'sec_fact_only',
          expectedRevision: 0,
          provider: 'p',
          referenceKey: 'k',
          fingerprint: '1'.repeat(64)
        }
      );

      // Seed another bot to own the fact
      seedBot(db, 'bot_other', 'cli_app_other');

      // Insert an identity fact referencing this secretId
      db.prepare(`
        INSERT INTO remote_identity_facts (
          id, schema_version, revision, channel_bot_id, credential_ref_id, credential_revision,
          credential_fingerprint, app_fingerprint, bot_identity_ref, tenant_ref, app_id_match,
          checked_at, expires_at, created_at, updated_at
        ) VALUES (
          'fact_orphan', 1, 1, 'bot_other', 'sec_fact_only', 1,
          ?, ?, 'remote_bot_other', NULL, 1,
          '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `).run('1'.repeat(64), '1'.repeat(64));

      expect(() =>
        credCommands.rotateUnboundSecret(
          { operationId: 'op_rot_fact_only', actor: owner },
          {
            secretId: 'sec_fact_only',
            expectedRevision: 1,
            provider: 'p2',
            referenceKey: 'k2',
            fingerprint: '2'.repeat(64)
          }
        )
      ).toThrow(RuntimeError);
    });

    it('removes unbound secret and returns original metadata', () => {
      const { db } = fixture();
      const credCommands = createBotCredentialCommands(db);
      credCommands.createUnboundSecret(
        { operationId: 'op_create_to_remove', actor: owner },
        'generic',
        {
          secretId: 'sec_to_remove',
          expectedRevision: 0,
          provider: 'prov_rem',
          referenceKey: 'key_rem',
          fingerprint: 'a'.repeat(64)
        }
      );

      const removed = credCommands.removeUnboundSecret(
        { operationId: 'op_remove_now', actor: owner },
        'sec_to_remove',
        1
      );

      expect(removed.id).toBe('sec_to_remove');
      expect(removed.kind).toBe('generic');
      expect(removed.revision).toBe(1);

      const inDb = db.prepare('SELECT * FROM secret_refs WHERE id = ?').get('sec_to_remove');
      expect(inDb).toBeUndefined();
    });

    it('rejects unbound remove if secret is referenced by bot or facts', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1', { id: 'sec_in_use' });
      const credCommands = createBotCredentialCommands(db);

      expect(() =>
        credCommands.removeUnboundSecret(
          { operationId: 'op_rem_in_use', actor: owner },
          'sec_in_use',
          1
        )
      ).toThrow(RuntimeError);
    });

    it('enumerates all 6 real FK references to secret_refs via PRAGMA', () => {
      const { db } = fixture();
      db.pragma('foreign_keys = ON');
      const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      const allRefs = tableRows
        .flatMap(({ name }) =>
          (db.pragma(`foreign_key_list("${name}")`) as Array<{ table: string; from: string }>).filter(x => x.table === 'secret_refs').map(x => `${name}.${x.from}`)
        )
        .sort();

      expect(allRefs).toEqual([
        'channel_bots.credential_ref',
        'remote_chat_facts.credential_ref_id',
        'remote_identity_facts.credential_ref_id',
        'schedule_definitions.secret_ref',
        'schedule_generations.secret_ref',
        'schedule_leases.secret_ref'
      ]);
    });

    it('rejects unbound rotate (including same-location no-op) and remove when referenced by a schedule lease', async () => {
      const { db } = fixture();
      db.pragma('foreign_keys = ON');
      const credCommands = createBotCredentialCommands(db);
      credCommands.createUnboundSecret(
        { operationId: 'op_create_lease_sec', actor: owner },
        'generic',
        {
          secretId: 'sec_lease',
          expectedRevision: 0,
          provider: 'vault',
          referenceKey: 'key_lease',
          fingerprint: 'a'.repeat(64)
        }
      );

      const schedules = createScheduleFoundationRepositories(db);
      await schedules.scheduleLeases.acquire({
        id: 'lease_1',
        leaseKey: 'writer:lease_1',
        expectedRevision: 0,
        expectedGeneration: 0,
        holderId: 'holder_1',
        holderIdentityRef: 'remote_bot_holder',
        secretRef: 'sec_lease',
        scheduleSetHash: 'c'.repeat(64),
        now: new Date().toISOString(),
        ttlMs: 60000
      });

      const before = dump(db);

      // 1. Rejects normal rotateUnboundSecret
      expect(() =>
        credCommands.rotateUnboundSecret(
          { operationId: 'op_rot_lease_sec', actor: owner },
          {
            secretId: 'sec_lease',
            expectedRevision: 1,
            provider: 'vault_new',
            referenceKey: 'key_new',
            fingerprint: 'b'.repeat(64)
          }
        )
      ).toThrow(/CONFIGURATION_CONFLICT/);
      expect(dump(db)).toEqual(before);

      // 2. Rejects same-location no-op rotateUnboundSecret
      expect(() =>
        credCommands.rotateUnboundSecret(
          { operationId: 'op_noop_lease_sec', actor: owner },
          {
            secretId: 'sec_lease',
            expectedRevision: 1,
            provider: 'vault',
            referenceKey: 'key_lease',
            fingerprint: 'a'.repeat(64)
          }
        )
      ).toThrow(/CONFIGURATION_CONFLICT/);
      expect(dump(db)).toEqual(before);

      // 3. Rejects removeUnboundSecret with explicit domain CONFIGURATION_CONFLICT (not raw SQLITE_CONSTRAINT)
      expect(() =>
        credCommands.removeUnboundSecret(
          { operationId: 'op_rem_lease_sec', actor: owner },
          'sec_lease',
          1
        )
      ).toThrow(/CONFIGURATION_CONFLICT/);
      expect(dump(db)).toEqual(before);
    });

    it('rejects unbound rotate and remove against schedule definition and historical generation', async () => {
      const { db } = fixture();
      db.pragma('foreign_keys = ON');
      seedBot(db, 'bot_def_owner', 'cli_app_def_owner');
      const credCommands = createBotCredentialCommands(db);
      credCommands.createUnboundSecret(
        { operationId: 'op_create_def_sec', actor: owner },
        'generic',
        {
          secretId: 'sec_def',
          expectedRevision: 0,
          provider: 'vault',
          referenceKey: 'key_def',
          fingerprint: 'a'.repeat(64)
        }
      );

      const schedules = createScheduleFoundationRepositories(db);
      await schedules.scheduleDefinitions.create({
        id: 'def_1',
        channelBotId: 'bot_def_owner',
        name: 'Test Definition',
        trigger: { kind: 'interval', everySeconds: 3600, anchorAt: '2026-01-01T00:00:00.000Z' },
        timezone: 'UTC',
        dstPolicy: { gap: 'skip', overlap: 'first' },
        delivery: { mode: 'chat', chatRef: 'chat_ref_1', continuation: 'chat_root' },
        payloadRef: 'payload_ref_1',
        secretRef: 'sec_def',
        sourceOwnership: 'dutydeck',
        sourceNamespace: 'test_ns',
        sourceEnabled: false
      });

      let before = dump(db);

      // Rejects rotate while definition references secret
      expect(() =>
        credCommands.rotateUnboundSecret(
          { operationId: 'op_rot_def_fail', actor: owner },
          {
            secretId: 'sec_def',
            expectedRevision: 1,
            provider: 'vault_rot',
            referenceKey: 'key_rot',
            fingerprint: 'b'.repeat(64)
          }
        )
      ).toThrow(/CONFIGURATION_CONFLICT/);
      expect(dump(db)).toEqual(before);

      // Now update definition to decouple secretRef: null
      await schedules.scheduleDefinitions.update('def_1', {
        expectedRevision: 1,
        secretRef: null
      });

      // Verification: definition itself now has secret_ref = null
      expect(db.prepare('SELECT secret_ref FROM schedule_definitions WHERE id = ?').get('def_1')).toEqual({ secret_ref: null });
      // But generation 1 still retains secret_ref = 'sec_def'
      expect(db.prepare('SELECT secret_ref FROM schedule_generations WHERE schedule_definition_id = ? AND generation = 1').get('def_1')).toEqual({ secret_ref: 'sec_def' });

      before = dump(db);

      // Still rejects unbound rotate because historical generation retains reference!
      expect(() =>
        credCommands.rotateUnboundSecret(
          { operationId: 'op_rot_gen_fail', actor: owner },
          {
            secretId: 'sec_def',
            expectedRevision: 1,
            provider: 'vault_rot',
            referenceKey: 'key_rot',
            fingerprint: 'b'.repeat(64)
          }
        )
      ).toThrow(/CONFIGURATION_CONFLICT/);
      expect(dump(db)).toEqual(before);

      // Still rejects unbound remove because historical generation retains reference!
      expect(() =>
        credCommands.removeUnboundSecret(
          { operationId: 'op_rem_gen_fail', actor: owner },
          'sec_def',
          1
        )
      ).toThrow(/CONFIGURATION_CONFLICT/);
      expect(dump(db)).toEqual(before);
    });
  });
});
