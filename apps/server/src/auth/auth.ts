import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify';
import type { ConfigRepository } from '@dutydeck/shared';

/** token 在 configs 表中的 key */
export const AUTH_TOKEN_CONFIG_KEY = 'auth.accessToken';
export const AUTH_COOKIE_NAME = 'dutydeck_access';
/** 访问密码的 scrypt 哈希在 configs 表中的 key；明文不落盘 */
export const AUTH_PASSWORD_CONFIG_KEY = 'auth.passwordHash';
/** 飞书卡片分享链接的签名密钥在 configs 表中的 key */
export const SHARE_LINK_SECRET_CONFIG_KEY = 'auth.shareLinkSecret';
/** 分享 token 放在查询串的这个参数里：EventSource 带不了自定义请求头 */
export const SHARE_TOKEN_QUERY_KEY = 'share';

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

const PASSWORD_SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const scryptKey = (password: string, salt: Buffer, length: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scrypt(password, salt, length, options, (error, key) => error ? reject(error) : resolve(key)));

/** 访问密码最短长度 */
export const MIN_PASSWORD_LENGTH = 8;

/** scrypt 哈希，存成 `scrypt$N$r$p$<salt>$<key>`（base64url）；参数随哈希保存，日后调参不影响旧哈希 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptKey(password, salt, 32, PASSWORD_SCRYPT);
  return ['scrypt', PASSWORD_SCRYPT.N, PASSWORD_SCRYPT.r, PASSWORD_SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** 按哈希里记录的参数重算后 timing-safe 比对；格式不认识一律 false */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  if (expected.length < 16) return false;
  try {
    return timingSafeEqual(await scryptKey(password, Buffer.from(salt, 'base64url'), expected.length, { N: Number(N), r: Number(r), p: Number(p) }), expected);
  } catch {
    return false;
  }
}

/** 读取访问密码哈希；未设置返回 null */
export async function getPasswordHash(configs: ConfigRepository): Promise<string | null> {
  const stored = (await configs.get(AUTH_PASSWORD_CONFIG_KEY))?.trim();
  return stored ? stored : null;
}

/** 随机访问密码：18 随机字节 base64url（24 字符） */
export function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

export interface AuthPasswordCommandResult {
  passwordSet: true;
  /** 只在 --generate 时出现，且只出现这一次 */
  password?: string;
}

/**
 * `dutydeck auth password set` 的处理器：只存 scrypt 哈希。
 * 重设密码会换盐，之前用密码登录的浏览器会话随即失效。
 */
export async function runAuthPasswordSetCommand(
  configs: ConfigRepository,
  options: { generate?: boolean; readPassword(): Promise<string> },
): Promise<AuthPasswordCommandResult> {
  const password = options.generate ? generatePassword() : await options.readPassword();
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`访问密码至少 ${MIN_PASSWORD_LENGTH} 个字符，未修改。`);
  await configs.set(AUTH_PASSWORD_CONFIG_KEY, await hashPassword(password));
  return options.generate ? { passwordSet: true, password } : { passwordSet: true };
}

/** 密码登录发出的浏览器会话有效期，与 cookie 的 Max-Age 一致 */
const BROWSER_SESSION_MAX_AGE_MS = 2592000 * 1000;

const browserSessionMac = (passwordHash: string, issuedAt: string) =>
  createHmac('sha256', passwordHash).update(`dutydeck-browser-session-v1\0${issuedAt}`).digest('base64url');

/**
 * 密码登录后写进 cookie 的会话值 `pw.<签发时刻>.<HMAC>`，以当前密码哈希为钥。
 * cookie 里既没有密码也没有哈希；重设密码后之前签发的会话全部失效。
 */
export function issueBrowserSession(passwordHash: string, now = Date.now()): string {
  const issuedAt = now.toString(36);
  return `pw.${issuedAt}.${browserSessionMac(passwordHash, issuedAt)}`;
}

