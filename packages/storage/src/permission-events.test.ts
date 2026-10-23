import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentEvent } from '@dutydeck/shared';
import { createRepositories } from './index.js';
import { runMigrations } from './migrations.js';

const permission = (sessionId: string, taskId: string | undefined, sequence: number, status = 'pending', nativeId = 'same-id'): AgentEvent => ({
  id: `${sessionId}-${sequence}`, sessionId, taskId, sequence, timestamp: String(sequence), type: 'permission_request', data: { id: nativeId, title: '确认', status }
});

it('reads only the latest matching permission event and sees external commits without caching', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'permission-events-'));
  const path = join(directory, 'state.db'), writer = createRepositories(path), reader = createRepositories(path);
  try {
    for (let sequence = 1; sequence <= 5000; sequence++) await writer.events.append({ ...permission('s', 't', sequence), type: 'text', data: { text: 'x'.repeat(500) } });
    await writer.events.append(permission('s', 't', 5001));
    await writer.events.append(permission('s', 'other-task', 5002, 'rejected'));
    await writer.events.append(permission('other-session', 't', 5003, 'rejected'));
    await writer.events.append(permission('s', undefined, 5004, 'rejected'));
    await writer.events.append(permission('s', 't', 5005, 'rejected', 'other-native'));
    expect(await reader.events.getLatestPermissionRequest('s', 't', 'same-id')).toEqual({ ...permission('s', 't', 5001), raw: null, attemptId: null, settlementId: null });
    expect(await reader.events.getLatestPermissionRequest('s', 'missing', 'same-id')).toBeUndefined();
    expect(await reader.events.getLatestPermissionRequest('missing', 't', 'same-id')).toBeUndefined();
    expect(await reader.events.getLatestPermissionRequest('s', 't', 'missing')).toBeUndefined();
    await writer.events.append(permission('s', 't', 5006, 'approved'));
    expect(await reader.events.getLatestPermissionRequest('s', 't', 'same-id')).toEqual({ ...permission('s', 't', 5006, 'approved'), raw: null, attemptId: null, settlementId: null });
    await writer.events.append(permission('s', 't', 5008, 'rejected'));
    await writer.events.append(permission('s', 't', 5007, 'pending'));
    expect((await reader.events.getLatestPermissionRequest('s', 't', 'same-id'))?.sequence).toBe(5008);
  } finally { reader.close(); writer.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('upgrades old event rows additively and uses all lookup keys without sorting or malformed JSON failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'permission-event-migration-'));
  const path = join(directory, 'state.db');
  createRepositories(path).close();
  const db = new Database(path);
  try {
    db.exec('DROP INDEX IF EXISTS events_permission_request; DELETE FROM schema_migrations WHERE version=43');
    const insert = db.prepare('INSERT INTO events (id,session_id,task_id,sequence,type,timestamp,data) VALUES (?,?,?,?,?,?,?)');
    insert.run('valid', 's', 't', 1, 'permission_request', '1', JSON.stringify({ id: 'same-id', status: 'approved' }));
    insert.run('malformed-permission', 's', 't', 2, 'permission_request', '2', '{broken');
    insert.run('malformed-text', 's', 't', 3, 'text', '3', '{broken');
    const before = db.prepare('SELECT * FROM events ORDER BY sequence').all();
    runMigrations(db);
    expect(db.prepare('SELECT * FROM events ORDER BY sequence').all()).toEqual(before);
    expect(db.prepare('SELECT version FROM schema_migrations WHERE version=43').get()).toEqual({ version: 43 });
    const plan = JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM events WHERE session_id=? AND task_id=? AND type='permission_request'
      AND CASE WHEN json_valid(data) THEN json_extract(data,'$.id') END = ? ORDER BY sequence DESC LIMIT 1`).all('s', 't', 'same-id'));
    expect(plan).toContain('events_permission_request');
    expect(plan).toContain('session_id=? AND task_id=? AND <expr>=?');
    expect(plan).not.toMatch(/SCAN|TEMP B-TREE/);
  } finally { db.close(); }
  const repos = createRepositories(path);
  try {
    expect(await repos.events.getLatestPermissionRequest('s', 't', 'same-id')).toMatchObject({ id: 'valid', data: { id: 'same-id', status: 'approved' } });
  } finally { repos.close(); rmSync(directory, { recursive: true, force: true }); }
});
