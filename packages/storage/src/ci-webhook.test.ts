import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from './index.js';
import { migrations, runMigrations, withMigrationTransaction } from './migrations.js';

const cleanups: Array<() => void> = [];
afterEach(() => { vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function open() {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-ci-webhook-'));
  const path = join(root, 'dutydeck.db');
  const repos = createRepositories(path);
  cleanups.push(() => { repos.close(); rmSync(root, { recursive: true, force: true }); });
  const count = (table: string) => {
    const reader = new Database(path, { readonly: true });
    try { return (reader.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n; } finally { reader.close(); }
  };
  return { store: repos.ciWebhook, count, repos, path };
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
    store.bindTask('task_1', 'ciw_1', 1);
    store.bindTask('task_1', 'ciw_other', 2);
    store.bindTask('task_2', 'ciw_1', 3);
    expect(store.taskSubscription('task_1')).toBe('ciw_1');
    expect(store.listTaskBindings()).toEqual([{ taskId: 'task_1', subscriptionId: 'ciw_1', createdAt: 1 }, { taskId: 'task_2', subscriptionId: 'ciw_1', createdAt: 3 }]);
    store.unbindTask('task_1');
    store.unbindTask('task_2');
    expect(store.taskSubscription('task_1')).toBeUndefined();
    expect(count('ci_webhook_tasks')).toBe(0);
  });
});


