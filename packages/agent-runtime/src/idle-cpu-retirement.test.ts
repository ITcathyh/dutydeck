import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { agentConfigSchema, type AgentDriver, type DriverIdleCpuProof } from '@dutydeck/shared';
import { DutydeckRuntime } from './index.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(action: 'off' | 'diagnose' | 'retire' = 'retire') {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const state = { input: 0, cpu: 0, at: 0, prepared: true, idle: true, background: false, ask: false, stopped: true };
  const log = { warn: vi.fn(), info: vi.fn() };
  const drivers: AgentDriver[] = [];
  const runtime = new DutydeckRuntime(repos, { cleanupIntervalMs: 0, driverIdleTimeoutMs: 0, driverIdleCpuAction: action,
    log, awaitingAnswer: () => state.ask, probe: () => ({ protocol: 'pty-cli', available: true, resume: true }),
    driverFactory: (_agent, _protocol, emit) => {
      const driver: AgentDriver = { start: async () => {}, resume: async () => {}, interrupt: async () => {},
        send: async () => { emit({ type: 'text', data: { text: 'answer' } }); emit({ type: 'completed', data: {} }); },
        isIdle: () => state.idle, hasBackgroundWork: () => state.background,
        stop: vi.fn(async () => {}), isStopped: async () => state.stopped, prepareForIdleRetirement: vi.fn(async () => state.prepared),
        idleCpuProof: () => ({ identity: 'owned:pid:birth', generation: drivers.length, inputRevision: state.input, lastInputAt: 0, nativeSessionId: 'original', cpuMs: state.cpu, sampledAt: state.at }),
        beginIdleCpuRetirement: vi.fn((expected: DriverIdleCpuProof) => expected.inputRevision === state.input),
      }; drivers.push(driver); return driver;
    },
  });
  cleanup.push(async () => { await runtime.shutdown(); repos.close(); });
  const agent = agentConfigSchema.parse({ id: 'fixture', name: 'fixture', command: process.execPath, protocol: 'pty-cli', capabilities: { resume: true } });
  await runtime.initialize([agent]); const session = await runtime.start({ agentId: agent.id });
  await runtime.send(session.id, 'first');
  const start = Date.now() + 11 * 60_000;
  async function sample(index: number) { state.cpu = index * 120_000; state.at = start + index * 120_000; await runtime.cleanupIdleDrivers(start + index * 120_000); }
  return { runtime, repos, state, log, drivers, session, sample };
}
it.each(['off', 'diagnose', 'retire'] as const)('supports %s independently of the six-hour timer', async action => {
  const h = await fixture(action);
  for (let i = 0; i <= 4; i++) await h.sample(i);
  expect(h.drivers[0]!.stop).toHaveBeenCalledTimes(action === 'retire' ? 1 : 0);
  expect(h.log.warn.mock.calls.filter(([data]) => data.code === 'IDLE_CPU_HIGH')).toHaveLength(action === 'off' ? 0 : 1);
  if (action === 'retire') { expect(h.runtime.getDriver(h.session.id)).toBeUndefined(); expect((await h.runtime.send(h.session.id, 'second')).status).toBe('completed'); }
});
it.each(['background', 'ask', 'notIdle', 'unprepared', 'unknownDriver', 'queue', 'unknown', 'permission', 'prepareInput', 'prepareQueue', 'prepareChild', 'finalInput'] as const)('does not retire with %s', async block => {
  const h = await fixture();
  for (let i = 0; i <= 2; i++) await h.sample(i);
  const driver = h.drivers[0]!;
  if (block === 'background') h.state.background = true;
  if (block === 'ask') h.state.ask = true;
  if (block === 'notIdle') h.state.idle = false;
  if (block === 'unprepared') h.state.prepared = false;
  if (block === 'unknownDriver') driver.idleCpuProof = undefined;
  if (block === 'queue') { h.runtime.setQueueHeld(true); await h.runtime.dispatch(h.session.id, 'queued'); }
  if (block === 'unknown') vi.spyOn(h.repos.execution, 'getUnresolvedTasks').mockReturnValue([{ id: 'unknown', status: 'reconcile_required' }]);
  if (block === 'permission') vi.spyOn(h.runtime as any, 'permissionsForSession').mockReturnValue([{}]);
  if (block === 'prepareQueue') driver.prepareForIdleRetirement = async () => { h.runtime.setQueueHeld(true); await h.runtime.dispatch(h.session.id, 'arrived during prepare'); return true; };
  if (block === 'prepareChild') driver.prepareForIdleRetirement = async () => { driver.idleCpuProof = () => undefined; return true; };
  if (block === 'prepareInput') driver.prepareForIdleRetirement = async () => { h.state.input++; return true; };
  if (block === 'finalInput') driver.beginIdleCpuRetirement = () => { h.state.input++; return false; };
  await h.sample(3);
  expect(driver.stop).not.toHaveBeenCalled();
  expect(h.runtime.getDriver(h.session.id)).toBe(driver);
  vi.restoreAllMocks();
});
it('retains the existing stop block and recheck after an unverified early retirement', async () => {
  const h = await fixture(); h.state.stopped = false;
  for (let i = 0; i <= 3; i++) await h.sample(i);
  expect(h.runtime.getDriverStopBlock(h.session.id)).toBeDefined();
  await expect(h.runtime.send(h.session.id, 'blocked')).rejects.toMatchObject({ code: 'DRIVER_STOP_UNVERIFIED' });
  h.state.stopped = true;
  await h.runtime.stop(h.session.id);
});
