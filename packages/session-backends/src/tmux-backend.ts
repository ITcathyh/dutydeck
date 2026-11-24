import { processIdentityKey, captureOwnedTmuxIdentity, captureOwnedTmuxAbsence, stopOwnedTmux, verifyOwnedTmuxAbsence, verifyOwnedTmuxExit, type OwnedTmuxIdentity, type OwnedTmuxExitProof, type OwnedTmuxAbsence, type ProcessProbe } from './owned-tmux.js';
import { isDeepStrictEqual } from 'node:util';
import { programStatusCommand } from './program-status-launch.js';
import { RuntimeError, warnCaught, type DiagnosticLog } from '@dutydeck/shared';
/**
 * TmuxBackend — session backend backed by a detached tmux session.
 *
 * Architecture (no PTY, no attach). Third-party attribution: see THIRD_PARTY_NOTICES.md.
 *   - `tmux new-session -d -s <name> -x <cols> -y <rows> -c <cwd>` starts a
 *     bare shell in a detached session through an asynchronous, env-scrubbed client.
 *   - Session-specific env is exported by the private launch script that
 *     `respawn-pane` runs, so values (API keys included) never appear in a
 *     tmux client's argv, the shared server-global environment, or an
 *     interactive shell's visible history. Only names a POSIX shell cannot
 *     export are staged with `set-environment -t <session>` and removed again
 *     right after the respawn.
 *   - `tmux pipe-pane` sends output through a bounded Unix socket writer.
 *     Overflow reports a gap and the driver atomically restores the screen.
 *   - Writes go through `tmux send-keys -l` (long/multiline text via
 *     load-buffer + paste-buffer, which is also robust to the 4KB tty
 *     canonical-input limit).
 *   - An exit watcher polls pane liveness: an authoritative "session gone"
 *     answer (or a dead pane pid) fires onExit; server-level failures
 *     (connect refused, lost server, timeout) prove nothing and never tear
 *     the session down.
 *
 * Deliberately omitted: adopt/observe mode, ambiguous
 * submission journal, sandbox integration, onAccessUrl/onTaskDone/onTurnFinal
 * hooks, destroySession fencing, captureInputState/capturePaneInputModes,
 * screen-settling heuristics.
 */
import { runCommand } from './command.js';
import { OutputHandoff } from './output-handoff.js';
import { TmuxCapture, cleanAbandonedTmuxCapture } from './tmux-capture.js';
import { statStart } from './proc-stat.js';
import { unixSocketState } from './unix-socket.js';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'string-width';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PersistentSessionBackend, TerminalMetadataKey, SessionProbe, SpawnOptions } from './types.js';

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

/**
 * The tmux session exists, but it was not created for the Dutydeck session the
 * caller is trying to restore.  Treating an arbitrary same-named pane as ours
 * would attach user input to the wrong process, so ownership mismatch is a
 * hard failure and never triggers kill/respawn.
 */
export class TmuxOwnershipError extends TmuxError {
  constructor(message: string, stderr?: string) {
    super(message, stderr);
    this.name = 'TmuxOwnershipError';
  }
}

// ─── Classification helpers ────────────────────────────────────────────────

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

/** A clean tmux client answer that its selected socket path does not exist.
 * Unlike ECONNREFUSED/lost-server, ENOENT proves there is no server (and
 * therefore no target session) in this namespace at the time of the probe.
 * This is the normal first-use result for a fresh TMUX_TMPDIR. */
function isSocketMissingErrorText(stderrText: string): boolean {
  return /error connecting to .*\(No such file or directory\)/i.test(stderrText);
}

/**
 * The socket file is gone, yet the kernel still has a socket bound to that
 * path: the original server (and its panes) usually survives /tmp cleanup.
 * Starting a client command that creates a server there would put a second
 * CLI on the same conversation, so callers treat this as "state unknown".
 * Returns the orphaned path only on a definite `bound` answer; non-Linux or an
 * unreadable kernel table keeps the historical "no server" reading.
 */
function orphanedSocketPath(stderrText: string): string | undefined {
  const path = /error connecting to (.+) \(No such file or directory\)/i.exec(stderrText)?.[1];
  // 先查绑定再查文件：has-session 没连上之后，并发启动可能刚建好 server，这时文件也已存在，不算残留。
  return path !== undefined && unixSocketState(path) === 'bound' && !existsSync(path) ? path : undefined;
}

/** User-facing explanation for a launch refused because of an orphaned tmux socket. */
export function orphanedTmuxSocketMessage(path: string): string {
  return `tmux socket ${path} 已被删除，但原 tmux server 仍在运行；为避免同一会话起两个 CLI，已拒绝启动。`
    + '处理办法：按 tmux 手册向原 tmux server 进程发送 SIGUSR1 让它重建 socket，或结束原 tmux server 后重新发送消息。';
}

function processStart(pid: number): string | undefined {
  try { return statStart(readFileSync(`/proc/${pid}/stat`, 'utf8')); }
  catch { return undefined; }
}
function paneProcessAlive(pane: { pid: number; start?: string }): boolean {
  try { process.kill(pane.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; }
  return pane.start === undefined || processStart(pane.pid) === pane.start;
}

/** True when a thrown exec*Sync error is the caller's own timeout deadline
 *  firing — regardless of the exit-status shape Node attached (a timed-out
 *  client can complete and exit cleanly in the same window the kill fires). */
function isTimeoutError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null | undefined)?.code === 'ETIMEDOUT';
}

/** Names /bin/sh can `export`; the rest still go through tmux set-environment. */
const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** tmux parses an argument ending in `;` as a command separator and drops
 *  that `;`; a trailing `\;` is kept as a literal semicolon. */
const tmuxLiteralArg = (value: string): string => value.endsWith(';') ? `${value.slice(0, -1)}\\;` : value;

/** tmux format-expands new-session `-s`, `-c` and the pipe-pane command, so
 *  `#(...)` would run and `#S` would be replaced; `##` is a literal `#`.
 *  pipe-pane also applies strftime, where `%%` is a literal `%`. */
const tmuxFormatLiteral = (value: string): string => value.replaceAll('#', '##');
const tmuxTimeFormatLiteral = (value: string): string => tmuxFormatLiteral(value).replaceAll('%', '%%');

/** Single-quote-escape a string for /bin/sh (replaces ' with '\'' ). */
function shellescape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Keep the command passed to tmux short.  Even though tmux accepts argv, the
 * command is transported through its control socket and large prompts,
 * hooks, or provider arguments can exceed that message budget.  A private
 * executable script lets the pane open the complete argv without putting it
 * in the tmux command itself.  The script removes itself before exec so the
 * launch directory never accumulates credentials or stale arguments.
 *
 * The child environment is exported here too, so its values never travel in
 * a tmux client's argv where other local users could read them from
 * /proc/<pid>/cmdline. respawn-pane hands the pane the management client's
 * PATH, so the child's own PATH, including an empty one, is exported after
 * the cleanup commands and before exec. As with PtyBackend, a bare `bin` is
 * then resolved through that PATH.
 */
