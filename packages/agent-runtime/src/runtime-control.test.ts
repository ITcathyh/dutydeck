import { expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from './index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig, AgentDriver, DriverFactory } from '@dutydeck/shared';

it('rejects a second Runtime before recovery or config writes', async () => {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const first = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0 });
  const second = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0 });
  await first.initialize([]);
  const save = vi.spyOn(repos.agents, 'save');
  try {
    await expect(second.initialize([])).rejects.toThrow('DATABASE_RUNTIME_ALREADY_ATTACHED');
    expect(save).not.toHaveBeenCalled();
  } finally { await second.shutdown(); await first.shutdown(); repos.close(); }
});
it('does not allow public side effects before initialize', async () => {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0 });
  try { await expect(runtime.send('missing', 'work')).rejects.toMatchObject({ code: 'RUNTIME_NOT_INITIALIZED' }); }
  finally { await runtime.shutdown(); repos.close(); }
});
it('shares initialization and permits a new instance only after shutdown', async () => {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const first = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0 });
  const second = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0 });
  const list = vi.spyOn(repos.agents, 'list');
  try {
    const a = first.initialize([]); const b = first.initialize([]);
    expect(a).toBe(b);
    await a;
    await first.initialize([]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(() => repos.close()).toThrow('DATABASE_RUNTIME_STILL_ATTACHED');
    await first.shutdown();
    await second.initialize([]);
    await expect(first.send('missing', 'work')).rejects.toThrow();
  } finally { await first.shutdown(); await second.shutdown(); repos.close(); }
});

it('keeps failed initialization sticky until explicit shutdown and a new instance', async () => {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0 });
  const list = vi.spyOn(repos.agents, 'list').mockRejectedValue(new Error('config read failed'));
  await expect(runtime.initialize([])).rejects.toThrow('config read failed');
  await expect(runtime.initialize([])).rejects.toThrow('config read failed');
  expect(list).toHaveBeenCalledTimes(1);
  await expect(runtime.getSession('missing')).rejects.toMatchObject({ code: 'RUNTIME_NOT_INITIALIZED' });
  expect(() => repos.close()).toThrow('DATABASE_RUNTIME_STILL_ATTACHED');
  await runtime.shutdown(); list.mockRestore();
  const next = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0 });
  try { await next.initialize([]); } finally { await next.shutdown(); repos.close(); }
});

it('waits for an entered initialization write before releasing its binding during shutdown', async () => {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0 });
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const save = repos.agents.save.bind(repos.agents);
  vi.spyOn(repos.agents, 'save').mockImplementation(async agent => { entered(); await gate; await save(agent); });
  const initializing = runtime.initialize([{ id: 'delayed', name: 'Delayed', command: 'unused', args: [], protocol: 'acp', env: {}, timeout: 10, permissionMode: 'ask', builtin: false, capabilities: { pause: false, resume: false } }]);
  const result = initializing.catch(error => error);
  await enteredPromise;
  const stopping = runtime.shutdown(); expect(runtime.shutdown()).toBe(stopping);
  let stopped = false; void stopping.then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false);
  expect(() => repos.close()).toThrow('DATABASE_RUNTIME_STILL_ATTACHED');
  release(); await stopping;
  expect(await result).toMatchObject({ code: 'OPERATION_REVOKED' });
  repos.close();
});