export function verifyBrowserSession(value: string, passwordHash: string | null, now = Date.now()): boolean {
  const [kind, issuedAt, mac, ...rest] = value.split('.');
  if (!passwordHash || kind !== 'pw' || !issuedAt || !mac || rest.length) return false;
  const issued = Number.parseInt(issuedAt, 36);
  if (!Number.isSafeInteger(issued) || issued > now + 60_000 || now - issued > BROWSER_SESSION_MAX_AGE_MS) return false;
  return tokensEqual(mac, browserSessionMac(passwordHash, issuedAt));
}

/** 访问凭据是否有效：access token（Bearer 或 cookie），或密码登录签发的会话 cookie */
export async function isValidAccessCredential(
  presented: string | undefined,
  getToken: () => Promise<string | null>,
  getPasswordHash?: () => Promise<string | null>,
): Promise<boolean> {
  if (!presented) return false;
  const token = await getToken();
  if (token && tokensEqual(presented, token)) return true;
  return presented.startsWith('pw.') && verifyBrowserSession(presented, await getPasswordHash?.() ?? null);
}

/** 读取分享链接签名密钥；不存在返回 null，不自动创建 */
export async function getShareLinkSecret(configs: ConfigRepository): Promise<string | null> {
  const stored = (await configs.get(SHARE_LINK_SECRET_CONFIG_KEY))?.trim();
  return stored ? stored : null;
}

export async function loadOrCreateShareLinkSecret(configs: ConfigRepository): Promise<string> {
  const existing = await getShareLinkSecret(configs);
  if (existing) return existing;
  const created = randomBytes(32).toString('base64url');
  await configs.set(SHARE_LINK_SECRET_CONFIG_KEY, created);
  return created;
}

/** `dutydeck auth share-key rotate`：换签名密钥，之前发出的分享链接全部失效 */
export async function runShareKeyRotateCommand(configs: ConfigRepository): Promise<{ rotated: true }> {
  await configs.set(SHARE_LINK_SECRET_CONFIG_KEY, randomBytes(32).toString('base64url'));
  return { rotated: true };
}

/**
 * 分享 token = HMAC(密钥, 会话 ID)。同一会话同一密钥总是同一串，所以链接不过期；
 * 换一个会话 ID 算出来的就不是这一串，持有者只能读绑定的那一个会话。
 */
