import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { installationOwnerTaskActor, type AgentEvent, type Session, type TaskRecord } from '@dutydeck/shared';
import { LarkMemoryStore } from './memory.js';
import { LarkMemoryPipeline, type LarkMemoryPipelineRuntime } from './memory-pipeline.js';

const cleanups: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); cleanups.splice(0).forEach(close => close()); });
const scope = { appId: 'app_memory', chatId: 'chat_memory', pool: 'chat_memory' };
const owner = { kind: 'installation_owner', id: 'installation_owner' };

async function harness(status = 'running', timeoutMs = 30, options: { archive?: boolean } = {}) {
  const repos = createRepositories(':memory:');
  cleanups.push(() => repos.close());
  const store = new LarkMemoryStore(repos.config);
  await store.add(scope, { content: '回复使用中文', topic: 'preferences', source: 'user' });
  const memorySession = (id: string, createdAt: string) => ({ id, agentId: 'agent', state: 'idle', permissionMode: 'deny-all',
    source: 'lark-memory', sourceId: `${scope.appId}:${scope.pool}:memory`, createdAt }) as Session;
  const session = memorySession('session_memory', '2026-09-20T00:00:00.000Z');
  const fresh = memorySession('session_fresh', '2026-09-25T00:00:00.000Z');
  const sessions: Session[] = [session];
  const tasksBySession = new Map<string, TaskRecord[]>([[session.id, []]]);
  const tasksOf = (id: string) => tasksBySession.get(id) ?? [];
  let listener: ((event: AgentEvent) => void) | undefined;
  const task = (state: string, id = 'task_memory', sessionId = session.id) => ({ id, sessionId, status: state, revision: 3,
    prompt: 'memory consolidation', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as TaskRecord);
  const runtime = {
    start: vi.fn(async () => { sessions.push(fresh); if (!tasksBySession.has(fresh.id)) tasksBySession.set(fresh.id, []); return fresh; }),
    listAgents: vi.fn(async () => [{ id: 'agent' }]), listSessions: vi.fn(async () => sessions.map(item => ({ ...item }))),
    getTasks: vi.fn(async (id: string) => tasksOf(id)),
    getTaskRecovery: vi.fn(async (id: string, taskId: string) => ({ status: tasksOf(id).find(item => item.id === taskId)!.status, blockers: [] as Array<{ code: string }>, resolvedUnknown: false })),
    dispatch: vi.fn(async (id: string) => {
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
  const pipeline = new LarkMemoryPipeline({ runtime: runtime as unknown as LarkMemoryPipelineRuntime,
    controlActorId: installationOwnerTaskActor, repos, store,
    projection: { write: vi.fn(), directoryFor: () => '/memory' } as any,
    readConfig: async () => ({ appId: scope.appId, defaultAgentId: 'agent', memoryEnabled: true }) as any, log, timeoutMs });
  return {
    pipeline, runtime, session, fresh, task, store, log,
    setTasks: (next: TaskRecord[], sessionId = session.id) => { tasksBySession.set(sessionId, next); },
    tasks: (sessionId = session.id) => tasksOf(sessionId)
  };
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

  it.each(['reconcile_required', 'queued', 'running'])('archives a memory session stuck on a %s task and continues on a new one', async status => {
    // 新会话里的任务以 failed 结束：拿到的是新会话自己的终态，证明这次运行确实换到了新会话。
    const h = await harness('failed'); h.setTasks([h.task(status, 'task_stuck')]);
    await expect(h.pipeline.runConsolidation(scope)).resolves.toMatchObject({ ok: false, error: 'MEMORY_RUN_FAILED' });
    expect(h.runtime.archive).toHaveBeenCalledWith(h.session.id, owner);
    expect(h.runtime.start).toHaveBeenCalledOnce();
    expect(h.runtime.dispatch.mock.calls.map(call => call[0])).toEqual([h.fresh.id]);
    // 旧会话的任务账本原样保留，也没有被撤回或中断。
    expect(h.tasks()).toEqual([expect.objectContaining({ id: 'task_stuck', status })]);
    expect(h.runtime.cancelQueued).not.toHaveBeenCalled();
    expect(h.runtime.interrupt).not.toHaveBeenCalled();

    // 下一次运行按 sourceId 选中新会话，不再替换。
    await h.pipeline.runConsolidation(scope);
    expect(h.runtime.start).toHaveBeenCalledOnce();
    expect(h.runtime.archive).toHaveBeenCalledOnce();
    expect(h.runtime.dispatch.mock.calls.map(call => call[0])).toEqual([h.fresh.id, h.fresh.id]);
  });

  it('replaces idle memory sessions with blocked resources instead of dispatching to them', async () => {
    const h = await harness('failed'); h.setTasks([h.task('completed')]);
    h.runtime.getTaskRecovery.mockResolvedValue({ status: 'completed', blockers: [{ code: 'DRIVER_STOP_BLOCKED' }], resolvedUnknown: false });
    expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ error: 'MEMORY_RUN_FAILED' });
    expect(h.runtime.archive).toHaveBeenCalledWith(h.session.id, owner);
    expect(h.runtime.dispatch.mock.calls.map(call => call[0])).toEqual([h.fresh.id]);
  });

  it('keeps choosing the new session when archiving the stuck one fails', async () => {
    const h = await harness('failed'); h.setTasks([h.task('reconcile_required', 'task_stuck')]);
    h.runtime.archive!.mockRejectedValue(new Error('SESSION_RESOURCE_BLOCKED'));
    expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ error: 'MEMORY_RUN_FAILED' });
    expect(h.log.warn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: h.session.id }), '记忆会话有未决任务且归档未完成，改用新会话');
    // 旧会话没能归档、仍然可见，但新会话更新，下一次运行直接选中新会话。
    await h.pipeline.runConsolidation(scope);
    expect(h.runtime.start).toHaveBeenCalledOnce();
    expect(h.runtime.archive).toHaveBeenCalledOnce();
    expect(h.runtime.dispatch.mock.calls.map(call => call[0])).toEqual([h.fresh.id, h.fresh.id]);
  });

  it('replaces at most once per run: a replacement that is not ready either fails the run', async () => {
    const h = await harness('failed'); h.setTasks([h.task('reconcile_required', 'task_stuck')]);
    h.setTasks([h.task('reconcile_required', 'task_other', h.fresh.id)], h.fresh.id);
    expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ ok: false, error: 'MEMORY_RECOVERY_REQUIRED' });
    expect(h.runtime.archive).toHaveBeenCalledOnce();
    expect(h.runtime.start).toHaveBeenCalledOnce();
    expect(h.runtime.dispatch).not.toHaveBeenCalled();
    expect((await h.store.getState(scope)).lastFailureAt?.consolidation).toBeTruthy();
  });

  it('fails closed without starting another session when the runtime cannot archive', async () => {
    const h = await harness('failed', 30, { archive: false }); h.setTasks([h.task('reconcile_required')]);
    expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ error: 'MEMORY_RECOVERY_REQUIRED' });
    expect(h.runtime.dispatch).not.toHaveBeenCalled();
    expect(h.runtime.start).not.toHaveBeenCalled();
  });

  it('allows reuse after confirmed recovery with unknown old output, but never treats that output as memory completion', async () => {
    const h = await harness('reconcile_required'); h.setTasks([h.task('reconcile_required', 'old')]);
    h.runtime.getTaskRecovery.mockResolvedValue({ status: 'reconcile_required', blockers: [], resolvedUnknown: true });
    expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ error: 'MEMORY_RECOVERY_REQUIRED' });
    expect(h.runtime.dispatch).toHaveBeenCalledOnce();
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
    expect(h.runtime.dispatch).not.toHaveBeenCalled();
    expect(h.runtime.start).not.toHaveBeenCalled();
    expect(h.runtime.archive).not.toHaveBeenCalled();
  });
});