it('does not release its binding on shutdown failure while initialization recovery is still pending', async () => {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0 });
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const list = repos.config.list!.bind(repos.config);
  vi.spyOn(repos.config as { list: typeof list }, 'list').mockImplementation(async prefix => { entered(); await gate; return list(prefix); });
  vi.spyOn((runtime as any).verifications, 'stop').mockRejectedValue(new Error('stop failed'));
  const initializing = runtime.initialize([]).catch(error => error);
  await enteredPromise;
  const stopping = runtime.shutdown().catch(error => error);
  let stopped = false; void stopping.then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(stopped).toBe(false);
  expect(() => repos.close()).toThrow('DATABASE_RUNTIME_STILL_ATTACHED');
  release();
  expect(await stopping).toMatchObject({ message: 'stop failed' });
  expect(await initializing).toMatchObject({ code: 'OPERATION_REVOKED' });
  repos.close();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it.each((['prepare', 'commit', 'start'] as const).flatMap(stage => [
  { stage, shutdownFirst: false }, { stage, shutdownFirst: true }
]))('aborts initialization after A enters $stage when B fails (shutdown first: $shutdownFirst)', async ({ stage, shutdownFirst }) => {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-init-failure-'));
  const path = join(directory, 'state.sqlite');
  const agent: AgentConfig = { id: 'test', name: 'Test', protocol: 'acp', command: 'unused', args: [], cwd: directory, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  const seed = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
  const seedRuntime = new DutydeckRuntime(seed, { driverIdleTimeoutMs: 0, probe: () => ({ available: true, protocol: 'acp', pause: false, resume: true }), driverFactory: () => ({ start: async () => {}, send: async () => {}, interrupt: async () => {}, resume: async () => {}, isStopped: async () => true, stop: async () => {} }) });
  let taskAId = '', sessionAId = '', sessionBId = '';
  try {
    await seedRuntime.initialize([agent]);
    sessionAId = (await seedRuntime.start({ agentId: agent.id, cwd: directory })).id;
    sessionBId = (await seedRuntime.start({ agentId: agent.id, cwd: directory })).id;
    vi.spyOn(seedRuntime as unknown as { scheduleQueue(id: string): void }, 'scheduleQueue').mockImplementation(() => {});
    taskAId = (await seedRuntime.dispatch(sessionAId, 'work')).id;
    expect(seed.execution.getTaskExecution(taskAId)!.attempts).toEqual([]);
  } finally { await seedRuntime.shutdown(); seed.close(); }

  const repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
  const entered = deferred(), gate = deferred(), stopEntered = deferred(), stopGate = deferred();
  let physical = false, stageFinished = false, authorizations = 0;
  const hold = async () => { entered.resolve(); await gate.promise; stageFinished = true; };
  const send = vi.fn(async () => {});
  const stop = vi.fn(async () => { stopEntered.resolve(); await stopGate.promise; physical = true; });
  const factory = vi.fn<DriverFactory>(() => ({
    start: async () => { if (stage === 'start') await hold(); },
    resume: async () => {}, interrupt: async () => {}, isStopped: async () => physical,
    send, stop
  }));
  let stopping: Promise<void> | undefined;
  const runtime = new DutydeckRuntime(repos, {
    driverIdleTimeoutMs: 0,
    probe: () => ({ available: true, protocol: 'acp', pause: false, resume: true }),
    driverFactory: factory,
    authorizeExecution: async () => {
      const call = ++authorizations;
      if (stage === 'prepare') await hold();
      // The submit commit runs after the driver has actually started.
      if (stage === 'commit' && call === 2) return hold;
    }
  });
  const rawList = repos.sessions.list.bind(repos.sessions);
  vi.spyOn(repos.sessions, 'list').mockImplementation(async () => {
    const rows = await rawList();
    return [rows.find(row => row.id === sessionAId)!, rows.find(row => row.id === sessionBId)!];
  });
  const manager = (runtime as unknown as { workspaces: { get(id: string): Promise<unknown> } }).workspaces;
  const get = manager.get.bind(manager);
  let observedCloseError: unknown;
  const recoveryFailure = new Error('session B recovery failed');
  vi.spyOn(manager, 'get').mockImplementation(async id => {
    if (id !== sessionBId) return get(id);
    await entered.promise;
    if (shutdownFirst) {
      stopping = runtime.shutdown();
      try { repos.close(); } catch (error) { observedCloseError = error; }
    }
    throw recoveryFailure;
  });
  const initializing = runtime.initialize([agent]).catch(error => error);
  try {
    if (shutdownFirst) {
      expect(await initializing).toMatchObject({ code: 'OPERATION_REVOKED' });
      expect(observedCloseError).toMatchObject({ message: expect.stringContaining('DATABASE_RUNTIME_STILL_ATTACHED') });
    } else {
      expect(await initializing).toBe(recoveryFailure);
      expect(() => repos.close()).toThrow('DATABASE_RUNTIME_STILL_ATTACHED');
    }
    stopping ??= runtime.shutdown();
    if (stage !== 'prepare') {
      await stopEntered.promise;
      expect(factory).toHaveBeenCalledOnce();
      expect(stageFinished).toBe(false);
      let finished = false; void stopping.then(() => { finished = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(finished).toBe(false);
      expect(() => repos.close()).toThrow('DATABASE_RUNTIME_STILL_ATTACHED');
      gate.resolve();
      await vi.waitFor(() => expect(stageFinished).toBe(true));
      expect(finished).toBe(false);
      expect(physical).toBe(false);
      expect(() => repos.close()).toThrow('DATABASE_RUNTIME_STILL_ATTACHED');
    } else {
      expect(factory).not.toHaveBeenCalled();
      gate.resolve();
    }
    stopGate.resolve(); await stopping;
    expect(send).not.toHaveBeenCalled();
    const execution = repos.execution.getTaskExecution(taskAId)!;
    expect(execution.task.status).toBe('queued');
    expect(execution.attempts).toHaveLength(1);
    expect(execution.currentAttempt).toMatchObject({ state: 'suspended', submissionState: 'not_submitted' });
    if (stage !== 'prepare') expect(stop).toHaveBeenCalledOnce();
  } finally {
    gate.resolve(); stopGate.resolve();
    await initializing; await runtime.shutdown(); repos.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('runs the preserved queued Task exactly once on a later successful initialization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-init-retry-'));
  const path = join(directory, 'state.sqlite');
  const agent: AgentConfig = { id: 'test', name: 'Test', protocol: 'acp', command: 'unused', args: [], cwd: directory, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  let sendCount = 0;
  const factory: DriverFactory = (_a, _p, emit) => ({
    start: vi.fn(async () => {}),
    resume: async () => {}, interrupt: async () => {}, isStopped: async () => true,
    send: vi.fn(async () => { sendCount++; emit({ type: 'text', data: { text: 'done' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); }),
    stop: vi.fn(async () => {})
  });
  const seed = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
  const seedRuntime = new DutydeckRuntime(seed, { driverIdleTimeoutMs: 0, probe: () => ({ available: true, protocol: 'acp', pause: false, resume: true }), driverFactory: () => ({ start: async () => {}, send: async () => {}, interrupt: async () => {}, resume: async () => {}, isStopped: async () => true, stop: async () => {} }) });
  let taskId = '';
  try {
    await seedRuntime.initialize([{ ...agent, cwd: directory }]);
    const a = await seedRuntime.start({ agentId: agent.id, cwd: directory });
    taskId = (await seedRuntime.dispatch(a.id, 'work')).id;
    await seedRuntime.shutdown();
  } finally { seed.close(); }

  const repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0, probe: () => ({ available: true, protocol: 'acp', pause: false, resume: true }), driverFactory: factory });
  try {
    await runtime.initialize([{ ...agent, cwd: directory }]);
    await vi.waitFor(() => expect(sendCount).toBe(1));
    expect(repos.execution.getTaskExecution(taskId)!.task.status).toBe('completed');
    await runtime.shutdown();
    expect(sendCount).toBe(1);
  } finally { await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true }); }
});

it('waits for cleanup created after shutdown has already entered its initialization barrier', async () => {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0 });
  const initEntered = deferred(), initGate = deferred(), barrierEntered = deferred(), cleanupEntered = deferred(), cleanupGate = deferred();
  const verifications = (runtime as any).verifications;
  runtime.getDriver('historical-session');
  vi.spyOn(verifications, 'interruptRunning').mockImplementation(async () => { initEntered.resolve(); await initGate.promise; throw new Error('late recovery failure'); });
  let cleanupCalls = 0, cleanupFinished = false;
  vi.spyOn(verifications, 'stopSession').mockImplementation(async () => {
    if (++cleanupCalls === 2) { cleanupEntered.resolve(); await cleanupGate.promise; cleanupFinished = true; }
  });
  const initializing = runtime.initialize([]);
  const result = initializing.catch(error => error);
  await initEntered.promise;
  // Observe Promise.allSettled subscribing in finally without changing its result.
  const then = initializing.then.bind(initializing);
  const subscription = vi.spyOn(initializing, 'then').mockImplementation((onfulfilled, onrejected) => {
    const pending = then(onfulfilled, onrejected); barrierEntered.resolve(); return pending;
  });
  let stopped = false;
  const stopping = runtime.shutdown().then(() => { stopped = true; });
  try {
    await barrierEntered.promise;
    expect(cleanupCalls).toBe(1);
    expect((runtime as any).initializationCleanup).toBeUndefined();
    initGate.resolve();
    expect(await result).toMatchObject({ message: 'late recovery failure' });
    await cleanupEntered.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stopped).toBe(false);
    expect(cleanupFinished).toBe(false);
    expect(() => repos.close()).toThrow('DATABASE_RUNTIME_STILL_ATTACHED');
    cleanupGate.resolve(); await stopping;
    expect(cleanupFinished).toBe(true);
    const next = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0 });
    try { await next.initialize([]); } finally { await next.shutdown(); }
  } finally {
    initGate.resolve(); cleanupGate.resolve();
    await stopping; await (runtime as any).initializationCleanup;
    subscription.mockRestore(); repos.close();
  }
});
