import { expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { createServer, get, Agent, type ClientRequest, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { registerInstanceProxy } from './instance-proxy.js';

it('shutdown settles with an open proxied SSE response', async () => {
  let upstream: ServerResponse | undefined;
  const peer = createServer((_request, response) => {
    upstream = response;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: connected\n\n');
  });
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve));
  const app = Fastify();
  await registerInstanceProxy(app, [{ id: 'peer', name: 'Peer', url: `http://127.0.0.1:${(peer.address() as AddressInfo).port}` }], undefined);
  await app.listen({ host: '127.0.0.1', port: 0 });
  let client: ClientRequest | undefined;
  let closing: Promise<void> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      client = get(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/instances/peer/sessions/s1/stream`, { agent: false }, response => {
        response.on('error', () => {});
        response.once('data', () => resolve());
      });
      client.on('error', reject);
    });
    closing = app.close();
    const result = await Promise.race([closing.then(() => 'closed'), new Promise<string>(resolve => setTimeout(() => resolve('blocked'), 300))]);
    expect(result).toBe('closed');
  } finally {
    client?.destroy();
    upstream?.destroy();
    await (closing ?? app.close());
    peer.closeAllConnections();
    await new Promise<void>(resolve => peer.close(() => resolve()));
  }
});

it('a peer stream abort disconnects the downstream client', async () => {
  let upstream: ServerResponse | undefined;
  const peer = createServer((_request, response) => {
    upstream = response;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: connected\n\n');
  });
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve));
  const app = Fastify();
  await registerInstanceProxy(app, [{ id: 'peer', name: 'Peer', url: `http://127.0.0.1:${(peer.address() as AddressInfo).port}` }], undefined);
  await app.listen({ host: '127.0.0.1', port: 0 });
  let client: ClientRequest | undefined;
  let disconnected = false;
  try {
    await new Promise<void>((resolve, reject) => {
      client = get(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/instances/peer/sessions/s1/stream`, { agent: false }, response => {
        response.on('error', () => {});
        response.once('close', () => { disconnected = true; });
        response.once('data', () => resolve());
      });
      client.on('error', reject);
    });
    upstream!.destroy();
    await vi.waitFor(() => expect(disconnected).toBe(true));
  } finally {
    client?.destroy();
    upstream?.destroy();
    await app.close();
    peer.closeAllConnections();
    await new Promise<void>(resolve => peer.close(() => resolve()));
  }
});


it('cancels an HTTP forward waiting for upstream headers during shutdown', async () => {
  let reached!: () => void;
  const received = new Promise<void>(resolve => { reached = resolve; });
  let upstreamClosed = false;
  const peer = createServer((_request, response) => {
    response.once('close', () => { upstreamClosed = true; });
    reached();
  });
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve));
  const app = Fastify();
  await registerInstanceProxy(app, [{ id: 'peer', name: 'Peer', url: `http://127.0.0.1:${(peer.address() as AddressInfo).port}` }], undefined);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const client = get(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/instances/peer/sessions/s1`, { agent: false });
  client.on('error', () => {});
  let closing: Promise<void> | undefined;
  try {
    await received;
    closing = app.close();
    expect(await Promise.race([closing.then(() => 'closed'), new Promise(resolve => setTimeout(() => resolve('blocked'), 300))])).toBe('closed');
    await vi.waitFor(() => expect(upstreamClosed).toBe(true));
  } finally {
    client.destroy(); peer.closeAllConnections();
    await (closing ?? app.close());
    await new Promise<void>(resolve => peer.close(() => resolve()));
  }
});

it('drains complete HTTP responses and preserves the downstream keep-alive connection', async () => {
  const text = 'response'.repeat(64 * 1024);
  const peer = createServer((_request, response) => response.end(text));
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve));
  const app = Fastify();
  await registerInstanceProxy(app, [{ id: 'peer', name: 'Peer', url: `http://127.0.0.1:${(peer.address() as AddressInfo).port}` }], undefined);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const agent = new Agent({ keepAlive: true });
  const read = () => new Promise<{ body: string; reused: boolean }>((resolve, reject) => {
    const request = get(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/instances/peer/sessions/s1`, { agent }, response => {
      let body = '';
      response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.once('error', reject);
      response.once('end', () => resolve({ body, reused: request.reusedSocket }));
    });
    request.once('error', reject);
  });
  try {
    expect((await read()).body).toBe(text);
    expect(await read()).toEqual({ body: text, reused: true });
  } finally {
    agent.destroy(); await app.close(); peer.closeAllConnections();
    await new Promise<void>(resolve => peer.close(() => resolve()));
  }
});
