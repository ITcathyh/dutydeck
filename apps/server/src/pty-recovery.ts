import { HerdrBackend } from '@dutydeck/session-backends';
import { realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { canonicalExecutionJson, RuntimeError, type Session } from '@dutydeck/shared';
import type { PtyRetirementControl } from '@dutydeck/runtime';
import { dutydeckPtySessionName, captureOwnedTmuxIdentity, stopOwnedTmux, verifyOwnedTmuxExit, captureOwnedTmuxAbsence, verifyOwnedTmuxAbsence, type OwnedTmuxIdentity, type OwnedTmuxExitProof, type OwnedTmuxAbsence, type ProcessProbe } from '@dutydeck/pty-driver';

/** All executable resource coordinates are derived on this server, never from the request. */
export function createPtyRetirementControl(probe: ProcessProbe, herdrBackend?: (session: Session) => HerdrBackend): PtyRetirementControl {
  const herdr = (session: Session) => {
    if (!herdrBackend) throw new RuntimeError('HERDR_RETIREMENT_UNAVAILABLE', 'Trusted Herdr retirement is not configured', 503);
    return herdrBackend(session);
  };
  const scope = (session: Session) => {
    if (session.terminalBackend === 'herdr' || session.protocol !== 'pty-cli' || process.getuid?.() === undefined) throw new RuntimeError('PTY_RETIREMENT_SCOPE_REQUIRED', 'Only a local PTY session can be retired', 409);
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
    async capture(session) {
      if (session.terminalBackend === 'herdr') return herdr(session).captureOwnedIdentity();
      const snapshot = await captureOwnedTmuxIdentity(scope(session), probe);
      if (!snapshot) throw new RuntimeError('PTY_RETIREMENT_IDENTITY_UNAVAILABLE', 'No original PTY identity can be captured; missing alone is not proof of exit', 409);
      return snapshot;
    },
    async stop(session, raw, beforeKill) {
      if (session.terminalBackend === 'herdr') return herdr(session).stopOwnedIdentity(raw, beforeKill);
      if ((raw as OwnedTmuxAbsence)?.absent) throw new RuntimeError('PTY_EXIT_UNVERIFIED', 'An absence proof cannot stop a terminal', 409);
      return stopOwnedTmux(checked(session, raw), probe, beforeKill);
    },
    async verify(session, raw) {
      if (session.terminalBackend === 'herdr') return herdr(session).verifyOwnedIdentity(raw);
      const snapshot = checked(session, raw) as OwnedTmuxIdentity | OwnedTmuxAbsence;
      return 'absent' in snapshot ? verifyOwnedTmuxAbsence(snapshot, probe) : verifyOwnedTmuxExit(proof(snapshot), probe);
    },
    // Herdr 终端不走这条路径。tmux 上找不到会话时给出可复查的不存在证明；是否接受由运行时按所有者是否已退出决定。
    async captureAbsence(session) { return session.terminalBackend === 'herdr' ? undefined : captureOwnedTmuxAbsence(scope(session), probe); },
  };
}
