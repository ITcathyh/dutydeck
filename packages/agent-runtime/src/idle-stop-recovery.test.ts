import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig } from '@dutydeck/shared';
import { DutydeckRuntime, type AgentDriver, type SessionNotice } from './index.js';

const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
const HOUR = 60 * 60_000;
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); });

function runtimeFor(repos: ReturnType<typeof createRepositories>, state = { exited: true, prepared: true }) {
  const log = { warn: vi.fn(), info: vi.fn() }, notices: SessionNotice[] = [], drivers: AgentDriver[] = [];
  const runtime = new DutydeckRuntime(repos, {
    cleanupIntervalMs: 0, driverIdleTimeoutMs: 10, log, onSessionNotice: (_session, notice) => { notices.push(notice); },
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_agent, _protocol, emit) => {
      const driver: AgentDriver = {
        start: vi.fn(async () => {}), resume: vi.fn(async () => {}), interrupt: vi.fn(async () => {}),
        send: vi.fn(async () => { emit({ type: 'text', data: { text: 'answer' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); }),
        stop: vi.fn(async () => {}), isStopped: async () => state.exited, prepareForIdleRetirement: async () => state.prepared,
      };
      drivers.push(driver); return driver;
    },
  });
  cleanup.push(() => runtime.shutdown());
  return { runtime, log, notices, drivers };
}
async function fixture() {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  cleanup.push(() => repos.close());
  const state = { exited: false, prepared: true };
  const h = runtimeFor(repos, state);
  await h.runtime.initialize([agent]);
  const session = await h.runtime.start({ agentId: agent.id });
  expect((await h.runtime.send(session.id, 'first')).status).toBe('completed');
  return { ...h, repos, state, session };
}
const warned = (log: { warn: ReturnType<typeof vi.fn> }, code: string) => log.warn.mock.calls.filter(([data]) => data.code === code);

it('an idle retirement whose exit is unverified reports a stop block, not a revoked session', async () => {
  const h = await fixture();
  await h.runtime.cleanupIdleDrivers(Date.now() + 100);
  expect(h.drivers[0]!.stop).toHaveBeenCalledOnce();
  await expect(h.runtime.send(h.session.id, 'second')).rejects.toMatchObject({ code: 'DRIVER_STOP_UNVERIFIED' });
  expect(warned(h.log, 'DRIVER_STOP_UNVERIFIED')).toEqual([[expect.objectContaining({ sessionId: h.session.id, elapsedMs: expect.any(Number) }), expect.any(String)]]);
  // The blocked driver is left to its recheck instead of being retried and re-logged every cleanup.
  await h.runtime.cleanupIdleDrivers(Date.now() + 200);
  expect(h.drivers[0]!.stop).toHaveBeenCalledOnce();
  expect(warned(h.log, 'DRIVER_STOP_UNVERIFIED')).toHaveLength(1);
});

it('rechecks a stop block in the background, notices once while it persists, and reopens the session after exit is proven', async () => {
  const h = await fixture();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await h.runtime.cleanupIdleDrivers(Date.now() + 100);
  await vi.advanceTimersByTimeAsync(29_000);
  expect(h.notices).toEqual([]);
  await vi.advanceTimersByTimeAsync(31_000);
  expect(h.notices).toEqual([expect.objectContaining({ kind: 'stop_unverified', sessionIds: [h.session.id] })]);
  await expect(h.runtime.send(h.session.id, 'still blocked')).rejects.toMatchObject({ code: 'DRIVER_STOP_UNVERIFIED' });
  h.state.exited = true;
  await vi.advanceTimersByTimeAsync(90_000);
  vi.useRealTimers();
  expect(h.runtime.getDriverStopBlock(h.session.id)).toBeUndefined();
  expect(h.notices).toHaveLength(1);
  expect((await h.runtime.send(h.session.id, 'after recovery')).status).toBe('completed');
  expect(h.drivers).toHaveLength(2);
});

it('an explicit stop that proves exit lifts the rejection before the recheck runs', async () => {
  const h = await fixture();
  await h.runtime.cleanupIdleDrivers(Date.now() + 100);
  h.state.exited = true;
  await h.runtime.stop(h.session.id);
  await h.runtime.resume(h.session.id);
  expect((await h.runtime.send(h.session.id, 'after explicit stop')).status).toBe('completed');
});

it('retires an idle driver that never confirms its native session once it has been idle far past the timeout', async () => {
  const h = await fixture();
  h.state.prepared = false; h.state.exited = true;
  await h.runtime.cleanupIdleDrivers(Date.now() + 100);
  await h.runtime.cleanupIdleDrivers(Date.now() + 17 * HOUR);
  expect(h.drivers[0]!.stop).not.toHaveBeenCalled();
  await h.runtime.cleanupIdleDrivers(Date.now() + 19 * HOUR);
  expect(h.drivers[0]!.stop).toHaveBeenCalledOnce();
  expect(warned(h.log, 'IDLE_RETIREMENT_UNPREPARED')).toHaveLength(1);
  expect((await h.runtime.send(h.session.id, 'after retirement')).status).toBe('completed');
});

it('skips only the session whose saved workspace disappeared during startup recovery', async () => {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  cleanup.push(() => repos.close());
  const gone = mkdtempSync(join(tmpdir(), 'dd-gone-workspace-')), kept = mkdtempSync(join(tmpdir(), 'dd-kept-workspace-'));
  cleanup.push(() => { rmSync(gone, { recursive: true, force: true }); rmSync(kept, { recursive: true, force: true }); });
  const first = runtimeFor(repos);
  await first.runtime.initialize([agent]);
  const lost = await first.runtime.start({ agentId: agent.id, cwd: gone });
  const healthy = await first.runtime.start({ agentId: agent.id, cwd: kept });
  await first.runtime.shutdown();
  rmSync(gone, { recursive: true, force: true });
  const restarted = runtimeFor(repos);
  await restarted.runtime.initialize([agent]);
  expect(warned(restarted.log, 'WORKSPACE_UNAVAILABLE')).toEqual([[expect.objectContaining({ sessionId: lost.id }), expect.any(String)]]);
  expect((await restarted.runtime.send(healthy.id, 'still works')).status).toBe('completed');
});
