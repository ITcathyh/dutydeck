import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import {
  childProcessIdentity,
  currentProcessIdentity,
  type ProcessIdentity
} from '@dutydeck/storage';

/**
 * Self-managed background daemon for the Dutydeck local session server.
 *
 * `dutydeck start` re-spawns itself out of band (a `child_process.spawn` with
 * `detached: true`) and waits for the child to report ready — or to die — before
 * exiting, leaving a background child that owns the server. That child records
 * its PID plus metadata under the working directory's `.dutydeck/daemon/` so
 * `stop` / `restart` / `status` can locate and control it without any external
 * supervisor (no pm2 / systemd).
 *
 * Parent vs. daemon child split is signalled through the
 * `DUTYDECK_DAEMONIZED` environment variable set on the respawned child.
 *
 * Linux 开机自启的 systemd unit 走另一条路：`dutydeck start --foreground` 自己就是服务
 * 进程，按同样的格式写状态文件，并记下托管它的 unit（`supervisor` / `systemdUnit`），
 * 之后 stop / restart 改由 systemctl 执行，崩溃或被误杀由 systemd 重拉。
 */

export const DAEMON_ENV_FLAG = 'DUTYDECK_DAEMONIZED';
export const DAEMON_CWD_ENV = 'DUTYDECK_DAEMON_CWD';
export const DAEMON_STARTED_AT_ENV = 'DUTYDECK_DAEMON_STARTED_AT';
/** systemd unit 通过这两个环境变量声明「本进程由它托管」，只有前台入口会读取。 */
export const SUPERVISOR_ENV = 'DUTYDECK_SUPERVISOR';
export const SYSTEMD_UNIT_ENV = 'DUTYDECK_SYSTEMD_UNIT';

export const PID_FILE = 'dutydeck.pid';
export const STATE_FILE = 'dutydeck.state.json';
export const LOG_FILE = 'dutydeck.log';

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
  processIdentity?: ProcessIdentity;
  /** 由 systemd 托管时为 'systemd'；只有前台入口在 unit 里运行时才会写。 */
  supervisor?: 'systemd';
  /** 托管它的 systemd unit 名，stop / restart 据此调用 systemctl。 */
  systemdUnit?: string;
}

export interface DaemonPaths {
  dir: string;
  pidFile: string;
  stateFile: string;
  logFile: string;
}

/** Default daemon directory relative to the working directory. */
export function defaultDaemonDir(cwd = process.cwd()): string {
  return join(cwd, '.dutydeck', 'daemon');
}

