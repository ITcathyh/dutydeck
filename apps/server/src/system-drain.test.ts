import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import type { DutydeckRuntime } from '@dutydeck/runtime';

function fakeRuntime() {
  let held = false;
  const setQueueHeld = vi.fn((value: boolean) => { held = value; });
  const runtime = { getRunningTaskCount: vi.fn(() => 0), setQueueHeld, isQueueHeld: () => held } as unknown as DutydeckRuntime;
  return { runtime, setQueueHeld, held: () => held };
}

describe('POST /api/system/drain', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('requires authentication when auth is enabled', async () => {
    const { runtime, setQueueHeld } = fakeRuntime();
    const app = await buildApp(runtime, { auth: { getToken: async () => 'correct-access-token', localOnly: false } });
    try {
      const unauthed = await app.inject({ method: 'POST', url: '/api/system/drain', payload: { draining: true } });
      expect(unauthed.statusCode).toBe(401);
      expect(setQueueHeld).not.toHaveBeenCalled();
      const authed = await app.inject({ method: 'POST', url: '/api/system/drain', payload: { draining: true }, headers: { authorization: 'Bearer correct-access-token' } });
      expect(authed.statusCode).toBe(200);
      expect(setQueueHeld).toHaveBeenCalledWith(true);
    } finally { await app.close(); }
  });

  it('holds the queue until released', async () => {
    const { runtime, held } = fakeRuntime();
    const app = await buildApp(runtime);
    try {
      const hold = await app.inject({ method: 'POST', url: '/api/system/drain', payload: { draining: true } });
      expect(hold.json()).toEqual({ draining: true, leaseSeconds: 60 });
      expect(held()).toBe(true);
      const release = await app.inject({ method: 'POST', url: '/api/system/drain', payload: { draining: false } });
      expect(release.json()).toEqual({ draining: false });
      expect(held()).toBe(false);
    } finally { await app.close(); }
  });

  it('resumes by itself when the caller stops renewing the lease', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { runtime, held } = fakeRuntime();
    const app = await buildApp(runtime);
    try {
      await app.inject({ method: 'POST', url: '/api/system/drain', payload: { draining: true, leaseSeconds: 30 } });
      vi.advanceTimersByTime(29_000);
      expect(held()).toBe(true);
      // 续租：从现在起再算 30 秒
      await app.inject({ method: 'POST', url: '/api/system/drain', payload: { draining: true, leaseSeconds: 30 } });
      vi.advanceTimersByTime(29_000);
      expect(held()).toBe(true);
      vi.advanceTimersByTime(2_000);
      expect(held()).toBe(false);
    } finally { await app.close(); }
  });

  it('rejects malformed requests without touching the queue', async () => {
    const { runtime, setQueueHeld } = fakeRuntime();
    const app = await buildApp(runtime);
    try {
      for (const payload of [{}, { draining: 'yes' }, { draining: true, leaseSeconds: 0 }, { draining: true, leaseSeconds: 1.5 }]) {
        const response = await app.inject({ method: 'POST', url: '/api/system/drain', payload });
        expect(response.statusCode).toBe(400);
      }
      expect(setQueueHeld).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
