import { resolveExplicitFinalContext } from './lark/explicit-final.js';
import { createCollaborationIntegration } from './collaboration-integration.js';
import { LeaderDelegationService } from './leader-delegation.js';
import { renderMemoryIndex } from './lark/memory-view.js';
import type { CollaborationExtensions } from './collaboration-extensions.js';
import { LarkGroupManager } from './lark/group-management.js';
import { readLarkConfigs } from './lark/config.js';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { loadConfig, type AppConfig } from '@dutydeck/config';
import { childProcessIdentity, createRepositories, observeProcess } from '@dutydeck/storage';
import { createPtyRetirementControl } from './pty-recovery.js';
import { installationOwnerTaskActor, workPlanConfirmationRequired, type DriverFactory, type PolicyAction, type PolicyDecision } from '@dutydeck/shared';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { WorkItemService } from './work-items.js';
import { WorkItemInteractions } from './work-item-interactions.js';
import { LarkWorkbench } from './lark/workbench.js';
import { createLarkCardService } from './lark/service.js';
import { createWorkbenchFetch } from './workbench-fetch.js';
import { authorizeWorkItemAgent, authorizeWorkItemInteraction, workItemRiskPolicy } from './work-item-policy.js';
import { SessionAutomationService } from './session-automation.js';
import { createAutomationIntegration } from './automation-integration.js';
import { prepareSkillPrompt } from './skill-delivery.js';
import { createRelayAskStore } from './relay-ask-store.js';
import { LarkAgentToolCapabilityRegistry, LarkAgentToolsService, loadOrCreateGroupToolsSigningSecret } from './lark/agent-tools.js';
import { LarkMemoryStore } from './lark/memory.js';
import { LarkMemoryProjection } from './lark/memory-view.js';
import { LarkMemoryPipeline } from './lark/memory-pipeline.js';
import { getAuthToken, loadOrCreateAuthToken, tokensEqual } from './auth/auth.js';
import type { TerminalStreamProvider } from './terminal/terminal-ws.js';
import {
  createDutydeckPersistentBackend,
  createPtyCliDriver,
  PTY_AGENT_CONTRIBUTIONS,
  type BackendProbes,
} from '@dutydeck/pty-driver';
import { createCliAdapter } from '@dutydeck/cli-adapters';
import { RelayAskBroker, RelayCapabilityRegistry, RelayService, loadOrCreateRelaySigningSecret } from '@dutydeck/relay';
import { LocalFileSecretProvider, localFileSecretProviderName, secretDirectoryForDatabase } from '@dutydeck/secret-provider';
import { LarkIdentityPreflightProbe } from './lark/identity-preflight.js';
import {
  createFoundationExecutionAuthorizer,
  createFoundationManagementAuthorizer,
  createInstallationPrincipalResolver,
} from './foundation-policy.js';

