import type { FastifyBaseLogger } from 'fastify';
import type { LarkRoutesOptions } from '../lark/routes.js';
import type { LarkListenerPool, LarkLongConnectionListenerOptions, LarkLongConnectionListenerPool } from '../lark/listener.js';
import type { readLarkConfigs } from '../lark/config.js';

export function composeLarkChannel(log: FastifyBaseLogger, options: LarkRoutesOptions, fetcher: typeof fetch,
  saveBotConfig: LarkLongConnectionListenerOptions['saveBotConfig'], ListenerPool: typeof LarkLongConnectionListenerPool,
  readConfigs: typeof readLarkConfigs) {
  const env = options.env ?? process.env;
  const listener: LarkListenerPool = options.listener ?? new ListenerPool(log, {
    ...(options.runtime && options.config && options.cardMappings
      ? { runtime: options.runtime, workflowStore: options.config, cardMappings: options.cardMappings }
      : { workflowStore: options.config }),
    participation: options.participation,
    polishReply: options.polishReply,
    usage: options.usage,
    automation: options.automation,
    workbench: options.workbench,
    resourceRoot: options.resourceRoot,
    relayBroker: options.relayBroker,
    env,
    fetcher,
    executionPolicy: options.executionPolicy,
    groupManager: options.groupManager,
    memory: options.memory,
    loginLinks: options.loginLinks,
    agentCommands: options.agentTools?.commands,
    saveBotConfig,
    scheduleRequests: options.scheduleRequests,
    workspaceApprovals: options.workspaceApprovals,
    peerBotAuthorized: (appId, chatId, senderOpenId) => options.agentTools?.isConfiguredPeer(appId, chatId, senderOpenId) ?? Promise.resolve(false)
  });
  let listenerSyncTail: Promise<void> = Promise.resolve();
  const syncListeners = () => {
    // 每次同步时再读当前配置。连不上的机器人由连接池按退避自动重连，直到被下一次同步取代。
    const synced = listenerSyncTail.then(async () => {
      try { await listener.sync(await readConfigs(options.config)); }
      catch (error) { log.error({ error }, '飞书消息监听连接失败，已保留监听配置，稍后自动重连'); }
    });
    listenerSyncTail = synced.catch(() => {});
    return synced;
  };
  let settled = options.listeningDisabled === true;
  const start = () => {
    if (!options.listeningDisabled) void syncListeners().finally(() => { settled = true; });
  };
  return { listener, syncListeners, start, stop: () => listener.stop(),
    readiness: () => settled ? undefined : '飞书长连接还在建立' };
}
