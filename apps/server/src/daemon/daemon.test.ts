import { createRepositories, childProcessIdentity, currentProcessIdentity } from '@dutydeck/storage';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pidAlive,
  readDaemonStatus,
  resolveDaemonDir,
  writeState,
  writePidFile,
  clearState,
  daemonLogSize,
  defaultDaemonDir,
  isDaemonRunning,
  inspectDaemon,
  daemonPaths,
  tailDaemonLog,
  writeLastDaemonDir,
  lastDaemonDirPointerFile,
  releaseStartLock
} from './daemon.js';
import { daemonRestart, daemonRestartOptions, daemonStart, daemonStop, daemonStatus, markDaemonReady, resolveCliDatabase, systemdServiceControl } from './command.js';
import { expectOwnDaemonDir } from './daemon-dir.test-helpers.js';

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

  it.each(['cli_a', null])('keeps bot/Web process %s state local without changing the global pointer', async appId => {
    const database = join(tmp, 'bot.db');
    const repos = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
    await repos.config.set('lark.bots', JSON.stringify(appId ? [{ appId }] : []));
    await repos.config.set('dutydeck.bot_process', JSON.stringify({ version: 1, appId })); repos.close();
    const pointed = join(tmp, 'main', '.dutydeck', 'daemon'); mkdirSync(pointed, { recursive: true });
    writeLastDaemonDir(pointed, tmp);
    await daemonStart({ foreground: true, database, cwd: '/agent/workspace' }, { serve: vi.fn() }, { HOME: tmp });
    const state = readDaemonStatus(defaultDaemonDir())!;
    expect(state).toMatchObject({ botProcess: true, agentCwd: '/agent/workspace' });
    expect(readFileSync(lastDaemonDirPointerFile(tmp), 'utf8').trim()).toBe(pointed);
    expect(daemonRestartOptions({}, state)).toMatchObject({ cwd: '/agent/workspace', ...(appId ? { botAppId: appId } : {}) });
    writeState(defaultDaemonDir(), { ...state, pid: 0 });
    expect(resolveDaemonDir()).toBe(defaultDaemonDir());
  });

  it('prefers explicit daemon directory and refuses restarting a differently bound process', async () => {
    const dir = join(tmp, 'bot-b', '.dutydeck', 'daemon');
    vi.stubEnv('DUTYDECK_DAEMON_DIR', dir);
    writeState(dir, { pid: 0, ready: false, startedAt: 'old', cwd: join(tmp, 'bot-b'), botAppId: 'cli_b', botProcess: true });
    expect(resolveDaemonDir()).toBe(dir);
    expectOwnDaemonDir(tmp);
    const runCommand = vi.fn();
    const result = await daemonRestart({ botAppId: 'cli_a' }, { serve: vi.fn(), runCommand });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('BOT_PROCESS_SCOPE') });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each(['option', 'environment'])('refuses an unresolved bot restart from %s without touching the main daemon or pointer', async source => {
    const mainDir = join(tmp, 'main', '.dutydeck', 'daemon');
    const main = { pid: process.pid, processIdentity: currentProcessIdentity(), ready: true, startedAt: 'main', cwd: join(tmp, 'main'), supervisor: 'systemd' as const, systemdUnit: 'dutydeck.service' };
    writeState(mainDir, main); writeLastDaemonDir(mainDir, tmp);
    const pointer = readFileSync(lastDaemonDirPointerFile(tmp), 'utf8');
    const runCommand = vi.fn(), fetch = vi.fn(), serve = vi.fn();
    const result = await daemonRestart(source === 'option' ? { botAppId: 'cli_a' } : {}, { serve, runCommand, fetch }, { HOME: tmp, ...(source === 'environment' ? { DUTYDECK_BOT_APP_ID: 'cli_a' } : {}) });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('BOT_PROCESS_SCOPE') });
    expect(runCommand).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(serve).not.toHaveBeenCalled();
    expect(readDaemonStatus(mainDir)).toEqual(main);
    expect(readFileSync(lastDaemonDirPointerFile(tmp), 'utf8')).toBe(pointer);
  });

  it('picks the CLI database from explicit input first and trusts daemon state only while the daemon is verified', () => {
    const root = join(tmp, 'live');
    const dir = defaultDaemonDir(root);
    const other = join(tmp, 'project-b'); mkdirSync(other, { recursive: true });
    const live = { pid: process.pid, processIdentity: currentProcessIdentity(), ready: true, startedAt: 'live', cwd: root, database: join(root, 'custom.db') };
    writeState(dir, live); writeLastDaemonDir(dir, tmp);
    expect(resolveCliDatabase(undefined, { HOME: tmp }, other)).toBe(live.database);
    expect(resolveCliDatabase(undefined, { HOME: tmp, DUTYDECK_DATABASE_URL: join(tmp, 'x.db') }, other)).toBe(join(tmp, 'x.db'));
    expect(resolveCliDatabase(undefined, { HOME: tmp, DUTYDECK_DATABASE_URL: 'data/x.db' }, other)).toBe(join(root, 'data/x.db'));
    expect(resolveCliDatabase(join(tmp, 'flag.db'), { HOME: tmp, DUTYDECK_DATABASE_URL: join(tmp, 'x.db') }, other)).toBe(join(tmp, 'flag.db'));
    writeState(dir, { ...live, processIdentity: { ...live.processIdentity, start: 'reused-pid' } });
    expect(inspectDaemon(dir).status).toBe('stale');
    expect(resolveCliDatabase(undefined, { HOME: tmp }, other)).toBe(join(root, '.dutydeck', 'dutydeck.db'));
  });

  it('keeps an explicitly selected stop directory instead of resolving the main pointer again', async () => {
    const mainDir = join(tmp, 'main', '.dutydeck', 'daemon');
    const main = { pid: process.pid, processIdentity: currentProcessIdentity(), ready: true, startedAt: 'main', cwd: join(tmp, 'main'), supervisor: 'systemd' as const, systemdUnit: 'dutydeck.service' };
    writeState(mainDir, main); writeLastDaemonDir(mainDir, tmp);
    const runCommand = vi.fn();
    expect(await daemonStop({ runCommand }, defaultDaemonDir(tmp))).toMatchObject({ ok: true, running: false, state: 'not-running' });
    expect(runCommand).not.toHaveBeenCalled(); expect(readDaemonStatus(mainDir)).toEqual(main);
    expect(readFileSync(lastDaemonDirPointerFile(tmp), 'utf8').trim()).toBe(mainDir);
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

  it.each(['replacement-generation', 'legacy-live', 'stale-generation', 'malformed'] as const)('refuses delayed child publication over %s without touching pid, state, pointer or serve', async kind => {
    const dir = defaultDaemonDir();
    const processIdentity = currentProcessIdentity();
    writeState(dir, {
      pid: process.pid, processIdentity: kind === 'legacy-live' ? undefined : {
        ...processIdentity, ...(kind === 'stale-generation' ? { start: 'previous-birth' } : {})
      }, ready: true, startedAt: 'replacement-generation', cwd: tmp
    });
    if (kind === 'malformed') writeFileSync(daemonPaths(dir).stateFile, '{broken-replacement');
    writePidFile(dir, 12345678);
    writeLastDaemonDir(join(tmp, 'replacement-root'), tmp);
    const files = [daemonPaths(dir).stateFile, daemonPaths(dir).pidFile, lastDaemonDirPointerFile(tmp)];
    const before = files.map(file => readFileSync(file, 'utf8'));
    const serve = vi.fn();
    const result = await daemonStart({}, { serve }, {
      HOME: tmp, DUTYDECK_DAEMONIZED: '1', DUTYDECK_DAEMON_STARTED_AT: 'older-delayed-launch'
    });
    expect(result).toMatchObject({ ok: false, action: 'start', running: false });
    expect(serve).not.toHaveBeenCalled();
    expect(files.map(file => readFileSync(file, 'utf8'))).toEqual(before);
  });

  it.each(['malformed', 'unreadable'] as const)('preserves %s state instead of treating failed ready reads as an empty record', kind => {
    const dir = defaultDaemonDir();
    const stateFile = daemonPaths(dir).stateFile;
    mkdirSync(dir, { recursive: true });
    let preservedFile = stateFile;
    if (kind === 'unreadable') {
      // A directory produces a real EISDIR read failure even when tests run as root.
      mkdirSync(stateFile);
      preservedFile = join(stateFile, 'preserved-marker');
    }
    writeFileSync(preservedFile, '{broken-replacement');
    expect(inspectDaemon(dir).status).toBe('unverifiable');
    expect(() => markDaemonReady(dir, {}, 'delayed-launch')).toThrow('existing record preserved');
    expect(readFileSync(preservedFile, 'utf8')).toBe('{broken-replacement');
    expect(inspectDaemon(dir).status).toBe('unverifiable');
  });

  it('allows a child to publish and become ready for its own existing generation', async () => {
    const dir = defaultDaemonDir();
    const processIdentity = currentProcessIdentity();
    writeState(dir, { pid: process.pid, processIdentity, ready: false, startedAt: 'same-launch', cwd: tmp });
    const serve = vi.fn((_options, ready) => ready());
    expect(await daemonStart({}, { serve }, {
      HOME: tmp, DUTYDECK_DAEMONIZED: '1', DUTYDECK_DAEMON_STARTED_AT: 'same-launch'
    })).toMatchObject({ ok: true, action: 'start', running: true });
    expect(serve).toHaveBeenCalledOnce();
    expect(readDaemonStatus(dir)).toMatchObject({ pid: process.pid, processIdentity, ready: true, startedAt: 'same-launch' });
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
    expectOwnDaemonDir(tmp);
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
    expectOwnDaemonDir(tmp);
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
    expectOwnDaemonDir(tmp);
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

  it('the own-dir guard rejects an inherited daemon dir outside the temp dir', () => {
    expectOwnDaemonDir(tmp);
    vi.stubEnv('DUTYDECK_DAEMON_DIR', `${tmp}-elsewhere`);
    expect(() => expectOwnDaemonDir(tmp)).toThrow('refusing to stop it');
  });

  it('daemonStop reports not-running when nothing is recorded', async () => {
    expectOwnDaemonDir(tmp);
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

    it('旧日志含中文时按字节偏移切分：既不回放上一轮的报错，也不漏掉这次的', () => {
      // 中文一个字符 3 字节：按字符位置切会落在旧内容中间（回放旧报错），或越过新内容（漏报）。
      const stale = '启动失败：旧的报错 listen EADDRINUSE: address already in use 127.0.0.1:9999\n'.repeat(3);
      const dir = write(`${stale}listen EACCES: permission denied 127.0.0.1:80\n`);
      expect(tailDaemonLog(dir, 3, Buffer.byteLength(stale))).toEqual(['listen EACCES: permission denied 127.0.0.1:80']);
      // 旧内容字节数大于字符数：按字符切会把这次开头的报错整行跳过。
      const shortStale = '收到飞书消息事件\n';
      const second = write(`${shortStale}listen EACCES: permission denied\n${'Server listening\n'.repeat(5)}`);
      expect(tailDaemonLog(second, 3, Buffer.byteLength(shortStale))).toEqual(['listen EACCES: permission denied']);
    });

    it('偏移超过当前大小（日志被轮转过）时从新文件开头读', () => {
      const dir = write('Error: 轮转后的新报错\n');
      expect(tailDaemonLog(dir, 3, 50 * 1024 * 1024)).toEqual(['Error: 轮转后的新报错']);
    });

    it('日志不存在时返回空，绝不因为取日志而让启动流程崩掉', () => {
      expect(tailDaemonLog(join(tmp, 'nope'))).toEqual([]);
      expect(daemonLogSize(join(tmp, 'nope'))).toBe(0);
    });
  });

  /** 状态文件原子写：并发读的一方（status / resolveDaemonDir）不能读到截断到一半的文件。 */
  it('writeState 先写临时文件再 rename：已打开旧文件的读者读到的仍是完整旧内容，目录里不留临时文件', () => {
    const dir = defaultDaemonDir(tmp);
    const first = { pid: 101, ready: true, startedAt: 'gen-1', cwd: tmp };
    writeState(dir, first);
    const file = daemonPaths(dir).stateFile;
    const reader = openSync(file, 'r');
    try {
      writeState(dir, { pid: 202, ready: false, startedAt: 'gen-2', cwd: tmp, address: 'http://127.0.0.1:4310' });
      const buffer = Buffer.alloc(4096);
      const read = readSync(reader, buffer, 0, buffer.length, 0);
      // 原地覆盖写会先把文件截成 0 再写新内容，同一个句柄读到的是新内容或空文件。
      expect(JSON.parse(buffer.subarray(0, read).toString('utf8'))).toEqual(first);
    } finally {
      closeSync(reader);
    }
    expect(readDaemonStatus(dir)).toMatchObject({ pid: 202, startedAt: 'gen-2' });
    clearState(dir);
    expect(readFileSync(file, 'utf8')).toBe('');
    expect(readFileSync(daemonPaths(dir).pidFile, 'utf8')).toBe('');
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  /**
   * 并发 start：服务进程在「检查状态 → 写状态」之前取得目录排他锁。这里用另一条 SQLite 连接持锁，
   * 模拟另一个 `dutydeck start` 正处在检查和写状态之间。
   */
  it('另一个进程持有启动锁时，前台 start 拒绝：不服务、不写状态', async () => {
    const dir = defaultDaemonDir(tmp);
    mkdirSync(dir, { recursive: true });
    const holder = new Database(join(dir, '.start-lock.sqlite'));
    holder.exec('BEGIN IMMEDIATE');
    const serve = vi.fn();
    try {
      const result = await daemonStart({ foreground: true }, { serve }, { HOME: tmp });
      expect(result).toMatchObject({ ok: false, action: 'start', state: 'already-running' });
      expect(result.error).toContain('start lock');
      expect(serve).not.toHaveBeenCalled();
      expect(existsSync(daemonPaths(dir).stateFile)).toBe(false);
    } finally {
      holder.close();
    }
    // 锁释放后照常启动。
    const started = await daemonStart({ foreground: true }, { serve }, { HOME: tmp });
    expect(started).toMatchObject({ ok: true, running: true });
    expect(serve).toHaveBeenCalledTimes(1);
    releaseStartLock(dir);
  });

  it('deploy / restart --unit 的 systemctl restart 之前轮转超过 10MB 的守护日志', async () => {
    const dir = defaultDaemonDir(tmp);
    mkdirSync(dir, { recursive: true });
    const log = daemonPaths(dir).logFile;
    writeFileSync(log, Buffer.alloc(11 * 1024 * 1024, 'a'));
    const seen: Array<{ args: string; rotated: boolean }> = [];
    const control = systemdServiceControl('dutydeck.service', {
      runCommand: async (_command, args) => {
        seen.push({ args: args.join(' '), rotated: existsSync(`${log}.1`) && !existsSync(log) });
        return { status: 0, stdout: '', stderr: '' };
      }
    }, dir);
    expect(await control.restart()).toBeUndefined();
    // 先 show 查配套的 .socket（这里没有），再 restart。
    expect(seen.filter(call => !call.args.includes(' show '))).toEqual([{ args: '--user restart dutydeck.service', rotated: true }]);
    expect(statSync(`${log}.1`).size).toBe(11 * 1024 * 1024);
  });
});
