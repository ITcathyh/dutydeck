import type Database from 'better-sqlite3';

export function createCollaborationSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collaboration_scopes (
      app_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
      context_revision INTEGER NOT NULL DEFAULT 0 CHECK (context_revision >= 0),
      PRIMARY KEY (app_id, chat_id)
    );

    CREATE TABLE IF NOT EXISTS collaboration_settings (
      app_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      participation TEXT NOT NULL CHECK (participation IN ('off', 'observe', 'selective')),
      instructions TEXT NOT NULL CHECK (length(instructions) <= 8000),
      notifications_paused INTEGER NOT NULL CHECK (notifications_paused IN (0, 1)),
      max_proactive_per_hour INTEGER NOT NULL CHECK (max_proactive_per_hour >= 0 AND max_proactive_per_hour <= 60),
      max_decisions_per_hour INTEGER NOT NULL DEFAULT 60 CHECK (max_decisions_per_hour >= 0 AND max_decisions_per_hour <= 500),
      retention_days INTEGER NOT NULL CHECK (retention_days >= 1 AND retention_days <= 365),
      policy_version TEXT NOT NULL CHECK (length(policy_version) <= 64),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (app_id, chat_id)
    );

    CREATE TABLE IF NOT EXISTS collaboration_observations (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      source TEXT NOT NULL CHECK (length(source) <= 64),
      event_id TEXT NOT NULL CHECK (length(event_id) <= 128),
      occurred_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      sender_id TEXT CHECK (sender_id IS NULL OR length(sender_id) <= 128),
      sender_kind TEXT NOT NULL CHECK (sender_kind IN ('human', 'bot', 'system')),
      thread_id TEXT CHECK (thread_id IS NULL OR length(thread_id) <= 128),
      message_id TEXT CHECK (message_id IS NULL OR length(message_id) <= 128),
      text TEXT NOT NULL CHECK (length(text) <= 16000),
      refs_json TEXT NOT NULL CHECK (json_valid(refs_json)),
      origin TEXT NOT NULL CHECK (origin IN ('live', 'history', 'external')),
      missing_json TEXT NOT NULL CHECK (json_valid(missing_json)),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      UNIQUE (app_id, chat_id, source, event_id),
      UNIQUE (app_id, chat_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS collab_obs_scope_seq ON collaboration_observations(app_id, chat_id, sequence ASC);
    CREATE INDEX IF NOT EXISTS collab_obs_scope_thread ON collaboration_observations(app_id, chat_id, thread_id, sequence ASC);
    CREATE INDEX IF NOT EXISTS collab_obs_occurred ON collaboration_observations(occurred_at);

    CREATE TABLE IF NOT EXISTS collaboration_bootstraps (
      app_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'partial', 'failed')),
      cursor TEXT CHECK (cursor IS NULL OR length(cursor) <= 512),
      last_event_at TEXT,
      missing_json TEXT NOT NULL CHECK (json_valid(missing_json)),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (app_id, chat_id)
    );

    CREATE TABLE IF NOT EXISTS collaboration_followups (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      goal TEXT NOT NULL CHECK (length(goal) <= 2000),
      status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'cancelled')),
      progress TEXT NOT NULL CHECK (length(progress) <= 8000),
      steps_json TEXT NOT NULL CHECK (json_valid(steps_json)),
      owner_id TEXT CHECK (owner_id IS NULL OR length(owner_id) <= 128),
      due_at TEXT,
      result TEXT CHECK (result IS NULL OR length(result) <= 8000),
      source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
      task_ids_json TEXT NOT NULL CHECK (json_valid(task_ids_json)),
      external_refs_json TEXT NOT NULL CHECK (json_valid(external_refs_json)),
      fields_json TEXT NOT NULL CHECK (json_valid(fields_json)),
      created_by TEXT NOT NULL CHECK (length(created_by) <= 128),
      updated_by TEXT NOT NULL CHECK (length(updated_by) <= 128),
      provenance TEXT NOT NULL CHECK (provenance IN ('observed', 'inferred', 'confirmed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS collab_followups_scope ON collaboration_followups(app_id, chat_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS collab_followups_scope_status ON collaboration_followups(app_id, chat_id, status);

    CREATE TABLE IF NOT EXISTS collaboration_mandates (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      goal TEXT NOT NULL CHECK (length(goal) <= 2000),
      status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'cancelled', 'completed')),
      requester_id TEXT NOT NULL CHECK (length(requester_id) <= 128),
      source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
      followup_id TEXT REFERENCES collaboration_followups(id) ON DELETE SET NULL,
      schedule_definition_id TEXT NOT NULL CHECK (length(schedule_definition_id) <= 128),
      mode TEXT NOT NULL CHECK (mode IN ('notify', 'agent')),
      prompt TEXT NOT NULL CHECK (length(prompt) <= 8000),
      condition TEXT NOT NULL CHECK (condition IN ('always', 'followup_open', 'no_progress')),
      delivery_paused INTEGER NOT NULL CHECK (delivery_paused IN (0, 1)),
      catchup_policy TEXT NOT NULL CHECK (catchup_policy IN ('skip', 'coalesce')),
      last_progress_revision INTEGER CHECK (last_progress_revision IS NULL OR last_progress_revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS collab_mandates_scope ON collaboration_mandates(app_id, chat_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS collab_mandates_scope_status ON collaboration_mandates(app_id, chat_id, status);
    CREATE INDEX IF NOT EXISTS collab_mandates_followup ON collaboration_mandates(followup_id);

    CREATE TABLE IF NOT EXISTS collaboration_decisions (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      context_revision INTEGER NOT NULL CHECK (context_revision >= 0),
      policy_version TEXT NOT NULL CHECK (length(policy_version) <= 64),
      action TEXT NOT NULL CHECK (action IN ('silent', 'reply', 'act')),
      reason TEXT NOT NULL CHECK (length(reason) <= 2000),
      evidence_ids_json TEXT NOT NULL CHECK (json_valid(evidence_ids_json)),
      status TEXT NOT NULL CHECK (status IN ('candidate', 'suppressed', 'sent', 'failed')),
      response TEXT CHECK (response IS NULL OR length(response) <= 16000),
      input_snapshot_json TEXT NOT NULL CHECK (json_valid(input_snapshot_json)),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS collab_decisions_scope_created ON collaboration_decisions(app_id, chat_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS collaboration_feedbacks (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      decision_id TEXT NOT NULL REFERENCES collaboration_decisions(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL CHECK (length(actor_id) <= 128),
      correction TEXT NOT NULL CHECK (length(correction) <= 4000),
      expected_action TEXT CHECK (expected_action IS NULL OR expected_action IN ('silent', 'reply', 'act')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS collab_feedbacks_decision ON collaboration_feedbacks(app_id, chat_id, decision_id);
    CREATE INDEX IF NOT EXISTS collab_feedbacks_scope ON collaboration_feedbacks(app_id, chat_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS collaboration_actions (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      kind TEXT NOT NULL CHECK (length(kind) <= 64),
      mandate_id TEXT CHECK (mandate_id IS NULL OR length(mandate_id) <= 128),
      mandate_revision INTEGER CHECK (mandate_revision IS NULL OR mandate_revision >= 1),
      schedule_generation INTEGER CHECK (schedule_generation IS NULL OR schedule_generation >= 1),
      context_revision INTEGER CHECK (context_revision IS NULL OR context_revision >= 0),
      followup_revision INTEGER CHECK (followup_revision IS NULL OR followup_revision >= 1),
      requester_id TEXT NOT NULL CHECK (length(requester_id) <= 128),
      input_digest TEXT NOT NULL CHECK (length(input_digest) <= 128),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      status TEXT NOT NULL CHECK (status IN ('intent', 'sending', 'succeeded', 'failed', 'unknown', 'suppressed')),
      receipt TEXT CHECK (receipt IS NULL OR length(receipt) <= 4000),
      error TEXT CHECK (error IS NULL OR length(error) <= 4000),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS collab_actions_scope ON collaboration_actions(app_id, chat_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS collaboration_activities (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('followup', 'mandate', 'settings')),
      entity_id TEXT NOT NULL CHECK (length(entity_id) <= 128),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      actor_id TEXT NOT NULL CHECK (length(actor_id) <= 128),
      source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
      provenance TEXT NOT NULL CHECK (provenance IN ('observed', 'inferred', 'confirmed')),
      summary TEXT NOT NULL CHECK (length(summary) <= 1000),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS collab_activities_scope ON collaboration_activities(app_id, chat_id, created_at DESC);
  `);
}
