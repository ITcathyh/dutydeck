import { toolNeeds } from './agent-host/tool-table.js';
import { registerToolFamily } from './agent-host/routes.js';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RuntimeError, isRecord, collaborationScopeSchema, parseLarkSourceId, updateCollaborationSettingsRequestSchema, updateFollowupInputSchema, updateCollaborationDutyRequestSchema, type UpdateCollaborationDutyRequest, type UpdateCollaborationSettingsRequest, type CollaborationScope, type ScenarioPreview, type ScenarioPreviewInput } from '@dutydeck/shared';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import type { CollaborationService } from './collaboration-service.js';
import type { CollaborationEvaluation } from './collaboration-evaluation.js';
import type { CollaborationExtensions } from './collaboration-extensions.js';
import { resolveActorTurn, larkAgentSessionBinding } from './agent-host/turn-authority.js';
import type { LarkAgentToolsService } from './lark/agent-tools.js';

export interface CollaborationRouteOptions {
  service: CollaborationService;
  runtime: DutydeckRuntime;
  tools: LarkAgentToolsService;
  authorizeManagement(request: FastifyRequest): Promise<string | undefined>;
  bootstrap(scope: CollaborationScope): Promise<unknown>;
  evaluation: CollaborationEvaluation;
  extensions: CollaborationExtensions;
  prepareSettings?(scope: CollaborationScope, patch: UpdateCollaborationSettingsRequest): Promise<UpdateCollaborationSettingsRequest>;
  onChange?(scope: CollaborationScope): Promise<void>;
  /** Agent 发起的委托创建：不立即生效，改发确认卡，用户确认后才创建。未提供时直接创建。 */
  confirmMandate?(scope: CollaborationScope, actorId: string, body: unknown, origin: { threadRootMessageId?: string }): Promise<unknown>;
  /** Agent 发起的委托修改：只收紧（暂停、停止、暂停发送结果）时直接生效，其余改发确认卡；未提供时拒绝这类修改。 */
  confirmMandateUpdate?(scope: CollaborationScope, actorId: string, id: string, body: unknown, origin: { threadRootMessageId?: string }): Promise<unknown>;
  /** Web 改群分工（接话人、场景包绑定），见 LarkGroupParticipation.updateDuty。 */
  updateDuty?(scope: CollaborationScope, patch: UpdateCollaborationDutyRequest, actorId: string): Promise<unknown>;
  /** 群设置页列出的场景包和本群绑定，合进 GET 的结果，见 LarkGroupParticipation.scenarioOverview。 */
  scenarios?(scope: CollaborationScope): Promise<unknown[]>;
  previewScenario?(scope: CollaborationScope, id: string, input: ScenarioPreviewInput): Promise<ScenarioPreview>;
}
const feedbackSchema = z.object({ correction: z.string().trim().min(1).max(4000), expectedAction: z.enum(['silent', 'reply', 'act']).optional() }).strict();
const replaySchema = z.object({ decisionIds: z.array(z.string().min(1)).min(1).max(50), policyVersion: z.string().min(1).max(64).optional() }).strict();
const tighteningOnly = (body: unknown) => isRecord(body) && Object.entries(body).every(([key, value]) =>
  key === 'expectedRevision' || key === 'deliveryPaused' && value === true || key === 'status' && ['paused', 'cancelled', 'completed'].includes(value as string));
function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new RuntimeError('COLLABORATION_INVALID_INPUT', result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '), 400);
  return result.data;
}

