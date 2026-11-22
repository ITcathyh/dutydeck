import { composeCollaboration } from './compose/collaboration.js';
import { composeWork } from './compose/work.js';
import { composeAutomation } from './compose/automation.js';
import { composeDrivers,composeRuntime } from './compose/runtime.js';
import { composePlugins,composePluginResults } from './compose/plugins.js';
import { composeAgentTools,composeCapabilities } from './compose/agent-tools.js';
import { composeAuth,sessionAuthorization } from './compose/auth.js';
import { ServerLifecycle } from './compose/lifecycle.js';
import { composeInsight } from './compose/insight.js';
import { listenOptions,unauthenticatedListenRefusal } from './access-policy.js';
import { LarkReplyPolisher,type ReplyPolish } from './lark/reply-polish.js';
import { createRelayAskLifecycleWatcher } from './relay-routes.js';
import { inheritedListenOptions,inheritedSocketMismatch,takeInheritedListenSocket } from './socket-activation.js';
import { DutydeckWatch,startDutydeckWatch,watchDeliveryRejection,watchReceiverType } from './watch.js';
import { collectWatchScopes,resolveWatchReceiver } from './watch-signals.js';
import { assertDatabaseNotQuarantined } from '@dutydeck/storage';
import { larkAgentSessionBinding } from './lark/agent-tools.js';
import { withClaudeAutoMemoryMarker } from './lark/claude-auto-memory.js';
import { ArtifactSnapshots } from './artifact-snapshots.js';
import { instancePrivatePaths } from './lark/artifact-delivery.js';
import { PluginHost } from './plugins/host.js';
import { PluginResultError } from './plugins/result-service.js';
import { LarkPluginResultAdapter } from './lark/plugin-result-delivery.js';
import { LarkPluginResultIdentity,type PluginResultIdentityOptions } from './lark/plugin-result-identity.js';
import { AgentModelSettings } from './agent-model-settings.js';
import { createSessionContexts } from './session-context.js';
import { sessionUsageSnapshot } from './session-usage.js';
import { createRequire } from 'node:module';
import { HerdrSessions } from './herdr.js';
import { rememberSecretValues } from './platform/secret-redaction.js';
import { dutydeckGroupToolsCommand } from './lark/agent-tools.js';
import { resolveExplicitFinalContext } from './lark/explicit-final.js';
import { larkResultDeliveryIssues } from './lark/reconciler.js';
import { isAutomatedRequest } from './agent-request-tools.js';
import { renderMemoryIndex } from './lark/memory-view.js';
import type { CollaborationExtensions } from './collaboration-extensions.js';
import { LarkGroupManager } from './lark/group-management.js';
import { backfillBotPromptVersions,larkMemoryEnabled,readLarkConfig,readLarkConfigs } from './lark/config.js';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { loadConfigWithDiagnosticsAsync,resolveDatabaseUrl,type AppConfig } from '@dutydeck/config';
import { logDroppedAgents } from './agent-config-log.js';
import { assertBotProcessStartup,createRepositories } from '@dutydeck/storage';
import { installationOwnerTaskActor,RuntimeError,timeLoop } from '@dutydeck/shared';
import { dirname } from 'node:path';
import { larkResourceRoot,pruneLarkResourceDirectories,readLarkResourceReferences } from './resource-retention.js';
import { fileURLToPath } from 'node:url';
import { buildApp,createAppLogger } from './app.js';
import { parsePeerInstances } from './instance-proxy.js';
import { localLoopbackUrl } from './local-api-url.js';
import { LarkWorkbench } from './lark/workbench.js';
import { createLarkCardService,LarkServiceError } from './lark/service.js';
import { deliverLarkSessionNotice } from './lark/session-notice.js';
import { createWorkbenchFetch } from './workbench-fetch.js';
import { LarkAgentToolsService } from './lark/agent-tools.js';
import { larkMemoryScope,LarkMemoryStore } from './lark/memory.js';
import { LarkMemoryProjection } from './lark/memory-view.js';
import { LarkMemoryPipeline } from './lark/memory-pipeline.js';
import { setLarkSessionShareSigner,setLarkTurnDiffSigner } from './lark/detail-link.js';
import { requestLarkTurnDiffReview } from './lark/turn-diff.js';
import type { TerminalStreamProvider } from './terminal/terminal-ws.js';
import {
createDutydeckPersistentBackend,PTY_AGENT_CONTRIBUTIONS
} from '@dutydeck/pty-driver';
import { LocalFileSecretProvider,localFileSecretProviderName,secretDirectoryForDatabase } from '@dutydeck/secret-provider';
import { LarkIdentityPreflightProbe } from './lark/identity-preflight.js';
import { WorkspaceOrganizationService } from './workspace-organization.js';
import { loadDaemonPlugins } from './plugins/service-wiring.js';
import type { ShutdownPhases } from './shutdown-phases.js';
import type { FastifyBaseLogger } from 'fastify';

