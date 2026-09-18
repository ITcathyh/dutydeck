import { createHash } from 'node:crypto';
import {
  backendUnavailableMessage,
  defaultBackendProbes,
  selectSessionBackend,
  TmuxBackend,
  type BackendProbes,
} from '@dutydeck/session-backends';

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
export function createDutydeckPersistentBackend(
  sessionId: string,
  probes: BackendProbes = defaultBackendProbes,
): TmuxBackend {
  const sessionName = dutydeckPtySessionName(sessionId);
  const selected = selectSessionBackend({ preferred: 'tmux', sessionName, probes });
  if (!selected.ok) throw new Error(backendUnavailableMessage(selected.requested, selected.reason));
  if (selected.kind !== 'tmux') throw new Error(`Production PTY backend policy selected unexpected backend: ${selected.kind}`);
  return new TmuxBackend(sessionName, { ownerId: `dutydeck:${sessionId}` });
}

export type { BackendProbes };
