import { groupContextContributor } from './group-context.js';
import { memoryContributor } from './memory.js';
import { scenarioContributor } from './scenario.js';
import type { TurnContext, TurnPrompt } from './types.js';

// Each invocation owns one turn, including callbacks retained by its runtime subscription.
export function createTurnContributors(context: TurnContext) {
  const prompt: TurnPrompt = {
    groupInstructions: '',
    get scenarioRecall() { return context.task.scenarioRecall; },
  };
  const group = groupContextContributor(context, prompt);
  const memory = memoryContributor(context, prompt);
  const scenario = scenarioContributor(context, prompt);
  return {
    prompt,
    beforeCard: scenario.beforeCard,
    async preparePrompt() {
      await memory.preparePrompt();
      await scenario.preparePrompt();
    },
    attached: memory.attached,
    afterDelivery: memory.afterDelivery,
    readContext: group.readContext,
    onReplay: group.onReplay,
    settling: group.settling,
  };
}
