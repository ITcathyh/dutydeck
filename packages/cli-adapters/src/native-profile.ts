import type { NormalizedDriverEvent } from '@dutydeck/shared';
import type { CliPathEnv } from './cli-paths.js';

export interface ClaudeNativeSession {
  nativeSessionId: string; path: string; dataRoot: string; cwd: string; resumable: boolean; identityProof: string;
}

export interface CreateTranscriptTailerOptions {
  cwd: string;
  /** Verified live Claude process source; never a recency selector. */
  nativeSessionPath?: string;
  nativeSession?: () => ClaudeNativeSession | undefined;
  onNativeSession?: (source: ClaudeNativeSession) => void;
  onNativeSessionSwitch?: () => void;
  /** Explicit transcript path (skips directory resolution + switching). */
  transcriptPath?: string;
  /**
   * dutydeck's session id, used to identify WHICH transcript in a shared
   * location belongs to this session.
   *
   * Several CLIs key their transcript location by cwd alone, so every dutydeck
   * session started in one repo writes into the same directory. Resolving by
   * recency there silently attaches a sibling's transcript: the timeline then
   * shows another session's answer, or the turn is failed as "no final output"
   * while the correct transcript sits on disk untouched. Sources that can be
   * session-scoped use this; the rest fall back to recency and are documented
   * as such at their resolver.
   */
  sessionId?: string;
  /** Poll interval in ms (default 300). */
  pollIntervalMs?: number;
  /**
   * The environment the CLI child process was actually spawned with
   * (`PtyCliDriver.spawnEnv()`), NOT the daemon's `process.env`.
   *
   * The data-dir variables live in the child: the driver strips `CLAUDE_*`
   * from it, and `agent.env` may point `CODEX_HOME` / `CLAUDE_CONFIG_DIR` /
   * `HOME` elsewhere for multi-account or sandbox isolation. Reading the
   * daemon's env instead makes the tailer watch a directory the CLI never
   * writes to — the turn then reports no output at all. Defaults to
   * `process.env` for callers with no child (tests, tooling).
   */
  env?: CliPathEnv;
}

/** A durable position immediately after the last complete JSONL record.
 * Without a path there is no file identity, so the only valid offset is 0. */
export interface TranscriptCursor {
  path?: string;
  offset: number;
}

/** A physical file position; offsets are comparable only within the same file epoch. */
export interface TranscriptPosition {
  path: string;
  offset: number;
  dev: number;
  ino: number;
  epoch: number;
}

export interface TranscriptCompactionObservation {
  nativeSessionId: string;
  position: TranscriptPosition | undefined;
  generation: number;
  signal: AbortSignal;
  /** Final Enter was attempted, so records can still arrive after this wait retires. */
  submitted?(): boolean;
}

/** A live source of normalized driver events, backed by a CLI transcript. */
export interface TranscriptEventSource {
  start(): void;
  stop(): void;
  flush(): Promise<void>;
  checkpoint(): TranscriptCursor;
  restore(cursor: TranscriptCursor): void;
  onEvent(cb: (e: NormalizedDriverEvent) => void): void;
  /** New complete records, including held errors that publish no event. */
  onProgress?(cb: () => void): void;
  /** Arm after flush(), before writing. Only a new authorized user record in
   * this session can confirm input; abort/stop never converts unknown into accepted. */
  waitForInput?(prompt: string, signal: AbortSignal): Promise<void>;
  /** Maintenance-only /compact evidence; never creates or completes a business turn. */
  compactionNativeSession?(): string | undefined;
  waitForCompaction?(observation: TranscriptCompactionObservation): Promise<'completed' | 'failed'>;
  /** Background sub-agents the CLI reported still running when its latest
   *  turn ended. Only sources whose transcript records it (Claude) implement this. */
  pendingBackgroundWork?(): number;
  hasIndependentBackgroundWork?(): boolean;
  /** Forget that report at a new prompt; the new turn's own end record decides. */
  resetBackgroundWork?(): void;
  /** Why the turn ends without an answer, when the CLI recorded it (Claude's
   *  API-error lines). Held back until the turn ends because later model output
   *  supersedes it. Taking it starts a clean slate for the next turn. */
  takeTurnError?(): NormalizedDriverEvent | undefined;
  /** A native terminal error whose ancestry is bound to the exact input
   * receipt. It may finish the submitted turn without terminal screen evidence. */
  takeInputError?(): NormalizedDriverEvent | undefined;
  /** Native terminal marker belonging to the current exact input receipt or
   * recovery cursor. Output text alone is not terminal evidence. */
  hasTurnTerminal?(): boolean;
  /** Advances only for fresh terminals bound to this input, not metadata or
   * replayed terminal identities. Detects continuations read in a single poll. */
  turnTerminalRevision?(): number;
  /** Synchronous disk waterline, including bytes not yet polled. */
  captureWatermark?(): TranscriptPosition | undefined;
  /** True only for a bound terminal starting after that physical waterline. */
  hasTurnTerminalAfter?(watermark: TranscriptPosition): boolean;
  /** A native business input was bound after restoring the durable cursor. */
  hasRecoveredInput?(): boolean;
  /** This dialect always records native terminals; screen silence cannot replace one. */
  readonly requiresTurnTerminal?: boolean;
  /** A native cancellation bound to the same exact input as takeInputError. */
  takeInputCancellation?(): boolean;
  /** Token usage of the model calls recorded since the last call, as a status/turn_usage event. Only
   *  transcripts that record usage (Claude, Codex) implement it; undefined means the turn's usage is unknown. */
  takeTurnUsage?(): NormalizedDriverEvent | undefined;
}

/** Everything a resolver may use to identify the session on disk. */
export interface SessionIdLookupContext {
  /** dutydeck's session id — also the fingerprint injected into prompt #1. */
  sessionId: string;
  /** Claude-family automatic reconnect requires a durable prompt marker, not only a matching filename. */
  requireMarker?: boolean;
  /** The working directory the CLI was spawned in. */
  cwd: string;
  /**
   * The environment the CLI child was spawned with (`PtyCliDriver.spawnEnv()`),
   * NOT the daemon's `process.env`. The CLI wrote its records under the data
   * root ITS env named — the driver strips `CLAUDE_*` from the child, and
   * `agent.env` may relocate `CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `HOME`.
   * Optional: defaults to `process.env`, which is correct whenever the two
   * environments agree.
   */
  env?: CliPathEnv;
}
