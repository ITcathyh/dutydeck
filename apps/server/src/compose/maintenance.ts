import { DutydeckWatch, startDutydeckWatch, watchDeliveryRejection, watchReceiverType } from '../watch.js';
import { collectWatchScopes, resolveWatchReceiver } from '../watch-signals.js';
import { timeLoop } from '@dutydeck/shared';
import { pruneLarkResourceDirectories, readLarkResourceReferences } from '../resource-retention.js';
import { createWorkbenchFetch } from '../workbench-fetch.js';
import { createPtyCliProvider } from '@dutydeck/pty-driver';
import type { ComposeContext } from './context.js';

export function composeMaintenance({ repos, env, log, channel, lifecycle }: ComposeContext,
  workbenchHttp: ReturnType<typeof createWorkbenchFetch>, ptyProvider: ReturnType<typeof createPtyCliProvider>, resourceRoot: string) {
  const { readLarkConfigs, createLarkCardService, LarkServiceError } = channel;
  const loopLog = { warn: (details: Record<string, unknown>, message: string) => log.warn(details, message) };
  let resourceRetentionTimer: NodeJS.Timeout | undefined;
  const historyRetention = new AbortController();
  let historyRetentionRun: Promise<void> | undefined;
  lifecycle.register('historyRetention', () => {
    if (resourceRetentionTimer) clearInterval(resourceRetentionTimer);
    historyRetention.abort();
    return historyRetentionRun;
  }, false);
  const startWatch = () => {
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
    const closeWatch = startDutydeckWatch(watch, error => log.warn({ error }, '只读巡检失败'));
    lifecycle.register('watch', closeWatch, false);
  };
  const startRetention = () => {
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
  };
  return { watch: startWatch, historyRetention: startRetention };
}
