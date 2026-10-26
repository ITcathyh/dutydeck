import { PluginBusinessToolService } from './plugins/tool-service.js';
import { PluginToolLedger } from './plugins/tool-ledger.js';
import { PluginToolGrants } from './plugins/tool-grants.js';
import { TaskPluginToolIdentity } from './plugins/tool-identity.js';
import { prepareBoundTaskPrompt } from './plugins/bound-skills.js';
import { PluginHost } from './plugins/host.js';
import { PluginResultService, PluginResultError } from './plugins/result-service.js';
import { PluginResultToolRegistry } from './plugins/result-tools.js';
import { LarkPluginResultAdapter } from './lark/plugin-result-delivery.js';
import { LarkPluginResultIdentity, type PluginResultIdentityOptions } from './lark/plugin-result-identity.js';
import { AgentModelSettings } from './agent-model-settings.js';
import { sessionUsageSnapshot } from './session-usage.js';
import { HerdrBackend } from '@dutydeck/session-backends';
import { TerminalSettings, primaryHerdrBinary } from './terminal-settings.js';
import { createRequire } from 'node:module';
import { HerdrSessions } from './herdr.js';
import { rememberSecretValues } from './lark/secret-redaction.js';
import { dutydeckGroupToolsCommand } from './lark/agent-tools.js';
import { resolveExplicitFinalContext } from './lark/explicit-final.js';
import { larkResultDeliveryIssues } from './lark/reconciler.js';
import { createCollaborationIntegration } from './collaboration-integration.js';
import { isAutomatedRequest } from './agent-request-tools.js';
import { LeaderDelegationService } from './leader-delegation.js';
import { renderMemoryIndex } from './lark/memory-view.js';
import type { CollaborationExtensions } from './collaboration-extensions.js';
import { LarkGroupManager } from './lark/group-management.js';
import { larkMemoryEnabled, readLarkConfigs } from './lark/config.js';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { loadConfigWithDiagnostics, type AppConfig } from '@dutydeck/config';
import { logDroppedAgents } from './agent-config-log.js';
import { assertBotProcessStartup, childProcessIdentity, createRepositories, observeProcess } from '@dutydeck/storage';
import { createPtyRetirementControl } from './pty-recovery.js';
import { COLLABORATION_LIST_LIMIT, installationOwnerTaskActor, makeId, RuntimeError, workPlanConfirmationRequired, type DriverFactory, type PolicyAction, type PolicyDecision } from '@dutydeck/shared';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { larkResourceRoot, pruneLarkResourceDirectories } from './resource-retention.js';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { parsePeerInstances } from './instance-proxy.js';
import { localLoopbackUrl } from './local-api-url.js';
import { WorkItemService } from './work-items.js';
import { WorkItemInteractions } from './work-item-interactions.js';
import { LarkWorkbench } from './lark/workbench.js';
import { createLarkCardService } from './lark/service.js';
import { createWorkbenchFetch } from './workbench-fetch.js';
import { authorizeWorkItemAgent, authorizeWorkItemInteraction, workItemRiskPolicy } from './work-item-policy.js';
import { SessionAutomationService } from './session-automation.js';
import { createAutomationIntegration } from './automation-integration.js';
import { CiWebhookService } from './ci-webhook.js';
import { PullRequestService } from './pull-requests.js';
import { CiProviderRegistry } from './ci-providers.js';
import { prepareSkillPrompt } from './skill-delivery.js';
import { readTokenEfficiencyPolicy } from './token-efficiency.js';
import { assemblePrompt, isFrozenCollaborationSession, promptDigest, promptTemplateVersion } from './prompt-context.js';
import { createRelayAskStore } from './relay-ask-store.js';
import { LarkAgentToolCapabilityRegistry, LarkAgentToolsService, loadOrCreateGroupToolsSigningSecret } from './lark/agent-tools.js';
import { larkMemoryScope, LarkMemoryStore } from './lark/memory.js';
import { LarkMemoryProjection } from './lark/memory-view.js';
import { LarkMemoryPipeline } from './lark/memory-pipeline.js';
import { getAuthToken, getPasswordHash, getShareLinkSecret, loadOrCreateAuthToken, loadOrCreateShareLinkSecret, signSessionShareToken, signTurnDiffToken, tokensEqual, verifyBrowserSession } from './auth/auth.js';
import { setLarkSessionShareSigner, setLarkTurnDiffSigner } from './lark/detail-link.js';
import { createTurnDiffObserver, TURN_DIFF_LINK_TTL_MS } from './turn-diff.js';
import { requestLarkTurnDiffReview } from './lark/turn-diff.js';
import type { TerminalStreamProvider } from './terminal/terminal-ws.js';
import {
  createDutydeckPersistentBackend,
  createPtyCliDriver,
  PTY_AGENT_CONTRIBUTIONS,
} from '@dutydeck/pty-driver';
import { claudeDataDir, codexHome, traeHome } from '@dutydeck/pty-driver';
import { childEnvironment } from '@dutydeck/shared/child-environment';
import { createCliAdapter } from '@dutydeck/cli-adapters';
import { RelayAskBroker, RelayCapabilityRegistry, RelayService, loadOrCreateRelaySigningSecret } from '@dutydeck/relay';
import { LocalFileSecretProvider, localFileSecretProviderName, secretDirectoryForDatabase } from '@dutydeck/secret-provider';
import { LarkIdentityPreflightProbe } from './lark/identity-preflight.js';
import {
  createFoundationExecutionAuthorizer,
  createFoundationManagementAuthorizer,
  createInstallationPrincipalResolver,
} from './foundation-policy.js';
import { WorkspaceOrganizationService } from './workspace-organization.js';
import { parseUsageBackgroundLimits, parseUsagePricing, UsageLedger } from './usage-ledger.js';
import { SessionInsightService } from './session-insight-service.js';
import type { SessionInsightResolver } from './session-insight-service.js';
import { SessionInsightResolver as SessionInsightResolverImpl } from './session-insight-resolver.js';
import { createTranscriptSourceKeys } from '@dutydeck/runtime';
import { loadDaemonPlugins, wirePlugins } from './plugins/service-wiring.js';
import { createPluginManagementAuthorizer } from './plugins/management-auth.js';
import { sessionHookContext } from './plugins/integration.js';
import type { StoredLarkConfig } from './lark/config.js';

export interface StartLocalServerOptions {
  pluginResultIdentity?: PluginResultIdentityOptions;
  configureCollaborationExtensions?: (extensions: CollaborationExtensions) => void;
  env?: NodeJS.ProcessEnv;
  webRoot?: string;
  groupToolsCommand?: string;
  /** Test/operator injection only; no probe runs until its explicit API call. */
  identityPreflight?: {
    fetcher?: typeof globalThis.fetch;
    baseUrlForBrand?: (brand: 'feishu' | 'lark') => string;
    now?: () => Date;
    evidenceTtlMs?: number;
  };
}
export interface LocalServer {
  config: AppConfig;
  runtime: DutydeckRuntime;
  close(): Promise<void>;
}

