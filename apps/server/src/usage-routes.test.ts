import { expect, it } from 'vitest';
import Fastify from 'fastify';
import { createRepositories } from '@dutydeck/storage';
import { UsageLedger } from './usage-ledger.js';
import { registerUsageRoutes } from './usage-routes.js';

it('returns known costs, unknown coverage and automatic allowances through the owner-only summary route', async () => {
  const repos = createRepositories(':memory:');
  const app = Fastify();
  const ledger = new UsageLedger({ repositories: repos, backgroundLimits: { bots: { cli_a: 10 } }, now: () => new Date('2026-09-25T00:00:00Z') });
  let authorized = false;
  registerUsageRoutes(app, { ledger, authorize: () => authorized }, async () => {});
  try {
    expect((await app.inject('/api/usage/summary')).statusCode).toBe(403);
    authorized = true;
    await repos.usage.append({ id: 'usage', attemptId: 'attempt', taskId: 'task', sessionId: 'session', recordedAt: '2026-09-24T00:00:00Z', category: 'background', origin: 'memory', agentId: 'fixture', appId: 'cli_a', dataStatus: 'unpriced', costEstimated: false, inputTokens: 10, provider: 'unknown', unpricedReason: 'unknown_model' });
    await repos.usage.claimBackgroundTask('cli_a', '2026-09', 'task', 10);
    const result = await app.inject('/api/usage/summary');
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ month: { totals: { costUsd: 0, unpriced: 1, unknownCostEntries: 1, pricedEntries: 0, costCoverage: 0 } }, backgroundBudget: { month: '2026-09', bots: { cli_a: 10 }, usage: [{ appId: 'cli_a', tasks: 1 }] } });
    const cap = await app.inject({ method: 'PUT', url: '/api/usage/caps', payload: { scope: 'bot', appId: 'cli_a', monthlyCostUsd: 5 } });
    expect(cap.statusCode).toBe(200);
    expect(cap.json()).toMatchObject({ scope: 'bot', appId: 'cli_a', monthlyCostUsd: 5 });
  } finally { await app.close(); repos.close(); }
});
