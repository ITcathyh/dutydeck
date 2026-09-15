import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RuntimeError,
  canonicalExecutionJson,
  createBotV2Schema,
  botRelatedMutationSchema,
  preparedBotConversionSchema,
  isFullTrustScopeCovered,
  type BotChangeRef,
  type BotRelatedMutation,
  type CreateBotV2,
  type ManagementActor
} from '@dutydeck/shared';
import { runMigrations } from './migrations.js';
import { createConfigurationReader } from './bot-configuration-reader.js';
import { createConfigurationCommands } from './bot-configuration-commands.js';

const owner: ManagementActor = { kind: 'installation_owner', principalId: 'principal_installation_owner' };
const time = '2026-01-01T00:00:00.000Z';
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dutydeck-commands-fix-'));
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
    defaults: { model: 'm1' },
    routingDefaults: { p2pMode: 'chat' as const, groupReplyMode: 'runtime_default' as const, mentionPolicy: 'always' as const },
    accessPolicy: {
      humanTalk: { p2p: human, managedGroup: human, newGroup: human },
      botTalk: { p2p: bots, managedGroup: bots, newGroup: bots },
      defaultOperate: { rules: [] }, p2pOperate: { mode: 'none' as const }
    },
    execution: {
      permissionMode: 'ask' as const, preInjectPrompt: null,
      highRiskAccess: { p2p: risk, managedGroup: risk, newGroup: risk },
      riskControlMode: 'off' as const, highRiskPattern: '.*'
    },
    presentation: {
      webBaseUrl: null, structuredAskCards: false, groupCardMention: false,
      pushIntervalMs: 1000, traceLimit: 10, hideTraceOnComplete: false
    },
    groupToolsPolicy: {
      readCeiling: false, discoverCeiling: false, sendCeiling: false,
      readDefault: false, discoverDefault: false, sendDefault: false
    }
  };
}

function createInput(overrides: Record<string, unknown> = {}): CreateBotV2 {
  return createBotV2Schema.parse({
    operationId: 'op_create', actor: owner, botId: 'bot_fix', externalAppId: 'app_fix_1',
    expectedAppState: 'absent',
    bot: { displayName: 'Fix Bot', brand: 'feishu' },
    policy: policyInput(),
    ...overrides
  });
}

function mut(value: Record<string, unknown>): BotRelatedMutation {
  return botRelatedMutationSchema.parse(value);
}

function tableDump(db: Database.Database) {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>)
    .map(r => [r.name, db.prepare(`SELECT * FROM "${r.name}" ORDER BY rowid`).all()]);
}

