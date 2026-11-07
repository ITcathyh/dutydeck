import Fastify from 'fastify';
import { connect } from 'node:net';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import { registerTerminalRoutes } from './terminal-ws.js';

it.each(['/', '/api/%74erminal/session'])('rejects an unclaimed upgrade to %s instead of holding it through shutdown', async path => {
  const app = Fastify();
  registerTerminalRoutes(app, { provider: { lookupTerminalStream: () => ({ status: 'no-session' }) }, auth: { mode: 'token', check: () => false } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  const client = connect(address.port, '127.0.0.1');
  let timer: NodeJS.Timeout | undefined;
  try {
    const response = new Promise<string>(resolve => {
      let received = '';
      client.on('data', chunk => { received += chunk.toString(); });
      client.once('close', () => resolve(received));
    });
    client.on('error', () => {});
    client.write([
      `GET ${path} HTTP/1.1`, 'Host: localhost', 'Upgrade: websocket', 'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', '', '',
    ].join('\r\n'));
    const closed = await Promise.race([
      response,
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 3_000); }),
    ]);
    expect(closed, 'An upgrade nobody claims must be answered and closed').toMatch(/^HTTP\/1\.1 404 /);
  } finally {
    clearTimeout(timer);
    client.destroy();
    await app.close();
  }
});

it('rejects a terminal upgrade whose lookup outlives the handshake deadline and disposes the late handle', async () => {
  const app = Fastify();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let disposed = 0;
  registerTerminalRoutes(app, {
    handshakeTimeoutMs: 50,
    provider: { lookupTerminalStream: async () => {
      await gate;
      return { status: 'ready', handle: { stream: { onData() {}, write() {}, resize() {}, dispose() { disposed++; } }, onExit() {} } };
    } },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/terminal/session`);
  try {
    const status = await new Promise<number>((resolve, reject) => {
      client.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
      client.once('error', reject);
    });
    expect(status).toBe(504);
    release();
    await vi.waitFor(() => expect(disposed).toBe(1));
  } finally {
    release();
    client.terminate();
    await app.close();
  }
});

it.each([false, true])('closes the server with a terminal client still connected (paused=%s)', async paused => {
  const app = Fastify();
  let disposed = 0;
  registerTerminalRoutes(app, { provider: { lookupTerminalStream: () => ({
    status: 'ready',
    handle: {
      stream: { onData() {}, write() {}, resize() {}, dispose() { disposed++; } },
      onExit() {},
    },
  }) } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/terminal/session`);
  let closing: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
    if (paused) client.pause();
    closing = app.close();
    const closed = await Promise.race([
      closing.then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 3_000); }),
    ]);
    expect(closed, 'Server shutdown must close terminal sockets without waiting for a driver exit').toBe(true);
    expect(disposed).toBe(1);
  } finally {
    clearTimeout(timer);
    client.terminate();
    await (closing ?? app.close());
  }
});

it.each(['authorization', 'lookup'])('closes an upgrade waiting for %s and disposes a late handle', async phase => {
  const app = Fastify();
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  let disposed = 0;
  let lookups = 0;
  registerTerminalRoutes(app, {
    authorize: async (_request, _session, action) => {
      if (phase === 'authorization') { entered(); await pending; }
      return { allowed: true, action, code: 'allowed_owner', reason: 'test', source: 'owner' };
    },
    provider: { lookupTerminalStream: async () => {
      lookups++;
      if (phase === 'lookup') { entered(); await pending; }
      return { status: 'ready', handle: {
        stream: { onData() {}, write() {}, resize() {}, dispose() { disposed++; } }, onExit() {},
      } };
    } },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/terminal/session`);
  client.on('error', () => {}); // Shutdown rejects the unfinished handshake.
  let closing: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    await reached;
    closing = app.close();
    expect(await Promise.race([
      closing.then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 3_000); }),
    ])).toBe(true);
    release();
    if (phase === 'lookup') await vi.waitFor(() => expect(disposed).toBe(1));
    else {
      await new Promise(resolve => setImmediate(resolve));
      expect(lookups).toBe(0);
      expect(disposed).toBe(0);
    }
  } finally {
    clearTimeout(timer);
    release();
    client.terminate();
    await (closing ?? app.close());
  }
});
