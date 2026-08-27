import { DockmuxRuntime } from '@dockmux/runtime';
import { loadConfig, type AppConfig } from '@dockmux/config';
import { createRepositories } from '@dockmux/storage';
import type { DriverFactory } from '@dockmux/shared';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { LarkAgentToolCapabilityRegistry, LarkAgentToolsService, loadOrCreateGroupToolsSigningSecret } from './lark/agent-tools.js';
import { getAuthToken, isLoopbackAddress, loadOrCreateAuthToken, tokensEqual } from './auth/auth.js';
import type { TerminalStreamProvider } from './terminal/terminal-ws.js';
import { createPtyCliDriver, PTY_AGENT_CONTRIBUTIONS } from '@dockmux/pty-driver';
import { createCliAdapter } from '@dockmux/cli-adapters';

export interface StartLocalServerOptions { env?: NodeJS.ProcessEnv; webRoot?: string; groupToolsCommand?: string }
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

function localApiBaseUrl(config: Pick<AppConfig, 'host' | 'port'>) {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${config.port}`;
}

export async function startLocalServer(options: StartLocalServerOptions = {}): Promise<LocalServer> {
  // pty-cli agent 发现：PTY_AGENT_CONTRIBUTIONS 经 loadConfig 合并进 config.agents
  // （builtinAgents 内部按 commandExists 过滤，只暴露本机已安装的 CLI；id 冲突时 ACPX 优先）。
  const config = loadConfig(options.env ?? process.env, PTY_AGENT_CONTRIBUTIONS);
  const repos = createRepositories(config.databaseUrl);
  let groupToolsSigningSecret: string;
  try { groupToolsSigningSecret = await loadOrCreateGroupToolsSigningSecret(repos.config); }
  catch (error) { repos.close(); throw error; }
  const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, localApiBaseUrl(config), groupToolsSigningSecret);
  const env = options.env ?? process.env;
  const agentTools = new LarkAgentToolsService(capabilities, repos.config, { env, groupToolsCommand: options.groupToolsCommand });
  // 访问认证：启动时确保 token 存在（首次生成并打印到日志一次）。
  // 走 stderr 而非 stdout——daemon 子进程的 stdout 承载 daemon 协议的 JSON 输出，不能污染；
  // daemon 模式下 stderr 与 stdout 一起重定向到 dockmux.log，前台模式下直接可见。
  const { token: accessToken, created: tokenCreated } = await loadOrCreateAuthToken(repos.config);
  if (tokenCreated) {
    process.stderr.write(`[dockmux] Generated access token for remote access: ${accessToken}\n`);
    process.stderr.write(`[dockmux] Run 'dockmux auth token' to view it again, or 'dockmux auth token --rotate' to rotate it.\n`);
  }
  // WS 升级认证是同步钩子，token 又可能被 `dockmux auth token --rotate` 在另一个进程轮换，
  // 所以维护一份短周期刷新的缓存（HTTP 中间件每次请求直读 DB，不受此缓存影响）。
  let activeToken = accessToken;
  const tokenRefresh = setInterval(() => {
    getAuthToken(repos.config).then(current => { if (current) activeToken = current; }).catch(() => {});
  }, 5_000);
  tokenRefresh.unref();
  // pty-cli 协议驱动工厂：protocol='pty-cli' 的会话路由到 PtyCliDriver（botmux 适配器栈）。
  // agent.id 即 adapter id（contributions 的 id 与 adapterId 一致）；自定义 pty-cli agent
  // 需用已知 adapter id 作为 agent id。
  const ptyDriverFactory: DriverFactory = (agent, _protocol, onEvent, onExit, sessionId) => {
    const adapter = createCliAdapter(agent.id);
    return createPtyCliDriver({ agent, adapter, onEvent, onExit, sessionId });
  };
  const runtime = new DockmuxRuntime(repos, {
    acpxCommand: config.acpxCommand,
    ptyDriverFactory,
    driverIdleTimeoutMs: config.driverIdleTimeoutMs,
    cleanupIntervalMs: config.cleanupIntervalMs,
    sessionEnvironment: session => capabilities.environmentFor(session),
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
  try {
    await runtime.initialize(config.agents);
    const webRoot = options.webRoot ?? fileURLToPath(new URL('../public', import.meta.url));
    app = await buildApp(runtime, {
      webRoot,
      lark: { env, config: repos.config, agents: repos.agents, cardMappings: repos.channelMappings, runtime, agentTools, listeningDisabled: env.DOCKMUX_DISABLE_LARK_LISTENER === 'true' },
      auth: {
        getToken: () => getAuthToken(repos.config),
        localOnly: config.host === '127.0.0.1'
      },
      terminal: {
        provider: terminalProvider,
        auth: { isLoopback: isLoopbackAddress, check: presented => !!presented && tokensEqual(presented, activeToken) }
      }
    });
    await app.listen(listenOptions(config));
  } catch (error) {
    clearInterval(tokenRefresh);
    capabilities.close(); await runtime.shutdown(); repos.close(); throw error;
  }
  return {
    config,
    runtime,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(tokenRefresh);
      const results = await Promise.allSettled([app?.close() ?? Promise.resolve(), runtime.shutdown()]);
      capabilities.close();
      repos.close();
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Dockmux did not shut down cleanly');
    }
  };
}
