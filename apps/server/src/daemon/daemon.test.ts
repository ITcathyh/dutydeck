import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pidAlive,
  readDaemonStatus,
  writeState,
  writePidFile,
  clearState,
  defaultDaemonDir,
  isDaemonRunning,
  daemonPaths
} from './daemon.js';
import { daemonRestartOptions, daemonStart, daemonStop, daemonStatus } from './command.js';

describe('Dockmux daemon session', () => {
  let tmp: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dockmux-daemon-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmp);
    vi.stubEnv('HOME', tmp);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    vi.unstubAllEnvs();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reports false for a non-running or absent daemon', () => {
    expect(isDaemonRunning()).toBe(false);
    expect(daemonStatus().running).toBe(false);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(Number.NaN)).toBe(false);
  });

  it('reads a state written by the daemon child', () => {
    const dir = defaultDaemonDir();
    writeState(dir, { pid: 4242, ready: true, startedAt: '2024-01-01T00:00:00.000Z', cwd: tmp, address: 'http://127.0.0.1:4310' });
    writePidFile(dir, 4242);
    const state = readDaemonStatus(dir);
    expect(state).toMatchObject({ pid: 4242, ready: true, address: 'http://127.0.0.1:4310' });
    expect(daemonPaths(dir).logFile).toBe(join(tmp, '.dockmux', 'daemon', 'dockmux.log'));
    expect(readFileSync(join(dir, 'dockmux.pid'), 'utf8').trim()).toBe('4242');
    expect(daemonStatus().running).toBe(false); // 4242 is not an alive process
    clearState(dir);
    expect(readDaemonStatus(dir)).toBeUndefined();
  });

  it('daemonStart in the child branch records pid and serves in-band', async () => {
    const serve = vi.fn();
    const env = { HOME: tmp, DOCKMUX_DAEMONIZED: '1', DOCKMUX_DAEMON_CWD: tmp, DOCKMUX_DAEMON_STARTED_AT: '2024-01-01T00:00:00.000Z' } as NodeJS.ProcessEnv;
    const result = await daemonStart({ port: '4310' }, { serve }, env);
    expect(result).toMatchObject({ ok: true, action: 'start', running: true, pid: process.pid });
    expect(serve).toHaveBeenCalledOnce();
    const state = readDaemonStatus(defaultDaemonDir());
    expect(state).toMatchObject({ pid: process.pid, ready: false, address: 'http://127.0.0.1:4310', database: join(tmp, '.dockmux', 'dockmux.db') });
    expect(serve).toHaveBeenCalledWith(expect.objectContaining({ database: join(tmp, '.dockmux', 'dockmux.db') }), expect.any(Function));
  });

  it('reuses the first Dockmux root after the daemon has stopped', async () => {
    const firstRoot = join(tmp, 'dockmux-root');
    const otherCwd = join(tmp, 'somewhere-else');
    mkdirSync(firstRoot, { recursive: true });
    mkdirSync(otherCwd, { recursive: true });
    const canonicalDir = defaultDaemonDir(firstRoot);
    mkdirSync(canonicalDir, { recursive: true });
    const { writeLastDaemonDir, resolveDaemonDir } = await import('./daemon.js');
    writeLastDaemonDir(canonicalDir, tmp);
    expect(resolveDaemonDir(otherCwd, tmp)).toBe(canonicalDir);
  });

  it('ignores a remembered root that no longer exists', async () => {
    const otherCwd = join(tmp, 'current-root');
    mkdirSync(otherCwd, { recursive: true });
    const { writeLastDaemonDir, resolveDaemonDir } = await import('./daemon.js');
    writeLastDaemonDir(join(tmp, 'deleted-root', '.dockmux', 'daemon'), tmp);
    expect(resolveDaemonDir(otherCwd, tmp)).toBe(defaultDaemonDir(otherCwd));
  });

  it('daemonStatus reports an alive daemon using a real child process', async () => {
    // Spawn a short-lived sleep child and use its pid as a fake daemon.
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { stdio: 'ignore' });
    const dir = defaultDaemonDir();
    writeState(dir, { pid: child.pid!, ready: true, startedAt: '2024-01-01T00:00:00.000Z', cwd: tmp, address: 'http://127.0.0.1:4310' });
    const status = daemonStatus();
    expect(status.running).toBe(true);
    expect(status.pid).toBe(child.pid);
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
  });

  it('daemonStop SIGTERMs an alive daemon and clears state', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { stdio: 'ignore' });
    const dir = defaultDaemonDir();
    writeState(dir, { pid: child.pid!, ready: true, startedAt: '2024-01-01T00:00:00.000Z', cwd: tmp });
    const exited = new Promise(resolve => child.once('exit', resolve));
    const result = await daemonStop();
    await exited;
    expect(result).toMatchObject({ ok: true, action: 'stop', running: false, pid: child.pid });
    expect(isDaemonRunning()).toBe(false);
    expect(readDaemonStatus(dir)).toBeUndefined();
  });

  it('daemonStop lets the daemon run its SIGTERM handler for a graceful exit', async () => {
    // serve() installs a SIGTERM handler that closes the service before exiting.
    // Mirror that contract in the child: handle SIGTERM, record a marker, exit 0.
    // daemonStop must observe the graceful exit and clear state without escalating
    // to SIGKILL (which would surface as a timeout error on the result).
    const { spawn } = await import('node:child_process');
    const marker = join(tmp, 'graceful-stop-marker');
    const child = spawn(process.execPath, [
      '-e',
      `process.on('SIGTERM', () => { import('node:fs').then(fs => { fs.writeFileSync(${JSON.stringify(marker)}, 'ok'); process.exit(0); }); }); process.stdout.write('ready'); setTimeout(() => {}, 60_000);`
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    // Wait until the handler is registered, otherwise SIGTERM can land during
    // process boot and take the default termination action.
    await new Promise<void>(resolve => child.stdout!.once('data', () => resolve()));
    const dir = defaultDaemonDir();
    writeState(dir, { pid: child.pid!, ready: true, startedAt: '2024-01-01T00:00:00.000Z', cwd: tmp });
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
    const result = await daemonStop();
    const code = await exited;
    expect(code).toBe(0); // 0 means the handler ran; default SIGTERM termination yields null
    expect(result).toMatchObject({ ok: true, action: 'stop', running: false, pid: child.pid, state: 'stopped' });
    expect(result.error).toBeUndefined();
    expect(readFileSync(marker, 'utf8')).toBe('ok');
    expect(readDaemonStatus(dir)).toBeUndefined();
  });

  it('daemonStop reports not-running when nothing is recorded', async () => {
    const result = await daemonStop();
    expect(result).toMatchObject({ ok: true, action: 'stop', running: false, state: 'not-running' });
  });

  it('preserves the previous host and port on restart unless explicitly overridden', () => {
    const previous = { pid: 42, ready: true, startedAt: '2024-01-01T00:00:00.000Z', cwd: tmp, database: join(tmp, '.dockmux', 'dockmux.db'), host: '127.0.0.1', port: 4600 };
    expect(daemonRestartOptions({}, previous)).toMatchObject({ cwd: tmp, database: join(tmp, '.dockmux', 'dockmux.db'), host: '127.0.0.1', port: '4600' });
    expect(daemonRestartOptions({ host: '0.0.0.0', port: '4700' }, previous)).toMatchObject({ host: '0.0.0.0', port: '4700' });
    expect(daemonRestartOptions({}, undefined, {
      DOCKMUX_DAEMON_RESTART_CWD: tmp,
      DOCKMUX_DAEMON_RESTART_DATABASE: join(tmp, '.dockmux', 'dockmux.db'),
      DOCKMUX_DAEMON_RESTART_HOST: '127.0.0.1',
      DOCKMUX_DAEMON_RESTART_PORT: '4600'
    })).toMatchObject({ cwd: tmp, database: join(tmp, '.dockmux', 'dockmux.db'), host: '127.0.0.1', port: '4600' });
  });
});
