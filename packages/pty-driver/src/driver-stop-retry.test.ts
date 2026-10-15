import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { HerdrBackend } from '@dutydeck/session-backends';
import type { AgentConfig } from '@dutydeck/shared';
import { PtyCliDriver, type PtyCliDriverOptions } from './driver.js';

const agent: AgentConfig = {
  id: 'stop-retry', name: 'Stop retry', protocol: 'pty-cli', command: '/unused', args: [], cwd: '/tmp', env: {},
  permissionMode: 'full-trust', timeout: 60, capabilities: { resume: true, pause: false }, builtin: false,
};
afterEach(() => vi.restoreAllMocks());

function fixture(options: Partial<Pick<PtyCliDriverOptions, 'onEvent' | 'onExit' | 'sessionId'>> = {}) {
  const backend = new HerdrBackend('dutydeck-0123456789abcdef0123456789abcdef', {
    binary: '/unused', stateFile: `/tmp/dutydeck-stop-retry-${crypto.randomUUID()}.json`, ownerId: 'fixture', env: {},
    processProbe: { identify() { throw new Error('unused'); }, observe() { return 'alive'; } },
  });
  vi.spyOn(backend, 'cancelPending').mockResolvedValue();
  vi.spyOn(backend, 'setDutydeckMetadata').mockResolvedValue();
  let alive = true;
  const stopped = () => { alive = false; };
  const physicalStop = vi.spyOn(backend, 'stopOwnedIdentity').mockImplementation(async () => stopped());
  vi.spyOn(backend, 'isStopped').mockImplementation(async () => !alive);
  const driver = new PtyCliDriver({
    agent, adapter: { id: 'fixture', capabilities: {}, buildArgs: () => [], writeInput() {} },
    backend, sessionId: 'ses_stop_retry', onEvent() {}, onExit() {}, ...options,
  });
  return { driver, backend, physicalStop, stopped, alive: () => alive };
}

it.each(['error', 'unproven'] as const)('retries physical stop after an %s result without reopening input', async result => {
  const f = fixture();
  if (result === 'error') f.physicalStop.mockRejectedValueOnce(new Error('transient control timeout'));
  else f.physicalStop.mockResolvedValueOnce(undefined);
  await f.driver.stop();
  expect(await f.driver.isStopped()).toBe(false);
  await f.driver.stop();
  expect(f.physicalStop).toHaveBeenCalledTimes(2);
  expect(await f.driver.isStopped()).toBe(true);
  await expect(f.driver.send('must remain stopped')).rejects.toThrow(/after stop/);
  await f.driver.stop();
  expect(f.physicalStop).toHaveBeenCalledTimes(2);
});

it('runtime stop retries release the original blocked driver after physical exit', async () => {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  let f!: ReturnType<typeof fixture>;
  const runtime = new DutydeckRuntime(repos, {
    cleanupIntervalMs: 0,
    probe: () => ({ protocol: 'pty-cli', available: true, pause: false, resume: true }),
    driverFactory(_agent, _protocol, onEvent, onExit, sessionId) {
      f = fixture({ onEvent, onExit, sessionId: sessionId! });
      vi.spyOn(f.driver, 'start').mockResolvedValue();
      f.physicalStop.mockRejectedValueOnce(new Error('transient control timeout'));
      return f.driver;
    },
  });
  try {
    await runtime.initialize([agent]);
    const session = await runtime.start({ agentId: agent.id });
    await expect(runtime.stop(session.id)).rejects.toMatchObject({ code: 'DRIVER_STOP_UNVERIFIED' });
    await runtime.stop(session.id);
    expect(f.physicalStop).toHaveBeenCalledTimes(2);
    expect(f.alive()).toBe(false);
    expect((await runtime.getSession(session.id))?.state).toBe('stopped');
  } finally { await runtime.shutdown(); repos.close(); }
});

it('shares an in-flight physical stop and rejects new input immediately', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  f.physicalStop.mockImplementation(async () => { entered(); await gate; f.stopped(); });
  const first = f.driver.stop(), second = f.driver.stop();
  try {
    expect(second).toBe(first);
    await expect(f.driver.send('must not submit')).rejects.toThrow(/after stop/);
    await entering;
    expect(f.physicalStop).toHaveBeenCalledTimes(1);
    expect(await f.driver.isStopped()).toBe(false);
  } finally { release(); await Promise.all([first, second]); }
  expect(await f.driver.isStopped()).toBe(true);
});
