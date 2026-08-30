/**
 * TmuxBackend — session backend backed by a detached tmux session.
 *
 * Ported core from botmux's adapters/backend/tmux-backend.ts +
 * tmux-pipe-backend.ts. Architecture (no PTY, no attach):
 *   - `tmux new-session -d -s <name> -x <cols> -y <rows> -c <cwd>` starts a
 *     bare shell in a detached session (spawnSync, env-scrubbed client).
 *   - The CLI is launched by typing `exec /usr/bin/env KEY=VAL… <bin> <args>`
 *     into the pane via send-keys, so session-specific env NEVER touches the
 *     tmux server's global environment (injectEnv travels the same prefix).
 *   - `tmux pipe-pane -o -t <name> 'cat >> <tmpfile>'` replicates every byte
 *     the pane writes; a `tail -F` child streams the file back to onData.
 *   - Writes go through `tmux send-keys -l` (long/multiline text via
 *     load-buffer + paste-buffer, which is also robust to the 4KB tty
 *     canonical-input limit).
 *   - An exit watcher polls pane liveness: an authoritative "session gone"
 *     answer (or a dead pane pid) fires onExit; server-level failures
 *     (connect refused, lost server, timeout) prove nothing and never tear
 *     the session down.
 *
 * Deliberately NOT ported from botmux: adopt/observe mode, ambiguous
 * submission journal, sandbox integration, onAccessUrl/onTaskDone/onTurnFinal
 * hooks, destroySession fencing, captureInputState/capturePaneInputModes,
 * screen-settling heuristics.
 */
import { execFileSync, spawnSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { openSync, closeSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { SessionBackend, SessionProbe, SpawnOptions } from './types.js';

// ─── Typed errors ──────────────────────────────────────────────────────────

/** Base class for every tmux failure this backend surfaces. */
export class TmuxError extends Error {
  constructor(message: string, readonly stderr?: string) {
    super(message);
    this.name = 'TmuxError';
  }
}

/**
 * The tmux server could not be reached or did not answer within the deadline
 * ("no server running", connection refused, "lost server", command timeout,
 * tmux binary missing). The session's state is UNKNOWN — the driver may retry
 * or re-spawn, but must NOT treat this as "session gone".
 */
export class TmuxServerError extends TmuxError {
  constructor(message: string, stderr?: string) {
    super(message, stderr);
    this.name = 'TmuxServerError';
  }
}

/**
 * The server answered and authoritatively reported the session/pane missing
 * ("can't find session" / "can't find pane"). Safe to re-spawn.
 */
export class TmuxSessionMissingError extends TmuxError {
  constructor(message: string, stderr?: string) {
    super(message, stderr);
    this.name = 'TmuxSessionMissingError';
  }
}

/** new-session failed because a session with this name already exists —
 *  the driver can re-attach instead of re-spawning. */
export class TmuxSessionExistsError extends TmuxError {
  constructor(message: string, stderr?: string) {
    super(message, stderr);
    this.name = 'TmuxSessionExistsError';
  }
}

// ─── Classification helpers (ported from botmux tmux-backend.ts) ───────────

/**
 * CONNECTION-level failures — the client never got an answer from the shared
 * server, so the error proves nothing about any particular session/pane:
 *   - "error connecting to <socket>" (Linux fails unix-socket connect() with
 *     instant ECONNREFUSED when the server's accept backlog overflows — a
 *     busy-but-alive server looks exactly like a dead one)
 *   - "lost server" / "server exited unexpectedly"
 * Deliberately NOT matched: "no server running" — the client did determine
 * that no server owns the socket, and a not-running server provably has no
 * sessions (authoritative answer).
 */
function isServerLevelErrorText(stderrText: string): boolean {
  return /error connecting to|lost server|server exited unexpectedly/i.test(stderrText);
}

/** True when a thrown exec*Sync error is the caller's own timeout deadline
 *  firing — regardless of the exit-status shape Node attached (a timed-out
 *  client can complete and exit cleanly in the same window the kill fires). */
function isTimeoutError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null | undefined)?.code === 'ETIMEDOUT';
}

