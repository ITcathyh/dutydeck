import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RuntimeError,
  createBotV2Schema,
  botRelatedMutationSchema,
  type CreateBotV2,
  type BotChangeRef,
  type BotConfigPatchV2,
  type BotRelatedMutation,
  type ManagementActor
} from '@dutydeck/shared';
import { runMigrations } from './migrations.js';
import { createConfigurationReader } from './bot-configuration-reader.js';
import { createConfigurationCommands } from './bot-configuration-commands.js';

const owner: ManagementActor = { kind: 'installation_owner', principalId: 'principal_installation_owner' };
const adminActor: ManagementActor = { kind: 'principal', principalId: 'principal_admin', channelBotId: 'bot_test' };
const time = '2026-01-01T00:00:00.000Z';
const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dutydeck-commands-test-'));
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
      hideTraceOnComplete: false
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

function sampleCreateInput(overrides: Record<string, unknown> = {}): CreateBotV2 {
  return createBotV2Schema.parse({
    operationId: 'op_create_1',
    actor: owner,
    botId: 'bot_test',
    externalAppId: 'app_test_1',
    expectedAppState: 'absent',
    bot: {
      displayName: 'Test Bot',
      brand: 'feishu',
      platformDisplayName: 'Platform Test',
      state: 'staged',
      desiredListenerState: 'paused'
    },
    policy: samplePolicyInput(),
    ...overrides
  });
}

// Apply the command input schema (and its defaults) so test literals use the
// same parsed output types the public methods accept.
function mut(value: Record<string, unknown>): BotRelatedMutation {
  return botRelatedMutationSchema.parse(value);
}

function addAdminRole(db: Database.Database, botId: string, principalId: string, groupBindingId?: string, state: 'active' | 'revoked' = 'active') {
  db.prepare(`
    INSERT INTO role_assignments (
      id, schema_version, revision, channel_bot_id, group_binding_id,
      scope_key, principal_id, role, operate_scope, action_gates_json,
      state, expires_at, created_at, updated_at
    ) VALUES (
      ?, 1, 1, ?, ?,
      ?, ?, 'admin', 'none', '{"terminalWrite":false,"highRisk":false,"groupToolsSend":false}',
      ?, NULL, ?, ?
    )
  `).run(
    `role_${principalId}_${groupBindingId ?? 'app'}`,
    botId,
    groupBindingId ?? null,
    groupBindingId ?? 'bot',
    principalId,
    state,
    time,
    time
  );
}

