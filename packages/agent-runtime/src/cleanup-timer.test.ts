import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from './index.js';

describe('Runtime cleanup timer boundary', () => {
  it.each([-1, 0.5, 2_147_483_648, NaN, Infinity])('rejects direct unsafe cleanupIntervalMs=%s before creating a timer', async cleanupIntervalMs => {
    const directory = await mkdtemp(join(tmpdir(), 'dutydeck-cleanup-timer-'));
    const repos = createRepositories(join(directory, 'state.db'));
    const timers = vi.spyOn(globalThis, 'setInterval'); let runtime: DutydeckRuntime | undefined;
    try {
      expect(() => { runtime = new DutydeckRuntime(repos, { cleanupIntervalMs }); }).toThrow(/cleanupIntervalMs/);
      expect(timers).not.toHaveBeenCalled();
    } finally { if (runtime) await runtime.shutdown(); timers.mockRestore(); repos.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it.each([0, 1, 2_147_483_647])('preserves direct cleanup disable or safe interval %s', async cleanupIntervalMs => {
    const directory = await mkdtemp(join(tmpdir(), 'dutydeck-cleanup-timer-'));
    const repos = createRepositories(join(directory, 'state.db'));
    const timers = vi.spyOn(globalThis, 'setInterval'); let runtime: DutydeckRuntime | undefined;
    try {
      runtime = new DutydeckRuntime(repos, { cleanupIntervalMs });
      if (cleanupIntervalMs) expect(timers).toHaveBeenCalledWith(expect.any(Function), cleanupIntervalMs);
      else expect(timers).not.toHaveBeenCalled();
    } finally { if (runtime) await runtime.shutdown(); timers.mockRestore(); repos.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