describe('CI durable admission storage', () => {
  const event = { eventKey: 'event-one', providerId: 'fake', payloadJson: '{"kind":"pipeline"}', targets: ['one', 'two'], now: 1_000, expiresAt: 2_000 };

  it('atomically freezes all target IDs and rejects payload identity conflicts', () => {
    const { store } = open();
    expect(store.acceptEvent(event)).toBe('accepted');
    expect(store.acceptEvent({ ...event, targets: ['later'] })).toBe('duplicate');
    expect(store.acceptEvent({ ...event, payloadJson: '{}' })).toBe('conflict');
    expect(store.acceptEvent({ ...event, providerId: 'other' })).toBe('conflict');
    expect(store.listPendingEvents()).toEqual([{ eventKey: event.eventKey, providerId: 'fake', payloadJson: event.payloadJson, receivedAt: 1_000, targets: ['one', 'two'] }]);
  });

  it('commits the subscription and target together, with CAS and guarded missing records', async () => {
    const { store, repos } = open();
    store.acceptEvent(event);
    await repos.config.set('ci_webhook/subscription/one', 'original');
    const target = { eventKey: event.eventKey, subscriptionId: 'one', configKey: 'ci_webhook/subscription/one', expectedConfig: 'stale', nextConfig: 'running', state: 'admitted' as const };
    expect(store.commitTarget(target)).toBe(false);
    expect(await repos.config.get(target.configKey)).toBe('original');
    expect(store.listPendingEvents()[0]!.targets).toEqual(['one', 'two']);
    expect(store.commitTarget({ ...target, expectedConfig: 'original' })).toBe(true);
    expect(await repos.config.get(target.configKey)).toBe('running');
    expect(store.commitTarget({ ...target, expectedConfig: 'running' })).toBe(false);
    const missing = { eventKey: event.eventKey, subscriptionId: 'two', configKey: 'ci_webhook/subscription/two', expectedConfig: undefined, state: 'skipped' as const };
    await repos.config.set(missing.configKey, 'concurrent subscription');
    expect(store.commitTarget(missing)).toBe(false);
    expect(store.commitTarget({ ...missing, expectedConfig: 'concurrent subscription' })).toBe(true);
    expect(store.listPendingEvents()).toHaveLength(0);
  });

  it('rolls back both subscription and target when a write fails in the transaction', async () => {
    const { store, repos, path } = open(); store.acceptEvent(event);
    await repos.config.set('subscription', 'before');
    const writer = new Database(path);
    try {
      writer.exec("CREATE TRIGGER fail_target BEFORE UPDATE ON ci_webhook_event_targets BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
      expect(() => store.commitTarget({ eventKey: event.eventKey, subscriptionId: 'one', configKey: 'subscription', expectedConfig: 'before', nextConfig: 'after', state: 'admitted' })).toThrow('injected failure');
      expect(await repos.config.get('subscription')).toBe('before');
      expect(store.listPendingEvents()[0]!.targets).toEqual(['one', 'two']);
    } finally { writer.close(); }
  });

  it('retains pending events beyond TTL and prevents plugin release from deleting recovery data', () => {
    const { store, count } = open(); store.acceptEvent(event);
    store.releaseEvent(event.eventKey, event.expiresAt);
    expect(count('ci_webhook_events')).toBe(1);
    store.claimEvent('later', 10_000, 20_000);
    expect(store.listPendingEvents()).toHaveLength(1);
    for (const subscriptionId of event.targets) expect(store.commitTarget({ eventKey: event.eventKey, subscriptionId, configKey: subscriptionId, expectedConfig: undefined, state: 'skipped' })).toBe(true);
    store.claimEvent('cleanup', 10_001, 20_001);
    expect(count('ci_webhook_event_targets')).toBe(0);
    expect(store.acceptEvent({ ...event, now: 10_002, expiresAt: 20_002 })).toBe('accepted');
  });

  it('keeps one acceptance and one CAS winner across SQLite connections and reopen', async () => {
    const { store, repos, path } = open(); const other = createRepositories(path);
    cleanups.push(() => other.close());
    expect(store.acceptEvent(event)).toBe('accepted');
    expect(other.ciWebhook.acceptEvent(event)).toBe('duplicate');
    await repos.config.set('subscription', 'before');
    const target = { eventKey: event.eventKey, subscriptionId: 'one', configKey: 'subscription', expectedConfig: 'before', nextConfig: 'running', state: 'admitted' as const };
    expect(store.commitTarget(target)).toBe(true);
    expect(other.ciWebhook.commitTarget(target)).toBe(false);
    repos.close(); other.close();
    const reopened = createRepositories(path); cleanups.push(() => reopened.close());
    expect(reopened.ciWebhook.listPendingEvents()[0]!.targets).toEqual(['two']);
    expect(await reopened.config.get('subscription')).toBe('running');
  });

  it('upgrades old dedupe rows, reopens durable admissions, and enforces cascading foreign keys', () => {
    vi.stubEnv('DUTYDECK_TEST_FRESH_SCHEMA_TEMPLATE', undefined);
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-ci-migration-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'old.db'); let db = new Database(path);
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT NOT NULL)');
    withMigrationTransaction(db, () => {
      for (const migration of migrations.filter(entry => entry.version < 50)) {
        migration.up(db);
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(migration.version, migration.name, '2026-01-01');
      }
      db.prepare('INSERT INTO ci_webhook_events (event_key, expires_at) VALUES (?, ?)').run('legacy', 99_000);
    });
    runMigrations(db); db.close();
    const repos = createRepositories(path);
    expect(repos.ciWebhook.claimEvent('legacy', 1_000, 30_000)).toBe(false);
    expect(repos.ciWebhook.acceptEvent(event)).toBe('accepted');
    repos.close();
    db = new Database(path);
    try {
      runMigrations(db); db.pragma('foreign_keys = ON');
      expect(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 50 });
      expect(db.prepare("SELECT provider_id, payload_json, received_at FROM ci_webhook_events WHERE event_key = 'legacy'").get()).toEqual({ provider_id: null, payload_json: null, received_at: null });
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(() => db.prepare("INSERT INTO ci_webhook_event_targets VALUES ('missing', 'target', 'pending')").run()).toThrow(/FOREIGN KEY/);
      db.prepare('DELETE FROM ci_webhook_events WHERE event_key = ?').run(event.eventKey);
      expect(db.prepare('SELECT COUNT(*) AS count FROM ci_webhook_event_targets').get()).toEqual({ count: 0 });
    } finally { db.close(); }
  });
});
