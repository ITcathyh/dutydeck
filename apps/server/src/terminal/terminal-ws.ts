import { errorMessage, type PolicyDecision, type TerminalStream } from '@dutydeck/shared';
import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { extractBearerToken, extractCookie, isLoopbackHost, isSameOriginRequest, SHARE_TOKEN_QUERY_KEY } from '../auth/auth.js';

/** 终端流句柄：stream + 进程退出订阅（runtime 侧从 driver onExit 合成） */
export interface TerminalStreamHandle {
  stream: TerminalStream;
  onExit(callback: (code: number | null) => void): (() => void) | void;
}

export type TerminalStreamLookup =
  | { status: 'ready'; handle: TerminalStreamHandle }
  | { status: 'no-session' }      // session 不存在 → 404
  | { status: 'unsupported' };    // driver 不支持终端流（ACP）→ 400

/** runtime driver 终端流的只读访问器，由 service 在 app 组装时注入。 */
export interface TerminalStreamProvider {
  lookupTerminalStream(sessionId: string): TerminalStreamLookup | Promise<TerminalStreamLookup>;
}

/** WS 认证钩子（由 auth 模块提供，负责人接线）；不传 = 不认证（loopback 场景） */
export interface TerminalRouteAuth {
  /** Explicit access mode. Omitted for compatibility with older callers. */
  mode?: 'local' | 'token' | 'open';
  /** 仅显式 local-only 监听可免认证。 */
  allowUnauthenticated?: boolean;
  /** 浏览器来自 HttpOnly cookie，非浏览器客户端也可使用 Bearer。 */
  check(presented: string | undefined): boolean;
}

export interface TerminalRouteOptions {
  provider: TerminalStreamProvider;
  auth?: TerminalRouteAuth;
  /** Unified GroupBinding execution gate; legacy sessions return legacy_unmanaged. */
  authorize?: (request: IncomingMessage, sessionId: string, action: 'terminal.read' | 'terminal.write') => Promise<PolicyDecision>;
  /** 升级握手（权限判定 + 终端查找）的最长等待时间。 */
  handshakeTimeoutMs?: number;
}

export interface UpgradeRoute {
  matches(request: IncomingMessage): boolean;
  handle(request: IncomingMessage, socket: Socket, head: Buffer): void | Promise<void>;
}

export const terminalConnectionLimits = {
  pendingSendBytes: 4 * 1024 * 1024,
  instancePendingSendBytes: 32 * 1024 * 1024,
  maxPayloadBytes: 64 * 1024,
  pendingInputBytes: 256 * 1024,
  pendingInputMessages: 128,
} as const;

type SendBudget = { bytes: number };

const TERMINAL_PATH_PREFIX = '/api/terminal/';
const TERMINAL_HANDSHAKE_TIMEOUT_MS = 30_000;

const upgradeRoutes = new WeakMap<object, UpgradeRoute[]>();

/**
 * 同一 HTTP 服务器上的 WS 升级统一在这里分发。服务器一旦有 upgrade 监听器，Node 就不再替
 * 没人认领的升级请求收尾，也不受请求超时约束，所以无人认领的升级必须当场回 404 断开，
 * 否则未认证的客户端可以无限占住连接，并拖住停服。
 */
export function registerUpgradeRoute(app: FastifyInstance, route: UpgradeRoute): void {
  const existing = upgradeRoutes.get(app.server);
  if (existing) { existing.push(route); return; }
  const routes = [route];
  upgradeRoutes.set(app.server, routes);
  // 被动 onReady，不能调 app.ready()，原因见 registerTerminalRoutes。
  app.addHook('onReady', async () => {
    app.server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
      const matched = routes.find(candidate => candidate.matches(request));
      if (!matched) { rejectUpgrade(socket, 404, 'Not Found', 'not found'); return; }
      Promise.resolve().then(() => matched.handle(request, socket, head)).catch(() => socket.destroy());
    });
  });
}

function terminalPathname(request: IncomingMessage): string | undefined {
  try {
    const { pathname } = new URL(request.url ?? '/', 'http://terminal.local');
    return pathname.startsWith(TERMINAL_PATH_PREFIX) ? pathname : undefined;
  } catch {
    return undefined;
  }
}

