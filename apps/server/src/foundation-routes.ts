import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import {
  RuntimeError,
  createChannelBotGroupPolicyInputSchema,
  createGroupBindingInputSchema,
  createRemoteChatFactInputSchema,
  createRoleAssignmentInputSchema,
  resolveGroupEffectiveConfig,
  roleAssignmentSchema,
  toPublicChannelBotFoundation,
  updateChannelBotGroupPolicyInputSchema,
  updateGroupBindingInputSchema,
  updateRemoteChatFactInputSchema,
  updateRoleAssignmentInputSchema,
  type ChannelBotGroupPolicy,
  type ChannelBotFoundation,
  type GroupBinding,
  type PolicyAction,
  type PolicyDecision,
  type RemoteChatFact,
  type RepositoryBundle,
  type SecretRefAvailability,
  type SecretRefMetadata,
  type RoleAssignment
} from '@dockmux/shared';

export type FoundationManagementRepositories = Pick<RepositoryBundle,
  'secretRefs' | 'channelBots' | 'channelBotPolicies' | 'groupBindings' | 'remoteChatFacts' | 'roleAssignments' | 'groupPolicy'>;

export interface FoundationManagementOptions {
  isLiveManagedBot?: (channelBotId: string) => Promise<boolean>;
  repositories?: FoundationManagementRepositories;
  authorize?: (request: FastifyRequest, action: PolicyAction) => boolean | PolicyDecision | Promise<boolean | PolicyDecision>;
  /** Metadata-only inspection. This surface must never receive a value resolver. */
  inspectSecretRef?: (metadata: SecretRefMetadata) => SecretRefAvailability | Promise<SecretRefAvailability>;
}

const createBotBodySchema = z.object({
  id: z.string().min(1),
  externalAppId: z.string().min(1),
  displayName: z.string().min(1),
  brand: z.enum(['feishu', 'lark']),
  credentialRef: z.string().min(1).optional()
}).strict();
const updateBotBodySchema = z.object({
  expectedRevision: z.number().int().positive(),
  externalAppId: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  brand: z.enum(['feishu', 'lark']).optional(),
  credentialRef: z.string().min(1).nullable().optional(),
  state: z.enum(['staged', 'disabled']).optional()
}).strict().refine(value => Object.keys(value).some(key => key !== 'expectedRevision'), { message: 'At least one field must be updated' });

function capability(options: FoundationManagementOptions) {
  const repositoriesWired = Boolean(options.repositories);
  const permissionEvaluatorWired = Boolean(options.authorize);
  const secretInspectorWired = Boolean(options.inspectSecretRef);
  const blockers = [
    ...(!repositoriesWired ? [{ code: 'foundation_repository_unwired', message: '群策略仓储尚未接入运行时', action: '由 WP1b 注入 RepositoryBundle' }] : []),
    ...(!permissionEvaluatorWired ? [{ code: 'permission_evaluator_unwired', message: '管理权限解析尚未接入运行时', action: '由 WP1b 注入 owner/admin principal resolver' }] : []),
    ...(!secretInspectorWired ? [{ code: 'secret_inspector_unwired', message: 'SecretRef 文件可用性检查尚未接入', action: '注入 metadata-only SecretRef inspector' }] : []),
    { code: 'production_execution_unwired', message: '生产消息与执行入口尚未接入', action: '等待 WP1b 执行入口接线' }
  ];
  return {
    schemaVersion: 1 as const,
    repositoriesWired,
    permissionEvaluatorWired,
    secretInspectorWired,
    runtimeWired: false as const,
    writesEnabled: repositoriesWired && permissionEvaluatorWired,
    readiness: !repositoriesWired ? 'repository_unwired' as const : !permissionEvaluatorWired ? 'permission_unwired' as const : !secretInspectorWired ? 'secret_inspector_unwired' as const : 'offline_management_ready' as const,
    blockers
  };
}

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  try { return schema.parse(input); }
  catch (error) {
    if (error instanceof ZodError) throw new RuntimeError('FOUNDATION_VALIDATION_FAILED', error.issues.map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '), 400);
    throw error;
  }
}

