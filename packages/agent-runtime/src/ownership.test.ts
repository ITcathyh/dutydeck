import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, AgentDriver, NormalizedDriverEvent } from '@dutydeck/shared';
import { DutydeckRuntime } from './index.js';
import { owner, SessionMutations } from './ownership.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const agent: AgentConfig = { id: 'owned', name: 'Owned', command: 'unused', args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
function deferred<T = unknown>() { let resolve!: (value?: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes as (value?: T) => void; reject = no; }); return { promise, resolve, reject }; }
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture(options: ConstructorParameters<typeof DutydeckRuntime>[1] = {}, filename = ':memory:') {
  const repos = createRepositories(filename, { newDatabaseAuthority: 'ledger_v1' });
  const runs: Array<{ driver: AgentDriver; emit: (event: NormalizedDriverEvent) => void; sent: ReturnType<typeof deferred>; done: ReturnType<typeof deferred>; settled: boolean }> = [];
  const factory = vi.fn((_a, _p, emit) => {
    const sent = deferred(), done = deferred();
    const run = { driver: null as unknown as AgentDriver, emit, sent, done, settled: false };
    const driver: AgentDriver = {
      start: async () => {}, resume: async () => {}, interrupt: async () => {},
      isStopped: async () => true,
      send: vi.fn(async () => { sent.resolve(); await done.promise; }),
      // Default stop releases the held turn so shutdown never dangles on a mock.
      stop: vi.fn(async () => { if (!run.settled) { run.settled = true; run.emit({ type: 'completed', data: { stopReason: 'cancelled' } }); done.resolve(); } })
    };
    run.driver = driver; runs.push(run); return driver;
  });
  const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0, probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: factory, ...options });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; try { await runtime.shutdown(); } finally { repos.close(); } };
  cleanup.push(close);
  await runtime.initialize([agent]); const session = await runtime.start({ agentId: agent.id });
  return { repos, runtime, session, runs, factory, close };
}

it.each(['resolve', 'reject'] as const)('reaps the old driver and ignores late stale callbacks after an unconfirmed stop (%s)', async completion => {
  const h = await fixture(), run = h.runs[0]!;
  const entered = deferred(), gate = deferred(); let physicallyStopped = false;
  run.driver.stop = async () => { entered.resolve(); await gate.promise; physicallyStopped = true; };
  run.driver.isStopped = async () => physicallyStopped;
  const lateFailure = new Error('stale failure');
  const observedTail = run.done.promise.then(() => 'resolved', error => error);
  const old = h.runtime.send(h.session.id, 'old');
  await run.sent.promise;
  let stopped = false;
  const stopping = h.runtime.stop(h.session.id).then(() => { stopped = true; });
  try {
    await entered.promise;
    expect((await old).status).toBe('reconcile_required');
    const before = await h.runtime.getTasks(h.session.id);
    run.emit({ type: 'error', data: { message: 'stale error' } });
    if (completion === 'resolve') run.done.resolve(); else run.done.reject(lateFailure);
    expect(await observedTail).toBe(completion === 'resolve' ? 'resolved' : lateFailure);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stopped).toBe(false);
    expect(await h.runtime.getTasks(h.session.id)).toEqual(before);
    gate.resolve(); await stopping;
    expect(h.runtime.getDriver(h.session.id)).toBeUndefined();
    expect(await h.runtime.getTasks(h.session.id)).toEqual(before);
    await expect(h.runtime.restart(h.session.id)).rejects.toMatchObject({ code: 'SESSION_PENDING_ATTEMPTS' });
  } finally { gate.resolve(); run.done.resolve(); await Promise.allSettled([old, stopping]); }
});

it('requires physical stop evidence before calling a replacement factory', async () => {
  const h = await fixture(); delete h.runs[0]!.driver.isStopped;
  await expect(h.runtime.stop(h.session.id)).rejects.toMatchObject({ code: 'DRIVER_STOP_UNVERIFIED' });
  await expect(h.runtime.restart(h.session.id)).rejects.toMatchObject({ code: 'DRIVER_STOP_UNVERIFIED' });
  expect(h.factory).toHaveBeenCalledTimes(1);
});

