import Database from 'better-sqlite3';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentConfig, AgentEvent, RepositoryBundle, Session, TaskRecord } from '@dockmux/shared';
import { agentConfigs, channelMappings, configs, errors, events, machines, permissionRequests, projects, sessions, tasks, toolCalls } from './schema.js';
export * from './schema.js';

export function createRepositories(filename: string): RepositoryBundle {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const sqlite = new Database(filename);
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
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
  `);
  const sessionColumns = sqlite.pragma('table_info(sessions)') as Array<{ name: string }>;
  if (!sessionColumns.some(column => column.name === 'reasoning_effort')) sqlite.exec('ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT');
  if (!sessionColumns.some(column => column.name === 'system_prompt')) sqlite.exec('ALTER TABLE sessions ADD COLUMN system_prompt TEXT');
  if (!sessionColumns.some(column => column.name === 'permission_mode')) sqlite.exec("ALTER TABLE sessions ADD COLUMN permission_mode TEXT DEFAULT 'full-trust'");
  if (!sessionColumns.some(column => column.name === 'source')) sqlite.exec('ALTER TABLE sessions ADD COLUMN source TEXT');
  if (!sessionColumns.some(column => column.name === 'source_id')) sqlite.exec('ALTER TABLE sessions ADD COLUMN source_id TEXT');
  if (!sessionColumns.some(column => column.name === 'archived_at')) sqlite.exec('ALTER TABLE sessions ADD COLUMN archived_at TEXT');
  const channelMappingColumns = sqlite.pragma('table_info(channel_mappings)') as Array<{ name: string }>;
  if (!channelMappingColumns.some(column => column.name === 'extra')) sqlite.exec('ALTER TABLE channel_mappings ADD COLUMN extra TEXT');
  const db = drizzle(sqlite);
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
      async save(t) { db.insert(tasks).values(t).onConflictDoUpdate({ target: tasks.id, set: t }).run(); },
      async listBySession(sessionId) { return db.select().from(tasks).where(eq(tasks.sessionId, sessionId)).all() as TaskRecord[]; }
    },
    events: {
      async append(e) { db.insert(events).values({ ...e, data: JSON.stringify(e.data) }).run(); },
      async list(sessionId, afterSequence = 0) { return db.select().from(events).where(and(eq(events.sessionId, sessionId), gt(events.sequence, afterSequence))).orderBy(asc(events.sequence)).all().map(r => ({ ...r, data: JSON.parse(r.data) })) as AgentEvent[]; },
      async listRecent(sessionId, limit) {
        const rows = db.select().from(events).where(eq(events.sessionId, sessionId)).orderBy(desc(events.sequence)).limit(limit).all();
        return rows.reverse().map(r => ({ ...r, data: JSON.parse(r.data) })) as AgentEvent[];
      }
    },
    config: {
      async get(key) { return db.select().from(configs).where(eq(configs.key, key)).get()?.value; },
      async set(key, value) { db.insert(configs).values({ key, value }).onConflictDoUpdate({ target: configs.key, set: { value } }).run(); }
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
    close() { sqlite.close(); }
  };
}
