import { expect, it } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { createSessionContexts } from './session-context.js';

const time = '2026-11-05T00:00:00Z';

it('reads the latest valid context of every session in one query and caches the batch briefly', async () => {
  const repos = createRepositories(':memory:');
  try {
    for (const id of ['hot', 'cool', 'quota-only', 'empty']) await repos.sessions.save({ id, runId: `run-${id}`, agentId: 'codex', cwd: '/tmp', state: 'completed', createdAt: time, updatedAt: time });
    const usage = (id: string, session: string, sequence: number, data: object) => repos.events.append({ id, sessionId: session, sequence, type: 'status', timestamp: `2026-11-05T00:00:0${sequence}Z`, data: { state: 'usage', ...data } });
    await usage('h1', 'hot', 1, { used: 100, size: 1000 });
    await usage('h2', 'hot', 2, { used: 850, size: 1000 });
    await usage('h3', 'hot', 3, { rateLimits: { fiveHour: { usedPercent: 5, resetsAt: 1791000000 } } });
    await usage('h4', 'hot', 4, { used: -1, size: 1000 });
    await usage('c1', 'cool', 1, { used: 10, size: 1000 });
    await usage('q1', 'quota-only', 1, { rateLimits: { sevenDay: { usedPercent: 25, resetsAt: 1791000000 } } });
    await repos.events.append({ id: 'text', sessionId: 'empty', sequence: 1, type: 'text', timestamp: time, data: { text: 'hi' } });

    let clock = Date.parse(time);
    const calls: number[] = [];
    const original = repos.events.listLatestContexts!.bind(repos.events);
    repos.events.listLatestContexts = async () => { calls.push(clock); return original(); };
    const contexts = createSessionContexts(repos, () => clock);

    const first = await contexts();
    expect([...first.keys()].sort()).toEqual(['cool', 'hot']);
    expect(first.get('hot')).toEqual({ used: 850, size: 1000, observedAt: '2026-11-05T00:00:02Z' });
    await usage('h5', 'hot', 5, { used: 900, size: 1000 });
    clock += 10_000;
    expect((await contexts()).get('hot')?.used).toBe(850);
    clock += 21_000;
    expect((await contexts()).get('hot')?.used).toBe(900);
    expect(calls).toHaveLength(2);
  } finally { repos.close(); }
});

it('does not cache a failed lookup', async () => {
  let attempts = 0;
  const repos = { events: { listLatestContexts: async () => { if (++attempts === 1) throw new Error('db busy'); return [{ sessionId: 's', timestamp: time, data: { used: 5, size: 10 } }]; } } } as any;
  const contexts = createSessionContexts(repos, () => 0);
  await expect(contexts()).rejects.toThrow('db busy');
  expect((await contexts()).get('s')).toMatchObject({ used: 5, size: 10 });
});
