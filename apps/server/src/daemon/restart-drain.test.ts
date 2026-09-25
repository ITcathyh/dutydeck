import { childProcessIdentity, type SqliteDriverCheck, type SqliteDriverCheckOptions } from '@dutydeck/storage';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutostartCommandOutput } from '../autostart/autostart.js';
import { daemonRestart, daemonStart, waitForRunningTasksDrain } from './command.js';
import { localLoopbackUrl } from '../local-api-url.js';
import { defaultDaemonDir, pidAlive, readDaemonStatus, writeState, type DaemonState } from './daemon.js';

const UNIT = 'dutydeck-test.service';
const UNIT_EXEC = '/opt/node22/bin/node';
const UNIT_SCRIPT = '/opt/dutydeck/dist/cli.js';

type Verb = 'show' | 'start' | 'stop' | 'restart';

interface World {
  loaded?: boolean;
  subState?: string;
  mainPid?: number;
  environment?: string;
  workingDirectory?: string;
  /** ExecStart 里入口脚本之后的参数，默认 `start --foreground`。 */
  args?: string;
  fail?: Partial<Record<Verb, AutostartCommandOutput>>;
  on?: Partial<Record<Exclude<Verb, 'show'>, () => Promise<void>>>;
}

function systemctl(world: World) {
  const calls: string[] = [];
  const run = async (command: string, args: readonly string[]): Promise<AutostartCommandOutput> => {
    calls.push([command, ...args].join(' '));
    const verb = args[1] as Verb;
    const failure = world.fail?.[verb];
    if (failure) return failure;
    if (verb === 'show') {
      return {
        status: 0,
        stderr: '',
        stdout: [
          `LoadState=${world.loaded === false ? 'not-found' : 'loaded'}`,
          `SubState=${world.subState ?? 'running'}`,
          `MainPID=${world.mainPid ?? 0}`,
          `Environment=${world.environment ?? `PATH=/usr/bin DUTYDECK_SUPERVISOR=systemd DUTYDECK_SYSTEMD_UNIT=${UNIT}`}`,
          `WorkingDirectory=${world.workingDirectory ?? ''}`,
          `ExecStart={ path=${UNIT_EXEC} ; argv[]=${UNIT_EXEC} ${UNIT_SCRIPT} ${world.args ?? 'start --foreground'} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`
        ].join('\n') + '\n'
      };
    }
    await world.on?.[verb as Exclude<Verb, 'show'>]?.();
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, run };
}

const passingSqlite = (options?: SqliteDriverCheckOptions): SqliteDriverCheck => ({ ok: true, execPath: options?.execPath ?? process.execPath });

function activityResponse(runningTasks: number) {
  return { ok: true, status: 200, json: async () => ({ runningTasks }) } as unknown as Response;
}

/** 按路径应答的假 API：排空请求记下 draining 并按 drainStatus 应答，任务数查询依次返回 counts。 */
function daemonApi(counts: number[], options: { drainStatus?: number; activityStatus?: number } = {}) {
  const drains: boolean[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (new URL(url).pathname === '/api/system/drain') {
      drains.push(JSON.parse(String(init?.body)).draining);
      return (options.drainStatus ? { ok: false, status: options.drainStatus, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ draining: true }) }) as unknown as Response;
    }
    if (options.activityStatus) return { ok: false, status: options.activityStatus, json: async () => ({}) } as unknown as Response;
    return activityResponse(counts.shift() ?? 0);
  });
  const activity = () => fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/api/system/activity').length;
  return { fetch, drains, activity };
}

