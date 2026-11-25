import { afterEach, expect, it, vi } from 'vitest';
import { createCleanup } from '../scripts/lark-e2e-shared.mts';

afterEach(() => vi.useRealTimers());

it('keeps the first cleanup flag and error, and closes resources acquired during capture', async () => {
  let startCapture!: () => void;
  const captureStarted = new Promise<void>(resolve => { startCapture = resolve; });
  let finishCapture!: () => void;
  const capturePending = new Promise<void>(resolve => { finishCapture = resolve; });
  const calls: string[] = [];
  const firstError = new Error('repositories failed to close');
  let close = () => { calls.push('old resource'); };
  const run = createCleanup(async (isFailure, step) => {
    await step('captureBrowserArtifacts', () => {
      calls.push(isFailure ? 'failure screenshot' : 'finish screenshot');
      startCapture();
      return capturePending;
    });
    await step('repositories.close', () => close());
    await step('later.close', async () => { calls.push('later resource'); throw new Error('later failure'); });
  }, { flush: async () => { calls.push('flush'); } });

  const first = run(false);
  await captureStarted;
  const concurrent = run(true);
  close = () => { calls.push('new resource'); throw firstError; };
  finishCapture();
  expect(await Promise.all([first, concurrent])).toEqual([firstError, firstError]);
  await expect(run(true)).resolves.toBe(firstError);
  expect(calls).toEqual(['finish screenshot', 'new resource', 'later resource', 'flush']);
});

it('continues to later steps and flushes after a step times out', async () => {
  vi.useFakeTimers();
  const close = vi.fn();
  const flush = vi.fn(async () => {});
  const run = createCleanup(async (_isFailure, step) => {
    await step('page.close', () => new Promise<void>(() => {}), 5_000);
    await step('context.close', close);
  }, { flush });

  const outcome = run(true);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(outcome).resolves.toMatchObject({ message: 'Timeout of 5000ms exceeded: page.close' });
  expect(close).toHaveBeenCalledBefore(flush);
  expect(vi.getTimerCount()).toBe(0);
});

it('treats logger failures as best effort', async () => {
  const run = createCleanup(async () => {}, { flush: async () => { throw new Error('log write failed'); } });
  await expect(run(false)).resolves.toBeUndefined();
});
