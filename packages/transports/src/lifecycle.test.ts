import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '@dutydeck/shared';
import { JsonlTransport, PipeTransport } from './index.js';

const fixture = resolve(process.cwd(), 'tests/fixtures/transport-lifecycle-agent.mjs');
const dirs: string[] = [];
const transports: JsonlTransport[] = [];

function registerTransport<T extends JsonlTransport>(transport: T): T {
  transports.push(transport);
  return transport;
}

afterEach(async () => {
  // 统一登记 transport 并等待真实 stop；cleanup 失败暴露真实错误，绝不凭裸 PID 盲目杀进程。
  const activeTransports = transports.splice(0);
  try {
    await Promise.all(activeTransports.map(t => t.stop()));
  } finally {
    await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
  }
});

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dutydeck-transport-lifecycle-'));
  dirs.push(dir);
  return dir;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFile = (path: string) => vi.waitFor(() => expect(existsSync(path)).toBe(true), { timeout: 3_000 });

function config(extra: Partial<AgentConfig> & { env?: Record<string, string> } = {}): AgentConfig {
  return { id: 'lifecycle', name: 'lifecycle', command: process.execPath, args: [fixture], protocol: 'jsonl', cwd: process.cwd(), env: {}, permissionMode: 'deny-all', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false, ...extra } as AgentConfig;
}

