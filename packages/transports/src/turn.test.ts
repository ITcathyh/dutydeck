import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '@dutydeck/shared';
import { JsonlTransport, PipeTransport } from './index.js';

const fixture = resolve(process.cwd(), 'tests/fixtures/process-driver-turn-agent.mjs');
const dirs: string[] = [];
const transports: (JsonlTransport | PipeTransport)[] = [];

function registerTransport<T extends JsonlTransport>(transport: T): T {
  transports.push(transport);
  return transport;
}

afterEach(async () => {
  const active = transports.splice(0);
  try {
    await Promise.all(active.map(t => t.stop()));
  } finally {
    await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
  }
});

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dutydeck-turn-test-'));
  dirs.push(dir);
  return dir;
}

const waitFile = (path: string) => vi.waitFor(() => expect(existsSync(path)).toBe(true), { timeout: 3_000 });

function config(extra: Partial<AgentConfig> & { env?: Record<string, string> } = {}): AgentConfig {
  return {
    id: 'turn-agent',
    name: 'TurnAgent',
    command: process.execPath,
    args: [fixture],
    protocol: 'jsonl',
    cwd: process.cwd(),
    env: {},
    permissionMode: 'deny-all',
    timeout: 10,
    capabilities: { pause: false, resume: true },
    builtin: false,
    ...extra
  } as AgentConfig;
}

