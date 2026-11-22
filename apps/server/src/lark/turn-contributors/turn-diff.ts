import { readTurnDiffRecord } from '../../turn-diff.js';
import { larkTurnDiffElement } from '../turn-diff.js';
import type { TurnContext, TurnContributor } from './types.js';

export function turnDiffContributor({ task, config, options }: TurnContext) {
  return {
    async decorateResult(_state, result) {
      result.diff = task.sessionId && task.runtimeTaskId
        ? larkTurnDiffElement(await readTurnDiffRecord(options.store, task.sessionId, task.runtimeTaskId).catch(() => undefined), config.webBaseUrl)
        : undefined;
    },
  } satisfies TurnContributor;
}