async function writeLaunchScript(bin: string, args: string[], environment: Record<string, string>, programStatus?: boolean): Promise<{ path: string; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-tmux-launch-'));
  const path = join(directory, 'launch.sh');
  const exports = Object.entries(environment).map(([key, value]) => `${key}=${shellescape(value)}; export ${key}\n`).join('');
  const command = ['exec', ...programStatusCommand(bin, args, programStatus)].map(shellescape).join(' ');
  await writeFile(path, `#!/bin/sh\nrm -f -- "$0"\nrmdir -- "$(dirname -- "$0")" 2>/dev/null || true\n${exports}${command}\n`, { mode: 0o700 });
  await chmod(path, 0o700);
  return { path, directory };
}

/**
 * Environment for every `tmux` client invocation. Deliberately minimal:
 * the tmux SERVER seeds its global environment (and thus every future pane's
 * inherited env) from the first client that boots it, so anything
 * session-specific (opts.env / injectEnv) must never travel here.
 * TMUX/TMUX_PANE are stripped so a daemon started inside a tmux session
 * doesn't target that parent server's socket. TMUX_TMPDIR is different: it
 * selects the tmux socket root itself, so every client must preserve it or a
 * backend launched in an isolated namespace will silently create/query the
 * default server instead.
 */
function tmuxClientEnv(): NodeJS.ProcessEnv {
  const allow = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG',
    'LC_ALL', 'LC_CTYPE', 'TERM', 'XDG_RUNTIME_DIR', 'TZ', 'TMUX_TMPDIR',
  ];
  const out: NodeJS.ProcessEnv = {};
  for (const key of allow) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** Map a failed management command to the right typed error. */
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
async function runTmux(args: string[], opts: { input?: string; timeout?: number; cwd?: string } = {}): Promise<string> {
  try { return await runCommand('tmux', ['-u', ...args], { ...opts, env: tmuxClientEnv(), maxBuffer: 16 * 1024 * 1024 }); }
  catch (err) { throw classifyFailure(err, `tmux ${args[0] ?? 'client'}`); }
}

// ─── Shared pane liveness poller ───────────────────────────────────────────

export type PaneObservation = { probe: SessionProbe; pid: number | null; socketMissing?: boolean };
type PaneWatch = { close(): void };
const PANE_FORMAT = '#{session_name}\t#{window_active}#{pane_active}\t#{pane_pid}';

/**
 * Classify one `list-panes -a` answer for an exact session name. A clean
 * listing without the name is authoritative 'missing'; the pid comes from the
 * session's active pane in its active window (what `display-message -t
 * <session> '#{pane_pid}'` reports). A failed client is 'missing' only when it
 * cleanly proved no server owns the socket; any other failure is 'unknown'.
 */
export function classifyPaneListing(result: { stdout: string } | { error: unknown }, sessionName: string): PaneObservation {
  return 'error' in result ? classifyPaneFailure(result.error) : paneObservation(paneSessions(result.stdout), sessionName);
}

function classifyPaneFailure(error: unknown): PaneObservation {
  const failure = error as { signal?: string; status?: number; stderr?: string } | null | undefined;
  const stderr = failure?.stderr ?? '';
  const clean = !failure?.signal && typeof failure?.status === 'number';
  // A missing socket file is flagged: the exit watcher cross-checks it against the last known pane process.
  const socketMissing = clean && isSocketMissingErrorText(stderr);
  const missing = socketMissing || clean && /no server running/i.test(stderr);
  return { probe: missing ? 'missing' : 'unknown', pid: null, ...(socketMissing ? { socketMissing } : {}) };
}

/** Every listed session name with the pid of its first valid active pane in its active window (null when none). */
function paneSessions(stdout: string): Map<string, number | null> {
  const sessions = new Map<string, number | null>();
  for (const line of stdout.split('\n')) {
    // Split on the last two tabs: a foreign session name may contain tabs.
    const pidTab = line.lastIndexOf('\t');
    const activeTab = pidTab > 0 ? line.lastIndexOf('\t', pidTab - 1) : -1;
    if (activeTab < 0) continue;
    const name = line.slice(0, activeTab);
    let pid = sessions.get(name) ?? null;
    if (pid === null && line.slice(activeTab + 1, pidTab) === '11') {
      const value = Number(line.slice(pidTab + 1).trim());
      if (Number.isSafeInteger(value) && value > 0) pid = value;
    }
    sessions.set(name, pid);
  }
  return sessions;
}

const paneObservation = (sessions: Map<string, number | null>, sessionName: string): PaneObservation =>
  sessions.has(sessionName) ? { probe: 'exists', pid: sessions.get(sessionName)! } : { probe: 'missing', pid: null };

type PanePoller = {
  env: NodeJS.ProcessEnv;
  subscribers: Map<PaneWatch, { sessionName: string; deliver: (observation: PaneObservation) => void }>;
  timer: NodeJS.Timeout;
  inFlight: boolean;
};
const panePollers = new Map<string, PanePoller>();

/** One `list-panes -a` client per second per tmux client environment, shared
 *  by every exit watcher; at most one request is in flight per poller. Only
 *  watchers subscribed when a request started receive its answer. */
function subscribePanes(sessionName: string, deliver: (observation: PaneObservation) => void): PaneWatch {
  const env = tmuxClientEnv();
  const key = JSON.stringify(env);
  let poller = panePollers.get(key);
  if (!poller) {
    const created: PanePoller = { env, subscribers: new Map(), inFlight: false, timer: setInterval(() => pollPanes(created), 1000) };
    poller = created;
    panePollers.set(key, poller);
  }
  const owner = poller;
  const watch: PaneWatch = {
    close: () => {
      if (!owner.subscribers.delete(watch) || owner.subscribers.size > 0) return;
      clearInterval(owner.timer);
      if (panePollers.get(key) === owner) panePollers.delete(key);
    },
  };
  owner.subscribers.set(watch, { sessionName, deliver });
  return watch;
}

function pollPanes(poller: PanePoller): void {
  if (poller.inFlight || poller.subscribers.size === 0) return;
  poller.inFlight = true;
  const targets = [...poller.subscribers];
  void runCommand('tmux', ['-u', 'list-panes', '-a', '-F', PANE_FORMAT], { env: poller.env, timeout: 3000 })
    .then(stdout => paneSessions(stdout), (error: unknown) => classifyPaneFailure(error))
    .then(result => {
      for (const [watch, { sessionName, deliver }] of targets) {
        if (!poller.subscribers.has(watch)) continue;
        try { deliver(result instanceof Map ? paneObservation(result, sessionName) : result); } catch { /* One watcher cannot stall the others. */ }
      }
    })
    .finally(() => { poller.inFlight = false; });
}

let tmuxAvailableCache: boolean | undefined;

/** Probe whether tmux is installed and runnable (cached). */
export async function isTmuxAvailable(): Promise<boolean> {
  if (tmuxAvailableCache !== undefined) return tmuxAvailableCache;
  try { await runTmux(['-V'], { timeout: 2000 }); return tmuxAvailableCache = true; }
  catch { return tmuxAvailableCache = false; }
}

