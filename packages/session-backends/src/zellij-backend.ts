/**
 * ZellijBackend — session backend backed by a persistent zellij session.
 *
 * Ported core from botmux's adapters/backend/zellij-backend.ts (+ the
 * dump-screen / list-panes knowledge from zellij-observe-backend.ts).
 *
 * Architecture: **pty-under-zellij**. Unlike TmuxBackend (which never attaches
 * and replicates output with pipe-pane), the zellij client IS a node-pty:
 *   - `zellij --config <cfg> --session <n> --new-session-with-layout <layout>`
 *     starts a fresh session; `zellij --config <cfg> attach <n>` rejoins a
 *     surviving one. The node-pty is the session's only client.
 *   - Output flows through the pty, so onData/onExit come for free — this
 *     sidesteps zellij `subscribe`'s whole-viewport-snapshot model, which does
 *     not fit a byte-stream consumer.
 *   - Input is plain pty.write(). The generated config starts zellij in
 *     **locked mode with keybindings cleared**, so every byte written — Ctrl-C,
 *     arrows, bracketed-paste markers — reaches the focused CLI pane with zero
 *     keybinding interception.
 *   - resize() is pty.resize(): the attached client's size drives the pane, so
 *     the headless-default 25-column problem never bites.
 *   - The CLI is launched by the layout as `/usr/bin/env KEY=VAL… <bin> <args>`,
 *     so session env reaches the CLI only — never the zellij server's
 *     environment (the client itself runs on a scrubbed allowlist env).
 *
 * Deliberately NOT ported from botmux: the socket-probe pid attribution (see
 * findServerPid), the adopt/observe polling backend, sandbox/wrapper-shell
 * integration, liveness gating, destroy-result reporting.
 */
import * as pty from 'node-pty';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionBackend, SessionProbe, SpawnOptions } from './types.js';

/** Minimum zellij with the full CLI-automation surface (`action write`,
 *  `dump-screen --ansi`, `list-panes --json`, headless attach) — all landed
 *  in 0.44.0. Older zellij is not a viable backend. */
export const MIN_ZELLIJ_VERSION = { major: 0, minor: 44, patch: 0 };

/**
 * Environment for every `zellij` invocation (the pty client included).
 *
 * Two jobs, both load-bearing:
 *  1. ZELLIJ / ZELLIJ_SESSION_NAME are stripped. If the daemon itself was
 *     launched from inside a zellij session those are exported, and every
 *     `zellij` subcommand would then resolve against that PARENT session —
 *     `action` targets the wrong session, `attach` nests. Analogue of tmux's
 *     TMUX/TMUX_PANE scrubbing.
 *  2. It is an ALLOWLIST, so session-specific env (opts.env / injectEnv) can
 *     never ride into the zellij server through the client that boots it.
 *     Session env reaches the CLI through the layout's `/usr/bin/env` prefix.
 */
