import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { type AgentConfig, type AgentDriver, type DriverFactory, type NormalizedDriverEvent } from '@dutydeck/shared';
import { DutydeckRuntime } from './index.js';

const agent: AgentConfig = { id: 'persistent', name: 'Persistent', command: 'unused', args: [], protocol: 'pty-cli', cwd: '/tmp', env: {}, permissionMode: 'full-trust', timeout: 30, capabilities: { pause: false, resume: true }, builtin: false };
const directories: string[] = [];
const runtimes: DutydeckRuntime[] = [];
const repositories: ReturnType<typeof createRepositories>[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  for (const repos of repositories.splice(0)) repos.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A mock driver fixture with an observable backend state machine separated from
// local attachment. It tracks backend history, completion state, and seen cursor
// to exercise both unverified turns and the verified recovery handshake,
// including completion while no Runtime is attached.
function persistentTurn(recoverable = false) {
  const backendHistory: NormalizedDriverEvent[] = [];
  let backendCompleted = false;
  let seenCursor = 0;
  const prompts: string[] = [];
  const drivers: Array<{ start: ReturnType<typeof vi.fn>; recover: ReturnType<typeof vi.fn> }> = [];
  let attachedEmit: ((event: NormalizedDriverEvent) => void) | undefined;
  let attachedResolve: (() => void) | undefined;
  const factory: DriverFactory = (_agent, _protocol, emit) => {
    attachedEmit = emit;
    let detached = false;
    let preserve = false;
    const entry = { start: vi.fn(async () => {}), recover: vi.fn(async (_state, onAttached?: () => Promise<void>) => {
      if (!recoverable) return;
      await onAttached?.();
      for (const event of backendHistory) emit(event);
      if (!backendCompleted) await new Promise<void>(resolve => { attachedResolve = resolve; });
    }) };
    drivers.push(entry);
    return {
      start: entry.start,
      resume: vi.fn(async () => {}), interrupt: vi.fn(async () => {}),
      send: vi.fn(async prompt => {
        prompts.push(prompt);
        await new Promise<void>(resolve => { attachedResolve = resolve; });
      }),
      recover: entry.recover,
      ...(recoverable ? {
        checkpoint: () => ({ kind: 'pty-jsonl-v1' as const, turnId: 'verified-turn', transcript: { offset: 0 } }),
        prepareForDaemonShutdown: (keep: boolean) => { preserve = keep; },
        isDetachedForShutdown: () => detached,
      } : {}),
      isStopped: async () => !detached,
      stop: vi.fn(async () => {
        // stop explicitly detaches the emit callback and resolves the local send wait,
        // while preserving the observable backend state.
        detached = recoverable && preserve;
        attachedEmit = undefined;
        attachedResolve?.();
        attachedResolve = undefined;
      })
    };
  };
  return {
    factory, prompts, drivers,
    backendHistory: () => [...backendHistory],
    isBackendCompleted: () => backendCompleted,
    seenCursor: () => seenCursor,
    tool(type: 'tool_call' | 'tool_result') {
      const event: NormalizedDriverEvent = { type, data: { id: 'tool', name: 'Read', status: type === 'tool_call' ? 'running' : 'completed' }, sourceId: 'record_' + backendHistory.length };
      backendHistory.push(event); attachedEmit?.(event);
    },
    publish(text: string) {
      const event: NormalizedDriverEvent = { type: 'text', data: { text }, sourceId: 'record_' + backendHistory.length };
      backendHistory.push(event);
      if (attachedEmit) {
        seenCursor++;
        attachedEmit(event);
      }
    },
    complete() {
      backendCompleted = true;
      const event: NormalizedDriverEvent = { type: 'completed', data: { stopReason: 'end_turn' } };
      backendHistory.push(event);
      if (attachedEmit) {
        seenCursor++;
        attachedEmit(event);
        attachedResolve?.();
        attachedResolve = undefined;
      }
    },
    startedAfter: (index: number) => drivers.slice(index).reduce((sum, driver) => sum + driver.start.mock.calls.length, 0),
    recoveredAfter: (index: number) => drivers.slice(index).reduce((sum, driver) => sum + driver.recover.mock.calls.length, 0)
  };
}

function database() {
  const dir = mkdtempSync(join(tmpdir(), 'dutydeck-task-recovery-'));
  directories.push(dir);
  return join(dir, 'dutydeck.db');
}

function open(database: string, factory: DriverFactory, options: ConstructorParameters<typeof DutydeckRuntime>[1] = {}) {
  const repos = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, { driverFactory: factory, probe: () => ({ available: true, protocol: 'pty-cli', pause: false, resume: true }), ...options });
  repositories.push(repos); runtimes.push(runtime);
  return { repos, runtime };
}

