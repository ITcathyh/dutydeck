import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { createRepositories } from './index.js';

it('reads at most two recent receipts in same-millisecond insertion order using the existing index', async () => {
  const repos = createRepositories(':memory:');
  const prepare = vi.spyOn(Database.prototype, 'prepare');
  try {
    for (const id of ['a', 'b', 'c']) await repos.tasks.save({ id, sessionId: 's', prompt: id, status: 'completed', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' });
    await repos.tasks.save({ id: 'other', sessionId: 'other', prompt: 'other', status: 'completed', createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z' });
    prepare.mockClear();
    expect((await repos.tasks.listRecentBySession!('s')).map(task => task.id)).toEqual(['b', 'c']);
    const index = prepare.mock.calls.findIndex(([query]) => String(query).includes('FROM tasks'));
    const query = String(prepare.mock.calls[index]?.[0]);
    expect(query).toMatch(/LIMIT 2$/);
    const database = prepare.mock.contexts[index] as Database.Database;
    const plan = database.prepare('EXPLAIN QUERY PLAN ' + query).all('s') as Array<{ detail: string }>;
    expect(plan.map(row => row.detail).join(' ')).toContain('tasks_session_created');
    expect(plan.map(row => row.detail).join(' ')).not.toContain('TEMP B-TREE');
    expect(await repos.tasks.listRecentBySession!('missing')).toEqual([]);
  } finally { prepare.mockRestore(); repos.close(); }
});

it('lists each session\'s last receipt in one query, matching the last entry of listRecentBySession', async () => {
  const repos = createRepositories(':memory:');
  try {
    for (const id of ['a', 'b', 'c']) await repos.tasks.save({ id, sessionId: 's', prompt: id, status: 'completed', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' });
    await repos.tasks.save({ id: 'late', sessionId: 't', prompt: 'late', status: 'completed', createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z' });
    await repos.tasks.save({ id: 'early', sessionId: 't', prompt: 'early', status: 'completed', createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z' });
    const latest = new Map((await repos.tasks.listLatestPerSession!()).map(task => [task.sessionId, task.id]));
    expect(latest).toEqual(new Map([['s', 'c'], ['t', 'late']]));
    for (const sessionId of ['s', 't']) expect((await repos.tasks.listRecentBySession!(sessionId)).at(-1)?.id).toBe(latest.get(sessionId));
  } finally { repos.close(); }
});