export interface StartLocalServerOptions {
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

function localApiBaseUrl(config: Pick<AppConfig, 'host' | 'port'>) {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${config.port}`;
}

/** Production PTY-CLI policy: persistent tmux or a hard failure, never an
 * implicit downgrade to the in-process PtyBackend. */
export function createProductionPtyBackend(
  sessionId: string,
  probes?: BackendProbes,
) {
  return createDutydeckPersistentBackend(sessionId, probes);
}

export async function startLocalServer(options: StartLocalServerOptions = {}): Promise<LocalServer> {
  // pty-cli agent 发现：PTY_AGENT_CONTRIBUTIONS 经 loadConfig 合并进 config.agents
  // （builtinAgents 内部按 commandExists 过滤，只暴露本机已安装的 CLI；id 冲突时 ACPX 优先）。
  const config = loadConfig(options.env ?? process.env, PTY_AGENT_CONTRIBUTIONS);
  const repos = createRepositories(config.databaseUrl, { mode: 'runtime', newDatabaseAuthority: 'ledger_v1' });
  const setupCleanup: Array<() => unknown> = [];
  let closeResources = async () => {
    const results = await Promise.allSettled(setupCleanup.reverse().map(close => Promise.resolve().then(close)));
    repos.close();
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Dutydeck setup cleanup failed');
  };
  try {
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
  const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, localApiBaseUrl(config), groupToolsSigningSecret);
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
  // 访问认证：默认启动时确保 token 存在（首次生成并打印到日志一次）。
  // 走 stderr 而非 stdout——daemon 子进程的 stdout 承载 daemon 协议的 JSON 输出，不能污染；
  // daemon 模式下 stderr 与 stdout 一起重定向到 dutydeck.log，前台模式下直接可见。
  const mode = accessMode(config);
  let activeToken = '';
  let tokenRefresh: ReturnType<typeof setInterval> | undefined;
  if (config.authEnabled) {
    const { token: accessToken, created: tokenCreated } = await loadOrCreateAuthToken(repos.config);
    activeToken = accessToken;
    if (tokenCreated) {
      process.stderr.write(`[dutydeck] Generated access token for remote access: ${accessToken}\n`);
      process.stderr.write(`[dutydeck] Run 'dutydeck auth token' to view it again, or 'dutydeck auth token --rotate' to rotate it.\n`);
    }
    // WS 升级认证是同步钩子，token 又可能被 `dutydeck auth token --rotate` 在另一个进程轮换，
    // 所以维护一份短周期刷新的缓存（HTTP 中间件每次请求直读 DB，不受此缓存影响）。
    tokenRefresh = setInterval(() => {
      getAuthToken(repos.config).then(current => { if (current) activeToken = current; }).catch(() => {});
    }, 5_000);
    tokenRefresh.unref();
    setupCleanup.push(() => { if (tokenRefresh) clearInterval(tokenRefresh); });
  } else {
    process.stderr.write('[dutydeck] WARNING: authentication is disabled. Everyone who can reach this address can view tasks, control Agents, and access terminals. Use only on a trusted network or behind upstream authentication.\n');
  }
  const resolveInstallationPrincipal = createInstallationPrincipalResolver({
    authEnabled: config.authEnabled,
    mode,
    getToken: () => config.authEnabled ? getAuthToken(repos.config) : Promise.resolve(null),
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
  const agentTools = new LarkAgentToolsService(capabilities, repos.config, {
    env,
    groupToolsCommand: options.groupToolsCommand,
    workbenchTask: sessionId => runtime.getActiveTaskContext(sessionId),
    finalTaskContext: async (binding, task) => resolveExplicitFinalContext(await repos.channelMappings.list(`lark-card:${binding.appId}`), binding, task),
    authorizeTool: (sessionId, action) => collaboration?.background.authorizeTool(sessionId, action) ?? Promise.resolve(),
    executionPolicy: legacyExecutionPolicy,
    groupManager,
  });
  // pty-cli 协议驱动工厂：protocol='pty-cli' 的会话路由到 Dutydeck 的 PtyCliDriver。
  // 自定义命令可通过 adapterId 复用已有 CLI 家族，同时保留独立 agent id。
  const ptyDriverFactory: DriverFactory = (agent, _protocol, onEvent, onExit, sessionId) => {
    const adapter = createCliAdapter(agent.adapterId ?? agent.id);
    return createPtyCliDriver({
      agent,
      adapter,
      backend: createProductionPtyBackend(sessionId),
      processProbe: { identify: childProcessIdentity, observe: observeProcess },
      onEvent,
      onExit,
      sessionId,
    });
  };
  const runtime: DutydeckRuntime = new DutydeckRuntime(repos, {
    ptyRetirement: createPtyRetirementControl({ identify: childProcessIdentity, observe: observeProcess }),
    authorizeTask: async (session, task, phase) => { await collaboration?.background.authorizeTask(session, task); await automation.authorizeTask(task, phase); await workItems.authorizeTask(session, task, phase); },
    authorizeControl: async (sessionId, actor, _action) => {
      if (await workItems.authorizeControl(sessionId, actor)) return;
      if (await collaboration?.background.authorizeControl(sessionId, actor)) return;
      if (actor.kind !== 'installation_owner' && actor.kind !== 'unspecified') await groupManager.prepareTurn(sessionId, actor.id);
    },
    authorizeExecution: async (sessionId, actorId) => {
      if (await collaboration?.background.authorizeExecution(sessionId, actorId)) return;
      // work item 授权先行判断并自行短路；其余会话把 prepareTurn 返回的可选本地提交
      // 交回 Runtime，由其短写序列在归属校验后执行（prepare 不写运行身份）。
      if (await workItems.authorizeExecution(sessionId, actorId)) return;
      return groupManager.prepareTurn(sessionId, actorId);
    },
    resolveRiskPolicy: async (sessionId, fallback) => {
      const background = await collaboration?.riskPolicy(sessionId, fallback);
      if (background) return background.policy;
      const binding = await workItems.parentForSession(sessionId) ?? await delegations.parentForSession(sessionId);
      return binding ? workItemRiskPolicy(repos, groupManager, binding.parentSessionId, binding.actorId, fallback, env, workbenchHttp.fetch) : groupManager.riskPolicy(sessionId, fallback);
    },
    acpxCommand: config.acpxCommand,
    ptyDriverFactory,
    driverIdleTimeoutMs: config.driverIdleTimeoutMs,
    cleanupIntervalMs: config.cleanupIntervalMs,
    sessionEnvironment: session => ({ ...capabilities.environmentFor(session), ...relayCapabilities.environmentFor(session.id) }),
    prepareTaskPrompt: (session, prompt, skills) => prepareSkillPrompt(session.cwd, prompt, skills),
    sessionPrompt: (session, prompt) => agentTools.promptForSession(session, prompt)
  });
  setupCleanup.push(() => runtime.shutdown());
  const automationIntegration = createAutomationIntegration(repos, runtime, groupManager, { env, client: config => createLarkCardService(env, workbenchHttp.fetch, config), log: { warn: (...args: unknown[]) => app?.log.warn(...args as [unknown, string]) } });
  const automation = new SessionAutomationService({ repositories: repos, runtime, ...automationIntegration,
    githubToken: env.DUTYDECK_GITHUB_TOKEN ?? env.GH_TOKEN ?? env.GITHUB_TOKEN });
  setupCleanup.push(() => automation.close());
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
      if (tokenRefresh) clearInterval(tokenRefresh);
      if (automationTimer) clearInterval(automationTimer);
      if (collaborationTimer) clearInterval(collaborationTimer);
      const errors: unknown[] = [];
      const settle = async (operations: Array<() => unknown>) => {
        const results = await Promise.allSettled(operations.map(operation => Promise.resolve().then(operation)));
        errors.push(...results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason));
      };
      await settle([() => workbench.close(), () => workbenchHttp.close(), () => workItems.close(), () => delegations.close(), () => automation.close()]);
      // Wake blocked asks before waiting for HTTP shutdown.
      await settle([() => relayBroker.close()]);
      await settle([() => collaboration?.close(), () => relayBroker.flush(), () => app?.close(), () => runtime.shutdown()]);
      await settle([() => capabilities.close()]);
      await settle([() => repos.close()]);
      if (errors.length) throw new AggregateError(errors, 'Dutydeck did not shut down cleanly');
    })();
    return closeRun;
  };
    collaboration = createCollaborationIntegration({ repositories: repos, runtime, groups: groupManager,
      workspaceRoot: config.databaseUrl === ':memory:' ? join(tmpdir(), 'dutydeck-decisions') : join(dirname(resolve(config.databaseUrl)), 'decisions'),
      client: bot => createLarkCardService(env, workbenchHttp.fetch, bot), configureExtensions: options.configureCollaborationExtensions,
      readMemory: scope => readCollaborationMemory(scope),
      listeningDisabled: env.DUTYDECK_DISABLE_LARK_LISTENER === 'true',
      log: { warn: (details, message) => app?.log.warn(details, message) } });
    setupCleanup.push(() => collaboration?.close());
    await relayBroker.initialize();
    await runtime.initialize(config.agents);
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
    readCollaborationMemory = async scope => {
      const bot = (await readLarkConfigs(repos.config)).find(entry => entry.appId === scope.appId);
      return bot?.memoryEnabled === false ? '' : renderMemoryIndex(await memoryStore.list(scope), await memoryStore.getState(scope)).text;
    };
    app = await buildApp(runtime, {
      recovery: { authorize: async request => Boolean(await resolveInstallationPrincipal(request)) },
      webRoot,
      collaboration: { service: collaboration.service, runtime, tools: agentTools, evaluation: collaboration.evaluation, extensions: collaboration.extensions,
        authorizeManagement: async request => await resolveInstallationPrincipal(request) ? installationOwnerTaskActor : undefined,
        bootstrap: scope => collaboration!.participation.bootstrap(scope), prepareSettings: (scope, patch) => collaboration!.prepareSettings(scope, patch), onChange: scope => collaboration!.onChange(scope) },
      system: { directoryRoots: async () => [...config.agents.map(agent => agent.cwd).filter((cwd): cwd is string => Boolean(cwd)), ...(await readLarkConfigs(repos.config)).map(bot => bot.workspace).filter((cwd): cwd is string => Boolean(cwd))] },
      lark: {
        participation: collaboration.participation,
        automation,
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
          projection: memoryProjection,
          command: options.groupToolsCommand ?? 'dutydeck',
          pipeline: memoryPipeline
        },
        listeningDisabled: env.DUTYDECK_DISABLE_LARK_LISTENER === 'true',
      },
      auth: {
        mode,
        getToken: () => config.authEnabled ? getAuthToken(repos.config) : Promise.resolve(null),
        localOnly: mode === 'local'
      },
      terminal: {
        provider: terminalProvider,
        auth: { mode, allowUnauthenticated: mode === 'local', check: presented => !!presented && tokensEqual(presented, activeToken) },
        authorize: (request, sessionId, action) => authorizeSessionRequest(request, sessionId, 'terminal', action),
      },
      relay: { runtime, capabilities: relayCapabilities, broker: relayBroker },
      foundation: { repositories: repos, authorize: foundationManagementAuthorizer, inspectSecretRef, isLiveManagedBot: id => groupManager.isLiveManagedBot(id) },
      identityPreflight: { repositories: repos, authorize: foundationManagementAuthorizer, probe: identityPreflightProbe, now: options.identityPreflight?.now },
      schedule: { repositories: repos, authorize: foundationManagementAuthorizer, uiEntryReady: true, collaborationExecutorWired: true },
      workItemTools: { runtime, work: workItems, tools: agentTools, delegations },
      // 与 coordinator 的记忆存储同一个 configs 仓库（listener 的 workflowStore 就是 repos.config）。
      memoryTools: { tools: agentTools, store: memoryStore, runtime },
      workItems: { service: workItems, interactions: workInteractions, authorize: async (request, sessionId, action) => {
        if (!await resolveInstallationPrincipal(request)) return false;
        const decision = await groupManager.authorizeSession(sessionId, action, true) ?? await foundationExecution.authorizeSessionId(sessionId, { boundary: 'session', action, request });
        return { ...decision, actorId: installationOwnerTaskActor };
      } },
      automation: { service: automation, authorize: async (request, sessionId, action) => {
        const principal = await resolveInstallationPrincipal(request);
        if (!principal) return false;
        const decision = await groupManager.authorizeSession(sessionId, action, true) ?? await foundationExecution.authorizeSessionId(sessionId, { boundary: 'session', action, request });
        return { ...decision, actorId: installationOwnerTaskActor };
      } },
      executionPolicy: {
        authorize: (request, sessionId, boundary, action) => authorizeSessionRequest(request, sessionId, boundary, action),
      },
    });
    await app.listen(listenOptions(config));
    workItems.start();
    void delegations.start().catch(error => app?.log.warn({ error }, '分层协作规划恢复失败'));
    const tick = () => { void automation.tick().catch(error => app?.log.warn({ error }, '自动任务轮询失败')); };
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
