import {
  childMeta,
  clearState,
  daemonPaths,
  daemonize,
  defaultDaemonDir,
  isDaemonChild,
  pidAlive,
  pidFromState,
  readDaemonStatus,
  resolveDaemonDir,
  writeLastDaemonDir,
  writePidFile,
  writeState,
  type DaemonState
} from './daemon.js';
import type { CliOptions } from '../cli-program.js';
import { sleep } from './time.js';
import { resolve } from 'node:path';

export interface DaemonCommandResult {
  ok: boolean;
  action: 'start' | 'stop' | 'restart' | 'status';
  running: boolean;
  pid?: number;
  address?: string;
  authEnabled?: boolean;
  authentication?: 'required' | 'disabled';
  logFile?: string;
  state?: 'started' | 'already-running' | 'not-running' | 'stopped' | 'restarted';
  error?: string;
}

const READY_TIMEOUT_MS = 15_000;
const RESTART_HOST_ENV = 'DOCKMUX_DAEMON_RESTART_HOST';
const RESTART_PORT_ENV = 'DOCKMUX_DAEMON_RESTART_PORT';
const RESTART_CWD_ENV = 'DOCKMUX_DAEMON_RESTART_CWD';
const RESTART_DATABASE_ENV = 'DOCKMUX_DAEMON_RESTART_DATABASE';
const RESTART_AUTH_ENV = 'DOCKMUX_DAEMON_RESTART_AUTH';

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
export function markDaemonReady(dir: string, patch: Partial<Pick<DaemonState, 'host' | 'port' | 'address' | 'database' | 'authEnabled'>> = {}): void {
  const previous = readDaemonStatus(dir);
  writeState(dir, {
    pid: process.pid,
    ready: true,
    startedAt: previous?.startedAt ?? new Date().toISOString(),
    cwd: process.cwd(),
    ...patch
  });
}

/**
 * Entry point for `dockmux start`. From the foreground it re-spawns the
 * server as a detached daemon then exits; inside the detached child (signalled
 * via `DOCKMUX_DAEMONIZED`) it records self metadata and serves in-band.
 */
export async function daemonStart(options: CliOptions, handlers: DaemonCommandHandlers, env: NodeJS.ProcessEnv = process.env): Promise<DaemonCommandResult> {
  const invocationCwd = process.cwd();
  const dir = isDaemonChild(env) ? defaultDaemonDir(invocationCwd) : resolveDaemonDir(invocationCwd, env.HOME);
  const cwd = isDaemonChild(env) ? invocationCwd : resolve(dir, '../..');
  const database = resolve(cwd, options.database ?? '.dockmux/dockmux.db');

  if (isDaemonChild(env)) {
    // We are the detached child: own the server and publish self metadata.
    const meta = childMeta(env);
    writePidFile(dir, process.pid);
    writeState(dir, {
      pid: process.pid,
      ready: false,
      startedAt: meta.startedAt,
      cwd,
      database,
      ...addressFromCli(options, env)
    });
    writeLastDaemonDir(dir, env.HOME);
    await handlers.serve({ ...options, database }, () => markDaemonReady(dir, { ...addressFromCli(options, env), database }));
    const authEnabled = authEnabledFromCli(options, env);
    return { ok: true, action: 'start', running: true, pid: process.pid, authEnabled, authentication: authEnabled ? 'required' : 'disabled' };
  }

  // Foreground parent: refuse to double-start.
  const runningDir = resolveDaemonDir(cwd);
  const current = readDaemonStatus(runningDir);
  if (current && current.pid > 0 && pidAlive(current.pid)) {
    return { ok: false, action: 'start', running: true, pid: current.pid, state: 'already-running', error: `Dockmux is already running (pid ${current.pid}). Use 'dockmux status' or 'dockmux restart'.` };
  }

  const startedAt = new Date().toISOString();
  clearState(dir);
  daemonize({ cwd, startedAt, env });

  // daemonize-process exits the parent, but poll readiness in case it returns.
  return waitUntilReady(dir, startedAt);
}

