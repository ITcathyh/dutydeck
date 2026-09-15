import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import {
  botChangeRefSchema, botConfigPatchV2Schema, botSnapshotSchema, canonicalExecutionJson,
  RuntimeError, type ManagementActor
} from '@dutydeck/shared';
import { runMigrations } from './migrations.js';
import { createConfigurationReader } from './bot-configuration-reader.js';
import {
  runConfigurationCommand, nextConfigurationRevision, configurationIds,
  type ConfigurationCommand, type ConfigurationCommandContext, type ConfigurationAccess
} from './configuration-transaction.js';

const schema = botChangeRefSchema.extend({ patch: botConfigPatchV2Schema });
type Input = ReturnType<typeof schema.parse>;
type Snapshot = ReturnType<typeof botSnapshotSchema.parse>;
const owner: ManagementActor = { kind: 'installation_owner', principalId: 'principal_installation_owner' };
const principal: ManagementActor = { kind: 'principal', principalId: 'principal_admin', channelBotId: 'bot_a' };
const time = '2026-01-01T00:00:00.000Z';
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dutydeck-configuration-command-'));
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

function seedBot(db: Database.Database, id = 'bot_a', secret: string | null = null) {
  const human = { mode: 'owner_only' };
  const bots = { mode: 'allowlist', selectors: [], peerEnabled: false };
  const risk = { mode: 'entry_authorized' };
  const access = { humanTalk: { p2p: human, managedGroup: human, newGroup: human },
    botTalk: { p2p: bots, managedGroup: bots, newGroup: bots }, defaultOperate: { rules: [] }, p2pOperate: { mode: 'none' } };
  db.prepare(`INSERT INTO channel_bots (id,schema_version,revision,authorization_revision,connection_generation,channel,
    external_app_id,display_name,brand,credential_ref,state,desired_listener_state,full_trust_confirmed,created_at,updated_at)
    VALUES (?,2,1,1,1,'lark',?,?,'feishu',?,'staged','paused',0,?,?)`).run(id, `app_${id}`, 'Original', secret, time, time);
  db.prepare(`INSERT INTO channel_bot_policies (id,schema_version,revision,channel_bot_id,defaults_json,routing_defaults_json,
    access_policy_json,execution_json,presentation_json,group_tools_policy_json,created_at,updated_at)
    VALUES (?,2,1,?,'{}',?,?,?,?,?,?,?)`).run(`policy_${id}`, id,
    JSON.stringify({ p2pMode: 'chat', groupReplyMode: 'runtime_default', mentionPolicy: 'always' }), JSON.stringify(access),
    JSON.stringify({ permissionMode: 'ask', preInjectPrompt: null, highRiskAccess: { p2p: risk, managedGroup: risk, newGroup: risk }, riskControlMode: 'off', highRiskPattern: '.*' }),
    JSON.stringify({ webBaseUrl: null, structuredAskCards: false, groupCardMention: false, pushIntervalMs: 1000, traceLimit: 10, hideTraceOnComplete: false }),
    JSON.stringify({ readCeiling: false, discoverCeiling: false, sendCeiling: false, readDefault: false, discoverDefault: false, sendDefault: false }), time, time);
}

function role(db: Database.Database, id: string, botId = 'bot_a', group: string | null = null, expires: string | null = null) {
  db.prepare(`INSERT INTO role_assignments (id,schema_version,revision,channel_bot_id,group_binding_id,scope_key,principal_id,
    role,operate_scope,action_gates_json,state,expires_at,created_at,updated_at)
    VALUES (?,1,1,?,?,?,'principal_admin','admin','none',?,'active',?,?,?)`).run(id, botId, group, group ?? 'bot',
    JSON.stringify({ terminalWrite: false, highRisk: false, groupToolsSend: false }), expires, time, time);
}

