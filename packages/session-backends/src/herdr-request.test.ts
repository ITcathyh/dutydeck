import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HerdrBackend } from './herdr-backend.js';

const clients = vi.hoisted(() => [] as Socket[]);
vi.mock('node:net', async importOriginal => {
  const actual = await importOriginal<typeof import('node:net')>();
  return { ...actual, createConnection: (...args: any[]) => {
    const socket = (actual.createConnection as (...args: any[]) => Socket)(...args);
    clients.push(socket); return socket;
  } };
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanups.splice(0)) await close();
  for (const socket of clients.splice(0)) socket.destroy();
});
const ioTick = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dd-herdr-request-')), path = join(root, 'control.sock');
  const readers: Socket[] = [];
  let connected!: (socket: Socket) => void;
  const connection = new Promise<Socket>(resolve => { connected = resolve; });
  const server = createServer({ allowHalfOpen: true }, socket => {
    readers.push(socket); socket.on('error', () => {}); connected(socket);
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  cleanups.push(async () => {
    for (const socket of readers) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  const backend = new HerdrBackend(`dutydeck-${'e'.repeat(32)}`, {
    binary: 'unused', stateFile: join(root, 'identity.json'), ownerId: 'fixture',
    processProbe: { identify() { throw new Error('Unexpected process access'); }, observe() { throw new Error('Unexpected process access'); } },
  });
  const request = (target = path) => (backend as unknown as { request(method: string, params: unknown, path: string): Promise<unknown> }).request('fixture', {}, target);
  return { request, connection, root };
}

describe('bounded Herdr control socket requests', () => {
  it('uses an absolute deadline despite continuous partial replies and destroys the client', async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const response = f.request().catch(error => { settled = true; return error; });
    const reader = await f.connection;
    for (let at = 0; at < 49; at++) {
      reader.write(' '); await ioTick();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(settled).toBe(false);
    reader.write(' '); await ioTick();
    await vi.advanceTimersByTimeAsync(100);
    expect(await response).toMatchObject({ message: 'Herdr API timeout' });
    expect(clients.at(-1)?.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a response larger than its byte budget and releases its deadline', async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const response = f.request().catch(error => error);
    const reader = await f.connection;
    reader.write(Buffer.alloc(1024 * 1024 + 1, 32));
    expect(await response).toMatchObject({ message: 'Herdr API response exceeds 1048576 bytes' });
    expect(clients.at(-1)?.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('decodes split UTF8, settles a valid response without waiting for peer close, and recycles its socket', async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const response = f.request();
    const reader = await f.connection;
    const frame = Buffer.from(JSON.stringify({ result: { text: '中文' } }) + '\n');
    const split = frame.indexOf(Buffer.from('中文')) + 1;
    reader.write(frame.subarray(0, split)); await ioTick();
    reader.write(frame.subarray(split)); // Peer deliberately keeps the socket open.
    expect(await response).toEqual({ text: '中文' });
    expect(clients.at(-1)?.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases the absolute deadline on a connection error', async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const error = await f.request(join(f.root, 'missing.sock')).catch(error => error);
    expect(error).toMatchObject({ code: 'ENOENT' });
    expect(clients.at(-1)?.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['parse failure', 'peer end', 'peer reset'])('settles %s once and releases the timer and client', async kind => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const settled = vi.fn();
    const response = f.request().then(settled, error => { settled(error); return error; });
    const reader = await f.connection;
    if (kind === 'parse failure') reader.write('invalid JSON\n');
    else if (kind === 'peer end') reader.end('partial');
    else reader.destroy();
    expect(await response).toBeInstanceOf(Error);
    await ioTick(); await vi.advanceTimersByTimeAsync(6000);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(clients.at(-1)?.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
