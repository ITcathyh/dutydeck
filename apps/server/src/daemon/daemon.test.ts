import { childProcessIdentity } from '@dutydeck/storage';
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
  daemonLogSize,
  defaultDaemonDir,
  isDaemonRunning,
  daemonPaths,
  tailDaemonLog
} from './daemon.js';
import { daemonRestartOptions, daemonStart, daemonStop, daemonStatus } from './command.js';

describe('Dutydeck daemon session', () => {
  let tmp: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dutydeck-daemon-'));
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
    expect(daemonPaths(dir).logFile).toBe(join(tmp, '.dutydeck', 'daemon', 'dutydeck.log'));
    expect(readFileSync(join(dir, 'dutydeck.pid'), 'utf8').trim()).toBe('4242');
    expect(daemonStatus().running).toBe(false); // 4242 is not an alive process
    clearState(dir);
    expect(readDaemonStatus(dir)).toBeUndefined();
  });

  it('daemonStart in the child branch records pid and serves in-band', async () => {
    const serve = vi.fn();
    const env = { HOME: tmp, DUTYDECK_DAEMONIZED: '1', DUTYDECK_DAEMON_CWD: tmp, DUTYDECK_DAEMON_STARTED_AT: '2024-01-01T00:00:00.000Z' } as NodeJS.ProcessEnv;
    const result = await daemonStart({ port: '4310', auth: false }, { serve }, env);
    expect(result).toMatchObject({ ok: true, action: 'start', running: true, pid: process.pid, authEnabled: false, authentication: 'disabled' });
    expect(serve).toHaveBeenCalledOnce();
    const state = readDaemonStatus(defaultDaemonDir());
    expect(state).toMatchObject({ pid: process.pid, ready: false, address: 'http://127.0.0.1:4310', authEnabled: false, database: join(tmp, '.dutydeck', 'dutydeck.db') });
    expect(serve).toHaveBeenCalledWith(expect.objectContaining({ database: join(tmp, '.dutydeck', 'dutydeck.db') }), expect.any(Function));
  });

  it('records the effective remote open deployment when configured only through env', async () => {
    const serve = vi.fn();
    const env = {
      HOME: tmp,
      DUTYDECK_DAEMONIZED: '1',
      DUTYDECK_DAEMON_CWD: tmp,
      DUTYDECK_DAEMON_STARTED_AT: '2024-01-01T00:00:00.000Z',
      DUTYDECK_HOST: '0.0.0.0',
      DUTYDECK_PORT: '4510',
      DUTYDECK_AUTH: 'false'
    } as NodeJS.ProcessEnv;
    await daemonStart({}, { serve }, env);
    expect(readDaemonStatus(defaultDaemonDir())).toMatchObject({ host: '0.0.0.0', port: 4510, address: 'http://127.0.0.1:4510', authEnabled: false });
  });

  it('reuses the first Dutydeck root after the daemon has stopped', async () => {
    const firstRoot = join(tmp, 'dutydeck-root');
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
    writeLastDaemonDir(join(tmp, 'deleted-root', '.dutydeck', 'daemon'), tmp);
    expect(resolveDaemonDir(otherCwd, tmp)).toBe(defaultDaemonDir(otherCwd));
  });

  it('daemonStatus reports an alive daemon using a real child process', async () => {
    // Spawn a short-lived sleep child and use its pid as a fake daemon.
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { stdio: 'ignore' });
    const dir = defaultDaemonDir();
    writeState(dir, { pid: child.pid!, processIdentity: childProcessIdentity(child.pid!), ready: true, startedAt: '2024-01-01T00:00:00.000Z', cwd: tmp, address: 'http://127.0.0.1:4310', authEnabled: false });
    const status = daemonStatus();
    expect(status.running).toBe(true);
    expect(status.pid).toBe(child.pid);
    expect(status).toMatchObject({ authEnabled: false, authentication: 'disabled' });
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
  });

  it('daemonStop SIGTERMs an alive daemon and clears state', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { stdio: 'ignore' });
    const dir = defaultDaemonDir();
    writeState(dir, { pid: child.pid!, processIdentity: childProcessIdentity(child.pid!), ready: true, startedAt: '2024-01-01T00:00:00.000Z', cwd: tmp });
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
    writeState(dir, { pid: child.pid!, processIdentity: childProcessIdentity(child.pid!), ready: true, startedAt: '2024-01-01T00:00:00.000Z', cwd: tmp });
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
    const result = await daemonStop();
    const code = await exited;
    expect(code).toBe(0); // 0 means the handler ran; default SIGTERM termination yields null
    expect(result).toMatchObject({ ok: true, action: 'stop', running: false, pid: child.pid, state: 'stopped' });
    expect(result.error).toBeUndefined();
    expect(readFileSync(marker, 'utf8')).toBe('ok');
    expect(readDaemonStatus(dir)).toBeUndefined();
  });

  it('does not signal a real unrelated PID occupant referenced by a stale birth identity', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { stdio: 'ignore' });
    const exited = new Promise(resolve => child.once('exit', resolve));
    try {
      const identity = childProcessIdentity(child.pid!);
      writeState(defaultDaemonDir(), { pid: child.pid!, processIdentity: { ...identity, start: 'stale-birth' }, ready: true, startedAt: 'old', cwd: tmp });
      expect(await daemonStop()).toMatchObject({ ok: true, running: false, state: 'not-running' });
      expect(pidAlive(child.pid!)).toBe(true);
      expect(childProcessIdentity(child.pid!)).toEqual(identity);
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
  });

  it('daemonStop reports not-running when nothing is recorded', async () => {
    const result = await daemonStop();
    expect(result).toMatchObject({ ok: true, action: 'stop', running: false, state: 'not-running' });
  });

  it('preserves the previous host and port on restart unless explicitly overridden', () => {
    const previous = { pid: 42, ready: true, startedAt: '2024-01-01T00:00:00.000Z', cwd: tmp, database: join(tmp, '.dutydeck', 'dutydeck.db'), host: '127.0.0.1', port: 4600, authEnabled: false };
    expect(daemonRestartOptions({}, previous)).toMatchObject({ cwd: tmp, database: join(tmp, '.dutydeck', 'dutydeck.db'), host: '127.0.0.1', port: '4600', auth: false });
    expect(daemonRestartOptions({ host: '0.0.0.0', port: '4700' }, previous)).toMatchObject({ host: '0.0.0.0', port: '4700' });
    expect(daemonRestartOptions({ auth: true }, previous)).toMatchObject({ auth: true });
    expect(daemonRestartOptions({}, undefined, {
      DUTYDECK_DAEMON_RESTART_CWD: tmp,
      DUTYDECK_DAEMON_RESTART_DATABASE: join(tmp, '.dutydeck', 'dutydeck.db'),
      DUTYDECK_DAEMON_RESTART_HOST: '127.0.0.1',
      DUTYDECK_DAEMON_RESTART_PORT: '4600'
    })).toMatchObject({ cwd: tmp, database: join(tmp, '.dutydeck', 'dutydeck.db'), host: '127.0.0.1', port: '4600' });
  });

  it('fails secure for legacy or malformed daemon auth state', () => {
    const base = { pid: 42, ready: true, startedAt: '2024-01-01T00:00:00.000Z', cwd: tmp };
    expect(daemonRestartOptions({}, base)).not.toHaveProperty('auth');
    expect(daemonRestartOptions({}, { ...base, authEnabled: 'false' } as any)).not.toHaveProperty('auth');
    expect(daemonRestartOptions({}, undefined, { DUTYDECK_DAEMON_RESTART_AUTH: 'broken' })).not.toHaveProperty('auth');
  });

  /**
   * 启动失败原因的提炼。
   *
   * 背景：`dutydeck start` 过去在端口被占用时子进程死掉、父进程仍 exit 0 且零输出。
   * 修复方式是父进程等子进程 exit 并回放日志。回放本身有两个陷阱，各配一条断言：
   * 陈旧行（日志 append，必须按偏移只取本次）与机密行（服务会打印访问令牌）。
   */
  describe('tailDaemonLog', () => {
    const write = (text: string) => {
      const dir = defaultDaemonDir(tmp);
      mkdirSync(dir, { recursive: true });
      writeFileSync(daemonPaths(dir).logFile, text, 'utf8');
      return dir;
    };

    it('只挑错误特征行，不把正常启动流水当成原因', () => {
      const dir = write([
        'Server listening at http://127.0.0.1:4310',
        'Dutydeck UI and API listening on http://127.0.0.1:4310',
        'listen EADDRINUSE: address already in use 127.0.0.1:4310'
      ].join('\n'));
      expect(tailDaemonLog(dir)).toEqual(['listen EADDRINUSE: address already in use 127.0.0.1:4310']);
    });

    it('按字节偏移只回放本次启动写入的行 —— 否则上一轮的报错会被当成这次的原因', () => {
      const stale = 'listen EADDRINUSE: address already in use 127.0.0.1:9999\n';
      const dir = write(`${stale}listen EACCES: permission denied 127.0.0.1:80\n`);
      expect(tailDaemonLog(dir, 3, Buffer.byteLength(stale))).toEqual(['listen EACCES: permission denied 127.0.0.1:80']);
    });

    /**
     * 「绝不泄密」：服务启动时会把生成的访问令牌打进同一份日志，而这份回放会进入
     * 终端、CI 记录与 `--json` 的消费方。实测踩过一次，故用真实文案锁死。
     */
    it('绝不回放疑似机密的行', () => {
      const dir = write([
        '[dutydeck] Generated access token for remote access: DHL-ws45-FkYdsVMkKlmmKj0aGkVFyRAPX3QyDUHkaw',
        "[dutydeck] Run 'dutydeck auth token' to view it again, or 'dutydeck auth token --rotate' to rotate it.",
        'listen EADDRINUSE: address already in use 127.0.0.1:4310'
      ].join('\n'));
      const lines = tailDaemonLog(dir);
      expect(lines).toEqual(['listen EADDRINUSE: address already in use 127.0.0.1:4310']);
      expect(lines.join('\n')).not.toContain('DHL-ws45');
    });

    it('单行过长时截断，不把终端糊满', () => {
      const dir = write(`Error: ${'x'.repeat(500)}`);
      const [line] = tailDaemonLog(dir);
      expect(line!.length).toBeLessThanOrEqual(201);
      expect(line!.endsWith('…')).toBe(true);
    });

    it('日志不存在时返回空，绝不因为取日志而让启动流程崩掉', () => {
      expect(tailDaemonLog(join(tmp, 'nope'))).toEqual([]);
      expect(daemonLogSize(join(tmp, 'nope'))).toBe(0);
    });
  });
});