describe('bot-configuration-commands: create', () => {
  it('creates a new bot and policy with initial revisions = 1, staged and paused, and creates new secret', () => {
    const { db } = fixture();
    const commands = createConfigurationCommands(db);

    const input = sampleCreateInput({
      preparedCredential: {
        secretId: 'sec_1',
        expectedRevision: 0,
        provider: 'file',
        referenceKey: 'ref_key_1',
        fingerprint: 'a'.repeat(64)
      }
    });

    const snapshot = commands.create(input);
    expect(snapshot.bot.id).toBe('bot_test');
    expect(snapshot.bot.revision).toBe(1);
    expect(snapshot.bot.authorizationRevision).toBe(1);
    expect(snapshot.bot.connectionGeneration).toBe(1);
    expect(snapshot.bot.state).toBe('staged');
    expect(snapshot.bot.desiredListenerState).toBe('paused');
    expect(snapshot.bot.credentialRef).toBe('sec_1');
    expect(snapshot.credential?.id).toBe('sec_1');
    expect(snapshot.credential?.revision).toBe(1);
    expect(snapshot.credential?.status).toBe('configured');
    expect(snapshot.policy.revision).toBe(1);

    const reader = createConfigurationReader(db);
    const versions = reader.listVersions('bot_test');
    expect(versions).toHaveLength(1);
    expect(versions[0]?.changeKind).toBe('created');
    expect(versions[0]?.revision).toBe(1);
    expect(reader.readVersion('bot_test', versions[0]!.versionId)?.snapshot).toEqual(snapshot);

    const changes = reader.listChanges(0, 10);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.changeKind).toBe('created');
    expect(changes[0]?.sequence).toBe(1);
  });

  it('reopens the database and replays identical create operationId without duplicate writes', () => {
    const f = fixture();
    const commands1 = createConfigurationCommands(f.db);
    const input = sampleCreateInput();
    const first = commands1.create(input);

    const db2 = f.reopen();
    const commands2 = createConfigurationCommands(db2);
    const replayed = commands2.create(input);
    expect(replayed).toEqual(first);

    const reader = createConfigurationReader(db2);
    expect(reader.listVersions('bot_test')).toHaveLength(1);
    expect(reader.listChanges(0, 10)).toHaveLength(1);
    expect(db2.prepare('SELECT count(*) as count FROM configuration_operations').get()).toEqual({ count: 1 });
  });

  it('rejects create operationId replay with conflicting payload', () => {
    const { db } = fixture();
    const commands = createConfigurationCommands(db);
    const input = sampleCreateInput();
    commands.create(input);

    const conflicting = { ...input, bot: { ...input.bot, displayName: 'Conflict Name' } };
    expect(() => commands.create(conflicting)).toThrow(/CONFIGURATION_OPERATION_CONFLICT/);
  });

  it('creates bot referencing existing secret with positive revision', () => {
    const { db } = fixture();
    db.prepare(`
      INSERT INTO secret_refs (
        id, schema_version, revision, kind, provider, reference_key, status, created_at, updated_at
      ) VALUES ('shared_sec', 1, 3, 'lark_app_secret', 'vault', 'vault_ref', 'configured', ?, ?)
    `).run(time, time);

    const commands = createConfigurationCommands(db);
    const input = sampleCreateInput({
      preparedCredential: {
        secretId: 'shared_sec',
        expectedRevision: 3,
        provider: 'vault',
        referenceKey: 'vault_ref',
        fingerprint: 'b'.repeat(64)
      }
    });

    const snapshot = commands.create(input);
    expect(snapshot.bot.credentialRef).toBe('shared_sec');
    expect(snapshot.credential?.revision).toBe(3);

    // Existing secret row was NOT updated or deleted
    const secRow = db.prepare('SELECT * FROM secret_refs WHERE id = ?').get('shared_sec') as { revision: number };
    expect(secRow.revision).toBe(3);
  });

  it('rejects create with positive revision when secret does not exist or revision mismatches', () => {
    const { db } = fixture();
    const commands = createConfigurationCommands(db);

    expect(() =>
      commands.create(
        sampleCreateInput({
          preparedCredential: {
            secretId: 'non_existent_sec',
            expectedRevision: 1,
            provider: 'file',
            referenceKey: 'k',
            fingerprint: 'c'.repeat(64)
          }
        })
      )
    ).toThrow(/CONFIGURATION_NOT_FOUND/);

    db.prepare(`
      INSERT INTO secret_refs (
        id, schema_version, revision, kind, provider, reference_key, status, created_at, updated_at
      ) VALUES ('existing_sec', 1, 2, 'lark_app_secret', 'file', 'k', 'configured', ?, ?)
    `).run(time, time);

    expect(() =>
      commands.create(
        sampleCreateInput({
          preparedCredential: {
            secretId: 'existing_sec',
            expectedRevision: 1, // Mismatched revision
            provider: 'file',
            referenceKey: 'k',
            fingerprint: 'c'.repeat(64)
          }
        })
      )
    ).toThrow(/CONFIGURATION_REVISION_CONFLICT/);
  });

  it('rejects create with expectedRevision 0 when secret already exists', () => {
    const { db } = fixture();
    db.prepare(`
      INSERT INTO secret_refs (
        id, schema_version, revision, kind, provider, reference_key, status, created_at, updated_at
      ) VALUES ('already_exists_sec', 1, 1, 'lark_app_secret', 'file', 'k', 'configured', ?, ?)
    `).run(time, time);

    const commands = createConfigurationCommands(db);
    expect(() =>
      commands.create(
        sampleCreateInput({
          preparedCredential: {
            secretId: 'already_exists_sec',
            expectedRevision: 0,
            provider: 'file',
            referenceKey: 'k',
            fingerprint: 'd'.repeat(64)
          }
        })
      )
    ).toThrow(/CONFIGURATION_CONFLICT/);
  });

  it('rejects create when botId or externalAppId already exists (including tombstone)', () => {
    const { db } = fixture();
    const commands = createConfigurationCommands(db);
    commands.create(sampleCreateInput({ botId: 'bot_active', externalAppId: 'app_active', operationId: 'op_1' }));

    // Duplicate botId
    expect(() =>
      commands.create(sampleCreateInput({ botId: 'bot_active', externalAppId: 'app_other', operationId: 'op_2' }))
    ).toThrow(/CONFIGURATION_CONFLICT/);

    // Duplicate externalAppId
    expect(() =>
      commands.create(sampleCreateInput({ botId: 'bot_other', externalAppId: 'app_active', operationId: 'op_3' }))
    ).toThrow(/CONFIGURATION_CONFLICT/);

    // Now delete the bot (making it a tombstone)
    commands.delete({ operationId: 'op_del', actor: owner, botId: 'bot_active', expectedRevision: 1 });

    // Late creation with same botId must be rejected
    expect(() =>
      commands.create(sampleCreateInput({ botId: 'bot_active', externalAppId: 'app_fresh', operationId: 'op_4' }))
    ).toThrow(/CONFIGURATION_CONFLICT/);

    // Late creation with same externalAppId must be rejected
    expect(() =>
      commands.create(sampleCreateInput({ botId: 'bot_fresh', externalAppId: 'app_active', operationId: 'op_5' }))
    ).toThrow(/CONFIGURATION_CONFLICT/);
  });

  it('rejects create when actor is not installation_owner', () => {
    const { db } = fixture();
    const commands = createConfigurationCommands(db);
    expect(() =>
      commands.create(sampleCreateInput({ actor: adminActor }))
    ).toThrow(/CONFIGURATION_FORBIDDEN/);
  });
});

