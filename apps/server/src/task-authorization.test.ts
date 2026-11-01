import { afterAll, describe, expect, it } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { taskAuthorizationSchema, type TaskAuthorization } from '@dutydeck/shared';
import { readTaskAuthorization, recordTaskAuthorization } from './task-authorization.js';
import { buildApp } from './app.js';

const repos = createRepositories(':memory:');
afterAll(() => repos.close());
const record: TaskAuthorization = { schemaVersion: 1, taskId: 't1', sessionId: 's1', strength: 'explicit', via: 'mention', actorOpenId: 'ou_alice', chatId: 'oc_group', recordedAt: '2026-11-01T00:00:00.000Z' };
describe('host-owned authorization records', () => {
  it('strictly validates and preserves first acceptance across replay', async () => {
    expect(taskAuthorizationSchema.safeParse({ ...record, forged: true }).success).toBe(false);
    expect(taskAuthorizationSchema.safeParse({ ...record, schemaVersion: 2 }).success).toBe(false);
    await recordTaskAuthorization(repos.config, record);
    await recordTaskAuthorization(repos.config, { ...record, via: 'direct', actorOpenId: 'ou_bob' });
    expect(await readTaskAuthorization(repos.config, 't1', 's1')).toEqual(record);
    expect(await readTaskAuthorization(repos.config, 't1', 'another_session')).toBeUndefined();
  });
  it('only exposes evidence for tasks in the authorized session, with no write route', async () => {
    await recordTaskAuthorization(repos.config, record);
    await recordTaskAuthorization(repos.config, { ...record, taskId: 't_other', sessionId: 's_other' });
    const runtime = { getTasks: async () => [{ id: 't1' }, { id: 't_other' }, { id: 'legacy' }] } as any;
    const app = await buildApp(runtime, { lark: { config: repos.config } as any });
    const denied = await buildApp(runtime, { lark: { config: repos.config } as any, executionPolicy: { authorize: async () => ({ allowed: false, action: 'task.view_result', code: 'forbidden', reason: 'denied', source: 'integration' }) } });
    try {
      expect((await app.inject('/api/sessions/s1/task-authorizations')).json()).toEqual([record]);
      expect((await denied.inject('/api/sessions/s1/task-authorizations')).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/task-authorizations', payload: record })).statusCode).toBe(404);
    } finally { await app.close(); await denied.close(); }
  });
});