export function signSessionShareToken(secret: string, sessionId: string): string {
  return createHmac('sha256', secret).update(`dutydeck-session-share-v1\0${sessionId}`).digest('base64url');
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

/** 一次性登录链接的有效期 */
export const LOGIN_LINK_TTL_MS = 10 * 60_000;

const loginLinkKey = (code: string) => createHash('sha256').update(code).digest('hex');

/**
 * 飞书卡片「查看详情」换发的一次性登录链接。兑换结果等同 /api/auth/login，
 * 所以只在进程内存里保存随机码的 SHA-256：库里、日志里都没有可用的码，进程重启后未用的链接一并作废。
 * 兑换时先同步删掉记录再发 cookie，同一个码并发兑换只有第一个请求能拿到会话。
 */
export class LoginLinkStore {
  private readonly links = new Map<string, { sessionId: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** 生成绑定 sessionId 的一次性码（32 随机字节 base64url），只返回给调用方一次 */
  issue(sessionId: string): string {
    const now = this.now();
    for (const [key, link] of this.links) if (link.expiresAt <= now) this.links.delete(key);
    const code = randomBytes(32).toString('base64url');
    this.links.set(loginLinkKey(code), { sessionId, expiresAt: now + LOGIN_LINK_TTL_MS });
    return code;
  }

  /** 只查不用：打开链接时的确认页靠它判断要不要给按钮，码不作废 */
  isValid(code: string): boolean {
    const link = this.links.get(loginLinkKey(code));
    return Boolean(link && link.expiresAt > this.now());
  }

  /** 兑换并作废；码无效、已用或已过期时返回 undefined */
  redeem(code: string): string | undefined {
    const key = loginLinkKey(code);
    const link = this.links.get(key);
    this.links.delete(key);
    return link && link.expiresAt > this.now() ? link.sessionId : undefined;
  }
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
  /** 飞书卡片换发的一次性登录链接；只在 token 模式下提供 */
  loginLinks?: LoginLinkStore;
  /** 访问密码哈希（null = 未设置）。设置后浏览器用密码登录 */
  getPasswordHash?(): Promise<string | null>;
  /** 分享链接签名密钥；提供时单个会话的读接口凭分享 token 放行 */
  getShareSecret?(): Promise<string | null>;
  /** 登录失败限流；不传则每个 app 自建一个 */
  loginThrottle?: LoginThrottle;
}

export type BrowserAuthState = { authenticated: boolean; required: boolean; password?: boolean };

/**
 * 登录失败限流：同一来源地址连续失败 maxFailures 次后锁定 lockMs；距上次失败超过 lockMs 重新计数，
 * 成功即清零。只记在内存里，进程重启清空。
 */
export class LoginThrottle {
  private readonly failures = new Map<string, { count: number; until: number }>();

  constructor(private readonly now: () => number = Date.now, private readonly maxFailures = 5, private readonly lockMs = 60_000) {}

  /** 还在锁定期内返回剩余毫秒，否则 0 */
  retryAfter(key: string): number {
    const entry = this.failures.get(key);
    return entry && entry.count >= this.maxFailures ? Math.max(0, entry.until - this.now()) : 0;
  }

  fail(key: string): void {
    const now = this.now();
    for (const [other, entry] of this.failures) if (entry.until <= now) this.failures.delete(other);
    const count = (this.failures.get(key)?.count ?? 0) + 1;
    this.failures.set(key, { count, until: now + this.lockMs });
  }

  succeed(key: string): void {
    this.failures.delete(key);
  }
}

/** 分享页能读的接口：单个会话的详情、事件、任务和实时流，只读 */
const SHARED_SESSION_READ_ROUTES = new Set(['/api/sessions/:id', '/api/sessions/:id/events', '/api/sessions/:id/tasks', '/api/sessions/:id/stream']);

/** GET 上述路由且查询串带着为路由里这个会话 ID 签发的分享 token */
async function isSharedSessionRead(request: FastifyRequest, options: AuthMiddlewareOptions): Promise<boolean> {
  if (!options.getShareSecret || (request.method !== 'GET' && request.method !== 'HEAD')) return false;
  if (!SHARED_SESSION_READ_ROUTES.has(request.routeOptions.url ?? '')) return false;
  const token = (request.query as Record<string, unknown> | undefined)?.[SHARE_TOKEN_QUERY_KEY];
  const sessionId = (request.params as { id?: unknown } | undefined)?.id;
  if (typeof token !== 'string' || !token || typeof sessionId !== 'string' || !sessionId) return false;
  const secret = await options.getShareSecret();
  return Boolean(secret) && tokensEqual(token, signSessionShareToken(secret!, sessionId));
}

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
 * 3. 单个会话的读接口带着绑定该会话的分享 token → 放行
 * 4. 否则取 presented token（Authorization: Bearer 头或 HttpOnly cookie），
 *    与 getToken() 的当前 token 做 timing-safe 比对，cookie 也可以是密码登录签发的会话；未配置/缺失/不匹配 → 401
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
    if (await isSharedSessionRead(request, options)) return;
    const bearer = extractBearerToken(request.headers.authorization);
    const cookie = extractCookie(request.headers.cookie);
    if (!bearer && cookie && !isSameOriginRequest(request.headers, request.protocol)) {
      return reply.code(403).send({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Request origin does not match Dutydeck' } });
    }
    if (!await isValidAccessCredential(bearer ?? cookie, options.getToken, options.getPasswordHash)) {
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
  const throttle = options.loginThrottle ?? new LoginThrottle();
  // 设了访问密码，登录页就要密码；password 只在设了时出现，不透露别的。
  const passwordFlag = (passwordHash: string | null) => passwordHash ? { password: true } : {};

  app.get('/api/auth/status', async (request, reply): Promise<BrowserAuthState> => {
    reply.header('Cache-Control', 'no-store');
    const required = browserAuthRequired(request, options);
    if (!required) return { authenticated: true, required: false };
    const passwordHash = await options.getPasswordHash?.() ?? null;
    const authenticated = await isValidAccessCredential(requestToken(request), options.getToken, async () => passwordHash);
    return { authenticated, required: true, ...passwordFlag(passwordHash) };
  });

  // 密码或 access token 都能登录。同一来源连续失败会被锁定一段时间，锁定期内不再校验。
  app.post<{ Body: { token?: unknown; password?: unknown } }>('/api/auth/login', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!browserAuthRequired(request, options)) return { authenticated: true, required: false } satisfies BrowserAuthState;
    const retryAfter = throttle.retryAfter(request.ip);
    if (retryAfter > 0) {
      const seconds = Math.ceil(retryAfter / 1000);
      return reply.code(429).header('Retry-After', String(seconds))
        .send({ error: { code: 'LOGIN_RATE_LIMITED', message: `登录失败次数过多，请 ${seconds} 秒后再试` } });
    }
    const passwordHash = await options.getPasswordHash?.() ?? null;
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    const presented = typeof request.body?.token === 'string' ? request.body.token.trim() : '';
    let session: string | undefined;
    if (password && passwordHash && await verifyPassword(password, passwordHash)) session = issueBrowserSession(passwordHash);
    else if (presented) {
      const expected = await options.getToken();
      if (expected && tokensEqual(presented, expected)) session = presented;
    }
    if (!session) {
      throttle.fail(request.ip);
      return reply.code(401).send(UNAUTHORIZED_PAYLOAD);
    }
    throttle.succeed(request.ip);
    reply.header('Set-Cookie', cookieAttributes(request).replace('__VALUE__', session));
    return { authenticated: true, required: true, ...passwordFlag(passwordHash) } satisfies BrowserAuthState;
  });

  // 过期、已用、伪造的码一律回同一页，不区分原因，也不回显码。
  const invalidLoginLinkPage = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录链接已失效</title></head><body><p>登录链接已失效：它可能已过期或已被使用。请回到飞书卡片重新点「查看详情」。</p></body></html>';
  // 打开链接只到这一页：飞书链接检测、企业代理、浏览器预取只会 GET/HEAD，码要等人点按钮 POST 时才兑换。
  // 码已按 base64url 格式校验过，原样放进表单是安全的；no-referrer 让提交时的 Referer 不带查询串。
  const confirmLoginLinkPage = (code: string) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>登录 Dutydeck Web</title></head><body><p>点击下方按钮登录 Dutydeck Web，并打开这个任务的会话页。</p><form method="post" action="/api/auth/link"><input type="hidden" name="code" value="${code}"><button type="submit">登录并打开任务详情</button></form><p>链接 10 分钟内有效、只能用一次。</p></body></html>`;
  const loginLinkCode = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
  const loginLinkRoute = {
    // GET 的查询串里是一次性登录码，请求日志只记路径。
    childLoggerFactory: (logger, bindings, opts) => logger.child(bindings, { ...opts, serializers: { ...opts.serializers,
      req: (request: FastifyRequest) => ({ method: request.method, url: '/api/auth/link', host: request.host, remoteAddress: request.ip }) } })
  } satisfies RouteShorthandOptions;
  // 确认页的按钮是普通表单提交。表单解析只注册在这个作用域里，其余接口仍不接受表单请求体。
  app.register(async scope => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 1024 },
      (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))));
    // HEAD 由 Fastify 按 GET 自动生成，同样只回确认页。
    scope.get<{ Querystring: { code?: unknown } }>('/api/auth/link', loginLinkRoute, async (request, reply) => {
      reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8');
      const code = loginLinkCode(request.query?.code);
      if (!code || !browserAuthRequired(request, options) || !options.loginLinks?.isValid(code)) return reply.code(400).send(invalidLoginLinkPage);
      return reply.send(confirmLoginLinkPage(code));
    });
    scope.post<{ Body: { code?: unknown } | undefined }>('/api/auth/link', loginLinkRoute, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const code = loginLinkCode(request.body?.code);
      const sessionId = code && browserAuthRequired(request, options) ? options.loginLinks?.redeem(code) : undefined;
      const token = sessionId ? await options.getToken() : null;
      if (!sessionId || !token) return reply.code(400).type('text/html; charset=utf-8').send(invalidLoginLinkPage);
      reply.header('Set-Cookie', cookieAttributes(request).replace('__VALUE__', token));
      return reply.redirect(`/sessions/${encodeURIComponent(sessionId)}`, 303);
    });
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
