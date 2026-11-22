import { defaultDriverProviders } from '../../../apps/server/src/driver-providers.js';
import type { RepositoryBundle } from '@dutydeck/shared';
import { expect, it, vi } from 'vitest';
import { DutydeckRuntime } from './index.js';

it('forwards permission request existence checks without listing events', async () => {
  const hasPermissionRequest = vi.fn(async () => true), list = vi.fn();
  const runtime = new DutydeckRuntime({ events: { hasPermissionRequest, list } } as unknown as RepositoryBundle, { providers: defaultDriverProviders(), cleanupIntervalMs: 0 });
  await expect(runtime.hasPermissionRequest('s', 'native-id')).resolves.toBe(true);
  expect(hasPermissionRequest).toHaveBeenCalledExactlyOnceWith('s', 'native-id');
  expect(list).not.toHaveBeenCalled();
});
