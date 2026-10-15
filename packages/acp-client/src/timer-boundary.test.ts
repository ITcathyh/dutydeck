import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpxAdapter } from './index.js';

const dirs: string[] = [];
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop();
  vi.restoreAllMocks(); vi.useRealTimers();
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
/** 使用真实 adapter 的定时器调度；仅 ACP runtime 与 CPU 采样在边界替换。 */
async function setup(timeout: number) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-idle-deferral-')); dirs.push(cwd);
  const adapter = new AcpxAdapter({ id: 'fixture', name: 'Fixture', command: 'unused', args: [], env: {}, cwd, protocol: 'acp', permissionMode: 'ask', timeout, capabilities: { pause: false, resume: true }, builtin: false }, { onEvent() {} });
  const runtime = (adapter as any).runtime;
  vi.spyOn(runtime, 'ensureSession').mockResolvedValue({ sessionKey: 'fixture' });
  vi.spyOn(runtime, 'close').mockResolvedValue(undefined);
  vi.spyOn((adapter as any).cpu, 'sample').mockReturnValue('inactive');
  const result = deferred<any>(), streamClosed = deferred<void>();
  const finish = () => { result.resolve({ status: 'completed', stopReason: 'end_turn' }); streamClosed.resolve(); };
  const turn = { result: result.promise, cancel: vi.fn(async () => undefined),
    events: { async *[Symbol.asyncIterator]() { await streamClosed.promise; } } };
  vi.spyOn(runtime, 'startTurn').mockReturnValue(turn);
  await adapter.start();
  vi.useFakeTimers();
  const timers = vi.spyOn(globalThis, 'setTimeout');
  const sending = adapter.send('one').catch(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
  cleanup.push(async () => { finish(); await sending; await adapter.stop(); });
  return timers;
}

describe('ACP timer delay conversion', () => {
  it.each([0.001, 1.001, 2.003, 2_147_483.647])('uses integer delays for %s seconds, including the CPU half-window', async timeout => {
    const timers = await setup(timeout);
    try {
      const expectedMs = Math.round(timeout * 1000);
      const delays = timers.mock.calls.map(call => call[1]).filter((value): value is number => typeof value === 'number' && value > 0);
      expect(delays.every(value => Number.isInteger(value) && value <= 2_147_483_647)).toBe(true);
      const firstWindow = expectedMs < 2000 ? expectedMs : expectedMs - Math.min(60_000, Math.floor(expectedMs / 2));
      expect(delays).toContain(firstWindow);
    } finally { timers.mockRestore(); }
  });
});
