import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ConfigRepository } from '@dockmux/shared';

/** token 在 configs 表中的 key */
export const AUTH_TOKEN_CONFIG_KEY = 'auth.accessToken';

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

/** 读取或创建 token。created=true 表示本次新建（调用方负责打印一次日志） */
export async function loadOrCreateAuthToken(
  configs: ConfigRepository,
): Promise<{ token: string; created: boolean }> {
  const existing = await getAuthToken(configs);
  if (existing) return { token: existing, created: false };
  const token = generateAuthToken();
  await configs.set(AUTH_TOKEN_CONFIG_KEY, token);
  return { token, created: true };
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

/** loopback：127.0.0.1 / ::1 / ::ffff:127.0.0.1（IPv4-mapped） */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1';
}

/** 从 Authorization 头提取 Bearer token；缺失或格式不对返回 undefined */
export function extractBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  const token = match?.[1]?.trim();
  return token || undefined;
}

export interface AuthMiddlewareOptions {
  /** 当前有效 token（null = 未配置，fail closed：非豁免请求一律 401） */
  getToken(): Promise<string | null>;
  /** 服务以 --local-only 启动（绑 127.0.0.1）时为 true，全部豁免 */
  localOnly: boolean;
  /** 额外豁免判定（如 /api/lark/agent-tools/* 自有 Bearer）。默认无豁免 */
  exempt?: (method: string, pathname: string) => boolean;
}

const UNAUTHORIZED_PAYLOAD = {
  error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
} as const;

/** 从 query 中取 token：SSE 的 EventSource 与 WS 升级都无法设 Authorization 头 */
function tokenFromQuery(query: unknown): string | undefined {
  const value = (query as { token?: unknown } | undefined)?.token;
  if (Array.isArray(value)) {
    const first = value.find(item => typeof item === 'string' && item.length > 0);
    return first === undefined ? undefined : String(first);
  }
  if (typeof value === 'string' && value.length > 0) return value;
  return undefined;
}

/**
 * 注册访问认证中间件（Fastify onRequest hook）。判定顺序：
 * 1. localOnly → 放行（服务只绑 loopback，外部不可达）
 * 2. request.ip 是 loopback → 放行（本机请求免认证）
 * 3. exempt(method, pathname) 为 true → 放行
 * 4. 否则取 presented token（Authorization: Bearer 头或 ?token= query param），
 *    与 getToken() 的当前 token 做 timing-safe 比对；未配置/缺失/不匹配 → 401
 */
export function registerAuthMiddleware(app: FastifyInstance, options: AuthMiddlewareOptions): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (options.localOnly) return;
    if (isLoopbackAddress(request.ip)) return;
    const pathname = new URL(request.url, 'http://dockmux.local').pathname;
    if (options.exempt?.(request.method, pathname)) return;
    const presented = extractBearerToken(request.headers.authorization)
      ?? tokenFromQuery(request.query);
    const token = await options.getToken();
    if (!token || !presented || !tokensEqual(presented, token)) {
      return reply.code(401).send(UNAUTHORIZED_PAYLOAD);
    }
  });
}

export interface AuthTokenCommandResult {
  token: string;
  created: boolean;
  rotated: boolean;
}

/** `dockmux auth token` CLI 的处理器逻辑（负责人负责 commander 接线） */
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
