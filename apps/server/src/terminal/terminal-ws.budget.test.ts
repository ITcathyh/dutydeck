import Fastify from 'fastify';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerTerminalRoutes, terminalConnectionLimits, type TerminalStreamHandle } from './terminal-ws.js';
import type { Socket } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { Duplex } from 'node:stream';

const clients: WebSocket[] = [];
const apps: ReturnType<typeof Fastify>[] = [];
const blockedSockets: Duplex[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  for (const socket of blockedSockets.splice(0)) socket.destroy();
  await Promise.all(apps.splice(0).map(app => app.close()));
  vi.restoreAllMocks();
});
const turn = () => new Promise(resolve => setImmediate(resolve));
async function harness(authorize?: Parameters<typeof registerTerminalRoutes>[1]['authorize'], write?: (data: string) => Promise<void>) {
  const handles: Array<{ emit(data: string): void; disposed: boolean; unsubscribed: boolean; writes: string[] }> = [];
  const app = Fastify(); apps.push(app);
  registerTerminalRoutes(app, { authorize, provider: { lookupTerminalStream() {
    const entry = { emit: (_data: string) => {}, disposed: false, unsubscribed: false, writes: [] as string[] };
    handles.push(entry);
    const handle: TerminalStreamHandle = {
      stream: {
        onData(callback, snapshot) { entry.emit = callback; snapshot?.({ data: 'restored', cols: 80, rows: 24 }); },
        write(data) { entry.writes.push(data); return write?.(data); }, resize() {}, dispose() { entry.disposed = true; },
      },
      onExit() { return () => { entry.unsubscribed = true; }; },
    };
    return { status: 'ready', handle };
  } } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  const connect = async () => {
    const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/terminal/s1`); clients.push(client);
    const frames: any[] = []; client.on('message', data => frames.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
    await vi.waitFor(() => expect(frames[0]?.type).toBe('snapshot'));
    return { client, frames, handle: handles.at(-1)! };
  };
  return { connect, handles, app };
}
const pause = (client: WebSocket) => (client as unknown as { _socket: Socket })._socket.pause();

async function blockedHarness() {
  const app = Fastify(); apps.push(app);
  const handles: Array<{ emit(data: string): void; disposed: boolean; unsubscribed: boolean }> = [];
  registerTerminalRoutes(app, { provider: { lookupTerminalStream() {
    const entry = { emit: (_data: string) => {}, disposed: false, unsubscribed: false };
    handles.push(entry);
    return { status: 'ready', handle: {
      stream: { onData(callback) { entry.emit = callback; }, write() {}, resize() {}, dispose() { entry.disposed = true; } },
      onExit() { return () => { entry.unsubscribed = true; }; },
    } };
  } } });
  await app.ready();
  const connect = async () => {
    let handshake = true;
    const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) {
      // Complete the HTTP upgrade, then deterministically stop every WS write.
      if (handshake) { handshake = false; callback(); }
    } });
    blockedSockets.push(socket);
    const request = { url: '/api/terminal/s1', method: 'GET', socket,
      headers: { upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' },
    } as unknown as IncomingMessage;
    app.server.emit('upgrade', request, socket, Buffer.alloc(0));
    await turn();
    return { socket, handle: handles.at(-1)! };
  };
  return { connect, handles };
}

// Real ws receiver parses masked Ping control frames with a maximum 125-byte payload.
const pingBatch = () => {
  const frame = Buffer.alloc(131, 120);
  frame[0] = 0x89; frame[1] = 0xfd; frame.fill(0, 2, 6);
  return Buffer.concat(Array.from({ length: 1000 }, () => frame));
};

describe('terminal connection resource budgets', () => {
  it('replies exactly once to normal TCP Ping frames with the original payload', async () => {
    const { connect } = await harness();
    const connection = await connect();
    const pongs: Buffer[] = [];
    connection.client.on('pong', data => pongs.push(data));
    for (const payload of [Buffer.alloc(0), Buffer.from('terminal heartbeat'), Buffer.alloc(125, 120)]) {
      connection.client.ping(payload);
      await vi.waitFor(() => expect(pongs.at(-1)).toEqual(payload));
    }
    await turn();
    expect(pongs).toHaveLength(3);
    connection.handle.emit('after-heartbeat');
    await vi.waitFor(() => expect(connection.frames.some(frame => frame.data === 'after-heartbeat')).toBe(true));
    expect(connection.handle.disposed).toBe(false);
  });

  it('bounds control-frame output through the real ws receiver and cleans up a blocked consumer', async () => {
    const { connect } = await blockedHarness();
    let peakBuffered = 0, pongs = 0;
    const original = WebSocket.prototype.pong;
    vi.spyOn(WebSocket.prototype, 'pong').mockImplementation(function (this: WebSocket, ...args: any[]) {
      const result = original.apply(this, args as Parameters<typeof original>);
      pongs++; peakBuffered = Math.max(peakBuffered, this.bufferedAmount);
      return result;
    });
    const connection = await connect();
    const batch = pingBatch();
    for (let index = 0; index < 40 && !connection.socket.destroyed; index++) {
      connection.socket.push(batch); await turn();
    }
    expect(pongs).toBeGreaterThan(0);
    expect(peakBuffered).toBeLessThanOrEqual(terminalConnectionLimits.pendingSendBytes);
    expect(connection.socket.destroyed).toBe(true);
    expect(connection.handle.disposed).toBe(true);
    expect(connection.handle.unsubscribed).toBe(true);
    const next = await connect();
    next.handle.emit('x'.repeat(3 * 1024 * 1024));
    expect(next.handle.disposed).toBe(false);
  });

  it('charges Pong and terminal data to the same instance budget and releases reservations on close', async () => {
    const { connect, handles } = await blockedHarness();
    const connections = [];
    for (let index = 0; index < 10; index++) connections.push(await connect());
    // Each connection stays below 4 MiB, while data + Pong exceeds 32 MiB in total.
    for (const { handle } of connections) handle.emit('x'.repeat(3 * 1024 * 1024));
    const batch = pingBatch();
    for (let index = 0; index < 5; index++) for (const { socket } of connections) {
      if (!socket.destroyed) { socket.push(batch); await turn(); }
    }
    expect(handles.some(handle => handle.disposed && handle.unsubscribed)).toBe(true);
    for (const { socket } of connections) socket.destroy();
    await vi.waitFor(() => expect(handles.every(handle => handle.disposed && handle.unsubscribed)).toBe(true));
    const next = await connect();
    next.handle.emit('x'.repeat(3 * 1024 * 1024));
    expect(next.handle.disposed).toBe(false);
  });

  it('bounds real slow-socket output, keeps a healthy consumer live and restores a reconnect snapshot', async () => {
    const { connect } = await harness();
    const slow = await connect(), healthy = await connect(); pause(slow.client);
    let peakBuffered = 0;
    const original = WebSocket.prototype.send;
    vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, ...args: any[]) {
      const result = original.apply(this, args as Parameters<typeof original>);
      if (!(this as unknown as { _isServer: boolean })._isServer) return result;
      peakBuffered = Math.max(peakBuffered, this.bufferedAmount);
      return result;
    });
    const data = 'x'.repeat(64 * 1024);
    for (let batch = 0; batch < 512 && !slow.handle.disposed; batch++) {
      slow.handle.emit(data); healthy.handle.emit(data);
      await turn();
    }
    await vi.waitFor(() => expect(slow.handle.disposed).toBe(true));
    expect(slow.handle.unsubscribed).toBe(true);
    expect(peakBuffered).toBeGreaterThan(0);
    expect(peakBuffered).toBeLessThanOrEqual(terminalConnectionLimits.pendingSendBytes);
    expect(healthy.handle.disposed).toBe(false);
    expect(healthy.client.readyState).toBe(WebSocket.OPEN);
    healthy.handle.emit('still-live');
    await vi.waitFor(() => expect(healthy.frames.some(frame => frame.data === 'still-live')).toBe(true));
    const reconnected = await connect();
    expect(reconnected.frames[0]).toMatchObject({ type: 'snapshot', data: 'restored' });
    slow.client.terminate();
  });

  it('bounds aggregate output across connections and releases the instance budget on close', async () => {
    const { connect, handles } = await harness();
    const connections = [];
    for (let index = 0; index < 10; index++) { const connection = await connect(); pause(connection.client); connections.push(connection); }
    // Each connection stays below 4 MiB; the aggregate exceeds 32 MiB.
    for (const { handle } of connections) for (let index = 0; index < 7; index++) handle.emit('x'.repeat(512 * 1024));
    expect(handles.some(handle => handle.disposed)).toBe(true);
    for (const { client } of connections) client.terminate();
    await vi.waitFor(() => expect(handles.every(handle => handle.disposed && handle.unsubscribed)).toBe(true));
    const next = await connect();
    for (let index = 0; index < 3; index++) next.handle.emit('x'.repeat(1024 * 1024));
    expect(next.handle.disposed).toBe(false);
    await turn();
  });

  it.each(['bytes', 'count'] as const)('discards the bounded %s queue while authorization is waiting', async kind => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const { connect } = await harness(async (_request, _session, action) => {
      if (action === 'terminal.write') await waiting;
      return { allowed: true, action, code: 'allowed_owner', reason: 'owner', source: 'owner' };
    });
    const connection = await connect();
    const count = kind === 'bytes' ? 6 : terminalConnectionLimits.pendingInputMessages + 1;
    const data = kind === 'bytes' ? 'x'.repeat(60 * 1024) : 'x';
    try {
      for (let index = 0; index < count; index++) connection.client.send(JSON.stringify({ type: 'input', data }));
      await vi.waitFor(() => expect(connection.handle.disposed).toBe(true));
      expect(connection.handle.unsubscribed).toBe(true);
      expect(connection.handle.writes).toEqual([]);
    } finally { release(); }
    await turn();
    expect(connection.handle.writes).toEqual([]);
  });

  it('keeps a slow backend write within the same queue budget and never runs two writes concurrently', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let active = 0, peak = 0;
    const { connect } = await harness(undefined, async () => {
      active++; peak = Math.max(peak, active);
      try { await gate; } finally { active--; }
    });
    const connection = await connect();
    try {
      connection.client.send(JSON.stringify({ type: 'input', data: 'first' }));
      await vi.waitFor(() => expect(active).toBe(1));
      for (let index = 0; index < 6; index++) connection.client.send(JSON.stringify({ type: 'input', data: 'x'.repeat(60 * 1024) }));
      await vi.waitFor(() => expect(connection.handle.disposed).toBe(true));
      expect(peak).toBe(1);
      expect(connection.handle.writes).toEqual(['first']);
    } finally { release(); }
    await turn();
    expect(active).toBe(0);
    expect(connection.handle.writes).toEqual(['first']);
  });

  it('rejects an oversized input frame before stream.write', async () => {
    const { connect } = await harness(); const connection = await connect();
    connection.client.send(JSON.stringify({ type: 'input', data: 'x'.repeat(terminalConnectionLimits.maxPayloadBytes) }));
    await vi.waitFor(() => expect(connection.handle.disposed).toBe(true));
    expect(connection.handle.writes).toEqual([]);
    expect(connection.handle.unsubscribed).toBe(true);
  });
});
