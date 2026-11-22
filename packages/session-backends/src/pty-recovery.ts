import { RuntimeError, type PtyRetirementControl, type Session } from '@dutydeck/shared';
import { dutydeckPtySessionName } from '@dutydeck/shared/execution';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { HerdrBackend } from './herdr-backend.js';
import type { ProcessProbe } from './owned-tmux.js';
import { TmuxBackend } from './tmux-backend.js';
import type { PersistentSessionBackend } from './types.js';

export function createPtyRetirementControl(probe: ProcessProbe, herdrBackend?: (session: Session) => HerdrBackend): PtyRetirementControl {
  function backend(session: Session): PersistentSessionBackend {
    if (session.terminalBackend === 'herdr') {
      if (!herdrBackend) throw new RuntimeError('HERDR_RETIREMENT_UNAVAILABLE', 'Trusted Herdr retirement is not configured', 503);
      return herdrBackend(session);
    }
    if (session.protocol !== 'pty-cli' || process.getuid?.() === undefined) throw new RuntimeError('PTY_RETIREMENT_SCOPE_REQUIRED', 'Only a local PTY session can be retired', 409);
    return new TmuxBackend(dutydeckPtySessionName(session.id), {
      ownerId: `dutydeck:${session.id}`,
      retirementSocketPath: join(realpathSync(process.env.TMUX_TMPDIR ?? '/tmp'), `tmux-${process.getuid!()}`, 'default'),
    });
  }
  return {
    async capture(session) {
      const snapshot = await backend(session).captureIdentity(probe);
      if (!snapshot) throw new RuntimeError('PTY_RETIREMENT_IDENTITY_UNAVAILABLE', 'No original PTY identity can be captured; missing alone is not proof of exit', 409);
      return snapshot;
    },
    stop: (session, snapshot, beforeKill) => backend(session).stopOwned(snapshot, probe, beforeKill),
    verify: (session, snapshot) => backend(session).verifyExit(snapshot, probe),
    captureAbsence: session => session.terminalBackend === 'herdr' ? Promise.resolve(undefined) : backend(session).captureAbsence(probe),
  };
}