describe('bot-configuration-commands: update', () => {
  function seedBot(db: Database.Database, botId = 'bot_test', appId = 'app_test_1') {
    const commands = createConfigurationCommands(db);
    return commands.create(sampleCreateInput({ botId, externalAppId: appId, operationId: `seed_${botId}` }));
  }

  it('increments only composition revision on displayName and platformDisplayName change', () => {
    const { db } = fixture();
    seedBot(db);
    const commands = createConfigurationCommands(db);

    const ref: BotChangeRef = { operationId: 'op_up_1', actor: owner, botId: 'bot_test', expectedRevision: 1 };
    const patch: BotConfigPatchV2 = { displayName: 'New Display Name', platformDisplayName: 'New Platform' };
    const updated = commands.update(ref, patch);

    expect(updated.bot.revision).toBe(2);
    expect(updated.bot.authorizationRevision).toBe(1);
    expect(updated.bot.connectionGeneration).toBe(1);
    expect(updated.bot.displayName).toBe('New Display Name');
    expect(updated.bot.platformDisplayName).toBe('New Platform');

    const reader = createConfigurationReader(db);
    const versions = reader.listVersions('bot_test');
    expect(versions).toHaveLength(2);
    expect(versions[0]?.changeKind).toBe('updated');
    expect(versions[0]?.revision).toBe(2);
  });

  it('allows clearing platformDisplayName by explicitly setting null', () => {
    const { db } = fixture();
    seedBot(db);
    const commands = createConfigurationCommands(db);

    const ref: BotChangeRef = { operationId: 'op_up_null', actor: owner, botId: 'bot_test', expectedRevision: 1 };
    const patch: BotConfigPatchV2 = { platformDisplayName: null };
    const updated = commands.update(ref, patch);

    expect(updated.bot.revision).toBe(2);
    expect(updated.bot.platformDisplayName).toBeNull();
  });

  it('increments all three versions on externalAppId / brand change and invalidates facts', () => {
    const { db } = fixture();
    // Create with a credential so identity facts can reference it
    const commands0 = createConfigurationCommands(db);
    commands0.create(sampleCreateInput({
      preparedCredential: {
        secretId: 'sec_1', expectedRevision: 0, provider: 'file', referenceKey: 'ref1', fingerprint: 'a'.repeat(64)
      }
    }));

    // Seed a remote_chat_fact and remote_identity_fact
    db.prepare(`
      INSERT INTO remote_chat_facts (
        id, schema_version, revision, channel_bot_id, external_chat_id,
        membership_state, chat_type, observed_at, expires_at, created_at, updated_at
      ) VALUES ('chat_fact_1', 1, 1, 'bot_test', 'chat_1', 'member', 'group', ?, '2099-01-01T00:00:00.000Z', ?, ?)
    `).run(time, time, time);

    db.prepare(`
      INSERT INTO remote_identity_facts (
        id, schema_version, revision, channel_bot_id, credential_ref_id, credential_revision,
        credential_fingerprint, app_fingerprint, bot_identity_ref, app_id_match, checked_at, expires_at, created_at, updated_at
      ) VALUES (
        'id_fact_1', 1, 1, 'bot_test', 'sec_1', 1,
        '${'a'.repeat(64)}', '${'a'.repeat(64)}', 'remote_bot_1', 1, ?, '2099-01-01T00:00:00.000Z', ?, ?
      )
    `).run(time, time, time);

    const commands = createConfigurationCommands(db);
    const ref: BotChangeRef = { operationId: 'op_up_app', actor: owner, botId: 'bot_test', expectedRevision: 1 };
    const patch: BotConfigPatchV2 = { externalAppId: 'app_renamed', brand: 'lark' };
    const updated = commands.update(ref, patch);

    expect(updated.bot.revision).toBe(2);
    expect(updated.bot.authorizationRevision).toBe(2);
    expect(updated.bot.connectionGeneration).toBe(2);
    expect(updated.bot.externalAppId).toBe('app_renamed');
    expect(updated.bot.brand).toBe('lark');

    // Verify facts were invalidated
    const chatFact = db.prepare('SELECT * FROM remote_chat_facts WHERE id = ?').get('chat_fact_1') as {
      revision: number;
      invalidated_at: string | null;
      error_code: string | null;
    };
    expect(chatFact.revision).toBe(2);
    expect(chatFact.invalidated_at).not.toBeNull();
    expect(chatFact.error_code).toBe('REMOTE_APP_ID_CHANGED');

    const idFact = db.prepare('SELECT * FROM remote_identity_facts WHERE id = ?').get('id_fact_1') as {
      revision: number;
      error_code: string | null;
    };
    expect(idFact.revision).toBe(2);
    expect(idFact.error_code).toBe('REMOTE_APP_ID_CHANGED');
  });

  it('rejects externalAppId collision with another bot and rolls back', () => {
    const { db } = fixture();
    seedBot(db, 'bot_1', 'app_1');
    seedBot(db, 'bot_2', 'app_2');

    const commands = createConfigurationCommands(db);
    const ref: BotChangeRef = { operationId: 'op_collision', actor: owner, botId: 'bot_2', expectedRevision: 1 };
    const patch: BotConfigPatchV2 = { externalAppId: 'app_1' };

    expect(() => commands.update(ref, patch)).toThrow(/CONFIGURATION_CONFLICT/);

    const bot2 = createConfigurationReader(db).read('bot_2');
    expect(bot2?.bot.externalAppId).toBe('app_2');
    expect(bot2?.bot.revision).toBe(1);
  });

  it('records a no-op audit when update patch has identical values', () => {
    const { db } = fixture();
    seedBot(db);
    const commands = createConfigurationCommands(db);

    const ref: BotChangeRef = { operationId: 'op_noop_up', actor: owner, botId: 'bot_test', expectedRevision: 1 };
    const patch: BotConfigPatchV2 = { displayName: 'Test Bot' }; // same as initial
    const result = commands.update(ref, patch);

    expect(result.bot.revision).toBe(1);
    const reader = createConfigurationReader(db);
    expect(reader.listVersions('bot_test')).toHaveLength(1); // only create version
    expect(reader.listChanges(0, 10)).toHaveLength(1); // only create change
    expect(db.prepare('SELECT count(*) as c FROM configuration_operations').get()).toEqual({ c: 2 });
  });

  it('rejects update on a deleted bot', () => {
    const { db } = fixture();
    seedBot(db);
    const commands = createConfigurationCommands(db);
    commands.delete({ operationId: 'op_del', actor: owner, botId: 'bot_test', expectedRevision: 1 });

    expect(() =>
      commands.update({ operationId: 'op_edit_del', actor: owner, botId: 'bot_test', expectedRevision: 2 }, { displayName: 'Revive' })
    ).toThrow(/CONFIGURATION_CONFLICT/);
  });

  it('rejects update when expectedRevision does not match current revision', () => {
    const { db } = fixture();
    seedBot(db);
    const commands = createConfigurationCommands(db);

    expect(() =>
      commands.update({ operationId: 'op_wrong_rev', actor: owner, botId: 'bot_test', expectedRevision: 99 }, { displayName: 'Wrong Rev' })
    ).toThrow(/CONFIGURATION_REVISION_CONFLICT/);
  });
});

