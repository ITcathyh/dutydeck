import type { PolicyDecision, TerminalStream } from '@dutydeck/shared';
import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { extractBearerToken, extractCookie, isLoopbackHost, isSameOriginRequest } from '../auth/auth.js';

/** 终端流句柄：stream + 进程退出订阅（runtime 侧从 driver onExit 合成） */
export interface TerminalStreamHandle {
  stream: TerminalStream;
  onExit(callback: (code: number | null) => void): void;
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
}

const TERMINAL_PATH_PREFIX = '/api/terminal/';

/** 从 unknown 提取错误信息 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 升级前在 raw socket 上回 HTTP 错误并断开（不进入 WS 协议） */
function rejectUpgrade(socket: Socket, statusCode: number, statusText: string, message: string): void {
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
  authorizeWrite?: () => Promise<PolicyDecision>,
): void {
  const { stream } = handle;
  let disposed = false;
  let closed = false;

  const sendFrame = (frame: unknown): void => {
    // 注意：OPEN 是 WebSocket 的静态属性，实例上没有，不能写 ws.OPEN
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // 发送失败（对端已半关）按连接关闭处理
    }
  };

  /** 连接结束时只 dispose 一次（不杀 PTY 进程），幂等 */
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    onClosed();
    if (disposed) return;
    disposed = true;
    try {
      stream.dispose();
    } catch {
      // dispose 幂等，异常忽略
    }
  };

  // PTY 输出 → data 帧
  stream.onData(
    data => sendFrame({ type: 'data', data }),
    screen => sendFrame({ type: 'snapshot', ...screen }),
  );
  // 进程退出 → exit 帧后主动关闭
  handle.onExit(code => {
    sendFrame({ type: 'exit', code });
    try {
      ws.close();
    } catch {
      // 已关闭则忽略
    }
  });

  const handleMessage = async (raw: RawData) => {
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
      if (decision && !decision.allowed) {
        sendFrame({ type: 'error', message: decision.reason, code: decision.code });
        try { ws.close(); } catch { /* 已关闭 */ }
        return;
      }
    }
    if (message?.type === 'input') {
      try {
        stream.write(String(message.data ?? ''));
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
      if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
        sendFrame({ type: 'error', message: 'resize requires numeric cols and rows' });
        return;
      }
      try {
        stream.resize(cols, rows);
      } catch (error) {
        sendFrame({ type: 'error', message: errorMessage(error) });
        try { ws.close(); } catch { /* 已关闭 */ }
      }
      return;
    }
    // 未知 type / 解析失败 → error 帧，不断开
    sendFrame({ type: 'error', message: `unknown message type: ${String(message?.type)}` });
  };
  // Authorization may be asynchronous. Preserve PTY input ordering instead of
  // allowing a slower permission lookup to reorder adjacent key frames.
  let messageChain = Promise.resolve();
  ws.on('message', raw => {
    messageChain = messageChain.then(() => handleMessage(raw)).catch(error => {
      sendFrame({ type: 'error', message: errorMessage(error) });
      try { ws.close(); } catch { /* 已关闭 */ }
    });
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

/**
 * 注册终端 WS 代理路由：GET /api/terminal/:sessionId（WebSocket 升级）。
 *
 * 协议：
 *  - 服务端→客户端：{"type":"data","data":...} / {"type":"exit","code":n} / {"type":"error","message":...}
 *  - 客户端→服务端：{"type":"input","data":...} / {"type":"resize","cols":n,"rows":n}
 *
 * 只拦截 pathname 以 /api/terminal/ 开头的 upgrade，其它路径直接放行，不影响未来其它 WS。
 */
export function registerTerminalRoutes(app: FastifyInstance, options: TerminalRouteOptions): void {
  const wss = new WebSocketServer({ noServer: true });
  const active = new Set<WebSocket>();

  /*
   * 必须用被动的 onReady 钩子，不能调 app.ready(cb)：
   * app.ready() 会**主动触发** Fastify 的 boot。buildApp 里终端路由注册在前，
   * 之后还有 await registerLarkRoutes 等异步注册；真实启动时 Lark 那步要等网络
   * （读取并同步 Bot 配置），boot 就在这个 await 期间跑完了，随后的 addHook /
   * 路由注册直接抛 "Fastify instance is already listening. Cannot call addHook!"。
   * onReady 只登记回调，由 listen 时统一触发，时机与原来一致，WS 行为不变。
   */
  app.addHook('onReady', async () => {
    const server = app.server;
    // 防御：app.server 在 listen 后才存在（ready 后理论上必有）
    if (!server) return;
    server.on('upgrade', async (request: IncomingMessage, socket: Socket, head: Buffer) => {
      let url: URL;
      try {
        url = new URL(request.url ?? '/', 'http://terminal.local');
      } catch {
        return; // 非法 URL 不属本路由，交给其它 upgrade 处理者
      }
      if (!url.pathname.startsWith(TERMINAL_PATH_PREFIX)) return; // 非本路由，放行

      const authMode = options.auth?.mode ?? (options.auth?.allowUnauthenticated ? 'local' : 'token');
      // Explicit open mode accepts remote hosts without a token, while browser
      // upgrades still have to originate from the exact public Dutydeck origin.
      if (options.auth && authMode === 'open') {
        const encrypted = 'encrypted' in request.socket && request.socket.encrypted === true;
        if (request.headers.origin && !isSameOriginRequest(request.headers, encrypted ? 'https' : 'http')) {
          rejectUpgrade(socket, 403, 'Forbidden', 'origin not allowed');
          return;
        }
      // local-only may omit a token, but still validates Host/Origin to block
      // browser DNS rebinding into the loopback terminal.
      } else if (options.auth && authMode === 'local') {
        if (!isLoopbackHost(request.headers.host)) {
          rejectUpgrade(socket, 403, 'Forbidden', 'host not allowed');
          return;
        }
        const encrypted = 'encrypted' in request.socket && request.socket.encrypted === true;
        if (request.headers.origin && !isSameOriginRequest({ origin: request.headers.origin, host: request.headers.host }, encrypted ? 'https' : 'http')) {
          rejectUpgrade(socket, 403, 'Forbidden', 'origin not allowed');
          return;
        }
      } else if (options.auth) {
        const cookie = extractCookie(request.headers.cookie);
        const bearer = extractBearerToken(request.headers.authorization);
        const encrypted = 'encrypted' in request.socket && request.socket.encrypted === true;
        if (request.headers.origin && !isSameOriginRequest(request.headers, encrypted ? 'https' : 'http')) {
          rejectUpgrade(socket, 403, 'Forbidden', 'origin not allowed');
          return;
        }
        if (!options.auth.check(bearer ?? cookie)) {
          rejectUpgrade(socket, 401, 'Unauthorized', 'unauthorized');
          return;
        }
      }

      // 解析 sessionId：只取第一段，decodeURIComponent
      const firstSegment = url.pathname.slice(TERMINAL_PATH_PREFIX.length).split('/')[0] ?? '';
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
      if (socket.destroyed) { lookup.handle.stream.dispose(); return; }

      wss.handleUpgrade(request, socket, head, ws => {
        active.add(ws);
        bindConnection(
          ws,
          lookup.handle,
          () => active.delete(ws),
          options.authorize ? () => options.authorize!(request, sessionId, 'terminal.write') : undefined,
        );
      });
    });
  });

  // 与 app.ts 的 streams Set 清理模式对齐：app 关闭时断开所有终端连接
  app.addHook('onClose', async () => {
    for (const ws of active) {
      try { ws.terminate(); } catch { /* 已关闭 */ }
    }
    active.clear();
    wss.close();
  });
}
