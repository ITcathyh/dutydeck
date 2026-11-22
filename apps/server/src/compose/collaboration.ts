import { type ReplyPolish } from '../lark/reply-polish.js';
import { createCollaborationIntegration } from '../collaboration-integration.js';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { installationOwnerTaskActor,timeLoop } from '@dutydeck/shared';
import { tmpdir } from 'node:os';
import { dirname,join,resolve } from 'node:path';
import { createWorkbenchFetch } from '../workbench-fetch.js';
import { UsageLedger } from '../usage-ledger.js';
import { loadDaemonPlugins } from '../plugins/service-wiring.js';
import type { ComposeContext } from './context.js';
import type { LarkGroupManager } from '../lark/group-management.js';
import type { CollaborationScope } from '@dutydeck/shared';

export function composeCollaboration({ config, env, options, log, lifecycle, repos, channel }: ComposeContext,
  runtime: DutydeckRuntime, groupManager: LarkGroupManager, workbenchHttp: ReturnType<typeof createWorkbenchFetch>,
  usageLedger: UsageLedger, polishReply: ReplyPolish, scenarios: Awaited<ReturnType<typeof loadDaemonPlugins>>['scenarios']) {
  const { LarkMemoryStore, LarkMemoryProjection, LarkMemoryPipeline, readLarkConfigs, createLarkCardService,
    larkMemoryEnabled, renderMemoryIndex, larkMemoryScope } = channel;
  const memoryRoot = config.databaseUrl === ':memory:'
    ? join(tmpdir(), 'dutydeck-memory')
    : join(dirname(resolve(config.databaseUrl)), 'memory');
  const memoryStore: InstanceType<typeof LarkMemoryStore> = new LarkMemoryStore(repos.config, {
    onChange: scope => memoryProjection.write(scope)
  });
  const memoryProjection: InstanceType<typeof LarkMemoryProjection> = new LarkMemoryProjection(
    memoryStore,
    memoryRoot,
    { warn: (obj, msg) => log.warn(obj, msg) }
  );
  // 协作作用域都是群：读本机器人的群记忆池（shared 时是各群共享池，来源是别的群的条目标「其他群」；per-group 时是本群的池）。
  const readMemory = async (scope: CollaborationScope) => {
    const bot = (await readLarkConfigs(repos.config)).find(entry => entry.appId === scope.appId);
    const memoryScope = larkMemoryScope(scope.appId, scope.chatId, 'group', bot?.groupMemoryScope);
    return !bot || !larkMemoryEnabled(bot) ? '' : renderMemoryIndex(await memoryStore.list(memoryScope), await memoryStore.getState(memoryScope), { currentChatId: scope.chatId }).text;
  };
  const collaboration = createCollaborationIntegration({ polishReply, repositories: repos, runtime, groups: groupManager,
    workspaceRoot: config.databaseUrl === ':memory:' ? join(tmpdir(), 'dutydeck-decisions') : join(dirname(resolve(config.databaseUrl)), 'decisions'),
    client: bot => createLarkCardService(env, workbenchHttp.fetch, bot), configureExtensions: options.configureCollaborationExtensions,
    readMemory,
    usageRefusal: async scope => await usageLedger.refusal(scope.appId, scope.chatId)
      ?? await usageLedger.automaticRefusal(scope.appId),
    listeningDisabled: env.DUTYDECK_DISABLE_LARK_LISTENER === 'true', scenarios,
    log: { warn: (details, message) => log.warn(details, message) } });
  lifecycle.register('collaboration', () => collaboration.close(), false);
  const recoverMemory = async () => {
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
        info: (obj, msg) => log.info(obj, msg),
        warn: (obj, msg) => log.warn(obj, msg),
        error: (obj, msg) => log.error(obj, msg)
      }
    });
    for (const bot of await readLarkConfigs(repos.config)) void memoryPipeline.recoverJobs(bot.appId).catch(error => log.error({ error, appId: bot.appId }, '恢复后台记忆作业失败'));
    return memoryPipeline;
  };
  const loopLog = { warn: (details: Record<string, unknown>, message: string) => log.warn(details, message) };
  let collaborationTimer: NodeJS.Timeout | undefined;
  lifecycle.beforeStop('collaboration', () => clearInterval(collaborationTimer));
  const start = () => {
    let lastCollaborationPrune = 0;
    const tickCollaboration = () => {
      if (Date.now() - lastCollaborationPrune > 3_600_000) { lastCollaborationPrune = Date.now(); void timeLoop('collaboration.prune', loopLog, () => collaboration.prune()).catch(error => log.warn({ error }, '群上下文保留期清理失败')); }
      void timeLoop('collaboration.tick', loopLog, () => collaboration.scheduler.tick()).catch(error => log.warn({ error }, '群委托轮询失败')); };
    collaborationTimer = setInterval(tickCollaboration, 5_000);
    collaborationTimer.unref(); tickCollaboration();
  };
  return { collaboration, memoryStore, recoverMemory, start };
}
