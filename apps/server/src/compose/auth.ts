import { accessMode } from '../access-policy.js';
import { DutydeckRuntime } from '@dutydeck/runtime';
import type { PolicyAction, PolicyDecision, Session } from '@dutydeck/shared';
import { WorkItemService } from '../work-items.js';
import { getAuthToken, getPasswordHash, getShareLinkSecret, loadOrCreateAuthToken, loadOrCreateShareLinkSecret, SHARE_TOKEN_QUERY_KEY, signSessionShareToken, signTurnDiffToken, tokensEqual, verifyBrowserSession } from '../auth/auth.js';
import { TURN_DIFF_LINK_TTL_MS } from '../turn-diff.js';
import { createFoundationExecutionAuthorizer, createFoundationManagementAuthorizer, createInstallationPrincipalResolver } from '../foundation-policy.js';
import { createPluginManagementAuthorizer } from '../plugins/management-auth.js';
import type { ComposeContext } from './context.js';
import type { LarkGroupManager } from '../lark/group-management.js';

type Signers = typeof import('../lark/detail-link.js');
export async function composeAuth({ config, repos, lifecycle }: ComposeContext,
  { setLarkSessionShareSigner, setLarkTurnDiffSigner }: Pick<Signers, 'setLarkSessionShareSigner' | 'setLarkTurnDiffSigner'>) {
  // 访问认证：默认启动时确保 token 存在。首次生成时只提示查看命令，token 本身不进日志。
  // 走 stderr 而非 stdout——daemon 子进程的 stdout 承载 daemon 协议的 JSON 输出，不能污染；
  // daemon 模式下 stderr 与 stdout 一起重定向到 dutydeck.log，前台模式下直接可见。
  const mode = accessMode(config);
  let activeToken = '';
  let activePasswordHash: string | null = null;
  let tokenRefresh: ReturnType<typeof setInterval> | undefined;
  if (config.authEnabled) {
    const { token: accessToken, created: tokenCreated } = await loadOrCreateAuthToken(repos.config);
    activeToken = accessToken;
    activePasswordHash = await getPasswordHash(repos.config);
    if (tokenCreated) {
      process.stderr.write(`[dutydeck] Generated an access token for remote access. Run 'dutydeck auth token' to view it, or 'dutydeck auth token --rotate' to rotate it.\n`);
    }
    // WS 升级认证是同步钩子，token 和访问密码又可能在另一个进程里被轮换、重设，
    // 所以维护一份短周期刷新的缓存（HTTP 中间件每次请求直读 DB，不受此缓存影响）。
    tokenRefresh = setInterval(() => {
      getAuthToken(repos.config).then(current => { if (current) activeToken = current; }).catch(() => {});
      getPasswordHash(repos.config).then(current => { activePasswordHash = current; }).catch(() => {});
    }, 5_000);
    tokenRefresh.unref();
    lifecycle.onSetupFailure(() => { if (tokenRefresh) clearInterval(tokenRefresh); });
  } else {
    process.stderr.write('[dutydeck] WARNING: authentication is disabled. Everyone who can reach this address can view tasks, control Agents, and access terminals. Use only on a trusted network or behind upstream authentication.\n');
  }
  // 飞书卡片的「查看详情」指向只读分享页，链接带绑定会话的签名（lark/detail-link.ts）。
  // 签名密钥可能被 `dutydeck auth share-key rotate` 在另一个进程轮换，卡片签名用短周期刷新的缓存，校验每次直读 DB。
  let activeShareSecret = await loadOrCreateShareLinkSecret(repos.config);
  const shareSecretRefresh = setInterval(() => {
    getShareLinkSecret(repos.config).then(current => { if (current) activeShareSecret = current; }).catch(() => {});
  }, 5_000);
  shareSecretRefresh.unref();
  const disposeShareSigner = setLarkSessionShareSigner(sessionId => signSessionShareToken(activeShareSecret, sessionId));
  const disposeTurnDiffSigner = setLarkTurnDiffSigner((sessionId, taskId) => signTurnDiffToken(activeShareSecret, sessionId, taskId, Date.now() + TURN_DIFF_LINK_TTL_MS));
  const stopSigning = () => { clearInterval(shareSecretRefresh); disposeShareSigner(); disposeTurnDiffSigner(); };
  lifecycle.onSetupFailure(stopSigning);
  const resolveInstallationPrincipal = createInstallationPrincipalResolver({
    authEnabled: config.authEnabled,
    mode,
    getToken: () => config.authEnabled ? getAuthToken(repos.config) : Promise.resolve(null),
    getPasswordHash: () => getPasswordHash(repos.config),
  });
  const authorizeInstallationManagement = createPluginManagementAuthorizer({
    authEnabled: config.authEnabled, mode,
    getToken: () => config.authEnabled ? getAuthToken(repos.config) : Promise.resolve(null),
    getPasswordHash: () => getPasswordHash(repos.config),
  });
  const foundationManagementAuthorizer = createFoundationManagementAuthorizer(resolveInstallationPrincipal);
  const foundationExecution = createFoundationExecutionAuthorizer(repos, resolveInstallationPrincipal);
  const legacyExecutionPolicy = {
    integrationMode: 'legacy_unmanaged' as const,
    authorize: (boundary: 'listener' | 'session' | 'high_risk' | 'group_tools', action: PolicyAction) => foundationExecution.authorize({
      integration: 'legacy_lark',
      boundary,
      action,
    }),
  };
  const httpAuth = { mode, getToken: () => config.authEnabled ? getAuthToken(repos.config) : Promise.resolve(null),
    getPasswordHash: () => getPasswordHash(repos.config), getShareSecret: () => getShareLinkSecret(repos.config), localOnly: mode === 'local' };
  const terminalAuth = { mode, allowUnauthenticated: mode === 'local', check: (presented: string | undefined) => !!presented && (tokensEqual(presented, activeToken) || verifyBrowserSession(presented, activePasswordHash)) };
  const stop = () => { if (tokenRefresh) clearInterval(tokenRefresh); stopSigning(); };
  lifecycle.beforeStop('http', stop);
  return { resolveInstallationPrincipal, authorizeInstallationManagement, foundationManagementAuthorizer, foundationExecution, legacyExecutionPolicy, httpAuth, terminalAuth };
}