async function waitUntilReady(dir: string, startedAt: string): Promise<DaemonCommandResult> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = readDaemonStatus(dir);
    if (state && state.pid > 0 && pidAlive(state.pid) && state.ready) {
      const authEnabled = state.authEnabled !== false;
      return { ok: true, action: 'start', running: true, pid: state.pid, address: state.address, authEnabled, authentication: authEnabled ? 'required' : 'disabled', logFile: daemonPaths(dir).logFile, state: 'started' };
    }
    await sleep(200);
  }
  const state = readDaemonStatus(dir);
  const pid = pidFromState(state);
  if (pid > 0 && pidAlive(pid)) {
    const authEnabled = state?.authEnabled !== false;
    return { ok: true, action: 'start', running: true, pid, address: state?.address, authEnabled, authentication: authEnabled ? 'required' : 'disabled', logFile: daemonPaths(dir).logFile, state: 'started', error: 'Daemon started but did not report ready within the timeout.' };
  }
  return { ok: false, action: 'start', running: false, state: 'not-running', error: 'Daemon failed to start within the timeout. See the log file for details.' };
}

/** `dockmux stop`: SIGTERM the daemon and clear its state. */
export async function daemonStop(): Promise<DaemonCommandResult> {
  const dir = resolveDaemonDir();
  const state = readDaemonStatus(dir);
  const pid = pidFromState(state);

  if (!pid || !pidAlive(pid)) {
    clearState(dir);
    return { ok: true, action: 'stop', running: false, state: 'not-running' };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    clearState(dir);
    return { ok: false, action: 'stop', running: false, state: 'stopped', error: `Failed to signal pid ${pid}.` };
  }

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) {
      clearState(dir);
      return { ok: true, action: 'stop', running: false, pid, state: 'stopped' };
    }
    await sleep(200);
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch { /* already gone */ }
  await sleep(200);
  clearState(dir);
  return { ok: true, action: 'stop', running: false, pid, state: 'stopped', error: 'Graceful stop timed out; sent SIGKILL.' };
}

/** `dockmux restart`: stop, then start again. */
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
  if (previousCwd && previousCwd !== process.cwd()) {
    process.chdir(previousCwd);
  }
  await daemonStop();
  const started = await daemonStart(restartOptions, handlers, restartEnv);
  return started.running
    ? { ...started, action: 'restart' as const, state: 'restarted' as const }
    : { ok: false, action: 'restart' as const, running: false, state: 'not-running' as const, error: started.error };
}

export interface DaemonStatusInfo {
  running: boolean;
  pid?: number;
  address?: string;
  logFile?: string;
  startedAt?: string;
  ready?: boolean;
  authEnabled?: boolean;
  authentication?: 'required' | 'disabled';
}

/** `dockmux status`: report whether a daemon is alive and where. */
export function daemonStatus(): DaemonStatusInfo {
  const dir = resolveDaemonDir();
  const state = readDaemonStatus(dir);
  const pid = pidFromState(state);
  const alive = pid > 0 && pidAlive(pid);
  const authEnabled = state?.authEnabled !== false;
  return {
    running: alive,
    pid: alive ? pid : undefined,
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
  return env.DOCKMUX_AUTH !== 'false';
}

function addressFromCli(options: CliOptions, env: NodeJS.ProcessEnv = process.env): { host?: string; port?: number; address?: string; authEnabled: boolean } {
  const host = options.localOnly === true || (options.host === undefined && env.DOCKMUX_LOCAL_ONLY === 'true')
    ? '127.0.0.1'
    : options.host ?? env.DOCKMUX_HOST ?? '127.0.0.1';
  const port = Number(options.port ?? env.DOCKMUX_PORT ?? 4310);
  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  return { host, port, address: `http://${displayHost.includes(':') ? `[${displayHost}]` : displayHost}:${port}`, authEnabled: authEnabledFromCli(options, env) };
}