function publicPolicy(policy: ChannelBotGroupPolicy) {
  return {
    schemaVersion: policy.schemaVersion, id: policy.id, revision: policy.revision, channelBotId: policy.channelBotId,
    defaults: policy.defaults, routingDefaults: policy.routingDefaults, accessPolicy: policy.accessPolicy,
    groupToolsPolicy: policy.groupToolsPolicy, createdAt: policy.createdAt, updatedAt: policy.updatedAt
  };
}
function publicBinding(binding: GroupBinding) {
  return {
    schemaVersion: binding.schemaVersion, id: binding.id, revision: binding.revision, channelBotId: binding.channelBotId,
    externalChatId: binding.externalChatId, state: binding.state, oncall: binding.oncall, agentOverride: binding.agentOverride,
    workspaceOverride: binding.workspaceOverride, modelOverride: binding.modelOverride, reasoningOverride: binding.reasoningOverride,
    rolePolicyOverride: binding.rolePolicyOverride, routingOverride: binding.routingOverride, accessOverride: binding.accessOverride,
    groupToolsOverride: binding.groupToolsOverride, presentationOverride: binding.presentationOverride, reviewReasons: binding.reviewReasons,
    createdAt: binding.createdAt, updatedAt: binding.updatedAt
  };
}
function publicFact(fact: RemoteChatFact) {
  return {
    schemaVersion: fact.schemaVersion, id: fact.id, revision: fact.revision, channelBotId: fact.channelBotId,
    externalChatId: fact.externalChatId, membershipState: fact.membershipState, chatType: fact.chatType,
    displayName: fact.displayName, observedAt: fact.observedAt, lastSuccessAt: fact.lastSuccessAt,
    errorCode: fact.errorCode, createdAt: fact.createdAt, updatedAt: fact.updatedAt
  };
}
function publicRole(role: RoleAssignment) {
  return {
    schemaVersion: role.schemaVersion, id: role.id, revision: role.revision, channelBotId: role.channelBotId,
    groupBindingId: role.groupBindingId, principalId: role.principalId, role: role.role, operateScope: role.operateScope,
    actionGates: role.actionGates, state: role.state, expiresAt: role.expiresAt, createdAt: role.createdAt, updatedAt: role.updatedAt
  };
}
function publicSecretRef(metadata: SecretRefMetadata, availability: SecretRefAvailability) {
  return {
    schemaVersion: metadata.schemaVersion, id: metadata.id, revision: metadata.revision,
    kind: metadata.kind, provider: metadata.provider, referenceKey: metadata.referenceKey,
    status: metadata.status, availability, createdAt: metadata.createdAt, updatedAt: metadata.updatedAt
  };
}

