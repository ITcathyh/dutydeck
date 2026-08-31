import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import {
  RuntimeError,
  createScheduleDefinitionInputSchema,
  updateScheduleDefinitionInputSchema,
  type PolicyAction,
  type PolicyDecision,
  type RepositoryBundle,
  type ScheduleDefinition
} from '@dockmux/shared';

export type ScheduleManagementRepositories = Pick<RepositoryBundle,
  'scheduleDefinitions' | 'scheduleGenerations' | 'scheduleOccurrences' | 'scheduleWatermarks' | 'archivedHammerIntegrations'>;

export interface ScheduleManagementOptions {
  repositories?: ScheduleManagementRepositories;
  authorize?: (request: FastifyRequest, action: PolicyAction) => boolean | PolicyDecision | Promise<boolean | PolicyDecision>;
}

const createBodySchema = createScheduleDefinitionInputSchema.omit({ sourceOwnership: true, sourceNamespace: true, sourceScheduleRef: true, sourceEnabled: true });
const previewQuerySchema = z.object({ after: z.string().datetime({ offset: true }).optional() }).strict();
const integrationQuerySchema = z.object({ channelBotId: z.string().min(1) }).strict();

function capability(options: ScheduleManagementOptions) {
  const repositoriesWired = Boolean(options.repositories);
  const permissionEvaluatorWired = Boolean(options.authorize);
  return {
    schemaVersion: 1 as const,
    repositoriesWired,
    permissionEvaluatorWired,
    writesEnabled: repositoriesWired && permissionEvaluatorWired,
    executorWired: false as const,
    uiEntryReady: false as const,
    readiness: !repositoriesWired ? 'repository_unwired' as const : !permissionEvaluatorWired ? 'permission_unwired' as const : 'offline_management_ready' as const,
    blockers: [
      ...(!repositoriesWired ? [{ code: 'schedule_repository_unwired', message: 'Schedule foundation repository is not wired', action: 'Inject the optional v13 repository bundle' }] : []),
      ...(!permissionEvaluatorWired ? [{ code: 'schedule_permission_evaluator_unwired', message: 'Schedule management permission evaluator is not wired', action: 'Inject owner/admin authorization' }] : []),
      { code: 'schedule_executor_unavailable', message: 'Schedule executor is not implemented', action: 'Keep every definition staged and disabled' },
      { code: 'schedule_ui_entry_unwired', message: 'Schedule panel is not mounted in the shared UI shell', action: 'A single UI shell owner must add the navigation entry' }
    ]
  };
}

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  try { return schema.parse(input); }
  catch (error) {
    if (error instanceof ZodError) throw new RuntimeError('SCHEDULE_VALIDATION_FAILED', error.issues.map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '), 400);
    throw error;
  }
}

function publicDefinition(definition: ScheduleDefinition) {
  return {
    schemaVersion: definition.schemaVersion, id: definition.id, revision: definition.revision, channelBotId: definition.channelBotId,
    groupBindingId: definition.groupBindingId, name: definition.name, description: definition.description, trigger: definition.trigger,
    timezone: definition.timezone, dstPolicy: definition.dstPolicy,
    delivery: { mode: definition.delivery.mode, continuation: definition.delivery.continuation, destinationConfigured: Boolean(definition.delivery.chatRef), threadRootConfigured: Boolean(definition.delivery.rootMessageRef) },
    workspaceConfigured: Boolean(definition.cwdRef), payloadConfigured: Boolean(definition.payloadRef), identityConfigured: Boolean(definition.identityRef),
    secretRefConfigured: Boolean(definition.secretRef), sourceOwnership: definition.sourceOwnership, sourceEnabled: definition.sourceEnabled,
    state: definition.state, desiredExecutorState: definition.desiredExecutorState, currentGeneration: definition.currentGeneration,
    createdAt: definition.createdAt, updatedAt: definition.updatedAt
  };
}

