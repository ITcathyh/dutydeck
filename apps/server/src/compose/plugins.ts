import { PluginBusinessToolService } from '../plugins/tool-service.js';
import { PluginToolLedger } from '../plugins/tool-ledger.js';
import { PluginToolGrants } from '../plugins/tool-grants.js';
import { TaskPluginToolIdentity } from '../plugins/tool-identity.js';
import { PluginHost } from '../plugins/host.js';
import { PluginResultService } from '../plugins/result-service.js';
import { PluginResultToolRegistry } from '../plugins/result-tools.js';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { timeLoop } from '@dutydeck/shared';
import { createWorkbenchFetch } from '../workbench-fetch.js';
import { TurnAuthority } from '../agent-host/turn-authority.js';
import { RelayCapabilityRegistry } from '@dutydeck/relay';
import { wirePlugins } from '../plugins/service-wiring.js';
import type { StoredLarkConfig } from '../lark/config.js';
import type { ComposeContext } from './context.js';
import type { LarkGroupManager } from '../lark/group-management.js';
import type { PluginWiringDeps } from '../plugins/service-wiring.js';
import type { composeAuth } from './auth.js';

export function composePlugins({ repos, config, log, env, lifecycle, channel }: ComposeContext,
  pluginHost: PluginHost | undefined, workbenchHttp: ReturnType<typeof createWorkbenchFetch>,
  ports: Pick<PluginWiringDeps, 'runtime' | 'workItems'>) {
  const { readLarkConfigs, createLarkCardService } = channel;
  const pluginWiring = pluginHost ? wirePlugins(pluginHost, {
    runtime: ports.runtime,
    repositories: repos,
    readBot: async appId => (await readLarkConfigs(repos.config)).find(bot => bot.appId === appId),
    fallbackAgentId: () => config.agents[0]?.id,
    sendText: (bot, input) => createLarkCardService(env, workbenchHttp.fetch, bot as StoredLarkConfig).sendText(input),
    workItems: ports.workItems,
    log: { warn: (details, message) => log.warn(details, message) }
  }) : undefined;
  if (pluginWiring) lifecycle.register('pluginDispose', () => pluginWiring.dispose());
  return pluginWiring;
}

export function composePluginResults({ repos, options, log, env, channel, lifecycle }: ComposeContext,
  deps: {
    pluginHost?: PluginHost; pluginWiring?: ReturnType<typeof wirePlugins>; runtime: DutydeckRuntime;
    relayCapabilities: RelayCapabilityRegistry; capabilities: TurnAuthority; groupManager: LarkGroupManager;
    workbenchHttp: ReturnType<typeof createWorkbenchFetch>; legacyExecutionPolicy: Awaited<ReturnType<typeof composeAuth>>['legacyExecutionPolicy'];
  }) {
  const { pluginHost, pluginWiring, runtime, relayCapabilities, capabilities, groupManager, workbenchHttp, legacyExecutionPolicy } = deps;
  const { LarkPluginResultIdentity, LarkPluginResultAdapter, readLarkConfigs, createLarkCardService } = channel;
  const loopLog = { warn: (details: Record<string, unknown>, message: string) => log.warn(details, message) };
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
  const sweepPluginResults = () => pluginResultSweep ??= timeLoop('plugin-result-sweep', loopLog, async () => {
    try { await pluginResultService.sweep(env.DUTYDECK_DISABLE_LARK_LISTENER === 'true' ? [] : env.DUTYDECK_BOT_APP_ID ? [env.DUTYDECK_BOT_APP_ID] : (await readLarkConfigs(repos.config)).filter(bot => bot.listening).map(bot => bot.appId)); }
    catch { log.warn({ code: 'RESULT_RECOVERY_FAILED' }, '受控结果恢复失败'); }
    finally { pluginResultSweep = undefined; }
  });
  const closePluginResults = async () => { if (pluginResultTimer) clearInterval(pluginResultTimer); await pluginResultSweep; };
  lifecycle.register('pluginResults', closePluginResults);
  const start = () => {
    pluginResultTimer = setInterval(() => { void sweepPluginResults(); }, 30_000);
    pluginResultTimer.unref();
    void sweepPluginResults();
  };
  return { start: { pluginResults: start }, businessToolGrants, businessTools, pluginResultIdentity, pluginResultRegistry, pluginResultAdapter, pluginResultService };
}
