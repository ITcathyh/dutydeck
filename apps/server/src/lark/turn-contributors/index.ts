import { verificationContributor } from './verification.js';
import { gitStatusContributor } from './git-status.js';
import { turnDiffContributor } from './turn-diff.js';
import { groupContextContributor } from './group-context.js';
import { memoryContributor } from './memory.js';
import { scenarioContributor } from './scenario.js';
import { versionsContributor } from './prompt-versions.js';
import type { TerminalState } from '../terminal-plan.js';
import type { TurnContext, TurnPrompt, TurnReceipt, TurnResult } from './types.js';

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
  const git = gitStatusContributor(context);
  const diff = turnDiffContributor(context);

  // 每个阶段按表中顺序执行；订阅回调使用创建它的那一轮的贡献者。
  return {
    prompt,
    beforeCard: scenario.beforeCard,
    readContext: group.readContext,
    async preparePrompt() {
      await memory.preparePrompt();
      await scenario.preparePrompt();
      await versions.preparePrompt();
    },
    async captureWorkspace() {
      await verification.captureWorkspace();
      await git.captureWorkspace();
    },
    freezeRequest: versions.freezeRequest,
    async accepted(receipt: TurnReceipt) {
      const write = versions.accepted(receipt);
      if (write) await write;
      group.accepted(receipt);
    },
    attached: memory.attached,
    settling: group.settling,
    planDelivery: verification.planDelivery,
    async inspectResult(state: TerminalState) {
      const result: TurnResult = { changedCode: false, capabilities: {} };
      await git.inspectResult(state, result);
      await verification.inspectResult(state, result);
      return result;
    },
    async resultElements(state: TerminalState, result: TurnResult, workspace?: string) {
      await git.decorateResult(state, result, workspace);
      await diff.decorateResult(state, result);
      // Reads are ordered git then diff; card layout is verification, diff, git.
      return [result.verification, result.diff, result.gitStatus].filter(element => element !== undefined);
    },
    afterDelivery(state: TerminalState, runtimeTaskId?: string) {
      verification.afterDelivery();
      memory.afterDelivery(state, runtimeTaskId);
    },
  };
}