function binding(db: Database.Database, id: string, botId = 'bot_a') {
  const inherit = '{"mode":"inherit"}';
  db.prepare(`INSERT INTO group_bindings (id,schema_version,revision,channel_bot_id,external_chat_id,state,access_profile,oncall,
    agent_override_json,workspace_override_json,model_override_json,reasoning_override_json,role_policy_override_json,
    routing_override_json,access_override_json,group_tools_override_json,presentation_override_json,review_reasons_json,created_at,updated_at)
    VALUES (?,2,1,?,?,'enabled','managed_group',0,?,?,?,?,?,?,?,?,?,'[]',?,?)`)
    .run(id, botId, `chat_${id}`, ...Array<string>(5).fill(inherit),
      JSON.stringify({ groupReplyMode: { mode: 'inherit' }, mentionPolicy: { mode: 'inherit' } }), inherit,
      JSON.stringify({ read: 'inherit', discover: 'inherit', send: 'inherit' }), inherit, time, time);
}

function request(patch: Partial<Input> = {}): Input {
  return { operationId: 'operation_1', actor: owner, botId: 'bot_a', expectedRevision: 1, patch: { displayName: 'Changed' }, ...patch };
}

function command(db: Database.Database, overrides: Partial<ConfigurationCommand<Input, Snapshot>> = {}): ConfigurationCommand<Input, Snapshot> {
  return {
    action: 'update', inputSchema: schema, resultSchema: botSnapshotSchema,
    operation: input => ({ operationId: input.operationId, actor: input.actor }),
    target: input => ({ botId: input.botId }),
    stablePayload: ({ expectedRevision: _revision, ...input }) => input,
    access: input => ({ kind: 'bot', botId: input.botId }),
    execute(input, context) {
      const original = context.before.get(input.botId)!;
      if (original.bot.revision !== input.expectedRevision) throw new RuntimeError('CONFIGURATION_REVISION_CONFLICT', 'Wrong revision', 409);
      if (input.patch.displayName === original.bot.displayName) return original;
      const next = botSnapshotSchema.parse({ ...original, bot: { ...original.bot, ...input.patch } });
      db.prepare('UPDATE channel_bots SET display_name = ? WHERE id = ?').run(next.bot.displayName, input.botId);
      return context.recordChange(input.botId, { kind: 'updated', authorization: false, connection: false });
    }, ...overrides
  };
}

