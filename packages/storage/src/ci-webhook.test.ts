import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories } from './index.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function open() {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-ci-webhook-'));
  const path = join(root, 'dutydeck.db');
  const repos = createRepositories(path);
  cleanups.push(() => { repos.close(); rmSync(root, { recursive: true, force: true }); });
  const count = (table: string) => {
    const reader = new Database(path, { readonly: true });
    try { return (reader.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n; } finally { reader.close(); }
  };
  return { store: repos.ciWebhook, count };
}

describe('CI webhook 短期记录', () => {
  it('过期的去重记录在下次写入时物理删除，行数不随事件数一直增长', () => {
    const { store, count } = open();
    // 每秒一个事件、TTL 10 秒：任何时刻表里只剩最近 10 秒的记录。
    for (let index = 0; index < 200; index += 1) expect(store.claimEvent(`evt-${index}`, index * 1_000, index * 1_000 + 10_000)).toBe(true);
    expect(count('ci_webhook_events')).toBe(10);
    expect(store.claimEvent('evt-last', 1_000_000, 1_010_000)).toBe(true);
    expect(count('ci_webhook_events')).toBe(1);
  });

  it('TTL 内重复占用被拒，过期后可以重新占用；释放只删自己的那次占用', () => {
    const { store, count } = open();
    expect(store.claimEvent('evt', 0, 10_000)).toBe(true);
    expect(store.claimEvent('evt', 9_999, 19_999)).toBe(false);
    expect(store.claimEvent('evt', 10_000, 20_000)).toBe(true);
    store.releaseEvent('evt', 10_000);
    expect(count('ci_webhook_events')).toBe(1);
    store.releaseEvent('evt', 20_000);
    expect(count('ci_webhook_events')).toBe(0);
    expect(store.claimEvent('evt', 10_001, 20_001)).toBe(true);
  });

  it('任务绑定删除后不留行', () => {
    const { store, count } = open();
    store.bindTask('task_1', 'cbci_1', 1);
    store.bindTask('task_1', 'cbci_other', 2);
    store.bindTask('task_2', 'cbci_1', 3);
    expect(store.taskSubscription('task_1')).toBe('cbci_1');
    expect(store.listTaskBindings()).toEqual([{ taskId: 'task_1', subscriptionId: 'cbci_1', createdAt: 1 }, { taskId: 'task_2', subscriptionId: 'cbci_1', createdAt: 3 }]);
    store.unbindTask('task_1');
    store.unbindTask('task_2');
    expect(store.taskSubscription('task_1')).toBeUndefined();
    expect(count('ci_webhook_tasks')).toBe(0);
  });
});