describe('bot-configuration-commands: mutateRelated', () => {
  function seedBot(db: Database.Database, botId = 'bot_test') {
    const commands = createConfigurationCommands(db);
    return commands.create(sampleCreateInput({ botId, operationId: `seed_${botId}` }));
  }

  it('mutating policy defaults/execution increments revision and authorizationRevision', () => {
    const { db } = fixture();
    seedBot(db);
    const commands = createConfigurationCommands(db);

    const ref: BotChangeRef = { operationId: 'op_mut_pol', actor: owner, botId: 'bot_test', expectedRevision: 1 };
    const mutation = mut({
      policy: {
        expectedRevision: 1,
        patch: {
          defaults: { model: 'gpt-5' },
          execution: { riskControlMode: 'guidance' }
        }
      }
    });

    const updated = commands.mutateRelated(ref, mutation);
    expect(updated.bot.revision).toBe(2);
    expect(updated.bot.authorizationRevision).toBe(2);
    expect(updated.bot.connectionGeneration).toBe(1);
    expect(updated.policy.revision).toBe(2);
    expect(updated.policy.defaults.model).toBe('gpt-5');
    expect(updated.policy.execution.riskControlMode).toBe('guidance');
  });

  it('pure presentation mutation increments only composition revision', () => {
    const { db } = fixture();
    seedBot(db);
    const commands = createConfigurationCommands(db);

    const ref: BotChangeRef = { operationId: 'op_mut_pres', actor: owner, botId: 'bot_test', expectedRevision: 1 };
    const mutation = mut({
      policy: {
        expectedRevision: 1,
        patch: {
          presentation: { pushIntervalMs: 5000 }
        }
      }
    });

    const updated = commands.mutateRelated(ref, mutation);
    expect(updated.bot.revision).toBe(2);
    expect(updated.bot.authorizationRevision).toBe(1);
    expect(updated.bot.connectionGeneration).toBe(1);
    expect(updated.policy.revision).toBe(2);
    expect(updated.policy.presentation.pushIntervalMs).toBe(5000);
  });

  it('creates and updates bindings and roles in a single batch', () => {
    const { db } = fixture();
    seedBot(db);
    const commands = createConfigurationCommands(db);

    const ref: BotChangeRef = { operationId: 'op_mut_batch', actor: owner, botId: 'bot_test', expectedRevision: 1 };
    const mutation = mut({
      bindings: [
        {
          kind: 'create',
          id: 'binding_group_1',
          channelBotId: 'bot_test',
          expectedRevision: 0,
          binding: {
            externalChatId: 'chat_group_1',
            accessProfile: 'managed_group'
          }
        }
      ],
      roles: [
        {
          kind: 'create',
          id: 'role_group_1_talk',
          channelBotId: 'bot_test',
          expectedRevision: 0,
          role: {
            groupBindingId: 'binding_group_1',
            principalId: 'principal_alice',
            role: 'can_talk',
            operateScope: 'none'
          }
        }
      ]
    });

    const updated = commands.mutateRelated(ref, mutation);
    expect(updated.bot.revision).toBe(2);
    expect(updated.bot.authorizationRevision).toBe(2);
    expect(updated.bindings).toHaveLength(1);
    expect(updated.bindings[0]?.id).toBe('binding_group_1');
    expect(updated.bindings[0]?.revision).toBe(1);
    expect(updated.roles).toHaveLength(1);
    expect(updated.roles[0]?.id).toBe('role_group_1_talk');
    expect(updated.roles[0]?.revision).toBe(1);

    // Now update them in a second batch
    const ref2: BotChangeRef = { operationId: 'op_mut_batch_2', actor: owner, botId: 'bot_test', expectedRevision: 2 };
    const mutation2 = mut({
      bindings: [
        {
          kind: 'update',
          id: 'binding_group_1',
          channelBotId: 'bot_test',
          expectedRevision: 1,
          patch: { oncall: true }
        }
      ],
      roles: [
        {
          kind: 'update',
          id: 'role_group_1_talk',
          channelBotId: 'bot_test',
          expectedRevision: 1,
          patch: { state: 'revoked' }
        }
      ]
    });

    const updated2 = commands.mutateRelated(ref2, mutation2);
    expect(updated2.bot.revision).toBe(3);
    expect(updated2.bot.authorizationRevision).toBe(3);
    expect(updated2.bindings[0]?.revision).toBe(2);
    expect(updated2.bindings[0]?.oncall).toBe(true);
    expect(updated2.roles[0]?.revision).toBe(2);
    expect(updated2.roles[0]?.state).toBe('revoked');
  });

  it('allows group admin to edit their own group binding and group role', () => {
    const { db } = fixture();
    seedBot(db);
    const commands = createConfigurationCommands(db);

    // Owner creates binding_a and binding_b
    commands.mutateRelated(
      { operationId: 'op_init_bindings', actor: owner, botId: 'bot_test', expectedRevision: 1 },
      mut({
        bindings: [
          { kind: 'create', id: 'binding_a', channelBotId: 'bot_test', expectedRevision: 0, binding: { externalChatId: 'chat_a', accessProfile: 'managed_group' } },
          { kind: 'create', id: 'binding_b', channelBotId: 'bot_test', expectedRevision: 0, binding: { externalChatId: 'chat_b', accessProfile: 'managed_group' } }
        ]
      })
    );

    // Grant principal_group_a_admin admin role on binding_a
    addAdminRole(db, 'bot_test', 'principal_group_a_admin', 'binding_a');

    const groupAdminActor: ManagementActor = { kind: 'principal', principalId: 'principal_group_a_admin', channelBotId: 'bot_test' };

    // Group admin of binding_a can update binding_a
    const result = commands.mutateRelated(
      { operationId: 'op_grp_admin_success', actor: groupAdminActor, botId: 'bot_test', expectedRevision: 2 },
      {
        bindings: [
          { kind: 'update', id: 'binding_a', channelBotId: 'bot_test', expectedRevision: 1, patch: { oncall: true } }
        ]
      }
    );
    expect(result.bindings.find(b => b.id === 'binding_a')?.oncall).toBe(true);

    // Group admin of binding_a CANNOT update binding_b
    expect(() =>
      commands.mutateRelated(
        { operationId: 'op_grp_admin_fail_b', actor: groupAdminActor, botId: 'bot_test', expectedRevision: 3 },
        {
          bindings: [
            { kind: 'update', id: 'binding_b', channelBotId: 'bot_test', expectedRevision: 1, patch: { oncall: true } }
          ]
        }
      )
    ).toThrow(/CONFIGURATION_FORBIDDEN/);

    // Group admin CANNOT mutate policy
    expect(() =>
      commands.mutateRelated(
        { operationId: 'op_grp_admin_fail_pol', actor: groupAdminActor, botId: 'bot_test', expectedRevision: 3 },
        {
          policy: { expectedRevision: 1, patch: { defaults: { model: 'new-model' } } }
        }
      )
    ).toThrow(/CONFIGURATION_FORBIDDEN/);

    // Group admin CANNOT create an App-level role
    expect(() =>
      commands.mutateRelated(
        { operationId: 'op_grp_admin_fail_app_role', actor: groupAdminActor, botId: 'bot_test', expectedRevision: 3 },
        mut({
          roles: [
            {
              kind: 'create',
              id: 'role_app_admin_attempt',
              channelBotId: 'bot_test',
              expectedRevision: 0,
              role: { principalId: 'principal_hacker', role: 'admin', operateScope: 'none' }
            }
          ]
        })
      )
    ).toThrow(/CONFIGURATION_FORBIDDEN/);
  });

  it('rejects duplicate binding or role ID in the same batch', () => {
    const { db } = fixture();
    seedBot(db);
    const commands = createConfigurationCommands(db);

    expect(() =>
      commands.mutateRelated(
        { operationId: 'op_dup_binding', actor: owner, botId: 'bot_test', expectedRevision: 1 },
        mut({
          bindings: [
            { kind: 'create', id: 'binding_dup', channelBotId: 'bot_test', expectedRevision: 0, binding: { externalChatId: 'chat_1', accessProfile: 'managed_group' } },
            { kind: 'create', id: 'binding_dup', channelBotId: 'bot_test', expectedRevision: 0, binding: { externalChatId: 'chat_2', accessProfile: 'managed_group' } }
          ]
        })
      )
    ).toThrow(/CONFIGURATION_DUPLICATE_TARGET/);

    expect(() =>
      commands.mutateRelated(
        { operationId: 'op_dup_role', actor: owner, botId: 'bot_test', expectedRevision: 1 },
        mut({
          roles: [
            { kind: 'create', id: 'role_dup', channelBotId: 'bot_test', expectedRevision: 0, role: { principalId: 'principal_a', role: 'can_talk', operateScope: 'none' } },
            { kind: 'create', id: 'role_dup', channelBotId: 'bot_test', expectedRevision: 0, role: { principalId: 'principal_b', role: 'can_talk', operateScope: 'none' } }
          ]
        })
      )
    ).toThrow(/CONFIGURATION_DUPLICATE_TARGET/);
  });

  it('records a no-op audit when mutation results in zero changes', () => {
    const { db } = fixture();
    seedBot(db);
    const commands = createConfigurationCommands(db);

    const result = commands.mutateRelated(
      { operationId: 'op_noop_mut', actor: owner, botId: 'bot_test', expectedRevision: 1 },
      {
        policy: {
          expectedRevision: 1,
          patch: { defaults: { model: 'test-model' } } // already test-model
        }
      }
    );

    expect(result.bot.revision).toBe(1);
    expect(result.policy.revision).toBe(1);
    const reader = createConfigurationReader(db);
    expect(reader.listVersions('bot_test')).toHaveLength(1);
    expect(db.prepare('SELECT count(*) as c FROM configuration_operations').get()).toEqual({ c: 2 });
  });
});

