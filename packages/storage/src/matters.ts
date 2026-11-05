import type Database from 'better-sqlite3';
import { cachedStatement } from './database-control.js';
import { randomUUID } from 'node:crypto';
import { matterSchema, matterLinkSchema, type MatterRepository } from '@dutydeck/shared';

export function createMatterSchema(db: Database.Database) {
  db.exec(`CREATE TABLE matters (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','done','cancelled')),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, origin_app_id TEXT, origin_chat_id TEXT, origin_message_id TEXT
  );
  CREATE TABLE matter_links (
    matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('session','task','schedule','origin_message','reply_target')),
    ref_id TEXT NOT NULL, relation TEXT NOT NULL CHECK(relation IN ('origin','handoff','fork','resume','retry','agent_switch','schedule_run','created_in')),
    created_at TEXT NOT NULL, UNIQUE(matter_id,kind,ref_id)
  );
  CREATE UNIQUE INDEX matter_links_owner ON matter_links(kind,ref_id) WHERE kind IN ('session','task','schedule');
  CREATE INDEX matter_links_ref ON matter_links(kind,ref_id);`);
}
export function createMatterRepository(db: Database.Database): MatterRepository {
  const columns = 'id,title,status,created_at AS createdAt,updated_at AS updatedAt,origin_app_id AS originAppId,origin_chat_id AS originChatId,origin_message_id AS originMessageId';
  const decode = (row: unknown) => {
    if (!row) return undefined;
    return matterSchema.parse(Object.fromEntries(Object.entries(row as Record<string, unknown>).filter(([, value]) => value !== null)));
  };
  const get: MatterRepository['get'] = id => decode(db.prepare(`SELECT ${columns} FROM matters WHERE id=?`).get(id));
  const find: MatterRepository['find'] = (kind, refId) => {
    const row = cachedStatement(db, 'SELECT matter_id FROM matter_links WHERE kind=? AND ref_id=? ORDER BY created_at LIMIT 1').get(kind, refId) as { matter_id: string } | undefined;
    return row ? get(row.matter_id) : undefined;
  };
  const link: MatterRepository['link'] = input => {
    const value = matterLinkSchema.parse({ ...input, createdAt: new Date().toISOString() });
    cachedStatement(db, 'INSERT INTO matter_links(matter_id,kind,ref_id,relation,created_at) VALUES (?,?,?,?,?) ON CONFLICT(matter_id,kind,ref_id) DO NOTHING').run(value.matterId,value.kind,value.refId,value.relation,value.createdAt);
  };
  const ensureSession: MatterRepository['ensureSession'] = input => db.transaction(() => {
    const existing = find('session', input.sessionId);
    if (existing) return existing;
    const source = input.sourceSessionId && input.sourceSessionId !== input.sessionId
      ? ensureSession({ sessionId: input.sourceSessionId, title: input.title }) : undefined;
    const time = new Date().toISOString();
    const matter = source ?? matterSchema.parse({ id: `matter_${randomUUID()}`, title: Array.from(input.title.trim() || '未命名事项').slice(0, 60).join(''), status: 'open', createdAt: time, updatedAt: time,
      ...(input.originAppId ? { originAppId: input.originAppId } : {}), ...(input.originChatId ? { originChatId: input.originChatId } : {}), ...(input.originMessageId ? { originMessageId: input.originMessageId } : {}) });
    if (!source) cachedStatement(db, 'INSERT INTO matters(id,title,status,created_at,updated_at,origin_app_id,origin_chat_id,origin_message_id) VALUES (?,?,?,?,?,?,?,?)').run(matter.id,matter.title,matter.status,time,time,matter.originAppId ?? null,matter.originChatId ?? null,matter.originMessageId ?? null);
    link({ matterId: matter.id, kind: 'session', refId: input.sessionId, relation: input.relation ?? (source ? 'handoff' : 'origin') });
    return matter;
  }).immediate();
  return { get, find, ensureSession, link, links: id => cachedStatement(db, 'SELECT matter_id AS matterId,kind,ref_id AS refId,relation,created_at AS createdAt FROM matter_links WHERE matter_id=? ORDER BY created_at,ref_id').all(id).map(row => matterLinkSchema.parse(row)) };
}
