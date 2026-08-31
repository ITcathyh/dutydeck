import type { FastifyRequest } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import {
  createFailClosedPolicyEvaluator,
  evaluatePolicyAction,
  resolveGroupEffectiveConfig,
  type PolicyAction,
  type PolicyDecision,
  type PolicyEvaluator,
  type RepositoryBundle,
  type Session,
} from '@dockmux/shared';
import { extractBearerToken, extractCookie, isLoopbackHost, tokensEqual } from './auth/auth.js';

export const installationOwnerPrincipalId = 'principal_installation_owner';
export const foundationGroupBindingSessionSource = 'foundation_group_binding';

export type InstallationPrincipalAuthentication =
  | 'trusted_devhost_no_auth'
  | 'trusted_loopback'
  | 'verified_access_token';

export interface InstallationOwnerPrincipal {
  id: typeof installationOwnerPrincipalId;
  kind: 'installation_owner';
  role: 'admin';
  isOwner: true;
  isChatMember: false;
  authentication: InstallationPrincipalAuthentication;
}

type RequestWithHeaders = { headers: IncomingHttpHeaders };

export interface InstallationPrincipalResolverOptions {
  authEnabled: boolean;
  mode: 'local' | 'token' | 'open';
  getToken: () => Promise<string | null>;
}

const installationOwner = (authentication: InstallationPrincipalAuthentication): InstallationOwnerPrincipal => ({
  id: installationOwnerPrincipalId,
  kind: 'installation_owner',
  role: 'admin',
  isOwner: true,
  isChatMember: false,
  authentication,
});

/**
 * Resolve the Web management identity without an anonymous fallback.
 *
 * Explicit --no-auth is the trusted-devhost deployment selected by the user,
 * so it receives a clearly named installation owner. Token mode independently
 * verifies the presented credential even though the HTTP middleware has
 * already authenticated the request. Loopback keeps the existing trusted-local
 * deployment semantics and remains distinguishable in audit/debug output.
 */
export function createInstallationPrincipalResolver(options: InstallationPrincipalResolverOptions) {
  return async (request: RequestWithHeaders): Promise<InstallationOwnerPrincipal | undefined> => {
    if (!options.authEnabled) return installationOwner('trusted_devhost_no_auth');
    if (options.mode === 'local') {
      return isLoopbackHost(request.headers.host) ? installationOwner('trusted_loopback') : undefined;
    }
    if (options.mode !== 'token') return undefined;
    const presented = extractBearerToken(request.headers.authorization) ?? extractCookie(request.headers.cookie);
    if (!presented) return undefined;
    const expected = await options.getToken();
    return expected && tokensEqual(presented, expected) ? installationOwner('verified_access_token') : undefined;
  };
}

const managementChannelBot = { id: 'installation_management', state: 'staged' as const };

export function createFoundationManagementAuthorizer(
  resolvePrincipal: ReturnType<typeof createInstallationPrincipalResolver>,
  evaluator: PolicyEvaluator = evaluatePolicyAction,
) {
  const failClosedEvaluator = createFailClosedPolicyEvaluator(evaluator);
  return async (request: FastifyRequest, action: PolicyAction): Promise<PolicyDecision> => {
    const principal = await resolvePrincipal(request);
    return failClosedEvaluator({
      action,
      now: new Date().toISOString(),
      principal: principal ? {
        id: principal.id,
        channelBotId: managementChannelBot.id,
        isOwner: principal.isOwner,
        isChatMember: principal.isChatMember,
      } : undefined,
      channelBot: managementChannelBot,
      assignments: [],
      target: { channelBotId: managementChannelBot.id },
    });
  };
}

export type FoundationExecutionBoundary = 'listener' | 'session' | 'terminal' | 'high_risk' | 'group_tools';
export type FoundationExecutionIntegration = 'managed_group_binding' | 'legacy_lark' | 'legacy_web';

export type FoundationExecutionDecision = PolicyDecision & {
  boundary: FoundationExecutionBoundary;
  integrationMode: 'managed_group_binding' | 'legacy_unmanaged';
};

export interface FoundationExecutionRequest {
  boundary: FoundationExecutionBoundary;
  integration: FoundationExecutionIntegration;
  action: PolicyAction;
  request?: RequestWithHeaders;
  channelBotId?: string;
  groupBindingId?: string;
  principal?: { id: string; isOwner: boolean; isChatMember: boolean };
  runOwnerPrincipalId?: string;
  sessionGroupTools?: { read: boolean; discover: boolean; send: boolean };
}

type FoundationExecutionRepositories = Pick<RepositoryBundle,
  'sessions' | 'secretRefs' | 'channelBots' | 'channelBotPolicies' | 'groupBindings' | 'roleAssignments'>;

const integrationDecision = (
  request: Pick<FoundationExecutionRequest, 'action' | 'boundary'>,
  allowed: boolean,
  code: string,
  reason: string,
  integrationMode: FoundationExecutionDecision['integrationMode'],
): FoundationExecutionDecision => ({
  allowed,
  action: request.action,
  code,
  reason,
  source: 'integration',
  boundary: request.boundary,
  integrationMode,
});

