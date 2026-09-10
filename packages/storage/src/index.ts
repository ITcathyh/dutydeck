import Database from 'better-sqlite3';
import { and, asc, desc, eq, gt, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { AgentConfig, AgentEvent, RepositoryBundle, Session, TaskRecord } from '@dutydeck/shared';
import { agentConfigs, channelMappings, configs, errors, events, machines, permissionRequests, projects, sessions, tasks, toolCalls } from './schema.js';
import { runMigrations } from './migrations.js';
import { createFoundationRepositories } from './foundation.js';
import { createWp1aRepositories } from './group-policy.js';
import { createScheduleFoundationRepositories } from './schedule-foundation.js';
export * from './schema.js';
export * from './foundation.js';
export * from './group-policy.js';
export * from './schedule-foundation.js';

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
  chmodSync(filename, PRIVATE_FILE_MODE);
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

function decodeTask(row: typeof tasks.$inferSelect): TaskRecord {
  return {
    ...row,
    executionContext: row.executionContext ? JSON.parse(row.executionContext) : undefined
  } as TaskRecord;
}

export function createRepositories(filename: string): RepositoryBundle {
  if (filename !== ':memory:') {
    prepareDatabaseDirectory(filename);
    prepareDatabaseFile(filename);
    restrictDatabaseFiles(filename);
  }
  const sqlite = new Database(filename);
  try {
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('journal_mode = WAL');
    backupBeforeV10(sqlite, filename);
    runMigrations(sqlite);
    if (filename !== ':memory:') restrictDatabaseFiles(filename);
  } catch (error) {
    sqlite.close();
    if (filename !== ':memory:') restrictDatabaseFiles(filename);
    throw error;
  }
  const db = drizzle(sqlite);
  const foundationRepositories = createFoundationRepositories(sqlite);
  const wp1aRepositories = createWp1aRepositories(sqlite);
  const scheduleRepositories = createScheduleFoundationRepositories(sqlite);
  return {
    agents: {
      async list() { return db.select().from(agentConfigs).all().map(r => JSON.parse(r.json)); },
      async get(id) { const r = db.select().from(agentConfigs).where(eq(agentConfigs.id, id)).get(); return r ? JSON.parse(r.json) : undefined; },
      async save(agent) { const time = new Date().toISOString(); db.insert(agentConfigs).values({ id: agent.id, json: JSON.stringify(agent), createdAt: time, updatedAt: time }).onConflictDoUpdate({ target: agentConfigs.id, set: { json: JSON.stringify(agent), updatedAt: time } }).run(); },
      async delete(id) { db.delete(agentConfigs).where(eq(agentConfigs.id, id)).run(); }
    },
    sessions: {
      async list() { return db.select().from(sessions).orderBy(asc(sessions.createdAt)).all() as Session[]; },
      async get(id) { return db.select().from(sessions).where(eq(sessions.id, id)).get() as Session | undefined; },
      async save(s) { db.insert(sessions).values(s).onConflictDoUpdate({ target: sessions.id, set: s }).run(); }
    },
    tasks: {
      async get(id) {
        const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
        return row ? decodeTask(row) : undefined;
      },
      async create(task) {
        const row = { ...task, executionContext: task.executionContext ? JSON.stringify(task.executionContext) : null };
        return db.insert(tasks).values(row).onConflictDoNothing({ target: tasks.id }).run().changes === 1;
      },
      async save(t) {
        const row = { ...t, executionContext: t.executionContext ? JSON.stringify(t.executionContext) : null };
        db.insert(tasks).values(row).onConflictDoUpdate({ target: tasks.id, set: row }).run();
      },
      async listBySession(sessionId) { return db.select().from(tasks).where(eq(tasks.sessionId, sessionId)).orderBy(asc(tasks.createdAt)).all().map(decodeTask); }
    },
    events: {
      async append(e) { db.insert(events).values({ ...e, data: JSON.stringify(e.data) }).run(); },
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
      async set(key, value) { db.insert(configs).values({ key, value }).onConflictDoUpdate({ target: configs.key, set: { value } }).run(); },
      async list(prefix) {
        return sqlite.prepare('SELECT key, value FROM configs WHERE substr(key, 1, length(?)) = ? ORDER BY key').all(prefix, prefix) as Array<{ key: string; value: string }>;
      },
      async compareAndSet(key, expected, value) {
        return expected === undefined
          ? sqlite.prepare('INSERT INTO configs (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(key, value).changes === 1
          : sqlite.prepare('UPDATE configs SET value = ? WHERE key = ? AND value = ?').run(value, key, expected).changes === 1;
      }
    },
    channelMappings: {
      async get(channel, externalId) { return db.select().from(channelMappings).where(and(eq(channelMappings.channel, channel), eq(channelMappings.externalId, externalId))).get(); },
      async list(channel) { return db.select().from(channelMappings).where(eq(channelMappings.channel, channel)).all(); },
      async save(mapping) { db.insert(channelMappings).values(mapping).onConflictDoUpdate({ target: channelMappings.id, set: mapping }).run(); }
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
    close() {
      if (filename !== ':memory:') restrictDatabaseFiles(filename);
      sqlite.close();
      if (filename !== ':memory:') restrictDatabaseFiles(filename);
    }
  };
}
