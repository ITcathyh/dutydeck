export type { SessionBackend, SpawnOptions, SessionProbe } from './types.js';
export { PtyBackend } from './pty-backend.js';
export {
  TmuxBackend,
  TmuxError,
  TmuxServerError,
  TmuxSessionMissingError,
  TmuxSessionExistsError,
  TmuxOwnershipError,
  isTmuxAvailable,
  type TmuxBackendOptions,
  type TmuxDutydeckMetadataKey,
} from './tmux-backend.js';
export {
  captureOwnedTmuxIdentity, stopOwnedTmux, verifyOwnedTmuxExit,
  type OwnedTmuxScope, type OwnedTmuxIdentity, type OwnedTmuxExitProof,
  type PhysicalProcessIdentity, type ProcessProbe,
} from './owned-tmux.js';

export { HerdrBackend, herdrControlEnvironment, type HerdrBackendOptions } from './herdr-backend.js';
