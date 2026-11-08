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

function runtimeFor(repos: ReturnType<typeof createRepositories>, state: { exited: boolean; prepared: boolean; hold?: Promise<void> } = { exited: true, prepared: true }) {
  const log = { warn: vi.fn(), info: vi.fn() }, notices: SessionNotice[] = [], drivers: AgentDriver[] = [];
  const runtime = new DutydeckRuntime(repos, {
    cleanupIntervalMs: 0, driverIdleTimeoutMs: 10, log, onSessionNotice: (_session, notice) => { notices.push(notice); },
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_agent, _protocol, emit) => {
      const driver: AgentDriver = {
        start: vi.fn(async () => {}), resume: vi.fn(async () => {}), interrupt: vi.fn(async () => {}),
        send: vi.fn(async () => { await state.hold; emit({ type: 'text', data: { text: 'answer' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); }),
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
  const state: { exited: boolean; prepared: boolean; hold?: Promise<void> } = { exited: false, prepared: true };
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

it('a recheck stops the driver again when the first stop never ended its terminal', async () => {
  const h = await fixture();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // The first stop fails without killing anything (a busy tmux pane); only a repeated stop ends the terminal.
  h.drivers[0]!.stop = vi.fn(async () => { if (vi.mocked(h.drivers[0]!.stop).mock.calls.length >= 2) h.state.exited = true; });
  await h.runtime.cleanupIdleDrivers(Date.now() + 100);
  expect(h.drivers[0]!.stop).toHaveBeenCalledOnce();
  await expect(h.runtime.send(h.session.id, 'blocked')).rejects.toMatchObject({ code: 'DRIVER_STOP_UNVERIFIED' });
  await vi.advanceTimersByTimeAsync(45_000);
  vi.useRealTimers();
  expect(h.drivers[0]!.stop).toHaveBeenCalledTimes(2);
  expect(h.runtime.getDriverStopBlock(h.session.id)).toBeUndefined();
  expect((await h.runtime.send(h.session.id, 'after recheck')).status).toBe('completed');
});

it('a recheck whose probe outlives an explicit restart leaves the new driver and its task alone', async () => {
  const h = await fixture();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await h.runtime.cleanupIdleDrivers(Date.now() + 100);
  let probing!: () => void, releaseProbe!: () => void, held = false;
  const entered = new Promise<void>(resolve => { probing = resolve; }), gate = new Promise<void>(resolve => { releaseProbe = resolve; });
  // The recheck's probe hangs; the restart's own exit proof (a later call) succeeds at once.
  h.drivers[0]!.isStopped = async () => { if (!held) { held = true; probing(); await gate; } return true; };
  await vi.advanceTimersByTimeAsync(45_000);
  await entered;
  vi.useRealTimers();
  await h.runtime.restart(h.session.id);
  let finish!: () => void;
  h.state.hold = new Promise<void>(resolve => { finish = resolve; });
  const task = await h.runtime.dispatch(h.session.id, 'after restart');
  await vi.waitFor(() => expect(h.drivers[1]?.send).toHaveBeenCalled());
  try {
    releaseProbe();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(h.drivers[1]!.stop).not.toHaveBeenCalled();
    expect(h.runtime.getDriver(h.session.id)).toBe(h.drivers[1]);
  } finally { finish(); }
  await vi.waitFor(async () => expect((await h.runtime.getTasks(h.session.id)).find(item => item.id === task.id)?.status).toBe('completed'));
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
  const gone = mkdtempSync(join(tmpdir(), 'dd-gone-workspace-')), goneAgain = mkdtempSync(join(tmpdir(), 'dd-gone-workspace-again-')), kept = mkdtempSync(join(tmpdir(), 'dd-kept-workspace-'));
  cleanup.push(() => { rmSync(gone, { recursive: true, force: true }); rmSync(goneAgain, { recursive: true, force: true }); rmSync(kept, { recursive: true, force: true }); });
  const first = runtimeFor(repos);
  await first.runtime.initialize([agent]);
  const lost = await first.runtime.start({ agentId: agent.id, cwd: gone });
  const lostAgain = await first.runtime.start({ agentId: agent.id, cwd: goneAgain });
  const healthy = await first.runtime.start({ agentId: agent.id, cwd: kept });
  await first.runtime.shutdown();
  rmSync(gone, { recursive: true, force: true });
  rmSync(goneAgain, { recursive: true, force: true });
  const restarted = runtimeFor(repos);
  await restarted.runtime.initialize([agent]);
  expect(warned(restarted.log, 'WORKSPACE_UNAVAILABLE')).toHaveLength(2);
  expect(warned(restarted.log, 'WORKSPACE_UNAVAILABLE').map(([data]) => data.sessionId)).toEqual(expect.arrayContaining([lost.id, lostAgain.id]));
  await restarted.runtime.shutdown();
  const restartedAgain = runtimeFor(repos);
  await restartedAgain.runtime.initialize([agent]);
  expect(warned(restartedAgain.log, 'WORKSPACE_UNAVAILABLE')).toHaveLength(2);
  expect((await restartedAgain.runtime.send(healthy.id, 'still works')).status).toBe('completed');
});

it('a session whose idle check throws is logged and skipped while the other idle sessions are still retired', async () => {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  cleanup.push(() => repos.close());
  const h = runtimeFor(repos);
  await h.runtime.initialize([agent]);
  const broken = await h.runtime.start({ agentId: agent.id }), healthy = await h.runtime.start({ agentId: agent.id });
  h.drivers[0]!.prepareForIdleRetirement = async () => { throw new Error('native check exploded'); };
  await h.runtime.cleanupIdleDrivers(Date.now() + 100);
  expect(h.drivers[0]!.stop).not.toHaveBeenCalled();
  expect(h.drivers[1]!.stop).toHaveBeenCalledOnce();
  expect(h.runtime.getDriver(healthy.id)).toBeUndefined();
  expect(h.log.warn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: broken.id, error: expect.objectContaining({ message: 'native check exploded' }) }), 'Idle driver check failed');
});

it('logs a maintenance loop failure instead of swallowing it', async () => {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  cleanup.push(() => repos.close());
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const log = { warn: vi.fn(), info: vi.fn() };
  const runtime = new DutydeckRuntime(repos, { cleanupIntervalMs: 1_000, log, probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: () => { throw new Error('unused'); } });
  cleanup.push(() => runtime.shutdown());
  await runtime.initialize([agent]);
  vi.spyOn(repos.execution, 'getReconcileRequiredAttempts').mockImplementation(() => { throw new Error('ledger read failed'); });
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ message: 'ledger read failed' }) }), 'Runtime maintenance loop failed'));
});
