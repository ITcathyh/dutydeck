import type Database from 'better-sqlite3';
export function createPluginResultSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE plugin_result_deliveries (
      id TEXT PRIMARY KEY, requester_provider TEXT NOT NULL, requester_tenant TEXT NOT NULL, requester_subject TEXT NOT NULL,
      plugin TEXT NOT NULL, tool TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT NOT NULL, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
      call_id TEXT NOT NULL, input_digest TEXT NOT NULL, target_json TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT NOT NULL, lease_until INTEGER NOT NULL, file_count INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER NOT NULL DEFAULT 0,
      provider_key TEXT NOT NULL, message_id TEXT, first_send_at INTEGER, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, error_code TEXT,
      UNIQUE(session_id,task_id,attempt_id,plugin,tool,call_id));
    CREATE INDEX plugin_results_pending ON plugin_result_deliveries(requester_tenant,status,lease_until);
    CREATE TABLE plugin_result_files (id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL REFERENCES plugin_result_deliveries(id) ON DELETE CASCADE,
      name TEXT NOT NULL, byte_length INTEGER NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL);
    CREATE INDEX plugin_results_files ON plugin_result_files(delivery_id);
    CREATE TABLE plugin_result_oauth_states (state_hash TEXT PRIMARY KEY, browser_nonce_hash TEXT NOT NULL, delivery_id TEXT NOT NULL,
      provider TEXT NOT NULL, tenant TEXT NOT NULL, redirect_uri TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER);
    CREATE TABLE plugin_result_viewer_sessions (token_hash TEXT PRIMARY KEY, provider TEXT NOT NULL, tenant TEXT NOT NULL, subject TEXT NOT NULL, expires_at INTEGER NOT NULL);
  `);
}
