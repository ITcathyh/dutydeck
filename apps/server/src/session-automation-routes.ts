import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { RuntimeError, type PolicyAction, type PolicyDecision } from '@dutydeck/shared';
import {
  cancelCiInputSchema,
  createSessionScheduleInputSchema,
  runSessionScheduleInputSchema,
  deleteSessionScheduleInputSchema,
  subscribeCiInputSchema,
  updateSessionScheduleInputSchema
} from '@dutydeck/shared';
import type { SessionAutomationService } from './session-automation.js';

type RouteAuthorization = boolean | PolicyDecision | { allowed: boolean; actorId?: string; code?: string; reason?: string };

export interface SessionAutomationRouteOptions {
  service: SessionAutomationService;
  authorize?: (
    request: FastifyRequest,
    sessionId: string,
    action: PolicyAction
  ) => RouteAuthorization | Promise<RouteAuthorization>;
}

function routeActor(result: RouteAuthorization): string | undefined {
  return typeof result === 'object' && 'actorId' in result ? result.actorId : undefined;
}

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  try { return schema.parse(input); }
  catch (error) {
    if (error instanceof ZodError) throw new RuntimeError('SESSION_AUTOMATION_VALIDATION_FAILED', error.issues.map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '), 400);
    throw error;
  }
}

export async function registerSessionAutomationRoutes(app: FastifyInstance, options: SessionAutomationRouteOptions): Promise<void> {
  const authorize = async (request: FastifyRequest, sessionId: string, action: PolicyAction) => {
    if (!options.authorize) throw new RuntimeError('SESSION_AUTOMATION_ROUTE_AUTH_UNWIRED', 'Session automation route authorization is not configured', 403);
    const decision = await options.authorize(request, sessionId, action);
    if (decision === true || typeof decision === 'object' && decision.allowed) return routeActor(decision);
    throw new RuntimeError(
      typeof decision === 'object' && decision.code ? decision.code : 'SESSION_AUTOMATION_FORBIDDEN',
      typeof decision === 'object' && decision.reason ? decision.reason : 'Session automation access was denied',
      403
    );
  };

  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/automation', async request => {
    const actorId = await authorize(request, request.params.sessionId, 'task.view_result');
    return options.service.listBySession(request.params.sessionId, actorId);
  });

  app.post<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/automation/schedules', async request => {
    const actorId = await authorize(request, request.params.sessionId, 'schedule.create');
    return { schedule: await options.service.createSchedule(request.params.sessionId, parse(createSessionScheduleInputSchema, request.body), actorId) };
  });

  app.patch<{ Params: { sessionId: string; id: string } }>('/api/sessions/:sessionId/automation/schedules/:id', async request => {
    const enables = Boolean(request.body && typeof request.body === 'object' && 'enabled' in request.body && request.body.enabled === true);
    const actorId = await authorize(request, request.params.sessionId, enables ? 'schedule.enable' : 'schedule.update');
    const body = parse(updateSessionScheduleInputSchema, request.body);
    return { schedule: await options.service.updateSchedule(request.params.sessionId, request.params.id, body, actorId) };
  });

  app.post<{ Params: { sessionId: string; id: string } }>('/api/sessions/:sessionId/automation/schedules/:id/run', async request => {
    const actorId = await authorize(request, request.params.sessionId, 'task.create');
    return { occurrence: await options.service.runSchedule(request.params.sessionId, request.params.id, parse(runSessionScheduleInputSchema, request.body), actorId) };
  });

  app.get<{ Params: { sessionId: string; id: string } }>('/api/sessions/:sessionId/automation/schedules/:id', async request => {
    const actorId = await authorize(request, request.params.sessionId, 'task.view_result');
    return { schedule: await options.service.getScheduleDefinition(request.params.sessionId, request.params.id, actorId) };
  });

  app.get<{ Params: { sessionId: string; id: string } }>('/api/sessions/:sessionId/automation/schedules/:id/history', async request => {
    const actorId = await authorize(request, request.params.sessionId, 'task.view_result');
    return { occurrences: await options.service.getScheduleHistory(request.params.sessionId, request.params.id, actorId) };
  });

  app.delete<{ Params: { sessionId: string; id: string } }>('/api/sessions/:sessionId/automation/schedules/:id', async request => {
    const actorId = await authorize(request, request.params.sessionId, 'schedule.update');
    return { schedule: await options.service.deleteSchedule(request.params.sessionId, request.params.id, parse(deleteSessionScheduleInputSchema, request.body), actorId) };
  });

  /** 已加载的 CI 提供方；没有 CI 插件时为空列表，Web 据此提示「未安装 CI 插件」。 */
  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/automation/ci-providers', async request => {
    await authorize(request, request.params.sessionId, 'task.view_result');
    return { providers: options.service.listCiProviders() };
  });

  app.post<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/automation/ci', async request => {
    const actorId = await authorize(request, request.params.sessionId, 'task.create');
    return { subscription: await options.service.subscribeCi(request.params.sessionId, parse(subscribeCiInputSchema, request.body), actorId) };
  });

  app.post<{ Params: { sessionId: string; id: string } }>('/api/sessions/:sessionId/automation/ci/:id/cancel', async request => {
    const actorId = await authorize(request, request.params.sessionId, 'queue.cancel');
    return { subscription: await options.service.cancelCi(request.params.sessionId, request.params.id, parse(cancelCiInputSchema, request.body), actorId) };
  });

  // 开 PR：发起只生成确认清单；确认与取消沿用中断、重试的权限判定。
  const pullRequests = () => {
    const service = options.service.pullRequests;
    if (!service) throw new RuntimeError('PR_UNAVAILABLE', '当前服务未接入开 PR。', 404);
    return service;
  };
  const owned = async (sessionId: string, id: string) => {
    const record = await pullRequests().get(id);
    if (!record || record.sessionId !== sessionId) throw new RuntimeError('PR_NOT_FOUND', '此会话中找不到这条 PR 记录。', 404);
  };

  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/pull-requests', async request => {
    await authorize(request, request.params.sessionId, 'task.view_result');
    const service = options.service.pullRequests;
    if (!service) return { available: false, hint: '当前服务未接入开 PR。', items: [] };
    return { ...service.availability(), items: await service.listBySession(request.params.sessionId) };
  });

  app.post<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/pull-requests', async request => {
    const actorId = await authorize(request, request.params.sessionId, 'run.interrupt');
    const input = parse(prepareInputSchema, request.body ?? {});
    return { pullRequest: await pullRequests().prepare(request.params.sessionId, input, actorId) };
  });

  app.post<{ Params: { sessionId: string; id: string } }>('/api/sessions/:sessionId/pull-requests/:id/confirm', async request => {
    const actorId = await authorize(request, request.params.sessionId, 'run.interrupt');
    await owned(request.params.sessionId, request.params.id);
    return pullRequests().confirm(request.params.id, actorId);
  });

  app.post<{ Params: { sessionId: string; id: string } }>('/api/sessions/:sessionId/pull-requests/:id/cancel', async request => {
    await authorize(request, request.params.sessionId, 'run.interrupt');
    await owned(request.params.sessionId, request.params.id);
    return { pullRequest: await pullRequests().cancel(request.params.sessionId, request.params.id) };
  });
}

const prepareInputSchema = z.object({ title: z.string().trim().max(120).optional() }).strict();
