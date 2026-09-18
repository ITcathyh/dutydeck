import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentConfig } from '@dutydeck/shared'
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
  'configs',
  'secret_refs',
  'channel_bots',
  'foundation_entity_versions',
  'channel_bot_policies',
  'group_bindings',
  'remote_chat_facts',
  'remote_identity_facts',
  'role_assignments',
  'wp1a_entity_versions',
  'schedule_definitions',
  'schedule_generations',
  'schedule_occurrences',
  'schedule_watermarks',
  'schedule_leases',
  'archived_integrations',
  'schedule_entity_versions',
  'collaboration_scopes',
  'collaboration_settings',
  'collaboration_observations',
  'collaboration_bootstraps',
  'collaboration_followups',
  'collaboration_mandates',
  'collaboration_decisions',
  'collaboration_feedbacks',
  'collaboration_actions',
  'collaboration_activities'
]

const SESSION_PATCH_COLUMNS = ['reasoning_effort', 'system_prompt', 'permission_mode', 'source', 'source_id', 'archived_at']
const ALL_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]
const temporaryDirectories: string[] = []
const linuxIt = process.platform === 'linux' ? it : it.skip

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777
}

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

  it('upgrades v13 remote chat facts without loss and expires unbound legacy rows', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
    for (const migration of migrations.slice(0, 13)) {
      migration.up(db)
      record.run(migration.version, '2026-01-01T00:00:00.000Z')
    }
    db.prepare('INSERT INTO secret_refs (id, schema_version, revision, kind, provider, reference_key, status, created_at, updated_at) VALUES (?, 1, 1, ?, ?, ?, ?, ?, ?)')
      .run('secret_legacy', 'lark_app_secret', 'keychain', 'synthetic-reference', 'configured', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO channel_bots (id, schema_version, revision, channel, external_app_id, display_name, brand, credential_ref, state, desired_listener_state, full_trust_confirmed, created_at, updated_at) VALUES (?, 1, 1, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)')
      .run('bot_legacy', 'lark', 'synthetic-app', 'Legacy Bot', 'feishu', 'secret_legacy', 'staged', 'disabled', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO remote_chat_facts (id, schema_version, revision, channel_bot_id, external_chat_id, membership_state, chat_type, display_name, observed_at, last_success_at, error_code, created_at, updated_at) VALUES (?, 1, 1, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)')
      .run('chat_legacy', 'bot_legacy', 'synthetic-chat', 'member', 'group', 'Synthetic Legacy Group', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')

    runMigrations(db)

    expect(db.prepare('SELECT external_chat_id, display_name, expires_at, credential_ref_id, identity_fact_id FROM remote_chat_facts WHERE id = ?').get('chat_legacy')).toEqual({
      external_chat_id: 'synthetic-chat',
      display_name: 'Synthetic Legacy Group',
      expires_at: '1970-01-01T00:00:00.000Z',
      credential_ref_id: null,
      identity_fact_id: null
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM remote_identity_facts').get()).toEqual({ count: 0 })
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

  it('adds v11 foundation tables without rewriting v10 legacy data', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
    for (const migration of migrations.slice(0, 10)) {
      migration.up(db)
      record.run(migration.version, '2026-01-01T00:00:00.000Z')
    }
    const agentJson = JSON.stringify({ id: 'legacy-agent', command: 'legacy-command', env: { PRIVATE_TOKEN: 'migration-canary' } })
    const botsJson = JSON.stringify([{ appId: 'cli_legacy', appSecret: 'legacy-secret-canary', listening: false }])
    db.prepare('INSERT INTO agent_configs (id, json, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('legacy-agent', agentJson, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO configs (key, value) VALUES (?, ?)').run('lark.bots', botsJson)
    db.prepare('INSERT INTO sessions (id, agent_id, state, cwd, permission_mode, run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('legacy-session', 'legacy-agent', 'idle', '/legacy/workspace', 'ask', 'legacy-run', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')

    runMigrations(db)

    expect(db.prepare('SELECT json FROM agent_configs WHERE id = ?').get('legacy-agent')).toEqual({ json: agentJson })
    expect(db.prepare('SELECT value FROM configs WHERE key = ?').get('lark.bots')).toEqual({ value: botsJson })
    expect(db.prepare('SELECT agent_id, state, cwd, permission_mode, run_id FROM sessions WHERE id = ?').get('legacy-session'))
      .toEqual({ agent_id: 'legacy-agent', state: 'idle', cwd: '/legacy/workspace', permission_mode: 'ask', run_id: 'legacy-run' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM secret_refs').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM channel_bots').get()).toEqual({ count: 0 })
    expect(columnNames(db, 'secret_refs')).not.toContain('value')
    expect(columnNames(db, 'secret_refs')).not.toContain('secret')
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS)
    db.close()
  })

  it('adds v12 group-policy tables without changing v11 or legacy rows', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
    for (const migration of migrations.slice(0, 11)) {
      migration.up(db)
      record.run(migration.version, '2026-08-30T00:00:00.000Z')
    }
    db.prepare('INSERT INTO agent_configs (id, json, created_at, updated_at) VALUES (?, ?, ?, ?)').run('legacy-v12', '{"private":"unchanged"}', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z')
    db.prepare(`INSERT INTO channel_bots (id, schema_version, revision, channel, external_app_id, display_name, brand, state, desired_listener_state, full_trust_confirmed, created_at, updated_at) VALUES (?, 1, 1, 'lark', ?, ?, 'feishu', 'disabled', 'disabled', 0, ?, ?)`)
      .run('bot-v11', 'cli_v11', 'V11 Bot', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z')

    runMigrations(db)

    expect(db.prepare('SELECT json FROM agent_configs WHERE id = ?').get('legacy-v12')).toEqual({ json: '{"private":"unchanged"}' })
    expect(db.prepare('SELECT revision, state, desired_listener_state, full_trust_confirmed FROM channel_bots WHERE id = ?').get('bot-v11'))
      .toEqual({ revision: 1, state: 'disabled', desired_listener_state: 'disabled', full_trust_confirmed: 0 })
    for (const table of ['channel_bot_policies', 'group_bindings', 'remote_chat_facts', 'role_assignments']) expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS)
    db.close()
  })

  it('v15 把 v13 写死在 CHECK 约束里的旧品牌名重建掉，并改写已有行', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
    for (const migration of migrations.slice(0, 14)) {
      migration.up(db)
      record.run(migration.version, '2026-09-01T00:00:00.000Z')
    }
    db.prepare(`INSERT INTO channel_bots (id, schema_version, revision, channel, external_app_id, display_name, brand, state, desired_listener_state, full_trust_confirmed, created_at, updated_at) VALUES (?, 1, 1, 'lark', ?, ?, 'feishu', 'disabled', 'disabled', 0, ?, ?)`)
      .run('bot-legacy', 'cli_legacy', 'Legacy Bot', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
    // 还原成改名前的落盘形态：v13 当时把 'dockmux' 写进了约束，老库磁盘上至今还是它。
    const original = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'schedule_definitions'").get() as { sql: string }
    db.exec('DROP TABLE schedule_definitions')
    db.exec(original.sql.replace("'dutydeck'", "'dockmux'"))
    db.prepare(`INSERT INTO schedule_definitions (
      id, schema_version, revision, channel_bot_id, name, trigger_kind, interval_seconds, interval_anchor_at,
      timezone, dst_gap_policy, dst_overlap_policy, delivery_mode, chat_ref, continuation_policy, payload_ref,
      source_ownership, source_namespace, source_enabled, state, desired_executor_state, current_generation,
      created_at, updated_at
    ) VALUES (?, 1, 1, ?, ?, 'interval', 3600, ?, 'Asia/Shanghai', 'skip', 'first', 'chat', ?, 'same_thread', ?, 'dockmux', 'ns', 1, 'staged', 'disabled', 1, ?, ?)`)
      .run('sched-legacy', 'bot-legacy', '旧库里的排程', '2026-09-01T00:00:00.000Z', 'chat-1', 'payload-1',
           '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')

    runMigrations(db)

    const rebuilt = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'schedule_definitions'").get() as { sql: string }
    expect(rebuilt.sql).toContain("source_ownership IN ('dutydeck', 'botmux')")
    expect(rebuilt.sql).not.toContain("'dockmux'")
    expect(db.prepare('SELECT source_ownership, name FROM schedule_definitions WHERE id = ?').get('sched-legacy'))
      .toEqual({ source_ownership: 'dutydeck', name: '旧库里的排程' })
    // 索引必须跟着重建回来，否则唯一性保护在重建后就没了
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='schedule_definitions'").all() as Array<{ name: string }>).map(row => row.name)
    expect(indexes).toContain('schedule_definitions_source')
    expect(indexes).toContain('schedule_definitions_bot_state')
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS)
    db.close()
  })

  it('v15 在已经是新名字的库上什么都不做', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const before = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'schedule_definitions'").get() as { sql: string }
    runMigrations(db)
    const after = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'schedule_definitions'").get() as { sql: string }
    expect(after.sql).toBe(before.sql)
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS)
    db.close()
  })

  it('v16 给 tasks 补 interrupted_by_actor 列，旧任务读回为 undefined', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
    for (const migration of migrations.slice(0, 15)) {
      migration.up(db)
      record.run(migration.version, '2026-09-01T00:00:00.000Z')
    }
    db.prepare('INSERT INTO tasks (id, session_id, prompt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('task_legacy', 'ses_legacy', 'old', 'running', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')

    runMigrations(db)

    expect(columnNames(db, 'tasks')).toContain('interrupted_by_actor')
    // 迁移前的历史行该列为 NULL，仓储读出归一化为缺省而非 null。
    expect(db.prepare('SELECT interrupted_by_actor FROM tasks WHERE id = ?').get('task_legacy'))
      .toEqual({ interrupted_by_actor: null })
    db.close()
  })

  it('v17 给 tasks 补 queue_position 列并保持可空', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
    for (const migration of migrations.slice(0, 16)) {
      migration.up(db)
      record.run(migration.version, '2026-09-01T00:00:00.000Z')
    }
    db.prepare('INSERT INTO tasks (id, session_id, prompt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('task_running', 'ses_a', 'running task', 'running', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')

    runMigrations(db)

    expect(columnNames(db, 'tasks')).toContain('queue_position')
    // 非 queued 任务不回填，保持 NULL。
    expect(db.prepare('SELECT queue_position FROM tasks WHERE id = ?').get('task_running'))
      .toEqual({ queue_position: null })
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS)
    db.close()
  })

  it('v17 按每 session created_at、rowid 稳定顺序给存量 queued 任务回填 1..N', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
    for (const migration of migrations.slice(0, 16)) {
      migration.up(db)
      record.run(migration.version, '2026-09-01T00:00:00.000Z')
    }
    const insert = db.prepare('INSERT INTO tasks (id, session_id, prompt, status, execution_context, interrupted_by_actor, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    // ses_a：三个 queued，created_at 相同，靠 rowid 决定先后；一个 running 不参与。
    insert.run('a1', 'ses_a', 'a-one', 'queued', null, null, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
    insert.run('a2', 'ses_a', 'a-two', 'queued', null, null, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
    insert.run('a3', 'ses_a', 'a-three', 'running', null, null, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
    insert.run('a4', 'ses_a', 'a-four', 'queued', null, null, '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z')
    // ses_b：独立从 1 开始。
    insert.run('b1', 'ses_b', 'b-one', 'queued', null, null, '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z')
    // 已经有位置的 queued 行不被回填改动。模拟列已存在的库：手工补列后预置 42，
    // v17 的 ensureColumn 会跳过补列，回填只处理 NULL 位置行。
    insert.run('b2', 'ses_b', 'b-two', 'queued', null, null, '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z')
    db.exec('ALTER TABLE tasks ADD COLUMN queue_position INTEGER')
    db.prepare('UPDATE tasks SET queue_position = 42 WHERE id = ?').run('b2')

    runMigrations(db)

    const positions = (ids: string[]) => ids.map(id => {
      const row = db.prepare('SELECT queue_position, created_at, updated_at, status, execution_context FROM tasks WHERE id = ?').get(id) as Record<string, unknown>
      return [id, row.queue_position]
    })
    expect(positions(['a1', 'a2', 'a4'])).toEqual([['a1', 1], ['a2', 2], ['a4', 3]])
    expect(db.prepare('SELECT queue_position FROM tasks WHERE id = ?').get('a3')).toEqual({ queue_position: null })
    expect(db.prepare('SELECT queue_position FROM tasks WHERE id = ?').get('b1')).toEqual({ queue_position: 1 })
    // 已有位置不被覆盖。
    expect(db.prepare('SELECT queue_position FROM tasks WHERE id = ?').get('b2')).toEqual({ queue_position: 42 })
    // 其他字段不被迁移改写。
    const untouched = db.prepare('SELECT created_at, updated_at, status, execution_context FROM tasks WHERE id = ?').get('a1')
    expect(untouched).toEqual({
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
      status: 'queued',
      execution_context: null
    })
    db.close()
  })

  it('v17 重复执行迁移不改变已回填顺序', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
    for (const migration of migrations.slice(0, 16)) {
      migration.up(db)
      record.run(migration.version, '2026-09-01T00:00:00.000Z')
    }
    db.prepare('INSERT INTO tasks (id, session_id, prompt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('q1', 'ses_a', 'one', 'queued', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
    db.prepare('INSERT INTO tasks (id, session_id, prompt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('q2', 'ses_a', 'two', 'queued', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z')

    runMigrations(db)
    const afterFirst = db.prepare('SELECT id, queue_position FROM tasks ORDER BY queue_position').all()
    runMigrations(db)
    const afterSecond = db.prepare('SELECT id, queue_position FROM tasks ORDER BY queue_position').all()
    expect(afterSecond).toEqual(afterFirst)
    expect(afterSecond).toEqual([
      { id: 'q1', queue_position: 1 },
      { id: 'q2', queue_position: 2 }
    ])
    db.close()
  })

  it('v17 在缺 tasks 表的模拟夹具上按既有模式跳过', () => {
    const db = new Database(':memory:')
    // 模拟 v16 测试夹具：手工标记迁移已应用，但根本没有 tasks 表。
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
    for (let version = 1; version <= 16; version++) record.run(version, '2026-09-01T00:00:00.000Z')
    expect(() => migrations[16]!.up(db)).not.toThrow()
    expect(tableNames(db)).not.toContain('tasks')
    db.close()
  })

  it('adds v13 Schedule ledgers as disabled control-plane tables without creating runtime work', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
    for (const migration of migrations.slice(0, 12)) {
      migration.up(db)
      record.run(migration.version, '2026-08-30T00:00:00.000Z')
    }
    db.prepare(`INSERT INTO channel_bots (id, schema_version, revision, channel, external_app_id, display_name, brand, state, desired_listener_state, full_trust_confirmed, created_at, updated_at) VALUES (?, 1, 1, 'lark', ?, ?, 'feishu', 'disabled', 'disabled', 0, ?, ?)`).run('bot-v13', 'cli_v13', 'V13 Bot', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z')

    runMigrations(db)

    for (const table of ['schedule_definitions', 'schedule_generations', 'schedule_occurrences', 'schedule_watermarks', 'schedule_leases', 'archived_integrations']) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
    }
    expect(db.prepare('SELECT revision, state, desired_listener_state FROM channel_bots WHERE id = ?').get('bot-v13')).toEqual({ revision: 1, state: 'disabled', desired_listener_state: 'disabled' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 })
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS)
    db.close()
  })

  it('v22 给按旧 v20 建好的库补上判定预算列，默认 60 且不动已有行', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
    for (const migration of migrations.slice(0, 20)) {
      migration.up(db)
      record.run(migration.version, '2026-09-01T00:00:00.000Z')
    }
    // 旧版 v20 建表没有这一列，现在的 v20 已经带上；删掉才能还原线上旧库的形态。
    db.exec('ALTER TABLE collaboration_settings DROP COLUMN max_decisions_per_hour')
    db.prepare(`INSERT INTO collaboration_settings (app_id, chat_id, revision, participation, instructions, notifications_paused, max_proactive_per_hour, retention_days, policy_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('cli_legacy', 'oc_legacy', 3, 'observe', '旧群指令', 0, 2, 30, 'v1', '2026-09-01T00:00:00.000Z')

    runMigrations(db)

    expect(columnNames(db, 'collaboration_settings')).toContain('max_decisions_per_hour')
    expect(db.prepare('SELECT participation, instructions, max_proactive_per_hour, max_decisions_per_hour FROM collaboration_settings WHERE app_id = ?').get('cli_legacy'))
      .toEqual({ participation: 'observe', instructions: '旧群指令', max_proactive_per_hour: 2, max_decisions_per_hour: 60 })
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS)
    db.close()
  })

  it('creates a consistent one-time backup before the irreversible v10 table rebuild', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dutydeck-migration-backup-'))
    temporaryDirectories.push(directory)
    const filename = join(directory, 'dutydeck.db')
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

  linuxIt('creates a private database directory and SQLite files without changing its parent mode', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dutydeck-storage-permissions-'))
    temporaryDirectories.push(parent)
    await chmod(parent, 0o755)
    const directory = join(parent, 'private-data')
    const filename = join(directory, 'dutydeck.db')

    const repositories = createRepositories(filename)
    await repositories.config.set('credential', 'secret')

    expect(await mode(parent)).toBe(0o755)
    expect(await mode(directory)).toBe(0o700)
    expect(await mode(filename)).toBe(0o600)
    expect(existsSync(`${filename}-wal`)).toBe(true)
    expect(existsSync(`${filename}-shm`)).toBe(true)
    expect(await mode(`${filename}-wal`)).toBe(0o600)
    expect(await mode(`${filename}-shm`)).toBe(0o600)
    repositories.close()
  })

  linuxIt('tightens an existing .dutydeck directory, database, sidecars, and backup only', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dutydeck-storage-existing-'))
    temporaryDirectories.push(parent)
    await chmod(parent, 0o755)
    const directory = join(parent, '.dutydeck')
    const filename = join(directory, 'dutydeck.db')
    await mkdir(directory, { mode: 0o755 })

    const initial = new Database(filename)
    runMigrations(initial)
    initial.close()
    const backupFilename = `${filename}${PRE_V10_BACKUP_SUFFIX}`
    await writeFile(backupFilename, 'stale-sensitive-data', { mode: 0o644 })
    await chmod(filename, 0o644)

    const repositories = createRepositories(filename)
    expect(await mode(parent)).toBe(0o755)
    expect(await mode(directory)).toBe(0o700)
    expect(await mode(filename)).toBe(0o600)
    expect(await mode(backupFilename)).toBe(0o600)
    const journalFilename = `${filename}-journal`
    await writeFile(journalFilename, 'runtime-sensitive-data', { mode: 0o644 })
    repositories.close()
    // The final control transaction may remove SQLite's obsolete rollback journal.
    // If retained, its permissions must remain private.
    expect(await mode(journalFilename).catch(error => error.code === 'ENOENT' ? 0o600 : Promise.reject(error))).toBe(0o600)
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