// ─── Backend ───────────────────────────────────────────────────────────────

/** send-keys -l payloads longer than this risk hitting the tty canonical
 *  input limit (MAX_CANON, 4096 bytes on Linux) — route through paste-buffer. */
const LITERAL_SEND_LIMIT = 4096;
const BRACKETED_PASTE_START = '\x1b[200~';
const OWNER_OPTION = '@dutydeck_owner_id';
const METADATA_OPTIONS = {
  first_prompt_sent: '@dutydeck_first_prompt_sent',
  turn_id: '@dutydeck_turn_id',
} as const;

export type TmuxDutydeckMetadataKey = keyof typeof METADATA_OPTIONS;

export interface TmuxBackendOptions {
  /**
   * Stable Dutydeck-owned identity expected on spawn/attach.  When present,
   * attach refuses sessions without the exact marker.  This is what prevents
   * the production driver from adopting external or unrelated user tmux panes.
   */
  ownerId?: string;
  log?: DiagnosticLog;
  /** Trusted server socket for retirement after a daemon restart. */
  retirementSocketPath?: string;
}

function dutydeckSessionId(ownerId: string | undefined, sessionName: string): string {
  return ownerId?.startsWith('dutydeck:') ? ownerId.slice('dutydeck:'.length) : sessionName;
}

/**
 * Clean a submission capture without confusing terminal padding with input.
 * -J preserves trailing spaces. Non-cursor rows therefore lose right padding;
 * the cursor row keeps the spaces before the cursor. Native coordinates
 * are in terminal cells and refer to unjoined physical rows (-N).
 */