describe('F1: strict getter / hidden-field boundary on the four assembling wrappers', () => {
  const methods = ['update', 'mutateRelated', 'setReceiving', 'setEnabled'] as const;

  function invoke(c: ReturnType<typeof createConfigurationCommands>, method: typeof methods[number], ref: BotChangeRef) {
    if (method === 'update') return c.update(ref, { displayName: 'changed' });
    if (method === 'mutateRelated') {
      return c.mutateRelated(ref, mut({ policy: { expectedRevision: 1, patch: { defaults: { model: 'x' } } } }));
    }
    if (method === 'setReceiving') return c.setReceiving(ref, true);
    return c.setEnabled(ref, true);
  }

  it.each(methods)('%s invokes an actor getter zero times and writes nothing', method => {
    const { db } = fixture();
    const c = createConfigurationCommands(db);
    c.create(createInput());
    let calls = 0;
    const ref = { operationId: 'op_bad', actor: owner, botId: 'bot_fix', expectedRevision: 1 } as unknown as BotChangeRef;
    Object.defineProperty(ref, 'actor', { enumerable: true, get() { calls++; return owner; } });
    const before = tableDump(db);
    expect(() => invoke(c, method, ref)).toThrow(/EXECUTION_INVALID_JSON/);
    expect(calls).toBe(0);
    expect(tableDump(db)).toEqual(before);
  });

  it.each(methods)('%s rejects a getter on operationId / botId / expectedRevision without calling it', method => {
    const { db } = fixture();
    const c = createConfigurationCommands(db);
    c.create(createInput());
    for (const field of ['operationId', 'botId', 'expectedRevision'] as const) {
      let calls = 0;
      const ref: Record<string, unknown> = { operationId: 'op_bad', actor: owner, botId: 'bot_fix', expectedRevision: 1 };
      Object.defineProperty(ref, field, { enumerable: true, get() { calls++; return field === 'expectedRevision' ? 1 : 'bot_fix'; } });
      expect(() => invoke(c, method, ref as unknown as BotChangeRef)).toThrow(/EXECUTION_INVALID_JSON/);
      expect(calls).toBe(0);
    }
  });

  it.each(methods)('%s drops no non-enumerable own key and rejects before the kernel', method => {
    const { db } = fixture();
    const c = createConfigurationCommands(db);
    c.create(createInput());
    const ref = { operationId: 'op_bad', actor: owner, botId: 'bot_fix', expectedRevision: 1 } as unknown as Record<string, unknown>;
    Object.defineProperty(ref, 'hidden', { value: 'forbidden', enumerable: false });
    const before = tableDump(db);
    expect(() => invoke(c, method, ref as unknown as BotChangeRef)).toThrow(/EXECUTION_INVALID_JSON/);
    expect(tableDump(db)).toEqual(before);
  });

  it.each(methods)('%s rejects a symbol key, an explicit undefined field and a non-plain prototype', method => {
    const { db } = fixture();
    const c = createConfigurationCommands(db);
    c.create(createInput());
    const base = { operationId: 'op_bad', actor: owner, botId: 'bot_fix', expectedRevision: 1 };

    const sym = { ...base } as Record<symbol, unknown>;
    Object.defineProperty(sym, Symbol('x'), { value: 1, enumerable: true });
    expect(() => invoke(c, method, sym as unknown as BotChangeRef)).toThrow(/EXECUTION_INVALID_JSON/);

    const undefField = { ...base, extra: undefined };
    expect(() => invoke(c, method, undefField as unknown as BotChangeRef)).toThrow(/EXECUTION_INVALID_JSON/);

    const proto = Object.create({ inherited: 1 }) as Record<string, unknown>;
    Object.assign(proto, base);
    expect(() => invoke(c, method, proto as unknown as BotChangeRef)).toThrow(/EXECUTION_INVALID_JSON/);
  });

  it('create and delete (no wrapper spread) still reject a raw actor getter with zero calls', () => {
    const { db } = fixture();
    const c = createConfigurationCommands(db);
    let calls = 0;
    const input = createInput();
    Object.defineProperty(input, 'actor', { enumerable: true, get() { calls++; return owner; } });
    expect(() => c.create(input)).toThrow(/EXECUTION_INVALID_JSON/);
    expect(calls).toBe(0);

    c.create(createInput());
    const before = tableDump(db);
    const ref = { operationId: 'op_del', actor: owner, botId: 'bot_fix', expectedRevision: 1 } as unknown as BotChangeRef;
    Object.defineProperty(ref, 'actor', { enumerable: true, get() { calls++; return owner; } });
    expect(() => c.delete(ref)).toThrow(/EXECUTION_INVALID_JSON/);
    expect(calls).toBe(0);
    expect(tableDump(db)).toEqual(before);
  });

  it('rejects a ref carrying the same key the wrapper would spread-overwrite (no silent clobber)', () => {
    const { db } = fixture();
    const c = createConfigurationCommands(db);
    c.create(createInput());

    // update: ref.patch would be overwritten by the argument on spread.
    const refWithPatch = {
      operationId: 'op_clobber', actor: owner, botId: 'bot_fix', expectedRevision: 1,
      patch: { displayName: 'INJECTED' }
    };
    const before = tableDump(db);
    expect(() => c.update(refWithPatch as unknown as BotChangeRef, { displayName: 'ok' })).toThrow();
    expect(tableDump(db)).toEqual(before);

    // mutateRelated: ref.change
    expect(() => c.mutateRelated(
      { operationId: 'op_clobber2', actor: owner, botId: 'bot_fix', expectedRevision: 1, change: {} } as unknown as BotChangeRef,
      mut({ policy: { expectedRevision: 1, patch: { defaults: { model: 'x' } } } })
    )).toThrow();
    // setReceiving / setEnabled
    expect(() => c.setReceiving(
      { operationId: 'op_clobber3', actor: owner, botId: 'bot_fix', expectedRevision: 1, receiving: true } as unknown as BotChangeRef,
      false
    )).toThrow();
    expect(() => c.setEnabled(
      { operationId: 'op_clobber4', actor: owner, botId: 'bot_fix', expectedRevision: 1, enabled: false } as unknown as BotChangeRef,
      true
    )).toThrow();
    expect(tableDump(db)).toEqual(before);
  });
});

