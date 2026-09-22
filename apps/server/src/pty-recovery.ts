import { realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { canonicalExecutionJson, RuntimeError, type Session } from '@dutydeck/shared';
import type { PtyRetirementControl } from '@dutydeck/runtime';
import { dutydeckPtySessionName, captureOwnedTmuxIdentity, stopOwnedTmux, verifyOwnedTmuxExit, type OwnedTmuxIdentity, type OwnedTmuxExitProof, type ProcessProbe } from '@dutydeck/pty-driver';

/** All executable resource coordinates are derived on this server, never from the request. */
export function createPtyRetirementControl(probe: ProcessProbe): PtyRetirementControl {
  const scope = (session: Session) => {
    if (session.protocol !== 'pty-cli' || process.getuid?.() === undefined) throw new RuntimeError('PTY_RETIREMENT_SCOPE_REQUIRED', 'Only a local PTY session can be retired', 409);
    return { socketPath: join(realpathSync(process.env.TMUX_TMPDIR ?? '/tmp'), `tmux-${process.getuid!()}`, 'default'),
      sessionName: dutydeckPtySessionName(session.id), ownerId: `dutydeck:${session.id}`, hostname: hostname(), uid: process.getuid!() };
  };
  const checked = (session: Session, raw: unknown) => {
    const snapshot = raw as OwnedTmuxIdentity;
    if (!snapshot || canonicalExecutionJson(snapshot.scope) !== canonicalExecutionJson(scope(session))) throw new RuntimeError('PTY_RETIREMENT_SCOPE_CONFLICT', 'Stored snapshot does not match this session on this host', 409);
    return snapshot;
  };
  const proof = (snapshot: OwnedTmuxIdentity): OwnedTmuxExitProof => ({ ...snapshot, stoppedAt: (snapshot as OwnedTmuxExitProof).stoppedAt ?? new Date().toISOString() });
  return {
    capture(session) {
      const snapshot = captureOwnedTmuxIdentity(scope(session), probe);
      if (!snapshot) throw new RuntimeError('PTY_RETIREMENT_IDENTITY_UNAVAILABLE', 'No original PTY identity can be captured; missing alone is not proof of exit', 409);
      return snapshot;
    },
    async stop(session, raw, beforeKill) { return stopOwnedTmux(checked(session, raw), probe, beforeKill); },
    verify(session, raw) { return verifyOwnedTmuxExit(proof(checked(session, raw)), probe); },
  };
}
