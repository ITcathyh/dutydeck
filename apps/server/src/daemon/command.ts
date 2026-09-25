import { checkSqliteDriver, currentProcessIdentity, describeSqliteDriverFailure, type SqliteDriverCheck, type SqliteDriverCheckOptions } from '@dutydeck/storage';
import Database from 'better-sqlite3';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import {
  SUPERVISOR_ENV,
  SYSTEMD_UNIT_ENV,
  childMeta,
  clearGeneration,
  inspectDaemon,
  inspectDaemonState,
  sameGeneration,
  sameIdentity,
  daemonPaths,
  daemonize,
  daemonLogSize,
  defaultDaemonDir,
  isDaemonChild,
  readDaemonStatus,
  readLastDaemonDir,
  resolveDaemonDir,
  tailDaemonLog,
  writeLastDaemonDir,
  writePidFile,
  writeState,
  type DaemonChildHandle,
  type DaemonInspection,
  type DaemonProcessStatus,
  type DaemonState
} from './daemon.js';
import type { CliOptions } from '../cli-program.js';
import { AUTOSTART_LINUX_UNIT, defaultRunCommand, type AutostartCommandOutput, type AutostartRunCommand } from '../autostart/autostart.js';
import { sleep } from './time.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { localLoopbackUrl } from '../local-api-url.js';

export interface DaemonCommandResult {
  ok: boolean;
  action: 'start' | 'stop' | 'restart' | 'status';
  running: boolean;
  processStatus?: DaemonProcessStatus;
  pid?: number;
  address?: string;
  authEnabled?: boolean;
  authentication?: 'required' | 'disabled';
  logFile?: string;
  state?: 'started' | 'already-running' | 'not-running' | 'stopped' | 'restarted';
  error?: string;
}

const READY_TIMEOUT_MS = 15_000;
export const DRAIN_INTERVAL_MS = 5_000;
const ACTIVITY_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_DRAIN_TIMEOUT_SECONDS = 900;
const RESTART_HOST_ENV = 'DUTYDECK_DAEMON_RESTART_HOST';
const RESTART_PORT_ENV = 'DUTYDECK_DAEMON_RESTART_PORT';
const RESTART_CWD_ENV = 'DUTYDECK_DAEMON_RESTART_CWD';
const RESTART_DATABASE_ENV = 'DUTYDECK_DAEMON_RESTART_DATABASE';
const RESTART_AUTH_ENV = 'DUTYDECK_DAEMON_RESTART_AUTH';
/** detached restart：父进程已 drain 完，被拉起的 restart 子进程据此静默跳过，不再往守护日志写告警。 */
export const RESTART_DRAINED_ENV = 'DUTYDECK_DAEMON_RESTART_DRAINED';

/** start / stop / restart 与外部交互的钩子；默认走真实的 systemctl 与 SQLite 驱动，测试注入假实现。 */
export interface DaemonCommandDeps {
  /** 执行 systemctl，形状同 autostart 的 runCommand，默认 spawnSync。 */
  runCommand?: AutostartRunCommand;
  /** SQLite 驱动预检，默认 `@dutydeck/storage` 的 checkSqliteDriver。 */
  checkSqlite?: (options?: SqliteDriverCheckOptions) => SqliteDriverCheck;
  /** 默认 `process.platform`；只有 linux 会走 systemd。 */
  platform?: string;
  /** 网络请求客户端，默认 globalThis.fetch。测试可注入。 */
  fetch?: typeof fetch;
  /** 单次活动查询的超时（毫秒），默认 5000；测试可缩短。 */
  requestTimeoutMs?: number;
  /** 等待函数，默认 sleep。测试可注入。 */
  sleep?: (ms: number) => Promise<void>;
  /** 获取当前时间戳（毫秒），默认 Date.now。测试可注入。 */
  now?: () => number;
  /** 从数据库读取 accessToken，测试可注入。 */
  readToken?: (databasePath: string) => string | undefined;
  /** 本机网卡地址列表，默认读 node:os networkInterfaces。测试可注入。 */
  localAddresses?: () => string[];
  /** 要从计数里排除的会话 id；默认读 Agent 注入的 dutydeck_session_id。 */
  excludeSessionId?: string;
  /** 警告输出钩子，默认输出到 process.stderr。测试可注入。 */
  warn?: (message: string) => void;
  /** 进度说明输出钩子，默认输出到 process.stderr。测试可注入。 */
  info?: (message: string) => void;
}

const defaultWarn = (message: string) => {
  process.stderr.write(`警告：${message}\n`);
};

const defaultInfo = (message: string) => {
  process.stderr.write(`${message}\n`);
};

