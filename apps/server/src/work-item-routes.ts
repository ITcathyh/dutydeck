import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createWorkItemSchema, RuntimeError } from '@dutydeck/shared';
import type { SessionAutomationRouteOptions } from './session-automation-routes.js';
import type { WorkItemService } from './work-items.js';
import type { WorkItemInteractions } from './work-item-interactions.js';

export interface WorkItemRouteOptions {
  service: WorkItemService;
  authorize: NonNullable<SessionAutomationRouteOptions['authorize']>;
  interactions?: WorkItemInteractions;
}

export function workInput<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new RuntimeError('WORK_ITEM_INVALID_INPUT', result.error.issues.map(issue => issue.message).join('; '), 400);
  return result.data;
}

const revision = z.number().int().positive();
const stepId = z.string().min(1).max(64);
const revisionInput = z.object({ expectedRevision: revision }).strict();
const retryInput = revisionInput.extend({ stepId });
const answerInput = retryInput.extend({ answer: z.string().trim().min(1).max(4_000) });
export const templateNameInput = z.object({ name: z.string().trim().min(1).max(200) }).strict();
export const runTemplateInput = z.object({ version: revision, goal: z.string().trim().min(1).max(32_000), idempotencyKey: z.string().min(1).max(200) }).strict();

export async function registerWorkItemRoutes(app: FastifyInstance, options: WorkItemRouteOptions) {
  const actor = async (request: FastifyRequest, sessionId: string, read = false) => {
    const decision = await options.authorize(request, sessionId, read ? 'task.view_result' : 'turn.append');
    if (!decision || (typeof decision === 'object' && !decision.allowed)) throw new RuntimeError('WORK_ITEM_FORBIDDEN', '当前账号无权操作此目标', 403);
    const actorId = typeof decision === 'object' && 'actorId' in decision ? decision.actorId : undefined;
    if (!actorId) throw new RuntimeError('WORK_ITEM_ACTOR_REQUIRED', '目标操作缺少已验证的操作者', 403);
    return actorId;
  };
  type Params = { sessionId: string; id: string };
  const base = '/api/sessions/:sessionId/work-items';
  app.get<{ Params: Params }>(base, async request => {
    const sid = request.params.sessionId;
    const who = await actor(request, sid, true);
    return { items: await options.service.listBySession(sid, who), templates: await options.service.listTemplates(sid, who) };
  });
  app.post<{ Params: Params }>(base, async request => options.service.create(request.params.sessionId, workInput(createWorkItemSchema, request.body), await actor(request, request.params.sessionId)));
  app.get<{ Params: Params }>(`${base}/:id`, async request => options.service.get(request.params.sessionId, request.params.id, await actor(request, request.params.sessionId, true)));
  app.post<{ Params: Params }>(`${base}/:id/cancel`, async request => {
    const input = workInput(revisionInput, request.body);
    return options.service.cancel(request.params.sessionId, request.params.id, input.expectedRevision, await actor(request, request.params.sessionId));
  });
  app.post<{ Params: Params }>(`${base}/:id/retry`, async request => {
    const input = workInput(retryInput, request.body);
    return options.service.retryStep(request.params.sessionId, request.params.id, input.stepId, input.expectedRevision, await actor(request, request.params.sessionId));
  });
  app.post<{ Params: Params }>(`${base}/:id/answer`, async request => {
    const input = workInput(answerInput, request.body);
    return options.service.answer(request.params.sessionId, request.params.id, input.stepId, input.answer, input.expectedRevision, await actor(request, request.params.sessionId));
  });
  app.post<{ Params: Params }>(`${base}/:id/template`, async request => options.service.saveTemplate(request.params.sessionId, request.params.id, workInput(templateNameInput, request.body).name, await actor(request, request.params.sessionId)));
  app.post<{ Params: Params }>('/api/sessions/:sessionId/work-templates/:id/run', async request => {
    const input = workInput(runTemplateInput, request.body);
    return options.service.runTemplate(request.params.sessionId, request.params.id, input.version, input.goal, input.idempotencyKey, await actor(request, request.params.sessionId));
  });
  if (options.interactions) {
    app.get<{ Params: Params & { stepId: string } }>(`${base}/:id/terminal/:stepId`, async request => options.interactions!.terminal(request.params.sessionId, request.params.id, request.params.stepId, await actor(request, request.params.sessionId, true)));
    app.post<{ Params: Params }>(`${base}/:id/terminal-input`, async request => options.interactions!.terminalInput(request.params.sessionId, request.params.id, request.body, await actor(request, request.params.sessionId)));
    app.get<{ Params: Params }>(`${base}/:id/requests`, async request => options.interactions!.list(request.params.sessionId, request.params.id, await actor(request, request.params.sessionId, true)));
    app.post<{ Params: Params }>(`${base}/:id/respond`, async request => options.interactions!.respond(request.params.sessionId, request.params.id, request.body, await actor(request, request.params.sessionId)));
  }
}