describe('JsonlTransport turn completion protocol', () => {
  it('reserves a send waiting for real cleanup and revokes it on stop before another submission', async () => {
    const dir = await workspace(), log = join(dir, 'submissions.jsonl');
    const transport = registerTransport(new JsonlTransport(
      config({ timeout: 0.1, env: { turn_agent_submission_log: log } }),
      { onEvent() {}, killGraceMs: 150 }
    ));
    await transport.start();
    const internal = transport as any;
    const signal = internal.signalGroup.bind(transport);
    const launch = vi.spyOn(internal, 'launch');
    // Keep the real child alive through TERM; the existing escalation performs
    // the actual KILL and exit proof while the next send is waiting.
    internal.signalGroup = (owned: unknown, value: NodeJS.Signals) => { if (value !== 'SIGTERM') signal(owned, value); };
    try {
      await expect(transport.send('hang-forever')).rejects.toThrow(/timed out/);
      const waiting = transport.send('must-not-submit').catch(error => error);
      await expect(transport.send('concurrent')).rejects.toThrow(/in progress/);
      await transport.stop();
      expect(await waiting).toMatchObject({ message: 'Transport is stopped' });
      expect(launch).not.toHaveBeenCalled();
      expect((await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual(['hang-forever']);
      expect(await transport.isStopped()).toBe(true);
    } finally { internal.signalGroup = signal; }
  });
  it('waits for explicit completed event and delivers events before resolving send', async () => {
    const dir = await workspace();
    const readyFile = join(dir, 'ready');
    const gateDir = join(dir, 'gate');
    const events: string[] = [];
    let sendResolved = false;

    const transport = registerTransport(new JsonlTransport(
      config({ env: { turn_agent_ready_file: readyFile, turn_agent_gate_dir: gateDir } }),
      { onEvent: e => events.push(e.type) }
    ));

    await transport.start();
    await waitFile(readyFile);

    const sendPromise = transport.send('normal').then(() => { sendResolved = true; });

    // 等待子进程进入门禁（已收到 prompt，尚未输出 completed）
    await waitFile(join(gateDir, 'entered'));
    // 在子进程被 release 之前，send 绝不能提前返回！
    expect(sendResolved).toBe(false);
    expect(events).toEqual([]);

    // 释放门禁，允许子进程输出 thinking, text, completed
    await writeFile(join(gateDir, 'release'), '1');
    await sendPromise;

    expect(sendResolved).toBe(true);
    // 事件必须在 send resolve 之前全部交付给 Runtime！
    expect(events).toEqual(['thinking', 'text', 'completed']);
  });

  it('rejects cold-start concurrent send calls immediately on the first line before any await', async () => {
    const dir = await workspace();
    const readyFile = join(dir, 'ready');
    const transport = registerTransport(new JsonlTransport(
      config({ env: { turn_agent_ready_file: readyFile } }),
      { onEvent() {} }
    ));

    let firstResolved = false;
    let secondError = '';

    // 冷启动同步调用两次 send：首个进入，次个在第一个 await 之前同步占位检查时被立即拒绝
    const p1 = transport.send('first').then(() => { firstResolved = true; });
    const p2 = transport.send('second').catch(err => { secondError = err.message; });

    await Promise.all([p1, p2]);
    expect(firstResolved).toBe(true);
    expect(secondError).toMatch(/turn.*in progress/i);
  });

  it('holds send pending when stdin write callback is delayed even if completed arrives first', async () => {
    const dir = await workspace();
    const readyFile = join(dir, 'ready');
    const transport = registerTransport(new JsonlTransport(
      config({ env: { turn_agent_ready_file: readyFile } }),
      { onEvent() {} }
    ));

    await transport.start();
    await waitFile(readyFile);

    const child = (transport as any).current.child;
    const stdin = child.stdin;
    const realWrite = stdin.write.bind(stdin);

    let releaseWriteCallback!: () => void;
    let sendResolved = false;

    // 扣住真实 write 的 callback
    stdin.write = (chunk: any, cb: any) => {
      return realWrite(chunk, (err: any) => {
        releaseWriteCallback = () => cb(err);
      });
    };

    const p = transport.send('normal').then(() => { sendResolved = true; });

    // 等待子进程完成并发出 completed（子进程已收到内容并输出完成）
    await vi.waitFor(() => expect(releaseWriteCallback).toBeDefined());
    await new Promise(r => setTimeout(r, 60));

    // 双条件契约：write callback 未返回成功前，即使收到 completed，send 依然保持 pending！
    expect(sendResolved).toBe(false);

    // 释放 write callback，send 成功 resolve
    releaseWriteCallback();
    await p;
    expect(sendResolved).toBe(true);
  });

  it('reuses the same running process across consecutive sequential turns', async () => {
    const dir = await workspace();
    const readyFile = join(dir, 'ready');
    const transport = registerTransport(new JsonlTransport(
      config({ env: { turn_agent_ready_file: readyFile } }),
      { onEvent() {} }
    ));

    await transport.start();
    await waitFile(readyFile);
    const pid1 = (transport as any).current?.pid;

    await transport.send('turn-1');
    const pidAfterTurn1 = (transport as any).current?.pid;
    expect(pidAfterTurn1).toBe(pid1);

    await transport.send('turn-2');
    const pidAfterTurn2 = (transport as any).current?.pid;
    expect(pidAfterTurn2).toBe(pid1);
  });

  it('handles stdout chunk with thinking, text, and completed without trailing newline before exit', async () => {
    const dir = await workspace();
    const readyFile = join(dir, 'ready');
    const events: any[] = [];

    const transport = registerTransport(new JsonlTransport(
      config({ env: { turn_agent_ready_file: readyFile } }),
      { onEvent: e => events.push(e) }
    ));

    await transport.start();
    await waitFile(readyFile);

    // 子进程会在同一 chunk 写入所有事件，末尾无换行并立即 exit(0)
    // transport 不能因为 exit 比 stdout close 先到而丢失末尾未换行的 completed！
    await transport.send('chunk-all-and-exit-without-newline');

    const types = events.map(e => e.type);
    expect(types).toContain('thinking');
    expect(types).toContain('text');
    expect(types).toContain('completed');
  });

  it('rejects send when child exits without completed and preserves true exitCode for idle notification', async () => {
    const dir = await workspace();
    const readyFile = join(dir, 'ready');
    let exitCodeReceived: number | null | undefined;

    const transport = registerTransport(new JsonlTransport(
      config({ env: { turn_agent_ready_file: readyFile } }),
      { onEvent() {}, onExit: code => { exitCodeReceived = code; } }
    ));

    await transport.start();
    await waitFile(readyFile);

    // 子进程直接 process.exit(2) 退出，不发 completed
    await expect(transport.send('exit-without-completed')).rejects.toThrow(/without completing/i);

    // 轮次内异常退出通过 send 报告，不向外部触发全局 onExit
    expect(exitCodeReceived).toBeUndefined();
  });

  it('times out, isolates old events, and blocks reuse of process if termination fails', async () => {
    const dir = await workspace();
    const readyFile = join(dir, 'ready');
    const events: string[] = [];

    const transport = registerTransport(new JsonlTransport(
      config({ timeout: 0.15, env: { turn_agent_ready_file: readyFile } }),
      { onEvent: e => events.push(e.type), killGraceMs: 30 }
    ));

    await transport.start();
    await waitFile(readyFile);

    // 模拟收口信号被拦截（进程无法被杀死）
    const origSignal = (transport as any).signalGroup.bind(transport);
    (transport as any).signalGroup = () => {};

    try {
      // 1. 首轮超时，提前拒绝
      await expect(transport.send('hang-forever')).rejects.toThrow(/timed out/i);
      expect(events).toEqual([]);

      // 2. 收口失败后，下一次 send 绝不能在同一个 live 进程中悄悄复用，必须报收口失败阻断！
      await expect(transport.send('next-turn')).rejects.toThrow(/did not exit/i);
    } finally {
      (transport as any).signalGroup = origSignal;
    }
  });

  it('interrupt fails when process refuses termination and cleans up all timer/intervals without leak', async () => {
    const dir = await workspace();
    const readyFile = join(dir, 'ready');

    const transport = registerTransport(new JsonlTransport(
      config({ timeout: 5, env: { turn_agent_ready_file: readyFile, turn_agent_ignore_sigint: '1' } }),
      { onEvent() {}, killGraceMs: 30 }
    ));

    await transport.start();
    await waitFile(readyFile);

    // 模拟无法杀死进程
    const origSignal = (transport as any).signalGroup.bind(transport);
    (transport as any).signalGroup = () => {};

    // 追踪 setInterval
    const origSetInterval = globalThis.setInterval;
    let intervalRef: any;
    globalThis.setInterval = ((...args: any[]) => {
      intervalRef = (origSetInterval as any)(...args);
      return intervalRef;
    }) as any;

    try {
      const sendPromise = transport.send('hang-forever').catch(err => err.message);
      await new Promise(r => setTimeout(r, 20));

      // 中断失败时绝不冒充成功，必须向调用方抛错！
      await expect(transport.interrupt()).rejects.toThrow(/did not exit/i);

      // 定时器必须彻底被销毁，无 interval 泄漏
      expect(intervalRef?._destroyed ?? true).toBe(true);

      // 恢复真实信号分发以保证测试收尾能够正常杀死子进程
      (transport as any).signalGroup = origSignal;
      await transport.stop();
      await sendPromise;
    } finally {
      globalThis.setInterval = origSetInterval;
      (transport as any).signalGroup = origSignal;
    }
  });

  it('propagates stream error on child stdout to active turn without crashing host', async () => {
    const dir = await workspace();
    const readyFile = join(dir, 'ready');

    const transport = registerTransport(new JsonlTransport(
      config({ env: { turn_agent_ready_file: readyFile } }),
      { onEvent() {} }
    ));

    await transport.start();
    await waitFile(readyFile);

    // 使用 hang-forever 保证子进程在收到指令后不发 completed，维持轮次活动
    const sendPromise = transport.send('hang-forever').catch(err => err);
    await new Promise(r => setTimeout(r, 20));

    // 模拟 stdout 流抛错
    const stdout = (transport as any).current.child.stdout;
    stdout.emit('error', new Error('mock stream error'));

    const err = await sendPromise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('mock stream error');
  });

  it('stops cleanly while waiting for tail without spawning new child or prompt submission', async () => {
    const dir = await workspace();
    const readyFile = join(dir, 'ready');

    const transport = registerTransport(new JsonlTransport(
      config({ timeout: 0.15, env: { turn_agent_ready_file: readyFile } }),
      { onEvent() {}, killGraceMs: 50 }
    ));

    await transport.start();
    await waitFile(readyFile);

    // 触发超时，进入内部收口
    await expect(transport.send('hang-forever')).rejects.toThrow(/timed out/i);

    // 在等待旧 tail 时调用 stop
    await transport.stop();
    expect(await transport.isStopped!()).toBe(true);

    // 停止后绝不再允许 start、send 或 spawn
    await expect(transport.start()).rejects.toThrow(/stopped/i);
    await expect(transport.send('after-stop')).rejects.toThrow(/stopped/i);
  });
});
