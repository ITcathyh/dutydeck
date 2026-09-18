import Database from 'better-sqlite3';
import { and, asc, desc, eq, gt, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { AgentConfig, AgentEvent, RepositoryBundle, RepositoryOpenOptions, Session, TaskRecord } from '@dutydeck/shared';
import { agentConfigs, channelMappings, configs, errors, events, machines, permissionRequests, projects, sessions, tasks, toolCalls } from './schema.js';
import { RuntimeError } from '@dutydeck/shared';
import { createTaskExecutionRepository } from './task-execution.js';
import { needsMigration, runMigrations, withMigrationTransaction } from './migrations.js';
import { createFoundationRepositories } from './foundation.js';
import { createWp1aRepositories } from './group-policy.js';
import { createScheduleFoundationRepositories } from './schedule-foundation.js';
import { createCollaborationRepository } from './collaboration.js';
import { canonicalDatabase, openDatabaseControl } from './database-control.js';
export * from './schema.js';
export * from './task-execution.js';
export * from './foundation.js';
export * from './group-policy.js';
export * from './schedule-foundation.js';
export * from './collaboration.js';
export * from './collaboration-migration.js';
export * from './execution-inspection.js';

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

type TaskRowLike = typeof tasks.$inferSelect | {
  id: string;
  session_id: string;
  prompt: string;
  status: string;
  execution_context: string | null;
  interrupted_by_actor?: string | null;
  queue_position?: number | null;
  created_at: string;
  updated_at: string;
};

function decodeTask(row: TaskRowLike): TaskRecord {
  const sessionId = 'sessionId' in row ? row.sessionId : row.session_id;
  const executionContextRaw = 'executionContext' in row ? row.executionContext : row.execution_context;
  const interruptedByActor = 'interruptedByActor' in row ? row.interruptedByActor : row.interrupted_by_actor;
  const queuePosition = 'queuePosition' in row ? row.queuePosition : row.queue_position;
  const createdAt = 'createdAt' in row ? row.createdAt : row.created_at;
  const updatedAt = 'updatedAt' in row ? row.updatedAt : row.updated_at;

  return {
    id: row.id,
    sessionId,
    prompt: row.prompt,
    status: row.status,
    executionContext: executionContextRaw ? JSON.parse(executionContextRaw) : undefined,
    ...(interruptedByActor ? { interruptedByActor } : {}),
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
  try { sqlite = new Database(filename); } catch (error) { control.close(); throw error; }
  try {
    sqlite.pragma('foreign_keys = ON');
    const migrate = needsMigration(sqlite) || control.needsRecovery();
    if (migrate) control.beginUpgrade();
    sqlite.pragma('journal_mode = WAL');
    if (migrate) {
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
  return {
    control,
    execution,
    agents: {
      async list() { return db.select().from(agentConfigs).all().map(r => JSON.parse(r.json)); },
      async get(id) { const r = db.select().from(agentConfigs).where(eq(agentConfigs.id, id)).get(); return r ? JSON.parse(r.json) : undefined; },
      async save(agent) { const time = new Date().toISOString(); db.insert(agentConfigs).values({ id: agent.id, json: JSON.stringify(agent), createdAt: time, updatedAt: time }).onConflictDoUpdate({ target: agentConfigs.id, set: { json: JSON.stringify(agent), updatedAt: time } }).run(); },
      async delete(id) { db.delete(agentConfigs).where(eq(agentConfigs.id, id)).run(); }
    },
    sessions: {
      async list() { return db.select().from(sessions).orderBy(asc(sessions.createdAt)).all() as Session[]; },
      async get(id) { return db.select().from(sessions).where(eq(sessions.id, id)).get() as Session | undefined; },
      async save(s) {
        sqlite.transaction(() => {
          if (execution.authority() === 'ledger_v1') {
            const current = db.select().from(sessions).where(eq(sessions.id, s.id)).get();
            if (!current) throw new RuntimeError('EXECUTION_LEDGER_REQUIRED', 'Session creation requires a bound ledger command', 409);
            for (const key of ['state', 'runId', 'archivedAt', 'error', 'agentId', 'cwd', 'source', 'sourceId', 'protocol', 'createdAt'] as const) {
              if ((current[key] ?? null) !== (s[key] ?? null)) throw new RuntimeError('EXECUTION_LEDGER_REQUIRED', `Session ${key} requires a bound ledger command`, 409);
            }
            db.update(sessions).set({ model: s.model, reasoningEffort: s.reasoningEffort, systemPrompt: s.systemPrompt, permissionMode: s.permissionMode, updatedAt: s.updatedAt }).where(eq(sessions.id, s.id)).run();
          } else db.insert(sessions).values(s).onConflictDoUpdate({ target: sessions.id, set: s }).run();
        }).immediate();
      }
    },
    tasks: {
      async get(id) {
        const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
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
        return db.select().from(tasks).where(eq(tasks.sessionId, sessionId)).orderBy(asc(tasks.createdAt)).all().map(decodeTask);
      },
      async enqueue(task, position) {
        if (task.status !== 'queued') {
          throw new Error(`Cannot enqueue task with status '${task.status}': status must be 'queued'`);
        }

        return legacyWrite(() => {
          const existing = sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as TaskRowLike | undefined;
          if (existing) {
            return {
              task: decodeTask(existing),
              created: false
            };
          }

          const stats = sqlite.prepare(`
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

          sqlite.prepare(`
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

          const inserted = sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as TaskRowLike;
          return {
            task: decodeTask(inserted),
            created: true
          };
        });
      },
      async promoteQueued(sessionId, taskId) {
        return legacyWrite(() => {
          const row = sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRowLike | undefined;
          if (!row) {
            return undefined;
          }
          const rowSessionId = 'sessionId' in row ? row.sessionId : row.session_id;
          if (rowSessionId !== sessionId || row.status !== 'queued') {
            return undefined;
          }

          const stats = sqlite.prepare(`
            SELECT MIN(COALESCE(queue_position, 0)) AS min_pos
            FROM tasks
            WHERE session_id = ? AND status = 'queued'
          `).get(sessionId) as { min_pos: number | null } | undefined;

          const minVal = stats?.min_pos !== null && stats?.min_pos !== undefined ? Number(stats.min_pos) : 0;
          const newPosition = Math.min(0, minVal) - 1;
          const updatedAt = new Date().toISOString();

          sqlite.prepare('UPDATE tasks SET queue_position = ?, updated_at = ? WHERE id = ?').run(newPosition, updatedAt, taskId);

          const updated = sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRowLike;
          return decodeTask(updated);
        });
      },
      async listQueued(sessionId) {
        const rows = sqlite.prepare(`
          SELECT *
          FROM tasks
          WHERE session_id = ? AND status = 'queued'
          ORDER BY COALESCE(queue_position, 0) ASC, created_at ASC, rowid ASC
        `).all(sessionId) as TaskRowLike[];
        return rows.map(decodeTask);
      }
    },
    events: {
      highWaterMark(sessionId) { return (sqlite.prepare('SELECT COALESCE(MAX(sequence),0) AS sequence FROM events WHERE session_id=?').get(sessionId) as { sequence: number }).sequence; },
      async append(e) { legacyWrite(() => db.insert(events).values({ ...e, data: JSON.stringify(e.data) }).run()); },
      async list(sessionId, afterSequence = 0) { return db.select().from(events).where(and(eq(events.sessionId, sessionId), gt(events.sequence, afterSequence))).orderBy(asc(events.sequence)).all().map(r => ({ ...r, data: JSON.parse(r.data) })) as AgentEvent[]; },
      async listRecent(sessionId, limit) {
        const rows = db.select().from(events).where(eq(events.sessionId, sessionId)).orderBy(desc(events.sequence)).limit(limit).all();
        return rows.reverse().map(r => ({ ...r, data: JSON.parse(r.data) })) as AgentEvent[];
      },
      async listWindow(sessionId, options = {}) {
        const requestedLimit = Number.isFinite(options.limit) ? Math.trunc(options.limit!) : EVENT_WINDOW_DEFAULT_LIMIT;
        const limit = Math.max(1, Math.min(EVENT_WINDOW_MAX_LIMIT, requestedLimit));
        const filters = [eq(events.sessionId, sessionId)];
        if (options.afterSequence !== undefined) filters.push(gt(events.sequence, options.afterSequence));
        if (options.beforeSequence !== undefined) filters.push(lt(events.sequence, options.beforeSequence));
        const backward = options.direction === 'backward';
        const rows = db.select().from(events).where(and(...filters)).orderBy(backward ? desc(events.sequence) : asc(events.sequence)).limit(limit).all();
        if (backward) rows.reverse();
        return rows.map(r => ({ ...r, data: JSON.parse(r.data) })) as AgentEvent[];
      }
    },
    config: {
      async get(key) { return db.select().from(configs).where(eq(configs.key, key)).get()?.value; },
      async set(key, value) { if (key.startsWith('runtime_native_context:')) throw new RuntimeError('EXECUTION_WRITE_REQUIRES_LEDGER', 'Native context selection requires a bound ledger command', 409); db.insert(configs).values({ key, value }).onConflictDoUpdate({ target: configs.key, set: { value } }).run(); },
      async list(prefix) {
        return sqlite.prepare('SELECT key, value FROM configs WHERE substr(key, 1, length(?)) = ? ORDER BY key').all(prefix, prefix) as Array<{ key: string; value: string }>;
      },
      async compareAndSet(key, expected, value) {
        if (key.startsWith('runtime_native_context:')) throw new RuntimeError('EXECUTION_WRITE_REQUIRES_LEDGER', 'Native context selection requires a bound ledger command', 409);
        return expected === undefined
          ? sqlite.prepare('INSERT INTO configs (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(key, value).changes === 1
          : sqlite.prepare('UPDATE configs SET value = ? WHERE key = ? AND value = ?').run(value, key, expected).changes === 1;
      }
    },
    channelMappings: {
      async get(channel, externalId) { return db.select().from(channelMappings).where(and(eq(channelMappings.channel, channel), eq(channelMappings.externalId, externalId))).get(); },
      async list(channel) { return db.select().from(channelMappings).where(eq(channelMappings.channel, channel)).all(); },
      async save(mapping) { db.insert(channelMappings).values(mapping).onConflictDoUpdate({ target: channelMappings.id, set: mapping }).run(); },
      async compareAndSetExtra(id, expectedExtra, extra) {
        return sqlite.prepare('UPDATE channel_mappings SET extra = ? WHERE id = ? AND extra IS ?').run(extra, id, expectedExtra ?? null).changes === 1;
      }
    },
    artifacts: {
      async ensureLocalProject(cwd) { const time = new Date().toISOString(); db.insert(machines).values({ id: 'local', name: 'Local machine', metadata: '{}', createdAt: time, updatedAt: time }).onConflictDoNothing().run(); db.insert(projects).values({ id: `local:${cwd}`, machineId: 'local', name: cwd.split('/').filter(Boolean).at(-1) ?? cwd, cwd, createdAt: time, updatedAt: time }).onConflictDoUpdate({ target: projects.id, set: { cwd, updatedAt: time } }).run(); },
      async saveToolCall(sessionId, data) { const time = new Date().toISOString(); db.insert(toolCalls).values({ id: `${sessionId}:${data.id}`, sessionId, data: JSON.stringify(data), createdAt: data.startedAt ?? time, updatedAt: time }).onConflictDoUpdate({ target: toolCalls.id, set: { data: JSON.stringify(data), updatedAt: time } }).run(); },
      async savePermission(sessionId, data) { const time = new Date().toISOString(); db.insert(permissionRequests).values({ id: `${sessionId}:${data.id}`, sessionId, status: data.status, data: JSON.stringify(data), createdAt: time, updatedAt: time }).onConflictDoUpdate({ target: permissionRequests.id, set: { status: data.status, data: JSON.stringify(data), updatedAt: time } }).run(); },
      async saveError(sessionId, message, details) { db.insert(errors).values({ id: `error:${crypto.randomUUID()}`, sessionId, message, details: details === undefined ? undefined : JSON.stringify(details), createdAt: new Date().toISOString() }).run(); }
    },
    ...foundationRepositories,
    ...wp1aRepositories,
    ...scheduleRepositories,
    collaboration,
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

export { childProcessIdentity, observeProcess } from './process-identity.js';
