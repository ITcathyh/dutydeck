/**
 * ZmxBackend — session backend backed by a persistent zmx session.
 *
 * Third-party attribution: see THIRD_PARTY_NOTICES.md.
 * Core multiplexer protocol implementation.
 *
 * zmx is a standalone terminal multiplexer (github.com/neurosnap/zmx) whose CLI
 * is a control plane rather than an attach client — which shapes this backend:
 *   - `zmx attach <name> /bin/sh <bootstrap>` creates a detached session
 *     running the command. Attach (not `zmx run`) is deliberate: an EXISTING
 *     session ignores the command argument, so attach cannot inject into a
 *     session someone else won the race to create. `run` is an upsert and can.
 *   - Output is NOT a stream. `zmx tail <name>` emits bytes but its upstream
 *     ANSI stripper mangles UTF-8, so tail output is used ONLY as an activity
 *     signal ("something changed"); the authoritative view comes from
 *     `zmx history <name>`, a full-transcript snapshot that is diffed against
 *     the previous one to derive the delta emitted to onData.
 *   - Input is `zmx send <name>` with the bytes on stdin.
 *   - Env is injected by the bootstrap script `exec /usr/bin/env KEY=VAL… bin`,
 *     so it lands on the CLI only. Control-plane invocations run on a scrubbed
 *     allowlist env, so nothing session-specific reaches the zmx daemon.
 *   - `zmx kill <name> --force` destroys a session.
 *
 * Not implemented: the ready/release launch handshake with nonce files,
 * session/transport/gate labels and same-name-replacement detection,
 * ambiguous-submission journalling and fail-closed composer recovery,
 * tail reconnect/backoff, sandbox and wrapper-shell integration.
 * Dutydeck owns its session names directly.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { SessionBackend, SessionProbe, SpawnOptions } from './types.js';

const ZMX_COMMAND_TIMEOUT_MS = 5000;
const ZMX_HISTORY_TIMEOUT_MS = 3000;
/** Debounce after a tail activity signal — coalesces a burst into one capture. */
const HISTORY_TAIL_DEBOUNCE_MS = 50;
/** Poll cadence while output is moving. */
const HISTORY_HOT_POLL_MS = 250;
/** Safety poll when things look quiet. Kept comfortably under a typical 2s
 *  idle-detection window so a burst tail failed to signal is still observed
 *  before the consumer declares the turn finished. */
const HISTORY_COLD_POLL_MS = 1250;
/** Consecutive unchanged snapshots before backing off to the cold cadence. */
const HISTORY_STABLE_POLLS_BEFORE_COLD = 3;
/** Cap on the transcript we keep/emit, newest-first. */
const ZMX_HISTORY_MAX_BYTES = 16 * 1024 * 1024;
/**
 * zmx's daemon reads one 4096-byte IPC frame at a time and may observe HUP from
 * the short-lived `send` client in the same poll iteration. Keep header+payload
 * well below that boundary so it parses the complete message before closing the
 * client — `zmx send` has no ACK/drain handshake.
 */
const ZMX_SEND_CHUNK_BYTES = 1024;
/**
 * zmx queues send input into a 256 KiB daemon-side buffer and silently DROPS a
 * payload that would overflow it (no ACK, so `zmx send` still exits 0). Refuse
 * one-shot payloads well below that ceiling instead of losing them silently.
 */
const ZMX_SEND_MAX_BYTES = 64 * 1024;
/** Lowest zmx whose `send` only queues input instead of taking client
 *  leadership. Below this floor `send` steals the leader and rewrites the
 *  terminal size, corrupting the `history` screen this backend reads. */
export const MIN_ZMX_VERSION = { major: 0, minor: 7, patch: 0 };
/** zmx removes a session's history as soon as its PTY root exits. Keep the
 *  launch shell alive briefly after the CLI finishes so the history poller can
 *  publish the final bytes before the session disappears. */
const ZMX_EXIT_HISTORY_GRACE_SECONDS = 3;

/**
 * Environment for every zmx control-plane invocation.
 *
 * An allowlist, for the same reason tmux/zellij use one: session-specific env
 * must never reach the zmx daemon (which would leak it into future sessions).
 * ZMX_SESSION / ZMX_SESSION_PREFIX are absent from the allowlist by
 * construction, so a daemon launched inside a zmx session cannot have its
 * control commands retargeted at the parent session.
 */
