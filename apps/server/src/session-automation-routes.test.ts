import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSessionAutomationRoutes } from './session-automation-routes.js';
import type { SessionAutomationService } from './session-automation.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

function service() {
  return {
    listBySession: vi.fn(async () => ({ schedules: [], subscriptions: [], occurrences: [] })),
    createSchedule: vi.fn(),
    updateSchedule: vi.fn(),
    subscribeCi: vi.fn(),
    cancelCi: vi.fn(),
    listCiProviders: vi.fn(() => [])
  } as unknown as SessionAutomationService;
}

describe('session automation routes', () => {
  it('rejects protected reads when the route authorizer is missing', async () => {
    const app = Fastify(); apps.push(app);
    await registerSessionAutomationRoutes(app, { service: service() });
    const response = await app.inject({ method: 'GET', url: '/api/sessions/ses_1/automation' });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('SESSION_AUTOMATION_ROUTE_AUTH_UNWIRED');
  });

  it('authorizes malformed writes before returning a stable 400 validation error', async () => {
    const app = Fastify(); apps.push(app);
    const target = service();
    const authorize = vi.fn(async () => ({ allowed: true, actorId: 'installation_owner' }));
    await registerSessionAutomationRoutes(app, { service: target, authorize });
    const response = await app.inject({ method: 'POST', url: '/api/sessions/ses_1/automation/schedules', payload: { name: '' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('SESSION_AUTOMATION_VALIDATION_FAILED');
    expect(authorize).toHaveBeenCalledWith(expect.any(Object), 'ses_1', 'schedule.create');
    expect(target.createSchedule).not.toHaveBeenCalled();
  });

  it('passes the trusted actor from route authorization into the service', async () => {
    const app = Fastify(); apps.push(app);
    const target = service();
    vi.mocked(target.subscribeCi).mockResolvedValue({ id: 'ci_1' } as never);
    await registerSessionAutomationRoutes(app, { service: target, authorize: async () => ({ allowed: true, actorId: 'ou_user' }) });
    const response = await app.inject({ method: 'POST', url: '/api/sessions/ses_1/automation/ci', payload: {} });
    expect(response.statusCode).toBe(200);
    expect(target.subscribeCi).toHaveBeenCalledWith('ses_1', expect.objectContaining({ ttlSeconds: 86_400 }), 'ou_user');
  });

  it('lists loaded CI providers for the session, empty when no CI plugin is installed', async () => {
    const app = Fastify(); apps.push(app);
    const target = service();
    const authorize = vi.fn(async () => ({ allowed: true, actorId: 'ou_user' }));
    await registerSessionAutomationRoutes(app, { service: target, authorize });
    const empty = await app.inject({ method: 'GET', url: '/api/sessions/ses_1/automation/ci-providers' });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ providers: [] });
    expect(authorize).toHaveBeenCalledWith(expect.any(Object), 'ses_1', 'task.view_result');
    vi.mocked(target.listCiProviders).mockReturnValue([{ id: 'github', displayName: 'GitHub Actions', polling: true, webhook: false }]);
    expect((await app.inject({ method: 'GET', url: '/api/sessions/ses_1/automation/ci-providers' })).json()).toEqual({ providers: [{ id: 'github', displayName: 'GitHub Actions', polling: true, webhook: false }] });
  });

  it('开 PR：生成清单、确认、取消都要 run.interrupt 权限，确认只认本会话的记录', async () => {
    const app = Fastify(); apps.push(app);
    const pullRequests = {
      availability: vi.fn(() => ({ available: true })),
      listBySession: vi.fn(async () => []),
      prepare: vi.fn(async () => ({ id: 'pr_1' })),
      get: vi.fn(async (id: string) => ({ pr_1: { id: 'pr_1', sessionId: 'ses_1' }, pr_2: { id: 'pr_2', sessionId: 'ses_2' } } as Record<string, unknown>)[id]),
      confirm: vi.fn(async () => ({ message: '已确认', pullRequest: { id: 'pr_1' } })),
      cancel: vi.fn(async () => ({ id: 'pr_1', status: 'cancelled' }))
    };
    const target = Object.assign(service(), { pullRequests });
    let allowed = true;
    const authorize = vi.fn(async () => ({ allowed, actorId: 'ou_user' }));
    await registerSessionAutomationRoutes(app, { service: target, authorize });
    expect((await app.inject({ method: 'GET', url: '/api/sessions/ses_1/pull-requests' })).json()).toEqual({ available: true, items: [] });
    expect(authorize).toHaveBeenLastCalledWith(expect.any(Object), 'ses_1', 'task.view_result');

    expect((await app.inject({ method: 'POST', url: '/api/sessions/ses_1/pull-requests', payload: { title: 'Fix', branch: 'main' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/ses_1/pull-requests', payload: { title: 'Fix' } })).json()).toEqual({ pullRequest: { id: 'pr_1' } });
    expect(authorize).toHaveBeenLastCalledWith(expect.any(Object), 'ses_1', 'run.interrupt');
    expect(pullRequests.prepare).toHaveBeenCalledWith('ses_1', { title: 'Fix' }, 'ou_user');

    expect((await app.inject({ method: 'POST', url: '/api/sessions/ses_1/pull-requests/pr_2/confirm' })).statusCode).toBe(404);
    allowed = false;
    expect((await app.inject({ method: 'POST', url: '/api/sessions/ses_1/pull-requests/pr_1/confirm' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/ses_1/pull-requests/pr_1/cancel' })).statusCode).toBe(403);
    expect(pullRequests.confirm).not.toHaveBeenCalled();
    allowed = true;
    expect((await app.inject({ method: 'POST', url: '/api/sessions/ses_1/pull-requests/pr_1/confirm' })).json()).toEqual({ message: '已确认', pullRequest: { id: 'pr_1' } });
    expect(pullRequests.confirm).toHaveBeenCalledWith('pr_1', 'ou_user');
    expect(authorize).toHaveBeenLastCalledWith(expect.any(Object), 'ses_1', 'run.interrupt');
  });

  it('没有接入开 PR 时列表给出不可用说明', async () => {
    const app = Fastify(); apps.push(app);
    await registerSessionAutomationRoutes(app, { service: service(), authorize: async () => true });
    expect((await app.inject({ method: 'GET', url: '/api/sessions/ses_1/pull-requests' })).json()).toEqual({ available: false, hint: '当前服务未接入开 PR。', items: [] });
  });
});
