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
  `);
}

interface LedgerRow { app_id: string | null; chat_id: string | null; actor_id: string | null; category: string | null; entries: number; cost_usd: number | null; estimated_cost_usd: number | null; input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null; unavailable: number | null }
interface CapRow { scope: UsageCapScope; app_id: string; chat_id: string; monthly_cost_usd: number; updated_at: string }

const aggregates = `COUNT(*) AS entries, SUM(cost_usd) AS cost_usd, SUM(CASE WHEN cost_estimated = 1 THEN cost_usd END) AS estimated_cost_usd,
  SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
  SUM(CASE WHEN data_status = 'unavailable' THEN 1 ELSE 0 END) AS unavailable`;
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
    entries: row.entries, costUsd: row.cost_usd ?? 0, estimatedCostUsd: row.estimated_cost_usd ?? 0,
    inputTokens: row.input_tokens ?? 0, outputTokens: row.output_tokens ?? 0, cacheReadTokens: row.cache_read_tokens ?? 0, cacheWriteTokens: row.cache_write_tokens ?? 0,
    unavailable: row.unavailable ?? 0
  };
}

function capOf(row: CapRow): UsageCap {
  return { scope: row.scope, appId: row.app_id, ...(row.chat_id ? { chatId: row.chat_id } : {}), monthlyCostUsd: row.monthly_cost_usd, updatedAt: row.updated_at };
}

export function createUsageLedgerRepository(sqlite: Database.Database): UsageLedgerRepository {
  const insert = sqlite.prepare(`INSERT OR IGNORE INTO usage_ledger (id, recorded_at, app_id, chat_id, session_id, task_id, attempt_id, root_task_id, root_session_id, actor_id, category, origin, agent_id, model,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, cost_estimated, data_status, cumulative_cost_usd, usage_ref)
    VALUES (@id, @recordedAt, @appId, @chatId, @sessionId, @taskId, @attemptId, @rootTaskId, @rootSessionId, @actorId, @category, @origin, @agentId, @model,
    @inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens, @costUsd, @costEstimated, @dataStatus, @cumulativeCostUsd, @usageRef)`);
  const chatKey = (scope: UsageCapScope, chatId?: string) => scope === 'bot' ? '' : chatId ?? '';
  return {
    async append(entry: UsageLedgerEntry): Promise<boolean> {
      const nullable = (value: unknown) => value ?? null;
      return insert.run({
        id: entry.id, recordedAt: entry.recordedAt, appId: nullable(entry.appId), chatId: nullable(entry.chatId), sessionId: entry.sessionId, taskId: entry.taskId, attemptId: entry.attemptId,
        rootTaskId: nullable(entry.rootTaskId), rootSessionId: nullable(entry.rootSessionId), actorId: nullable(entry.actorId), category: entry.category, origin: entry.origin,
        agentId: entry.agentId, model: nullable(entry.model), inputTokens: nullable(entry.inputTokens), outputTokens: nullable(entry.outputTokens),
        cacheReadTokens: nullable(entry.cacheReadTokens), cacheWriteTokens: nullable(entry.cacheWriteTokens), costUsd: nullable(entry.costUsd),
        costEstimated: entry.costEstimated ? 1 : 0, dataStatus: entry.dataStatus, cumulativeCostUsd: nullable(entry.cumulativeCostUsd), usageRef: nullable(entry.usageRef)
      }).changes === 1;
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
