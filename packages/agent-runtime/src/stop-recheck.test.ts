import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig } from '@dutydeck/shared';
import { DutydeckRuntime, type AgentDriver, type SessionNotice } from './index.js';

const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
const owner = { kind: 'installation_owner', id: 'installation_owner' } as const;
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); });

interface Behaviour { exited: (build: number) => boolean; start?: (build: number) => Promise<void>; unverifiable?: boolean }
async function fixture(behaviour: Behaviour) {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  cleanup.push(() => repos.close());
  const log = { warn: vi.fn(), info: vi.fn() }, notices: SessionNotice[] = [], drivers: AgentDriver[] = [];
  const runtime = new DutydeckRuntime(repos, {
    cleanupIntervalMs: 0, driverIdleTimeoutMs: 10, log, onSessionNotice: (_session, notice) => { notices.push(notice); },
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_agent, _protocol, emit) => {
      const build = drivers.length + 1;
      const driver: AgentDriver = {
        start: vi.fn(async () => { await behaviour.start?.(build); }), resume: vi.fn(async () => {}), interrupt: vi.fn(async () => {}),
        send: vi.fn(async () => { emit({ type: 'text', data: { text: 'answer' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); }),
        stop: vi.fn(async () => {}), isStopped: vi.fn(async () => behaviour.exited(build)), prepareForIdleRetirement: async () => true,
        ...(behaviour.unverifiable ? { stopUnverifiable: () => build > 1 } : {}),
      };
      drivers.push(driver); return driver;
    },
  });
  cleanup.push(() => runtime.shutdown());
  await runtime.initialize([agent]);
  return { runtime, repos, log, notices, drivers };
}
/** First message completes, then idle retirement cannot prove the driver exited. */
async function idleBlocked() {
  const state = { exited: false };
  const h = await fixture({ exited: () => state.exited });
  const session = await h.runtime.start({ agentId: agent.id });
  expect((await h.runtime.send(session.id, 'first')).status).toBe('completed');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await h.runtime.cleanupIdleDrivers(Date.now() + 100);
  expect(h.drivers[0]!.stop).toHaveBeenCalledOnce();
  expect(h.runtime.getDriverStopBlock(session.id)).toBeDefined();
  return { ...h, state, session };
}

it('a recheck whose earlier exit proof now verifies does not stop the driver again', async () => {
  const h = await idleBlocked();
  h.state.exited = true;
  await vi.advanceTimersByTimeAsync(45_000);
  vi.useRealTimers();
  expect(h.runtime.getDriverStopBlock(h.session.id)).toBeUndefined();
  // A second stop would rebuild the proof from the wire-time identity and could drop processes the first stop recorded.
  expect(h.drivers[0]!.stop).toHaveBeenCalledOnce();
  expect((await h.runtime.send(h.session.id, 'after recheck')).status).toBe('completed');
});

it('a recheck neither aborts verification nor cancels capacity retries of the session', async () => {
  const h = await idleBlocked();
  const internal = h.runtime as unknown as { verifications: { stopSession(id: string): Promise<void> }; execution: { cancelCapacityRetries(...args: unknown[]): unknown[] } };
  const stopVerification = vi.spyOn(internal.verifications, 'stopSession');
  const cancelRetries = vi.spyOn(internal.execution, 'cancelCapacityRetries');
  h.state.exited = true;
  await vi.advanceTimersByTimeAsync(45_000);
  vi.useRealTimers();
  expect(h.runtime.getDriverStopBlock(h.session.id)).toBeUndefined();
  expect(stopVerification).not.toHaveBeenCalled();
  expect(cancelRetries).not.toHaveBeenCalled();
});

it('a new message during a recheck that stops the driver again is told the stop is unverified, not that it was revoked', async () => {
  const h = await idleBlocked();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(h.drivers[0]!.stop).mockImplementation(async () => { await gate; h.state.exited = true; });
  await vi.advanceTimersByTimeAsync(45_000);
  await vi.waitFor(() => expect(h.drivers[0]!.stop).toHaveBeenCalledTimes(2));
  await expect(h.runtime.dispatch(h.session.id, 'during recheck')).rejects.toMatchObject({ code: 'DRIVER_STOP_UNVERIFIED' });
  release();
  vi.useRealTimers();
  await vi.waitFor(() => expect(h.runtime.getDriverStopBlock(h.session.id)).toBeUndefined());
  expect((await h.runtime.send(h.session.id, 'after recheck')).status).toBe('completed');
});

it('a recheck whose exit probe hangs keeps rejecting new messages and keeps rechecking', async () => {
  const h = await idleBlocked();
  let probes = 0;
  vi.mocked(h.drivers[0]!.isStopped!).mockImplementation(async () => { if (++probes === 1) await new Promise(() => {}); return h.state.exited; });
  await vi.advanceTimersByTimeAsync(45_000);
  expect(probes).toBe(1);
  await expect(h.runtime.dispatch(h.session.id, 'while probing')).rejects.toMatchObject({ code: 'DRIVER_STOP_UNVERIFIED' });
  // The hung probe counts as unproven after its bound; the next recheck then proves exit.
  await vi.advanceTimersByTimeAsync(30_000);
  await expect(h.runtime.dispatch(h.session.id, 'still blocked')).rejects.toMatchObject({ code: 'DRIVER_STOP_UNVERIFIED' });
  h.state.exited = true;
  await vi.advanceTimersByTimeAsync(90_000);
  vi.useRealTimers();
  expect(h.runtime.getDriverStopBlock(h.session.id)).toBeUndefined();
  expect((await h.runtime.send(h.session.id, 'after recovery')).status).toBe('completed');
});

it('an explicit stop during a failing startup does not schedule a startup recheck that reopens the session', async () => {
  let fail!: () => void;
  const failing = new Promise<void>(resolve => { fail = resolve; });
  const exited = { second: false };
  const h = await fixture({ exited: build => build !== 2 || exited.second, start: async build => { if (build === 2) { await failing; throw new Error('start failed #2'); } } });
  const session = await h.runtime.start({ agentId: agent.id });
  expect((await h.runtime.send(session.id, 'first')).status).toBe('completed');
  await h.runtime.cleanupIdleDrivers(Date.now() + 100);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const second = h.runtime.send(session.id, 'second').catch(error => error);
  await vi.waitFor(() => expect(h.drivers[1]?.start).toHaveBeenCalled());
  const stopping = h.runtime.stop(session.id, owner).catch(error => error);
  fail();
  expect(await stopping).toMatchObject({ code: expect.stringMatching(/SESSION_RESOURCE_BLOCKED|DRIVER_STOP_UNVERIFIED/) });
  await second;
  await vi.advanceTimersByTimeAsync(46_000);
  exited.second = true;
  await vi.advanceTimersByTimeAsync(90_000);
  vi.useRealTimers();
  expect(h.notices).toEqual([]);
  // The stop block stays for the explicit stop's own recovery; nothing reopened the stopped session behind it.
  expect(h.runtime.getDriverStopBlock(session.id)).toBeDefined();
  expect((await h.runtime.getSession(session.id))?.state).not.toBe('interrupted');
});

it('a new session whose startup failed with unproven exit rejects messages until a recheck proves exit', async () => {
  const exited = { first: false };
  const h = await fixture({ exited: build => build !== 1 || exited.first, start: async build => { if (build === 1) throw new Error('start failed #1'); } });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await expect(h.runtime.start({ agentId: agent.id })).rejects.toMatchObject({ code: 'START_FAILED' });
  const [session] = await h.runtime.listSessions();
  await expect(h.runtime.dispatch(session!.id, 'after failed start')).rejects.toMatchObject({ code: 'DRIVER_STOP_UNVERIFIED', message: expect.stringContaining('自动恢复') });
  exited.first = true;
  await vi.advanceTimersByTimeAsync(46_000);
  vi.useRealTimers();
  expect(h.runtime.getDriverStopBlock(session!.id)).toBeUndefined();
  expect((await h.runtime.send(session!.id, 'after recovery')).status).toBe('completed');
});

it('a driver whose exit can never be verified is not rechecked forever and messages are not promised an automatic recovery', async () => {
  const h = await fixture({ exited: build => build !== 2, start: async build => { if (build === 2) throw new Error('start failed #2'); }, unverifiable: true });
  const session = await h.runtime.start({ agentId: agent.id });
  expect((await h.runtime.send(session.id, 'first')).status).toBe('completed');
  await h.runtime.cleanupIdleDrivers(Date.now() + 100);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  expect((await h.runtime.send(session.id, 'second')).status).toBe('failed');
  // Queued for the recovery flow instead of rejected with a promise that cannot be kept.
  const queued = await h.runtime.dispatch(session.id, 'third', 'queue', 'third', undefined, 'installation_owner');
  expect(queued.status).toBe('queued');
  await vi.advanceTimersByTimeAsync(46_000);
  const probes = vi.mocked(h.drivers[1]!.isStopped!).mock.calls.length;
  await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
  vi.useRealTimers();
  expect(vi.mocked(h.drivers[1]!.isStopped!).mock.calls.length).toBe(probes);
  expect(h.notices).toHaveLength(1);
  expect(h.notices[0]!.message).not.toContain('自动恢复');
  expect(h.notices[0]!.message).toContain('管理员');
});
