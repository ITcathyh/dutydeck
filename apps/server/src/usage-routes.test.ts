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

it('serves the owner-only report and a paginated task list for one time range and filter', async () => {
  const repos = createRepositories(':memory:');
  const app = Fastify();
  const ledger = new UsageLedger({ repositories: repos, now: () => new Date('2026-09-25T08:00:00') });
  let authorized = false;
  registerUsageRoutes(app, { ledger, authorize: () => authorized }, async () => {});
  const row = (n: number, patch: Record<string, unknown>) => ({ id: `usage_${n}`, attemptId: `attempt_${n}`, taskId: `task_${n}`, sessionId: `session_${n}`, recordedAt: new Date(`2026-09-2${n}T10:00:00`).toISOString(), category: 'explicit', origin: 'web', agentId: 'claude', provider: 'unknown', costEstimated: true, dataStatus: 'estimated', ...patch });
  try {
    expect((await app.inject('/api/usage/report')).statusCode).toBe(403);
    expect((await app.inject('/api/usage/tasks')).statusCode).toBe(403);
    authorized = true;
    await repos.usage.append(row(3, { model: 'claude-opus-5-5', costUsd: 4, inputTokens: 1 }) as never);
    await repos.usage.append(row(4, { model: 'gpt-5', costUsd: 1, inputTokens: 1 }) as never);
    await repos.usage.append(row(5, { dataStatus: 'unavailable', costEstimated: false }) as never);
    const report = (await app.inject('/api/usage/report?from=2026-09-23&to=2026-09-25')).json();
    expect(report).toMatchObject({ range: { from: '2026-09-23', to: '2026-09-25' }, totals: { entries: 3, costUsd: 5, unknownCostEntries: 1 }, timezone: { name: expect.any(String) } });
    expect(report.daily.map((day: { day: string }) => day.day)).toEqual(['2026-09-23', '2026-09-24', '2026-09-25']);
    const filtered = (await app.inject('/api/usage/report?from=2026-09-23&to=2026-09-25&model=claude-opus-5-5')).json();
    expect(filtered).toMatchObject({ filter: { model: 'claude-opus-5-5' }, totals: { entries: 1, costUsd: 4 } });
    const page = (await app.inject('/api/usage/tasks?from=2026-09-23&to=2026-09-25&limit=2&offset=0')).json();
    expect(page).toMatchObject({ total: 3, tasks: [{ taskId: 'task_5', sessionId: 'session_5' }, { taskId: 'task_4' }] });
    expect((await app.inject('/api/usage/tasks?from=2026-09-23&to=2026-09-25&limit=2&offset=2')).json().tasks.map((task: { taskId: string }) => task.taskId)).toEqual(['task_3']);
    expect((await app.inject('/api/usage/tasks?limit=0')).statusCode).toBeGreaterThanOrEqual(400);
    expect((await app.inject('/api/usage/report?from=nope')).statusCode).toBeGreaterThanOrEqual(400);
    expect((await app.inject('/api/usage/report?bogus=1')).statusCode).toBeGreaterThanOrEqual(400);
  } finally { await app.close(); repos.close(); }
});
