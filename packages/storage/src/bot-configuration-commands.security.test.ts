import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  BotChangeRef,
  BotRelatedMutation,
  CreateBotV2,
  ManagementActor
} from '@dutydeck/shared';
import { createBotV2Schema, botRelatedMutationSchema } from '@dutydeck/shared';
import { runMigrations } from './migrations.js';
import { createConfigurationReader } from './bot-configuration-reader.js';
import { createConfigurationCommands } from './bot-configuration-commands.js';

const owner: ManagementActor = { kind: 'installation_owner', principalId: 'principal_installation_owner' };
const time = '2026-01-01T00:00:00.000Z';
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dutydeck-commands-sec-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'database.sqlite');
  let db = new Database(path);
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  db.prepare("UPDATE configuration_authority SET authority='v2' WHERE id=1").run();
  cleanup.push(() => { if (db.open) db.close(); });
  const reopen = () => { db.close(); db = new Database(path); db.pragma('foreign_keys=ON'); return db; };
  return { db, path, reopen };
}

function policyInput() {
  const human = { mode: 'owner_only' as const };
  const bots = { mode: 'allowlist' as const, selectors: [], peerEnabled: false };
  const risk = { mode: 'entry_authorized' as const };
  return {
    defaults: {},
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
      webBaseUrl: null, structuredAskCards: false, groupCardMention: false,
      pushIntervalMs: 1000, traceLimit: 10, hideTraceOnComplete: false, completionReactionOnly: false, silentProgress: false
    },
    groupToolsPolicy: {
      readCeiling: false, discoverCeiling: false, sendCeiling: false,
      readDefault: false, discoverDefault: false, sendDefault: false
    }
  };
}

function createBot(
  db: Database.Database,
  botId: string,
  appId: string,
  overrides: { secret?: { id: string; rev: number; provider: string; key: string; fp: string }; opId?: string } = {}
): BotChangeRef {
  const commands = createConfigurationCommands(db);
  const input = createBotV2Schema.parse({
    operationId: overrides.opId ?? `op_create_${botId}`,
    actor: owner,
    botId,
    externalAppId: appId,
    expectedAppState: 'absent',
    bot: { displayName: botId, brand: 'feishu' },
    policy: policyInput(),
    ...(overrides.secret ? { preparedCredential: {
      secretId: overrides.secret.id,
      expectedRevision: overrides.secret.rev,
      provider: overrides.secret.provider,
      referenceKey: overrides.secret.key,
      fingerprint: overrides.secret.fp
    } } : {})
  });
  commands.create(input);
  return { operationId: input.operationId, actor: owner, botId, expectedRevision: 1 };
}

function mut(value: Record<string, unknown>): BotRelatedMutation {
  return botRelatedMutationSchema.parse(value);
}

function addAdminRole(db: Database.Database, botId: string, principalId: string, groupBindingId?: string) {
  db.prepare(`
    INSERT INTO role_assignments (
      id, schema_version, revision, channel_bot_id, group_binding_id,
      scope_key, principal_id, role, operate_scope, action_gates_json,
      state, expires_at, created_at, updated_at
    ) VALUES (?, 1, 1, ?, ?, ?, ?, 'admin', 'none',
      '{"terminalWrite":false,"highRisk":false,"groupToolsSend":false}', 'active', NULL, ?, ?)
  `).run(`role_${principalId}_${groupBindingId ?? 'app'}`, botId, groupBindingId ?? null,
    groupBindingId ?? 'bot', principalId, time, time);
}

function createBindings(db: Database.Database, botId: string, rev: number, ids: string[]) {
  createConfigurationCommands(db).mutateRelated(
    { operationId: `op_init_b_${botId}`, actor: owner, botId, expectedRevision: rev },
    mut({ bindings: ids.map(id => ({
      kind: 'create', id, channelBotId: botId, expectedRevision: 0,
      binding: { externalChatId: `chat_${id}`, accessProfile: 'managed_group' }
    })) })
  );
}