it.each(['prepare', 'authorize', 'taskAuthority', 'prompt', 'policy'] as const)('revokes a paused %s preparation without reviving it', async stage => {
  const entered = deferred(), gate = deferred();
  let blocked = true, commits = 0;
  const pause = async () => { if (blocked) { blocked = false; entered.resolve(); await gate.promise; } };
  const options: ConstructorParameters<typeof DutydeckRuntime>[1] = stage === 'prepare' ? { prepareTaskPrompt: async (_s, prompt) => { await pause(); return { agentPrompt: prompt }; } }
    : stage === 'authorize' ? { authorizeExecution: async () => { await pause(); return async () => { commits++; }; } }
    : stage === 'taskAuthority' ? { authorizeTask: pause }
    : stage === 'prompt' ? { sessionPrompt: async (_s, prompt) => { await pause(); return prompt; } }
    : { resolveRiskPolicy: async () => { await pause(); return undefined; } };
  const h = await fixture(options);
  const old = h.runtime.send(h.session.id, 'old').then(task => task, error => error);
  await entered.promise;
  await h.runtime.stop(h.session.id);
  const session = await h.runtime.restart(h.session.id);
  const before = await h.runtime.getSession(session.id);
  gate.resolve(); await old; await Promise.resolve();
  expect(await h.runtime.getSession(session.id)).toEqual(before);
  expect(h.runs[0]!.driver.send).not.toHaveBeenCalled();
  expect(commits).toBe(0);
  expect((await h.runtime.getTasks(session.id)).every(task => task.status !== 'running')).toBe(true);
});

it('waits for an already-entered actor commit before allowing a replacement', async () => {
  const entered = deferred(), gate = deferred(); let actor = '';
  // Acceptance authorization passes; only the execution-phase commit is held.
  let accepted = false;
  const h = await fixture({ authorizeExecution: async () => { if (!accepted) { accepted = true; return; } return async () => { entered.resolve(); await gate.promise; actor = 'old'; }; } });
  const old = h.runtime.send(h.session.id, 'old').catch(error => error); await entered.promise;
  const stopping = h.runtime.stop(h.session.id); let stopped = false;
  void stopping.then(() => { stopped = true; });
  await vi.waitFor(() => expect((h.runtime as any).lifecycle(h.session.id).revoked).toBe(true));
  expect(stopped).toBe(false); expect(h.factory).toHaveBeenCalledTimes(1);
  gate.resolve(); await stopping; await old;
  expect(actor).toBe('old');
  await h.runtime.restart(h.session.id);
  expect(h.factory).toHaveBeenCalledTimes(2);
});

it('replaces runId on restart while preserving the Session model fields', async () => {
  const h = await fixture();
  h.runs[0]!.driver.setModel = vi.fn(async () => {});
  await h.runtime.setModel(h.session.id, 'preserved-model');
  await h.runtime.stop(h.session.id);
  const current = await h.runtime.restart(h.session.id);
  expect(current.runId).not.toBe(h.session.runId);
  expect((await h.runtime.getSession(h.session.id))?.state).toBe('idle');
  expect((await h.runtime.getSession(h.session.id))?.model).toBe('preserved-model');
});

it('rechecks physical evidence after a driver caches a rejected stop promise', async () => {
  const h = await fixture(); let exited = false;
  const failure = Promise.reject(new Error('timeout')); void failure.catch(() => {});
  h.runs[0]!.driver.stop = () => failure;
  h.runs[0]!.driver.isStopped = async () => exited;
  await expect(h.runtime.stop(h.session.id)).rejects.toMatchObject({ code: 'DRIVER_STOP_UNVERIFIED' });
  exited = true;
  await h.runtime.stop(h.session.id); await h.runtime.restart(h.session.id);
  expect(h.factory).toHaveBeenCalledTimes(2);
});

it('preserves native context on normal stop and resume', async () => {
  const h = await fixture(); let discarded = false;
  h.runs[0]!.driver.stop = async options => { discarded ||= options?.discardSession === true; };
  await h.runtime.stop(h.session.id); await h.runtime.resume(h.session.id);
  expect(discarded).toBe(false); expect(h.factory).toHaveBeenCalledTimes(2);
  expect((await h.runtime.getSession(h.session.id))?.state).toBe('idle');
});

