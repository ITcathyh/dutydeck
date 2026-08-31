import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

/**
 * Self-managed background daemon for the Dockmux local session server.
 *
 * `dockmux start` re-spawns itself out of band (a `child_process.spawn` with
 * `detached: true`) and waits for the child to report ready — or to die — before
 * exiting, leaving a background child that owns the server. That child records
 * its PID plus metadata under the working directory's `.dockmux/daemon/` so
 * `stop` / `restart` / `status` can locate and control it without any external
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

/** 已启动的后台子进程句柄。父进程据此判断「起来了」还是「当场就死了」。 */
export interface DaemonChildHandle {
  pid: number;
  /**
   * 子进程退出时 resolve。
   *
   * 有了它，父进程就不必傻等满就绪超时：端口被占用之类的失败会在几十毫秒内
   * 让子进程带非零码退出，父进程立刻据此报错。
   */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * 把当前 `dockmux` 进程在后台重新拉起一份，stdout / stderr 重定向进守护日志。
 *
 * 这里刻意不用 `daemonize-process`：它在 spawn 完成后立刻 `exit(0)` 掉父进程，
 * 于是「服务到底起来没有」永远没人检查——端口被占用时子进程 EADDRINUSE 死掉，
 * 父进程却已经带 0 退出且一个字都不打印，用户以为起好了。这违反「状态不许说谎」。
 * 改成自己 spawn 并把句柄交还调用方，让父进程等到就绪或失败再决定退出码与输出。
 *
 * `execArgv` 一并透传，否则在 tsx 等 loader 下起出来的子进程会因为 node 无法加载
 * `.ts` 入口而立刻死掉（表现为 ERR_MODULE_NOT_FOUND）。
 */
export function daemonize(options: DaemonizeOptions = {}): DaemonChildHandle {
  const cwd = options.cwd ?? process.cwd();
  const logFile = daemonPaths(cwd ? join(cwd, '.dockmux', 'daemon') : defaultDaemonDir()).logFile;
  const fd = openLogFd(logFile);
  const script = process.argv[1];
  if (script === undefined) throw new Error('无法确定 Dockmux 自身的入口脚本，无法启动后台服务。');

  const child = spawn(process.execPath, [...process.execArgv, script, ...process.argv.slice(2)], {
    cwd,
    stdio: ['ignore', fd, fd],
    detached: true,
    env: {
      ...(options.env ?? process.env),
      [DAEMON_ENV_FLAG]: '1',
      [DAEMON_CWD_ENV]: cwd,
      [DAEMON_STARTED_AT_ENV]: options.startedAt ?? new Date().toISOString()
    }
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', () => resolve({ code: null, signal: null }));
  });
  // detached + unref：父进程退出后子进程继续活着，且不因它而卡住事件循环。
  child.unref();
  return { pid: child.pid ?? 0, exited };
}

/**
 * 看起来像「失败原因」的行。启动日志里绝大多数是正常的启动流水，直接取末尾几行
 * 会把真正的报错埋掉，所以只挑错误特征行。
 */
const FAILURE_LINE_PATTERN = /error|EADDRINUSE|EACCES|EPERM|ENOENT|ENOTDIR|cannot|can't|unable|failed|fatal|denied|refused|exception|throw|not found|invalid/i;

/**
 * 疑似携带机密的行，一律不回放。
 *
 * 守护日志里混着服务自己打印的访问令牌（`Generated access token ...`）。把日志
 * 尾巴原样搬进 CLI 输出会让令牌进入终端记录、CI 日志乃至 `--json` 的消费方——
 * 这是「绝不泄密」的红线。错误特征过滤已经能挡掉这一行，这里再做一道兜底，
 * 因为将来谁在启动路径上多打一行机密，都不该因此泄漏。
 */
const SECRET_LINE_PATTERN = /token|secret|password|passwd|credential|api[-_ ]?key|authorization|bearer/i;

/** 单行上限，防止一条巨大的堆栈或 JSON 把终端糊满。 */
const MAX_REASON_LINE = 200;

/** 守护日志当前字节数。用于只读取「这次启动之后」新写入的内容。 */
export function daemonLogSize(dir: string): number {
  try {
    return statSync(daemonPaths(dir).logFile).size;
  } catch {
    return 0;
  }
}

/**
 * 从守护日志里提炼「起不来」的原因，用于直接呈现给用户。
 *
 * `fromByte` 是关键：日志是 append 的，若不从本次启动的偏移开始读，报错里会混进
 * 上几轮运行的陈旧行——真正的原因（比如 EADDRINUSE）被埋在噪音后面，用户反而
 * 更难判断。只报不改：读失败就返回空，绝不因为取日志而让启动流程崩掉。
 */
export function tailDaemonLog(dir: string, lines = 3, fromByte = 0): string[] {
  try {
    const text = readFileSync(daemonPaths(dir).logFile, 'utf8');
    const fresh = fromByte > 0 && fromByte <= text.length ? text.slice(fromByte) : text;
    return fresh
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '')
      .filter(line => !SECRET_LINE_PATTERN.test(line))
      .filter(line => FAILURE_LINE_PATTERN.test(line))
      .map(line => line.length > MAX_REASON_LINE ? `${line.slice(0, MAX_REASON_LINE)}…` : line)
      .slice(-lines);
  } catch {
    return [];
  }
}

/** Open a log file for append (creating parent directories), returning its numeric fd. */
function openLogFd(file: string): number {
  mkdirSync(dirname(file), { recursive: true });
  return openSync(file, 'a');
}
