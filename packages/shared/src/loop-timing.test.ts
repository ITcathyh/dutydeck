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

  it('measures a failing cycle and rethrows its error; a throwing log sink does not break the loop', async () => {
    const warn = vi.fn(() => { throw new Error('sink down'); });
    await expect(timeLoop('failing', { warn }, async () => { await sleep(30); throw new Error('boom'); }, 10)).rejects.toThrow('boom');
    expect(() => timeLoop('failing-sync', { warn }, () => { throw new Error('boom'); }, 0)).toThrow('boom');
    expect(timeLoop('no-log', undefined, () => 1, 0)).toBe(1);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