it('shares the complete shutdown promise while physical cleanup is pending', async () => {
  const h = await fixture(); const entered = deferred(), gate = deferred();
  h.runs[0]!.driver.stop = async () => { entered.resolve(); await gate.promise; };
  const first = h.runtime.shutdown(); await entered.promise;
  const second = h.runtime.shutdown(); expect(second).toBe(first);
  let finished = false; void second.then(() => { finished = true; });
  await Promise.resolve(); expect(finished).toBe(false);
  gate.resolve(); await Promise.all([first, second]);
});

it.each([['shutdown', 'queued'], ['stop', 'cancelled']] as const)('keeps an unsubmitted checkpoint as suspended/cancelled without sending (%s)', async (operation, status) => {
  const entered = deferred(), gate = deferred();
  // Hold preparation at the execution authorization fence, before submission.
  let accepted = false;
  const h = await fixture({ authorizeExecution: async () => { if (!accepted) { accepted = true; return; } entered.resolve(); await gate.promise; } });
  h.runs[0]!.driver.checkpoint = () => ({ kind: 'pty-jsonl-v1', turnId: 'not-submitted', transcript: { offset: 0 } });
  // Attach catch immediately to observe rejection and avoid unhandled rejection during shutdown.
  let sendError: unknown;
  const sending = h.runtime.send(h.session.id, 'new prompt').catch(err => { sendError = err; return err; });
  try {
    await entered.promise;
    if (operation === 'shutdown') await h.runtime.shutdown(); else await h.runtime.stop(h.session.id, { kind: 'installation_owner', id: 'installation_owner' });
    const [task] = await h.runtime.getTasks(h.session.id);
    expect(task?.status).toBe(status);
    expect(h.runs[0]!.driver.send).not.toHaveBeenCalled();
  } finally { gate.resolve(); await sending; }
});

it('lets a newer archive revoke the restart tail after shared cleanup', async () => {
  const h = await fixture(); const entered = deferred(), gate = deferred();
  h.runs[0]!.driver.stop = async () => { entered.resolve(); await gate.promise; };
  const restart = h.runtime.restart(h.session.id).catch(error => error); await entered.promise;
  const archive = h.runtime.archive(h.session.id); gate.resolve();
  expect(await restart).toMatchObject({ code: 'OPERATION_REVOKED' });
  expect((await archive).archivedAt).toBeTruthy(); expect(h.factory).toHaveBeenCalledTimes(1);
});

it('replays an accepted queue task exactly once and runs it a single time', async () => {
  const h = await fixture();
  const envelope = { version: 1 as const, namespace: 'runtime' as const, sessionId: h.session.id, key: 'key', actor: { kind: 'installation_owner' as const, id: 'installation_owner' as const }, prompt: 'accepted', mode: 'queue' as const, skills: [], options: {}, sources: [], sourcePayload: {} };
  const accepted = await h.runtime.dispatch(h.session.id, 'accepted', 'queue', 'accepted', undefined, 'installation_owner', 'key', [], envelope);
  await h.runs[0]!.sent.promise;
  const replay = await h.runtime.dispatch(h.session.id, 'accepted', 'queue', 'accepted', undefined, 'installation_owner', 'key', [], envelope);
  expect(replay.replayed).toBe(true); expect(replay.id).toBe(accepted.id);
  h.runs[0]!.emit({ type: 'text', data: { text: 'answer' } });
  h.runs[0]!.emit({ type: 'completed', data: { stopReason: 'end_turn' } }); h.runs[0]!.done.resolve(undefined);
  await vi.waitFor(async () => expect((await h.runtime.getTasks(h.session.id))[0]?.status).toBe('completed'));
  expect(h.runs[0]!.driver.send).toHaveBeenCalledTimes(1);
});

it('cancels a durable queued task even if projection has not happened', async () => {
  const h = await fixture(); const entered = deferred(), gate = deferred();
  const rawListQueued = h.repos.tasks.listQueued!.bind(h.repos.tasks);
  let once = true;
  vi.spyOn(h.repos.tasks as unknown as { listQueued: typeof rawListQueued }, 'listQueued').mockImplementation(async (sessionId: string) => {
    if (once) { once = false; entered.resolve(); await gate.promise; }
    return rawListQueued(sessionId);
  });
  const accepting = h.runtime.dispatch(h.session.id, 'not projected').catch(error => error);
  await entered.promise;
  await h.runtime.stop(h.session.id, { kind: 'installation_owner', id: 'installation_owner' });
  gate.resolve(); await accepting;
  expect((await h.repos.tasks.listBySession(h.session.id)).find(t => t.prompt === 'not projected')?.status).toBe('cancelled');
  expect(h.runs[0]!.driver.send).not.toHaveBeenCalled();
});

