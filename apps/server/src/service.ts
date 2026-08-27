import { DockmuxRuntime } from '@dockmux/runtime';
import { loadConfig, type AppConfig } from '@dockmux/config';
import { createRepositories } from '@dockmux/storage';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { LarkAgentToolCapabilityRegistry, LarkAgentToolsService, loadOrCreateGroupToolsSigningSecret } from './lark/agent-tools.js';

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
  const config = loadConfig(options.env ?? process.env);
  const repos = createRepositories(config.databaseUrl);
  let groupToolsSigningSecret: string;
  try { groupToolsSigningSecret = await loadOrCreateGroupToolsSigningSecret(repos.config); }
  catch (error) { repos.close(); throw error; }
  const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, localApiBaseUrl(config), groupToolsSigningSecret);
  const env = options.env ?? process.env;
  const agentTools = new LarkAgentToolsService(capabilities, repos.config, { env, groupToolsCommand: options.groupToolsCommand });
  const runtime = new DockmuxRuntime(repos, {
    acpxCommand: config.acpxCommand,
    driverIdleTimeoutMs: config.driverIdleTimeoutMs,
    cleanupIntervalMs: config.cleanupIntervalMs,
    sessionEnvironment: session => capabilities.environmentFor(session),
    sessionPrompt: (session, prompt) => agentTools.promptForSession(session, prompt)
  });
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let closed = false;
  try {
    await runtime.initialize(config.agents);
    const webRoot = options.webRoot ?? fileURLToPath(new URL('../public', import.meta.url));
    app = await buildApp(runtime, { webRoot, lark: { env, config: repos.config, agents: repos.agents, cardMappings: repos.channelMappings, runtime, agentTools, listeningDisabled: env.DOCKMUX_DISABLE_LARK_LISTENER === 'true' } });
    await app.listen(listenOptions(config));
  } catch (error) {
    capabilities.close(); await runtime.shutdown(); repos.close(); throw error;
  }
  return {
    config,
    runtime,
    async close() {
      if (closed) return;
      closed = true;
      const results = await Promise.allSettled([app?.close() ?? Promise.resolve(), runtime.shutdown()]);
      capabilities.close();
      repos.close();
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Dockmux did not shut down cleanly');
    }
  };
}
