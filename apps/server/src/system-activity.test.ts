import { describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { DutydeckRuntime } from '@dutydeck/runtime';
import type { AgentDriver } from '@dutydeck/shared';

describe('GET /api/system/activity', () => {
  it('requires authentication when auth is enabled', async () => {
    const token = 'correct-access-token';
    const runtime = {
      getRunningTaskCount: vi.fn(() => 3)
    } as unknown as DutydeckRuntime;

    const app = await buildApp(runtime, {
      auth: {
        getToken: async () => token,
        localOnly: false
      }
    });

    try {
      // 1. 无 token -> 401
      const unauthed = await app.inject({
        method: 'GET',
        url: '/api/system/activity'
      });
      expect(unauthed.statusCode).toBe(401);
      expect(unauthed.json()).toMatchObject({
        error: { code: 'UNAUTHORIZED' }
      });
      expect(runtime.getRunningTaskCount).not.toHaveBeenCalled();

      // 2. 错误 token -> 401
      const wrongToken = await app.inject({
        method: 'GET',
        url: '/api/system/activity',
        headers: { authorization: 'Bearer wrong-token' }
      });
      expect(wrongToken.statusCode).toBe(401);
      expect(wrongToken.json()).toMatchObject({
        error: { code: 'UNAUTHORIZED' }
      });
      expect(runtime.getRunningTaskCount).not.toHaveBeenCalled();

      // 3. 正确 token -> 200 & 返回 runningTasks
      const authed = await app.inject({
        method: 'GET',
        url: '/api/system/activity',
        headers: { authorization: `Bearer ${token}` }
      });
      expect(authed.statusCode).toBe(200);
      expect(authed.json()).toEqual({ runningTasks: 3 });
      expect(runtime.getRunningTaskCount).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('passes excludeSessionId query through to the runtime counter', async () => {
    const getRunningTaskCount = vi.fn(() => 0);
    const app = await buildApp({ getRunningTaskCount } as unknown as DutydeckRuntime);
    try {
      const response = await app.inject({ method: 'GET', url: '/api/system/activity?excludeSessionId=ses_self_1' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ runningTasks: 0 });
      expect(getRunningTaskCount).toHaveBeenCalledWith('ses_self_1');

      // 空白参数视为未提供，不排除任何会话
      getRunningTaskCount.mockClear();
      const blank = await app.inject({ method: 'GET', url: '/api/system/activity?excludeSessionId=%20%20' });
      expect(blank.statusCode).toBe(200);
      expect(getRunningTaskCount).toHaveBeenCalledWith(undefined);
    } finally {
      await app.close();
    }
  });

  it('requests restart proof explicitly and keeps the total running count', async () => {
    const getRestartActivity = vi.fn(async () => ({ runningTasks: 3, restartBlockers: 1, recoverableTasks: 2 }));
    const getRunningTaskCount = vi.fn(() => 3);
    const app = await buildApp({ getRestartActivity, getRunningTaskCount } as unknown as DutydeckRuntime);
    try {
      expect((await app.inject('/api/system/activity')).json()).toEqual({ runningTasks: 3 });
      expect(getRestartActivity).not.toHaveBeenCalled();
      const response = await app.inject('/api/system/activity?restart=true&excludeSessionId=ses_self');
      expect(response.json()).toEqual({ runningTasks: 3, restartBlockers: 1, recoverableTasks: 2 });
      expect(getRestartActivity).toHaveBeenCalledWith('ses_self');
    } finally { await app.close(); }
  });

  it('merges running, steering and background work by session and excludes the given session', () => {
    // 按会话合并 running、steering 与后台任务，并排除指定会话
    const mockTasks = new Map<string, any>([
      ['session-1', { id: 'task-1', status: 'running' }],
      ['session-2', { id: 'task-2', status: 'queued' }],
      ['session-3', { id: 'task-3', status: 'running' }],
      ['session-4', { id: 'task-4', status: 'completed' }],
      ['session-5', { id: 'task-5', status: 'failed' }],
      ['session-6', { id: 'task-6', status: 'cancelled' }]
    ]);

    const fakeRuntime = Object.create(DutydeckRuntime.prototype);
    Object.defineProperty(fakeRuntime, 'activeTasks', {
      value: mockTasks,
      writable: true
    });
    const steeringSessions = new Map<string, string>();
    Object.defineProperty(fakeRuntime, 'steeringSessions', {
      value: steeringSessions,
      writable: true
    });

    const drivers = new Map<string, Pick<AgentDriver, 'hasBackgroundWork'>>();
    Object.defineProperty(fakeRuntime, 'drivers', { value: drivers });

    expect(fakeRuntime.getRunningTaskCount()).toBe(2);
    // 排除其中一个 running 会话后只剩 1（Agent 在自己会话里重启时排除本会话）
    expect(fakeRuntime.getRunningTaskCount('session-1')).toBe(1);
    // 排除一个本来就非 running 的会话不影响计数
    expect(fakeRuntime.getRunningTaskCount('session-2')).toBe(2);
    // 插话请求在途的会话也算正在运行；本会话已有运行中的一轮时不重复计数
    steeringSessions.set('session-1', 'task-7');
    steeringSessions.set('session-4', 'task-8');
    expect(fakeRuntime.getRunningTaskCount()).toBe(3);
    expect(fakeRuntime.getRunningTaskCount('session-4')).toBe(2);

    let backgroundActive = true;
    drivers.set('session-1', { hasBackgroundWork: () => true });
    drivers.set('session-4', { hasBackgroundWork: () => true });
    drivers.set('session-7', { hasBackgroundWork: () => backgroundActive });
    drivers.set('session-8', { hasBackgroundWork: () => false });
    drivers.set('session-9', {});
    expect(fakeRuntime.getRunningTaskCount()).toBe(4);
    expect(fakeRuntime.getRunningTaskCount('session-7')).toBe(3);
    expect(fakeRuntime.getRunningTaskCount('session-1')).toBe(3);
    expect(fakeRuntime.getRunningTaskCount('session-4')).toBe(3);
    expect(fakeRuntime.getRunningTaskCount('session-8')).toBe(4);
    expect(fakeRuntime.getRunningTaskCount('session-9')).toBe(4);
    backgroundActive = false;
    expect(fakeRuntime.getRunningTaskCount()).toBe(3);
  });
});