describe('JsonlTransport process lifecycle', () => {
  it('reports isStopped false before stop and true after the group exits', async () => {
    const dir = await workspace();
    const readyFile = join(dir, 'ready');
    const transport = registerTransport(new JsonlTransport(config({ env: { lifecycle_ready_file: readyFile } }), { onEvent() {} }));
    expect(await transport.isStopped!()).toBe(false);
    await transport.start();
    await waitFile(readyFile);
    expect(await transport.isStopped!()).toBe(false);
    await transport.stop();
    await vi.waitFor(async () => expect(await transport.isStopped!()).toBe(true), { timeout: 3_000 });
  });

  it('resolves consecutive stop calls and stays stopped', async () => {
    const dir = await workspace();
    const readyFile = join(dir, 'ready');
    const transport = registerTransport(new JsonlTransport(config({ env: { lifecycle_ready_file: readyFile } }), { onEvent() {} }));
    await transport.start();
    await waitFile(readyFile);
    await Promise.all([transport.stop(), transport.stop()]);
    await transport.stop();
    expect(await transport.isStopped!()).toBe(true);
  });

  it('rejects start/send/resume after stop and never spawns again', async () => {
    const dir = await workspace();
    const spawnLog = join(dir, 'spawns');
    const transport = registerTransport(new JsonlTransport(config({ env: { lifecycle_spawn_log: spawnLog } }), { onEvent() {} }));
    await transport.start();
    await vi.waitFor(() => expect(readFileSync(spawnLog, 'utf8').trim().split('\n')).toHaveLength(1));
    await transport.stop();
    await expect(transport.start()).rejects.toThrow(/stop/i);
    await expect(transport.send('late')).rejects.toThrow(/stop/i);
    await expect(transport.resume()).rejects.toThrow(/stop/i);
    await vi.waitFor(() => expect(readFileSync(spawnLog, 'utf8').trim().split('\n')).toHaveLength(1), { timeout: 500 });
  });

  it('keeps the process alive across interrupt and allows resume/send', async () => {
    const dir = await workspace();
    const events: string[] = [];
    const transport = registerTransport(new JsonlTransport(config(), { onEvent: event => events.push(event.type) }));
    await transport.start();
    await transport.send('one');
    await vi.waitFor(() => expect(events[events.length - 1]).toBe('completed'));
    await transport.interrupt();
    await transport.resume();
    events.length = 0;
    await transport.send('two');
    await vi.waitFor(() => expect(events[events.length - 1]).toBe('completed'));
    expect(await transport.isStopped!()).toBe(false);
    await transport.stop();
    expect(await transport.isStopped!()).toBe(true);
  });

  it('surfaces spawn failure to the start caller without killing the host, and allows a later retry', async () => {
    const dir = await workspace();
    const transport = registerTransport(new JsonlTransport(config({ command: '/nonexistent-dutydeck-command-xyz' }), { onEvent() {} }));
    await expect(transport.start()).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await transport.isStopped!()).toBe(false);
    await expect(transport.start()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('concurrent start calls share one spawn and one child process', async () => {
    const dir = await workspace();
    const spawnLog = join(dir, 'spawns');
    const transport = registerTransport(new JsonlTransport(config({ env: { lifecycle_spawn_log: spawnLog } }), { onEvent() {} }));
    await Promise.all([transport.start(), transport.start(), transport.start()]);
    await vi.waitFor(() => expect(readFileSync(spawnLog, 'utf8').trim().split('\n')).toHaveLength(1));
    await transport.stop();
  });

  it('escalates to SIGKILL when the process group ignores SIGTERM and still proves exit', async () => {
    const dir = await workspace();
    const readyFile = join(dir, 'ready');
    const transport = registerTransport(new JsonlTransport(
      config({ env: { lifecycle_ready_file: readyFile, lifecycle_ignore_sigterm: '1' } }),
      { onEvent() {}, killGraceMs: 150 },
    ));
    await transport.start();
    await waitFile(readyFile);
    const pid = Number(await readFile(readyFile, 'utf8'));
    await transport.stop();
    expect(alive(pid)).toBe(false);
    expect(await transport.isStopped!()).toBe(true);
  }, 10_000);

  it('keeps isStopped false when stop has begun and leader is dead but grandchild survives SIGTERM', async () => {
    const dir = await workspace();
    const readyFile = join(dir, 'ready');
    const grandchildFile = join(dir, 'grandchild.pid');
    const leaderExited = vi.fn();
    const transport = registerTransport(new JsonlTransport(
      config({ env: {
        lifecycle_ready_file: readyFile,
        lifecycle_orphan_grandchild: '1',
        lifecycle_grandchild_pid_file: grandchildFile,
        lifecycle_grandchild_ignore_sigterm: '1',
      } }),
      { onEvent() {}, onExit: leaderExited, killGraceMs: 300 },
    ));
    await transport.start();
    await waitFile(readyFile);
    await waitFile(grandchildFile);
    const leaderPid = Number(await readFile(readyFile, 'utf8'));
    const grandchildPid = Number(await readFile(grandchildFile, 'utf8'));

    // 等待 leader 自然退出（settled 为 true）
    await vi.waitFor(() => expect(leaderExited).toHaveBeenCalled());
    expect(alive(leaderPid)).toBe(false);
    expect(alive(grandchildPid)).toBe(true);

    // 核心断言：stop() 已经发起（stopped=true 且 leader settled=true）
    // 此时孙代忽略 SIGTERM 仍存活，isStopped 必须返回 false，绝不能因 leader 已 exit 而误判为 true！
    const stopping = transport.stop();
    expect(await transport.isStopped!()).toBe(false);

    // 等待 SIGTERM 超时后升级到 SIGKILL，孙代被强制杀掉
    await stopping;
    expect(alive(grandchildPid)).toBe(false);
    expect(await transport.isStopped!()).toBe(true);
  }, 10_000);

  it('reaps surviving grandchild from previous natural exit before spawning a replacement in the same instance', async () => {
    const dir = await workspace();
    const readyA = join(dir, 'readyA');
    const grandchildA = join(dir, 'grandchildA.pid');
    const readyB = join(dir, 'readyB');
    const leaderExited = vi.fn();

    // 步骤 1：同实例第一次 start，启动一个 leader 自然退出但孙代存活的组
    const transport = registerTransport(new JsonlTransport(
      config({ env: {
        lifecycle_ready_file: readyA,
        lifecycle_orphan_grandchild: '1',
        lifecycle_grandchild_pid_file: grandchildA,
      } }),
      { onEvent() {}, onExit: leaderExited },
    ));
    await transport.start();
    await waitFile(readyA);
    await waitFile(grandchildA);
    const leaderPidA = Number(await readFile(readyA, 'utf8'));
    const grandchildPidA = Number(await readFile(grandchildA, 'utf8'));

    await vi.waitFor(() => expect(leaderExited).toHaveBeenCalled());
    expect(alive(leaderPidA)).toBe(false);
    expect(alive(grandchildPidA)).toBe(true);

    // 步骤 2：在同一个 transport 实例上调用 resume / start
    // 契约要求：先对旧 owned 组收口并证明退出；绝对不能让旧孙代和新子进程同时存活！
    // 动态切换 agent 配置以验证新子进程独立出生到 readyB
    (transport as any).agent = config({ env: { lifecycle_ready_file: readyB } });
    await transport.resume();

    // 验证：旧孙代必须已经死亡！绝不能和新进程并存
    expect(alive(grandchildPidA)).toBe(false);

    // 验证：新 child 正常启动
    await waitFile(readyB);
    const leaderPidB = Number(await readFile(readyB, 'utf8'));
    expect(alive(leaderPidB)).toBe(true);

    // 验证：新 child 正常工作
    const events: string[] = [];
    (transport as any).options.onEvent = (e: any) => events.push(e.type);
    await transport.send('same-instance-turn');
    await vi.waitFor(() => expect(events[events.length - 1]).toBe('completed'));

    await transport.stop();
    expect(alive(leaderPidB)).toBe(false);
    expect(await transport.isStopped!()).toBe(true);
  });

  it('does not let a late exit of one instance clear or stop a replacement instance', async () => {
    const dir = await workspace();
    const readyA = join(dir, 'readyA');
    const readyB = join(dir, 'readyB');
    const exited = vi.fn();
    const first = registerTransport(new JsonlTransport(config({ env: { lifecycle_ready_file: readyA } }), { onEvent() {}, onExit: exited }));
    const eventsB: string[] = [];
    const second = registerTransport(new JsonlTransport(config({ env: { lifecycle_ready_file: readyB } }), { onEvent: event => eventsB.push(event.type) }));
    await Promise.all([first.start(), second.start()]);
    await waitFile(readyA);
    await waitFile(readyB);
    const firstPid = Number(await readFile(readyA, 'utf8'));
    const secondPid = Number(await readFile(readyB, 'utf8'));
    // The first instance dies on its own; its exit callback must not touch the second instance.
    process.kill(-firstPid, 'SIGTERM');
    await vi.waitFor(() => expect(exited).toHaveBeenCalled());
    expect(await second.isStopped!()).toBe(false);
    await second.send('alive');
    await vi.waitFor(() => expect(eventsB[eventsB.length - 1]).toBe('completed'));
    await first.stop();
    await second.stop();
    expect(await first.isStopped!()).toBe(true);
    expect(await second.isStopped!()).toBe(true);
  });

  it('stops an in-flight start and reaps the late process', async () => {
    const dir = await workspace();
    const readyFile = join(dir, 'ready');
    const transport = registerTransport(new JsonlTransport(config({ env: { lifecycle_ready_file: readyFile } }), { onEvent() {} }));
    const starting = transport.start().then(() => 'started', (error: unknown) => error);
    const stopping = transport.stop();
    const outcome = await starting;
    await stopping;
    expect(outcome).toBeInstanceOf(Error);
    if (existsSync(readyFile)) {
      const pid = Number(await readFile(readyFile, 'utf8'));
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3_000 });
    }
    expect(await transport.isStopped!()).toBe(true);
    await expect(transport.start()).rejects.toThrow(/stop/i);
  });

  it('rejects a write after the child closes stdin without an uncaught EPIPE killing the host', async () => {
    const dir = await workspace();
    const readyFile = join(dir, 'ready');
    const transport = registerTransport(new JsonlTransport(
      config({ env: { lifecycle_ready_file: readyFile, lifecycle_close_stdin: '1' } }),
      { onEvent() {} },
    ));
    await transport.start();
    // fixture 在执行 closeSync(0) 之后才会写入 readyFile，因此读端在 waitFile 返回时已 100% 确认关闭
    await waitFile(readyFile);
    const pid = Number(await readFile(readyFile, 'utf8'));
    // 不挂全局 uncaughtException 吞错误，直接验证 send 明确 reject EPIPE，且无未捕获异常外溢导致 vitest 崩溃
    await expect(transport.send('x'.repeat(120_000))).rejects.toThrow();
    await transport.stop();
    expect(await transport.isStopped!()).toBe(true);
  });

  it('a fresh replacement instance starts independently after the old instance stopped', async () => {
    const dir = await workspace();
    const spawnLog = join(dir, 'spawns');
    const first = registerTransport(new JsonlTransport(config({ env: { lifecycle_spawn_log: spawnLog } }), { onEvent() {} }));
    await first.start();
    // start() 只证明 spawn 成功；必须等 A 进程真正落盘，再 stop，否则 A 来不及写日志。
    await vi.waitFor(() => expect(readFileSync(spawnLog, 'utf8').trim().split('\n')).toHaveLength(1));
    await first.stop();
    const replacement = registerTransport(new JsonlTransport(config({ env: { lifecycle_spawn_log: spawnLog } }), { onEvent() {} }));
    await replacement.start();
    await vi.waitFor(() => expect(readFileSync(spawnLog, 'utf8').trim().split('\n')).toHaveLength(2));
    expect(await replacement.isStopped!()).toBe(false);
    await replacement.stop();
    expect(await replacement.isStopped!()).toBe(true);
  });
});

describe('PipeTransport inherited lifecycle', () => {
  it('runs a turn, stops the group, and rejects reuse after stop', async () => {
    const dir = await workspace();
    const events: string[] = [];
    const transport = registerTransport(new PipeTransport(config(), { onEvent: event => events.push(event.type) }));
    await transport.start();
    await transport.send('hello');
    await vi.waitFor(() => expect(events[events.length - 1]).toBe('completed'));
    await transport.stop();
    expect(await transport.isStopped!()).toBe(true);
    await expect(transport.resume()).rejects.toThrow(/stop/i);
  });
});
