import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRepositories } from './index.js'
import { migrations, runMigrations, withMigrationTransaction } from './migrations.js'

const databases: Database.Database[] = []
const directories: string[] = []
const tables = ['channel_bots', 'schedule_definitions', 'schedule_generations', 'schedule_occurrences', 'schedule_watermarks'] as const
const references = [
  ['schedule_generations', 'schedule_definition_id'],
  ['schedule_occurrences', 'schedule_definition_id'],
  ['schedule_watermarks', 'schedule_definition_id'],
  ['schedule_occurrences', 'schedule_generation_id']
] as const
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) if (db.open) db.close()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function file() {
  const directory = mkdtempSync(join(tmpdir(), 'migration-foreign-keys-'))
  directories.push(directory)
  return join(directory, 'state.sqlite')
}
function open(filename = ':memory:') {
  const db = new Database(filename)
  databases.push(db)
  return db
}
function snapshot(db: Database.Database) {
  return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
}
function version(db: Database.Database) { return db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get() }
function definition(db: Database.Database) { return db.prepare("SELECT sql FROM sqlite_schema WHERE name='schedule_definitions'").pluck().get() }
function legacy(filename = ':memory:') {
  const db = open(filename)
  db.pragma('foreign_keys = OFF')
  db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
  for (const migration of migrations.slice(0, 14)) {
    migration.up(db)
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(migration.version, '2026-09-14')
  }
  const ddl = definition(db) as string
  db.exec('DROP TABLE schedule_definitions')
  db.exec(ddl.replace("'dutydeck'", "'dockmux'"))
  db.exec(`CREATE UNIQUE INDEX schedule_definitions_source ON schedule_definitions(source_namespace,source_schedule_ref) WHERE source_schedule_ref IS NOT NULL;
    CREATE INDEX schedule_definitions_bot_state ON schedule_definitions(channel_bot_id,state,updated_at);
    INSERT INTO channel_bots(id,schema_version,revision,channel,external_app_id,display_name,brand,state,desired_listener_state,full_trust_confirmed,created_at,updated_at)
    VALUES('bot',1,1,'lark','app','bot','feishu','disabled','disabled',0,'created','updated')`)
  for (const [id, ownership] of [['one', 'dockmux'], ['two', 'botmux']]) {
    db.prepare(`INSERT INTO schedule_definitions(id,schema_version,revision,channel_bot_id,name,description,trigger_kind,interval_seconds,interval_anchor_at,timezone,dst_gap_policy,dst_overlap_policy,delivery_mode,chat_ref,continuation_policy,payload_ref,source_ownership,source_namespace,source_schedule_ref,source_enabled,state,desired_executor_state,current_generation,created_at,updated_at)
      VALUES(?,1,7,'bot','preserved name','preserved description','interval',3600,'anchor','Asia/Shanghai','skip','second','chat','chat','same_thread','payload',?,'ns',?,1,'staged','disabled',3,'created','updated')`).run(id, ownership, id)
    db.prepare(`INSERT INTO schedule_generations(id,schema_version,schedule_definition_id,generation,definition_revision,definition_hash,timezone,state,created_at)
      VALUES(?,1,?,3,7,?,'Asia/Shanghai','staged_disabled','created')`).run('g' + id, id, 'a'.repeat(64))
    db.prepare(`INSERT INTO schedule_occurrences(id,schema_version,revision,schedule_definition_id,schedule_generation_id,generation,scheduled_for_utc,idempotency_key,state,intent_kind,created_at,updated_at)
      VALUES(?,1,8,?,?,3,'due',?,'settled','task_run_snapshot','created','updated')`).run('o' + id, id, 'g' + id, 'key' + id)
    db.prepare(`INSERT INTO schedule_watermarks(schedule_definition_id,schema_version,revision,last_planned_occurrence_key,last_claimed_occurrence_key,last_started_occurrence_key,last_settled_occurrence_key,next_due_at,updated_at)
      VALUES(?,1,4,'planned','claimed','started','settled','next','updated')`).run(id)
  }
  expect(db.pragma('foreign_key_check')).toEqual([])
  return db
}