export function listenOptions(config: Pick<AppConfig, 'host' | 'port'>) {
  if (config.host === '0.0.0.0') {
    return { host: '::', port: config.port, ipv6Only: false } as const;
  }
  return { host: config.host, port: config.port };
}

export function accessMode(config: Pick<AppConfig, 'host' | 'authEnabled'>): 'local' | 'token' | 'open' {
  // Loopback keeps its stricter Host/Origin rebinding protection even when the
  // redundant --no-auth flag is present.
  if (config.host === '127.0.0.1' || config.host === '::1') return 'local';
  return config.authEnabled ? 'token' : 'open';
}

/** 显式确认在非回环地址上免认证运行：--unsafe-no-auth 或这个环境变量 */
export const UNSAFE_NO_AUTH_ENV = 'DUTYDECK_UNSAFE_NO_AUTH';

/**
 * 监听地址不是回环、认证又关着（open 模式）时返回拒绝启动的说明，显式确认 unsafe 时放行。
 * 第一行带 refused 且不含 password/token 字样：`dutydeck start` 只从守护日志回放这样的行。
 */
export function unauthenticatedListenRefusal(config: Pick<AppConfig, 'host' | 'authEnabled'>, env: NodeJS.ProcessEnv): string | undefined {
  if (accessMode(config) !== 'open' || env[UNSAFE_NO_AUTH_ENV] === 'true') return undefined;
  return [
    `Dutydeck refused to start: 监听地址 ${config.host} 不是本机回环地址，访问认证却已关闭，同网络任何人都能查看任务、驱动 Agent、打开终端。`,
    '先设置访问密码：dutydeck auth password set，再去掉 --no-auth（或 .env 里的 DUTYDECK_AUTH=false）重新启动；浏览器用这个密码登录，CLI 和本机调用照旧用 access token。',
    `确需在这个地址免认证运行，改用 --unsafe-no-auth 或设置 ${UNSAFE_NO_AUTH_ENV}=true。`
  ].join('\n');
}

function localApiBaseUrl(config: Pick<AppConfig, 'host' | 'port'>) {
  return localLoopbackUrl(config.host, config.port);
}

/**
 * 按当前 session 对应 agent 的子进程环境计算弱候选数据根（每次 resolve 实时算，
 * 不缓存 agent env，不持久化密钥，不扫描 HOME）。候选仅用于有界历史发现，
 * resolver 仍须内容 native id + ledger 身份证明才成 historical_verified。
 *
 * - PTY 驱动：childEnvironment(serverEnv, agent.env, { stripClaude: true })，
 *   剥离 daemon 的 ANTHROPIC_/CLAUDE_ 桥接身份；
 * - ACP/其它：childEnvironment(serverEnv, agent.env) 不 strip；
 * - 无 agent 配置：回退 serverEnv 自身（daemon 直跑场景）。
 */
function configuredRootsForSession(
  serverEnv: NodeJS.ProcessEnv,
  session: import('@dutydeck/shared').Session | undefined,
  agent: import('@dutydeck/shared').AgentConfig | undefined
): Array<{ client: 'claude' | 'codex' | 'traex'; path: string }> {
  const isPtyCli = session?.protocol === 'pty-cli';
  const childEnv = childEnvironment(
    serverEnv as Record<string, string | undefined>,
    agent?.env ?? {},
    ...(isPtyCli ? [{ stripClaude: true }] : [])
  ) as Record<string, string | undefined>;
  return [
    { client: 'claude' as const, path: claudeDataDir(childEnv) },
    { client: 'codex' as const, path: codexHome(childEnv) },
    { client: 'traex' as const, path: traeHome(childEnv) }
  ];
}

/**
 * 构造生产会话分析 resolver（静态接线，esbuild bundle 必须能静态解析）。
 * 返回 SessionInsightResolver interface 的轻量 wrapper：每次 resolve(sessionId)
 * 实时读取该 session 的 agent 配置，用 childEnvironment 合并当前 server env
 * （startLocalServer options.env 生效，不固定 process.env）与 agent.env，
 * 再调 cli-paths 三函数生成 weak candidate roots，最后 new 真实 resolver 委托。
 * 持久 observations 的历史 dataRoot 仍由 resolver 自行并入。
 */
function createInsightResolver(
  repos: ReturnType<typeof createRepositories>,
  serverEnv: NodeJS.ProcessEnv
): SessionInsightResolver {
  return {
    async resolveSessionInsightSources(sessionId, options) {
      const session = await repos.sessions.get(sessionId);
      const agent = session ? await repos.agents.get(session.agentId) : undefined;
      const configuredRoots = configuredRootsForSession(serverEnv, session ?? undefined, agent ?? undefined);
      return new SessionInsightResolverImpl({
        repositories: {
          insight: repos.insight,
          sessions: repos.sessions,
          execution: repos.execution,
          config: repos.config,
          agents: repos.agents
        },
        configuredRoots,
        // 统一 source key hash 算法来自 T3c runtime helper（包根具名导出），接线方不另复制。
        createTranscriptSourceKeys
      }).resolveSessionInsightSources(sessionId, options);
    }
  };
}

export { configuredRootsForSession, createInsightResolver };

/** Production PTY-CLI policy: persistent tmux or a hard failure, never an
 * implicit downgrade to the in-process PtyBackend. */
export function createProductionPtyBackend(sessionId: string) {
  return createDutydeckPersistentBackend(sessionId);
}

