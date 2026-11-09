// The package surface that does not load the driver or transcript parsers. Callers that only need these import
// `@dutydeck/pty-driver/support`; `index.ts` re-exports all of it.
export { PTY_AGENT_CONTRIBUTIONS } from './contributions.js';
export type { PtyAgentContribution } from './contributions.js';
export { dutydeckPtySessionName } from './persistent-backend.js';
export { TRANSCRIPT_ADAPTER_IDS } from './transcript/adapter-ids.js';
export {
  resolveCliSessionId,
  adapterIdsWithSessionIdLookup,
  buildSessionMarker,
  type SessionIdLookup,
  type SessionIdLookupContext,
} from './session-id/index.js';
export {
  captureOwnedTmuxIdentity, stopOwnedTmux, verifyOwnedTmuxExit, captureOwnedTmuxAbsence, verifyOwnedTmuxAbsence,
  type OwnedTmuxScope, type OwnedTmuxIdentity, type OwnedTmuxExitProof, type OwnedTmuxAbsence, type ProcessProbe,
} from '@dutydeck/session-backends';

export { realCwd, claudeDataDir, claudeProjectDir, claudeProjectDirCandidates, codexHome, traeHome } from './cli-paths.js';
