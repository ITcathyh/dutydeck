import { dutydeckPtySessionName } from '@dutydeck/shared/execution';
import type { DiagnosticLog } from '@dutydeck/shared';
import { TmuxBackend } from '@dutydeck/session-backends';

export { dutydeckPtySessionName };

/** Production PTY-CLI policy: persistent tmux or a hard failure, never an
 * implicit downgrade to the in-process PtyBackend. */
export function createDutydeckPersistentBackend(sessionId: string, log?: DiagnosticLog): TmuxBackend {
  const sessionName = dutydeckPtySessionName(sessionId);
  // Construction is synchronous; start() performs asynchronous tri-state and
  // ownership probes before launch. There is never an implicit PTY fallback.
  return new TmuxBackend(sessionName, { ownerId: `dutydeck:${sessionId}`, log });
}