export async function startLocalServer(options: StartLocalServerOptions = {}): Promise<LocalServer> {
  // pty-cli agent 发现：PTY_AGENT_CONTRIBUTIONS 经 loadConfig 合并进 config.agents
  // （builtinAgents 内部按 commandExists 过滤，只暴露本机已安装的 CLI；可用的终端适配器优先，同 id 覆盖 ACPX）。
  // 插件在加载配置之前加载：插件 agents 要与 DUTYDECK_AGENTS_JSON 一起合并。没有启用的插件（或只有内置场景包）时为 undefined，下面不接线。
  const { host: pluginHost, scenarios } = await loadDaemonPlugins(options.env ?? process.env);
  const { config, droppedAgents, repos } = await (async () => {
    try {
      const { config, droppedAgents } = loadConfigWithDiagnostics(options.env ?? process.env, PTY_AGENT_CONTRIBUTIONS, pluginHost?.agents);
      const refusal = unauthenticatedListenRefusal(config, options.env ?? process.env);
      if (refusal) throw new Error(refusal);
      assertBotProcessStartup(config.databaseUrl, (options.env ?? process.env).DUTYDECK_BOT_APP_ID);
      const repos = createRepositories(config.databaseUrl, { mode: 'runtime', newDatabaseAuthority: 'ledger_v1' });
      return { config, droppedAgents, repos };
    } catch (error) { await pluginHost?.dispose(); throw error; }
  })();
  // 声明在 try 外：setup 失败路径与正常关闭路径都要先显式 await 分析服务关闭。
  let insightService: SessionInsightService | undefined;
  const insightCloseErrors: unknown[] = [];
  const closeInsightService = async (): Promise<void> => {
    if (!insightService) return;
    try { await insightService.close(); }
    catch (error) { insightCloseErrors.push(error); }
  };
  const setupCleanup: Array<() => unknown> = [() => pluginHost?.dispose()];
  let closeResources = async () => {
    // 初始化失败路径同样先显式关闭分析服务（拒新刷新/取消作业/清临时目录），
    // 再跑 setupCleanup 并行组与 repos.close。
    await closeInsightService();
    const results = await Promise.allSettled(setupCleanup.reverse().map(close => Promise.resolve().then(close)));
    repos.close();
    const errors = [
      ...insightCloseErrors,
      ...results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason)
    ];
    if (errors.length) throw new AggregateError(errors, 'Dutydeck setup cleanup failed');
  };
  try {
  // Recheck under the runtime claim in case an offline split completed between inspection and open.
  assertBotProcessStartup(config.databaseUrl, (options.env ?? process.env).DUTYDECK_BOT_APP_ID);
  // 发往飞书的文本按原值抹掉服务环境和各 Agent 配置里的凭据（见 lark/secret-redaction）。
  rememberSecretValues(options.env ?? process.env);
  for (const agent of [...config.agents, ...await repos.agents.list()]) rememberSecretValues(agent.env ?? {});
  let localSecretProvider: LocalFileSecretProvider | undefined;
  try {
    localSecretProvider = new LocalFileSecretProvider(secretDirectoryForDatabase(config.databaseUrl), { createDirectory: true });
  } catch {
    // In-memory/test databases cannot own a durable secret directory. The
    // metadata-only inspector remains wired and reports such refs unreadable.
  }
  const inspectSecretRef = (metadata: { provider: string; referenceKey: string }) => {
    if (metadata.provider !== localFileSecretProviderName) return 'unchecked' as const;
    return localSecretProvider?.inspect(metadata.referenceKey).availability ?? 'unreadable' as const;
  };
  const agentModelSettings = new AgentModelSettings(repos, config.agents, localSecretProvider);
  const env = options.env ?? process.env;
  const identityPreflightProbe = localSecretProvider ? new LarkIdentityPreflightProbe({
    secretProvider: localSecretProvider,
    fetcher: options.identityPreflight?.fetcher,
    baseUrlForBrand: options.identityPreflight?.baseUrlForBrand ?? (brand => env.LARK_OPEN_API_BASE_URL?.trim()
      || (brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn')),
    now: options.identityPreflight?.now,
    evidenceTtlMs: options.identityPreflight?.evidenceTtlMs,
  }) : undefined;
  let groupToolsSigningSecret: string;
  try { groupToolsSigningSecret = await loadOrCreateGroupToolsSigningSecret(repos.config); }
  catch (error) { throw error; }
  let relaySigningSecret: string;
  try { relaySigningSecret = await loadOrCreateRelaySigningSecret(repos.config); }
  catch (error) { throw error; }
  const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, localApiBaseUrl(config), groupToolsSigningSecret, options.groupToolsCommand ?? 'dutydeck');
  setupCleanup.push(() => capabilities.close());
  // 通用回传通道：与飞书无关，任何来源的会话（含 Web 工作台创建的 pty-cli）都注入凭证。
  // command 前缀复用 groupToolsCommand 算出的运行期绝对路径——静态文案拿不到它，
  // 经 env 下发后由 @dutydeck/relay 的 relayHintLines() 在提示块里读回。
  const relayCapabilities = new RelayCapabilityRegistry(
    repos.sessions,
    localApiBaseUrl(config),
    relaySigningSecret,
    options.groupToolsCommand
  );
  const herdr = new HerdrSessions({ database: config.databaseUrl, signingSecret: relaySigningSecret, botAppId: env.DUTYDECK_BOT_APP_ID, env,
    command: options.groupToolsCommand ?? dutydeckGroupToolsCommand(fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './cli.ts' : './cli.js', import.meta.url)), process.execPath, import.meta.url.endsWith('.ts') ? createRequire(import.meta.url).resolve('tsx') : undefined) });
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
    setupCleanup.push(() => { if (tokenRefresh) clearInterval(tokenRefresh); });
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
  setupCleanup.push(() => { clearInterval(shareSecretRefresh); disposeShareSigner(); disposeTurnDiffSigner(); });
  const resolveInstallationPrincipal = createInstallationPrincipalResolver({
    authEnabled: config.authEnabled,
    mode,
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
  const workbenchHttp = createWorkbenchFetch();
  setupCleanup.push(() => workbenchHttp.close());
  const groupManager: LarkGroupManager = new LarkGroupManager(repos, { env, fetcher: workbenchHttp.fetch, onPolicyChanged: (): Promise<void> => groupManager.refreshPolicies(runtime) });
  let readCollaborationMemory: (scope: import('@dutydeck/shared').CollaborationScope) => Promise<string> = async () => '';
  let collaboration: ReturnType<typeof createCollaborationIntegration> | undefined;
  const isAutomatedTask = (taskId: string) => isAutomatedRequest(repos.execution.getAcceptedTask(taskId)?.request);
  const agentTools = new LarkAgentToolsService(capabilities, repos.config, {
    env,
    groupToolsCommand: options.groupToolsCommand,
    workbenchTask: sessionId => runtime.getActiveTaskContext(sessionId),
    scheduleRequests: true,
    automatedTask: taskId => isAutomatedTask(taskId),
    finalTaskContext: async (binding, task) => resolveExplicitFinalContext(await repos.channelMappings.list(`lark-card:${binding.appId}`), binding, task),
    authorizeTool: (sessionId, action) => collaboration?.background.authorizeTool(sessionId, action) ?? Promise.resolve(),
    previewTool: (sessionId, action) => collaboration?.background.authorizeTool(sessionId, action, true) ?? Promise.resolve(),
    previewWork: (sessionId, actorId) => automationIntegration.previewAuthorize(sessionId, actorId),
    previewCollaboration: (binding, actorId) => collaboration?.previewAuthorize(binding, actorId, 'write') ?? Promise.resolve(false),
    executionPolicy: legacyExecutionPolicy,
    groupManager,
    history: repos,
    teamSearch: () => collaboration?.teamSearch,
  });
  const primaryHerdrBackend = (sessionId: string) => new HerdrBackend(herdr.nameFor(`primary:${sessionId}`), {
    binary: primaryHerdrBinary(env), stateFile: join(dirname(config.databaseUrl), 'terminal-sessions', `${herdr.nameFor(`primary:${sessionId}`)}.json`),
    ownerId: `dutydeck:${sessionId}`, processProbe: { identify: childProcessIdentity, observe: observeProcess }, env,
  });
  const terminalSettings = new TerminalSettings(repos.config, env);
  // pty-cli 协议驱动工厂：protocol='pty-cli' 的会话路由到 Dutydeck 的 PtyCliDriver。
  // 自定义命令可通过 adapterId 复用已有 CLI 家族，同时保留独立 agent id。
  const ptyDriverFactory: DriverFactory = (agent, _protocol, onEvent, onExit, sessionId, context) => {
    const adapter = createCliAdapter(agent.adapterId ?? agent.id);
    return createPtyCliDriver({
      agent,
      adapter,
      backend: agent.env.dutydeck_terminal_backend === 'herdr' ? primaryHerdrBackend(sessionId) : createProductionPtyBackend(sessionId),
      processProbe: { identify: childProcessIdentity, observe: observeProcess },
      onEvent,
      onExit,
      sessionId,
      awaitingAnswer: () => relayBroker.listPending(sessionId).length > 0,
      nativeForkSessionId: context.nativeForkSessionId,
    });
  };
  const pluginWiring = pluginHost ? wirePlugins(pluginHost, {
    runtime: () => runtime,
    repositories: repos,
    readBot: async appId => (await readLarkConfigs(repos.config)).find(bot => bot.appId === appId),
    fallbackAgentId: () => config.agents[0]?.id,
    sendText: (bot, input) => createLarkCardService(env, workbenchHttp.fetch, bot as StoredLarkConfig).sendText(input),
    log: { warn: (details, message) => app?.log.warn(details, message) }
  }) : undefined;
  if (pluginWiring) setupCleanup.push(() => pluginWiring.dispose());
  // 用量账本：runtime 每轮交来读数、派发新任务前查月度上限。子步骤的根任务取自下方的工作项与 Leader 委托。
  const usageLedger = new UsageLedger({
    repositories: repos,
    pricing: parseUsagePricing(env.DUTYDECK_USAGE_PRICING_JSON),
    backgroundLimits: parseUsageBackgroundLimits(env.DUTYDECK_USAGE_BACKGROUND_LIMITS_JSON),
    parentOf: async session => {
      const binding = session.source === 'work_item' ? await workItems.parentForSession(session.id) : await delegations.parentForSession(session.id);
      return binding ? { parentSessionId: binding.parentSessionId, ...(binding.parentTaskId ? { parentTaskId: binding.parentTaskId } : {}) } : undefined;
    },
    isProactive: async (appId, chatId, messageId) => (await repos.collaboration.listActions({ appId, chatId }, COLLABORATION_LIST_LIMIT))
      .some(action => action.kind === 'participation.dispatch' && action.payload.messageId === messageId),
    notify: async (target, text, idempotencyKey) => {
      const bot = (await readLarkConfigs(repos.config)).find(entry => entry.appId === target.appId);
      if (!bot?.appSecret) throw new Error('机器人凭证缺失，无法发送用量提醒');
      await createLarkCardService(env, workbenchHttp.fetch, bot).sendText({ chatId: target.chatId, text, idempotencyKey });
    },
    log: { warn: (details, message) => app?.log.warn(details, message) }
  });
  const runtime: DutydeckRuntime = new DutydeckRuntime(repos, {
    configureAgent: (agent, session) => agentModelSettings.resolveForSession(agent, session, async id => await workItems.parentForSession(id) ?? await delegations.parentForSession(id)),
    ptyRetirement: createPtyRetirementControl({ identify: childProcessIdentity, observe: observeProcess }, session => primaryHerdrBackend(session.id)),
    admitTask: pluginWiring
      ? async (session, request) => { await usageLedger.admit(session, request); await pluginWiring.hooks.taskReceived(session, request); }
      : (session, request) => usageLedger.admit(session, request),
    recordUsage: (session, attempt, reading) => usageLedger.record(session, attempt, reading),
    observeTurn: createTurnDiffObserver(repos.config, { log: { warn: (details, message) => app?.log.warn(details, message) } }),
    authorizeTask: async (session, task, phase) => { await collaboration?.background.authorizeTask(session, task); await automation.authorizeTask(task, phase); await ciWebhook?.authorizeTask(task, phase); await pullRequests.authorizeTask(task, phase); await workItems.authorizeTask(session, task, phase); },
    authorizeControl: async (sessionId, actor, _action) => {
      if (await workItems.authorizeControl(sessionId, actor)) return;
      if (await collaboration?.background.authorizeControl(sessionId, actor)) return;
      if (actor.kind !== 'installation_owner' && actor.kind !== 'unspecified') await groupManager.prepareTurn(sessionId, actor.id);
    },
    authorizeExecution: async (sessionId, actorId) => {
      if (await automation.authorizeExecutionSession(sessionId, actorId)) return;
      if (await collaboration?.background.authorizeExecution(sessionId, actorId)) return;
      // work item 授权先行判断并自行短路；其余会话把 prepareTurn 返回的可选本地提交
      // 交回 Runtime，由其短写序列在归属校验后执行（prepare 不写运行身份）。
      if (await workItems.authorizeExecution(sessionId, actorId)) return;
      return groupManager.prepareTurn(sessionId, actorId);
    },
    resolveRiskPolicy: async (sessionId, fallback) => {
      const scheduleSource = await automation.sourceSessionId(sessionId);
      if (scheduleSource) return groupManager.riskPolicy(scheduleSource, fallback);
      const background = await collaboration?.riskPolicy(sessionId, fallback);
      if (background) return background.policy;
      const binding = await workItems.parentForSession(sessionId) ?? await delegations.parentForSession(sessionId);
      return binding ? workItemRiskPolicy(repos, groupManager, binding.parentSessionId, binding.actorId, fallback, env, workbenchHttp.fetch) : groupManager.riskPolicy(sessionId, fallback);
    },
    acpxCommand: config.acpxCommand,
    ptyDriverFactory,
    terminalBackend: () => terminalSettings.current(),
    driverIdleTimeoutMs: config.driverIdleTimeoutMs,
    cleanupIntervalMs: config.cleanupIntervalMs,
    sessionEnvironment: session => ({ ...capabilities.environmentFor(session), ...relayCapabilities.environmentFor(session.id), ...herdr.environmentFor(session.id),
      ...(session.protocol === 'pty-cli' && isFrozenCollaborationSession(session) ? { dutydeck_frozen_materials: 'true' } : {}) }),
    selectPromptPolicy: async session => {
      const parent = await workItems.parentForSession(session.id) ?? await delegations.parentForSession(session.id);
      if (parent?.parentTaskId) {
        const task = repos.execution.getAcceptedTask(parent.parentTaskId)?.task;
        return { version: task?.executionContext?.promptPolicyVersion ?? 'legacy-v1' };
      }
      const policy = await readTokenEfficiencyPolicy(repos.config);
      return { version: promptTemplateVersion(policy.mode), ...(policy.diagnosticReason ? { diagnosticReason: policy.diagnosticReason } : {}) };
    },
    prepareTaskPrompt: pluginWiring
      ? (session, prompt, skills, context) => prepareBoundTaskPrompt(pluginHost!, pluginWiring.hooks, session, prompt, skills, context)
      : (session, prompt, skills, context) => prepareSkillPrompt(session.cwd, prompt, skills, context),
    sessionPrompt: async (session, prompt, context) => {
      const version = context?.promptPolicyVersion ?? 'legacy-v1';
      if (isFrozenCollaborationSession(session)) {
        const result = assemblePrompt(context?.promptParts ?? [{ kind: 'user_request', trustScope: 'user_request', content: prompt }], prompt, version);
        if (context?.promptDiagnostics?.fallbackReason && !result.diagnostics.fallbackReason) result.diagnostics.fallbackReason = context.promptDiagnostics.fallbackReason;
        return result;
      }
      const toolsPrompt = await agentTools.promptForSession(session, prompt);
      const active = runtime.getActiveTaskContext(session.id);
      const resultTools = pluginHost?.resultTools.list({ botAppId: session.sourceId?.split(':')[0], cwd: session.cwd }) ?? [];
      const resultPrompt = session.source === 'lark' && active?.actorId && active.attemptId && !isAutomatedTask(active.taskId) && resultTools.length ? `受控插件结果工具：只返回回执，正文仅原请求者登录下载。调用 dutydeck plugin-tool call <工具> --json '<参数>' --call-id <稳定调用ID> --turn ${capabilities.finalTurnToken(session.id, active.taskId, active.attemptId)}；重试保持 call-id。可用工具：${resultTools.map(t => `${t.id}：${t.description}`).join('；')}\n\n` : '';
      const businessPrompt = pluginHost?.businessTools.list({ botAppId: session.sourceId?.split(':')[0], cwd: session.workspaceSourceCwd ?? session.cwd }).length && active?.attemptId && !isAutomatedTask(active.taskId)
        ? `业务工具：使用本轮凭证执行 ${options.groupToolsCommand ?? 'dutydeck'} tool list --turn ${capabilities.workbenchTurnToken(session.id, active.taskId, active.attemptId)}，按返回 schema 调用 ${options.groupToolsCommand ?? 'dutydeck'} tool call <工具> --json '<参数>' --call-id <稳定ID> --turn <本轮凭证>。同次重试保留 call-id；unknown 仅用 tool reconcile 核对，不新建写操作。MCP tools 端点为 /api/plugin-tools/mcp，使用会话 relay Bearer 与 x-dutydeck-tool-turn；身份由宿主决定。\n\n` : '';
      const prefix = toolsPrompt.slice(0, toolsPrompt.length - prompt.length) + resultPrompt + businessPrompt;
      // 飞书会话的工具块已经定义了 dutydeck 简写，Herdr 入口排在它后面并沿用简写。
      const herdrPrompt = session.terminalBackend === 'herdr' ? '你正在 Herdr 的真实主终端 pane 内运行；HERDR_* 由 Herdr 注入，使用 herdr pane current 核实自身上下文，可用 --current 管理本 pane。不要伪造身份或操作用户 default session。侧边任务可继续使用本会话的 dutydeck session herdr 专属入口。' : herdr.prompt(prefix ? 'dutydeck' : undefined);
      const legacyPrompt = `${prefix}${herdrPrompt ? `${herdrPrompt}\n\n` : ''}${prompt}`;
      const parts = [
        ...(prefix ? [{ kind: 'dynamic_context' as const, trustScope: 'host:current_authority', content: prefix }] : []),
        ...(herdrPrompt ? [{ kind: 'host_rules' as const, sourceId: 'dutydeck:herdr', version, digest: promptDigest(herdrPrompt), trustScope: 'host', complete: true, content: herdrPrompt, suffix: '\n\n' }] : []),
        ...(context?.promptParts ?? [{ kind: 'user_request' as const, trustScope: 'user_request', content: prompt }])
      ];
      const result = assemblePrompt(parts, legacyPrompt, version);
      if (context?.promptDiagnostics?.fallbackReason && !result.diagnostics.fallbackReason) result.diagnostics.fallbackReason = context.promptDiagnostics.fallbackReason;
      return result;
    },
    awaitingAnswer: sessionId => relayBroker.listPending(sessionId).length > 0,
    log: { warn: (...args: unknown[]) => app?.log.warn(...args as [unknown, string]), info: (data, message) => app?.log.info(data, message) },
    ...pluginWiring?.runtimeOptions
  });
  setupCleanup.push(() => runtime.shutdown());
  const workspaceOrganizationService = new WorkspaceOrganizationService({
    config: repos.config,
    listSessions: () => runtime.listSessions(),
  });
  // 会话分析服务（T4c）：1 running/16 queued，按需 Go 分析，失败不影响 Agent 运行。
  // resolver 每次 resolve 按 session agent 当前 env 实时计算候选根；静态接线，无动态 import。
  try {
    insightService = new SessionInsightService({
      insightRepository: repos.insight,
      resolver: createInsightResolver(repos, options.env ?? process.env),
      dataDir: config.databaseUrl === ':memory:'
        ? join(tmpdir(), 'dutydeck-insight')
        : dirname(resolve(config.databaseUrl)),
      processRunId: makeId('insight-run'),
      hostEvidence: {
        readHostEvidenceRaw: (sessionId) => repos.insight.readHostEvidenceRaw(sessionId),
        getSessionExecutions: (sessionId) => repos.execution.getSessionExecutions(sessionId),
        getAcceptedTask: (taskId) => repos.execution.getAcceptedTask(taskId),
        readTransaction: (work) => repos.insight.readTransaction(work)
      },
      loadWorkspaceOrganization: async () => (await workspaceOrganizationService.getSnapshot()).organization,
      getCurrentFingerprint: async (sessionId) => runtime.getCodeFingerprint(sessionId),
      log: (details, message) => app?.log.warn(details, message)
    });
    await insightService.initialize();
  } catch {
    // 只记录固定 code，绝不回显 error.message（可能携带私有路径/token）。
    process.stderr.write('[dutydeck] Session insight service disabled: INSIGHT_STARTUP_FAILED\n');
    insightService = undefined;
  }
  const businessToolGrants = new PluginToolGrants(repos.config);
  const businessTools = pluginHost ? new PluginBusinessToolService(pluginHost, businessToolGrants, new PluginToolLedger(repos.config), new TaskPluginToolIdentity(repos, relayCapabilities, capabilities, runtime), 30_000, pluginWiring?.hooks) : undefined;
  const pluginResultIdentity = new LarkPluginResultIdentity(repos.config, options.pluginResultIdentity);
  const pluginResultRegistry = pluginHost?.resultTools ?? new PluginResultToolRegistry();
  const pluginResultAdapter = new LarkPluginResultAdapter({ repositories: repos, capabilities, runtime, groupManager,
    identity: pluginResultIdentity, client: bot => createLarkCardService(env, workbenchHttp.fetch, bot),
    authorizePolicy: () => legacyExecutionPolicy.authorize('group_tools', 'group_tools.send') });
  const pluginResultService = new PluginResultService(repos.pluginResults, pluginResultRegistry, pluginResultAdapter);
  let pluginResultSweep: Promise<void> | undefined;
  let pluginResultTimer: ReturnType<typeof setInterval> | undefined;
  const sweepPluginResults = () => pluginResultSweep ??= (async () => {
    try { await pluginResultService.sweep(env.DUTYDECK_DISABLE_LARK_LISTENER === 'true' ? [] : env.DUTYDECK_BOT_APP_ID ? [env.DUTYDECK_BOT_APP_ID] : (await readLarkConfigs(repos.config)).filter(bot => bot.listening).map(bot => bot.appId)); }
    catch { app?.log.warn({ code: 'RESULT_RECOVERY_FAILED' }, '受控结果恢复失败'); }
    finally { pluginResultSweep = undefined; }
  })();
  const closePluginResults = async () => { if (pluginResultTimer) clearInterval(pluginResultTimer); await pluginResultSweep; };
  setupCleanup.push(closePluginResults);
  const automationIntegration = createAutomationIntegration(repos, runtime, groupManager, { env, client: config => createLarkCardService(env, workbenchHttp.fetch, config), log: { warn: (...args: unknown[]) => app?.log.warn(...args as [unknown, string]) } });
  // CI 平台全部来自插件；没有 CI 插件时注册表为空，/ci 与 Web 提示「未安装 CI 插件」。
  const ciProviders = pluginHost?.ciProviders ?? new CiProviderRegistry();
  // 插件 notify hook 拒绝时不发这条 CI 通知。
  const notifyCi: typeof automationIntegration.notify = pluginWiring?.hooks.has('notify')
    ? async (sessionId, sourceId, notice) => {
      const session = await runtime.getSession(sessionId);
      if (session && !await pluginWiring.hooks.notify(sessionHookContext(session), 'ci_notice', { title: notice.title, text: notice.markdown, failed: notice.failed === true })) return undefined;
      return automationIntegration.notify(sessionId, sourceId, notice);
    }
    : automationIntegration.notify;
  const pullRequests = new PullRequestService({ repositories: repos, runtime, providers: ciProviders, prepareDelivery: automationIntegration.prepareDelivery, notify: notifyCi,
    log: { warn: (...args: unknown[]) => app?.log.warn(...args as [unknown, string]) } });
  const ciWebhook = ciProviders.list().some(({ provider }) => provider.webhook) ? new CiWebhookService({ repositories: repos, runtime, providers: ciProviders, onEvent: (providerId, event) => pullRequests.onWebhookEvent(providerId, event),
    prepareDelivery: automationIntegration.prepareDelivery, notify: notifyCi, log: { warn: (...args: unknown[]) => app?.log.warn(...args as [unknown, string]) } }) : undefined;
  const automation = new SessionAutomationService({ repositories: repos, runtime, ...automationIntegration, ciProviders, pullRequests, ...(ciWebhook ? { ciWebhook } : {}) });
  setupCleanup.push(() => automation.close());
  if (ciWebhook) setupCleanup.push(() => ciWebhook.close());
  setupCleanup.push(() => pullRequests.close());
  const authorizeWorkAgent = (sessionId: string, actorId: string, agentId: string) => authorizeWorkItemAgent(repos, groupManager, automationIntegration.authorize, sessionId, actorId, agentId);
  const workbench = new LarkWorkbench(repos, runtime, () => workItems, () => workInteractions, automationIntegration.authorize, { env, authorizeAgent: authorizeWorkAgent, log: { warn: (...args: any[]) => app?.log.warn(...args as [unknown, string]) } });
  setupCleanup.push(() => workbench.close());
  const workItems: WorkItemService = new WorkItemService({ repositories: repos, runtime, authorize: automationIntegration.authorize, authorizeAgent: authorizeWorkAgent,
    requireConfirmation: workPlanConfirmationRequired,
    prepareDelivery: (sessionId, id, key) => workbench.prepareDelivery(sessionId, id, key), deliver: item => workbench.deliver(item), notify: (item, actorId) => workbench.notify(item, actorId) });
  setupCleanup.push(() => workItems.close());
  const delegations = new LeaderDelegationService({ repositories: repos, runtime, work: workItems, authorizeAgent: authorizeWorkAgent,
    prepareDelivery: (sessionId, id, key) => workbench.prepareDelivery(sessionId, id, key), notice: (workId, text, key) => workbench.notice(workId, text, key),
    log: { warn: (details, message) => app?.log.warn(details, message) } });
  setupCleanup.push(() => delegations.close());
  const authorizeSessionRequest = async (request: import('fastify').FastifyRequest | import('node:http').IncomingMessage, sessionId: string, boundary: 'session' | 'high_risk' | 'terminal', action: PolicyAction): Promise<PolicyDecision> => {
    const session = await runtime.getSession(sessionId);
    if (session?.source === 'work_item') {
      const binding = await workItems.parentForSession(sessionId);
      if (!binding || !['task.view_result', 'terminal.read'].includes(action)) return { allowed: false, action, code: 'WORK_ITEM_MANAGED_SESSION', reason: '此会话由目标编排管理，请在目标中操作步骤', source: 'integration' };
      sessionId = binding.parentSessionId;
    }
    return await groupManager.authorizeSession(sessionId, action, true) ?? foundationExecution.authorizeSessionId(sessionId, { boundary, action, request });
  };
  let automationTimer: NodeJS.Timeout | undefined;
  let collaborationTimer: NodeJS.Timeout | undefined;
  let resourceRetentionTimer: NodeJS.Timeout | undefined;
  // Reattach surviving idle terminals after a daemon restart, without starting a task.
  const terminalProvider: TerminalStreamProvider = {
    async lookupTerminalStream(sessionId) {
      const driver = await runtime.getTerminalDriver(sessionId);
      if (!driver) return { status: 'no-session' };
      const stream = driver.createTerminalStream?.();
      if (!stream) return { status: 'unsupported' };
      return {
        status: 'ready',
        handle: {
          stream,
          onExit(callback) {
            const unsubscribe = runtime.onDriverExit(sessionId, code => {
              unsubscribe();
              callback(code);
            });
            return unsubscribe;
          }
        }
      };
    }
  };
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let closeRun: Promise<void> | undefined;
  const relayBroker = new RelayAskBroker({
    async publish(sessionId, input) {
      await runtime.publishSessionEvent(sessionId, 'text', {
        text: input.text,
        relay: input.kind,
        ...(input.askId ? { askId: input.askId } : {})
      });
    }
  }, createRelayAskStore(repos.config));
  const workInteractions = new WorkItemInteractions(workItems, runtime, relayBroker, (sessionId, actorId, action) => authorizeWorkItemInteraction(repos, groupManager, sessionId, actorId, action, env, workbenchHttp.fetch));
  closeResources = () => {
    if (!closeRun) closeRun = (async () => {
      // 分析服务必须在任何并行关闭组之前显式 await：先拒新刷新、取消 queued/running
      // 作业并等待 runner 退出与临时目录清理，再关闭 HTTP/runtime/repos。
      await closeInsightService();
      if (tokenRefresh) clearInterval(tokenRefresh);
      clearInterval(shareSecretRefresh);
      disposeShareSigner();
      disposeTurnDiffSigner();
      if (automationTimer) clearInterval(automationTimer);
      if (collaborationTimer) clearInterval(collaborationTimer);
      if (resourceRetentionTimer) clearInterval(resourceRetentionTimer);
      const errors: unknown[] = [...insightCloseErrors];
      const settle = async (operations: Array<() => unknown>) => {
        const results = await Promise.allSettled(operations.map(operation => Promise.resolve().then(operation)));
        errors.push(...results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason));
      };
      await settle([closePluginResults]);
      await settle([() => workbench.close(), () => workbenchHttp.close(), () => workItems.close(), () => delegations.close(), () => automation.close(), () => ciWebhook?.close(), () => pullRequests.close()]);
      // Wake blocked asks before waiting for HTTP shutdown.
      await settle([() => relayBroker.close()]);
      await settle([() => collaboration?.close(), () => relayBroker.flush(), () => app?.close(), () => runtime.shutdown()]);
      await settle([() => capabilities.close()]);
      await settle([() => repos.close()]);
      await settle([() => pluginWiring?.dispose()]);
      if (errors.length) throw new AggregateError(errors, 'Dutydeck did not shut down cleanly');
    })();
    return closeRun;
  };
    collaboration = createCollaborationIntegration({ repositories: repos, runtime, groups: groupManager,
      workspaceRoot: config.databaseUrl === ':memory:' ? join(tmpdir(), 'dutydeck-decisions') : join(dirname(resolve(config.databaseUrl)), 'decisions'),
      client: bot => createLarkCardService(env, workbenchHttp.fetch, bot), configureExtensions: options.configureCollaborationExtensions,
      readMemory: scope => readCollaborationMemory(scope),
      usageRefusal: async scope => await usageLedger.refusal(scope.appId, scope.chatId)
        ?? await usageLedger.automaticRefusal(scope.appId),
      listeningDisabled: env.DUTYDECK_DISABLE_LARK_LISTENER === 'true', scenarios,
      log: { warn: (details, message) => app?.log.warn(details, message) } });
    setupCleanup.push(() => collaboration?.close());
    automation.mandateCards = collaboration.mandateCards;
    await relayBroker.initialize();
    await runtime.initialize(await agentModelSettings.defaultsForBoot(config.agents));
    const webRoot = options.webRoot ?? fileURLToPath(new URL('../public', import.meta.url));
    const memoryRoot = config.databaseUrl === ':memory:'
      ? join(tmpdir(), 'dutydeck-memory')
      : join(dirname(resolve(config.databaseUrl)), 'memory');
    let memoryProjection!: LarkMemoryProjection;
    const memoryStore = new LarkMemoryStore(repos.config, {
      onChange: scope => memoryProjection.write(scope)
    });
    memoryProjection = new LarkMemoryProjection(
      memoryStore,
      memoryRoot,
      { warn: (obj, msg) => app?.log.warn(obj, msg) }
    );
    const memoryPipeline = new LarkMemoryPipeline({
      runtime,
      jobs: repos.memoryJobs,
      policyConfig: repos.config,
      controlActorId: installationOwnerTaskActor,
      repos: { execution: repos.execution },
      store: memoryStore,
      projection: memoryProjection,
      readConfig: async appId => (await readLarkConfigs(repos.config)).find(bot => bot.appId === appId),
      log: {
        info: (obj, msg) => app?.log.info(obj, msg),
        warn: (obj, msg) => app?.log.warn(obj, msg),
        error: (obj, msg) => app?.log.error(obj, msg)
      }
    });
    for (const bot of await readLarkConfigs(repos.config)) void memoryPipeline.recoverJobs(bot.appId).catch(error => app?.log.error({ error, appId: bot.appId }, '恢复后台记忆作业失败'));
    // 协作作用域都是群：读本机器人的群记忆池（shared 时是各群共享池，来源是别的群的条目标「其他群」；per-group 时是本群的池）。
    readCollaborationMemory = async scope => {
      const bot = (await readLarkConfigs(repos.config)).find(entry => entry.appId === scope.appId);
      const memoryScope = larkMemoryScope(scope.appId, scope.chatId, 'group', bot?.groupMemoryScope);
      return !bot || !larkMemoryEnabled(bot) ? '' : renderMemoryIndex(await memoryStore.list(memoryScope), await memoryStore.getState(memoryScope), { currentChatId: scope.chatId }).text;
    };
    app = await buildApp(runtime, {
      pluginBindings: { host: pluginHost ?? PluginHost.empty(dirname(config.databaseUrl)), authorize: createPluginManagementAuthorizer({ authEnabled: config.authEnabled, mode, getToken: () => config.authEnabled ? getAuthToken(repos.config) : Promise.resolve(null), getPasswordHash: () => getPasswordHash(repos.config) }) },
    terminalSettings,
    agentModelSettings,
      ...(insightService
        ? { insight: { service: insightService, authorize: async request => Boolean(await resolveInstallationPrincipal(request)) } }
        : {}),
      recovery: { authorize: async request => Boolean(await resolveInstallationPrincipal(request)),
        larkResultDeliveries: async sessionId => larkResultDeliveryIssues((await Promise.all((await readLarkConfigs(repos.config))
          .map(bot => repos.channelMappings.list(`lark-card:${bot.appId}`)))).flat().filter(mapping => mapping.sessionId === sessionId)) },
      workspaceGroups: {
        service: workspaceOrganizationService,
        authorize: async request => Boolean(await resolveInstallationPrincipal(request)),
      },
      sessionNames: {
        authorize: async request => Boolean(await resolveInstallationPrincipal(request)),
      },
      plan: { store: repos.config },
      webRoot,
      usage: { ledger: usageLedger, snapshot: sessionId => sessionUsageSnapshot(repos, sessionId, options.env ?? process.env), authorize: async request => Boolean(await resolveInstallationPrincipal(request)) },
      collaboration: { service: collaboration.service, runtime, tools: agentTools, evaluation: collaboration.evaluation, extensions: collaboration.extensions,
        authorizeManagement: async request => await resolveInstallationPrincipal(request) ? installationOwnerTaskActor : undefined,
        bootstrap: scope => collaboration!.participation.bootstrap(scope), prepareSettings: (scope, patch) => collaboration!.prepareSettings(scope, patch), onChange: scope => collaboration!.onChange(scope),
        confirmMandate: (scope, actorId, body, origin) => collaboration!.mandateCards.request(scope, actorId, body, origin),
        updateDuty: (scope, patch, actorId) => collaboration!.participation.updateDuty(scope, patch, actorId), scenarios: scope => collaboration!.participation.scenarioOverview(scope) },
      system: { directoryRoots: async () => [...config.agents.map(agent => agent.cwd).filter((cwd): cwd is string => Boolean(cwd)), ...(await readLarkConfigs(repos.config)).map(bot => bot.workspace).filter((cwd): cwd is string => Boolean(cwd))] },
      lark: {
        fetcher: workbenchHttp.fetch,
        participation: collaboration.participation,
        usage: usageLedger,
        automation,
        scheduleRequests: { prepareDelivery: automationIntegration.prepareMessageDelivery, sendConfirmation: automationIntegration.sendScheduleRequest },
        workbench,
        relayBroker,
        env,
        config: repos.config,
        agents: repos.agents,
        cardMappings: repos.channelMappings,
        runtime,
        agentTools,
        executionPolicy: legacyExecutionPolicy,
        groupManager,
        memory: {
          store: memoryStore,
          pipeline: memoryPipeline
        },
        listeningDisabled: env.DUTYDECK_DISABLE_LARK_LISTENER === 'true',
      },
      auth: {
        mode,
        getToken: () => config.authEnabled ? getAuthToken(repos.config) : Promise.resolve(null),
        getPasswordHash: () => getPasswordHash(repos.config),
        getShareSecret: () => getShareLinkSecret(repos.config),
        localOnly: mode === 'local'
      },
      terminal: {
        provider: terminalProvider,
        auth: { mode, allowUnauthenticated: mode === 'local', check: presented => !!presented && (tokensEqual(presented, activeToken) || verifyBrowserSession(presented, activePasswordHash)) },
        authorize: (request, sessionId, action) => authorizeSessionRequest(request, sessionId, 'terminal', action),
      },
      instances: parsePeerInstances(env.DUTYDECK_INSTANCES_JSON),
      relay: { runtime, capabilities: relayCapabilities, broker: relayBroker, herdr },
      foundation: { repositories: repos, authorize: foundationManagementAuthorizer, inspectSecretRef, isLiveManagedBot: id => groupManager.isLiveManagedBot(id) },
      identityPreflight: { repositories: repos, authorize: foundationManagementAuthorizer, probe: identityPreflightProbe, now: options.identityPreflight?.now },
      schedule: { repositories: repos, authorize: foundationManagementAuthorizer, uiEntryReady: true, collaborationExecutorWired: true },
      workItemTools: { runtime, work: workItems, tools: agentTools, delegations },
      agentRequests: { runtime, tools: agentTools, automation, automatedTask: isAutomatedTask, prepareDelivery: automationIntegration.prepareTaskDelivery, sendConfirmation: automationIntegration.sendScheduleRequest },
      // 与 coordinator 的记忆存储同一个 configs 仓库（listener 的 workflowStore 就是 repos.config）。
      memoryTools: { tools: agentTools, store: memoryStore, runtime },
      ...(businessTools ? { pluginBusinessTools: { service: businessTools, grants: businessToolGrants, origin: new URL(localApiBaseUrl(config)).origin, authorize: createPluginManagementAuthorizer({ authEnabled: config.authEnabled, mode, getToken: () => config.authEnabled ? getAuthToken(repos.config) : Promise.resolve(null), getPasswordHash: () => getPasswordHash(repos.config) }) } } : {}),
      pluginResults: { service: pluginResultService, viewer: { repository: repos.pluginResults, identity: pluginResultIdentity, authorize: async delivery => { if (!pluginResultRegistry.get(`${delivery.plugin}/${delivery.tool}`, { botAppId: delivery.requester.tenant, cwd: String(delivery.target.cwd ?? '') })) throw new PluginResultError('RESULT_TOOL_UNAVAILABLE'); await pluginResultAdapter.assertDeliveryAuthorized(delivery); } } },
      workItems: { service: workItems, interactions: workInteractions, authorize: async (request, sessionId, action) => {
        if (!await resolveInstallationPrincipal(request)) return false;
        const decision = await groupManager.authorizeSession(sessionId, action, true) ?? await foundationExecution.authorizeSessionId(sessionId, { boundary: 'session', action, request });
        return { ...decision, actorId: installationOwnerTaskActor };
      } },
      ciHooks: { ...(ciWebhook ? { service: ciWebhook } : {}) },
      ...(pluginWiring ? { plugins: pluginWiring.routes } : {}),
      automation: { service: automation, authorize: async (request, sessionId, action) => {
        const principal = await resolveInstallationPrincipal(request);
        if (!principal) return false;
        const decision = await groupManager.authorizeSession(sessionId, action, true) ?? await foundationExecution.authorizeSessionId(sessionId, { boundary: 'session', action, request });
        return { ...decision, actorId: installationOwnerTaskActor };
      } },
      executionPolicy: {
        authorize: (request, sessionId, boundary, action) => authorizeSessionRequest(request, sessionId, boundary, action),
      },
      turnDiffs: { store: repos.config,
        requestLarkReview: review => requestLarkTurnDiffReview({ configs: repos.config, mappings: repos.channelMappings, confirmations: collaboration?.participation.confirmations }, review) },
    });
    logDroppedAgents(app.log, droppedAgents);
    await app.listen(listenOptions(config));
    pluginResultTimer = setInterval(() => { void sweepPluginResults(); }, 30_000);
    pluginResultTimer.unref();
    void sweepPluginResults();
    const resourceRoot = larkResourceRoot(tmpdir());
    const sweepResources = () => { void pruneLarkResourceDirectories(resourceRoot).catch(error => app?.log.warn({ error }, '飞书附件临时目录清理失败')); };
    resourceRetentionTimer = setInterval(sweepResources, 60 * 60_000);
    resourceRetentionTimer.unref();
    sweepResources();
    workItems.start();
    void delegations.start().catch(error => app?.log.warn({ error }, '分层协作规划恢复失败'));
    const tick = () => {
      void automation.tick().catch(error => app?.log.warn({ error }, '自动任务轮询失败'));
      void ciWebhook?.tick().catch(error => app?.log.warn({ error }, 'CI webhook 续作轮询失败'));
      void pullRequests.tick().catch(error => app?.log.warn({ error }, 'PR 跟进轮询失败'));
    };
    automationTimer = setInterval(tick, 60_000);
    automationTimer.unref();
    tick();
    let lastCollaborationPrune = 0;
    const tickCollaboration = () => {
      if (Date.now() - lastCollaborationPrune > 3_600_000) { lastCollaborationPrune = Date.now(); void collaboration!.prune().catch(error => app?.log.warn({ error }, '群上下文保留期清理失败')); }
      void collaboration!.scheduler.tick().catch(error => app?.log.warn({ error }, '群委托轮询失败')); };
    collaborationTimer = setInterval(tickCollaboration, 5_000);
    collaborationTimer.unref(); tickCollaboration();
  return { config, runtime, close: closeResources };
  } catch (error) {
    try { await closeResources(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Dutydeck startup and cleanup failed'); }
    throw error;
  }
}