describe('bot-configuration-commands: setReceiving & setEnabled', () => {
  function seedBot(db: Database.Database, botId = 'bot_test') {
    const commands = createConfigurationCommands(db);
    return commands.create(sampleCreateInput({ botId, operationId: `seed_${botId}` }));
  }

  it('setReceiving toggles desiredListenerState and bumps revision and connectionGeneration', () => {
    const { db } = fixture();
    seedBot(db);
    const commands = createConfigurationCommands(db);

    const ref: BotChangeRef = { operationId: 'op_rec_on', actor: owner, botId: 'bot_test', expectedRevision: 1 };
    const r1 = commands.setReceiving(ref, true);
    expect(r1.bot.revision).toBe(2);
    expect(r1.bot.authorizationRevision).toBe(1);
    expect(r1.bot.connectionGeneration).toBe(2);
    expect(r1.bot.desiredListenerState).toBe('receiving');

    // Toggle back to paused
    const r2 = commands.setReceiving({ operationId: 'op_rec_off', actor: owner, botId: 'bot_test', expectedRevision: 2 }, false);
    expect(r2.bot.revision).toBe(3);
    expect(r2.bot.authorizationRevision).toBe(1);
    expect(r2.bot.connectionGeneration).toBe(3);
    expect(r2.bot.desiredListenerState).toBe('paused');

    // No-op setReceiving
    const r3 = commands.setReceiving({ operationId: 'op_rec_noop', actor: owner, botId: 'bot_test', expectedRevision: 3 }, false);
    expect(r3.bot.revision).toBe(3);
  });

  it('setEnabled enables bot (bumping all 3 versions) and disabling revokes receiving intent', () => {
    const { db } = fixture();
    seedBot(db);
    const commands = createConfigurationCommands(db);

    // Turn on receiving first
    commands.setReceiving({ operationId: 'op_rec_on', actor: owner, botId: 'bot_test', expectedRevision: 1 }, true);

    // Enable bot
    const e1 = commands.setEnabled({ operationId: 'op_enable', actor: owner, botId: 'bot_test', expectedRevision: 2 }, true);
    expect(e1.bot.revision).toBe(3);
    expect(e1.bot.authorizationRevision).toBe(2);
    expect(e1.bot.connectionGeneration).toBe(3);
    expect(e1.bot.state).toBe('enabled');
    expect(e1.bot.desiredListenerState).toBe('receiving');

    // Disable bot: should reset desiredListenerState to 'paused' and bump all 3 versions
    const e2 = commands.setEnabled({ operationId: 'op_disable', actor: owner, botId: 'bot_test', expectedRevision: 3 }, false);
    expect(e2.bot.revision).toBe(4);
    expect(e2.bot.authorizationRevision).toBe(3);
    expect(e2.bot.connectionGeneration).toBe(4);
    expect(e2.bot.state).toBe('disabled');
    expect(e2.bot.desiredListenerState).toBe('paused');

    // No-op disabling
    const e3 = commands.setEnabled({ operationId: 'op_disable_noop', actor: owner, botId: 'bot_test', expectedRevision: 4 }, false);
    expect(e3.bot.revision).toBe(4);
  });
});