/**
 * WS 升级的访问认证，终端与转发到其他实例的升级共用。不传 auth = 不认证（loopback 场景）。
 * 拒绝时返回 rejectUpgrade 的参数，放行时返回 undefined。
 */
export function upgradeRejection(request: IncomingMessage, auth: TerminalRouteAuth | undefined): [statusCode: number, statusText: string, message: string] | undefined {
  if (new URLSearchParams(request.url?.split('?').slice(1).join('?')).has(SHARE_TOKEN_QUERY_KEY)) return [401, 'Unauthorized', 'share links cannot access terminals'];
  if (!auth) return undefined;
  const authMode = auth.mode ?? (auth.allowUnauthenticated ? 'local' : 'token');
  const protocol = 'encrypted' in request.socket && request.socket.encrypted === true ? 'https' : 'http';
  // Explicit open mode accepts remote hosts without a token, while browser
  // upgrades still have to originate from the exact public Dutydeck origin.
  if (authMode === 'open') {
    return request.headers.origin && !isSameOriginRequest(request.headers, protocol) ? [403, 'Forbidden', 'origin not allowed'] : undefined;
  }
  // local-only may omit a token, but still validates Host/Origin to block
  // browser DNS rebinding into the loopback terminal.
  if (authMode === 'local') {
    if (!isLoopbackHost(request.headers.host)) return [403, 'Forbidden', 'host not allowed'];
    return request.headers.origin && !isSameOriginRequest({ origin: request.headers.origin, host: request.headers.host }, protocol) ? [403, 'Forbidden', 'origin not allowed'] : undefined;
  }
  if (request.headers.origin && !isSameOriginRequest(request.headers, protocol)) return [403, 'Forbidden', 'origin not allowed'];
  if (!auth.check(extractBearerToken(request.headers.authorization) ?? extractCookie(request.headers.cookie))) return [401, 'Unauthorized', 'unauthorized'];
  return undefined;
}

/** 升级前在 raw socket 上回 HTTP 错误并断开（不进入 WS 协议） */
export function rejectUpgrade(socket: Socket, statusCode: number, statusText: string, message: string): void {
  const body = JSON.stringify({ type: 'error', message });
  socket.on('error', () => {}); // 对端可能已断开，写错误响应时静默吞掉 ECONNRESET
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      'Content-Type: application/json; charset=utf-8\r\n' +
      'Connection: close\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      '\r\n' +
      body
  );
  socket.destroy();
}

