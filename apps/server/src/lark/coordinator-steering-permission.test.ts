import { expect, it, vi } from 'vitest';
import type { AgentEvent } from '@dutydeck/shared';
import { LarkCoordinatorDispatch } from './coordinator-dispatch.js';

const at = '2026-11-16T00:00:00.000Z';
const permission = (id: string, status: string): AgentEvent => ({ type: 'permission_request', data: { id, status }, timestamp: at } as AgentEvent);
const make = (runtime: Record<string, unknown>) => {
  const coordinator = Object.create(LarkCoordinatorDispatch.prototype) as any;
  coordinator.runtime = runtime;
  coordinator.log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return coordinator;
};

it('索引诊断在首个 confirmed-pending 命中后立即停止', async () => {
  const queries: string[] = [];
  const status = await make({
    getPendingPermissions: () => Array.from({ length: 5 }, (_, index) => ({ id: `permission-${index}`, status: 'pending' })),
    getLatestPermissionRequest: async (_session: string, _task: string, id: string) => {
      queries.push(id);
      return id === 'permission-0' ? permission(id, 'pending') : undefined;
    }
  }).steeringPermissionStatus('ses', { taskId: 'target', attemptId: 'attempt' });
  expect(status).toBe('confirmed-pending');
  expect(queries).toEqual(['permission-0']);
});

it('实际 target 存在但缺少 pending 诊断能力时返回 unknown，且不调用后续事件查询', async () => {
  const getLatestPermissionRequest = vi.fn(async () => permission('permission-1', 'pending'));
  const getEvents = vi.fn(async () => [permission('permission-1', 'pending')]);
  const status = await make({ getLatestPermissionRequest, getEvents })
    .steeringPermissionStatus('ses', { taskId: 'target', attemptId: 'attempt' });
  expect(status).toBe('unknown');
  expect(getLatestPermissionRequest).not.toHaveBeenCalled();
  expect(getEvents).not.toHaveBeenCalled();
});

it('兼容 fallback 单次遍历保留最新审批事件和任务边界，不做逐 pending 全量过滤', async () => {
  let filterCalls = 0;
  class CountingEvents extends Array<AgentEvent> {
    override filter(callback: (value: AgentEvent, index: number, array: AgentEvent[]) => unknown, thisArg?: unknown): AgentEvent[] {
      filterCalls++;
      return super.filter(callback, thisArg);
    }
  }
  const events = CountingEvents.from([
    { type: 'text', data: { role: 'user', taskId: 'other' }, timestamp: at } as AgentEvent,
    permission('permission-2', 'approved'),
    { type: 'task', data: { task: { id: 'other', status: 'completed' } }, timestamp: at } as AgentEvent,
    { type: 'text', data: { role: 'user', taskId: 'target' }, timestamp: at } as AgentEvent,
    permission('permission-1', 'pending'),
    permission('permission-2', 'pending'),
    permission('permission-1', 'approved'),
    { type: 'task', data: { task: { id: 'target', status: 'completed' } }, timestamp: at } as AgentEvent
  ]);
  const getEvents = vi.fn(async () => events);
  const status = await make({
    getPendingPermissions: () => [{ id: 'permission-1', status: 'pending' }, { id: 'permission-2', status: 'pending' }],
    getEvents
  }).steeringPermissionStatus('ses', { taskId: 'target', attemptId: 'attempt' });
  expect(status).toBe('confirmed-pending');
  expect(getEvents).toHaveBeenCalledTimes(1);
  expect(filterCalls).toBe(1);
});

it.each(['throws', 'malformed'] as const)('fallback 历史为 %s 时返回 unknown，而不是 confirmed-none', async mode => {
  const events = [
    { type: 'text', data: { role: 'user', taskId: 'target' }, timestamp: at } as AgentEvent,
    { type: 'permission_request', data: null, timestamp: at } as AgentEvent
  ];
  const status = await make({
    getPendingPermissions: () => [{ id: 'permission-1', status: 'pending' }],
    getEvents: async () => { if (mode === 'throws') throw new SyntaxError('malformed historical JSON'); return events; }
  }).steeringPermissionStatus('ses', { taskId: 'target', attemptId: 'attempt' });
  expect(status).toBe('unknown');
});

it('只有旧 runtime 缺 target 时才核验并复用同一个 running，换轮或诊断失败均为 unknown', async () => {
  const fallback = { id: 'old', sessionId: 'ses', prompt: 'old', status: 'running', currentAttemptId: 'attempt-old', createdAt: at, updatedAt: at };
  const getLatestPermissionRequest = vi.fn(async () => permission('permission-1', 'pending'));
  const runtime = {
    getTasks: vi.fn(async () => [fallback]),
    getPendingPermissions: () => [{ id: 'permission-1', status: 'pending' }],
    getLatestPermissionRequest
  };
  const coordinator = make(runtime);
  await expect(coordinator.steeringPermissionStatus('ses', undefined, fallback)).resolves.toBe('confirmed-pending');
  expect(getLatestPermissionRequest).toHaveBeenCalledWith('ses', 'old', 'permission-1');

  getLatestPermissionRequest.mockClear();
  runtime.getTasks.mockResolvedValue([{ ...fallback, id: 'new', currentAttemptId: 'attempt-new' }]);
  await expect(coordinator.steeringPermissionStatus('ses', undefined, fallback)).resolves.toBe('unknown');
  expect(getLatestPermissionRequest).not.toHaveBeenCalled();

  runtime.getTasks.mockRejectedValue(new Error('running diagnostic unavailable'));
  await expect(coordinator.steeringPermissionStatus('ses', undefined, fallback)).resolves.toBe('unknown');
});