function defaultReadToken(databasePath: string): string | undefined {
  try {
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      return (db.prepare('SELECT value FROM configs WHERE key=?').get('auth.accessToken') as { value?: string } | undefined)?.value?.trim();
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

/** 只允许连 loopback 或本机网卡地址，且必须是明文 http、不带用户名密码。与 recovery-cli 同一边界。 */
function resolveLocalUrl(address: string | undefined, localAddresses: () => string[]): URL | undefined {
  if (!address) return undefined;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return undefined;
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const local = ['127.0.0.1', 'localhost', '::1'].includes(hostname)
    || Boolean(isIP(hostname) && localAddresses().includes(hostname));
  if (url.protocol !== 'http:' || !local || url.username || url.password) return undefined;
  return url;
}

/** 解析 --drain-timeout：只接受正整数秒数；undefined 用默认值；非法值返回 undefined。 */
export function parseDrainTimeoutSeconds(value: string | undefined): number | undefined {
  if (value === undefined) return DEFAULT_DRAIN_TIMEOUT_SECONDS;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const seconds = Number(trimmed);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

/** 排空租约（秒）：等待期间每轮查询都会续租；调用方中途退出时，服务在租约到期后自己恢复。 */
const DRAIN_LEASE_SECONDS = 60;

/** 连运行时本机 API 用的三项：守护状态文件里的记录，或由 unit / deployment.json 推出来的同样信息。 */
export type RuntimeEndpoint = Pick<DaemonState, 'address' | 'database' | 'authEnabled'>;

/**
 * 等待成功时 release 退出排空；调用方在随后的重启失败、旧进程还在跑时用它恢复执行。
 * renew 把排空租约再续一个 DRAIN_LEASE_SECONDS：停旧进程前还有耗时步骤（如备份数据库）时定期调用。
 */
export type DrainResult = { ok: true; release?: () => Promise<void>; renew?: () => Promise<void> } | { ok: false; error: string; runningTasks: number };

const invalidDrainTimeout = (options: Pick<CliOptions, 'drainTimeout'>): DrainResult => ({
  ok: false, runningTasks: 0,
  error: `--drain-timeout 只接受正整数秒数（收到 ${JSON.stringify(options.drainTimeout)}）。要跳过等待立即重启，请用 dutydeck restart --force。旧服务仍在运行，没有停止任何进程。`
});

const refuseWithoutStatus = (reason: string) =>
  `${reason}，无法确认是否有任务正在执行，已拒绝重启，旧服务仍在运行。若确认可以中断正在执行的任务，加 --force 跳过等待。`;

/**
 * 重启前等待守护进程中正在执行的任务结束（drain）。
 * - options.force / 父进程已 drain（restart 子进程）：直接放行，不查询、不告警；
 * - 守护进程未运行、身份无法验证：输出警告并继续（后者会被随后的停止步骤拒绝）；
 * - 其余情形先让服务进入排空，再等任务结束，见 holdAndWait。
 */
export async function waitForRunningTasksDrain(
  dir: string,
  state: DaemonState | undefined,
  options: CliOptions,
  deps: DaemonCommandDeps
): Promise<DrainResult> {
  if (options.force) return { ok: true };
  // detached restart 会再拉起一个执行 `daemon restart` 的后台子进程；父进程已等过，
  // 子进程静默跳过，别再往守护日志写一行「守护进程未运行」。标记只消费一次，读完立即删除，
  // 避免进程把标记带到后续执行或泄露给派生的 Agent。
  if (process.env[RESTART_DRAINED_ENV] === '1') {
    delete process.env[RESTART_DRAINED_ENV];
    return { ok: true };
  }

  const warn = deps.warn ?? defaultWarn;
  const timeoutSeconds = parseDrainTimeoutSeconds(options.drainTimeout);
  if (timeoutSeconds === undefined) return invalidDrainTimeout(options);

  const inspection = inspectDaemon(dir);
  if (inspection.status === 'stale') {
    warn('守护进程未运行，跳过任务等待，继续执行重启。');
    return { ok: true };
  }
  if (inspection.status === 'unverifiable') {
    warn('守护进程身份无法验证，跳过任务等待，继续执行重启。');
    return { ok: true };
  }
  return await holdAndWait(state, timeoutSeconds, deps);
}

/** deploy 与 `restart --unit` 用：目标不是某个守护状态目录，地址和数据库由调用方给出。 */
export async function drainRuntime(endpoint: RuntimeEndpoint, options: Pick<CliOptions, 'force' | 'drainTimeout'>, deps: DaemonCommandDeps): Promise<DrainResult> {
  if (options.force) return { ok: true };
  const timeoutSeconds = parseDrainTimeoutSeconds(options.drainTimeout);
  if (timeoutSeconds === undefined) return invalidDrainTimeout(options);
  return await holdAndWait(endpoint, timeoutSeconds, deps);
}

/**
 * 先让服务进入排空（新消息照常入队，但不开始新的轮次），再每 5 秒查一次正在执行的任务数：
 * - 归零：返回 ok 与 release，排空保持到旧进程退出；
 * - 查询失败：退出排空并拒绝重启——不知道有没有任务在跑，就不能停旧进程；
 * - 超时仍有任务、或等待中被 Ctrl-C：退出排空，旧进程照常服务。
 * 服务不支持排空（旧版本返回 404）时只告警，照旧等待。
 */
async function holdAndWait(endpoint: RuntimeEndpoint | undefined, timeoutSeconds: number, deps: DaemonCommandDeps): Promise<DrainResult> {
  const warn = deps.warn ?? defaultWarn;
  const info = deps.info ?? defaultInfo;

  const localAddresses = deps.localAddresses ?? (() => Object.values(networkInterfaces()).flatMap(entries => entries?.map(entry => entry.address) ?? []));
  const parsedUrl = resolveLocalUrl(endpoint?.address, localAddresses);
  if (!parsedUrl) {
    return { ok: false, runningTasks: 0, error: refuseWithoutStatus(`守护进程监听地址（${endpoint?.address ?? '未记录'}）不可用于本机查询`) };
  }

  // 在 dutydeck 托管的 Agent 里执行 restart 时，Agent 自己那轮必然 running；
  // 通过它注入的 dutydeck_session_id 把本会话从计数里排除，否则一定等满超时。
  const excludeSessionId = deps.excludeSessionId ?? process.env.dutydeck_session_id;
  if (excludeSessionId) {
    info(`检测到当前运行在 Agent 会话 ${excludeSessionId} 中，查询任务数时已排除该会话。`);
  }

  let token: string | undefined;
  if (endpoint?.authEnabled !== false && endpoint?.database) {
    token = (deps.readToken ?? defaultReadToken)(endpoint.database);
  }

  const fetcher = deps.fetch ?? fetch;
  const requestTimeoutMs = deps.requestTimeoutMs ?? ACTIVITY_REQUEST_TIMEOUT_MS;
  const request = async (url: URL, body?: unknown): Promise<{ ok: true; data: any } | { ok: false; status?: number; error: string }> => {
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      };
      const response = await fetcher(url.toString(), {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(requestTimeoutMs)
      });
      if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}` };
      return { ok: true, data: await response.json() };
    } catch (error: any) {
      return { ok: false, error: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? `查询超时（${requestTimeoutMs} ms）` : (error?.message || String(error)) };
    }
  };
  const queryRunningTasks = async (): Promise<{ ok: true; runningTasks: number } | { ok: false; error: string }> => {
    const url = new URL('/api/system/activity', parsedUrl.origin);
    if (excludeSessionId) url.searchParams.set('excludeSessionId', excludeSessionId);
    const result = await request(url);
    if (!result.ok) return result;
    const data = result.data;
    if (typeof data?.runningTasks !== 'number' || !Number.isSafeInteger(data.runningTasks) || data.runningTasks < 0) {
      return { ok: false, error: '接口返回数据格式错误' };
    }
    return { ok: true, runningTasks: data.runningTasks };
  };
  const setDrain = (draining: boolean) => request(new URL('/api/system/drain', parsedUrl.origin), draining ? { draining, leaseSeconds: DRAIN_LEASE_SECONDS } : { draining });

  const hold = await setDrain(true);
  if (!hold.ok) {
    warn(hold.status === 404 ? '当前服务版本不支持排空，等待期间仍可能开始新的任务。' : `进入排空失败（${hold.error}），等待期间仍可能开始新的任务。`);
  }
  const release = hold.ok ? async () => { await setDrain(false); } : undefined;
  const renew = hold.ok ? async () => { await setDrain(true); } : undefined;
  const refuse = async (error: string, runningTasks: number): Promise<DrainResult> => {
    await release?.();
    return { ok: false, error, runningTasks };
  };

  const initial = await queryRunningTasks();
  if (!initial.ok) return await refuse(refuseWithoutStatus(`查询正在执行的任务数失败（${initial.error}）`), 0);
  if (initial.runningTasks === 0) return { ok: true, release, renew };

  info(`有 ${initial.runningTasks} 个任务正在执行，等它们结束后再重启（最长 ${timeoutSeconds} 秒；加 --force 立即重启）${hold.ok ? '。等待期间新消息照常排队，重启后由新进程执行' : ''}`);

  const sleeper = deps.sleep ?? sleep;
  const timer = deps.now ?? Date.now;
  const deadline = timer() + timeoutSeconds * 1000;
  let currentRunning = initial.runningTasks;
  // 等待中被 Ctrl-C / kill：先退出排空再退出，别让队列停到租约到期。
  const onSignal = () => { void (release?.() ?? Promise.resolve()).finally(() => process.exit(130)); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    while (currentRunning > 0) {
      await sleeper(DRAIN_INTERVAL_MS);
      if (hold.ok) await setDrain(true);
      const current = await queryRunningTasks();
      if (!current.ok) return await refuse(refuseWithoutStatus(`查询正在执行的任务数失败（${current.error}）`), currentRunning);
      currentRunning = current.runningTasks;
      if (currentRunning === 0) break;
      if (timer() >= deadline) {
        return await refuse(`等待正在执行的任务结束超时（${timeoutSeconds} 秒），旧服务仍在运行（当前仍有 ${currentRunning} 个任务正在执行）。若确认可以中断这些任务，请使用 dutydeck restart --force 强制重启。`, currentRunning);
      }
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  return { ok: true, release, renew };
}

export interface DaemonCommandHandlers extends DaemonCommandDeps {
  serve(options: CliOptions, onReady?: () => void): Promise<void> | void;
}

export function daemonRestartOptions(options: CliOptions, previousState?: DaemonState, env: NodeJS.ProcessEnv = {}): CliOptions {
  const inheritedAuth = previousState?.authEnabled === false
    ? false
    : previousState?.authEnabled === true
      ? true
      : env[RESTART_AUTH_ENV] === 'false'
        ? false
        : env[RESTART_AUTH_ENV] === 'true'
          ? true
          : undefined;
  return {
    ...options,
    ...(options.cwd === undefined && (previousState?.cwd ?? env[RESTART_CWD_ENV]) ? { cwd: previousState?.cwd ?? env[RESTART_CWD_ENV] } : {}),
    ...(options.database === undefined && (previousState?.database ?? env[RESTART_DATABASE_ENV]) ? { database: previousState?.database ?? env[RESTART_DATABASE_ENV] } : {}),
    ...(options.host === undefined && (previousState?.host ?? env[RESTART_HOST_ENV]) ? { host: previousState?.host ?? env[RESTART_HOST_ENV] } : {}),
    ...(options.port === undefined && (previousState?.port ?? env[RESTART_PORT_ENV]) ? { port: String(previousState?.port ?? env[RESTART_PORT_ENV]) } : {}),
    ...(options.auth === undefined && inheritedAuth !== undefined ? { auth: inheritedAuth } : {})
  };
}

/** Mark the running daemon as ready and refresh its live metadata. */
export function markDaemonReady(dir: string, patch: Partial<Pick<DaemonState, 'host' | 'port' | 'address' | 'database' | 'authEnabled'>> = {}, startedAt = childMeta().startedAt): void {
  const previous = readDaemonStatus(dir);
  const processIdentity = currentProcessIdentity();
  const ownPrevious = previous?.pid === process.pid && previous.startedAt === startedAt && sameIdentity(previous.processIdentity, processIdentity) ? previous : undefined;
  if (previous && !ownPrevious) throw new Error('Daemon state was replaced before readiness; replacement record preserved.');
  if (inspectDaemon(dir).status === 'unverifiable') throw new Error('Daemon state cannot be verified before readiness; existing record preserved.');
  writeState(dir, {
    ...ownPrevious,
    pid: process.pid,
    ready: true,
    startedAt,
    processIdentity,
    cwd: ownPrevious?.cwd ?? process.cwd(),
    ...patch
  });
}

/**
 * Entry point for `dutydeck start`. From the foreground it re-spawns the
 * server as a detached daemon then exits; inside the detached child (signalled
 * via `DUTYDECK_DAEMONIZED`) it records self metadata and serves in-band.
 *
 * `--foreground`（systemd unit 的 ExecStart）：本进程自己就是 daemon，和 detached 子进程一样
 * 在当前目录写状态文件并服务，另外记下托管它的 unit。Linux 上装了新模板 unit 时，普通的
 * `start` 改为 `systemctl --user start`，不在 unit 之外再起一个没人管的进程；`viaSystemd`
 * 只在 restart 延续一个 detached daemon 时传 false。
 */
export async function daemonStart(options: CliOptions, handlers: DaemonCommandHandlers, env: NodeJS.ProcessEnv = process.env, viaSystemd = true): Promise<DaemonCommandResult> {
  const invocationCwd = process.cwd();
  const foreground = options.foreground === true && !isDaemonChild(env);
  const inBand = isDaemonChild(env) || foreground;
  const dir = inBand ? defaultDaemonDir(invocationCwd) : resolveDaemonDir(invocationCwd, env.HOME);
  const cwd = inBand ? invocationCwd : resolve(dir, '../..');
  const database = resolve(cwd, options.database ?? '.dutydeck/dutydeck.db');

  // 托管声明只给前台入口自己用：读完就从 process.env 删掉。否则它派生的 Agent 会继承，Agent 在沙箱里
  // 跑 `start --foreground` 时，沙箱 daemon 会把自己登记成由生产 unit 托管。
  const supervision = foreground ? systemdSupervisionFromEnv(env) : {};
  if (foreground) {
    delete process.env[SUPERVISOR_ENV];
    delete process.env[SYSTEMD_UNIT_ENV];
    // 前台入口没有父进程替它把关：先做父进程那套防重复启动检查，再按子进程的方式发布状态。
    const current = readDaemonStatus(dir);
    const inspection = inspectDaemon(dir);
    if (inspection.status === 'unverifiable') return unverifiedResult('start', inspection);
    if (inspection.status === 'verified') return alreadyRunningResult(current);
    // unit 的根目录在 enable 时就定了（比如还没有指针时定在 HOME）。这里还没有数据库、指针却指向
    // 别处时，用户的数据多半在那边：别在这里建一份空库、再把指针改过来。
    const pointed = readLastDaemonDir(env.HOME);
    if (!existsSync(database) && pointed && pointed !== dir && existsSync(pointed)) {
      return { ok: false, action: 'start', running: false,
        error: `unit 托管的根目录 ${cwd} 还没有数据库，而 last-daemon-dir 指向 ${pointed}；为免另建一份空库，已拒绝启动。若 daemon 应在后者运行，重跑 dutydeck autostart enable（它按指针改写 unit 的根目录）；若确实要在 ${cwd} 新建，先删掉指针文件再启动。` };
    }
    if (!clearGeneration(dir, current)) return changedResult('start');
  }

  if (inBand) {
    // 无论是 foreground 还是 detached 子进程，服务进程在派生任何 Agent 之前必须删除此标记，
    // 避免 Agent 继承后执行 restart 被跳过等待。与 SUPERVISOR_ENV 的清理机制一致。
    delete process.env[RESTART_DRAINED_ENV];
    delete env[RESTART_DRAINED_ENV];
    // We are the daemon process (detached child or foreground entry): own the server and publish self metadata.
    const meta = foreground ? { startedAt: new Date().toISOString() } : childMeta(env);
    const processIdentity = currentProcessIdentity();
    const initialState: DaemonState = {
      pid: process.pid,
      processIdentity,
      ready: false,
      startedAt: meta.startedAt,
      cwd,
      database,
      ...addressFromCli(options, env),
      // 托管声明只认前台入口：detached 子进程可能从 systemd 下的上一代继承到这些环境变量。
      ...supervision
    };
    const inspection = inspectDaemon(dir);
    if (inspection.status === 'unverifiable') return unverifiedResult('start', inspection);
    const previous = readDaemonStatus(dir);
    if (previous && !sameGeneration(previous, initialState)) return changedResult('start');
    writePidFile(dir, process.pid);
    writeState(dir, initialState);
    writeLastDaemonDir(dir, env.HOME);
    await handlers.serve({ ...options, database }, () => markDaemonReady(dir, { ...addressFromCli(options, env), database }, meta.startedAt));
    const authEnabled = authEnabledFromCli(options, env);
    return { ok: true, action: 'start', running: true, pid: process.pid, authEnabled, authentication: authEnabled ? 'required' : 'disabled' };
  }

  // Foreground parent: refuse to double-start.
  const current = readDaemonStatus(dir);
  const inspection = inspectDaemon(dir);
  if (inspection.status === 'unverifiable') return unverifiedResult('start', inspection);
  if (inspection.status === 'verified') return alreadyRunningResult(current);

  if (viaSystemd) {
    const target = await systemdStartTarget(cwd, handlers, env);
    if (target) return await systemdStart(target.unit, target.info, options, dir, handlers);
  }

  const startedAt = new Date().toISOString();
  if (!clearGeneration(dir, current)) return changedResult('start');
  // 先记下日志长度，失败时只回放这次启动新写入的行（日志是 append 的）。
  const logOffset = daemonLogSize(dir);
  const child = daemonize({ cwd, startedAt, env });
  return await waitUntilReady(dir, startedAt, child, logOffset);
}

/**
 * 等到子进程「就绪」或「死掉」，两者以先到者为准。
 *
 * 早前这里只轮询就绪标记，且父进程其实已被 daemonize-process 提前 exit(0)，于是
 * 端口被占用这类失败完全无人报告。现在同时盯住子进程的 exit：它带非零码退出就
 * 立即失败，并把守护日志末尾几行作为原因带回去——用户不必自己去翻日志。
 */
async function waitUntilReady(dir: string, startedAt: string, child: DaemonChildHandle, logOffset = 0): Promise<DaemonCommandResult> {
  let childExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  void child.exited.then(result => { childExit = result; });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = readDaemonStatus(dir);
    if (!childExit && child.processIdentity && state?.pid === child.pid && state.startedAt === startedAt &&
      sameIdentity(state.processIdentity, child.processIdentity) && state.ready && inspectDaemonState(state).status === 'verified') {
      const authEnabled = state.authEnabled !== false;
      return { ok: true, action: 'start', running: true, pid: state.pid, address: state.address, authEnabled, authentication: authEnabled ? 'required' : 'disabled', logFile: daemonPaths(dir).logFile, state: 'started' };
    }
    // 子进程已经退出且没留下就绪状态 —— 它是起崩了，别再等满 15 秒。
    if (childExit !== undefined) {
      const reason = tailDaemonLog(dir, 3, logOffset);
      const detail = reason.length > 0 ? `原因：${reason.join('；')}` : '守护日志中没有更多线索。';
      const how = childExit.signal ? `被信号 ${childExit.signal} 终止` : `退出码 ${childExit.code ?? '未知'}`;
      return {
        ok: false,
        action: 'start',
        running: false,
        state: 'not-running',
        logFile: daemonPaths(dir).logFile,
        error: `后台服务启动后立即退出（${how}）。${detail}`
      };
    }
    await sleep(200);
  }
  return { ok: false, action: 'start', running: false, logFile: daemonPaths(dir).logFile, error: 'Daemon did not report verified readiness within the timeout. Inspect its state and log before retrying.' };
}

function alreadyRunningResult(current: DaemonState | undefined): DaemonCommandResult {
  return { ok: false, action: 'start', running: true, pid: current?.pid, state: 'already-running', error: `Dutydeck is already running (pid ${current?.pid}). Use 'dutydeck status' or 'dutydeck restart'.` };
}

function unverifiedResult(action: DaemonCommandResult['action'], inspection: DaemonInspection): DaemonCommandResult {
  return { ok: false, action, running: false, pid: inspection.pid, processStatus: 'unverifiable',
    error: `Daemon identity cannot be verified: ${inspection.reason}. Inspect the recorded PID and daemon state manually before starting or stopping it.` };
}

function changedResult(action: DaemonCommandResult['action']): DaemonCommandResult {
  return { ok: false, action, running: false, error: 'Daemon state changed during this operation; the replacement record was preserved. Inspect dutydeck status before retrying.' };
}

/** Recheck both the disk generation and process identity before every signal and poll. */
export async function daemonStop(deps: DaemonCommandDeps = {}): Promise<DaemonCommandResult> {
  const dir = resolveDaemonDir();
  const state = readDaemonStatus(dir);
  // 受 systemd 托管（Restart=always）的 daemon 直接发信号会被立刻重拉，交给 systemctl 停。
  const supervised = await systemdSupervisor(dir, state, deps);
  if (supervised && 'error' in supervised) return { ok: false, action: 'stop', running: true, pid: state?.pid, error: supervised.error };
  if (supervised) return await systemdStop(dir, state!, supervised.unit, deps);
  // 崩溃后 unit 正在 RestartSec 间隙里等着重拉：状态已经 stale，但 systemd 马上会再拉起一代，同样交给 systemctl stop。
  const pending = await pendingSystemdRestart(dir, state, deps);
  if (pending) return await systemdStop(dir, state!, pending, deps);
  const inspect = (): DaemonInspection | undefined => {
    const inspection = inspectDaemon(dir);
    if (inspection.status === 'unverifiable') return inspection;
    return sameGeneration(state, readDaemonStatus(dir)) ? inspection : undefined;
  };
  const finish = (stopped: boolean): DaemonCommandResult => clearGeneration(dir, state)
    ? { ok: true, action: 'stop', running: false, pid: state?.pid, state: stopped ? 'stopped' : 'not-running' }
    : changedResult('stop');
  const check = (stopped: boolean): DaemonCommandResult | undefined => {
    const inspection = inspect();
    if (!inspection) return changedResult('stop');
    if (inspection.status === 'unverifiable') return unverifiedResult('stop', inspection);
    if (inspection.status === 'stale') return finish(stopped);
    return undefined;
  };
  let result = check(false);
  if (result) return result;
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    result = check(signal === 'SIGKILL');
    if (result) return result;
    try {
      process.kill(state!.pid, signal);
    } catch {
      return { ok: false, action: 'stop', running: inspectDaemon(dir).status === 'verified', pid: state?.pid, error: `Failed to send ${signal} to pid ${state?.pid}; daemon state preserved.` };
    }
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      result = check(true);
      if (result) return result;
      await sleep(200);
    }
  }
  return { ok: false, action: 'stop', running: true, pid: state?.pid, error: 'Daemon did not exit after SIGKILL; daemon state preserved.' };
}

/** `dutydeck restart`: stop, then start again. */
export async function daemonRestart(options: CliOptions, handlers: DaemonCommandHandlers, env: NodeJS.ProcessEnv = process.env): Promise<DaemonCommandResult> {
  if (options.unit) return await unitRestart(options.unit, options, handlers);
  // Resolve the currently running daemon's directory so we can restart it in
  // the same working directory (important when the user runs `restart` from a
  // different directory than where the daemon was started).
  const runningDir = resolveDaemonDir();
  const previousState = readDaemonStatus(runningDir);
  // 受 systemd 托管：交给 systemctl restart，由 unit 的 ExecStart 拉起新一代。
  const supervised = await systemdSupervisor(runningDir, previousState, handlers);
  if (supervised && 'error' in supervised) return { ok: false, action: 'restart', running: true, pid: previousState?.pid, error: supervised.error };
  if (supervised) return await systemdRestart(runningDir, previousState!, supervised.unit, supervised.info, options, handlers);
  // 没有 daemon 在跑、上一代也是 unit 拉起的（或没有记录）时，restart 就是 start：交给 systemd，
  // host / port 由 unit 自己的配置（根目录 .env）决定。上一代是 detached daemon 时照旧走下面的
  // detached 重启，沿用它记录的 host / port / auth。
  if (inspectDaemon(runningDir).status === 'stale' && (!previousState || previousState.supervisor === 'systemd')) {
    const target = await systemdStartTarget(resolve(runningDir, '../..'), handlers, env);
    if (target) {
      const started = await systemdStart(target.unit, target.info, options, runningDir, handlers);
      return started.ok ? { ...started, action: 'restart', state: 'restarted' } : { ...started, action: 'restart' };
    }
  }
  const previousCwd = previousState?.cwd;
  const restartOptions = daemonRestartOptions(options, previousState, env);
  const restartEnv = {
    ...env,
    ...(restartOptions.cwd ? { [RESTART_CWD_ENV]: restartOptions.cwd } : {}),
    ...(restartOptions.database ? { [RESTART_DATABASE_ENV]: restartOptions.database } : {}),
    ...(restartOptions.host ? { [RESTART_HOST_ENV]: restartOptions.host } : {}),
    ...(restartOptions.port ? { [RESTART_PORT_ENV]: restartOptions.port } : {}),
    ...(restartOptions.auth !== undefined ? { [RESTART_AUTH_ENV]: String(restartOptions.auth) } : {})
  };
  // 新 daemon 由当前解释器派生（daemonize 用 process.execPath）：停旧进程之前先在本进程里
  // 真的打开一次 SQLite，ABI 不匹配就拒绝，别等旧进程被停掉、新进程打开数据库才崩。
  const sqlite = (handlers.checkSqlite ?? checkSqliteDriver)();
  if (!sqlite.ok) {
    const running = inspectDaemon(runningDir).status === 'verified';
    return { ok: false, action: 'restart', running, pid: previousState?.pid,
      error: `SQLite 预检失败，已拒绝重启${running ? '，旧的守护进程仍在运行' : ''}。${describeSqliteDriverFailure(sqlite)}。换一个能加载该驱动的 node（写绝对路径）重跑 dutydeck restart。` };
  }
  const drain = await waitForRunningTasksDrain(runningDir, previousState, options, handlers);
  if (!drain.ok) {
    return { ok: false, action: 'restart', running: true, pid: previousState?.pid, error: drain.error };
  }
  // 父进程已完成 drain：daemonize 出的 restart 子进程继承此标记，静默跳过第二次等待检查，
  // 否则旧进程已停、它会往守护日志再写一行「守护进程未运行」，挤掉启动失败时的关键日志。
  (restartEnv as Record<string, string>)[RESTART_DRAINED_ENV] = '1';
  const stopped = await daemonStop(handlers);
  if (!stopped.ok) {
    await drain.release?.();
    return { ...stopped, action: 'restart' };
  }
  if (previousCwd && previousCwd !== process.cwd()) {
    process.chdir(previousCwd);
  }
  // 延续一个不受 systemd 托管的 daemon：start 阶段不改道 systemd。
  const started = await daemonStart(restartOptions, handlers, restartEnv, false);
  return started.ok && started.running
    ? { ...started, action: 'restart' as const, state: 'restarted' as const }
    : { ok: false, action: 'restart' as const, running: false, state: 'not-running' as const, error: started.error };
}

// ─── systemd 托管 ────────────────────────────────────────────────────────────

/** `systemctl --user show` 里用得到的几项。 */
interface SystemdUnitInfo {
  loaded: boolean;
  subState?: string;
  mainPid?: number;
  environment: string[];
  workingDirectory?: string;
  /** ExecStart 的解释器与入口脚本：新 daemon 实际由它们运行。 */
  execPath?: string;
  script?: string;
  /** ExecStart 里入口脚本之后的参数，例如 `start --foreground` 或 `--port 4311`。 */
  args: string[];
  /** unit 文件路径（FragmentPath）。 */
  fragmentPath?: string;
}

function firstLine(value: string): string {
  return value.trim().split('\n')[0]?.trim() ?? '';
}

/** unit 不存在时 LoadState=not-found；systemctl 不可用或连不上 user systemd 时返回 undefined。 */
async function showSystemdUnit(unit: string, deps: DaemonCommandDeps): Promise<SystemdUnitInfo | undefined> {
  const shown = await (deps.runCommand ?? defaultRunCommand)('systemctl', ['--user', 'show', unit, '--property=LoadState,SubState,MainPID,Environment,WorkingDirectory,ExecStart,FragmentPath']);
  if (shown.status !== 0) return undefined;
  const props = new Map<string, string>();
  for (const line of shown.stdout.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) props.set(line.slice(0, at), line.slice(at + 1));
  }
  // ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /x/dist/cli.js start --foreground ; ignore_errors=no ; ... }
  const exec = /path=(.*?) ; argv\[\]=(.*?) ; /.exec(props.get('ExecStart') ?? '');
  const mainPid = Number(props.get('MainPID'));
  return {
    loaded: props.get('LoadState') === 'loaded',
    subState: props.get('SubState'),
    mainPid: Number.isSafeInteger(mainPid) && mainPid > 0 ? mainPid : undefined,
    environment: (props.get('Environment') ?? '').split(/\s+/).filter(Boolean),
    workingDirectory: props.get('WorkingDirectory') || undefined,
    execPath: exec?.[1],
    script: exec?.[2]?.split(' ')[1],
    args: exec?.[2]?.split(' ').slice(2) ?? [],
    fragmentPath: props.get('FragmentPath') || undefined
  };
}

function systemdSupervisionFromEnv(env: NodeJS.ProcessEnv): Pick<DaemonState, 'supervisor' | 'systemdUnit'> {
  const unit = env[SYSTEMD_UNIT_ENV];
  return env[SUPERVISOR_ENV] === 'systemd' && unit ? { supervisor: 'systemd', systemdUnit: unit } : {};
}

/**
 * 正在运行的 daemon 是否受 systemd 托管：状态文件里有前台入口记下的 unit、身份校验通过、
 * 且 systemd 报告该 unit 的 MainPID 正是它。三者都满足才改走 systemctl；记录了托管却无法
 * 向 systemd 核实时返回 error，调用方不做任何改动。
 */
async function systemdSupervisor(dir: string, state: DaemonState | undefined, deps: DaemonCommandDeps): Promise<{ unit: string; info: SystemdUnitInfo } | { error: string } | undefined> {
  if ((deps.platform ?? process.platform) !== 'linux') return undefined;
  if (state?.supervisor !== 'systemd' || !state.systemdUnit || inspectDaemonState(state).status !== 'verified') return undefined;
  const unit = state.systemdUnit;
  const info = await showSystemdUnit(unit, deps);
  if (!info) {
    return { error: `守护进程（pid ${state.pid}）由 systemd unit ${unit} 托管，但 systemctl --user show ${unit} 失败，连不上 user systemd。它配置了 Restart=always，直接发信号会被立刻重拉，所以没有做任何改动。请在能连上 user systemd 的会话里重试（通常需要 XDG_RUNTIME_DIR=/run/user/$(id -u)）。` };
  }
  // unit 文件被删并 daemon-reload 后，还在跑的 unit 变成 not-found：Restart 回到 no、读不到 ExecStart，
  // 不会再重拉，照旧由 CLI 直接发信号 / detached 重启。`autostart disable` 在新模板 unit 运行时会拒绝，
  // 所以只有手工删文件才会走到这里。KillMode 这时也回到了 control-group：daemon 一退出，systemd 就清掉
  // unit cgroup 里剩下的进程（包括落在里面的 tmux），走哪条路都一样；要保住 tmux，先重跑
  // `dutydeck autostart enable` 恢复 unit，再 stop。
  if (!info.loaded) return undefined;
  if (info.mainPid !== state.pid) {
    return { error: `状态文件记录守护进程（pid ${state.pid}）由 ${unit} 托管，但 systemd 报告该 unit 的 MainPID 是 ${info.mainPid ?? '无'}。两边对不上，为免误停其他进程，没有做任何改动；请用 systemctl --user status ${unit} 和 dutydeck status 核对。` };
  }
  return { unit, info };
}

/**
 * 普通 `dutydeck start` 是否交给 systemd：Linux 上装了新模板 unit（带托管声明），且它的
 * WorkingDirectory 正是这次要启动的 daemon 根目录。旧 oneshot unit、systemctl 不可用、unit
 * 托管的是别的根目录（比如测试用的临时 HOME）都照旧走 detached。
 */
async function systemdStartTarget(root: string, deps: DaemonCommandDeps, env: NodeJS.ProcessEnv): Promise<{ unit: string; info: SystemdUnitInfo } | undefined> {
  const unit = env[SYSTEMD_UNIT_ENV] || AUTOSTART_LINUX_UNIT;
  const info = await ownedSystemdUnit(unit, root, deps);
  return info ? { unit, info } : undefined;
}

/** unit 已加载、带托管声明、且 WorkingDirectory 正是 root：它拉起的就是这个根目录的 daemon。 */
async function ownedSystemdUnit(unit: string, root: string, deps: DaemonCommandDeps): Promise<SystemdUnitInfo | undefined> {
  if ((deps.platform ?? process.platform) !== 'linux') return undefined;
  const info = await showSystemdUnit(unit, deps);
  if (!info?.loaded || info.workingDirectory !== root) return undefined;
  if (!info.environment.includes(`${SUPERVISOR_ENV}=systemd`) || !info.environment.includes(`${SYSTEMD_UNIT_ENV}=${unit}`)) return undefined;
  return info;
}

/** 状态记录的托管 daemon 已经死了，但它的 unit 仍在运行或等待重拉（auto-restart）：返回该 unit。 */
async function pendingSystemdRestart(dir: string, state: DaemonState | undefined, deps: DaemonCommandDeps): Promise<string | undefined> {
  if (state?.supervisor !== 'systemd' || !state.systemdUnit || inspectDaemonState(state).status !== 'stale') return undefined;
  const info = await ownedSystemdUnit(state.systemdUnit, resolve(dir, '../..'), deps);
  return info && info.subState !== 'dead' && info.subState !== 'failed' ? state.systemdUnit : undefined;
}

function systemctlFailure(verb: string, unit: string, output: AutostartCommandOutput): string {
  const detail = firstLine(output.stderr) || firstLine(output.stdout) || (output.status === null ? 'systemctl 无法执行' : `退出码 ${output.status}`);
  return `systemctl --user ${verb} ${unit} 失败：${detail}。查看：systemctl --user status ${unit}；若提示启动过于频繁（start-limit-hit），先排查日志，再执行 systemctl --user reset-failed ${unit}。`;
}

/** 新进程按 unit 的 ExecStart 启动，命令行上的服务参数传不过去；显式给了就拒绝，不静默丢弃。 */
function explicitServerFlags(options: CliOptions): string[] {
  return Object.entries(options)
    .filter(([key, value]) => value !== undefined
      && key !== 'json'
      && key !== 'foreground'
      && key !== 'force'
      && key !== 'drainTimeout'
      && key !== 'unit'
      && !(key === 'larkListen' && value === true))
    .map(([key, value]) => key === 'auth' && value === false ? '--no-auth'
      : key === 'larkListen' ? '--no-lark-listen'
        : `--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`);
}

function refuseExplicitFlags(action: 'start' | 'restart', unit: string, options: CliOptions, dir: string, pid?: number): DaemonCommandResult | undefined {
  const flags = explicitServerFlags(options);
  if (flags.length === 0) return undefined;
  return { ok: false, action, running: action === 'restart', pid,
    error: `Dutydeck 由 systemd unit ${unit} 托管，新进程按 unit 的 ExecStart 启动，命令行参数 ${flags.join(' ')} 传不过去。请把配置写进 ${resolve(dir, '../..', '.env')}（如 DUTYDECK_PORT、DUTYDECK_HOST）后不带参数重试。` };
}

/** systemctl start / restart 返回后，等到新一代由 systemd 托管的 daemon 就绪并通过身份校验。 */
async function waitForSystemdGeneration(action: 'start' | 'restart', unit: string, dir: string, previous: DaemonState | undefined, logOffset: number): Promise<DaemonCommandResult> {
  const logFile = daemonPaths(dir).logFile;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = readDaemonStatus(dir);
    if (state?.ready && state.supervisor === 'systemd' && state.systemdUnit === unit && !sameGeneration(state, previous) && inspectDaemonState(state).status === 'verified') {
      const authEnabled = state.authEnabled !== false;
      return { ok: true, action, running: true, pid: state.pid, address: state.address, authEnabled, authentication: authEnabled ? 'required' : 'disabled', logFile, state: action === 'restart' ? 'restarted' : 'started' };
    }
    await sleep(200);
  }
  const reason = tailDaemonLog(dir, 3, logOffset);
  const running = inspectDaemon(dir).status === 'verified';
  return { ok: false, action, running, logFile,
    ...(action === 'restart' && !running ? { state: 'not-running' as const } : {}),
    error: `systemctl --user ${action} ${unit} 已返回，但 ${READY_TIMEOUT_MS / 1000} 秒内没有等到新的守护进程就绪并通过身份校验。${reason.length > 0 ? `原因：${reason.join('；')}。` : ''}查看：systemctl --user status ${unit}` };
}

async function systemdStart(unit: string, info: SystemdUnitInfo, options: CliOptions, dir: string, deps: DaemonCommandDeps): Promise<DaemonCommandResult> {
  const refused = refuseExplicitFlags('start', unit, options, dir);
  if (refused) return refused;
  const logFile = daemonPaths(dir).logFile;
  // 旧 oneshot unit 被改写并 daemon-reload 后仍停在 active (exited)：systemctl start 对它是空操作。
  if (info.subState === 'exited') {
    return { ok: false, action: 'start', running: false, logFile,
      error: `unit ${unit} 还停在旧 oneshot 留下的 active (exited) 状态，systemctl start 不会拉起新进程。确认旧守护进程已停止（dutydeck status）后执行：systemctl --user restart ${unit}` };
  }
  // 新进程由 unit 的 ExecStart 拉起：它的解释器加载不了 SQLite 就别交给 systemd 反复重拉。
  if (info.execPath) {
    const sqlite = (deps.checkSqlite ?? checkSqliteDriver)({ execPath: info.execPath, ...(info.script ? { resolveFrom: info.script } : {}) });
    if (!sqlite.ok) {
      return { ok: false, action: 'start', running: false, logFile,
        error: `SQLite 预检失败，没有启动。${describeSqliteDriverFailure(sqlite)}。unit ${unit} 的 ExecStart 用的就是这个解释器：换成能加载该驱动的 node，用它重跑 dutydeck autostart enable 改写 unit 后再启动。` };
    }
  }
  const previous = readDaemonStatus(dir);
  const logOffset = daemonLogSize(dir);
  const started = await (deps.runCommand ?? defaultRunCommand)('systemctl', ['--user', 'start', unit]);
  if (started.status !== 0) return { ok: false, action: 'start', running: false, logFile, error: systemctlFailure('start', unit, started) };
  return await waitForSystemdGeneration('start', unit, dir, previous, logOffset);
}

async function systemdStop(dir: string, state: DaemonState, unit: string, deps: DaemonCommandDeps): Promise<DaemonCommandResult> {
  const stopped = await (deps.runCommand ?? defaultRunCommand)('systemctl', ['--user', 'stop', unit]);
  if (stopped.status !== 0) {
    return { ok: false, action: 'stop', running: inspectDaemon(dir).status === 'verified', pid: state.pid, error: systemctlFailure('stop', unit, stopped) };
  }
  // systemctl stop 等停止任务结束才返回；仍按状态文件核验旧进程确实已经退出。
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = readDaemonStatus(dir);
    const inspection = inspectDaemon(dir);
    if (inspection.status === 'unverifiable') return unverifiedResult('stop', inspection);
    if (inspection.status === 'stale') {
      // 在重拉间隙里 stop 时，unit 可能刚拉起过新一代，它也随 unit 停掉了；别的来源写下的记录保留。
      const ours = !current || sameGeneration(current, state) || (current.supervisor === 'systemd' && current.systemdUnit === unit);
      return ours && clearGeneration(dir, current) ? { ok: true, action: 'stop', running: false, pid: state.pid, state: 'stopped' } : changedResult('stop');
    }
    if (!sameGeneration(current, state)) return changedResult('stop');
    await sleep(200);
  }
  return { ok: false, action: 'stop', running: true, pid: state.pid, error: `systemctl --user stop ${unit} 已返回，但守护进程（pid ${state.pid}）仍在运行，状态已保留。查看：systemctl --user status ${unit}` };
}

async function systemdRestart(dir: string, state: DaemonState, unit: string, info: SystemdUnitInfo, options: CliOptions, deps: DaemonCommandDeps): Promise<DaemonCommandResult> {
  const refused = refuseExplicitFlags('restart', unit, options, dir, state.pid);
  if (refused) return refused;
  // unit 被 autostart enable 改写到别的根目录后，restart 会在那边拉起新进程，这里只会空等。
  const root = resolve(dir, '../..');
  if (info.workingDirectory !== root) {
    return { ok: false, action: 'restart', running: true, pid: state.pid,
      error: `unit ${unit} 现在托管的根目录是 ${info.workingDirectory ?? '（未设置）'}，不是正在运行的 ${root}（unit 被 autostart enable 改写过）。已拒绝重启，旧的守护进程仍在运行；先 dutydeck stop，再到要用的根目录下 dutydeck start。` };
  }
  // 新一代由 unit 的 ExecStart 拉起：检查的是 ExecStart 里的解释器（驱动从它的入口脚本解析），
  // 不是当前 CLI 自己。
  if (!info.execPath) {
    return { ok: false, action: 'restart', running: true, pid: state.pid, error: `读不到 ${unit} 的 ExecStart，无法确认新进程能否加载 SQLite；已拒绝重启，旧的守护进程仍在运行。` };
  }
  const sqlite = (deps.checkSqlite ?? checkSqliteDriver)({ execPath: info.execPath, ...(info.script ? { resolveFrom: info.script } : {}) });
  if (!sqlite.ok) {
    return { ok: false, action: 'restart', running: true, pid: state.pid,
      error: `SQLite 预检失败，已拒绝重启，旧的守护进程仍在运行。${describeSqliteDriverFailure(sqlite)}。unit ${unit} 的 ExecStart 用的就是这个解释器：换成能加载该驱动的 node，用它重跑 dutydeck autostart enable 改写 unit 后再重启。` };
  }
  const drain = await waitForRunningTasksDrain(dir, state, options, deps);
  if (!drain.ok) {
    return { ok: false, action: 'restart', running: true, pid: state.pid, error: drain.error };
  }
  const logOffset = daemonLogSize(dir);
  const restarted = await (deps.runCommand ?? defaultRunCommand)('systemctl', ['--user', 'restart', unit]);
  if (restarted.status !== 0) {
    await drain.release?.();
    return { ok: false, action: 'restart', running: inspectDaemon(dir).status === 'verified', pid: state.pid, error: systemctlFailure('restart', unit, restarted) };
  }
  return await waitForSystemdGeneration('restart', unit, dir, state, logOffset);
}

/**
 * 受 systemd 托管时，restart 实际运行的是 unit ExecStart 里的解释器和入口脚本。
 * `dutydeck update` 用它确认 unit 指向刚装好的入口，否则重启后跑的仍是旧代码。
 */
export async function systemdRestartTarget(deps: DaemonCommandDeps = {}): Promise<{ unit: string; execPath?: string; script?: string } | undefined> {
  const dir = resolveDaemonDir();
  const supervised = await systemdSupervisor(dir, readDaemonStatus(dir), deps);
  return supervised && !('error' in supervised) ? { unit: supervised.unit, execPath: supervised.info.execPath, script: supervised.info.script } : undefined;
}

// ─── 按 unit 重启（bot 运行时）与部署共用 ───────────────────────────────────

/** deploy 与 `restart --unit` 控制目标服务的方式：默认走 systemd user unit，测试和演练可以换成直接起进程。 */
export interface ServiceControl {
  /** 服务当前的主进程；没在运行时为 undefined。 */
  mainPid(): Promise<number | undefined>;
  /** 重启服务；失败时返回原因。 */
  restart(): Promise<string | undefined>;
  /** 停服务；失败时返回原因。回滚要恢复数据库时用，停下后再用 restart 启动。 */
  stop(): Promise<string | undefined>;
  /** 清掉失败计数（systemd 的 start-limit）；回滚前用，免得刚才的崩溃循环挡住回滚。 */
  resetFailed?(): Promise<void>;
}

export function systemdServiceControl(unit: string, deps: DaemonCommandDeps): ServiceControl {
  const run = deps.runCommand ?? defaultRunCommand;
  return {
    mainPid: async () => (await showSystemdUnit(unit, deps))?.mainPid,
    restart: async () => {
      const restarted = await run('systemctl', ['--user', 'restart', unit]);
      return restarted.status === 0 ? undefined : systemctlFailure('restart', unit, restarted);
    },
    stop: async () => {
      const stopped = await run('systemctl', ['--user', 'stop', unit]);
      return stopped.status === 0 ? undefined : systemctlFailure('stop', unit, stopped);
    },
    resetFailed: async () => { await run('systemctl', ['--user', 'reset-failed', unit]); }
  };
}

const HEALTH_TIMEOUT_MS = 90_000;
const HEALTH_INTERVAL_MS = 1_000;

/** 重启后等到换上新的主进程，并且它的 /health 返回 ok。服务在 runtime 初始化完成后才开始监听。 */
export async function waitForServiceHealth(service: ServiceControl, previousPid: number | undefined, address: string | undefined, deps: DaemonCommandDeps, timeoutMs = HEALTH_TIMEOUT_MS): Promise<{ ok: true; pid: number } | { ok: false; error: string }> {
  const localAddresses = deps.localAddresses ?? (() => Object.values(networkInterfaces()).flatMap(entries => entries?.map(entry => entry.address) ?? []));
  const url = resolveLocalUrl(address, localAddresses);
  if (!url) return { ok: false, error: `监听地址（${address ?? '未记录'}）不可用于本机健康检查。` };
  const fetcher = deps.fetch ?? fetch;
  const sleeper = deps.sleep ?? sleep;
  const timer = deps.now ?? Date.now;
  const requestTimeoutMs = deps.requestTimeoutMs ?? ACTIVITY_REQUEST_TIMEOUT_MS;
  const deadline = timer() + timeoutMs;
  let last = '没有换上新的主进程';
  for (;;) {
    const pid = await service.mainPid();
    if (pid !== undefined && pid !== previousPid) {
      try {
        const response = await fetcher(new URL('/health', url.origin).toString(), { signal: AbortSignal.timeout(requestTimeoutMs) });
        if (response.ok && (await response.json() as any)?.ok === true) return { ok: true, pid };
        last = `新进程（pid ${pid}）的 /health 返回 HTTP ${response.status}`;
      } catch (error: any) {
        last = `新进程（pid ${pid}）的 /health 请求失败：${error?.message || String(error)}`;
      }
    }
    if (timer() >= deadline) return { ok: false, error: `${Math.round(timeoutMs / 1000)} 秒内没有通过健康检查（${last}）。` };
    await sleeper(HEALTH_INTERVAL_MS);
  }
}

/** unit 托管的运行时：根目录（WorkingDirectory）、ExecStart，以及连它本机 API 用的地址和数据库。 */
export interface UnitRuntime {
  unit: string;
  root: string;
  /** ExecStart 是 `start --foreground`：守护状态写在根目录的 .dutydeck/daemon 下。 */
  foreground: boolean;
  execPath?: string;
  script?: string;
  mainPid?: number;
  fragmentPath?: string;
  endpoint: RuntimeEndpoint;
}

function flagValue(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at >= 0) return args[at + 1];
  return args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

/**
 * 按 unit 找到它托管的运行时。`start --foreground` 的 unit 从守护状态读地址和数据库；直接 serve 的
 * unit（如 Tag 运行时）没有守护状态，按 ExecStart 的 --host / --port / --local-only / --database 推出来。
 */
export async function unitRuntime(unit: string, deps: DaemonCommandDeps): Promise<UnitRuntime | { error: string }> {
  if ((deps.platform ?? process.platform) !== 'linux') return { error: `--unit 只支持 Linux 上的 systemd user unit。` };
  const info = await showSystemdUnit(unit, deps);
  if (!info) return { error: `systemctl --user show ${unit} 失败，连不上 user systemd。请在能连上 user systemd 的会话里重试（通常需要 XDG_RUNTIME_DIR=/run/user/$(id -u)）。` };
  if (!info.loaded) return { error: `找不到 systemd user unit ${unit}。` };
  if (!info.workingDirectory) return { error: `unit ${unit} 没有设置 WorkingDirectory，无法确定运行时的根目录。` };
  const root = info.workingDirectory;
  const foreground = info.args[0] === 'start' && info.args.includes('--foreground');
  const base = { unit, root, foreground, execPath: info.execPath, script: info.script, mainPid: info.mainPid, fragmentPath: info.fragmentPath };
  if (foreground) {
    const state = readDaemonStatus(defaultDaemonDir(root));
    return { ...base, endpoint: { address: state?.address, database: state?.database, authEnabled: state?.authEnabled } };
  }
  const env = Object.fromEntries(info.environment.map(item => [item.slice(0, item.indexOf('=')), item.slice(item.indexOf('=') + 1)]));
  const { address, authEnabled } = addressFromCli({
    host: flagValue(info.args, '--host'),
    port: flagValue(info.args, '--port'),
    ...(info.args.includes('--local-only') ? { localOnly: true } : {}),
    ...(info.args.includes('--no-auth') ? { auth: false } : {})
  }, env);
  return { ...base, endpoint: { address, authEnabled, database: resolve(root, flagValue(info.args, '--database') ?? '.dutydeck/dutydeck.db') } };
}

/**
 * `dutydeck restart --unit <unit>`：重启指定 unit 托管的运行时，例如 Tag 这类 bot 运行时。
 * `start --foreground` 的 unit 按根目录下的守护状态走上面的 systemd 重启；直接 serve 的 unit 同样先
 * SQLite 预检、排空并等任务结束，再 systemctl restart，最后等新进程通过 /health。
 */
async function unitRestart(unit: string, options: CliOptions, deps: DaemonCommandDeps): Promise<DaemonCommandResult> {
  const target = await unitRuntime(unit, deps);
  if ('error' in target) return { ok: false, action: 'restart', running: false, error: target.error };
  const dir = defaultDaemonDir(target.root);
  if (target.foreground) {
    const state = readDaemonStatus(dir);
    const supervised = await systemdSupervisor(dir, state, deps);
    if (supervised && 'error' in supervised) return { ok: false, action: 'restart', running: true, pid: state?.pid, error: supervised.error };
    if (supervised?.unit === unit) return await systemdRestart(dir, state!, unit, supervised.info, options, deps);
  }
  const refused = refuseExplicitFlags('restart', unit, options, dir, target.mainPid);
  if (refused) return refused;
  if (!target.execPath) {
    return { ok: false, action: 'restart', running: target.mainPid !== undefined, pid: target.mainPid, error: `读不到 ${unit} 的 ExecStart，无法确认新进程能否加载 SQLite；已拒绝重启。` };
  }
  const sqlite = (deps.checkSqlite ?? checkSqliteDriver)({ execPath: target.execPath, ...(target.script ? { resolveFrom: target.script } : {}) });
  if (!sqlite.ok) {
    return { ok: false, action: 'restart', running: target.mainPid !== undefined, pid: target.mainPid,
      error: `SQLite 预检失败，已拒绝重启。${describeSqliteDriverFailure(sqlite)}。unit ${unit} 的 ExecStart 用的就是这个解释器。` };
  }
  const drain: DrainResult = target.mainPid === undefined ? { ok: true } : await drainRuntime(target.endpoint, options, deps);
  if (!drain.ok) return { ok: false, action: 'restart', running: true, pid: target.mainPid, error: drain.error };
  const service = systemdServiceControl(unit, deps);
  const restartError = await service.restart();
  if (restartError) {
    await drain.release?.();
    return { ok: false, action: 'restart', running: (await service.mainPid()) !== undefined, pid: target.mainPid, error: restartError };
  }
  const healthy = await waitForServiceHealth(service, target.mainPid, target.endpoint.address, deps);
  if (!healthy.ok) return { ok: false, action: 'restart', running: false, state: 'not-running', error: `systemctl --user restart ${unit} 已返回，但${healthy.error}查看：systemctl --user status ${unit}` };
  const authEnabled = target.endpoint.authEnabled !== false;
  return { ok: true, action: 'restart', running: true, pid: healthy.pid, address: target.endpoint.address, authEnabled, authentication: authEnabled ? 'required' : 'disabled', state: 'restarted' };
}

export interface DaemonStatusInfo {
  running: boolean;
  processStatus: DaemonProcessStatus;
  error?: string;
  pid?: number;
  address?: string;
  logFile?: string;
  startedAt?: string;
  ready?: boolean;
  authEnabled?: boolean;
  authentication?: 'required' | 'disabled';
}

/** `dutydeck status`: report whether a daemon is alive and where. */
export function daemonStatus(): DaemonStatusInfo {
  const dir = resolveDaemonDir();
  const state = readDaemonStatus(dir);
  const inspection = inspectDaemon(dir);
  const alive = inspection.status === 'verified';
  const authEnabled = state?.authEnabled !== false;
  return {
    running: alive,
    processStatus: inspection.status,
    error: inspection.status === 'unverifiable' ? unverifiedResult('status', inspection).error : undefined,
    pid: inspection.status !== 'stale' ? inspection.pid : undefined,
    address: alive ? state?.address : undefined,
    logFile: alive ? daemonPaths(dir).logFile : undefined,
    startedAt: alive ? state?.startedAt : undefined,
    ready: alive ? state?.ready : false,
    authEnabled: alive ? authEnabled : undefined,
    authentication: alive ? (authEnabled ? 'required' : 'disabled') : undefined
  };
}

function authEnabledFromCli(options: CliOptions, env: NodeJS.ProcessEnv): boolean {
  if (options.auth !== undefined) return options.auth;
  return env.DUTYDECK_AUTH !== 'false';
}

function addressFromCli(options: CliOptions, env: NodeJS.ProcessEnv = process.env): { host?: string; port?: number; address?: string; authEnabled: boolean } {
  const host = options.localOnly === true || (options.host === undefined && env.DUTYDECK_LOCAL_ONLY === 'true')
    ? '127.0.0.1'
    : options.host ?? env.DUTYDECK_HOST ?? '127.0.0.1';
  const port = Number(options.port ?? env.DUTYDECK_PORT ?? 4310);
  // 通配地址（0.0.0.0 / ::）在本机统一回环到 127.0.0.1，映射口径与 service.localApiBaseUrl 一致。
  return { host, port, address: localLoopbackUrl(host, port), authEnabled: authEnabledFromCli(options, env) };
}
