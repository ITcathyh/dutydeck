import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentConfig } from '@dockmux/shared'
import { createRepositories, PRE_V10_BACKUP_SUFFIX } from './index.js'
import { migrations, runMigrations } from './migrations.js'

const BUSINESS_TABLES = [
  'agent_configs',
  'machines',
  'projects',
  'sessions',
  'tasks',
  'events',
  'tool_calls',
  'permission_requests',
  'errors',
  'channel_mappings',
  'configs'
]

const SESSION_PATCH_COLUMNS = ['reasoning_effort', 'system_prompt', 'permission_mode', 'source', 'source_id', 'archived_at']
const ALL_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
const temporaryDirectories: string[] = []

afterEach(async () => Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))))

function tableNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name)
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(column => column.name)
}

function appliedVersions(db: Database.Database): number[] {
  return (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>).map(row => row.version)
}

describe('storage migrations', () => {
  it('declares migrations in ascending version order', () => {
    expect(migrations.map(migration => migration.version)).toEqual(ALL_VERSIONS)
  })

  it('creates all tables and records every migration on a fresh database', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const tables = tableNames(db)
    for (const name of [...BUSINESS_TABLES, 'schema_migrations']) expect(tables).toContain(name)
    const rows = db.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version').all() as Array<{ version: number; applied_at: string }>
    expect(rows).toHaveLength(ALL_VERSIONS.length)
    expect(rows.map(row => row.version)).toEqual(ALL_VERSIONS)
    for (const row of rows) expect(row.applied_at).toBeTruthy()
    db.prepare('INSERT INTO sessions (id, agent_id, state, cwd, run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('ses_default_permission', 'agent', 'idle', '/tmp', 'run', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    expect(db.prepare('SELECT permission_mode FROM sessions WHERE id = ?').get('ses_default_permission'))
      .toEqual({ permission_mode: 'ask' })
    db.close()
  })

  it('is idempotent when run twice', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    expect(() => runMigrations(db)).not.toThrow()
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS)
    db.close()
  })

  it('upgrades a legacy database missing the patched columns', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, state TEXT NOT NULL, cwd TEXT NOT NULL, run_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE channel_mappings (id TEXT PRIMARY KEY, channel TEXT NOT NULL, external_id TEXT NOT NULL, session_id TEXT NOT NULL, created_at TEXT NOT NULL);
    `)
    runMigrations(db)
    const sessionColumns = columnNames(db, 'sessions')
    for (const name of SESSION_PATCH_COLUMNS) expect(sessionColumns).toContain(name)
    expect(columnNames(db, 'channel_mappings')).toContain('extra')
    expect(columnNames(db, 'tasks')).toContain('execution_context')
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS)
    db.close()
  })

  it('upgrades a v8 database without losing queued tasks and adds the recovery index', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
    for (const migration of migrations.slice(0, 8)) {
      migration.up(db)
      record.run(migration.version, '2025-01-01T00:00:00.000Z')
    }
    db.prepare('INSERT INTO tasks (id, session_id, prompt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('task_queued', 'ses_legacy', 'keep me', 'queued', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')

    runMigrations(db)

    expect(columnNames(db, 'tasks')).toContain('execution_context')
    expect(db.prepare('SELECT prompt, status, execution_context FROM tasks WHERE id = ?').get('task_queued'))
      .toEqual({ prompt: 'keep me', status: 'queued', execution_context: null })
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'tasks_session_created'").get() as { name: string }).name)
      .toBe('tasks_session_created')
    const taskPlan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at').all('ses_legacy') as Array<{ detail: string }>
    expect(taskPlan.some(row => row.detail.includes('tasks_session_created'))).toBe(true)
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS)
    db.close()
  })

  it('upgrades a v9 database to ask-by-default without changing existing full-trust sessions', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, state TEXT NOT NULL,
        cwd TEXT NOT NULL, model TEXT, reasoning_effort TEXT, system_prompt TEXT,
        permission_mode TEXT DEFAULT 'full-trust', source TEXT, source_id TEXT,
        archived_at TEXT, protocol TEXT, run_id TEXT NOT NULL, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `)
    const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
    for (let version = 1; version <= 9; version++) record.run(version, '2025-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO sessions (id, agent_id, state, cwd, permission_mode, run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('ses_existing_full_trust', 'agent', 'idle', '/tmp', 'full-trust', 'run-old', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')

    runMigrations(db)

    expect(db.prepare('SELECT permission_mode FROM sessions WHERE id = ?').get('ses_existing_full_trust'))
      .toEqual({ permission_mode: 'full-trust' })
    db.prepare('INSERT INTO sessions (id, agent_id, state, cwd, run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('ses_future_default', 'agent', 'idle', '/tmp', 'run-new', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    expect(db.prepare('SELECT permission_mode FROM sessions WHERE id = ?').get('ses_future_default'))
      .toEqual({ permission_mode: 'ask' })
    const permissionColumn = (db.pragma('table_info(sessions)') as Array<{ name: string; dflt_value: string | null }>)
      .find(column => column.name === 'permission_mode')
    expect(permissionColumn?.dflt_value).toBe("'ask'")
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS)
    db.close()
  })

  it('creates a consistent one-time backup before the irreversible v10 table rebuild', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dockmux-migration-backup-'))
    temporaryDirectories.push(directory)
    const filename = join(directory, 'dockmux.db')
    const legacy = new Database(filename)
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, state TEXT NOT NULL,
        cwd TEXT NOT NULL, model TEXT, reasoning_effort TEXT, system_prompt TEXT,
        permission_mode TEXT DEFAULT 'full-trust', source TEXT, source_id TEXT,
        archived_at TEXT, protocol TEXT, run_id TEXT NOT NULL, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `)
    const applied = legacy.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
    for (let version = 1; version <= 9; version++) applied.run(version, '2025-01-01T00:00:00.000Z')
    legacy.prepare('INSERT INTO sessions (id, agent_id, state, cwd, permission_mode, run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('ses_preserved', 'agent', 'idle', '/workspace', 'full-trust', 'run-old', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')
    legacy.close()

    const repositories = createRepositories(filename)
    repositories.close()
    const backupFilename = `${filename}${PRE_V10_BACKUP_SUFFIX}`
    expect(existsSync(backupFilename)).toBe(true)

    const backup = new Database(backupFilename, { readonly: true })
    expect(backup.prepare('SELECT permission_mode FROM sessions WHERE id = ?').get('ses_preserved')).toEqual({ permission_mode: 'full-trust' })
    expect((backup.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version).toBe(9)
    backup.close()

    const migrated = new Database(filename, { readonly: true })
    expect((migrated.pragma('table_info(sessions)') as Array<{ name: string; dflt_value: string | null }>).find(column => column.name === 'permission_mode')?.dflt_value).toBe("'ask'")
    migrated.close()

    const backupMtime = (await stat(backupFilename)).mtimeMs
    const reopened = createRepositories(filename)
    reopened.close()
    expect((await stat(backupFilename)).mtimeMs).toBe(backupMtime)
  })

  it('createRepositories runs migrations and round-trips agents', async () => {
    const repos = createRepositories(':memory:')
    const agent: AgentConfig = { id: 'a1', name: 'Agent One', command: 'echo', args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 30, capabilities: { pause: false, resume: false }, builtin: false }
    await repos.agents.save(agent)
    const listed = await repos.agents.list()
    expect(listed.map(item => item.id)).toContain('a1')
    expect(listed.find(item => item.id === 'a1')?.name).toBe('Agent One')
    repos.close()
  })
})
