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
    cancelCi: vi.fn()
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
});