it('keeps a completed task settled even when a subscriber notification throws', async () => {
  const h = await fixture(); const received: string[] = [];
  h.runtime.subscribe(h.session.id, () => { throw new Error('disconnected'); });
  h.runtime.subscribe(h.session.id, event => { received.push(event.type); });
  const run = h.runtime.send(h.session.id, 'task'); await h.runs[0]!.sent.promise;
  h.runs[0]!.emit({ type: 'text', data: { text: 'answer' } });
  h.runs[0]!.emit({ type: 'completed', data: { stopReason: 'end_turn' } }); h.runs[0]!.done.resolve(undefined);
  expect((await run).status).toBe('completed'); expect(received).toContain('completed');
});

it('does not start a thunk after revocation and observes already-started late rejection', async () => {
  const mutations = new SessionMutations(), token = owner('session'); const hook = vi.fn(async () => {});
  const late = deferred(); token.revoke();
  await expect(mutations.run(token, () => mutations.wait(hook))).rejects.toMatchObject({ code: 'OPERATION_REVOKED' });
  expect(hook).not.toHaveBeenCalled();
  await expect(mutations.run(token, () => mutations.wait(late.promise))).rejects.toMatchObject({ code: 'OPERATION_REVOKED' });
  late.reject(new Error('late rejection')); await Promise.resolve();
});

it.each([false, true])('returns the original idempotent task after stop/archive (archive: %s)', async archive => {
  const h = await fixture();
  const owner = { kind: 'installation_owner' as const, id: 'installation_owner' as const };
  const envelope = { version: 1 as const, namespace: 'runtime' as const, sessionId: h.session.id, key: 'delivery', actor: owner, prompt: 'original', mode: 'queue' as const, skills: [], options: {}, sources: [], sourcePayload: {} };
  const original = await h.runtime.dispatch(h.session.id, 'original', 'queue', 'original', undefined, 'installation_owner', 'delivery', [], envelope);
  await h.runs[0]!.sent.promise;
  if (archive) {
    // Settle Attempt 1 first so the Session has no unconfirmed attempts and can be archived cleanly.
    h.runs[0]!.emit({ type: 'text', data: { text: 'answer' } });
    h.runs[0]!.emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    h.runs[0]!.done.resolve(undefined);
    await vi.waitFor(async () => expect((await h.runtime.getTasks(h.session.id))[0]?.status).toBe('completed'));
    await h.runtime.archive(h.session.id, owner);
  } else {
    await h.runtime.stop(h.session.id, owner);
  }
  const replay = await h.runtime.dispatch(h.session.id, 'original', 'queue', 'original', undefined, 'installation_owner', 'delivery', [], envelope);
  expect(replay).toMatchObject({ id: original.id, replayed: true });
  await expect(h.runtime.dispatch(h.session.id, 'changed', 'queue', 'original', undefined, 'installation_owner', 'delivery', [], { ...envelope, prompt: 'changed' })).rejects.toMatchObject({ code: 'TASK_IDEMPOTENCY_CONFLICT' });
  expect(h.factory).toHaveBeenCalledTimes(1);
});