export function zmxControlEnv(): NodeJS.ProcessEnv {
  const allow = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG',
    'LC_ALL', 'LC_CTYPE', 'XDG_RUNTIME_DIR', 'TZ',
  ];
  const out: NodeJS.ProcessEnv = {};
  for (const key of allow) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** The session PTY inherits the creating client's env, so TERM must be pinned
 *  here or the CLI comes up on a dumb terminal. */
export function zmxSessionEnv(): NodeJS.ProcessEnv {
  return { ...zmxControlEnv(), TERM: 'xterm-256color' };
}

let zmxAvailableCache: boolean | undefined;

/** Parse `zmx version` output (it also prints socket/log dirs) → semver. */
export function parseZmxVersion(raw: string): { major: number; minor: number; patch: number } | undefined {
  const m = raw.match(/(?:^|\n)zmx\s+(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** True iff `v` >= `min` (pure — unit testable). */
export function isZmxVersionSupported(
  v: { major: number; minor: number; patch: number },
  min = MIN_ZMX_VERSION,
): boolean {
  if (v.major !== min.major) return v.major > min.major;
  if (v.minor !== min.minor) return v.minor > min.minor;
  return v.patch >= min.patch;
}

/**
 * Probe whether a new-enough zmx is installed and runnable (cached).
 *
 * The subcommand is `zmx version`, not `--version`. Note the version floor is
 * necessary but NOT sufficient: an already-running older daemon silently
 * discards the newer `send` IPC tag while `zmx send` still exits 0.
 */
export function isZmxAvailable(): boolean {
  if (zmxAvailableCache !== undefined) return zmxAvailableCache;
  try {
    const r = spawnSync('zmx', ['version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
      env: zmxControlEnv(),
    });
    if (r.status !== 0) {
      zmxAvailableCache = false;
    } else {
      const v = parseZmxVersion((r.stdout ?? '').trim());
      zmxAvailableCache = v !== undefined && isZmxVersionSupported(v);
    }
  } catch {
    zmxAvailableCache = false;
  }
  return zmxAvailableCache;
}

/** zmx history emits LF while tail can expose CRLF; a terminal consumer needs
 *  CRLF, without doubling an existing one. */
export function normaliseZmxHistory(text: string): string {
  return text.replace(/\r*\n/g, '\r\n');
}

/**
 * Parse `zmx list --short` — one bare session name per line.
 *
 * This is the AUTHORITATIVE healthy-name surface. The full `zmx list` format is
 * not a line protocol (a session's `cmd=` field is verbatim argv and may
 * contain literal newlines that spill onto continuation lines), so a forged
 * command string could otherwise fabricate a session row. Names containing a
 * tab or a control character are impossible here and are reported as malformed
 * rather than accepted.
 */
export function parseZmxShortList(output: string): { sessions: string[]; malformedLines: string[] } {
  const sessions: string[] = [];
  const malformedLines: string[] = [];
  const seen = new Set<string>();
  for (const raw of output.split('\n')) {
    const name = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!name) continue;
    // eslint-disable-next-line no-control-regex
    if (/[\t\x00-\x1f\x7f]/.test(name) || seen.has(name)) {
      malformedLines.push(raw);
      continue;
    }
    seen.add(name);
    sessions.push(name);
  }
  return { sessions, malformedLines };
}

/**
 * Parse the full `zmx list` — tab-separated `name=…\tpid=…\t…` records, or
 * `name=…\terr=…` for a session whose backing process is broken.
 *
 * Only the FIRST line of a record is trustworthy: once a record has started,
 * later text can be continuation of a multiline `cmd=` field, so a line that
 * merely looks like a record is skipped rather than parsed.
 */
export function parseZmxList(output: string): {
  sessions: string[];
  unhealthySessions: string[];
  malformedLines: string[];
} {
  const sessions: string[] = [];
  const unhealthySessions: string[] = [];
  const malformedLines: string[] = [];
  let sawRecord = false;
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    if (!/^\s*name=[^\t]*\t(?:pid=\d+(?:\t|$)|err=)/.test(line)) {
      if (!sawRecord) malformedLines.push(line);
      continue;
    }
    sawRecord = true;
    const fields = line.replace(/^\s*/, '').split('\t');
    const nameField = fields[0];
    const name = nameField?.startsWith('name=') ? nameField.slice(5) : '';
    const status = fields[1];
    // eslint-disable-next-line no-control-regex
    if (!name || /[\x00-\x1f\x7f]/.test(name) || !status) {
      malformedLines.push(line);
    } else if (/^pid=\d+$/.test(status)) {
      sessions.push(name);
    } else if (status.startsWith('err=')) {
      unhealthySessions.push(name);
    } else {
      malformedLines.push(line);
    }
  }
  return { sessions, unhealthySessions, malformedLines };
}

export interface ZmxSessionsProbe {
  ok: true;
  /** Names confirmed healthy by `list --short`. */
  sessions: string[];
  /** Names that exist but whose health is not established — never treat these
   *  as absent (that would spawn a duplicate CLI). */
  unhealthySessions: string[];
}

/**
 * Reconcile the two listing surfaces into a trustworthy view. Pure, so the
 * forged-row defence is testable without zmx installed.
 *
 * `list --short` is authoritative for healthy names: it is a real line protocol
 * (one bare name per line), so nothing in a session's command can forge a row.
 * The full `list` is NOT a line protocol — a session's `cmd=` field is verbatim
 * argv and may contain literal newlines, so a crafted command can print
 * something that parses as a healthy record for any name it likes.
 *
 * Hence: a healthy-looking full row absent from `--short` is neither existence
 * nor absence — it is downgraded to UNKNOWN. Unknown blocks both reattach and
 * a fresh spawn, which is the safe outcome; treating it as absent would start a
 * duplicate CLI against a live session.
 */
export function reconcileZmxSessions(
  short: { sessions: string[]; malformedLines: string[] },
  full: { sessions: string[]; unhealthySessions: string[]; malformedLines: string[] },
): ZmxSessionsProbe | { ok: false } {
  // A partially-understood listing must never answer "missing".
  if (short.malformedLines.length > 0 || full.malformedLines.length > 0) return { ok: false };
  // --short saw names the full list cannot account for at all → the surfaces
  // disagree, so neither is trustworthy.
  if (short.sessions.length > 0 && full.sessions.length + full.unhealthySessions.length === 0) {
    return { ok: false };
  }
  const healthy = new Set(short.sessions);
  const unhealthy = new Set([
    ...full.unhealthySessions.filter(n => !healthy.has(n)),
    // The forged-row defence: healthy in the full list but unseen by --short.
    ...full.sessions.filter(n => !healthy.has(n)),
  ]);
  return { ok: true, sessions: short.sessions, unhealthySessions: [...unhealthy] };
}

/** Single-quote-escape a string for /bin/sh. */
function shellescape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Render the bootstrap script a fresh session runs.
 *
 * It self-deletes (the file carries the env assignments, which may include
 * secrets, so it must not outlive the exec) and then runs
 * `/usr/bin/env KEY=VAL… <bin> <args>`.
 *
 * Deliberately NOT `exec`: zmx destroys a session's history the moment its PTY
 * root exits, so the root shell is kept alive for a short grace period after
 * the CLI finishes — that window is what lets the history poller publish the
 * final output before the session disappears. The CLI still runs in the
 * foreground, so it keeps the normal SIGINT disposition.
 */
export function buildZmxBootstrap(bin: string, args: string[], opts: SpawnOptions): string {
  const assignments = [
    ...Object.entries(opts.env),
    ...Object.entries(opts.injectEnv ?? {}),
  ].map(([k, v]) => `${k}=${v}`);
  const launch = ['/usr/bin/env', ...assignments, bin, ...args].map(shellescape).join(' ');
  return [
    '#!/bin/sh',
    'umask 077',
    // The script carries session env — remove it before handing control over.
    'self=$0',
    'rm -f -- "$self"',
    'unset self ZMX_SESSION ZMX_SESSION_PREFIX',
    `cd ${shellescape(opts.cwd)} || exit 126`,
    launch,
    // Grace window: keep the PTY root alive so the final bytes stay readable
    // through `zmx history`. The loop retries a sleep interrupted by a signal.
    `while ! sleep ${ZMX_EXIT_HISTORY_GRACE_SECONDS}; do :; done`,
  ].join('\n');
}

/**
 * argv for creating a fresh session.
 *
 * `attach` rather than `run`: an existing session IGNORES this command, which
 * makes attach safe against a concurrent creator — `run` is an upsert and would
 * inject our command into a session we did not create.
 */
export function buildZmxAttachArgs(sessionName: string, bootstrapPath: string): string[] {
  return ['attach', sessionName, '/bin/sh', bootstrapPath];
}

export class ZmxBackend implements SessionBackend {
  readonly kind = 'zmx' as const;

  /** SessionBackend contract: the zmx session this backend owns. */
  readonly sessionName: string;
  private started = false;
  private exited = false;
  /** Set by detach()/kill() so teardown we caused is not reported as CLI exit. */
  private intentionalExit = false;
  private launchDir: string | null = null;
  private tailProcess: ChildProcess | null = null;
  private historyTimer: NodeJS.Timeout | null = null;
  private historyGeneration = 0;
  private capturing = false;
  /** Last authoritative transcript; the diff base for delta emission. */
  private snapshotCache = '';
  private hasSnapshot = false;
  private stablePolls = 0;
  private readonly dataCbs: Array<(d: string) => void> = [];
  private readonly exitCbs: Array<(code: number | null, signal: string | null) => void> = [];

  constructor(sessionName: string) {
    this.sessionName = sessionName;
  }

  // ─── Static helpers ───────────────────────────────────────────────────────

  /**
   * Pair the authoritative healthy-name surface (`list --short`) with the full
   * list's `err=` rows. See reconcileZmxSessions for the trust model.
   */
  static probeSessions(): ZmxSessionsProbe | { ok: false } {
    try {
      const shortOut = execFileSync('zmx', ['list', '--short'], {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, env: zmxControlEnv(),
      });
      const fullOut = execFileSync('zmx', ['list'], {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, env: zmxControlEnv(),
      });
      return reconcileZmxSessions(parseZmxShortList(shortOut), parseZmxList(fullOut));
    } catch {
      return { ok: false };
    }
  }

  /** Tri-state probe. A failed listing, or a name known only ambiguously, is
   *  'unknown' — never 'missing'. */
  static probeSession(name: string): SessionProbe {
    const probe = ZmxBackend.probeSessions();
    if (!probe.ok) return 'unknown';
    if (probe.sessions.includes(name)) return 'exists';
    if (probe.unhealthySessions.includes(name)) return 'unknown';
    return 'missing';
  }

  static killSession(name: string): void {
    try {
      execFileSync('zmx', ['kill', name, '--force'], {
        stdio: 'ignore', timeout: ZMX_COMMAND_TIMEOUT_MS, env: zmxControlEnv(),
      });
    } catch { /* doesn't exist */ }
  }

  // ─── SessionBackend implementation ────────────────────────────────────────

  spawn(bin: string, args: string[], opts: SpawnOptions): void {
    if (this.started) throw new Error('zmx spawn() called twice');
    this.started = true;

    // A live session means the daemon restarted while the CLI survived: skip
    // creation and just re-arm observation. 'unknown' is treated as live —
    // creating a duplicate CLI is far worse than observing a session that
    // turns out to be gone (the liveness poll will then fire onExit).
    const probe = ZmxBackend.probeSession(this.sessionName);
    if (probe === 'missing') {
      this.launchDir = mkdtempSync(join(tmpdir(), 'dutydeck-zmx-'));
      const bootstrapPath = join(this.launchDir, `bootstrap-${randomBytes(6).toString('hex')}.sh`);
      writeFileSync(bootstrapPath, buildZmxBootstrap(bin, args, opts), { mode: 0o600 });
      const result = spawnSync('zmx', buildZmxAttachArgs(this.sessionName, bootstrapPath), {
        cwd: opts.cwd,
        // stdio ignored makes this a one-shot CREATE client: it never lingers
        // as a fake terminal leader controlling the session's PTY dimensions.
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: ZMX_COMMAND_TIMEOUT_MS,
        env: zmxSessionEnv(),
      });
      if (result.error) {
        this.cleanupLaunchDir();
        throw result.error;
      }
    }

    this.startTail();
    this.requestHistoryCapture(0);
  }

  /**
   * Bytes go to the session's PTY via `zmx send` with the payload on **stdin**
   * (never argv — env values and prompts must not be visible in a process
   * listing).
   *
   * Three protocol rules, all load-bearing:
   *  1. zmx strips exactly one trailing LF from piped stdin, so a framing '\n'
   *     is appended — that preserves the caller's bytes exactly, including an
   *     original trailing newline.
   *  2. Several zmx control-plane failures are reported on **stdout with exit
   *     status 0**. Empty stdout is the success contract.
   *  3. Chunked, because the daemon reads one IPC frame at a time. A send is
   *     never retried: there is no PTY-level ACK, so a retry can duplicate
   *     input the daemon already queued.
   */
  write(data: string): boolean {
    if (this.exited || !this.started || !data) return false;
    const buf = Buffer.from(data, 'utf-8');
    // Oversized payloads are silently dropped by the daemon — refuse up front.
    if (buf.length > ZMX_SEND_MAX_BYTES) return false;
    for (let i = 0; i < buf.length; i += ZMX_SEND_CHUNK_BYTES) {
      const chunk = buf.subarray(i, i + ZMX_SEND_CHUNK_BYTES);
      let stdout: string;
      try {
        stdout = execFileSync('zmx', ['send', this.sessionName], {
          input: Buffer.concat([chunk, Buffer.from('\n')]),
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: ZMX_COMMAND_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          env: zmxControlEnv(),
        });
      } catch {
        return false;
      }
      if (stdout.trim()) return false; // exit 0 but an error on stdout
    }
    // A write moves the pane — capture soon rather than at the cold cadence.
    this.requestHistoryCapture(HISTORY_TAIL_DEBOUNCE_MS);
    return true;
  }

  interrupt(): void {
    this.write('\x03');
  }

  /**
   * No-op by construction: zmx exposes no leaderless resize primitive. Size is
   * set only by an attached client's window size, and `send` deliberately never
   * becomes that client. Because the session is created with non-TTY stdio, it
   * runs at zmx's fallback geometry until a real `zmx attach` takes leadership —
   * so the CLI wraps its TUI at that fixed width, which is what the captured
   * history reflects.
   */
  resize(_cols: number, _rows: number): void { /* unsupported by zmx */ }

  /** Safe before spawn() — callbacks are buffered. */
  onData(cb: (data: string) => void): void {
    this.dataCbs.push(cb);
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.exitCbs.push(cb);
  }

  /** The full transcript as last captured. */
  captureCurrentScreen(): string | null {
    if (this.exited) return null;
    return this.hasSnapshot ? this.snapshotCache : null;
  }

  /**
   * Detach WITHOUT destroying the session: stop tail + history polling. The zmx
   * session and its CLI keep running, so a later ZmxBackend.spawn() with the
   * same name re-observes it instead of starting a second CLI.
   */
  detach(): void {
    if (this.exited) return;
    this.exited = true;
    this.intentionalExit = true;
    this.stopObservation();
    this.cleanupLaunchDir();
  }

  /** Destroy the session permanently. */
  kill(): void {
    const alreadyDetached = this.exited;
    this.exited = true;
    this.intentionalExit = true;
    this.stopObservation();
    this.cleanupLaunchDir();
    if (this.started || alreadyDetached) ZmxBackend.killSession(this.sessionName);
  }

  // ─── Observation internals ────────────────────────────────────────────────

  /**
   * `zmx tail` as an ACTIVITY SIGNAL ONLY.
   *
   * Its bytes are deliberately discarded: upstream's ANSI stripper corrupts
   * UTF-8 and can consume following ASCII, so the payload is not trustworthy —
   * only the fact that a chunk arrived. Every chunk wakes a history capture,
   * which is the authoritative view.
   */
  private startTail(): void {
    const child = spawn('zmx', ['tail', this.sessionName], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: zmxControlEnv(),
    });
    this.tailProcess = child;
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (this.exited || this.tailProcess !== child) return;
      const len = typeof chunk === 'string' ? chunk.length : chunk.byteLength;
      if (len > 0) this.requestHistoryCapture(HISTORY_TAIL_DEBOUNCE_MS);
    });
    child.on('error', () => { /* tail unavailable — the poll still runs */ });
  }

  /** Schedule a capture in `delay` ms, unless one is already due sooner. */
  private requestHistoryCapture(delay: number): void {
    if (this.exited) return;
    if (this.historyTimer) clearTimeout(this.historyTimer);
    this.historyTimer = setTimeout(() => {
      this.historyTimer = null;
      void this.captureAndPublish();
    }, delay);
    this.historyTimer.unref?.();
  }

  private async captureAndPublish(): Promise<void> {
    if (this.exited || this.capturing) return;
    this.capturing = true;
    const generation = this.historyGeneration;
    try {
      const snapshot = await this.readHistory();
      if (this.exited || generation !== this.historyGeneration) return;
      if (snapshot === null) {
        // The command failed. Distinguish "session gone" (authoritative) from a
        // transient control-plane failure — only the former ends the session.
        if (ZmxBackend.probeSession(this.sessionName) === 'missing') {
          this.handleSessionGone();
          return;
        }
      } else {
        this.publishSnapshot(snapshot);
      }
    } finally {
      this.capturing = false;
      if (!this.exited) {
        const cold = this.stablePolls >= HISTORY_STABLE_POLLS_BEFORE_COLD;
        this.requestHistoryCapture(cold ? HISTORY_COLD_POLL_MS : HISTORY_HOT_POLL_MS);
      }
    }
  }

  /**
   * `zmx history <name>` — the full transcript. null on failure.
   *
   * The output MUST go to a real file descriptor, not a Node pipe: zmx does a
   * single write that a pipe truncates. The file is unlinked immediately after
   * opening, so the transcript bytes stay reachable only through the open fd
   * (they never sit on disk under a readable path).
   */
  private readHistory(): Promise<string | null> {
    return new Promise(resolve => {
      let dir: string | null = null;
      let fd: number | null = null;
      let done = false;
      const cleanup = () => {
        if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } fd = null; }
        if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* benign */ } dir = null; }
      };
      const finish = (v: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cleanup();
        resolve(v);
      };

      let timer: NodeJS.Timeout;
      try {
        dir = mkdtempSync(join(tmpdir(), 'dutydeck-zmx-history-'));
        const path = join(dir, 'history.txt');
        fd = openSync(path, 'wx+', 0o600);
        rmSync(path); // keep the bytes reachable only through the fd
        const child = spawn('zmx', ['history', this.sessionName], {
          stdio: ['ignore', fd, 'pipe'],
          env: zmxControlEnv(),
        });
        let stderrTail = '';
        child.stderr?.on('data', (c: Buffer) => { stderrTail = (stderrTail + c.toString()).slice(-4096); });
        timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          finish(null);
        }, ZMX_HISTORY_TIMEOUT_MS);
        timer.unref?.();
        child.once('error', () => finish(null));
        child.once('close', (code, signal) => {
          if (code !== 0 || signal || stderrTail.trim() || fd === null) return finish(null);
          try {
            // Tail-bounded read: only the newest slice is kept, and a leading
            // partial line is discarded so the text starts on a line boundary.
            const size = fstatSync(fd).size;
            const length = Math.min(size, ZMX_HISTORY_MAX_BYTES);
            const buf = Buffer.allocUnsafe(length);
            if (length > 0) readSync(fd, buf, 0, length, size - length);
            let text = buf.toString('utf-8');
            if (length < size) {
              const nl = text.indexOf('\n');
              text = nl >= 0 ? text.slice(nl + 1) : text;
            }
            finish(normaliseZmxHistory(text));
          } catch {
            finish(null);
          }
        });
      } catch {
        finish(null);
      }
    });
  }

  /**
   * Diff the new transcript against the last one and emit only the delta.
   *
   * An append (the normal case) emits the appended tail. Anything else — a
   * rewrite, a scrollback trim — re-emits the whole snapshot, since a
   * consumer's terminal must be resynced rather than fed a bogus delta.
   */
  private publishSnapshot(snapshot: string): void {
    // A zmx history failure can exit 0 with EMPTY stdout. Never let an
    // ambiguous empty capture erase a previously non-empty authoritative view.
    if (snapshot.length === 0 && this.hasSnapshot && this.snapshotCache.length > 0) {
      this.stablePolls = 0;
      return;
    }
    if (!this.hasSnapshot) {
      this.hasSnapshot = true;
      this.snapshotCache = snapshot;
      this.stablePolls = snapshot.length === 0 ? 1 : 0;
      if (snapshot) this.emitData(snapshot);
      return;
    }
    const previous = this.snapshotCache;
    if (snapshot === previous) {
      this.stablePolls += 1;
      return;
    }
    this.snapshotCache = snapshot;
    this.stablePolls = 0;
    this.emitData(snapshot.startsWith(previous) ? snapshot.slice(previous.length) : snapshot);
  }

  private emitData(data: string): void {
    for (const cb of this.dataCbs) {
      try { cb(data); } catch { /* listener crash is benign */ }
    }
  }

  private handleSessionGone(): void {
    if (this.exited) return;
    this.exited = true;
    this.stopObservation();
    this.cleanupLaunchDir();
    if (this.intentionalExit) return;
    for (const cb of this.exitCbs) {
      try { cb(null, null); } catch { /* listener crash is benign */ }
    }
  }

  private stopObservation(): void {
    this.historyGeneration += 1;
    if (this.historyTimer) {
      clearTimeout(this.historyTimer);
      this.historyTimer = null;
    }
    const tail = this.tailProcess;
    this.tailProcess = null;
    try { tail?.kill('SIGTERM'); } catch { /* already gone */ }
  }

  private cleanupLaunchDir(): void {
    if (this.launchDir) {
      try { rmSync(this.launchDir, { recursive: true, force: true }); } catch { /* benign */ }
      this.launchDir = null;
    }
  }
}