describe('F2: reusing the current SecretRef ignores only older-revision facts', () => {
  function seedOldBotWithSecret(db: Database.Database, source: 'identity' | 'chat') {
    const c = createConfigurationCommands(db);
    c.create(createInput({
      botId: 'bot_old', externalAppId: 'app_old', operationId: 'op_create_old',
      preparedCredential: { secretId: 'sec', expectedRevision: 0, provider: 'file', referenceKey: 'old', fingerprint: 'a'.repeat(64) }
    }));
    if (source === 'identity') {
      db.prepare(`
        INSERT INTO remote_identity_facts (
          id, schema_version, revision, channel_bot_id, credential_ref_id, credential_revision,
          credential_fingerprint, app_fingerprint, bot_identity_ref, app_id_match,
          checked_at, expires_at, created_at, updated_at
        ) VALUES ('old_idf', 1, 1, 'bot_old', 'sec', 1, ?, ?, 'remote_bot_old', 1, ?, '2099-01-01T00:00:00.000Z', ?, ?)
      `).run('a'.repeat(64), 'a'.repeat(64), time, time, time);
    } else {
      db.prepare(`
        INSERT INTO remote_chat_facts (
          id, schema_version, revision, channel_bot_id, external_chat_id,
          membership_state, chat_type, credential_ref_id, credential_revision, credential_fingerprint,
          observed_at, expires_at, invalidated_at, created_at, updated_at
        ) VALUES ('old_chat', 1, 1, 'bot_old', 'chat_old', 'member', 'group', 'sec', 1, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?, ?)
      `).run('a'.repeat(64), time, time, time, time);
    }
    // Simulate the persisted result of a future legitimate rotate command.
    db.prepare("UPDATE secret_refs SET revision=2, reference_key='new', updated_at=? WHERE id='sec'").run(time);
  }

  // A minimal second Bot row that already references the shared secret. Identity
  // facts are UNIQUE per channel_bot_id, so a current-rev2 fact for a shared
  // secret realistically lives on a different referencing Bot.
  function seedCurrentReferenceBot(db: Database.Database) {
    db.prepare(`
      INSERT INTO channel_bots (
        id, schema_version, revision, authorization_revision, connection_generation,
        channel, external_app_id, display_name, platform_display_name, brand,
        credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at
      ) VALUES ('bot_cur', 2, 1, 1, 1, 'lark', 'app_cur', 'Cur', NULL, 'feishu',
        'sec', 'staged', 'paused', 0, ?, ?)
    `).run(time, time);
  }

  function newBotInput(): CreateBotV2 {
    return createInput({
      botId: 'bot_new', externalAppId: 'app_new', operationId: 'op_create_new',
      preparedCredential: { secretId: 'sec', expectedRevision: 2, provider: 'file', referenceKey: 'new', fingerprint: 'b'.repeat(64) }
    });
  }

  it.each(['identity', 'chat'] as const)('reuses current rev2 credential while retaining the old rev1 %s proof verbatim', source => {
    const { db } = fixture();
    seedOldBotWithSecret(db, source);

    const oldFactRow = source === 'identity'
      ? db.prepare('SELECT * FROM remote_identity_facts WHERE id=?').get('old_idf')
      : db.prepare('SELECT * FROM remote_chat_facts WHERE id=?').get('old_chat');

    const snapshot = createConfigurationCommands(db).create(newBotInput());
    expect(snapshot.credential?.revision).toBe(2);
    expect(snapshot.bot.credentialRef).toBe('sec');

    // The old historical fact is byte-for-byte preserved.
    const afterFactRow = source === 'identity'
      ? db.prepare('SELECT * FROM remote_identity_facts WHERE id=?').get('old_idf')
      : db.prepare('SELECT * FROM remote_chat_facts WHERE id=?').get('old_chat');
    expect(afterFactRow).toEqual(oldFactRow);
    // Secret metadata advanced by the simulated rotate is untouched.
    expect((db.prepare('SELECT revision, reference_key FROM secret_refs WHERE id=?').get('sec') as { revision: number; reference_key: string }))
      .toEqual({ revision: 2, reference_key: 'new' });
  });

  it.each(['identity', 'chat'] as const)('still rejects a contradictory CURRENT-revision %s fingerprint', source => {
    const { db } = fixture();
    seedOldBotWithSecret(db, source);
    seedCurrentReferenceBot(db);
    // A current-revision (rev2) fact on the other referencing Bot recording a
    // fingerprint different from the prepared one. Even an expired/invalidated
    // current-revision fact must not be ignored into a false match.
    if (source === 'identity') {
      db.prepare(`
        INSERT INTO remote_identity_facts (
          id, schema_version, revision, channel_bot_id, credential_ref_id, credential_revision,
          credential_fingerprint, app_fingerprint, bot_identity_ref, app_id_match,
          checked_at, expires_at, error_code, created_at, updated_at
        ) VALUES ('cur_idf', 1, 1, 'bot_cur', 'sec', 2, ?, ?, 'remote_bot_cur', 0, ?, '2000-01-01T00:00:00.000Z', 'APP_MISMATCH', ?, ?)
      `).run('c'.repeat(64), 'c'.repeat(64), time, time, time);
    } else {
      db.prepare(`
        INSERT INTO remote_chat_facts (
          id, schema_version, revision, channel_bot_id, external_chat_id,
          membership_state, chat_type, credential_ref_id, credential_revision, credential_fingerprint,
          observed_at, expires_at, invalidated_at, error_code, created_at, updated_at
        ) VALUES ('cur_chat', 1, 1, 'bot_cur', 'chat_cur', 'inaccessible', 'group', 'sec', 2, ?, ?, '2000-01-01T00:00:00.000Z', ?, 'CONFLICT', ?, ?)
      `).run('c'.repeat(64), time, time, time, time);
    }

    const before = tableDump(db);
    expect(() => createConfigurationCommands(db).create(newBotInput())).toThrow(/CONFIGURATION_CONFLICT/);
    // Atomic: nothing persisted.
    expect(tableDump(db)).toEqual(before);
    expect(createConfigurationReader(db).readByApp('app_new')).toBeUndefined();
  });

  it('a current-revision identity fact with a MATCHING fingerprint is accepted alongside the old fact', () => {
    const { db } = fixture();
    seedOldBotWithSecret(db, 'identity');
    seedCurrentReferenceBot(db);
    db.prepare(`
      INSERT INTO remote_identity_facts (
        id, schema_version, revision, channel_bot_id, credential_ref_id, credential_revision,
        credential_fingerprint, app_fingerprint, bot_identity_ref, app_id_match,
        checked_at, expires_at, created_at, updated_at
      ) VALUES ('cur_idf', 1, 1, 'bot_cur', 'sec', 2, ?, ?, 'remote_bot_cur', 1, ?, '2099-01-01T00:00:00.000Z', ?, ?)
    `).run('b'.repeat(64), 'b'.repeat(64), time, time, time);

    const snapshot = createConfigurationCommands(db).create(newBotInput());
    expect(snapshot.credential?.revision).toBe(2);
    const idfs = db.prepare('SELECT id, credential_revision FROM remote_identity_facts ORDER BY id').all() as Array<{ id: string; credential_revision: number }>;
    expect(idfs).toEqual([
      { id: 'cur_idf', credential_revision: 2 },
      { id: 'old_idf', credential_revision: 1 }
    ]);
  });
});

