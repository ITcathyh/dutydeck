import { describe, expect, it, vi } from 'vitest';
import type { ScenarioProvider } from '@dutydeck/shared';
import { scenarioMessage } from './scenario-fixtures.test-helpers.js';
import { callWithDeadline, ScenarioProviderCaller } from './scenario-providers.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const blockFor = (ms: number) => { const until = Date.now() + ms; while (Date.now() < until) { /* 同步阻塞 */ } };

describe('callWithDeadline', () => {
  it('stops waiting for a call that never returns and aborts it', async () => {
    let signal: AbortSignal | undefined;
    const result = await callWithDeadline(given => { signal = given; return new Promise(() => {}); }, 50);
    expect(result.status).toBe('timeout');
    expect(signal?.aborted).toBe(true);
  });

  it('a call that ignores the signal still times out, and its late result is discarded and reported', async () => {
    const onLate = vi.fn();
    const result = await callWithDeadline(async () => { await sleep(120); return 'late'; }, 40, onLate);
    expect(result).toMatchObject({ status: 'timeout' });
    await sleep(150);
    expect(onLate).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok' }));
  });

  it('turns a throw (sync or async) into an error result', async () => {
    expect(await callWithDeadline(() => { throw new Error('boom'); }, 50)).toMatchObject({ status: 'error', error: 'boom' });
    expect(await callWithDeadline(async () => { throw new Error('async boom'); }, 50)).toMatchObject({ status: 'error', error: 'async boom' });
  });

  it('discards a synchronous result that comes back after the deadline', async () => {
    const onLate = vi.fn();
    expect(await callWithDeadline(() => { blockFor(80); return 'value'; }, 30, onLate)).toMatchObject({ status: 'timeout' });
    expect(onLate).toHaveBeenCalledTimes(1);
    expect(await callWithDeadline(() => 'fast', 30)).toMatchObject({ status: 'ok', value: 'fast' });
  });
});

describe('ScenarioProviderCaller', () => {
  const warn = vi.fn();
  const caller = (provider: ScenarioProvider) => new ScenarioProviderCaller('demo', provider, { warn });
  const input = { message: scenarioMessage('boom'), params: {} };

  it('match: 500ms deadline, never-returning and signal-ignoring providers time out, bad shapes are errors', async () => {
    expect(await caller({ id: 'p', match: ({ message }) => ({ matched: message.text === 'boom', dedupeKey: 'k1' }) }).match(input)).toMatchObject({ status: 'ok', value: { matched: true, dedupeKey: 'k1' } });
    const started = Date.now();
    expect(await caller({ id: 'p', match: () => new Promise(() => {}) }).match(input)).toMatchObject({ status: 'timeout' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(await caller({ id: 'p', match: () => ({ matched: 'yes' }) as never }).match(input)).toMatchObject({ status: 'error' });
    expect(await caller({ id: 'p', match: () => { throw new Error('match failed'); } }).match(input)).toMatchObject({ status: 'error', error: 'match failed' });
  });

  it('context: deadline from the pack, capped at 15s, with maxChars capped; late results are logged and dropped', async () => {
    let seen: { maxChars: number; signal: AbortSignal } | undefined;
    const provider: ScenarioProvider = { id: 'runbook', context: async given => { seen = given; await sleep(150); return { items: [], missing: [] }; } };
    expect(await caller(provider).context({ scope: { appId: 'cli', chatId: 'oc' }, message: input.message, params: {}, maxChars: 99_999 }, 50)).toMatchObject({ status: 'timeout' });
    expect(seen?.maxChars).toBe(16_000);
    expect(seen?.signal.aborted).toBe(true);
    await sleep(200);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ provider: 'runbook', method: 'context' }), expect.stringContaining('迟到'));
  });

  it('context: a pack asking for more than 15s still stops at 15s', async () => {
    vi.useFakeTimers();
    try {
      let settled: unknown;
      const provider: ScenarioProvider = { id: 'runbook', context: () => new Promise(() => {}) };
      void caller(provider).context({ scope: { appId: 'cli', chatId: 'oc' }, message: input.message, params: {} }, 60_000).then(result => { settled = result; });
      await vi.advanceTimersByTimeAsync(14_999);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toMatchObject({ status: 'timeout' });
    } finally { vi.useRealTimers(); }
  });

  it('correlationKey: synchronous, bounded by the remaining round time', async () => {
    const provider: ScenarioProvider = { id: 'alert-key', correlationKey: ({ entries }) => ({ title: entries[0]?.label ?? '' }) };
    expect(await caller(provider).correlationKey({ entries: [{ label: 'RDS CPU', lines: [] }] })).toMatchObject({ status: 'ok', value: { title: 'RDS CPU' } });
    expect(await caller({ id: 'slow', correlationKey: () => { blockFor(60); return { title: 'x' }; } }).correlationKey({ entries: [] }, 20)).toMatchObject({ status: 'timeout' });
    expect(await caller({ id: 'none' }).correlationKey({ entries: [] })).toMatchObject({ status: 'error' });
  });
});
