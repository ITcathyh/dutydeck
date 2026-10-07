import { createHash } from 'node:crypto';
import { TmuxBackend } from '@dutydeck/session-backends';

/**
 * Stable, Dutydeck-only tmux namespace. The hash keeps arbitrary/custom
 * session ids out of tmux target syntax while the readable prefix makes
 * operator diagnostics recognizable. External session names are never probed.
 */
export function dutydeckPtySessionName(sessionId: string): string {
  const readable = sessionId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48) || 'session';
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  return `dutydeck-${readable}-${digest}`;
}

/** Production PTY-CLI policy: persistent tmux or a hard failure, never an
 * implicit downgrade to the in-process PtyBackend. */
export function createDutydeckPersistentBackend(sessionId: string): TmuxBackend {
  const sessionName = dutydeckPtySessionName(sessionId);
  // Construction is synchronous; start() performs asynchronous tri-state and
  // ownership probes before launch. There is never an implicit PTY fallback.
  return new TmuxBackend(sessionName, { ownerId: `dutydeck:${sessionId}` });
}