describe('mutateRelated authorization boundaries', () => {
  it('rejects batch self-authorization: a new app role created in the batch cannot authorize later writes', () => {
    const { db } = fixture();
    createBot(db, 'bot_x', 'app_x');
    // Attacker principal has NO admin role beforehand.
    const attacker: ManagementActor = { kind: 'principal', principalId: 'principal_attacker', channelBotId: 'bot_x' };
    const commands = createConfigurationCommands(db);

    // Batch tries to grant itself an app admin role AND edit policy using that (not yet existing) role.
    const mutation = mut({
      policy: { expectedRevision: 1, patch: { defaults: { model: 'hijacked' } } },
      roles: [{
        kind: 'create', id: 'role_self_grant', channelBotId: 'bot_x', expectedRevision: 0,
        role: { principalId: 'principal_attacker', role: 'admin', operateScope: 'none' }
      }]
    });
    expect(() => commands.mutateRelated(
      { operationId: 'op_self_auth', actor: attacker, botId: 'bot_x', expectedRevision: 1 }, mutation
    )).toThrow(/CONFIGURATION_FORBIDDEN/);

    // Nothing was written
    const snap = createConfigurationReader(db).read('bot_x')!;
    expect(snap.roles).toHaveLength(0);
    expect(snap.policy.defaults.model).toBeUndefined();
  });

  it('rejects role update that reports a foreign channelBotId or a groupBindingId owned by another bot', () => {
    const { db } = fixture();
    createBot(db, 'bot_x', 'app_x');
    createBot(db, 'bot_y', 'app_y');
    createBindings(db, 'bot_x', 1, ['gx']);
    createBindings(db, 'bot_y', 1, ['gy']);
    const commands = createConfigurationCommands(db);

    // Create a group role on gx for a principal, as owner.
    commands.mutateRelated(
      { operationId: 'op_role_x', actor: owner, botId: 'bot_x', expectedRevision: 2 },
      mut({ roles: [{
        kind: 'create', id: 'role_gx', channelBotId: 'bot_x', expectedRevision: 0,
        role: { groupBindingId: 'gx', principalId: 'principal_gx', role: 'can_talk', operateScope: 'none' }
      }] })
    );

    // Attempt to update role_gx claiming it belongs to bot_y (request self-reported ownership ignored).
    expect(() => commands.mutateRelated(
      { operationId: 'op_cross_role', actor: owner, botId: 'bot_y', expectedRevision: 1 },
      mut({ roles: [{
        kind: 'update', id: 'role_gx', channelBotId: 'bot_y', expectedRevision: 1,
        patch: { state: 'revoked' }
      }] })
    )).toThrow(/CONFIGURATION_INVALID_TARGET/);

    // Attempt to create a role on bot_y referencing gx (owned by bot_x).
    expect(() => commands.mutateRelated(
      { operationId: 'op_cross_ref', actor: owner, botId: 'bot_y', expectedRevision: 1 },
      mut({ roles: [{
        kind: 'create', id: 'role_foreign_group', channelBotId: 'bot_y', expectedRevision: 0,
        role: { groupBindingId: 'gx', principalId: 'principal_p', role: 'can_talk', operateScope: 'none' }
      }] })
    )).toThrow(/CONFIGURATION_INVALID_TARGET/);
  });

  it('rejects binding update for a binding owned by another bot', () => {
    const { db } = fixture();
    createBot(db, 'bot_x', 'app_x');
    createBot(db, 'bot_y', 'app_y');
    createBindings(db, 'bot_x', 1, ['gx']);
    const commands = createConfigurationCommands(db);

    expect(() => commands.mutateRelated(
      { operationId: 'op_foreign_binding', actor: owner, botId: 'bot_y', expectedRevision: 1 },
      mut({ bindings: [{
        kind: 'update', id: 'gx', channelBotId: 'bot_y', expectedRevision: 1,
        patch: { oncall: true }
      }] })
    )).toThrow(/CONFIGURATION_INVALID_TARGET/);
  });

  it('multi-group scope requires admin on every target group; app admin always passes', () => {
    const { db } = fixture();
    createBot(db, 'bot_m', 'app_m');
    createBindings(db, 'bot_m', 1, ['g1', 'g2']);
    addAdminRole(db, 'bot_m', 'principal_g1', 'g1');
    addAdminRole(db, 'bot_m', 'principal_app');

    const g1Admin: ManagementActor = { kind: 'principal', principalId: 'principal_g1', channelBotId: 'bot_m' };
    const appAdmin: ManagementActor = { kind: 'principal', principalId: 'principal_app', channelBotId: 'bot_m' };
    const commands = createConfigurationCommands(db);

    // g1 admin cannot edit both g1 and g2
    expect(() => commands.mutateRelated(
      { operationId: 'op_multi_deny', actor: g1Admin, botId: 'bot_m', expectedRevision: 2 },
      mut({ bindings: [
        { kind: 'update', id: 'g1', channelBotId: 'bot_m', expectedRevision: 1, patch: { oncall: true } },
        { kind: 'update', id: 'g2', channelBotId: 'bot_m', expectedRevision: 1, patch: { oncall: true } }
      ] })
    )).toThrow(/CONFIGURATION_FORBIDDEN/);

    // g1 admin can edit g1 alone
    const ok = commands.mutateRelated(
      { operationId: 'op_multi_g1', actor: g1Admin, botId: 'bot_m', expectedRevision: 2 },
      mut({ bindings: [
        { kind: 'update', id: 'g1', channelBotId: 'bot_m', expectedRevision: 1, patch: { oncall: true } }
      ] })
    );
    expect(ok.bindings.find(b => b.id === 'g1')?.oncall).toBe(true);

    // app admin can edit g2 regardless of group-scoped roles
    const okApp = commands.mutateRelated(
      { operationId: 'op_multi_app', actor: appAdmin, botId: 'bot_m', expectedRevision: 3 },
      mut({ bindings: [
        { kind: 'update', id: 'g2', channelBotId: 'bot_m', expectedRevision: 1, patch: { oncall: true } }
      ] })
    );
    expect(okApp.bindings.find(b => b.id === 'g2')?.oncall).toBe(true);
  });

  it('group admin cannot create a new binding or mutate policy', () => {
    const { db } = fixture();
    createBot(db, 'bot_g', 'app_g');
    createBindings(db, 'bot_g', 1, ['g1']);
    addAdminRole(db, 'bot_g', 'principal_ga', 'g1');
    const ga: ManagementActor = { kind: 'principal', principalId: 'principal_ga', channelBotId: 'bot_g' };
    const commands = createConfigurationCommands(db);

    expect(() => commands.mutateRelated(
      { operationId: 'op_ga_newb', actor: ga, botId: 'bot_g', expectedRevision: 2 },
      mut({ bindings: [{
        kind: 'create', id: 'g_new', channelBotId: 'bot_g', expectedRevision: 0,
        binding: { externalChatId: 'chat_new', accessProfile: 'new_group' }
      }] })
    )).toThrow(/CONFIGURATION_FORBIDDEN/);

    expect(() => commands.mutateRelated(
      { operationId: 'op_ga_pol', actor: ga, botId: 'bot_g', expectedRevision: 2 },
      mut({ policy: { expectedRevision: 1, patch: { defaults: { model: 'x' } } } })
    )).toThrow(/CONFIGURATION_FORBIDDEN/);
  });
});

