// Exercise the production pool's startup, failure and shutdown paths. Hold only the external listener start.
import { vi } from 'vitest';
import { LarkLongConnectionListener, LarkLongConnectionListenerPool } from './listener.js';
import type { StoredLarkConfig } from './config.js';

export async function pendingListener(disabled = false) {
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const handshake = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  let releasePeer!: () => void;
  const peer = new Promise<void>(resolve => { releasePeer = resolve; });
  const start = vi.spyOn(LarkLongConnectionListener.prototype, 'start').mockImplementation(async config => {
    if (config.appId === 'cli_slow') await peer;
    if (config.appId === 'cli_bot') await handshake;
  });
  const pool = new LarkLongConnectionListenerPool({ info() {}, warn() {}, error() {} });
  const configs = ['cli_bot', 'cli_ready', 'cli_slow'].map(appId => ({
    appId, permissionMode: 'ask', listening: appId !== 'cli_bot' || !disabled
  } as StoredLarkConfig));
  const synced = pool.sync(configs);
  void synced.catch(() => {});
  await vi.waitFor(() => { if (!pool.activeAppIds.includes('cli_ready')) throw new Error('second listener still starting'); });
  return { pool, finish, fail: () => fail(new Error('identity lookup failed')),
    async close() { finish(); releasePeer(); await synced.catch(() => {}); pool.stop(); start.mockRestore(); } };
}
