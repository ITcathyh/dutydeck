import type Database from 'better-sqlite3';
import { usageCategories, type UsageCap, type UsageCapScope, type UsageDimension, type UsageFilter, type UsageGroup, type UsageLedgerEntry, type UsageLedgerRepository, type UsageTotals } from '@dutydeck/shared';

export function createUsageLedgerSchema(db: Database.Database): void {
  const categories = usageCategories.map(category => `'${category}'`).join(', ');
  db.exec(`
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
      category TEXT NOT NULL CHECK (category IN (${categories})),
      origin TEXT NOT NULL CHECK (length(origin) <= 64),
      agent_id TEXT NOT NULL,
      model TEXT,
      provider TEXT NOT NULL DEFAULT 'unknown',
      model_source TEXT NOT NULL DEFAULT 'legacy_unknown',
      pricing_source TEXT NOT NULL DEFAULT 'legacy_unknown',
      pricing_version TEXT,
      pricing_match TEXT,
      unpriced_reason TEXT,
      input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
      output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
      cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
      cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
      cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
      cost_estimated INTEGER NOT NULL CHECK (cost_estimated IN (0, 1)),
      data_status TEXT NOT NULL CHECK (data_status IN ('reported', 'estimated', 'unpriced', 'unavailable')),
      cumulative_cost_usd REAL CHECK (cumulative_cost_usd IS NULL OR cumulative_cost_usd >= 0),
      usage_ref TEXT,
      UNIQUE (session_id, usage_ref)
    );
    CREATE INDEX IF NOT EXISTS usage_ledger_recorded ON usage_ledger(recorded_at);
    CREATE INDEX IF NOT EXISTS usage_ledger_app_recorded ON usage_ledger(app_id, chat_id, recorded_at);
    CREATE INDEX IF NOT EXISTS usage_ledger_session ON usage_ledger(session_id, recorded_at);
    CREATE INDEX IF NOT EXISTS usage_ledger_root_session ON usage_ledger(root_session_id);

    CREATE TABLE IF NOT EXISTS usage_background_admissions (
      app_id TEXT NOT NULL,
      month TEXT NOT NULL,
      task_id TEXT NOT NULL,
      admitted_at TEXT NOT NULL,
      PRIMARY KEY (app_id, task_id)
    );
    CREATE INDEX IF NOT EXISTS usage_background_month ON usage_background_admissions(month, app_id);

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
  `);
}

/** v29 preserves recorded bills and old estimate provenance without inventing
 * a provider/rate version. Old cache-write estimates were incomplete. */
export function migrateUsagePricing(db: Database.Database): void {
  const columns = db.pragma('table_info(usage_ledger)') as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'pricing_source')) {
    db.exec('ALTER TABLE usage_ledger RENAME TO usage_ledger_v27');
    createUsageLedgerSchema(db);
    const oldColumns = columns.map(column => `"${column.name}"`).join(', ');
    db.exec(`INSERT INTO usage_ledger (${oldColumns}) SELECT ${oldColumns} FROM usage_ledger_v27`);
    db.exec(`UPDATE usage_ledger SET cost_usd = NULL, cost_estimated = 0, data_status = 'unpriced', unpriced_reason = 'legacy_cache_write_rate_unknown'
      WHERE data_status = 'estimated' AND cache_write_tokens > 0`);
    db.exec('DROP TABLE usage_ledger_v27');
  }
  // Index names belonged to the renamed table until it was dropped.
  createUsageLedgerSchema(db);
}

interface LedgerRow { app_id: string | null; chat_id: string | null; actor_id: string | null; category: string | null; entries: number; token_entries: number | null; partial_token_entries: number | null; cost_usd: number | null; estimated_cost_usd: number | null; input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null; unavailable: number | null; unpriced: number | null; priced_entries: number | null }
interface CapRow { scope: UsageCapScope; app_id: string; chat_id: string; monthly_cost_usd: number; updated_at: string }