export function sessionAuthorization(runtime: DutydeckRuntime, workItems: WorkItemService, groupManager: LarkGroupManager,
  { authorizeInstallationManagement, foundationExecution }: Awaited<ReturnType<typeof composeAuth>>) {
  const authorizeSessionRequest = async (request: import('fastify').FastifyRequest | import('node:http').IncomingMessage, sessionId: string, boundary: 'session' | 'high_risk' | 'terminal', action: PolicyAction): Promise<PolicyDecision> =>
    authorizeLoadedSession(request, sessionId, await runtime.getSession(sessionId), boundary, action);
  /** List routes check every session per poll; one listSessions replaces a getSession per id. */
  const authorizeSessionRequests = async (request: import('fastify').FastifyRequest, sessionIds: string[], boundary: 'session' | 'high_risk', action: PolicyAction, listed?: Session[]): Promise<PolicyDecision[]> => {
    // A route that already listed sessions passes them in, so the list is read once per request.
    const sessions = new Map((listed ?? await runtime.listSessions()).map(session => [session.id, session]));
    return Promise.all(sessionIds.map(sessionId => authorizeLoadedSession(request, sessionId, sessions.get(sessionId), boundary, action)));
  };
  const authorizeLoadedSession = async (request: import('fastify').FastifyRequest | import('node:http').IncomingMessage, sessionId: string, session: Session | undefined, boundary: 'session' | 'high_risk' | 'terminal', action: PolicyAction): Promise<PolicyDecision> => {
    if (session?.source === 'work_item') {
      const binding = await workItems.parentForSession(sessionId);
      if (!binding || !['task.view_result', 'terminal.read'].includes(action)) return { allowed: false, action, code: 'WORK_ITEM_MANAGED_SESSION', reason: '此会话由目标编排管理，请在目标中操作步骤', source: 'integration' };
      sessionId = binding.parentSessionId;
    }
    const decision = await groupManager.authorizeSession(sessionId, action, true) ?? await foundationExecution.authorizeSessionId(sessionId, { boundary, action, request });
    if (!decision.allowed) return decision;
    // A policy's origin does not authenticate the HTTP caller, including legacy integrations.
    const owner = !new URL(request.url ?? '', 'http://dutydeck.local').searchParams.has(SHARE_TOKEN_QUERY_KEY)
      && await authorizeInstallationManagement(request);
    return { ...decision, source: owner ? 'owner' : decision.source === 'owner' ? 'integration' : decision.source };
  };
  return { authorizeSessionRequest, authorizeSessionRequests };
}