it('keeps the binding through physical teardown even when stop fact persistence fails', async () => {
  const h = await fixture(), driverRun = h.runs[0]!;
  const run = h.runtime.send(h.session.id, 'active').catch(error => error);
  await driverRun.sent.promise;
  const internal = h.runtime as unknown as { bound(): import('@dutydeck/shared').BoundExecutionRepository };
  const failure = new Error('stop fact failure');
  vi.spyOn(internal.bound(), 'markReconcileRequired').mockImplementation(() => { throw failure; });
  const entered = deferred(), gate = deferred(); let physical = false;
  driverRun.driver.stop = vi.fn(async () => { entered.resolve(); await gate.promise; driverRun.done.resolve(); physical = true; });
  driverRun.driver.isStopped = async () => physical;
  let stopped = false, shutDown = false;
  const stopping = h.runtime.stop(h.session.id).catch(error => error).then(result => { stopped = true; return result; });
  let shutdown: Promise<void> | undefined;
  try {
    await entered.promise;
    shutdown = h.runtime.shutdown().then(() => { shutDown = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stopped).toBe(false); expect(shutDown).toBe(false);
    expect(() => h.repos.close()).toThrow('DATABASE_RUNTIME_STILL_ATTACHED');
    gate.resolve();
    expect(await stopping).toBe(failure);
    await shutdown;
    expect(await run).toMatchObject({ code: 'RUNTIME_SHUTTING_DOWN' });
    expect(driverRun.driver.stop).toHaveBeenCalledOnce();
    expect(h.runtime.getDriver(h.session.id)).toBeUndefined();
  } finally { gate.resolve(); await Promise.allSettled([run, stopping, shutdown]); }
});

it('seals paused preparation before closing SQLite and observes its later rejection', async () => {
  const entered = deferred(), gate = deferred();
  const h = await fixture({ prepareTaskPrompt: async () => { entered.resolve(); await gate.promise; throw new Error('late preparation'); } });
  const run = h.runtime.send(h.session.id, 'old').catch(error => error); await entered.promise;
  await h.close();
  expect(await run).toMatchObject({ code: 'OPERATION_REVOKED' });
  gate.resolve(); await Promise.resolve(); await Promise.resolve();
});

it('restores promoted and successive front queue positions after SQLite is closed and reopened', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-owned-queue-')); const file = join(directory, 'queue.sqlite');
  const h = await fixture({}, file);
  vi.spyOn(h.runtime as any, 'scheduleQueue').mockImplementation(() => {});
  const env = (key: string, prompt: string, mode: 'queue' | 'interrupt' = 'queue') => ({ version: 1 as const, namespace: 'runtime' as const, sessionId: h.session.id, key, actor: { kind: 'installation_owner' as const, id: 'installation_owner' as const }, prompt, mode, skills: [] as string[], options: {}, sources: [] as never[], sourcePayload: {} });
  const a = await h.runtime.dispatch(h.session.id, 'A', 'queue', 'A', undefined, 'installation_owner', 'A', [], env('A', 'A'));
  await h.runtime.dispatch(h.session.id, 'B', 'queue', 'B', undefined, 'installation_owner', 'B', [], env('B', 'B'));
  const c = await h.runtime.dispatch(h.session.id, 'C', 'queue', 'C', undefined, 'installation_owner', 'C', [], env('C', 'C'));
  const before = c.createdAt;
  await h.runtime.steerQueued(h.session.id, c.id, 'installation_owner');
  await h.runtime.dispatch(h.session.id, 'D', 'interrupt', 'D', undefined, 'installation_owner', 'D', [], env('D', 'D', 'interrupt'));
  await h.runtime.dispatch(h.session.id, 'E', 'interrupt', 'E', undefined, 'installation_owner', 'E', [], env('E', 'E', 'interrupt'));
  // An exact redelivery of C (same immutable request) replays the stored Task.
  const replay = await h.runtime.dispatch(h.session.id, 'C', 'queue', 'C', undefined, 'installation_owner', 'C', [], env('C', 'C'));
  expect(replay.replayed).toBe(true);
  expect(replay.createdAt).toBe(before); expect(a.createdAt).toBeTruthy();
  expect((await h.repos.tasks.listQueued!(h.session.id)).map(t => t.prompt)).toEqual(['E', 'D', 'C', 'A', 'B']);
  await h.close();
  const repos = createRepositories(file, { newDatabaseAuthority: 'ledger_v1' }); const submitted: string[] = [];
  const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0, driverFactory: (_a, _p, emit) => ({
    start: async () => {}, resume: async () => {}, interrupt: async () => {}, stop: async () => {}, isStopped: async () => true,
    send: async (prompt: string | { prompt: string }) => { submitted.push(typeof prompt === 'string' ? prompt : prompt.prompt); emit({ type: 'text', data: { text: 'answer' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); }
  }) });
  try {
    await runtime.initialize([agent]);
    await vi.waitFor(async () => expect((await runtime.getTasks(h.session.id)).every(task => task.status === 'completed')).toBe(true));
    expect(submitted).toEqual(['E', 'D', 'C', 'A', 'B']);
  } finally { await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true }); }
});

