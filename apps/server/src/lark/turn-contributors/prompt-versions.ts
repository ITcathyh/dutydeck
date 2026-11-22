import { clearPendingPromptUsage, type BotPromptUsage, freezePromptUsage, pendingPromptUsageKey, promptUsageSnapshot, recordPromptUsage } from '../prompt-versions.js';
import { LarkServiceError } from '../service.js';
import type { TurnContext, TurnContributor, TurnPrompt } from './types.js';

export function versionsContributor({ task, config, event, currentTurn, reattaching, options, log }: TurnContext, prompt: TurnPrompt) {
  let promptUsage: BotPromptUsage | undefined;
  let frozenUsage: Awaited<ReturnType<typeof freezePromptUsage>>;
  let pendingUsageKey: string;
  return {
    async preparePrompt() {
      const { groupInstructionsRevision } = prompt;
      promptUsage = {
        schemaVersion: 1, taskId: task.id, appId: config.appId, groupInstructionsRevision
      };
      try {
        promptUsage = await promptUsageSnapshot(options.store, {
          taskId: task.id, appId: config.appId, configRevision: config.revision, text: config.preInjectPrompt?.trim() ?? '', groupInstructionsRevision
        });
      } catch (error) { log.warn({ error, taskId: task.id }, '读取提示词历史失败，继续派发'); }
      if (promptUsage?.botPromptVersion === undefined) log.warn({ taskId: task.id }, '本轮未记录版本，继续派发');
    },
    async freezeRequest() {
      pendingUsageKey = pendingPromptUsageKey(config.appId, event.messageId, currentTurn);
      try {
        frozenUsage = await freezePromptUsage(options.store,
          pendingUsageKey, reattaching ? undefined : promptUsage);
      } catch (error) {
        if (error instanceof LarkServiceError && error.code === 'PROMPT_USAGE_CONFLICT') throw error;
        log.warn({ error, taskId: task.id }, '冻结提示词版本失败，继续派发');
      }
    },
    async accepted(runtimeTask) {
      // 重放只能补原准备快照；pending 已清理时保留已有 usage，不能拿当前配置补旧轮。
      const usedPromptUsage = runtimeTask.replayed ? (frozenUsage && !frozenUsage.created ? frozenUsage.usage : undefined) : promptUsage;
      let recorded = false;
      if (usedPromptUsage) {
        try {
          await recordPromptUsage(options.store, { ...usedPromptUsage, taskId: runtimeTask.id });
          recorded = true;
        } catch (error) { log.warn({ error, taskId: runtimeTask.id }, '记录本轮提示词版本失败'); }
      }
      // 重放时新建的快照不属于原任务，无论旧 usage 是否存在都不能用于补记。
      if (frozenUsage && (recorded || runtimeTask.replayed && frozenUsage.created)) {
        await clearPendingPromptUsage(options.store, pendingUsageKey, frozenUsage.usage)
          .catch(error => log.warn({ error, taskId: runtimeTask.id }, '清理提示词准备快照失败'));
      }
    },
  } satisfies TurnContributor;
}
