import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RuntimeError, type ConfigRepository } from '@dutydeck/shared';
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
export const BOT_SESSION_ROUTES_KEY = 'dutydeck.bot_session_routes';
const sessionRoutesSchema = z.object({ version: z.literal(1), routes: z.record(z.string().min(1), z.string().regex(/^[a-z0-9-]+$/)) }).strict();

/**
 * 分享链接能经主服务转发到对方实例的接口（会话路径之后的部分）：会话分享页的只读接口，
 * 「查看改动」页读 diff 和提交评论（评论只会变成飞书确认卡，见 turn-diff-routes.ts）。
 */
const SHARED_PROXY_SUFFIX: Record<string, RegExp> = {
  GET: /^(?:\/(?:events|tasks|stream|tasks\/[A-Za-z0-9_-]+\/diff))?$/,
  HEAD: /^(?:\/(?:events|tasks|stream|tasks\/[A-Za-z0-9_-]+\/diff))?$/,
  POST: /^\/tasks\/[A-Za-z0-9_-]+\/diff\/comments$/
};
const sharedProxyPath = (method: string | undefined, pathname: string, prefix: string) => {
  const match = new RegExp(`^${prefix}/([A-Za-z0-9_-]+)(.*)$`).exec(pathname);
  const suffix = method ? SHARED_PROXY_SUFFIX[method] : undefined;
  return Boolean(match && suffix?.test(match[2]!));
};

