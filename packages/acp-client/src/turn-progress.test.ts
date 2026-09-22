import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpxAdapter, normalizeAcpxEvent } from './index.js';

const dirs: string[] = [];
const cleanup: Array<() => Promise<void>> = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-progress-')); dirs.push(cwd);
  const events: any[] = [];
  const adapter = new AcpxAdapter({ id: 'fixture', name: 'Fixture', command: 'unused', args: [], env: {}, cwd, protocol: 'acp', permissionMode: 'ask', timeout: 1, capabilities: { pause: false, resume: true }, builtin: false }, { onEvent: event => events.push(event) });
  const runtime = (adapter as any).runtime;
  vi.spyOn(runtime, 'ensureSession').mockResolvedValue({ sessionKey: 'fixture' });
  vi.spyOn(runtime, 'close').mockResolvedValue(undefined);
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
  const permission = (id: string) => runtime.options.onPermissionRequest({ raw: { toolCall: { toolCallId: id, title: 'Controlled command' }, options: [] } });
  return { adapter, events, runtime, turn, push, finish, sending, permission, outcome: () => outcome };
}
afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop();
  vi.useRealTimers(); vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('ACP meaningful progress and human wait', () => {
  it('does not let session metadata, usage or blank chunks prolong idle', async () => {
    const h = await setup();
    for (let i = 0; i < 5; i++) {
      h.push({ type: 'status', tag: 'session_info_update', text: 'session updated' });
      h.push({ type: 'usage_update', used: i }); h.push({ type: 'text_delta', text: ' ' });
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(h.turn.cancel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.outcome()).toMatchObject({ code: 'AGENT_IDLE_TIMEOUT' });
    h.finish({ status: 'cancelled', stopReason: 'cancelled' }); await h.sending;
    await vi.advanceTimersByTimeAsync(0);
    expect(h.events.some(event => event.type === 'completed')).toBe(false);
  });

  it('does not count duplicate tool snapshots as progress', async () => {
    const h = await setup();
    for (let i = 0; i < 5; i++) {
      h.push({ type: 'tool_call', id: 'same', status: 'running', input: {} });
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(h.turn.cancel).toHaveBeenCalledTimes(1);
    expect(await h.permission('late')).toEqual({ outcome: 'reject_once' });
    h.finish({ status: 'cancelled', stopReason: 'cancelled' }); await h.sending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows substantive thinking, text and tool progress to extend a turn', async () => {
    const h = await setup();
    for (const event of [{ type: 'text_delta', stream: 'thought', text: 'thinking' }, { type: 'text_delta', text: 'answer' }, { type: 'tool_call', id: 'tool', status: 'running' }, { type: 'tool_result', id: 'tool', status: 'completed' }]) {
      await vi.advanceTimersByTimeAsync(750); h.push(event); await vi.advanceTimersByTimeAsync(0);
    }
    expect(h.turn.cancel).not.toHaveBeenCalled(); h.finish(); await h.sending;
    expect(h.outcome()).toBe('resolved'); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])('pauses until all permissions resolve (last approved=%s), then resumes idle', async approved => {
    const h = await setup(); const first = h.permission('first'); const second = h.permission('second');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.turn.cancel).not.toHaveBeenCalled(); expect(h.outcome()).toBe('pending');
    await h.adapter.resolvePermission('first', true); expect(await first).toEqual({ outcome: 'allow_once' });
    await vi.advanceTimersByTimeAsync(5_000); expect(h.turn.cancel).not.toHaveBeenCalled();
    await h.adapter.resolvePermission('second', approved); expect(await second).toEqual({ outcome: approved ? 'allow_once' : 'reject_once' });
    await vi.advanceTimersByTimeAsync(999); expect(h.turn.cancel).not.toHaveBeenCalled();
    h.push({ type: 'text_delta', text: approved ? 'continued after approval' : 'permission declined' });
    await vi.advanceTimersByTimeAsync(0); h.finish(); await h.sending;
    expect(h.outcome()).toBe('resolved'); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['interrupt', 'stop'] as const)('rejects waiting permission and clears timers on %s', async action => {
    const h = await setup(); const decision = h.permission('pending');
    const stopping = h.adapter[action](); await vi.advanceTimersByTimeAsync(0);
    expect(await decision).toEqual({ outcome: 'reject_once' });
    h.finish({ status: 'cancelled', stopReason: 'cancelled' }); await stopping; await h.sending;
    expect(vi.getTimerCount()).toBe(0);
    expect(await h.adapter.resolvePermission('pending', true)).toBe(false);
  });

  it('settles timeout only after the same stream and cancelled prompt result finish', async () => {
    const h = await setup(); await vi.advanceTimersByTimeAsync(1_000);
    expect(h.turn.cancel).toHaveBeenCalledTimes(1); expect(h.outcome()).toBe('pending');
    h.finish({ status: 'cancelled', stopReason: 'cancelled' }); await h.sending;
    expect(h.outcome()).toBe('resolved');
    expect(h.events).toContainEqual({ type: 'completed', data: { stopReason: 'cancelled' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not treat a completed cancel RPC as a cancelled turn', async () => {
    const h = await setup(); await vi.advanceTimersByTimeAsync(1_000);
    h.finish(); await h.sending;
    expect(h.outcome()).toMatchObject({ code: 'AGENT_IDLE_TIMEOUT' });
    expect(h.events.some(event => event.type === 'completed')).toBe(false);
  });

  it('keeps the real legacy provider error text indistinguishable from an assistant quotation', () => {
    const text = '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The model requires a newer version of Codex."}}\n\n';
    expect(normalizeAcpxEvent({ type: 'text_delta', text })).toEqual({ type: 'text', data: { text } });
    expect(normalizeAcpxEvent({ params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })).toEqual({ type: 'text', data: { text } });
  });
});