describe('F3: App/brand change retains full-trust confirmation history; coverage is false', () => {
  function seedConfirmedBot(db: Database.Database, revoked: boolean) {
    createConfigurationCommands(db).create(createInput());
    const scope = { version: 1 as const, channelBotId: 'bot_fix', externalAppId: 'app_fix_1', brand: 'feishu' as const, entries: [] };
    db.prepare(`
      INSERT INTO full_trust_confirmations (
        id, channel_bot_id, bot_revision, scope_digest, scope_json, source,
        confirmed_by_json, confirmed_at, legacy_source_digest, recorded_at, revoked_at, revoked_reason
      ) VALUES ('conf_1', 'bot_fix', 1, ?, ?, 'user_action', ?, ?, NULL, NULL, ?, ?)
    `).run(
      createHash('sha256').update(canonicalExecutionJson(scope)).digest('hex'),
      JSON.stringify(scope),
      JSON.stringify(owner), time,
      revoked ? time : null,
      revoked ? 'app changed' : null
    );
    return scope;
  }

  it.each([false, true])('keeps the %s confirmation (scope/digest/source unchanged) after an App change and reads it back', revoked => {
    const { db } = fixture();
    const oldScope = seedConfirmedBot(db, revoked);
    const c = createConfigurationCommands(db);

    const updated = c.update(
      { operationId: 'op_change_app', actor: owner, botId: 'bot_fix', expectedRevision: 1 },
      { externalAppId: 'app_fix_2' }
    );
    expect(updated.bot.externalAppId).toBe('app_fix_2');

    const confRow = db.prepare('SELECT scope_json, scope_digest, source, confirmed_by_json, confirmed_at, revoked_at, revoked_reason FROM full_trust_confirmations WHERE id=?').get('conf_1') as {
      scope_json: string; scope_digest: string; source: string;
      confirmed_by_json: string; confirmed_at: string; revoked_at: string | null; revoked_reason: string | null;
    };
    // Scope is the immutable old App scope; digest/source/attestation preserved.
    expect(JSON.parse(confRow.scope_json)).toEqual(oldScope);
    expect(confRow.scope_digest).toBe(createHash('sha256').update(canonicalExecutionJson(oldScope)).digest('hex'));
    expect(confRow.source).toBe('user_action');
    expect(JSON.parse(confRow.confirmed_by_json)).toEqual(owner);
    expect(confRow.confirmed_at).toBe(time);
    expect(confRow.revoked_at).toBe(revoked ? time : null);
    expect(confRow.revoked_reason).toBe(revoked ? 'app changed' : null);

    // Reader returns the historical confirmation attached to the new snapshot.
    const snap = createConfigurationReader(db).read('bot_fix')!;
    expect(snap.confirmations).toHaveLength(1);
    expect(snap.confirmations[0]!.scope.externalAppId).toBe('app_fix_1');
    // The stored digest still verifies against the OLD scope, not the new App.
    expect(snap.confirmations[0]!.scopeDigest).toBe(confRow.scope_digest);

    // Coverage against a candidate for the NEW app is false (domain differs).
    const candidateNewApp = { version: 1 as const, channelBotId: 'bot_fix', externalAppId: 'app_fix_2', brand: 'feishu' as const, entries: [] };
    expect(isFullTrustScopeCovered(candidateNewApp, snap.confirmations[0]!.scope)).toBe(false);
    // Coverage against the identical OLD scope remains true (scope itself is intact).
    expect(isFullTrustScopeCovered(oldScope, snap.confirmations[0]!.scope)).toBe(true);
  });

  it('brand change likewise retains both active and revoked confirmation history', () => {
    const { db } = fixture();
    const oldScope = seedConfirmedBot(db, false);
    const updated = createConfigurationCommands(db).update(
      { operationId: 'op_change_brand', actor: owner, botId: 'bot_fix', expectedRevision: 1 },
      { brand: 'lark' }
    );
    expect(updated.bot.brand).toBe('lark');
    const snap = createConfigurationReader(db).read('bot_fix')!;
    expect(snap.confirmations[0]!.scope.brand).toBe('feishu');
    const candidate = { version: 1 as const, channelBotId: 'bot_fix', externalAppId: 'app_fix_1', brand: 'lark' as const, entries: [] };
    expect(isFullTrustScopeCovered(candidate, snap.confirmations[0]!.scope)).toBe(false);
    expect(oldScope.brand).toBe('feishu');
  });

  it('PreparedBotConversion still rejects a carried confirmation whose scope App differs from the conversion target', () => {
    // Pure schema-level guarantee that conversion does not relax to the snapshot rule.
    const res = preparedBotConversionSchema.safeParse({
      botId: 'bot_c', externalAppId: 'app_target',
      bot: {
        schemaVersion: 2, id: 'bot_c', revision: 1, authorizationRevision: 1, connectionGeneration: 1,
        channel: 'lark', externalAppId: 'app_target', displayName: 'C', platformDisplayName: null,
        brand: 'feishu', credentialRef: 'sec_c', state: 'staged', desiredListenerState: 'paused',
        createdAt: time, updatedAt: time
      },
      policy: {
        schemaVersion: 2, id: 'policy_bot_c', revision: 1, channelBotId: 'bot_c',
        defaults: {},
        routingDefaults: { p2pMode: 'chat', groupReplyMode: 'runtime_default', mentionPolicy: 'always' },
        accessPolicy: {
          humanTalk: { p2p: { mode: 'owner_only' }, managedGroup: { mode: 'owner_only' }, newGroup: { mode: 'owner_only' } },
          botTalk: {
            p2p: { mode: 'allowlist', selectors: [], peerEnabled: false },
            managedGroup: { mode: 'allowlist', selectors: [], peerEnabled: false },
            newGroup: { mode: 'allowlist', selectors: [], peerEnabled: false }
          },
          defaultOperate: { rules: [] }, p2pOperate: { mode: 'none' }
        },
        execution: {
          permissionMode: 'ask', preInjectPrompt: null,
          highRiskAccess: { p2p: { mode: 'entry_authorized' }, managedGroup: { mode: 'entry_authorized' }, newGroup: { mode: 'entry_authorized' } },
          riskControlMode: 'off', highRiskPattern: '.*'
        },
        presentation: {
          webBaseUrl: null, structuredAskCards: false, groupCardMention: false,
          pushIntervalMs: 1000, traceLimit: 10, hideTraceOnComplete: false
        },
        groupToolsPolicy: { readCeiling: false, discoverCeiling: false, sendCeiling: false, readDefault: false, discoverDefault: false, sendDefault: false },
        createdAt: time, updatedAt: time
      },
      bindings: [], roles: [],
      confirmations: [{
        id: 'conf_c', channelBotId: 'bot_c', botRevision: 1,
        scopeDigest: 'd'.repeat(64),
        scope: { version: 1, channelBotId: 'bot_c', externalAppId: 'app_OTHER', brand: 'feishu', entries: [] },
        source: 'user_action',
        confirmedBy: owner, confirmedAt: time
      }],
      preparedCredential: { secretId: 'sec_c', expectedRevision: 1, provider: 'file', referenceKey: 'k', fingerprint: '1'.repeat(64) },
      executionEvidence: []
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.message).toMatch(/confirmation\.scope\.externalAppId must match externalAppId/);
  });
});

describe('F4: unsafe expected revisions rejected on first call and on replay; safe stale CAS still replays', () => {
  function setup(db: Database.Database) {
    createConfigurationCommands(db).create(createInput());
  }

  it('rejects unsafe Bot expectedRevision on first execution', () => {
    const { db } = fixture(); setup(db);
    const c = createConfigurationCommands(db);
    for (const bad of [Number.MAX_SAFE_INTEGER + 1, 1e100, 1.5, 0, -1]) {
      expect(() => c.update(
        { operationId: `op_bad_${bad}`, actor: owner, botId: 'bot_fix', expectedRevision: bad as number },
        { displayName: 'X' }
      )).toThrow();
    }
  });

  it('rejects an unsafe Bot expectedRevision even when replaying a previously completed operation', () => {
    const { db } = fixture(); setup(db);
    const c = createConfigurationCommands(db);
    const ref: BotChangeRef = { operationId: 'op_rep', actor: owner, botId: 'bot_fix', expectedRevision: 1 };
    const patch = { displayName: 'Replayed' };
    const first = c.update(ref, patch);
    expect(first.bot.revision).toBe(2);

    const before = tableDump(db);
    expect(() => c.update({ ...ref, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, patch)).toThrow();
    expect(tableDump(db)).toEqual(before);
  });

  it('rejects an unsafe nested policy.expectedRevision on replay', () => {
    const { db } = fixture(); setup(db);
    const c = createConfigurationCommands(db);
    const ref: BotChangeRef = { operationId: 'op_nested', actor: owner, botId: 'bot_fix', expectedRevision: 1 };
    const change = mut({ policy: { expectedRevision: 1, patch: { defaults: { model: 'n1' } } } });
    c.mutateRelated(ref, change);

    const before = tableDump(db);
    expect(() => c.mutateRelated(ref, mut({ policy: { expectedRevision: Number.MAX_SAFE_INTEGER + 1, patch: { defaults: { model: 'n1' } } } }))).toThrow();
    expect(tableDump(db)).toEqual(before);
  });

  it('rejects unsafe update Binding/Role CAS revisions', () => {
    const { db } = fixture(); setup(db);
    const c = createConfigurationCommands(db);
    c.mutateRelated(
      { operationId: 'op_init_b', actor: owner, botId: 'bot_fix', expectedRevision: 1 },
      mut({ bindings: [{ kind: 'create', id: 'bg', channelBotId: 'bot_fix', expectedRevision: 0, binding: { externalChatId: 'chat_bg', accessProfile: 'managed_group' } }] })
    );
    c.mutateRelated(
      { operationId: 'op_init_r', actor: owner, botId: 'bot_fix', expectedRevision: 2 },
      mut({ roles: [{ kind: 'create', id: 'rl', channelBotId: 'bot_fix', expectedRevision: 0, role: { principalId: 'principal_p', role: 'can_talk', operateScope: 'none' } }] })
    );

    expect(() => c.mutateRelated(
      { operationId: 'op_bad_b', actor: owner, botId: 'bot_fix', expectedRevision: 3 },
      mut({ bindings: [{ kind: 'update', id: 'bg', channelBotId: 'bot_fix', expectedRevision: Number.MAX_SAFE_INTEGER + 1, patch: { oncall: true } }] })
    )).toThrow();
    expect(() => c.mutateRelated(
      { operationId: 'op_bad_r', actor: owner, botId: 'bot_fix', expectedRevision: 3 },
      mut({ roles: [{ kind: 'update', id: 'rl', channelBotId: 'bot_fix', expectedRevision: Number.MAX_SAFE_INTEGER + 1, patch: { state: 'revoked' } }] })
    )).toThrow();
  });

  it('a legal but stale SAFE expectedRevision still replays the cached result after closing and reopening SQLite', () => {
    const f = fixture(); setup(f.db);
    const c1 = createConfigurationCommands(f.db);
    const ref: BotChangeRef = { operationId: 'op_stale', actor: owner, botId: 'bot_fix', expectedRevision: 1 };
    const patch = { displayName: 'Stale But Safe' };
    const first = c1.update(ref, patch);

    const db2 = f.reopen();
    const replayed = createConfigurationCommands(db2).update({ ...ref, expectedRevision: 9007199254740990 }, patch);
    expect(replayed).toEqual(first);

    const reader = createConfigurationReader(db2);
    expect(reader.listVersions('bot_fix')).toHaveLength(2); // create + one update
    expect(db2.prepare('SELECT count(*) c FROM configuration_operations').get()).toEqual({ c: 2 });
    // The tombstone from a separate delete still cannot be re-created by a late create after reopen.
    createConfigurationCommands(db2).delete({ operationId: 'op_del', actor: owner, botId: 'bot_fix', expectedRevision: 2 });
    const db3 = f.reopen();
    expect(() => createConfigurationCommands(db3).create(createInput({ operationId: 'late_create', externalAppId: 'app_fix_1' })))
      .toThrow(/CONFIGURATION_CONFLICT/);
  });
});