async function close(handle: ReturnType<typeof open>) {
  await handle.runtime.shutdown();
  handle.repos.close();
  runtimes.splice(runtimes.indexOf(handle.runtime), 1);
  repositories.splice(repositories.indexOf(handle.repos), 1);
}

describe('persistent task recovery across a reopened database', () => {
  it.each([false, true])('keeps a submitted Attempt without a checkpoint unresolved (completed offline: %s)', async offline => {
    const file = database(); const backend = persistentTurn();
    const first = open(file, backend.factory);
    await first.runtime.initialize([agent]);
    const session = await first.runtime.start({ agentId: agent.id });
    const task = await first.runtime.dispatch(session.id, 'original prompt');
    await vi.waitFor(() => expect(backend.prompts).toEqual(['original prompt']));
    backend.publish('before restart');
    await vi.waitFor(async () => expect((await first.runtime.getEvents(session.id)).some(event => (event.data as any)?.text === 'before restart')).toBe(true));
    expect(backend.seenCursor()).toBe(1);
    expect(backend.isBackendCompleted()).toBe(false);

    // Capture original identities before database closure
    const taskBeforeClose = first.repos.execution.getTaskExecution(task.id)!;
    const originalAttemptId = taskBeforeClose.currentAttempt!.attemptId;
    const originalSubmissionId = taskBeforeClose.currentAttempt!.submission!.submissionId;
    expect(originalSubmissionId).toBeDefined();
    expect(taskBeforeClose.currentAttempt?.submissionState).toBe('intent_recorded');

    await close(first);
    // After close, stop has detached the callback; offline publish/complete affects only backend facts
    if (offline) {
      backend.publish('offline text');
      backend.complete();
    }

    // Explicitly assert distinct backend history and completion state between offline true/false
    if (offline) {
      expect(backend.isBackendCompleted()).toBe(true);
      expect(backend.backendHistory()).toHaveLength(3); // 'before restart', 'offline text', 'completed'
      expect(backend.seenCursor()).toBe(1); // seenCursor remains at 1 because offline events were not delivered to attached driver
    } else {
      expect(backend.isBackendCompleted()).toBe(false);
      expect(backend.backendHistory()).toHaveLength(1);
      expect(backend.seenCursor()).toBe(1);
    }

    // Reopen database with fresh Runtime instance
    const second = open(file, backend.factory);
    await second.runtime.initialize([agent]);
    await vi.waitFor(async () => expect((await second.runtime.getTasks(session.id))[0]?.status).toBe('reconcile_required'));

    // Verify preservation of original Task, Attempt ID, and Submission identity/intent
    const stored = second.repos.execution.getTaskExecution(task.id)!;
    expect(stored.task.id).toBe(task.id);
    expect(stored.currentAttempt?.attemptId).toBe(originalAttemptId);
    expect(stored.currentAttempt?.submission?.submissionId).toBe(originalSubmissionId);
    expect(stored.currentAttempt).toMatchObject({ state: 'reconcile_required', submissionState: 'intent_recorded' });

    // Without a durable checkpoint, even an offline result cannot authorize adoption.
    expect(backend.recoveredAfter(1)).toBe(0);
    expect(backend.startedAfter(1)).toBe(0);
    expect(backend.prompts).toEqual(['original prompt']);
    expect((await second.runtime.getTasks(session.id)).map(item => item.id)).toEqual([task.id]);

    // The previously submitted events are not duplicated or lost; offline text is never projected into ledger events
    const events = await second.runtime.getEvents(session.id);
    expect(events.filter(event => event.type === 'text' && (event.data as any).text === 'before restart')).toHaveLength(1);
    expect(events.some(event => (event.data as any)?.text === 'offline text')).toBe(false);
    expect(events.filter(event => event.type === 'completed')).toHaveLength(0);
  });

  it('leaves queued work pending across shutdown and does not claim it behind an unconfirmed Attempt', async () => {
    const file = database(); const backend = persistentTurn();
    const first = open(file, backend.factory);
    await first.runtime.initialize([agent]);
    const session = await first.runtime.start({ agentId: agent.id });
    await first.runtime.dispatch(session.id, 'first');
    await vi.waitFor(() => expect(backend.prompts).toEqual(['first']));
    const queued = await first.runtime.dispatch(session.id, 'second');
    await close(first);
    const second = open(file, backend.factory);
    await second.runtime.initialize([agent]);
    // The submitted first Attempt becomes reconcile_required; the queued Task
    // is never claimed or sent behind the unconfirmed Attempt.
    await vi.waitFor(async () => expect((await second.runtime.getTasks(session.id))[0]?.status).toBe('reconcile_required'));
    expect((await second.runtime.getTasks(session.id)).find(task => task.id === queued.id)?.status).toBe('queued');
    expect(backend.prompts).toEqual(['first']);
    expect(backend.recoveredAfter(1)).toBe(0);
    expect(backend.startedAfter(1)).toBe(0);
  });

  it.each([false, true])('recovers a verified original turn and resumes its queue (offline: %s)', async offline => {
    const file = database(), backend = persistentTurn(true);
    const first = open(file, backend.factory);
    await first.runtime.initialize([agent]);
    const session = await first.runtime.start({ agentId: agent.id });
    const task = await first.runtime.dispatch(session.id, 'first');
    await vi.waitFor(() => expect(backend.prompts).toEqual(['first']));
    backend.tool('tool_call'); backend.tool('tool_result');
    backend.publish('before restart');
    await vi.waitFor(async () => expect((await first.runtime.getEvents(session.id)).some(event => (event.data as any).text === 'before restart')).toBe(true));
    const original = first.repos.execution.getTaskExecution(task.id)!.currentAttempt!;
    const queued = await first.runtime.dispatch(session.id, 'second');
    await close(first);
    if (offline) { backend.publish('offline answer'); backend.complete(); }
    const second = open(file, backend.factory);
    await second.runtime.initialize([agent]);
    if (!offline) { backend.publish('live answer'); backend.complete(); }
    await vi.waitFor(() => expect(backend.prompts).toEqual(['first', 'second']));
    const recovered = second.repos.execution.getTaskExecution(task.id)!.currentAttempt!;
    expect(recovered).toMatchObject({ attemptId: original.attemptId, submission: original.submission, submissionController: original.submissionController, state: 'settled', outcome: 'completed' });
    expect(recovered.controller).not.toEqual(original.controller);
    expect(backend.recoveredAfter(1)).toBe(1);
    expect(backend.startedAfter(1)).toBe(0);
    backend.publish('second answer'); backend.complete();
    await vi.waitFor(() => expect(second.repos.execution.getTaskExecution(queued.id)?.task.status).toBe('completed'));
    const events = await second.runtime.getEvents(session.id);
    expect(events.filter(event => event.type === 'text' && (event.data as any).text === 'before restart')).toHaveLength(1);
    expect(events.filter(event => event.type === 'completed')).toHaveLength(2);
    expect(events.filter(event => event.type === 'tool_call')).toHaveLength(1);
    expect(events.filter(event => event.type === 'tool_result')).toHaveLength(1);
  });

  it('counts running tasks as 1 during initial run and keeps 1 after recovering persistent turn', async () => {
    const file = database(), backend = persistentTurn(true);
    const first = open(file, backend.factory);
    await first.runtime.initialize([agent]);
    const session = await first.runtime.start({ agentId: agent.id });
    const task = await first.runtime.dispatch(session.id, 'first');
    await vi.waitFor(() => expect(backend.prompts).toEqual(['first']));
    expect(first.runtime.getRunningTaskCount()).toBe(1);

    await close(first);

    // Reopen without completing offline turn: recovery should adopt it and count as 1
    const second = open(file, backend.factory);
    await second.runtime.initialize([agent]);
    expect(second.runtime.getRunningTaskCount()).toBe(1);

    backend.publish('live answer');
    backend.complete();
    await vi.waitFor(() => expect(second.runtime.getRunningTaskCount()).toBe(0));
  });

  it.each([false, true])('requires the verified-attachment handshake (rejected: %s)', async rejected => {
    const file = database(), backend = persistentTurn(true);
    const first = open(file, backend.factory);
    await first.runtime.initialize([agent]);
    const session = await first.runtime.start({ agentId: agent.id });
    const task = await first.runtime.dispatch(session.id, 'first');
    await vi.waitFor(() => expect(backend.prompts).toEqual(['first']));
    await close(first);
    const recover = vi.fn(async () => { if (rejected) throw new Error('mismatched identity'); });
    const factory: DriverFactory = (...args) => ({ ...backend.factory(...args), recover });
    const second = open(file, factory);
    await second.runtime.initialize([agent]);
    expect(recover).toHaveBeenCalledOnce();
    expect(second.repos.execution.getTaskExecution(task.id)?.currentAttempt?.state).toBe('reconcile_required');
    expect(second.runtime.getDriver(session.id)).toBeUndefined();
    expect(backend.prompts).toEqual(['first']);
  });

  it('keeps revoked task authorization local to recovery and still initializes other sessions', async () => {
    const file = database(), backend = persistentTurn(true);
    const first = open(file, backend.factory);
    await first.runtime.initialize([agent]);
    const session = await first.runtime.start({ agentId: agent.id });
    const task = await first.runtime.dispatch(session.id, 'first');
    await vi.waitFor(() => expect(backend.prompts).toEqual(['first']));
    await close(first);
    const second = open(file, backend.factory, { authorizeTask: async () => { throw new Error('revoked'); } });
    await expect(second.runtime.initialize([agent])).resolves.toBeUndefined();
    expect(second.repos.execution.getTaskExecution(task.id)?.currentAttempt?.state).toBe('reconcile_required');
    expect(backend.recoveredAfter(1)).toBe(0);
    expect((await second.runtime.getEvents(session.id)).some(event => (event.data as any).code === 'PTY_RECOVERY_DEFERRED')).toBe(true);
    await expect(second.runtime.start({ agentId: agent.id })).resolves.toBeDefined();
  });

  it('preserves an explicit unknown stop reason across reopen and never adopts its surviving resource', async () => {
    const file = database(), backend = persistentTurn(true);
    const factory: DriverFactory = (...args) => ({ ...backend.factory(...args), isStopped: async () => false, isDetachedForShutdown: () => false });
    const first = open(file, factory);
    await first.runtime.initialize([agent]);
    const session = await first.runtime.start({ agentId: agent.id });
    const task = await first.runtime.dispatch(session.id, 'first');
    await vi.waitFor(() => expect(backend.prompts).toEqual(['first']));
    await expect(first.runtime.stop(session.id, { kind: 'installation_owner', id: 'installation_owner' })).rejects.toMatchObject({ code: 'DRIVER_STOP_UNVERIFIED' });
    expect(first.repos.execution.getTaskExecution(task.id)?.currentAttempt?.reconcileReason?.code).toBe('STOP_RESULT_UNKNOWN');
    await close(first);
    const second = open(file, factory);
    await second.runtime.initialize([agent]);
    expect(second.repos.execution.getTaskExecution(task.id)?.currentAttempt?.reconcileReason?.code).toBe('STOP_RESULT_UNKNOWN');
    expect(backend.recoveredAfter(1)).toBe(0);
    expect(backend.prompts).toEqual(['first']);
  });

  it('preserves an unsubmitted queued task when shutdown races with authorization', async () => {
    const file = database(); const backend = persistentTurn();
    let authorize!: () => void;
    const gate = new Promise<void>(resolve => { authorize = resolve; });
    // Acceptance authorization passes so the Task is admitted; the
    // execution-time authorization then holds it unsubmitted.
    let accepted = false;
    const first = open(file, backend.factory, { authorizeExecution: async () => { if (!accepted) { accepted = true; return; } await gate; } });
    await first.runtime.initialize([agent]);
    const session = await first.runtime.start({ agentId: agent.id });
    await first.runtime.dispatch(session.id, 'not yet submitted');
    await vi.waitFor(async () => expect((await first.runtime.getTasks(session.id))[0]?.status).toBe('queued'));
    const stopped = first.runtime.shutdown();
    authorize(); await stopped;
    expect(backend.prompts).toEqual([]);
    const stored = first.repos.execution.getTaskExecution((await first.runtime.getTasks(session.id))[0]!.id)!;
    expect(stored.task.status).toBe('queued');
    // The Attempt was claimed (preparing) but never submitted, so shutdown
    // suspends it rather than dropping or re-sending the prompt.
    expect(stored.currentAttempt).toMatchObject({ state: 'suspended', submissionState: 'not_submitted' });
  });

  it('does not resend when the original backend cannot be confirmed, and leaves the submitted Attempt reconcile_required', async () => {
    const file = database(); const backend = persistentTurn();
    const first = open(file, backend.factory);
    await first.runtime.initialize([agent]);
    const session = await first.runtime.start({ agentId: agent.id });
    await first.runtime.dispatch(session.id, 'first');
    await vi.waitFor(() => expect(backend.prompts).toEqual(['first']));
    await first.runtime.dispatch(session.id, 'second');
    await close(first);
    // A driver whose old terminal is gone: recover would throw, but the frozen
    // Runtime must not even attempt an automatic reattach.
    const rejectingFactory: DriverFactory = () => ({ ...(backend.factory as () => AgentDriver)(), recover: vi.fn(async () => { throw new Error('original terminal gone'); }) });
    const second = open(file, rejectingFactory);
    await second.runtime.initialize([agent]);
    await vi.waitFor(async () => expect((await second.runtime.getTasks(session.id))[0]?.status).toBe('reconcile_required'));
    expect(backend.prompts).toEqual(['first']);
    expect(backend.recoveredAfter(1)).toBe(0);
    expect(backend.startedAfter(1)).toBe(0);
  });

  it.each([false, true])('does not recover an explicitly interrupted turn even with a checkpoint (%s)', async recoverable => {
    const file = database(); const backend = persistentTurn(recoverable);
    const first = open(file, backend.factory);
    await first.runtime.initialize([agent]);
    const session = await first.runtime.start({ agentId: agent.id });
    const task = await first.runtime.dispatch(session.id, 'first');
    await vi.waitFor(() => expect(backend.prompts).toEqual(['first']));
    // Issue a real structured interrupt with an owner before shutdown. Under the
    // frozen ledger contract, intent is pinned and old session status heuristics are discarded.
    await first.runtime.interrupt(session.id, task.id, 'installation_owner');
    await close(first);
    const second = open(file, backend.factory);
    await second.runtime.initialize([agent]);
    await vi.waitFor(async () => expect((await second.runtime.getTasks(session.id))[0]?.status).toBe('reconcile_required'));
    const stored = second.repos.execution.getTaskExecution(task.id)!;
    expect(stored.currentAttempt?.submissionState).toBe('intent_recorded');
    expect(second.runtime.getDriver(session.id)).toBeUndefined();
    expect(backend.prompts).toEqual(['first']);
    expect(backend.recoveredAfter(1)).toBe(0);
  });
});

