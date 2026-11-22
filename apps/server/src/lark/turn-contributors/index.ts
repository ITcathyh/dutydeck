import { groupContextContributor } from './group-context.js';
import { memoryContributor } from './memory.js';
import type { TurnContext, TurnPrompt } from './types.js';

// Each invocation owns one turn, including callbacks retained by its runtime subscription.
export function createTurnContributors(context: TurnContext) {
  const prompt: TurnPrompt = { groupInstructions: '' };
  const group = groupContextContributor(context, prompt);
  const memory = memoryContributor(context, prompt);
  return {
    prompt,
    preparePrompt: memory.preparePrompt,
    attached: memory.attached,
    afterDelivery: memory.afterDelivery,
    readContext: group.readContext,
    onReplay: group.onReplay,
    settling: group.settling,
  };
}
