import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import {
  RuntimeError,
  toPublicRemoteChatFact,
  toPublicRemoteIdentityFact,
  type PolicyAction,
  type PolicyDecision,
  type RemoteChatFact,
  type RemoteIdentityFact,
  type RepositoryBundle,
} from '@dutydeck/shared';
import { IdentityPreflightError, LarkIdentityPreflightProbe, type LarkIdentityPreflightEvidence } from './lark/identity-preflight.js';

export type IdentityPreflightRepositories = Pick<RepositoryBundle,
  'secretRefs' | 'channelBots' | 'groupBindings' | 'remoteIdentityFacts' | 'remoteChatFacts' | 'remoteFacts'>;

export interface IdentityPreflightRouteOptions {
  repositories?: IdentityPreflightRepositories;
  probe?: LarkIdentityPreflightProbe;
  authorize?: (request: FastifyRequest, action: PolicyAction) => boolean | PolicyDecision | Promise<boolean | PolicyDecision>;
  now?: () => Date;
}

const runBodySchema = z.object({
  groupBindingIds: z.array(z.string().min(1)).max(100).optional(),
}).strict().superRefine((value, context) => {
  if (value.groupBindingIds && new Set(value.groupBindingIds).size !== value.groupBindingIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['groupBindingIds'], message: 'GroupBinding IDs must be unique' });
  }
});

function stableFactId(prefix: 'remote_identity' | 'remote_chat', naturalKey: string): string {
  return `${prefix}_${createHash('sha256').update(naturalKey).digest('hex').slice(0, 24)}`;
}

