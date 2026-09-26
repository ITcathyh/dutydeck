import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RuntimeError } from '@dutydeck/shared';
import { rejectUpgrade, upgradeRejection, type TerminalRouteAuth } from './terminal/terminal-ws.js';

/**
 * 同机另起的 Dutydeck 实例（例如独立运行的 Tag bot 服务）。主服务的 dashboard 通过
 * /api/instances/<id>/... 把请求原样转发过去，用户只需登录主服务。
 *
 * 转发时丢掉主服务的登录凭据，对方按本机请求放行，所以只支持以 --local-only 启动的实例。
 */
export type PeerInstance = { id: string; name: string; url: string };

const peerInstancesSchema = z.array(z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  url: z.string().url()
}));

/** DUTYDECK_INSTANCES_JSON，例如 [{"id":"tag","name":"Tag · CCFlash","url":"http://127.0.0.1:4311"}]。 */
export function parsePeerInstances(raw: string | undefined): PeerInstance[] {
  return raw ? peerInstancesSchema.parse(JSON.parse(raw)) : [];
}

const PROXY_PATH = /^\/api\/instances\/([a-z0-9-]+)(\/[^#]*)$/;
// 逐跳头不转发；Host 由目标地址重新生成；登录凭据和 Origin 属于主服务，对方是本机实例，不需要。
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const PRIVATE_REQUEST_HEADERS = ['host', 'cookie', 'authorization', 'origin', 'referer'];
const DROPPED_REQUEST_HEADERS = new Set([...HOP_BY_HOP, ...PRIVATE_REQUEST_HEADERS]);
const DROPPED_UPGRADE_HEADERS = new Set(PRIVATE_REQUEST_HEADERS);
// 对方的 Set-Cookie 会覆盖主服务同名的登录 cookie。
const DROPPED_RESPONSE_HEADERS = new Set([...HOP_BY_HOP, 'set-cookie']);

const withoutHeaders = (headers: IncomingHttpHeaders, dropped: Set<string>) =>
  Object.fromEntries(Object.entries(headers).filter(([name, value]) => value !== undefined && !dropped.has(name)));

export function registerInstanceProxy(app: FastifyInstance, peers: PeerInstance[], auth: TerminalRouteAuth | undefined): void {
  app.get('/api/instances', async () => ({ instances: peers.map(({ id, name }) => ({ id, name })) }));
  if (!peers.length) return;
  const byId = new Map(peers.map(peer => [peer.id, peer]));
  const target = (url: string | undefined) => {
    const match = PROXY_PATH.exec(url ?? '');
    const peer = match && byId.get(match[1]!);
    return peer ? { peer, url: new URL(`/api${match[2]}`, peer.url) } : undefined;
  };

  void app.register(async scope => {
    // 请求体原样转发，不在主服务解析。
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
    scope.all('/api/instances/:id/*', async (request, reply) => {
      const upstreamTarget = target(request.raw.url);
      if (!upstreamTarget) throw new RuntimeError('INSTANCE_NOT_FOUND', `Unknown instance: ${(request.params as { id: string }).id}`, 404);
      const { peer, url } = upstreamTarget;
      reply.hijack();
      const upstream = httpRequest(url, { method: request.method, headers: withoutHeaders(request.headers, DROPPED_REQUEST_HEADERS) });
      upstream.on('response', response => {
        // 对方要登录说明它不是 --local-only 启动的；原样回 401 会让浏览器以为主服务掉了登录。
        reply.raw.writeHead(response.statusCode === 401 ? 502 : response.statusCode ?? 502, withoutHeaders(response.headers, DROPPED_RESPONSE_HEADERS));
        response.pipe(reply.raw);
      });
      upstream.on('error', error => {
        if (reply.raw.headersSent || reply.raw.destroyed) { reply.raw.destroy(); return; }
        reply.raw.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        reply.raw.end(JSON.stringify({ error: { code: 'INSTANCE_UNAVAILABLE', message: `${peer.name} 无法连接：${error.message}` } }));
      });
      // 浏览器关掉实时流或请求中断时，一并断开到对方的连接。
      reply.raw.on('close', () => upstream.destroy());
      const body = request.body as Readable | undefined;
      if (body) body.pipe(upstream);
      else upstream.end();
    });
  });

  // 终端 WebSocket 不经过 Fastify 路由，与 registerTerminalRoutes 一样在 upgrade 事件上处理。
  app.addHook('onReady', async () => {
    app.server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
      if (!request.url?.startsWith('/api/instances/')) return;
      const upstreamTarget = target(request.url);
      const rejection: [number, string, string] | undefined = upstreamTarget ? upgradeRejection(request, auth) : [404, 'Not Found', 'instance not found'];
      if (rejection) { rejectUpgrade(socket, ...rejection); return; }
      const upstream = httpRequest(upstreamTarget!.url, { method: 'GET', headers: withoutHeaders(request.headers, DROPPED_UPGRADE_HEADERS) });
      upstream.on('upgrade', (response, peerSocket, peerHead) => {
        const headerLines = response.rawHeaders.reduce((lines, value, index) => index % 2 ? `${lines}: ${value}\r\n` : `${lines}${value}`, '');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headerLines}\r\n`);
        if (peerHead.length) socket.write(peerHead);
        if (head.length) peerSocket.write(head);
        const close = () => { socket.destroy(); peerSocket.destroy(); };
        socket.on('error', close).on('close', close);
        peerSocket.on('error', close).on('close', close);
        peerSocket.pipe(socket).pipe(peerSocket);
      });
      upstream.on('response', response => { response.resume(); rejectUpgrade(socket, response.statusCode ?? 502, response.statusMessage ?? 'Bad Gateway', 'instance refused the upgrade'); });
      upstream.on('error', () => rejectUpgrade(socket, 502, 'Bad Gateway', 'instance unavailable'));
      upstream.end();
    });
  });
}
