import { createHash } from 'node:crypto';
import {
  backendUnavailableMessage,
  defaultBackendProbes,
  selectSessionBackend,
  TmuxBackend,
  type BackendProbes,
} from '@dockmux/session-backends';

/**
 * Stable, Dockmux-only tmux namespace. The hash keeps arbitrary/custom
 * session ids out of tmux target syntax while the readable prefix makes
 * operator diagnostics recognizable. BotMux session names are never probed.
 */
export function dockmuxPtySessionName(sessionId: string): string {
  const readable = sessionId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48) || 'session';
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  return `dockmux-${readable}-${digest}`;
}

/** Production PTY-CLI policy: persistent tmux or a hard failure, never an
 * implicit downgrade to the in-process PtyBackend. */
export function createDockmuxPersistentBackend(
  sessionId: string,
  probes: BackendProbes = defaultBackendProbes,
): TmuxBackend {
  const sessionName = dockmuxPtySessionName(sessionId);
  const selected = selectSessionBackend({ preferred: 'tmux', sessionName, probes });
  if (!selected.ok) throw new Error(backendUnavailableMessage(selected.requested, selected.reason));
  if (selected.kind !== 'tmux') throw new Error(`Production PTY backend policy selected unexpected backend: ${selected.kind}`);
  return new TmuxBackend(sessionName, { ownerId: `dockmux:${sessionId}` });
}

export type { BackendProbes };