/** 单个 WS 连接的双向绑定：stream → ws 帧、ws 消息 → stream 调用 */
function bindConnection(
  ws: WebSocket,
  handle: TerminalStreamHandle,
  onClosed: () => void,
  sendBudget: SendBudget,
  authorizeWrite?: () => Promise<PolicyDecision>,
): void {
  const { stream } = handle;
  let closed = false;
  let pendingSendBytes = 0;
  let unsubscribeExit: (() => void) | void;
  const inputQueue: Array<{ raw: RawData; bytes: number }> = [];
  let pendingInputBytes = 0;
  let processingInput = false;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    onClosed();
    sendBudget.bytes -= pendingSendBytes;
    pendingSendBytes = 0;
    inputQueue.length = 0;
    pendingInputBytes = 0;
    unsubscribeExit?.();
    try { stream.dispose(); } catch { /* dispose 幂等 */ }
  };
  const disconnect = (): void => {
    cleanup();
    ws.terminate();
  };
  const sendPayload = (payload: string | Buffer, pong = false): void => {
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    const bytes = Buffer.byteLength(payload) + 14; // Maximum WS frame header.
    if (pendingSendBytes + bytes > terminalConnectionLimits.pendingSendBytes
      || sendBudget.bytes + bytes > terminalConnectionLimits.instancePendingSendBytes) {
      // A reconnect restores a snapshot; never pause the shared PTY producer.
      disconnect();
      return;
    }
    pendingSendBytes += bytes;
    sendBudget.bytes += bytes;
    try {
      const sent = (error?: Error) => {
        if (closed) return;
        pendingSendBytes -= bytes;
        sendBudget.bytes -= bytes;
        if (error) disconnect();
      };
      if (pong) ws.pong(payload, false, sent);
      else ws.send(payload, sent);
    } catch { disconnect(); }
  };
  const sendFrame = (frame: unknown): void => sendPayload(JSON.stringify(frame));
  ws.on('ping', data => sendPayload(data, true));
  ws.on('close', cleanup);
  ws.on('error', disconnect);

  stream.onData(
    data => sendFrame({ type: 'data', data }),
    screen => sendFrame({ type: 'snapshot', ...screen }),
  );
  if (!closed) {
    const unsubscribe = handle.onExit(code => {
      sendFrame({ type: 'exit', code });
      try { ws.close(); } catch { disconnect(); }
    });
    if (closed) unsubscribe?.();
    else unsubscribeExit = unsubscribe;
  }

  const handleMessage = async (raw: RawData) => {
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    let message: any;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      sendFrame({ type: 'error', message: 'invalid JSON message' });
      return;
    }
    if (message?.type === 'input' || message?.type === 'resize') {
      let decision: PolicyDecision | undefined;
      try { decision = await authorizeWrite?.(); }
      catch { decision = { allowed: false, action: 'terminal.write', code: 'permission_evaluator_failed', reason: 'Terminal permission evaluation failed', source: 'integration' }; }
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      if (decision && !decision.allowed) {
        sendFrame({ type: 'error', message: decision.reason, code: decision.code });
        try { ws.close(); } catch { /* 已关闭 */ }
        return;
      }
    }
    if (message?.type === 'input') {
      try {
        await stream.write(String(message.data ?? ''));
      } catch (error) {
        // 运行期 stream 异常 → error 帧后 close
        sendFrame({ type: 'error', message: errorMessage(error) });
        try { ws.close(); } catch { /* 已关闭 */ }
      }
      return;
    }
    if (message?.type === 'resize') {
      const cols = Number(message.cols);
      const rows = Number(message.rows);
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
        sendFrame({ type: 'error', message: 'resize requires positive integer cols and rows' });
        return;
      }
      try {
        await stream.resize(cols, rows);
      } catch (error) {
        sendFrame({ type: 'error', message: errorMessage(error) });
        try { ws.close(); } catch { /* 已关闭 */ }
      }
      return;
    }
    // 未知 type / 解析失败 → error 帧，不断开
    sendFrame({ type: 'error', message: `unknown message type: ${String(message?.type)}` });
  };
  // One active authorization retains at most one frame; waiting frames have
  // both a byte and a count budget, and are discarded on disconnect.
  const pumpInput = async () => {
    if (processingInput) return;
    processingInput = true;
    try {
      while (!closed && inputQueue.length) {
        const item = inputQueue.shift()!;
        try { await handleMessage(item.raw); }
        finally { pendingInputBytes = Math.max(0, pendingInputBytes - item.bytes); }
      }
    } catch (error) {
      sendFrame({ type: 'error', message: errorMessage(error) });
      disconnect();
    } finally { processingInput = false; }
  };
  ws.on('message', raw => {
    if (closed) return;
    const bytes = Array.isArray(raw) ? raw.reduce((total, part) => total + part.length, 0) : raw.byteLength;
    if (pendingInputBytes + bytes > terminalConnectionLimits.pendingInputBytes
      || inputQueue.length + Number(processingInput) >= terminalConnectionLimits.pendingInputMessages) {
      disconnect();
      return;
    }
    inputQueue.push({ raw, bytes });
    pendingInputBytes += bytes;
    void pumpInput();
  });
}

/**
 * 注册终端 WS 代理路由：GET /api/terminal/:sessionId（WebSocket 升级）。
 *
 * 协议：
 *  - 服务端→客户端：{"type":"data","data":...} / {"type":"exit","code":n} / {"type":"error","message":...}
 *  - 客户端→服务端：{"type":"input","data":...} / {"type":"resize","cols":n,"rows":n}
 *
 * 只认领 pathname 以 /api/terminal/ 开头的 upgrade；其它路径由 registerUpgradeRoute 的分发器处理。
 */
