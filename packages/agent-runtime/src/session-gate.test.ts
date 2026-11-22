import { defaultDriverProviders } from '../../../apps/server/src/driver-providers.js';
import { runtimeComponents } from '../test-support/components.js';
import { expect, it, vi } from 'vitest';
import type { RepositoryBundle, TaskRecord } from '@dutydeck/shared';
import { DutydeckRuntime } from './index.js';
import { owner } from './ownership.js';

const id = 'session';
function fixture() {
  const execution = {
    getTaskExecution: vi.fn(), getUnresolvedTasks: vi.fn().mockReturnValue([]),
    hasQueuedOrRunningTasks: vi.fn().mockReturnValue(false)
  };
  const unexpectedOperation = async () => { throw new Error('Admission invoked a driver operation'); };
  const driver = {
    start: unexpectedOperation, send: unexpectedOperation, interrupt: unexpectedOperation,
    resume: unexpectedOperation, stop: unexpectedOperation,
    isIdle: vi.fn(() => true), hasBackgroundWork: vi.fn(() => false), isDetachedForShutdown: vi.fn(() => false)
  };
  const r = new DutydeckRuntime({ execution } as unknown as RepositoryBundle, { providers: defaultDriverProviders(), cleanupIntervalMs: 0 }) as any;
  runtimeComponents(r).supervisor.connectedDrivers.set(id, driver);
  runtimeComponents(r).scheduler.queues.set(id, [{ id: 'task' } as TaskRecord]);
  // Observe admission without starting a second turn or finishing the drain.
  runtimeComponents(r).scheduler.drainQueue = vi.fn(() => new Promise<void>(() => {}));
  return { r, driver, execution };
}

