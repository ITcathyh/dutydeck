// Plain Node (no tsx/vitest) smoke test: load the built dist reader and read a
// real on-disk SQLite database created by the built dist migrator.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../dist/migrations.js';
import { createConfigurationReader, computeSnapshotDigest } from '../../dist/bot-configuration-reader.js';

const dir = mkdtempSync(join(tmpdir(), 'dutydeck-config-storage-smoke-'));
try {
  const dbPath = join(dir, 'smoke.db');
  const db = new Database(dbPath);
  runMigrations(db);

  const reader = createConfigurationReader(db);
  if (reader.authority() !== 'legacy') throw new Error('fresh database must be legacy configuration authority');

  // switch marker to v2 and insert a minimal valid V2 bot/policy directly
  db.prepare("UPDATE configuration_authority SET authority='v2', completed_at=? WHERE id=1")
    .run('2026-01-01T00:00:00.000Z');

  db.exec(`
    INSERT INTO channel_bots (
      id, schema_version, revision, authorization_revision, connection_generation,
      channel, external_app_id, display_name, platform_display_name, brand,
      credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at
    ) VALUES (
      'bot_smoke', 2, 1, 1, 1, 'lark', 'cli_smoke', 'Smoke Bot', NULL, 'feishu',
      NULL, 'staged', 'paused', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO channel_bot_policies (
      id, schema_version, revision, channel_bot_id, defaults_json, routing_defaults_json,
      access_policy_json, execution_json, presentation_json, group_tools_policy_json,
      created_at, updated_at
    ) VALUES (
      'pol_smoke', 2, 1, 'bot_smoke', '{}',
      '{"p2pMode":"chat","groupReplyMode":"runtime_default","mentionPolicy":"always"}',
      '{"humanTalk":{"p2p":{"mode":"owner_only"},"managedGroup":{"mode":"owner_only"},"newGroup":{"mode":"owner_only"}},"botTalk":{"p2p":{"mode":"allowlist","selectors":[],"peerEnabled":false},"managedGroup":{"mode":"allowlist","selectors":[],"peerEnabled":false},"newGroup":{"mode":"allowlist","selectors":[],"peerEnabled":false}},"defaultOperate":{"rules":[]},"p2pOperate":{"mode":"none"}}',
      '{"permissionMode":"ask","preInjectPrompt":null,"highRiskAccess":{"p2p":{"mode":"entry_authorized"},"managedGroup":{"mode":"entry_authorized"},"newGroup":{"mode":"entry_authorized"}},"riskControlMode":"off","highRiskPattern":".*"}',
      '{"webBaseUrl":null,"structuredAskCards":false,"groupCardMention":false,"pushIntervalMs":1000,"traceLimit":10,"hideTraceOnComplete":false}',
      '{"readCeiling":false,"discoverCeiling":false,"sendCeiling":false,"readDefault":false,"discoverDefault":false,"sendDefault":false}',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO role_assignments (
      id, schema_version, revision, channel_bot_id, group_binding_id, scope_key,
      principal_id, role, operate_scope, action_gates_json, state, expires_at, created_at, updated_at
    ) VALUES (
      'role_admin', 1, 1, 'bot_smoke', NULL, 'bot',
      'principal_admin', 'admin', 'none',
      '{"terminalWrite":false,"highRisk":false,"groupToolsSend":false}',
      'active', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
  `);

  const snapshot = reader.read('bot_smoke');
  if (!snapshot || snapshot.bot.id !== 'bot_smoke' || snapshot.policy.id !== 'pol_smoke') {
    throw new Error('dist reader failed to assemble the V2 snapshot');
  }
  if (snapshot.bot.authorizationRevision !== 1 || snapshot.bot.connectionGeneration !== 1) {
    throw new Error('dist reader returned wrong version columns');
  }
  if (snapshot.roles.length !== 1 || snapshot.roles[0].id !== 'role_admin') {
    throw new Error('dist reader failed to read role assignment');
  }
  if (Object.hasOwn(snapshot.roles[0], 'groupBindingId') || Object.hasOwn(snapshot.roles[0], 'expiresAt')) {
    throw new Error('optional null columns must not produce own undefined keys');
  }

  const digest = computeSnapshotDigest(snapshot);
  if (typeof digest !== 'string' || digest.length !== 64) {
    throw new Error('computeSnapshotDigest failed on snapshot with role');
  }

  const bots = reader.listBots();
  if (bots.length !== 1 || bots[0].id !== 'bot_smoke') throw new Error('dist listBots failed');

  console.log('SMOKE_OK', JSON.stringify({
    authority: reader.authority(),
    botId: snapshot.bot.id,
    policyId: snapshot.policy.id,
    bindings: snapshot.bindings.length,
    roles: snapshot.roles.length,
    listBots: bots.length
  }));
  db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