export async function registerFoundationManagementRoutes(app: FastifyInstance, options: FoundationManagementOptions = {}): Promise<void> {
  const repositories = () => {
    if (!options.repositories) throw new RuntimeError('FOUNDATION_REPOSITORY_UNWIRED', 'Foundation management repository is not wired into this runtime', 503);
    return options.repositories;
  };
  const requireWrite = async (request: FastifyRequest, action: PolicyAction) => {
    repositories();
    if (!options.authorize) throw new RuntimeError('FOUNDATION_PERMISSION_EVALUATOR_UNWIRED', 'Foundation management permission evaluator is not wired', 403);
    const decision = await options.authorize(request, action);
    if (decision === true || (typeof decision === 'object' && decision.allowed)) {
      if (options.isLiveManagedBot) {
        const body = request.body as { channelBotId?: string } | undefined;
        const id = (request.params as { id?: string }).id;
        let botId = body?.channelBotId;
        const route = request.routeOptions.url ?? '';
        if (id && route.includes('/channel-bots/')) botId = id;
        if (id && route.includes('/channel-bot-policies/')) botId = (await repositories().channelBotPolicies.get(id))?.channelBotId;
        if (id && route.includes('/group-bindings/')) botId = (await repositories().groupBindings.get(id))?.channelBotId;
        if (id && route.includes('/role-assignments/')) botId = (await repositories().roleAssignments.get(id))?.channelBotId;
        if (id && route.includes('/remote-chat-facts/')) botId = (await repositories().remoteChatFacts.get(id))?.channelBotId;
        if (botId && await options.isLiveManagedBot(botId)) throw new RuntimeError('LARK_LIVE_MANAGEMENT_REQUIRED', '此 Bot 已接入群配置，请在机器人或群聊页面修改，以同步校验并应用到运行时。', 409);
      }
      return;
    }
    const code = typeof decision === 'object' ? decision.code : 'FOUNDATION_PERMISSION_DENIED';
    const reason = typeof decision === 'object' ? decision.reason : 'Owner/admin permission is required';
    throw new RuntimeError(code, reason, 403);
  };
  const conflict = async <T>(error: unknown, load: () => Promise<T | undefined>, serialize: (value: T) => unknown) => {
    if (error instanceof RuntimeError && error.code === 'FOUNDATION_REVISION_CONFLICT') {
      const current = await load();
      return { statusCode: 409, body: { error: { code: error.code, message: error.message }, current: current ? serialize(current) : undefined } };
    }
    throw error;
  };

  app.get('/api/foundation/capabilities', async () => capability(options));
  app.get('/api/foundation/secret-refs', async () => {
    const refs = await repositories().secretRefs.list();
    return {
      secretRefs: await Promise.all(refs.map(async ref => publicSecretRef(ref, options.inspectSecretRef ? await options.inspectSecretRef(ref) : 'unchecked')))
    };
  });
  app.get('/api/foundation/group-matrix', async () => {
    const repos = repositories();
    const bots = await repos.channelBots.list();
    return {
      capabilities: capability(options),
      bots: await Promise.all(bots.map(async bot => {
        const [policy, bindings, facts, roles, secretRef] = await Promise.all([
          repos.channelBotPolicies.getByChannelBot(bot.id),
          repos.groupBindings.listByChannelBot(bot.id, 500),
          repos.remoteChatFacts.listByChannelBot(bot.id, 500),
          repos.roleAssignments.listByChannelBot(bot.id, 500),
          bot.credentialRef ? repos.secretRefs.get(bot.credentialRef) : Promise.resolve(undefined)
        ]);
        const bindingByChat = new Map(bindings.map(binding => [binding.externalChatId, binding]));
        const factByChat = new Map(facts.map(fact => [fact.externalChatId, fact]));
        const chatIds = [...new Set([...bindingByChat.keys(), ...factByChat.keys()])].sort();
        const secretAvailability = secretRef && options.inspectSecretRef ? await options.inspectSecretRef(secretRef) : 'unchecked';
        const publicBot = toPublicChannelBotFoundation(bot, secretRef, secretAvailability);
        return {
          bot: publicBot,
          policy: policy ? publicPolicy(policy) : undefined,
          cells: chatIds.map(externalChatId => {
            const binding = bindingByChat.get(externalChatId);
            const fact = factByChat.get(externalChatId);
            const effective = binding ? resolveGroupEffectiveConfig(policy, binding) : undefined;
            const scopedRoles = roles.filter(role => !role.groupBindingId || role.groupBindingId === binding?.id).filter(role => role.state === 'active');
            const blockers = [
              ...publicBot.blockerCodes.map(code => ({
                code,
                action: code === 'channel_bot_credential_required'
                  ? '选择 SecretRef'
                  : code === 'channel_bot_credential_unreadable'
                    ? '运行 dockmux secret list 检查并 rotate'
                    : '等待 WP1b 接入运行时'
              })),
              ...(!binding ? [{ code: 'group_binding_missing', action: '配置此群' }] : binding.state !== 'staged' && binding.state !== 'disabled' ? [{ code: `group_binding_${binding.state}`, action: '确认或修复群策略' }] : []),
              ...(fact?.membershipState && fact.membershipState !== 'member' ? [{ code: `remote_chat_${fact.membershipState}`, action: '检查 Bot 入群与读取权限' }] : [])
            ];
            return {
              externalChatId,
              remoteFact: fact ? publicFact(fact) : undefined,
              desiredPolicy: binding ? publicBinding(binding) : undefined,
              effectiveSummary: effective,
              permissionSummary: {
                talkSource: effective?.talkGrant ?? 'none',
                canTalkAssignments: scopedRoles.filter(role => role.role === 'can_talk').length,
                canOperateAssignments: scopedRoles.filter(role => role.role === 'can_operate').length,
                adminAssignments: scopedRoles.filter(role => role.role === 'admin').length,
                independentGates: {
                  terminalWrite: scopedRoles.some(role => role.actionGates.terminalWrite),
                  highRisk: scopedRoles.some(role => role.actionGates.highRisk),
                  groupToolsSend: scopedRoles.some(role => role.actionGates.groupToolsSend)
                }
              },
              severity: blockers.length ? 'blocked' : 'info',
              blockers,
              primaryAction: !binding ? { id: 'configure_group', label: '配置此群' } : { id: 'review_effective_config', label: '查看有效配置' }
            };
          })
        };
      }))
    };
  });

  app.post('/api/foundation/channel-bots', async (request, reply) => {
    await requireWrite(request, 'channel_bot.update');
    const body = parse(createBotBodySchema, request.body);
    const bot = await repositories().channelBots.create({ ...body, channel: 'lark', state: 'staged' });
    const secretRef = bot.credentialRef ? await repositories().secretRefs.get(bot.credentialRef) : undefined;
    const availability = secretRef && options.inspectSecretRef ? await options.inspectSecretRef(secretRef) : 'unchecked';
    return reply.code(201).send(toPublicChannelBotFoundation(bot, secretRef, availability));
  });
  app.patch<{ Params: { id: string } }>('/api/foundation/channel-bots/:id', async (request, reply) => {
    await requireWrite(request, 'channel_bot.update');
    const body = parse(updateBotBodySchema, request.body);
    try {
      const bot = await repositories().channelBots.update(request.params.id, body);
      const secretRef = bot.credentialRef ? await repositories().secretRefs.get(bot.credentialRef) : undefined;
      const availability = secretRef && options.inspectSecretRef ? await options.inspectSecretRef(secretRef) : 'unchecked';
      return toPublicChannelBotFoundation(bot, secretRef, availability);
    } catch (error) {
      const result = await conflict(error, () => repositories().channelBots.get(request.params.id), (bot: ChannelBotFoundation) => toPublicChannelBotFoundation(bot));
      return reply.code(result.statusCode).send(result.body);
    }
  });

  app.post('/api/foundation/channel-bot-policies', async (request, reply) => {
    await requireWrite(request, 'channel_bot.update');
    return reply.code(201).send(publicPolicy(await repositories().channelBotPolicies.create(parse(createChannelBotGroupPolicyInputSchema, request.body))));
  });
  app.patch<{ Params: { id: string } }>('/api/foundation/channel-bot-policies/:id', async (request, reply) => {
    await requireWrite(request, 'channel_bot.update');
    const body = parse(updateChannelBotGroupPolicyInputSchema, request.body);
    try { return publicPolicy(await repositories().channelBotPolicies.update(request.params.id, body)); }
    catch (error) { const result = await conflict(error, () => repositories().channelBotPolicies.get(request.params.id), publicPolicy); return reply.code(result.statusCode).send(result.body); }
  });

  app.post('/api/foundation/group-bindings', async (request, reply) => {
    await requireWrite(request, 'group_binding.update');
    return reply.code(201).send(publicBinding(await repositories().groupBindings.create(parse(createGroupBindingInputSchema, request.body))));
  });
  app.patch<{ Params: { id: string } }>('/api/foundation/group-bindings/:id', async (request, reply) => {
    await requireWrite(request, 'group_binding.update');
    const body = parse(updateGroupBindingInputSchema, request.body);
    try { return publicBinding(await repositories().groupBindings.update(request.params.id, body)); }
    catch (error) { const result = await conflict(error, () => repositories().groupBindings.get(request.params.id), publicBinding); return reply.code(result.statusCode).send(result.body); }
  });

  app.post('/api/foundation/remote-chat-facts', async (request, reply) => {
    await requireWrite(request, 'channel_bot.update');
    return reply.code(201).send(publicFact(await repositories().remoteChatFacts.create(parse(createRemoteChatFactInputSchema, request.body))));
  });
  app.patch<{ Params: { id: string } }>('/api/foundation/remote-chat-facts/:id', async (request, reply) => {
    await requireWrite(request, 'channel_bot.update');
    const body = parse(updateRemoteChatFactInputSchema, request.body);
    try { return publicFact(await repositories().remoteChatFacts.update(request.params.id, body)); }
    catch (error) { const result = await conflict(error, () => repositories().remoteChatFacts.get(request.params.id), publicFact); return reply.code(result.statusCode).send(result.body); }
  });

  app.post('/api/foundation/role-assignments', async (request, reply) => {
    await requireWrite(request, 'grant.create');
    return reply.code(201).send(publicRole(await repositories().roleAssignments.create(parse(createRoleAssignmentInputSchema, request.body))));
  });
  app.patch<{ Params: { id: string } }>('/api/foundation/role-assignments/:id', async (request, reply) => {
    const body = parse(updateRoleAssignmentInputSchema, request.body);
    await requireWrite(request, body.state === 'revoked' ? 'grant.revoke' : 'grant.create');
    const existing = await repositories().roleAssignments.get(request.params.id);
    if (existing) {
      const { expectedRevision: _expectedRevision, ...patch } = body;
      parse(roleAssignmentSchema, { ...existing, ...patch, revision: existing.revision + 1, expiresAt: body.expiresAt === null ? undefined : body.expiresAt ?? existing.expiresAt, updatedAt: new Date().toISOString() });
    }
    try { return publicRole(await repositories().roleAssignments.update(request.params.id, body)); }
    catch (error) { const result = await conflict(error, () => repositories().roleAssignments.get(request.params.id), publicRole); return reply.code(result.statusCode).send(result.body); }
  });
}
