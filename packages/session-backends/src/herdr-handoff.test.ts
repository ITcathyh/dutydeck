import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { HerdrBackend } from './herdr-backend.js';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));
afterEach(() => { vi.useRealTimers(); spawn.mockReset(); });
function child() {
  return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
}
function frame(target: ReturnType<typeof child>, data: string) {
  target.stdout.write(JSON.stringify({ type: 'terminal.frame', bytes: Buffer.from(data).toString('base64'), width: 80, height: 24 }) + '\n');
}
function fixture() {
  vi.useFakeTimers();
  const backend = new HerdrBackend(`dutydeck-${'b'.repeat(32)}`, { binary: 'fixture', stateFile: '/missing/dd-handoff-fixture', ownerId: 'fixture', processProbe: {} as any });
  vi.spyOn(backend as any, 'checked').mockResolvedValue({ pane: { terminal_id: 'owned-terminal' } });
  return backend;
}
async function start(backend: HerdrBackend, target: ReturnType<typeof child>, initial: string, delta: string) {
  spawn.mockReturnValueOnce(target);
  const ready = backend.attach({ cols: 80, rows: 24 });
  await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
  frame(target, initial); frame(target, delta); await ready;
}
describe('Herdr controller snapshot handoff', () => {
  it('retains frames after the first snapshot, then clears stale listeners on reattach', async () => {
    const backend = fixture(), first = child(), old = vi.fn(), next = vi.fn();
    await start(backend, first, 'BEFORE', 'DURING');
    expect(backend.initialScreen?.data).toBe('BEFORE');
    backend.onData(old); frame(first, 'AFTER');
    expect(old.mock.calls).toEqual([['DURING'], ['AFTER']]);
    await backend.detach();
    const second = child();
    await start(backend, second, 'SECOND-SNAPSHOT', 'SECOND-DELTA');
    backend.onData(next); frame(first, 'OBSOLETE'); frame(second, 'SECOND-AFTER');
    expect(old.mock.calls).toEqual([['DURING'], ['AFTER']]);
    expect(next.mock.calls).toEqual([['SECOND-DELTA'], ['SECOND-AFTER']]);
    await backend.detach(); expect(vi.getTimerCount()).toBe(0);
  });
  it('reports bounded overflow before delivery and resumes from a new controller snapshot boundary', async () => {
    const backend = fixture(), first = child(), data = vi.fn(), gap = vi.fn();
    await start(backend, first, 'OLD-SNAPSHOT', 'x'.repeat(256 * 1024 + 1));
    backend.onOutputGap(gap); backend.onData(data);
    expect(gap).toHaveBeenCalledExactlyOnceWith(256 * 1024 + 1); expect(data).not.toHaveBeenCalled();
    const second = child(), boundary = vi.fn(); spawn.mockReturnValueOnce(second);
    const snapshot = backend.resyncOutput(boundary);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    expect(boundary).toHaveBeenCalledTimes(1); expect(first.kill).toHaveBeenCalledTimes(1);
    frame(first, 'OLD-BOUNDARY'); frame(second, 'CURRENT-SNAPSHOT'); frame(second, 'NEW-DELTA');
    expect(await snapshot).toBe('CURRENT-SNAPSHOT');
    expect(data).toHaveBeenCalledExactlyOnceWith('NEW-DELTA');
    await backend.detach(); expect(vi.getTimerCount()).toBe(0);
  });
});
