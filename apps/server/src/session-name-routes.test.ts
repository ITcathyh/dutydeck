import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import { RuntimeError, type Session } from '@dutydeck/shared';

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
});

function mockSession(id: string, name?: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    agentId: 'mock-agent',
    state: 'idle',
    cwd: '/tmp/work',
    runId: 'run-1',
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
    ...(name ? { name } : {}),
    ...extra
  };
}

describe('session name routes', () => {
  it('fails closed with 403 when sessionNames is unconfigured or authorize returns false', async () => {
    const runtime = {
      setSessionName: vi.fn()
    } as unknown as DutydeckRuntime;

    // Unconfigured
    const unconfiguredApp = await buildApp(runtime, {});
    apps.push(unconfiguredApp);
    const res1 = await unconfiguredApp.inject({
      method: 'PATCH',
      url: '/api/sessions/s1/name',
      payload: { name: 'My Session' }
    });
    expect(res1.statusCode).toBe(403);
    expect(res1.json().error.code).toBe('SESSION_NAME_OWNER_REQUIRED');

    // Authorize returns false
    const unauthorizedApp = await buildApp(runtime, {
      sessionNames: { authorize: () => false }
    });
    apps.push(unauthorizedApp);
    const res2 = await unauthorizedApp.inject({
      method: 'PATCH',
      url: '/api/sessions/s1/name',
      payload: { name: 'My Session' }
    });
    expect(res2.statusCode).toBe(403);
    expect(res2.json().error.code).toBe('SESSION_NAME_OWNER_REQUIRED');
  });

  it('rejects invalid body format with 400 INVALID_INPUT (strict body)', async () => {
    const runtime = {
      setSessionName: vi.fn()
    } as unknown as DutydeckRuntime;
    const app = await buildApp(runtime, {
      sessionNames: { authorize: () => true }
    });
    apps.push(app);

    // Extra property rejected by strict schema
    const extraPropRes = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/s1/name',
      payload: { name: 'My Session', extra: 'bad' }
    });
    expect(extraPropRes.statusCode).toBe(400);
    expect(extraPropRes.json().error.code).toBe('INVALID_INPUT');

    // Missing name field
    const missingNameRes = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/s1/name',
      payload: {}
    });
    expect(missingNameRes.statusCode).toBe(400);
    expect(missingNameRes.json().error.code).toBe('INVALID_INPUT');

    // Non-string non-null name
    const numberNameRes = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/s1/name',
      payload: { name: 12345 }
    });
    expect(numberNameRes.statusCode).toBe(400);
    expect(numberNameRes.json().error.code).toBe('INVALID_INPUT');
  });

  it('delegates valid name or null to runtime and returns full session', async () => {
    let storedName: string | undefined = undefined;
    const sessionRecord = mockSession('s1');

    const runtime = {
      setSessionName: vi.fn(async (id: string, name: string | null) => {
        if (name === null) storedName = undefined;
        else storedName = name.trim();
        return {
          ...sessionRecord,
          ...(storedName ? { name: storedName } : {})
        };
      }),
      getSession: vi.fn(async (id: string) => {
        if (id !== 's1') return undefined;
        return {
          ...sessionRecord,
          ...(storedName ? { name: storedName } : {})
        };
      }),
      listSessions: vi.fn(async () => [
        {
          ...sessionRecord,
          ...(storedName ? { name: storedName } : {})
        }
      ])
    } as unknown as DutydeckRuntime;

    const app = await buildApp(runtime, {
      sessionNames: { authorize: () => true }
    });
    apps.push(app);

    // Initial GET /api/sessions/:id without name
    const get1 = await app.inject({ method: 'GET', url: '/api/sessions/s1' });
    expect(get1.statusCode).toBe(200);
    expect(get1.json().name).toBeUndefined();

    // PATCH rename
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/s1/name',
      payload: { name: '  Project Alpha  ' }
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json()).toMatchObject({
      id: 's1',
      name: 'Project Alpha',
      updatedAt: '2026-09-24T00:00:00.000Z'
    });
    expect(runtime.setSessionName).toHaveBeenCalledWith('s1', '  Project Alpha  ');

    // GET /api/sessions returns projected name
    const listRes = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()[0].name).toBe('Project Alpha');

    // PATCH reset (null)
    const resetRes = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/s1/name',
      payload: { name: null }
    });
    expect(resetRes.statusCode).toBe(200);
    expect(resetRes.json().name).toBeUndefined();
    expect(resetRes.json().updatedAt).toBe('2026-09-24T00:00:00.000Z');

    // GET /api/sessions/:id after reset has no name
    const get2 = await app.inject({ method: 'GET', url: '/api/sessions/s1' });
    expect(get2.statusCode).toBe(200);
    expect(get2.json().name).toBeUndefined();
  });

  it('translates runtime error codes appropriately', async () => {
    const runtime = {
      setSessionName: vi.fn(async (id: string) => {
        if (id === 's_unknown') throw new RuntimeError('SESSION_NOT_FOUND', 'Session not found', 404);
        if (id === 's_work') throw new RuntimeError('INVALID_WORK_SESSION', 'Work-item managed sessions cannot be renamed', 400);
        throw new RuntimeError('INVALID_SESSION_NAME', 'Session name cannot be empty', 400);
      })
    } as unknown as DutydeckRuntime;

    const app = await buildApp(runtime, {
      sessionNames: { authorize: () => true }
    });
    apps.push(app);

    const res404 = await app.inject({ method: 'PATCH', url: '/api/sessions/s_unknown/name', payload: { name: 'Name' } });
    expect(res404.statusCode).toBe(404);
    expect(res404.json().error.code).toBe('SESSION_NOT_FOUND');

    const resWork = await app.inject({ method: 'PATCH', url: '/api/sessions/s_work/name', payload: { name: 'Name' } });
    expect(resWork.statusCode).toBe(400);
    expect(resWork.json().error.code).toBe('INVALID_WORK_SESSION');
  });
});
