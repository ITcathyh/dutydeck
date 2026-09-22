import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { installationOwnerTaskActor, type AgentEvent, type Session, type TaskRecord } from '@dutydeck/shared';
import { LarkMemoryStore } from './memory.js';
import { LarkMemoryPipeline, type LarkMemoryPipelineRuntime } from './memory-pipeline.js';

const cleanups: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); cleanups.splice(0).forEach(close => close()); });
const scope = { appId: 'app_memory', chatId: 'chat_memory' };

async function harness(status = 'running', timeoutMs = 30) {
  const repos = createRepositories(':memory:');
  cleanups.push(() => repos.close());
  const store = new LarkMemoryStore(repos.config);
  await store.add(scope, { content: '回复使用中文', topic: 'preferences', source: 'user' });
  const session = { id: 'session_memory', agentId: 'agent', state: 'idle', permissionMode: 'deny-all',
    source: 'lark-memory', sourceId: `${scope.appId}:${scope.chatId}:memory` } as Session;
  let tasks: TaskRecord[] = [];
  let listener: ((event: AgentEvent) => void) | undefined;
  const task = (state: string, id = 'task_memory') => ({ id, sessionId: session.id, status: state, revision: 3,
    prompt: 'memory consolidation', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as TaskRecord);
  const runtime = {
    start: vi.fn(async () => session), listAgents: vi.fn(async () => [{ id: 'agent' }]), listSessions: vi.fn(async () => [session]),
    getTasks: vi.fn(async () => tasks),
    getTaskRecovery: vi.fn(async (_sessionId: string, id: string) => ({ status: tasks.find(item => item.id === id)!.status, blockers: [] as Array<{ code: string }>, resolvedUnknown: false })),
    dispatch: vi.fn(async () => {
      const current = task(status); tasks.push(current);
      listener?.({ type: 'task', data: { task: current } } as AgentEvent);
      return { id: current.id, status: 'queued' };
    }),
    cancelQueued: vi.fn(async () => { tasks[0] = task('cancelled'); }),
    interrupt: vi.fn(async () => ({ interrupted: false })),
    subscribe: vi.fn((_id: string, receive: (event: AgentEvent) => void) => { listener = receive; return () => { listener = undefined; }; })
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const pipeline = new LarkMemoryPipeline({ runtime: runtime as unknown as LarkMemoryPipelineRuntime,
    controlActorId: installationOwnerTaskActor, repos, store,
    projection: { write: vi.fn(), directoryFor: () => '/memory' } as any,
    readConfig: async () => ({ appId: scope.appId, defaultAgentId: 'agent', memoryEnabled: true }) as any, log, timeoutMs });
  return { pipeline, runtime, session, task, store, log, setTasks: (next: TaskRecord[]) => { tasks = next; }, tasks: () => tasks };
}

describe('memory recovery and timeout boundaries', () => {
  it.each(['reconcile_required', 'legacy_unresolved'])('ends immediately on %s without cancelling or interrupting the unknown turn', async status => {
    const h = await harness(status, 600_000);
    await expect(h.pipeline.runConsolidation(scope)).resolves.toMatchObject({ ok: false, error: 'MEMORY_RECOVERY_REQUIRED' });
    expect(h.runtime.interrupt).not.toHaveBeenCalled();
    expect(h.runtime.cancelQueued).not.toHaveBeenCalled();
    expect(h.tasks()[0]?.status).toBe(status);
    expect((await h.store.getState(scope)).running).toBeUndefined();
  });

  it.each(['reconcile_required', 'queued', 'running'])('does not accumulate another request behind an existing %s task', async status => {
    const h = await harness(); h.setTasks([h.task(status)]);
    await expect(h.pipeline.runConsolidation(scope)).resolves.toMatchObject({ error: 'MEMORY_RECOVERY_REQUIRED' });
    await expect(h.pipeline.runConsolidation(scope)).resolves.toMatchObject({ error: 'MEMORY_RECOVERY_REQUIRED' });
    expect(h.runtime.dispatch).not.toHaveBeenCalled();
    expect(h.runtime.start).not.toHaveBeenCalled();
  });

  it('refuses reuse of idle memory sessions with blocked resources and does not start an alternative session', async () => {
    const h = await harness(); h.setTasks([h.task('completed')]);
    h.runtime.getTaskRecovery.mockResolvedValue({ status: 'completed', blockers: [{ code: 'DRIVER_STOP_BLOCKED' }], resolvedUnknown: false });
    expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ error: 'MEMORY_RECOVERY_REQUIRED' });
    expect(h.runtime.dispatch).not.toHaveBeenCalled(); expect(h.runtime.start).not.toHaveBeenCalled();
  });

  it('allows reuse after confirmed recovery with unknown old output, but never treats that output as memory completion', async () => {
    const h = await harness('reconcile_required'); h.setTasks([h.task('reconcile_required', 'old')]);
    h.runtime.getTaskRecovery.mockResolvedValue({ status: 'reconcile_required', blockers: [], resolvedUnknown: true });
    expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ error: 'MEMORY_RECOVERY_REQUIRED' });
    expect(h.runtime.dispatch).toHaveBeenCalledOnce();
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
    expect(h.runtime.dispatch).not.toHaveBeenCalled();
  });
});
