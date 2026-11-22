import type { ReplyPolish } from '../lark/reply-polish.js';
import { ArtifactSnapshots } from '../artifact-snapshots.js';
import { PluginHost } from '../plugins/host.js';
import { PluginResultError } from '../plugins/result-service.js';
import { AgentModelSettings } from '../agent-model-settings.js';
import { createSessionContexts } from '../session-context.js';
import { sessionUsageSnapshot } from '../session-usage.js';
import { TerminalSettings } from '../terminal-settings.js';
import { HerdrSessions } from '../herdr.js';
import { installationOwnerTaskActor, RuntimeError } from '@dutydeck/shared';
import { dirname } from 'node:path';
import { buildApp } from '../app.js';
import { parsePeerInstances } from '../instance-proxy.js';
import { localLoopbackUrl } from '../local-api-url.js';
import { createWorkbenchFetch } from '../workbench-fetch.js';
import type { TerminalStreamProvider } from '../terminal/terminal-ws.js';
import { RelayCapabilityRegistry } from '@dutydeck/relay';
import { WorkspaceOrganizationService } from '../workspace-organization.js';
import { SessionInsightService } from '../session-insight-service.js';
import { wirePlugins } from '../plugins/service-wiring.js';
import type { ComposeContext } from './context.js';
import type { BuildAppOptions } from '../app.js';
import type { composeAuth } from './auth.js';
import { sessionAuthorization } from './auth.js';
import type { composeRuntime } from './runtime.js';
import type { composeWork } from './work.js';
import type { composePluginResults } from './plugins.js';
import type { composeAutomation } from './automation.js';
import type { composeCollaboration } from './collaboration.js';
import type { LarkGroupManager } from '../lark/group-management.js';
import type { LarkAgentToolsService } from '../lark/agent-tools.js';
import type { LarkMemoryPipeline } from '../lark/memory-pipeline.js';

interface HttpDependencies {
  auth: Awaited<ReturnType<typeof composeAuth>>;
  execution: ReturnType<typeof composeRuntime>;
  work: ReturnType<typeof composeWork>;
  schedules: ReturnType<typeof composeAutomation>;
  groups: ReturnType<typeof composeCollaboration>;
  pluginResults: ReturnType<typeof composePluginResults>;
  pluginHost?: PluginHost;
  pluginWiring?: ReturnType<typeof wirePlugins>;
  insightService?: SessionInsightService;
  groupManager: LarkGroupManager;
  agentTools: LarkAgentToolsService;
  relayCapabilities: RelayCapabilityRegistry;
  terminalSettings: TerminalSettings;
  agentModelSettings: AgentModelSettings;
  herdr: HerdrSessions;
  workspaceOrganizationService: WorkspaceOrganizationService;
  isAutomatedTask: (id: string) => boolean;
  inspectSecretRef: NonNullable<BuildAppOptions['foundation']>['inspectSecretRef'];
  identityPreflightProbe: NonNullable<BuildAppOptions['identityPreflight']>['probe'];
  polishReply: ReplyPolish;
  workbenchHttp: ReturnType<typeof createWorkbenchFetch>;
  memoryPipeline: LarkMemoryPipeline;
  resourceRoot: string;
  webRoot: string;
}

export async function composeHttp({ config, env, repos, options, log, channel, lifecycle }: ComposeContext, deps: HttpDependencies) {
  const { auth, execution, groups, work, schedules, pluginResults, pluginHost, pluginWiring, groupManager,
    resourceRoot, webRoot, insightService, terminalSettings, agentModelSettings, herdr, relayCapabilities, agentTools,
    workbenchHttp, memoryPipeline, polishReply, isAutomatedTask, workspaceOrganizationService, inspectSecretRef, identityPreflightProbe } = deps;
  const { runtime, workspaceApprovals, sessionAgentConfig, projectMemory, usageLedger } = execution;
  const { businessToolGrants, businessTools, pluginResultIdentity, pluginResultRegistry, pluginResultAdapter, pluginResultService } = pluginResults;
  const { collaboration, memoryStore } = groups;
  const { workbench, workItems, delegations, workInteractions, relayBroker, relayContinuation } = work;
  const { resolveInstallationPrincipal, authorizeInstallationManagement, foundationManagementAuthorizer, foundationExecution, legacyExecutionPolicy } = auth;
  const { automation, automationIntegration, ciWebhook } = schedules;
  const { larkResultDeliveryIssues, readLarkConfigs, larkAgentSessionBinding, larkMemoryScope, requestLarkTurnDiffReview } = channel;
  const { authorizeSessionRequest, authorizeSessionRequests } = sessionAuthorization(runtime, workItems, groupManager, auth);
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
  const app = await buildApp(runtime, {
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
    usage: { ledger: usageLedger, snapshot: sessionId => sessionUsageSnapshot(repos, sessionId, env), contexts: createSessionContexts(repos), authorize: async request => Boolean(await resolveInstallationPrincipal(request)) },
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
    ...(businessTools ? { pluginBusinessTools: { service: businessTools, grants: businessToolGrants, origin: new URL(localLoopbackUrl(config.host, config.port)).origin, authorize: authorizeInstallationManagement } } : {}),
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
      requestLarkReview: (review, waitForListener) => requestLarkTurnDiffReview({ waitForListener, configs: repos.config, mappings: repos.channelMappings, confirmations: collaboration.participation.confirmations }, review) },
  });
  lifecycle.register('http', () => app.close(), false);
  return app;
}
