import { LarkGroupManager } from './lark/group-management.js';
import { readLarkConfigs } from './lark/config.js';
import { DockmuxRuntime } from '@dockmux/runtime';
import { loadConfig, type AppConfig } from '@dockmux/config';
import { createRepositories } from '@dockmux/storage';
import { type DriverFactory, type PolicyAction } from '@dockmux/shared';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { createRelayAskStore } from './relay-ask-store.js';
import { LarkAgentToolCapabilityRegistry, LarkAgentToolsService, loadOrCreateGroupToolsSigningSecret } from './lark/agent-tools.js';
import { getAuthToken, loadOrCreateAuthToken, tokensEqual } from './auth/auth.js';
import type { TerminalStreamProvider } from './terminal/terminal-ws.js';
import {
  createDockmuxPersistentBackend,
  createPtyCliDriver,
  PTY_AGENT_CONTRIBUTIONS,
  type BackendProbes,
  type PtyCliDriver,
} from '@dockmux/pty-driver';
import { createCliAdapter } from '@dockmux/cli-adapters';
import { RelayAskBroker, RelayCapabilityRegistry, RelayService, loadOrCreateRelaySigningSecret } from '@dockmux/relay';
import { LocalFileSecretProvider, localFileSecretProviderName, secretDirectoryForDatabase } from '@dockmux/secret-provider';
import { LarkIdentityPreflightProbe } from './lark/identity-preflight.js';
import {
  createFoundationExecutionAuthorizer,
  createFoundationManagementAuthorizer,
  createInstallationPrincipalResolver,
} from './foundation-policy.js';

export interface StartLocalServerOptions {
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
  runtime: DockmuxRuntime;
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
  return createDockmuxPersistentBackend(sessionId, probes);
}