describe('shared secret protection', () => {
  it('a second bot cannot silently rebind a shared secret to different provider/key/fingerprint', () => {
    const { db } = fixture();
    // Shared secret already exists at revision 2.
    db.prepare(`
      INSERT INTO secret_refs (id, schema_version, revision, kind, provider, reference_key, status, created_at, updated_at)
      VALUES ('shared', 1, 2, 'lark_app_secret', 'vault', 'key_orig', 'configured', ?, ?)
    `).run(time, time);

    createBot(db, 'bot_a', 'app_a', { secret: { id: 'shared', rev: 2, provider: 'vault', key: 'key_orig', fp: 'a'.repeat(64) } });

    // Record a real identity fact for bot_a bound to the shared secret with fingerprint A.
    db.prepare(`
      INSERT INTO remote_identity_facts (
        id, schema_version, revision, channel_bot_id, credential_ref_id, credential_revision,
        credential_fingerprint, app_fingerprint, bot_identity_ref, app_id_match,
        checked_at, expires_at, created_at, updated_at
      ) VALUES ('idf_a', 1, 1, 'bot_a', 'shared', 2, ?, ?, 'remote_bot_a', 1, ?, '2099-01-01T00:00:00.000Z', ?, ?)
    `).run('a'.repeat(64), 'f'.repeat(64), time, time, time);

    const commands = createConfigurationCommands(db);
    // bot_b tries to claim the same secretId with different provider/key at the same revision.
    expect(() => createBot(db, 'bot_b', 'app_b', {
      secret: { id: 'shared', rev: 2, provider: 'file', key: 'key_stolen', fp: 'b'.repeat(64) },
      opId: 'op_create_b_bad'
    })).toThrow(/CONFIGURATION_CONFLICT/);

    // bot_b cannot claim a different fingerprint than the fact already recorded for this secret.
    expect(() => createBot(db, 'bot_b', 'app_b', {
      secret: { id: 'shared', rev: 2, provider: 'vault', key: 'key_orig', fp: 'c'.repeat(64) },
      opId: 'op_create_b_fp'
    })).toThrow(/CONFIGURATION_CONFLICT/);

    // The shared row is untouched and bot_b was not created.
    const row = db.prepare('SELECT revision, provider, reference_key, status FROM secret_refs WHERE id = ?').get('shared') as {
      revision: number; provider: string; reference_key: string; status: string;
    };
    expect(row).toEqual({ revision: 2, provider: 'vault', reference_key: 'key_orig', status: 'configured' });
    expect(createConfigurationReader(db).readByApp('app_b')).toBeUndefined();

    // bot_b CAN legitimately reference the same shared secret with identical metadata and fingerprint.
    createBot(db, 'bot_b', 'app_b', {
      secret: { id: 'shared', rev: 2, provider: 'vault', key: 'key_orig', fp: 'a'.repeat(64) },
      opId: 'op_create_b_ok'
    });
    const okSnap = createConfigurationReader(db).read('bot_b')!;
    expect(okSnap.credential?.revision).toBe(2);
  });
});

