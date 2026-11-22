import { larkCardChannel } from '../coordinator-core.js';
import { larkMessageAnchor } from '../message-anchor.js';
import { larkScenarioAdoptionOf } from '../scenario-legacy.js';
import type { TurnContext, TurnContributor, TurnPrompt } from './types.js';

export function scenarioContributor({ task, config, event, materialPrompt, cardMappings, options, log }: TurnContext, prompt: TurnPrompt) {
  return {
    async beforeCard(cardContext) {
      // 场景包的关联：这个 Bot 之前在本群别的话题处理过同一件事，上次的结论带给 Agent，过程卡顶部挂一行。读不到只少这一项。
      task.scenarioRecall = undefined;
      if (options.participation) {
        try {
          task.scenarioRecall = await options.participation.scenarioRecall({ appId: config.appId, chatId: event.chatId }, config, { materialPrompt, scopeId: task.scopeId, before: task.startedAt!,
            mappings: () => cardMappings.list(larkCardChannel(config.appId)), brand: config.brand, webBaseUrl: config.webBaseUrl });
        } catch (error) {
          log.warn({ error, taskId: task.id }, '查找上一轮关联失败，本轮不带上次结论');
        }
        if (task.scenarioRecall) cardContext.scenarioRecall = { packId: task.scenarioRecall.packId, line: task.scenarioRecall.line };
      }
    },
    async preparePrompt() {
      // model 场景包判为 act 的消息：判定时冻结的执行指令和材料，用户请求仍是原文。读不到或对不上时这一轮不带。
      const scenarioAdoption = larkScenarioAdoptionOf(event);
      if (scenarioAdoption?.mode === 'model' && options.participation) {
        prompt.scenarioExecution = await options.participation.scenarioExecution({ appId: config.appId, chatId: event.chatId }, scenarioAdoption, larkMessageAnchor(event))
          .catch(error => { log.warn({ error, taskId: task.id }, '读取场景执行内容失败，本轮不带场景指令'); return undefined; });
      }
      prompt.scenarioAdoption = scenarioAdoption;
    },
  } satisfies TurnContributor;
}