/** A dedicated destination path makes anonymous sharing fail closed on older peers. */
export function rewriteSharedSessionProxyUrl(request: { url?: string; method?: string }): string {
  const url = request.url ?? '/';
  const queryAt = url.indexOf('?');
  const tokens = new URLSearchParams(queryAt < 0 ? '' : url.slice(queryAt + 1)).getAll('share');
  if (tokens.length !== 1 || !tokens[0] || !sharedProxyPath(request.method, queryAt < 0 ? url : url.slice(0, queryAt), '/api/shared-sessions')) return url;
  return url.replace(/^\/api\/shared-sessions\//, '/api/sessions/');
}

function proxyTarget(raw: string | undefined, peers: PeerInstance[]) {
  const match = PROXY_PATH.exec(raw ?? '');
  const peer = match && peers.find(item => item.id === match[1]);
  if (!peer || !match) return undefined;
  const path = `/api${match[2]}`;
  const url = new URL(path, peer.url);
  // Do not authorize one path and forward a normalized traversal to another.
  if (url.pathname !== path.split('?')[0] || url.hash || url.origin !== new URL(peer.url).origin) return undefined;
  return { peer, url };
}

export function isSharedInstanceRead(request: Pick<FastifyRequest, 'method' | 'url'>, peers: PeerInstance[]): boolean {
  const target = proxyTarget(request.url, peers);
  if (!target || !sharedProxyPath(request.method, target.url.pathname, '/api/sessions')) return false;
  const tokens = target.url.searchParams.getAll('share');
  return tokens.length === 1 && tokens[0]!.length > 0;
}
// 逐跳头不转发；Host 由目标地址重新生成；登录凭据和 Origin 属于主服务，对方是本机实例，不需要。
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const PRIVATE_REQUEST_HEADERS = ['host', 'cookie', 'authorization', 'origin', 'referer'];
const DROPPED_REQUEST_HEADERS = new Set([...HOP_BY_HOP, ...PRIVATE_REQUEST_HEADERS]);
const DROPPED_UPGRADE_HEADERS = new Set(PRIVATE_REQUEST_HEADERS);
// 对方的 Set-Cookie 会覆盖主服务同名的登录 cookie。
const DROPPED_RESPONSE_HEADERS = new Set([...HOP_BY_HOP, 'set-cookie']);

const withoutHeaders = (headers: IncomingHttpHeaders, dropped: Set<string>) =>
  Object.fromEntries(Object.entries(headers).filter(([name, value]) => value !== undefined && !dropped.has(name)));

export async function registerInstanceProxy(app: FastifyInstance, peers: PeerInstance[], auth: TerminalRouteAuth | undefined, config?: ConfigRepository): Promise<void> {
  const rawRoutes = await config?.get(BOT_SESSION_ROUTES_KEY);
  const routes = rawRoutes == null ? {} : sessionRoutesSchema.parse(JSON.parse(rawRoutes)).routes;
  for (const id of Object.values(routes)) {
    if (!peers.some(peer => peer.id === id)) throw new Error(`Session route references unknown instance: ${id}`);
  }
  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return;
    const match = /^\/(share|sessions|diff)\/([^/?]+)(\/[^/?]+)?(?:\?.*)?$/.exec(request.url);
    // 「查看改动」页是 /diff/<会话>/<任务>，另外两种只有会话一段。
    if (!match || (match[1] === 'diff') !== Boolean(match[3])) return;
    let sessionId: string;
    try { sessionId = decodeURIComponent(match[2]!); } catch { return; }
    const instanceId = Object.prototype.hasOwnProperty.call(routes, sessionId) ? routes[sessionId] : undefined;
    if (instanceId) return reply.header('Cache-Control', 'no-store').redirect(`/instances/${instanceId}/${match[1]}/${encodeURIComponent(sessionId)}${match[3] ?? ''}`, 302);
  });
  app.get('/api/instances', async () => ({ instances: peers.map(({ id, name }) => ({ id, name })) }));
  if (!peers.length) return;
  const target = (url: string | undefined) => proxyTarget(url, peers);
  let closing = false;
  const upgrades = new Set<() => void>();
  const forwards = new Set<() => void>();
  app.addHook('preClose', async () => {
    closing = true;
    for (const close of upgrades) close();
    for (const close of forwards) close();
  });

  void app.register(async scope => {
    // 请求体原样转发，不在主服务解析。
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
    scope.all('/api/instances/:id/*', async (request, reply) => {
      const upstreamTarget = target(request.raw.url);
      if (!upstreamTarget) throw new RuntimeError('INSTANCE_NOT_FOUND', `Unknown instance: ${(request.params as { id: string }).id}`, 404);
      const { peer, url } = upstreamTarget;
      if (closing) throw new RuntimeError('INSTANCE_PROXY_CLOSING', 'Instance proxy is closing', 503);
      const sharedRead = isSharedInstanceRead(request, peers);
      if (sharedRead) url.pathname = url.pathname.replace('/api/sessions/', '/api/shared-sessions/');
      reply.hijack();
      const upstream = httpRequest(url, { method: request.method, headers: withoutHeaders(request.headers, DROPPED_REQUEST_HEADERS) });
      const body = request.body as Readable | undefined;
      let upstreamResponse: IncomingMessage | undefined;
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        forwards.delete(close);
        upstream.destroy();
        upstreamResponse?.destroy();
        if (!reply.raw.writableFinished) reply.raw.destroy();
      };
      forwards.add(close);
      reply.raw.once('close', close).once('error', close);
      reply.raw.once('finish', () => forwards.delete(close));
      request.raw.once('aborted', close);
      body?.once('error', close);
      upstream.on('response', response => {
        upstreamResponse = response;
        if (closed) { response.destroy(); return; }
        // 对方要登录说明它不是 --local-only 启动的；原样回 401 会让浏览器以为主服务掉了登录。
        reply.raw.writeHead(response.statusCode === 401 && !sharedRead ? 502 : response.statusCode ?? 502, withoutHeaders(response.headers, DROPPED_RESPONSE_HEADERS));
        // pipe() does not propagate a premature upstream close, including a
        // revoked share stream, to the browser. Normal end still drains fully.
        response.once('aborted', close).once('error', close);
        response.once('close', () => { if (!response.complete) close(); });
        response.pipe(reply.raw);
      });
      upstream.on('error', error => {
        if (reply.raw.headersSent || reply.raw.destroyed) { reply.raw.destroy(); return; }
        reply.raw.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        reply.raw.end(JSON.stringify({ error: { code: 'INSTANCE_UNAVAILABLE', message: `${peer.name} 无法连接：${error.message}` } }));
      });
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
      if (closing) { socket.destroy(); return; }
      let upstream: ClientRequest;
      let peerSocket: Socket | undefined;
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        upgrades.delete(close);
        upstream?.destroy();
        socket.destroy();
        peerSocket?.destroy();
      };
      upgrades.add(close);
      socket.on('error', close).once('close', close);
      upstream = httpRequest(upstreamTarget!.url, { method: 'GET', headers: withoutHeaders(request.headers, DROPPED_UPGRADE_HEADERS) });
      upstream.on('upgrade', (response, upgradedSocket, peerHead) => {
        peerSocket = upgradedSocket;
        peerSocket.on('error', close).once('close', close);
        if (closing || closed || socket.destroyed) { peerSocket.destroy(); close(); return; }
        const headerLines = response.rawHeaders.reduce((lines, value, index) => index % 2 ? `${lines}: ${value}\r\n` : `${lines}${value}`, '');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headerLines}\r\n`);
        if (peerHead.length) socket.write(peerHead);
        if (head.length) peerSocket.write(head);
        peerSocket.pipe(socket).pipe(peerSocket);
      });
      upstream.on('response', response => {
        response.resume();
        if (!closed) rejectUpgrade(socket, response.statusCode ?? 502, response.statusMessage ?? 'Bad Gateway', 'instance refused the upgrade');
        close();
      });
      upstream.on('error', () => {
        if (!closed) rejectUpgrade(socket, 502, 'Bad Gateway', 'instance unavailable');
        close();
      });
      upstream.end();
    });
  });
}