it('attaches a completed terminal once via getTerminalDriver without starting or changing the task', async () => {
  const file = database();
  const backend = persistentTurn();
  const first = open(file, backend.factory);
  await first.runtime.initialize([agent]);
  const session = await first.runtime.start({ agentId: agent.id });
  // Establish a real settled Task before closing so terminal attach observes a real Task.
  const firstTask = first.runtime.send(session.id, 'initial prompt');
  await vi.waitFor(() => expect(backend.prompts).toEqual(['initial prompt']));
  backend.publish('done');
  backend.complete();
  await firstTask;
  await close(first);

  const attached: AgentDriver = {
    start: vi.fn(async () => {}), resume: vi.fn(async () => {}), send: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}), isStopped: async () => true, stop: vi.fn(async () => {}), attachTerminal: vi.fn(() => true)
  };
  const factory = vi.fn(() => attached);
  const second = open(file, factory);
  await second.runtime.initialize([agent]);
  const beforeTask = (await second.runtime.getTasks(session.id))[0]!;
  const beforeSession = await second.runtime.getSession(session.id);
  await expect(Promise.all([second.runtime.getTerminalDriver(session.id), second.runtime.getTerminalDriver(session.id)])).resolves.toEqual([attached, attached]);
  expect(factory).toHaveBeenCalledOnce();
  expect(attached.attachTerminal).toHaveBeenCalledOnce();
  expect(attached.start).not.toHaveBeenCalled();
  expect(attached.resume).not.toHaveBeenCalled();
  expect(attached.send).not.toHaveBeenCalled();
  // Verify Task and Session snapshots are completely unchanged by terminal attachment.
  expect(await second.runtime.getSession(session.id)).toEqual(beforeSession);
  expect((await second.runtime.getTasks(session.id))[0]!).toEqual(beforeTask);
});

