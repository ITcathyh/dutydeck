import { describe, expect, it, vi } from 'vitest';
import { timeLoop } from './loop-timing.js';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe('timeLoop', () => {
  it('warns once with the loop name and duration when a cycle exceeds the threshold', async () => {
    const warn = vi.fn();
    await expect(timeLoop('slow-loop', { warn }, async () => { await sleep(80); return 'done'; }, 20)).resolves.toBe('done');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ loop: 'slow-loop', thresholdMs: 20, durationMs: expect.any(Number) }), expect.stringContaining('slow-loop'));
    expect(warn.mock.calls[0]![0].durationMs).toBeGreaterThanOrEqual(20);
  });

  it('stays silent for cycles under the threshold, sync or async', async () => {
    const warn = vi.fn();
    expect(timeLoop('fast-sync', { warn }, () => 7)).toBe(7);
    await timeLoop('fast-async', { warn }, async () => { await sleep(1); });
    expect(warn).not.toHaveBeenCalled();
  });

  it('after the first warning, summarizes a loop that stays slow at most hourly, and warns again after it recovers', () => {
    vi.useFakeTimers({ toFake: ['performance', 'Date'] });
    try {
      const warn = vi.fn();
      const cycle = (ms: number) => { timeLoop('busy', { warn }, () => { vi.advanceTimersByTime(ms); }, 500); vi.advanceTimersByTime(5_000); };
      cycle(1_500);
      expect(warn).toHaveBeenCalledOnce();
      for (let round = 0; round < 600; round++) cycle(round % 2 ? 1_400 : 1_600);
      expect(warn).toHaveBeenCalledTimes(2);
      const [summary, message] = warn.mock.calls[1]!;
      expect(summary).toMatchObject({ loop: 'busy', thresholdMs: 500, p50Ms: expect.any(Number), maxMs: 1_600 });
      expect(summary.count).toBeGreaterThan(500);
      expect(message).toContain('busy');
      cycle(100);
      cycle(900);
      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn.mock.calls[2]![0]).toMatchObject({ loop: 'busy', durationMs: 900 });
    } finally { vi.useRealTimers(); }
  });

  it('keeps a separate slow streak per scope, so another bot running the same loop fast does not reset it', () => {
    vi.useFakeTimers({ toFake: ['performance', 'Date'] });
    try {
      const warn = vi.fn();
      const cycle = (scope: string, ms: number) => { timeLoop('lark.reconcile', { warn }, () => { vi.advanceTimersByTime(ms); }, 500, scope); vi.advanceTimersByTime(3_000); };
      for (let round = 0; round < 20; round++) { cycle('cli_slow', 1_500); cycle('cli_fast', 10); }
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toMatchObject({ loop: 'lark.reconcile', scope: 'cli_slow' });
      expect(warn.mock.calls[0]![1]).toContain('cli_slow');
    } finally { vi.useRealTimers(); }
  });

  it('measures a failing cycle and rethrows its error; a throwing log sink does not break the loop', async () => {
    const warn = vi.fn(() => { throw new Error('sink down'); });
    await expect(timeLoop('failing', { warn }, async () => { await sleep(30); throw new Error('boom'); }, 10)).rejects.toThrow('boom');
    expect(() => timeLoop('failing-sync', { warn }, () => { throw new Error('boom'); }, 0)).toThrow('boom');
    expect(timeLoop('no-log', undefined, () => 1, 0)).toBe(1);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