const channel = {
  readLarkConfigs, readLarkConfig, createLarkCardService,
  withClaudeAutoMemoryMarker, deliverLarkSessionNotice, LarkPluginResultIdentity,
  LarkPluginResultAdapter, LarkWorkbench, larkMemoryScope,
  larkMemoryEnabled, renderMemoryIndex, LarkMemoryStore,
  LarkMemoryProjection, LarkMemoryPipeline, larkAgentSessionBinding,
  larkResultDeliveryIssues, requestLarkTurnDiffReview, LarkServiceError
};
export type ChannelBindings = typeof channel;

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
  /** Test/operator injection only. */
  logger?: FastifyBaseLogger;
}
export interface LocalServer {
  config: AppConfig;
  runtime: DutydeckRuntime;
  close(): Promise<void>;
  /** 停服各阶段的进度；close() 开始后才有记录，强制退出时据此报出卡住的阶段。 */
  shutdownPhases: ShutdownPhases;
}

export { accessMode, listenOptions, unauthenticatedListenRefusal, UNSAFE_NO_AUTH_ENV } from './access-policy.js';

function localApiBaseUrl(config: Pick<AppConfig, 'host' | 'port'>) {
  return localLoopbackUrl(config.host, config.port);
}

export { configuredRootsForSession, createInsightResolver } from './compose/insight.js';

/** Production PTY-CLI policy: persistent tmux or a hard failure, never an
 * implicit downgrade to the in-process PtyBackend. */
export function createProductionPtyBackend(sessionId: string, log?: import('@dutydeck/shared').DiagnosticLog) {
  return createDutydeckPersistentBackend(sessionId, log);
}