type Case = [string, boolean, boolean, boolean, (f: ReturnType<typeof fixture>) => void];
// Expected blocking effects at the three actual entry points, including indirect recovery checks.
const cases: Case[] = [
  ['clear', false, false, false, () => {}],
  ['capacity_wait', true, false, false, ({ r, execution }) => { runtimeComponents(r).scheduler.capacityTimers.set(id, { taskId: 'task' }); execution.getTaskExecution.mockReturnValue({ task: { status: 'queued' }, currentAttempt: { automaticRetry: { dueAt: '2099-01-01' } } }); }],
  ['pty_retirement', true, false, true, ({ r }) => { runtimeComponents(r).recovery.reservePtyRetirement(id); }],
  ['shutting_down', true, false, true, ({ r }) => { r.shuttingDown = true; }],
  ['queue_held', true, false, false, ({ r }) => { r.setQueueHeld(true); }],
  ['initialization_failed', true, false, false, ({ r }) => { r.initializationFailed = true; }],
  ['queue_blocked', true, false, false, ({ r }) => { runtimeComponents(r).scheduler.queueBlocked.add(id); }],
  ['resource_queue_blocked', true, false, false, ({ r }) => { runtimeComponents(r).scheduler.resourceQueueBlocked.add(id); }],
  ['driver_retiring', true, true, true, ({ r }) => { runtimeComponents(r).supervisor.retiringDrivers.add(id); }],
  ['stop_running', true, true, true, ({ r }) => { runtimeComponents(r).supervisor.stopRuns.set(id, Promise.resolve()); }],
  ['stop_unverified', true, true, false, ({ r }) => { runtimeComponents(r).supervisor.stops.setBlock(id, { sessionId: id, runId: 'run', reason: 'pending' }); }],
  ['blocked_driver', true, true, true, ({ r, driver }) => { runtimeComponents(r).supervisor.stops.setDriver(id, { driver, reason: 'pending' }); }],
  ['lifecycle_revoked', true, false, true, ({ r }) => { r.lifecycle(id).revoke(); }],
  ['parent_revoked', true, false, false, ({ r }) => { const parent = owner(id); r.lifecycles.set(id, owner(id, parent)); parent.revoke(); }],
  ['drain_active', true, false, true, ({ r }) => { runtimeComponents(r).mutations.drains.set(id, owner(id)); }],
  ['attempt_active', true, true, true, ({ r }) => { runtimeComponents(r).mutations.attempts.set(id, owner(id)); }],
  ['verification_active', true, true, true, ({ r }) => { r.verifyingSessions.add(id); }],
  ['steering_active', true, true, true, ({ r }) => { runtimeComponents(r).steering.steeringSessions.set(id, 'turn'); }],
  ['verification_blocked', true, true, false, ({ r }) => { r.blockedVerificationSessions.set(id, 'pending'); }],
  ['queue_empty', true, false, false, ({ r }) => { runtimeComponents(r).scheduler.queues.delete(id); }],
  ['turn_active', false, true, true, ({ r }) => { r.activeTurns.add(id); }],
  ['driver_replaced', false, false, true, ({ r }) => { runtimeComponents(r).supervisor.connectedDrivers.delete(id); }],
  ['steering_reply', false, false, true, ({ r, driver }) => { runtimeComponents(r).steering.steeringReplies.set('reply', { sessionId: id, driver }); }],
  ['factory_cleanup', false, false, true, ({ r }) => { runtimeComponents(r).supervisor.factoryCleanups.set(id, Promise.resolve()); }],
  ['driver_operation', false, false, true, ({ r, driver }) => { runtimeComponents(r).supervisor.driverOperations.set(driver, new Set([Promise.resolve()])); }],
  ['permission_pending', false, false, true, ({ r }) => {
    const token = owner(id);
    r.mutations.run(token, () => runtimeComponents(r).humanWaits.register(
      { sessionId: id, runId: 'run', taskId: 'task', attemptId: 'attempt' },
      { id: 'request', title: 'Permission', status: 'pending' }, 'native'));
  }],
  ['answer_pending', false, false, true, ({ r }) => { r.options.awaitingAnswer = () => true; }],
  ['background_work', false, false, true, ({ driver }) => { driver.hasBackgroundWork.mockReturnValue(true); }],
  ['driver_detached', false, false, true, ({ driver }) => { driver.isDetachedForShutdown.mockReturnValue(true); }],
  ['driver_not_idle', false, false, true, ({ driver }) => { driver.isIdle.mockReturnValue(false); }],
  ['unresolved_tasks', false, false, true, ({ execution }) => { execution.getUnresolvedTasks.mockReturnValue([{}]); }],
  ['queued_or_running', false, false, true, ({ execution }) => { execution.hasQueuedOrRunningTasks.mockReturnValue(true); }],
];

it.each(cases)('%s', (_name, drain, held, idle, activate) => {
  const f = fixture();
  activate(f);
  expect(runtimeComponents(f.r).scheduler.sessionHeld(id)).toBe(held);
  expect(runtimeComponents(f.r).supervisor.idleCpuBlocked(id, f.driver)).toBe(idle);
  runtimeComponents(f.r).scheduler.scheduleQueue(id);
  expect(vi.mocked(runtimeComponents(f.r).scheduler.drainQueue).mock.calls.length === 0).toBe(drain);
});

it('returns concurrent reasons with the original stop evidence and skips unnecessary probes during admission', () => {
  const { r, driver, execution } = fixture();
  runtimeComponents(r).supervisor.stops.setBlock(id, { sessionId: id, runId: 'run', reason: 'exit pending' });
  runtimeComponents(r).supervisor.stops.setDriver(id, { driver, reason: 'driver pending' });
  expect(r.gate.reasons(id, 'held')).toEqual([
    { code: 'stop_unverified', reason: 'exit pending' }, { code: 'blocked_driver', reason: 'driver pending' }
  ]);
  expect(runtimeComponents(r).supervisor.idleCpuBlocked(id, driver)).toBe(true);
  expect(driver.isIdle).not.toHaveBeenCalled();
  expect(execution.getUnresolvedTasks).not.toHaveBeenCalled();
});
