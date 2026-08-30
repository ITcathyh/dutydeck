/**
 * Session backend contract — PTY and tmux implementations.
 * Ported from botmux's adapters/backend layer (core only).
 */

export interface SpawnOptions {
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
  readonly kind: 'pty' | 'tmux' | 'zellij' | 'zmx';
  /** Start the CLI process. Calling twice is undefined behavior (driver calls once). */
  spawn(bin: string, args: string[], opts: SpawnOptions): void;
  /** Write literal text. Returns false when the backend refused outright
   *  (tmux send-keys timeout, …); void/true means it was sent. */
  write(data: string): void | boolean;
  /** Interrupt the current turn: pty writes \x03; tmux sends C-c. */
  interrupt(): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  kill(): void;
  /**
   * Detach from a LIVE backend without destroying the underlying session
   * (tmux only): tear down output capture so another backend instance can
   * attach later. The CLI process keeps running. PtyBackend does not
   * implement it — a pty child cannot survive its backend.
   */
  detach?(): void;
  /** tmux: capture-pane snapshot; pty: null */
  captureCurrentScreen?(): string | null;
  getPaneSize?(): { cols: number; rows: number } | null;
  getPid?(): number | null;
}

/** Tri-state tmux session probe (command failure ≠ session missing). */
export type SessionProbe = 'exists' | 'missing' | 'unknown';