export async function startLocalServer(options: StartLocalServerOptions = {}): Promise<LocalServer> {
  // buildApp 之前的阶段（含会话恢复）也要记日志，不能等 app.log。
  const log = options.logger ?? createAppLogger();
  // pty-cli agent 发现：PTY_AGENT_CONTRIBUTIONS 经 loadConfig 合并进 config.agents
  // （builtinAgents 内部按 commandExists 过滤，只暴露本机已安装的 CLI；可用的终端适配器优先，同 id 覆盖 ACPX）。
  // 插件在加载配置之前加载：插件 agents 要与 DUTYDECK_AGENTS_JSON 一起合并。没有启用的插件（或只有内置场景包）时为 undefined，下面不接线。
  // 启动各阶段耗时（毫秒），开始监听后汇总成一条日志；boot 是进程启动到这里（Node 启动与模块加载）。
  const startupMs: Record<string, number> = { boot: Math.round(process.uptime() * 1000) };
  // systemd socket 激活传入的监听 socket：启动一开始就取走并清掉 LISTEN_* 变量，启动恢复期间派生的子进程看不到它们。
  const inherited = takeInheritedListenSocket();
  if (inherited && 'error' in inherited) throw new Error(inherited.error);
  const lifecycle = new ServerLifecycle(log);
  let startupMark = performance.now();
  const startupPhase = (name: string) => { const now = performance.now(); startupMs[name] = Math.round(now - startupMark); startupMark = now; };
  const startupEnvironment = options.env ?? process.env;
  assertDatabaseNotQuarantined(resolveDatabaseUrl(startupEnvironment));
  const { host: pluginHost, scenarios } = await loadDaemonPlugins(startupEnvironment);
  startupPhase('plugins');
  const { config, droppedAgents, repos } = await (async () => {
    try {
      const { config, droppedAgents } = await loadConfigWithDiagnosticsAsync(options.env ?? process.env, PTY_AGENT_CONTRIBUTIONS, pluginHost?.agents);
      startupPhase('config');
      const refusal = unauthenticatedListenRefusal(config, options.env ?? process.env);
      if (refusal) throw new Error(refusal);
      assertBotProcessStartup(config.databaseUrl, (options.env ?? process.env).DUTYDECK_BOT_APP_ID);
      let migrateMs = 0;
      const repos = createRepositories(config.databaseUrl, { mode: 'runtime', runtimeCapabilities: ['lark_secret_refs'], newDatabaseAuthority: 'ledger_v1', onMigrated: ms => { migrateMs = Math.round(ms); } });
      try { await backfillBotPromptVersions(repos.config); }
      catch { process.stderr.write('[dutydeck] 提示词版本回填失败，继续启动；缺少历史的轮次会标为未记录版本。\n'); }
      startupPhase('database');
      // database 只算打开与校验，迁移单独记。
      startupMs.migrate = migrateMs; startupMs.database! -= migrateMs;
      return { config, droppedAgents, repos };
    } catch (error) { await pluginHost?.dispose(); throw error; }
  })();
  lifecycle.onSetupFailure(() => pluginHost?.dispose());
  lifecycle.register('database', () => repos.close(), false);
  try {
  // Recheck under the runtime claim in case an offline split completed between inspection and open.
  assertBotProcessStartup(config.databaseUrl, (options.env ?? process.env).DUTYDECK_BOT_APP_ID);
  // 发往飞书的文本按原值抹掉服务环境和各 Agent 配置里的凭据（见 platform/secret-redaction）。
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
  const env = startupEnvironment;
  const context = { config, env, repos, log, lifecycle, options, channel };
  const identityPreflightProbe = localSecretProvider ? new LarkIdentityPreflightProbe({
    secretProvider: localSecretProvider,
    fetcher: options.identityPreflight?.fetcher,
    baseUrlForBrand: options.identityPreflight?.baseUrlForBrand ?? (brand => env.LARK_OPEN_API_BASE_URL?.trim()
      || (brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn')),
    now: options.identityPreflight?.now,
    evidenceTtlMs: options.identityPreflight?.evidenceTtlMs,
  }) : undefined;
  const { capabilities, relayCapabilities, relaySigningSecret } = await composeCapabilities(context);
  const herdr = new HerdrSessions({ database: config.databaseUrl, signingSecret: relaySigningSecret, botAppId: env.DUTYDECK_BOT_APP_ID, env,
    command: options.groupToolsCommand ?? dutydeckGroupToolsCommand(fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './internal-agent-cli.ts' : './internal-agent-cli.js', import.meta.url)), process.execPath, import.meta.url.endsWith('.ts') ? createRequire(import.meta.url).resolve('tsx') : undefined) });
  const auth = await composeAuth(context, { setLarkSessionShareSigner, setLarkTurnDiffSigner });
  const { resolveInstallationPrincipal, authorizeInstallationManagement, foundationManagementAuthorizer, foundationExecution, legacyExecutionPolicy } = auth;
  lifecycle.beforeStop('http', auth.stop);
  const workbenchHttp = createWorkbenchFetch();
  lifecycle.register('workbenchHttp', () => workbenchHttp.close());
  const groupManager: LarkGroupManager = new LarkGroupManager(repos, { env, fetcher: workbenchHttp.fetch, onPolicyChanged: (): Promise<void> => groupManager.refreshPolicies(runtime) });
  const isAutomatedTask = (taskId: string) => isAutomatedRequest(repos.execution.getAcceptedTask(taskId)?.request);
  const polishReply: ReplyPolish = (...args) => replyPolisher.polish(...args);
  const agentTools = composeAgentTools(context, capabilities, groupManager, legacyExecutionPolicy, isAutomatedTask,
    { ChannelTools: LarkAgentToolsService, privatePaths: instancePrivatePaths, resolveFinal: resolveExplicitFinalContext }, {
      polishReply, activeTask: id => runtime.getActiveTaskContext(id),
      authorizeTool: (id, action, preview) => collaboration.background.authorizeTool(id, action, preview),
      previewWork: (id, actor) => automationIntegration.previewAuthorize(id, actor),
      previewCollaboration: (binding, actor) => collaboration.previewAuthorize(binding, actor, 'write'),
      teamSearch: () => collaboration.teamSearch,
    });
  const drivers = composeDrivers(context, herdr);
  const { terminalSettings, ptyProvider } = drivers;
  const pluginWiring = composePlugins(context, pluginHost, workbenchHttp, { runtime: () => runtime, workItems: () => workItems });
  const { runtime, sessionAgentConfig, usageLedger, workspaceApprovals, projectMemory } = composeRuntime(context, {
    drivers, pluginHost, pluginWiring, groupManager, workbenchHttp, capabilities, relayCapabilities, herdr,
    agentTools, agentModelSettings, isAutomatedTask,
  }, {
    workItems: () => workItems, delegations: () => delegations, collaboration: () => collaboration,
    automation: () => schedules, awaitingAnswer: id => relayBroker.listPending(id).length > 0,
  });
  const replyPolisher = new LarkReplyPolisher({ runtime, repos, log: { warn: (details, message) => log.warn(details, message) } });
  lifecycle.register('runtime', () => runtime.shutdown());
  const workspaceOrganizationService = new WorkspaceOrganizationService({
    config: repos.config,
    listSessions: () => runtime.listSessions(),
  });
  const insightService = await composeInsight(repos, config, env, workspaceOrganizationService, runtime, log, startupPhase);
  lifecycle.register('insight', () => insightService?.close(), false);
  startupPhase('insight');
  const loopLog = { warn: (details: Record<string, unknown>, message: string) => log.warn(details, message) };
  const pluginResults = composePluginResults(context, {
    pluginHost, pluginWiring, runtime, capabilities, relayCapabilities, groupManager, workbenchHttp, legacyExecutionPolicy,
  });
  const { businessToolGrants, businessTools, pluginResultIdentity, pluginResultRegistry, pluginResultAdapter, pluginResultService } = pluginResults;
  const schedules = composeAutomation(context, runtime, groupManager, workbenchHttp, pluginHost, pluginWiring, {
    workItems: () => workItems, awaitingAnswer: id => relayBroker.listPending(id).length > 0,
    mandateCards: { callback: (...args) => collaboration.mandateCards.callback(...args) },
  });
  const { automation, automationIntegration, ciWebhook } = schedules;
  const work = composeWork(context, runtime, groupManager, workbenchHttp, automationIntegration);
  const { workbench, workItems, delegations, workInteractions, relayBroker, relayContinuation } = work;
  const { authorizeSessionRequest, authorizeSessionRequests } = sessionAuthorization(runtime, workItems, groupManager, auth);
  let resourceRetentionTimer: NodeJS.Timeout | undefined;
  const historyRetention = new AbortController();
  let historyRetentionRun: Promise<void> | undefined;
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
  let closeWatch: (() => Promise<void>) | undefined;
  lifecycle.register('historyRetention', () => {
    if (resourceRetentionTimer) clearInterval(resourceRetentionTimer);
    historyRetention.abort();
    return historyRetentionRun;
  }, false);
  lifecycle.register('relayClose', () => relayBroker.close(), false);
  lifecycle.register('relayFlush', () => relayBroker.flush(), false);
  lifecycle.register('watch', () => closeWatch?.(), false);
  lifecycle.register('http', () => app?.close(), false);
  lifecycle.assembledCore();
  const groups = composeCollaboration(context, runtime, groupManager, workbenchHttp, usageLedger, polishReply, scenarios);
  const { collaboration, memoryStore } = groups;
    startupPhase('integrations');
    await relayBroker.initialize();
    startupPhase('relay');
    const bootAgents = await agentModelSettings.defaultsForBoot(config.agents);
    startupPhase('agentDefaults');
    // agents：绑定账本并登记 Agent；sessions：逐个会话恢复与对账（孤儿记录、资源观察、接回原轮、排队）。
    await runtime.initialize(bootAgents, () => startupPhase('agents'));
    relayBroker.setContinuationChecker(relayContinuation, createRelayAskLifecycleWatcher(runtime));
    await relayBroker.refreshPending();
    startupPhase('sessions');
    const webRoot = options.webRoot ?? fileURLToPath(new URL('../public', import.meta.url));
    const memoryPipeline = await groups.recoverMemory();
    const resourceRoot = larkResourceRoot(config.databaseUrl);
    app = await buildApp(runtime, {
      loggerInstance: log,
      matters: repos.matters,
      artifactSnapshots: { service: new ArtifactSnapshots(repos, config.databaseUrl), authorize: async (request, sessionId) => {
        return await authorizeInstallationManagement(request) && (await authorizeSessionRequest(request, sessionId, 'session', 'task.view_result')).allowed;
      } },
      pluginBindings: { host: pluginHost ?? PluginHost.empty(dirname(config.databaseUrl)), authorize: authorizeInstallationManagement },
    terminalSettings,
    configurationExplanation: { repositories: repos, groups: groupManager, host: pluginHost, authorize: async (request, sessionId) => {
      return await authorizeInstallationManagement(request) && (await authorizeSessionRequest(request, sessionId, 'session', 'task.view_result')).allowed;
    } },
    agentModelSettings,
    sessionAgentConfig,
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
      usage: { ledger: usageLedger, snapshot: sessionId => sessionUsageSnapshot(repos, sessionId, options.env ?? process.env), contexts: createSessionContexts(repos), authorize: async request => Boolean(await resolveInstallationPrincipal(request)) },
      ...(workspaceApprovals ? { workspaceApprovals: { service: workspaceApprovals, authorize: async (request: import('fastify').FastifyRequest) => Boolean(await resolveInstallationPrincipal(request)) } } : {}),
      collaboration: { service: collaboration.service, runtime, tools: agentTools, evaluation: collaboration.evaluation, extensions: collaboration.extensions,
        authorizeManagement: async request => await resolveInstallationPrincipal(request) ? installationOwnerTaskActor : undefined,
        bootstrap: scope => collaboration.participation.bootstrap(scope), prepareSettings: (scope, patch) => collaboration.prepareSettings(scope, patch), onChange: scope => collaboration.onChange(scope),
        confirmMandate: (scope, actorId, body, origin) => collaboration.mandateCards.request(scope, actorId, body, origin),
        confirmMandateUpdate: (scope, actorId, id, body, origin) => collaboration.mandateCards.requestUpdate(scope, actorId, id, body, origin),
        updateDuty: (scope, patch, actorId) => collaboration.participation.updateDuty(scope, patch, actorId), scenarios: scope => collaboration.participation.scenarioOverview(scope),
        previewScenario: (scope, id, input) => collaboration.participation.previewScenario(scope, id, input) },
      system: { directoryRoots: async () => [...config.agents.map(agent => agent.cwd).filter((cwd): cwd is string => Boolean(cwd)), ...(await readLarkConfigs(repos.config)).map(bot => bot.workspace).filter((cwd): cwd is string => Boolean(cwd))] },
      lark: {
        resourceRoot,
        fetcher: workbenchHttp.fetch,
        participation: collaboration.participation,
        polishReply,
        usage: usageLedger,
        automation,
        scheduleRequests: { prepareDelivery: automationIntegration.prepareMessageDelivery, sendConfirmation: automationIntegration.sendScheduleRequest },
        workspaceApprovals,
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
      auth: auth.httpAuth,
      terminal: {
        provider: terminalProvider,
        auth: auth.terminalAuth,
        authorize: (request, sessionId, action) => authorizeSessionRequest(request, sessionId, 'terminal', action),
      },
      instances: parsePeerInstances(env.DUTYDECK_INSTANCES_JSON),
      relay: { runtime, capabilities: relayCapabilities, broker: relayBroker, herdr, continuation: relayContinuation,
        authorizeResult: async sessionId => {
          const decision = await groupManager.authorizeSession(sessionId, 'task.view_result', false, false, { propagateRefreshErrors: true });
          if (decision?.allowed === false) throw new RuntimeError(decision.code, decision.reason, 403);
        } },
      foundation: { repositories: repos, authorize: foundationManagementAuthorizer, inspectSecretRef, isLiveManagedBot: id => groupManager.isLiveManagedBot(id) },
      identityPreflight: { repositories: repos, authorize: foundationManagementAuthorizer, probe: identityPreflightProbe, now: options.identityPreflight?.now },
      schedule: { repositories: repos, authorize: foundationManagementAuthorizer, uiEntryReady: true, collaborationExecutorWired: true },
      workItemTools: { runtime, work: workItems, tools: agentTools, delegations },
      agentRequests: { runtime, tools: agentTools, automation, automatedTask: isAutomatedTask, prepareDelivery: automationIntegration.prepareTaskDelivery, sendConfirmation: automationIntegration.sendScheduleRequest },
      // 与 coordinator 的记忆存储同一个 configs 仓库（listener 的 workflowStore 就是 repos.config）。
      memoryTools: { tools: agentTools, store: memoryStore, runtime },
      memoryManagement: {
        store: memoryStore,
        scope: async sessionId => {
          const session = await runtime.getSession(sessionId);
          const binding = session && larkAgentSessionBinding(session);
          if (!binding) throw new RuntimeError('MEMORY_SCOPE_INVALID', '此会话没有飞书记忆池。', 400);
          const bot = (await readLarkConfigs(repos.config)).find(item => item.appId === binding.appId);
          if (!bot) throw new RuntimeError('MEMORY_SCOPE_INVALID', '机器人已不存在。', 404);
          return larkMemoryScope(binding.appId, binding.chatId, binding.chatType, bot.groupMemoryScope);
        },
        authorize: async (request, sessionId) => {
          if (!await authorizeInstallationManagement(request)) throw new RuntimeError('MEMORY_OWNER_REQUIRED', '管理记忆需要安装管理员权限。', 403);
          const decision = await authorizeSessionRequest(request, sessionId, 'session', 'task.view_result');
          if (!decision.allowed) throw new RuntimeError(decision.code, decision.reason, 403);
        },
        sourceSession: async entry => entry.taskId ? repos.execution.getTaskExecution(entry.taskId)?.task.sessionId : ['extraction', 'consolidation'].includes(entry.source) ? undefined : entry.sessionId,
        canViewSource: async (request, sessionId) => Boolean(await runtime.getSession(sessionId)) && (await authorizeSessionRequest(request, sessionId, 'session', 'task.view_result')).allowed,
      },
      projectMemory: {
        service: projectMemory,
        authorize: authorizeInstallationManagement,
        authorizeSession: async (request, sessionId) => {
          const decision = await authorizeSessionRequest(request, sessionId, 'session', 'task.view_result');
          if (!decision.allowed) throw new RuntimeError(decision.code, decision.reason, 403);
        },
      },
      ...(businessTools ? { pluginBusinessTools: { service: businessTools, grants: businessToolGrants, origin: new URL(localApiBaseUrl(config)).origin, authorize: authorizeInstallationManagement } } : {}),
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
        authorizeMany: (request, sessionIds, boundary, action, sessions) => authorizeSessionRequests(request, sessionIds, boundary, action, sessions),
      },
      turnDiffs: { store: repos.config,
        requestLarkReview: review => requestLarkTurnDiffReview({ configs: repos.config, mappings: repos.channelMappings, confirmations: collaboration?.participation.confirmations }, review) },
    });
    startupPhase('routes');
    logDroppedAgents(log, droppedAgents);
    // systemd socket 激活时用它传入的监听 socket：重启期间端口由 .socket unit 持有，连接排队而不是被拒。
    await app.listen(inherited ? inheritedListenOptions(inherited.fd) : listenOptions(config));
    if (inherited) {
      const mismatch = inheritedSocketMismatch(app.server.address(), config);
      if (mismatch) throw new Error(mismatch);
      log.info({ fd: inherited.fd }, '使用 systemd socket 激活传入的监听 socket');
    }
    startupPhase('listen');
    log.info({ startupMs: { ...startupMs, total: Math.round(process.uptime() * 1000) } }, '启动各阶段耗时');
    const watch = new DutydeckWatch({
      store: repos.config,
      collect: async () => collectWatchScopes(repos,
        await readLarkConfigs(repos.config, { readOnly: true }),
        { listeningDisabled: env.DUTYDECK_DISABLE_LARK_LISTENER === 'true', appId: env.DUTYDECK_BOT_APP_ID,
          // tmux 查询只读；Herdr 或非终端会话 captureAbsence 不给证据，按终端仍在处理。
          terminalAbsent: async session => Boolean(await ptyProvider.retirement?.captureAbsence?.(session)) }),
      send: async input => {
        const bots = await readLarkConfigs(repos.config, { readOnly: true });
        const bot = bots.find(bot => bot.appId === input.appId);
        const receiver = bot ? await resolveWatchReceiver(repos.config, bot) : undefined;
        if (!bot || !bot.listening || receiver?.id !== input.ownerId || receiver.type !== watchReceiverType(input.ownerId, input.ownerIdType)) throw new Error('巡检机器人或接收人已变更');
        try {
          return await createLarkCardService(env, workbenchHttp.fetch, bot).send({
            receiveId: receiver.id, receiveIdType: receiver.type,
            markdown: input.text, taskName: '巡检发现', state: 'completed', readOnly: true, idempotencyKey: input.idempotencyKey
          });
        } catch (error) {
          // 只有飞书确定拒收才不进入"结果未知"；其他失败可能已发出，保持原有重试。
          const rejection = error instanceof LarkServiceError ? watchDeliveryRejection(error.details) : undefined;
          throw rejection ?? error;
        }
      },
      warn: (details, message) => log.warn(details, message)
    });
    closeWatch = startDutydeckWatch(watch, error => log.warn({ error }, '只读巡检失败'));
    pluginResults.start();
    const sweepResources = () => {
      void pruneLarkResourceDirectories(resourceRoot, { readProtectedDirectories: () => timeLoop('lark.resource-references', loopLog, () => readLarkResourceReferences(repos.config, repos.tasks)) }).catch(error => log.warn({ error }, '飞书附件临时目录清理失败'));
      // 账本保留期清理：分批让出事件循环，关闭时在批间停下；不做 VACUUM，腾出的页留给后续写入复用。
      historyRetentionRun ??= (async () => {
        const startedAt = performance.now();
        const pruned = await repos.retention.prune({ signal: historyRetention.signal });
        if (Object.values(pruned).some(Boolean)) log.info({ retention: pruned, durationMs: Math.round(performance.now() - startedAt) }, '历史数据保留期清理');
      })().catch(error => log.warn({ error }, '历史数据保留期清理失败')).finally(() => { historyRetentionRun = undefined; });
    };
    resourceRetentionTimer = setInterval(sweepResources, 60 * 60_000);
    resourceRetentionTimer.unref();
    sweepResources();
    work.startWorkItems();
    work.startDelegations();
    schedules.start();
    groups.start();
  return { config, runtime, close: lifecycle.close, shutdownPhases: lifecycle.phases };
  } catch (error) {
    try { await lifecycle.close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Dutydeck startup and cleanup failed'); }
    throw error;
  }
}
