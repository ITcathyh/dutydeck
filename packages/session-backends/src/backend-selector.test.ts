/**
 * Backend selection is pure decision logic with injected probes, so this whole
 * suite runs everywhere — no multiplexer needs to be installed.
 */
import { describe, expect, it } from 'vitest';
import {
  selectSessionBackend,
  backendUnavailableMessage,
  isPersistentBackend,
  PERSISTENT_BACKENDS,
  type BackendKind,
  type BackendProbes,
} from './backend-selector.js';
import type { SessionProbe } from './types.js';

/** Build fake probes: `available` lists usable backends, `sessions` maps a
 *  backend to the probe result for the session name under test. */
function fakeProbes(opts: {
  available?: BackendKind[];
  sessions?: Partial<Record<BackendKind, SessionProbe>>;
} = {}): BackendProbes & { availabilityCalls: BackendKind[]; sessionCalls: BackendKind[] } {
  const available = new Set(opts.available ?? []);
  const availabilityCalls: BackendKind[] = [];
  const sessionCalls: BackendKind[] = [];
  return {
    availabilityCalls,
    sessionCalls,
    isAvailable(kind) {
      availabilityCalls.push(kind);
      return available.has(kind);
    },
    probeSession(kind) {
      sessionCalls.push(kind);
      return opts.sessions?.[kind] ?? 'missing';
    },
  };
}

describe('selectSessionBackend', () => {
  describe('no preference (the default path)', () => {
    it('defaults to tmux when tmux is available', () => {
      const r = selectSessionBackend({ probes: fakeProbes({ available: ['tmux'] }) });
      expect(r.ok).toBe(true);
      expect(r).toMatchObject({ ok: true, kind: 'tmux', reattach: false });
    });

    it('degrades to pty when tmux is unavailable — the only automatic downgrade', () => {
      const r = selectSessionBackend({ probes: fakeProbes({ available: [] }) });
      expect(r).toMatchObject({ ok: true, kind: 'pty', reattach: false });
      expect(r.ok && r.reason).toMatch(/tmux unavailable/);
    });

    it('never auto-selects zellij or zmx, even when they are the only ones available', () => {
      const r = selectSessionBackend({ probes: fakeProbes({ available: ['zellij', 'zmx'] }) });
      expect(r).toMatchObject({ ok: true, kind: 'pty' });
    });

    it('reports reattach when the default tmux session already exists', () => {
      const r = selectSessionBackend({
        sessionName: 'sess-1',
        probes: fakeProbes({ available: ['tmux'], sessions: { tmux: 'exists' } }),
      });
      expect(r).toMatchObject({ ok: true, kind: 'tmux', reattach: true });
    });

    it('does not reattach without a session name to probe', () => {
      const probes = fakeProbes({ available: ['tmux'], sessions: { tmux: 'exists' } });
      const r = selectSessionBackend({ probes });
      expect(r).toMatchObject({ ok: true, kind: 'tmux', reattach: false });
      expect(probes.sessionCalls).toEqual([]);
    });
  });

  describe('explicit pty', () => {
    it('always runs, even with every probe failing', () => {
      const r = selectSessionBackend({ preferred: 'pty', probes: fakeProbes({ available: [] }) });
      expect(r).toMatchObject({ ok: true, kind: 'pty', reattach: false });
    });

    it('never claims a reattach — a pty child cannot outlive its backend', () => {
      const r = selectSessionBackend({
        preferred: 'pty',
        sessionName: 'sess-1',
        probes: fakeProbes({ available: ['pty'], sessions: { pty: 'exists' } }),
      });
      expect(r).toMatchObject({ ok: true, reattach: false });
    });
  });

  describe.each(['tmux', 'zellij', 'zmx'] as const)('explicit %s', kind => {
    it('runs when available', () => {
      const r = selectSessionBackend({ preferred: kind, probes: fakeProbes({ available: [kind] }) });
      expect(r).toMatchObject({ ok: true, kind, reattach: false });
    });

    it('FAILS when unavailable — never silently downgrades to pty', () => {
      const r = selectSessionBackend({ preferred: kind, probes: fakeProbes({ available: [] }) });
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ ok: false, requested: kind });
      // The whole point: an unavailable persistent backend must not come back
      // as a working pty selection.
      expect(r).not.toMatchObject({ kind: 'pty' });
    });

    it('runs an existing live session even when the availability probe fails', () => {
      const r = selectSessionBackend({
        preferred: kind,
        sessionName: 'sess-1',
        probes: fakeProbes({ available: [], sessions: { [kind]: 'exists' } }),
      });
      expect(r).toMatchObject({ ok: true, kind, reattach: true });
    });

    it("treats an inconclusive ('unknown') probe as not-live and falls back to availability", () => {
      // 'unknown' must not be read as 'exists' (would attach to nothing) and
      // the decision falls through to the availability check.
      const live = selectSessionBackend({
        preferred: kind,
        sessionName: 'sess-1',
        probes: fakeProbes({ available: [kind], sessions: { [kind]: 'unknown' } }),
      });
      expect(live).toMatchObject({ ok: true, kind, reattach: false });

      const dead = selectSessionBackend({
        preferred: kind,
        sessionName: 'sess-1',
        probes: fakeProbes({ available: [], sessions: { [kind]: 'unknown' } }),
      });
      expect(dead).toMatchObject({ ok: false, requested: kind });
    });

    it('spawns fresh when the session is authoritatively missing', () => {
      const r = selectSessionBackend({
        preferred: kind,
        sessionName: 'sess-1',
        probes: fakeProbes({ available: [kind], sessions: { [kind]: 'missing' } }),
      });
      expect(r).toMatchObject({ ok: true, kind, reattach: false });
    });

    it('does not consult availability once a live session is found', () => {
      const probes = fakeProbes({ available: [kind], sessions: { [kind]: 'exists' } });
      selectSessionBackend({ preferred: kind, sessionName: 'sess-1', probes });
      expect(probes.availabilityCalls).toEqual([]);
    });
  });

  it('never selects a backend other than the one requested', () => {
    for (const requested of ['tmux', 'zellij', 'zmx'] as const) {
      const r = selectSessionBackend({
        preferred: requested,
        probes: fakeProbes({ available: ['tmux', 'zellij', 'zmx'] }),
      });
      expect(r).toMatchObject({ ok: true, kind: requested });
    }
  });
});

describe('backend metadata', () => {
  it('classifies persistence: everything but pty survives a daemon restart', () => {
    expect(isPersistentBackend('pty')).toBe(false);
    for (const kind of PERSISTENT_BACKENDS) expect(isPersistentBackend(kind)).toBe(true);
    expect([...PERSISTENT_BACKENDS].sort()).toEqual(['tmux', 'zellij', 'zmx']);
  });

  it('produces an actionable message naming the backend and a version floor', () => {
    expect(backendUnavailableMessage('tmux', 'probe failed')).toContain('apt-get install');
    expect(backendUnavailableMessage('zellij', 'probe failed')).toContain('0.44');
    expect(backendUnavailableMessage('zmx', 'probe failed')).toContain('0.7.0');
    for (const kind of ['tmux', 'zellij', 'zmx'] as const) {
      const msg = backendUnavailableMessage(kind, 'probe failed');
      expect(msg).toContain(kind);
      expect(msg).toContain('probe failed');
    }
  });
});
