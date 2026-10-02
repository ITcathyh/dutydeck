import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UsageLedgerEntry } from '@dutydeck/shared';
import { createRepositories } from './index.js';

const entry = (patch: Partial<UsageLedgerEntry>): UsageLedgerEntry => ({
  id: `usage_${patch.attemptId ?? 'a1'}`, recordedAt: '2026-09-10T00:00:00.000Z', appId: 'cli_a', chatId: 'oc_1', sessionId: 'ses_1', taskId: 'task_1', attemptId: 'a1',
  actorId: 'ou_1', category: 'explicit', origin: 'lark_group', agentId: 'claude', costEstimated: false, dataStatus: 'reported', ...patch
});

describe('usage ledger repository', () => {
  it('records one entry per attempt and per usage ref', async () => {
    const repos = createRepositories(':memory:');
    try {
      expect(await repos.usage.append(entry({ attemptId: 'a1', usageRef: 'req_1', costUsd: 0.5, cumulativeCostUsd: 0.5 }))).toBe(true);
      expect(await repos.usage.append(entry({ id: 'usage_dup', attemptId: 'a1', costUsd: 9 }))).toBe(false);
      expect(await repos.usage.append(entry({ id: 'usage_other', attemptId: 'a2', usageRef: 'req_1', costUsd: 9 }))).toBe(false);
      expect(await repos.usage.hasAttempt('a1')).toBe(true);
      expect(await repos.usage.hasUsageRef('ses_1', 'req_1')).toBe(true);
      expect(await repos.usage.hasUsageRef('ses_2', 'req_1')).toBe(false);
      expect(await repos.usage.append(entry({ attemptId: 'a3', recordedAt: '2026-09-11T00:00:00.000Z', costUsd: 0.25, cumulativeCostUsd: 0.75 }))).toBe(true);
      expect(await repos.usage.append(entry({ attemptId: 'a4', recordedAt: '2026-09-12T00:00:00.000Z', dataStatus: 'unavailable' }))).toBe(true);
      expect(await repos.usage.lastCumulativeCost('ses_1')).toBe(0.75);
      expect(await repos.usage.lastCumulativeCost('ses_2')).toBeUndefined();
      expect(await repos.usage.totals({ sessionId: 'ses_1' })).toMatchObject({ entries: 3, costUsd: 0.75, unavailable: 1 });
    } finally { repos.close(); }
  });

  it('falls back to the last streamed cumulative cost of an earlier attempt when the ledger has no baseline', async () => {
    const repos = createRepositories(':memory:');
    try {
      const event = (sequence: number, attemptId: string, data: unknown) => repos.events.append({ id: `evt_${sequence}`, sessionId: 'ses_1', sequence, type: 'status', timestamp: '2026-09-10T00:00:00.000Z', data, taskId: 'task_1', attemptId } as any);
      await event(1, 'old_1', { state: 'usage', used: 1, size: 2, cost: { amount: 1.5, currency: 'USD' } });
      await event(2, 'old_2', { state: 'usage', used: 1, size: 2 });
      await event(3, 'old_2', { state: 'usage', used: 1, size: 2, cost: { amount: 2.25, currency: 'USD' } });
      await event(4, 'current', { state: 'usage', used: 1, size: 2, cost: { amount: 3, currency: 'USD' } });
      expect(await repos.usage.lastCumulativeCost('ses_1', 'current')).toBe(2.25);
      await repos.usage.append(entry({ attemptId: 'current', costUsd: 0.75, cumulativeCostUsd: 3 }));
      expect(await repos.usage.lastCumulativeCost('ses_1', 'next')).toBe(3);
    } finally { repos.close(); }
  });

  it('summarizes by dimension within a window and keeps estimates visible', async () => {
    const repos = createRepositories(':memory:');
    try {
      await repos.usage.append(entry({ attemptId: 'old', recordedAt: '2026-08-31T23:00:00.000Z', costUsd: 5 }));
      await repos.usage.append(entry({ attemptId: 'b1', costUsd: 1, inputTokens: 100, outputTokens: 10 }));
      await repos.usage.append(entry({ attemptId: 'b2', chatId: 'oc_2', actorId: undefined, category: 'background', origin: 'decision', costUsd: 0.2, costEstimated: true, dataStatus: 'estimated', inputTokens: 50 }));
      await repos.usage.append(entry({ attemptId: 'b3', appId: 'cli_b', chatId: undefined, actorId: undefined, category: 'scheduled', origin: 'schedule', costUsd: 2, rootSessionId: 'ses_root' }));
      const since = '2026-09-01T00:00:00.000Z';
      expect(await repos.usage.totals({ since })).toMatchObject({ entries: 3, costUsd: 3.2, estimatedCostUsd: 0.2, inputTokens: 150, outputTokens: 10 });
      expect(await repos.usage.totals({ since, appId: 'cli_a', chatId: 'oc_1' })).toMatchObject({ entries: 1, costUsd: 1 });
      expect((await repos.usage.summarize('appId', { since })).map(row => [row.appId, row.costUsd])).toEqual([['cli_b', 2], ['cli_a', 1.2]]);
      expect((await repos.usage.summarize('category', { since, appId: 'cli_a' })).map(row => [row.category, row.entries])).toEqual([['explicit', 1], ['background', 1]]);
      expect((await repos.usage.summarize('actorId', { since })).find(row => row.actorId === undefined)).toMatchObject({ costUsd: 2.2 });
      expect((await repos.usage.summarize('chatId', { since })).map(row => [row.appId, row.chatId, row.costUsd])).toEqual([['cli_b', undefined, 2], ['cli_a', 'oc_1', 1], ['cli_a', 'oc_2', 0.2]]);
      expect(await repos.usage.totals({ rootSessionId: 'ses_root' })).toMatchObject({ entries: 1, costUsd: 2 });
    } finally { repos.close(); }
  });

  it('stores caps per bot and per group and claims each alert once', async () => {
    const repos = createRepositories(':memory:');
    try {
      await repos.usage.setCap({ scope: 'bot', appId: 'cli_a', chatId: 'ignored', monthlyCostUsd: 10 });
      await repos.usage.setCap({ scope: 'group', appId: 'cli_a', chatId: 'oc_1', monthlyCostUsd: 2 });
      await repos.usage.setCap({ scope: 'group', appId: 'cli_a', chatId: 'oc_1', monthlyCostUsd: 3 });
      expect((await repos.usage.listCaps()).map(({ updatedAt: _updatedAt, ...cap }) => cap)).toEqual([
        { scope: 'bot', appId: 'cli_a', monthlyCostUsd: 10 },
        { scope: 'group', appId: 'cli_a', chatId: 'oc_1', monthlyCostUsd: 3 }
      ]);
      expect(await repos.usage.claimAlert('group', 'cli_a', 'oc_1', '2026-09', 75)).toBe(true);
      expect(await repos.usage.claimAlert('group', 'cli_a', 'oc_1', '2026-09', 75)).toBe(false);
      expect(await repos.usage.claimAlert('group', 'cli_a', 'oc_1', '2026-10', 75)).toBe(true);
      await repos.usage.releaseAlert('group', 'cli_a', 'oc_1', '2026-09', 75);
      expect(await repos.usage.claimAlert('group', 'cli_a', 'oc_1', '2026-09', 75)).toBe(true);
      expect(await repos.usage.deleteCap('group', 'cli_a', 'oc_1')).toBe(true);
      expect(await repos.usage.deleteCap('group', 'cli_a', 'oc_1')).toBe(false);
      expect(await repos.usage.listCaps()).toHaveLength(1);
    } finally { repos.close(); }
  });
});


