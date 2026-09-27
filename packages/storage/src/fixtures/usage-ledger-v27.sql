-- Historical schema from master 8f6fd0c, before usage pricing migration 29.

    CREATE TABLE IF NOT EXISTS usage_ledger (
      id TEXT PRIMARY KEY,
      recorded_at TEXT NOT NULL,
      app_id TEXT,
      chat_id TEXT,
      session_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL UNIQUE,
      root_task_id TEXT,
      root_session_id TEXT,
      actor_id TEXT,
      category TEXT NOT NULL CHECK (category IN ('explicit', 'proactive', 'scheduled', 'background')),
      origin TEXT NOT NULL CHECK (length(origin) <= 64),
      agent_id TEXT NOT NULL,
      model TEXT,
      input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
      output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
      cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
      cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
      cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
      cost_estimated INTEGER NOT NULL CHECK (cost_estimated IN (0, 1)),
      data_status TEXT NOT NULL CHECK (data_status IN ('reported', 'estimated', 'unavailable')),
      cumulative_cost_usd REAL CHECK (cumulative_cost_usd IS NULL OR cumulative_cost_usd >= 0),
      usage_ref TEXT,
      UNIQUE (session_id, usage_ref)
    );
    CREATE INDEX IF NOT EXISTS usage_ledger_recorded ON usage_ledger(recorded_at);
    CREATE INDEX IF NOT EXISTS usage_ledger_app_recorded ON usage_ledger(app_id, chat_id, recorded_at);
    CREATE INDEX IF NOT EXISTS usage_ledger_session ON usage_ledger(session_id, recorded_at);
    CREATE INDEX IF NOT EXISTS usage_ledger_root_session ON usage_ledger(root_session_id);

    CREATE TABLE IF NOT EXISTS usage_caps (
      scope TEXT NOT NULL CHECK (scope IN ('bot', 'group')),
      app_id TEXT NOT NULL,
      chat_id TEXT NOT NULL DEFAULT '',
      monthly_cost_usd REAL NOT NULL CHECK (monthly_cost_usd > 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope, app_id, chat_id),
      CHECK ((scope = 'bot') = (chat_id = ''))
    );

    CREATE TABLE IF NOT EXISTS usage_cap_alerts (
      scope TEXT NOT NULL,
      app_id TEXT NOT NULL,
      chat_id TEXT NOT NULL DEFAULT '',
      month TEXT NOT NULL,
      threshold INTEGER NOT NULL,
      notified_at TEXT NOT NULL,
      PRIMARY KEY (scope, app_id, chat_id, month, threshold)
    );
