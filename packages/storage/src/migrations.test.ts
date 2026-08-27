import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { AgentConfig } from '@dockmux/shared'
import { createRepositories } from './index.js'
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
    expect(migrations.map(migration => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('creates all tables and records every migration on a fresh database', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const tables = tableNames(db)
    for (const name of [...BUSINESS_TABLES, 'schema_migrations']) expect(tables).toContain(name)
    const rows = db.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version').all() as Array<{ version: number; applied_at: string }>
    expect(rows).toHaveLength(8)
    expect(rows.map(row => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    for (const row of rows) expect(row.applied_at).toBeTruthy()
    db.close()
  })

  it('is idempotent when run twice', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    expect(() => runMigrations(db)).not.toThrow()
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
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
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    db.close()
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