/** Single-quote-escape a string for /bin/sh (replaces ' with '\'' ). */
function shellescape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Environment for every `tmux` client invocation. Deliberately minimal:
 * the tmux SERVER seeds its global environment (and thus every future pane's
 * inherited env) from the first client that boots it, so anything
 * session-specific (opts.env / injectEnv) must never travel here.
 * TMUX/TMUX_PANE are stripped so a daemon started inside a tmux session
 * doesn't target that parent server's socket.
 */
function tmuxClientEnv(): NodeJS.ProcessEnv {
  const allow = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG',
    'LC_ALL', 'LC_CTYPE', 'TERM', 'XDG_RUNTIME_DIR', 'TZ',
  ];
  const out: NodeJS.ProcessEnv = {};
  for (const key of allow) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** Map a failed execFileSync to the right typed error. */
function classifyFailure(err: unknown, op: string): TmuxError {
  const e = err as (NodeJS.ErrnoException & {
    status?: number | null;
    signal?: string | null;
    stderr?: Buffer | string;
  }) | null | undefined;
  const stderrText = (e?.stderr?.toString?.() ?? '').trim();
  const detail = stderrText || e?.message || String(err);
  // Deadline first: a timed-out client can surface a clean numeric exit when
  // its completion races the kill — still "no answer", never deterministic.
  if (isTimeoutError(e)) return new TmuxServerError(`${op}: command timeout (${detail})`, stderrText);
  if (e && typeof e.status === 'number' && !e.signal) {
    if (/duplicate session/i.test(stderrText)) return new TmuxSessionExistsError(`${op}: ${detail}`, stderrText);
    if (/can't find session|can't find pane/i.test(stderrText)) return new TmuxSessionMissingError(`${op}: ${detail}`, stderrText);
    if (isServerLevelErrorText(stderrText) || /no server running/i.test(stderrText)) {
      return new TmuxServerError(`${op}: ${detail}`, stderrText);
    }
    // Server answered and rejected deterministically.
    return new TmuxError(`${op}: ${detail}`, stderrText);
  }
  // Signal-killed or spawn failure (ENOENT/EACCES/EMFILE) — no answer.
  return new TmuxServerError(`${op}: ${detail}`, stderrText);
}