describe('bot-configuration-commands: delete', () => {
  function seedBot(db: Database.Database, botId = 'bot_test') {
    const commands = createConfigurationCommands(db);
    return commands.create(
      sampleCreateInput({
        botId,
        operationId: `seed_${botId}`,
        preparedCredential: {
          secretId: 'sec_del_test',
          expectedRevision: 0,
          provider: 'file',
          referenceKey: 'ref_del',
          fingerprint: 'e'.repeat(64)
        }
      })
    );
  }

  it('deletes bot, marks state=deleted, desiredListenerState=paused, preserves credentialRef and facts, bumps 3 versions', () => {
    const { db } = fixture();
    seedBot(db);

    db.prepare(`
      INSERT INTO remote_chat_facts (
        id, schema_version, revision, channel_bot_id, external_chat_id,
        membership_state, chat_type, observed_at, expires_at, created_at, updated_at
      ) VALUES ('chat_del_1', 1, 1, 'bot_test', 'chat_del', 'member', 'group', ?, '2099-01-01T00:00:00.000Z', ?, ?)
    `).run(time, time, time);

    const commands = createConfigurationCommands(db);
    const ref: BotChangeRef = { operationId: 'op_delete_1', actor: owner, botId: 'bot_test', expectedRevision: 1 };
    const deleted = commands.delete(ref);

    expect(deleted.bot.state).toBe('deleted');
    expect(deleted.bot.desiredListenerState).toBe('paused');
    expect(deleted.bot.revision).toBe(2);
    expect(deleted.bot.authorizationRevision).toBe(2);
    expect(deleted.bot.connectionGeneration).toBe(2);
    expect(deleted.bot.credentialRef).toBe('sec_del_test');
    expect(deleted.credential?.id).toBe('sec_del_test');

    // Delete preserves identity/chat facts (only credential/app/brand changes invalidate them).
    const chatFact = db.prepare('SELECT revision, invalidated_at, error_code FROM remote_chat_facts WHERE id = ?').get('chat_del_1') as {
      revision: number;
      invalidated_at: string | null;
      error_code: string | null;
    };
    expect(chatFact.revision).toBe(1);
    expect(chatFact.invalidated_at).toBeNull();
    expect(chatFact.error_code).toBeNull();

    // Calling delete again is a no-op audit
    const reDel = commands.delete({ operationId: 'op_delete_noop', actor: owner, botId: 'bot_test', expectedRevision: 2 });
    expect(reDel.bot.revision).toBe(2);
  });
});

