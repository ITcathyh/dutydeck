import { expect, it } from 'vitest';
import { TurnTokens } from './turn-token.js';

it('verifies a turn issued by the pre-migration registry', () => {
  const tokens = new TurnTokens('synthetic-compatibility');
  const previous = 'efA2NjyZ2Hl_Q2EwthVprWXk9pLInq8t5_EXQewo6w0';
  expect(tokens.finalTurnToken('ses_A', 'task_B', 'attempt_C')).toBe(previous);
  expect(() => tokens.assertFinalTurn('ses_A', 'task_B', 'attempt_C', previous)).not.toThrow();
  expect(() => tokens.assertWorkbenchTurn('ses_A', 'task_B', 'attempt_C', previous)).not.toThrow();
});
