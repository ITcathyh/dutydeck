import { createScheduleExecutionSchema } from './schedule-execution-migration.js'
import type Database from 'better-sqlite3'
import { createTaskExecutionSchema } from './task-execution-migration.js'
import { createBotConfigurationSchema } from './bot-configuration-migration.js'
import { createCollaborationSchema } from './collaboration-migration.js'
import { pruneScheduleEntityVersions } from './schedule-foundation.js'
import { createCiWebhookSchema } from './ci-webhook.js'
import { createUsageLedgerSchema } from './usage-ledger.js'

export interface Migration {
  version: number
  name: string
  up(db: Database.Database): void
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>
  if (!columns.some(entry => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
}

function tableExistsForMigration(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up(db) {
      db.exec(`
    CREATE TABLE IF NOT EXISTS agent_configs (id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, name TEXT NOT NULL, metadata TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, machine_id TEXT, name TEXT NOT NULL, cwd TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, state TEXT NOT NULL, cwd TEXT NOT NULL, model TEXT, reasoning_effort TEXT, system_prompt TEXT, permission_mode TEXT DEFAULT 'ask', source TEXT, source_id TEXT, archived_at TEXT, protocol TEXT, run_id TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL, timestamp TEXT NOT NULL, data TEXT NOT NULL, raw TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS events_session_seq ON events(session_id, sequence);
    CREATE TABLE IF NOT EXISTS tool_calls (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS permission_requests (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS errors (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message TEXT NOT NULL, details TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS channel_mappings (id TEXT PRIMARY KEY, channel TEXT NOT NULL, external_id TEXT NOT NULL, session_id TEXT NOT NULL, extra TEXT, created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS channel_external ON channel_mappings(channel, external_id);
    CREATE TABLE IF NOT EXISTS configs (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)
    }
  },
  {
    version: 2,
    name: 'sessions_add_reasoning_effort',
    up(db) { ensureColumn(db, 'sessions', 'reasoning_effort', 'reasoning_effort TEXT') }
  },
  {
    version: 3,
    name: 'sessions_add_system_prompt',
    up(db) { ensureColumn(db, 'sessions', 'system_prompt', 'system_prompt TEXT') }
  },
  {
    version: 4,
    name: 'sessions_add_permission_mode',
    up(db) { ensureColumn(db, 'sessions', 'permission_mode', "permission_mode TEXT DEFAULT 'ask'") }
  },
  {
    version: 5,
    name: 'sessions_add_source',
    up(db) { ensureColumn(db, 'sessions', 'source', 'source TEXT') }
  },
  {
    version: 6,
    name: 'sessions_add_source_id',
    up(db) { ensureColumn(db, 'sessions', 'source_id', 'source_id TEXT') }
  },
  {
    version: 7,
    name: 'sessions_add_archived_at',
    up(db) { ensureColumn(db, 'sessions', 'archived_at', 'archived_at TEXT') }
  },
  {
    version: 8,
    name: 'channel_mappings_add_extra',
    up(db) { ensureColumn(db, 'channel_mappings', 'extra', 'extra TEXT') }
  },
  {
    version: 9,
    name: 'tasks_add_execution_context_and_session_index',
    up(db) {
      ensureColumn(db, 'tasks', 'execution_context', 'execution_context TEXT')
      db.exec('CREATE INDEX IF NOT EXISTS tasks_session_created ON tasks(session_id, created_at)')
    }
  },
  {
    version: 10,
    name: 'sessions_default_permission_to_ask',
    up(db) {
      // SQLite cannot alter a column default in place. Rebuild the table so
      // databases that already applied v4 stop creating full-trust sessions,
      // while keeping every existing session's explicit permission posture.
      // Very early pre-migration databases may lack these nullable v1 fields.
      ensureColumn(db, 'sessions', 'model', 'model TEXT')
      ensureColumn(db, 'sessions', 'protocol', 'protocol TEXT')
      ensureColumn(db, 'sessions', 'error', 'error TEXT')
      db.exec(`
        CREATE TABLE sessions_v10 (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          state TEXT NOT NULL,
          cwd TEXT NOT NULL,
          model TEXT,
          reasoning_effort TEXT,
          system_prompt TEXT,
          permission_mode TEXT DEFAULT 'ask',
          source TEXT,
          source_id TEXT,
          archived_at TEXT,
          protocol TEXT,
          run_id TEXT NOT NULL,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO sessions_v10 (
          id, agent_id, state, cwd, model, reasoning_effort, system_prompt,
          permission_mode, source, source_id, archived_at, protocol, run_id,
          error, created_at, updated_at
        )
        SELECT
          id, agent_id, state, cwd, model, reasoning_effort, system_prompt,
          permission_mode, source, source_id, archived_at, protocol, run_id,
          error, created_at, updated_at
        FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_v10 RENAME TO sessions;
      `)
    }
  },
  {
    version: 11,
    name: 'botmux_foundation_safety',
    up(db) {
      // These tables are intentionally additive. Existing Agent, Lark and
      // Session data stays authoritative until a later explicit cutover.
      db.exec(`
        CREATE TABLE secret_refs (
          id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL CHECK (schema_version = 1),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          kind TEXT NOT NULL CHECK (kind IN ('lark_app_secret', 'agent_env', 'generic')),
          provider TEXT NOT NULL,
          reference_key TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('configured', 'invalid')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE channel_bots (
          id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL CHECK (schema_version = 1),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          channel TEXT NOT NULL CHECK (channel = 'lark'),
          external_app_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          brand TEXT NOT NULL CHECK (brand IN ('feishu', 'lark')),
          credential_ref TEXT REFERENCES secret_refs(id) ON DELETE RESTRICT,
          state TEXT NOT NULL CHECK (state IN ('staged', 'disabled')),
          desired_listener_state TEXT NOT NULL CHECK (desired_listener_state = 'disabled'),
          full_trust_confirmed INTEGER NOT NULL CHECK (full_trust_confirmed = 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(channel, external_app_id)
        );
        CREATE TABLE foundation_entity_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_kind TEXT NOT NULL CHECK (entity_kind IN ('secret_ref', 'channel_bot')),
          entity_id TEXT NOT NULL,
          from_revision INTEGER,
          to_revision INTEGER NOT NULL CHECK (to_revision >= 1),
          before_json TEXT,
          after_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(entity_kind, entity_id, to_revision)
        );
        CREATE INDEX foundation_versions_entity ON foundation_entity_versions(entity_kind, entity_id, to_revision DESC);
      `)
    }
  },
  {
    version: 12,
    name: 'group_policy_foundation',
    up(db) {
      // WP1a is control-plane only: all tables are additive and contain no
      // listener, lease, schedule, SecretRef value or runtime dispatch state.
      db.exec(`
        CREATE TABLE channel_bot_policies (
          id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL CHECK (schema_version = 1),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          channel_bot_id TEXT NOT NULL REFERENCES channel_bots(id) ON DELETE RESTRICT,
          defaults_json TEXT NOT NULL,
          routing_defaults_json TEXT NOT NULL,
          access_policy_json TEXT NOT NULL,
          group_tools_policy_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(channel_bot_id)
        );
        CREATE TABLE group_bindings (
          id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL CHECK (schema_version = 1),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          channel_bot_id TEXT NOT NULL REFERENCES channel_bots(id) ON DELETE RESTRICT,
          external_chat_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('staged', 'disabled', 'needs_review', 'archived')),
          oncall INTEGER NOT NULL CHECK (oncall IN (0, 1)),
          agent_override_json TEXT NOT NULL,
          workspace_override_json TEXT NOT NULL,
          model_override_json TEXT NOT NULL,
          reasoning_override_json TEXT NOT NULL,
          role_policy_override_json TEXT NOT NULL,
          routing_override_json TEXT NOT NULL,
          access_override_json TEXT NOT NULL,
          group_tools_override_json TEXT NOT NULL,
          presentation_override_json TEXT NOT NULL,
          review_reasons_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(channel_bot_id, external_chat_id)
        );
        CREATE INDEX group_bindings_bot_state ON group_bindings(channel_bot_id, state);
        CREATE TABLE remote_chat_facts (
          id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL CHECK (schema_version = 1),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          channel_bot_id TEXT NOT NULL REFERENCES channel_bots(id) ON DELETE RESTRICT,
          external_chat_id TEXT NOT NULL,
          membership_state TEXT NOT NULL CHECK (membership_state IN ('member', 'not_member', 'inaccessible', 'unknown')),
          chat_type TEXT NOT NULL CHECK (chat_type IN ('group', 'topic_group', 'unknown')),
          display_name TEXT,
          observed_at TEXT NOT NULL,
          last_success_at TEXT,
          error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(channel_bot_id, external_chat_id)
        );
        CREATE INDEX remote_chat_facts_bot ON remote_chat_facts(channel_bot_id, observed_at DESC);
        CREATE TABLE role_assignments (
          id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL CHECK (schema_version = 1),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          channel_bot_id TEXT NOT NULL REFERENCES channel_bots(id) ON DELETE RESTRICT,
          group_binding_id TEXT REFERENCES group_bindings(id) ON DELETE RESTRICT,
          scope_key TEXT NOT NULL,
          principal_id TEXT NOT NULL CHECK (principal_id LIKE 'principal_%'),
          role TEXT NOT NULL CHECK (role IN ('can_talk', 'can_operate', 'admin')),
          operate_scope TEXT NOT NULL CHECK (operate_scope IN ('none', 'own_runs', 'group_runs', 'bot_runs')),
          action_gates_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
          expires_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(channel_bot_id, scope_key, principal_id, role)
        );
        CREATE INDEX role_assignments_lookup ON role_assignments(channel_bot_id, group_binding_id, principal_id, role, state, expires_at);
        CREATE TABLE wp1a_entity_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_kind TEXT NOT NULL CHECK (entity_kind IN ('channel_bot_policy', 'group_binding', 'remote_chat_fact', 'role_assignment')),
          entity_id TEXT NOT NULL,
          from_revision INTEGER,
          to_revision INTEGER NOT NULL CHECK (to_revision >= 1),
          before_json TEXT,
          after_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(entity_kind, entity_id, to_revision)
        );
        CREATE INDEX wp1a_versions_entity ON wp1a_entity_versions(entity_kind, entity_id, to_revision DESC);
      `)
    }
  },
  {
    version: 13,
    name: 'schedule_single_writer_foundation',
    up(db) {
      // WP-Schedule is a disabled control-plane ledger. No timer, listener,
      // dispatcher or executable workflow consumes these tables.
      db.exec(`
        CREATE TABLE schedule_definitions (
          id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL CHECK (schema_version = 1),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          channel_bot_id TEXT NOT NULL REFERENCES channel_bots(id) ON DELETE RESTRICT,
          group_binding_id TEXT REFERENCES group_bindings(id) ON DELETE RESTRICT,
          name TEXT NOT NULL,
          description TEXT,
          trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('at', 'interval', 'cron')),
          at_local_datetime TEXT,
          interval_seconds INTEGER,
          interval_anchor_at TEXT,
          cron_expression TEXT,
          timezone TEXT NOT NULL,
          dst_gap_policy TEXT NOT NULL CHECK (dst_gap_policy IN ('skip', 'shift_forward')),
          dst_overlap_policy TEXT NOT NULL CHECK (dst_overlap_policy IN ('first', 'second')),
          delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('chat', 'thread')),
          chat_ref TEXT NOT NULL,
          root_message_ref TEXT,
          continuation_policy TEXT NOT NULL CHECK (continuation_policy IN ('same_thread', 'new_topic', 'chat_root')),
          cwd_ref TEXT,
          payload_ref TEXT NOT NULL,
          identity_ref TEXT,
          secret_ref TEXT REFERENCES secret_refs(id) ON DELETE RESTRICT,
          source_ownership TEXT NOT NULL CHECK (source_ownership IN ('dutydeck', 'botmux')),
          source_namespace TEXT NOT NULL,
          source_schedule_ref TEXT,
          source_enabled INTEGER NOT NULL CHECK (source_enabled IN (0, 1)),
          state TEXT NOT NULL CHECK (state IN ('staged', 'disabled')),
          desired_executor_state TEXT NOT NULL CHECK (desired_executor_state = 'disabled'),
          current_generation INTEGER NOT NULL CHECK (current_generation >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (
            (trigger_kind = 'at' AND at_local_datetime IS NOT NULL AND interval_seconds IS NULL AND interval_anchor_at IS NULL AND cron_expression IS NULL) OR
            (trigger_kind = 'interval' AND at_local_datetime IS NULL AND interval_seconds >= 60 AND interval_anchor_at IS NOT NULL AND cron_expression IS NULL) OR
            (trigger_kind = 'cron' AND at_local_datetime IS NULL AND interval_seconds IS NULL AND interval_anchor_at IS NULL AND cron_expression IS NOT NULL)
          )
        );
        CREATE UNIQUE INDEX schedule_definitions_source ON schedule_definitions(source_namespace, source_schedule_ref) WHERE source_schedule_ref IS NOT NULL;
        CREATE INDEX schedule_definitions_bot_state ON schedule_definitions(channel_bot_id, state, updated_at DESC);

        CREATE TABLE schedule_generations (
          id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL CHECK (schema_version = 1),
          schedule_definition_id TEXT NOT NULL REFERENCES schedule_definitions(id) ON DELETE RESTRICT,
          generation INTEGER NOT NULL CHECK (generation >= 1),
          definition_revision INTEGER NOT NULL CHECK (definition_revision >= 1),
          definition_hash TEXT NOT NULL CHECK (length(definition_hash) = 64),
          timezone TEXT NOT NULL,
          identity_ref TEXT,
          secret_ref TEXT REFERENCES secret_refs(id) ON DELETE RESTRICT,
          state TEXT NOT NULL CHECK (state = 'staged_disabled'),
          created_at TEXT NOT NULL,
          UNIQUE(schedule_definition_id, generation)
        );

        CREATE TABLE schedule_occurrences (
          id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL CHECK (schema_version = 1),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          schedule_definition_id TEXT NOT NULL REFERENCES schedule_definitions(id) ON DELETE RESTRICT,
          schedule_generation_id TEXT NOT NULL REFERENCES schedule_generations(id) ON DELETE RESTRICT,
          generation INTEGER NOT NULL CHECK (generation >= 1),
          scheduled_for_utc TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK (state IN ('planned', 'source_owned_pending', 'settled', 'suppressed')),
          intent_kind TEXT NOT NULL CHECK (intent_kind = 'task_run_snapshot'),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(schedule_definition_id, generation, scheduled_for_utc)
        );
        CREATE INDEX schedule_occurrences_definition_time ON schedule_occurrences(schedule_definition_id, scheduled_for_utc DESC);

        CREATE TABLE schedule_watermarks (
          schedule_definition_id TEXT PRIMARY KEY REFERENCES schedule_definitions(id) ON DELETE RESTRICT,
          schema_version INTEGER NOT NULL CHECK (schema_version = 1),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          last_planned_occurrence_key TEXT,
          last_claimed_occurrence_key TEXT,
          last_started_occurrence_key TEXT,
          last_settled_occurrence_key TEXT,
          next_due_at TEXT,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE schedule_leases (
          id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL CHECK (schema_version = 1),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          lease_key TEXT NOT NULL UNIQUE,
          generation INTEGER NOT NULL CHECK (generation >= 0),
          holder_id TEXT,
          holder_identity_ref TEXT,
          secret_ref TEXT REFERENCES secret_refs(id) ON DELETE RESTRICT,
          state TEXT NOT NULL CHECK (state IN ('held', 'fenced', 'released')),
          schedule_set_hash TEXT NOT NULL CHECK (length(schedule_set_hash) = 64),
          fence_token INTEGER NOT NULL CHECK (fence_token >= 0),
          renewed_at TEXT,
          expires_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (state != 'held' OR (holder_id IS NOT NULL AND holder_identity_ref IS NOT NULL AND secret_ref IS NOT NULL AND renewed_at IS NOT NULL AND expires_at IS NOT NULL))
        );

        CREATE TABLE archived_integrations (
          id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL CHECK (schema_version = 1),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          channel_bot_id TEXT NOT NULL REFERENCES channel_bots(id) ON DELETE RESTRICT,
          kind TEXT NOT NULL CHECK (kind = 'hammer'),
          source_system TEXT NOT NULL CHECK (source_system = 'botmux'),
          source_enabled INTEGER NOT NULL CHECK (source_enabled IN (0, 1)),
          hammer_mode TEXT NOT NULL CHECK (hammer_mode IN ('full', 'lite', 'unknown')),
          enforce_gates INTEGER NOT NULL CHECK (enforce_gates IN (0, 1)),
          skills_injection TEXT NOT NULL CHECK (skills_injection IN ('prompt', 'runtime', 'none', 'unknown')),
          state TEXT NOT NULL CHECK (state = 'archived'),
          executor_state TEXT NOT NULL CHECK (executor_state = 'unavailable'),
          blocker_code TEXT NOT NULL CHECK (blocker_code = 'hammer_executor_unavailable'),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(channel_bot_id, kind)
        );

        CREATE TABLE schedule_entity_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_kind TEXT NOT NULL CHECK (entity_kind IN ('schedule_definition', 'schedule_lease', 'archived_integration')),
          entity_id TEXT NOT NULL,
          from_revision INTEGER,
          to_revision INTEGER NOT NULL CHECK (to_revision >= 1),
          before_json TEXT,
          after_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(entity_kind, entity_id, to_revision)
        );
        CREATE INDEX schedule_versions_entity ON schedule_entity_versions(entity_kind, entity_id, to_revision DESC);
      `)
    }
  },
  {
    version: 14,
    name: 'remote_identity_fact_fencing',
    up(db) {
      // Remote verification facts are a short-lived, fail-closed cache. The
      // migration deliberately expires every v12 RemoteChatFact because those
      // rows predate credential and identity version binding.
      db.exec(`
        CREATE TABLE remote_identity_facts (
          id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL CHECK (schema_version = 1),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          channel_bot_id TEXT NOT NULL REFERENCES channel_bots(id) ON DELETE RESTRICT,
          credential_ref_id TEXT NOT NULL REFERENCES secret_refs(id) ON DELETE RESTRICT,
          credential_revision INTEGER NOT NULL CHECK (credential_revision >= 1),
          credential_fingerprint TEXT NOT NULL CHECK (length(credential_fingerprint) = 64 AND credential_fingerprint NOT GLOB '*[^0-9a-f]*'),
          app_fingerprint TEXT NOT NULL CHECK (length(app_fingerprint) = 64 AND app_fingerprint NOT GLOB '*[^0-9a-f]*'),
          bot_identity_ref TEXT NOT NULL CHECK (bot_identity_ref LIKE 'remote_bot_%'),
          tenant_ref TEXT CHECK (tenant_ref IS NULL OR tenant_ref LIKE 'remote_tenant_%'),
          app_id_match INTEGER NOT NULL CHECK (app_id_match IN (0, 1)),
          checked_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(channel_bot_id)
        );
        CREATE INDEX remote_identity_facts_expiry ON remote_identity_facts(channel_bot_id, expires_at);

        ALTER TABLE remote_chat_facts ADD COLUMN credential_ref_id TEXT REFERENCES secret_refs(id) ON DELETE RESTRICT;
        ALTER TABLE remote_chat_facts ADD COLUMN credential_revision INTEGER;
        ALTER TABLE remote_chat_facts ADD COLUMN credential_fingerprint TEXT CHECK (credential_fingerprint IS NULL OR (length(credential_fingerprint) = 64 AND credential_fingerprint NOT GLOB '*[^0-9a-f]*'));
        ALTER TABLE remote_chat_facts ADD COLUMN identity_fact_id TEXT REFERENCES remote_identity_facts(id) ON DELETE RESTRICT;
        ALTER TABLE remote_chat_facts ADD COLUMN identity_revision INTEGER;
        ALTER TABLE remote_chat_facts ADD COLUMN expires_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
        ALTER TABLE remote_chat_facts ADD COLUMN invalidated_at TEXT;
        CREATE INDEX remote_chat_facts_current ON remote_chat_facts(channel_bot_id, external_chat_id, expires_at);
        CREATE INDEX remote_chat_facts_identity ON remote_chat_facts(identity_fact_id, identity_revision);
        CREATE INDEX remote_chat_facts_credential ON remote_chat_facts(credential_ref_id, credential_revision);
      `)
    }
  },
  {
    version: 15,
    name: 'schedule_source_ownership_rebrand',
    up(db) {
      // v13 把品牌名写进了 CHECK 约束（source_ownership IN ('dockmux', 'botmux')）。
      // 改名后新代码只会写 'dutydeck'，老库的约束会让每一次 Schedule 写入直接 SQLITE_CONSTRAINT_CHECK，
      // 已有行也会在读取时被 zod 判为非法枚举值。SQLite 不能 ALTER 掉 CHECK，只能重建表。
      const existing = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schedule_definitions'")
        .get() as { sql?: string } | undefined
      // 新装的库由改名后的 v13 直接建出正确约束，这里无事可做。
      if (!existing?.sql?.includes("'dockmux'")) return

      const rebuilt = existing.sql
        .replace("'dockmux'", "'dutydeck'")
        .replace('CREATE TABLE schedule_definitions', 'CREATE TABLE schedule_definitions_rebrand')
      const columns = (db.pragma('table_info(schedule_definitions)') as Array<{ name: string }>).map(entry => entry.name)
      // 老行的值是 'dockmux'，必须在搬运途中改写：直接 UPDATE 会撞上老表自己的约束。
      const selected = columns
        .map(name => (name === 'source_ownership'
          ? "CASE source_ownership WHEN 'dockmux' THEN 'dutydeck' ELSE source_ownership END"
          : `"${name}"`))
        .join(', ')
      const target = columns.map(name => `"${name}"`).join(', ')

      // The migration transaction disables FK enforcement before BEGIN and
      // verifies all references before COMMIT; deferring DROP's checks is insufficient.
      db.exec(rebuilt)
      db.exec(`INSERT INTO schedule_definitions_rebrand (${target}) SELECT ${selected} FROM schedule_definitions`)
      db.exec('DROP TABLE schedule_definitions')
      db.exec('ALTER TABLE schedule_definitions_rebrand RENAME TO schedule_definitions')
      db.exec(`
        CREATE UNIQUE INDEX schedule_definitions_source ON schedule_definitions(source_namespace, source_schedule_ref) WHERE source_schedule_ref IS NOT NULL;
        CREATE INDEX schedule_definitions_bot_state ON schedule_definitions(channel_bot_id, state, updated_at DESC);
      `)
    }
  },
  {
    version: 16,
    name: 'tasks_add_interrupted_by_actor',
    up(db) {
      // 中断操作者（飞书点按人 open_id）与任务发起人 executionContext.actorId 语义不同，单列承接。
      // 测试夹具可能手工标记早期迁移已应用却没真建 tasks 表；真实升级路径里 v1 已建表。
      const tasksExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
        .get();
      if (tasksExists) ensureColumn(db, 'tasks', 'interrupted_by_actor', 'interrupted_by_actor TEXT')
    }
  },
  {
    version: 17,
    name: 'tasks_add_queue_position',
    up(db) {
      // 队列内部稳定排序字段。对现有 status='queued' 且 NULL 位置的任务按每 session created_at、rowid
      // 稳定顺序赋 1..N；不改变 created_at/updated_at/status/execution_context 等其他字段。
      const tasksExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
        .get();
      if (!tasksExists) return;

      ensureColumn(db, 'tasks', 'queue_position', 'queue_position INTEGER');

      const queuedWithoutPos = db.prepare(`
        SELECT id, session_id
        FROM tasks
        WHERE status = 'queued' AND queue_position IS NULL
        ORDER BY session_id ASC, created_at ASC, rowid ASC
      `).all() as Array<{ id: string; session_id: string }>;

      if (queuedWithoutPos.length > 0) {
        const updateStmt = db.prepare('UPDATE tasks SET queue_position = ? WHERE id = ?');
        let currentSession = '';
        let pos = 0;
        for (const row of queuedWithoutPos) {
          if (row.session_id !== currentSession) {
            currentSession = row.session_id;
            pos = 1;
          } else {
            pos += 1;
          }
          updateStmt.run(pos, row.id);
        }
      }
    }
  },
  { version: 18, name: 'task_execution_schema_only', up: createTaskExecutionSchema },
  { version: 19, name: 'bot_configuration_storage_base', up: createBotConfigurationSchema },
  { version: 20, name: 'collaboration_foundation', up: createCollaborationSchema },
  { version: 21, name: 'collaboration_schedule_execution', up: createScheduleExecutionSchema },
  // collaboration_settings 建表在 v20，这里单独加列，让已按旧 v20 建好的库也能升级。
  // 默认 60：判定远比主动发言频繁，约等于每分钟一次的持续上限。
  { version: 22, name: 'collaboration_decision_budget', up(db) { ensureColumn(db, 'collaboration_settings', 'max_decisions_per_hour', 'max_decisions_per_hour INTEGER NOT NULL DEFAULT 60 CHECK (max_decisions_per_hour >= 0 AND max_decisions_per_hour <= 500)') } },
  // 呈现设置从 Bot 级下沉到群级：presentationOverride 由 `{"mode":"inherit"}` 改成逐字段结构，
  // Bot 级 presentation 增加两档静默形态。两列都是既有的 JSON 列，只改内容不改表结构，
  // 但已经建好的旧库里存的还是旧形态，读出来会被 schema 拒掉，所以在这里就地改写。
  { version: 23, name: 'group_presentation_override_fields', up: migratePresentationOverrides },
  { version: 24, name: 'collaboration_participation_inheritance', up(db) { ensureColumn(db, 'collaboration_settings', 'participation_inherited', 'participation_inherited INTEGER NOT NULL DEFAULT 0 CHECK (participation_inherited IN (0, 1))') } },
  {
    // 旧版本每个 tick 的租约续租都写一行 schedule_entity_versions（线上 5 天 40 万行）。
    // 续租不再写版本；这里把历史版本按实体收敛到保留窗口，租约实体只留下真正的持有者变更。
    version: 25,
    name: 'schedule_entity_versions_retention',
    up(db) {
      if (tableExistsForMigration(db, 'schedule_entity_versions')) pruneScheduleEntityVersions(db)
    }
  },
  // CI webhook 的 event-id 去重和任务绑定是短期记录：单独建表，过期或任务结束即删，不写进只增不删的 configs。
  { version: 26, name: 'ci_webhook_short_lived_records', up: createCiWebhookSchema },
  { version: 27, name: 'usage_ledger', up: createUsageLedgerSchema }
]

const INHERIT_PRESENTATION_OVERRIDE = {
  structuredAskCards: { mode: 'inherit' },
  groupCardMention: { mode: 'inherit' },
  pushIntervalMs: { mode: 'inherit' },
  traceLimit: { mode: 'inherit' },
  hideTraceOnComplete: { mode: 'inherit' },
  completionReactionOnly: { mode: 'inherit' },
  silentProgress: { mode: 'inherit' }
}

function migratePresentationOverrides(db: Database.Database): void {
  const tableExists = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))

  if (tableExists('group_bindings')) {
    const rows = db.prepare('SELECT id, presentation_override_json FROM group_bindings').all() as Array<{ id: string; presentation_override_json: string }>
    const update = db.prepare('UPDATE group_bindings SET presentation_override_json = ? WHERE id = ?')
    for (const row of rows) {
      let current: unknown
      try { current = JSON.parse(row.presentation_override_json) } catch { current = undefined }
      // 已经是逐字段结构（七项齐全）就不动；旧的 inherit-only 形态和任何别的内容都重写成全继承。
      const keys = current && typeof current === 'object' && !Array.isArray(current) ? current as Record<string, unknown> : undefined
      if (keys && Object.keys(INHERIT_PRESENTATION_OVERRIDE).every(key => key in keys)) continue
      update.run(JSON.stringify(INHERIT_PRESENTATION_OVERRIDE), row.id)
    }
  }

  if (!tableExists('channel_bot_policies')) return
  const policies = db.prepare('SELECT id, presentation_json FROM channel_bot_policies WHERE presentation_json IS NOT NULL').all() as Array<{ id: string; presentation_json: string }>
  const updatePolicy = db.prepare('UPDATE channel_bot_policies SET presentation_json = ? WHERE id = ?')
  for (const policy of policies) {
    let current: Record<string, unknown>
    try { current = JSON.parse(policy.presentation_json) as Record<string, unknown> } catch { continue }
    if (!current || typeof current !== 'object' || Array.isArray(current)) continue
    if ('completionReactionOnly' in current && 'silentProgress' in current) continue
    // 两档都默认关闭：升级不改变任何现存 Bot 的说话量。
    updatePolicy.run(JSON.stringify({ completionReactionOnly: false, silentProgress: false, ...current }), policy.id)
  }
}

/** Own the outer transaction required by SQLite's table-rebuild procedure. */
export function withMigrationTransaction(db: Database.Database, work: () => void): void {
  if (db.inTransaction) throw new Error('DATABASE_MIGRATION_REQUIRES_OUTER_TRANSACTION')
  const foreignKeys = db.pragma('foreign_keys', { simple: true }) as number
  let failed = false
  let failure: unknown
  try {
    db.pragma('foreign_keys = OFF')
    if (db.pragma('foreign_keys', { simple: true }) !== 0) throw new Error('DATABASE_MIGRATION_FOREIGN_KEYS_NOT_DISABLED')
    db.transaction(() => {
      work()
      const violations = db.pragma('foreign_key_check') as unknown[]
      if (violations.length) throw new Error(`DATABASE_MIGRATION_FOREIGN_KEY_CHECK_FAILED: ${JSON.stringify(violations)}`)
    }).immediate()
  } catch (error) {
    failed = true
    failure = error
    throw error
  } finally {
    try {
      db.pragma(`foreign_keys = ${foreignKeys}`)
      if (db.pragma('foreign_keys', { simple: true }) !== foreignKeys) throw new Error('DATABASE_MIGRATION_FOREIGN_KEYS_NOT_RESTORED')
    } catch (restoreError) {
      const errors = failed ? [failure, restoreError] : [restoreError]
      try { if (db.open) db.close() } catch (closeError) { errors.push(closeError) }
      throw new AggregateError(errors, 'Database migration foreign key restoration failed')
    }
  }
}

export function runMigrations(db: Database.Database): void {
  if (!db.inTransaction) {
    withMigrationTransaction(db, () => runMigrations(db))
    return
  }
  if (db.pragma('foreign_keys', { simple: true }) !== 0) throw new Error('DATABASE_MIGRATION_REQUIRES_FOREIGN_KEYS_DISABLED')
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
  const appliedVersions = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(row => row.version)
  )
  const recordApplied = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue
    db.transaction(() => {
      migration.up(db)
      recordApplied.run(migration.version, new Date().toISOString())
    })()
  }
}

export function needsMigration(db: Database.Database): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()) return true;
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(row => row.version));
  if ([...applied].some(version => !migrations.some(migration => migration.version === version))) throw new Error('DATABASE_SCHEMA_TOO_NEW');
  return migrations.some(migration => !applied.has(migration.version));
}
