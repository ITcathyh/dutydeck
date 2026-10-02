import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { HerdrBackend } from './herdr-backend.js';
import { TmuxBackend } from './tmux-backend.js';

const command = vi.hoisted(() => vi.fn());
const sockets = vi.hoisted(() => [] as any[]);
vi.mock('./command.js', () => ({ runCommand: command }));
vi.mock('node:net', () => ({ createConnection: () => sockets.shift() }));
afterEach(() => { vi.useRealTimers(); command.mockReset(); sockets.length = 0; });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

it.each(['detach', 'interrupt', 'kill'] as const)('revokes tmux paste after %s during load-buffer and deletes that buffer', async cancel => {
  const load = deferred<string>(), calls: string[][] = [];
  command.mockImplementation((_bin, args) => { calls.push(args); return args[0] === 'load-buffer' ? load.promise : Promise.resolve(''); });
  const backend = new TmuxBackend('fixture');
  (backend as any).started = true;
  const writing = backend.write('synthetic\ninput');
  expect(calls[0][0]).toBe('load-buffer');
  await backend[cancel]();
  load.resolve('');
  expect(await writing).toBe(false);
  expect(calls.some(args => args[0] === 'paste-buffer')).toBe(false);
  expect(calls.find(args => args[0] === 'delete-buffer')?.[2]).toBe(calls[0][2]);
});
it('keeps an uncancelled tmux paste ordered and cleans it through -d', async () => {
  const calls: string[][] = [];
  command.mockImplementation((_bin, args) => { calls.push(args); return Promise.resolve(''); });
  const backend = new TmuxBackend('fixture'); (backend as any).started = true;
  expect(await backend.write('one\ntwo')).toBe(true);
  expect(calls.map(args => args[0])).toEqual(['load-buffer', 'paste-buffer']);
  expect(calls[1][2]).toBe(calls[0][2]); expect(calls[1]).toContain('-d');
});
function herdrFixture() {
  const backend = new HerdrBackend(`dutydeck-${'a'.repeat(32)}`, { binary: 'unused', stateFile: '/missing/dd-input-fixture', ownerId: 'fixture', processProbe: {} as any });
  const state = { pane: { pane_id: 'owned-pane' }, socket: '/fixture' };
  vi.spyOn(backend as any, 'checked').mockResolvedValue(state);
  (backend as any).stream = { stdin: { writable: true, end() {} }, kill() {} };
  const socket = Object.assign(new EventEmitter(), { write: vi.fn(), destroy: vi.fn() });
  sockets.push(socket);
  return { backend, socket };
}
describe('Herdr pending input connection', () => {
  it.each(['detach', 'interrupt'] as const)('destroys an unsent input on %s even if connect arrives later', async cancel => {
    vi.useFakeTimers(); command.mockResolvedValue('');
    const { backend, socket } = herdrFixture();
    const writing = backend.write('old-input').catch(error => error);
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    await backend[cancel]();
    socket.emit('connect');
    expect(await writing).toMatchObject({ message: 'Herdr input cancelled before send' });
    expect(socket.write).not.toHaveBeenCalled(); expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('awaits the bounded reply for input already sent rather than claiming it was revoked', async () => {
    vi.useFakeTimers(); command.mockResolvedValue('');
    const { backend, socket } = herdrFixture();
    const writing = backend.write('sent-input');
    await Promise.resolve(); socket.emit('connect');
    expect(socket.write).toHaveBeenCalledTimes(1);
    await backend.interrupt();
    expect(socket.destroy).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(1);
    socket.emit('data', Buffer.from('{"result":{}}\n'));
    expect(await writing).toBe(false);
    expect(socket.destroy).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
});
