import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ConfigRepository } from '@dutydeck/shared';

/** token 在 configs 表中的 key */
export const AUTH_TOKEN_CONFIG_KEY = 'auth.accessToken';
export const AUTH_COOKIE_NAME = 'dutydeck_access';

/** 32 随机字节 base64url（43 字符，无填充） */
export function generateAuthToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 读取当前 token；不存在（或为空/纯空白）返回 null，不自动创建 */
export async function getAuthToken(configs: ConfigRepository): Promise<string | null> {
  const stored = await configs.get(AUTH_TOKEN_CONFIG_KEY);
  const token = stored?.trim();
  return token ? token : null;
}

/**
 * 同进程内的「读-建-写」串行化闩。
 *
 * loadOrCreateAuthToken 是 get-then-set：两个并发调用都可能读到空，各自生成
 * 一个 token 并写入，后写的赢——先拿到 token 的调用方手里就是个已失效的串。
 * 按 ConfigRepository 实例去重在途调用，让并发调用共享同一次创建。
 *
 * 注意边界：ConfigRepository 只有 get/set，没有 insert-if-absent，所以**跨进程**
 * 的同一 DB 竞态仍然存在（两个 daemon 同时首启）。真正修掉它需要 storage 层
 * 提供原子的 setIfAbsent；在此之前，跨进程首启请避免并发。
 */
const inFlightTokenCreation = new WeakMap<ConfigRepository, Promise<{ token: string; created: boolean }>>();

/** 读取或创建 token。created=true 表示本次新建（调用方负责打印一次日志） */
export async function loadOrCreateAuthToken(
  configs: ConfigRepository,
): Promise<{ token: string; created: boolean }> {
  const existing = await getAuthToken(configs);
  if (existing) return { token: existing, created: false };

  const inFlight = inFlightTokenCreation.get(configs);
  if (inFlight) {
    // 并发调用共享同一次创建，但 created 只对发起者为 true——日志才不会打两次。
    const shared = await inFlight;
    return { token: shared.token, created: false };
  }

  const creation = (async () => {
    // 二次确认：等到闩之前可能已有别的调用写完了。
    const raced = await getAuthToken(configs);
    if (raced) return { token: raced, created: false };
    const token = generateAuthToken();
    await configs.set(AUTH_TOKEN_CONFIG_KEY, token);
    return { token, created: true };
  })();
  inFlightTokenCreation.set(configs, creation);
  try {
    return await creation;
  } finally {
    inFlightTokenCreation.delete(configs);
  }
}

/** 轮换 token（无条件重新生成并写入），返回新 token；旧 token 随即失效 */
export async function rotateAuthToken(configs: ConfigRepository): Promise<string> {
  const token = generateAuthToken();
  await configs.set(AUTH_TOKEN_CONFIG_KEY, token);
  return token;
}

/** timing-safe 比对；长度不同直接返回 false（避免 timingSafeEqual 抛 RangeError） */
export function tokensEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** 从 Authorization 头提取 Bearer token；缺失或格式不对返回 undefined */
export function extractBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  const token = match?.[1]?.trim();
  return token || undefined;
}

/** Read one exact cookie without decoding arbitrary user-controlled values. */
export function extractCookie(cookieHeader: string | undefined, name = AUTH_COOKIE_NAME): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value || undefined;
  }
  return undefined;
}

export interface AuthMiddlewareOptions {
  /** Explicit access mode. Omitted for compatibility with localOnly callers. */
  mode?: 'local' | 'token' | 'open';
  /** 当前有效 token（null = 未配置，fail closed：非豁免请求一律 401） */
  getToken(): Promise<string | null>;
  /** 服务以 --local-only 启动（绑 127.0.0.1）时为 true；仍校验 Host/Origin 以阻断 DNS rebinding */
  localOnly: boolean;
  /** 额外豁免判定（如 /api/lark/agent-tools/* 自有 Bearer）。默认无豁免 */
  exempt?: (method: string, pathname: string) => boolean;
}

export type BrowserAuthState = { authenticated: boolean; required: boolean };

const accessMode = (options: AuthMiddlewareOptions): 'local' | 'token' | 'open' =>
  options.mode ?? (options.localOnly ? 'local' : 'token');

const UNAUTHORIZED_PAYLOAD = {
  error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
} as const;

type OriginHeaders = {
  origin?: string;
  host?: string;
  'x-forwarded-host'?: string | string[];
  'x-forwarded-proto'?: string | string[];
};

const firstForwardedValue = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim();

/** Browser cookie/WS requests must originate from the exact public Dutydeck origin. */
export function isSameOriginRequest(headers: OriginHeaders, fallbackProtocol = 'http'): boolean {
  if (!headers.origin) return true;
  const host = firstForwardedValue(headers['x-forwarded-host']) || headers.host?.trim();
  const protocol = firstForwardedValue(headers['x-forwarded-proto']) || fallbackProtocol;
  if (!host || (protocol !== 'http' && protocol !== 'https')) return false;
  try { return new URL(headers.origin).origin === `${protocol}://${host}`; }
  catch { return false; }
}

