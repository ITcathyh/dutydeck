import type Database from 'better-sqlite3';

/**
 * Session Insight 派生缓存（设计第 5.1 节）。
 *
 * 四张表均为可重算的派生数据：
 * - insight_sources：不可变的私有来源观察（含私有路径，仅私有存储，不进公开 DTO）。
 * - insight_snapshots：固定分析结果，按 (session_id, cache_key) 唯一。淘汰时行不物理删除，
 *   置 tombstoned=1 并清空三份 JSON 与事件，使固定 snapshot 请求能区分 410 Gone 与从未存在。
 * - insight_events：快照事件，随快照级联删除，支持 kind / result_status 分页筛选。
 * - insight_refresh：每 session 一行的作业状态与当前快照指针，CAS 防旧作业覆盖。
 *
 * source / snapshot / refresh 都外键引用 sessions；删除 session 时级联清理派生缓存，
 * 但绝不触碰 tasks / usage / execution 等权威账本。
 */
export function createSessionInsightSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS insight_sources (
      observation_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      driver_instance_id TEXT NOT NULL,
      source_key TEXT,
      proof_kind TEXT NOT NULL CHECK (proof_kind IN ('launch_observed','historical_verified','inferred')),
      private_payload_json TEXT NOT NULL CHECK (json_valid(private_payload_json)),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS insight_sources_session ON insight_sources(session_id, created_at);
    CREATE INDEX IF NOT EXISTS insight_sources_source_key ON insight_sources(session_id, source_key) WHERE source_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS insight_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      cache_key TEXT NOT NULL CHECK (length(cache_key) = 64),
      schema_version INTEGER NOT NULL,
      engine_version TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      metric_version TEXT NOT NULL,
      redaction_version TEXT NOT NULL,
      summary_json TEXT CHECK (summary_json IS NULL OR json_valid(summary_json)),
      manifest_json TEXT CHECK (manifest_json IS NULL OR json_valid(manifest_json)),
      host_evidence_json TEXT CHECK (host_evidence_json IS NULL OR json_valid(host_evidence_json)),
      payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK (payload_bytes >= 0),
      tombstoned INTEGER NOT NULL DEFAULT 0 CHECK (tombstoned IN (0, 1)),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS insight_snapshots_session_created ON insight_snapshots(session_id, created_at);
    -- 同一 session 的活跃 cache key 唯一；tombstone 行保留用于 410 Gone，不阻止同内容重新发布。
    CREATE UNIQUE INDEX IF NOT EXISTS insight_snapshots_active_cache_key
      ON insight_snapshots(session_id, cache_key) WHERE tombstoned = 0;

    CREATE TABLE IF NOT EXISTS insight_events (
      snapshot_id TEXT NOT NULL REFERENCES insight_snapshots(snapshot_id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      event_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      tool_name TEXT,
      result_status TEXT,
      event_json TEXT NOT NULL CHECK (json_valid(event_json)),
      PRIMARY KEY (snapshot_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS insight_events_kind ON insight_events(snapshot_id, kind, ordinal);
    CREATE INDEX IF NOT EXISTS insight_events_result ON insight_events(snapshot_id, result_status, ordinal);
    CREATE UNIQUE INDEX IF NOT EXISTS insight_events_event_id ON insight_events(snapshot_id, event_id);

    CREATE TABLE IF NOT EXISTS insight_refresh (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      request_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('idle','queued','running','succeeded','failed','cancelled','interrupted')),
      binding_revision INTEGER NOT NULL DEFAULT 0 CHECK (binding_revision >= 0),
      current_snapshot_id TEXT REFERENCES insight_snapshots(snapshot_id) ON DELETE SET NULL,
      process_run_id TEXT,
      queued_at TEXT,
      started_at TEXT,
      finished_at TEXT,
      last_checked_at TEXT,
      error_code TEXT
    );
  `);
}
