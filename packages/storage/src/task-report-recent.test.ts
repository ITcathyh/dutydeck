import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

it('keeps latest receipt edge cases and external commits without a global window sort', async () => {
  const empty = createRepositories(':memory:');
  try { expect(await empty.tasks.listLatestPerSession!()).toEqual([]); } finally { empty.close(); }
  const directory = mkdtempSync(join(tmpdir(), 'latest-receipt-')), path = join(directory, 'test.db');
  const reader = createRepositories(path), writer = createRepositories(path);
  const save = (id: string, sessionId: string, prompt: string, status: string, createdAt = '1') => writer.tasks.save({ id, sessionId, prompt, status, createdAt, updatedAt: createdAt });
  try {
    await save('early', 'orphan', 'real', 'completed', '1');
    await save('cancelled', 'orphan', 'cancelled', 'cancelled', '2');
    await save('first-tie', 'ties', 'first', 'completed');
    await save('second-tie', 'ties', 'second', 'completed');
    await save('meaningful', 'blank', 'real', 'completed', '1');
    await save('blank', 'blank', '', 'queued', '2');
    const expected = new Map([['blank', 'blank'], ['orphan', 'cancelled'], ['ties', 'second-tie']]);
    expect(new Map((await reader.tasks.listLatestPerSession!()).map(task => [task.sessionId, task.id]))).toEqual(expected);
    await save('later', 'orphan', 'later', 'failed', '3');
    expect(new Map((await reader.tasks.listLatestPerSession!()).map(task => [task.sessionId, task.id]))).toEqual(new Map([...expected].map(([sessionId, id]) => [sessionId, sessionId === 'orphan' ? 'later' : id])));

    const verifier = createRepositories(path), prepare = vi.spyOn(Database.prototype, 'prepare');
    try {
      await verifier.tasks.listLatestPerSession!();
      const index = prepare.mock.calls.findIndex(([query]) => String(query).includes('WITH ids AS'));
      const query = String(prepare.mock.calls[index]?.[0]);
      expect(query).not.toContain('ROW_NUMBER');
      const database = prepare.mock.contexts[index] as Database.Database;
      const plan = database.prepare('EXPLAIN QUERY PLAN ' + query).all() as Array<{ detail: string }>;
      expect(plan.map(row => row.detail).join(' ')).toContain('tasks_session_created');
      expect(plan.map(row => row.detail).join(' ')).not.toMatch(/ROW_NUMBER|TEMP B-TREE/);
    } finally { prepare.mockRestore(); verifier.close(); }
  } finally { reader.close(); writer.close(); rmSync(directory, { recursive: true, force: true }); }
});