export function cleanTmuxSubmissionCapture(partialAnsi: string, fullCapture: string, requireCursor = true, nativeCursor?: { column: number; physicalRow: string }): string | null {
  const rows = (capture: string) => (capture.endsWith('\n') ? capture.slice(0, -1) : capture).split('\n');
  const partialRows = rows(partialAnsi);
  const fullRows = rows(fullCapture);
  const cursorRow = partialRows.length - 1;
  if (cursorRow < 0 || cursorRow >= fullRows.length) return null;
  const ansiRow = partialRows[cursorRow]!;
  const capturedRow = fullRows[cursorRow]!;
  const cursor = /\x1b\[([0-9;]*)m (?:\x1b\[([0-9;]*)m|$)/.exec(ansiRow);
  const sgrIncludes = (parameters: string | undefined, code: number) => parameters?.split(';').includes(String(code)) ?? false;
  let beforeCursor: string;
  if (cursor && sgrIncludes(cursor[1], 7) && (cursor[2] === undefined || sgrIncludes(cursor[2], 0) || sgrIncludes(cursor[2], 27))) {
    beforeCursor = stripVTControlCharacters(ansiRow.slice(0, cursor.index));
    const afterCursor = stripVTControlCharacters(ansiRow.slice(cursor.index + cursor[0].length));
    if (!/^ *$/.test(afterCursor) || !capturedRow.startsWith(beforeCursor) || !/^ +$/.test(capturedRow.slice(beforeCursor.length))) return null;
  } else if (nativeCursor) {
    const { column, physicalRow } = nativeCursor;
    if (stripVTControlCharacters(ansiRow) !== capturedRow || !capturedRow.endsWith(physicalRow)
      || !/^─{8,} *$/.test(fullRows[cursorRow + 1] ?? '')) return null;
    const text = physicalRow.replace(/ +$/, '');
    const spaces = column - stringWidth(text);
    // A fresh Claude continuation has two columns of indent but no painted cells.
    const blankContinuation = physicalRow === '' && column === 2;
    // tmux can omit unpainted trailing spaces even with -N. The visible
    // cursor still measures them; keep the reconstructed text inside the box.
    const paintedPadding = physicalRow.length - text.length;
    const maxSpaces = paintedPadding || fullRows[cursorRow + 1]!.trimEnd().length - stringWidth(text);
    if (!blankContinuation && (spaces < 0 || spaces > maxSpaces)) return null;
    const prefix = capturedRow.slice(0, capturedRow.length - physicalRow.length);
    beforeCursor = prefix + (blankContinuation ? '' : text + ' '.repeat(spaces));
  } else {
    return requireCursor ? null : fullCapture;
  }
  for (let index = 0; index < fullRows.length; index++) {
    fullRows[index] = index === cursorRow ? beforeCursor : fullRows[index]!.replace(/ +$/, '');
  }
  return fullRows.join('\n') + (fullCapture.endsWith('\n') ? '\n' : '');
}

export class TmuxBackend implements PersistentSessionBackend {
  get persistent(): PersistentSessionBackend { return this; }
  getMetadata(key: TerminalMetadataKey) { return this.getDutydeckMetadata(key); }
  setMetadata(key: TerminalMetadataKey, value: string) { return this.setDutydeckMetadata(key, value); }
  reattach(size: { cols: number; rows: number }) { return this.attach(size); }
  async canAttach(purpose: 'start' | 'resume' | 'view', check?: () => void) {
    if (!this.sessionName) return false;
    if (purpose === 'start') {
      await TmuxBackend.reapDeadOwnedSession(this.sessionName, this.ownerId, this.options.log);
      check?.();
    }
    const state = await TmuxBackend.probeSession(this.sessionName);
    if (state !== 'unknown' || purpose === 'view') return state === 'exists';
    const reason = `Cannot determine whether persistent tmux session ${this.sessionName} is alive; refusing to `;
    if (purpose === 'resume') throw new Error(reason + 'replace it');
    const orphan = await TmuxBackend.orphanedServerSocket(this.sessionName).catch(() => undefined);
    throw new Error(reason + 'spawn a duplicate CLI' + (orphan === undefined ? '' : `. ${orphanedTmuxSocketMessage(orphan)}`));
  }
  async recoveryOwnerError() {
    if (!this.sessionName || await TmuxBackend.probeSession(this.sessionName) !== 'exists') return 'Original tmux session is not alive';
    if (await TmuxBackend.sessionOwner(this.sessionName) !== this.ownerId) return 'Original tmux session owner does not match';
    return undefined;
  }
  attachmentTarget(log?: DiagnosticLog) { return this.replacement(this.sessionName, log); }
  replacement(sessionId: string, log?: DiagnosticLog) { return new TmuxBackend(this.sessionName || sessionId, { ownerId: this.ownerId, log }); }
  async exitedAfterDisconnect() { return await TmuxBackend.probeSession(this.sessionName) === 'missing'; }
  private liveIdentity?: OwnedTmuxIdentity;
  private exitProof?: OwnedTmuxExitProof;
  private absence?: OwnedTmuxAbsence;

  async rememberIdentity(probe?: ProcessProbe) {
    this.liveIdentity = undefined;
    this.absence = undefined;
    this.exitProof = undefined;
    this.liveIdentity = await this.captureIdentity(probe);
  }

  async stopAttached(probe?: ProcessProbe) {
    if (!probe) { try { await this.kill(); } catch { /* exit remains unverified */ } return; }
    try {
      this.disposeCapture();
      if (!this.liveIdentity && !this.absence) {
        let captureError: unknown;
        try { this.liveIdentity = await this.captureIdentity(probe); } catch (error) { captureError = error; }
        if (!this.liveIdentity) {
          this.absence = await this.captureAbsence(probe).catch(error => { this.warnCaught('stop.captureTmuxAbsence', error); return undefined; });
          if (!this.absence && captureError !== undefined) throw captureError;
        }
      }
      if (this.liveIdentity) {
        // Retrying a stop must retain descendants observed by every earlier attempt.
        const identity = this.exitProof
          ? { ...this.liveIdentity, identities: mergeIdentities(this.liveIdentity.identities, this.exitProof.identities) }
          : this.liveIdentity;
        this.exitProof = await this.stopOwned(identity, probe);
      }
    } catch (error) {
      const pending = error as { code?: string; proof?: OwnedTmuxExitProof };
      if (pending.code === 'LEGACY_TMUX_EXIT_UNPROVEN' && pending.proof) {
        this.exitProof = pending.proof;
        return;
      }
      const code = pending.code ?? (error instanceof Error ? error.message : String(error));
      throw Object.assign(new Error(`Tmux stop failed (${code}); the terminal may still be running`), { code: 'PTY_TMUX_STOP_FAILED', cause: error });
    }
  }
  async attachedExitVerified(probe: ProcessProbe | undefined, pid: number | undefined, preserve: boolean) {
    if (!probe || (preserve && !this.exitProof)) return false;
    if (!this.liveIdentity && this.absence) return (await this.verifyExit(this.absence, probe)) && !processRunning(pid) && this.captureDisposed();
    return !!this.exitProof && (await this.verifyExit(this.exitProof, probe)) && this.captureDisposed();
  }
  idleProcessesVerified(identity: string, probe: ProcessProbe) {
    return !!this.liveIdentity && this.liveIdentity.identities.every(item => processIdentityKey(item) === identity || probe.observe(item) === 'dead');
  }
  async adoptionIdentity(allowIdle: boolean, probe?: ProcessProbe, pid?: number) {
    if (!allowIdle || !this.liveIdentity || !probe || !pid) return undefined;
    const process = probe.identify(pid);
    if (probe.observe(process) !== 'alive') return undefined;
    return { kind: 'tmux', reason: 'unconfirmed_claude_source', tmux: this.liveIdentity, process };
  }
  async verifyAdoption(snapshot: unknown, idle: () => boolean, probe?: ProcessProbe, pid?: number) {
    const expected = snapshot as { kind?: string; tmux?: OwnedTmuxIdentity; process?: ReturnType<ProcessProbe['identify']> };
    const current = this.liveIdentity, process = pid && probe?.identify(pid);
    if (expected.kind !== 'tmux' || !expected.tmux || !expected.process || !current || !process
      || !isDeepStrictEqual(expected.tmux.scope, current.scope) || !isDeepStrictEqual(expected.tmux.socket, current.socket)
      || expected.tmux.targetId !== current.targetId || !isDeepStrictEqual(expected.tmux.server, current.server)
      || !isDeepStrictEqual(expected.process, process) || probe?.observe(expected.process) !== 'alive' || !idle()) {
      throw new Error('Persistent tmux identity changed or no longer idle');
    }
  }

  private ownedScope() {
    const socketPath = this.getSocketPath() ?? this.options.retirementSocketPath;
    if (!this.ownerId || !socketPath) return undefined;
    return { socketPath, sessionName: this.sessionName, ownerId: this.ownerId, hostname: hostname(), uid: process.getuid!() };
  }
  async captureIdentity(probe?: ProcessProbe) {
    const scope = this.ownedScope();
    return scope && probe && captureOwnedTmuxIdentity(scope, probe);
  }
  async captureAbsence(probe?: ProcessProbe) {
    const scope = this.ownedScope();
    return scope && probe && captureOwnedTmuxAbsence(scope, probe);
  }
  private checkedSnapshot(raw: unknown) {
    const snapshot = raw as OwnedTmuxIdentity | OwnedTmuxAbsence;
    if (!snapshot?.scope || !isDeepStrictEqual(snapshot.scope, this.ownedScope())) {
      throw new RuntimeError('PTY_RETIREMENT_SCOPE_CONFLICT', 'Stored snapshot does not match this session on this host', 409);
    }
    return snapshot;
  }
  async stopOwned(raw: unknown, probe: ProcessProbe, beforeKill?: (snapshot: unknown) => Promise<void>) {
    if ((raw as OwnedTmuxAbsence)?.absent) throw new RuntimeError('PTY_EXIT_UNVERIFIED', 'An absence proof cannot stop a terminal', 409);
    return stopOwnedTmux(this.checkedSnapshot(raw) as OwnedTmuxIdentity, probe, beforeKill);
  }
  async verifyExit(raw: unknown, probe: ProcessProbe) {
    const snapshot = this.checkedSnapshot(raw);
    if ('absent' in snapshot) return verifyOwnedTmuxAbsence(snapshot, probe);
    return verifyOwnedTmuxExit({ ...snapshot, stoppedAt: (snapshot as OwnedTmuxExitProof).stoppedAt ?? new Date().toISOString() }, probe);
  }
  readonly kind = 'tmux' as const;

  /** SessionBackend contract: the tmux session this backend owns. */
  readonly sessionName: string;
  readonly ownerId?: string;
  private started = false;
  private lifecycle = 0;
  private inputGeneration = 0;
  private creation?: Promise<void>;
  private exited = false;
  private capture: TmuxCapture | undefined;
  private socketPath: string | undefined;
  private readonly output = new OutputHandoff();
  private readonly exitCbs: Array<(code: number | null, signal: string | null) => void> = [];
  private exitTimer: PaneWatch | null = null;
  initialScreen?: { data: string; cols: number; rows: number };

  constructor(sessionName: string, private readonly options: TmuxBackendOptions = {}) {
    this.sessionName = sessionName;
    this.ownerId = options.ownerId;
  }

  private warnCaught(location: string, error: unknown) {
    warnCaught(this.options.log, 'TmuxBackend', location, dutydeckSessionId(this.ownerId, this.sessionName), error);
  }

  // ─── SessionBackend implementation ──────────────────────────────────────

  spawn(bin: string, args: string[], opts: SpawnOptions): Promise<void> {
    const creation = this.launch(bin, args, opts, this.lifecycle);
    this.creation = creation;
    return creation.finally(() => { if (this.creation === creation) this.creation = undefined; });
  }

  async cancelPending(): Promise<void> {
    this.lifecycle++;
    this.inputGeneration++;
    // best-effort: wait for creation to settle; its caller receives any launch error.
    await this.creation?.catch(() => {});
  }

  private async launch(bin: string, args: string[], opts: SpawnOptions, generation: number): Promise<void> {
    const check = () => { if (generation !== this.lifecycle) throw new TmuxError('tmux launch cancelled'); };
    if (this.started) throw new TmuxError('tmux spawn() called twice');
    // Validate cwd before starting the management client.
    let validCwd = false;
    try { validCwd = statSync(opts.cwd).isDirectory(); } catch { /* Missing or inaccessible directory. */ }
    if (!validCwd) {
      throw new TmuxError(`工作目录不可用：${opts.cwd}。请在机器人或任务设置中选择已存在且可访问的目录。`);
    }
    this.started = true;

    // 0. Never create a server next to one whose socket file was deleted, and
    //    clear a dead session this owner left behind (remain-on-exit) so the
    //    name is free again.
    const existing = await TmuxBackend.hasSession(this.sessionName);
    if (existing.orphanedSocket !== undefined) throw new TmuxServerError(orphanedTmuxSocketMessage(existing.orphanedSocket));
    if (existing.probe === 'exists') await TmuxBackend.reapDeadOwnedSession(this.sessionName, this.ownerId, this.options.log);
    check();

    // 1. Detached session running a bare shell. The CLI is launched by
    //    send-keys (step 4) so session-specific env never touches the tmux
    //    server's global environment.
    try {
      (await runTmux([
        'new-session', '-d',
        '-s', tmuxFormatLiteral(this.sessionName),
        '-x', String(opts.cols),
        '-y', String(opts.rows),
        '-c', tmuxLiteralArg(tmuxFormatLiteral(opts.cwd)),
      ], { cwd: opts.cwd }));
    } catch (err) {
      if (err instanceof TmuxError) throw err;
      throw classifyFailure(err, 'tmux new-session');
    }

    try {
      this.socketPath = (await runTmux(['display-message', '-p', '-t', `=${this.sessionName}`, '#{socket_path}'])).trim();
      await this.writeOwnershipMarker();
      check();
      // 2. Scope the child environment to this session only. injectEnv is
      // applied last so it wins on collisions, matching PtyBackend. Names the
      // launch script cannot export are staged on the session.
      const childEnvironment = { ...opts.env, ...opts.injectEnv };
      const scripted = Object.fromEntries(Object.entries(childEnvironment).filter(([key]) => SHELL_NAME.test(key)));
      const staged = Object.fromEntries(Object.entries(childEnvironment).filter(([key]) => !SHELL_NAME.test(key)));
      await this.scrubStaleGlobalEnvironment(childEnvironment);
      check();
      await this.stageSessionEnvironment(staged);
      check();

      // 3. Stream output through a bounded private socket capture.
      await this.startCapture();
      check();

      // 4. Replace the bootstrap shell through a private script instead of
      // sending the complete argv and environment in the tmux control
      // message. tmux forks the pane with a snapshot of the session
      // environment before respawn-pane returns; clear any staged values
      // immediately afterwards. The script unlinks itself before exec.
      const launch = await writeLaunchScript(bin, args, scripted, opts.programStatus);
      try {
        (await runTmux(['respawn-pane', '-k', '-t', this.sessionName, '-c', tmuxLiteralArg(tmuxFormatLiteral(opts.cwd)), '/bin/sh', launch.path]));
      } catch (error) {
        await rm(launch.directory, { recursive: true, force: true });
        throw error;
      }
      await this.clearSessionEnvironment(Object.keys(staged));
      check();

      this.startExitWatcher();
    } catch (err) {
      this.exited = true; // spawn failed — the instance is inert
      this.cleanup();
      try { (await runTmux(['kill-session', '-t', this.sessionName], { timeout: 3000 })); } catch (error) { this.warnCaught('launch.killFailedSession', error); }
      throw err;
    }
  }

  /**
   * Write literal text to the pane. Never throws: a tmux failure returns
   * false (the driver treats that as "not sent"). An authoritative
   * session-missing answer is converted to onExit (guarded send) — the CLI exited and the pane is gone.
   */
  async write(data: string): Promise<boolean> {
    return this.sendInput(generation => this.sendLiteral(data, generation));
  }

  /** Paste through tmux: bracketed-paste markers only when the application
   *  requested bracketed paste, so callers must not add their own. Same
   *  refusal semantics as write(). */
  async pasteText(text: string): Promise<boolean> {
    return this.sendInput(generation => this.pasteLiteral(text, generation, true));
  }

  private async sendInput(send: (generation: number) => Promise<void>): Promise<boolean> {
    if (this.exited || !this.started) return false;
    const generation = this.inputGeneration;
    try {
      await send(generation);
      return this.inputValid(generation);
    } catch (err) {
      if (err instanceof TmuxSessionMissingError) this.handlePaneExit();
      return false;
    }
  }

  /** Send tmux key names (for example Down or Enter), never literal escape
   * bytes. Applications in cursor-key mode distinguish these from text sent
   * through write(), which is intentionally limited to literal paste input. */
  async sendSpecialKeys(...keys: string[]): Promise<boolean> {
    if (keys.length === 0) return false;
    return this.sendInput(async () => {
      (await runTmux(['send-keys', '-t', this.sessionName, ...keys]));
    });
  }

  async interrupt(): Promise<void> {
    this.inputGeneration++;
    if (this.exited) return;
    try { (await runTmux(['send-keys', '-t', this.sessionName, 'C-c'])); } catch (error) { this.warnCaught('interrupt.sendKeys', error); }
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (this.exited) return;
    try {
      (await runTmux(['resize-window', '-t', this.sessionName, '-x', String(cols), '-y', String(rows)]));
    } catch { /* best-effort: a pane may close during resize. */ }
  }

  /** Safe to call before spawn() — callbacks are buffered and survive the
   *  spawn-time wiring (unlike the pty backend). */
  onData(cb: (data: string) => void): void {
    this.output.onData(cb);
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.exitCbs.push(cb);
  }

  /** Frozen while attached; later TMUX_TMPDIR changes cannot redirect a verified stop. */
  getSocketPath(): string | undefined { return this.socketPath; }
  captureDisposed(): boolean { return !this.capture; }
  onOutputGap(cb: (dropped: number) => void): void { this.output.onGap(cb); }

  /** Local teardown only. The identity-bound verifier owns the tmux command. */
  disposeCapture(): void {
    this.lifecycle++;
    this.inputGeneration++;
    this.exited = true;
    this.stopExitWatcher();
    this.cleanup();
  }

  /** Best-effort teardown. Never throws — a session that already died (CLI
   *  exited → last pane closed → session destroyed) is not an error. */
  async kill(): Promise<void> {
    await this.cancelPending();
    if (this.exited) return;
    this.exited = true;
    this.stopExitWatcher();
    this.cleanup();
    // An owner-bound backend may be a not-yet-attached restoration handle.
    // If its name now points at an unmarked/foreign pane, cleanup after a
    // failed attach must never destroy that pane (preserving external session history).
    if (this.ownerId !== undefined && (await TmuxBackend.sessionOwner(this.sessionName)) !== this.ownerId) return;
    try { await runTmux(['kill-session', '-t', this.sessionName], { timeout: 3000 }); } catch (error) { if (!(error instanceof TmuxSessionMissingError)) this.warnCaught('kill.killSession', error); }
  }

  /**
   * Detach this backend from a LIVE session WITHOUT destroying it: stop the
   * exit watcher, cancel the pipe-pane capture and close its private socket. The tmux
   * session and its CLI keep running — another TmuxBackend can attach() later
   * (driver resume() across daemon restarts). Contrast with kill(), which
   * kills the session itself.
   */
  async detach(): Promise<void> {
    await this.cancelPending();
    if (this.exited) return;
    this.exited = true;
    this.stopExitWatcher();
    try { (await runTmux(['pipe-pane', '-t', this.sessionName])); } catch { /* best-effort: capture cleanup still closes the local socket. */ }
    this.cleanup();
  }

  /**
   * Attach to an EXISTING live session — the caller must have probed with
   * probeSession() === 'exists'. Unlike spawn(), this neither creates the
   * session nor launches a CLI: the CLI is already running in the pane.
   * Re-arms output capture (pipe-pane + socket) and the exit watcher only.
   */
  async attach(_opts: { cols: number; rows: number }): Promise<void> {
    const generation = this.lifecycle;
    const check = () => { if (generation !== this.lifecycle) throw new TmuxError('tmux attachment cancelled'); };
    if (this.started) throw new TmuxError('tmux attach() called twice');
    await this.assertOwnership();
    check();
    this.socketPath = (await runTmux(['display-message', '-p', '-t', `=${this.sessionName}`, '#{socket_path}'])).trim();
    check();
    this.started = true;
    try {
      // A daemon crash leaves tmux's `pipe-pane` writer alive even though the
      // local socket reader is gone. Replace that stale capture before arming
      // ours; the higher-level lease/fencing layer is responsible for
      // preventing two live daemons from attaching concurrently.
      const oldCapture = await runTmux(['show-options', '-v', '-t', this.sessionName, '@dutydeck_capture_directory'])
        // best-effort: the old capture directory is only needed for cleanup.
        .catch(() => '');
      check();
      await runTmux(['pipe-pane', '-t', this.sessionName]);
      check();
      if (oldCapture.trim()) cleanAbandonedTmuxCapture(oldCapture.trim(), this.ownerId ?? this.sessionName);
      await this.startCapture(true);
      check();
      this.startExitWatcher();
    } catch (err) {
      (await this.detach());
      throw err;
    }
  }

  async resyncOutput(onBoundary?: () => void): Promise<string | null> {
    if (this.exited) return null;
    const generation = this.lifecycle;
    const check = () => { if (this.exited || generation !== this.lifecycle) throw new TmuxError('tmux capture cancelled'); };
    await this.assertOwnership(); check();
    await runTmux(['pipe-pane', '-t', this.sessionName]); check();
    this.cleanup();
    onBoundary?.();
    await this.startCapture(true); check();
    return this.initialScreen?.data ?? null;
  }

  async captureCurrentScreen(includeScrollback = false): Promise<string | null> {
    if (this.exited) return null;
    if (includeScrollback) return this.captureSubmissionScreen(false);
    try {
      return await runTmux(['capture-pane', '-p', '-J', '-t', this.sessionName]);
    } catch (error) {
      this.warnCaught('captureCurrentScreen', error);
      return null;
    }
  }

  captureInputSubmissionScreen(): Promise<string | null> {
    return this.captureSubmissionScreen(true);
  }

  private async captureSubmissionScreen(requireCursor: boolean): Promise<string | null> {
    if (this.exited) return null;
    try {
      const cursorFormat = '#{cursor_y} #{cursor_flag} #{cursor_x}';
      const cursor = (await runTmux(['display-message', '-p', '-t', this.sessionName, cursorFormat])).trim();
      if (!/^\d+ [01] \d+$/.test(cursor)) return null;
      const [cursorY, cursorFlag, cursorX] = cursor.split(' ').map(Number);
      const nativeCursorX = requireCursor && cursorFlag === 1 ? cursorX : undefined;
      const marker = randomBytes(16).toString('hex');
      const separator = `\n${marker}\n`;
      const captured = await runTmux([
        'capture-pane', '-p', '-e', '-J', '-S', '-200', '-E', String(cursorY), '-t', this.sessionName, ';',
        'display-message', '-p', marker, ';',
        'capture-pane', '-p', '-J', '-S', '-200', '-t', this.sessionName,
        ...(nativeCursorX === undefined ? [] : [';', 'display-message', '-p', marker, ';',
          'capture-pane', '-p', '-N', '-S', String(cursorY), '-E', String(cursorY), '-t', this.sessionName, ';',
          'display-message', '-p', '-t', this.sessionName, `${marker} ${cursorFormat}`]),
      ]);
      const boundary = captured.indexOf(separator);
      if (boundary < 0) return null;
      const partial = captured.slice(0, boundary + 1);
      const full = captured.slice(boundary + separator.length);
      if (nativeCursorX === undefined) return cleanTmuxSubmissionCapture(partial, full, requireCursor);
      const end = full.indexOf(separator);
      const suffix = `\n${marker} ${cursor}\n`;
      if (end < 0 || !full.endsWith(suffix)) return null;
      const physicalRow = full.slice(end + separator.length, -suffix.length);
      return cleanTmuxSubmissionCapture(partial, full.slice(0, end + 1), true, { column: nativeCursorX, physicalRow });
    } catch (error) {
      this.warnCaught('captureSubmissionScreen', error);
      return null;
    }
  }

  async getPaneSize(): Promise<{ cols: number; rows: number } | null> {
    if (this.exited) return null;
    try {
      const out = (await runTmux(
        ['display-message', '-p', '-t', this.sessionName, '#{pane_width} #{pane_height}'],
        { timeout: 2000 },
      )).trim();
      const parts = out.split(/\s+/).map(s => parseInt(s, 10));
      const cols = parts[0];
      const rows = parts[1];
      if (cols !== undefined && rows !== undefined && Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
        return { cols, rows };
      }
      return null;
    } catch {
      // best-effort: pane dimensions are optional display metadata.
      return null;
    }
  }

  async getPid(): Promise<number | null> {
    if (this.exited) return null;
    try {
      const out = (await runTmux(
        ['display-message', '-p', '-t', this.sessionName, '#{pane_pid}'],
        { timeout: 2000 },
      )).trim();
      const pid = parseInt(out, 10);
      return pid > 0 ? pid : null;
    } catch (error) {
      this.warnCaught('getPid', error);
      return null;
    }
  }

  /** Read a small non-secret driver lifecycle marker persisted by tmux. */
  async getDutydeckMetadata(key: TmuxDutydeckMetadataKey): Promise<string | undefined> {
    if (this.exited) return undefined;
    try {
      const value = (await runTmux([
        'show-options', '-v', '-t', this.sessionName, METADATA_OPTIONS[key],
      ], { timeout: 2000 })).trim();
      return value || undefined;
    } catch {
      // best-effort: recovery markers may be absent on older sessions.
      return undefined;
    }
  }

  /** Persist a small non-secret driver lifecycle marker on the tmux session. */
  async setDutydeckMetadata(key: TmuxDutydeckMetadataKey, value: string): Promise<void> {
    if (this.exited) throw new TmuxError('cannot write metadata on an exited tmux backend');
    (await runTmux(['set-option', '-t', this.sessionName, METADATA_OPTIONS[key], value], { timeout: 2000 }));
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
  static probeSession(name: string): Promise<SessionProbe> { return this.probeSessionAsync(name); }

  /** Async probe for the high-frequency watcher; unknown never proves exit. */
  static async probeSessionAsync(name: string): Promise<SessionProbe> {
    return (await this.hasSession(name)).probe;
  }

  /**
   * Path of a deleted tmux socket whose server is still bound to it (Linux
   * only), for diagnostics after a probe answered 'unknown'.
   */
  static async orphanedServerSocket(name: string): Promise<string | undefined> {
    return (await this.hasSession(name)).orphanedSocket;
  }

  /** A missing socket file is 'missing' unless the kernel proves the old server still listens on that path. */
  private static async hasSession(name: string): Promise<{ probe: SessionProbe; orphanedSocket?: string }> {
    try {
      await runCommand('tmux', ['-u', 'has-session', '-t', name], { env: tmuxClientEnv(), timeout: 3000 });
      return { probe: 'exists' };
    } catch (error) {
      const failure = error as { signal?: string; status?: number; stderr?: string };
      if (failure.signal || typeof failure.status !== 'number') return { probe: 'unknown' };
      const stderr = failure.stderr ?? '';
      if (isSocketMissingErrorText(stderr)) {
        const orphanedSocket = orphanedSocketPath(stderr);
        return orphanedSocket === undefined ? { probe: 'missing' } : { probe: 'unknown', orphanedSocket };
      }
      return { probe: isServerLevelErrorText(stderr) ? 'unknown' : 'missing' };
    }
  }

  /**
   * Remove a dead session this owner left behind, typically kept by the
   * user's `remain-on-exit`. Only an exact-name session carrying `ownerId`
   * whose every pane in every window reports dead is killed; the session id,
   * owner and pane states are read again right before kill-session. Missing
   * owner, a live pane, an unreadable state or any tmux error leaves the
   * session untouched. Returns whether a session was removed.
   */
  static async reapDeadOwnedSession(name: string, ownerId: string | undefined, log?: DiagnosticLog): Promise<boolean> {
    if (ownerId === undefined) return false;
    const sessionId = async () => (await runTmux(['display-message', '-p', '-t', name, '#{session_id}'], { timeout: 2000 })).trim();
    try {
      const id = await sessionId();
      if (!/^\$\d+$/.test(id)) return false;
      const reapable = async () => {
        if ((await sessionId()) !== id) return false;
        if ((await runTmux(['show-options', '-v', '-t', id, OWNER_OPTION], { timeout: 2000 })).trim() !== ownerId) return false;
        const panes = (await runTmux(['list-panes', '-s', '-t', id, '-F', '#{pane_dead}'], { timeout: 2000 })).split('\n').map(line => line.trim()).filter(Boolean);
        return panes.length > 0 && panes.every(dead => dead === '1');
      };
      if (!(await reapable()) || !(await reapable())) return false;
      await runTmux(['kill-session', '-t', id], { timeout: 3000 });
      return true;
    } catch (error) {
      warnCaught(log, 'TmuxBackend', 'reapDeadOwnedSession', dutydeckSessionId(ownerId, name), error);
      return false;
    }
  }

  /** Kill a named tmux session (no-op if it doesn't exist). */
  static async killSession(name: string): Promise<void> {
    try { await runTmux(['kill-session', '-t', name], { timeout: 3000 }); } catch { /* already gone */ }
  }

  /** Diagnostic/readiness helper.  Missing markers return undefined. */
  static async sessionOwner(name: string): Promise<string | undefined> {
    try {
      const owner = (await runTmux(['show-options', '-v', '-t', name, OWNER_OPTION], { timeout: 2000 })).trim();
      return owner || undefined;
    } catch {
      // best-effort: an external or missing pane may have no owner marker.
      return undefined;
    }
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  /** Arm bounded socket capture; restoreScreen atomically captures screen/history
   *  before starting new increments. kill/detach remove local socket metadata. */
  private async startCapture(restoreScreen = false): Promise<void> {
    const generation = this.lifecycle;
    const capture = new TmuxCapture(this.ownerId ?? this.sessionName, data => {
      this.output.data(data);
    }, dropped => this.output.gap(dropped));
    this.capture = capture;
    const check = () => {
      if (this.exited || this.capture !== capture || this.lifecycle !== generation) {
        capture.close();
        if (this.capture === capture) this.capture = undefined;
        throw new TmuxError('tmux capture cancelled');
      }
    };
    await capture.listen(); check();
    await runTmux(['set-option', '-t', this.sessionName, '@dutydeck_capture_directory', capture.directory]); check();
    const pipe = ['pipe-pane', '-o', '-t', this.sessionName, tmuxTimeFormatLiteral(capture.command())];
    if (!restoreScreen) { await runTmux(pipe); check(); return; }

    // One tmux command queue captures the existing screen/history and then
    // starts the incremental pipe, without a gap between two client calls.
    const fields = ['pane_width', 'pane_height', 'cursor_x', 'cursor_y', 'alternate_on',
      'cursor_flag', 'keypad_cursor_flag', 'mouse_standard_flag', 'mouse_button_flag',
      'mouse_all_flag', 'mouse_sgr_flag', 'mouse_utf8_flag', 'insert_flag', 'wrap_flag',
      'origin_flag', 'scroll_region_upper', 'scroll_region_lower'];
    const captured = (await runTmux([
      'display-message', '-p', '-t', this.sessionName, fields.map(key => `#{${key}}`).join('|'), ';',
      'capture-pane', '-p', '-e', '-t', this.sessionName, '-S', '-5000', ';', ...pipe,
    ]));
    check();
    const boundary = captured.indexOf('\n');
    const values = captured.slice(0, boundary).trim().split('|').map(Number);
    const [cols, rows, x, y, alternate, cursor, cursorKeys, mouse, mouseButton, mouseAll, sgr, utf8, insert, wrap, origin, top, bottom] = values;
    if (!cols || !rows || boundary < 0) throw new TmuxError('Could not capture terminal dimensions');
    let data = '\x1bc' + (alternate ? '\x1b[?1049h' : '');
    data += captured.slice(boundary + 1).replace(/\n$/, '').replace(/\n/g, '\r\n');
    data += `\x1b[0m\x1b[${top! + 1};${bottom! + 1}r`;
    for (const [mode, enabled] of [[25, cursor], [1, cursorKeys], [1000, mouse], [1002, mouseButton],
      [1003, mouseAll], [1006, sgr], [1005, utf8], [7, wrap], [6, origin]]) {
      if (enabled) data += `\x1b[?${mode}h`;
    }
    if (!cursor) data += '\x1b[?25l';
    if (!wrap) data += '\x1b[?7l';
    if (insert) data += '\x1b[4h';
    data += `\x1b[${y! + 1 - (origin ? top! : 0)};${x! + 1}H`;
    this.initialScreen = { data, cols, rows };
  }

  private async writeOwnershipMarker(): Promise<void> {
    if (this.ownerId === undefined) return;
    (await runTmux(['set-option', '-t', this.sessionName, OWNER_OPTION, this.ownerId], { timeout: 2000 }));
  }

  private async scrubStaleGlobalEnvironment(childEnvironment: Record<string, string>): Promise<void> {
    const raw = (await runTmux(['show-environment', '-g'], { timeout: 2000 }));
    const commands: string[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('-')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq);
      if (!(key in childEnvironment) || childEnvironment[key] === undefined) {
        commands.push('set-environment', '-t', this.sessionName, '-r', '--', key, ';');
      }
    }
    await this.runEnvironmentCommands(commands);
  }

  private async stageSessionEnvironment(environment: Record<string, string>): Promise<void> {
    const commands = Object.entries(environment).flatMap(([key, value]) => ['set-environment', '-t', this.sessionName, '--', key, tmuxLiteralArg(value), ';']);
    await this.runEnvironmentCommands(commands);
  }

  private async clearSessionEnvironment(keys: string[]): Promise<void> {
    const commands = keys.flatMap(key => ['set-environment', '-u', '-t', this.sessionName, '--', key, ';']);
    await this.runEnvironmentCommands(commands);
  }

  /** tmux limits a client's command message; keep batches below that limit. */
  private async runEnvironmentCommands(commands: string[]): Promise<void> {
    let batch: string[] = [], command: string[] = [], bytes = 0;
    for (const arg of commands) {
      if (arg !== ';') { command.push(arg); continue; }
      const size = command.reduce((sum, value) => sum + Buffer.byteLength(value) + 8, 0);
      if (bytes + size > 8192 && batch.length) { await runTmux(batch.slice(0, -1)); batch = []; bytes = 0; }
      batch.push(...command, ';'); bytes += size; command = [];
    }
    if (batch.length) await runTmux(batch.slice(0, -1));
  }

  private async assertOwnership(): Promise<void> {
    if (this.ownerId === undefined) return;
    const actual = (await TmuxBackend.sessionOwner(this.sessionName));
    if (actual !== this.ownerId) {
      throw new TmuxOwnershipError(
        `Refusing to attach tmux session ${this.sessionName}: Dutydeck ownership marker mismatch`,
      );
    }
  }

  private inputValid(generation: number): boolean { return generation === this.inputGeneration && !this.exited && this.started; }

  /** Send text literally: send-keys -l for short single-line payloads,
   *  load-buffer + paste-buffer for long or multiline text (avoids the 4KB
   *  tty canonical-input limit and handles newlines via bracketed paste).
   *  A payload carrying its own paste markers is pasted byte-exact without
   *  tmux markers, which would otherwise nest and end the paste early. */
  private async sendLiteral(text: string, generation: number): Promise<void> {
    if (text.length > LITERAL_SEND_LIMIT || text.includes('\n')) {
      (await this.pasteLiteral(text, generation, !text.includes(BRACKETED_PASTE_START)));
      return;
    }
    (await runTmux(['send-keys', '-t', this.sessionName, '-l', '--', tmuxLiteralArg(text)]));
  }

  private async pasteLiteral(text: string, generation: number, bracketed: boolean): Promise<void> {
    const bufferName = `dutydeck-${randomBytes(8).toString('hex')}`;
    let loaded = false;
    try {
      (await runTmux(['load-buffer', '-b', bufferName, '-'], { input: text }));
      loaded = true;
      if (!this.inputValid(generation)) throw new TmuxError('tmux input cancelled before paste');
      // -d deletes the buffer after pasting; -r keeps LF (tmux otherwise sends
      // CR, a separate Enter for an application without bracketed paste); -p
      // wraps in markers only when the application requested bracketed paste.
      (await runTmux(['paste-buffer', '-b', bufferName, '-t', this.sessionName, '-d', '-r', ...(bracketed ? ['-p'] : [])]));
      loaded = false;
    } finally {
      if (loaded) {
        try { (await runTmux(['delete-buffer', '-b', bufferName], { timeout: 1000 })); } catch { /* best-effort: the paste buffer may already have been deleted. */ }
      }
    }
  }

  /**
   * Poll liveness once per second through the process-wide pane poller: an
   * authoritative 'missing' answer means the CLI exited (the session dies
   * with its last pane), so fire onExit. A dead pane pid (process.kill
   * ESRCH) is equally decisive. Server-level failures (connect refused, lost
   * server, timeout) prove nothing and are ignored: misreading a
   * busy-but-stalled server as "session gone" could mass-tear down live
   * sessions, so this watcher never acts on them.
   */
  private startExitWatcher(): void {
    // Liveness checks can transiently fail under load (list-panes timeout,
    // a stale/dead pane pid). A single bad reading must NOT tear down a live
    // session — require consecutive failures before declaring the pane gone.
    // Any successful check resets the counter.
    let consecutiveFailures = 0;
    const FAILURE_THRESHOLD = 3;
    // Last pane process seen through a live server. A deleted socket file (e.g. /tmp cleanup) makes every
    // client report "no such file" while the server and CLI keep running; that alone does not prove exit.
    let knownPane: { pid: number; start?: string } | undefined;
    const timer: PaneWatch = subscribePanes(this.sessionName, ({ probe, pid, socketMissing }) => {
      // A detached/replaced watcher must not act on an in-flight result.
      if (this.exited || this.exitTimer !== timer) return;
      let failed = probe === 'missing';
      if (socketMissing && knownPane && paneProcessAlive(knownPane)) failed = false;
      // An unknown server answer must not be combined with a stale pane PID.
      if (probe === 'exists') {
        if (pid !== null) {
          try { process.kill(pid, 0); if (knownPane?.pid !== pid) knownPane = { pid, start: processStart(pid) }; }
          catch (e) { failed = (e as NodeJS.ErrnoException).code === 'ESRCH'; }
        }
      }
      consecutiveFailures = failed ? consecutiveFailures + 1 : 0;
      if (consecutiveFailures >= FAILURE_THRESHOLD) this.handlePaneExit();
    });
    this.exitTimer = timer;
  }

  private stopExitWatcher(): void {
    if (this.exitTimer) {
      this.exitTimer.close();
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

  /** Close the local socket and metadata without touching the tmux session. */
  private cleanup(): void {
    this.capture?.close(); this.capture = undefined;
  }
}

function mergeIdentities(...lists: OwnedTmuxIdentity['identities'][]): OwnedTmuxIdentity['identities'] {
  const merged = new Map<string, OwnedTmuxIdentity['identities'][number]>();
  for (const item of lists.flat()) merged.set(processIdentityKey(item), item);
  return [...merged.values()];
}
/** False only when the PID no longer exists (ESRCH); an unknown answer counts as running. */
function processRunning(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
