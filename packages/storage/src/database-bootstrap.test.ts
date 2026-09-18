import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import type { RepositoryBundle, RepositoryOpenOptions } from '@dutydeck/shared';
import { createRepositories } from './index.js';
import { openDatabaseControl } from './database-control.js';
import { migrations } from './migrations.js';

const directories: string[] = [];
const repositories: RepositoryBundle[] = [];
const children: Array<{ child: ChildProcess; exit: Promise<[number | null, NodeJS.Signals | null]> }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const entry of children.splice(0)) {
    if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL');
    await entry.exit;
  }
  for (const repos of repositories.splice(0)) repos.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function file() { const directory = mkdtempSync(join(tmpdir(), 'database-bootstrap-')); directories.push(directory); return join(directory, 'state.sqlite'); }
const ledger = { newDatabaseAuthority: 'ledger_v1' } as RepositoryOpenOptions;
function open(path: string, options: RepositoryOpenOptions = ledger) { const repos = createRepositories(path, options); repositories.push(repos); return repos; }
function inspect<T>(path: string, work: (db: Database.Database) => T): T { const db = new Database(path); try { return work(db); } finally { db.close(); } }
function userSchema(db: Database.Database) { return db.prepare("SELECT name FROM main.sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT IN ('dutydeck_control','dutydeck_access') ORDER BY name").all(); }
function phase(db: Database.Database) { return db.prepare('SELECT phase FROM dutydeck_control WHERE id=1').pluck().get(); }
function accessCount(db: Database.Database) { return db.prepare('SELECT COUNT(*) FROM dutydeck_access').pluck().get(); }
function interceptRun(predicate: (sql: string, args: unknown[]) => boolean, action: (db: Database.Database, run: () => Database.RunResult) => Database.RunResult) {
  const prepare = Database.prototype.prepare;
  return vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
    const statement = prepare.call(this, sql); const original = statement.run.bind(statement); const db = this;
    vi.spyOn(statement, 'run').mockImplementation((...args: unknown[]) => predicate(sql, args) ? action(db, () => (original as (...args: unknown[]) => Database.RunResult)(...args)) : (original as (...args: unknown[]) => Database.RunResult)(...args));
    return statement;
  });
}