it('commits each acceptance and execution authority and waits for WorkItem admission before birth', async () => {
  const phases: string[] = []; let next = 0;
  const h = await fixture({
    authorizeExecution: async () => {
      const call = ++next; phases.push(`prepare:${call}`);
      return async () => { phases.push(`commit:${call}`); };
    },
    authorizeTask: async (_s, _t, phase) => { phases.push(`task:${phase}`); }
  });
  const stableId = 'ses_work_' + 'b'.repeat(64);
  const entered = deferred(), gate = deferred();
  const workItemSession = h.runtime.startWorkItemSession(
    { source: 'work_item', sourceId: 'work-item-1', agentId: agent.id },
    stableId,
    async () => { entered.resolve(); await gate.promise; }
  );
  try {
    await entered.promise;
    expect(await h.repos.sessions.get(stableId)).toBeUndefined();
    expect(h.factory).toHaveBeenCalledTimes(1);
    gate.resolve();
    expect((await workItemSession).id).toBe(stableId);
    expect(h.factory).toHaveBeenCalledTimes(2);
    const send = h.runs[0]!.driver.send.bind(h.runs[0]!.driver);
    h.runs[0]!.driver.send = vi.fn(async input => { phases.push('send'); await send(input); });
    await h.runtime.dispatch(h.session.id, 'work');
    await h.runs[0]!.sent.promise;
    expect(phases).toEqual(['prepare:1', 'commit:1', 'prepare:2', 'commit:2', 'task:prepare', 'prepare:3', 'commit:3', 'task:submit', 'send']);
  } finally { gate.resolve(); await workItemSession; }
});

it('rejects a raw session source mutation outside the bound ledger', async () => {
  const h = await fixture();
  await expect(h.repos.sessions.save({ ...h.session, source: 'work_item', sourceId: 'work-item' })).rejects.toMatchObject({ code: /EXECUTION_LEDGER_REQUIRED|REQUIRES/ });
});

it('clears a held permission on stop and never submits a stale approval after it', async () => {
  const h = await fixture(); h.runs[0]!.driver.resolvePermission = vi.fn(async () => true);
  const run = h.runtime.send(h.session.id, 'permission').catch(error => error); await h.runs[0]!.sent.promise;
  h.runs[0]!.emit({ type: 'permission_request', data: { id: 'pending', title: 'Write?', status: 'pending' } });
  await vi.waitFor(() => expect(h.runtime.getPendingPermissions(h.session.id)).toHaveLength(1));
  await h.runtime.stop(h.session.id); await run;
  // The held permission is dropped from the active set and resolving it after
  // stop cannot reach the driver.
  expect(h.runtime.getPendingPermissions(h.session.id)).toEqual([]);
  await expect(h.runtime.resolvePermission(h.session.id, 'pending', true)).rejects.toBeDefined();
  expect(h.runs[0]!.driver.resolvePermission).not.toHaveBeenCalled();
});

it('drains registered task continuations when a separate cleanup makes shutdown reject', async () => {
  const h = await fixture();
  const entered = deferred(), gate = deferred();
  const internal = h.runtime as unknown as {
    executeTask(id: string, task: import('@dutydeck/shared').TaskRecord): Promise<import('@dutydeck/shared').PublicTaskRecord>;
    cleanupRun?: Promise<void>;
  };
  const execute = internal.executeTask.bind(h.runtime);
  internal.executeTask = async (id, task) => {
    const result = await execute(id, task);
    entered.resolve(); await gate.promise;
    return result;
  };
  const run = h.runtime.send(h.session.id, 'old').catch(error => error);
  await h.runs[0]!.sent.promise;
  const failure = new Error('cleanup failed');
  const failedCleanup = Promise.reject(failure); void failedCleanup.catch(() => {});
  internal.cleanupRun = failedCleanup;
  let stopped = false;
  const stopping = h.runtime.shutdown().catch(error => error).then(result => { stopped = true; return result; });
  try {
    await entered.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stopped).toBe(false);
    expect(() => h.repos.close()).toThrow('DATABASE_RUNTIME_STILL_ATTACHED');
    gate.resolve();
    expect(await stopping).toBe(failure);
    expect(await run).toMatchObject({ code: 'RUNTIME_SHUTTING_DOWN' });
    await expect(h.close()).rejects.toBe(failure);
  } finally { gate.resolve(); await Promise.allSettled([run, stopping]); }
});

