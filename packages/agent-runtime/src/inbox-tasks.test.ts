import { expect, it, vi } from 'vitest';
import type { TaskRecord } from '@dutydeck/shared';
import { DutydeckRuntime } from './index.js';

const reference = { id: 't', sessionId: 's', prompt: '完整🙂\nprompt', status: 'completed', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:01:00.000Z' };

it('uses the repository inbox projection without calling the generic task path', async () => {
  const getInboxTasks = vi.fn(async () => [reference]), getTasks = vi.fn();
  const runtime = { repos: { tasks: { getInboxTasks } }, getTasks };
  await expect(DutydeckRuntime.prototype.getInboxTasks.call(runtime as any, 's')).resolves.toEqual([reference]);
  expect(getInboxTasks).toHaveBeenCalledExactlyOnceWith('s');
  expect(getTasks).not.toHaveBeenCalled();
});

it('falls back to the original getTasks and preserves public skill deliveries when the projection is missing', async () => {
  const skillDeliveries = [{ name: 'review', path: '/skills/review', source: 'workspace' as const, digest: 'digest', mode: 'prompt' as const }];
  const full: TaskRecord = { ...reference, queuePosition: 2, executionContext: { agentPrompt: 'private prompt', skillDeliveries } };
  const listBySession = vi.fn(async () => [full]);
  const runtime = Object.assign(Object.create(DutydeckRuntime.prototype), { repos: { tasks: { listBySession } } }) as DutydeckRuntime;
  const expected = [{ ...reference, skillDeliveries }];
  await expect(runtime.getInboxTasks('s')).resolves.toEqual(expected);
  await expect(runtime.getTasks('s')).resolves.toEqual(expected);
  expect(listBySession).toHaveBeenCalledTimes(2);
});
