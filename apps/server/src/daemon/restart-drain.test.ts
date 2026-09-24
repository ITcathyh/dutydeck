import { childProcessIdentity, type SqliteDriverCheck, type SqliteDriverCheckOptions } from '@dutydeck/storage';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutostartCommandOutput } from '../autostart/autostart.js';
import { daemonRestart } from './command.js';
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
          `ExecStart={ path=${UNIT_EXEC} ; argv[]=${UNIT_EXEC} ${UNIT_SCRIPT} start --foreground ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`
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

describe('restart 前等待正在执行的任务结束（drain）', () => {
  let tmp: string;
  let dir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  const children: ChildProcess[] = [];

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

  function daemonState(child: ChildProcess, startedAt: string, managed = true): DaemonState {
    return {
      pid: child.pid!, processIdentity: childProcessIdentity(child.pid!), ready: true, startedAt, cwd: tmp,
      address: 'http://127.0.0.1:4391', authEnabled: false,
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
    const counts = [2, 1, 0];
    const fetcher = vi.fn(async () => activityResponse(counts.shift() ?? 0));
    const sleeper = vi.fn(async () => {});
    const info = vi.fn();
    const warn = vi.fn();

    const result = await daemonRestart({}, {
      serve: vi.fn(), runCommand: world.run, platform: 'linux', checkSqlite: passingSqlite,
      fetch: fetcher, sleep: sleeper, info, warn
    });

    expect(result).toMatchObject({ ok: true, action: 'restart', state: 'restarted' });
    expect(fetcher).toHaveBeenCalledTimes(3);
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
    const fetcher = vi.fn(async () => activityResponse(1));
    let clock = 0;
    const sleeper = vi.fn(async () => { clock += 6_000; });
    const info = vi.fn();

    const result = await daemonRestart({ drainTimeout: '10' }, {
      serve: vi.fn(), runCommand: world.run, platform: 'linux', checkSqlite: passingSqlite,
      fetch: fetcher, sleep: sleeper, now: () => clock, info, warn: vi.fn()
    });

    expect(result).toMatchObject({ ok: false, action: 'restart', running: true, pid: old.pid });
    expect(result.error).toContain('旧服务仍在运行');
    expect(result.error).toContain('1 个任务');
    expect(result.error).toContain('--force');
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

  it('查询失败（旧版本 404）时输出警告并继续 restart', async () => {
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
    const fetcher = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as never);
    const warn = vi.fn();

    const result = await daemonRestart({}, {
      serve: vi.fn(), runCommand: world.run, platform: 'linux', checkSqlite: passingSqlite,
      fetch: fetcher, sleep: vi.fn(), info: vi.fn(), warn
    });

    expect(result).toMatchObject({ ok: true, action: 'restart', state: 'restarted' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('查询正在执行的任务数失败');
    expect(world.calls).toContain(`systemctl --user restart ${UNIT}`);
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
});