const aggregates = `COUNT(*) AS entries, SUM(cost_usd) AS cost_usd, SUM(CASE WHEN cost_estimated = 1 THEN cost_usd END) AS estimated_cost_usd,
  SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
  SUM(CASE WHEN input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR cache_read_tokens IS NOT NULL OR cache_write_tokens IS NOT NULL THEN 1 ELSE 0 END) AS token_entries,
  SUM(CASE WHEN (input_tokens IS NULL OR output_tokens IS NULL) AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR cache_read_tokens IS NOT NULL OR cache_write_tokens IS NOT NULL) THEN 1 ELSE 0 END) AS partial_token_entries,
  SUM(CASE WHEN data_status = 'unavailable' THEN 1 ELSE 0 END) AS unavailable,
  SUM(CASE WHEN data_status = 'unpriced' THEN 1 ELSE 0 END) AS unpriced,
  SUM(CASE WHEN cost_usd IS NOT NULL AND data_status IN ('reported', 'estimated') THEN 1 ELSE 0 END) AS priced_entries`;
/** 群按 (Bot, 群) 分组：同一个群里的两个 Bot 各算各的。 */
const groupings: Record<UsageDimension, Array<[keyof UsageGroup, string]>> = {
  appId: [['appId', 'app_id']], chatId: [['appId', 'app_id'], ['chatId', 'chat_id']], actorId: [['actorId', 'actor_id']], category: [['category', 'category']]
};

