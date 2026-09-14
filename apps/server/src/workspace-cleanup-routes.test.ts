import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { RuntimeError } from '@dutydeck/shared';

const apps: any[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
});

describe('Workspace cleanup routes', () => {
  it('enforces task.view_result permission for GET /api/sessions/:id/workspace/cleanup', async () => {
    const runtime = {
      getWorkspaceCleanupPreview: vi.fn(async () => ({
        sessionId: 'ses_1',
        path: '/tmp/worktree',
        branch: 'dutydeck/session/ses_1',
        canClean: true,
        blockers: [],
        fingerprint: 'fp_abc123'
      }))
    } as any;

    const authorize = vi.fn(async (_req, _sessionId, boundary, action) => {
      if (boundary === 'session' && action === 'task.view_result') {
        return { allowed: true, action, code: 'ok', reason: 'allowed', source: 'user' as const };
      }
      return { allowed: false, action, code: 'denied', reason: 'forbidden', source: 'user' as const };
    });

    const app = await buildApp(runtime, { executionPolicy: { authorize } });
    apps.push(app);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/ses_1/workspace/cleanup'
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      sessionId: 'ses_1',
      canClean: true,
      fingerprint: 'fp_abc123'
    });
    expect(authorize).toHaveBeenCalledWith(expect.any(Object), 'ses_1', 'session', 'task.view_result');
    expect(runtime.getWorkspaceCleanupPreview).toHaveBeenCalledWith('ses_1');
  });

  it('denies GET /api/sessions/:id/workspace/cleanup when policy forbids viewing', async () => {
    const runtime = {
      getWorkspaceCleanupPreview: vi.fn()
    } as any;

    const authorize = vi.fn(async () => ({
      allowed: false, action: 'task.view_result' as const, code: 'FORBIDDEN', reason: 'no view permission', source: 'user' as const
    }));

    const app = await buildApp(runtime, { executionPolicy: { authorize } });
    apps.push(app);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/ses_1/workspace/cleanup'
    });
    expect(res.statusCode).toBe(403);
    expect(runtime.getWorkspaceCleanupPreview).not.toHaveBeenCalled();
  });

  it('enforces high_risk.execute permission for POST /api/sessions/:id/workspace/cleanup', async () => {
    const runtime = {
      cleanWorkspace: vi.fn(async () => ({
        ok: true,
        sessionId: 'ses_1',
        path: '/tmp/worktree',
        cleanedAt: '2026-09-14T00:00:00Z'
      }))
    } as any;

    const authorize = vi.fn(async (_req, _sessionId, boundary, action) => {
      if (boundary === 'high_risk' && action === 'high_risk.execute') {
        return { allowed: true, action, code: 'ok', reason: 'allowed', source: 'user' as const };
      }
      return { allowed: false, action, code: 'denied', reason: 'forbidden', source: 'user' as const };
    });

    const app = await buildApp(runtime, { executionPolicy: { authorize } });
    apps.push(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/ses_1/workspace/cleanup',
      payload: { fingerprint: 'fp_valid_123' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      sessionId: 'ses_1',
      cleanedAt: '2026-09-14T00:00:00Z'
    });
    expect(authorize).toHaveBeenCalledWith(expect.any(Object), 'ses_1', 'high_risk', 'high_risk.execute');
    expect(runtime.cleanWorkspace).toHaveBeenCalledWith('ses_1', 'fp_valid_123');
  });

  it('denies POST /api/sessions/:id/workspace/cleanup when high_risk.execute is refused', async () => {
    const runtime = {
      cleanWorkspace: vi.fn()
    } as any;

    const authorize = vi.fn(async () => ({
      allowed: false, action: 'high_risk.execute' as const, code: 'HIGH_RISK_FORBIDDEN', reason: 'denied', source: 'user' as const
    }));

    const app = await buildApp(runtime, { executionPolicy: { authorize } });
    apps.push(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/ses_1/workspace/cleanup',
      payload: { fingerprint: 'fp_valid_123' }
    });
    expect(res.statusCode).toBe(403);
    expect(runtime.cleanWorkspace).not.toHaveBeenCalled();
  });

  it('validates request body and returns 400 when fingerprint is missing or empty', async () => {
    const runtime = {
      cleanWorkspace: vi.fn()
    } as any;

    const app = await buildApp(runtime);
    apps.push(app);

    const emptyRes = await app.inject({
      method: 'POST',
      url: '/api/sessions/ses_1/workspace/cleanup',
      payload: {}
    });
    expect(emptyRes.statusCode).toBe(400);
    expect(emptyRes.json()).toMatchObject({ error: { code: 'INVALID_FINGERPRINT' } });

    const blankRes = await app.inject({
      method: 'POST',
      url: '/api/sessions/ses_1/workspace/cleanup',
      payload: { fingerprint: '   ' }
    });
    expect(blankRes.statusCode).toBe(400);
    expect(blankRes.json()).toMatchObject({ error: { code: 'INVALID_FINGERPRINT' } });
    expect(runtime.cleanWorkspace).not.toHaveBeenCalled();
  });

  it('returns 409 when runtime reports state conflict or fingerprint mismatch', async () => {
    const runtime = {
      cleanWorkspace: vi.fn(async () => {
        throw new RuntimeError('WORKSPACE_FINGERPRINT_MISMATCH', '工作目录状态已变化，请重新检查', 409);
      })
    } as any;

    const app = await buildApp(runtime);
    apps.push(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/ses_1/workspace/cleanup',
      payload: { fingerprint: 'fp_stale_123' }
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: { code: 'WORKSPACE_FINGERPRINT_MISMATCH', message: '工作目录状态已变化，请重新检查' }
    });
  });
});