describe('fact invalidation preserves source proof', () => {
  it('brand/app change marks existing facts invalid, bumps their revisions, and keeps identity/credential proof', () => {
    const { db } = fixture();
    createBot(db, 'bot_p', 'app_p', { secret: { id: 'sec_p', rev: 0, provider: 'file', key: 'k', fp: 'a'.repeat(64) } });

    db.prepare(`
      INSERT INTO remote_identity_facts (
        id, schema_version, revision, channel_bot_id, credential_ref_id, credential_revision,
        credential_fingerprint, app_fingerprint, bot_identity_ref, tenant_ref, app_id_match,
        checked_at, expires_at, created_at, updated_at
      ) VALUES ('idf', 1, 1, 'bot_p', 'sec_p', 1, ?, ?, 'remote_bot_p', 'remote_tenant_p', 1,
        ?, '2099-01-01T00:00:00.000Z', ?, ?)
    `).run('a'.repeat(64), 'f'.repeat(64), time, time, time);

    db.prepare(`
      INSERT INTO remote_chat_facts (
        id, schema_version, revision, channel_bot_id, external_chat_id,
        membership_state, chat_type, display_name, observed_at, last_success_at,
        credential_ref_id, credential_revision, credential_fingerprint,
        identity_fact_id, identity_revision, expires_at, created_at, updated_at
      ) VALUES ('cf', 1, 1, 'bot_p', 'chat_p', 'member', 'group', 'Original Group', ?, ?,
        'sec_p', 1, ?, 'idf', 1, '2099-01-01T00:00:00.000Z', ?, ?)
    `).run(time, time, 'a'.repeat(64), time, time);

    createConfigurationCommands(db).update(
      { operationId: 'op_brand', actor: owner, botId: 'bot_p', expectedRevision: 1 },
      { brand: 'lark' }
    );

    const chat = db.prepare('SELECT * FROM remote_chat_facts WHERE id = ?').get('cf') as Record<string, unknown>;
    expect(chat.revision).toBe(2);
    expect(chat.invalidated_at).not.toBeNull();
    expect(chat.error_code).toBe('REMOTE_APP_ID_CHANGED');
    // Source proof preserved
    expect(chat.membership_state).toBe('member');
    expect(chat.display_name).toBe('Original Group');
    expect(chat.credential_ref_id).toBe('sec_p');
    expect(chat.credential_revision).toBe(1);
    expect(chat.credential_fingerprint).toBe('a'.repeat(64));
    expect(chat.identity_fact_id).toBe('idf');
    expect(chat.identity_revision).toBe(1);
    expect(chat.last_success_at).toBe(time);

    const idf = db.prepare('SELECT * FROM remote_identity_facts WHERE id = ?').get('idf') as Record<string, unknown>;
    expect(idf.revision).toBe(2);
    expect(idf.error_code).toBe('REMOTE_APP_ID_CHANGED');
    expect(idf.credential_ref_id).toBe('sec_p');
    expect(idf.credential_fingerprint).toBe('a'.repeat(64));
    expect(idf.app_fingerprint).toBe('f'.repeat(64));
    expect(idf.bot_identity_ref).toBe('remote_bot_p');
    expect(idf.tenant_ref).toBe('remote_tenant_p');
  });

  it('a display-only patch does not invalidate facts', () => {
    const { db } = fixture();
    createBot(db, 'bot_d', 'app_d', { secret: { id: 'sec_d', rev: 0, provider: 'file', key: 'k', fp: 'a'.repeat(64) } });
    db.prepare(`
      INSERT INTO remote_chat_facts (
        id, schema_version, revision, channel_bot_id, external_chat_id,
        membership_state, chat_type, observed_at, expires_at, created_at, updated_at
      ) VALUES ('cfd', 1, 1, 'bot_d', 'chat_d', 'member', 'group', ?, '2099-01-01T00:00:00.000Z', ?, ?)
    `).run(time, time, time);

    createConfigurationCommands(db).update(
      { operationId: 'op_name_only', actor: owner, botId: 'bot_d', expectedRevision: 1 },
      { displayName: 'New Name' }
    );

    const chat = db.prepare('SELECT revision, invalidated_at, error_code FROM remote_chat_facts WHERE id = ?').get('cfd') as {
      revision: number; invalidated_at: string | null; error_code: string | null;
    };
    expect(chat.revision).toBe(1);
    expect(chat.invalidated_at).toBeNull();
    expect(chat.error_code).toBeNull();
  });
});