/**
 * One adapter for every new GroupBinding execution edge. Existing Lark/Web
 * execution is explicitly classified as legacy_unmanaged and returned before
 * repository/evaluator lookup, so staged records can never silently alter the
 * legacy runtime. The managed branch is fail-closed on every unresolved link.
 */
export function createFoundationExecutionAuthorizer(
  repositories: FoundationExecutionRepositories,
  resolvePrincipal: ReturnType<typeof createInstallationPrincipalResolver>,
  evaluator: PolicyEvaluator = evaluatePolicyAction,
) {
  const failClosedEvaluator = createFailClosedPolicyEvaluator(evaluator);

  const authorize = async (request: FoundationExecutionRequest): Promise<FoundationExecutionDecision> => {
    if (request.integration !== 'managed_group_binding') {
      return integrationDecision(
        request,
        true,
        'legacy_unmanaged',
        'Legacy execution remains isolated from the GroupBinding permission domain',
        'legacy_unmanaged',
      );
    }
    if (!request.groupBindingId) {
      return integrationDecision(request, false, 'group_binding_context_unresolved', 'A managed execution requires an explicit GroupBinding identity', 'managed_group_binding');
    }
    const binding = await repositories.groupBindings.get(request.groupBindingId);
    if (!binding) {
      return integrationDecision(request, false, 'group_binding_not_found', 'The managed GroupBinding does not exist', 'managed_group_binding');
    }
    if (request.channelBotId && binding.channelBotId !== request.channelBotId) {
      return integrationDecision(request, false, 'scope_mismatch', 'The GroupBinding does not belong to the requested ChannelBot', 'managed_group_binding');
    }
    const channelBot = await repositories.channelBots.get(binding.channelBotId);
    if (!channelBot) {
      return integrationDecision(request, false, 'channel_bot_not_found', 'The managed ChannelBot does not exist', 'managed_group_binding');
    }

    // WP1b intentionally has no activation transition. Even a configured
    // SecretRef cannot substitute for identity preflight and an owned listener
    // lease, so listener creation is always blocked here.
    if (request.boundary === 'listener') {
      const secretRef = channelBot.credentialRef ? await repositories.secretRefs.get(channelBot.credentialRef) : undefined;
      const missing = [
        ...(!secretRef || secretRef.status !== 'configured' ? ['secret_ref'] : []),
        'identity_preflight',
        'listener_lease',
      ];
      return integrationDecision(request, false, 'channel_bot_activation_blocked', `ChannelBot activation prerequisites are unavailable: ${missing.join(', ')}`, 'managed_group_binding');
    }

    const [policy, assignments, resolvedInstallationPrincipal] = await Promise.all([
      repositories.channelBotPolicies.getByChannelBot(channelBot.id),
      repositories.roleAssignments.listByChannelBot(channelBot.id, 500),
      request.principal || !request.request ? Promise.resolve(undefined) : resolvePrincipal(request.request),
    ]);
    const principal = request.principal ?? resolvedInstallationPrincipal;
    const decision = failClosedEvaluator({
      action: request.action,
      now: new Date().toISOString(),
      principal: principal ? {
        id: principal.id,
        channelBotId: channelBot.id,
        isOwner: principal.isOwner,
        isChatMember: principal.isChatMember,
      } : undefined,
      channelBot: { id: channelBot.id, state: channelBot.state },
      binding,
      effectiveConfig: resolveGroupEffectiveConfig(policy, binding),
      assignments,
      target: {
        channelBotId: channelBot.id,
        groupBindingId: binding.id,
        ...(request.runOwnerPrincipalId ? { runOwnerPrincipalId: request.runOwnerPrincipalId } : {}),
      },
      sessionGroupTools: request.sessionGroupTools,
    });
    if (decision.allowed) {
      return integrationDecision(
        request,
        false,
        'channel_bot_disabled',
        'The staged/disabled ChannelBot has no production execution integration',
        'managed_group_binding',
      );
    }
    return { ...decision, boundary: request.boundary, integrationMode: 'managed_group_binding' };
  };

  const authorizeSession = async (
    session: Pick<Session, 'source' | 'sourceId'> | undefined,
    request: Omit<FoundationExecutionRequest, 'integration' | 'channelBotId' | 'groupBindingId'>,
  ) => {
    if (session?.source !== foundationGroupBindingSessionSource) {
      return authorize({ ...request, integration: session?.source === 'lark' ? 'legacy_lark' : 'legacy_web' });
    }
    return authorize({
      ...request,
      integration: 'managed_group_binding',
      groupBindingId: session.sourceId,
    });
  };

  const authorizeSessionId = async (
    sessionId: string,
    request: Omit<FoundationExecutionRequest, 'integration' | 'channelBotId' | 'groupBindingId'>,
  ) => authorizeSession(await repositories.sessions.get(sessionId), request);

  return { authorize, authorizeSession, authorizeSessionId };
}