function safeParse(input: unknown) {
  try { return runBodySchema.parse(input ?? {}); }
  catch (error) {
    if (error instanceof ZodError) {
      throw new RuntimeError('IDENTITY_PREFLIGHT_VALIDATION_FAILED', error.issues.map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '), 400);
    }
    throw error;
  }
}

function isAllowed(decision: boolean | PolicyDecision): boolean {
  return decision === true || (typeof decision === 'object' && decision.allowed);
}

async function currentPublicState(repositories: IdentityPreflightRepositories, channelBotId: string, now: Date) {
  const [identity, facts, bindings] = await Promise.all([
    repositories.remoteIdentityFacts.getByChannelBot(channelBotId),
    repositories.remoteChatFacts.listByChannelBot(channelBotId, 500),
    repositories.groupBindings.listByChannelBot(channelBotId, 500),
  ]);
  const bindingByChat = new Map(bindings.map(binding => [binding.externalChatId, binding.id]));
  const publicIdentity = identity ? toPublicRemoteIdentityFact(identity, now) : undefined;
  const chatFacts = facts.flatMap(fact => {
    const groupBindingId = bindingByChat.get(fact.externalChatId);
    return groupBindingId ? [{ groupBindingId, fact: toPublicRemoteChatFact(fact, identity, now) }] : [];
  });
  const blockerCodes = [
    ...(!publicIdentity ? ['IDENTITY_PREFLIGHT_REQUIRED'] : publicIdentity.validity === 'valid' ? [] : [`IDENTITY_PREFLIGHT_${publicIdentity.validity.toUpperCase()}`]),
    ...chatFacts.flatMap(({ fact }) => fact.errorCode ? [fact.errorCode] : fact.membershipState !== 'member'
      ? [fact.errorCode ?? `IDENTITY_PREFLIGHT_CHAT_${fact.membershipState.toUpperCase()}`]
      : fact.validity === 'valid' ? [] : [`IDENTITY_PREFLIGHT_CHAT_${fact.validity.toUpperCase()}`]),
  ];
  return {
    schemaVersion: 1 as const,
    channelBotId,
    status: blockerCodes.length ? 'blocked' as const : 'passed' as const,
    identityFact: publicIdentity,
    chatFacts,
    blockerCodes: [...new Set(blockerCodes)],
    activationChanged: false as const,
    listenerReadiness: 'blocked' as const,
    remainingBlockers: ['listener_lease', 'activation_unavailable'] as const,
  };
}

function persistEvidence(
  repositories: IdentityPreflightRepositories,
  evidence: LarkIdentityPreflightEvidence,
  input: {
    credentialRefId: string;
    credentialRevision: number;
    expectedIdentity: { id?: string; revision: number };
    bindingsById: Map<string, { id: string; externalChatId: string }>;
  },
): Promise<{ identity: RemoteIdentityFact; chats: Array<{ groupBindingId: string; fact: RemoteChatFact }> }> {
  return repositories.remoteFacts.transact(transaction => {
    const identity = transaction.remoteIdentityFacts.upsert({
      id: input.expectedIdentity.id ?? stableFactId('remote_identity', evidence.channelBotId),
      expectedRevision: input.expectedIdentity.revision,
      channelBotId: evidence.channelBotId,
      credentialRefId: input.credentialRefId,
      credentialRevision: input.credentialRevision,
      credentialFingerprint: evidence.credentialFingerprint,
      appFingerprint: evidence.appFingerprint,
      botIdentityRef: evidence.botIdentityOpaqueRef,
      ...(evidence.tenantOpaqueRef ? { tenantRef: evidence.tenantOpaqueRef } : {}),
      appIdMatch: evidence.appMatch,
      checkedAt: evidence.checkedAt,
      expiresAt: evidence.expiresAt,
    });
    const chats = evidence.chatFacts.map(observation => {
      const binding = input.bindingsById.get(observation.groupBindingId);
      if (!binding) throw new RuntimeError('IDENTITY_PREFLIGHT_GROUP_BINDING_INVALID', 'A selected GroupBinding disappeared before fact persistence', 409);
      // Identity upsert invalidates facts tied to its previous revision. Load
      // the chat row afterward so this upsert CASes against that invalidation.
      const current = transaction.remoteChatFacts.getByNaturalKey(evidence.channelBotId, binding.externalChatId);
      const fact = transaction.remoteChatFacts.upsert({
        id: current?.id ?? stableFactId('remote_chat', `${evidence.channelBotId}\0${binding.externalChatId}`),
        expectedRevision: current?.revision ?? 0,
        channelBotId: evidence.channelBotId,
        externalChatId: binding.externalChatId,
        membershipState: observation.membershipState,
        chatType: observation.chatType,
        observedAt: evidence.checkedAt,
        ...(observation.membershipState === 'member' ? { lastSuccessAt: evidence.checkedAt } : current?.lastSuccessAt ? { lastSuccessAt: current.lastSuccessAt } : {}),
        ...(observation.blockerCode ? { errorCode: observation.blockerCode } : {}),
        credentialRefId: input.credentialRefId,
        credentialRevision: input.credentialRevision,
        credentialFingerprint: evidence.credentialFingerprint,
        identityFactId: identity.id,
        identityRevision: identity.revision,
        expiresAt: evidence.expiresAt,
      });
      return { groupBindingId: binding.id, fact };
    });
    return { identity, chats };
  });
}

function postPublicResult(
  evidence: LarkIdentityPreflightEvidence,
  persisted: { identity: RemoteIdentityFact; chats: Array<{ groupBindingId: string; fact: RemoteChatFact }> },
) {
  const at = new Date(evidence.checkedAt);
  return {
    schemaVersion: 1 as const,
    channelBotId: evidence.channelBotId,
    status: evidence.status,
    identityFact: toPublicRemoteIdentityFact(persisted.identity, at),
    chatFacts: persisted.chats.map(item => ({ groupBindingId: item.groupBindingId, fact: toPublicRemoteChatFact(item.fact, persisted.identity, at) })),
    blockerCodes: evidence.blockerCodes,
    appMatch: evidence.appMatch,
    tenantAppMatch: evidence.tenantAppMatch,
    checkedAt: evidence.checkedAt,
    expiresAt: evidence.expiresAt,
    activationChanged: false as const,
    listenerReadiness: 'blocked' as const,
    remainingBlockers: ['listener_lease', 'activation_unavailable'] as const,
  };
}

export async function registerIdentityPreflightRoutes(app: FastifyInstance, options: IdentityPreflightRouteOptions = {}): Promise<void> {
  const repositories = () => {
    if (!options.repositories) throw new RuntimeError('IDENTITY_PREFLIGHT_REPOSITORY_UNWIRED', 'Identity preflight repository is not wired', 503);
    return options.repositories;
  };
  const requireAdmin = async (request: FastifyRequest) => {
    repositories();
    if (!options.authorize) throw new RuntimeError('IDENTITY_PREFLIGHT_PERMISSION_UNWIRED', 'Identity preflight permission evaluator is not wired', 403);
    const decision = await options.authorize(request, 'channel_bot.update');
    if (isAllowed(decision)) return;
    throw new RuntimeError(typeof decision === 'object' ? decision.code : 'IDENTITY_PREFLIGHT_PERMISSION_DENIED', typeof decision === 'object' ? decision.reason : 'Owner/admin permission is required', 403);
  };

  app.get<{ Params: { id: string } }>('/api/foundation/channel-bots/:id/identity-preflight', async (request) => {
    await requireAdmin(request);
    const bot = await repositories().channelBots.get(request.params.id);
    if (!bot) throw new RuntimeError('FOUNDATION_NOT_FOUND', 'ChannelBot was not found', 404);
    return currentPublicState(repositories(), bot.id, options.now?.() ?? new Date());
  });

  app.post<{ Params: { id: string } }>('/api/foundation/channel-bots/:id/identity-preflight', async (request, reply) => {
    await requireAdmin(request);
    if (!options.probe) throw new RuntimeError('IDENTITY_PREFLIGHT_PROBE_UNWIRED', 'Identity preflight probe is not wired', 503);
    const body = safeParse(request.body);
    const repo = repositories();
    const bot = await repo.channelBots.get(request.params.id);
    if (!bot) throw new RuntimeError('FOUNDATION_NOT_FOUND', 'ChannelBot was not found', 404);
    const secretRef = bot.credentialRef ? await repo.secretRefs.get(bot.credentialRef) : undefined;
    const allBindings = await repo.groupBindings.listByChannelBot(bot.id, 500);
    // Capture the identity revision before the remote round trip. A concurrent
    // preflight must win explicitly; this request may not silently overwrite
    // its newer evidence after returning from Lark.
    const identitySnapshot = await repo.remoteIdentityFacts.getByChannelBot(bot.id);
    const byId = new Map(allBindings.map(binding => [binding.id, binding]));
    const bindings = body.groupBindingIds?.map(id => byId.get(id)) ?? allBindings;
    if (bindings.some(binding => !binding)) throw new RuntimeError('IDENTITY_PREFLIGHT_GROUP_BINDING_INVALID', 'A selected GroupBinding was not found for this ChannelBot', 409);

    let evidence: LarkIdentityPreflightEvidence;
    try {
      evidence = await options.probe.probe({ channelBot: bot, secretRef, groupBindings: bindings as typeof allBindings });
    } catch (error) {
      if (error instanceof IdentityPreflightError) {
        if (identitySnapshot) {
          try {
            await repo.remoteFacts.transact(transaction => transaction.remoteIdentityFacts.invalidate(identitySnapshot.id, {
              expectedRevision: identitySnapshot.revision,
              invalidatedAt: (options.now?.() ?? new Date()).toISOString(),
              errorCode: error.code,
            }));
          } catch (conflict) {
            if (conflict instanceof RuntimeError && conflict.code === 'FOUNDATION_REVISION_CONFLICT') {
              return reply.code(409).send({
                error: { code: conflict.code, message: 'Identity preflight facts changed concurrently; retry against the current state' },
                current: await currentPublicState(repo, bot.id, options.now?.() ?? new Date()),
              });
            }
            throw conflict;
          }
        }
        return reply.code(error.statusCode).send({
          error: { code: error.code, message: error.message },
          current: await currentPublicState(repo, bot.id, options.now?.() ?? new Date()),
          activationChanged: false,
          listenerReadiness: 'blocked',
        });
      }
      throw error;
    }
    if (!secretRef) throw new RuntimeError('IDENTITY_PREFLIGHT_SECRET_REF_MISSING', 'The selected SecretRef is missing', 409);
    try {
      const persisted = await persistEvidence(repo, evidence, {
        credentialRefId: secretRef.id,
        credentialRevision: secretRef.revision,
        expectedIdentity: { id: identitySnapshot?.id, revision: identitySnapshot?.revision ?? 0 },
        bindingsById: new Map((bindings as typeof allBindings).map(binding => [binding.id, { id: binding.id, externalChatId: binding.externalChatId }])),
      });
      return postPublicResult(evidence, persisted);
    } catch (error) {
      if (error instanceof RuntimeError && error.code === 'FOUNDATION_REVISION_CONFLICT') {
        return reply.code(409).send({
          error: { code: error.code, message: 'Identity preflight facts changed concurrently; retry against the current state' },
          current: await currentPublicState(repo, bot.id, options.now?.() ?? new Date()),
        });
      }
      throw error;
    }
  });
}