describe('per-method replay and payload conflict across reopen', () => {
  function setupBot(db: Database.Database) {
    createBot(db, 'bot_r', 'app_r');
  }

  it('update replay across reopen returns cached result with no duplicate history', () => {
    const f = fixture(); setupBot(f.db);
    const ref: BotChangeRef = { operationId: 'op_r_up', actor: owner, botId: 'bot_r', expectedRevision: 1 };
    const first = createConfigurationCommands(f.db).update(ref, { displayName: 'First' });

    const db2 = f.reopen();
    // Stale CAS must be ignored on replay
    const replay = createConfigurationCommands(db2).update({ ...ref, expectedRevision: 999 }, { displayName: 'First' });
    expect(replay).toEqual(first);
    const reader = createConfigurationReader(db2);
    expect(reader.listVersions('bot_r')).toHaveLength(2);
    expect(db2.prepare('SELECT count(*) c FROM configuration_operations').get()).toEqual({ c: 2 });
  });

  it('mutateRelated same-op replay is idempotent; changed patch conflicts', () => {
    const f = fixture(); setupBot(f.db);
    const commands = createConfigurationCommands(f.db);
    const ref: BotChangeRef = { operationId: 'op_r_mut', actor: owner, botId: 'bot_r', expectedRevision: 1 };
    const mutation = mut({ policy: { expectedRevision: 1, patch: { defaults: { model: 'm1' } } } });
    const first = commands.mutateRelated(ref, mutation);
    const replay = commands.mutateRelated({ ...ref, expectedRevision: 2 }, mutation);
    expect(replay).toEqual(first);

    expect(() => commands.mutateRelated(ref, mut({
      policy: { expectedRevision: 1, patch: { defaults: { model: 'm2' } } }
    }))).toThrow(/CONFIGURATION_OPERATION_CONFLICT/);
  });

  it('setReceiving / setEnabled / delete replay across reopen is idempotent and changed payload conflicts', () => {
    const f = fixture(); setupBot(f.db);
    const recvRef: BotChangeRef = { operationId: 'op_r_recv', actor: owner, botId: 'bot_r', expectedRevision: 1 };
    const firstRecv = createConfigurationCommands(f.db).setReceiving(recvRef, true);

    let db = f.reopen();
    expect(createConfigurationCommands(db).setReceiving({ ...recvRef, expectedRevision: 4242 }, true)).toEqual(firstRecv);
    expect(() => createConfigurationCommands(db).setReceiving(recvRef, false)).toThrow(/CONFIGURATION_OPERATION_CONFLICT/);

    const enRef: BotChangeRef = { operationId: 'op_r_en', actor: owner, botId: 'bot_r', expectedRevision: 2 };
    const firstEn = createConfigurationCommands(db).setEnabled(enRef, true);
    db = f.reopen();
    expect(createConfigurationCommands(db).setEnabled({ ...enRef, expectedRevision: 4242 }, true)).toEqual(firstEn);
    expect(() => createConfigurationCommands(db).setEnabled(enRef, false)).toThrow(/CONFIGURATION_OPERATION_CONFLICT/);

    const delRef: BotChangeRef = { operationId: 'op_r_del', actor: owner, botId: 'bot_r', expectedRevision: 3 };
    const firstDel = createConfigurationCommands(db).delete(delRef);
    db = f.reopen();
    expect(createConfigurationCommands(db).delete({ ...delRef, expectedRevision: 4242 })).toEqual(firstDel);

    const reader = createConfigurationReader(db);
    // created + receiving + enabled + deleted = 4 versions
    expect(reader.listVersions('bot_r')).toHaveLength(4);
    expect(db.prepare('SELECT count(*) c FROM configuration_operations').get()).toEqual({ c: 4 });
  });

  it('rejects replay after current admin role is revoked (revoked replay not honored)', () => {
    const { db } = fixture();
    createBot(db, 'bot_v', 'app_v');
    addAdminRole(db, 'bot_v', 'principal_v');
    const actor: ManagementActor = { kind: 'principal', principalId: 'principal_v', channelBotId: 'bot_v' };
    const commands = createConfigurationCommands(db);
    const ref: BotChangeRef = { operationId: 'op_v_up', actor, botId: 'bot_v', expectedRevision: 1 };
    commands.update(ref, { displayName: 'Allowed' });

    // Revoke the admin role, then replay the same successful operation.
    db.prepare("UPDATE role_assignments SET state='revoked' WHERE principal_id='principal_v'").run();
    expect(() => commands.update(ref, { displayName: 'Allowed' })).toThrow(/CONFIGURATION_FORBIDDEN/);
  });
});

