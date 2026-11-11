import type Database from 'better-sqlite3';
import { cachedStatement } from './statement-cache.js';
import type { CiWebhookRepository } from '@dutydeck/shared';

export function createCiWebhookSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ci_webhook_events (
      event_key TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ci_webhook_events_expires ON ci_webhook_events(expires_at);

    CREATE TABLE IF NOT EXISTS ci_webhook_tasks (
      task_id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

/** Separate migration: v26 keeps its original schema and semantics. */
export function createCiWebhookAdmissionSchema(db: Database.Database): void {
  db.exec(`
    ALTER TABLE ci_webhook_events ADD COLUMN provider_id TEXT;
    ALTER TABLE ci_webhook_events ADD COLUMN payload_json TEXT;
    ALTER TABLE ci_webhook_events ADD COLUMN received_at INTEGER;
    CREATE TABLE ci_webhook_event_targets (
      event_key TEXT NOT NULL REFERENCES ci_webhook_events(event_key) ON DELETE CASCADE,
      subscription_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'admitted', 'skipped')),
      PRIMARY KEY (event_key, subscription_id)
    );
  `);
}

export function createCiWebhookRepository(sqlite: Database.Database): CiWebhookRepository {
  const cleanup = (now: number) => cachedStatement(sqlite, `DELETE FROM ci_webhook_events WHERE expires_at <= ?
    AND NOT EXISTS (SELECT 1 FROM ci_webhook_event_targets WHERE event_key = ci_webhook_events.event_key AND state = 'pending')`).run(now);
  const accept = sqlite.transaction((input: Parameters<CiWebhookRepository['acceptEvent']>[0]) => {
    cleanup(input.now);
    const existing = cachedStatement(sqlite, 'SELECT provider_id, payload_json FROM ci_webhook_events WHERE event_key = ?').get(input.eventKey) as { provider_id: string | null; payload_json: string | null } | undefined;
    if (existing) return existing.payload_json === null || (existing.provider_id === input.providerId && existing.payload_json === input.payloadJson) ? 'duplicate' as const : 'conflict' as const;
    cachedStatement(sqlite, 'INSERT INTO ci_webhook_events (event_key, expires_at, provider_id, payload_json, received_at) VALUES (?, ?, ?, ?, ?)').run(input.eventKey, input.expiresAt, input.providerId, input.payloadJson, input.now);
    for (const target of new Set(input.targets)) cachedStatement(sqlite, "INSERT INTO ci_webhook_event_targets (event_key, subscription_id, state) VALUES (?, ?, 'pending')").run(input.eventKey, target);
    return 'accepted' as const;
  });
  const commit = sqlite.transaction((input: Parameters<CiWebhookRepository['commitTarget']>[0]) => {
    const target = cachedStatement(sqlite, "SELECT 1 FROM ci_webhook_event_targets WHERE event_key = ? AND subscription_id = ? AND state = 'pending'").get(input.eventKey, input.subscriptionId);
    if (!target) return false;
    const config = cachedStatement(sqlite, 'SELECT value FROM configs WHERE key = ?').get(input.configKey) as { value: string } | undefined;
    if (config?.value !== input.expectedConfig) return false;
    if (input.nextConfig !== undefined) cachedStatement(sqlite, 'INSERT INTO configs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(input.configKey, input.nextConfig);
    cachedStatement(sqlite, 'UPDATE ci_webhook_event_targets SET state = ? WHERE event_key = ? AND subscription_id = ?').run(input.state, input.eventKey, input.subscriptionId);
    return true;
  });
  const claim = sqlite.transaction((eventKey: string, now: number, expiresAt: number) => {
    cleanup(now);
    return cachedStatement(sqlite, 'INSERT INTO ci_webhook_events (event_key, expires_at) VALUES (?, ?) ON CONFLICT(event_key) DO NOTHING')
      .run(eventKey, expiresAt).changes === 1;
  });
  return {
    acceptEvent: input => accept.immediate(input),
    commitTarget: input => commit.immediate(input),
    listPendingEvents() {
      const rows = cachedStatement(sqlite, `SELECT event_key, provider_id, payload_json, received_at FROM ci_webhook_events e
        WHERE payload_json IS NOT NULL AND EXISTS (SELECT 1 FROM ci_webhook_event_targets t WHERE t.event_key = e.event_key AND t.state = 'pending')
        ORDER BY received_at, event_key`).all() as Array<{ event_key: string; provider_id: string; payload_json: string; received_at: number }>;
      return rows.map(row => ({ eventKey: row.event_key, providerId: row.provider_id, payloadJson: row.payload_json, receivedAt: row.received_at,
        targets: (cachedStatement(sqlite, "SELECT subscription_id FROM ci_webhook_event_targets WHERE event_key = ? AND state = 'pending' ORDER BY subscription_id").all(row.event_key) as Array<{ subscription_id: string }>).map(target => target.subscription_id) }));
    },
    claimEvent: (eventKey, now, expiresAt) => claim.immediate(eventKey, now, expiresAt),
    releaseEvent(eventKey, expiresAt) {
      cachedStatement(sqlite, 'DELETE FROM ci_webhook_events WHERE event_key = ? AND expires_at = ? AND payload_json IS NULL').run(eventKey, expiresAt);
    },
    bindTask(taskId, subscriptionId, createdAt) {
      cachedStatement(sqlite, 'INSERT INTO ci_webhook_tasks (task_id, subscription_id, created_at) VALUES (?, ?, ?) ON CONFLICT(task_id) DO NOTHING')
        .run(taskId, subscriptionId, createdAt);
    },
    taskSubscription(taskId) {
      return (cachedStatement(sqlite, 'SELECT subscription_id FROM ci_webhook_tasks WHERE task_id = ?').get(taskId) as { subscription_id: string } | undefined)?.subscription_id;
    },
    listTaskBindings() {
      return (cachedStatement(sqlite, 'SELECT task_id, subscription_id, created_at FROM ci_webhook_tasks ORDER BY created_at').all() as Array<{ task_id: string; subscription_id: string; created_at: number }>)
        .map(row => ({ taskId: row.task_id, subscriptionId: row.subscription_id, createdAt: row.created_at }));
    },
    unbindTask(taskId) {
      cachedStatement(sqlite, 'DELETE FROM ci_webhook_tasks WHERE task_id = ?').run(taskId);
    }
  };
}