it('revokes a terminal reconnect paused before the driver factory', async () => {
  const file = database();
  const backend = persistentTurn();
  const first = open(file, backend.factory);
  await first.runtime.initialize([agent]);
  const session = await first.runtime.start({ agentId: agent.id });
  await close(first);
  const attached: AgentDriver = {
    start: vi.fn(async () => {}), resume: vi.fn(async () => {}), send: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}), isStopped: async () => true, stop: vi.fn(async () => {}), attachTerminal: vi.fn(() => true)
  };
  const second = open(file, () => attached);
  await second.runtime.initialize([agent]);
  let releaseAgent!: (value: AgentConfig) => void;
  const agentRead = new Promise<AgentConfig>(resolve => { releaseAgent = resolve; });
  const getAgent = vi.spyOn(second.repos.agents, 'get').mockReturnValueOnce(agentRead);
  const loading = second.runtime.getTerminalDriver(session.id);
  await vi.waitFor(() => expect(getAgent).toHaveBeenCalled());
  let releaseSession!: (value: Awaited<ReturnType<typeof second.runtime.getSession>>) => void;
  const sessionRead = new Promise<Awaited<ReturnType<typeof second.runtime.getSession>>>(resolve => { releaseSession = resolve; });
  vi.spyOn(second.repos.sessions, 'get').mockReturnValueOnce(sessionRead);
  const stopping = second.runtime.stop(session.id);
  releaseSession(await second.runtime.getSession(session.id));
  releaseAgent((await second.repos.agents.get(agent.id))!);
  expect(await loading).toBeUndefined();
  await stopping;
  expect(attached.attachTerminal).not.toHaveBeenCalled();
  expect(attached.stop).not.toHaveBeenCalled();
  expect(second.runtime.getDriver(session.id)).toBeUndefined();
  expect((await second.runtime.getSession(session.id))?.state).toBe('stopped');
});