export async function registerCollaborationRoutes(app: FastifyInstance, options: CollaborationRouteOptions) {
  const repo = options.service.repositories.collaboration;
  type Context = { scope: CollaborationScope; actorId: string; taskId?: string; origin?: { threadRootMessageId?: string } };
  const managementContext = async (request: FastifyRequest): Promise<Context> => {
    const actorId = await options.authorizeManagement(request);
    if (!actorId) throw new RuntimeError('COLLABORATION_FORBIDDEN', '需要群管理权限。', 403);
    const { appId, chatId } = request.params as { appId?: string; chatId?: string };
    return { scope: parse(collaborationScopeSchema, { appId, chatId }), actorId };
  };
  const agentContext = async (request: FastifyRequest): Promise<Context> => {
    const { sessionId, actorId, taskId } = await resolveActorTurn(request, 'collaboration', options.runtime,
      options.tools.capabilities, token => options.tools.workbenchContext(token));
    const session = await options.runtime.getSession(sessionId);
    const binding = session && larkAgentSessionBinding(session);
    if (!binding || binding.chatType !== 'group' || parseLarkSourceId(session?.sourceId).scope[0] === 'collaboration') throw new RuntimeError('COLLABORATION_SCOPE_REQUIRED', '请在群内的当前指令中管理委托。', 403);
    return { scope: { appId: binding.appId, chatId: binding.chatId }, actorId, taskId, origin: binding.threadRootMessageId ? { threadRootMessageId: binding.threadRootMessageId } : {} };
  };
  const createInput = (context: Context, body: unknown) => {
    const input = parse(z.object({ id: z.string().trim().min(1).max(128) }).passthrough(), body);
    // A retry from the same turn keeps the same key. Another turn cannot claim it.
    return context.taskId ? { ...input, id: createHash('sha256').update(JSON.stringify([context.scope, context.taskId, input.id])).digest('hex') } : input;
  };
  const changed = async (scope: CollaborationScope) => { await options.onChange?.(scope); };
  if (options.previewScenario) {
    const previewScenario = options.previewScenario;
    app.post<{ Params: { id: string } }>('/api/lark/groups/:appId/:chatId/collaboration/scenarios/:id/preview', async (request, reply) => {
      const { scope, actorId } = await managementContext(request);
      await options.service.require(scope, actorId, 'read', true);
      const id = parse(z.string().min(1).max(64), request.params.id);
      const input = parse(z.object({ params: z.record(z.unknown()).optional(), limit: z.number().int().min(1).optional() }).strict(), request.body ?? {});
      reply.header('cache-control', 'no-store');
      return previewScenario(scope, id, input);
    });
  }
  type CollaborationRequest = FastifyRequest<{ Params: { id: string } }>;
  const handlers = (context: (request: FastifyRequest) => Promise<Context>) => ({
    'collaborate.status': async (request: CollaborationRequest) => {
      const ctx = await context(request);
      const result = await options.service.get(ctx.scope, ctx.actorId);
      return options.scenarios ? { ...result, scenarios: await options.scenarios(ctx.scope) } : result;
    },
    'collaborationSettings': async (request: CollaborationRequest) => {
      const ctx = await context(request);
      await options.service.require(ctx.scope, ctx.actorId, 'manage');
      let patch = parse(updateCollaborationSettingsRequestSchema, request.body);
      if (options.prepareSettings) patch = await options.prepareSettings(ctx.scope, patch);
      const result = await options.service.updateSettings(ctx.scope, ctx.actorId, patch);
      await changed(ctx.scope); return result;
    },
    'collaborate.followup-create': async (request: CollaborationRequest) => {
      const ctx = await context(request); const result = await options.service.createFollowup(ctx.scope, ctx.actorId, createInput(ctx, request.body), ctx.taskId ? 'inferred' : 'confirmed');
      await changed(ctx.scope); return result;
    },
    'collaborate.followup-update': async (request: CollaborationRequest) => {
      const ctx = await context(request); const result = await options.service.updateFollowup(ctx.scope, ctx.actorId, request.params.id, { ...parse(updateFollowupInputSchema, request.body), provenance: ctx.taskId ? 'inferred' : 'confirmed' });
      await changed(ctx.scope); return result;
    },
    'collaborate.mandate-create': async (request: CollaborationRequest) => {
      const ctx = await context(request);
      // 只有 Agent 通道带 taskId；Web 管理端是用户自己在页面上操作，保持立即创建。
      if (ctx.taskId && options.confirmMandate) return options.confirmMandate(ctx.scope, ctx.actorId, createInput(ctx, request.body), ctx.origin ?? {});
      const result = await options.service.createMandate(ctx.scope, ctx.actorId, createInput(ctx, request.body));
      await changed(ctx.scope); return result;
    },
    'collaborate.mandate-update': async (request: CollaborationRequest) => {
      const ctx = await context(request);
      if (ctx.taskId && !tighteningOnly(request.body)) {
        if (!options.confirmMandateUpdate) throw new RuntimeError('COLLABORATION_CONFIRMATION_UNAVAILABLE', '当前服务不能发确认卡，Agent 不能直接修改委托的内容、时间或恢复执行。', 503);
        return options.confirmMandateUpdate(ctx.scope, ctx.actorId, request.params.id, request.body, ctx.origin ?? {});
      }
      const result = await options.service.updateMandate(ctx.scope, ctx.actorId, request.params.id, request.body);
      await changed(ctx.scope); return result;
    },
    'collaborate.feedback': async (request: CollaborationRequest) => {
      const ctx = await context(request); await options.service.require(ctx.scope, ctx.actorId, 'write');
      const input = parse(feedbackSchema, request.body);
      return { feedback: await repo.addFeedback({ id: randomUUID(), scope: ctx.scope, decisionId: request.params.id, actorId: ctx.actorId, ...input, createdAt: new Date().toISOString() }) };
    },
    'collaborationReplay': async (request: CollaborationRequest) => {
      const ctx = await context(request); await options.service.require(ctx.scope, ctx.actorId, 'manage');
      return options.evaluation.replay(ctx.scope, parse(replaySchema, request.body));
    },
    'collaborationBootstrap': async (request: CollaborationRequest) => {
      const ctx = await context(request); await options.service.require(ctx.scope, ctx.actorId, 'manage');
      await options.bootstrap(ctx.scope); return { bootstrap: await repo.getBootstrap(ctx.scope) };
    },
  });
  registerToolFamily<{ Params: { id: string } }>(app, [toolNeeds.collaboration], handlers(agentContext));

  const management = handlers(managementContext);
  const base = '/api/lark/groups/:appId/:chatId/collaboration';
  app.get(base, management['collaborate.status']);
  app.patch(`${base}/settings`, management['collaborationSettings']);
  app.post(`${base}/followups`, management['collaborate.followup-create']);
  app.patch(`${base}/followups/:id`, management['collaborate.followup-update']);
  app.post(`${base}/mandates`, management['collaborate.mandate-create']);
  app.patch(`${base}/mandates/:id`, management['collaborate.mandate-update']);
  app.post(`${base}/decisions/:id/feedback`, management['collaborate.feedback']);
  app.post(`${base}/replay`, management['collaborationReplay']);
  app.post(`${base}/bootstrap`, management['collaborationBootstrap']);
  // 群分工只在 Web 群设置里改，Agent 工具不改。
  app.patch('/api/lark/groups/:appId/:chatId/collaboration/duty', async request => {
    const ctx = await managementContext(request);
    await options.service.require(ctx.scope, ctx.actorId, 'manage');
    if (!options.updateDuty) throw new RuntimeError('COLLABORATION_DUTY_UNAVAILABLE', '当前服务不能修改群分工。', 503);
    return options.updateDuty(ctx.scope, parse(updateCollaborationDutyRequestSchema, request.body), ctx.actorId);
  });
  // Each installed source must independently authenticate and derive its scope.
  app.post<{ Params: { sourceId: string } }>('/api/collaboration/events/:sourceId', async request => {
    const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, typeof value === 'string' ? value : undefined]));
    return options.extensions.ingest(request.params.sourceId, request.body, headers);
  });
}
