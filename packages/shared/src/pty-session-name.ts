import { createHash } from 'node:crypto';

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
