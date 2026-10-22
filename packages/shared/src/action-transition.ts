import type { ActionStatus } from './collaboration.js';
import { RuntimeError } from './index.js';

/** Shared by the collaboration ledger and the channel-neutral plugin tool ledger. */
export const actionTransitions: Readonly<Record<ActionStatus, readonly ActionStatus[]>> = {
  intent: ['sending', 'suppressed', 'failed'],
  sending: ['succeeded', 'failed', 'unknown', 'suppressed'],
  unknown: ['succeeded', 'failed', 'suppressed'],
  succeeded: [], failed: [], suppressed: []
};
export function actionTransition(existing: { id: string; revision: number; status: ActionStatus; receipt?: string; error?: string }, patch: { expectedRevision: number; status: ActionStatus; receipt?: string | null; error?: string | null }) {
  if (existing.revision !== patch.expectedRevision) throw new RuntimeError('COLLABORATION_REVISION_CONFLICT', 'Action revision conflict', 409);
  const receipt = patch.receipt === undefined ? existing.receipt : patch.receipt ?? undefined;
  const error = patch.error === undefined ? existing.error : patch.error ?? undefined;
  const changed = receipt !== existing.receipt || error !== existing.error;
  if (patch.status === existing.status) {
    if (actionTransitions[existing.status].length === 0 && changed) throw new RuntimeError('COLLABORATION_ACTION_CONFLICT', `Cannot modify terminal action '${existing.id}'`, 409);
    if (!changed) return undefined;
  } else if (!actionTransitions[existing.status].includes(patch.status)) {
    throw new RuntimeError('COLLABORATION_ACTION_INVALID_TRANSITION', `Invalid action status transition from '${existing.status}' to '${patch.status}'`, 400);
  }
  return { status: patch.status, revision: existing.revision + 1, receipt, error };
}
