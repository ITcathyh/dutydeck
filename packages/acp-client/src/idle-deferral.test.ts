import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpxAdapter } from './index.js';

const dirs: string[] = [];
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop();
  vi.useRealTimers(); vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
/** 与 turn-progress.test.ts 相同的假 turn：事件由测试逐条推入，CPU 采样结果由测试指定。 */
async function setup(timeout: number, cpu: 'active' | 'inactive' | 'unknown') {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-idle-deferral-')); dirs.push(cwd);
  const adapter = new AcpxAdapter({ id: 'fixture', name: 'Fixture', command: 'unused', args: [], env: {}, cwd, protocol: 'acp', permissionMode: 'ask', timeout, capabilities: { pause: false, resume: true }, builtin: false }, { onEvent() {} });
  const runtime = (adapter as any).runtime;
  vi.spyOn(runtime, 'ensureSession').mockResolvedValue({ sessionKey: 'fixture' });
  vi.spyOn(runtime, 'close').mockResolvedValue(undefined);
  const sample = vi.spyOn((adapter as any).cpu, 'sample').mockReturnValue(cpu);
  const result = deferred<any>();
  let wake = deferred<void>(); let closed = false;
  const queue: unknown[] = [];
  const push = (event: unknown) => { queue.push(event); wake.resolve(); };
  const finish = (outcome = { status: 'completed', stopReason: 'end_turn' }) => { result.resolve(outcome); closed = true; wake.resolve(); };
  const turn = {
    result: result.promise, cancel: vi.fn(async () => undefined),
    events: { async *[Symbol.asyncIterator]() {
      while (!closed || queue.length) {
        if (queue.length) { yield queue.shift(); continue; }
        await wake.promise; wake = deferred<void>();
      }
    } }
  };
  vi.spyOn(runtime, 'startTurn').mockReturnValue(turn);
  await adapter.start();
  vi.useFakeTimers();
  let outcome: unknown = 'pending';
  const sending = adapter.send('one').then(() => { outcome = 'resolved'; }, error => { outcome = error; });
  await vi.advanceTimersByTimeAsync(0);
  cleanup.push(async () => { finish(); await sending; await adapter.stop(); });
  return { turn, push, sample, outcome: () => outcome };
}
// acpx 0.13.0 把 claude-agent-acp 的长工具心跳转成这样的事件：_meta（其中的 elapsedTimeSeconds）被丢掉，每一条都一样。
const heartbeat = { type: 'tool_call', text: 'tool call (in_progress)', tag: 'tool_call_update', title: 'tool call', toolCallId: 'long-tool', status: 'in_progress' };

describe('ACP idle cancellation while the process tree is busy', () => {
  it('keeps a turn whose tree uses CPU past the timeout and cancels it at three times the timeout', async () => {
    const h = await setup(10, 'active');
    h.push({ type: 'tool_call', tag: 'tool_call', title: 'Run tests', toolCallId: 'long-tool', status: 'in_progress', rawInput: { command: 'pnpm test' } });
    h.push(heartbeat);
    for (let second = 1; second < 30; second++) {
      await vi.advanceTimersByTimeAsync(1_000); h.push(heartbeat);
    }
    expect(h.turn.cancel).not.toHaveBeenCalled();
    expect(h.sample).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.turn.cancel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.outcome()).toMatchObject({ code: 'AGENT_IDLE_TIMEOUT', timeoutMs: 30_000 });
  });

  it.each(['inactive', 'unknown'] as const)('still cancels a silent turn at the timeout when CPU is %s', async cpu => {
    const h = await setup(10, cpu);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.turn.cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.turn.cancel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.outcome()).toMatchObject({ code: 'AGENT_IDLE_TIMEOUT', timeoutMs: 10_000 });
  });
});

describe.runIf(existsSync('/proc/self/stat'))('ACP idle cancellation with a real long-tool agent', () => {
  const run = async (prompt: string) => {
    const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-idle-deferral-real-')); dirs.push(cwd);
    const events: any[] = [];
    const adapter = new AcpxAdapter({ id: 'busy', name: 'Busy Tool', command: process.execPath, args: [resolve(process.cwd(), 'tests/fixtures/acp-busy-tool-agent.mjs')], protocol: 'acp', cwd, env: {}, permissionMode: 'deny-all', timeout: 2, capabilities: { pause: false, resume: true }, builtin: false }, { onEvent: event => events.push(event) });
    cleanup.push(() => adapter.stop());
    await adapter.start();
    const started = Date.now();
    const outcome = await adapter.send(prompt).then(() => 'resolved', error => error);
    return { elapsed: Date.now() - started, outcome, events };
  };
  // 无进展超时按失败结束（不是用户中断）：取消确认时 completed 的 stopReason 是 idle_timeout，两种收尾都先发原因码 error。
  const cancelled = (result: Awaited<ReturnType<typeof run>>) => result.events.some(event => event.type === 'error' && event.data.code === 'AGENT_IDLE_TIMEOUT')
    && (result.outcome === 'resolved'
      ? result.events.some(event => event.type === 'completed' && event.data.stopReason === 'idle_timeout')
      : (result.outcome as { code?: string }).code === 'AGENT_IDLE_TIMEOUT');

  it('lets a CPU-busy tool run past the timeout and cancels it at the hard limit', async () => {
    const result = await run('busy tool');
    expect(cancelled(result)).toBe(true);
    // 硬上限是 3 × 2 秒，从最后一次算作进展的事件（第一条心跳）起算。
    expect(result.elapsed).toBeGreaterThanOrEqual(6_000);
    expect(result.elapsed).toBeLessThan(10_000);
  }, 20_000);

  it('cancels an idle tool at the timeout even though its heartbeats keep arriving', async () => {
    const result = await run('idle tool');
    expect(result.events.filter(event => event.type === 'tool_call').length).toBeGreaterThan(3);
    expect(cancelled(result)).toBe(true);
    expect(result.elapsed).toBeGreaterThanOrEqual(2_000);
    expect(result.elapsed).toBeLessThan(5_500);
  }, 20_000);
});