export function zellijClientEnv(): NodeJS.ProcessEnv {
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

/** Parse `zellij 0.44.1` → {major,minor,patch}. undefined if unparseable. */
export function parseZellijVersion(raw: string): { major: number; minor: number; patch: number } | undefined {
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** True iff `v` >= `min` (pure — unit testable). */
export function isZellijVersionSupported(
  v: { major: number; minor: number; patch: number },
  min = MIN_ZELLIJ_VERSION,
): boolean {
  if (v.major !== min.major) return v.major > min.major;
  if (v.minor !== min.minor) return v.minor > min.minor;
  return v.patch >= min.patch;
}

let zellijAvailableCache: boolean | undefined;

/** Probe whether a new-enough zellij is installed and runnable (cached). */
export function isZellijAvailable(): boolean {
  if (zellijAvailableCache !== undefined) return zellijAvailableCache;
  try {
    const r = spawnSync('zellij', ['--version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      env: zellijClientEnv(),
    });
    if (r.status !== 0) {
      zellijAvailableCache = false;
    } else {
      const v = parseZellijVersion((r.stdout ?? '').trim());
      zellijAvailableCache = v !== undefined && isZellijVersionSupported(v);
    }
  } catch {
    zellijAvailableCache = false;
  }
  return zellijAvailableCache;
}

/**
 * Parse `zellij list-sessions --no-formatting` into LIVE session names.
 *
 * A killed-but-serialised session lingers in the listing as
 * `name [Created ...] (EXITED - attach to resurrect)`. Those are NOT
 * reattachable, so they are filtered out — treating one as live would attach
 * to a corpse instead of spawning a real CLI. Pure/unit-testable.
 */
export function parseZellijSessions(out: string): string[] {
  return out
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !/EXITED/i.test(l))
    .map(l => l.split(/\s+/)[0]!)
    .filter(Boolean);
}

/** Escape a string for a KDL double-quoted value. */
export function kdlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Locked mode + cleared keybinds ⇒ the client pty forwards every byte to the
 * focused pane with no zellij interception (the moral equivalent of tmux's
 * single prefix key, but with nothing reserved at all). Startup tips and pane
 * frames are off so the captured stream is just the CLI.
 */
export const ZELLIJ_CONFIG_KDL = `// dockmux-generated — do not edit
show_startup_tips false
pane_frames false
default_mode "locked"
keybinds clear-defaults=true {
}
`;

/** Single-quote-escape a string for /bin/sh. */
function shellescape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the single-pane layout KDL.
 *
 * The pane runs `/bin/sh -c 'cd <cwd> && exec /usr/bin/env KEY=VAL… <bin> <args>'`
 * — the same per-process env prefix TmuxBackend types into its pane, and the
 * reason session env never touches the zellij server. `exec` means the CLI
 * replaces the shell, so it becomes a direct child of the zellij server (which
 * is what makes the pid lookup below work).
 *
 * cwd travels through `cd` rather than the pane's `cwd=` KDL attribute so the
 * layout depends on nothing beyond KDL string parsing. The argv is built with
 * execvp semantics (KDL strings carry spaces/quotes), so only the sh fragment
 * needs shell escaping — the KDL layer needs only KDL escaping.
 *
 * `close_on_exit=true` makes the pane — and, being the only pane, the session —
 * end when the CLI exits, which surfaces as the pty client's exit → onExit.
 */
export function buildZellijLayout(bin: string, args: string[], opts: SpawnOptions): string {
  const assignments = [
    ...Object.entries(opts.env),
    ...Object.entries(opts.injectEnv ?? {}),
  ].map(([k, v]) => `${k}=${v}`);
  const script = `cd ${shellescape(opts.cwd)} && exec `
    + ['/usr/bin/env', ...assignments, bin, ...args].map(shellescape).join(' ');
  return [
    'layout {',
    '    pane command="/bin/sh" close_on_exit=true {',
    `        args "-c" ${kdlString(script)}`,
    '    }',
    '}',
  ].join('\n');
}

/** A running `zellij --server <socketPath>` process. */
export interface ZellijServerProc {
  pid: number;
  /** The socket path from argv — the session name AT SPAWN TIME. */
  socketPath: string;
}

/** Parse `ps -eo pid=,args=` output into the zellij server processes. Pure. */
export function parseZellijServerProcs(psOut: string): ZellijServerProc[] {
  const servers: ZellijServerProc[] = [];
  for (const line of psOut.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const s = m[2]!.trim().match(/zellij\b.*--server\s+(\S+)$/);
    if (s) servers.push({ pid: Number(m[1]), socketPath: s[1]! });
  }
  return servers;
}

/** Parse `ps -eo pid=,ppid=,comm=` into the non-zellij children of `parent`. Pure. */
export function parseChildPids(psOut: string, parent: number): number[] {
  const children: number[] = [];
  for (const line of psOut.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    if (Number(m[2]) === parent && m[3]!.trim() !== 'zellij') children.push(Number(m[1]));
  }
  return children;
}

/**
 * Session-name → server-pid lookup by argv tail.
 *
 * CAVEAT (botmux ships a stronger version): `zellij action rename-session`
 * renames the session's SOCKET FILE while the server's argv keeps the
 * spawn-time path forever, and a freed name is reusable — so a name-keyed
 * lookup can in principle bind to a different session's server. botmux defends
 * against that with a socket-probe child that attributes an accept() to a
 * specific pid; that machinery is deliberately NOT ported here. dockmux owns
 * its session names and never renames them, so the argv-tail match (botmux's
 * own non-Linux path) is sufficient.
 */
export function findZellijServerPid(sessionName: string): number | null {
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,args='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      env: zellijClientEnv(),
    });
    const suffix = new RegExp(`/${sessionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
    return parseZellijServerProcs(out).find(s => suffix.test(s.socketPath))?.pid ?? null;
  } catch {
    return null; // ps unavailable
  }
}

/**
 * Best-effort CLI pid for the managed pane. The layout execs `/usr/bin/env`,
 * which execs the CLI in place, so the CLI is a direct child of the zellij
 * server and (single-pane session) the server's lone non-zellij child.
 */
export function findZellijPaneCliPid(sessionName: string): number | null {
  const server = findZellijServerPid(sessionName);
  if (server === null) return null;
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,ppid=,comm='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      env: zellijClientEnv(),
    });
    return parseChildPids(out, server)[0] ?? null;
  } catch {
    return null;
  }
}

/** zellij `dump-screen` separates rows with a bare `\n`. Fed to an xterm as-is,
 *  each line continues from the previous line's end column instead of returning
 *  to column 0 — the staircase/right-drift garble. */
export function normaliseCaptureLineEndings(s: string): string {
  return s.replace(/\r?\n/g, '\r\n');
}

export class ZellijBackend implements SessionBackend {
  readonly kind = 'zellij' as const;

  /** SessionBackend contract: the zellij session this backend owns. */
  readonly sessionName: string;
  private process: pty.IPty | null = null;
  private tmpConfigDir: string | null = null;
  private cols = 80;
  private rows = 24;
  private started = false;
  private reattaching = false;
  /** Set by detach()/kill() so the pty-client exit WE cause is not reported as
   *  a CLI exit. A real CLI exit (pane closes → single-pane session ends)
   *  leaves this false and is forwarded to onExit. */
  private intentionalExit = false;
  private resolvedCliPid: number | null = null;
  private readonly exitCbs: Array<(code: number | null, signal: string | null) => void> = [];

  constructor(sessionName: string) {
    this.sessionName = sessionName;
  }

  // ─── Static helpers ───────────────────────────────────────────────────────

  /**
   * Tri-state existence probe. `list-sessions` is the only surface zellij
   * offers, so a FAILED command (not installed, timeout, no server) proves
   * nothing about this session → 'unknown'. Only a successful listing can
   * answer 'exists' / 'missing'.
   */
  static probeSession(name: string): SessionProbe {
    const probe = ZellijBackend.probeLiveSessions();
    if (!probe.ok) return 'unknown';
    return probe.sessions.includes(name) ? 'exists' : 'missing';
  }

  /**
   * Distinguishes "command failed" ({ok:false}) from "succeeded, zero live
   * sessions" ({ok:true, sessions:[]}) — the basis of the tri-state probe.
   *
   * NB: `zellij list-sessions` exits **1** when there are no live sessions at
   * all, printing "No active zellij sessions found." to stderr. botmux runs
   * this through execFileSync, whose throw collapses that authoritative
   * "provably zero sessions" answer into 'unknown'. Here spawnSync is used
   * instead so the empty case stays authoritative: exit 1 with no session
   * lines is {ok:true, sessions:[]} → a clean 'missing'.
   */
  static probeLiveSessions(): { ok: true; sessions: string[] } | { ok: false } {
    let r: ReturnType<typeof spawnSync>;
    try {
      r = spawnSync('zellij', ['list-sessions', '--no-formatting'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 3000,
        env: zellijClientEnv(),
      });
    } catch {
      return { ok: false };
    }
    // Spawn failure (ENOENT/EACCES) or a signal/timeout kill — no answer.
    if (r.error || r.signal || r.status === null) return { ok: false };
    const sessions = parseZellijSessions(typeof r.stdout === 'string' ? r.stdout : '');
    if (r.status === 0) return { ok: true, sessions };
    // Non-zero: only the specific "no sessions" answer is authoritative.
    const stderrText = (typeof r.stderr === 'string' ? r.stderr : '').trim();
    if (sessions.length === 0 && /no active zellij sessions|no sessions/i.test(stderrText)) {
      return { ok: true, sessions: [] };
    }
    return { ok: false };
  }

  /** Kill AND purge a session — `delete-session -f` also removes the
   *  resurrectable corpse, so killed sessions don't accumulate in
   *  `list-sessions` as EXITED entries. */
  static killSession(name: string): void {
    try {
      spawnSync('zellij', ['delete-session', name, '-f'], {
        stdio: 'ignore',
        timeout: 4000,
        env: zellijClientEnv(),
      });
    } catch { /* doesn't exist */ }
  }

  // ─── SessionBackend implementation ────────────────────────────────────────

  spawn(bin: string, args: string[], opts: SpawnOptions): void {
    if (this.started) throw new Error('zellij spawn() called twice');
    this.started = true;
    this.cols = opts.cols;
    this.rows = opts.rows;

    // A live session means the daemon restarted while the CLI survived —
    // rejoin it instead of starting a second CLI.
    this.reattaching = ZellijBackend.probeSession(this.sessionName) === 'exists';

    this.tmpConfigDir = mkdtempSync(join(tmpdir(), 'dockmux-zellij-'));
    const configPath = join(this.tmpConfigDir, 'config.kdl');
    writeFileSync(configPath, ZELLIJ_CONFIG_KDL, { mode: 0o600 });

    // Fresh: `--new-session-with-layout <file>` FORCES a new named session with
    // our layout — plain `--session … --layout-string` instead ATTACHES to the
    // name and errors "no active session".
    let zellijArgs: string[];
    if (this.reattaching) {
      zellijArgs = ['--config', configPath, 'attach', this.sessionName];
    } else {
      const layoutPath = join(this.tmpConfigDir, 'layout.kdl');
      writeFileSync(layoutPath, buildZellijLayout(bin, args, opts), { mode: 0o600 });
      zellijArgs = [
        '--config', configPath,
        '--session', this.sessionName,
        '--new-session-with-layout', layoutPath,
      ];
    }

    try {
      this.process = pty.spawn('zellij', zellijArgs, {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        // Scrubbed allowlist: session env travels in the layout, not here.
        env: zellijClientEnv() as Record<string, string>,
      });
    } catch (err) {
      this.cleanupConfig();
      throw err;
    }

    // Wire the buffered exit callbacks onto the fresh pty.
    this.process.onExit(({ exitCode, signal }) => {
      if (this.intentionalExit) return;
      for (const cb of this.exitCbs) {
        try { cb(exitCode, signal !== undefined ? String(signal) : null); } catch { /* benign */ }
      }
    });
  }

  /** True when spawn() rejoined a surviving session instead of creating one. */
  get isReattach(): boolean {
    return this.reattaching;
  }

  /**
   * In locked mode with cleared keybinds, raw bytes written to the client pty
   * are forwarded verbatim to the focused pane — so every input path collapses
   * to pty.write(), including control bytes and bracketed-paste markers.
   */
  write(data: string): boolean {
    if (!this.process) return false;
    this.process.write(data);
    return true;
  }

  interrupt(): void {
    this.process?.write('\x03');
  }

  /** The pty client's size IS the pane size — no zellij resize command needed. */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.process?.resize(cols, rows);
  }

  /** Must be called AFTER spawn() — node-pty wiring, like PtyBackend. */
  onData(cb: (data: string) => void): void {
    this.process?.onData(cb);
  }

  /** Safe before or after spawn(): callbacks are buffered and wired at spawn. */
  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.exitCbs.push(cb);
  }

  /** `dump-screen --ansi` against the focused (single) pane. */
  captureCurrentScreen(): string | null {
    if (!this.started || this.intentionalExit) return null;
    try {
      const out = execFileSync(
        'zellij',
        ['--session', this.sessionName, 'action', 'dump-screen', '--ansi'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000, env: zellijClientEnv() },
      );
      return normaliseCaptureLineEndings(out);
    } catch {
      return null;
    }
  }

  /** The attached client drives the pane, so the tracked client size is
   *  authoritative — no round-trip to `list-panes --json` needed. */
  getPaneSize(): { cols: number; rows: number } | null {
    if (!this.started || this.intentionalExit) return null;
    return { cols: this.cols, rows: this.rows };
  }

  /** CLI pid. May be null right after spawn() (the CLI starts asynchronously);
   *  cached once resolved — a single-pane session cannot swap its CLI. */
  getPid(): number | null {
    if (this.resolvedCliPid !== null) return this.resolvedCliPid;
    if (!this.started || this.intentionalExit) return null;
    this.resolvedCliPid = findZellijPaneCliPid(this.sessionName);
    return this.resolvedCliPid;
  }

  /**
   * Detach WITHOUT destroying the session: kill the pty client only. The zellij
   * server keeps the CLI running, so a later ZellijBackend.spawn() with the
   * same name reattaches (`zellij attach`) instead of starting a second CLI.
   * This is the basis of surviving a daemon restart.
   */
  detach(): void {
    if (this.intentionalExit) return;
    this.intentionalExit = true;
    this.killClient();
    this.cleanupConfig();
  }

  /** Destroy the session permanently: detach the client, then delete-session -f. */
  kill(): void {
    const alreadyDetached = this.intentionalExit;
    this.intentionalExit = true;
    this.killClient();
    this.cleanupConfig();
    // Kill the session even when the client was already detached — kill() is
    // the explicit "this session is over" signal.
    if (this.started || alreadyDetached) ZellijBackend.killSession(this.sessionName);
  }

  private killClient(): void {
    if (this.process) {
      try { this.process.kill(); } catch { /* already dead */ }
      this.process = null;
    }
  }

  private cleanupConfig(): void {
    if (this.tmpConfigDir) {
      try { rmSync(this.tmpConfigDir, { recursive: true, force: true }); } catch { /* benign */ }
      this.tmpConfigDir = null;
    }
  }
}
