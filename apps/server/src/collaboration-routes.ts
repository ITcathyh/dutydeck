import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RuntimeError, collaborationScopeSchema, updateCollaborationSettingsInputSchema, updateFollowupInputSchema, type CollaborationScope } from '@dutydeck/shared';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import type { CollaborationService } from './collaboration-service.js';
import type { CollaborationEvaluation } from './collaboration-evaluation.js';
import type { CollaborationExtensions } from './collaboration-extensions.js';
import { agentGroupToolBearerToken, larkAgentSessionBinding, type LarkAgentToolsService } from './lark/agent-tools.js';

export interface CollaborationRouteOptions {
  service: CollaborationService;
  runtime: DutydeckRuntime;
  tools: LarkAgentToolsService;
  authorizeManagement(request: FastifyRequest): Promise<string | undefined>;
  bootstrap(scope: CollaborationScope): Promise<unknown>;
  evaluation: CollaborationEvaluation;
  extensions: CollaborationExtensions;
  prepareSettings?(scope: CollaborationScope, patch: z.infer<typeof updateCollaborationSettingsInputSchema>): Promise<z.infer<typeof updateCollaborationSettingsInputSchema>>;
  onChange?(scope: CollaborationScope): Promise<void>;
}
const feedbackSchema = z.object({ correction: z.string().trim().min(1).max(4000), expectedAction: z.enum(['silent', 'reply', 'act']).optional() }).strict();
const replaySchema = z.object({ decisionIds: z.array(z.string().min(1)).min(1).max(50), policyVersion: z.string().min(1).max(64).optional() }).strict();
function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new RuntimeError('COLLABORATION_INVALID_INPUT', result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '), 400);
  return result.data;
}

export async function registerCollaborationRoutes(app: FastifyInstance, options: CollaborationRouteOptions) {
  const repo = options.service.repositories.collaboration;
  type Context = { scope: CollaborationScope; actorId: string; taskId?: string };
  const managementContext = async (request: FastifyRequest): Promise<Context> => {
    const actorId = await options.authorizeManagement(request);
    if (!actorId) throw new RuntimeError('COLLABORATION_FORBIDDEN', '需要群管理权限。', 403);
    const { appId, chatId } = request.params as { appId?: string; chatId?: string };
    return { scope: parse(collaborationScopeSchema, { appId, chatId }), actorId };
  };
  const agentContext = async (request: FastifyRequest): Promise<Context> => {
    const { sessionId } = await options.tools.workbenchContext(agentGroupToolBearerToken(request.headers.authorization));
    const active = options.runtime.getActiveTaskContext(sessionId);
    if (!active?.actorId) throw new RuntimeError('COLLABORATION_ACTIVE_ACTOR_REQUIRED', '协作工具只接受当前正在执行的群指令。', 403);
    options.tools.assertWorkbenchTurn(sessionId, active.taskId, typeof request.headers['x-dutydeck-work-turn'] === 'string' ? request.headers['x-dutydeck-work-turn'] : undefined);
    const session = await options.runtime.getSession(sessionId);
    const binding = session && larkAgentSessionBinding(session);
    if (!binding || binding.chatType !== 'group' || session?.sourceId?.split(':')[3] === 'collaboration') throw new RuntimeError('COLLABORATION_SCOPE_REQUIRED', '请在群内的当前指令中管理委托。', 403);
    return { scope: { appId: binding.appId, chatId: binding.chatId }, actorId: active.actorId, taskId: active.taskId };
  };
  const createInput = (context: Context, body: unknown) => {
    const input = parse(z.object({ id: z.string().trim().min(1).max(128) }).passthrough(), body);
    // A retry from the same turn keeps the same key. Another turn cannot claim it.
    return context.taskId ? { ...input, id: createHash('sha256').update(JSON.stringify([context.scope, context.taskId, input.id])).digest('hex') } : input;
  };
  const changed = async (scope: CollaborationScope) => { await options.onChange?.(scope); };
  for (const [base, context] of [
    ['/api/lark/groups/:appId/:chatId/collaboration', managementContext],
    ['/api/lark/agent-tools/collaboration', agentContext]
  ] as const) {
    app.get(base, async request => { const ctx = await context(request); return options.service.get(ctx.scope, ctx.actorId); });
    app.patch(`${base}/settings`, async request => {
      const ctx = await context(request);
      await options.service.require(ctx.scope, ctx.actorId, 'manage');
      let patch = parse(updateCollaborationSettingsInputSchema, request.body);
      if (options.prepareSettings) patch = await options.prepareSettings(ctx.scope, patch);
      const result = await options.service.updateSettings(ctx.scope, ctx.actorId, patch);
      await changed(ctx.scope); return result;
    });
    app.post(`${base}/followups`, async request => {
      const ctx = await context(request); const result = await options.service.createFollowup(ctx.scope, ctx.actorId, createInput(ctx, request.body), ctx.taskId ? 'inferred' : 'confirmed');
      await changed(ctx.scope); return result;
    });
    app.patch<{ Params: { appId?: string; chatId?: string; id: string } }>(`${base}/followups/:id`, async request => {
      const ctx = await context(request); const result = await options.service.updateFollowup(ctx.scope, ctx.actorId, request.params.id, { ...parse(updateFollowupInputSchema, request.body), provenance: ctx.taskId ? 'inferred' : 'confirmed' });
      await changed(ctx.scope); return result;
    });
    app.post(`${base}/mandates`, async request => {
      const ctx = await context(request); const result = await options.service.createMandate(ctx.scope, ctx.actorId, createInput(ctx, request.body));
      await changed(ctx.scope); return result;
    });
    app.patch<{ Params: { appId?: string; chatId?: string; id: string } }>(`${base}/mandates/:id`, async request => {
      const ctx = await context(request); const result = await options.service.updateMandate(ctx.scope, ctx.actorId, request.params.id, request.body);
      await changed(ctx.scope); return result;
    });
    app.post<{ Params: { appId?: string; chatId?: string; id: string } }>(`${base}/decisions/:id/feedback`, async request => {
      const ctx = await context(request); await options.service.require(ctx.scope, ctx.actorId, 'write');
      const input = parse(feedbackSchema, request.body);
      return { feedback: await repo.addFeedback({ id: randomUUID(), scope: ctx.scope, decisionId: request.params.id, actorId: ctx.actorId, ...input, createdAt: new Date().toISOString() }) };
    });
    app.post(`${base}/replay`, async request => {
      const ctx = await context(request); await options.service.require(ctx.scope, ctx.actorId, 'manage');
      return options.evaluation.replay(ctx.scope, parse(replaySchema, request.body));
    });
    app.post(`${base}/bootstrap`, async request => {
      const ctx = await context(request); await options.service.require(ctx.scope, ctx.actorId, 'manage');
      await options.bootstrap(ctx.scope); return { bootstrap: await repo.getBootstrap(ctx.scope) };
    });
  }
  // Each installed source must independently authenticate and derive its scope.
  app.post<{ Params: { sourceId: string } }>('/api/collaboration/events/:sourceId', async request => {
    const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, typeof value === 'string' ? value : undefined]));
    return options.extensions.ingest(request.params.sourceId, request.body, headers);
  });
}