/** local-only requests may name only the loopback listener, never an attacker-controlled DNS host. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

/**
 * 注册访问认证中间件（Fastify onRequest hook）。判定顺序：
 * 1. localOnly → 仅 loopback Host 且（若有）Origin 精确同源时放行
 * 2. exempt(method, pathname) 为 true → 放行
 * 3. 否则取 presented token（Authorization: Bearer 头或 HttpOnly cookie），
 *    与 getToken() 的当前 token 做 timing-safe 比对；未配置/缺失/不匹配 → 401
 */
export function registerAuthMiddleware(app: FastifyInstance, options: AuthMiddlewareOptions): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const mode = accessMode(options);
    if (mode === 'local') {
      if (!isLoopbackHost(request.headers.host)) {
        return reply.code(403).send({ error: { code: 'HOST_NOT_ALLOWED', message: 'Local-only requests require a loopback Host' } });
      }
      if (request.headers.origin && !isSameOriginRequest({ origin: request.headers.origin, host: request.headers.host }, request.protocol)) {
        return reply.code(403).send({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Request origin does not match Dutydeck' } });
      }
      return;
    }
    if (mode === 'open') {
      // --no-auth removes the credential gate, not browser same-origin
      // protection. CLI/API clients without Origin remain supported.
      if (request.headers.origin && !isSameOriginRequest(request.headers, request.protocol)) {
        return reply.code(403).send({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Request origin does not match Dutydeck' } });
      }
      return;
    }
    const pathname = new URL(request.url, 'http://dutydeck.local').pathname;
    if (options.exempt?.(request.method, pathname)) return;
    const bearer = extractBearerToken(request.headers.authorization);
    const cookie = extractCookie(request.headers.cookie);
    if (!bearer && cookie && !isSameOriginRequest(request.headers, request.protocol)) {
      return reply.code(403).send({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Request origin does not match Dutydeck' } });
    }
    const presented = bearer ?? cookie;
    const token = await options.getToken();
    if (!token || !presented || !tokensEqual(presented, token)) {
      return reply.code(401).send(UNAUTHORIZED_PAYLOAD);
    }
  });
}

const browserAuthRequired = (request: FastifyRequest, options: AuthMiddlewareOptions) =>
  accessMode(options) === 'token';

const requestToken = (request: FastifyRequest) => extractBearerToken(request.headers.authorization)
  ?? extractCookie(request.headers.cookie);

const cookieAttributes = (request: FastifyRequest, clear = false) => {
  const forwarded = request.headers['x-forwarded-proto'];
  const protocol = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  const secure = request.protocol === 'https' || protocol === 'https';
  return [
    `${AUTH_COOKIE_NAME}=${clear ? '' : '__VALUE__'}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    ...(secure ? ['Secure'] : []),
    ...(clear ? ['Max-Age=0'] : ['Max-Age=2592000'])
  ].join('; ');
};

/**
 * Browser login for remote Web access. The long-lived access token is submitted
 * once and kept in an HttpOnly, same-site cookie, so fetch, EventSource and
 * WebSocket upgrades authenticate without exposing it in URLs or JavaScript.
 */
export function registerBrowserAuthRoutes(app: FastifyInstance, options: AuthMiddlewareOptions): void {
  app.get('/api/auth/status', async (request, reply): Promise<BrowserAuthState> => {
    reply.header('Cache-Control', 'no-store');
    const required = browserAuthRequired(request, options);
    if (!required) return { authenticated: true, required: false };
    const expected = await options.getToken();
    const presented = requestToken(request);
    return { authenticated: Boolean(expected && presented && tokensEqual(presented, expected)), required: true };
  });

  app.post<{ Body: { token?: unknown } }>('/api/auth/login', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!browserAuthRequired(request, options)) return { authenticated: true, required: false } satisfies BrowserAuthState;
    const expected = await options.getToken();
    const presented = typeof request.body?.token === 'string' ? request.body.token.trim() : '';
    if (!expected || !presented || !tokensEqual(presented, expected)) {
      return reply.code(401).send(UNAUTHORIZED_PAYLOAD);
    }
    reply.header('Set-Cookie', cookieAttributes(request).replace('__VALUE__', presented));
    return { authenticated: true, required: true } satisfies BrowserAuthState;
  });

  app.post('/api/auth/logout', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Set-Cookie', cookieAttributes(request, true));
    const required = browserAuthRequired(request, options);
    return { authenticated: !required, required } satisfies BrowserAuthState;
  });
}

export interface AuthTokenCommandResult {
  token: string;
  created: boolean;
  rotated: boolean;
}

/** `dutydeck auth token` CLI 的处理器逻辑（负责人负责 commander 接线） */
export async function runAuthTokenCommand(
  configs: ConfigRepository,
  options: { rotate?: boolean },
): Promise<AuthTokenCommandResult> {
  if (options.rotate) {
    const token = await rotateAuthToken(configs);
    return { token, created: false, rotated: true };
  }
  const { token, created } = await loadOrCreateAuthToken(configs);
  return { token, created, rotated: false };
}
