import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
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
    // 5000 条无关的历史文本事件只用来撑大表，单事务批量写入；被测的权限事件仍走 events.append。
    const filler = new Database(path);
    const insert = filler.prepare('INSERT INTO events (id,session_id,task_id,sequence,type,timestamp,data) VALUES (?,?,?,?,?,?,?)');
    filler.transaction(() => {
      for (let sequence = 1; sequence <= 5000; sequence++) insert.run(`s-${sequence}`, 's', 't', sequence, 'text', String(sequence), JSON.stringify({ text: 'x'.repeat(500) }));
    })();
    filler.close();
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

it('checks exact string permission ids across tasks and sees external commits without caching', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'permission-event-exists-'));
  const path = join(directory, 'state.db'), writer = createRepositories(path), reader = createRepositories(path);
  const unicode = '审批-é-🙂';
  try {
    await writer.events.append(permission('s', 'task-b', 1, 'approved', 'cross-task'));
    await writer.events.append({ ...permission('s', undefined, 0, 'rejected', 'null-task'), attemptId: 'attempt-old' });
    await writer.events.append(permission('s', 'task-a', 2, 'pending', 'duplicate'));
    await writer.events.append(permission('s', 'task-b', 3, 'approved', 'duplicate'));
    await writer.events.append(permission('other-session', 'task-a', 1, 'approved', 'other-session'));
    await writer.events.append({ ...permission('s', 'task-a', 4, 'approved', 'other-type'), type: 'text' } as AgentEvent);
    await writer.events.append(permission('s', undefined, -1, 'approved', unicode));

    expect(await reader.events.hasPermissionRequest('s', 'cross-task')).toBe(true);
    expect(await reader.events.hasPermissionRequest('s', 'null-task')).toBe(true);
    expect(await reader.events.hasPermissionRequest('s', 'duplicate')).toBe(true);
    expect(await reader.events.hasPermissionRequest('s', 'other-session')).toBe(false);
    expect(await reader.events.hasPermissionRequest('other-session', 'other-session')).toBe(true);
    expect(await reader.events.hasPermissionRequest('s', 'other-type')).toBe(false);
    expect(await reader.events.hasPermissionRequest('s', unicode)).toBe(true);
    expect(await reader.events.hasPermissionRequest('s', '审批-é-🙂')).toBe(false);
    expect(await reader.events.hasPermissionRequest('s', 'external')).toBe(false);
    await writer.events.append(permission('s', 'new-task', 5, 'approved', 'external'));
    expect(await reader.events.hasPermissionRequest('s', 'external')).toBe(true);
  } finally { reader.close(); writer.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('rejects non-string JSON ids and ignores malformed or non-object rows', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'permission-event-json-types-'));
  const path = join(directory, 'state.db'), repos = createRepositories(path), db = new Database(path);
  const insert = db.prepare('INSERT INTO events (id,session_id,task_id,sequence,type,timestamp,data) VALUES (?,?,?,?,?,?,?)');
  const cases = [
    ['object', { value: 'x' }, '{"value":"x"}'],
    ['array', ['x'], '["x"]'],
    ['number', 7, '7'],
    ['boolean-true', true, '1'],
    ['boolean-false', false, '0'],
    ['null', null, 'null']
  ] as const;
  try {
    for (const [name, id] of cases) insert.run(`${name}-nontext`, `type-${name}`, null, 1, 'permission_request', '1', JSON.stringify({ id }));
    for (const [name, , nativeId] of cases) expect(await repos.events.hasPermissionRequest(`type-${name}`, nativeId)).toBe(false);
    for (const [name, , nativeId] of cases) insert.run(`${name}-text`, `type-${name}`, null, 2, 'permission_request', '2', JSON.stringify({ id: nativeId }));
    for (const [name, , nativeId] of cases) expect(await repos.events.hasPermissionRequest(`type-${name}`, nativeId)).toBe(true);

    for (const [index, data] of ['{broken', 'null', '[{"id":"valid"}]', '"valid"'].entries()) {
      insert.run(`invalid-${index}`, 'invalid', null, index + 1, 'permission_request', String(index + 1), data);
    }
    expect(await repos.events.hasPermissionRequest('invalid', 'valid')).toBe(false);
    insert.run('invalid-valid', 'invalid', null, 10, 'permission_request', '10', JSON.stringify({ id: 'valid' }));
    expect(await repos.events.hasPermissionRequest('invalid', 'valid')).toBe(true);
    // 定向查询忽略坏行；旧的全量读取仍会 JSON.parse 并抛错，这是明确接受的健壮性差异。
    await expect(repos.events.list('invalid')).rejects.toThrow(SyntaxError);
  } finally { db.close(); repos.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('uses the permission index session prefix for the existence query', async () => {
  const repos = createRepositories(':memory:');
  const prepare = vi.spyOn(Database.prototype, 'prepare');
  try {
    expect(await repos.events.hasPermissionRequest('s', 'missing')).toBe(false);
    const index = prepare.mock.calls.findIndex(([query]) => String(query).includes('SELECT EXISTS') && String(query).includes('events_permission_request'));
    expect(index).toBeGreaterThanOrEqual(0);
    const query = String(prepare.mock.calls[index]![0]);
    expect(query).toContain("CASE WHEN json_valid(data) THEN json_extract(data,'$.id') END=?");
    expect(query).toContain("CASE WHEN json_valid(data) THEN json_type(data,'$.id') END='text'");
    const database = prepare.mock.contexts[index] as Database.Database;
    const plan = database.prepare(`EXPLAIN QUERY PLAN ${query}`).all('s', 'missing') as Array<{ detail: string }>;
    const details = plan.map(row => row.detail).join('\n');
    expect(details).toContain('SEARCH events USING INDEX events_permission_request (session_id=?)');
    expect(details).not.toContain('SCAN events');
    expect(details).not.toContain('TEMP B-TREE');
  } finally { prepare.mockRestore(); repos.close(); }
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
