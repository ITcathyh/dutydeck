import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginStore } from './store.js';
import { PluginHost } from './host.js';
afterEach(() => vi.restoreAllMocks());
it('releases an acquired lease when generation recording fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-host-lease-'));
  try {
    const release = vi.fn(async () => {}); const failure = new Error('record failed');
    vi.spyOn(PluginStore.prototype, 'acquireHost').mockResolvedValueOnce({ entries: [], record: async () => { throw failure; }, release });
    await expect(PluginHost.load({ dataDir: root, builtinRoot: join(root, 'no-builtins') })).rejects.toBe(failure);
    expect(release).toHaveBeenCalledTimes(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
