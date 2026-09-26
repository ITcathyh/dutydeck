import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, get as httpGet, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { buildApp } from './app.js';
import { parsePeerInstances } from './instance-proxy.js';

type Seen = { method?: string; url?: string; headers: IncomingHttpHeaders; body: string };

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

const listen = async (server: Server) => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};

/** 假的 --local-only 实例：记录收到的请求，按路径回普通 JSON、401、不结束的实时流或终端 WS。 */
async function startPeer() {
  const seen: Seen[] = [];
  const streams: ServerResponse[] = [];
  let closedStreams = 0;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body });
      if (request.url === '/api/needs-login') { response.writeHead(401, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'login' } })); return; }
      if (request.url?.startsWith('/api/sessions/s1/stream')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: first\n\n');
        response.on('close', () => { closedStreams++; });
        streams.push(response);
        return;
      }
      response.writeHead(201, { 'content-type': 'application/json', 'set-cookie': 'dutydeck_auth=peer; Path=/', 'x-peer': 'yes' });
      response.end(JSON.stringify({ echoed: body }));
    });
  });
  const wss = new WebSocketServer({ server, path: '/api/terminal/s1' });
  wss.on('connection', (socket, request) => {
    seen.push({ method: 'UPGRADE', url: request.url, headers: request.headers, body: '' });
    socket.send('hello');
    socket.on('message', data => socket.send(`echo:${data}`));
  });
  const port = await listen(server);
  closers.push(() => new Promise(resolve => { for (const stream of streams) stream.destroy(); wss.close(); server.close(resolve); }));
  return { seen, port, closedStreams: () => closedStreams };
}

async function startMain(peerPort: number) {
  const unused = createServer();
  const downPort = await listen(unused);
  await new Promise(resolve => unused.close(resolve));
  const app = await buildApp({} as any, {
    instances: [{ id: 'tag', name: 'Tag', url: `http://127.0.0.1:${peerPort}` }, { id: 'down', name: 'Down', url: `http://127.0.0.1:${downPort}` }],
    auth: { mode: 'token', getToken: async () => 'secret-token', localOnly: false },
    terminal: { provider: { lookupTerminalStream: () => ({ status: 'no-session' as const }) }, auth: { mode: 'token', check: presented => presented === 'secret-token' } }
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  closers.push(() => app.close());
  return `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

const authorized = { authorization: 'Bearer secret-token' };

describe('转发到同机其他实例', () => {
  it('实例列表只给 id 和名称，不暴露对方地址', async () => {
    const main = await startMain((await startPeer()).port);
    const response = await fetch(`http://${main}/api/instances`, { headers: authorized });
    expect(await response.json()).toEqual({ instances: [{ id: 'tag', name: 'Tag' }, { id: 'down', name: 'Down' }] });
  });

  it('先过主服务登录，再原样转发请求体和查询串，不带主服务凭据，也不回传对方 cookie', async () => {
    const peer = await startPeer();
    const main = await startMain(peer.port);
    const url = `http://${main}/api/instances/tag/sessions/s1/send?mode=queue`;
    const init = { method: 'POST', body: '{"prompt":"hi"}' };

    expect((await fetch(url, { ...init, headers: { 'content-type': 'application/json' } })).status).toBe(401);
    expect(peer.seen).toHaveLength(0);

    const response = await fetch(url, { ...init, headers: { ...authorized, cookie: 'dutydeck_auth=main', 'content-type': 'application/json' } });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ echoed: '{"prompt":"hi"}' });
    expect(response.headers.get('x-peer')).toBe('yes');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(peer.seen).toEqual([expect.objectContaining({ method: 'POST', url: '/api/sessions/s1/send?mode=queue', body: '{"prompt":"hi"}' })]);
    expect(peer.seen[0]!.headers).toMatchObject({ host: `127.0.0.1:${peer.port}`, 'content-type': 'application/json' });
    expect(peer.seen[0]!.headers.authorization).toBeUndefined();
    expect(peer.seen[0]!.headers.cookie).toBeUndefined();
  });

  it('未知实例回 404，对方连不上或要求登录都回 502，不让浏览器误以为主服务掉了登录', async () => {
    const main = await startMain((await startPeer()).port);
    const unknown = await fetch(`http://${main}/api/instances/nope/sessions`, { headers: authorized });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: 'INSTANCE_NOT_FOUND' } });
    const down = await fetch(`http://${main}/api/instances/down/sessions`, { headers: authorized });
    expect(down.status).toBe(502);
    expect(await down.json()).toMatchObject({ error: { code: 'INSTANCE_UNAVAILABLE' } });
    expect((await fetch(`http://${main}/api/instances/tag/needs-login`, { headers: authorized })).status).toBe(502);
  });

  it('实时流边收边转，浏览器断开后对方的流也被关闭', async () => {
    const peer = await startPeer();
    const main = await startMain(peer.port);
    // 用单连接的 node:http 而不是 fetch：fetch 会额外预开一条空闲连接，拖住 app.close()。
    const { contentType, first } = await new Promise<{ contentType?: string; first: string }>((resolve, reject) => {
      const request = httpGet(`http://${main}/api/instances/tag/sessions/s1/stream?after=0`, { headers: authorized, agent: false }, response => {
        response.once('data', chunk => { resolve({ contentType: response.headers['content-type'], first: String(chunk) }); request.destroy(); });
      });
      request.on('error', reject);
    });
    expect(contentType).toBe('text/event-stream');
    expect(first).toBe('data: first\n\n');
    await vi.waitFor(() => expect(peer.closedStreams()).toBe(1));
  });

  it('终端 WebSocket 先过主服务登录再转发，双向消息都能通', async () => {
    const peer = await startPeer();
    const main = await startMain(peer.port);
    const denied = new WebSocket(`ws://${main}/api/instances/tag/terminal/s1`);
    const status = await new Promise(resolve => denied.on('unexpected-response', (_request, response) => resolve(response.statusCode)));
    expect(status).toBe(401);

    const socket = new WebSocket(`ws://${main}/api/instances/tag/terminal/s1`, { headers: authorized });
    const messages: string[] = [];
    socket.on('message', data => messages.push(String(data)));
    await new Promise(resolve => socket.on('open', resolve));
    socket.send('ping');
    await vi.waitFor(() => expect(messages).toEqual(['hello', 'echo:ping']));
    socket.close();
    const upgrade = peer.seen.find(item => item.method === 'UPGRADE');
    expect(upgrade?.url).toBe('/api/terminal/s1');
    expect(upgrade?.headers.authorization).toBeUndefined();
  });
});

describe('DUTYDECK_INSTANCES_JSON', () => {
  it('未配置时没有其他实例，id 不合规时启动即报错', () => {
    expect(parsePeerInstances(undefined)).toEqual([]);
    expect(parsePeerInstances('[{"id":"tag","name":"Tag","url":"http://127.0.0.1:4311"}]')).toEqual([{ id: 'tag', name: 'Tag', url: 'http://127.0.0.1:4311' }]);
    expect(() => parsePeerInstances('[{"id":"Tag/x","name":"Tag","url":"http://127.0.0.1:4311"}]')).toThrow();
  });
});
