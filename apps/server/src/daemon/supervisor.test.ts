import { childProcessIdentity, currentProcessIdentity, type SqliteDriverCheck, type SqliteDriverCheckOptions } from '@dutydeck/storage';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutostartCommandOutput } from '../autostart/autostart.js';
import { daemonRestart, daemonStart, daemonStatus, daemonStop, systemdRestartTarget } from './command.js';
import { defaultDaemonDir, lastDaemonDirPointerFile, pidAlive, readDaemonStatus, writeLastDaemonDir, writeState, type DaemonState } from './daemon.js';

const UNIT = 'dutydeck-test.service';
const UNIT_EXEC = '/opt/node22/bin/node';
const UNIT_SCRIPT = '/opt/dutydeck/dist/cli.js';

type Verb = 'show' | 'start' | 'stop' | 'restart';

/** 假的 user systemd：记录每次 systemctl 调用，按 world 回答 show，并在 start/stop/restart 时执行注入的副作用。 */
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
const failingSqlite = (options?: SqliteDriverCheckOptions): SqliteDriverCheck => ({
  ok: false, execPath: options?.execPath ?? '/usr/local/node-v26.5.0/bin/node', nodeVersion: 'v26.5.0', modules: '147',
  error: 'The module better_sqlite3.node was compiled against a different Node.js version using NODE_MODULE_VERSION 127'
});

