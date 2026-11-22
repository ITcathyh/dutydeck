import type { DiagnosticLog } from '@dutydeck/shared';
import type { ProcessProbe } from './owned-tmux.js';

/**
 * Session backend contract — PTY and terminal multiplexer implementations.
 * Third-party attribution: see THIRD_PARTY_NOTICES.md.
 */

export interface SpawnOptions {
  /** Enable OSC 7501 negotiation for a known supporting CLI. */
  programStatus?: boolean;
  cwd: string;
  cols: number;
  rows: number;
  /** Base environment (already merged: process.env + agent.env). */
  env: Record<string, string>;
  /** Extra env injected into the CLI process only. Under tmux this travels
   *  via a per-pane env prefix, never the tmux server's global environment. */
  injectEnv?: Record<string, string>;
}

export interface SessionBackend {
  readonly persistent?: PersistentSessionBackend;
  readonly kind: 'pty' | 'tmux' | 'herdr';
  /**
   * The multiplexer session this backend is bound to (tmux/Herdr session
   * name), or undefined for backends with no addressable session (pty).
   *
   * This is the ONLY supported way to ask a backend which session it owns.
   * The driver needs it to probe "is my session still alive?" before deciding
   * between reattach and respawn; it used to read the implementations' private
   * `sessionName` field by reflection, which broke silently on any rename.
   * Read-only on purpose: the name is fixed at construction, and rebinding a
   * live backend to a different session would strand its capture pipeline.
   */
  readonly sessionName?: string;
  /** Start the CLI process. Calling twice is undefined behavior (driver calls once). */
  spawn(bin: string, args: string[], opts: SpawnOptions): void | Promise<void>;
  /** Write literal text. Returns false when the backend refused outright
   *  (tmux send-keys timeout, …); void/true means it was sent. */
  write(data: string): void | boolean | Promise<void | boolean>;
  /** Interrupt the current turn: pty writes \x03; tmux sends C-c. */
  interrupt(): void | Promise<void>;
  resize(cols: number, rows: number): void | Promise<void>;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  kill(): void | Promise<void>;
  /**
   * Detach from a LIVE backend without destroying the underlying session
   * (tmux only): tear down output capture so another backend instance can
   * attach later. The CLI process keeps running. PtyBackend does not
   * implement it — a pty child cannot survive its backend.
   */
  detach?(): void | Promise<void>;
  /** tmux: capture-pane snapshot; pty: null. Submission reads may request bounded scrollback. */
  captureCurrentScreen?(includeScrollback?: boolean): string | null | Promise<string | null>;
  /** Fresh post-write input proof with cursor/terminal-padding metadata when the backend supports it. */
  captureInputSubmissionScreen?(): string | null | Promise<string | null>;
  /** Atomically restore a snapshot followed by new pipe increments. */
  resyncOutput?(onBoundary?: () => void): Promise<string | null>;
  onOutputGap?(cb: (droppedBytes: number) => void): void;
  getPaneSize?(): { cols: number; rows: number } | null | Promise<{ cols: number; rows: number } | null>;
  getPid?(): number | null | Promise<number | null>;
}

/** Tri-state tmux session probe (command failure ≠ session missing). */
export type SessionProbe = 'exists' | 'missing' | 'unknown';

export type TerminalMetadataKey = 'first_prompt_sent' | 'turn_id';
export interface PersistentSessionBackend extends SessionBackend {
  readonly ownerId?: string;
  readonly initialScreen?: { data: string; cols: number; rows: number };
  canAttach(purpose: 'start' | 'resume' | 'view', check?: () => void): Promise<boolean>;
  attachmentTarget(log?: DiagnosticLog): PersistentSessionBackend;
  replacement(sessionId: string, log?: DiagnosticLog): PersistentSessionBackend;
  recoveryOwnerError?(): Promise<string | undefined>;
  prepareReplacement?(): Promise<void>;
  readonly preserveOnShutdown?: boolean;
  assertOwnedIdentity?(snapshot: unknown): Promise<void>;
  onDisconnect?(callback: (error: Error) => void): void;
  exitedAfterDisconnect(): Promise<boolean>;
  rememberIdentity?(probe?: ProcessProbe): Promise<void>;
  stopAttached(probe?: ProcessProbe): Promise<void>;
  attachedExitVerified(probe: ProcessProbe | undefined, pid: number | undefined, preserve: boolean): Promise<boolean>;
  idleProcessesVerified?(identity: string, probe: ProcessProbe): boolean;
  adoptionIdentity(allowIdle: boolean, probe?: ProcessProbe, pid?: number): Promise<unknown>;
  verifyAdoption(snapshot: unknown, idle: () => boolean, probe?: ProcessProbe, pid?: number): Promise<void>;
  captureIdentity(probe?: ProcessProbe): Promise<unknown>;
  captureAbsence(probe?: ProcessProbe): Promise<unknown>;
  stopOwned(snapshot: unknown, probe?: ProcessProbe, beforeKill?: (snapshot: unknown) => Promise<void>): Promise<unknown>;
  verifyExit(snapshot: unknown, probe?: ProcessProbe): Promise<boolean>;
  getMetadata(key: TerminalMetadataKey): Promise<string | undefined>;
  setMetadata(key: TerminalMetadataKey, value: string): Promise<void>;
  reattach(size: { cols: number; rows: number }): Promise<void>;
  detach(): Promise<void>;
  cancelPending(): Promise<void>;
}

/** Screen encoding and cursor semantics also apply to externally supplied SessionBackend implementations. */
export const terminalScreens = {
  pty: { renderedFrames: false, paneGeometry: false },
  tmux: { renderedFrames: false, paneGeometry: true },
  herdr: { renderedFrames: true, paneGeometry: false },
} as const;
