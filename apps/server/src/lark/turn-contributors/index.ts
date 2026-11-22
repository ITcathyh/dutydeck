import { groupContextContributor } from './group-context.js';
import type { TurnContext, TurnPrompt } from './types.js';

// Each invocation owns one turn, including callbacks retained by its runtime subscription.
export function createTurnContributors(context: TurnContext) {
  const prompt: TurnPrompt = { groupInstructions: '' };
  const group = groupContextContributor(context, prompt);
  return {
    prompt,
    readContext: group.readContext,
    onReplay: group.onReplay,
    settling: group.settling,
  };
}