it('blocks replacement when the resource probe returns false', async () => {
  const h = await fixture();
  h.runs[0]!.driver.isStopped = async () => false;
  await expect(h.runtime.stop(h.session.id)).rejects.toMatchObject({ code: 'DRIVER_STOP_UNVERIFIED' });
  expect(h.runtime.getDriverStopBlock(h.session.id)).toBeTruthy();
  await expect(h.runtime.restart(h.session.id)).rejects.toMatchObject({ code: 'DRIVER_STOP_UNVERIFIED' });
  expect(h.factory).toHaveBeenCalledTimes(1);
});

it('surfaces a throwing resource probe and leaves a stop block preventing replacement', async () => {
  const h = await fixture();
  h.runs[0]!.driver.isStopped = async () => { throw new Error('probe unavailable'); };
  await expect(h.runtime.stop(h.session.id)).rejects.toThrow('probe unavailable');
  // Replacement is gated by the persisted stop block and never builds a driver.
  await expect(h.runtime.restart(h.session.id)).rejects.toThrow();
  expect(h.factory).toHaveBeenCalledTimes(1);
});

it('rejects a second configuration RPC while one is still awaiting confirmation', async () => {
  const h = await fixture(); const entered = deferred(), gate = deferred();
  h.runs[0]!.driver.setModel = vi.fn(async () => { entered.resolve(); await gate.promise; });
  h.runs[0]!.driver.setReasoningEffort = vi.fn(async () => {});
  const model = h.runtime.setModel(h.session.id, 'model-b'); await entered.promise;
  // Concurrent configuration changes are no longer merged; they are gated.
  await expect(h.runtime.setReasoningEffort(h.session.id, 'high')).rejects.toMatchObject({ code: 'DRIVER_CONFIGURATION_BUSY' });
  gate.resolve(); await model;
  expect(h.runs[0]!.driver.setReasoningEffort).not.toHaveBeenCalled();
});

it('retains unverified resource identity across SQLite reopen without calling a new factory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-stop-block-')); const file = join(directory, 'runtime.sqlite');
  const first = await fixture({}, file); delete first.runs[0]!.driver.isStopped;
  await expect(first.runtime.stop(first.session.id)).rejects.toMatchObject({ code: 'DRIVER_STOP_UNVERIFIED' });
  const persisted = JSON.parse((await first.repos.config.get('runtime_driver_stop_block:' + first.session.id))!);
  expect(persisted).toMatchObject({ sessionId: first.session.id, runId: first.session.runId });
  await first.close();
  const repos = createRepositories(file, { newDatabaseAuthority: 'ledger_v1' }); const factory = vi.fn(() => first.runs[0]!.driver);
  const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0, driverFactory: factory });
  try {
    await runtime.initialize([agent]);
    expect(runtime.getDriverStopBlock(first.session.id)).toBeTruthy();
    // On reopen the persisted stop block is surfaced as a resource blocker;
    // neither stop nor restart can attach a new driver.
    await expect(runtime.stop(first.session.id)).rejects.toMatchObject({ code: 'SESSION_RESOURCE_BLOCKED' });
    await expect(runtime.restart(first.session.id)).rejects.toMatchObject({ code: 'SESSION_RESOURCE_BLOCKED' });
    expect(factory).not.toHaveBeenCalled();
    expect(await repos.config.get('runtime_driver_stop_block:' + first.session.id)).toBeTruthy();
  } finally { await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true }); }
});

it('does not let a paused capability lookup interrupt a replacement lifecycle', async () => {
  const h = await fixture(); await h.repos.agents.save({ ...agent, capabilities: { pause: true, resume: true } });
  const entered = deferred(), gate = deferred(); const get = h.repos.agents.get.bind(h.repos.agents); let once = true;
  h.repos.agents.get = async id => { const result = await get(id); if (once) { once = false; entered.resolve(); await gate.promise; } return result; };
  const pause = h.runtime.pause(h.session.id).catch(error => error); await entered.promise;
  await h.runtime.stop(h.session.id); await h.runtime.restart(h.session.id);
  const interrupt = vi.fn(async () => {}); h.runs[1]!.driver.interrupt = interrupt;
  gate.resolve(); await pause;
  expect(interrupt).not.toHaveBeenCalled();
  expect((await h.runtime.getSession(h.session.id))?.state).toBe('idle');
});