export async function registerScheduleManagementRoutes(app: FastifyInstance, options: ScheduleManagementOptions = {}): Promise<void> {
  const repositories = () => {
    if (!options.repositories) throw new RuntimeError('SCHEDULE_REPOSITORY_UNWIRED', 'Schedule management repository is not wired into this runtime', 503);
    return options.repositories;
  };
  const requireWrite = async (request: FastifyRequest, action: 'schedule.create' | 'schedule.update') => {
    repositories();
    if (!options.authorize) throw new RuntimeError('SCHEDULE_PERMISSION_EVALUATOR_UNWIRED', 'Schedule management permission evaluator is not wired', 403);
    const decision = await options.authorize(request, action as PolicyAction);
    if (decision === true || (typeof decision === 'object' && decision.allowed)) return;
    throw new RuntimeError(typeof decision === 'object' ? decision.code : 'SCHEDULE_PERMISSION_DENIED', typeof decision === 'object' ? decision.reason : 'Owner/admin permission is required', 403);
  };
  const detail = async (definition: ScheduleDefinition, now?: string) => {
    const [readiness, generations, watermark] = await Promise.all([
      repositories().scheduleDefinitions.readiness(definition.id, now),
      repositories().scheduleGenerations.listByDefinition(definition.id, 20),
      repositories().scheduleWatermarks.get(definition.id)
    ]);
    return { definition: publicDefinition(definition), readiness, currentGeneration: generations.find(item => item.generation === definition.currentGeneration), watermark };
  };

  app.get('/api/foundation/schedules/capabilities', async () => capability(options));
  app.get('/api/foundation/schedules', async () => ({ capabilities: capability(options), schedules: await Promise.all((await repositories().scheduleDefinitions.list(500)).map(item => detail(item))) }));
  app.get<{ Params: { id: string } }>('/api/foundation/schedules/:id', async (request, reply) => {
    const definition = await repositories().scheduleDefinitions.get(request.params.id);
    return definition ? detail(definition) : reply.code(404).send({ error: { code: 'SCHEDULE_FOUNDATION_NOT_FOUND', message: 'ScheduleDefinition was not found' } });
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/foundation/schedules/:id/preview', async (request, reply) => {
    const query = parse(previewQuerySchema, request.query);
    const definition = await repositories().scheduleDefinitions.get(request.params.id);
    if (!definition) return reply.code(404).send({ error: { code: 'SCHEDULE_FOUNDATION_NOT_FOUND', message: 'ScheduleDefinition was not found' } });
    const value = await detail(definition, query.after);
    return { scheduleId: definition.id, preview: value.readiness.nextOccurrence, executionEligible: false, blockers: value.readiness.blockers };
  });
  app.post('/api/foundation/schedules', async (request, reply) => {
    await requireWrite(request, 'schedule.create');
    const body = parse(createBodySchema, request.body);
    const definition = await repositories().scheduleDefinitions.create({ ...body, sourceOwnership: 'dockmux', sourceNamespace: `dockmux:${body.channelBotId}`, sourceEnabled: false });
    return reply.code(201).send(await detail(definition));
  });
  app.patch<{ Params: { id: string } }>('/api/foundation/schedules/:id', async (request, reply) => {
    await requireWrite(request, 'schedule.update');
    const body = parse(updateScheduleDefinitionInputSchema, request.body);
    try { return await detail(await repositories().scheduleDefinitions.update(request.params.id, body)); }
    catch (error) {
      if (error instanceof RuntimeError && error.code === 'SCHEDULE_REVISION_CONFLICT') {
        const current = await repositories().scheduleDefinitions.get(request.params.id);
        return reply.code(409).send({ error: { code: error.code, message: error.message }, current: current ? await detail(current) : undefined });
      }
      throw error;
    }
  });
  app.get<{ Querystring: { channelBotId: string } }>('/api/foundation/schedules/archived-integrations', async request => {
    const query = parse(integrationQuerySchema, request.query);
    return { integrations: await repositories().archivedHammerIntegrations.listByChannelBot(query.channelBotId, 100) };
  });
}
