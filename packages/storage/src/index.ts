import { createMatterRepository } from './matters.js';
import { cachedStatement } from './statement-cache.js';
import { createWorkspaceApprovalRuleRepository } from './workspace-approval-rules.js';
export { assertDatabaseNotQuarantined, restoreQuarantinePath } from './database-control.js';
export { backupSqlite, withOfflineDatabase, BACKUP_SCHEMA_VERSION } from './offline-backup.js';
import { readHistoryOutline, readHistoryTurns } from './event-history.js';
import { listConfigByJsonField, listConfigJsonFields } from './config-query.js';
import { createPluginResultRepository } from './plugin-results.js';
import { createMemoryJobRepository } from './memory-jobs.js';
import { createWorkItemIndexRepository } from './work-item-index.js';
import { assertBotProcessConfigWrite } from './bot-process.js';
export { assertBotProcessStartup, botProcessKey, botProcessMigrationKey, type BotProcessBinding } from './bot-process.js';
export { memoryJobVersionDigest } from './memory-jobs.js';
import Database from 'better-sqlite3';
import { and, asc, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { AgentConfig, AgentEvent, RepositoryBundle, RepositoryOpenOptions, Session, TaskRecord } from '@dutydeck/shared';
import { agentConfigs, channelMappings, configs, errors, events, machines, permissionRequests, projects, sessions, tasks, toolCalls } from './schema.js';
import { deferredConfirmationId, RuntimeError, watchFindingSchema } from '@dutydeck/shared';
import { createTaskExecutionRepository } from './task-execution.js';
import { needsMigration, runMigrations, withMigrationTransaction } from './migrations.js';
import { listRecentIgnoredLarkInbox, pruneIgnoredLarkInbox } from './lark-inbox.js';
import { createFoundationRepositories } from './foundation.js';
import { createWp1aRepositories } from './group-policy.js';
import { createScheduleFoundationRepositories } from './schedule-foundation.js';
import { createCollaborationRepository } from './collaboration.js';
import { createCiWebhookRepository } from './ci-webhook.js';
import { createUsageLedgerRepository } from './usage-ledger.js';
import { createSessionInsightRepository } from './session-insight.js';
import { createRetentionRepository } from './retention.js';
import { canonicalDatabase, openDatabaseControl } from './database-control.js';
export * from './schema.js';
export * from './task-execution.js';
export * from './foundation.js';
export * from './group-policy.js';
export * from './schedule-foundation.js';
export * from './collaboration.js';
export * from './collaboration-migration.js';
export * from './scenario-legacy.js';
export * from './usage-ledger.js';
export * from './execution-inspection.js';
export { createSessionInsightRepository } from './session-insight.js';
export { createSessionInsightSchema } from './session-insight-migration.js';

export const EVENT_WINDOW_DEFAULT_LIMIT = 200;
export const EVENT_WINDOW_MAX_LIMIT = 1_000;
export const PRE_V10_BACKUP_SUFFIX = '.pre-v10.bak';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/**
 * POSIX modes do not model Windows ACLs. Avoid pretending that chmod provides
 * equivalent protection there; Windows keeps the inherited ACL of the user's
 * profile or configured data directory.
 */
function supportsPosixModes(): boolean {
  return process.platform !== 'win32';
}

function prepareDatabaseDirectory(filename: string): void {
  const directory = dirname(filename);
  const existed = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (!supportsPosixModes()) return;

  // Tighten directories created by Dutydeck and its conventional persisted
  // `.dutydeck` directory. Do not chmod an unrelated existing parent such as
  // `/tmp` when a caller explicitly stores a database directly inside it.
  if (!existed || basename(directory) === '.dutydeck') chmodSync(directory, PRIVATE_DIRECTORY_MODE);
}

function prepareDatabaseFile(filename: string): void {
  if (!supportsPosixModes()) return;
  if (!existsSync(filename)) {
    try {
      const descriptor = openSync(filename, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, PRIVATE_FILE_MODE);
      closeSync(descriptor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

function restrictDatabaseFiles(filename: string): void {
  if (!supportsPosixModes()) return;
  for (const candidate of [
    filename,
    `${filename}-wal`,
    `${filename}-shm`,
    `${filename}-journal`,
    `${filename}${PRE_V10_BACKUP_SUFFIX}`
  ]) {
    if (existsSync(candidate)) chmodSync(candidate, PRIVATE_FILE_MODE);
  }
}

function tableExists(sqlite: Database.Database, table: string) {
  return Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

/** v10 rebuilds sessions, so preserve one consistent pre-migration snapshot first. */
function backupBeforeV10(sqlite: Database.Database, filename: string) {
  if (filename === ':memory:' || !tableExists(sqlite, 'sessions')) return;
  const version = tableExists(sqlite, 'schema_migrations')
    ? (sqlite.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version?: number | null } | undefined)?.version ?? 0
    : 0;
  if (version >= 10) return;
  const backupFilename = `${filename}${PRE_V10_BACKUP_SUFFIX}`;
  if (existsSync(backupFilename)) return;
  // VACUUM INTO takes a transactionally consistent snapshot, including WAL pages.
  sqlite.exec(`VACUUM INTO '${backupFilename.replaceAll("'", "''")}'`);
}

function decodeEvent(row: typeof events.$inferSelect): AgentEvent {
  return { ...row, data: JSON.parse(row.data) } as AgentEvent;
}

type TaskRowLike = typeof tasks.$inferSelect | {
  id: string;
  session_id: string;
  prompt: string;
  status: string;
  execution_context: string | null;
  interrupted_by_actor?: string | null;
  queue_position?: number | null;
  current_attempt_id?: string | null;
  created_at: string;
  updated_at: string;
};

function decodeTask(row: TaskRowLike): TaskRecord {
  const sessionId = 'sessionId' in row ? row.sessionId : row.session_id;
  const executionContextRaw = 'executionContext' in row ? row.executionContext : row.execution_context;
  const interruptedByActor = 'interruptedByActor' in row ? row.interruptedByActor : row.interrupted_by_actor;
  const queuePosition = 'queuePosition' in row ? row.queuePosition : row.queue_position;
  const currentAttemptId = 'currentAttemptId' in row ? row.currentAttemptId : row.current_attempt_id;
  const createdAt = 'createdAt' in row ? row.createdAt : row.created_at;
  const updatedAt = 'updatedAt' in row ? row.updatedAt : row.updated_at;

  return {
    id: row.id,
    sessionId,
    prompt: row.prompt,
    status: row.status,
    executionContext: executionContextRaw ? JSON.parse(executionContextRaw) : undefined,
    ...(interruptedByActor ? { interruptedByActor } : {}),
    ...(currentAttemptId ? { currentAttemptId } : {}),
    ...(queuePosition !== null && queuePosition !== undefined ? { queuePosition } : {}),
    createdAt,
    updatedAt
  };
}

export function createRepositories(filename: string, options: RepositoryOpenOptions = {}): RepositoryBundle {
  if (filename !== ':memory:') {
    prepareDatabaseDirectory(filename);
    prepareDatabaseFile(filename);
    filename = canonicalDatabase(filename);
    restrictDatabaseFiles(filename);
  }
  const control = openDatabaseControl(filename, options);
  let sqlite: Database.Database;
  try { sqlite = new Database(filename, { timeout: options.busyTimeoutMs ?? 5_000 }); } catch (error) { control.close(); throw error; }
  try {
    sqlite.pragma('foreign_keys = ON');
    const migrate = needsMigration(sqlite) || control.needsRecovery();
    if (migrate) control.beginUpgrade();
    sqlite.pragma('journal_mode = WAL');
    // Test-only: thousands of throwaway databases otherwise spend over a tenth of the suite syncing to disk.
    if (process.env.DUTYDECK_TEST_NO_SYNC === '1') sqlite.pragma('synchronous = OFF');
    if (migrate) {
      const started = performance.now();
      backupBeforeV10(sqlite, filename);
      withMigrationTransaction(sqlite, () => {
        control.assertMaintenance(sqlite);
        const fresh = !sqlite.prepare("SELECT 1 FROM main.sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT IN ('dutydeck_control', 'dutydeck_access') LIMIT 1").get();
        runMigrations(sqlite);
        if (fresh && options.newDatabaseAuthority === 'ledger_v1') {
          const changed = sqlite.prepare("UPDATE execution_authority SET authority='ledger_v1' WHERE id=1 AND authority='legacy'").run();
          if (changed.changes !== 1) throw new RuntimeError('DATABASE_BOOTSTRAP_FAILED', 'New database authority was not initialized', 500);
        }
      });
      control.finishUpgrade();
      options.onMigrated?.(performance.now() - started);
    }
    if (filename !== ':memory:') restrictDatabaseFiles(filename);
  const db = drizzle(sqlite);
  const execution = createTaskExecutionRepository(sqlite, control);
  const legacyWrite = <T>(work: () => T): T => sqlite.transaction(() => {
    if (execution.authority() !== 'legacy') throw new RuntimeError('EXECUTION_LEDGER_REQUIRED', 'Execution writes require a bound ledger command', 409);
    return work();
  }).immediate();
  const foundationRepositories = createFoundationRepositories(sqlite);
  const wp1aRepositories = createWp1aRepositories(sqlite);
  const scheduleRepositories = createScheduleFoundationRepositories(sqlite);
  const collaboration = createCollaborationRepository(sqlite);
  const ciWebhook = createCiWebhookRepository(sqlite);
  const usage = createUsageLedgerRepository(sqlite);
  const insight = createSessionInsightRepository(sqlite, control);
  // Per-event reads: build and prepare each query once, on first use, instead of on every call.
  const once = <T>(build: () => T) => { let prepared: T | undefined; return () => (prepared ??= build()); };
  const sessionById = once(() => db.select().from(sessions).where(eq(sessions.id, sql.placeholder('id'))).prepare());
  const configByKey = once(() => db.select().from(configs).where(eq(configs.key, sql.placeholder('key'))).prepare());
  const agentById = once(() => db.select().from(agentConfigs).where(eq(agentConfigs.id, sql.placeholder('id'))).prepare());
  const taskById = once(() => db.select().from(tasks).where(eq(tasks.id, sql.placeholder('id'))).prepare());
  const tasksBySession = once(() => db.select().from(tasks).where(eq(tasks.sessionId, sql.placeholder('sessionId'))).orderBy(asc(tasks.createdAt)).prepare());
  const upsertToolCall = () => cachedStatement(sqlite, 'INSERT INTO tool_calls (id,session_id,data,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at');
  const configValue = () => cachedStatement(sqlite, 'SELECT value FROM configs WHERE key=?');
  const sessionHighWaterMark = () => cachedStatement(sqlite, 'SELECT COALESCE(MAX(sequence),0) AS sequence FROM events WHERE session_id=?');
  const insertEvent = once(() => db.insert(events).values({ id: sql.placeholder('id'), sessionId: sql.placeholder('sessionId'), sequence: sql.placeholder('sequence'), type: sql.placeholder('type'),
    timestamp: sql.placeholder('timestamp'), data: sql.placeholder('data'), raw: sql.placeholder('raw'), taskId: sql.placeholder('taskId'), attemptId: sql.placeholder('attemptId'), settlementId: sql.placeholder('settlementId') }).prepare());
  const eventsAfter = once(() => db.select().from(events).where(and(eq(events.sessionId, sql.placeholder('sessionId')), gt(events.sequence, sql.placeholder('afterSequence')))).orderBy(asc(events.sequence)).prepare());
  const deferredConfirmation = once(() => db.select().from(events).where(and(eq(events.sessionId, sql.placeholder('sessionId')), eq(events.taskId, sql.placeholder('taskId')),
    eq(events.type, 'status'), sql`${events.id} = ('deferred:' || ${events.attemptId})`)).orderBy(asc(events.sequence)).limit(1).prepare());
  const latestPermissionRequest = once(() => db.select().from(events).where(and(eq(events.sessionId, sql.placeholder('sessionId')), eq(events.taskId, sql.placeholder('taskId')),
    sql`${events.type} = 'permission_request'`,
    sql`CASE WHEN json_valid(${events.data}) THEN json_extract(${events.data}, '$.id') END = ${sql.placeholder('nativeId')}`)).orderBy(desc(events.sequence)).limit(1).prepare());
  const recentEvents = once(() => db.select().from(events).where(eq(events.sessionId, sql.placeholder('sessionId'))).orderBy(desc(events.sequence)).limit(sql.placeholder('limit')).prepare());
  const latestUsage = once(() => db.select().from(events).where(and(eq(events.sessionId, sql.placeholder('sessionId')), eq(events.type, 'status'),
    sql`json_extract(${events.data}, '$.state') = 'usage'`,
    sql`json_type(${events.data}, ${sql.placeholder('path')}) IN ('integer', 'real')`,
    sql`json_extract(${events.data}, ${sql.placeholder('path')}) >= 0`)).orderBy(desc(events.sequence)).limit(1).prepare());
  const eventWindows = new Map<string, ReturnType<typeof buildEventWindow>>();
  const buildEventWindow = (after: boolean, before: boolean, backward: boolean) => {
    const filters = [eq(events.sessionId, sql.placeholder('sessionId'))];
    if (after) filters.push(gt(events.sequence, sql.placeholder('afterSequence')));
    if (before) filters.push(lt(events.sequence, sql.placeholder('beforeSequence')));
    return db.select().from(events).where(and(...filters)).orderBy(backward ? desc(events.sequence) : asc(events.sequence)).limit(sql.placeholder('limit')).prepare();
  };
  return {
    control,
    matters: createMatterRepository(sqlite),
    workspaceApprovalRules: createWorkspaceApprovalRuleRepository(sqlite),
    execution,
    insight,
    agents: {
      async list() { return db.select().from(agentConfigs).all().map(r => JSON.parse(r.json)); },
      async get(id) { const r = agentById().get({ id }); return r ? JSON.parse(r.json) : undefined; },
      async save(agent) { const time = new Date().toISOString(); db.insert(agentConfigs).values({ id: agent.id, json: JSON.stringify(agent), createdAt: time, updatedAt: time }).onConflictDoUpdate({ target: agentConfigs.id, set: { json: JSON.stringify(agent), updatedAt: time } }).run(); },
      async delete(id) { db.delete(agentConfigs).where(eq(agentConfigs.id, id)).run(); }
    },
    sessions: {
      async list() { return db.select().from(sessions).orderBy(asc(sessions.createdAt)).all() as Session[]; },
      async get(id) { return sessionById().get({ id }) as Session | undefined; },
      async save(s) {
        sqlite.transaction(() => {
          if (execution.authority() === 'ledger_v1') {
            const current = db.select().from(sessions).where(eq(sessions.id, s.id)).get();
            if (!current) throw new RuntimeError('EXECUTION_LEDGER_REQUIRED', 'Session creation requires a bound ledger command', 409);
            for (const key of ['state', 'runId', 'archivedAt', 'error', 'agentId', 'cwd', 'source', 'sourceId', 'protocol', 'terminalBackend', 'createdAt'] as const) {
              if ((current[key] ?? null) !== (s[key] ?? null)) throw new RuntimeError('EXECUTION_LEDGER_REQUIRED', `Session ${key} requires a bound ledger command`, 409);
            }
            db.update(sessions).set({ model: s.model, reasoningEffort: s.reasoningEffort, systemPrompt: s.systemPrompt, permissionMode: s.permissionMode, updatedAt: s.updatedAt }).where(eq(sessions.id, s.id)).run();
          } else db.insert(sessions).values(s).onConflictDoUpdate({ target: sessions.id, set: s }).run();
        }).immediate();
      }
    },
    tasks: {
      async listRunSummaries() {
        // SQLite's default TRIM only removes ASCII spaces; match JS trim so a
        // whitespace-only first task never hides the first meaningful prompt.
        const whitespace = '\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
        return cachedStatement(sqlite, `WITH grouped AS (
          SELECT session_id, MIN(created_at) AS first_created_at,
            MAX(COALESCE(NULLIF(updated_at,''),created_at)) AS latest,
            SUM(status='queued') AS queued
          FROM tasks WHERE status != 'cancelled' AND length(trim(prompt, ?)) > 0
          GROUP BY session_id
        ) SELECT g.session_id AS sessionId,t.id AS taskId,trim(t.prompt, ?) AS prompt,t.status,
            g.latest AS updatedAt,g.queued AS queuedCount
          FROM grouped g JOIN tasks t ON t.rowid = (
            SELECT rowid FROM tasks
            WHERE session_id=g.session_id AND created_at=g.first_created_at
              AND status != 'cancelled' AND length(trim(prompt, ?)) > 0
            ORDER BY rowid LIMIT 1
          ) ORDER BY g.session_id`).all(whitespace, whitespace, whitespace) as import('@dutydeck/shared').RunSummary[];
      },
      async get(id) {
        const row = taskById().get({ id });
        return row ? decodeTask(row) : undefined;
      },
      async create(task) {
        const row = { ...task, executionContext: task.executionContext ? JSON.stringify(task.executionContext) : null };
        return legacyWrite(() => db.insert(tasks).values(row).onConflictDoNothing({ target: tasks.id }).run().changes === 1);
      },
      async save(t) {
        const row = { ...t, executionContext: t.executionContext ? JSON.stringify(t.executionContext) : null };
        legacyWrite(() => db.insert(tasks).values(row).onConflictDoUpdate({ target: tasks.id, set: row }).run());
      },
      async listBySession(sessionId) {
        return tasksBySession().all({ sessionId }).map(decodeTask);
      },
      async listRecentBySession(sessionId) {
        return (cachedStatement(sqlite, 'SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 2').all(sessionId) as TaskRowLike[]).map(decodeTask).reverse();
      },
      async listLatestPerSession() {
        return (cachedStatement(sqlite, `SELECT t.* FROM tasks t JOIN (
          SELECT rowid AS rid, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at DESC, rowid DESC) AS rn FROM tasks
        ) latest ON t.rowid = latest.rid WHERE latest.rn = 1`).all() as TaskRowLike[]).map(decodeTask);
      },
      async enqueue(task, position) {
        if (task.status !== 'queued') {
          throw new Error(`Cannot enqueue task with status '${task.status}': status must be 'queued'`);
        }

        return legacyWrite(() => {
          const existing = cachedStatement(sqlite, 'SELECT * FROM tasks WHERE id = ?').get(task.id) as TaskRowLike | undefined;
          if (existing) {
            return {
              task: decodeTask(existing),
              created: false
            };
          }

          const stats = cachedStatement(sqlite, `
            SELECT
              MIN(COALESCE(queue_position, 0)) AS min_pos,
              MAX(COALESCE(queue_position, 0)) AS max_pos
            FROM tasks
            WHERE session_id = ? AND status = 'queued'
          `).get(task.sessionId) as { min_pos: number | null; max_pos: number | null } | undefined;

          const minVal = stats?.min_pos !== null && stats?.min_pos !== undefined ? Number(stats.min_pos) : 0;
          const maxVal = stats?.max_pos !== null && stats?.max_pos !== undefined ? Number(stats.max_pos) : 0;

          const calculatedPosition = position === 'front'
            ? Math.min(0, minVal) - 1
            : Math.max(0, maxVal) + 1;

          const executionContextJson = task.executionContext ? JSON.stringify(task.executionContext) : null;
          const interruptedByActor = task.interruptedByActor ?? null;

          cachedStatement(sqlite, `
            INSERT INTO tasks (
              id, session_id, prompt, status, execution_context, interrupted_by_actor,
              queue_position, created_at, updated_at
            ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)
          `).run(
            task.id,
            task.sessionId,
            task.prompt,
            executionContextJson,
            interruptedByActor,
            calculatedPosition,
            task.createdAt,
            task.updatedAt
          );

          const inserted = cachedStatement(sqlite, 'SELECT * FROM tasks WHERE id = ?').get(task.id) as TaskRowLike;
          return {
            task: decodeTask(inserted),
            created: true
          };
        });
      },
      async promoteQueued(sessionId, taskId) {
        return legacyWrite(() => {
          const row = cachedStatement(sqlite, 'SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRowLike | undefined;
          if (!row) {
            return undefined;
          }
          const rowSessionId = 'sessionId' in row ? row.sessionId : row.session_id;
          if (rowSessionId !== sessionId || row.status !== 'queued') {
            return undefined;
          }

          const stats = cachedStatement(sqlite, `
            SELECT MIN(COALESCE(queue_position, 0)) AS min_pos
            FROM tasks
            WHERE session_id = ? AND status = 'queued'
          `).get(sessionId) as { min_pos: number | null } | undefined;

          const minVal = stats?.min_pos !== null && stats?.min_pos !== undefined ? Number(stats.min_pos) : 0;
          const newPosition = Math.min(0, minVal) - 1;
          const updatedAt = new Date().toISOString();

          cachedStatement(sqlite, 'UPDATE tasks SET queue_position = ?, updated_at = ? WHERE id = ?').run(newPosition, updatedAt, taskId);

          const updated = cachedStatement(sqlite, 'SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRowLike;
          return decodeTask(updated);
        });
      },
      async listQueued(sessionId) {
        const rows = cachedStatement(sqlite, `
          SELECT *
          FROM tasks
          WHERE session_id = ? AND status = 'queued'
          ORDER BY COALESCE(queue_position, 0) ASC, created_at ASC, rowid ASC
        `).all(sessionId) as TaskRowLike[];
        return rows.map(decodeTask);
      }
    },
    events: {
      async listHistoryOutline(sessionId, query) { return readHistoryOutline(sqlite, sessionId, query); },
      async listHistoryTurns(sessionId, from, through) { return readHistoryTurns(sqlite, sessionId, from, through); },
      highWaterMark(sessionId) { return (sessionHighWaterMark().get(sessionId) as { sequence: number }).sequence; },
      // Columns the event omits are written as NULL, as the unprepared insert did.
      async append(e) { legacyWrite(() => insertEvent().run({ id: e.id, sessionId: e.sessionId, sequence: e.sequence, type: e.type, timestamp: e.timestamp, data: JSON.stringify(e.data),
        raw: e.raw ?? null, taskId: e.taskId ?? null, attemptId: e.attemptId ?? null, settlementId: e.settlementId ?? null })); },
      async list(sessionId, afterSequence = 0) { return eventsAfter().all({ sessionId, afterSequence }).map(decodeEvent); },
      async getDeferredConfirmationId(sessionId, taskId) {
        const row = deferredConfirmation().get({ sessionId, taskId });
        return deferredConfirmationId(row ? [decodeEvent(row)] : [], taskId);
      },
      async getLatestPermissionRequest(sessionId, taskId, nativeId) {
        const row = latestPermissionRequest().get({ sessionId, taskId, nativeId });
        return row ? decodeEvent(row) : undefined;
      },
      async listRecent(sessionId, limit) {
        const rows = recentEvents().all({ sessionId, limit });
        return rows.reverse().map(decodeEvent);
      },
      async listLatestUsage(sessionId) {
        const rows = await Promise.all(['used', 'rateLimits.fiveHour.usedPercent', 'rateLimits.sevenDay.usedPercent'].map(async field => {
          return latestUsage().all({ sessionId, path: `$.${field}` });
        }));
        return rows.flat().map(decodeEvent);
      },
      async listLatestContexts() {
        // 字面量 type='status' 才能命中 events_session_status 部分索引（见迁移 41）。
        const rows = sqlite.prepare(`SELECT e.session_id AS sessionId, e.timestamp, e.data FROM sessions s JOIN events e ON e.rowid = (
          SELECT rowid FROM events WHERE session_id=s.id AND type='status' AND json_extract(data,'$.state')='usage'
            AND json_type(data,'$.used') IN ('integer','real') AND json_extract(data,'$.used') >= 0
          ORDER BY sequence DESC LIMIT 1)`).all() as Array<{ sessionId: string; timestamp: string; data: string }>;
        return rows.map(row => ({ sessionId: row.sessionId, timestamp: row.timestamp, data: JSON.parse(row.data) }));
      },
      async listWindow(sessionId, options = {}) {
        const requestedLimit = Number.isFinite(options.limit) ? Math.trunc(options.limit!) : EVENT_WINDOW_DEFAULT_LIMIT;
        const limit = Math.max(1, Math.min(EVENT_WINDOW_MAX_LIMIT, requestedLimit));
        const after = options.afterSequence !== undefined, before = options.beforeSequence !== undefined;
        const backward = options.direction === 'backward';
        const shape = `${after}:${before}:${backward}`;
        let query = eventWindows.get(shape);
        if (!query) eventWindows.set(shape, query = buildEventWindow(after, before, backward));
        const rows = query.all({ sessionId, afterSequence: options.afterSequence, beforeSequence: options.beforeSequence, limit });
        if (backward) rows.reverse();
        return rows.map(decodeEvent);
      }
    },
    config: {
      async compareAndSetBatch(checks, writes) {
        return sqlite.transaction(() => {
          for (const { key, value } of writes) {
            assertBotProcessConfigWrite(sqlite, key, value);
            if (key.startsWith('runtime_native_context:')) throw new RuntimeError('EXECUTION_WRITE_REQUIRES_LEDGER', 'Native context selection requires a bound ledger command', 409);
          }
          const read = cachedStatement(sqlite, 'SELECT value FROM configs WHERE key=?');
          if (checks.some(({ key, expected }) => (read.get(key) as { value: string } | undefined)?.value !== expected)) return false;
          const put = cachedStatement(sqlite, 'INSERT INTO configs (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
          for (const { key, value } of writes) put.run(key, value);
          for (const { key, value } of writes) assertBotProcessConfigWrite(sqlite, key, value);
          return true;
        }).immediate();
      },
      getSync(key) { return (configValue().get(key) as { value: string } | undefined)?.value; },
      async listByJsonField(prefix, filter) { return listConfigByJsonField(sqlite, prefix, filter); },
      async listJsonFields(prefix, paths, filter) { return listConfigJsonFields(sqlite, prefix, paths, filter); },
      async pruneIgnoredLarkInbox(appId, options) { return pruneIgnoredLarkInbox(sqlite, appId, options); },
      async listRecentIgnoredLarkInbox(input) { return listRecentIgnoredLarkInbox(sqlite, input); },
      async remove(key, expected) {
        const promptPending = key.startsWith('bot_prompt_version/pending/');
        let recovered: ReturnType<typeof watchFindingSchema.parse> | undefined;
        if (key.startsWith('watch_findings/')) {
          try {
            const parsed = watchFindingSchema.safeParse(JSON.parse(expected));
            if (parsed.success && parsed.data.recoveredAt && !key.endsWith('/notification')
              && key === `watch_findings/${parsed.data.appId}/${parsed.data.fingerprint}`) recovered = parsed.data;
          } catch { /* Invalid records cannot authorize deletion. */ }
        }
        if (!promptPending && !recovered && (!key.startsWith('lark.inbox.') || JSON.parse(expected)?.state !== 'ignored')) throw new RuntimeError('CONFIG_DELETE_NOT_SUPPORTED', 'Only recovered watch findings, ignored Lark inbox receipts and prompt usage preparations can be removed', 409);
        return sqlite.transaction(() => {
          if (recovered) {
            const row = cachedStatement(sqlite, 'SELECT value FROM configs WHERE key=?').get(`watch_findings/${recovered.appId}/notification`) as { value: string } | undefined;
            if (row) {
              try {
                const notice = JSON.parse(row.value) as { status?: string; members?: Array<{ fingerprint?: string } | null> } | null;
                if (!notice || !['pending', 'completed', 'unknown'].includes(notice.status ?? '')
                  || notice.status === 'pending' && (!Array.isArray(notice.members) || notice.members.some(member => member?.fingerprint === recovered!.fingerprint))) return false;
              } catch { return false; }
            }
          }
          return cachedStatement(sqlite, 'DELETE FROM configs WHERE key = ? AND value = ?').run(key, expected).changes === 1;
        }).immediate();
      },
      async get(key) { return configByKey().get({ key })?.value; },
      async set(key, value) { assertBotProcessConfigWrite(sqlite, key, value); if (key.startsWith('runtime_native_context:')) throw new RuntimeError('EXECUTION_WRITE_REQUIRES_LEDGER', 'Native context selection requires a bound ledger command', 409); db.insert(configs).values({ key, value }).onConflictDoUpdate({ target: configs.key, set: { value } }).run(); },
      async list(prefix) {
        const characters = Array.from(prefix);
        // SQLite length/substr stop at NUL; keep their existing edge-case semantics.
        if (!prefix || prefix.includes('\0') || characters.some(character => /^[\ud800-\udfff]$/.test(character))) {
          return cachedStatement(sqlite, 'SELECT key, value FROM configs WHERE substr(key, 1, length(?)) = ? ORDER BY key').all(prefix, prefix) as Array<{ key: string; value: string }>;
        }
        let upper: string | undefined;
        for (let index = characters.length - 1; index >= 0; index--) {
          const code = characters[index]!.codePointAt(0)!;
          if (code === 0x10ffff) continue;
          // UTF-8 BINARY order follows scalar values; skip the surrogate range.
          upper = characters.slice(0, index).join('') + String.fromCodePoint(code === 0xd7ff ? 0xe000 : code + 1);
          break;
        }
        return (upper === undefined
          ? cachedStatement(sqlite, 'SELECT key, value FROM configs WHERE key >= ? COLLATE BINARY AND substr(key, 1, length(?)) = ? ORDER BY key').all(prefix, prefix, prefix)
          : cachedStatement(sqlite, 'SELECT key, value FROM configs WHERE key >= ? COLLATE BINARY AND key < ? COLLATE BINARY AND substr(key, 1, length(?)) = ? ORDER BY key').all(prefix, upper, prefix, prefix)) as Array<{ key: string; value: string }>;
      },
      async compareAndSet(key, expected, value) {
        assertBotProcessConfigWrite(sqlite, key, value);
        if (key.startsWith('runtime_native_context:')) throw new RuntimeError('EXECUTION_WRITE_REQUIRES_LEDGER', 'Native context selection requires a bound ledger command', 409);
        return expected === undefined
          ? cachedStatement(sqlite, 'INSERT INTO configs (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(key, value).changes === 1
          : cachedStatement(sqlite, 'UPDATE configs SET value = ? WHERE key = ? AND value = ?').run(value, key, expected).changes === 1;
      }
    },
    channelMappings: {
      async get(channel, externalId) { return db.select().from(channelMappings).where(and(eq(channelMappings.channel, channel), eq(channelMappings.externalId, externalId))).get(); },
      async list(channel) { return db.select().from(channelMappings).where(eq(channelMappings.channel, channel)).all(); },
      async save(mapping) { db.insert(channelMappings).values(mapping).onConflictDoUpdate({ target: channelMappings.id, set: mapping }).run(); },
      async compareAndSetExtra(id, expectedExtra, extra) {
        return cachedStatement(sqlite, 'UPDATE channel_mappings SET extra = ? WHERE id = ? AND extra IS ?').run(extra, id, expectedExtra ?? null).changes === 1;
      }
    },
    artifacts: {
      async ensureLocalProject(cwd) { const time = new Date().toISOString(); db.insert(machines).values({ id: 'local', name: 'Local machine', metadata: '{}', createdAt: time, updatedAt: time }).onConflictDoNothing().run(); db.insert(projects).values({ id: `local:${cwd}`, machineId: 'local', name: cwd.split('/').filter(Boolean).at(-1) ?? cwd, cwd, createdAt: time, updatedAt: time }).onConflictDoUpdate({ target: projects.id, set: { cwd, updatedAt: time } }).run(); },
      async saveToolCall(sessionId, data) { const time = new Date().toISOString(); upsertToolCall().run(`${sessionId}:${data.id}`, sessionId, JSON.stringify(data), data.startedAt ?? time, time); },
      async savePermission(sessionId, data) { const time = new Date().toISOString(); db.insert(permissionRequests).values({ id: `${sessionId}:${data.id}`, sessionId, status: data.status, data: JSON.stringify(data), createdAt: time, updatedAt: time }).onConflictDoUpdate({ target: permissionRequests.id, set: { status: data.status, data: JSON.stringify(data), updatedAt: time } }).run(); },
      async saveError(sessionId, message, details) { db.insert(errors).values({ id: `error:${crypto.randomUUID()}`, sessionId, message, details: details === undefined ? undefined : JSON.stringify(details), createdAt: new Date().toISOString() }).run(); }
    },
    ...foundationRepositories,
    ...wp1aRepositories,
    ...scheduleRepositories,
    pluginResults: createPluginResultRepository(sqlite),
    memoryJobs: createMemoryJobRepository(sqlite),
    workItems: createWorkItemIndexRepository(sqlite),
    collaboration,
    ciWebhook,
    usage,
    retention: createRetentionRepository(sqlite, () => execution.authority()),
    close() {
      control.assertClosable();
      if (filename !== ':memory:') restrictDatabaseFiles(filename);
      if (sqlite.open) sqlite.close();
      if (filename !== ':memory:') restrictDatabaseFiles(filename);
      control.close();
    }
  };
  } catch (error) {
    try {
      if (sqlite.open) sqlite.close();
      if (filename !== ':memory:') restrictDatabaseFiles(filename);
      control.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Database open and cleanup failed');
    }
    throw error;
  }
}

export { childProcessIdentity, observeProcess, currentProcessIdentity, type ProcessIdentity } from './process-identity.js';
export { checkSqliteDriver, describeSqliteDriverFailure, type SqliteDriverCheck, type SqliteDriverCheckOptions } from './sqlite-preflight.js';
