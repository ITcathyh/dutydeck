import { verificationContributor } from './verification.js';
import { groupContextContributor } from './group-context.js';
import { memoryContributor } from './memory.js';
import { scenarioContributor } from './scenario.js';
import { versionsContributor } from './prompt-versions.js';
import type { TerminalState } from '../terminal-plan.js';
import type { TurnContext, TurnPrompt, TurnResult } from './types.js';

// Each invocation owns one turn, including callbacks retained by its runtime subscription.
export function createTurnContributors(context: TurnContext) {
  const prompt: TurnPrompt = {
    groupInstructions: '',
    get scenarioRecall() { return context.task.scenarioRecall; },
  };
  const group = groupContextContributor(context, prompt);
  const memory = memoryContributor(context, prompt);
  const scenario = scenarioContributor(context, prompt);
  const versions = versionsContributor(context, prompt);
  const verification = verificationContributor(context);
  return {
    prompt,
    beforeCard: scenario.beforeCard,
    async preparePrompt() {
      await memory.preparePrompt();
      await scenario.preparePrompt();
      await versions.preparePrompt();
    },
    attached: memory.attached,
    captureWorkspace: verification.captureWorkspace,
    planDelivery: verification.planDelivery,
    async inspectResult(state: TerminalState, changedCode: boolean) {
      const result: TurnResult = { changedCode, capabilities: {} };
      await verification.inspectResult(state, result);
      return result;
    },
    afterDelivery(state: TerminalState, runtimeTaskId?: string) {
      verification.afterDelivery();
      memory.afterDelivery(state, runtimeTaskId);
    },
    readContext: group.readContext,
    freezeRequest: versions.freezeRequest,
    async accepted(receipt: { id: string; replayed?: boolean }) {
      await versions.accepted(receipt);
      if (receipt.replayed) group.onReplay();
    },
    settling: group.settling,
  };
}
