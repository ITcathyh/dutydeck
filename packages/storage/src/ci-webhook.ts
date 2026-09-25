import type Database from 'better-sqlite3';
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

export function createCiWebhookRepository(sqlite: Database.Database): CiWebhookRepository {
  const claim = sqlite.transaction((eventKey: string, now: number, expiresAt: number) => {
    sqlite.prepare('DELETE FROM ci_webhook_events WHERE expires_at <= ?').run(now);
    return sqlite.prepare('INSERT INTO ci_webhook_events (event_key, expires_at) VALUES (?, ?) ON CONFLICT(event_key) DO NOTHING')
      .run(eventKey, expiresAt).changes === 1;
  });
  return {
    claimEvent: (eventKey, now, expiresAt) => claim.immediate(eventKey, now, expiresAt),
    releaseEvent(eventKey, expiresAt) {
      sqlite.prepare('DELETE FROM ci_webhook_events WHERE event_key = ? AND expires_at = ?').run(eventKey, expiresAt);
    },
    bindTask(taskId, subscriptionId, createdAt) {
      sqlite.prepare('INSERT INTO ci_webhook_tasks (task_id, subscription_id, created_at) VALUES (?, ?, ?) ON CONFLICT(task_id) DO NOTHING')
        .run(taskId, subscriptionId, createdAt);
    },
    taskSubscription(taskId) {
      return (sqlite.prepare('SELECT subscription_id FROM ci_webhook_tasks WHERE task_id = ?').get(taskId) as { subscription_id: string } | undefined)?.subscription_id;
    },
    listTaskBindings() {
      return (sqlite.prepare('SELECT task_id, subscription_id, created_at FROM ci_webhook_tasks ORDER BY created_at').all() as Array<{ task_id: string; subscription_id: string; created_at: number }>)
        .map(row => ({ taskId: row.task_id, subscriptionId: row.subscription_id, createdAt: row.created_at }));
    },
    unbindTask(taskId) {
      sqlite.prepare('DELETE FROM ci_webhook_tasks WHERE task_id = ?').run(taskId);
    }
  };
}