/** Path to the global pointer file that records the last-started daemon directory. */
export function lastDaemonDirPointerFile(home = process.env.HOME ?? homedir()): string {
  return join(home, '.dutydeck', 'last-daemon-dir');
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

export type DaemonProcessStatus = 'verified' | 'stale' | 'unverifiable';

export interface DaemonInspection {
  status: DaemonProcessStatus;
  pid?: number;
  reason?: string;
}

/** A captured identity must contain every component before it can authorize signals. */
function completeIdentity(identity: ProcessIdentity | undefined): identity is ProcessIdentity {
  return !!identity && Number.isSafeInteger(identity.pid) && identity.pid > 0 &&
    [identity.host, identity.boot, identity.namespace, identity.start].every(value => typeof value === 'string' && value.length > 0);
}

export function sameIdentity(left?: ProcessIdentity, right?: ProcessIdentity): boolean {
  if (!left || !right) return left === right;
  return (['host', 'boot', 'namespace', 'pid', 'start'] as const).every(key => left[key] === right[key]);
}

export function sameGeneration(left?: DaemonState, right?: DaemonState): boolean {
  if (!left || !right) return left === right;
  return left.pid === right.pid && left.startedAt === right.startedAt && sameIdentity(left.processIdentity, right.processIdentity);
}

export function inspectDaemonState(state: DaemonState | undefined): DaemonInspection {
  if (!state) return { status: 'stale', reason: 'No daemon recorded' };
  const pid = state.pid;
  const result = (status: DaemonProcessStatus, reason: string): DaemonInspection => ({ status, pid, reason });
  if (!Number.isSafeInteger(pid) || pid <= 0) return result('unverifiable', 'Invalid recorded daemon PID');
  const saved = state.processIdentity;
  if (!saved) return pidAlive(pid)
    ? result('unverifiable', 'Live legacy daemon has no process identity')
    : result('stale', 'Recorded process no longer exists');
  if (!completeIdentity(saved) || saved.pid !== pid) return result('unverifiable', 'Incomplete recorded process identity');
  try {
    const local = currentProcessIdentity();
    if (!completeIdentity(local)) return result('unverifiable', 'Local process identity unavailable');
    if (local.host !== saved.host) return result('unverifiable', 'Recorded daemon belongs to another host');
    if (local.boot !== saved.boot) return result('stale', 'Recorded daemon predates the current boot');
    if (local.namespace !== saved.namespace) return result('unverifiable', 'Recorded daemon belongs to another PID namespace');
    if (!pidAlive(pid)) return result('stale', 'Recorded process no longer exists');
    let target: ProcessIdentity;
    try {
      target = childProcessIdentity(pid);
    } catch (error) {
      if (!pidAlive(pid)) return result('stale', 'Recorded process exited during inspection');
      if ((error as Error).message === 'PROCESS_NAMESPACE_UNSUPPORTED') return result('stale', 'Target PID namespace changed');
      return result('unverifiable', 'Cannot read target process identity');
    }
    if (!completeIdentity(target)) return result('unverifiable', 'Target process identity unavailable');
    if (target.host !== saved.host) return result('unverifiable', 'Target host cannot be verified');
    return sameIdentity(saved, target)
      ? { status: 'verified', pid }
      : result('stale', 'Recorded process identity changed (PID reused)');
  } catch {
    return result('unverifiable', 'Cannot read local process identity');
  }
}

export function inspectDaemon(dir = defaultDaemonDir()): DaemonInspection {
  try {
    const raw = readFileSync(join(dir, STATE_FILE), 'utf8').trim();
    if (!raw) return inspectDaemonState(undefined);
    const state = JSON.parse(raw) as DaemonState;
    if (!state || typeof state !== 'object') return { status: 'unverifiable', reason: 'Malformed daemon state' };
    return inspectDaemonState(state);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'stale', reason: 'No daemon recorded' }
      : { status: 'unverifiable', reason: 'Cannot read daemon state' };
  }
}

/** Only remove the generation inspected by this operation. */
export function clearGeneration(dir: string, expected?: DaemonState): boolean {
  if (inspectDaemon(dir).status === 'unverifiable' || !sameGeneration(expected, readDaemonStatus(dir))) return false;
  clearState(dir);
  return true;
}

/**
 * Resolve which daemon directory to operate on.
 *
 * Priority:
 * 1. The daemon directory under the current working directory, IF it points at
 *    a verified or unverifiable daemon process (stale pid files are ignored, but
 *    unverifiable state is preserved to avoid silent cross-directory fallback).
 * 2. The directory recorded in `~/.dutydeck/last-daemon-dir`. It remains the
 *    canonical Dutydeck root even while the daemon is stopped, preventing a
 *    later start from silently creating a second database under another cwd.
 * 3. The current working directory's daemon directory on the very first run.
 */
export function resolveDaemonDir(cwd = process.cwd(), home = process.env.HOME ?? homedir()): string {
  const localDir = defaultDaemonDir(cwd);
  const localInspection = inspectDaemon(localDir);
  if (localInspection.status === 'verified' || localInspection.status === 'unverifiable') {
    return localDir;
  }
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
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
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
 * True when a daemon recorded for `dir` is currently verified and alive.
 */
export function isDaemonRunning(dir = defaultDaemonDir()): boolean {
  return inspectDaemon(dir).status === 'verified';
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

/** Whether this process is the daemonized child spawned by `dutydeck start`. */
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
  processIdentity?: ProcessIdentity;
  /**
   * 子进程退出时 resolve。
   *
   * 有了它，父进程就不必傻等满就绪超时：端口被占用之类的失败会在几十毫秒内
   * 让子进程带非零码退出，父进程立刻据此报错。
   */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * 把当前 `dutydeck` 进程在后台重新拉起一份，stdout / stderr 重定向进守护日志。
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
  const logFile = daemonPaths(cwd ? join(cwd, '.dutydeck', 'daemon') : defaultDaemonDir()).logFile;
  const fd = openLogFd(logFile);
  const script = process.argv[1];
  if (script === undefined) throw new Error('无法确定 Dutydeck 自身的入口脚本，无法启动后台服务。');

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
  let processIdentity: ProcessIdentity | undefined;
  try { if (child.pid) processIdentity = childProcessIdentity(child.pid); } catch { /* Startup will fail closed if identity cannot be captured. */ }
  return { pid: child.pid ?? 0, processIdentity, exited };
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
