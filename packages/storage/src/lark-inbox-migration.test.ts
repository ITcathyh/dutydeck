import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createRepositories } from './index.js'
import { migrations, runMigrations, withMigrationTransaction } from './migrations.js'
import { PRUNE_IGNORED_SQL, SLIM_IGNORED_SQL } from './lark-inbox.js'

const card = JSON.stringify({ schema: '2.0', body: { elements: Array.from({ length: 200 }, (_, index) => ({ tag: 'markdown', content: `告警第 ${index} 行` })) } })
const inbox = (messageId: string, state: string, senderType: string, content: string, extra: Record<string, unknown> = {}) => [`lark.inbox.cli_app.${messageId}`,
  JSON.stringify({ appId: 'cli_app', event: { messageId, chatId: 'oc_chat', chatType: 'group', senderType, messageType: senderType === 'bot' ? 'interactive' : 'text', content, mentions: [] }, boot: '', state, receivedAt: '2026-11-05T00:00:00.000Z', ...extra })] as const

it('v48 only adds indexes: existing receipts stay byte-for-byte, and only receipts marked after upgrade lose their body once due', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lark-inbox-v48-'))
  const path = join(directory, 'db.sqlite')
  try {
    const legacy = new Database(path)
    legacy.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)')
    withMigrationTransaction(legacy, () => { for (const migration of migrations.filter(item => item.version <= 46)) { migration.up(legacy); legacy.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(migration.version, '2026-11-01') } })
    const rows = [
      inbox('om_bot_card', 'ignored', 'bot', card, { reason: 'bot_message', disposition: { schemaVersion: 1, reason: 'bot_message' }, duplicateCount: 2 }),
      inbox('om_human', 'ignored', 'user', JSON.stringify({ text: '真人消息' }), { reason: 'participation_confirmation' }),
      inbox('om_bot_accepted', 'accepted', 'bot', card, { taskId: 'task_1' }),
      ['lark.inbox.cli_app.om_broken', '{not json'],
      ['other.config', JSON.stringify({ state: 'ignored', event: { senderType: 'bot', content: card } })]
    ]
    for (const [key, value] of rows) legacy.prepare('INSERT INTO configs VALUES (?,?)').run(key, value)
    legacy.close()

    const repos = createRepositories(path)
    const due = '2026-11-05T01:00:00.000Z'
    await repos.config.set('lark.inbox.cli_app.om_new_bot', inbox('om_new_bot', 'ignored', 'app', JSON.stringify({ text: '机器人文本'.repeat(100) }), { bodyExpiresAt: due })[1])
    await repos.config.set('lark.inbox.cli_app.om_new_plain', inbox('om_new_plain', 'ignored', 'bot', 'not json at all', { bodyExpiresAt: '2026-11-05T03:00:00.000Z' })[1])
    expect(await repos.config.pruneIgnoredLarkInbox!('cli_app', { receivedBefore: '2026-10-01T00:00:00.000Z', keep: 60_000, now: '2026-11-05T02:00:00.000Z' })).toEqual({ removed: 0, slimmed: 1 })
    expect(JSON.parse((await repos.config.get('lark.inbox.cli_app.om_new_bot'))!)).toEqual({ ...JSON.parse(inbox('om_new_bot', 'ignored', 'app', '', {})[1]), snippet: '机器人文本'.repeat(100).slice(0, 160) })
    expect(JSON.parse((await repos.config.get('lark.inbox.cli_app.om_new_plain'))!).event.content).toBe('not json at all')
    await repos.config.pruneIgnoredLarkInbox!('cli_app', { receivedBefore: '2026-10-01T00:00:00.000Z', keep: 60_000, now: '2026-11-05T04:00:00.000Z' })
    expect(JSON.parse((await repos.config.get('lark.inbox.cli_app.om_new_plain'))!)).toMatchObject({ snippet: 'not json at all', event: { content: '' } })
    repos.close()

    const db = new Database(path)
    const read = (key: string) => (db.prepare('SELECT value FROM configs WHERE key=?').get(key) as { value: string }).value
    for (const [key, value] of rows) expect(read(key)).toBe(value)
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(50)
    const snapshot = db.prepare('SELECT key,value FROM configs ORDER BY key').all()
    runMigrations(db)
    db.close()
    createRepositories(path).close()
    const reopened = new Database(path)
    expect(reopened.prepare('SELECT key,value FROM configs ORDER BY key').all()).toEqual(snapshot)
    const indexes = (reopened.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'config_lark_inbox_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
    expect(indexes).toEqual(['config_lark_inbox_body', 'config_lark_inbox_ignored', 'config_lark_inbox_reason', 'config_lark_inbox_state'])
    const plan = (sql: string, params: Record<string, unknown>) => JSON.stringify(reopened.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params))
    const prefix = 'lark.inbox.cli_app.'
    const prune = plan(PRUNE_IGNORED_SQL, { prefix, app: 'cli_app', bot: 1, before: '2026-10-01', keep: 60_000 })
    // 删除按（机器人、state、类别）定位再按时间取范围；边界只在覆盖索引里数到第 keep 名（排序的临时表只有两行候选边界）。
    expect(prune).toContain('SEARCH configs USING INDEX config_lark_inbox_ignored (<expr>=? AND <expr>=? AND <expr>=? AND <expr><?)')
    expect(prune).toContain('SEARCH configs USING COVERING INDEX config_lark_inbox_ignored')
    expect(prune).not.toContain('SCAN configs')
    const slim = plan(SLIM_IGNORED_SQL, { prefix, app: 'cli_app', now: '2026-11-05' })
    expect(slim).toContain('SEARCH configs USING INDEX config_lark_inbox_body')
    expect(slim).not.toContain('SCAN configs')
    reopened.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('projects only requested inbox fields and filters by indexed state', async () => {
  const repos = createRepositories(':memory:')
  try {
    for (const [key, value] of [inbox('om_a', 'ignored', 'bot', card), inbox('om_b', 'received', 'user', '{"text":"hi"}', { receiptOrder: 3, resourceDirectories: null })]) await repos.config.set(key, value)
    await repos.config.set('lark.inbox.cli_other.om_c', inbox('om_c', 'received', 'user', '{}')[1])
    expect(await repos.config.listJsonFields!('lark.inbox.cli_app.', ['state', 'event.senderType', 'receiptOrder', 'resourceDirectories', 'missing.path'])).toEqual([
      { key: 'lark.inbox.cli_app.om_a', fields: { state: 'ignored', 'event.senderType': 'bot', receiptOrder: undefined, resourceDirectories: undefined, 'missing.path': undefined } },
      { key: 'lark.inbox.cli_app.om_b', fields: { state: 'received', 'event.senderType': 'user', receiptOrder: 3, resourceDirectories: null, 'missing.path': undefined } }
    ])
    expect((await repos.config.listJsonFields!('lark.inbox.', ['appId'], { field: 'state', values: ['received'] })).map(row => row.key)).toEqual(['lark.inbox.cli_app.om_b', 'lark.inbox.cli_other.om_c'])
    expect((await repos.config.listByJsonField!('lark.inbox.cli_app.', { field: 'state', values: ['received'] })).map(row => row.key)).toEqual(['lark.inbox.cli_app.om_b'])
    await expect(repos.config.listJsonFields!('lark.inbox.', ["state') OR 1=1 --"])).rejects.toThrow('Invalid JSON field paths')
  } finally { repos.close() }
})

// 已升级的库按这份原文建过 v48 索引：原文不能改，否则已升级的库和新建的库表达式对不上（INDEXED BY 报错、其他查询退回全表扫描）。
// 要换表达式就追加新迁移重建索引，再更新这份快照。
const V48_INDEX_SQL = [
  { name: "config_lark_inbox_body", sql: "CREATE INDEX config_lark_inbox_body ON configs(json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END,'$.appId'),json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END,'$.bodyExpiresAt')) WHERE key GLOB 'lark.inbox.*'" },
  { name: "config_lark_inbox_ignored", sql: "CREATE INDEX config_lark_inbox_ignored ON configs(json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END,'$.appId'),json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END,'$.state'),(IFNULL(json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END,'$.event.senderType'),'') IN ('bot','app')),json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END,'$.receivedAt'),key) WHERE key GLOB 'lark.inbox.*'" },
  { name: "config_lark_inbox_reason", sql: "CREATE INDEX config_lark_inbox_reason ON configs(json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END,'$.disposition.reason'),key) WHERE key GLOB 'lark.inbox.*'" },
  { name: "config_lark_inbox_state", sql: "CREATE INDEX config_lark_inbox_state ON configs(json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END,'$.state'),key) WHERE key GLOB 'lark.inbox.*'" }
]

it('keeps the v48 inbox index DDL frozen and plans state and reason projections on their indexes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lark-inbox-plan-'))
  const path = join(directory, 'db.sqlite')
  try {
    const repos = createRepositories(path)
    const db = new Database(path)
    expect(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND name LIKE 'config_lark_inbox_%' ORDER BY name").all()).toEqual(V48_INDEX_SQL)
    const prefix = 'lark.inbox.cli_app.'
    for (const [field, value, index] of [['state', 'received', 'config_lark_inbox_state'], ['disposition.reason', 'participation_observes', 'config_lark_inbox_reason']] as const) {
      const spy = vi.spyOn(Database.prototype, 'prepare')
      await repos.config.listJsonFields!(prefix, ['appId', 'receivedAt'], { field, values: [value] })
      const sql = spy.mock.calls.map(([text]) => text).find(text => text.includes('json_valid(value) AS valid'))!
      spy.mockRestore()
      const plan = JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('$.appId', '$.receivedAt', prefix, prefix, value))
      expect(plan).toContain(`SEARCH configs USING INDEX ${index} (<expr>=? AND key>? AND key<?)`)
      expect(plan).not.toContain('SCAN configs')
    }
    const spy = vi.spyOn(Database.prototype, 'prepare')
    await repos.config.listJsonFields!(prefix, ['appId'], { field: 'state', values: [null] })
    const sql = spy.mock.calls.map(([text]) => text).find(text => text.includes('IS NULL'))!
    spy.mockRestore()
    expect(JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('$.appId', prefix, prefix))).toContain('INDEX config_lark_inbox_state (<expr>=?')
    db.close(); repos.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
