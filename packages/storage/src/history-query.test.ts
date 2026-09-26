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
    db.exec('DROP INDEX task_attempt_session_history; DELETE FROM schema_migrations WHERE version=28');
    runMigrations(db);
    for (const [sql, expected] of [
      ['SELECT json FROM task_attempts WHERE session_id=? ORDER BY number,id', 'task_attempt_session_history'],
      ['SELECT json FROM task_attempts WHERE task_id=? ORDER BY number', 'sqlite_autoindex_task_attempts_4'],
      ["SELECT 1 FROM task_attempts WHERE session_id=? AND state IN ('preparing','active','reconcile_required') LIMIT 1", 'task_attempt_active_slot']
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
