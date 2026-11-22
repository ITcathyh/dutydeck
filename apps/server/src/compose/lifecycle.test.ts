import { expect, it, vi } from 'vitest';
import { createAppLogger } from '../app.js';
import { ServerLifecycle } from './lifecycle.js';

it('waits for a parallel stop group before closing relay, HTTP, runtime and SQLite', async () => {
  const lifecycle = new ServerLifecycle(createAppLogger());
  const order: string[] = [];
  let finishWorkbench!: () => void;
  const workbench = new Promise<void>(resolve => { finishWorkbench = resolve; });
  lifecycle.register('workbench', () => { order.push('workbench'); return workbench; });
  for (const phase of ['database', 'runtime', 'http', 'relayClose', 'automation', 'insight'] as const) {
    lifecycle.register(phase, () => { order.push(phase); });
  }
  lifecycle.assembledCore();
  const closing = lifecycle.close();
  expect(lifecycle.close()).toBe(closing);
  await vi.waitFor(() => expect(order).toEqual(['insight', 'workbench', 'automation']));
  finishWorkbench();
  await closing;
  expect(order).toEqual(['insight', 'workbench', 'automation', 'relayClose', 'http', 'runtime', 'database']);
  expect(lifecycle.phases.unfinished()).toEqual([]);
});

it('rolls back only acquired resources and closes SQLite after pending cleanup even if a stop fails', async () => {
  const lifecycle = new ServerLifecycle(createAppLogger());
  const order: string[] = [];
  const stopped = vi.fn();
  lifecycle.onSetupFailure(() => { order.push('plugins'); });
  lifecycle.register('database', () => { order.push('database'); }, false);
  lifecycle.register('capabilities', async () => { order.push('capabilities'); await Promise.resolve(); order.push('drained'); });
  lifecycle.register('runtime', () => { order.push('runtime'); throw new Error('fixture'); });
  lifecycle.register('insight', () => { order.push('insight'); }, false);
  lifecycle.register('http', stopped, false);
  await expect(lifecycle.close()).rejects.toThrow('Dutydeck setup cleanup failed');
  expect(order).toEqual(['insight', 'runtime', 'capabilities', 'plugins', 'drained', 'database']);
  expect(stopped).not.toHaveBeenCalled();
});