function where(filter: UsageFilter): { sql: string; values: string[] } {
  const clauses: string[] = [];
  const values: string[] = [];
  const add = (clause: string, value: string | undefined) => { if (value !== undefined) { clauses.push(clause); values.push(value); } };
  add('recorded_at >= ?', filter.since);
  add('app_id = ?', filter.appId);
  add('chat_id = ?', filter.chatId);
  add('session_id = ?', filter.sessionId);
  add('root_session_id = ?', filter.rootSessionId);
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

function totalsOf(row: LedgerRow): UsageTotals {
  return {
    entries: row.entries, tokenEntries: row.token_entries ?? 0, partialTokenEntries: row.partial_token_entries ?? 0, costUsd: row.cost_usd ?? 0, estimatedCostUsd: row.estimated_cost_usd ?? 0,
    inputTokens: row.input_tokens ?? 0, outputTokens: row.output_tokens ?? 0, cacheReadTokens: row.cache_read_tokens ?? 0, cacheWriteTokens: row.cache_write_tokens ?? 0,
    unavailable: row.unavailable ?? 0, unpriced: row.unpriced ?? 0, pricedEntries: row.priced_entries ?? 0,
    unknownCostEntries: row.entries - (row.priced_entries ?? 0), costCoverage: row.entries ? (row.priced_entries ?? 0) / row.entries : null
  };
}

function capOf(row: CapRow): UsageCap {
  return { scope: row.scope, appId: row.app_id, ...(row.chat_id ? { chatId: row.chat_id } : {}), monthlyCostUsd: row.monthly_cost_usd, updatedAt: row.updated_at };
}

export function createUsageLedgerRepository(sqlite: Database.Database): UsageLedgerRepository {
  const insert = sqlite.prepare(`INSERT OR IGNORE INTO usage_ledger (id, recorded_at, app_id, chat_id, session_id, task_id, attempt_id, root_task_id, root_session_id, actor_id, category, origin, agent_id, model, provider, model_source, pricing_source, pricing_version, pricing_match, unpriced_reason,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, cost_estimated, data_status, cumulative_cost_usd, usage_ref)
    VALUES (@id, @recordedAt, @appId, @chatId, @sessionId, @taskId, @attemptId, @rootTaskId, @rootSessionId, @actorId, @category, @origin, @agentId, @model, @provider, @modelSource, @pricingSource, @pricingVersion, @pricingMatch, @unpricedReason,
    @inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens, @costUsd, @costEstimated, @dataStatus, @cumulativeCostUsd, @usageRef)`);
  const chatKey = (scope: UsageCapScope, chatId?: string) => scope === 'bot' ? '' : chatId ?? '';
  return {
    async append(entry: UsageLedgerEntry): Promise<boolean> {
      const nullable = (value: unknown) => value ?? null;
      return insert.run({
        id: entry.id, recordedAt: entry.recordedAt, appId: nullable(entry.appId), chatId: nullable(entry.chatId), sessionId: entry.sessionId, taskId: entry.taskId, attemptId: entry.attemptId,
        rootTaskId: nullable(entry.rootTaskId), rootSessionId: nullable(entry.rootSessionId), actorId: nullable(entry.actorId), category: entry.category, origin: entry.origin,
        agentId: entry.agentId, model: nullable(entry.model), provider: entry.provider ?? 'unknown', modelSource: entry.modelSource ?? 'legacy_unknown',
        pricingSource: entry.pricingSource ?? 'legacy_unknown', pricingVersion: nullable(entry.pricingVersion), pricingMatch: nullable(entry.pricingMatch), unpricedReason: nullable(entry.unpricedReason), inputTokens: nullable(entry.inputTokens), outputTokens: nullable(entry.outputTokens),
        cacheReadTokens: nullable(entry.cacheReadTokens), cacheWriteTokens: nullable(entry.cacheWriteTokens), costUsd: nullable(entry.costUsd),
        costEstimated: entry.costEstimated ? 1 : 0, dataStatus: entry.dataStatus, cumulativeCostUsd: nullable(entry.cumulativeCostUsd), usageRef: nullable(entry.usageRef)
      }).changes === 1;
    },
    async claimBackgroundTask(appId, month, taskId, limit): Promise<boolean> {
      if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid automatic task limit');
      return sqlite.transaction(() => {
        if (sqlite.prepare('SELECT 1 FROM usage_background_admissions WHERE app_id = ? AND task_id = ?').get(appId, taskId)) return true;
        const { count } = sqlite.prepare('SELECT COUNT(*) AS count FROM usage_background_admissions WHERE app_id = ? AND month = ?').get(appId, month) as { count: number };
        if (count >= limit) return false;
        sqlite.prepare('INSERT INTO usage_background_admissions (app_id, month, task_id, admitted_at) VALUES (?, ?, ?, ?)').run(appId, month, taskId, new Date().toISOString());
        return true;
      }).immediate();
    },
    async backgroundTaskCounts(month) {
      return (sqlite.prepare('SELECT app_id AS appId, COUNT(*) AS tasks FROM usage_background_admissions WHERE month = ? GROUP BY app_id ORDER BY app_id').all(month)) as Array<{ appId: string; tasks: number }>;
    },
    async hasAttempt(attemptId: string): Promise<boolean> {
      return Boolean(sqlite.prepare('SELECT 1 FROM usage_ledger WHERE attempt_id = ?').get(attemptId));
    },
    async hasUsageRef(sessionId: string, usageRef: string): Promise<boolean> {
      return Boolean(sqlite.prepare('SELECT 1 FROM usage_ledger WHERE session_id = ? AND usage_ref = ?').get(sessionId, usageRef));
    },
    async lastCumulativeCost(sessionId: string, excludeAttemptId?: string): Promise<number | undefined> {
      const row = sqlite.prepare('SELECT cumulative_cost_usd FROM usage_ledger WHERE session_id = ? AND cumulative_cost_usd IS NOT NULL ORDER BY recorded_at DESC, rowid DESC LIMIT 1')
        .get(sessionId) as { cumulative_cost_usd: number } | undefined;
      if (row) return row.cumulative_cost_usd;
      // 账本上线前就在跑的会话没有记录可比：退回到事件表里此前各轮流式上报的累计成本，避免首轮把历史成本整笔记进来。
      const reported = sqlite.prepare(`SELECT json_extract(data, '$.cost.amount') AS amount FROM events
        WHERE session_id = ? AND type = 'status' AND json_extract(data, '$.state') = 'usage' AND json_extract(data, '$.cost.amount') IS NOT NULL AND attempt_id IS NOT ?
        ORDER BY sequence DESC LIMIT 1`).get(sessionId, excludeAttemptId ?? null) as { amount: number } | undefined;
      return typeof reported?.amount === 'number' ? reported.amount : undefined;
    },
    async listEntries(filter: UsageFilter, taskIds?: string[]): Promise<UsageLedgerEntry[]> {
      const query = where(filter);
      if (taskIds !== undefined) {
        query.sql += `${query.sql ? ' AND ' : 'WHERE '}task_id IN (SELECT value FROM json_each(?))`;
        query.values.push(JSON.stringify([...new Set(taskIds)]));
      }
      const { sql, values } = query;
      const columns = {
        id: 'id', recordedAt: 'recorded_at', appId: 'app_id', chatId: 'chat_id', sessionId: 'session_id', taskId: 'task_id', attemptId: 'attempt_id',
        rootTaskId: 'root_task_id', rootSessionId: 'root_session_id', actorId: 'actor_id', category: 'category', origin: 'origin', agentId: 'agent_id',
        model: 'model', provider: 'provider', modelSource: 'model_source', pricingSource: 'pricing_source', pricingVersion: 'pricing_version',
        pricingMatch: 'pricing_match', unpricedReason: 'unpriced_reason', inputTokens: 'input_tokens', outputTokens: 'output_tokens',
        cacheReadTokens: 'cache_read_tokens', cacheWriteTokens: 'cache_write_tokens', costUsd: 'cost_usd', costEstimated: 'cost_estimated',
        dataStatus: 'data_status', cumulativeCostUsd: 'cumulative_cost_usd', usageRef: 'usage_ref'
      };
      const projection = Object.entries(columns).map(([key, column]) => `${column} AS "${key}"`).join(', ');
      const rows = sqlite.prepare(`SELECT ${projection} FROM usage_ledger ${sql} ORDER BY recorded_at, id`).all(...values) as Array<Record<string, unknown>>;
      return rows.map(row => ({ ...Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)), costEstimated: row.costEstimated === 1 }) as unknown as UsageLedgerEntry);
    },
    async totals(filter: UsageFilter): Promise<UsageTotals> {
      const { sql, values } = where(filter);
      return totalsOf(sqlite.prepare(`SELECT ${aggregates} FROM usage_ledger ${sql}`).get(...values) as LedgerRow);
    },
    async summarize(dimension: UsageDimension, filter: UsageFilter): Promise<UsageGroup[]> {
      const { sql, values } = where(filter);
      const keys = groupings[dimension];
      const list = keys.map(([, column]) => column).join(', ');
      const rows = sqlite.prepare(`SELECT ${list}, ${aggregates} FROM usage_ledger ${sql} GROUP BY ${list} ORDER BY SUM(cost_usd) DESC, COUNT(*) DESC`).all(...values) as LedgerRow[];
      return rows.map(row => {
        const group: Record<string, unknown> = {};
        for (const [key, column] of keys) {
          const value = (row as unknown as Record<string, string | null>)[column];
          if (value !== null && value !== undefined) group[key] = value;
        }
        return { ...group, ...totalsOf(row) } as UsageGroup;
      });
    },
    async listCaps(): Promise<UsageCap[]> {
      return (sqlite.prepare('SELECT * FROM usage_caps ORDER BY scope, app_id, chat_id').all() as CapRow[]).map(capOf);
    },
    async setCap(cap): Promise<UsageCap> {
      const updatedAt = new Date().toISOString();
      sqlite.prepare(`INSERT INTO usage_caps (scope, app_id, chat_id, monthly_cost_usd, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(scope, app_id, chat_id) DO UPDATE SET monthly_cost_usd = excluded.monthly_cost_usd, updated_at = excluded.updated_at`)
        .run(cap.scope, cap.appId, chatKey(cap.scope, cap.chatId), cap.monthlyCostUsd, updatedAt);
      return { scope: cap.scope, appId: cap.appId, ...(cap.scope === 'group' && cap.chatId ? { chatId: cap.chatId } : {}), monthlyCostUsd: cap.monthlyCostUsd, updatedAt };
    },
    async deleteCap(scope, appId, chatId): Promise<boolean> {
      return sqlite.prepare('DELETE FROM usage_caps WHERE scope = ? AND app_id = ? AND chat_id = ?').run(scope, appId, chatKey(scope, chatId)).changes === 1;
    },
    async claimAlert(scope, appId, chatId, month, threshold): Promise<boolean> {
      return sqlite.prepare('INSERT OR IGNORE INTO usage_cap_alerts (scope, app_id, chat_id, month, threshold, notified_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(scope, appId, chatKey(scope, chatId), month, threshold, new Date().toISOString()).changes === 1;
    },
    async releaseAlert(scope, appId, chatId, month, threshold): Promise<void> {
      sqlite.prepare('DELETE FROM usage_cap_alerts WHERE scope = ? AND app_id = ? AND chat_id = ? AND month = ? AND threshold = ?').run(scope, appId, chatKey(scope, chatId), month, threshold);
    }
  };
}