/** Run a tmux command, capturing stdout. Throws a typed TmuxError on failure. */
function runTmux(args: string[], opts: { input?: string; timeout?: number } = {}): string {
  try {
    return execFileSync('tmux', args, {
      encoding: 'utf8',
      stdio: opts.input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      input: opts.input,
      timeout: opts.timeout ?? 5000,
      env: tmuxClientEnv(),
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    throw classifyFailure(err, `tmux ${args[0] ?? 'client'}`);
  }
}

let tmuxAvailableCache: boolean | undefined;

/** Probe whether tmux is installed and runnable (cached). */
export function isTmuxAvailable(): boolean {
  if (tmuxAvailableCache !== undefined) return tmuxAvailableCache;
  try {
    const r = spawnSync('tmux', ['-V'], { stdio: 'ignore', timeout: 2000 });
    tmuxAvailableCache = r.status === 0;
  } catch {
    tmuxAvailableCache = false;
  }
  return tmuxAvailableCache;
}

// ─── Backend ───────────────────────────────────────────────────────────────

/** send-keys -l payloads longer than this risk hitting the tty canonical
 *  input limit (MAX_CANON, 4096 bytes on Linux) — route through paste-buffer. */
const LITERAL_SEND_LIMIT = 4096;

export class TmuxBackend implements SessionBackend {
  readonly kind = 'tmux' as const;

  /** SessionBackend contract: the tmux session this backend owns. */
  readonly sessionName: string;
  private cols = 80;
  private rows = 24;
  private started = false;
  private exited = false;
  private pipePath: string | null = null;
  private tail: ChildProcessByStdio<null, Readable, null> | null = null;
  /** Streaming UTF-8 decoder: tail emits raw chunks that can split a
   *  multi-byte character (CJK/emoji) — StringDecoder reassembles it. */
  private readonly decoder = new StringDecoder('utf8');
  private readonly dataCbs: Array<(d: string) => void> = [];
  private readonly exitCbs: Array<(code: number | null, signal: string | null) => void> = [];
  private exitTimer: NodeJS.Timeout | null = null;

  constructor(sessionName: string) {
    this.sessionName = sessionName;
  }

  // ─── SessionBackend implementation ──────────────────────────────────────

  spawn(bin: string, args: string[], opts: SpawnOptions): void {
    if (this.started) throw new TmuxError('tmux spawn() called twice');
    this.started = true;
    this.cols = opts.cols;
    this.rows = opts.rows;

    // 1. Detached session running a bare shell. The CLI is launched by
    //    send-keys (step 4) so session-specific env never touches the tmux
    //    server's global environment.
    try {
      execFileSync('tmux', [
        'new-session', '-d',
        '-s', this.sessionName,
        '-x', String(opts.cols),
        '-y', String(opts.rows),
        '-c', opts.cwd,
      ], {
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 5000,
        env: tmuxClientEnv(),
        cwd: opts.cwd,
      });
    } catch (err) {
      throw classifyFailure(err, 'tmux new-session');
    }

    try {
      // 2. Pipe every byte the pane writes into a per-session tmp file;
      //    `tail -F` streams it back to onData. The file is removed on kill.
      this.startCapture();

      // 3. Launch the CLI with a per-pane env prefix: env(1) assignments
      //    apply to the CLI only, after the (scrubbed) pane shell starts.
      //    `exec` replaces the shell so pane_pid IS the CLI.
      const assignments = [
        ...Object.entries(opts.env),
        ...Object.entries(opts.injectEnv ?? {}),
      ].map(([k, v]) => `${k}=${v}`);
      const launchLine = ['exec', '/usr/bin/env', ...assignments, bin, ...args]
        .map(shellescape)
        .join(' ');
      this.sendLiteral(launchLine);
      runTmux(['send-keys', '-t', this.sessionName, 'Enter']);

      this.startExitWatcher();
    } catch (err) {
      this.exited = true; // spawn failed — the instance is inert
      this.cleanup();
      try { runTmux(['kill-session', '-t', this.sessionName], { timeout: 3000 }); } catch { /* best effort */ }
      throw err;
    }
  }

  /**
   * Write literal text to the pane. Never throws: a tmux failure returns
   * false (the driver treats that as "not sent"). An authoritative
   * session-missing answer is converted to onExit, mirroring botmux's
   * guardedSend — the CLI exited and the pane is gone.
   */
  write(data: string): boolean {
    if (this.exited || !this.started) return false;
    try {
      this.sendLiteral(data);
      return true;
    } catch (err) {
      if (err instanceof TmuxSessionMissingError) this.handlePaneExit();
      return false;
    }
  }

  interrupt(): void {
    if (this.exited) return;
    try { runTmux(['send-keys', '-t', this.sessionName, 'C-c']); } catch { /* best effort */ }
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    this.cols = cols;
    this.rows = rows;
    try {
      runTmux(['resize-window', '-t', this.sessionName, '-x', String(cols), '-y', String(rows)]);
    } catch { /* best effort */ }
  }

  /** Safe to call before spawn() — callbacks are buffered and survive the
   *  spawn-time wiring (unlike the pty backend). */
  onData(cb: (data: string) => void): void {
    this.dataCbs.push(cb);
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.exitCbs.push(cb);
  }

  /** Best-effort teardown. Never throws — a session that already died (CLI
   *  exited → last pane closed → session destroyed) is not an error. */
  kill(): void {
    if (this.exited) return;
    this.exited = true;
    this.stopExitWatcher();
    this.cleanup();
    try { runTmux(['kill-session', '-t', this.sessionName], { timeout: 3000 }); } catch { /* already gone */ }
  }

  /**
   * Detach this backend from a LIVE session WITHOUT destroying it: stop the
   * exit watcher, cancel the pipe-pane capture, kill the tail child. The tmux
   * session and its CLI keep running — another TmuxBackend can attach() later
   * (driver resume() across daemon restarts). Contrast with kill(), which
   * kills the session itself.
   */
  detach(): void {
    if (this.exited) return;
    this.exited = true;
    this.stopExitWatcher();
    try { runTmux(['pipe-pane', '-t', this.sessionName]); } catch { /* best effort */ }
    this.cleanup();
  }

  /**
   * Attach to an EXISTING live session — the caller must have probed with
   * probeSession() === 'exists'. Unlike spawn(), this neither creates the
   * session nor launches a CLI: the CLI is already running in the pane.
   * Re-arms output capture (pipe-pane + tail) and the exit watcher only.
   */
  attach(opts: { cols: number; rows: number }): void {
    if (this.started) throw new TmuxError('tmux attach() called twice');
    this.started = true;
    this.cols = opts.cols;
    this.rows = opts.rows;
    try {
      this.startCapture();
      this.startExitWatcher();
    } catch (err) {
      this.cleanup();
      throw err;
    }
  }

  captureCurrentScreen(): string | null {
    if (this.exited) return null;
    try {
      return runTmux(['capture-pane', '-p', '-t', this.sessionName]);
    } catch {
      return null;
    }
  }

  getPaneSize(): { cols: number; rows: number } | null {
    if (this.exited) return null;
    try {
      const out = runTmux(
        ['display-message', '-p', '-t', this.sessionName, '#{pane_width} #{pane_height}'],
        { timeout: 2000 },
      ).trim();
      const parts = out.split(/\s+/).map(s => parseInt(s, 10));
      const cols = parts[0];
      const rows = parts[1];
      if (cols !== undefined && rows !== undefined && Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
        return { cols, rows };
      }
      return null;
    } catch {
      return null;
    }
  }

  getPid(): number | null {
    if (this.exited) return null;
    try {
      const out = runTmux(
        ['display-message', '-p', '-t', this.sessionName, '#{pane_pid}'],
        { timeout: 2000 },
      ).trim();
      const pid = parseInt(out, 10);
      return pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  // ─── Static helpers ─────────────────────────────────────────────────────

  /**
   * Tri-state existence probe. `tmux has-session` exits 0 when the session
   * exists and exits 1 (clean status, no signal) when the server answered
   * but the session is absent — including "no server running" (a
   * not-running server provably has no sessions).
   * A clean non-zero exit whose stderr is a CONNECTION-level failure
   * ("error connecting to <socket>", "lost server", …) is 'unknown', not
   * 'missing': the client never reached the server, so it proved nothing.
   * Anything else — a timeout or a spawn failure (ENOENT/EACCES, neither
   * carries a numeric exit status) — also means we never got an answer →
   * 'unknown'.
   */
  static probeSession(name: string): SessionProbe {
    try {
      execFileSync('tmux', ['has-session', '-t', name], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: tmuxClientEnv(),
        timeout: 3000,
      });
      return 'exists';
    } catch (e) {
      if (isTimeoutError(e)) return 'unknown';
      const err = e as { status?: number; signal?: string; stderr?: Buffer };
      if (err && typeof err.status === 'number' && !err.signal) {
        const stderrText = (err.stderr?.toString?.() ?? '').trim();
        if (isServerLevelErrorText(stderrText)) return 'unknown';
        return 'missing';
      }
      return 'unknown';
    }
  }

  /** Kill a named tmux session (no-op if it doesn't exist). */
  static killSession(name: string): void {
    try {
      execFileSync('tmux', ['kill-session', '-t', name], {
        stdio: 'ignore',
        timeout: 3000,
        env: tmuxClientEnv(),
      });
    } catch { /* session doesn't exist */ }
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  /** Arm output capture: per-session tmp file + `tail -F` child + pipe-pane
   *  subscription. Shared by spawn() (new session) and attach() (existing
   *  session); the file is removed by cleanup() on kill/detach. */
  private startCapture(): void {
    this.pipePath = join(tmpdir(), `dockmux-tmux-${randomBytes(8).toString('hex')}.log`);
    closeSync(openSync(this.pipePath, 'w')); // ensure it exists before tail -F
    this.tail = spawn('tail', ['-n', '+1', '-F', this.pipePath], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    this.tail.stdout.on('data', (chunk: Buffer) => {
      const data = this.decoder.write(chunk);
      if (!data) return;
      for (const cb of this.dataCbs) {
        try { cb(data); } catch { /* listener crash is benign */ }
      }
    });
    this.tail.stdout.on('end', () => {
      const rest = this.decoder.end();
      if (rest) {
        for (const cb of this.dataCbs) {
          try { cb(rest); } catch { /* listener crash is benign */ }
        }
      }
    });
    this.tail.on('error', () => { /* tail missing/killed — output goes quiet */ });

    // -o opens only when no pipe is set yet; detach() cancels it.
    runTmux(['pipe-pane', '-o', '-t', this.sessionName, `cat >> ${shellescape(this.pipePath)}`]);
  }

  /** Send text literally: send-keys -l for short single-line payloads,
   *  load-buffer + paste-buffer for long or multiline text (avoids the 4KB
   *  tty canonical-input limit and handles newlines via bracketed paste). */
  private sendLiteral(text: string): void {
    if (text.length > LITERAL_SEND_LIMIT || text.includes('\n')) {
      this.pasteLiteral(text);
      return;
    }
    runTmux(['send-keys', '-t', this.sessionName, '-l', '--', text]);
  }

  private pasteLiteral(text: string): void {
    const bufferName = `dockmux-${randomBytes(8).toString('hex')}`;
    let loaded = false;
    try {
      runTmux(['load-buffer', '-b', bufferName, '-'], { input: text });
      loaded = true;
      // -d deletes the buffer after pasting; -p wraps in bracketed-paste
      // markers when the application requested bracketed paste.
      runTmux(['paste-buffer', '-b', bufferName, '-t', this.sessionName, '-d', '-p']);
      loaded = false;
    } finally {
      if (loaded) {
        try { runTmux(['delete-buffer', '-b', bufferName], { timeout: 1000 }); } catch { /* best effort */ }
      }
    }
  }

  /**
   * Poll liveness once per second. `has-session` is the authoritative
   * check: an authoritative 'missing' answer means the CLI exited (the
   * session dies with its last pane), so fire onExit. A dead pane pid
   * (process.kill ESRCH) is equally decisive. Server-level failures
   * (connect refused, lost server, timeout) prove nothing and are ignored:
   * misreading a busy-but-stalled server as "session gone" once mass-tore
   * down live sessions in botmux, so this watcher never acts on them.
   *
   * NB: `display-message` alone is NOT sufficient — on tmux 3.3a it exits 0
   * with EMPTY output for a just-destroyed session, which a throw-based
   * classifier would miss (observed live). has-session answers reliably.
   */
  private startExitWatcher(): void {
    // Liveness checks can transiently fail under load (has-session timeout,
    // display-message returning a stale/dead pid). A single bad reading must
    // NOT tear down a live session — require consecutive failures before
    // declaring the pane gone. Any successful check resets the counter.
    let consecutiveFailures = 0;
    const FAILURE_THRESHOLD = 3;
    this.exitTimer = setInterval(() => {
      if (this.exited) return;
      let failed = false;
      if (TmuxBackend.probeSession(this.sessionName) === 'missing') {
        failed = true;
      } else {
        // Session exists: with `exec env` the pane process IS the CLI, so a
        // dead pid means the CLI exited even if tmux hasn't reaped the pane.
        const pid = this.getPid();
        if (pid !== null) {
          try {
            process.kill(pid, 0);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ESRCH') failed = true;
          }
        }
      }
      if (failed) {
        consecutiveFailures++;
        if (consecutiveFailures >= FAILURE_THRESHOLD) this.handlePaneExit();
      } else {
        consecutiveFailures = 0;
      }
    }, 1000);
  }

  private stopExitWatcher(): void {
    if (this.exitTimer) {
      clearInterval(this.exitTimer);
      this.exitTimer = null;
    }
  }

  private handlePaneExit(): void {
    if (this.exited) return;
    this.exited = true;
    this.stopExitWatcher();
    this.cleanup();
    for (const cb of this.exitCbs) {
      try { cb(null, null); } catch { /* listener crash is benign */ }
    }
  }

  /** Stop the tail child and remove the pipe tmp file. Does NOT touch the
   *  tmux session itself. */
  private cleanup(): void {
    if (this.tail) {
      try { this.tail.kill(); } catch { /* already dead */ }
      this.tail = null;
    }
    if (this.pipePath) {
      try { unlinkSync(this.pipePath); } catch { /* already gone */ }
      this.pipePath = null;
    }
  }
}
