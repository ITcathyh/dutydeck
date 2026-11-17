import { expect, it, vi } from 'vitest';
import { DutydeckRuntime } from './index.js';

it('forwards permission request existence checks without listing events', async () => {
  const hasPermissionRequest = vi.fn(async () => true), list = vi.fn();
  const runtime = { repos: { events: { hasPermissionRequest, list } } };
  await expect(DutydeckRuntime.prototype.hasPermissionRequest.call(runtime as any, 's', 'native-id')).resolves.toBe(true);
  expect(hasPermissionRequest).toHaveBeenCalledExactlyOnceWith('s', 'native-id');
  expect(list).not.toHaveBeenCalled();
});
