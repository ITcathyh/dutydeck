import type Database from 'better-sqlite3'

export interface Migration {
  version: number
  name: string
  up(db: Database.Database): void
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>
  if (!columns.some(entry => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up(db) {
      db.exec(`
    CREATE TABLE IF NOT EXISTS agent_configs (id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, name TEXT NOT NULL, metadata TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, machine_id TEXT, name TEXT NOT NULL, cwd TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, state TEXT NOT NULL, cwd TEXT NOT NULL, model TEXT, reasoning_effort TEXT, system_prompt TEXT, permission_mode TEXT DEFAULT 'full-trust', source TEXT, source_id TEXT, archived_at TEXT, protocol TEXT, run_id TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL, timestamp TEXT NOT NULL, data TEXT NOT NULL, raw TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS events_session_seq ON events(session_id, sequence);
    CREATE TABLE IF NOT EXISTS tool_calls (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS permission_requests (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS errors (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message TEXT NOT NULL, details TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS channel_mappings (id TEXT PRIMARY KEY, channel TEXT NOT NULL, external_id TEXT NOT NULL, session_id TEXT NOT NULL, extra TEXT, created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS channel_external ON channel_mappings(channel, external_id);
    CREATE TABLE IF NOT EXISTS configs (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)
    }
  },
  {
    version: 2,
    name: 'sessions_add_reasoning_effort',
    up(db) { ensureColumn(db, 'sessions', 'reasoning_effort', 'reasoning_effort TEXT') }
  },
  {
    version: 3,
    name: 'sessions_add_system_prompt',
    up(db) { ensureColumn(db, 'sessions', 'system_prompt', 'system_prompt TEXT') }
  },
  {
    version: 4,
    name: 'sessions_add_permission_mode',
    up(db) { ensureColumn(db, 'sessions', 'permission_mode', "permission_mode TEXT DEFAULT 'full-trust'") }
  },
  {
    version: 5,
    name: 'sessions_add_source',
    up(db) { ensureColumn(db, 'sessions', 'source', 'source TEXT') }
  },
  {
    version: 6,
    name: 'sessions_add_source_id',
    up(db) { ensureColumn(db, 'sessions', 'source_id', 'source_id TEXT') }
  },
  {
    version: 7,
    name: 'sessions_add_archived_at',
    up(db) { ensureColumn(db, 'sessions', 'archived_at', 'archived_at TEXT') }
  },
  {
    version: 8,
    name: 'channel_mappings_add_extra',
    up(db) { ensureColumn(db, 'channel_mappings', 'extra', 'extra TEXT') }
  }
]

export function runMigrations(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
  const appliedVersions = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(row => row.version)
  )
  const recordApplied = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue
    db.transaction(() => {
      migration.up(db)
      recordApplied.run(migration.version, new Date().toISOString())
    })()
  }
}
