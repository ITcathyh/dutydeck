import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { LarkAppCreationError } from './app-creation.js';
import { registerLarkAppCreationRoutes } from './app-creation-routes.js';

it('exposes the fixed async create/read/cancel/retry contract with no-store responses', async () => {
  const job = { id: 'job', name: 'Bot', status: 'preparing' as const, createdAt: 'now', updatedAt: 'now', retryable: false };
  const jobs = { start: vi.fn(async () => job), get: vi.fn(async () => job), cancel: vi.fn(async () => job), retry: vi.fn(async () => job) };
  const app = Fastify();
  await registerLarkAppCreationRoutes(app, jobs);
  for (const [method, path, status] of [['POST', '', 202], ['GET', '/job', 200], ['POST', '/job/cancel', 200], ['POST', '/job/retry', 202]] as const) {
    const response = await app.inject({ method, url: `/api/lark/apps/create${path}`, ...(path ? {} : { payload: { requestId: 'job', name: 'Bot' } }) });
    expect(response.statusCode).toBe(status);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual(job);
  }
  expect(jobs.start).toHaveBeenCalledWith('job', 'Bot');
  jobs.cancel.mockRejectedValueOnce(new LarkAppCreationError(409, '应用创建已经开始，无法取消'));
  expect((await app.inject({ method: 'POST', url: '/api/lark/apps/create/job/cancel' })).statusCode).toBe(409);
  jobs.start.mockRejectedValueOnce(new Error('private-cookie-value'));
  const failure = await app.inject({ method: 'POST', url: '/api/lark/apps/create', payload: {} });
  expect(failure.statusCode).toBe(500);
  expect(failure.body).not.toContain('private-cookie-value');
  await app.close();
});

it('returns 503 when durable config storage is unavailable', async () => {
  const app = Fastify(); await registerLarkAppCreationRoutes(app);
  expect((await app.inject({ method: 'POST', url: '/api/lark/apps/create', payload: {} })).statusCode).toBe(503);
  await app.close();
});
