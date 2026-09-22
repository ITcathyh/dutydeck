import { currentProcessIdentity } from '@dutydeck/storage';
import {
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
import { sleep } from './time.js';
import { resolve } from 'node:path';

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
const RESTART_HOST_ENV = 'DUTYDECK_DAEMON_RESTART_HOST';
const RESTART_PORT_ENV = 'DUTYDECK_DAEMON_RESTART_PORT';
const RESTART_CWD_ENV = 'DUTYDECK_DAEMON_RESTART_CWD';
const RESTART_DATABASE_ENV = 'DUTYDECK_DAEMON_RESTART_DATABASE';
const RESTART_AUTH_ENV = 'DUTYDECK_DAEMON_RESTART_AUTH';

export interface DaemonCommandHandlers {
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
 */
export async function daemonStart(options: CliOptions, handlers: DaemonCommandHandlers, env: NodeJS.ProcessEnv = process.env): Promise<DaemonCommandResult> {
  const invocationCwd = process.cwd();
  const dir = isDaemonChild(env) ? defaultDaemonDir(invocationCwd) : resolveDaemonDir(invocationCwd, env.HOME);
  const cwd = isDaemonChild(env) ? invocationCwd : resolve(dir, '../..');
  const database = resolve(cwd, options.database ?? '.dutydeck/dutydeck.db');

  if (isDaemonChild(env)) {
    // We are the detached child: own the server and publish self metadata.
    const meta = childMeta(env);
    const processIdentity = currentProcessIdentity();
    const initialState: DaemonState = {
      pid: process.pid,
      processIdentity,
      ready: false,
      startedAt: meta.startedAt,
      cwd,
      database,
      ...addressFromCli(options, env)
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
  if (inspection.status === 'verified') {
    return { ok: false, action: 'start', running: true, pid: current?.pid, state: 'already-running', error: `Dutydeck is already running (pid ${current?.pid}). Use 'dutydeck status' or 'dutydeck restart'.` };
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

function unverifiedResult(action: DaemonCommandResult['action'], inspection: DaemonInspection): DaemonCommandResult {
  return { ok: false, action, running: false, pid: inspection.pid, processStatus: 'unverifiable',
    error: `Daemon identity cannot be verified: ${inspection.reason}. Inspect the recorded PID and daemon state manually before starting or stopping it.` };
}

function changedResult(action: DaemonCommandResult['action']): DaemonCommandResult {
  return { ok: false, action, running: false, error: 'Daemon state changed during this operation; the replacement record was preserved. Inspect dutydeck status before retrying.' };
}

/** Recheck both the disk generation and process identity before every signal and poll. */
export async function daemonStop(): Promise<DaemonCommandResult> {
  const dir = resolveDaemonDir();
  const state = readDaemonStatus(dir);
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
  // Resolve the currently running daemon's directory so we can restart it in
  // the same working directory (important when the user runs `restart` from a
  // different directory than where the daemon was started).
  const runningDir = resolveDaemonDir();
  const previousState = readDaemonStatus(runningDir);
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
  const stopped = await daemonStop();
  if (!stopped.ok) return { ...stopped, action: 'restart' };
  if (previousCwd && previousCwd !== process.cwd()) {
    process.chdir(previousCwd);
  }
  const started = await daemonStart(restartOptions, handlers, restartEnv);
  return started.ok && started.running
    ? { ...started, action: 'restart' as const, state: 'restarted' as const }
    : { ok: false, action: 'restart' as const, running: false, state: 'not-running' as const, error: started.error };
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
  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  return { host, port, address: `http://${displayHost.includes(':') ? `[${displayHost}]` : displayHost}:${port}`, authEnabled: authEnabledFromCli(options, env) };
}
