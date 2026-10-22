import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from './index.js';
import { runMigrations } from './migrations.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
it('upgrades existing databases and uses indexes for session, task and active attempts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'history-query-')); directories.push(directory);
  const path = join(directory, 'test.db'); createRepositories(path).close();
  const db = new Database(path);
  try {
    db.exec('DROP INDEX task_attempts_session_order; DELETE FROM schema_migrations WHERE version=30');
    runMigrations(db);
    for (const [sql, expected] of [
      ['SELECT json FROM task_attempts WHERE session_id=? ORDER BY number,id', 'task_attempts_session_order'],
      ['SELECT json FROM task_attempts WHERE task_id=? ORDER BY number', 'sqlite_autoindex_task_attempts_4'],
      ["SELECT 1 FROM task_attempts WHERE session_id=? AND state IN ('preparing','active','reconcile_required') LIMIT 1", 'task_attempts_session_state']
    ]) {
      const plan = JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('s'));
      expect(plan).toContain('SEARCH'); expect(plan).not.toMatch(/SCAN|TEMP B-TREE/);
      if (expected !== 'sqlite_autoindex_task_attempts_4') expect(plan).toContain(expected);
      else expect(plan).toContain('(task_id=?)');
    }
  } finally { db.close(); }
});
it('summarizes only meaningful non-cancelled tasks while retaining first status and latest timestamp', async () => {
  const repos = createRepositories(':memory:');
  try {
    await repos.sessions.save({ id: 's', agentId: 'a', state: 'idle', cwd: '/tmp', runId: 'r', createdAt: '1', updatedAt: '1' });
    for (const [id, prompt, status, createdAt, updatedAt] of [
      ['blank', '\t\n\u3000', 'queued', '0', '9'], ['cancelled', 'wrong', 'cancelled', '0', '9'],
      ['first', '  real prompt \u3000', 'completed', '1', '1'], ['queue', 'later', 'queued', '2', '4'], ['last', 'last', 'failed', '3', '3']
    ]) await repos.tasks.save({ id, sessionId: 's', prompt, status, createdAt, updatedAt });
    const queries = vi.spyOn(Database.prototype, 'prepare');
    expect(await repos.tasks.listRunSummaries!()).toEqual([{ sessionId: 's', taskId: 'first', prompt: 'real prompt', status: 'completed', queuedCount: 1, updatedAt: '4' }]);
    expect(queries).toHaveBeenCalledTimes(1); queries.mockRestore();
  } finally { repos.close(); }
});

it('keeps first-task ties, cancellation, Unicode whitespace and external commits visible', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'summary-visible-')); directories.push(directory);
  const path = join(directory, 'test.db');
  const reader = createRepositories(path), writer = createRepositories(path);
  try {
    await writer.sessions.save({ id: 's', agentId: 'a', state: 'idle', cwd: '/tmp', runId: 'r', createdAt: '1', updatedAt: '1' });
    const first = { id: 'z-first', sessionId: 's', prompt: '\u00a0first\ufeff', status: 'completed' as const, createdAt: '1', updatedAt: '' };
    await writer.tasks.save(first);
    await writer.tasks.save({ ...first, id: 'a-second', prompt: 'second', status: 'queued', updatedAt: '2' });
    expect(await reader.tasks.listRunSummaries!()).toEqual([{ sessionId: 's', taskId: 'z-first', prompt: 'first', status: 'completed', updatedAt: '2', queuedCount: 1 }]);
    await writer.tasks.save({ ...first, status: 'cancelled' });
    expect(await reader.tasks.listRunSummaries!()).toEqual([{ sessionId: 's', taskId: 'a-second', prompt: 'second', status: 'queued', updatedAt: '2', queuedCount: 1 }]);
    await writer.tasks.save({ ...first, id: 'a-second', prompt: '\u2000\u2029', status: 'queued' });
    expect(await reader.tasks.listRunSummaries!()).toEqual([]);
  } finally { reader.close(); writer.close(); }
});

it('backfills the usage index and independently reads valid latest fields across connections', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'usage-visible-')); directories.push(directory);
  const path = join(directory, 'test.db');
  const writer = createRepositories(path);
  const event = (sequence: number, data: unknown) => ({ id: `usage-${sequence}`, sessionId: 's', sequence, type: 'status' as const, timestamp: String(sequence), data } as any);
  await writer.events.append(event(1, { state: 'usage', used: 0 }));
  await writer.events.append(event(2, { state: 'usage', rateLimits: { fiveHour: { usedPercent: 0 } } }));
  await writer.events.append(event(3, { state: 'usage', rateLimits: { sevenDay: { usedPercent: 10 } } }));
  const db = new Database(path);
  db.exec('DROP INDEX events_session_status; DROP INDEX sessions_created_id; DELETE FROM schema_migrations WHERE version=41');
  runMigrations(db);
  const plan = JSON.stringify(db.prepare("EXPLAIN QUERY PLAN SELECT * FROM events WHERE session_id=? AND type='status' AND json_extract(data,'$.state')='usage' ORDER BY sequence DESC LIMIT 1").all('s'));
  expect(plan).toContain('events_session_status');
  db.close();
  const reader = createRepositories(path);
  try {
    expect((await reader.events.listLatestUsage!('s')).map(row => row.sequence)).toEqual([1, 2, 3]);
    await writer.events.append(event(4, { state: 'usage', used: -1, rateLimits: { fiveHour: { usedPercent: 'invalid' }, sevenDay: { usedPercent: null } } }));
    expect((await reader.events.listLatestUsage!('s')).map(row => row.sequence)).toEqual([1, 2, 3]);
    await writer.events.append(event(5, { state: 'usage', used: 5 }));
    expect((await reader.events.listLatestUsage!('s')).map(row => row.sequence)).toEqual([5, 2, 3]);
    expect(await reader.events.listLatestUsage!('empty')).toEqual([]);
  } finally { reader.close(); writer.close(); }
});