export function registerTerminalRoutes(app: FastifyInstance, options: TerminalRouteOptions): void {
  const wss = new WebSocketServer({ noServer: true, autoPong: false, maxPayload: terminalConnectionLimits.maxPayloadBytes });
  const active = new Set<WebSocket>();
  const sendBudget: SendBudget = { bytes: 0 };
  const pending = new Set<Socket>();
  let closing = false;
  let closeRun: Promise<void> | undefined;

  /*
   * upgrade 监听器必须挂在被动的 onReady 钩子上（registerUpgradeRoute 内），不能调 app.ready(cb)：
   * app.ready() 会**主动触发** Fastify 的 boot。buildApp 里终端路由注册在前，
   * 之后还有 await registerLarkRoutes 等异步注册；真实启动时 Lark 那步要等网络
   * （读取并同步 Bot 配置），boot 就在这个 await 期间跑完了，随后的 addHook /
   * 路由注册直接抛 "Fastify instance is already listening. Cannot call addHook!"。
   * onReady 只登记回调，由 listen 时统一触发。
   */
  registerUpgradeRoute(app, {
    matches: request => terminalPathname(request) !== undefined,
    handle: async (request, socket, head) => {
      const pathname = terminalPathname(request)!;
      const onSocketError = () => {
        pending.delete(socket);
        socket.destroy();
      };
      socket.on('error', onSocketError);
      if (closing) { socket.destroy(); return; }
      pending.add(socket);
      // 权限判定与终端查找都可能卡住；握手不能无限占着连接。
      const deadline = setTimeout(
        () => rejectUpgrade(socket, 504, 'Gateway Timeout', 'terminal handshake timed out'),
        options.handshakeTimeoutMs ?? TERMINAL_HANDSHAKE_TIMEOUT_MS,
      );
      socket.once('close', () => { pending.delete(socket); clearTimeout(deadline); });

      const rejection = upgradeRejection(request, options.auth);
      if (rejection) {
        rejectUpgrade(socket, ...rejection);
        return;
      }

      // 解析 sessionId：只取第一段，decodeURIComponent
      const firstSegment = pathname.slice(TERMINAL_PATH_PREFIX.length).split('/')[0] ?? '';
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(firstSegment);
      } catch {
        rejectUpgrade(socket, 400, 'Bad Request', 'invalid session id');
        return;
      }
      if (!sessionId) {
        rejectUpgrade(socket, 404, 'Not Found', 'session not found');
        return;
      }

      if (options.authorize) {
        let decision: PolicyDecision;
        try { decision = await options.authorize(request, sessionId, 'terminal.read'); }
        catch {
          rejectUpgrade(socket, 503, 'Service Unavailable', 'terminal permission evaluation failed');
          return;
        }
        if (!decision.allowed) {
          rejectUpgrade(socket, 403, 'Forbidden', decision.reason);
          return;
        }
      }

      if (closing || socket.destroyed) return;
      let lookup: TerminalStreamLookup;
      try { lookup = await options.provider.lookupTerminalStream(sessionId); }
      catch (error) {
        rejectUpgrade(socket, 503, 'Service Unavailable', errorMessage(error));
        return;
      }
      if (lookup.status === 'no-session') {
        rejectUpgrade(socket, 404, 'Not Found', 'session not found');
        return;
      }
      if (lookup.status === 'unsupported') {
        rejectUpgrade(socket, 400, 'Bad Request', 'terminal stream not supported for this session');
        return;
      }
      if (closing || socket.destroyed) { lookup.handle.stream.dispose(); socket.destroy(); return; }

      clearTimeout(deadline);
      wss.handleUpgrade(request, socket, head, ws => {
        socket.removeListener('error', onSocketError);
        pending.delete(socket);
        active.add(ws);
        bindConnection(
          ws,
          lookup.handle,
          () => active.delete(ws),
          sendBudget,
          options.authorize ? () => options.authorize!(request, sessionId, 'terminal.write') : undefined,
        );
      });
    },
  });

  // HTTP server.close 等升级连接退出；必须在它之前关闭终端，不能等 onClose。
  app.addHook('preClose', async () => {
    if (closeRun) return closeRun;
    closing = true;
    for (const socket of pending) socket.destroy();
    pending.clear();
    for (const ws of active) {
      try { ws.terminate(); } catch { /* 已关闭 */ }
    }
    active.clear();
    closeRun = new Promise<void>((resolve, reject) => wss.close(error => error ? reject(error) : resolve()));
    return closeRun;
  });
}