describe('revision safety and no-op audit', () => {
  it('uses nextConfigurationRevision and rolls back when an entity revision is at the safe integer ceiling', () => {
    const { db } = fixture();
    createBot(db, 'bot_max', 'app_max');
    // Force the policy revision to the safe integer ceiling; a real mutation must fail atomically.
    db.prepare('UPDATE channel_bot_policies SET revision = ? WHERE channel_bot_id = ?')
      .run(Number.MAX_SAFE_INTEGER, 'bot_max');
    const commands = createConfigurationCommands(db);
    const bytes = db.serialize();
    expect(() => commands.mutateRelated(
      { operationId: 'op_max_pol', actor: owner, botId: 'bot_max', expectedRevision: 1 },
      { policy: { expectedRevision: Number.MAX_SAFE_INTEGER, patch: { defaults: { model: 'overflow' } } } }
    )).toThrow(/CONFIGURATION_REVISION_OVERFLOW/);
    expect(db.serialize().equals(bytes)).toBe(true);
  });

  it('rejects non-positive / non-integer expected revisions at the schema boundary', () => {
    const { db } = fixture();
    createBot(db, 'bot_bad_rev', 'app_bad');
    const commands = createConfigurationCommands(db);
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => commands.update(
        { operationId: `op_bad_${bad}`, actor: owner, botId: 'bot_bad_rev', expectedRevision: bad as number },
        { displayName: 'X' }
      )).toThrow();
    }
  });

  it('no-op mutations across all simple commands record an operation but no history/sequence/version bump', () => {
    const { db } = fixture();
    createBot(db, 'bot_noop', 'app_noop');
    const commands = createConfigurationCommands(db);

    // paused -> paused: no-op
    commands.setReceiving({ operationId: 'op_noop_recv', actor: owner, botId: 'bot_noop', expectedRevision: 1 }, false);
    // staged -> disabled: a real change (revision -> 2)
    commands.setEnabled({ operationId: 'op_real_disable', actor: owner, botId: 'bot_noop', expectedRevision: 1 }, false);
    // disabled -> disabled: no-op
    commands.setEnabled({ operationId: 'op_noop_en', actor: owner, botId: 'bot_noop', expectedRevision: 2 }, false);
    // Delete at revision 2: real delete (revision -> 3)
    commands.delete({ operationId: 'op_real_del', actor: owner, botId: 'bot_noop', expectedRevision: 2 });
    // Second delete with the post-delete revision is a no-op but still audited.
    const del2 = commands.delete({ operationId: 'op_noop_del', actor: owner, botId: 'bot_noop', expectedRevision: 3 });
    expect(del2.bot.revision).toBe(3);
    const reader = createConfigurationReader(db);
    // created + enabled_changed + deleted = 3 changes/versions; the two no-ops added no history.
    expect(reader.listChanges(0, 50).map(c => c.changeKind)).toEqual(['created', 'enabled_changed', 'deleted']);
    expect(reader.listVersions('bot_noop')).toHaveLength(3);
    // create + 5 commands = 6 operations
    expect(db.prepare('SELECT count(*) c FROM configuration_operations').get()).toEqual({ c: 6 });
  });
});