describe('bot-configuration-commands: triggers, rollback, and concurrency', () => {
  it('rolls back all table writes, operations, and sequence when a SQL trigger fails during version insert', () => {
    const { db } = fixture();
    const commands = createConfigurationCommands(db);
    commands.create(sampleCreateInput({ botId: 'bot_a', operationId: 'seed_bot' }));

    db.exec("CREATE TRIGGER fail_version BEFORE INSERT ON configuration_versions BEGIN SELECT RAISE(ABORT, 'version trigger aborted'); END;");

    expect(() =>
      commands.update(
        { operationId: 'op_trigger_fail', actor: owner, botId: 'bot_a', expectedRevision: 1 },
        { displayName: 'Trigger Should Fail' }
      )
    ).toThrow(/version trigger aborted/);

    // Bot revision must still be 1
    const reader = createConfigurationReader(db);
    const snapshot = reader.read('bot_a');
    expect(snapshot?.bot.revision).toBe(1);
    expect(snapshot?.bot.displayName).toBe('Test Bot');
    expect(reader.listVersions('bot_a')).toHaveLength(1);
    expect(db.prepare("SELECT count(*) as c FROM configuration_operations WHERE operation_id = 'op_trigger_fail'").get()).toEqual({ c: 0 });

    // After dropping trigger, update succeeds
    db.exec('DROP TRIGGER fail_version');
    const updated = commands.update(
      { operationId: 'op_trigger_succeed', actor: owner, botId: 'bot_a', expectedRevision: 1 },
      { displayName: 'Succeeded After Drop' }
    );
    expect(updated.bot.revision).toBe(2);
  });

  it('safely locks out concurrent write from a second process during transaction execution', () => {
    const { db, path } = fixture();
    const commands = createConfigurationCommands(db);
    commands.create(sampleCreateInput({ botId: 'bot_lock', operationId: 'seed_lock' }));
    addAdminRole(db, 'bot_lock', 'principal_admin');

    const modulePath = createRequire(import.meta.url).resolve('better-sqlite3');
    const workerScript = `
      const Database = require(process.argv[2]);
      const db = new Database(process.argv[1], { timeout: 50 });
      try {
        db.prepare("UPDATE role_assignments SET state='revoked' WHERE principal_id='principal_admin'").run();
        process.stdout.write('revoked');
      } catch(e) {
        process.stdout.write(e.code);
      } finally {
        db.close();
      }
    `;
    const attemptRevoke = () =>
      spawnSync(process.execPath, ['-e', workerScript, path, modulePath], { encoding: 'utf8', timeout: 10000 });

    // Within update execution, simulate an external process trying to write
    // Because runConfigurationCommand holds BEGIN IMMEDIATE, the other process gets SQLITE_BUSY!
    let checkedConcurrency = false;
    db.function('test_concurrency_check', () => {
      const other = attemptRevoke();
      expect(other.stdout).toBe('SQLITE_BUSY');
      checkedConcurrency = true;
      return 1;
    });

    // Create a temporary trigger to invoke test_concurrency_check during update
    db.exec(`
      CREATE TRIGGER check_lock BEFORE UPDATE ON channel_bots
      BEGIN
        SELECT test_concurrency_check();
      END;
    `);

    commands.update(
      { operationId: 'op_locked_update', actor: owner, botId: 'bot_lock', expectedRevision: 1 },
      { displayName: 'Concurrent Test' }
    );

    expect(checkedConcurrency).toBe(true);
    db.exec('DROP TRIGGER check_lock');

    // After transaction completes, external process can write
    const after = attemptRevoke();
    expect(after.stdout).toBe('revoked');
  });
});
