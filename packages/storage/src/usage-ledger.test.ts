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
