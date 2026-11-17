import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProcessTable } from './agent-process-tree.js';
import { AgentProcessSampler } from './agent-process-sampler.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function tree(refresh: (table: ProcessTable) => boolean = () => true, hasGroups: () => boolean = () => false) {
  return { refresh: vi.fn(refresh), hasGroups: vi.fn(hasGroups) };
}

it('shares one fresh table between ten same-tick trees and never across ticks', async () => {
  const scan = vi.fn((): ProcessTable => new Map());
  const sampler = new AgentProcessSampler(scan);
  const trees = Array.from({ length: 10 }, () => tree());
  const cancellations = trees.map(item => sampler.register(item));
  await vi.advanceTimersByTimeAsync(99);
  expect(scan).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(scan).toHaveBeenCalledTimes(1);
  const first = scan.mock.results[0]!.value;
  for (const item of trees) expect(item.refresh).toHaveBeenCalledExactlyOnceWith(first);
  await vi.advanceTimersByTimeAsync(100);
  expect(scan).toHaveBeenCalledTimes(2);
  const second = scan.mock.results[1]!.value;
  expect(second).not.toBe(first);
  for (const item of trees) expect(item.refresh).toHaveBeenNthCalledWith(2, second);
  cancellations.forEach(cancel => cancel());
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps the 50-sample budget and due time independent for staggered trees', async () => {
  const scan = vi.fn((): ProcessTable => new Map());
  const sampler = new AgentProcessSampler(scan);
  const first = tree();
  sampler.register(first);
  await vi.advanceTimersByTimeAsync(50);
  const second = tree();
  sampler.register(second);
  await vi.advanceTimersByTimeAsync(50);
  expect(first.refresh).toHaveBeenCalledTimes(1);
  expect(second.refresh).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(50);
  expect(first.refresh).toHaveBeenCalledTimes(1);
  expect(second.refresh).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(4_850);
  expect(first.refresh).toHaveBeenCalledTimes(50);
  expect(second.refresh).toHaveBeenCalledTimes(49);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(50);
  expect(second.refresh).toHaveBeenCalledTimes(50);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(first.refresh).toHaveBeenCalledTimes(50);
  expect(second.refresh).toHaveBeenCalledTimes(50);
});

it('unregisters grouped and unreadable trees without disturbing their peers', async () => {
  const scan = vi.fn((): ProcessTable => new Map());
  const sampler = new AgentProcessSampler(scan);
  const grouped = tree(() => true, () => true);
  const unreadable = tree(() => false);
  const active = tree();
  sampler.register(grouped);
  sampler.register(unreadable);
  const cancelActive = sampler.register(active);
  await vi.advanceTimersByTimeAsync(100);
  expect(grouped.refresh).toHaveBeenCalledTimes(1);
  expect(unreadable.refresh).toHaveBeenCalledTimes(1);
  expect(unreadable.hasGroups).not.toHaveBeenCalled();
  expect(active.refresh).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(grouped.refresh).toHaveBeenCalledTimes(1);
  expect(unreadable.refresh).toHaveBeenCalledTimes(1);
  expect(active.refresh).toHaveBeenCalledTimes(2);
  cancelActive();
  expect(vi.getTimerCount()).toBe(0);
});

it('unrefs and restarts the nearest-due timer, with no scans after cancellation', async () => {
  const scan = vi.fn((): ProcessTable => new Map());
  const sampler = new AgentProcessSampler(scan);
  const cancelled = tree();
  const active = tree();
  const cancelCancelled = sampler.register(cancelled);
  const cancelActive = sampler.register(active);
  expect(vi.getTimerCount()).toBe(1);
  expect((sampler as any).timer.hasRef()).toBe(false);
  cancelCancelled();
  cancelCancelled();
  await vi.advanceTimersByTimeAsync(100);
  expect(cancelled.refresh).not.toHaveBeenCalled();
  expect(active.refresh).toHaveBeenCalledTimes(1);
  cancelActive();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(scan).toHaveBeenCalledTimes(1);
  const restarted = tree();
  const cancelRestarted = sampler.register(restarted);
  expect(vi.getTimerCount()).toBe(1);
  expect((sampler as any).timer.hasRef()).toBe(false);
  await vi.advanceTimersByTimeAsync(99);
  expect(restarted.refresh).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(restarted.refresh).toHaveBeenCalledTimes(1);
  expect(scan).toHaveBeenCalledTimes(2);
  cancelRestarted();
});

it('does not densely catch up after a delayed tick', async () => {
  const scan = vi.fn((): ProcessTable => new Map());
  const sampler = new AgentProcessSampler(scan);
  const sampled = tree();
  sampler.register(sampled);
  vi.setSystemTime(Date.now() + 1_000);
  await vi.runOnlyPendingTimersAsync();
  expect(scan).toHaveBeenCalledTimes(1);
  expect(sampled.refresh).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(99);
  expect(scan).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(scan).toHaveBeenCalledTimes(2);
  expect(sampled.refresh).toHaveBeenCalledTimes(2);
});