describe('foreign keys across migration table rebuilds', () => {
  it.each([0, 1])('preserves every child row and constraint, restoring original FK=%i', foreignKeys => {
    const db = legacy()
    const before = snapshot(db)
    const beforeReferences = tables.map(table => db.pragma(`foreign_key_list(${table})`))
    db.pragma(`foreign_keys = ${foreignKeys}`)
    runMigrations(db)
    const expected = structuredClone(before)
    for (const row of expected.schedule_definitions as Array<{ source_ownership: string }>) {
      if (row.source_ownership === 'dockmux') row.source_ownership = 'dutydeck'
    }
    for (const row of expected.channel_bots) Object.assign(row, { authorization_revision: null, connection_generation: null, platform_display_name: null });
    expect(snapshot(db)).toEqual(expected)
    expect(tables.map(table => db.pragma(`foreign_key_list(${table})`))).toEqual(beforeReferences)
    expect(version(db)).toBe(19)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(foreignKeys)
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='schedule_definitions' AND name NOT GLOB 'sqlite_*' ORDER BY name").all())
      .toEqual([{ name: 'schedule_definitions_bot_state' }, { name: 'schedule_definitions_source' }])
    db.pragma('foreign_keys = ON')
    expect(() => db.exec("DELETE FROM schedule_definitions WHERE id='one'")).toThrow(/FOREIGN KEY/)
    expect(() => db.exec("UPDATE schedule_occurrences SET schedule_generation_id='missing' WHERE id='oone'")).toThrow(/FOREIGN KEY/)
    expect(() => db.exec("UPDATE schedule_definitions SET source_schedule_ref='one' WHERE id='two'")).toThrow(/UNIQUE/)
    expect(() => runMigrations(db)).not.toThrow()
    for (const row of expected.channel_bots) Object.assign(row, { authorization_revision: null, connection_generation: null, platform_display_name: null });
    expect(snapshot(db)).toEqual(expected)
  })

  for (const foreignKeys of [0, 1]) {
    it.each(references)(`rolls back a broken %s.%s before commit and restores FK=${foreignKeys}`, (table, column) => {
      const db = legacy()
      const before = snapshot(db)
      const beforeSchema = definition(db)
      db.pragma(`foreign_keys = ${foreignKeys}`)
      expect(() => withMigrationTransaction(db, () => {
        runMigrations(db)
        db.exec(`UPDATE ${table} SET ${column}='missing' WHERE rowid=(SELECT MIN(rowid) FROM ${table})`)
      })).toThrow(/DATABASE_MIGRATION_FOREIGN_KEY_CHECK_FAILED/)
      expect(snapshot(db)).toEqual(before)
      expect(definition(db)).toBe(beforeSchema)
      expect(version(db)).toBe(14)
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name IN ('execution_authority','schedule_definitions_rebrand')").all()).toEqual([])
      expect(db.pragma('foreign_keys', { simple: true })).toBe(foreignKeys)
      expect(db.pragma('foreign_key_check')).toEqual([])
    })
  }

  it.each([0, 1])('rejects pre-existing dangling rows even when original FK=%i', foreignKeys => {
    const db = legacy()
    db.exec("UPDATE schedule_watermarks SET schedule_definition_id='missing' WHERE schedule_definition_id='one'")
    const before = snapshot(db)
    db.pragma(`foreign_keys = ${foreignKeys}`)
    expect(() => runMigrations(db)).toThrow(/DATABASE_MIGRATION_FOREIGN_KEY_CHECK_FAILED/)
    expect(snapshot(db)).toEqual(before)
    expect(version(db)).toBe(14)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(foreignKeys)
    expect(db.pragma('foreign_key_check')).toHaveLength(1)
  })

  it('rejects an uncontrolled FK-enabled outer transaction before any schema write', () => {
    const db = open()
    db.pragma('foreign_keys = ON')
    expect(() => db.transaction(() => runMigrations(db))()).toThrow(/DATABASE_MIGRATION_REQUIRES_FOREIGN_KEYS_DISABLED/)
    expect(db.prepare('SELECT name FROM sqlite_schema').all()).toEqual([])
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(() => db.transaction(() => withMigrationTransaction(db, () => {}))()).toThrow(/DATABASE_MIGRATION_REQUIRES_OUTER_TRANSACTION/)
  })

  it('rolls back FK inspection errors and restores the original setting', () => {
    const db = legacy()
    const before = snapshot(db)
    const failure = new Error('injected foreign key inspection failure')
    const pragma = db.pragma.bind(db)
    db.pragma('foreign_keys = ON')
    vi.spyOn(db, 'pragma').mockImplementation((sql, options) => {
      if (sql === 'foreign_key_check') throw failure
      return pragma(sql, options)
    })
    expect(() => runMigrations(db)).toThrow(failure)
    expect(snapshot(db)).toEqual(before)
    expect(version(db)).toBe(14)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('closes an unsafe connection and preserves both migration and restoration errors', () => {
    const db = open()
    db.pragma('foreign_keys = ON')
    const migrationFailure = new Error('injected migration failure')
    const restoreFailure = new Error('injected restore failure')
    const pragma = db.pragma.bind(db)
    vi.spyOn(db, 'pragma').mockImplementation((sql, options) => {
      if (sql === 'foreign_keys = 1') throw restoreFailure
      return pragma(sql, options)
    })
    let failure: unknown
    try { withMigrationTransaction(db, () => { throw migrationFailure }) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([migrationFailure, restoreFailure])
    expect(db.open).toBe(false)
  })

  it('keeps the opener in recovery after an FK failure, then reopens the unchanged legacy data', () => {
    const path = file()
    const initial = legacy(path)
    const before = snapshot(initial)
    initial.close()
    const pragma = Database.prototype.pragma
    vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (this: Database.Database, sql, options) {
      if (sql === 'foreign_key_check') this.exec("UPDATE schedule_occurrences SET schedule_generation_id='missing' WHERE id='oone'")
      return pragma.call(this, sql, options)
    })
    expect(() => createRepositories(path, { newDatabaseAuthority: 'ledger_v1' })).toThrow(/DATABASE_MIGRATION_FOREIGN_KEY_CHECK_FAILED/)
    vi.restoreAllMocks()
    const inspect = open(path)
    expect(snapshot(inspect)).toEqual(before)
    expect(version(inspect)).toBe(14)
    expect(inspect.prepare('SELECT phase FROM dutydeck_control').pluck().get()).toBe('recovery')
    expect(inspect.prepare('SELECT COUNT(*) FROM dutydeck_access').pluck().get()).toBe(0)
    inspect.close()
    const repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' })
    try { expect(repos.execution.authority()).toBe('legacy') } finally { repos.close() }
    expect(version(open(path))).toBe(19)
  })
})
