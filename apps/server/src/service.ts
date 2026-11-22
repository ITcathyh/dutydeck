import { composeHttp } from './compose/http.js';
import { composeMaintenance } from './compose/maintenance.js';
import { composeCollaboration } from './compose/collaboration.js';
import { composeWork } from './compose/work.js';
import { composeAutomation } from './compose/automation.js';
import { composeDrivers, composeRuntime } from './compose/runtime.js';
import { composePlugins, composePluginResults } from './compose/plugins.js';
import { composeAgentTools, composeCapabilities } from './compose/agent-tools.js';
import { composeAuth } from './compose/auth.js';
import { ServerLifecycle } from './compose/lifecycle.js';
import { composeInsight } from './compose/insight.js';
import { listenOptions, unauthenticatedListenRefusal } from './access-policy.js';
import { LarkReplyPolisher, type ReplyPolish } from './lark/reply-polish.js';
import { createRelayAskLifecycleWatcher } from './relay-routes.js';
import { inheritedListenOptions, inheritedSocketMismatch, takeInheritedListenSocket } from './socket-activation.js';
import { assertDatabaseNotQuarantined } from '@dutydeck/storage';
import { larkAgentSessionBinding } from './lark/agent-tools.js';
import { withClaudeAutoMemoryMarker } from './lark/claude-auto-memory.js';
import { instancePrivatePaths } from './lark/artifact-delivery.js';
import { LarkPluginResultAdapter } from './lark/plugin-result-delivery.js';
import { LarkPluginResultIdentity, type PluginResultIdentityOptions } from './lark/plugin-result-identity.js';
import { AgentModelSettings } from './agent-model-settings.js';
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
import { backfillBotPromptVersions, larkMemoryEnabled, readLarkConfig, readLarkConfigs } from './lark/config.js';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { loadConfigWithDiagnosticsAsync, resolveDatabaseUrl, type AppConfig } from '@dutydeck/config';
import { logDroppedAgents } from './agent-config-log.js';
import { assertBotProcessStartup, createRepositories } from '@dutydeck/storage';
import { larkResourceRoot } from './resource-retention.js';
import { fileURLToPath } from 'node:url';
import { createAppLogger } from './app.js';
import { LarkWorkbench } from './lark/workbench.js';
import { createLarkCardService, LarkServiceError } from './lark/service.js';
import { deliverLarkSessionNotice } from './lark/session-notice.js';
import { createWorkbenchFetch } from './workbench-fetch.js';
import { LarkAgentToolsService } from './lark/agent-tools.js';
import { larkMemoryScope, LarkMemoryStore } from './lark/memory.js';
import { LarkMemoryProjection } from './lark/memory-view.js';
import { LarkMemoryPipeline } from './lark/memory-pipeline.js';
import { setLarkSessionShareSigner, setLarkTurnDiffSigner } from './lark/detail-link.js';
import { requestLarkTurnDiffReview } from './lark/turn-diff.js';
import { createDutydeckPersistentBackend, PTY_AGENT_CONTRIBUTIONS } from '@dutydeck/pty-driver';
import { LocalFileSecretProvider, localFileSecretProviderName, secretDirectoryForDatabase } from '@dutydeck/secret-provider';
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
  const env = options.env ?? process.env;
  assertDatabaseNotQuarantined(resolveDatabaseUrl(env));
  const { host: pluginHost, scenarios } = await loadDaemonPlugins(env);
  startupPhase('plugins');
  const { config, droppedAgents, repos } = await (async () => {
    try {
      const { config, droppedAgents } = await loadConfigWithDiagnosticsAsync(env, PTY_AGENT_CONTRIBUTIONS, pluginHost?.agents);
      startupPhase('config');
      const refusal = unauthenticatedListenRefusal(config, env);
      if (refusal) throw new Error(refusal);
      assertBotProcessStartup(config.databaseUrl, env.DUTYDECK_BOT_APP_ID);
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
    assertBotProcessStartup(config.databaseUrl, env.DUTYDECK_BOT_APP_ID);
    // 发往飞书的文本按原值抹掉服务环境和各 Agent 配置里的凭据（见 platform/secret-redaction）。
    rememberSecretValues(env);
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
    const { legacyExecutionPolicy } = auth;
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
    const execution = composeRuntime(context, {
      drivers, pluginHost, pluginWiring, groupManager, workbenchHttp, capabilities, relayCapabilities, herdr,
      agentTools, agentModelSettings, isAutomatedTask,
    }, {
      workItems: () => workItems, delegations: () => delegations, collaboration: () => collaboration,
      schedules: () => schedules, awaitingAnswer: id => relayBroker.listPending(id).length > 0,
    });
    const { runtime, usageLedger } = execution;
    const replyPolisher = new LarkReplyPolisher({ runtime, repos, log: { warn: (details, message) => log.warn(details, message) } });
    const workspaceOrganizationService = new WorkspaceOrganizationService({
      config: repos.config,
      listSessions: () => runtime.listSessions(),
    });
    const insightService = await composeInsight(context, workspaceOrganizationService, runtime, startupPhase);
    startupPhase('insight');
    const pluginResults = composePluginResults(context, {
      pluginHost, pluginWiring, runtime, capabilities, relayCapabilities, groupManager, workbenchHttp, legacyExecutionPolicy,
    });
    const schedules = composeAutomation(context, runtime, groupManager, workbenchHttp, pluginHost, pluginWiring, {
      workItems: () => workItems, awaitingAnswer: id => relayBroker.listPending(id).length > 0,
      mandateCards: { callback: (...args) => collaboration.mandateCards.callback(...args) },
    });
    const { automationIntegration } = schedules;
    const work = composeWork(context, runtime, groupManager, workbenchHttp, automationIntegration);
    const { workItems, delegations, relayBroker, relayContinuation } = work;
    lifecycle.assembledCore();
    const groups = composeCollaboration(context, runtime, groupManager, workbenchHttp, usageLedger, polishReply, scenarios);
    const { collaboration } = groups;
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
    const app = await composeHttp(context, {
      auth, execution, groups, work, schedules, pluginResults, pluginHost, pluginWiring, groupManager, resourceRoot,
      webRoot, insightService, terminalSettings, agentModelSettings, herdr, relayCapabilities, agentTools, workbenchHttp,
      memoryPipeline, polishReply, isAutomatedTask, workspaceOrganizationService, inspectSecretRef, identityPreflightProbe,
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
    const maintenanceStarts = composeMaintenance(context, workbenchHttp, ptyProvider, resourceRoot);
    lifecycle.startBackground({ ...maintenanceStarts, ...pluginResults.start, ...work.start, ...schedules.start, ...groups.start });
    return { config, runtime, close: lifecycle.close, shutdownPhases: lifecycle.phases };
  } catch (error) {
    try { await lifecycle.close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Dutydeck startup and cleanup failed'); }
    throw error;
  }
}
