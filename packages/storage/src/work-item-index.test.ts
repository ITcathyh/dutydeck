import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createRepositories } from './index.js';

it('keeps scheduling, child ownership and unsettled capacity atomic with config CAS, rewrites and deletion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'work-item-index-')), path = join(directory, 'state.db');
  const repos = createRepositories(path), sqlite = new Database(path);
  try {
    const key = 'work_item:work', record = { stoppedAttempts: [] as string[], item: { parentSessionId: 'parent', status: 'blocked', steps: [{ status: 'blocked', attempts: [{ id: 'attempt', sessionId: 'child' }] }], delivery: { status: 'pending' } } };
    let raw = JSON.stringify(record);
    expect(await repos.config.compareAndSet!(key, undefined, raw)).toBe(true);
    expect(await repos.workItems.listScheduledIds()).toEqual(['work']);
    expect(await repos.workItems.findByChildSession('child')).toBe('work');
    expect(await repos.workItems.countActiveSteps()).toBe(1);
    expect(await repos.workItems.listByParent('parent')).toEqual([{ key, value: raw }]);
    expect(await repos.config.compareAndSet!(key, 'stale', '{}')).toBe(false);
    expect(await repos.workItems.countActiveSteps()).toBe(1);
    record.stoppedAttempts.push('attempt'); record.item.status = 'completed';
    const completed = JSON.stringify(record);
    expect(await repos.config.compareAndSet!(key, raw, completed)).toBe(true); raw = completed;
    expect(await repos.workItems.countActiveSteps()).toBe(0);
    expect(await repos.workItems.listScheduledIds()).toEqual(['work']);
    record.item.delivery.status = 'error'; await repos.config.set(key, JSON.stringify(record));
    expect(await repos.workItems.listScheduledIds()).toEqual(['work']);
    sqlite.pragma('foreign_keys = ON');
    sqlite.prepare('UPDATE configs SET key=? WHERE key=?').run('work_item:renamed', key);
    expect(await repos.workItems.listScheduledIds()).toEqual(['renamed']);
    expect(await repos.workItems.findByChildSession('child')).toBe('renamed');
    sqlite.prepare('UPDATE configs SET key=? WHERE key=?').run(key, 'work_item:renamed');
    record.item.delivery.status = 'delivered'; await repos.config.set(key, JSON.stringify(record));
    expect(await repos.workItems.listScheduledIds()).toEqual([]);
    expect(await repos.workItems.findByChildSession('child')).toBe('work');
    const plan = sqlite.prepare('EXPLAIN QUERY PLAN SELECT config_key FROM work_item_index WHERE needs_tick=1 ORDER BY config_key').all();
    expect(JSON.stringify(plan)).toContain('work_item_index_scheduled');
    await repos.config.set(key, '{invalid');
    expect(await repos.workItems.listScheduledIds()).toEqual(['work']);
    expect(await repos.workItems.findByChildSession('child')).toBeUndefined();
    sqlite.prepare('DELETE FROM configs WHERE key=?').run(key);
    expect(await repos.workItems.listScheduledIds()).toEqual([]);
    expect(sqlite.prepare('SELECT COUNT(*) FROM work_item_sessions').pluck().get()).toBe(0);
  } finally { sqlite.close(); repos.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('recovers pending and failed deliveries after reopening while retaining paused and unresolved work', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'work-item-index-reopen-')), path = join(directory, 'state.db');
  let repos = createRepositories(path);
  try {
    for (const [id, status, delivery] of [['pending', 'completed', 'pending'], ['retry', 'completed', 'error'], ['done', 'completed', 'delivered'], ['cancelled', 'cancelled', 'not_requested'], ['confirm', 'awaiting_confirmation', 'pending'], ['blocked', 'blocked', 'pending']] as const) {
      await repos.config.set(`work_item:${id}`, JSON.stringify({ item: { id, status, delivery: { status: delivery }, steps: [] } }));
    }
    repos.close(); repos = createRepositories(path);
    expect(await repos.workItems.listScheduledIds()).toEqual(['blocked', 'confirm', 'pending', 'retry']);
    await repos.config.set('work_item:retry', JSON.stringify({ item: { status: 'completed', delivery: { status: 'delivered' } } }));
    expect(await repos.workItems.listScheduledIds()).toEqual(['blocked', 'confirm', 'pending']);
  } finally { repos.close(); rmSync(directory, { recursive: true, force: true }); }
});
