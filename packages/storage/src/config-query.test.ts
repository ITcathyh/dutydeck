import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createRepositories } from './index.js';
import { runMigrations } from './migrations.js';

it('backfills JSON indexes without rewriting sources, selects matching legacy/current states and sees other connections', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'config-index-'));
  const path = join(directory, 'db.sqlite');
  const reader = createRepositories(path), writer = createRepositories(path), db = new Database(path);
  const occurrence = 'session_automation/occurrence/', ci = 'session_automation/ci/';
  try {
    for (const [id, runStatus, scheduleId, delivery] of [
      ['pending', 'pending', 's1', 'pending'], ['accepted', 'accepted', 's1', 'pending'],
      ['blocked', 'blocked', 's1', 'not_requested'], ['other', 'pending', 's2', 'pending'],
      ['completed', 'completed', 's1', 'error'], ['done', 'completed', 's1', 'delivered']
    ]) await writer.config.set(occurrence + id, JSON.stringify({ schemaVersion: id === 'accepted' ? 1 : 2, runStatus, scheduleId, delivery: { status: delivery } }));
    for (const status of ['waiting', 'dispatching', 'accepted', 'blocked', 'completed']) await writer.config.set(ci + status, JSON.stringify({ status, delivery: { status: status === 'completed' ? 'error' : 'not_requested' } }));
    const before = db.prepare('SELECT key,value FROM configs ORDER BY key').all();
    for (const name of ['config_occurrence_run', 'config_occurrence_delivery', 'config_ci_status', 'config_ci_delivery', 'config_relay_status']) db.exec(`DROP INDEX ${name}`);
    db.exec('DELETE FROM schema_migrations WHERE version=42');
    runMigrations(db);
    expect(db.prepare('SELECT key,value FROM configs ORDER BY key').all()).toEqual(before);
    expect((await reader.config.listByJsonField!(occurrence, { field: 'runStatus', values: ['pending', 'accepted', 'blocked'], scheduleId: 's1' })).map(row => row.key)).toEqual([occurrence + 'accepted', occurrence + 'blocked', occurrence + 'pending']);
    expect((await reader.config.listByJsonField!(occurrence, { field: 'delivery.status', values: ['pending', 'error'] })).map(row => row.key)).toEqual([occurrence + 'accepted', occurrence + 'completed', occurrence + 'other', occurrence + 'pending']);
    expect((await reader.config.listByJsonField!(ci, { field: 'status', values: ['waiting', 'dispatching', 'accepted'] })).map(row => row.key)).toEqual([ci + 'accepted', ci + 'dispatching', ci + 'waiting']);
    const spy = vi.spyOn(Database.prototype, 'prepare');
    await reader.config.listByJsonField!(occurrence, { field: 'runStatus', values: ['pending'], scheduleId: 's1' });
    const sql = spy.mock.calls[0]![0]; spy.mockRestore();
    const plan = JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('pending', 's1'));
    expect(plan).toContain('SEARCH configs USING INDEX config_occurrence_run');
    expect(plan).toContain('<expr>=? AND <expr>=?');
    const previous = await writer.config.get(occurrence + 'pending');
    expect(await writer.config.compareAndSet!(occurrence + 'pending', previous, JSON.stringify({ runStatus: 'completed', scheduleId: 's1' }))).toBe(true);
    expect((await reader.config.listByJsonField!(occurrence, { field: 'runStatus', values: ['pending'], scheduleId: 's1' }))).toEqual([]);
    expect(reader.config.getSync!(occurrence + 'pending')).toBe(await writer.config.get(occurrence + 'pending'));
  } finally { db.close(); reader.close(); writer.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('filters plans and same-id history by source session before decoding unrelated malformed rows', async () => {
  const repos = createRepositories(':memory:');
  try {
    for (const sessionId of ['public', 'private']) {
      await repos.config.set('session_automation/schedule/' + sessionId, JSON.stringify({ sessionId }));
      await repos.config.set('session_automation/occurrence/' + sessionId, JSON.stringify({ sessionId, scheduleId: 'same-plan' }));
    }
    await repos.config.set('session_automation/occurrence/broken', '{invalid');
    expect((await repos.config.listByJsonField!('session_automation/schedule/', { field: 'sessionId', values: ['public'] })).map(row => row.key)).toEqual(['session_automation/schedule/public']);
    expect((await repos.config.listByJsonField!('session_automation/occurrence/', { field: 'scheduleId', values: ['same-plan'], sessionId: 'public' })).map(row => row.key)).toEqual(['session_automation/occurrence/public']);
    expect(await repos.config.listByJsonField!('session_automation/schedule/', { field: 'sessionId', values: [] })).toEqual([]);
  } finally { repos.close(); }
});