describe('deleted bot remains a tombstone', () => {
  it('ordinary edits, receiving and enable toggles on a deleted bot never resurrect it', () => {
    const { db } = fixture();
    createBot(db, 'bot_tomb', 'app_tomb');
    const commands = createConfigurationCommands(db);
    commands.delete({ operationId: 'op_tomb_del', actor: owner, botId: 'bot_tomb', expectedRevision: 1 });

    expect(() => commands.update(
      { operationId: 'op_tomb_up', actor: owner, botId: 'bot_tomb', expectedRevision: 2 },
      { displayName: 'Back' }
    )).toThrow(/CONFIGURATION_CONFLICT/);
    expect(() => commands.setReceiving(
      { operationId: 'op_tomb_recv', actor: owner, botId: 'bot_tomb', expectedRevision: 2 }, true
    )).toThrow(/CONFIGURATION_CONFLICT/);
    expect(() => commands.setEnabled(
      { operationId: 'op_tomb_en', actor: owner, botId: 'bot_tomb', expectedRevision: 2 }, true
    )).toThrow(/CONFIGURATION_CONFLICT/);
    expect(() => commands.mutateRelated(
      { operationId: 'op_tomb_mut', actor: owner, botId: 'bot_tomb', expectedRevision: 2 },
      { policy: { expectedRevision: 1, patch: { defaults: { model: 'z' } } } }
    )).toThrow(/CONFIGURATION_CONFLICT/);

    const snap = createConfigurationReader(db).read('bot_tomb')!;
    expect(snap.bot.state).toBe('deleted');
    expect(snap.bot.displayName).toBe('bot_tomb');
  });
});
