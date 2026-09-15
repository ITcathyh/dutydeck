import type Database from 'better-sqlite3';

/** Schema only. Business history is converted by execution.upgradeLegacy under maintenance. */
export function createTaskExecutionSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE execution_authority (id INTEGER PRIMARY KEY CHECK(id=1), authority TEXT NOT NULL CHECK(authority IN ('legacy','ledger_v1')));
    INSERT INTO execution_authority VALUES (1, 'legacy');
    CREATE TABLE task_requests (task_id TEXT PRIMARY KEY REFERENCES tasks(id), namespace TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id), request_key TEXT NOT NULL, request_digest TEXT NOT NULL, request_json TEXT CHECK(request_json IS NULL OR json_valid(request_json)), accepted_json TEXT CHECK(accepted_json IS NULL OR json_valid(accepted_json)), UNIQUE(namespace, session_id, request_key));
    CREATE TABLE task_attempts (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL,
      number INTEGER NOT NULL CHECK(number>0), revision INTEGER NOT NULL CHECK(revision>0),
      state TEXT NOT NULL CHECK(state IN ('preparing','active','suspended','reconcile_required','legacy_unresolved','settled')),
      submission_state TEXT NOT NULL CHECK(submission_state IN ('not_submitted','intent_recorded','acknowledged','legacy_unknown')),
      submission_id TEXT UNIQUE, settlement_id TEXT UNIQUE, json TEXT NOT NULL CHECK(json_valid(json)),
      UNIQUE(task_id, number),
      CHECK((state IN ('preparing','suspended') AND submission_state='not_submitted') OR (state='active' AND submission_state IN ('intent_recorded','acknowledged')) OR (state IN ('reconcile_required','legacy_unresolved') AND submission_state!='not_submitted') OR state='settled')
    );
    CREATE UNIQUE INDEX task_attempt_active_slot ON task_attempts(session_id) WHERE state IN ('preparing','active','reconcile_required');
    CREATE TABLE task_queue_actions (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','applied','blocked','obsolete')), json TEXT NOT NULL CHECK(json_valid(json)));
    CREATE TABLE driver_resources (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL, parent_id TEXT REFERENCES driver_resources(id), identity_id TEXT UNIQUE, revision INTEGER NOT NULL, json TEXT NOT NULL CHECK(json_valid(json)));
    CREATE INDEX driver_resources_session ON driver_resources(session_id);
    CREATE TABLE recovery_decisions (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), attempt_id TEXT, json TEXT NOT NULL CHECK(json_valid(json)));
    CREATE TABLE task_execution_commands (id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)), result TEXT NOT NULL CHECK(json_valid(result)));
  `);
  // Very early migration fixtures can lack tables they mark as already migrated.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='tasks'").get()) db.exec(`
    ALTER TABLE tasks ADD COLUMN current_attempt_id TEXT;
    ALTER TABLE tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE tasks ADD COLUMN digest_version TEXT NOT NULL DEFAULT 'legacy_unverifiable';
  `);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='events'").get()) db.exec(`
    ALTER TABLE events ADD COLUMN task_id TEXT;
    ALTER TABLE events ADD COLUMN attempt_id TEXT;
    ALTER TABLE events ADD COLUMN settlement_id TEXT;
    ALTER TABLE events ADD COLUMN source_key TEXT;
    CREATE UNIQUE INDEX events_source_key ON events(source_key) WHERE source_key IS NOT NULL;
    CREATE INDEX events_attempt_sequence ON events(attempt_id, sequence);
  `);
}
