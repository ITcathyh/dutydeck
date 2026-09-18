import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrations, runMigrations, withMigrationTransaction } from './migrations.js';
import { createBotConfigurationSchema } from './bot-configuration-migration.js';

describe('v19 bot configuration migration & schema checks', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const dir of directories.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dutydeck-migration-v19-test-'));
    directories.push(dir);
    return dir;
  }

  function tempDb(): { db: Database.Database; path: string } {
    const path = join(tempDir(), 'test.db');
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    return { db, path };
  }

  function applyUpToVersion(db: Database.Database, maxVersion: number): void {
    withMigrationTransaction(db, () => {
      db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
      const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(r => r.version));
      const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
      for (const m of migrations) {
        if (m.version > maxVersion) break;
        if (applied.has(m.version)) continue;
        m.up(db);
        record.run(m.version, new Date().toISOString());
      }
    });
  }

  it('upgrades a real non-empty v18 database with bots, policies, bindings, roles, facts and schedules', () => {
    const { db } = tempDb();
    try {
      // 1. Build v18 database
      applyUpToVersion(db, 18);

      // Verify v18 applied
      const v18Migrations = (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(r => r.version);
      expect(v18Migrations).toContain(18);
      expect(v18Migrations).not.toContain(19);

      // 2. Insert non-empty v18 business data across all related tables
      db.exec(`
        INSERT INTO secret_refs (
          id, schema_version, revision, kind, provider, reference_key, status, created_at, updated_at
        ) VALUES (
          'secret-1', 1, 1, 'lark_app_secret', 'vault', 'key/secret1', 'configured', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );

        INSERT INTO channel_bots (
          id, schema_version, revision, channel, external_app_id, display_name, brand,
          credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at
        ) VALUES (
          'bot-1', 1, 2, 'lark', 'cli_app_1', 'Original Bot', 'feishu',
          'secret-1', 'staged', 'disabled', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );

        INSERT INTO channel_bot_policies (
          id, schema_version, revision, channel_bot_id, defaults_json, routing_defaults_json,
          access_policy_json, group_tools_policy_json, created_at, updated_at
        ) VALUES (
          'policy-1', 1, 1, 'bot-1', '{}', '{"p2pMode":"chat","groupReplyMode":"chat","mentionPolicy":"at_mention"}',
          '{"humanTalk":{"p2p":{"mode":"owner_only"},"managedGroup":{"mode":"owner_only"},"newGroup":{"mode":"owner_only"}},"botTalk":{"p2p":{"mode":"allowlist","selectors":[],"peerEnabled":false},"managedGroup":{"mode":"allowlist","selectors":[],"peerEnabled":false},"newGroup":{"mode":"allowlist","selectors":[],"peerEnabled":false}},"defaultOperate":{"rules":[]},"p2pOperate":{"mode":"none"}}',
          '{"readCeiling":true,"discoverCeiling":true,"sendCeiling":false,"readDefault":false,"discoverDefault":false,"sendDefault":false}',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );

        INSERT INTO group_bindings (
          id, schema_version, revision, channel_bot_id, external_chat_id, state, oncall,
          agent_override_json, workspace_override_json, model_override_json, reasoning_override_json,
          role_policy_override_json, routing_override_json, access_override_json, group_tools_override_json,
          presentation_override_json, review_reasons_json, created_at, updated_at
        ) VALUES (
          'binding-1', 1, 1, 'bot-1', 'oc_chat_1', 'staged', 0,
          '{"mode":"inherit"}', '{"mode":"inherit"}', '{"mode":"inherit"}', '{"mode":"inherit"}',
          '{"mode":"inherit"}', '{"groupReplyMode":{"mode":"inherit"},"mentionPolicy":{"mode":"inherit"}}',
          '{"mode":"inherit","principalIds":[]}', '{"read":"inherit","discover":"inherit","send":"inherit"}',
          '{"mode":"inherit"}', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );

        INSERT INTO role_assignments (
          id, schema_version, revision, channel_bot_id, group_binding_id, scope_key,
          principal_id, role, operate_scope, action_gates_json, state, created_at, updated_at
        ) VALUES (
          'role-1', 1, 1, 'bot-1', 'binding-1', 'binding:binding-1',
          'principal_user_1', 'can_talk', 'none', '{"terminalWrite":false,"highRisk":false,"groupToolsSend":false}',
          'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );

        INSERT INTO remote_chat_facts (
          id, schema_version, revision, channel_bot_id, external_chat_id, membership_state,
          chat_type, observed_at, expires_at, created_at, updated_at
        ) VALUES (
          'fact-1', 1, 1, 'bot-1', 'oc_chat_1', 'member',
          'group', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );

        INSERT INTO schedule_definitions (
          id, schema_version, revision, channel_bot_id, group_binding_id, name,
          trigger_kind, cron_expression, timezone, dst_gap_policy, dst_overlap_policy,
          delivery_mode, chat_ref, continuation_policy, payload_ref, secret_ref,
          source_ownership, source_namespace, source_enabled, state, desired_executor_state,
          current_generation, created_at, updated_at
        ) VALUES (
          'schedule-1', 1, 1, 'bot-1', 'binding-1', 'Daily sync',
          'cron', '0 9 * * *', 'UTC', 'skip', 'first',
          'chat', 'oc_chat_1', 'same_thread', 'payload-1', 'secret-1',
          'dutydeck', 'default', 1, 'staged', 'disabled',
          1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );
      `);

      // 3. Perform v19 upgrade via runMigrations
      runMigrations(db);

      // Verify v19 applied
      const v19Migrations = (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(r => r.version);
      expect(v19Migrations).toContain(19);

      // 4. Verify foreign key check passes completely across all rebuilt tables
      db.pragma('foreign_keys = ON');
      const fkViolations = db.pragma('foreign_key_check') as unknown[];
      expect(fkViolations).toEqual([]);

      // 5. Verify preserved row values and schema
      const botRow = db.prepare('SELECT * FROM channel_bots WHERE id = ?').get('bot-1') as any;
      expect(botRow.id).toBe('bot-1');
      expect(botRow.schema_version).toBe(1);
      expect(botRow.revision).toBe(2);
      expect(botRow.display_name).toBe('Original Bot');
      expect(botRow.authorization_revision).toBeNull();
      expect(botRow.connection_generation).toBeNull();
      expect(botRow.platform_display_name).toBeNull();
      expect(botRow.credential_ref).toBe('secret-1');
      expect(botRow.state).toBe('staged');
      expect(botRow.desired_listener_state).toBe('disabled');
      expect(botRow.full_trust_confirmed).toBe(0);

      const policyRow = db.prepare('SELECT * FROM channel_bot_policies WHERE channel_bot_id = ?').get('bot-1') as any;
      expect(policyRow.id).toBe('policy-1');
      expect(policyRow.schema_version).toBe(1);
      expect(policyRow.revision).toBe(1);
      expect(policyRow.execution_json).toBeNull();
      expect(policyRow.presentation_json).toBeNull();

      const bindingRow = db.prepare('SELECT * FROM group_bindings WHERE id = ?').get('binding-1') as any;
      expect(bindingRow.id).toBe('binding-1');
      expect(bindingRow.schema_version).toBe(1);
      expect(bindingRow.revision).toBe(1);
      expect(bindingRow.access_profile).toBeNull();

      // 6. Verify indices preserved
      const indices = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(r => r.name);
      expect(indices).toContain('group_bindings_bot_state');
      expect(indices).toContain('configuration_changes_bot_seq');
      expect(indices).toContain('configuration_versions_bot_rev');
      expect(indices).toContain('full_trust_confirmations_bot');

      // 7. Verify configuration_authority singleton
      const authRow = db.prepare('SELECT * FROM configuration_authority').all() as any[];
      expect(authRow).toHaveLength(1);
      expect(authRow[0].id).toBe(1);
      expect(authRow[0].authority).toBe('legacy');

      // Verify execution authority unchanged
      const execAuthRow = db.prepare('SELECT authority FROM execution_authority WHERE id = 1').get() as any;
      expect(execAuthRow.authority).toBe('legacy');

      // 8. Idempotency: re-running runMigrations should do nothing
      expect(() => runMigrations(db)).not.toThrow();
      const authRowAgain = db.prepare('SELECT * FROM configuration_authority').all() as any[];
      expect(authRowAgain).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('rolls back completely if v19 fails halfway through', () => {
    const { db } = tempDb();
    try {
      applyUpToVersion(db, 18);

      db.exec(`
        INSERT INTO secret_refs (id, schema_version, revision, kind, provider, reference_key, status, created_at, updated_at)
        VALUES ('sec-1', 1, 1, 'lark_app_secret', 'p', 'k', 'configured', '2026-01-01', '2026-01-01');
        INSERT INTO channel_bots (id, schema_version, revision, channel, external_app_id, display_name, brand, credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at)
        VALUES ('bot-1', 1, 1, 'lark', 'app-1', 'Bot', 'feishu', 'sec-1', 'staged', 'disabled', 0, '2026-01-01', '2026-01-01');
      `);

      // Inject a failure in a migration attempt
      expect(() => {
        withMigrationTransaction(db, () => {
          // partially run v19
          db.exec(`
            CREATE TABLE channel_bots_v19_tmp (id TEXT PRIMARY KEY);
            INSERT INTO channel_bots_v19_tmp SELECT id FROM channel_bots;
          `);
          // simulate failure before completion
          throw new Error('SIMULATED_MIGRATION_INJECTION_FAILURE');
        });
      }).toThrow('SIMULATED_MIGRATION_INJECTION_FAILURE');

      // Verify that channel_bots_v19_tmp does not exist and channel_bots is unchanged
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(r => r.name);
      expect(tables).not.toContain('channel_bots_v19_tmp');
      expect(tables).toContain('channel_bots');

      const bot = db.prepare('SELECT * FROM channel_bots WHERE id = ?').get('bot-1') as any;
      expect(bot.id).toBe('bot-1');
      expect(bot.schema_version).toBe(1);

      // Foreign keys pragma is restored
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });

  it('rolls back the real v19 migration on a DDL failure, then succeeds after the obstacle is removed', () => {
    const { db } = tempDb();
    try {
      applyUpToVersion(db, 18);

      db.exec(`
        INSERT INTO secret_refs (id, schema_version, revision, kind, provider, reference_key, status, created_at, updated_at)
        VALUES ('sec-1', 1, 1, 'lark_app_secret', 'p', 'k', 'configured', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO channel_bots (id, schema_version, revision, channel, external_app_id, display_name, brand, credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at)
        VALUES ('bot-1', 1, 3, 'lark', 'app-1', 'Bot', 'lark', 'sec-1', 'disabled', 'disabled', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      `);

      // Real obstacle: v19's first DDL is CREATE TABLE channel_bots_v19. A
      // pre-existing table with that name makes the genuine migration fail,
      // exercising runMigrations + withMigrationTransaction rollback (no private
      // SQL string replay).
      db.exec('CREATE TABLE channel_bots_v19 (obstacle INTEGER)');

      expect(() => runMigrations(db)).toThrow(/already exists/);

      // schema_migrations must not record v19
      const versions = (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(r => r.version);
      expect(versions).not.toContain(19);
      expect(versions).toContain(18);

      // No configuration marker / new tables created
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(r => r.name));
      expect(tables.has('configuration_authority')).toBe(false);
      expect(tables.has('configuration_operations')).toBe(false);
      expect(tables.has('configuration_versions')).toBe(false);

      // Original channel_bots untouched (still the old shape)
      const columns = (db.pragma('table_info(channel_bots)') as Array<{ name: string }>).map(c => c.name);
      expect(columns).not.toContain('authorization_revision');
      const bot = db.prepare('SELECT * FROM channel_bots WHERE id = ?').get('bot-1') as any;
      expect(bot.revision).toBe(3);
      expect(bot.state).toBe('disabled');

      // Whole-database FK gate still satisfied and pragma restored
      expect(db.pragma('foreign_key_check') as unknown[]).toEqual([]);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

      // Remove the obstacle and replay: the real migration now completes once
      db.exec('DROP TABLE channel_bots_v19');
      expect(() => runMigrations(db)).not.toThrow();
      const versionsAfter = (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(r => r.version);
      expect(versionsAfter).toContain(19);
      const botAfter = db.prepare('SELECT * FROM channel_bots WHERE id = ?').get('bot-1') as any;
      expect(botAfter.revision).toBe(3);
      expect(botAfter.authorization_revision).toBeNull();
      const auth = db.prepare('SELECT authority FROM configuration_authority WHERE id = 1').get() as any;
      expect(auth.authority).toBe('legacy');

      // Idempotent reopen
      expect(() => runMigrations(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('preserves natural keys, non-unique secret provider/key and RESTRICT deletes after v19', () => {
    const { db } = tempDb();
    try {
      runMigrations(db);
      db.pragma('foreign_keys = ON');

      // Two secret rows may share the same provider/reference_key (identity is id)
      db.exec(`
        INSERT INTO secret_refs (id, schema_version, revision, kind, provider, reference_key, status, created_at, updated_at)
        VALUES ('sec-a', 1, 1, 'generic', 'same-provider', 'same-key', 'configured', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO secret_refs (id, schema_version, revision, kind, provider, reference_key, status, created_at, updated_at)
        VALUES ('sec-b', 1, 1, 'generic', 'same-provider', 'same-key', 'configured', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      `);
      expect(db.prepare('SELECT COUNT(*) AS c FROM secret_refs WHERE provider = ? AND reference_key = ?').get('same-provider', 'same-key') as any)
        .toEqual({ c: 2 });

      // natural key UNIQUE(channel, external_app_id) survives
      const botCols = `
        id, schema_version, revision, authorization_revision, connection_generation,
        channel, external_app_id, display_name, platform_display_name, brand,
        credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at`;
      const botVals = (id: string, appId: string, secret: string | null) =>
        `('${id}', 1, 1, NULL, NULL, 'lark', '${appId}', 'Bot', NULL, 'feishu', ${secret ? `'${secret}'` : 'NULL'}, 'staged', 'disabled', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      db.exec(`INSERT INTO channel_bots (${botCols}) VALUES ${botVals('bot-a', 'app-dup', null)}`);
      expect(() => db.exec(`INSERT INTO channel_bots (${botCols}) VALUES ${botVals('bot-b', 'app-dup', null)}`))
        .toThrow(/UNIQUE constraint failed/);

      // different natural key with secret reference
      db.exec(`INSERT INTO channel_bots (${botCols}) VALUES ${botVals('bot-c', 'app-c', 'sec-a')}`);

      // deleting a referenced secret is RESTRICTed
      expect(() => db.exec("DELETE FROM secret_refs WHERE id = 'sec-a'")).toThrow(/FOREIGN KEY constraint failed/);
      // deleting an unreferenced secret with a duplicated provider/key is allowed
      expect(() => db.exec("DELETE FROM secret_refs WHERE id = 'sec-b'")).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('enforces V1 and V2 CHECK constraints, cross-state rejections, and safe integer revisions', () => {
    const { db } = tempDb();
    try {
      runMigrations(db);
      db.pragma('foreign_keys = ON');

      // Create a secret_ref
      db.exec(`
        INSERT INTO secret_refs (id, schema_version, revision, kind, provider, reference_key, status, created_at, updated_at)
        VALUES ('sec-1', 1, 1, 'lark_app_secret', 'p', 'k', 'configured', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      `);

      // 1. Valid V1 bot passes
      expect(() => {
        db.exec(`
          INSERT INTO channel_bots (
            id, schema_version, revision, authorization_revision, connection_generation,
            channel, external_app_id, display_name, platform_display_name, brand,
            credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at
          ) VALUES (
            'bot-v1', 1, 1, NULL, NULL,
            'lark', 'app-v1', 'Bot V1', NULL, 'feishu',
            'sec-1', 'staged', 'disabled', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
          );
        `);
      }).not.toThrow();

      // 2. V1 cross-state rejection: authorization_revision not null
      expect(() => {
        db.exec(`
          INSERT INTO channel_bots (
            id, schema_version, revision, authorization_revision, connection_generation,
            channel, external_app_id, display_name, platform_display_name, brand,
            credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at
          ) VALUES (
            'bot-v1-invalid-auth', 1, 1, 1, NULL,
            'lark', 'app-v1-inv', 'Bot V1', NULL, 'feishu',
            'sec-1', 'staged', 'disabled', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
          );
        `);
      }).toThrow(/CHECK constraint failed/);

      // 3. V1 cross-state rejection: state = 'enabled'
      expect(() => {
        db.exec(`
          INSERT INTO channel_bots (
            id, schema_version, revision, authorization_revision, connection_generation,
            channel, external_app_id, display_name, platform_display_name, brand,
            credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at
          ) VALUES (
            'bot-v1-invalid-state', 1, 1, NULL, NULL,
            'lark', 'app-v1-inv2', 'Bot V1', NULL, 'feishu',
            'sec-1', 'enabled', 'disabled', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
          );
        `);
      }).toThrow(/CHECK constraint failed/);

      // 4. Valid V2 bot passes
      expect(() => {
        db.exec(`
          INSERT INTO channel_bots (
            id, schema_version, revision, authorization_revision, connection_generation,
            channel, external_app_id, display_name, platform_display_name, brand,
            credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at
          ) VALUES (
            'bot-v2', 2, 1, 1, 1,
            'lark', 'app-v2', 'Bot V2', 'Platform Bot V2', 'feishu',
            'sec-1', 'enabled', 'receiving', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
          );
        `);
      }).not.toThrow();

      // 5. V2 cross-state rejection: missing authorization_revision (NULL)
      expect(() => {
        db.exec(`
          INSERT INTO channel_bots (
            id, schema_version, revision, authorization_revision, connection_generation,
            channel, external_app_id, display_name, platform_display_name, brand,
            credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at
          ) VALUES (
            'bot-v2-no-auth', 2, 1, NULL, 1,
            'lark', 'app-v2-no-auth', 'Bot V2', NULL, 'feishu',
            'sec-1', 'enabled', 'receiving', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
          );
        `);
      }).toThrow(/CHECK constraint failed/);

      // 6. full_trust_confirmed = 1 rejected for both V1 and V2
      expect(() => {
        db.exec(`
          INSERT INTO channel_bots (
            id, schema_version, revision, authorization_revision, connection_generation,
            channel, external_app_id, display_name, platform_display_name, brand,
            credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at
          ) VALUES (
            'bot-v2-trust-1', 2, 1, 1, 1,
            'lark', 'app-v2-trust', 'Bot V2', NULL, 'feishu',
            'sec-1', 'enabled', 'receiving', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
          );
        `);
      }).toThrow(/CHECK constraint failed/);

      // 7. Unsafe integer revision rejected (> 9007199254740991)
      expect(() => {
        db.exec(`
          INSERT INTO channel_bots (
            id, schema_version, revision, authorization_revision, connection_generation,
            channel, external_app_id, display_name, platform_display_name, brand,
            credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at
          ) VALUES (
            'bot-v2-unsafe-rev', 2, 9007199254740992, 1, 1,
            'lark', 'app-v2-unsafe', 'Bot V2', NULL, 'feishu',
            'sec-1', 'enabled', 'receiving', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
          );
        `);
      }).toThrow(/CHECK constraint failed/);

      // 8. Policy V1 vs V2 checks
      expect(() => {
        // V1 with execution_json rejected
        db.exec(`
          INSERT INTO channel_bot_policies (
            id, schema_version, revision, channel_bot_id, defaults_json, routing_defaults_json,
            access_policy_json, execution_json, presentation_json, group_tools_policy_json,
            created_at, updated_at
          ) VALUES (
            'pol-inv', 1, 1, 'bot-v1', '{}', '{}', '{}', '{"mode":"ask"}', NULL, '{}', '2026-01-01', '2026-01-01'
          );
        `);
      }).toThrow(/CHECK constraint failed/);

      expect(() => {
        // V2 without execution_json rejected
        db.exec(`
          INSERT INTO channel_bot_policies (
            id, schema_version, revision, channel_bot_id, defaults_json, routing_defaults_json,
            access_policy_json, execution_json, presentation_json, group_tools_policy_json,
            created_at, updated_at
          ) VALUES (
            'pol-v2-no-exec', 2, 1, 'bot-v2', '{}', '{}', '{}', NULL, '{}', '{}', '2026-01-01', '2026-01-01'
          );
        `);
      }).toThrow(/CHECK constraint failed/);

      // 9. Binding V1 vs V2 checks
      expect(() => {
        // V1 with access_profile rejected
        db.exec(`
          INSERT INTO group_bindings (
            id, schema_version, revision, channel_bot_id, external_chat_id, state, access_profile,
            oncall, agent_override_json, workspace_override_json, model_override_json, reasoning_override_json,
            role_policy_override_json, routing_override_json, access_override_json, group_tools_override_json,
            presentation_override_json, review_reasons_json, created_at, updated_at
          ) VALUES (
            'bind-inv', 1, 1, 'bot-v1', 'chat-1', 'staged', 'managed_group', 0,
            '{}', '{}', '{}', '{}', '{}', '{}', '{}', '{}', '{}', '[]', '2026-01-01', '2026-01-01'
          );
        `);
      }).toThrow(/CHECK constraint failed/);

      expect(() => {
        // V2 without access_profile rejected
        db.exec(`
          INSERT INTO group_bindings (
            id, schema_version, revision, channel_bot_id, external_chat_id, state, access_profile,
            oncall, agent_override_json, workspace_override_json, model_override_json, reasoning_override_json,
            role_policy_override_json, routing_override_json, access_override_json, group_tools_override_json,
            presentation_override_json, review_reasons_json, created_at, updated_at
          ) VALUES (
            'bind-v2-no-prof', 2, 1, 'bot-v2', 'chat-2', 'enabled', NULL, 0,
            '{}', '{}', '{}', '{}', '{}', '{}', '{}', '{}', '{}', '[]', '2026-01-01', '2026-01-01'
          );
        `);
      }).toThrow(/CHECK constraint failed/);

      // 10. Parent entity ON DELETE RESTRICT
      // Add a policy referencing bot-v1, then deleting bot-v1 must fail
      db.exec(`
        INSERT INTO channel_bot_policies (
          id, schema_version, revision, channel_bot_id, defaults_json, routing_defaults_json,
          access_policy_json, execution_json, presentation_json, group_tools_policy_json,
          created_at, updated_at
        ) VALUES (
          'pol-v1', 1, 1, 'bot-v1', '{}', '{}', '{}', NULL, NULL, '{}', '2026-01-01', '2026-01-01'
        );
      `);
      expect(() => {
        db.exec("DELETE FROM channel_bots WHERE id = 'bot-v1'");
      }).toThrow(/FOREIGN KEY constraint failed/);

      // 11. Configuration authority id=1 check
      expect(() => {
        db.exec("INSERT INTO configuration_authority (id, authority) VALUES (2, 'v2')");
      }).toThrow(/CHECK constraint failed/);

      // 12. FullTrustConfirmation discriminated union check
      expect(() => {
        // user_action with recorded_at rejected
        db.exec(`
          INSERT INTO full_trust_confirmations (
            id, channel_bot_id, bot_revision, scope_digest, scope_json,
            source, confirmed_by_json, confirmed_at, legacy_source_digest, recorded_at
          ) VALUES (
            'conf-1', 'bot-v2', 1, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '{}',
            'user_action', '{"kind":"installation_owner","principalId":"principal_installation_owner"}',
            '2026-01-01T00:00:00.000Z', NULL, '2026-01-01T00:00:00.000Z'
          );
        `);
      }).toThrow(/CHECK constraint failed/);

      expect(() => {
        // legacy_live with confirmed_by_json rejected
        db.exec(`
          INSERT INTO full_trust_confirmations (
            id, channel_bot_id, bot_revision, scope_digest, scope_json,
            source, confirmed_by_json, confirmed_at, legacy_source_digest, recorded_at
          ) VALUES (
            'conf-2', 'bot-v2', 1, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '{}',
            'legacy_live', '{"kind":"installation_owner","principalId":"principal_installation_owner"}',
            NULL, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '2026-01-01T00:00:00.000Z'
          );
        `);
      }).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it('F1: V2 version columns require real INTEGER positive safe values (fractions/zero/negative/MAX_SAFE+1 rejected)', () => {
    const { db } = tempDb();
    try {
      runMigrations(db);
      db.pragma('foreign_keys = ON');

      db.exec(`
        INSERT INTO secret_refs (id, schema_version, revision, kind, provider, reference_key, status, created_at, updated_at)
        VALUES ('sec', 1, 1, 'generic', 'p', 'k', 'configured', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO channel_bots (
          id, schema_version, revision, authorization_revision, connection_generation,
          channel, external_app_id, display_name, platform_display_name, brand,
          credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at
        ) VALUES (
          'bot', 2, 1, 1, 1, 'lark', 'app', 'Bot', NULL, 'feishu',
          NULL, 'staged', 'paused', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );
      `);

      const insertBot = (revision: number | bigint, auth: number | bigint, conn: number | bigint) =>
        db.prepare(`
          INSERT INTO channel_bots (
            id, schema_version, revision, authorization_revision, connection_generation,
            channel, external_app_id, display_name, platform_display_name, brand,
            credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at
          ) VALUES (?, 2, ?, ?, ?, 'lark', ?, 'Bot', NULL, 'feishu',
            NULL, 'staged', 'paused', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
        `).run(`b_${revision}_${auth}_${conn}`, revision, auth, conn, `app_${revision}_${auth}_${conn}`);

      // fraction 1.5 must be rejected (SQLite would otherwise store REAL)
      expect(() => insertBot(1.5, 1, 1)).toThrow(/CHECK constraint failed/);
      expect(() => insertBot(0, 1, 1)).toThrow(/CHECK constraint failed/);
      expect(() => insertBot(-1, 1, 1)).toThrow(/CHECK constraint failed/);
      expect(() => insertBot(9007199254740992n, 1, 1)).toThrow(/CHECK constraint failed/);
      expect(() => insertBot(1, 1.5, 1)).toThrow(/CHECK constraint failed/);
      expect(() => insertBot(1, 1, 0)).toThrow(/CHECK constraint failed/);
      expect(() => insertBot(1, 9007199254740992n, 1)).toThrow(/CHECK constraint failed/);
      expect(() => insertBot(1, 1, 9007199254740992n)).toThrow(/CHECK constraint failed/);
      // boundary MAX_SAFE_INTEGER is accepted
      expect(() => insertBot(9007199254740991n, 9007199254740991n, 9007199254740991n)).not.toThrow();

      // policy/binding fractions rejected
      db.exec(`
        INSERT INTO channel_bot_policies (
          id, schema_version, revision, channel_bot_id, defaults_json, routing_defaults_json,
          access_policy_json, execution_json, presentation_json, group_tools_policy_json,
          created_at, updated_at
        ) VALUES ('pol-ok', 2, 1, 'bot', '{}', '{}', '{}', '{}', '{}', '{}',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      `);
      expect(() => db.prepare(`
        INSERT INTO channel_bot_policies (
          id, schema_version, revision, channel_bot_id, defaults_json, routing_defaults_json,
          access_policy_json, execution_json, presentation_json, group_tools_policy_json,
          created_at, updated_at
        ) VALUES ('pol-frac', 2, 1.5, 'bot', '{}', '{}', '{}', '{}', '{}', '{}',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `).run()).toThrow(/CHECK constraint failed/);

      db.exec(`
        INSERT INTO group_bindings (
          id, schema_version, revision, channel_bot_id, external_chat_id, state, access_profile,
          oncall, agent_override_json, workspace_override_json, model_override_json, reasoning_override_json,
          role_policy_override_json, routing_override_json, access_override_json, group_tools_override_json,
          presentation_override_json, review_reasons_json, created_at, updated_at
        ) VALUES ('gb-ok', 2, 1, 'bot', 'chat', 'enabled', 'managed_group', 0,
          '{}','{}','{}','{}','{}','{}','{}','{}','{}','[]',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      `);
      expect(() => db.prepare(`
        INSERT INTO group_bindings (
          id, schema_version, revision, channel_bot_id, external_chat_id, state, access_profile,
          oncall, agent_override_json, workspace_override_json, model_override_json, reasoning_override_json,
          role_policy_override_json, routing_override_json, access_override_json, group_tools_override_json,
          presentation_override_json, review_reasons_json, created_at, updated_at
        ) VALUES ('gb-frac', 2, 2.5, 'bot', 'chat2', 'enabled', 'managed_group', 0,
          '{}','{}','{}','{}','{}','{}','{}','{}','{}','[]',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `).run()).toThrow(/CHECK constraint failed/);

      // full_trust_confirmations.bot_revision fraction/unsafe rejected
      expect(() => db.prepare(`
        INSERT INTO full_trust_confirmations (
          id, channel_bot_id, bot_revision, scope_digest, scope_json,
          source, confirmed_by_json, confirmed_at, legacy_source_digest, recorded_at
        ) VALUES (?, 'bot', 1.5, ?, '{}',
          'user_action', '{}', '2026-01-01T00:00:00.000Z', NULL, NULL)
      `).run('conf-frac', 'a'.repeat(64))).toThrow(/CHECK constraint failed/);

      // configuration_changes sequence bounds: manual INSERT positive safe works;
      // 0, negative, fraction and MAX_SAFE+1 rejected
      db.prepare(`
        INSERT INTO configuration_operations (operation_id, action, actor_json, target_json, payload_digest, result_json, created_at)
        VALUES ('op1', 'update', '{}', NULL, ?, '{}', '2026-01-01T00:00:00.000Z')
      `).run('a'.repeat(64));
      const insertChange = (seq: number | bigint) => db.prepare(`
        INSERT INTO configuration_changes (sequence, bot_id, change_kind, revision, authorization_revision, connection_generation, timestamp)
        VALUES (?, 'bot', 'updated', 1, 1, 1, '2026-01-01T00:00:00.000Z')
      `).run(seq);
      expect(() => insertChange(0)).toThrow(/CHECK constraint failed/);
      expect(() => insertChange(-1)).toThrow(/CHECK constraint failed/);
      // INTEGER PRIMARY KEY rejects REAL with a datatype mismatch (stronger than CHECK); either is a rejection
      expect(() => insertChange(1.5)).toThrow(/CHECK constraint failed|datatype mismatch/);
      expect(() => insertChange(9007199254740992n)).toThrow(/CHECK constraint failed|datatype mismatch/);
      expect(() => insertChange(10)).not.toThrow();

      // configuration_versions revision/change_sequence fractions rejected
      expect(() => db.prepare(`
        INSERT INTO configuration_versions (
          version_id, bot_id, revision, change_sequence, change_kind, operation_id,
          created_at, snapshot_digest, snapshot_json
        ) VALUES ('v-frac', 'bot', 1.5, 10, 'updated', 'op1',
          '2026-01-01T00:00:00.000Z', ?, '{}')
      `).run('b'.repeat(64))).toThrow(/CHECK constraint failed/);

      // AUTOINCREMENT sequence generates positive integers
      db.prepare(`
        INSERT INTO configuration_changes (bot_id, change_kind, revision, authorization_revision, connection_generation, timestamp)
        VALUES ('bot', 'updated', 1, 1, 1, '2026-01-01T00:00:00.000Z')
      `).run();
      const auto = db.prepare('SELECT sequence, typeof(sequence) AS t FROM configuration_changes ORDER BY sequence DESC LIMIT 1').get() as any;
      expect(auto.t).toBe('integer');
      expect(auto.sequence).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });

  it('F2: configuration_operations enforces json_valid per column and rolls back the whole statement/transaction', () => {
    const { db } = tempDb();
    try {
      runMigrations(db);

      const insertOp = (actor: string | null, target: string | null, result: string | null, id: string) =>
        db.prepare(`
          INSERT INTO configuration_operations (operation_id, action, actor_json, target_json, payload_digest, result_json, created_at)
          VALUES (?, 'update', ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')
        `).run(id, actor, target, 'c'.repeat(64), result);

      // valid rows accepted: NULL target, object/array/string/number JSON
      expect(() => insertOp('{}', null, '{}', 'op-null-target')).not.toThrow();
      expect(() => insertOp('[]', '{"x":1}', 'null', 'op-valid')).not.toThrow();
      expect(() => insertOp('"actor"', '5', '"result"', 'op-scalars')).not.toThrow();

      // per-column invalid JSON rejected
      expect(() => insertOp('{', null, '{}', 'op-bad-actor')).toThrow(/CHECK constraint failed/);
      expect(() => insertOp('{}', '{', '{}', 'op-bad-target')).toThrow(/CHECK constraint failed/);
      expect(() => insertOp('{}', null, 'not-json', 'op-bad-result')).toThrow(/CHECK constraint failed/);
      // empty string is not valid JSON
      expect(() => insertOp('', null, '{}', 'op-empty-actor')).toThrow(/CHECK constraint failed/);
      expect(() => insertOp('{}', '', '{}', 'op-empty-target')).toThrow(/CHECK constraint failed/);

      // none of the rejected rows may exist
      const rejected = db.prepare("SELECT COUNT(*) AS c FROM configuration_operations WHERE operation_id LIKE 'op-bad-%' OR operation_id = 'op-empty-actor' OR operation_id = 'op-empty-target'").get() as any;
      expect(rejected.c).toBe(0);

      // multi-row transaction failure must roll back every row permanently
      expect(() => {
        db.transaction(() => {
          insertOp('{}', null, '{}', 'op-tx-good');
          insertOp('{bad', null, '{}', 'op-tx-bad');
        })();
      }).toThrow(/CHECK constraint failed/);
      const txRows = db.prepare("SELECT COUNT(*) AS c FROM configuration_operations WHERE operation_id LIKE 'op-tx-%'").get() as any;
      expect(txRows.c).toBe(0);
    } finally {
      db.close();
    }
  });

  it('F5: real v18 rows with over-safe V1 revisions upgrade unchanged, while V2 rejects the same values', () => {
    const { db } = tempDb();
    try {
      applyUpToVersion(db, 18);
      db.pragma('foreign_keys = ON');

      const WIDE = 9007199254740992n;
      // Build genuinely old v11/v12 rows whose original CHECK only required revision >= 1
      db.exec(`
        INSERT INTO secret_refs (id, schema_version, revision, kind, provider, reference_key, status, created_at, updated_at)
        VALUES ('sec-wide', 1, 1, 'generic', 'p', 'k', 'configured', '2026-01-01', '2026-01-01');
      `);
      db.prepare(`
        INSERT INTO channel_bots (id, schema_version, revision, channel, external_app_id, display_name, brand, credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at)
        VALUES ('bot-wide', 1, ?, 'lark', 'app-wide', 'Wide Bot', 'feishu', 'sec-wide', 'disabled', 'disabled', 0, '2026-01-01', '2026-01-01')
      `).run(WIDE);
      db.prepare(`
        INSERT INTO channel_bot_policies (id, schema_version, revision, channel_bot_id, defaults_json, routing_defaults_json, access_policy_json, group_tools_policy_json, created_at, updated_at)
        VALUES ('pol-wide', 1, ?, 'bot-wide', '{}', '{}', '{}', '{}', '2026-01-01', '2026-01-01')
      `).run(WIDE);
      db.prepare(`
        INSERT INTO group_bindings (
          id, schema_version, revision, channel_bot_id, external_chat_id, state, oncall,
          agent_override_json, workspace_override_json, model_override_json, reasoning_override_json,
          role_policy_override_json, routing_override_json, access_override_json, group_tools_override_json,
          presentation_override_json, review_reasons_json, created_at, updated_at
        ) VALUES (
          'gb-wide', 1, ?, 'bot-wide', 'chat-wide', 'staged', 0,
          '{}','{}','{}','{}','{}','{}','{}','{}','{}','[]','2026-01-01','2026-01-01')
      `).run(WIDE);

      // v19 must accept the old legal values and carry them verbatim
      expect(() => runMigrations(db)).not.toThrow();
      const bot = db.prepare('SELECT revision, typeof(revision) AS t FROM channel_bots WHERE id=?').get('bot-wide') as any;
      expect(bot.revision).toBe(Number(WIDE));
      expect(bot.t).toBe('integer');
      const pol = db.prepare('SELECT revision FROM channel_bot_policies WHERE id=?').get('pol-wide') as any;
      expect(pol.revision).toBe(Number(WIDE));
      const gb = db.prepare('SELECT revision FROM group_bindings WHERE id=?').get('gb-wide') as any;
      expect(gb.revision).toBe(Number(WIDE));

      // Reopening is still idempotent
      expect(() => runMigrations(db)).not.toThrow();

      // Same over-safe value must be rejected for a new V2 bot
      expect(() => db.prepare(`
        INSERT INTO channel_bots (
          id, schema_version, revision, authorization_revision, connection_generation,
          channel, external_app_id, display_name, platform_display_name, brand,
          credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at
        ) VALUES ('bot-v2-wide', 2, ?, 1, 1, 'lark', 'app-v2-wide', 'Bot', NULL, 'feishu',
          NULL, 'staged', 'paused', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `).run(WIDE)).toThrow(/CHECK constraint failed/);

      // Fraction is also rejected for a new V2 bot, while an old V1 fraction row
      // (legal under original INTEGER-affinity CHECK? original was revision >= 1 only)
      // is preserved: build one directly in an old-shape database.
    } finally {
      db.close();
    }
  });

  it('rolls back a real late-stage v19 failure after all three table rebuilds and authority creation', () => {
    const { db } = tempDb();
    try {
      applyUpToVersion(db, 18);
      db.pragma('foreign_keys = ON');

      db.exec(`
        INSERT INTO channel_bots (id, schema_version, revision, channel, external_app_id, display_name, brand, state, desired_listener_state, full_trust_confirmed, created_at, updated_at)
        VALUES ('old-bot', 1, 7, 'lark', 'old-app', 'Old Bot', 'lark', 'staged', 'disabled', 0, '2026-01-01', '2026-01-01');
      `);

      // v19 order: rebuild bots, policies, bindings, create authority, then CREATE
      // configuration_operations. A pre-existing table with that exact name makes
      // the genuine migration fail only AFTER the three rebuilds and the authority
      // singleton insert — the late rollback stop point proven independently.
      db.exec('CREATE TABLE configuration_operations(obstacle INTEGER NOT NULL)');

      const dump = () => ({
        schema: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
        bots: db.prepare('SELECT * FROM channel_bots ORDER BY id').all(),
        versions: db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
      });
      const before = dump();

      expect(() => runMigrations(db)).toThrow(/configuration_operations already exists/);

      // Everything the migration touched must be back exactly as it was
      expect(dump()).toEqual(before);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.pragma('foreign_key_check')).toEqual([]);

      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name));
      expect(tables.has('configuration_authority')).toBe(false);
      expect(tables.has('configuration_changes')).toBe(false);
      expect(tables.has('configuration_versions')).toBe(false);
      expect(tables.has('full_trust_confirmations')).toBe(false);
      // old bot unchanged
      const bot = db.prepare('SELECT revision FROM channel_bots WHERE id=?').get('old-bot') as any;
      expect(bot.revision).toBe(7);
      const versions = (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(r => r.version);
      expect(versions).not.toContain(19);

      // Remove obstacle and retry: migration completes and reopening is idempotent
      db.exec('DROP TABLE configuration_operations');
      expect(() => runMigrations(db)).not.toThrow();
      expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 22 });
      expect(() => runMigrations(db)).not.toThrow();
      expect(db.prepare('SELECT authority FROM configuration_authority WHERE id=1').get()).toEqual({ authority: 'legacy' });
    } finally {
      db.close();
    }
  });
});
