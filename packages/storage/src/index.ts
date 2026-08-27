import Database from 'better-sqlite3';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentConfig, AgentEvent, RepositoryBundle, Session, TaskRecord } from '@dockmux/shared';
import { agentConfigs, channelMappings, configs, errors, events, machines, permissionRequests, projects, sessions, tasks, toolCalls } from './schema.js';
import { runMigrations } from './migrations.js';
export * from './schema.js';

export function createRepositories(filename: string): RepositoryBundle {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const sqlite = new Database(filename);
  sqlite.pragma('journal_mode = WAL');
  runMigrations(sqlite);
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