export async function startLocalServer(options: StartLocalServerOptions = {}): Promise<LocalServer> {
  // pty-cli agent 发现：PTY_AGENT_CONTRIBUTIONS 经 loadConfig 合并进 config.agents
  // （builtinAgents 内部按 commandExists 过滤，只暴露本机已安装的 CLI；id 冲突时 ACPX 优先）。
  const config = loadConfig(options.env ?? process.env, PTY_AGENT_CONTRIBUTIONS);
  const repos = createRepositories(config.databaseUrl);
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
  catch (error) { repos.close(); throw error; }
  let relaySigningSecret: string;
  try { relaySigningSecret = await loadOrCreateRelaySigningSecret(repos.config); }
  catch (error) { repos.close(); throw error; }
  const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, localApiBaseUrl(config), groupToolsSigningSecret);
  // 通用回传通道：与飞书无关，任何来源的会话（含 Web 工作台创建的 pty-cli）都注入凭证。
  // command 前缀复用 groupToolsCommand 算出的运行期绝对路径——静态文案拿不到它，
  // 经 env 下发后由 @dockmux/relay 的 relayHintLines() 在提示块里读回。
  const relayCapabilities = new RelayCapabilityRegistry(
    repos.sessions,
    localApiBaseUrl(config),
    relaySigningSecret,
    options.groupToolsCommand
  );
  // 访问认证：默认启动时确保 token 存在（首次生成并打印到日志一次）。
  // 走 stderr 而非 stdout——daemon 子进程的 stdout 承载 daemon 协议的 JSON 输出，不能污染；
  // daemon 模式下 stderr 与 stdout 一起重定向到 dockmux.log，前台模式下直接可见。
  const mode = accessMode(config);
  let activeToken = '';
  let tokenRefresh: ReturnType<typeof setInterval> | undefined;
  if (config.authEnabled) {
    const { token: accessToken, created: tokenCreated } = await loadOrCreateAuthToken(repos.config);
    activeToken = accessToken;
    if (tokenCreated) {
      process.stderr.write(`[dockmux] Generated access token for remote access: ${accessToken}\n`);
      process.stderr.write(`[dockmux] Run 'dockmux auth token' to view it again, or 'dockmux auth token --rotate' to rotate it.\n`);
    }
    // WS 升级认证是同步钩子，token 又可能被 `dockmux auth token --rotate` 在另一个进程轮换，
    // 所以维护一份短周期刷新的缓存（HTTP 中间件每次请求直读 DB，不受此缓存影响）。
    tokenRefresh = setInterval(() => {
      getAuthToken(repos.config).then(current => { if (current) activeToken = current; }).catch(() => {});
    }, 5_000);
    tokenRefresh.unref();
  } else {
    process.stderr.write('[dockmux] WARNING: authentication is disabled. Everyone who can reach this address can view tasks, control Agents, and access terminals. Use only on a trusted network or behind upstream authentication.\n');
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
  const groupManager: LarkGroupManager = new LarkGroupManager(repos, { env, onPolicyChanged: (): Promise<void> => groupManager.refreshPolicies(runtime) });
  const agentTools = new LarkAgentToolsService(capabilities, repos.config, {
    env,
    groupToolsCommand: options.groupToolsCommand,
    executionPolicy: legacyExecutionPolicy,
    groupManager,
  });
  // pty-cli 协议驱动工厂：protocol='pty-cli' 的会话路由到 Dockmux 的 PtyCliDriver。
  // agent.id 即 adapter id（contributions 的 id 与 adapterId 一致）；自定义 pty-cli agent
  // 需用已知 adapter id 作为 agent id。
  const ptyDrivers = new Set<PtyCliDriver>();
  const ptyDriverFactory: DriverFactory = (agent, _protocol, onEvent, onExit, sessionId) => {
    const adapter = createCliAdapter(agent.id);
    let driver: PtyCliDriver;
    driver = createPtyCliDriver({
      agent,
      adapter,
      backend: createProductionPtyBackend(sessionId),
      onEvent,
      onExit: code => {
        ptyDrivers.delete(driver);
        onExit(code);
      },
      onStopped: () => ptyDrivers.delete(driver),
      sessionId,
    });
    ptyDrivers.add(driver);
    return driver;
  };
  const runtime = new DockmuxRuntime(repos, {
    authorizeExecution: (sessionId, actorId) => groupManager.beginTurn(sessionId, actorId),
    resolveRiskPolicy: (sessionId, fallback) => groupManager.riskPolicy(sessionId, fallback),
    acpxCommand: config.acpxCommand,
    ptyDriverFactory,
    driverIdleTimeoutMs: config.driverIdleTimeoutMs,
    cleanupIntervalMs: config.cleanupIntervalMs,
    sessionEnvironment: session => ({ ...capabilities.environmentFor(session), ...relayCapabilities.environmentFor(session.id) }),
    sessionPrompt: (session, prompt) => agentTools.promptForSession(session, prompt)
  });
  // 终端 WS 代理的会话→终端流访问器，走 runtime 的只读 getDriver 访问器（Team Core 已交付）。
  // driver 不实现 createTerminalStream（ACP 形态）→ unsupported；driver 未连接/已释放 → no-session。
  // onExit 信号走 runtime.onDriverExit 正式订阅（Team Core 已交付），不再匹配 error 事件文本。
  const terminalProvider: TerminalStreamProvider = {
    lookupTerminalStream(sessionId) {
      const driver = runtime.getDriver(sessionId);
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
  let closed = false;
  const relayBroker = new RelayAskBroker({
    async publish(sessionId, input) {
      await runtime.publishSessionEvent(sessionId, 'text', {
        text: input.text,
        relay: input.kind,
        ...(input.askId ? { askId: input.askId } : {})
      });
    }
  }, createRelayAskStore(repos.config));
  try {
    await relayBroker.initialize();
    await runtime.initialize(config.agents);
    const webRoot = options.webRoot ?? fileURLToPath(new URL('../public', import.meta.url));
    app = await buildApp(runtime, {
      webRoot,
      system: { directoryRoots: async () => [...config.agents.map(agent => agent.cwd).filter((cwd): cwd is string => Boolean(cwd)), ...(await readLarkConfigs(repos.config)).map(bot => bot.workspace).filter((cwd): cwd is string => Boolean(cwd))] },
      lark: {
        relayBroker,
        env,
        config: repos.config,
        agents: repos.agents,
        cardMappings: repos.channelMappings,
        runtime,
        agentTools,
        executionPolicy: legacyExecutionPolicy,
    groupManager,
        listeningDisabled: env.DOCKMUX_DISABLE_LARK_LISTENER === 'true',
      },
      auth: {
        mode,
        getToken: () => config.authEnabled ? getAuthToken(repos.config) : Promise.resolve(null),
        localOnly: mode === 'local'
      },
      terminal: {
        provider: terminalProvider,
        auth: { mode, allowUnauthenticated: mode === 'local', check: presented => !!presented && tokensEqual(presented, activeToken) },
        authorize: async (request, sessionId, action) => await groupManager.authorizeSession(sessionId, action, true) ?? foundationExecution.authorizeSessionId(sessionId, {
          boundary: 'terminal',
          action,
          request,
        }),
      },
      relay: { runtime, capabilities: relayCapabilities, broker: relayBroker },
      foundation: { repositories: repos, authorize: foundationManagementAuthorizer, inspectSecretRef, isLiveManagedBot: id => groupManager.isLiveManagedBot(id) },
      identityPreflight: { repositories: repos, authorize: foundationManagementAuthorizer, probe: identityPreflightProbe, now: options.identityPreflight?.now },
      schedule: { repositories: repos, authorize: foundationManagementAuthorizer },
      executionPolicy: {
        authorize: async (request, sessionId, boundary, action) => await groupManager.authorizeSession(sessionId, action, true) ?? foundationExecution.authorizeSessionId(sessionId, {
          boundary,
          action,
          request,
        }),
      },
    });
    await app.listen(listenOptions(config));
  } catch (error) {
    if (tokenRefresh) clearInterval(tokenRefresh);
    capabilities.close(); await runtime.shutdown(); repos.close(); throw error;
  }
  return {
    config,
    runtime,
    async close() {
      if (closed) return;
      closed = true;
      if (tokenRefresh) clearInterval(tokenRefresh);
      // 先唤醒所有阻塞中的 ask，再关 app：否则长轮询请求会拖住 app.close()。
      relayBroker.close();
      // A normal daemon stop/restart detaches Dockmux-owned tmux sessions.
      // Explicit session stop/restart never passes through here and continues
      // to destroy its backend as requested by the user.
      for (const driver of ptyDrivers) driver.prepareForDaemonShutdown();
      const results = await Promise.allSettled([relayBroker.flush(), app?.close() ?? Promise.resolve(), runtime.shutdown()]);
      capabilities.close();
      repos.close();
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Dockmux did not shut down cleanly');
    }
  };
}
