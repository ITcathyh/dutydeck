import Fastify from 'fastify';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, connect, type Socket, type AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { expect, it, vi } from 'vitest';
import { registerInstanceProxy } from './instance-proxy.js';

const host = (server: { address(): unknown }) => `127.0.0.1:${(server.address() as AddressInfo).port}`;
const closedWithin = async (shutdown: Promise<void>) => {
  let timer: NodeJS.Timeout | undefined;
  try {
    expect(await Promise.race([shutdown.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1_000); })])).toBe(true);
  } finally { clearTimeout(timer); }
};

it.each(['active', 'paused', 'half-open'] as const)('closes both proxy endpoints with a %s peer terminal', async state => {
  const peer = createHttpServer(); const wss = new WebSocketServer({ server: peer });
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve));
  const app = Fastify(); await registerInstanceProxy(app, [{ id: 'peer', name: 'Peer', url: `http://${host(peer)}` }], undefined);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new WebSocket(`ws://${host(app.server)}/api/instances/peer/terminal/s1`);
  client.on('error', () => {});
  let shutdown: Promise<void> | undefined;
  try {
    await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
    if (state === 'paused') (client as unknown as { _socket: Socket })._socket.pause();
    if (state === 'half-open') (client as unknown as { _socket: Socket })._socket.end();
    shutdown = app.close(); await closedWithin(shutdown);
    await vi.waitFor(() => expect(wss.clients.size).toBe(0));
    client.terminate();
    // The peer HTTP server remains alive; closing a proxy never stops its owner.
    const raw = connect((peer.address() as AddressInfo).port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { raw.once('connect', resolve); raw.once('error', reject); }); raw.destroy();
  } finally {
    client.terminate(); await (shutdown ?? app.close());
    for (const connection of wss.clients) connection.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => peer.close(() => resolve()));
  }
});

it('cancels an upgrade whose half-open upstream never returns a handshake', async () => {
  let received!: () => void;
  const reached = new Promise<void>(resolve => { received = resolve; });
  const peers: Socket[] = [];
  const peer = createNetServer({ allowHalfOpen: true }, socket => {
    peers.push(socket); socket.once('data', received); socket.on('error', () => {}); socket.resume();
  });
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve));
  const app = Fastify(); await registerInstanceProxy(app, [{ id: 'peer', name: 'Peer', url: `http://${host(peer)}` }], undefined);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new WebSocket(`ws://${host(app.server)}/api/instances/peer/terminal/s1`);
  client.on('error', () => {});
  try {
    await reached;
    await closedWithin(app.close());
    await vi.waitFor(() => expect(peers[0]?.readableEnded).toBe(true));
    expect(peers[0]?.writable).toBe(true); // The mock intentionally keeps its half open.
  } finally {
    client.terminate(); await app.close();
    for (const socket of peers) socket.destroy();
    await new Promise<void>(resolve => peer.close(() => resolve()));
  }
});

it('preserves an upstream handshake rejection before cleaning up its sockets', async () => {
  const peer = createHttpServer();
  peer.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve));
  const app = Fastify(); await registerInstanceProxy(app, [{ id: 'peer', name: 'Peer', url: `http://${host(peer)}` }], undefined);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new WebSocket(`ws://${host(app.server)}/api/instances/peer/terminal/s1`);
  client.on('error', () => {});
  try {
    expect(await new Promise<number | undefined>(resolve => client.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); }))).toBe(503);
    client.terminate(); await closedWithin(app.close());
  } finally {
    client.terminate(); await app.close(); await new Promise<void>(resolve => peer.close(() => resolve()));
  }
});