describe('configuration command transactions', () => {
  it('persists one immutable history and reopens the original result before stale CAS', () => {
    const f = fixture(); seedBot(f.db);
    const first = runConfigurationCommand(f.db, request(), command(f.db));
    expect([first.bot.revision, first.bot.authorizationRevision, first.bot.connectionGeneration]).toEqual([2, 1, 1]);
    const db = f.reopen();
    const replay = runConfigurationCommand(db, request({ expectedRevision: 900 }), command(db, { execute: () => { throw new Error('Must not execute twice'); } }));
    expect(replay).toEqual(first);
    const reader = createConfigurationReader(db);
    const versions = reader.listVersions('bot_a');
    expect(versions).toHaveLength(1);
    expect(reader.readVersion('bot_a', versions[0]!.versionId)?.snapshot).toEqual(first);
    expect(reader.listChanges(0, 10)).toHaveLength(1);
    expect(db.prepare('SELECT count(*) AS n FROM configuration_operations').get()).toEqual({ n: 1 });
  });

  it('records a no-op audit without advancing any version or sequence', () => {
    const { db } = fixture(); seedBot(db);
    const result = runConfigurationCommand(db, request({ patch: { displayName: 'Original' } }), command(db));
    expect(result.bot.revision).toBe(1);
    expect(db.prepare('SELECT count(*) AS n FROM configuration_operations').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM configuration_changes').get()).toEqual({ n: 0 });
    const saved = db.serialize();
    expect(runConfigurationCommand(db, request({ patch: { displayName: 'Original' } }), command(db))).toEqual(result);
    expect(db.serialize().equals(saved)).toBe(true);
  });

  it('records a newly created Bot once with versions starting at one', () => {
    const { db } = fixture();
    const create = command(db, { action: 'create', access: input => ({ kind: 'owner', botIds: [input.botId] }),
      execute(input, context) {
        expect(context.before.has(input.botId)).toBe(true);
        expect(context.before.get(input.botId)).toBeUndefined();
        seedBot(db, input.botId);
        return context.recordChange(input.botId, { kind: 'created', authorization: true, connection: true });
      }
    });
    const result = runConfigurationCommand(db, request(), create);
    expect([result.bot.revision, result.bot.authorizationRevision, result.bot.connectionGeneration]).toEqual([1, 1, 1]);
    expect(runConfigurationCommand(db, request(), create)).toEqual(result);
    expect(createConfigurationReader(db).listVersions('bot_a')).toHaveLength(1);
  });

  it.each(['action', 'actor', 'target', 'prepared_fingerprint', 'business_revision'])('rejects reused operation with different %s', field => {
    const { db } = fixture(); seedBot(db); seedBot(db, 'bot_b');
    const first = command(db, { stablePayload: input => ({ patch: input.patch, prepared: { fingerprint: 'a'.repeat(64) }, business: { revision: 1 } }) });
    runConfigurationCommand(db, request(), first);
    const changed = command(db, { ...first,
      ...(field === 'action' ? { action: 'delete' } : {}),
      ...(field === 'actor' ? { operation: () => ({ operationId: 'operation_1', actor: { kind: 'principal', principalId: 'principal_other', channelBotId: 'bot_a' } }), access: () => ({ kind: 'bot', botId: 'bot_a' }) } : {}),
      ...(field === 'target' ? { target: () => ({ botId: 'bot_b' }) } : {}),
      ...(field === 'prepared_fingerprint' ? { stablePayload: input => ({ patch: input.patch, prepared: { fingerprint: 'b'.repeat(64) }, business: { revision: 1 } }) } : {}),
      ...(field === 'business_revision' ? { stablePayload: input => ({ patch: input.patch, prepared: { fingerprint: 'a'.repeat(64) }, business: { revision: 2 } }) } : {})
    });
    if (field === 'actor') {
      role(db, 'other'); db.prepare("UPDATE role_assignments SET principal_id='principal_other' WHERE id='other'").run();
    }
    const before = db.serialize();
    expect(() => runConfigurationCommand(db, request(), changed)).toThrow(/CONFIGURATION_OPERATION_CONFLICT/);
    expect(db.serialize()).toEqual(before);
  });

  it('rechecks current roles before a cached result after revoke and expiry', () => {
    const { db } = fixture(); seedBot(db); role(db, 'admin');
    const input = request({ actor: principal });
    runConfigurationCommand(db, input, command(db));
    for (const update of ["state='revoked'", "state='active',expires_at='2000-01-01T00:00:00.000Z'"]) {
      db.exec(`UPDATE role_assignments SET ${update} WHERE id='admin'`);
      const bytes = db.serialize();
      expect(() => runConfigurationCommand(db, input, command(db))).toThrow(/CONFIGURATION_FORBIDDEN/);
      expect(db.serialize().equals(bytes)).toBe(true);
    }
  });

  it('checks exact App and every existing group using the original role set', () => {
    const { db } = fixture(); seedBot(db); seedBot(db, 'bot_b');
    binding(db, 'group_a'); binding(db, 'group_b'); binding(db, 'foreign', 'bot_b');
    role(db, 'group_admin', 'bot_a', 'group_a');
    const input = request({ actor: principal });
    const scoped = (ids: string[]) => command(db, {
      action: 'mutateRelated',
      target: () => ({ botId: 'bot_a', bindingIds: configurationIds(ids) }),
      stablePayload: () => ({ bindingIds: configurationIds(ids), oncall: true }),
      access: () => ({ kind: 'bot', botId: 'bot_a', bindingIds: ids }),
      execute(input, context) {
        for (const id of ids) db.prepare('UPDATE group_bindings SET oncall=1,revision=revision+1 WHERE id=?').run(id);
        return context.recordChange(input.botId, { kind: 'related_mutated', authorization: true, connection: false });
      }
    });
    const initial = db.serialize();
    expect(() => runConfigurationCommand(db, input, command(db))).toThrow(/CONFIGURATION_FORBIDDEN/);
    expect(() => runConfigurationCommand(db, input, scoped(['group_a', 'group_b']))).toThrow(/CONFIGURATION_FORBIDDEN/);
    expect(() => runConfigurationCommand(db, input, scoped(['foreign']))).toThrow(/CONFIGURATION_INVALID_TARGET/);
    expect(() => runConfigurationCommand(db, input, scoped([]))).toThrow(/CONFIGURATION_INVALID_TARGET/);
    expect(() => runConfigurationCommand(db, input, scoped(['group_a', 'group_a']))).toThrow(/CONFIGURATION_DUPLICATE_TARGET/);
    expect(() => runConfigurationCommand(db, request({ actor: { ...principal, channelBotId: 'bot_b' } }), scoped(['group_a']))).toThrow(/CONFIGURATION_FORBIDDEN/);
    expect(db.serialize().equals(initial)).toBe(true);
    role(db, 'group_b_admin', 'bot_a', 'group_b');
    const result = runConfigurationCommand(db, input, scoped(['group_b', 'group_a']));
    expect(result.bot.revision).toBe(2);
    expect(result.bot.authorizationRevision).toBe(2);
    expect(result.bindings.map(group => [group.id, group.oncall, group.revision])).toEqual([['group_a', true, 2], ['group_b', true, 2]]);
  });

  it('checks every current shared-secret reference including tombstones', () => {
    const { db } = fixture();
    db.prepare("INSERT INTO secret_refs (id,schema_version,revision,kind,provider,reference_key,status,created_at,updated_at) VALUES ('secret',1,1,'lark_app_secret','file','ref','configured',?,?)").run(time, time);
    seedBot(db, 'bot_a', 'secret'); seedBot(db, 'bot_b', 'secret'); role(db, 'admin');
    db.prepare("UPDATE channel_bots SET state='deleted' WHERE id='bot_b'").run();
    const shared = command(db, { access: () => ({ kind: 'shared_secret', secretId: 'secret' }) });
    const bytes = db.serialize();
    expect(() => runConfigurationCommand(db, request({ actor: principal }), shared)).toThrow(/CONFIGURATION_FORBIDDEN/);
    expect(db.serialize().equals(bytes)).toBe(true);
    expect(runConfigurationCommand(db, request(), shared).bot.revision).toBe(2);
  });

  it.each<ConfigurationAccess>([{ kind: 'owner', botIds: ['bot_a'] }, { kind: 'unbound_secret', secretId: 'secret' }, { kind: 'shared_secret', secretId: 'missing' }])('requires the installation owner for $kind without delegated Bot scope', access => {
    const { db } = fixture(); seedBot(db); role(db, 'admin');
    expect(() => runConfigurationCommand(db, request({ actor: principal }), command(db, { access: () => access }))).toThrow(/CONFIGURATION_FORBIDDEN/);
  });

  it('rejects getters and lossy JSON before parsing, without reading the getter', () => {
    const { db } = fixture(); seedBot(db);
    let gets = 0; let parses = 0;
    const getter = { ...request() };
    Object.defineProperty(getter, 'patch', { enumerable: true, get() { gets++; return { displayName: 'Bad' }; } });
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const sparse = Array(2); sparse[1] = 'x';
    const invalid = [getter, { ...request(), extra: undefined }, { ...request(), toJSON() { gets++; return request(); } },
      { ...request(), extra: NaN }, { ...request(), extra: Infinity }, { ...request(), extra: sparse }, { ...request(), extra: cyclic }, { ...request(), extra: new Date() }];
    const bytes = db.serialize();
    for (const input of invalid) expect(() => runConfigurationCommand(db, input, command(db, { inputSchema: { parse: value => { parses++; return schema.parse(value); } } }))).toThrow(/EXECUTION_INVALID_JSON/);
    expect([gets, parses]).toEqual([0, 0]);
    expect(db.serialize().equals(bytes)).toBe(true);
  });

  it.each(['null', '{"extra":true}', '{'])('rejects a corrupt saved result %s without executing or repairing', saved => {
    const { db } = fixture(); seedBot(db);
    runConfigurationCommand(db, request(), command(db));
    db.pragma('ignore_check_constraints=ON');
    db.prepare('UPDATE configuration_operations SET result_json=?').run(saved);
    db.pragma('ignore_check_constraints=OFF');
    const bytes = db.serialize();
    expect(() => runConfigurationCommand(db, request(), command(db, { execute() { throw new Error('Must not execute'); } }))).toThrow(/CONFIGURATION_CORRUPTED_RECORD/);
    expect(db.serialize().equals(bytes)).toBe(true);
  });

  it.each(['legacy', 'missing', 'unknown'])('rejects authority %s before mutation', state => {
    const { db } = fixture(); seedBot(db);
    if (state === 'missing') db.exec('DELETE FROM configuration_authority');
    else { db.pragma('ignore_check_constraints=ON'); db.prepare('UPDATE configuration_authority SET authority=?').run(state); db.pragma('ignore_check_constraints=OFF'); }
    const bytes = db.serialize();
    expect(() => runConfigurationCommand(db, request(), command(db))).toThrow(/CONFIGURATION_(LEGACY_AUTHORITY|AUTHORITY_MISSING|AUTHORITY_INVALID)/);
    expect(db.serialize().equals(bytes)).toBe(true);
  });

  it('rejects a caller transaction and recursive command without disturbing its owner', () => {
    const { db } = fixture(); seedBot(db);
    db.exec('BEGIN');
    expect(() => runConfigurationCommand(db, request(), command(db))).toThrow(/CONFIGURATION_OUTER_TRANSACTION/);
    expect(db.inTransaction).toBe(true); db.exec('ROLLBACK');
    const bytes = db.serialize();
    expect(() => runConfigurationCommand(db, request(), command(db, { execute() { return runConfigurationCommand(db, request(), command(db)); } }))).toThrow(/CONFIGURATION_OUTER_TRANSACTION/);
    expect(db.serialize().equals(bytes)).toBe(true);
  });

  it.each(['after_write', 'after_history', 'invalid_result', 'double_history'])('rolls back all tables and sequence at %s', point => {
    const { db } = fixture(); seedBot(db);
    const bytes = db.serialize();
    expect(() => runConfigurationCommand(db, request(), command(db, { execute(input, context) {
      db.prepare("UPDATE channel_bots SET display_name='Transient' WHERE id=?").run(input.botId);
      if (point === 'after_write') throw new Error('Injected command failure');
      const result = context.recordChange(input.botId, { kind: 'updated', authorization: true, connection: true });
      if (point === 'after_history') throw new Error('Injected command failure');
      if (point === 'double_history') context.recordChange(input.botId, { kind: 'updated', authorization: false, connection: false });
      return { ...result, extra: true } as Snapshot;
    } }))).toThrow();
    expect(db.serialize().equals(bytes)).toBe(true);
    expect(runConfigurationCommand(db, request(), command(db)).bot.revision).toBe(2);
    expect(createConfigurationReader(db).listChanges(0, 10)[0]?.sequence).toBe(1);
  });

  it.each(['revision', 'authorization_revision', 'connection_generation', 'sequence'])('rolls back integer overflow in %s', column => {
    const { db } = fixture(); seedBot(db);
    if (column === 'sequence') db.prepare("INSERT INTO sqlite_sequence (name,seq) VALUES ('configuration_changes',?)").run(Number.MAX_SAFE_INTEGER);
    else db.exec(`UPDATE channel_bots SET ${column}=${Number.MAX_SAFE_INTEGER}`);
    const input = request({ expectedRevision: column === 'revision' ? Number.MAX_SAFE_INTEGER : 1 });
    const bytes = db.serialize();
    expect(() => runConfigurationCommand(db, input, command(db, { execute(i, context) {
      db.prepare("UPDATE channel_bots SET display_name='Overflow' WHERE id=?").run(i.botId);
      return context.recordChange(i.botId, { kind: 'updated', authorization: true, connection: true });
    } }))).toThrow();
    expect(db.serialize().equals(bytes)).toBe(true);
  });

  it('keeps escaped history writers closed after success and failure', () => {
    const { db } = fixture(); seedBot(db);
    let escaped: ConfigurationCommandContext | undefined;
    runConfigurationCommand(db, request({ patch: { displayName: 'Original' } }), command(db, { execute(_i, context) { escaped = context; return context.before.get('bot_a')!; } }));
    const bytes = db.serialize();
    expect(() => escaped!.recordChange('bot_a', { kind: 'updated', authorization: false, connection: false })).toThrow(/CONFIGURATION_TRANSACTION_CLOSED/);
    expect(db.serialize().equals(bytes)).toBe(true);
    expect(() => runConfigurationCommand(db, request({ operationId: 'failure' }), command(db, { execute(_i, context) { escaped = context; throw new Error('Abort'); } }))).toThrow('Abort');
    expect(() => escaped!.recordChange('bot_a', { kind: 'updated', authorization: false, connection: false })).toThrow(/CONFIGURATION_TRANSACTION_CLOSED/);
    expect(db.serialize().equals(bytes)).toBe(true);
  });

  it('rejects a changed Bot outside the originally authorized targets and rolls back its writes', () => {
    const { db } = fixture(); seedBot(db); seedBot(db, 'bot_b');
    const bytes = db.serialize();
    expect(() => runConfigurationCommand(db, request(), command(db, { execute(_input, context) {
      db.prepare("UPDATE channel_bots SET display_name='Outside' WHERE id='bot_b'").run();
      return context.recordChange('bot_b', { kind: 'updated', authorization: false, connection: false });
    } }))).toThrow(/CONFIGURATION_INVALID_TARGET/);
    expect(db.serialize().equals(bytes)).toBe(true);
  });

  it('rolls back a real version INSERT failure including the operation and allocated sequence', () => {
    const { db } = fixture(); seedBot(db);
    db.exec("CREATE TRIGGER fail_version BEFORE INSERT ON configuration_versions BEGIN SELECT RAISE(ABORT,'version write failed'); END;");
    const bytes = db.serialize();
    expect(() => runConfigurationCommand(db, request(), command(db))).toThrow('version write failed');
    expect(db.serialize().equals(bytes)).toBe(true);
    db.exec('DROP TRIGGER fail_version');
    runConfigurationCommand(db, request(), command(db));
    expect(createConfigurationReader(db).listChanges(0, 10)[0]?.sequence).toBe(1);
  });

  it('holds the write lock between current authorization and writes against a real second process', () => {
    const { db, path } = fixture(); seedBot(db); role(db, 'admin');
    const modulePath = createRequire(import.meta.url).resolve('better-sqlite3');
    const worker = `const Database=require(process.argv[2]); const db=new Database(process.argv[1],{timeout:40}); try {db.prepare("UPDATE role_assignments SET state='revoked' WHERE id='admin'").run(); process.stdout.write('revoked');} catch(e) {process.stdout.write(e.code);} finally {db.close();}`;
    const revoke = () => spawnSync(process.execPath, ['-e', worker, path, modulePath], { encoding: 'utf8', timeout: 10000 });
    let inCommand = false;
    const original = command(db);
    const result = runConfigurationCommand(db, request({ actor: principal }), command(db, { execute(input, context) {
      inCommand = true;
      const other = revoke();
      expect(other.error).toBeUndefined(); expect(other.status).toBe(0); expect(other.stdout).toBe('SQLITE_BUSY');
      expect(db.prepare("SELECT state FROM role_assignments WHERE id='admin'").get()).toEqual({ state: 'active' });
      return original.execute(input, context);
    } }));
    expect(inCommand).toBe(true); expect(result.bot.revision).toBe(2);
    const after = revoke(); expect(after.status).toBe(0); expect(after.stdout).toBe('revoked');
    expect(() => runConfigurationCommand(db, request({ actor: principal }), command(db))).toThrow(/CONFIGURATION_FORBIDDEN/);
  });

  it('normalizes unordered ID sets and refuses lossy increments', () => {
    expect(configurationIds(['b', 'a'])).toEqual(['a', 'b']);
    expect(() => configurationIds(['a', 'a'])).toThrow(/CONFIGURATION_DUPLICATE_TARGET/);
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) expect(() => nextConfigurationRevision(value)).toThrow(/CONFIGURATION_REVISION_OVERFLOW/);
    expect(nextConfigurationRevision(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER);
    expect(canonicalExecutionJson({ business: { revision: 42 } })).toContain('42');
  });

  it('resolves a stored role group under the same write lock as authorization and mutation', () => {
    const { db, path } = fixture(); seedBot(db); binding(db, 'group_a'); binding(db, 'group_b'); role(db, 'admin', 'bot_a', 'group_a');
    const modulePath = createRequire(import.meta.url).resolve('better-sqlite3');
    const worker = `const Database=require(process.argv[2]); const db=new Database(process.argv[1],{timeout:40}); try {db.prepare("UPDATE role_assignments SET group_binding_id='group_b',scope_key='group_b' WHERE id='admin'").run(); process.stdout.write('moved');} catch(e) {process.stdout.write(e.code);} finally {db.close();}`;
    const move = () => spawnSync(process.execPath, ['-e', worker, path, modulePath], { encoding: 'utf8', timeout: 10000 });
    let resolved = false;
    const result = runConfigurationCommand(db, request({ actor: principal }), command(db, {
      action: 'mutateRelated', target: () => ({ roleId: 'admin' }),
      access(input) {
        expect(db.inTransaction).toBe(true);
        const original = createConfigurationReader(db).read(input.botId)!.roles.find(item => item.id === 'admin')!;
        expect(original.groupBindingId).toBe('group_a');
        const other = move(); expect(other.error).toBeUndefined(); expect(other.status).toBe(0); expect(other.stdout).toBe('SQLITE_BUSY');
        resolved = true;
        return { kind: 'bot', botId: input.botId, bindingIds: [original.groupBindingId!] };
      },
      execute(input, context) {
        expect(context.before.get(input.botId)!.roles.find(item => item.id === 'admin')!.groupBindingId).toBe('group_a');
        db.prepare("UPDATE role_assignments SET state='revoked',revision=2 WHERE id='admin'").run();
        return context.recordChange(input.botId, { kind: 'related_mutated', authorization: true, connection: false });
      }
    }));
    expect(resolved).toBe(true); expect(result.bot.authorizationRevision).toBe(2);
    expect(result.roles.find(item => item.id === 'admin')).toMatchObject({ groupBindingId: 'group_a', state: 'revoked' });
    const after = move(); expect(after.status).toBe(0); expect(after.stdout).toBe('moved');
    const history = createConfigurationReader(db).listVersions('bot_a')[0]!;
    expect(createConfigurationReader(db).readVersion('bot_a', history.versionId)!.snapshot.roles.find(item => item.id === 'admin')!.groupBindingId).toBe('group_a');
  });

  it('rejects a new target injected into the command snapshot Map and rolls back its writes', () => {
    const { db } = fixture(); seedBot(db); seedBot(db, 'bot_b'); role(db, 'admin');
    const bytes = db.serialize();
    expect(() => runConfigurationCommand(db, request({ actor: principal }), command(db, { execute(_input, context) {
      const exposed = context.before as Map<string, Snapshot | undefined>;
      expect(Object.isFrozen(exposed.get('bot_a')!.bot)).toBe(true);
      exposed.set('bot_b', createConfigurationReader(db).read('bot_b'));
      db.prepare("UPDATE channel_bots SET display_name='Injected' WHERE id='bot_b'").run();
      return context.recordChange('bot_b', { kind: 'updated', authorization: false, connection: false });
    } }))).toThrow(/CONFIGURATION_INVALID_TARGET/);
    expect(db.serialize().equals(bytes)).toBe(true);
    expect(createConfigurationReader(db).listVersions('bot_b')).toEqual([]);
  });

  it('keeps the original version fence when the command replaces an authorized snapshot', () => {
    const { db } = fixture(); seedBot(db); role(db, 'admin');
    const bytes = db.serialize();
    expect(() => runConfigurationCommand(db, request({ actor: principal }), command(db, { execute(_input, context) {
      db.prepare("UPDATE channel_bots SET revision=2,display_name='Replaced' WHERE id='bot_a'").run();
      (context.before as Map<string, Snapshot | undefined>).set('bot_a', createConfigurationReader(db).read('bot_a'));
      return context.recordChange('bot_a', { kind: 'updated', authorization: false, connection: false });
    } }))).toThrow(/CONFIGURATION_REVISION_CONFLICT/);
    expect(db.serialize().equals(bytes)).toBe(true);
    expect(createConfigurationReader(db).listVersions('bot_a')).toEqual([]);
  });
});
