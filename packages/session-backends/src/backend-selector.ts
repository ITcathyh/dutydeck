/**
 * Session backend selection — which multiplexer a session should run on.
 *
 * Third-party attribution: see THIRD_PARTY_NOTICES.md.
 * The rules that matter, and why:
 *
 *  - **tmux is the default.** Not "tmux if available" — unconditionally.
 *  - **A persistent backend that isn't available does NOT silently become pty.**
 *    Picking pty whenever the tmux probe failed would mean hosts with a broken tmux
 *    silently run on pty and then hit pty's problem set (no survival across a daemon
 *    restart, etc.) without the user knowing they were downgraded. Callers get an explicit
 *    'unavailable' decision to surface, not a quiet downgrade.
 *  - **pty is reachable only as an explicit opt-in** — an outright request for
 *    it — plus the one narrow automatic case below.
 *  - **zellij/zmx are never auto-selected**, only on explicit request.
 *  - **A live session beats a failed capability probe.** If the session already
 *    exists, it runs regardless of what the probe says: abandoning it would
 *    spawn a duplicate CLI and orphan the real conversation, and a capability
 *    probe is a separate, weaker signal than a session known to be there.
 *
 * This module is pure decision logic — probes are injected, so it is fully
 * testable without any multiplexer installed.
 */
import type { SessionProbe } from './types.js';
import { isTmuxAvailable, TmuxBackend } from './tmux-backend.js';
import { isZellijAvailable, ZellijBackend } from './zellij-backend.js';
import { isZmxAvailable, ZmxBackend } from './zmx-backend.js';

/** Backends a session can be placed on. */
export type BackendKind = 'pty' | 'tmux' | 'zellij' | 'zmx';

/** Every backend except pty keeps its session alive across a daemon restart. */
export const PERSISTENT_BACKENDS: readonly BackendKind[] = ['tmux', 'zellij', 'zmx'];

export function isPersistentBackend(kind: BackendKind): boolean {
  return PERSISTENT_BACKENDS.includes(kind);
}

/** Availability + existence probes, injectable so selection is unit-testable. */
export interface BackendProbes {
  /** Is this backend usable on this host? */
  isAvailable(kind: BackendKind): boolean;
  /** Does this session already exist on this backend? Tri-state: a failed
   *  probe must answer 'unknown', never 'missing'. */
  probeSession(kind: BackendKind, sessionName: string): SessionProbe;
}

/** Real probes against the installed multiplexers. */
export const defaultBackendProbes: BackendProbes = {
  isAvailable(kind) {
    switch (kind) {
      case 'pty': return true; // node-pty is a dependency, always present
      case 'tmux': return isTmuxAvailable();
      case 'zellij': return isZellijAvailable();
      case 'zmx': return isZmxAvailable();
    }
  },
  probeSession(kind, sessionName) {
    switch (kind) {
      case 'pty': return 'missing'; // a pty child cannot outlive its backend
      case 'tmux': return TmuxBackend.probeSession(sessionName);
      case 'zellij': return ZellijBackend.probeSession(sessionName);
      case 'zmx': return ZmxBackend.probeSession(sessionName);
    }
  },
};

export interface SelectBackendOptions {
  /** Explicit preference. Omitted ⇒ tmux, degrading to pty if tmux is absent. */
  preferred?: BackendKind;
  /** Session name to probe for an existing session (persistent backends only). */
  sessionName?: string;
  /** Defaults to the real probes; inject fakes in tests. */
  probes?: BackendProbes;
}

export type BackendSelection =
  | {
      ok: true;
      kind: BackendKind;
      /** True when a live session was found and should be re-attached rather
       *  than spawned fresh. */
      reattach: boolean;
      /** Why this backend was chosen (diagnostics/logging). */
      reason: string;
    }
  | {
      ok: false;
      /** The backend that was asked for but cannot run here. */
      requested: BackendKind;
      reason: string;
    };

/**
 * Pick a session backend.
 *
 * Precedence:
 *  1. An explicitly requested `pty` always runs (the deliberate escape hatch).
 *  2. An existing live session on the requested backend always runs, even if
 *     the availability probe fails.
 *  3. An available requested backend runs.
 *  4. An explicitly requested backend that is unavailable FAILS — no silent
 *     downgrade to pty.
 *  5. With no preference: tmux when available, otherwise pty. This is the only
 *     automatic degradation, and it happens before any session exists, so
 *     nothing can be orphaned by it.
 */
export function selectSessionBackend(opts: SelectBackendOptions = {}): BackendSelection {
  const probes = opts.probes ?? defaultBackendProbes;

  // 5. No explicit preference — the default path.
  if (opts.preferred === undefined) {
    if (probes.isAvailable('tmux')) {
      const reattach = opts.sessionName !== undefined
        && probes.probeSession('tmux', opts.sessionName) === 'exists';
      return {
        ok: true,
        kind: 'tmux',
        reattach,
        reason: reattach ? 'default tmux (existing session)' : 'default tmux',
      };
    }
    return { ok: true, kind: 'pty', reattach: false, reason: 'tmux unavailable, defaulted to pty' };
  }

  const requested = opts.preferred;

  // 1. pty on request: always allowed, never has an existing session.
  if (requested === 'pty') {
    return { ok: true, kind: 'pty', reattach: false, reason: 'pty requested explicitly' };
  }

  // 2. A live session outranks the capability probe.
  if (opts.sessionName !== undefined) {
    if (probes.probeSession(requested, opts.sessionName) === 'exists') {
      return { ok: true, kind: requested, reattach: true, reason: `${requested} session already live` };
    }
  }

  // 3/4. Availability decides — and an unavailable request fails loudly.
  if (probes.isAvailable(requested)) {
    return { ok: true, kind: requested, reattach: false, reason: `${requested} requested and available` };
  }
  return {
    ok: false,
    requested,
    reason: `${requested} backend is not available on this host`,
  };
}

/** Actionable message for a failed selection. */
export function backendUnavailableMessage(requested: BackendKind, reason: string): string {
  const hint =
    requested === 'tmux'
      ? 'macOS: brew install tmux | Debian/Ubuntu: sudo apt-get install -y tmux'
      : requested === 'zellij'
        ? 'zellij >= 0.44 is required (dump-screen --ansi / list-panes --json / headless attach)'
        : requested === 'zmx'
          ? 'zmx >= 0.7.0 is required (older `send` steals client leadership and corrupts history)'
          : `ensure ${requested} is installed and on PATH`;
  return [
    `Cannot start the session: the ${requested} backend is unavailable.`,
    `Reason: ${reason}`,
    `Fix: ${hint}`,
    'To run without it, request the pty backend explicitly — but pty sessions do '
    + 'not survive a daemon restart, so treat that as a stopgap.',
  ].join('\n');
}
