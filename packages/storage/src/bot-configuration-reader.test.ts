import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from './migrations.js';
import {
  createConfigurationReader,
  computeSnapshotDigest,
  canonicalSnapshotJson
} from './bot-configuration-reader.js';
import type { BotSnapshot } from '@dutydeck/shared';

describe('bot configuration reader', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const dir of directories.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dutydeck-reader-test-'));
    directories.push(dir);
    return dir;
  }

  function setupTestDatabase(): { db: Database.Database; path: string } {
    const path = join(tempDir(), 'test.db');
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    runMigrations(db);
    return { db, path };
  }

  function setAuthority(db: Database.Database, authority: 'legacy' | 'v2'): void {
    db.prepare('UPDATE configuration_authority SET authority = ?, completed_at = ? WHERE id = 1').run(
      authority,
      new Date().toISOString()
    );
  }

  const samplePolicyDefaults = {
    agentDefinitionId: 'agent-1',
    workspace: '/workspace',
    model: 'gpt-4',
    reasoningEffort: 'high'
  };

  const sampleRoutingDefaults = {
    p2pMode: 'chat' as const,
    groupReplyMode: 'runtime_default' as const,
    mentionPolicy: 'always' as const
  };

  const sampleAccessPolicy = {
    humanTalk: {
      p2p: { mode: 'owner_only' as const },
      managedGroup: { mode: 'owner_only' as const },
      newGroup: { mode: 'owner_only' as const }
    },
    botTalk: {
      p2p: { mode: 'allowlist' as const, selectors: [], peerEnabled: false },
      managedGroup: { mode: 'allowlist' as const, selectors: [], peerEnabled: false },
      newGroup: { mode: 'allowlist' as const, selectors: [], peerEnabled: false }
    },
    defaultOperate: { rules: [] },
    p2pOperate: { mode: 'none' as const }
  };

  const sampleExecution = {
    permissionMode: 'full-trust' as const,
    preInjectPrompt: null,
    highRiskAccess: {
      p2p: { mode: 'entry_authorized' as const },
      managedGroup: { mode: 'entry_authorized' as const },
      newGroup: { mode: 'entry_authorized' as const }
    },
    riskControlMode: 'off' as const,
    highRiskPattern: 'rm -rf'
  };

  const samplePresentation = {
    webBaseUrl: 'https://example.com',
    structuredAskCards: true,
    groupCardMention: true,
    pushIntervalMs: 1000,
    traceLimit: 50,
    hideTraceOnComplete: false,
    completionReactionOnly: false,
    silentProgress: false
  };

  const sampleGroupToolsPolicy = {
    readCeiling: true,
    discoverCeiling: true,
    sendCeiling: false,
    readDefault: false,
    discoverDefault: false,
    sendDefault: false
  };

  it('authority reads singleton authority and rejects missing, corrupt, or invalid rows without fallback', () => {
    const { db } = setupTestDatabase();
    try {
      const reader = createConfigurationReader(db);

      // Default after migration is legacy
      expect(reader.authority()).toBe('legacy');

      // Switch to v2
      setAuthority(db, 'v2');
      expect(reader.authority()).toBe('v2');

      // 1. Missing authority row
      db.prepare('DELETE FROM configuration_authority').run();
      expect(() => reader.authority()).toThrowError(/CONFIGURATION_AUTHORITY_MISSING/);

      // 2. Corrupt multiple rows or invalid authority value
      db.exec(`
        DROP TABLE configuration_authority;
        CREATE TABLE configuration_authority (id INTEGER, authority TEXT, migration_id TEXT, legacy_collection_digest TEXT, completed_at TEXT);
        INSERT INTO configuration_authority VALUES (1, 'legacy', NULL, NULL, NULL), (2, 'v2', NULL, NULL, NULL);
      `);
      expect(() => reader.authority()).toThrowError(/CONFIGURATION_AUTHORITY_CORRUPT/);

      db.exec(`
        DELETE FROM configuration_authority;
        INSERT INTO configuration_authority VALUES (1, 'corrupt_val', NULL, NULL, NULL);
      `);
      expect(() => reader.authority()).toThrowError(/CONFIGURATION_AUTHORITY_INVALID/);
    } finally {
      db.close();
    }
  });

  it('rejects all read methods with CONFIGURATION_LEGACY_AUTHORITY when authority is legacy', () => {
    const { db } = setupTestDatabase();
    try {
      const reader = createConfigurationReader(db);
      expect(reader.authority()).toBe('legacy');

      expect(() => reader.listBots()).toThrowError(/CONFIGURATION_LEGACY_AUTHORITY/);
      expect(() => reader.read('any-bot')).toThrowError(/CONFIGURATION_LEGACY_AUTHORITY/);
      expect(() => reader.readByApp('any-app')).toThrowError(/CONFIGURATION_LEGACY_AUTHORITY/);
      expect(() => reader.listVersions('any-bot')).toThrowError(/CONFIGURATION_LEGACY_AUTHORITY/);
      expect(() => reader.readVersion('any-bot', 'v-1')).toThrowError(/CONFIGURATION_LEGACY_AUTHORITY/);
      expect(() => reader.listChanges(0, 10)).toThrowError(/CONFIGURATION_LEGACY_AUTHORITY/);
    } finally {
      db.close();
    }
  });

  it('returns undefined when reading non-existent bot or version under V2 authority', () => {
    const { db } = setupTestDatabase();
    try {
      setAuthority(db, 'v2');
      const reader = createConfigurationReader(db);

      expect(reader.read('non-existent')).toBeUndefined();
      expect(reader.readByApp('non-existent-app')).toBeUndefined();
      expect(reader.readVersion('non-existent', 'v-1')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('reads a complete snapshot with 601 bindings, 601 roles, credential metadata and confirmations in one transaction without truncation', () => {
    const { db } = setupTestDatabase();
    try {
      setAuthority(db, 'v2');
      const reader = createConfigurationReader(db);

      const botId = 'bot_full_snapshot';
      const appId = 'cli_full_app_1';
      const secretId = 'sec_ref_1';

      // Insert secret
      db.prepare(`
        INSERT INTO secret_refs (id, schema_version, revision, kind, provider, reference_key, status, created_at, updated_at)
        VALUES (?, 1, 1, 'lark_app_secret', 'vault', 'key/secret', 'configured', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `).run(secretId);

      // Insert bot v2
      db.prepare(`
        INSERT INTO channel_bots (
          id, schema_version, revision, authorization_revision, connection_generation,
          channel, external_app_id, display_name, platform_display_name, brand,
          credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at
        ) VALUES (
          ?, 2, 1, 1, 1,
          'lark', ?, 'Full Bot', 'Platform Full Bot', 'feishu',
          ?, 'enabled', 'receiving', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `).run(botId, appId, secretId);

      // Insert policy v2
      db.prepare(`
        INSERT INTO channel_bot_policies (
          id, schema_version, revision, channel_bot_id, defaults_json, routing_defaults_json,
          access_policy_json, execution_json, presentation_json, group_tools_policy_json,
          created_at, updated_at
        ) VALUES (
          'pol_1', 2, 1, ?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `).run(
        botId,
        JSON.stringify(samplePolicyDefaults),
        JSON.stringify(sampleRoutingDefaults),
        JSON.stringify(sampleAccessPolicy),
        JSON.stringify(sampleExecution),
        JSON.stringify(samplePresentation),
        JSON.stringify(sampleGroupToolsPolicy)
      );

      // Insert 601 group bindings and 601 role assignments
      const insertBinding = db.prepare(`
        INSERT INTO group_bindings (
          id, schema_version, revision, channel_bot_id, external_chat_id, state, access_profile,
          oncall, agent_override_json, workspace_override_json, model_override_json, reasoning_override_json,
          role_policy_override_json, routing_override_json, access_override_json, group_tools_override_json,
          presentation_override_json, review_reasons_json, created_at, updated_at
        ) VALUES (
          ?, 2, 1, ?, ?, 'enabled', 'managed_group', 0,
          '{"mode":"inherit"}', '{"mode":"inherit"}', '{"mode":"inherit"}', '{"mode":"inherit"}',
          '{"mode":"inherit"}', '{"groupReplyMode":{"mode":"inherit"},"mentionPolicy":{"mode":"inherit"}}',
          '{"mode":"inherit","principalIds":[]}', '{"read":"inherit","discover":"inherit","send":"inherit"}',
          '{"structuredAskCards":{"mode":"inherit"},"groupCardMention":{"mode":"inherit"},"pushIntervalMs":{"mode":"inherit"},"traceLimit":{"mode":"inherit"},"hideTraceOnComplete":{"mode":"inherit"},"completionReactionOnly":{"mode":"inherit"},"silentProgress":{"mode":"inherit"}}', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `);

      const insertRole = db.prepare(`
        INSERT INTO role_assignments (
          id, schema_version, revision, channel_bot_id, group_binding_id, scope_key,
          principal_id, role, operate_scope, action_gates_json, state, created_at, updated_at
        ) VALUES (
          ?, 1, 1, ?, ?, ?, 'principal_user_1', 'can_talk', 'none',
          '{"terminalWrite":false,"highRisk":false,"groupToolsSend":false}',
          'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `);

      db.transaction(() => {
        for (let i = 1; i <= 601; i++) {
          const bindingId = `binding_${String(i).padStart(4, '0')}`;
          const chatId = `chat_${String(i).padStart(4, '0')}`;
          insertBinding.run(bindingId, botId, chatId);

          const roleId = `role_${String(i).padStart(4, '0')}`;
          insertRole.run(roleId, botId, bindingId, `binding:${bindingId}`);
        }
      })();

      // Insert 2 confirmations: one user_action and one legacy_live
      const sampleScope = {
        version: 1,
        channelBotId: botId,
        externalAppId: appId,
        brand: 'feishu',
        entries: []
      };

      const scopeDigest = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

      db.prepare(`
        INSERT INTO full_trust_confirmations (
          id, channel_bot_id, bot_revision, scope_digest, scope_json,
          source, confirmed_by_json, confirmed_at, legacy_source_digest, recorded_at
        ) VALUES (
          'conf_user', ?, 1, ?, ?,
          'user_action', '{"kind":"installation_owner","principalId":"principal_installation_owner"}',
          '2026-01-01T00:00:00.000Z', NULL, NULL
        )
      `).run(botId, scopeDigest, JSON.stringify(sampleScope));

      db.prepare(`
        INSERT INTO full_trust_confirmations (
          id, channel_bot_id, bot_revision, scope_digest, scope_json,
          source, confirmed_by_json, confirmed_at, legacy_source_digest, recorded_at
        ) VALUES (
          'conf_legacy', ?, 1, ?, ?,
          'legacy_live', NULL, NULL,
          'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
          '2026-01-01T00:00:00.000Z'
        )
      `).run(botId, scopeDigest, JSON.stringify(sampleScope));

      // Read snapshot via read(botId)
      const snapshot1 = reader.read(botId);
      expect(snapshot1).toBeDefined();
      expect(snapshot1!.bot.id).toBe(botId);
      expect(snapshot1!.credential?.id).toBe(secretId);
      expect(snapshot1!.bindings).toHaveLength(601);
      expect(snapshot1!.roles).toHaveLength(601);
      expect(snapshot1!.confirmations).toHaveLength(2);

      // Read snapshot via readByApp(appId)
      const snapshot2 = reader.readByApp(appId);
      expect(snapshot2).toBeDefined();
      expect(snapshot2!.bot.id).toBe(botId);
      expect(snapshot2!.bindings).toHaveLength(601);
      expect(snapshot2!.roles).toHaveLength(601);

      // Verify no write side-effects (database unmodified)
      expect(snapshot1).toEqual(snapshot2);
    } finally {
      db.close();
    }
  });

  it('paginates listBots over 500 boundary without duplicate or skipped records', () => {
    const { db } = setupTestDatabase();
    try {
      setAuthority(db, 'v2');
      const reader = createConfigurationReader(db);

      const insertBot = db.prepare(`
        INSERT INTO channel_bots (
          id, schema_version, revision, authorization_revision, connection_generation,
          channel, external_app_id, display_name, platform_display_name, brand,
          credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at
        ) VALUES (
          ?, 2, 1, 1, 1,
          'lark', ?, 'Batch Bot', NULL, 'feishu',
          NULL, 'staged', 'paused', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `);

      // Insert 505 bots
      db.transaction(() => {
        for (let i = 1; i <= 505; i++) {
          const id = `bot_${String(i).padStart(4, '0')}`;
          const appId = `app_${String(i).padStart(4, '0')}`;
          insertBot.run(id, appId);
        }
      })();

      // First page limit 500
      const page1 = reader.listBots({ limit: 500 });
      expect(page1).toHaveLength(500);
      expect(page1[0]!.id).toBe('bot_0001');
      expect(page1[499]!.id).toBe('bot_0500');

      // Second page
      const lastId = page1[499]!.id;
      const page2 = reader.listBots({ afterId: lastId, limit: 500 });
      expect(page2).toHaveLength(5);
      expect(page2[0]!.id).toBe('bot_0501');
      expect(page2[4]!.id).toBe('bot_0505');

      // Full collection verification
      const allIds = [...page1, ...page2].map(b => b.id);
      expect(new Set(allIds).size).toBe(505);

      // Default limit is 200
      const defaultPage = reader.listBots();
      expect(defaultPage).toHaveLength(200);

      // Limit above 500 is rejected
      expect(() => reader.listBots({ limit: 501 })).toThrow();
    } finally {
      db.close();
    }
  });

  it('paginates listVersions over 200 boundary, reads versions with historical accuracy and cross-bot isolation', () => {
    const { db } = setupTestDatabase();
    try {
      setAuthority(db, 'v2');
      const reader = createConfigurationReader(db);

      const botId = 'bot_version_test';
      const otherBotId = 'bot_other';

      // Insert bot
      db.prepare(`
        INSERT INTO channel_bots (
          id, schema_version, revision, authorization_revision, connection_generation,
          channel, external_app_id, display_name, platform_display_name, brand,
          credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at
        ) VALUES (
          ?, 2, 205, 1, 1,
          'lark', 'app_v_test', 'Version Bot', NULL, 'feishu',
          NULL, 'enabled', 'receiving', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `).run(botId);

      db.prepare(`
        INSERT INTO channel_bots (
          id, schema_version, revision, authorization_revision, connection_generation,
          channel, external_app_id, display_name, platform_display_name, brand,
          credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at
        ) VALUES (
          ?, 2, 1, 1, 1,
          'lark', 'app_other', 'Other Bot', NULL, 'feishu',
          NULL, 'staged', 'paused', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `).run(otherBotId);

      // Insert operation and change
      db.prepare(`
        INSERT INTO configuration_operations (
          operation_id, action, actor_json, payload_digest, result_json, created_at
        ) VALUES (
          'op_init', 'create', '{"kind":"installation_owner","principalId":"principal_installation_owner"}',
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '{"success":true}',
          '2026-01-01T00:00:00.000Z'
        )
      `).run();

      const insertChange = db.prepare(`
        INSERT INTO configuration_changes (
          sequence, bot_id, change_kind, revision, authorization_revision, connection_generation, timestamp
        ) VALUES (?, ?, 'updated', ?, 1, 1, '2026-01-01T00:00:00.000Z')
      `);

      const insertVersion = db.prepare(`
        INSERT INTO configuration_versions (
          version_id, bot_id, revision, change_sequence, change_kind, operation_id, created_at, snapshot_digest, snapshot_json
        ) VALUES (?, ?, ?, ?, 'updated', 'op_init', '2026-01-01T00:00:00.000Z', ?, ?)
      `);

      // Build snapshots and insert 205 versions
      const versionsMap = new Map<string, BotSnapshot>();

      db.transaction(() => {
        for (let rev = 1; rev <= 205; rev++) {
          insertChange.run(rev, botId, rev);

          const snap: BotSnapshot = {
            bot: {
              schemaVersion: 2,
              id: botId,
              revision: rev,
              authorizationRevision: 1,
              connectionGeneration: 1,
              channel: 'lark',
              externalAppId: 'app_v_test',
              displayName: `Version Bot rev ${rev}`,
              platformDisplayName: null,
              brand: 'feishu',
              credentialRef: null,
              state: 'enabled',
              desiredListenerState: 'receiving',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z'
            },
            policy: {
              schemaVersion: 2,
              id: `pol_${rev}`,
              revision: rev,
              channelBotId: botId,
              defaults: samplePolicyDefaults,
              routingDefaults: sampleRoutingDefaults,
              accessPolicy: sampleAccessPolicy,
              execution: sampleExecution,
              presentation: samplePresentation,
              groupToolsPolicy: sampleGroupToolsPolicy,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z'
            },
            bindings: [],
            roles: [],
            confirmations: []
          };

          const digest = computeSnapshotDigest(snap);
          const versionId = `ver_${String(rev).padStart(4, '0')}`;
          versionsMap.set(versionId, snap);

          insertVersion.run(versionId, botId, rev, rev, digest, JSON.stringify(snap));
        }
      })();

      // 1. Paginate listVersions
      const vPage1 = reader.listVersions(botId, { limit: 200 });
      expect(vPage1).toHaveLength(200);
      expect(vPage1[0]!.revision).toBe(205);
      expect(vPage1[199]!.revision).toBe(6);

      const vPage2 = reader.listVersions(botId, { beforeRevision: 6, limit: 200 });
      expect(vPage2).toHaveLength(5);
      expect(vPage2[0]!.revision).toBe(5);
      expect(vPage2[4]!.revision).toBe(1);

      // 2. readVersion accurately reproduces snapshot without being replaced by current database row
      const ver50 = reader.readVersion(botId, 'ver_0050');
      expect(ver50).toBeDefined();
      expect(ver50!.revision).toBe(50);
      expect(ver50!.snapshot.bot.revision).toBe(50);
      expect(ver50!.snapshot.bot.displayName).toBe('Version Bot rev 50');

      // 3. Cross-bot isolation: reading a version belonging to botId from otherBotId returns undefined
      expect(reader.readVersion(otherBotId, 'ver_0050')).toBeUndefined();

      // 4. Corrupted snapshot digest detection
      db.prepare("UPDATE configuration_versions SET snapshot_digest = '0000000000000000000000000000000000000000000000000000000000000000' WHERE version_id = 'ver_0001'").run();
      expect(() => reader.readVersion(botId, 'ver_0001')).toThrowError(/CONFIGURATION_VERSION_DIGEST_MISMATCH/);
    } finally {
      db.close();
    }
  });

  it('reads listChanges ordered by sequence with afterSequence cursor and bounds', () => {
    const { db } = setupTestDatabase();
    try {
      setAuthority(db, 'v2');
      const reader = createConfigurationReader(db);

      const botId = 'bot_changes';
      db.prepare(`
        INSERT INTO channel_bots (
          id, schema_version, revision, authorization_revision, connection_generation,
          channel, external_app_id, display_name, platform_display_name, brand,
          credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at
        ) VALUES (
          ?, 2, 1, 1, 1, 'lark', 'app_chg', 'Bot', NULL, 'feishu', NULL, 'staged', 'paused', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `).run(botId);

      const insertChange = db.prepare(`
        INSERT INTO configuration_changes (
          sequence, bot_id, change_kind, revision, authorization_revision, connection_generation, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')
      `);

      db.transaction(() => {
        insertChange.run(1, botId, 'created', 1, 1, 1);
        insertChange.run(2, botId, 'receiving_changed', 1, 1, 2);
        insertChange.run(3, botId, 'updated', 2, 1, 2);
      })();

      const changes = reader.listChanges(0, 10);
      expect(changes).toHaveLength(3);
      expect(changes[0]!.sequence).toBe(1);
      expect(changes[0]!.changeKind).toBe('created');
      expect(changes[1]!.sequence).toBe(2);
      expect(changes[1]!.changeKind).toBe('receiving_changed');
      expect(changes[2]!.sequence).toBe(3);
      expect(changes[2]!.changeKind).toBe('updated');

      // afterSequence cursor
      const cursorChanges = reader.listChanges(1, 10);
      expect(cursorChanges).toHaveLength(2);
      expect(cursorChanges[0]!.sequence).toBe(2);

      // Bounds validation
      expect(() => reader.listChanges(-1, 10)).toThrow();
      expect(() => reader.listChanges(0, 0)).toThrow();
      expect(() => reader.listChanges(0, 501)).toThrow();
    } finally {
      db.close();
    }
  });

  it('readVersion preserves historical credential metadata and revoked confirmations, never substituting current rows', () => {
    const { db } = setupTestDatabase();
    try {
      setAuthority(db, 'v2');
      const reader = createConfigurationReader(db);

      const botId = 'bot_hist';

      // Current rows: secret now at revision 3 with a different provider/key; bot has no active confirmation
      db.prepare(`
        INSERT INTO secret_refs (id, schema_version, revision, kind, provider, reference_key, status, created_at, updated_at)
        VALUES ('sec_hist', 1, 3, 'lark_app_secret', 'current-provider', 'current-key', 'configured', '2026-01-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')
      `).run();

      db.prepare(`
        INSERT INTO channel_bots (
          id, schema_version, revision, authorization_revision, connection_generation,
          channel, external_app_id, display_name, platform_display_name, brand,
          credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at
        ) VALUES (
          ?, 2, 2, 2, 2, 'lark', 'app_hist', 'Current Bot', NULL, 'feishu',
          'sec_hist', 'enabled', 'receiving', 0, '2026-01-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'
        )
      `).run(botId);

      // Historical snapshot (rev 1): secret was revision 1, different provider/key; confirmation later revoked
      const historicalScope = {
        version: 1 as const,
        channelBotId: botId,
        externalAppId: 'app_hist',
        brand: 'feishu' as const,
        entries: []
      };
      const historicalSnapshot: BotSnapshot = {
        bot: {
          schemaVersion: 2,
          id: botId,
          revision: 1,
          authorizationRevision: 1,
          connectionGeneration: 1,
          channel: 'lark',
          externalAppId: 'app_hist',
          displayName: 'Historical Bot',
          platformDisplayName: null,
          brand: 'feishu',
          credentialRef: 'sec_hist',
          state: 'enabled',
          desiredListenerState: 'receiving',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        },
        credential: {
          schemaVersion: 1,
          id: 'sec_hist',
          revision: 1,
          kind: 'lark_app_secret',
          provider: 'historical-provider',
          referenceKey: 'historical-key',
          status: 'configured',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        },
        policy: {
          schemaVersion: 2,
          id: 'pol_hist',
          revision: 1,
          channelBotId: botId,
          defaults: {},
          routingDefaults: sampleRoutingDefaults,
          accessPolicy: sampleAccessPolicy,
          execution: sampleExecution,
          presentation: samplePresentation,
          groupToolsPolicy: sampleGroupToolsPolicy,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        },
        bindings: [],
        roles: [],
        confirmations: [
          {
            id: 'conf_revoked',
            channelBotId: botId,
            botRevision: 1,
            scopeDigest: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            scope: historicalScope,
            source: 'user_action',
            confirmedBy: { kind: 'installation_owner', principalId: 'principal_installation_owner' },
            confirmedAt: '2026-01-02T00:00:00.000Z',
            revokedAt: '2026-02-01T00:00:00.000Z',
            revokedReason: 'policy changed'
          }
        ]
      };

      db.prepare(`
        INSERT INTO configuration_operations (
          operation_id, action, actor_json, payload_digest, result_json, created_at
        ) VALUES (
          'op_hist', 'update', '{"kind":"installation_owner","principalId":"principal_installation_owner"}',
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '{}',
          '2026-01-01T00:00:00.000Z'
        )
      `).run();

      // Current live policy (rev 2) for reader.read(botId)
      db.prepare(`
        INSERT INTO channel_bot_policies (
          id, schema_version, revision, channel_bot_id, defaults_json, routing_defaults_json,
          access_policy_json, execution_json, presentation_json, group_tools_policy_json,
          created_at, updated_at
        ) VALUES (
          'pol_hist', 2, 2, ?, '{}', ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'
        )
      `).run(
        botId,
        JSON.stringify(sampleRoutingDefaults),
        JSON.stringify(sampleAccessPolicy),
        JSON.stringify(sampleExecution),
        JSON.stringify(samplePresentation),
        JSON.stringify(sampleGroupToolsPolicy)
      );
      db.prepare(`
        INSERT INTO configuration_changes (sequence, bot_id, change_kind, revision, authorization_revision, connection_generation, timestamp)
        VALUES (1, ?, 'updated', 1, 1, 1, '2026-01-01T00:00:00.000Z')
      `).run(botId);
      db.prepare(`
        INSERT INTO configuration_versions (
          version_id, bot_id, revision, change_sequence, change_kind, operation_id, created_at, snapshot_digest, snapshot_json
        ) VALUES (?, ?, 1, 1, 'updated', 'op_hist', '2026-01-01T00:00:00.000Z', ?, ?)
      `).run('ver_hist', botId, computeSnapshotDigest(historicalSnapshot), JSON.stringify(historicalSnapshot));

      const version = reader.readVersion(botId, 'ver_hist');
      expect(version).toBeDefined();
      // Historical credential metadata survives even though the live row is rev 3
      expect(version!.snapshot.credential?.revision).toBe(1);
      expect(version!.snapshot.credential?.provider).toBe('historical-provider');
      expect(version!.snapshot.credential?.referenceKey).toBe('historical-key');
      // Revoked confirmation stays in the historical snapshot with revocation fields
      expect(version!.snapshot.confirmations).toHaveLength(1);
      expect(version!.snapshot.confirmations[0]!.id).toBe('conf_revoked');
      expect(version!.snapshot.confirmations[0]!.revokedAt).toBe('2026-02-01T00:00:00.000Z');
      expect(version!.snapshot.confirmations[0]!.revokedReason).toBe('policy changed');
      // Current live snapshot differs: secret rev 3, no confirmations
      const current = reader.read(botId);
      expect(current).toBeDefined();
      expect(current!.bot.revision).toBe(2);
      expect(current!.credential?.revision).toBe(3);
      expect(current!.credential?.provider).toBe('current-provider');
      expect(current!.confirmations).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('rejects corrupted records and missing relations under V2 authority', () => {
    const { db } = setupTestDatabase();
    try {
      setAuthority(db, 'v2');
      const reader = createConfigurationReader(db);

      // 1. Missing policy for an existing bot
      db.prepare(`
        INSERT INTO channel_bots (
          id, schema_version, revision, authorization_revision, connection_generation,
          channel, external_app_id, display_name, platform_display_name, brand,
          credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at
        ) VALUES (
          'bot_no_policy', 2, 1, 1, 1, 'lark', 'app_no_pol', 'Bot', NULL, 'feishu', NULL, 'staged', 'paused', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `).run();

      expect(() => reader.read('bot_no_policy')).toThrowError(/CONFIGURATION_CORRUPTED_RELATION/);

      // 2. Missing referenced secret
      db.prepare(`
        INSERT INTO secret_refs (id, schema_version, revision, kind, provider, reference_key, status, created_at, updated_at)
        VALUES ('temp_sec', 1, 1, 'lark_app_secret', 'vault', 'key', 'configured', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `).run();

      db.prepare(`
        INSERT INTO channel_bots (
          id, schema_version, revision, authorization_revision, connection_generation,
          channel, external_app_id, display_name, platform_display_name, brand,
          credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at
        ) VALUES (
          'bot_missing_sec', 2, 1, 1, 1, 'lark', 'app_miss_sec', 'Bot', NULL, 'feishu', 'temp_sec', 'staged', 'paused', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `).run();

      db.prepare(`
        INSERT INTO channel_bot_policies (
          id, schema_version, revision, channel_bot_id, defaults_json, routing_defaults_json,
          access_policy_json, execution_json, presentation_json, group_tools_policy_json,
          created_at, updated_at
        ) VALUES (
          'pol_missing_sec', 2, 1, 'bot_missing_sec', '{}',
          '{"p2pMode":"chat","groupReplyMode":"runtime_default","mentionPolicy":"always"}',
          '{"humanTalk":{"p2p":{"mode":"owner_only"},"managedGroup":{"mode":"owner_only"},"newGroup":{"mode":"owner_only"}},"botTalk":{"p2p":{"mode":"allowlist","selectors":[],"peerEnabled":false},"managedGroup":{"mode":"allowlist","selectors":[],"peerEnabled":false},"newGroup":{"mode":"allowlist","selectors":[],"peerEnabled":false}},"defaultOperate":{"rules":[]},"p2pOperate":{"mode":"none"}}',
          '{"permissionMode":"ask","preInjectPrompt":null,"highRiskAccess":{"p2p":{"mode":"entry_authorized"},"managedGroup":{"mode":"entry_authorized"},"newGroup":{"mode":"entry_authorized"}},"riskControlMode":"off","highRiskPattern":".*"}',
          '{"webBaseUrl":null,"structuredAskCards":false,"groupCardMention":false,"pushIntervalMs":1000,"traceLimit":10,"hideTraceOnComplete":false,"completionReactionOnly":false,"silentProgress":false}',
          '{"readCeiling":false,"discoverCeiling":false,"sendCeiling":false,"readDefault":false,"discoverDefault":false,"sendDefault":false}',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `).run();

      // Simulate corrupted database where secret_ref was deleted under foreign_keys = OFF
      db.pragma('foreign_keys = OFF');
      db.prepare("DELETE FROM secret_refs WHERE id = 'temp_sec'").run();
      db.pragma('foreign_keys = ON');

      expect(() => reader.read('bot_missing_sec')).toThrowError(/CONFIGURATION_CORRUPTED_RELATION/);
    } finally {
      db.close();
    }
  });

  it('guarantees composite read isolation preventing version mixing during concurrent writes via sync barrier', () => {
    const { db, path } = setupTestDatabase();
    // Open a second connection to the same SQLite WAL database
    const db2 = new Database(path);
    db2.pragma('journal_mode = WAL');

    try {
      setAuthority(db, 'v2');

      const botId = 'bot_isolation_test';
      const appId = 'app_isolation_test';

      // Insert initial bot (rev 1) and policy (rev 1)
      db.prepare(`
        INSERT INTO channel_bots (
          id, schema_version, revision, authorization_revision, connection_generation,
          channel, external_app_id, display_name, platform_display_name, brand,
          credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at
        ) VALUES (
          ?, 2, 1, 1, 1, 'lark', ?, 'Initial Bot', NULL, 'feishu', NULL, 'enabled', 'receiving', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `).run(botId, appId);

      db.prepare(`
        INSERT INTO channel_bot_policies (
          id, schema_version, revision, channel_bot_id, defaults_json, routing_defaults_json,
          access_policy_json, execution_json, presentation_json, group_tools_policy_json,
          created_at, updated_at
        ) VALUES (
          'pol_iso', 2, 1, ?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `).run(
        botId,
        JSON.stringify(samplePolicyDefaults),
        JSON.stringify(sampleRoutingDefaults),
        JSON.stringify(sampleAccessPolicy),
        JSON.stringify(sampleExecution),
        JSON.stringify(samplePresentation),
        JSON.stringify(sampleGroupToolsPolicy)
      );

      // Custom deterministic barrier: when conn1 reads bot, conn2 commits a mutation bumping bot & policy to rev 2
      let barrierTriggered = false;
      db.function('trigger_concurrent_write', () => {
        if (!barrierTriggered) {
          barrierTriggered = true;
          // Connection 2 updates bot and policy to rev 2 in an immediate transaction
          db2.transaction(() => {
            db2.prepare("UPDATE channel_bots SET revision = 2, display_name = 'Updated Bot' WHERE id = ?").run(botId);
            db2.prepare("UPDATE channel_bot_policies SET revision = 2 WHERE channel_bot_id = ?").run(botId);
          })();
        }
        return null;
      });

      // Intercept channel_bots query via TEMP VIEW on connection 1:
      // When reader queries channel_bots, trigger_concurrent_write() fires inside the active read transaction of conn1
      db.exec(`
        CREATE TEMP VIEW channel_bots AS
        SELECT
          id, schema_version, revision, authorization_revision, connection_generation,
          channel, external_app_id, display_name, platform_display_name, brand,
          credential_ref, state, desired_listener_state, full_trust_confirmed,
          created_at, updated_at
        FROM main.channel_bots
        WHERE trigger_concurrent_write() IS NULL;
      `);

      // Now create reader on db
      const reader = createConfigurationReader(db);

      // Now call reader.read(botId).
      // Reader executes:
      // 1. SELECT * FROM channel_bots WHERE id = ? (triggers barrier, conn2 commits rev 2)
      // 2. SELECT * FROM channel_bot_policies WHERE channel_bot_id = ?
      // Because reader runs in a transaction, statement 2 sees conn1's read snapshot (rev 1 policy)!
      const snapshot = reader.read(botId);

      expect(barrierTriggered).toBe(true);
      expect(snapshot).toBeDefined();

      // Crucial verification: Connection 1's read transaction sees its consistent snapshot (rev 1 bot and rev 1 policy)
      // It must NOT see rev 1 bot mixed with rev 2 policy!
      expect(snapshot!.bot.revision).toBe(1);
      expect(snapshot!.policy.revision).toBe(1);
      expect(snapshot!.bot.displayName).toBe('Initial Bot');

      // Drop the temp view so subsequent reads query the main table normally
      db.exec('DROP VIEW temp.channel_bots');

      // Now on a new transaction, reader sees rev 2 for both
      const nextSnapshot = reader.read(botId);
      expect(nextSnapshot).toBeDefined();
      expect(nextSnapshot!.bot.revision).toBe(2);
      expect(nextSnapshot!.policy.revision).toBe(2);
      expect(nextSnapshot!.bot.displayName).toBe('Updated Bot');
      expect(nextSnapshot!.policy.revision).toBe(2);
      expect(nextSnapshot!.bot.displayName).toBe('Updated Bot');
    } finally {
      db2.close();
      db.close();
    }
  });

  // Helper for F1/F3: insert a valid V2 bot + policy for the given id
  function insertV2BotWithPolicy(
    db: Database.Database,
    botId: string,
    appId: string,
    revision: number,
    authorizationRevision: number,
    connectionGeneration: number
  ): void {
    db.prepare(`
      INSERT INTO channel_bots (
        id, schema_version, revision, authorization_revision, connection_generation,
        channel, external_app_id, display_name, platform_display_name, brand,
        credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at
      ) VALUES (
        ?, 2, ?, ?, ?, 'lark', ?, 'Bot', NULL, 'feishu',
        NULL, 'enabled', 'receiving', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
    `).run(botId, revision, authorizationRevision, connectionGeneration, appId);
    db.prepare(`
      INSERT INTO channel_bot_policies (
        id, schema_version, revision, channel_bot_id, defaults_json, routing_defaults_json,
        access_policy_json, execution_json, presentation_json, group_tools_policy_json,
        created_at, updated_at
      ) VALUES (?, 2, ?, ?, '{}', ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run(
      `pol_${botId}`, revision, botId,
      JSON.stringify(sampleRoutingDefaults),
      JSON.stringify(sampleAccessPolicy),
      JSON.stringify(sampleExecution),
      JSON.stringify(samplePresentation),
      JSON.stringify(sampleGroupToolsPolicy)
    );
  }

  function buildHistoricalSnapshot(
    botId: string,
    appId: string,
    revision: number,
    authorizationRevision: number,
    connectionGeneration: number
  ): BotSnapshot {
    return {
      bot: {
        schemaVersion: 2,
        id: botId,
        revision,
        authorizationRevision,
        connectionGeneration,
        channel: 'lark',
        externalAppId: appId,
        displayName: `Bot rev ${revision}`,
        platformDisplayName: null,
        brand: 'feishu',
        credentialRef: null,
        state: 'enabled',
        desiredListenerState: 'receiving',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      },
      policy: {
        schemaVersion: 2,
        id: `pol_${botId}`,
        revision,
        channelBotId: botId,
        defaults: {},
        routingDefaults: sampleRoutingDefaults,
        accessPolicy: sampleAccessPolicy,
        execution: sampleExecution,
        presentation: samplePresentation,
        groupToolsPolicy: sampleGroupToolsPolicy,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      },
      bindings: [],
      roles: [],
      confirmations: []
    };
  }

  function insertOperation(db: Database.Database, operationId: string): void {
    db.prepare(`
      INSERT INTO configuration_operations (operation_id, action, actor_json, target_json, payload_digest, result_json, created_at)
      VALUES (?, 'update', '{}', NULL, ?, '{}', '2026-01-01T00:00:00.000Z')
    `).run(operationId, 'd'.repeat(64));
  }

  function insertChange(
    db: Database.Database,
    sequence: number,
    botId: string,
    kind: string,
    revision: number,
    auth: number,
    conn: number
  ): void {
    db.prepare(`
      INSERT INTO configuration_changes (sequence, bot_id, change_kind, revision, authorization_revision, connection_generation, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')
    `).run(sequence, botId, kind, revision, auth, conn);
  }

  function insertVersion(
    db: Database.Database,
    versionId: string,
    botId: string,
    revision: number,
    changeSequence: number,
    kind: string,
    operationId: string,
    snapshot: BotSnapshot
  ): void {
    db.prepare(`
      INSERT INTO configuration_versions (
        version_id, bot_id, revision, change_sequence, change_kind, operation_id,
        created_at, snapshot_digest, snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', ?, ?)
    `).run(versionId, botId, revision, changeSequence, kind, operationId, computeSnapshotDigest(snapshot), JSON.stringify(snapshot));
  }

  it('F1: reader rejects unsafe versions in listChanges, version metadata and nested historical snapshot values', () => {
    const { db } = setupTestDatabase();
    try {
      setAuthority(db, 'v2');
      const reader = createConfigurationReader(db);
      insertV2BotWithPolicy(db, 'botA', 'appA', 1, 1, 1);
      insertOperation(db, 'op1');

      // 1. listChanges must surface unsafe rows as corruption, not return them.
      //    SQL CHECK already blocks these at write time, so place the bad row
      //    with ignore_check_constraints to simulate a corrupt database.
      db.pragma('ignore_check_constraints = ON');
      db.prepare(`
        INSERT INTO configuration_changes (sequence, bot_id, change_kind, revision, authorization_revision, connection_generation, timestamp)
        VALUES (?, 'botA', 'updated', ?, 1, 1, '2026-01-01T00:00:00.000Z')
      `).run(9007199254740992n, 1);
      db.pragma('ignore_check_constraints = OFF');
      expect(() => reader.listChanges(0, 10)).toThrowError(/CONFIGURATION_CORRUPTED_RECORD/);
      db.exec('DELETE FROM configuration_changes');

      // 2. Correct digest but unsafe nested versions inside a historical snapshot must be rejected.
      insertChange(db, 1, 'botA', 'updated', 1, 1, 1);
      const unsafeSnap = buildHistoricalSnapshot('botA', 'appA', 1, 1, 1);
      (unsafeSnap as any).bot.authorizationRevision = 9007199254740992;
      insertVersion(db, 'ver_unsafe_auth', 'botA', 1, 1, 'updated', 'op1', unsafeSnap);
      expect(() => reader.readVersion('botA', 'ver_unsafe_auth')).toThrowError(/CONFIGURATION_CORRUPTED_RECORD/);
      db.exec("DELETE FROM configuration_versions WHERE version_id='ver_unsafe_auth'");

      const unsafeSnap2 = buildHistoricalSnapshot('botA', 'appA', 1, 1, 1);
      (unsafeSnap2 as any).policy.revision = 9007199254740992;
      insertVersion(db, 'ver_unsafe_pol', 'botA', 1, 1, 'updated', 'op1', unsafeSnap2);
      expect(() => reader.readVersion('botA', 'ver_unsafe_pol')).toThrowError(/CONFIGURATION_CORRUPTED_RECORD/);
      db.exec("DELETE FROM configuration_versions WHERE version_id='ver_unsafe_pol'");

      // 3. A genuinely safe history version is still returned unchanged.
      const safeSnap = buildHistoricalSnapshot('botA', 'appA', 1, 1, 1);
      insertVersion(db, 'ver_safe', 'botA', 1, 1, 'updated', 'op1', safeSnap);
      const ok = reader.readVersion('botA', 'ver_safe');
      expect(ok).toBeDefined();
      expect(ok!.revision).toBe(1);
    } finally {
      db.close();
    }
  });

  it('F3: readVersion/listVersions verify the associated change (existence, same bot, revision, kind, generations) without writing', () => {
    const { db } = setupTestDatabase();
    try {
      setAuthority(db, 'v2');
      const reader = createConfigurationReader(db);
      insertV2BotWithPolicy(db, 'botA', 'appA', 1, 1, 1);
      insertV2BotWithPolicy(db, 'botB', 'appB', 1, 1, 1);
      insertOperation(db, 'opA');
      insertOperation(db, 'opB');

      const snapshotA = buildHistoricalSnapshot('botA', 'appA', 1, 1, 1);

      // Cross-bot change: version for botA references a change belonging to botB
      insertChange(db, 1, 'botB', 'deleted', 999, 77, 88);
      insertVersion(db, 'ver_cross', 'botA', 1, 1, 'updated', 'opA', snapshotA);
      expect(() => reader.readVersion('botA', 'ver_cross')).toThrowError(/CONFIGURATION_CORRUPTED_RELATION/);
      expect(() => reader.listVersions('botA')).toThrowError(/CONFIGURATION_CORRUPTED_RELATION/);
      // querying the same version id under botB returns undefined (identity gate runs before relation check)
      expect(reader.readVersion('botB', 'ver_cross')).toBeUndefined();

      // Missing related change sequence (plant a dangling FK reference with enforcement off)
      db.pragma('foreign_keys = OFF');
      db.exec('DELETE FROM configuration_changes');
      db.pragma('foreign_keys = ON');
      expect(() => reader.readVersion('botA', 'ver_cross')).toThrowError(/CONFIGURATION_CORRUPTED_RELATION/);
      expect(() => reader.listVersions('botA')).toThrowError(/CONFIGURATION_CORRUPTED_RELATION/);

      // Same bot but mismatched revision/kind on the change row
      const replaceChange = (kind: string, revision: number, auth: number, conn: number) => {
        db.pragma('foreign_keys = OFF');
        db.exec('DELETE FROM configuration_changes');
        db.pragma('foreign_keys = ON');
        insertChange(db, 1, 'botA', kind, revision, auth, conn);
      };
      replaceChange('deleted', 2, 1, 1);
      expect(() => reader.readVersion('botA', 'ver_cross')).toThrowError(/CONFIGURATION_CORRUPTED_RELATION/);
      replaceChange('created', 1, 1, 1);
      expect(() => reader.readVersion('botA', 'ver_cross')).toThrowError(/CONFIGURATION_CORRUPTED_RELATION/);

      // Authorization/connection generations in the change must equal the snapshot versions
      replaceChange('updated', 1, 5, 1);
      expect(() => reader.readVersion('botA', 'ver_cross')).toThrowError(/CONFIGURATION_CORRUPTED_RELATION/);
      replaceChange('updated', 1, 1, 6);
      expect(() => reader.readVersion('botA', 'ver_cross')).toThrowError(/CONFIGURATION_CORRUPTED_RELATION/);

      // Reads are not allowed to repair anything: rows remain exactly as left
      const stillBroken = db.prepare('SELECT change_sequence FROM configuration_versions WHERE version_id=?').get('ver_cross') as any;
      expect(stillBroken.change_sequence).toBe(1);

      // A fully consistent version reads fine through both listVersions and readVersion
      db.pragma('foreign_keys = OFF');
      db.exec('DELETE FROM configuration_changes');
      db.pragma('foreign_keys = ON');
      insertChange(db, 1, 'botA', 'updated', 1, 1, 1);
      db.exec("UPDATE configuration_versions SET change_kind='updated' WHERE version_id='ver_cross'");
      const listed = reader.listVersions('botA');
      expect(listed).toHaveLength(1);
      expect(listed[0]!.versionId).toBe('ver_cross');
      const full = reader.readVersion('botA', 'ver_cross');
      expect(full).toBeDefined();
      expect(full!.snapshot.bot.id).toBe('botA');
    } finally {
      db.close();
    }
  });

  it('F4: corrupt confirmation rows with conflicting NULL/non-NULL columns are rejected in both directions', () => {
    const { db } = setupTestDatabase();
    try {
      setAuthority(db, 'v2');
      const reader = createConfigurationReader(db);
      insertV2BotWithPolicy(db, 'botConf', 'appConf', 1, 1, 1);

      const scope = { version: 1 as const, channelBotId: 'botConf', externalAppId: 'appConf', brand: 'feishu' as const, entries: [] };
      const digest = 'a'.repeat(64);
      const legacyDigest = 'b'.repeat(64);
      const actor = JSON.stringify({ kind: 'installation_owner', principalId: 'principal_installation_owner' });

      const insertConfirmation = (id: string, source: string, cols: Record<string, string | null>) => {
        db.prepare(`
          INSERT INTO full_trust_confirmations (
            id, channel_bot_id, bot_revision, scope_digest, scope_json,
            source, confirmed_by_json, confirmed_at, legacy_source_digest, recorded_at, revoked_at, revoked_reason
          ) VALUES (?, 'botConf', 1, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        `).run(
          id, digest, JSON.stringify(scope), source,
          'confirmed_by_json' in cols ? cols.confirmed_by_json : null,
          'confirmed_at' in cols ? cols.confirmed_at : null,
          'legacy_source_digest' in cols ? cols.legacy_source_digest : null,
          'recorded_at' in cols ? cols.recorded_at : null
        );
      };

      // Baseline: a valid legacy_live row reads
      insertConfirmation('legacy_ok', 'legacy_live', { legacy_source_digest: legacyDigest, recorded_at: '2026-01-01T00:00:00.000Z' });
      expect(reader.read('botConf')!.confirmations).toHaveLength(1);

      // Corrupt direction 1: legacy_live row carrying actor/time (placed with ignore_check_constraints)
      db.pragma('ignore_check_constraints = ON');
      insertConfirmation('legacy_cross', 'legacy_live', {
        confirmed_by_json: actor,
        confirmed_at: '2026-02-01T00:00:00.000Z',
        legacy_source_digest: legacyDigest,
        recorded_at: '2026-01-01T00:00:00.000Z'
      });
      // empty string is not NULL either
      insertConfirmation('legacy_empty', 'legacy_live', {
        confirmed_by_json: '',
        confirmed_at: null,
        legacy_source_digest: legacyDigest,
        recorded_at: '2026-01-01T00:00:00.000Z'
      });
      // Corrupt direction 2: user_action row carrying legacy columns
      insertConfirmation('user_cross', 'user_action', {
        confirmed_by_json: actor,
        confirmed_at: '2026-02-01T00:00:00.000Z',
        legacy_source_digest: legacyDigest,
        recorded_at: '2026-01-01T00:00:00.000Z'
      });
      insertConfirmation('user_empty', 'user_action', {
        confirmed_by_json: actor,
        confirmed_at: '2026-02-01T00:00:00.000Z',
        legacy_source_digest: '',
        recorded_at: null
      });
      db.pragma('ignore_check_constraints = OFF');

      expect(() => reader.read('botConf')).toThrowError(/CONFIGURATION_CORRUPTED_RECORD/);

      // Each corrupt row is individually rejected: keep only one corrupt row at a time
      const corruptSpecs: Array<{ id: string; source: string; cols: Record<string, string | null> }> = [
        { id: 'legacy_cross', source: 'legacy_live', cols: { confirmed_by_json: actor, confirmed_at: '2026-02-01T00:00:00.000Z', legacy_source_digest: legacyDigest, recorded_at: '2026-01-01T00:00:00.000Z' } },
        { id: 'legacy_empty', source: 'legacy_live', cols: { confirmed_by_json: '', confirmed_at: null, legacy_source_digest: legacyDigest, recorded_at: '2026-01-01T00:00:00.000Z' } },
        { id: 'user_cross', source: 'user_action', cols: { confirmed_by_json: actor, confirmed_at: '2026-02-01T00:00:00.000Z', legacy_source_digest: legacyDigest, recorded_at: '2026-01-01T00:00:00.000Z' } },
        { id: 'user_empty', source: 'user_action', cols: { confirmed_by_json: actor, confirmed_at: '2026-02-01T00:00:00.000Z', legacy_source_digest: '', recorded_at: null } }
      ];
      for (const spec of corruptSpecs) {
        db.exec("DELETE FROM full_trust_confirmations WHERE id IN ('legacy_cross','legacy_empty','user_cross','user_empty')");
        db.pragma('ignore_check_constraints = ON');
        insertConfirmation(spec.id, spec.source, spec.cols);
        db.pragma('ignore_check_constraints = OFF');
        expect(() => reader.read('botConf')).toThrowError(/CONFIGURATION_CORRUPTED_RECORD/);
      }

      // After removing all corrupt rows, the valid row reads again and SQL was never mutated by the reader
      db.exec("DELETE FROM full_trust_confirmations WHERE id IN ('legacy_cross','legacy_empty','user_cross','user_empty')");
      const result = reader.read('botConf')!.confirmations;
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('legacy_ok');
      const raw = db.prepare('SELECT confirmed_by_json, confirmed_at, legacy_source_digest, recorded_at FROM full_trust_confirmations WHERE id=?').get('legacy_ok') as any;
      expect(raw).toEqual({ confirmed_by_json: null, confirmed_at: null, legacy_source_digest: legacyDigest, recorded_at: '2026-01-01T00:00:00.000Z' });
    } finally {
      db.close();
    }
  });

  it('guarantees clean object shapes on optional fields omitting own undefined properties across roles and confirmations', () => {
    const { db, path } = setupTestDatabase();
    try {
      setAuthority(db, 'v2');
      const reader = createConfigurationReader(db);

      const botId = 'bot_clean_shape';
      const appId = 'app_clean_shape';
      const secId = 'sec_clean_shape';

      // 1. Secret metadata
      db.prepare(`
        INSERT INTO secret_refs (id, schema_version, revision, kind, provider, reference_key, status, created_at, updated_at)
        VALUES (?, 1, 1, 'lark_app_secret', 'vault', 'key/sec', 'configured', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `).run(secId);

      // 2. Bot & Policy
      db.prepare(`
        INSERT INTO channel_bots (
          id, schema_version, revision, authorization_revision, connection_generation,
          channel, external_app_id, display_name, platform_display_name, brand,
          credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at
        ) VALUES (
          ?, 2, 1, 1, 1, 'lark', ?, 'Clean Bot', NULL, 'feishu',
          ?, 'enabled', 'receiving', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `).run(botId, appId, secId);

      db.prepare(`
        INSERT INTO channel_bot_policies (
          id, schema_version, revision, channel_bot_id, defaults_json, routing_defaults_json,
          access_policy_json, execution_json, presentation_json, group_tools_policy_json,
          created_at, updated_at
        ) VALUES (
          'pol_clean', 2, 1, ?, '{}', ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `).run(
        botId,
        JSON.stringify(sampleRoutingDefaults),
        JSON.stringify(sampleAccessPolicy),
        JSON.stringify(sampleExecution),
        JSON.stringify(samplePresentation),
        JSON.stringify(sampleGroupToolsPolicy)
      );

      // 3. Binding
      const bindingId = 'binding_clean';
      db.prepare(`
        INSERT INTO group_bindings (
          id, schema_version, revision, channel_bot_id, external_chat_id, state, access_profile,
          oncall, agent_override_json, workspace_override_json, model_override_json, reasoning_override_json,
          role_policy_override_json, routing_override_json, access_override_json, group_tools_override_json,
          presentation_override_json, review_reasons_json, created_at, updated_at
        ) VALUES (
          ?, 2, 1, ?, 'chat_clean', 'enabled', 'managed_group', 0,
          '{"mode":"inherit"}', '{"mode":"inherit"}', '{"mode":"inherit"}', '{"mode":"inherit"}',
          '{"mode":"inherit"}', '{"groupReplyMode":{"mode":"inherit"},"mentionPolicy":{"mode":"inherit"}}',
          '{"mode":"inherit","principalIds":[]}', '{"read":"inherit","discover":"inherit","send":"inherit"}',
          '{"structuredAskCards":{"mode":"inherit"},"groupCardMention":{"mode":"inherit"},"pushIntervalMs":{"mode":"inherit"},"traceLimit":{"mode":"inherit"},"hideTraceOnComplete":{"mode":"inherit"},"completionReactionOnly":{"mode":"inherit"},"silentProgress":{"mode":"inherit"}}', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `).run(bindingId, botId);

      // 4. Roles:
      // - Role 1: App admin (group_binding_id = NULL, expires_at = NULL)
      // - Role 2: Group talker with expiry (group_binding_id = bindingId, expires_at = ISO timestamp)
      db.prepare(`
        INSERT INTO role_assignments (
          id, schema_version, revision, channel_bot_id, group_binding_id, scope_key,
          principal_id, role, operate_scope, action_gates_json, state, expires_at, created_at, updated_at
        ) VALUES (
          'role_app_admin', 1, 1, ?, NULL, 'bot',
          'principal_admin', 'admin', 'none',
          '{"terminalWrite":false,"highRisk":false,"groupToolsSend":false}',
          'active', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `).run(botId);

      db.prepare(`
        INSERT INTO role_assignments (
          id, schema_version, revision, channel_bot_id, group_binding_id, scope_key,
          principal_id, role, operate_scope, action_gates_json, state, expires_at, created_at, updated_at
        ) VALUES (
          'role_group_talker', 1, 1, ?, ?, 'binding:binding_clean',
          'principal_talker', 'can_talk', 'none',
          '{"terminalWrite":false,"highRisk":false,"groupToolsSend":false}',
          'active', '2026-12-31T23:59:59.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `).run(botId, bindingId);

      // 5. Confirmations:
      // - Confirmation 1: user_action, not revoked (revoked_at = NULL, revoked_reason = NULL)
      // - Confirmation 2: legacy_live, revoked (revoked_at = ISO timestamp, revoked_reason = text)
      const cleanScope = {
        version: 1 as const,
        channelBotId: botId,
        externalAppId: appId,
        brand: 'feishu' as const,
        entries: []
      };
      const scopeDigest = '1'.repeat(64);
      const legacyDigest = '2'.repeat(64);

      db.prepare(`
        INSERT INTO full_trust_confirmations (
          id, channel_bot_id, bot_revision, scope_digest, scope_json,
          source, confirmed_by_json, confirmed_at, legacy_source_digest, recorded_at, revoked_at, revoked_reason
        ) VALUES (
          'conf_user_active', ?, 1, ?, ?,
          'user_action', '{"kind":"installation_owner","principalId":"principal_installation_owner"}',
          '2026-01-01T00:00:00.000Z', NULL, NULL, NULL, NULL
        )
      `).run(botId, scopeDigest, JSON.stringify(cleanScope));

      db.prepare(`
        INSERT INTO full_trust_confirmations (
          id, channel_bot_id, bot_revision, scope_digest, scope_json,
          source, confirmed_by_json, confirmed_at, legacy_source_digest, recorded_at, revoked_at, revoked_reason
        ) VALUES (
          'conf_legacy_revoked', ?, 1, ?, ?,
          'legacy_live', NULL, NULL,
          ?, '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 'superseded'
        )
      `).run(botId, scopeDigest, JSON.stringify(cleanScope), legacyDigest);

      // 6. Read snapshot
      const snapshot = reader.read(botId);
      expect(snapshot).toBeDefined();

      // Check App admin role (NULL columns must NOT produce own undefined properties)
      const appAdmin = snapshot!.roles.find(r => r.id === 'role_app_admin')!;
      expect(appAdmin).toBeDefined();
      expect(Object.hasOwn(appAdmin, 'groupBindingId')).toBe(false);
      expect(Object.hasOwn(appAdmin, 'expiresAt')).toBe(false);

      // Check Group talker role (populated optional columns must produce own properties)
      const groupTalker = snapshot!.roles.find(r => r.id === 'role_group_talker')!;
      expect(groupTalker).toBeDefined();
      expect(Object.hasOwn(groupTalker, 'groupBindingId')).toBe(true);
      expect(groupTalker.groupBindingId).toBe(bindingId);
      expect(Object.hasOwn(groupTalker, 'expiresAt')).toBe(true);
      expect(groupTalker.expiresAt).toBe('2026-12-31T23:59:59.000Z');

      // Check active user_action confirmation (unrevoked: no revokedAt/revokedReason keys)
      const userConf = snapshot!.confirmations.find(c => c.id === 'conf_user_active')!;
      expect(userConf).toBeDefined();
      expect(Object.hasOwn(userConf, 'revokedAt')).toBe(false);
      expect(Object.hasOwn(userConf, 'revokedReason')).toBe(false);
      expect(Object.hasOwn(userConf, 'legacySourceDigest')).toBe(false);
      expect(Object.hasOwn(userConf, 'recordedAt')).toBe(false);

      // Check revoked legacy_live confirmation (nullable columns preserved as null, revoked fields present)
      const legacyConf = snapshot!.confirmations.find(c => c.id === 'conf_legacy_revoked')!;
      expect(legacyConf).toBeDefined();
      expect(Object.hasOwn(legacyConf, 'confirmedBy')).toBe(true);
      expect(legacyConf.confirmedBy).toBeNull();
      expect(Object.hasOwn(legacyConf, 'confirmedAt')).toBe(true);
      expect(legacyConf.confirmedAt).toBeNull();
      expect(Object.hasOwn(legacyConf, 'revokedAt')).toBe(true);
      expect(legacyConf.revokedAt).toBe('2026-02-01T00:00:00.000Z');
      expect(Object.hasOwn(legacyConf, 'revokedReason')).toBe(true);
      expect(legacyConf.revokedReason).toBe('superseded');

      // 7. Verify serializability with canonicalExecutionJson and computeSnapshotDigest without errors
      let canonicalStr: string = '';
      let digest: string = '';
      expect(() => {
        canonicalStr = canonicalSnapshotJson(snapshot!);
      }).not.toThrow();
      expect(typeof canonicalStr).toBe('string');
      expect(canonicalStr.length).toBeGreaterThan(0);

      expect(() => {
        digest = computeSnapshotDigest(snapshot!);
      }).not.toThrow();
      expect(typeof digest).toBe('string');
      expect(digest).toHaveLength(64);

      // 8. Write genuine version record and readVersion back
      const versionId = 'ver_clean';
      const opId = 'op_clean';
      db.prepare(`
        INSERT INTO configuration_operations (operation_id, action, actor_json, target_json, payload_digest, result_json, created_at)
        VALUES (?, 'create', '{}', NULL, ?, '{}', '2026-01-01T00:00:00.000Z')
      `).run(opId, 'e'.repeat(64));

      db.prepare(`
        INSERT INTO configuration_changes (sequence, bot_id, change_kind, revision, authorization_revision, connection_generation, timestamp)
        VALUES (100, ?, 'created', 1, 1, 1, '2026-01-01T00:00:00.000Z')
      `).run(botId);

      db.prepare(`
        INSERT INTO configuration_versions (
          version_id, bot_id, revision, change_sequence, change_kind, operation_id, created_at, snapshot_digest, snapshot_json
        ) VALUES (?, ?, 1, 100, 'created', ?, '2026-01-01T00:00:00.000Z', ?, ?)
      `).run(versionId, botId, opId, digest, JSON.stringify(snapshot));

      const versionRead = reader.readVersion(botId, versionId);
      expect(versionRead).toBeDefined();
      expect(versionRead!.snapshot).toEqual(snapshot);
      expect(computeSnapshotDigest(versionRead!.snapshot)).toBe(digest);

      // 9. Close and reopen verification
      db.close();
      const reopenedDb = new Database(path);
      try {
        const reopenedReader = createConfigurationReader(reopenedDb);
        const reopenedVersion = reopenedReader.readVersion(botId, versionId);
        expect(reopenedVersion).toBeDefined();
        expect(reopenedVersion!.snapshot).toEqual(snapshot);
        expect(computeSnapshotDigest(reopenedVersion!.snapshot)).toBe(digest);
      } finally {
        reopenedDb.close();
      }
    } finally {
      if (db.open) db.close();
    }
  });
});