describe('restart 前等待正在执行的任务结束（drain）', () => {
  let tmp: string;
  let dir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  const children: ChildProcess[] = [];
  const servers: Server[] = [];

  function idleProcess(): ChildProcess {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(child);
    return child;
  }

  async function kill(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  }

  /** 起一个本地 HTTP server；handler 决定如何应答。 */
  function localServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ address: string; close: () => Promise<void> }> {
    return new Promise((resolve, reject) => {
      const server = createServer(handler);
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        servers.push(server);
        resolve({
          address: `http://127.0.0.1:${port}`,
          close: async () => await new Promise<void>(done => server.close(() => done()))
        });
      });
    });
  }

  function daemonState(child: ChildProcess, startedAt: string, managed = true, address = 'http://127.0.0.1:4391'): DaemonState {
    return {
      pid: child.pid!, processIdentity: childProcessIdentity(child.pid!), ready: true, startedAt, cwd: tmp,
      address, authEnabled: false,
      ...(managed ? { supervisor: 'systemd' as const, systemdUnit: UNIT } : {})
    };
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dutydeck-drain-'));
    dir = defaultDaemonDir(tmp);
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmp);
    vi.stubEnv('HOME', tmp);
  });

  afterEach(async () => {
    for (const child of children.splice(0)) await kill(child);
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    cwdSpy.mockRestore();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('有任务在执行时先等待，归零后才 systemctl restart', async () => {
    const old = idleProcess();
    writeState(dir, daemonState(old, 'gen-1'));
    let next: ChildProcess | undefined;
    const world = systemctl({
      mainPid: old.pid, workingDirectory: tmp,
      on: {
        restart: async () => {
          await kill(old);
          next = idleProcess();
          writeState(dir, daemonState(next, 'gen-2'));
        }
      }
    });
    const api = daemonApi([2, 1, 0]);
    const sleeper = vi.fn(async () => {});
    const info = vi.fn();
    const warn = vi.fn();

    const result = await daemonRestart({}, {
      serve: vi.fn(), runCommand: world.run, platform: 'linux', checkSqlite: passingSqlite,
      fetch: api.fetch, sleep: sleeper, info, warn
    });

    expect(result).toMatchObject({ ok: true, action: 'restart', state: 'restarted' });
    expect(api.activity()).toBe(3);
    // 查询前先进入排空，之后每轮续租；成功后保持排空，直到旧进程被 restart 停掉。
    expect(api.drains).toEqual([true, true, true]);
    expect(api.fetch.mock.calls[0]![0]).toContain('/api/system/drain');
    expect(sleeper).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('有 2 个任务正在执行'));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('--force'));
    expect(world.calls.filter(call => !call.includes(' show '))).toEqual([`systemctl --user restart ${UNIT}`]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('超时仍有任务在执行时不调用 restart，返回 ok:false，旧进程与状态保留', async () => {
    const old = idleProcess();
    const state = daemonState(old, 'gen-1');
    writeState(dir, state);
    const world = systemctl({ mainPid: old.pid, workingDirectory: tmp });
    const api = daemonApi([1, 1, 1, 1]);
    let clock = 0;
    const sleeper = vi.fn(async () => { clock += 6_000; });
    const info = vi.fn();

    const result = await daemonRestart({ drainTimeout: '10' }, {
      serve: vi.fn(), runCommand: world.run, platform: 'linux', checkSqlite: passingSqlite,
      fetch: api.fetch, sleep: sleeper, now: () => clock, info, warn: vi.fn()
    });

    expect(result).toMatchObject({ ok: false, action: 'restart', running: true, pid: old.pid });
    expect(result.error).toContain('旧服务仍在运行');
    expect(result.error).toContain('1 个任务');
    expect(result.error).toContain('--force');
    // 放弃重启时退出排空，旧进程接着执行排队的任务。
    expect(api.drains.at(0)).toBe(true);
    expect(api.drains.at(-1)).toBe(false);
    expect(world.calls.some(call => call.includes(' restart '))).toBe(false);
    expect(pidAlive(old.pid!)).toBe(true);
    expect(readDaemonStatus(dir)).toEqual(state);
  });

  it('--force 时不查询任务数，直接 restart', async () => {
    const old = idleProcess();
    writeState(dir, daemonState(old, 'gen-1'));
    let next: ChildProcess | undefined;
    const world = systemctl({
      mainPid: old.pid, workingDirectory: tmp,
      on: {
        restart: async () => {
          await kill(old);
          next = idleProcess();
          writeState(dir, daemonState(next, 'gen-2'));
        }
      }
    });
    const fetcher = vi.fn();

    const result = await daemonRestart({ force: true }, {
      serve: vi.fn(), runCommand: world.run, platform: 'linux', checkSqlite: passingSqlite,
      fetch: fetcher, sleep: vi.fn(), info: vi.fn(), warn: vi.fn()
    });

    expect(result).toMatchObject({ ok: true, action: 'restart', state: 'restarted' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(world.calls).toContain(`systemctl --user restart ${UNIT}`);
  });

  it('查询任务数失败时拒绝重启并提示 --force，同时退出排空', async () => {
    const old = idleProcess();
    const state = daemonState(old, 'gen-1');
    writeState(dir, state);
    const world = systemctl({ mainPid: old.pid, workingDirectory: tmp });
    const api = daemonApi([], { activityStatus: 500 });

    const result = await daemonRestart({}, {
      serve: vi.fn(), runCommand: world.run, platform: 'linux', checkSqlite: passingSqlite,
      fetch: api.fetch, sleep: vi.fn(), info: vi.fn(), warn: vi.fn()
    });

    expect(result).toMatchObject({ ok: false, action: 'restart', running: true, pid: old.pid });
    expect(result.error).toContain('查询正在执行的任务数失败（HTTP 500）');
    expect(result.error).toContain('--force');
    expect(api.drains).toEqual([true, false]);
    expect(world.calls.some(call => call.includes(' restart '))).toBe(false);
    expect(pidAlive(old.pid!)).toBe(true);
    expect(readDaemonStatus(dir)).toEqual(state);
  });

  it('监听地址不可用于本机查询时同样拒绝重启', async () => {
    const old = idleProcess();
    writeState(dir, daemonState(old, 'gen-1', true, 'http://192.0.2.1:4310'));
    const world = systemctl({ mainPid: old.pid, workingDirectory: tmp });
    const api = daemonApi([0]);

    const result = await daemonRestart({}, {
      serve: vi.fn(), runCommand: world.run, platform: 'linux', checkSqlite: passingSqlite,
      fetch: api.fetch, sleep: vi.fn(), info: vi.fn(), warn: vi.fn(), localAddresses: () => []
    });

    expect(result).toMatchObject({ ok: false, action: 'restart', running: true });
    expect(result.error).toContain('--force');
    expect(api.fetch).not.toHaveBeenCalled();
    expect(world.calls.some(call => call.includes(' restart '))).toBe(false);
  });

  it('服务不支持排空（旧版本 404）时告警，照常等待后重启', async () => {
    const old = idleProcess();
    writeState(dir, daemonState(old, 'gen-1'));
    const world = systemctl({
      mainPid: old.pid, workingDirectory: tmp,
      on: { restart: async () => { await kill(old); writeState(dir, daemonState(idleProcess(), 'gen-2')); } }
    });
    const api = daemonApi([1, 0], { drainStatus: 404 });
    const warn = vi.fn();

    const result = await daemonRestart({}, {
      serve: vi.fn(), runCommand: world.run, platform: 'linux', checkSqlite: passingSqlite,
      fetch: api.fetch, sleep: vi.fn(), info: vi.fn(), warn
    });

    expect(result).toMatchObject({ ok: true, action: 'restart', state: 'restarted' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('不支持排空');
    expect(api.activity()).toBe(2);
    expect(world.calls).toContain(`systemctl --user restart ${UNIT}`);
  });

  it('systemctl restart 失败时退出排空，旧进程继续执行排队任务', async () => {
    const old = idleProcess();
    writeState(dir, daemonState(old, 'gen-1'));
    const world = systemctl({ mainPid: old.pid, workingDirectory: tmp, fail: { restart: { status: 1, stdout: '', stderr: 'Job failed' } } });
    const api = daemonApi([0]);

    const result = await daemonRestart({}, {
      serve: vi.fn(), runCommand: world.run, platform: 'linux', checkSqlite: passingSqlite,
      fetch: api.fetch, sleep: vi.fn(), info: vi.fn(), warn: vi.fn()
    });

    expect(result).toMatchObject({ ok: false, action: 'restart' });
    expect(result.error).toContain('Job failed');
    expect(api.drains).toEqual([true, false]);
  });

  it('detached 路径超时也不发信号停止旧进程', async () => {
    const old = idleProcess();
    const state = daemonState(old, 'gen-1', false);
    writeState(dir, state);
    const signals = vi.spyOn(process, 'kill');
    const world = systemctl({});
    const fetcher = vi.fn(async () => activityResponse(3));
    let clock = 0;

    const result = await daemonRestart({ drainTimeout: '5' }, {
      serve: vi.fn(), runCommand: world.run, platform: 'linux', checkSqlite: passingSqlite,
      fetch: fetcher, sleep: async () => { clock += 6_000; }, now: () => clock, info: vi.fn(), warn: vi.fn()
    });

    expect(result).toMatchObject({ ok: false, action: 'restart', running: true, pid: old.pid });
    expect(result.error).toContain('3 个任务');
    expect(signals.mock.calls.filter(([, signal]) => signal === 'SIGTERM' || signal === 'SIGKILL')).toEqual([]);
    expect(pidAlive(old.pid!)).toBe(true);
    expect(readDaemonStatus(dir)).toEqual(state);
  });

  // ── 返修 #2：单次查询 5 秒超时 ────────────────────────────────────────────

  it('查询挂住（只接受连接不应答）时在超时后拒绝重启，不再无限等待', async () => {
    const daemon = idleProcess();
    const server = await localServer(() => { /* 连接建立后永不响应 */ });
    writeState(dir, daemonState(daemon, 'gen-1', false, server.address));
    const warn = vi.fn();
    const started = Date.now();

    const result = await waitForRunningTasksDrain(dir, readDaemonStatus(dir), {}, {
      fetch, warn, info: vi.fn(), requestTimeoutMs: 600
    });

    const elapsed = Date.now() - started;
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toContain('查询正在执行的任务数失败（查询超时（600 ms））');
    expect(!result.ok && result.error).toContain('--force');
    // 排空请求与任务数查询各等一次超时
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    expect(elapsed).toBeLessThan(4_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('进入排空失败');
    await server.close();
  });

  // ── 返修 #3：排除当前 Agent 会话 ──────────────────────────────────────────

  it('设置了 dutydeck_session_id 时请求带 excludeSessionId 并提示已排除本会话', async () => {
    const daemon = idleProcess();
    const requestedUrls: string[] = [];
    const server = await localServer((req, res) => {
      requestedUrls.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ runningTasks: 0 }));
    });
    writeState(dir, daemonState(daemon, 'gen-1', false, server.address));
    vi.stubEnv('dutydeck_session_id', 'ses_self_123');
    const info = vi.fn();

    const result = await waitForRunningTasksDrain(dir, readDaemonStatus(dir), {}, { fetch, info, warn: vi.fn() });

    expect(result).toMatchObject({ ok: true });
    expect(requestedUrls).toContain('/api/system/drain');
    expect(requestedUrls.find(url => url.startsWith('/api/system/activity'))).toContain('excludeSessionId=ses_self_123');
    expect(info).toHaveBeenCalledWith(expect.stringContaining('ses_self_123'));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('排除'));
    await server.close();
  });

  // ── 返修 #4：--drain-timeout 只接受正整数 ────────────────────────────────

  it.each(['0', '-1', 'abc'])('非法 --drain-timeout（%s）在停止任何东西之前报错', async bad => {
    const old = idleProcess();
    const state = daemonState(old, 'gen-1');
    writeState(dir, state);
    const world = systemctl({ mainPid: old.pid, workingDirectory: tmp });
    const fetcher = vi.fn();

    const result = await daemonRestart({ drainTimeout: bad }, {
      serve: vi.fn(), runCommand: world.run, platform: 'linux', checkSqlite: passingSqlite,
      fetch: fetcher, sleep: vi.fn(), info: vi.fn(), warn: vi.fn()
    });

    expect(result).toMatchObject({ ok: false, action: 'restart', running: true, pid: old.pid });
    expect(result.error).toContain('--force');
    expect(fetcher).not.toHaveBeenCalled();
    expect(world.calls.some(call => / (restart|stop) /.test(`${call} `))).toBe(false);
    expect(pidAlive(old.pid!)).toBe(true);
    expect(readDaemonStatus(dir)).toEqual(state);
  });

  it('合法的 --drain-timeout 30 正常进入等待流程', async () => {
    const old = idleProcess();
    writeState(dir, daemonState(old, 'gen-1'));
    let next: ChildProcess | undefined;
    const world = systemctl({
      mainPid: old.pid, workingDirectory: tmp,
      on: { restart: async () => { await kill(old); next = idleProcess(); writeState(dir, daemonState(next, 'gen-2')); } }
    });
    const fetcher = vi.fn(async () => activityResponse(0));

    const result = await daemonRestart({ drainTimeout: '30' }, {
      serve: vi.fn(), runCommand: world.run, platform: 'linux', checkSqlite: passingSqlite,
      fetch: fetcher, sleep: vi.fn(), info: vi.fn(), warn: vi.fn()
    });

    expect(result).toMatchObject({ ok: true, action: 'restart', state: 'restarted' });
    expect(world.calls).toContain(`systemctl --user restart ${UNIT}`);
  });

  // ── 返修 #5：监听 :: 时回环到 127.0.0.1 ──────────────────────────────────

  it('localLoopbackUrl 把 0.0.0.0 与 :: 都映射到 127.0.0.1', () => {
    expect(localLoopbackUrl('::', 4310)).toBe('http://127.0.0.1:4310');
    expect(localLoopbackUrl('0.0.0.0', 4310)).toBe('http://127.0.0.1:4310');
    expect(localLoopbackUrl('::1', 4310)).toBe('http://[::1]:4310');
  });

  it('daemon 以 --host :: 启动记录的地址能在 127.0.0.1 上查到活动并等待', async () => {
    const daemon = idleProcess();
    const counts = [1, 0];
    const server = await localServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ runningTasks: counts.shift() ?? 0 }));
    });
    // markDaemonReady 用 addressFromCli 记录：:: -> http://127.0.0.1:<port>
    const recordedAddress = localLoopbackUrl('::', Number(new URL(server.address).port));
    expect(recordedAddress).toBe(server.address);
    writeState(dir, daemonState(daemon, 'gen-1', false, recordedAddress));

    const result = await waitForRunningTasksDrain(dir, readDaemonStatus(dir), { drainTimeout: '30' }, {
      fetch, sleep: vi.fn(), info: vi.fn(), warn: vi.fn()
    });

    expect(result).toMatchObject({ ok: true });
    await server.close();
  });

  // ── 返修 #6 深入：标记只消费一次并从 process.env 彻底删除 ───────────────

  it('RESTART_DRAINED 标记只消费一次，读完立即从 process.env 删除，紧接着再次等待会正常查询', async () => {
    const daemon = idleProcess();
    const api = daemonApi([0]);
    const fetcher = api.fetch;
    writeState(dir, daemonState(daemon, 'gen-1', false));
    vi.stubEnv('DUTYDECK_DAEMON_RESTART_DRAINED', '1');

    // 第一次：由于有标记，直接跳过等待，不查询活动接口
    const first = await waitForRunningTasksDrain(dir, readDaemonStatus(dir), {}, {
      fetch: fetcher, sleep: vi.fn(), info: vi.fn(), warn: vi.fn()
    });
    expect(first).toEqual({ ok: true });
    expect(fetcher).not.toHaveBeenCalled();
    // 标记已经被删除，不会泄露给后续操作或派生的 Agent
    expect(process.env.DUTYDECK_DAEMON_RESTART_DRAINED).toBeUndefined();

    // 紧接着再执行一次：不再有标记，照常查询活动接口
    const second = await waitForRunningTasksDrain(dir, readDaemonStatus(dir), {}, {
      fetch: fetcher, sleep: vi.fn(), info: vi.fn(), warn: vi.fn()
    });
    expect(second).toMatchObject({ ok: true });
    expect(api.activity()).toBe(1);
  });

  it('daemonStart 在 inBand 守护进程入口处会清理 RESTART_DRAINED 环境变量，防止派生的 Agent 继承', async () => {
    vi.stubEnv('DUTYDECK_DAEMONIZED', '1');
    vi.stubEnv('DUTYDECK_DAEMON_RESTART_DRAINED', '1');
    const serve = vi.fn((_opts, ready) => ready?.());

    await daemonStart({}, { serve }, process.env, false);

    expect(process.env.DUTYDECK_DAEMON_RESTART_DRAINED).toBeUndefined();
  });

  // ── restart --unit：直接 serve 的 bot 运行时 ───────────────────────────────

  /** 起一个假的运行时 API：排空、任务数、健康检查三个接口。 */
  async function runtimeApi(counts: number[], activityStatus = 200) {
    const drains: boolean[] = [];
    const paths: string[] = [];
    const server = await localServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      paths.push(path);
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        if (path === '/api/system/drain') drains.push(JSON.parse(body).draining);
        const status = path === '/api/system/activity' ? activityStatus : 200;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(path === '/api/system/activity' ? { runningTasks: counts.shift() ?? 0 } : path === '/health' ? { ok: true } : { draining: true }));
      });
    });
    return { ...server, drains, paths, port: Number(new URL(server.address).port) };
  }

  it('restart --unit：直接 serve 的 unit 按 ExecStart 找到端口，排空并等任务结束后重启，新进程通过健康检查', async () => {
    const api = await runtimeApi([1, 0]);
    const world: World = {
      mainPid: 4001, workingDirectory: tmp, environment: 'PATH=/usr/bin',
      args: `--database ${join(tmp, 'bot.db')} --cwd ${tmp} --local-only --port ${api.port}`
    };
    world.on = { restart: async () => { world.mainPid = 4002; } };
    const sys = systemctl(world);
    const readToken = vi.fn(() => undefined);
    let clock = 0;

    const result = await daemonRestart({ unit: 'dutydeck-tag.service' }, {
      serve: vi.fn(), runCommand: sys.run, platform: 'linux', checkSqlite: passingSqlite,
      fetch, sleep: async () => { clock += 1_000; }, now: () => clock, readToken, info: vi.fn(), warn: vi.fn()
    });

    expect(result).toMatchObject({ ok: true, action: 'restart', state: 'restarted', pid: 4002, address: `http://127.0.0.1:${api.port}` });
    expect(readToken).toHaveBeenCalledWith(join(tmp, 'bot.db'));
    expect(api.drains).toEqual([true, true]);
    expect(api.paths.filter(path => path === '/api/system/activity')).toHaveLength(2);
    expect(api.paths.at(-1)).toBe('/health');
    expect(sys.calls.filter(call => !call.includes(' show '))).toEqual(['systemctl --user restart dutydeck-tag.service']);
    await api.close();
  });

  it('restart --unit：查询任务数失败时拒绝重启，不调用 systemctl restart', async () => {
    const api = await runtimeApi([], 500);
    const sys = systemctl({ mainPid: 4001, workingDirectory: tmp, environment: 'PATH=/usr/bin', args: `--local-only --port ${api.port}` });

    const result = await daemonRestart({ unit: 'dutydeck-tag.service' }, {
      serve: vi.fn(), runCommand: sys.run, platform: 'linux', checkSqlite: passingSqlite,
      fetch, sleep: vi.fn(), readToken: () => undefined, info: vi.fn(), warn: vi.fn()
    });

    expect(result).toMatchObject({ ok: false, action: 'restart', running: true, pid: 4001 });
    expect(result.error).toContain('--force');
    expect(api.drains).toEqual([true, false]);
    expect(sys.calls.some(call => call.includes(' restart '))).toBe(false);
    await api.close();
  });

  it('restart --unit：start --foreground 的 unit 交给守护状态那条 systemd 重启', async () => {
    const old = idleProcess();
    writeState(dir, daemonState(old, 'gen-1'));
    const world = systemctl({
      mainPid: old.pid, workingDirectory: tmp,
      on: { restart: async () => { await kill(old); writeState(dir, daemonState(idleProcess(), 'gen-2')); } }
    });
    const api = daemonApi([0]);

    const result = await daemonRestart({ unit: UNIT }, {
      serve: vi.fn(), runCommand: world.run, platform: 'linux', checkSqlite: passingSqlite,
      fetch: api.fetch, sleep: vi.fn(), info: vi.fn(), warn: vi.fn()
    });

    expect(result).toMatchObject({ ok: true, action: 'restart', state: 'restarted' });
    expect(world.calls.filter(call => !call.includes(' show '))).toEqual([`systemctl --user restart ${UNIT}`]);
  });
});
