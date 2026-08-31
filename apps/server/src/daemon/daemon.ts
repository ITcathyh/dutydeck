import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { daemonizeProcess } from 'daemonize-process';

/**
 * Self-managed background daemon for the Dockmux local session server.
 *
 * `dockmux start` re-spawns itself out of band via `daemonize-process`
 * (a `child_process.spawn` with `detached: true`) and then exits, leaving a
 * foreground child that owns the server. That child records its PID plus
 * metadata under the working directory's `.dockmux/daemon/` so `stop` /
 * `restart` / `status` can locate and control it without any external
 * supervisor (no pm2 / systemd).
 *
 * Parent vs. daemon child split is signalled through the
 * `DOCKMUX_DAEMONIZED` environment variable set on the respawned child.
 */

export const DAEMON_ENV_FLAG = 'DOCKMUX_DAEMONIZED';
export const DAEMON_CWD_ENV = 'DOCKMUX_DAEMON_CWD';
export const DAEMON_STARTED_AT_ENV = 'DOCKMUX_DAEMON_STARTED_AT';

export const PID_FILE = 'dockmux.pid';
export const STATE_FILE = 'dockmux.state.json';
export const LOG_FILE = 'dockmux.log';

export interface DaemonState {
  pid: number;
  ready: boolean;
  startedAt: string;
  cwd: string;
  database?: string;
  host?: string;
  port?: number;
  address?: string;
  /** Missing or malformed legacy values are interpreted as enabled. */
  authEnabled?: boolean;
  stoppedAt?: string;
}

export interface DaemonPaths {
  dir: string;
  pidFile: string;
  stateFile: string;
  logFile: string;
}

/** Default daemon directory relative to the working directory. */
export function defaultDaemonDir(cwd = process.cwd()): string {
  return join(cwd, '.dockmux', 'daemon');
}

/** Path to the global pointer file that records the last-started daemon directory. */
export function lastDaemonDirPointerFile(home = process.env.HOME ?? homedir()): string {
  return join(home, '.dockmux', 'last-daemon-dir');
}

/** Read the last-started daemon directory from the global pointer, if any. */
export function readLastDaemonDir(home = process.env.HOME ?? homedir()): string | undefined {
  try {
    const raw = readFileSync(lastDaemonDirPointerFile(home), 'utf8').trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

/** Persist the last-started daemon directory to the global pointer. */
export function writeLastDaemonDir(dir: string, home = process.env.HOME ?? homedir()): void {
  const pointerFile = lastDaemonDirPointerFile(home);
  mkdirSync(dirname(pointerFile), { recursive: true });
  writeFileSync(pointerFile, `${dir}\n`, 'utf8');
}

/**
 * Resolve which daemon directory to operate on.
 *
 * Priority:
 * 1. The daemon directory under the current working directory, IF it points at
 *    a live daemon process (stale pid files are ignored).
 * 2. The directory recorded in `~/.dockmux/last-daemon-dir`. It remains the
 *    canonical Dockmux root even while the daemon is stopped, preventing a
 *    later start from silently creating a second database under another cwd.
 * 3. The current working directory's daemon directory on the very first run.
 */
export function resolveDaemonDir(cwd = process.cwd(), home = process.env.HOME ?? homedir()): string {
  const localDir = defaultDaemonDir(cwd);
  if (isDaemonRunning(localDir)) return localDir;
  const lastDir = readLastDaemonDir(home);
  if (lastDir && existsSync(lastDir)) return lastDir;
  return localDir;
}

export function daemonPaths(dir = defaultDaemonDir()): DaemonPaths {
  return { dir, pidFile: join(dir, PID_FILE), stateFile: join(dir, STATE_FILE), logFile: join(dir, LOG_FILE) };
}

/** Returns true when a process with `pid` exists (signal 0 succeeds). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH means the pid does not exist.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readDaemonStatus(dir = defaultDaemonDir()): DaemonState | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(dir, STATE_FILE), 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw) as DaemonState;
  } catch {
    return undefined;
  }
}

export function pidFromState(state?: DaemonState): number {
  return state && Number.isInteger(state.pid) && state.pid > 0 ? state.pid : 0;
}

/**
 * True when a daemon recorded for `dir` is currently alive. A stale PID file
 * (its process no longer exists) counts as not running.
 */
export function isDaemonRunning(dir = defaultDaemonDir()): boolean {
  const pid = pidFromState(readDaemonStatus(dir));
  return pid > 0 && pidAlive(pid);
}

/** The PID read straight from the pid file (0 when absent/unreadable). */
export function readPidFile(dir = defaultDaemonDir()): number {
  try {
    return parseInt(readFileSync(join(dir, PID_FILE), 'utf8').trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function writeState(dir: string, state: DaemonState): void {
  ensureDir(dir);
  writeFileSync(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function writePidFile(dir: string, pid: number): void {
  ensureDir(dir);
  writeFileSync(join(dir, PID_FILE), `${pid}\n`, 'utf8');
}

export function clearState(dir: string): void {
  ensureDir(dir);
  writeFileSync(join(dir, STATE_FILE), '', 'utf8');
  writeFileSync(join(dir, PID_FILE), '', 'utf8');
}

/** Resolved daemon cwd: the recorded cwd, falling back to the supplied one. */
export function daemonCwd(dir: string, fallback = process.cwd()): string {
  return readDaemonStatus(dir)?.cwd || fallback;
}

/** Whether this process is the daemonized child spawned by `dockmux start`. */
export function isDaemonChild(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DAEMON_ENV_FLAG] === '1';
}

/** Metadata captured by the parent `start` command and passed via env. */
export interface DaemonChildMeta {
  cwd: string;
  startedAt: string;
}

export function childMeta(env: NodeJS.ProcessEnv = process.env): DaemonChildMeta {
  return {
    cwd: env[DAEMON_CWD_ENV] ?? process.cwd(),
    startedAt: env[DAEMON_STARTED_AT_ENV] ?? new Date().toISOString()
  };
}

export interface DaemonizeOptions {
  cwd?: string;
  startedAt?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Re-spawn the current `dockmux` process in the background with stdout /
 * stderr redirected into the daemon log file. `daemonize-process` exits the
 * caller after launching the detached child, so this is terminal for the
 * calling process.
 */
export function daemonize(options: DaemonizeOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();
  const logFile = daemonPaths(cwd ? join(cwd, '.dockmux', 'daemon') : defaultDaemonDir()).logFile;
  const fd = openLogFd(logFile);

  daemonizeProcess({
    cwd,
    stdio: ['ignore', fd, fd],
    env: {
      ...(options.env ?? process.env),
      [DAEMON_ENV_FLAG]: '1',
      [DAEMON_CWD_ENV]: cwd,
      [DAEMON_STARTED_AT_ENV]: options.startedAt ?? new Date().toISOString()
    }
  });
}

/** Open a log file for append (creating parent directories), returning its numeric fd. */
function openLogFd(file: string): number {
  mkdirSync(dirname(file), { recursive: true });
  return openSync(file, 'a');
}
