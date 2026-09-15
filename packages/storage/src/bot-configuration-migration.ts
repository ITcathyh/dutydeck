import type Database from 'better-sqlite3';

export function createBotConfigurationSchema(db: Database.Database): void {
  // 1. Rebuild channel_bots with v2 columns and checks
  db.exec(`
    CREATE TABLE channel_bots_v19 (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      authorization_revision INTEGER,
      connection_generation INTEGER,
      channel TEXT NOT NULL CHECK (channel = 'lark'),
      external_app_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      platform_display_name TEXT,
      brand TEXT NOT NULL CHECK (brand IN ('feishu', 'lark')),
      credential_ref TEXT REFERENCES secret_refs(id) ON DELETE RESTRICT,
      state TEXT NOT NULL,
      desired_listener_state TEXT NOT NULL,
      full_trust_confirmed INTEGER NOT NULL CHECK (full_trust_confirmed = 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(channel, external_app_id),
      CHECK (
        (schema_version = 1 AND
         revision >= 1 AND
         authorization_revision IS NULL AND
         connection_generation IS NULL AND
         platform_display_name IS NULL AND
         state IN ('staged', 'disabled') AND
         desired_listener_state = 'disabled'
        ) OR
        (schema_version = 2 AND
         authorization_revision IS NOT NULL AND
         connection_generation IS NOT NULL AND
         typeof(revision) = 'integer' AND revision >= 1 AND revision <= 9007199254740991 AND
         typeof(authorization_revision) = 'integer' AND authorization_revision >= 1 AND authorization_revision <= 9007199254740991 AND
         typeof(connection_generation) = 'integer' AND connection_generation >= 1 AND connection_generation <= 9007199254740991 AND
         state IN ('staged', 'enabled', 'disabled', 'deleted') AND
         desired_listener_state IN ('receiving', 'paused')
        )
      )
    );

    INSERT INTO channel_bots_v19 (
      id, schema_version, revision, authorization_revision, connection_generation,
      channel, external_app_id, display_name, platform_display_name, brand,
      credential_ref, state, desired_listener_state, full_trust_confirmed,
      created_at, updated_at
    )
    SELECT
      id, schema_version, revision, NULL, NULL,
      channel, external_app_id, display_name, NULL, brand,
      credential_ref, state, desired_listener_state, full_trust_confirmed,
      created_at, updated_at
    FROM channel_bots;

    DROP TABLE channel_bots;
    ALTER TABLE channel_bots_v19 RENAME TO channel_bots;
  `);

  // 2. Rebuild channel_bot_policies with v2 columns and checks
  db.exec(`
    CREATE TABLE channel_bot_policies_v19 (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      channel_bot_id TEXT NOT NULL REFERENCES channel_bots(id) ON DELETE RESTRICT,
      defaults_json TEXT NOT NULL,
      routing_defaults_json TEXT NOT NULL,
      access_policy_json TEXT NOT NULL,
      execution_json TEXT,
      presentation_json TEXT,
      group_tools_policy_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(channel_bot_id),
      CHECK (
        (schema_version = 1 AND
         revision >= 1 AND
         execution_json IS NULL AND
         presentation_json IS NULL
        ) OR
        (schema_version = 2 AND
         execution_json IS NOT NULL AND
         presentation_json IS NOT NULL AND
         typeof(revision) = 'integer' AND revision >= 1 AND revision <= 9007199254740991
        )
      )
    );

    INSERT INTO channel_bot_policies_v19 (
      id, schema_version, revision, channel_bot_id,
      defaults_json, routing_defaults_json, access_policy_json,
      execution_json, presentation_json, group_tools_policy_json,
      created_at, updated_at
    )
    SELECT
      id, schema_version, revision, channel_bot_id,
      defaults_json, routing_defaults_json, access_policy_json,
      NULL, NULL, group_tools_policy_json,
      created_at, updated_at
    FROM channel_bot_policies;

    DROP TABLE channel_bot_policies;
    ALTER TABLE channel_bot_policies_v19 RENAME TO channel_bot_policies;
  `);

  // 3. Rebuild group_bindings with v2 columns, checks and index
  db.exec(`
    CREATE TABLE group_bindings_v19 (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      channel_bot_id TEXT NOT NULL REFERENCES channel_bots(id) ON DELETE RESTRICT,
      external_chat_id TEXT NOT NULL,
      state TEXT NOT NULL,
      access_profile TEXT,
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
      UNIQUE(channel_bot_id, external_chat_id),
      CHECK (
        (schema_version = 1 AND
         revision >= 1 AND
         state IN ('staged', 'disabled', 'needs_review', 'archived') AND
         access_profile IS NULL
        ) OR
        (schema_version = 2 AND
         access_profile IS NOT NULL AND
         typeof(revision) = 'integer' AND revision >= 1 AND revision <= 9007199254740991 AND
         state IN ('staged', 'enabled', 'disabled', 'needs_review', 'archived') AND
         access_profile IN ('managed_group', 'new_group')
        )
      )
    );

    INSERT INTO group_bindings_v19 (
      id, schema_version, revision, channel_bot_id, external_chat_id,
      state, access_profile, oncall, agent_override_json, workspace_override_json,
      model_override_json, reasoning_override_json, role_policy_override_json,
      routing_override_json, access_override_json, group_tools_override_json,
      presentation_override_json, review_reasons_json, created_at, updated_at
    )
    SELECT
      id, schema_version, revision, channel_bot_id, external_chat_id,
      state, NULL, oncall, agent_override_json, workspace_override_json,
      model_override_json, reasoning_override_json, role_policy_override_json,
      routing_override_json, access_override_json, group_tools_override_json,
      presentation_override_json, review_reasons_json, created_at, updated_at
    FROM group_bindings;

    DROP TABLE group_bindings;
    ALTER TABLE group_bindings_v19 RENAME TO group_bindings;
    CREATE INDEX group_bindings_bot_state ON group_bindings(channel_bot_id, state);
  `);

  // 4. Create configuration_authority singleton
  db.exec(`
    CREATE TABLE configuration_authority (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      authority TEXT NOT NULL CHECK (authority IN ('legacy', 'v2')),
      migration_id TEXT,
      legacy_collection_digest TEXT CHECK (legacy_collection_digest IS NULL OR (length(legacy_collection_digest) = 64 AND legacy_collection_digest NOT GLOB '*[^0-9a-f]*')),
      completed_at TEXT
    );
    INSERT INTO configuration_authority (id, authority, migration_id, legacy_collection_digest, completed_at)
    VALUES (1, 'legacy', NULL, NULL, NULL);
  `);

  // 5. Create configuration_operations with json_valid constraints
  db.exec(`
    CREATE TABLE configuration_operations (
      operation_id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      actor_json TEXT NOT NULL CHECK (json_valid(actor_json)),
      target_json TEXT CHECK (target_json IS NULL OR json_valid(target_json)),
      payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      created_at TEXT NOT NULL
    );
  `);

  // 6. Create configuration_changes with sequence safe bounds
  db.exec(`
    CREATE TABLE configuration_changes (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK (typeof(sequence) = 'integer' AND sequence >= 1 AND sequence <= 9007199254740991),
      bot_id TEXT NOT NULL REFERENCES channel_bots(id) ON DELETE RESTRICT,
      change_kind TEXT NOT NULL CHECK (change_kind IN ('created', 'updated', 'deleted', 'restored', 'receiving_changed', 'enabled_changed', 'related_mutated', 'secret_rotated', 'full_trust_confirmed', 'full_trust_revoked', 'legacy_converted')),
      revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision >= 1 AND revision <= 9007199254740991),
      authorization_revision INTEGER NOT NULL CHECK (typeof(authorization_revision) = 'integer' AND authorization_revision >= 1 AND authorization_revision <= 9007199254740991),
      connection_generation INTEGER NOT NULL CHECK (typeof(connection_generation) = 'integer' AND connection_generation >= 1 AND connection_generation <= 9007199254740991),
      timestamp TEXT NOT NULL
    );
    CREATE INDEX configuration_changes_bot_seq ON configuration_changes(bot_id, sequence);
  `);

  // 7. Create configuration_versions
  db.exec(`
    CREATE TABLE configuration_versions (
      version_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES channel_bots(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision >= 1 AND revision <= 9007199254740991),
      change_sequence INTEGER NOT NULL REFERENCES configuration_changes(sequence) ON DELETE RESTRICT CHECK (typeof(change_sequence) = 'integer' AND change_sequence >= 1 AND change_sequence <= 9007199254740991),
      change_kind TEXT NOT NULL CHECK (change_kind IN ('created', 'updated', 'deleted', 'restored', 'receiving_changed', 'enabled_changed', 'related_mutated', 'secret_rotated', 'full_trust_confirmed', 'full_trust_revoked', 'legacy_converted')),
      operation_id TEXT NOT NULL REFERENCES configuration_operations(operation_id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      snapshot_digest TEXT NOT NULL CHECK (length(snapshot_digest) = 64 AND snapshot_digest NOT GLOB '*[^0-9a-f]*'),
      snapshot_json TEXT NOT NULL,
      UNIQUE(bot_id, revision)
    );
    CREATE INDEX configuration_versions_bot_rev ON configuration_versions(bot_id, revision DESC);
  `);

  // 8. Create full_trust_confirmations
  db.exec(`
    CREATE TABLE full_trust_confirmations (
      id TEXT PRIMARY KEY,
      channel_bot_id TEXT NOT NULL REFERENCES channel_bots(id) ON DELETE RESTRICT,
      bot_revision INTEGER NOT NULL CHECK (typeof(bot_revision) = 'integer' AND bot_revision >= 1 AND bot_revision <= 9007199254740991),
      scope_digest TEXT NOT NULL CHECK (length(scope_digest) = 64 AND scope_digest NOT GLOB '*[^0-9a-f]*'),
      scope_json TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('user_action', 'legacy_live')),
      confirmed_by_json TEXT,
      confirmed_at TEXT,
      legacy_source_digest TEXT CHECK (legacy_source_digest IS NULL OR (length(legacy_source_digest) = 64 AND legacy_source_digest NOT GLOB '*[^0-9a-f]*')),
      recorded_at TEXT,
      revoked_at TEXT,
      revoked_reason TEXT,
      CHECK (
        (source = 'user_action' AND
         confirmed_by_json IS NOT NULL AND
         confirmed_at IS NOT NULL AND
         legacy_source_digest IS NULL AND
         recorded_at IS NULL
        ) OR
        (source = 'legacy_live' AND
         confirmed_by_json IS NULL AND
         confirmed_at IS NULL AND
         legacy_source_digest IS NOT NULL AND
         recorded_at IS NOT NULL
        )
      )
    );
    CREATE INDEX full_trust_confirmations_bot ON full_trust_confirmations(channel_bot_id, bot_revision DESC);
  `);
}