describe('systemd 托管下的 stop / restart / start 路由', () => {
  let tmp: string;
  let dir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  const children: ChildProcess[] = [];

  /** 一个真实存活的进程，充当 daemon：身份校验必须对真 PID 通过。 */
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
    tmp = mkdtempSync(join(tmpdir(), 'dutydeck-supervisor-'));
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

  // ─── stop ────────────────────────────────────────────────────────────────

  it('stop：受托管时调用 systemctl stop，不直接发信号，并按状态文件核验旧进程已退出', async () => {
    const daemon = idleProcess();
    writeState(dir, daemonState(daemon, 'gen-1'));
    const signals = vi.spyOn(process, 'kill');
    const world = systemctl({ mainPid: daemon.pid, on: { stop: () => kill(daemon) } });

    const result = await daemonStop({ runCommand: world.run, platform: 'linux' });

    expect(result).toEqual({ ok: true, action: 'stop', running: false, pid: daemon.pid, state: 'stopped' });
    expect(world.calls).toContain(`systemctl --user stop ${UNIT}`);
    expect(signals.mock.calls.filter(([, signal]) => signal === 'SIGTERM' || signal === 'SIGKILL')).toEqual([]);
    expect(readDaemonStatus(dir)).toBeUndefined();
  });

  it('stop：不受托管时照旧由 CLI 发信号，不调用 systemctl', async () => {
    const daemon = idleProcess();
    writeState(dir, daemonState(daemon, 'gen-1', false));
    const world = systemctl({ mainPid: daemon.pid });

    const result = await daemonStop({ runCommand: world.run, platform: 'linux' });

    expect(result).toMatchObject({ ok: true, action: 'stop', running: false, pid: daemon.pid, state: 'stopped' });
    expect(world.calls).toEqual([]);
    expect(pidAlive(daemon.pid!)).toBe(false);
  });

  it('stop：systemctl stop 失败时给出可操作的报错，进程与状态都保留', async () => {
    const daemon = idleProcess();
    const state = daemonState(daemon, 'gen-1');
    writeState(dir, state);
    const world = systemctl({ mainPid: daemon.pid, fail: { stop: { status: 1, stdout: '', stderr: `Failed to stop ${UNIT}: Access denied\n` } } });

    const result = await daemonStop({ runCommand: world.run, platform: 'linux' });

    expect(result).toMatchObject({ ok: false, action: 'stop', running: true, pid: daemon.pid });
    expect(result.error).toContain('Access denied');
    expect(result.error).toContain(`systemctl --user status ${UNIT}`);
    expect(pidAlive(daemon.pid!)).toBe(true);
    expect(readDaemonStatus(dir)).toEqual(state);
  });

  it('stop：连不上 user systemd 时拒绝，不退回直接发信号（Restart=always 会立刻重拉）', async () => {
    const daemon = idleProcess();
    const state = daemonState(daemon, 'gen-1');
    writeState(dir, state);
    const world = systemctl({ fail: { show: { status: 1, stdout: '', stderr: 'Failed to connect to bus' } } });

    const result = await daemonStop({ runCommand: world.run, platform: 'linux' });

    expect(result).toMatchObject({ ok: false, action: 'stop', running: true });
    expect(result.error).toContain('XDG_RUNTIME_DIR');
    expect(world.calls.some(call => call.includes(' stop '))).toBe(false);
    expect(pidAlive(daemon.pid!)).toBe(true);
    expect(readDaemonStatus(dir)).toEqual(state);
  });

  it('stop：状态记录的 unit 与 systemd 报告的 MainPID 对不上时不做任何改动', async () => {
    const daemon = idleProcess();
    writeState(dir, daemonState(daemon, 'gen-1'));
    const world = systemctl({ mainPid: 999_999 });

    const result = await daemonStop({ runCommand: world.run, platform: 'linux' });

    expect(result).toMatchObject({ ok: false, action: 'stop' });
    expect(result.error).toContain('MainPID');
    expect(world.calls).toEqual([expect.stringContaining(`systemctl --user show ${UNIT}`)]);
    expect(pidAlive(daemon.pid!)).toBe(true);
  });

  it('stop：托管的 daemon 刚崩溃、unit 正在等待重拉时也交给 systemctl stop，并清掉停止期间拉起的新一代', async () => {
    const dead = idleProcess();
    writeState(dir, daemonState(dead, 'gen-1'));
    await kill(dead);
    const world = systemctl({
      workingDirectory: tmp, subState: 'auto-restart',
      // 停止任务执行期间 unit 恰好拉起了 gen-2，它随 unit 一起被停掉
      on: { stop: async () => { const next = idleProcess(); writeState(dir, daemonState(next, 'gen-2')); await kill(next); } }
    });

    const result = await daemonStop({ runCommand: world.run, platform: 'linux' });

    expect(result).toEqual({ ok: true, action: 'stop', running: false, pid: dead.pid, state: 'stopped' });
    expect(world.calls).toContain(`systemctl --user stop ${UNIT}`);
    expect(readDaemonStatus(dir)).toBeUndefined();
  });

  it('stop：托管的 daemon 已死且 unit 也已停下时照旧报 not-running，不调用 systemctl stop', async () => {
    const dead = idleProcess();
    writeState(dir, daemonState(dead, 'gen-1'));
    await kill(dead);
    const world = systemctl({ workingDirectory: tmp, subState: 'dead' });

    const result = await daemonStop({ runCommand: world.run, platform: 'linux' });

    expect(result).toEqual({ ok: true, action: 'stop', running: false, pid: dead.pid, state: 'not-running' });
    expect(world.calls.some(call => call.includes(' stop '))).toBe(false);
  });

  it('stop：systemctl stop 期间出现别的来源写下的记录时保留它', async () => {
    const daemon = idleProcess();
    writeState(dir, daemonState(daemon, 'gen-1'));
    let foreign: DaemonState | undefined;
    const world = systemctl({
      mainPid: daemon.pid,
      on: { stop: async () => { await kill(daemon); const other = idleProcess(); foreign = daemonState(other, 'other', false); writeState(dir, foreign); await kill(other); } }
    });

    const result = await daemonStop({ runCommand: world.run, platform: 'linux' });

    expect(result).toMatchObject({ ok: false, action: 'stop' });
    expect(readDaemonStatus(dir)).toEqual(foreign);
  });

  it('stop：autostart disable 之后（unit not-found，Restart/KillMode 已回到默认）改回直接发信号', async () => {
    const daemon = idleProcess();
    writeState(dir, daemonState(daemon, 'gen-1'));
    const world = systemctl({ loaded: false, mainPid: daemon.pid, environment: '' });

    const result = await daemonStop({ runCommand: world.run, platform: 'linux' });

    expect(result).toMatchObject({ ok: true, action: 'stop', running: false, pid: daemon.pid, state: 'stopped' });
    expect(world.calls.some(call => call.includes(' stop '))).toBe(false);
    expect(pidAlive(daemon.pid!)).toBe(false);
  });

  // ─── restart ─────────────────────────────────────────────────────────────

  it('restart：受托管时先预检 ExecStart 的解释器，再 systemctl restart，等到新一代就绪', async () => {
    const old = idleProcess();
    writeState(dir, daemonState(old, 'gen-1'));
    const checked: Array<SqliteDriverCheckOptions | undefined> = [];
    let next: ChildProcess | undefined;
    const signals = vi.spyOn(process, 'kill');
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

    const result = await daemonRestart({}, {
      serve: vi.fn(), runCommand: world.run, platform: 'linux',
      checkSqlite: options => { checked.push(options); return passingSqlite(options); }
    });

    expect(result).toMatchObject({ ok: true, action: 'restart', running: true, state: 'restarted', pid: next?.pid, address: 'http://127.0.0.1:4391', authentication: 'disabled' });
    expect(checked).toEqual([{ execPath: UNIT_EXEC, resolveFrom: UNIT_SCRIPT }]);
    expect(world.calls.filter(call => !call.includes(' show '))).toEqual([`systemctl --user restart ${UNIT}`]);
    expect(signals.mock.calls.filter(([, signal]) => signal === 'SIGTERM' || signal === 'SIGKILL')).toEqual([]);
  });

  it('restart：systemctl restart 返回后状态文件里仍是旧一代时不报成功', async () => {
    // 比如 unit 起来了却没能发布状态：不能把仍在的旧一代当成「新 pid 就绪」。
    const old = idleProcess();
    const state = daemonState(old, 'gen-1');
    writeState(dir, state);
    const world = systemctl({ mainPid: old.pid, workingDirectory: tmp });

    const result = await daemonRestart({}, { serve: vi.fn(), runCommand: world.run, platform: 'linux', checkSqlite: passingSqlite });

    // 旧一代仍在运行：running 为 true，不再同时报 state: 'not-running'。
    expect(result).toMatchObject({ ok: false, action: 'restart', running: true });
    expect(result.state).toBeUndefined();
    expect(result.error).toContain(`systemctl --user status ${UNIT}`);
    expect(world.calls).toContain(`systemctl --user restart ${UNIT}`);
  }, 30_000);

  it('restart：ExecStart 的解释器加载不了 SQLite 时在调用 systemctl 之前拒绝，旧进程不被停', async () => {
    const old = idleProcess();
    const state = daemonState(old, 'gen-1');
    writeState(dir, state);
    const world = systemctl({ mainPid: old.pid, workingDirectory: tmp });

    const result = await daemonRestart({}, { serve: vi.fn(), runCommand: world.run, platform: 'linux', checkSqlite: failingSqlite });

    expect(result).toMatchObject({ ok: false, action: 'restart', running: true, pid: old.pid });
    expect(result.error).toContain(UNIT_EXEC);
    expect(result.error).toContain('v26.5.0');
    expect(result.error).toContain('process.versions.modules=147');
    expect(result.error).toContain('NODE_MODULE_VERSION 127');
    expect(world.calls.some(call => / (restart|stop) /.test(`${call} `))).toBe(false);
    expect(pidAlive(old.pid!)).toBe(true);
    expect(readDaemonStatus(dir)).toEqual(state);
  });

  it('restart：systemctl restart 失败时报错并指出熔断的解除方式', async () => {
    const old = idleProcess();
    writeState(dir, daemonState(old, 'gen-1'));
    const world = systemctl({ mainPid: old.pid, workingDirectory: tmp, fail: { restart: { status: 1, stdout: '', stderr: `Job for ${UNIT} failed because start of the service was attempted too often.\n` } } });

    const result = await daemonRestart({}, { serve: vi.fn(), runCommand: world.run, platform: 'linux', checkSqlite: passingSqlite });

    expect(result).toMatchObject({ ok: false, action: 'restart' });
    expect(result.error).toContain('attempted too often');
    expect(result.error).toContain(`systemctl --user reset-failed ${UNIT}`);
  });

  it('restart：受托管时拒绝传不过去的命令行参数，不调用 systemctl restart', async () => {
    const old = idleProcess();
    writeState(dir, daemonState(old, 'gen-1'));
    const world = systemctl({ mainPid: old.pid, workingDirectory: tmp });

    const result = await daemonRestart({ port: '4410', larkListen: true }, { serve: vi.fn(), runCommand: world.run, platform: 'linux', checkSqlite: passingSqlite });

    expect(result).toMatchObject({ ok: false, action: 'restart', running: true });
    expect(result.error).toContain('--port');
    expect(result.error).not.toContain('lark-listen');
    expect(world.calls.some(call => call.includes(' restart '))).toBe(false);
    expect(pidAlive(old.pid!)).toBe(true);
  });

  it('restart（detached）：当前解释器预检失败时在 daemonStop 之前拒绝，旧进程不被停', async () => {
    const old = idleProcess();
    const state = daemonState(old, 'gen-1', false);
    writeState(dir, state);
    const signals = vi.spyOn(process, 'kill');
    const world = systemctl({});

    const result = await daemonRestart({}, { serve: vi.fn(), runCommand: world.run, platform: 'linux', checkSqlite: failingSqlite });

    expect(result).toMatchObject({ ok: false, action: 'restart', running: true, pid: old.pid });
    expect(result.error).toContain('旧的守护进程仍在运行');
    expect(result.error).toContain('NODE_MODULE_VERSION 127');
    expect(signals.mock.calls.filter(([, signal]) => signal === 'SIGTERM' || signal === 'SIGKILL')).toEqual([]);
    expect(world.calls).toEqual([]);
    expect(pidAlive(old.pid!)).toBe(true);
    expect(readDaemonStatus(dir)).toEqual(state);
  });

  it('restart：没有 daemon 在跑且装了托管这个根目录的新模板 unit 时，等同 start 交给 systemd', async () => {
    const dead = idleProcess();
    const stale = daemonState(dead, 'gen-1');
    await kill(dead);
    writeState(dir, stale);
    let next: ChildProcess | undefined;
    const world = systemctl({
      workingDirectory: tmp, subState: 'dead',
      on: { start: async () => { next = idleProcess(); writeState(dir, daemonState(next, 'gen-2')); } }
    });

    const result = await daemonRestart({}, { serve: vi.fn(), runCommand: world.run, platform: 'linux', checkSqlite: passingSqlite }, { HOME: tmp, DUTYDECK_SYSTEMD_UNIT: UNIT });

    expect(result).toMatchObject({ ok: true, action: 'restart', state: 'restarted', pid: next?.pid });
    expect(world.calls.filter(call => !call.includes(' show '))).toEqual([`systemctl --user start ${UNIT}`]);
  });

  it('restart：unit 已被 enable 改写到别的根目录时拒绝，不调用 systemctl restart', async () => {
    const old = idleProcess();
    writeState(dir, daemonState(old, 'gen-1'));
    const world = systemctl({ mainPid: old.pid, workingDirectory: '/somewhere/else' });

    const result = await daemonRestart({}, { serve: vi.fn(), runCommand: world.run, platform: 'linux', checkSqlite: passingSqlite });

    expect(result).toMatchObject({ ok: false, action: 'restart', running: true, pid: old.pid });
    expect(result.error).toContain('/somewhere/else');
    expect(world.calls.some(call => call.includes(' restart '))).toBe(false);
    expect(pidAlive(old.pid!)).toBe(true);
  });

  it('restart：上一代是已死的 detached daemon 时照旧 detached 重启，不改道 systemd', async () => {
    const dead = idleProcess();
    writeState(dir, daemonState(dead, 'gen-1', false));
    await kill(dead);
    const world = systemctl({ workingDirectory: tmp, subState: 'dead' });
    // detached 重启会用 process.argv[1] 拉起自己；换成立即退出的脚本，拿到「立即退出」就证明走的是 detached。
    const script = join(tmp, 'exit-now.mjs');
    writeFileSync(script, 'process.exit(3);\n');
    const argv = process.argv;
    process.argv = [process.execPath, script];
    try {
      const result = await daemonRestart({}, { serve: vi.fn(), runCommand: world.run, platform: 'linux', checkSqlite: passingSqlite }, { HOME: tmp, DUTYDECK_SYSTEMD_UNIT: UNIT });
      expect(result).toMatchObject({ ok: false, action: 'restart', running: false });
      expect(result.error).toContain('退出码 3');
    } finally {
      process.argv = argv;
    }
    expect(world.calls.some(call => call.includes(' start '))).toBe(false);
  });

  it('update 用的 systemdRestartTarget：受托管时给出 unit 的 ExecStart，不受托管时为空', async () => {
    const daemon = idleProcess();
    writeState(dir, daemonState(daemon, 'gen-1'));
    const world = systemctl({ mainPid: daemon.pid });
    expect(await systemdRestartTarget({ runCommand: world.run, platform: 'linux' })).toEqual({ unit: UNIT, execPath: UNIT_EXEC, script: UNIT_SCRIPT });

    writeState(dir, daemonState(daemon, 'gen-1', false));
    expect(await systemdRestartTarget({ runCommand: world.run, platform: 'linux' })).toBeUndefined();
  });

  // ─── start ───────────────────────────────────────────────────────────────

  it('start：装了新模板 unit 且它托管这个根目录时改走 systemctl start，等到新一代就绪', async () => {
    let next: ChildProcess | undefined;
    const world = systemctl({
      workingDirectory: tmp, subState: 'dead',
      on: { start: async () => { next = idleProcess(); writeState(dir, daemonState(next, 'gen-1')); } }
    });

    const result = await daemonStart({}, { serve: vi.fn(), runCommand: world.run, platform: 'linux', checkSqlite: passingSqlite }, { HOME: tmp, DUTYDECK_SYSTEMD_UNIT: UNIT });

    expect(result).toMatchObject({ ok: true, action: 'start', running: true, state: 'started', pid: next?.pid, logFile: join(dir, 'dutydeck.log') });
    expect(world.calls).toEqual([expect.stringContaining(`systemctl --user show ${UNIT}`), `systemctl --user start ${UNIT}`]);
  });

  it('start：systemctl start 失败时报错，不退回 detached 另起进程', async () => {
    const world = systemctl({ workingDirectory: tmp, subState: 'failed', fail: { start: { status: 1, stdout: '', stderr: `Job for ${UNIT} failed.\n` } } });

    const result = await daemonStart({}, { serve: vi.fn(), runCommand: world.run, platform: 'linux', checkSqlite: passingSqlite }, { HOME: tmp, DUTYDECK_SYSTEMD_UNIT: UNIT });

    expect(result).toMatchObject({ ok: false, action: 'start', running: false });
    expect(result.error).toContain(`systemctl --user start ${UNIT} 失败`);
    expect(readDaemonStatus(dir)).toBeUndefined();
  });

  it('start：显式给了传不过去的参数时拒绝，不调用 systemctl start', async () => {
    const world = systemctl({ workingDirectory: tmp, subState: 'dead' });

    const result = await daemonStart({ host: '0.0.0.0', auth: false }, { serve: vi.fn(), runCommand: world.run, platform: 'linux' }, { HOME: tmp, DUTYDECK_SYSTEMD_UNIT: UNIT });

    expect(result).toMatchObject({ ok: false, action: 'start' });
    expect(result.error).toContain('--host --no-auth');
    expect(world.calls.some(call => call.includes(' start '))).toBe(false);
  });

  it('start：unit 还停在旧 oneshot 的 active (exited) 时直接指出要 restart，不空等', async () => {
    const world = systemctl({ workingDirectory: tmp, subState: 'exited' });

    const result = await daemonStart({}, { serve: vi.fn(), runCommand: world.run, platform: 'linux' }, { HOME: tmp, DUTYDECK_SYSTEMD_UNIT: UNIT });

    expect(result).toMatchObject({ ok: false, action: 'start' });
    expect(result.error).toContain(`systemctl --user restart ${UNIT}`);
    expect(world.calls.some(call => call.includes(' start '))).toBe(false);
  });

  it('start：unit 的 ExecStart 解释器加载不了 SQLite 时不调用 systemctl start', async () => {
    const checked: Array<SqliteDriverCheckOptions | undefined> = [];
    const world = systemctl({ workingDirectory: tmp, subState: 'dead' });

    const result = await daemonStart({}, {
      serve: vi.fn(), runCommand: world.run, platform: 'linux',
      checkSqlite: options => { checked.push(options); return failingSqlite(options); }
    }, { HOME: tmp, DUTYDECK_SYSTEMD_UNIT: UNIT });

    expect(result).toMatchObject({ ok: false, action: 'start', running: false });
    expect(result.error).toContain('NODE_MODULE_VERSION 127');
    expect(checked).toEqual([{ execPath: UNIT_EXEC, resolveFrom: UNIT_SCRIPT }]);
    expect(world.calls.some(call => call.includes(' start '))).toBe(false);
  });

  it.each([
    ['旧 oneshot unit（没有托管声明）', { environment: 'PATH=/usr/bin', workingDirectory: '<tmp>' }, 'linux'],
    ['unit 托管的是别的根目录', { workingDirectory: '/somewhere/else' }, 'linux'],
    ['unit 未安装', { loaded: false, workingDirectory: '<tmp>' }, 'linux'],
    ['user systemd 不可用', { fail: { show: { status: 1, stdout: '', stderr: 'Failed to connect to bus' } } }, 'linux'],
    ['非 Linux', { workingDirectory: '<tmp>' }, 'darwin']
  ] as const)('start：%s 时照旧走 detached', async (_label, shape, platform) => {
    const world = systemctl({ ...shape, ...('workingDirectory' in shape ? { workingDirectory: shape.workingDirectory === '<tmp>' ? tmp : shape.workingDirectory } : {}) } as World);
    // detached 路径会用 process.argv[1] 重新拉起自己；换成一个立即退出的脚本，拿到「立即退出」就证明走的是 detached。
    const script = join(tmp, 'exit-now.mjs');
    writeFileSync(script, 'process.exit(3);\n');
    const argv = process.argv;
    process.argv = [process.execPath, script];
    try {
      const result = await daemonStart({}, { serve: vi.fn(), runCommand: world.run, platform }, { HOME: tmp, DUTYDECK_SYSTEMD_UNIT: UNIT });
      expect(result).toMatchObject({ ok: false, action: 'start', running: false });
      expect(result.error).toContain('退出码 3');
    } finally {
      process.argv = argv;
    }
    expect(world.calls.some(call => call.includes(' start '))).toBe(false);
    if (platform === 'darwin') expect(world.calls).toEqual([]);
  });

  // ─── 前台入口 ────────────────────────────────────────────────────────────

  const systemdEnv = (): NodeJS.ProcessEnv => ({ HOME: tmp, DUTYDECK_SUPERVISOR: 'systemd', DUTYDECK_SYSTEMD_UNIT: UNIT, DUTYDECK_PORT: '4391', DUTYDECK_AUTH: 'false' });

  it('start --foreground：本进程作为 daemon 写状态并记下托管它的 unit，status 与身份校验照常', async () => {
    const world = systemctl({});
    const serve = vi.fn((_options: unknown, ready?: () => void) => { ready?.(); });

    const result = await daemonStart({ foreground: true }, { serve, runCommand: world.run, platform: 'linux' }, systemdEnv());

    expect(result).toMatchObject({ ok: true, action: 'start', running: true, pid: process.pid, authentication: 'disabled' });
    expect(serve).toHaveBeenCalledOnce();
    expect(serve).toHaveBeenCalledWith(expect.objectContaining({ database: join(tmp, '.dutydeck', 'dutydeck.db') }), expect.any(Function));
    expect(readDaemonStatus(dir)).toMatchObject({
      pid: process.pid, processIdentity: currentProcessIdentity(), ready: true, cwd: tmp,
      address: 'http://127.0.0.1:4391', authEnabled: false, supervisor: 'systemd', systemdUnit: UNIT
    });
    expect(daemonStatus()).toMatchObject({ running: true, processStatus: 'verified', pid: process.pid, ready: true });
    expect(readFileSync(lastDaemonDirPointerFile(tmp), 'utf8').trim()).toBe(dir);
    // 前台入口自己就是服务进程：不再调用 systemctl，也不派生子进程
    expect(world.calls).toEqual([]);
  });

  it('start --foreground：读完托管声明就从 process.env 删掉，服务期间派生的 Agent 不会继承', async () => {
    vi.stubEnv('DUTYDECK_SUPERVISOR', 'systemd');
    vi.stubEnv('DUTYDECK_SYSTEMD_UNIT', UNIT);
    let seen: NodeJS.ProcessEnv | undefined;
    const serve = vi.fn((_options: unknown, ready?: () => void) => { seen = { ...process.env }; ready?.(); });

    await daemonStart({ foreground: true }, { serve, platform: 'linux' }, process.env);

    expect(readDaemonStatus(dir)).toMatchObject({ pid: process.pid, supervisor: 'systemd', systemdUnit: UNIT });
    expect(seen).not.toHaveProperty('DUTYDECK_SUPERVISOR');
    expect(seen).not.toHaveProperty('DUTYDECK_SYSTEMD_UNIT');
    expect(process.env).not.toHaveProperty('DUTYDECK_SUPERVISOR');
    expect(process.env).not.toHaveProperty('DUTYDECK_SYSTEMD_UNIT');
  });

  it('start --foreground：没有托管声明时不记录 supervisor', async () => {
    await daemonStart({ foreground: true }, { serve: vi.fn(), platform: 'linux' }, { HOME: tmp });
    const state = readDaemonStatus(dir);
    expect(state).toMatchObject({ pid: process.pid, ready: false });
    expect(state).not.toHaveProperty('supervisor');
    expect(state).not.toHaveProperty('systemdUnit');
  });

  it('start --foreground：已有通过校验的 daemon 时拒绝，不服务、不改状态', async () => {
    const other = idleProcess();
    const state = daemonState(other, 'gen-1', false);
    writeState(dir, state);
    const serve = vi.fn();

    const result = await daemonStart({ foreground: true }, { serve, platform: 'linux' }, systemdEnv());

    expect(result).toMatchObject({ ok: false, action: 'start', running: true, pid: other.pid, state: 'already-running' });
    expect(serve).not.toHaveBeenCalled();
    expect(readDaemonStatus(dir)).toEqual(state);
  });

  it('start --foreground：清掉上一代留下的陈旧状态后发布自己（SIGKILL 后被 systemd 重拉的情形）', async () => {
    const dead = idleProcess();
    const stale = daemonState(dead, 'gen-1');
    await kill(dead);
    writeState(dir, stale);

    const result = await daemonStart({ foreground: true }, { serve: vi.fn((_o: unknown, ready?: () => void) => { ready?.(); }), platform: 'linux' }, systemdEnv());

    expect(result).toMatchObject({ ok: true, pid: process.pid });
    const state = readDaemonStatus(dir);
    expect(state).toMatchObject({ pid: process.pid, ready: true, supervisor: 'systemd' });
    expect(state?.startedAt).not.toBe('gen-1');
  });

  it('start --foreground：本根目录还没有数据库、指针却指向别的根目录时拒绝，不建空库、不改指针', async () => {
    const elsewhere = join(tmp, 'project', '.dutydeck', 'daemon');
    mkdirSync(elsewhere, { recursive: true });
    writeLastDaemonDir(elsewhere, tmp);
    const serve = vi.fn();

    const result = await daemonStart({ foreground: true }, { serve, platform: 'linux' }, systemdEnv());

    expect(result).toMatchObject({ ok: false, action: 'start', running: false });
    expect(result.error).toContain(elsewhere);
    expect(result.error).toContain('autostart enable');
    expect(serve).not.toHaveBeenCalled();
    expect(readDaemonStatus(dir)).toBeUndefined();
    expect(readFileSync(lastDaemonDirPointerFile(tmp), 'utf8').trim()).toBe(elsewhere);
  });

  it('start --foreground：数据库已在本根目录时照常服务并接管指针（崩溃重拉的常见情形）', async () => {
    const elsewhere = join(tmp, 'project', '.dutydeck', 'daemon');
    mkdirSync(elsewhere, { recursive: true });
    writeLastDaemonDir(elsewhere, tmp);
    mkdirSync(join(tmp, '.dutydeck'), { recursive: true });
    writeFileSync(join(tmp, '.dutydeck', 'dutydeck.db'), '');

    const result = await daemonStart({ foreground: true }, { serve: vi.fn(), platform: 'linux' }, systemdEnv());

    expect(result).toMatchObject({ ok: true, pid: process.pid });
    expect(readFileSync(lastDaemonDirPointerFile(tmp), 'utf8').trim()).toBe(dir);
  });

  it('detached 子进程不认继承来的托管声明', async () => {
    await daemonStart({}, { serve: vi.fn(), platform: 'linux' }, {
      ...systemdEnv(), DUTYDECK_DAEMONIZED: '1', DUTYDECK_DAEMON_CWD: tmp, DUTYDECK_DAEMON_STARTED_AT: 'child-gen'
    });
    const state = readDaemonStatus(dir);
    expect(state).toMatchObject({ pid: process.pid, startedAt: 'child-gen' });
    expect(state).not.toHaveProperty('supervisor');
  });
});