describe('usage pricing migration and durable automatic allowances', () => {
  it('migrates real v27 rows, preserving reported costs and marking incomplete legacy cache-write estimates unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-migrate-'));
    const path = join(dir, 'usage.sqlite');
    let repos = createRepositories(path);
    repos.close();
    const db = new Database(path);
    db.exec(`DROP TABLE usage_ledger;
      DELETE FROM schema_migrations WHERE version = 29;
      CREATE TABLE usage_ledger (
        id TEXT PRIMARY KEY, recorded_at TEXT NOT NULL, app_id TEXT, chat_id TEXT,
        session_id TEXT NOT NULL, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE,
        root_task_id TEXT, root_session_id TEXT, actor_id TEXT,
        category TEXT NOT NULL, origin TEXT NOT NULL, agent_id TEXT NOT NULL, model TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
        cost_usd REAL, cost_estimated INTEGER NOT NULL,
        data_status TEXT NOT NULL CHECK(data_status IN ('reported','estimated','unavailable')),
        cumulative_cost_usd REAL, usage_ref TEXT, UNIQUE(session_id, usage_ref));`);
    const insert = db.prepare(`INSERT INTO usage_ledger
      (id, recorded_at, session_id, task_id, attempt_id, category, origin, agent_id, cache_write_tokens, cost_usd, cost_estimated, data_status)
      VALUES (?, '2026-09-10T00:00:00Z', 'session', 'task', ?, 'background', 'memory', 'agent', ?, ?, ?, ?)`);
    insert.run('reported', 'reported', 1000, 2, 0, 'reported');
    insert.run('incomplete', 'incomplete', 1000, 0, 1, 'estimated');
    insert.run('old-estimate', 'old-estimate', 0, 1, 1, 'estimated');
    db.close();
    try {
      repos = createRepositories(path);
      expect(await repos.usage.totals({})).toMatchObject({ entries: 3, costUsd: 3, unpriced: 1, unknownCostEntries: 1, pricedEntries: 2, costCoverage: 2 / 3 });
      expect(await repos.usage.append(entry({ attemptId: 'fresh', provider: 'actual-vendor', model: 'model', modelSource: 'reading', pricingSource: 'custom_model', pricingVersion: 'config:hash', pricingMatch: 'model', costUsd: 0, dataStatus: 'estimated', costEstimated: true }))).toBe(true);
      repos.close();
      const inspect = new Database(path, { readonly: true });
      try {
        expect(inspect.prepare('SELECT provider, model_source, pricing_source, pricing_version, cost_usd, unpriced_reason FROM usage_ledger WHERE id = ?').get('incomplete')).toEqual({ provider: 'unknown', model_source: 'legacy_unknown', pricing_source: 'legacy_unknown', pricing_version: null, cost_usd: null, unpriced_reason: 'legacy_cache_write_rate_unknown' });
        expect(inspect.prepare('SELECT provider, pricing_version, pricing_match, model, model_source FROM usage_ledger WHERE attempt_id = ?').get('fresh')).toEqual({ provider: 'actual-vendor', pricing_version: 'config:hash', pricing_match: 'model', model: 'model', model_source: 'reading' });
        expect(inspect.prepare('SELECT cost_usd, data_status FROM usage_ledger WHERE id = ?').get('reported')).toEqual({ cost_usd: 2, data_status: 'reported' });
        expect(inspect.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'usage_ledger_%'").all()).toHaveLength(4);
      } finally { inspect.close(); }
      repos = createRepositories(path);
      expect(await repos.usage.append(entry({ attemptId: 'fresh', costUsd: 99 }))).toBe(false);
    } finally { repos.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('distinguishes reported zero, token-only unpriced and no-usage entries in every aggregate', async () => {
    const repos = createRepositories(':memory:');
    try {
      await repos.usage.append(entry({ attemptId: 'zero', costUsd: 0 }));
      await repos.usage.append(entry({ attemptId: 'unpriced', inputTokens: 10, dataStatus: 'unpriced', unpricedReason: 'unknown_model' }));
      await repos.usage.append(entry({ attemptId: 'unavailable', dataStatus: 'unavailable' }));
      const expected = { costUsd: 0, entries: 3, unpriced: 1, unavailable: 1, pricedEntries: 1, unknownCostEntries: 2, costCoverage: 1 / 3 };
      expect(await repos.usage.totals({})).toMatchObject(expected);
      expect(await repos.usage.summarize('appId', {})).toMatchObject([expected]);
      expect(await repos.usage.totals({ appId: 'absent' })).toMatchObject({ entries: 0, costCoverage: null });
    } finally { repos.close(); }
  });

  it('atomically claims one allowance, keeps task replay free across months and survives reopening', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-allowance-'));
    const path = join(dir, 'usage.sqlite');
    let repos = createRepositories(path);
    try {
      expect(await Promise.all(Array.from({ length: 10 }, (_, index) => repos.usage.claimBackgroundTask('app', '2026-09', `task-${index}`, 1)))).toEqual([true, ...Array(9).fill(false)]);
      repos.close(); repos = createRepositories(path);
      expect(await repos.usage.claimBackgroundTask('app', '2026-09', 'task-0', 0)).toBe(true);
      expect(await repos.usage.claimBackgroundTask('app', '2026-09', 'task-next', 1)).toBe(false);
      expect(await repos.usage.claimBackgroundTask('app', '2026-10', 'task-0', 1)).toBe(true);
      expect(await repos.usage.backgroundTaskCounts('2026-10')).toEqual([]);
      expect(await repos.usage.claimBackgroundTask('app', '2026-10', 'task-next', 1)).toBe(true);
      expect(await repos.usage.claimBackgroundTask('other-app', '2026-09', 'task-next', 1)).toBe(true);
      expect(await repos.usage.backgroundTaskCounts('2026-09')).toEqual([{ appId: 'app', tasks: 1 }, { appId: 'other-app', tasks: 1 }]);
    } finally { repos.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

it('reports token coverage independently of costs, including zero and partial readings', async () => {
  const repos = createRepositories(':memory:');
  try {
    await repos.usage.append(entry({ attemptId: 'cost-only', costUsd: 1 }));
    await repos.usage.append(entry({ attemptId: 'zero', inputTokens: 0, outputTokens: 0, costUsd: 0 }));
    await repos.usage.append(entry({ attemptId: 'partial', inputTokens: 25, dataStatus: 'unpriced' }));
    expect(await repos.usage.totals({ sessionId: 'ses_1' })).toMatchObject({ entries: 3, tokenEntries: 2, partialTokenEntries: 1, inputTokens: 25, outputTokens: 0 });
  } finally { repos.close(); }
});
