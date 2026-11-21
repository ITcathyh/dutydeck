import type { LarkCardActionName } from '../card-actions.js';
import type { StoredButtonHandler } from './button-context.js';

export const storedButtons = {
  ask_plain: (ctx, parsed, operator, source) => ctx.submitResultFollowUp(parsed, operator, source),
  ask_reply: (ctx, parsed, operator, source) => ctx.submitResultFollowUp(parsed, operator, source),
  ask_detail: (ctx, parsed, operator, source) => ctx.submitResultFollowUp(parsed, operator, source),
  schedule_daily: (ctx, parsed, operator, source) => ctx.scheduleResultDaily(parsed, operator, source),
  detail: (ctx, parsed, operator, source) => ctx.handleDetailLogin(operator, source, parsed),
  run_in_new_session: (ctx, parsed, operator, source) => ctx.relaunchCardAction('run_in_new_session', parsed.taskId, parsed.turn, operator, source),
  rerun_in_new_session: (ctx, parsed, operator, source) => ctx.relaunchCardAction('rerun_in_new_session', parsed.taskId, parsed.turn, operator, source),
  replay_turn: (ctx, parsed, operator, source) => ctx.interruptedTurnAction('replay_turn', parsed.taskId, parsed.turn, operator, source),
  abandon_turn: (ctx, parsed, operator, source) => ctx.interruptedTurnAction('abandon_turn', parsed.taskId, parsed.turn, operator, source),
  continue_in_place: (ctx, parsed, operator, source) => ctx.continueInPlaceAction(parsed.taskId, parsed.turn, operator, source),
  resolve_retry: (ctx, parsed, operator, source) => ctx.unknownTaskAction('resolve_retry', parsed.taskId, parsed.turn, parsed.target, operator, source),
  resolve_completed: (ctx, parsed, operator, source) => ctx.unknownTaskAction('resolve_completed', parsed.taskId, parsed.turn, parsed.target, operator, source),
  resolve_failed: (ctx, parsed, operator, source) => ctx.unknownTaskAction('resolve_failed', parsed.taskId, parsed.turn, parsed.target, operator, source),
} satisfies Partial<Record<LarkCardActionName, StoredButtonHandler>>;