describe('atomic new database authority', () => {
  it.each(['memory', 'disk'])('initializes genuine fresh %s directly as ledger without legacy history', kind => {
    const repos = open(kind === 'memory' ? ':memory:' : file());
    expect(repos.execution.authority()).toBe('ledger_v1');
    const claim = repos.control.attachRuntime('bootstrap');
    try { expect(repos.execution.bind(claim)).toBeDefined(); } finally { claim.release(); }
  });

  it('keeps default and explicit legacy initialization unchanged', () => {
    for (const options of [{}, { newDatabaseAuthority: 'legacy' } as RepositoryOpenOptions]) {
      expect(open(file(), options).execution.authority()).toBe('legacy');
    }
  });

  it.each([
    'CREATE TABLE unknown_empty(id TEXT)',
    'CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
    'CREATE VIEW unknown_view AS SELECT 1 AS n',
    'CREATE TABLE dutydeck_unknown(id TEXT)'
  ])('does not promote any existing user schema: %s', sql => {
    const path = file(); inspect(path, db => db.exec(sql));
    expect(open(path).execution.authority()).toBe('legacy');
  });

  it('never downgrades an existing ledger on reopen, even with explicit legacy', () => {
    const path = file(); const first = createRepositories(path, ledger);
    expect(first.execution.authority()).toBe('ledger_v1'); first.close();
    expect(open(path, { newDatabaseAuthority: 'legacy' } as RepositoryOpenOptions).execution.authority()).toBe('ledger_v1');
  });

  it.each(['schema', 'marker'])('rolls back all business schema on %s failure and reopens through recovery', point => {
    const path = file(); const failure = new Error(`injected ${point}`);
    if (point === 'schema') {
      const exec = Database.prototype.exec;
      vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql: string) {
        const result = exec.call(this, sql);
        if (sql.includes('CREATE TABLE execution_authority')) throw failure;
        return result;
      });
    } else interceptRun(sql => sql.startsWith('UPDATE execution_authority'), (_db, run) => { run(); throw failure; });
    expect(() => createRepositories(path, ledger)).toThrow(failure); vi.restoreAllMocks();
    inspect(path, db => { expect(userSchema(db)).toEqual([]); expect(phase(db)).toBe('recovery'); expect(accessCount(db)).toBe(0); });
    expect(open(path).execution.authority()).toBe('ledger_v1');
  });

  it('rejects a marker update that did not update its expected row and rolls back initialization', () => {
    const path = file();
    interceptRun(sql => sql.startsWith('UPDATE execution_authority'), () => ({ changes: 0, lastInsertRowid: 0 }));
    expect(() => createRepositories(path, ledger)).toThrow(/New database authority was not initialized/); vi.restoreAllMocks();
    inspect(path, db => { expect(userSchema(db)).toEqual([]); expect(accessCount(db)).toBe(0); });
    expect(open(path).execution.authority()).toBe('ledger_v1');
  });

  it('keeps the committed ledger after finishUpgrade fails and releases the access registration', () => {
    const path = file(); const failure = new Error('injected finish');
    interceptRun((sql, args) => sql.startsWith('UPDATE dutydeck_control SET') && args[1] === 'idle', () => { throw failure; });
    expect(() => createRepositories(path, ledger)).toThrow(failure); vi.restoreAllMocks();
    inspect(path, db => { expect(db.prepare('SELECT authority FROM execution_authority').pluck().get()).toBe('ledger_v1'); expect(phase(db)).toBe('recovery'); expect(accessCount(db)).toBe(0); });
    expect(open(path).execution.authority()).toBe('ledger_v1');
  });

  it('closes both connections when repository construction fails after commit', () => {
    const path = file(); const failure = new Error('injected repository construction'); const prepare = Database.prototype.prepare; const connections = new Set<Database.Database>();
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
      connections.add(this);
      if (/SELECT.*FROM secret_refs/i.test(sql)) throw failure;
      return prepare.call(this, sql);
    });
    expect(() => createRepositories(path, ledger)).toThrow(failure); vi.restoreAllMocks();
    expect(connections.size).toBe(2); for (const connection of connections) expect(connection.open).toBe(false);
    inspect(path, db => { expect(accessCount(db)).toBe(0); expect(db.prepare('SELECT authority FROM execution_authority').pluck().get()).toBe('ledger_v1'); });
    expect(open(path).execution.authority()).toBe('ledger_v1');
  });

  it('keeps schema and marker invisible together until commit and restores foreign key enforcement', () => {
    const path = file(); let observed = false;
    let business: Database.Database | undefined;
    interceptRun(sql => sql.startsWith('UPDATE execution_authority'), (db, run) => {
      business = db;
      expect(db.inTransaction).toBe(true); expect(db.pragma('foreign_keys', { simple: true })).toBe(0);
      const result = run(); inspect(path, reader => { expect(userSchema(reader)).toEqual([]); expect(phase(reader)).toBe('maintenance'); }); observed = true; return result;
    });
    expect(open(path).execution.authority()).toBe('ledger_v1'); expect(observed).toBe(true);
    expect(business!.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('respects existing maintenance and registered visitors instead of taking over an old database', () => {
    const path = file(); inspect(path, () => {}); const control = openDatabaseControl(path, {});
    try { expect(() => createRepositories(path, ledger)).toThrow(/DATABASE_MAINTENANCE/); } finally { control.close(); }
    const current = open(path, {}); inspect(path, db => db.prepare('DELETE FROM schema_migrations WHERE version=18').run());
    expect(() => createRepositories(path, ledger)).toThrow(/DATABASE_UPGRADE_BUSY/);
    expect(current.execution.authority()).toBe('legacy');
    inspect(path, db => db.prepare('INSERT INTO schema_migrations VALUES (18, ?)').run('2026-09-14T00:00:00.000Z'));
  });

  it.each(['schema', 'marker'])('recovers a real child SIGKILL during %s with no partial business schema', async point => {
    const path = file();
    const child = spawn(process.execPath, ['--conditions=development', '--import', 'tsx', fileURLToPath(new URL('../tests/database-bootstrap-child.mts', import.meta.url)), path, point], { stdio: ['ignore', 'ignore', 'pipe'] });
    const exit = new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => { child.once('exit', (code, signal) => resolve([code, signal])); child.once('error', reject); }); children.push({ child, exit });
    const result = await exit; expect(result).toEqual([null, 'SIGKILL']);
    inspect(path, db => { expect(userSchema(db)).toEqual([]); expect(phase(db)).toBe('maintenance'); expect(accessCount(db)).toBe(1); });
    expect(open(path).execution.authority()).toBe('ledger_v1');
    inspect(path, db => expect(accessCount(db)).toBe(1));
  });

  it('runs the existing v15 table rebuild through the opener transaction with foreign keys intact', () => {
    const path = file();
    inspect(path, db => {
      db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
      for (const migration of migrations.slice(0, 14)) { migration.up(db); db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(migration.version, '2026-09-14T00:00:00.000Z'); }
      const definition = (db.prepare("SELECT sql FROM sqlite_schema WHERE name='schedule_definitions'").get() as { sql: string }).sql;
      db.exec('DROP TABLE schedule_definitions'); db.exec(definition.replace("'dutydeck'", "'dockmux'"));
      db.exec(`INSERT INTO channel_bots (id,schema_version,revision,channel,external_app_id,display_name,brand,state,desired_listener_state,full_trust_confirmed,created_at,updated_at)
        VALUES ('bot',1,1,'lark','app','bot','feishu','disabled','disabled',0,'2026-09-14','2026-09-14');
        INSERT INTO schedule_definitions (id,schema_version,revision,channel_bot_id,name,trigger_kind,interval_seconds,interval_anchor_at,timezone,dst_gap_policy,dst_overlap_policy,delivery_mode,chat_ref,continuation_policy,payload_ref,source_ownership,source_namespace,source_enabled,state,desired_executor_state,current_generation,created_at,updated_at)
        VALUES ('schedule',1,1,'bot','preserved','interval',3600,'2026-09-14','Asia/Shanghai','skip','first','chat','chat','same_thread','payload','dockmux','ns',1,'staged','disabled',1,'2026-09-14','2026-09-14');
        INSERT INTO schedule_watermarks (schedule_definition_id,schema_version,revision,updated_at) VALUES ('schedule',1,1,'2026-09-14');`);
    });
    expect(open(path).execution.authority()).toBe('legacy');
    inspect(path, db => { expect(db.prepare("SELECT sql FROM sqlite_schema WHERE name='schedule_definitions'").pluck().get()).toContain("'dutydeck'"); expect(db.prepare('SELECT source_ownership,name FROM schedule_definitions').get()).toEqual({source_ownership:'dutydeck',name:'preserved'}); expect(db.prepare('SELECT schedule_definition_id FROM schedule_watermarks').pluck().get()).toBe('schedule'); expect(db.pragma('foreign_key_check')).toEqual([]); expect(db.pragma('integrity_check', { simple: true })).toBe('ok'); expect(db.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get()).toBe(22); });
  });
});
