import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { installationOwnerTaskActor, type StartSessionInput, type AgentEvent, type Session, type TaskRequestV1, type TaskRecord } from '@dutydeck/shared';
import { LarkMemoryStore } from './memory.js';
import { LarkMemoryPipeline, type LarkMemoryPipelineRuntime } from './memory-pipeline.js';

const cleanups: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); cleanups.splice(0).forEach(close => close()); });
const scope = { appId: 'app_memory', chatId: 'chat_memory', pool: 'chat_memory' };

async function harness(status = 'running', timeoutMs = 30, options: { archive?: boolean; now?: () => Date; staleRunningMs?: number } = {}) {
  const repos = createRepositories(':memory:');
  cleanups.push(() => repos.close());
  const store = new LarkMemoryStore(repos.config);
  await store.add(scope, { content: '回复使用中文', topic: 'preferences', source: 'user' });
  const memorySession = (id: string, createdAt: string) => ({ id, agentId: 'agent', state: 'idle', permissionMode: 'deny-all',
    cwd: '/memory', protocol: 'acp', source: 'lark-memory', sourceId: `${scope.appId}:${scope.pool}:memory`, createdAt }) as Session;
  const session = memorySession('session_memory', '2026-09-20T00:00:00.000Z');
  const fresh = memorySession('session_fresh', '2026-09-25T00:00:00.000Z');
  const sessions: Session[] = [session];
  const tasksBySession = new Map<string, TaskRecord[]>([[session.id, []]]);
  const tasksOf = (id: string) => tasksBySession.get(id) ?? [];
  let listener: ((event: AgentEvent) => void) | undefined;
  const task = (state: string, id = 'task_memory', sessionId = session.id) => ({ id, sessionId, status: state, revision: 3,
    prompt: 'memory consolidation', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as TaskRecord);
  const runtime = {
    start: vi.fn(),
    resolveMemorySessionInput: vi.fn(async (input: StartSessionInput) => ({ ...input, protocol: 'acp', permissionMode: 'deny-all' })),
    startMemorySession: vi.fn(async (_input: StartSessionInput, id: string, beforeStart: () => Promise<void>) => {
      await beforeStart();
      fresh.id = id; sessions.push(fresh); tasksBySession.set(id, []); return fresh;
    }),
    lookupAcceptedTask: vi.fn(() => undefined),
    listAgents: vi.fn(async () => [{ id: 'agent' }]), listSessions: vi.fn(async () => sessions.map(item => ({ ...item }))),
    getTasks: vi.fn(async (id: string) => tasksOf(id)),
    getTaskRecovery: vi.fn(async (id: string, taskId: string) => ({ status: tasksOf(id).find(item => item.id === taskId)!.status, blockers: [] as Array<{ code: string }>, resolvedUnknown: false })),
    dispatch: vi.fn(),
    dispatchRequest: vi.fn(async (request: TaskRequestV1) => {
      const id = request.sessionId;
      const current = task(status, 'task_memory', id); tasksBySession.set(id, [...tasksOf(id), current]);
      listener?.({ type: 'task', data: { task: current } } as AgentEvent);
      return { id: current.id, status: 'queued' };
    }),
    cancelQueued: vi.fn(async (id: string) => { tasksBySession.set(id, [task('cancelled', 'task_memory', id)]); }),
    interrupt: vi.fn(async () => ({ interrupted: false })),
    subscribe: vi.fn((_id: string, receive: (event: AgentEvent) => void) => { listener = receive; return () => { listener = undefined; }; }),
    ...(options.archive === false ? {} : { archive: vi.fn(async (id: string) => { sessions.find(item => item.id === id)!.archivedAt = '2026-09-25T00:00:01.000Z'; }) })
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const pipelineOptions = { runtime: runtime as unknown as LarkMemoryPipelineRuntime,
    controlActorId: installationOwnerTaskActor, repos, store, jobs: repos.memoryJobs, policyConfig: repos.config,
    projection: { write: vi.fn(), writeVerified: vi.fn(async () => true), directoryFor: () => '/memory' } as any,
    readConfig: async () => ({ appId: scope.appId, defaultAgentId: 'agent', memoryEnabled: true }) as any, log, timeoutMs, now: options.now, staleRunningMs: options.staleRunningMs };
  const pipeline = new LarkMemoryPipeline(pipelineOptions);
  return {
    pipeline, pipelineOptions, runtime, session, fresh, task, store, log,
    setTasks: (next: TaskRecord[], sessionId = session.id) => { tasksBySession.set(sessionId, next); },
    tasks: (sessionId = session.id) => tasksOf(sessionId)
  };
}

describe('memory recovery and timeout boundaries', () => {
  it.each(['dispatch', 'interrupt'] as const)('unsubscribes on timeout while %s is pending and still cleans up the late task', async phase => {
    const h = await harness(phase === 'dispatch' ? 'queued' : 'running');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const unsubscribe = vi.fn();
    h.runtime.subscribe.mockReturnValue(unsubscribe);
    if (phase === 'dispatch') {
      h.runtime.dispatchRequest.mockImplementation(async () => {
        await gate;
        h.setTasks([h.task('queued')]);
        return { id: 'task_memory', status: 'queued' };
      });
    } else {
      h.runtime.interrupt.mockImplementation(async () => {
        await gate;
        h.setTasks([h.task('interrupted')]);
        return { interrupted: true };
      });
    }
    try {
      expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ error: 'MEMORY_RUN_TIMEOUT' });
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect((await h.store.getState(scope)).running?.token).toBeTruthy();
      expect(await h.pipeline.requestConsolidation(scope)).toBe('running');
      // An already queued callback can still arrive after unsubscribe; it must not be buffered or read.
      const readEvent = vi.fn(() => 'task');
      const late = { get type() { return readEvent(); } } as AgentEvent;
      const receive = h.runtime.subscribe.mock.calls[0]![1];
      for (let index = 0; index < 10; index++) receive(late);
      release();
      await vi.waitFor(async () => expect((await h.store.getState(scope)).running).toBeUndefined());
      expect(readEvent).not.toHaveBeenCalled();
      expect(unsubscribe).toHaveBeenCalledOnce();
      if (phase === 'dispatch') {
        expect(h.runtime.cancelQueued).toHaveBeenCalledWith(h.session.id, 'task_memory', installationOwnerTaskActor, 3);
        expect(h.runtime.interrupt).not.toHaveBeenCalled();
      } else {
        expect(h.runtime.interrupt).toHaveBeenCalledExactlyOnceWith(h.session.id, 'task_memory', installationOwnerTaskActor);
        expect(h.runtime.cancelQueued).not.toHaveBeenCalled();
      }
    } finally {
      release();
      await vi.waitFor(async () => expect((await h.store.getState(scope)).running).toBeUndefined());
    }
  });

  it.each(['startup', 'preparation'] as const)('bounds pending %s and keeps its live claim until late cleanup', async phase => {
    let now = Date.now();
    const h = await harness('failed', 30, { now: () => new Date(now), staleRunningMs: 50 });
    h.session.state = 'stopped';
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    if (phase === 'startup') h.runtime.startMemorySession.mockImplementation(async (_input, id, beforeStart) => { await gate; await beforeStart(); h.fresh.id = id; return h.fresh; });
    else h.pipelineOptions.projection.write.mockImplementation(async () => { await gate; });
    const started = Date.now();
    expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ error: 'MEMORY_RUN_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect((await h.store.getState(scope)).running?.token).toBeTruthy();
    now += 60_000;
    const second = new LarkMemoryPipeline(h.pipelineOptions);
    expect(await second.requestConsolidation(scope)).toBe('running');
    release();
    await vi.waitFor(async () => expect((await h.store.getState(scope)).running).toBeUndefined());
    expect(h.runtime.dispatchRequest).not.toHaveBeenCalled();
    expect(h.runtime.archive).not.toHaveBeenCalled();
    if (phase === 'preparation') expect(h.runtime.startMemorySession).not.toHaveBeenCalled();
    expect(await h.store.list(scope)).toHaveLength(1);
  });

  it('bounds pending dispatch, retains ownership, and cancels only the late accepted task', async () => {
    const h = await harness('queued');
    let release!: () => void;
    h.runtime.dispatchRequest.mockImplementation(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      h.setTasks([h.task('queued')]);
      return { id: 'task_memory', status: 'queued' };
    });
    expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ error: 'MEMORY_RUN_TIMEOUT' });
    expect((await h.store.getState(scope)).running?.token).toBeTruthy();
    expect(await h.pipeline.requestConsolidation(scope)).toBe('running');
    release();
    await vi.waitFor(async () => expect((await h.store.getState(scope)).running).toBeUndefined());
    expect(h.runtime.cancelQueued).toHaveBeenCalledWith(h.session.id, 'task_memory', installationOwnerTaskActor, 3);
    expect(h.runtime.dispatchRequest).toHaveBeenCalledOnce();
    expect(h.runtime.interrupt).not.toHaveBeenCalled();
    expect(await h.store.list(scope)).toHaveLength(1);
  });

  it('does not release or overwrite another claim when an old operation finishes', async () => {
    const h = await harness('failed', 1000);
    let release!: () => void;
    h.runtime.dispatchRequest.mockImplementation(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return { id: 'task_memory', status: 'failed' };
    });
    const run = h.pipeline.runConsolidation(scope);
    await vi.waitFor(() => expect(h.runtime.dispatchRequest).toHaveBeenCalledOnce());
    const before = await h.store.getState(scope);
    await h.store.updateState(scope, { running: { ...before.running!, token: 'new-claim' } });
    release();
    await expect(run).rejects.toMatchObject({ code: 'MEMORY_CLAIM_LOST' });
    expect((await h.store.getState(scope)).running?.token).toBe('new-claim');
    expect((await h.store.getState(scope)).lastRun).toBe(before.lastRun);
    expect(await h.store.list(scope)).toHaveLength(1);
  });

  it.each(['reconcile_required', 'legacy_unresolved'])('ends immediately on %s without cancelling or interrupting the unknown turn', async status => {
    const h = await harness(status, 600_000);
    await expect(h.pipeline.runConsolidation(scope)).resolves.toMatchObject({ ok: false, error: 'MEMORY_RECOVERY_REQUIRED' });
    expect(h.runtime.interrupt).not.toHaveBeenCalled();
    expect(h.runtime.cancelQueued).not.toHaveBeenCalled();
    expect(h.tasks()[0]?.status).toBe(status);
    expect((await h.store.getState(scope)).running).toBeUndefined();
  });

  // The retired path archived unknown sessions and replaced them. Persistent jobs must
  // instead reconcile every prior execution before freezing a new job.
  it.each(['reconcile_required', 'legacy_unresolved', 'queued', 'running'])('blocks a new job while an old %s task is unresolved', async status => {
    const h = await harness('failed'); h.setTasks([h.task(status, 'task_stuck')]);
    expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ error: 'MEMORY_RECOVERY_REQUIRED' });
    expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ error: 'MEMORY_RECOVERY_REQUIRED' });
    expect(h.runtime.archive).not.toHaveBeenCalled();
    expect(h.runtime.startMemorySession).not.toHaveBeenCalled();
    expect(h.runtime.dispatchRequest).not.toHaveBeenCalled();
    expect(await h.pipelineOptions.jobs.listScope(scope)).toEqual([]);
    expect(h.tasks()).toEqual([expect.objectContaining({ id: 'task_stuck', status })]);
    expect(h.runtime.cancelQueued).not.toHaveBeenCalled();
    expect(h.runtime.interrupt).not.toHaveBeenCalled();
  });

  it('blocks a completed old task with unresolved resources without replacing its session', async () => {
    const h = await harness('failed'); h.setTasks([h.task('completed')]);
    h.runtime.getTaskRecovery.mockResolvedValue({ status: 'completed', blockers: [{ code: 'DRIVER_STOP_BLOCKED' }], resolvedUnknown: false });
    expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ error: 'MEMORY_RECOVERY_REQUIRED' });
    expect(h.runtime.archive).not.toHaveBeenCalled();
    expect(h.runtime.startMemorySession).not.toHaveBeenCalled();
    expect(h.runtime.dispatchRequest).not.toHaveBeenCalled();
    expect(await h.pipelineOptions.jobs.listScope(scope)).toEqual([]);
  });

  it('does not use archive availability to bypass an unknown execution', async () => {
    const h = await harness('failed', 30, { archive: false }); h.setTasks([h.task('reconcile_required')]);
    expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ error: 'MEMORY_RECOVERY_REQUIRED' });
    expect(h.runtime.dispatchRequest).not.toHaveBeenCalled();
    expect(h.runtime.startMemorySession).not.toHaveBeenCalled();
  });

  it('allows reuse after confirmed recovery with unknown old output, but never treats that output as memory completion', async () => {
    const h = await harness('reconcile_required'); h.setTasks([h.task('reconcile_required', 'old')]);
    h.runtime.getTaskRecovery.mockResolvedValue({ status: 'reconcile_required', blockers: [], resolvedUnknown: true });
    expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ error: 'MEMORY_RECOVERY_REQUIRED' });
    expect(h.runtime.dispatchRequest).toHaveBeenCalledOnce();
    expect(h.runtime.archive).not.toHaveBeenCalled();
    expect((await h.store.list(scope))).toHaveLength(1);
  });

  it('cancels only the exact queued request with the injected actor and revision on timeout', async () => {
    const h = await harness('queued');
    expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ error: 'MEMORY_RUN_TIMEOUT' });
    expect(h.runtime.cancelQueued).toHaveBeenCalledWith(h.session.id, 'task_memory', installationOwnerTaskActor, 3);
    expect(h.runtime.interrupt).not.toHaveBeenCalled();
    expect(h.tasks()[0]?.status).toBe('cancelled');
  });

  it('does not interrupt a claimed task or the next task when queue cancellation loses its revision race', async () => {
    const h = await harness('queued');
    h.runtime.cancelQueued.mockImplementation(async () => { h.setTasks([h.task('running')]); throw new Error('TASK_REVISION_CONFLICT'); });
    expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ error: 'MEMORY_RECOVERY_REQUIRED' });
    expect(h.runtime.interrupt).not.toHaveBeenCalled(); expect(h.tasks()[0]?.status).toBe('running');
  });

  it.each([false, true])('does not report a stop solely from interrupt response %s', async interrupted => {
    const h = await harness(); h.runtime.interrupt.mockResolvedValue({ interrupted });
    expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ error: 'MEMORY_RECOVERY_REQUIRED' });
    expect(h.tasks()[0]?.status).toBe('running');
    expect(h.runtime.interrupt).toHaveBeenCalledWith(h.session.id, 'task_memory', installationOwnerTaskActor);
  });

  it('reports a confirmed stopped timeout only after reading the actual terminal state', async () => {
    const h = await harness();
    h.runtime.interrupt.mockImplementation(async () => { h.setTasks([h.task('interrupted')]); return { interrupted: true }; });
    expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ error: 'MEMORY_RUN_TIMEOUT' });
    expect(h.tasks()[0]?.status).toBe('interrupted');
  });

  it('fails closed before dispatch when recovery inspection is unavailable', async () => {
    const h = await harness(); (h.runtime as any).getTaskRecovery = undefined;
    expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ error: 'MEMORY_RECOVERY_REQUIRED' });
    expect(h.runtime.dispatchRequest).not.toHaveBeenCalled();
    expect(h.runtime.start).not.toHaveBeenCalled();
    expect(h.runtime.archive).not.toHaveBeenCalled();
  });
});
