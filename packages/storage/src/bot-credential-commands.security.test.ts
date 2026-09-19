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
import { createWp1aRepositories } from './group-policy.js';

const dump = (db: Database.Database) =>
  Object.fromEntries(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
      .map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '" ORDER BY rowid').all()])
  );

const owner: ManagementActor = { kind: 'installation_owner', principalId: 'principal_installation_owner' };
const adminA: ManagementActor = { kind: 'principal', principalId: 'principal_admin_a', channelBotId: 'bot_a' };
const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dutydeck-cred-security-test-'));
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

describe('bot-credential-commands.security', () => {
  describe('1. Wrapper input validation (collision fields, unknown properties, getters, prototype pollution)', () => {
    it('rejects bindPreparedCredential when ref has colliding "prepared" property', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1');
      const credCommands = createBotCredentialCommands(db);

      const badRef = {
        operationId: 'op_collision_1',
        actor: owner,
        botId: 'bot_1',
        expectedRevision: 1,
        prepared: { secretId: 'sneaky' }
      };

      const prepared: PreparedCredentialRef = {
        secretId: 'sec_new',
        expectedRevision: 0,
        provider: 'v',
        referenceKey: 'k',
        fingerprint: 'a'.repeat(64)
      };

      expect(() =>
        credCommands.bindPreparedCredential(badRef as any, prepared)
      ).toThrow(RuntimeError);
    });

    it('rejects bindPreparedCredential when ref or prepared has unknown property', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1');
      const credCommands = createBotCredentialCommands(db);

      const refWithUnknown = {
        operationId: 'op_unk_1',
        actor: owner,
        botId: 'bot_1',
        expectedRevision: 1,
        extraField: 'not_allowed'
      };

      const prepared: PreparedCredentialRef = {
        secretId: 'sec_new',
        expectedRevision: 0,
        provider: 'v',
        referenceKey: 'k',
        fingerprint: 'a'.repeat(64)
      };

      expect(() =>
        credCommands.bindPreparedCredential(refWithUnknown as any, prepared)
      ).toThrow();

      const refNormal = {
        operationId: 'op_unk_2',
        actor: owner,
        botId: 'bot_1',
        expectedRevision: 1
      };

      const preparedWithUnknown = {
        ...prepared,
        extraCredField: 'sneaky'
      };

      expect(() =>
        credCommands.bindPreparedCredential(refNormal, preparedWithUnknown as any)
      ).toThrow();
    });

    it('rejects getters on input without executing accessor side-effects', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1');
      const credCommands = createBotCredentialCommands(db);

      let sideEffect = 0;
      const refWithGetter = {
        operationId: 'op_getter_1',
        actor: owner,
        botId: 'bot_1',
        get expectedRevision() {
          sideEffect++;
          return 1;
        }
      };

      const prepared: PreparedCredentialRef = {
        secretId: 'sec_new',
        expectedRevision: 0,
        provider: 'v',
        referenceKey: 'k',
        fingerprint: 'a'.repeat(64)
      };

      expect(() =>
        credCommands.bindPreparedCredential(refWithGetter as any, prepared)
      ).toThrow();
      expect(sideEffect).toBe(0);

      // Additional comprehensive getter and accessor rejection on rotateSharedSecret
      seedBot(db, 'bot_rot_g', 'cli_app_rot_g', { id: 'sec_rot_g', rev: 0 });
      let called = 0;
      const baseRef = () => ({
        operationId: 'op_rot_g',
        actor: { ...owner },
        secretId: 'sec_rot_g',
        expectedSecretRevision: 1,
        bots: [{ botId: 'bot_rot_g', expectedRevision: 1 }]
      });

      const variants: (() => any)[] = [
        () => {
          const x = baseRef();
          Object.defineProperty(x.actor, 'hidden', { value: 'x' });
          return x;
        },
        () => {
          const x = baseRef();
          Object.defineProperty(x.bots[0], 'expectedRevision', {
            enumerable: true,
            get() {
              called++;
              return 1;
            }
          });
          return x;
        },
        () => {
          const x = baseRef();
          Object.defineProperty(x.bots, '0', {
            enumerable: true,
            get() {
              called++;
              return { botId: 'bot_rot_g', expectedRevision: 1 };
            }
          });
          return x;
        },
        () => {
          const x = baseRef();
          Object.defineProperty(x.bots, 'toJSON', {
            get() {
              called++;
              return () => [];
            }
          });
          return x;
        }
      ];

      const before = dump(db);
      for (const make of variants) {
        expect(() =>
          credCommands.rotateSharedSecret(make(), {
            secretId: 'sec_rot_g',
            expectedRevision: 1,
            provider: 'v',
            referenceKey: 'k',
            fingerprint: 'a'.repeat(64)
          })
        ).toThrow();
        expect(called).toBe(0);
        expect(dump(db)).toEqual(before);
      }
    });

    it('rejects rotateSharedSecret when ref has colliding "prepared" or unknown fields', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1', { id: 'sec_1' });
      const credCommands = createBotCredentialCommands(db);

      const badRef = {
        operationId: 'op_rot_bad',
        actor: owner,
        secretId: 'sec_1',
        expectedSecretRevision: 1,
        bots: [{ botId: 'bot_1', expectedRevision: 1 }],
        prepared: 'collide'
      };

      const prepared: PreparedCredentialRef = {
        secretId: 'sec_1',
        expectedRevision: 1,
        provider: 'v2',
        referenceKey: 'k2',
        fingerprint: 'b'.repeat(64)
      };

      expect(() => credCommands.rotateSharedSecret(badRef as any, prepared)).toThrow();
    });

    it('rejects createUnboundSecret when op contains colliding "kind" or "prepared"', () => {
      const { db } = fixture();
      const credCommands = createBotCredentialCommands(db);

      const badOp = {
        operationId: 'op_unbound_bad',
        actor: owner,
        kind: 'generic'
      };

      const prepared: PreparedCredentialRef = {
        secretId: 'sec_u',
        expectedRevision: 0,
        provider: 'v',
        referenceKey: 'k',
        fingerprint: 'a'.repeat(64)
      };

      expect(() => credCommands.createUnboundSecret(badOp as any, 'generic', prepared)).toThrow(RuntimeError);
    });

    it('rejects rotateUnboundSecret when op contains colliding "prepared"', () => {
      const { db } = fixture();
      const credCommands = createBotCredentialCommands(db);

      const badOp = {
        operationId: 'op_u_rot_bad',
        actor: owner,
        prepared: 'collision'
      };

      const prepared: PreparedCredentialRef = {
        secretId: 'sec_u',
        expectedRevision: 1,
        provider: 'v',
        referenceKey: 'k',
        fingerprint: 'a'.repeat(64)
      };

      expect(() => credCommands.rotateUnboundSecret(badOp as any, prepared)).toThrow(RuntimeError);
    });

    it('rejects removeUnboundSecret when op contains colliding "secretId" or "expectedRevision"', () => {
      const { db } = fixture();
      const credCommands = createBotCredentialCommands(db);

      const badOp = {
        operationId: 'op_u_rem_bad',
        actor: owner,
        secretId: 'sec_u'
      };

      expect(() => credCommands.removeUnboundSecret(badOp as any, 'sec_u', 1)).toThrow(RuntimeError);
    });
  });

  describe('2. Idempotent replay with real SQLite close / reopen', () => {
    it('replays bindPreparedCredential after reopen without duplicate writes', () => {
      const { db, reopen } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1');
      let credCommands = createBotCredentialCommands(db);

      const ref: BotChangeRef = {
        operationId: 'op_bind_reopen',
        actor: owner,
        botId: 'bot_1',
        expectedRevision: 1
      };
      const prepared: PreparedCredentialRef = {
        secretId: 'sec_reopen',
        expectedRevision: 0,
        provider: 'vault',
        referenceKey: 'keys/reopen',
        fingerprint: 'a'.repeat(64)
      };

      const firstSnapshot = credCommands.bindPreparedCredential(ref, prepared);

      // Reopen database connection
      const reopenedDb = reopen();
      credCommands = createBotCredentialCommands(reopenedDb);

      // Replay identical operationId
      const replaySnapshot = credCommands.bindPreparedCredential(ref, prepared);
      expect(replaySnapshot).toEqual(firstSnapshot);

      // Check operations, versions and changes count
      const opCount = reopenedDb.prepare('SELECT count(*) AS c FROM configuration_operations WHERE operation_id = ?').get('op_bind_reopen') as { c: number };
      expect(opCount.c).toBe(1);

      const verCount = reopenedDb.prepare('SELECT count(*) AS c FROM configuration_versions WHERE bot_id = ?').get('bot_1') as { c: number };
      expect(verCount.c).toBe(2); // 1 create + 1 updated
    });

    it('replays rotateSharedSecret after reopen without duplicate writes', () => {
      const { db, reopen } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1', { id: 'sec_shared_reopen', rev: 0 });
      let credCommands = createBotCredentialCommands(db);

      const ref: SharedSecretChangeRef = {
        operationId: 'op_rot_reopen',
        actor: owner,
        secretId: 'sec_shared_reopen',
        expectedSecretRevision: 1,
        bots: [{ botId: 'bot_1', expectedRevision: 1 }]
      };
      const prepared: PreparedCredentialRef = {
        secretId: 'sec_shared_reopen',
        expectedRevision: 1,
        provider: 'vault_v2',
        referenceKey: 'keys/v2',
        fingerprint: 'b'.repeat(64)
      };

      const firstSnapshots = credCommands.rotateSharedSecret(ref, prepared);

      const reopenedDb = reopen();
      credCommands = createBotCredentialCommands(reopenedDb);

      const replaySnapshots = credCommands.rotateSharedSecret(ref, prepared);
      expect(replaySnapshots).toEqual(firstSnapshots);

      const opCount = reopenedDb.prepare('SELECT count(*) AS c FROM configuration_operations WHERE operation_id = ?').get('op_rot_reopen') as { c: number };
      expect(opCount.c).toBe(1);

      const verCount = reopenedDb.prepare('SELECT count(*) AS c FROM configuration_versions WHERE bot_id = ?').get('bot_1') as { c: number };
      expect(verCount.c).toBe(2);
    });

    it('replays removeUnboundSecret returning original metadata after secret is deleted from db', () => {
      const { db, reopen } = fixture();
      let credCommands = createBotCredentialCommands(db);

      credCommands.createUnboundSecret(
        { operationId: 'op_unb_create', actor: owner },
        'generic',
        {
          secretId: 'sec_del_replay',
          expectedRevision: 0,
          provider: 'p',
          referenceKey: 'k',
          fingerprint: 'a'.repeat(64)
        }
      );

      const firstResult = credCommands.removeUnboundSecret(
        { operationId: 'op_del_replay', actor: owner },
        'sec_del_replay',
        1
      );

      const reopenedDb = reopen();
      credCommands = createBotCredentialCommands(reopenedDb);

      // In reopened DB, sec_del_replay is already deleted from secret_refs
      const checkRow = reopenedDb.prepare('SELECT * FROM secret_refs WHERE id = ?').get('sec_del_replay');
      expect(checkRow).toBeUndefined();

      // Replay should return the saved result
      const replayResult = credCommands.removeUnboundSecret(
        { operationId: 'op_del_replay', actor: owner },
        'sec_del_replay',
        1
      );
      expect(replayResult).toEqual(firstResult);
    });
  });

  describe('3. Operation conflict detection (different action, actor, or stable payload)', () => {
    it('rejects same operationId with different action', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1', { id: 'sec_1' });
      const credCommands = createBotCredentialCommands(db);

      credCommands.bindPreparedCredential({
        operationId: 'op_conflict_action',
        actor: owner,
        botId: 'bot_1',
        expectedRevision: 1
      }, {
        secretId: 'sec_1',
        expectedRevision: 1,
        provider: 'vault',
        referenceKey: 'keys/sec_1',
        fingerprint: 'a'.repeat(64)
      });

      // Try calling rotateSharedSecret with the same operationId
      expect(() =>
        credCommands.rotateSharedSecret({
          operationId: 'op_conflict_action',
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
        })
      ).toThrow(RuntimeError);
    });

    it('rejects same operationId with different actor', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1', { id: 'sec_1' });
      seedAdminRole(db, 'bot_1', 'principal_admin_1');
      const credCommands = createBotCredentialCommands(db);

      credCommands.bindPreparedCredential({
        operationId: 'op_conflict_actor',
        actor: owner,
        botId: 'bot_1',
        expectedRevision: 1
      }, {
        secretId: 'sec_1',
        expectedRevision: 1,
        provider: 'vault',
        referenceKey: 'keys/sec_1',
        fingerprint: 'a'.repeat(64)
      });

      const adminPrincipal: ManagementActor = {
        kind: 'principal',
        principalId: 'principal_admin_1',
        channelBotId: 'bot_1'
      };

      expect(() =>
        credCommands.bindPreparedCredential({
          operationId: 'op_conflict_actor',
          actor: adminPrincipal,
          botId: 'bot_1',
          expectedRevision: 1
        }, {
          secretId: 'sec_1',
          expectedRevision: 1,
          provider: 'vault',
          referenceKey: 'keys/sec_1',
          fingerprint: 'a'.repeat(64)
        })
      ).toThrow(RuntimeError);
    });

    it('rejects same operationId with different stable payload', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1');
      const credCommands = createBotCredentialCommands(db);

      credCommands.bindPreparedCredential({
        operationId: 'op_conflict_payload',
        actor: owner,
        botId: 'bot_1',
        expectedRevision: 1
      }, {
        secretId: 'sec_p1',
        expectedRevision: 0,
        provider: 'vault',
        referenceKey: 'keys/sec_p1',
        fingerprint: 'a'.repeat(64)
      });

      // Same operationId, different provider
      expect(() =>
        credCommands.bindPreparedCredential({
          operationId: 'op_conflict_payload',
          actor: owner,
          botId: 'bot_1',
          expectedRevision: 1
        }, {
          secretId: 'sec_p1',
          expectedRevision: 0,
          provider: 'different_vault',
          referenceKey: 'keys/sec_p1',
          fingerprint: 'a'.repeat(64)
        })
      ).toThrow(RuntimeError);
    });
  });

  describe('4. Replay CAS tolerance vs unsafe nested input validation', () => {
    it('allows replay when expectedRevision changes to another valid safe integer, but rejects unsafe numbers at entry', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1', { id: 'sec_1' });
      const credCommands = createBotCredentialCommands(db);

      const firstResult = credCommands.bindPreparedCredential({
        operationId: 'op_cas_replay',
        actor: owner,
        botId: 'bot_1',
        expectedRevision: 1
      }, {
        secretId: 'sec_1',
        expectedRevision: 1,
        provider: 'vault',
        referenceKey: 'keys/sec_1',
        fingerprint: 'a'.repeat(64)
      });

      // Replay with a different valid safe positive integer for expectedRevision
      const replayResult = credCommands.bindPreparedCredential({
        operationId: 'op_cas_replay',
        actor: owner,
        botId: 'bot_1',
        expectedRevision: 99
      }, {
        secretId: 'sec_1',
        expectedRevision: 1,
        provider: 'vault',
        referenceKey: 'keys/sec_1',
        fingerprint: 'a'.repeat(64)
      });
      expect(replayResult).toEqual(firstResult);

      // Replay with an unsafe number for expectedRevision -> rejected at input schema before replay check!
      expect(() =>
        credCommands.bindPreparedCredential({
          operationId: 'op_cas_replay',
          actor: owner,
          botId: 'bot_1',
          expectedRevision: Number.MAX_SAFE_INTEGER + 1
        } as any, {
          secretId: 'sec_1',
          expectedRevision: 1,
          provider: 'vault',
          referenceKey: 'keys/sec_1',
          fingerprint: 'a'.repeat(64)
        })
      ).toThrow();

      // Replay with unsafe prepared.expectedRevision -> rejected at entry
      expect(() =>
        credCommands.bindPreparedCredential({
          operationId: 'op_cas_replay',
          actor: owner,
          botId: 'bot_1',
          expectedRevision: 1
        }, {
          secretId: 'sec_1',
          expectedRevision: 1e100,
          provider: 'vault',
          referenceKey: 'keys/sec_1',
          fingerprint: 'a'.repeat(64)
        } as any)
      ).toThrow();
    });

    it('rejects unsafe CAS in rotateSharedSecret replay at schema validation boundary', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1', { id: 'sec_rot_cas' });
      const credCommands = createBotCredentialCommands(db);

      const firstSnapshots = credCommands.rotateSharedSecret({
        operationId: 'op_rot_cas_replay',
        actor: owner,
        secretId: 'sec_rot_cas',
        expectedSecretRevision: 1,
        bots: [{ botId: 'bot_1', expectedRevision: 1 }]
      }, {
        secretId: 'sec_rot_cas',
        expectedRevision: 1,
        provider: 'v',
        referenceKey: 'k',
        fingerprint: 'a'.repeat(64)
      });

      // Legal replay with different safe expectedRevision
      const replaySnapshots = credCommands.rotateSharedSecret({
        operationId: 'op_rot_cas_replay',
        actor: owner,
        secretId: 'sec_rot_cas',
        expectedSecretRevision: 5,
        bots: [{ botId: 'bot_1', expectedRevision: 10 }]
      }, {
        secretId: 'sec_rot_cas',
        expectedRevision: 5,
        provider: 'v',
        referenceKey: 'k',
        fingerprint: 'a'.repeat(64)
      });
      expect(replaySnapshots).toEqual(firstSnapshots);

      // Unsafe expectedSecretRevision
      expect(() =>
        credCommands.rotateSharedSecret({
          operationId: 'op_rot_cas_replay',
          actor: owner,
          secretId: 'sec_rot_cas',
          expectedSecretRevision: Number.MAX_SAFE_INTEGER + 1,
          bots: [{ botId: 'bot_1', expectedRevision: 1 }]
        } as any, {
          secretId: 'sec_rot_cas',
          expectedRevision: 1,
          provider: 'v',
          referenceKey: 'k',
          fingerprint: 'a'.repeat(64)
        })
      ).toThrow();

      // Unsafe bots[0].expectedRevision
      expect(() =>
        credCommands.rotateSharedSecret({
          operationId: 'op_rot_cas_replay',
          actor: owner,
          secretId: 'sec_rot_cas',
          expectedSecretRevision: 1,
          bots: [{ botId: 'bot_1', expectedRevision: 1e100 }]
        } as any, {
          secretId: 'sec_rot_cas',
          expectedRevision: 1,
          provider: 'v',
          referenceKey: 'k',
          fingerprint: 'a'.repeat(64)
        })
      ).toThrow();
    });
  });

  describe('5. Authorization revocation before replay and multi-bot permissions', () => {
    it('rejects replay if principal admin permission was revoked after the initial success', () => {
      const { db } = fixture();
      seedBot(db, 'bot_a', 'cli_app_a');
      seedAdminRole(db, 'bot_a', 'principal_admin_a');
      const credCommands = createBotCredentialCommands(db);

      const ref: BotChangeRef = {
        operationId: 'op_bind_auth_revoked',
        actor: adminA,
        botId: 'bot_a',
        expectedRevision: 1
      };
      const prepared: PreparedCredentialRef = {
        secretId: 'sec_auth_test',
        expectedRevision: 0,
        provider: 'vault',
        referenceKey: 'keys/auth',
        fingerprint: 'a'.repeat(64)
      };

      // Initial execution succeeds
      const result = credCommands.bindPreparedCredential(ref, prepared);
      expect(result.bot.credentialRef).toBe('sec_auth_test');

      // Revoke admin role in database
      db.prepare("UPDATE role_assignments SET state = 'revoked' WHERE channel_bot_id = 'bot_a'").run();

      // Replay identical operationId -> must be rejected with 403 CONFIGURATION_FORBIDDEN!
      expect(() =>
        credCommands.bindPreparedCredential(ref, prepared)
      ).toThrow(RuntimeError);

      try {
        credCommands.bindPreparedCredential(ref, prepared);
      } catch (e: any) {
        expect(e.statusCode).toBe(403);
        expect(e.code).toBe('CONFIGURATION_FORBIDDEN');
      }
    });

    it('rejects rotateSharedSecret if principal is admin of bot A but not bot B', () => {
      const { db } = fixture();
      seedBot(db, 'bot_a', 'cli_app_a', { id: 'sec_cross', rev: 0 });
      seedBot(db, 'bot_b', 'cli_app_b', { id: 'sec_cross', rev: 1 });
      seedAdminRole(db, 'bot_a', 'principal_admin_a');
      // Notice: principal_admin_a is NOT admin of bot_b!

      const credCommands = createBotCredentialCommands(db);

      expect(() =>
        credCommands.rotateSharedSecret({
          operationId: 'op_rot_cross_fail',
          actor: adminA,
          secretId: 'sec_cross',
          expectedSecretRevision: 1,
          bots: [
            { botId: 'bot_a', expectedRevision: 1 },
            { botId: 'bot_b', expectedRevision: 1 }
          ]
        }, {
          secretId: 'sec_cross',
          expectedRevision: 1,
          provider: 'vault_new',
          referenceKey: 'keys/new',
          fingerprint: 'b'.repeat(64)
        })
      ).toThrow(RuntimeError);

      try {
        credCommands.rotateSharedSecret({
          operationId: 'op_rot_cross_fail',
          actor: adminA,
          secretId: 'sec_cross',
          expectedSecretRevision: 1,
          bots: [
            { botId: 'bot_a', expectedRevision: 1 },
            { botId: 'bot_b', expectedRevision: 1 }
          ]
        }, {
          secretId: 'sec_cross',
          expectedRevision: 1,
          provider: 'vault_new',
          referenceKey: 'keys/new',
          fingerprint: 'b'.repeat(64)
        });
      } catch (e: any) {
        expect(e.statusCode).toBe(403);
        expect(e.code).toBe('CONFIGURATION_FORBIDDEN');
      }
    });

    it('rejects unbound commands when invoked by non-installation-owner principal', () => {
      const { db } = fixture();
      seedBot(db, 'bot_a', 'cli_app_a');
      seedAdminRole(db, 'bot_a', 'principal_admin_a');
      const credCommands = createBotCredentialCommands(db);

      expect(() =>
        credCommands.createUnboundSecret(
          { operationId: 'op_unb_principal_create', actor: adminA },
          'generic',
          {
            secretId: 'sec_p_fail',
            expectedRevision: 0,
            provider: 'p',
            referenceKey: 'k',
            fingerprint: 'a'.repeat(64)
          }
        )
      ).toThrow();

      expect(() =>
        credCommands.rotateUnboundSecret(
          { operationId: 'op_unb_principal_rot', actor: adminA },
          {
            secretId: 'sec_p_fail',
            expectedRevision: 1,
            provider: 'p',
            referenceKey: 'k',
            fingerprint: 'a'.repeat(64)
          }
        )
      ).toThrow();

      expect(() =>
        credCommands.removeUnboundSecret(
          { operationId: 'op_unb_principal_rem', actor: adminA },
          'sec_p_fail',
          1
        )
      ).toThrow();
    });

    const scheduleCases = [
      'definition_other_app',
      'definition_same_app',
      'generation_only',
      'lease_held',
      'lease_released'
    ] as const;

    async function addScheduleReference(db: Database.Database, kind: typeof scheduleCases[number], secretId = 'sec_matrix') {
      const s = createScheduleFoundationRepositories(db);
      if (kind.startsWith('lease_')) {
        await s.scheduleLeases.acquire({
          id: 'lease_probe',
          leaseKey: 'writer:probe',
          expectedRevision: 0,
          expectedGeneration: 0,
          holderId: 'holder',
          holderIdentityRef: 'remote_bot_holder',
          secretRef: secretId,
          scheduleSetHash: 'c'.repeat(64),
          now: new Date().toISOString(),
          ttlMs: 60000
        });
        // No public release method exists; seed the schema-supported historical released row while retaining its actual FK.
        if (kind === 'lease_released') {
          db.prepare("UPDATE schedule_leases SET state = 'released' WHERE id = 'lease_probe'").run();
        }
        expect(await s.scheduleLeases.getByKey('writer:probe')).toMatchObject({
          state: kind === 'lease_held' ? 'held' : 'released',
          secretRef: secretId
        });
        expect(db.prepare('SELECT count(*) AS n FROM schedule_definitions').get()).toEqual({ n: 0 });
        expect(db.prepare('SELECT count(*) AS n FROM schedule_generations').get()).toEqual({ n: 0 });
      } else {
        await s.scheduleDefinitions.create({
          id: 'schedule_probe',
          channelBotId: kind === 'definition_same_app' ? 'bot_a' : 'bot_b',
          name: 'S',
          trigger: { kind: 'interval', everySeconds: 3600, anchorAt: '2026-01-01T00:00:00.000Z' },
          timezone: 'UTC',
          dstPolicy: { gap: 'skip', overlap: 'first' },
          delivery: { mode: 'chat', chatRef: 'chat', continuation: 'chat_root' },
          payloadRef: 'payload',
          secretRef: secretId,
          sourceOwnership: 'dutydeck',
          sourceNamespace: 'test',
          sourceEnabled: false
        });
        if (kind === 'generation_only') {
          await s.scheduleDefinitions.update('schedule_probe', { expectedRevision: 1, secretRef: null });
          expect(db.prepare('SELECT secret_ref FROM schedule_definitions').get()).toEqual({ secret_ref: null });
          expect(db.prepare('SELECT secret_ref FROM schedule_generations WHERE generation = 1').get()).toEqual({ secret_ref: secretId });
        }
      }
      expect(db.pragma('foreign_key_check')).toEqual([]);
    }

    function assertForbidden(fn: () => unknown) {
      try {
        fn();
        expect.unreachable('403 required');
      } catch (e: any) {
        expect(e).toMatchObject({ code: 'CONFIGURATION_FORBIDDEN', statusCode: 403 });
      }
    }

    it.each(scheduleCases)('F2: first shared %s requires owner; full unrelated state preserved and reopen replay writes nothing', async kind => {
      const { db, reopen } = fixture();
      db.pragma('foreign_keys = ON');
      seedBot(db, 'bot_a', 'cli_app_a', { id: 'sec_matrix' });
      seedBot(db, 'bot_b', 'cli_app_b');
      seedAdminRole(db, 'bot_a', 'principal_admin_a');
      await addScheduleReference(db, kind, 'sec_matrix');

      const c = createBotCredentialCommands(db);
      const before = dump(db);

      const matrixPrep = (revision = 1, key = 'new', provider = 'vault_new'): PreparedCredentialRef => ({
        secretId: 'sec_matrix',
        expectedRevision: revision,
        provider,
        referenceKey: key,
        fingerprint: 'b'.repeat(64)
      });
      const matrixRef = (actor: ManagementActor = adminA, operationId = 'rotate'): SharedSecretChangeRef => ({
        operationId,
        actor,
        secretId: 'sec_matrix',
        expectedSecretRevision: 1,
        bots: [{ botId: 'bot_a', expectedRevision: 1 }]
      });

      // 1. Admin first rotate and same-location no-op are both rejected with 403, whole db unchanged
      assertForbidden(() => c.rotateSharedSecret(matrixRef(), matrixPrep()));
      assertForbidden(() =>
        c.rotateSharedSecret(matrixRef(adminA, 'noop'), {
          ...matrixPrep(1, 'keys/sec_matrix'),
          provider: 'vault'
        })
      );
      expect(dump(db)).toEqual(before);

      // 2. Installation owner succeeds, bumps only bot_a three versions and updates credential metadata
      const prepInput = matrixPrep();
      const result = c.rotateSharedSecret(matrixRef(owner, 'owner_rotate'), prepInput);
      expect(result.map(x => x.bot.id)).toEqual(['bot_a']);
      expect(result[0]?.bot).toMatchObject({ revision: 2, authorizationRevision: 2, connectionGeneration: 2 });
      expect(result[0]?.credential?.revision).toBe(2);
      expect(result[0]?.credential?.provider).toBe(prepInput.provider);
      expect(result[0]?.credential?.referenceKey).toBe(prepInput.referenceKey);

      // Check all non-modified tables completely unchanged
      const after = dump(db);
      const changedTables = new Set(['secret_refs', 'channel_bots', 'configuration_operations', 'configuration_changes', 'configuration_versions', 'sqlite_sequence']);
      for (const [table, rows] of Object.entries(before)) {
        if (!changedTables.has(table)) expect(after[table], table).toEqual(rows);
      }
      for (const table of ['channel_bots', 'configuration_changes', 'configuration_versions']) {
        const key = table === 'channel_bots' ? 'id' : 'bot_id';
        expect(
          after[table]!.filter((x: unknown) => (x as Record<string, unknown>)[key] === 'bot_b'),
          table
        ).toEqual(
          before[table]!.filter((x: unknown) => (x as Record<string, unknown>)[key] === 'bot_b')
        );
      }
      expect(db.prepare("SELECT count(*) AS n FROM configuration_versions WHERE bot_id = 'bot_b'").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT count(*) AS n FROM configuration_versions WHERE bot_id = 'bot_a'").get()).toEqual({ n: 2 });

      // 3. Reopen DB and replay owner operation -> returns identical result and zero writes across all tables
      const reopened = reopen();
      const beforeReplay = dump(reopened);
      expect(createBotCredentialCommands(reopened).rotateSharedSecret(matrixRef(owner, 'owner_rotate'), prepInput)).toEqual(result);
      expect(dump(reopened)).toEqual(beforeReplay);
    });

    it.each(scheduleCases)('F2: adding %s after legitimate admin acceptance blocks exact cached replay without writes', async kind => {
      const { db } = fixture();
      db.pragma('foreign_keys = ON');
      seedBot(db, 'bot_a', 'cli_app_a', { id: 'sec_admin_cache' });
      seedBot(db, 'bot_b', 'cli_app_b');
      seedAdminRole(db, 'bot_a', 'principal_admin_a');
      const c = createBotCredentialCommands(db);

      const matrixPrep = (revision = 1, key = 'new', provider = 'vault_new'): PreparedCredentialRef => ({
        secretId: 'sec_admin_cache',
        expectedRevision: revision,
        provider,
        referenceKey: key,
        fingerprint: 'b'.repeat(64)
      });
      const matrixRef = (actor: ManagementActor = adminA, operationId = 'rotate'): SharedSecretChangeRef => ({
        operationId,
        actor,
        secretId: 'sec_admin_cache',
        expectedSecretRevision: 1,
        bots: [{ botId: 'bot_a', expectedRevision: 1 }]
      });

      // 1. Initially without schedule reference, admin succeeds (preserves bot revision=2 & credential revision=2)
      const prepInput = matrixPrep();
      const adminOpRef = matrixRef();
      const result = c.rotateSharedSecret(adminOpRef, prepInput);
      expect(result[0]?.bot.revision).toBe(2);
      expect(result[0]?.credential?.revision).toBe(2);
      expect(result[0]?.credential?.provider).toBe('vault_new');

      // Clean replay without writes succeeds and returns identical result
      const clean = dump(db);
      const replayResult = c.rotateSharedSecret(adminOpRef, prepInput);
      expect(replayResult).toEqual(result);
      expect(dump(db)).toEqual(clean);

      // 2. Now add schedule reference
      await addScheduleReference(db, kind, 'sec_admin_cache');
      const before = dump(db);

      // 3. Exact cached replay now blocked with 403 on current authority check, whole db unchanged
      assertForbidden(() => c.rotateSharedSecret(adminOpRef, prepInput));
      expect(dump(db)).toEqual(before);
    });

    it.each(['lease_held', 'lease_released'] as const)('F1: unbound %s rejects mutation, same-location no-op and removal with domain error', async kind => {
      const { db } = fixture();
      db.pragma('foreign_keys = ON');
      const c = createBotCredentialCommands(db);
      const matrixPrep = (revision = 1, key = 'new'): PreparedCredentialRef => ({
        secretId: 'sec_unb_matrix',
        expectedRevision: revision,
        provider: 'vault',
        referenceKey: key,
        fingerprint: 'b'.repeat(64)
      });

      c.createUnboundSecret({ operationId: 'create_unb_m', actor: owner }, 'generic', matrixPrep(0, 'old'));
      await addScheduleReference(db, kind, 'sec_unb_matrix');
      const before = dump(db);

      for (const [operationId, key] of [['rot_m', 'new'], ['noop_m', 'old']]) {
        expect(() => c.rotateUnboundSecret({ operationId: operationId!, actor: owner }, matrixPrep(1, key))).toThrow(/CONFIGURATION_CONFLICT/);
      }
      expect(() => c.removeUnboundSecret({ operationId: 'rem_m', actor: owner }, 'sec_unb_matrix', 1)).toThrow(/CONFIGURATION_CONFLICT/);
      expect(dump(db)).toEqual(before);
    });
  });

  describe('6. Multi-bot binding isolation (binding one bot does not alter other bots)', () => {
    it('re-binding bot A to another secret leaves bot B completely untouched', () => {
      const { db } = fixture();
      seedBot(db, 'bot_a', 'cli_app_a', { id: 'sec_init', rev: 0 });
      seedBot(db, 'bot_b', 'cli_app_b', { id: 'sec_init', rev: 1 });

      const credCommands = createBotCredentialCommands(db);

      // Re-bind bot_a to sec_isolated
      credCommands.bindPreparedCredential({
        operationId: 'op_rebind_bot_a',
        actor: owner,
        botId: 'bot_a',
        expectedRevision: 1
      }, {
        secretId: 'sec_isolated',
        expectedRevision: 0,
        provider: 'vault',
        referenceKey: 'keys/iso',
        fingerprint: 'c'.repeat(64)
      });

      const reader = createConfigurationReader(db);
      const snapB = reader.read('bot_b')!;
      expect(snapB.bot.credentialRef).toBe('sec_init');
      expect(snapB.bot.revision).toBe(1);
      expect(snapB.bot.authorizationRevision).toBe(1);
      expect(snapB.bot.connectionGeneration).toBe(1);
      expect(snapB.credential?.id).toBe('sec_init');
      expect(snapB.credential?.revision).toBe(1);

      // Only bot_a has 2 versions
      const versionsA = reader.listVersions('bot_a');
      expect(versionsA.length).toBe(2);
      const versionsB = reader.listVersions('bot_b');
      expect(versionsB.length).toBe(1);
    });
  });

  describe('7. Scale check: shared rotation across >500 referencing bots', () => {
    it('rotates shared secret across 505 bots without pagination truncation', () => {
      const { db } = fixture();
      const TOTAL_BOTS = 505;

      // Seed first bot with sec_massive (rev 0 creates it)
      seedBot(db, 'bot_m_000', 'cli_app_m_000', { id: 'sec_massive', rev: 0 });

      // Seed remaining 504 bots referencing sec_massive with rev 1
      const commands = createConfigurationCommands(db);
      for (let i = 1; i < TOTAL_BOTS; i++) {
        const idStr = String(i).padStart(3, '0');
        const botId = `bot_m_${idStr}`;
        const appId = `cli_app_m_${idStr}`;
        commands.create({
          operationId: `op_create_${botId}`,
          actor: owner,
          botId,
          externalAppId: appId,
          expectedAppState: 'absent',
          bot: { displayName: `Bot ${botId}`, brand: 'feishu', state: 'staged', desiredListenerState: 'paused' },
          policy: samplePolicyInput(),
          preparedCredential: {
            secretId: 'sec_massive',
            expectedRevision: 1,
            provider: 'vault',
            referenceKey: 'keys/sec_massive',
            fingerprint: 'a'.repeat(64)
          }
        });
      }

      const refBots: Array<{ botId: string; expectedRevision: number }> = [];
      for (let i = 0; i < TOTAL_BOTS; i++) {
        const idStr = String(i).padStart(3, '0');
        refBots.push({ botId: `bot_m_${idStr}`, expectedRevision: 1 });
      }

      const credCommands = createBotCredentialCommands(db);
      const snapshots = credCommands.rotateSharedSecret({
        operationId: 'op_rot_massive',
        actor: owner,
        secretId: 'sec_massive',
        expectedSecretRevision: 1,
        bots: refBots
      }, {
        secretId: 'sec_massive',
        expectedRevision: 1,
        provider: 'vault_massive',
        referenceKey: 'keys/massive_v2',
        fingerprint: 'f'.repeat(64)
      });

      expect(snapshots.length).toBe(TOTAL_BOTS);
      expect(snapshots[0]?.bot.revision).toBe(2);
      expect(snapshots[504]?.bot.revision).toBe(2);
      expect(snapshots[0]?.credential?.revision).toBe(2);
      expect(snapshots[0]?.credential?.provider).toBe('vault_massive');
    });
  });

  describe('8. Integer overflow and late failure whole-db rollback', () => {
    it('rolls back completely when Bot revision overflows MAX_SAFE_INTEGER', () => {
      const { db } = fixture();
      seedBot(db, 'bot_overflow', 'cli_app_overflow');
      // Set revision to MAX_SAFE_INTEGER
      db.prepare('UPDATE channel_bots SET revision = ? WHERE id = ?').run(Number.MAX_SAFE_INTEGER, 'bot_overflow');

      const credCommands = createBotCredentialCommands(db);

      expect(() =>
        credCommands.bindPreparedCredential({
          operationId: 'op_overflow_bind',
          actor: owner,
          botId: 'bot_overflow',
          expectedRevision: Number.MAX_SAFE_INTEGER
        }, {
          secretId: 'sec_overflow',
          expectedRevision: 0,
          provider: 'vault',
          referenceKey: 'keys/overflow',
          fingerprint: 'a'.repeat(64)
        })
      ).toThrow(RuntimeError);

      // Verify rollback: secret_refs does not have sec_overflow, channel_bots is untouched
      const secRow = db.prepare('SELECT * FROM secret_refs WHERE id = ?').get('sec_overflow');
      expect(secRow).toBeUndefined();

      const opRow = db.prepare('SELECT * FROM configuration_operations WHERE operation_id = ?').get('op_overflow_bind');
      expect(opRow).toBeUndefined();
    });

    it('rolls back completely when Secret revision overflows MAX_SAFE_INTEGER during rotateSharedSecret', () => {
      const { db } = fixture();
      seedBot(db, 'bot_1', 'cli_app_1', { id: 'sec_overflow_shared', rev: 0 });
      db.prepare('UPDATE secret_refs SET revision = ? WHERE id = ?').run(Number.MAX_SAFE_INTEGER, 'sec_overflow_shared');

      const credCommands = createBotCredentialCommands(db);

      expect(() =>
        credCommands.rotateSharedSecret({
          operationId: 'op_overflow_rot',
          actor: owner,
          secretId: 'sec_overflow_shared',
          expectedSecretRevision: Number.MAX_SAFE_INTEGER,
          bots: [{ botId: 'bot_1', expectedRevision: 1 }]
        }, {
          secretId: 'sec_overflow_shared',
          expectedRevision: Number.MAX_SAFE_INTEGER,
          provider: 'vault_new',
          referenceKey: 'keys/new',
          fingerprint: 'b'.repeat(64)
        })
      ).toThrow(RuntimeError);

      // Verify rollback: bot revision is still 1
      const botRow = db.prepare('SELECT revision FROM channel_bots WHERE id = ?').get('bot_1') as { revision: number };
      expect(botRow.revision).toBe(1);

      const opRow = db.prepare('SELECT * FROM configuration_operations WHERE operation_id = ?').get('op_overflow_rot');
      expect(opRow).toBeUndefined();
    });

    it('rolls back a real late second-Bot history INSERT failure and can retry same operation', () => {
      const { db } = fixture();
      seedBot(db, 'bot_a', 'cli_app_a', { id: 'sec_late_sql', rev: 0 });
      seedBot(db, 'bot_z', 'cli_app_z', { id: 'sec_late_sql', rev: 1 });

      db.prepare(`
        INSERT INTO remote_identity_facts (
          id, schema_version, revision, channel_bot_id, credential_ref_id, credential_revision,
          credential_fingerprint, app_fingerprint, bot_identity_ref, tenant_ref, app_id_match,
          checked_at, expires_at, created_at, updated_at
        ) VALUES ('identity_a', 1, 1, 'bot_a', 'sec_late_sql', 1, ?, ?, 'remote_bot_a', NULL, 1, '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `).run('a'.repeat(64), 'a'.repeat(64));

      db.prepare(`
        INSERT INTO remote_chat_facts (
          id, schema_version, revision, channel_bot_id, external_chat_id,
          membership_state, chat_type, credential_ref_id, credential_revision, credential_fingerprint,
          observed_at, expires_at, created_at, updated_at
        ) VALUES ('chat_a', 1, 1, 'bot_a', 'oc_chat_a', 'member', 'group', 'sec_late_sql', 1, ?, '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `).run('a'.repeat(64));

      // Inject late failure on inserting version for bot_z
      db.exec("CREATE TRIGGER probe_failure BEFORE INSERT ON configuration_versions WHEN NEW.bot_id='bot_z' AND NEW.change_kind='secret_rotated' BEGIN SELECT RAISE(ABORT, 'PROBE_LATE_HISTORY'); END");

      const before = dump(db);
      const c = createBotCredentialCommands(db);

      try {
        expect(() =>
          c.rotateSharedSecret({
            operationId: 'op_late_fail',
            actor: owner,
            secretId: 'sec_late_sql',
            expectedSecretRevision: 1,
            bots: [{ botId: 'bot_a', expectedRevision: 1 }, { botId: 'bot_z', expectedRevision: 1 }]
          }, {
            secretId: 'sec_late_sql',
            expectedRevision: 1,
            provider: 'vault_new',
            referenceKey: 'keys/new',
            fingerprint: 'b'.repeat(64)
          })
        ).toThrow('PROBE_LATE_HISTORY');
        expect(dump(db)).toEqual(before);
      } finally {
        db.exec('DROP TRIGGER IF EXISTS probe_failure');
      }

      // Now retry same operation succeeds and returns 2 snapshots
      const results = c.rotateSharedSecret({
        operationId: 'op_late_fail',
        actor: owner,
        secretId: 'sec_late_sql',
        expectedSecretRevision: 1,
        bots: [{ botId: 'bot_a', expectedRevision: 1 }, { botId: 'bot_z', expectedRevision: 1 }]
      }, {
        secretId: 'sec_late_sql',
        expectedRevision: 1,
        provider: 'vault_new',
        referenceKey: 'keys/new',
        fingerprint: 'b'.repeat(64)
      });
      expect(results).toHaveLength(2);
    });

    it.each(['identity', 'chat', 'bot_auth', 'bot_connection'] as const)(
      'rolls back late %s overflow including all rows and sqlite_sequence',
      kind => {
        const { db } = fixture();
        seedBot(db, 'bot_a', 'cli_app_a', { id: 'sec_of', rev: 0 });
        seedBot(db, 'bot_z', 'cli_app_z', { id: 'sec_of', rev: 1 });

        db.prepare(`
          INSERT INTO remote_identity_facts (
            id, schema_version, revision, channel_bot_id, credential_ref_id, credential_revision,
            credential_fingerprint, app_fingerprint, bot_identity_ref, tenant_ref, app_id_match,
            checked_at, expires_at, created_at, updated_at
          ) VALUES ('identity_a', 1, 1, 'bot_a', 'sec_of', 1, ?, ?, 'remote_bot_a', NULL, 1, '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
        `).run('a'.repeat(64), 'a'.repeat(64));

        db.prepare(`
          INSERT INTO remote_chat_facts (
            id, schema_version, revision, channel_bot_id, external_chat_id,
            membership_state, chat_type, credential_ref_id, credential_revision, credential_fingerprint,
            observed_at, expires_at, created_at, updated_at
          ) VALUES ('chat_a', 1, 1, 'bot_a', 'oc_chat_a', 'member', 'group', 'sec_of', 1, ?, '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
        `).run('a'.repeat(64));

        if (kind === 'identity') db.prepare('UPDATE remote_identity_facts SET revision = ?').run(Number.MAX_SAFE_INTEGER);
        if (kind === 'chat') db.prepare('UPDATE remote_chat_facts SET revision = ?').run(Number.MAX_SAFE_INTEGER);
        if (kind === 'bot_auth') db.prepare("UPDATE channel_bots SET authorization_revision = ? WHERE id = 'bot_z'").run(Number.MAX_SAFE_INTEGER);
        if (kind === 'bot_connection') db.prepare("UPDATE channel_bots SET connection_generation = ? WHERE id = 'bot_z'").run(Number.MAX_SAFE_INTEGER);

        const before = dump(db);
        expect(() =>
          createBotCredentialCommands(db).rotateSharedSecret({
            operationId: 'op_overflow_test',
            actor: owner,
            secretId: 'sec_of',
            expectedSecretRevision: 1,
            bots: [{ botId: 'bot_a', expectedRevision: 1 }, { botId: 'bot_z', expectedRevision: 1 }]
          }, {
            secretId: 'sec_of',
            expectedRevision: 1,
            provider: 'vault_rot',
            referenceKey: 'keys/rot',
            fingerprint: 'b'.repeat(64)
          })
        ).toThrow(/CONFIGURATION_REVISION_OVERFLOW/);
        expect(dump(db)).toEqual(before);
      }
    );

    it('revokes complete old fact bindings and they remain readable with old proof fields preserved', async () => {
      const { db } = fixture();
      seedBot(db, 'bot_a', 'cli_app_a', { id: 'sec_proof', rev: 0 });

      const botIdentityRef = 'remote_bot_' + 'a'.repeat(64);
      db.prepare(`
        INSERT INTO remote_identity_facts (
          id, schema_version, revision, channel_bot_id, credential_ref_id, credential_revision,
          credential_fingerprint, app_fingerprint, bot_identity_ref, tenant_ref, app_id_match,
          checked_at, expires_at, created_at, updated_at
        ) VALUES ('identity_a', 1, 1, 'bot_a', 'sec_proof', 1, ?, ?, ?, NULL, 1, '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `).run('a'.repeat(64), 'a'.repeat(64), botIdentityRef);

      db.prepare(`
        INSERT INTO remote_chat_facts (
          id, schema_version, revision, channel_bot_id, external_chat_id,
          membership_state, chat_type, credential_ref_id, credential_revision, credential_fingerprint,
          identity_fact_id, identity_revision, observed_at, expires_at, created_at, updated_at
        ) VALUES ('chat_a', 1, 1, 'bot_a', 'oc_chat_a', 'member', 'group', 'sec_proof', 1, ?, 'identity_a', 1, '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `).run('a'.repeat(64));

      const wp = createWp1aRepositories(db);
      const oldId = await wp.remoteIdentityFacts.get('identity_a');
      const oldChat = await wp.remoteChatFacts.get('chat_a');
      expect(oldId).toBeDefined();
      expect(oldChat).toBeDefined();

      createBotCredentialCommands(db).rotateSharedSecret({
        operationId: 'op_rot_proof',
        actor: owner,
        secretId: 'sec_proof',
        expectedSecretRevision: 1,
        bots: [{ botId: 'bot_a', expectedRevision: 1 }]
      }, {
        secretId: 'sec_proof',
        expectedRevision: 1,
        provider: 'vault_rot',
        referenceKey: 'keys/rot',
        fingerprint: 'b'.repeat(64)
      });

      const id = await wp.remoteIdentityFacts.get('identity_a');
      const ch = await wp.remoteChatFacts.get('chat_a');
      expect(id).toMatchObject({
        revision: 2,
        credentialRefId: 'sec_proof',
        credentialRevision: 1,
        credentialFingerprint: oldId!.credentialFingerprint,
        botIdentityRef: oldId!.botIdentityRef,
        errorCode: 'CREDENTIAL_ROTATED'
      });
      expect(ch).toMatchObject({
        revision: 2,
        credentialRefId: 'sec_proof',
        credentialRevision: 1,
        identityFactId: 'identity_a',
        identityRevision: 1,
        errorCode: 'CREDENTIAL_ROTATED'
      });
      expect(ch?.invalidatedAt).toBeDefined();

      // Also verify old fact fingerprint does not block new-revision bind on another bot
      seedBot(db, 'bot_b', 'cli_app_b');
      const bindB = createBotCredentialCommands(db).bindPreparedCredential({
        operationId: 'bind_b_new_fp',
        actor: owner,
        botId: 'bot_b',
        expectedRevision: 1
      }, {
        secretId: 'sec_proof',
        expectedRevision: 2,
        provider: 'vault_rot',
        referenceKey: 'keys/rot',
        fingerprint: 'b'.repeat(64)
      });
      expect(bindB.credential?.revision).toBe(2);
    });
  });
});
