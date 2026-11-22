import type { AttemptRef, SessionFence } from '@dutydeck/shared';

export function isAttemptRef(ref: SessionFence | AttemptRef): ref is SessionFence & AttemptRef {
  return 'attemptId' in ref && 'taskId' in ref && typeof ref.attemptId === 'string' && typeof ref.taskId === 'string';
}
