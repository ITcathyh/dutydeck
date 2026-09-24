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
// to prove that the reopened Runtime never automatically recovers or resubmits
// an unconfirmed turn even when the backend completed offline.
function persistentTurn() {
  const backendHistory: NormalizedDriverEvent[] = [];
  let backendCompleted = false;
  let seenCursor = 0;
  const prompts: string[] = [];
  const drivers: Array<{ start: ReturnType<typeof vi.fn>; recover: ReturnType<typeof vi.fn> }> = [];
  let attachedEmit: ((event: NormalizedDriverEvent) => void) | undefined;
  let attachedResolve: (() => void) | undefined;
  const factory: DriverFactory = (_agent, _protocol, emit) => {
    attachedEmit = emit;
    const entry = { start: vi.fn(async () => {}), recover: vi.fn(async () => {}) };
    drivers.push(entry);
    return {
      start: entry.start,
      resume: vi.fn(async () => {}), interrupt: vi.fn(async () => {}),
      send: vi.fn(async prompt => {
        prompts.push(prompt);
        await new Promise<void>(resolve => { attachedResolve = resolve; });
      }),
      recover: entry.recover,
      isStopped: async () => true,
      stop: vi.fn(async () => {
        // stop explicitly detaches the emit callback and resolves the local send wait,
        // while preserving the observable backend state.
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
  it.each([false, true])('marks a submitted, unconfirmed Attempt reconcile_required without reattaching or resending (completed offline: %s)', async offline => {
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

    // The frozen Runtime never transparently reattaches the old turn or resends, even if completed offline.
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

  it('does not resubmit an interrupted submitted turn and leaves its result reconcile_required on reopen', async () => {
    const file = database(); const backend = persistentTurn();
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