it('does not inherit another session owner through a nested policy refresh', async () => {
  const entered = deferred(), gate = deferred(); let target = '', refresh: Promise<unknown> | undefined;
  let runtime!: DutydeckRuntime;
  const h = await fixture({
    authorizeExecution: async id => {
      if (target && id !== target) {
        refresh = runtime.setRiskPolicy(target, { enabled: false, authorized: false, pattern: '' }).catch(e => e);
      }
    },
    resolveRiskPolicy: async (id, fallback) => {
      if (id === target) {
        entered.resolve();
        await gate.promise;
      }
      return fallback;
    }
  });
  runtime = h.runtime;
  target = (await runtime.start({ agentId: agent.id })).id;
  const applied = vi.fn();
  await vi.waitFor(() => expect(h.runs).toHaveLength(2));
  h.runs[1]!.driver.setRiskPolicy = applied;
  const old = runtime.send(h.session.id, 'old').catch(e => e);
  await entered.promise;
  await runtime.stop(h.session.id, { kind: 'installation_owner', id: 'installation_owner' });
  await old;
  gate.resolve();
  await refresh;
  expect(applied).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  expect((await runtime.getSession(target))?.state).toBe('idle');
});

it('does not let the delivery of an old promotion stop a new task', async () => {
  const h = await fixture();
  const secondEntered = deferred(), secondTail = deferred();
  const driver = h.runs[0]!.driver;
  const originalSend = driver.send.bind(driver);
  driver.interrupt = vi.fn(async () => {});
  driver.send = vi.fn(async input => {
    if (input === 'old') return originalSend(input);
    secondEntered.resolve(); await secondTail.promise;
    h.runs[0]!.emit({ type: 'text', data: { text: 'second answer' } });
    h.runs[0]!.emit({ type: 'completed', data: { stopReason: 'end_turn' } });
  });
  const old = h.runtime.send(h.session.id, 'old');
  await h.runs[0]!.sent.promise;
  const queued = await h.runtime.dispatch(h.session.id, 'queued');
  const entered = deferred(), gate = deferred();
  const internal = h.runtime as unknown as { applyQueueActions(session: import('@dutydeck/shared').Session): Promise<void>; bound(): import('@dutydeck/shared').BoundExecutionRepository; fence(session: import('@dutydeck/shared').Session): import('@dutydeck/shared').SessionFence };
  const deliver = internal.applyQueueActions.bind(h.runtime);
  let paused = true, firstDelivery = true;
  internal.applyQueueActions = async session => {
    if (paused) {
      // Withhold this pending action's first delivery; other queue drains can
      // continue without delivering it while the original invocation is held.
      if (!firstDelivery) return;
      firstDelivery = false; entered.resolve(); await gate.promise;
    }
    await deliver(session);
  };
  const operationId = 'first-late-promotion';
  const steering = h.runtime.steerQueued(h.session.id, queued.id, 'installation_owner', undefined, operationId);
  try {
    await entered.promise;
    const action = internal.bound().getPendingQueueActions(internal.fence(h.session)).find(item => item.operationId === operationId)!;
    const originalAttempt = h.repos.execution.getTaskExecution(action.target!.taskId)!.currentAttempt!;
    expect(action.target).toMatchObject({ taskId: originalAttempt.taskId, attemptId: originalAttempt.attemptId });
    h.runs[0]!.emit({ type: 'text', data: { text: 'answer' } });
    h.runs[0]!.emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    h.runs[0]!.done.resolve();
    expect((await old).status).toBe('completed');
    await secondEntered.promise;
    const active = h.repos.execution.getTaskExecution(queued.id)!.currentAttempt!;
    expect(active).toMatchObject({ state: 'active', submissionState: 'intent_recorded' });
    expect(driver.send).toHaveBeenCalledTimes(2);
    expect(internal.bound().getPendingQueueActions(internal.fence(h.session)).find(item => item.operationId === operationId)?.target).toEqual(action.target);
    paused = false; gate.resolve(); await steering;
    expect(h.repos.execution.getTaskExecution(queued.id)!.currentAttempt).toEqual(active);
    expect(driver.interrupt).not.toHaveBeenCalled();
    secondTail.resolve();
    await vi.waitFor(() => expect(h.repos.execution.getTaskExecution(queued.id)!.task.status).toBe('completed'));
    expect(h.repos.execution.getTaskExecution(originalAttempt.taskId)!.currentAttempt!.state).toBe('settled');
  } finally { paused = false; gate.resolve(); secondTail.resolve(); await Promise.allSettled([old, steering]); }
});