it.each(['missing', 'foreign'] as const)('leaves a session usable when terminal viewing attaches nothing (%s pane)', async pane => {
  const file = database();
  const backend = persistentTurn();
  const first = open(file, backend.factory);
  await first.runtime.initialize([agent]);
  const session = await first.runtime.start({ agentId: agent.id });
  const firstTask = first.runtime.send(session.id, 'initial prompt');
  await vi.waitFor(() => expect(backend.prompts).toEqual(['initial prompt']));
  backend.complete();
  await firstTask;
  await close(first);

  // Mirrors the PTY driver after shutdown retired an idle pane (attach finds no
  // tmux session) or when a surviving pane fails the ownership check (attach
  // throws). Either way nothing is attached, so no physical exit can be proven.
  const unattached: AgentDriver = {
    start: vi.fn(async () => {}), resume: vi.fn(async () => {}), send: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}), isStopped: async () => false, stop: vi.fn(async () => {}),
    attachTerminal: vi.fn(() => { if (pane === 'foreign') throw new Error('tmux owner mismatch'); return false; })
  };
  // A missing pane is remembered after the first view; a foreign pane is rechecked on
  // every view. The next instruction builds a real driver either way.
  const views = pane === 'missing' ? 1 : 2;
  const factory = vi.fn<DriverFactory>((...args) => factory.mock.calls.length <= views ? unattached : backend.factory(...args));
  const second = open(file, factory);
  await second.runtime.initialize([agent]);
  const beforeSession = await second.runtime.getSession(session.id);

  const view = () => second.runtime.getTerminalDriver(session.id);
  if (pane === 'missing') await expect(view()).resolves.toBeUndefined();
  else await expect(view()).rejects.toThrow('tmux owner mismatch');
  expect(second.runtime.getDriver(session.id)).toBeUndefined();
  expect(second.runtime.getDriverStopBlock(session.id)).toBeUndefined();
  expect(second.repos.execution.getSessionResourceBlockers(session.id)).toEqual([]);
  expect(await second.runtime.getSession(session.id)).toEqual(beforeSession);
  // Viewing again reports the same attach outcome instead of a resource block.
  const rows = second.repos.execution.getResources(session.id).length;
  if (pane === 'missing') await expect(view()).resolves.toBeUndefined();
  else await expect(view()).rejects.toThrow('tmux owner mismatch');
  expect(factory).toHaveBeenCalledTimes(views);
  if (pane === 'missing') expect(second.repos.execution.getResources(session.id)).toHaveLength(rows);

  // The next instruction still starts a fresh driver for the idle session.
  await second.runtime.dispatch(session.id, 'next prompt');
  await vi.waitFor(() => expect(backend.prompts).toEqual(['initial prompt', 'next prompt']));
  backend.complete();
});
