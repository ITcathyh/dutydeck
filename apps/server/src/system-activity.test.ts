import { describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { DutydeckRuntime } from '@dutydeck/runtime';

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

  it('counts only tasks with status === running', () => {
    // 验证 DutydeckRuntime 原型上的 getRunningTaskCount 逻辑只计数 running 状态
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

    expect(fakeRuntime.getRunningTaskCount()).toBe(2);
  });
});
