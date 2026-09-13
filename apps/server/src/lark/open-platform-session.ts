import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const FEISHU_ACCOUNTS_ORIGIN = 'https://accounts.feishu.cn';
const FEISHU_CONSOLE_ORIGIN = 'https://open.feishu.cn';
const FEISHU_LOGIN_REDIRECT = 'https://ask.feishu.cn/';
const FEISHU_APP_ID = '12';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const FEISHU_CONSOLE_ORIGINS = new Set(['https://open.feishu.cn', 'https://open.larkoffice.com']);
const DEFAULT_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const FEISHU_COMMON_HEADERS = {
  'x-api-version': '1.0.28',
  'x-device-info':
    'device_id=0;device_name=Chrome;device_os=Mac;device_model=Chrome;lark_version=;channel=Release;package_name=feishu;tt_app_id=1658;is_dpop_support=true;is_iframe=false',
  'x-locale': 'zh-CN',
  'x-terminal-type': '2',
};

export interface StoredOpenPlatformCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  hostOnly: boolean;
  expiresAt?: number;
  sameSite?: string;
}

/** Internal owner proof. IDs never leave this session boundary through job state. */
export interface OpenPlatformOwnerIdentity {
  userId: string;
  userName: string;
  tenantId: string;
  tenantName: string;
}

export interface OpenPlatformSessionClient {
  readonly apiOrigin: string;
  postJson(path: string, body?: unknown): Promise<unknown>;
  postForm(path: string, body: FormData): Promise<unknown>;
}

/** A rejected request is distinct from a lost response to an external write. */
export class OpenPlatformRequestError extends Error {
  constructor(message: string, readonly statusCode: number, readonly apiCode?: number) {
    super(message);
  }
}

export type OpenPlatformQrStatus = 'waiting_for_scan' | 'scan_confirmed';

export interface OpenPlatformQrUpdate {
  qrPayload: string;
  status: OpenPlatformQrStatus;
}

export interface ConnectOpenPlatformSessionOptions {
  sessionFilePath?: string;
  forceLogin?: boolean;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  requestTimeoutMs?: number;
  onQrUpdate?: (update: OpenPlatformQrUpdate) => void | Promise<void>;
}

export interface ConnectedOpenPlatformSession {
  client: OpenPlatformSessionClient;
  owner: OpenPlatformOwnerIdentity;
  source: 'cache' | 'qr_login';
}

export function defaultOpenPlatformSessionFilePath(home = homedir()): string {
  return join(home, '.dutydeck', 'feishu-open-platform-session.json');
}

export function readOpenPlatformSessionCookies(filePath: string): StoredOpenPlatformCookie[] | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { cookies?: unknown };
    if (!Array.isArray(parsed?.cookies)) return null;
    return pruneExpiredCookies(parsed.cookies.filter(isStoredCookie));
  } catch {
    return null;
  }
}

/** Writes secrets only to a private, atomically replaced cache file. */
export function writeOpenPlatformSessionCookies(
  filePath: string,
  cookies: StoredOpenPlatformCookie[],
): void {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // chmod is best-effort on non-POSIX filesystems.
  }

  const temporary = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify({ cookies: pruneExpiredCookies(cookies) }), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporary, filePath);
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // chmod is best-effort on non-POSIX filesystems.
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // The rename normally removed the temporary path.
    }
  }
}

/**
 * Reuses a private cache first, then falls back to Feishu Web QR login. A
 * readable owner identity is mandatory: silently configuring under an unknown
 * account could publish the app into the wrong enterprise.
 */
export async function connectLarkOpenPlatformSession(
  options: ConnectOpenPlatformSessionOptions = {},
): Promise<ConnectedOpenPlatformSession> {
  const fetcher = options.fetchImpl ?? fetch;
  const sessionFile = options.sessionFilePath ?? defaultOpenPlatformSessionFilePath();
  const requestTimeoutMs = positiveTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);

  if (!options.forceLogin) {
    const cached = readOpenPlatformSessionCookies(sessionFile);
    if (cached && cached.length > 0) {
      const jar = new CookieJar(cached, requestTimeoutMs);
      try {
        const connected = await createClient(jar, fetcher);
        if (connected.owner) {
          // Refresh expiry/domain changes received while opening the console.
          writeOpenPlatformSessionCookies(sessionFile, jar.toJSON());
          return { ...connected, owner: connected.owner, source: 'cache' };
        }
      } catch {
        // Invalid/expired cache intentionally falls through to a fresh QR.
      }
    }
  }

  const jar = new CookieJar([], requestTimeoutMs);
  await loginWithQr(jar, fetcher, options);
  let connected: Awaited<ReturnType<typeof createClient>>;
  try {
    connected = await createClient(jar, fetcher);
  } catch (error) {
    throw new Error(`无法建立飞书开放平台会话：${safeOpenPlatformError(error)}`);
  }
  if (!connected.owner) {
    throw new Error('开放平台未返回当前登录账号和企业信息；为避免配置到错误企业，已停止操作');
  }
  writeOpenPlatformSessionCookies(sessionFile, jar.toJSON());
  return { ...connected, owner: connected.owner, source: 'qr_login' };
}

async function createClient(
  jar: CookieJar,
  fetcher: typeof fetch,
): Promise<{ client: OpenPlatformSessionClient; owner: OpenPlatformOwnerIdentity | null }> {
  const page = await jar.fetch(fetcher, `${FEISHU_CONSOLE_ORIGIN}/app`, { method: 'GET' }, {
    allowedOrigins: FEISHU_CONSOLE_ORIGINS,
  });
  if (!page.response.ok) throw new Error(`开放平台页面 HTTP ${page.response.status}`);
  const html = await page.response.text();
  const csrf = extractOpenPlatformCsrf(html);
  if (!csrf) throw new Error('开放平台页面未返回有效登录凭据，会话可能已经过期');

  const apiOrigin = new URL(page.finalUrl).origin;
  if (!FEISHU_CONSOLE_ORIGINS.has(apiOrigin)) {
    throw new Error('开放平台跳转到了不受信任的站点，已停止操作');
  }
  const referer = page.finalUrl;
  const owner = extractOpenPlatformOwnerIdentity(html);
  const post = async (path: string, body: unknown, multipart = false): Promise<unknown> => {
    if (!/^\/developers\/v1(?:\/|$)/.test(path) || /[?#]/.test(path) || path.split('/').some(part => part === '.' || part === '..')) {
      throw new Error('开放平台客户端仅允许访问 /developers/v1/*');
    }
    const hasBody = body !== undefined;
    const response = await jar.fetch(fetcher, `${apiOrigin}${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        origin: apiOrigin,
        referer,
        'x-csrf-token': csrf,
        ...(hasBody && !multipart ? { 'content-type': 'application/json' } : {}),
      },
      body: multipart ? body as FormData : hasBody ? JSON.stringify(body) : undefined,
    }, {
      allowCrossOriginRedirects: false,
      allowedOrigins: new Set([apiOrigin]),
    });
    const payload = await readJson(response.response);
    if (!response.response.ok) {
      throw new OpenPlatformRequestError(safeOpenPlatformError(
        `开放平台请求失败（HTTP ${response.response.status}，${path}）：${payloadMessage(payload)}`,
      ), response.response.status);
    }
    const code = numericCode(payload);
    if (code !== undefined && code !== 0) {
      throw new OpenPlatformRequestError(safeOpenPlatformError(
        `开放平台请求失败（code=${code}，${path}）：${payloadMessage(payload)}`,
      ), response.response.status, code);
    }
    return payload;
  };
  const client: OpenPlatformSessionClient = {
    apiOrigin,
    postJson: (path, body) => post(path, body),
    postForm: (path, body) => post(path, body, true),
  };
  return { client, owner };
}

async function loginWithQr(
  jar: CookieJar,
  fetcher: typeof fetch,
  options: ConnectOpenPlatformSessionOptions,
): Promise<void> {
  const nonce = `_r${10_000 + Math.floor(Math.random() * 80_000)}=${Date.now()}`;
  const initialized = await jar.fetch(fetcher, `${FEISHU_ACCOUNTS_ORIGIN}/accounts/qrlogin/init?${nonce}`, {
    method: 'POST',
    headers: {
      ...FEISHU_COMMON_HEADERS,
      'x-app-id': FEISHU_APP_ID,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ biz_type: null, redirect_uri: FEISHU_LOGIN_REDIRECT }),
  });
  const initPayload = await readJson(initialized.response);
  assertLoginPayload(initPayload, '初始化扫码登录失败');
  const token = pickString(asRecord(asRecord(asRecord(initPayload).data).step_info), ['token']);
  const flowKey = initialized.response.headers.get('x-flow-key');
  if (!token || !flowKey) throw new Error('初始化扫码登录失败：响应不完整');

  const qrPayload = JSON.stringify({ qrlogin: { token } });
  await options.onQrUpdate?.({ qrPayload, status: 'waiting_for_scan' });
  const startedAt = Date.now();
  const maxWaitMs = options.maxWaitMs ?? 120_000;
  const requestTimeoutMs = positiveTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const pollIntervalMs = options.pollIntervalMs ?? 1_500;
  let scanConfirmed = false;
  for (;;) {
    const remainingMs = maxWaitMs - (Date.now() - startedAt);
    if (remainingMs <= 0) throw new Error('等待飞书扫码超时');
    const pollNonce = `_r${10_000 + Math.floor(Math.random() * 80_000)}=${Date.now()}`;
    const polled = await jar.fetch(fetcher, `${FEISHU_ACCOUNTS_ORIGIN}/accounts/qrlogin/polling?${pollNonce}`, {
      method: 'POST',
      headers: {
        ...FEISHU_COMMON_HEADERS,
        'x-app-id': FEISHU_APP_ID,
        'x-flow-key': flowKey,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ biz_type: null }),
    }, {
      requestTimeoutMs: Math.min(requestTimeoutMs, remainingMs),
    });
    const pollPayload = await readJson(polled.response);
    assertLoginPayload(pollPayload, '轮询扫码登录失败');
    const data = asRecord(asRecord(pollPayload).data);
    const step = asRecord(data.step_info);
    const status = typeof step.status === 'number' ? step.status : undefined;
    if (status === 2 && !scanConfirmed) {
      scanConfirmed = true;
      await options.onQrUpdate?.({ qrPayload, status: 'scan_confirmed' });
    }
    if (status === 5) throw new Error('飞书登录二维码已过期');
    if (pickString(data, ['next_step']) === 'enter_app') {
      const crossLoginUri = pickString(step, ['cross_login_uri']);
      if (crossLoginUri) {
        if (!isTrustedFeishuAuthUrl(crossLoginUri)) throw new Error('飞书登录返回了不受信任的跳转地址');
        await jar.fetch(fetcher, crossLoginUri, { method: 'GET' });
      }
      return;
    }
    const remainingAfterPollMs = maxWaitMs - (Date.now() - startedAt);
    if (remainingAfterPollMs <= 0) throw new Error('等待飞书扫码超时');
    if (pollIntervalMs > 0) await delay(Math.min(pollIntervalMs, remainingAfterPollMs));
  }
}

interface CookieFetchOptions {
  maxRedirects?: number;
  requestTimeoutMs?: number;
  allowCrossOriginRedirects?: boolean;
  allowedOrigins?: ReadonlySet<string>;
}

class CookieJar {
  private cookies: StoredOpenPlatformCookie[];

  constructor(cookies: StoredOpenPlatformCookie[], private readonly requestTimeoutMs: number) {
    this.cookies = pruneExpiredCookies(cookies);
  }

  toJSON(): StoredOpenPlatformCookie[] {
    this.cookies = pruneExpiredCookies(this.cookies);
    return this.cookies.map(cookie => ({ ...cookie }));
  }

  async fetch(
    fetcher: typeof fetch,
    url: string,
    initial: RequestInit,
    options: CookieFetchOptions = {},
  ): Promise<{ response: Response; finalUrl: string }> {
    const maxRedirects = options.maxRedirects ?? 10;
    const requestTimeoutMs = positiveTimeout(options.requestTimeoutMs, this.requestTimeoutMs);
    let currentUrl = url;
    let init = initial;
    let redirectReferer: string | undefined;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (options.allowedOrigins && !options.allowedOrigins.has(new URL(currentUrl).origin)) {
        throw new Error('开放平台跳转到了不受信任的站点，已停止操作');
      }
      const headers = new Headers(init.headers);
      const cookie = cookieHeader(this.cookies, currentUrl);
      if (cookie) headers.set('cookie', cookie);
      if (!headers.has('user-agent')) headers.set('user-agent', DEFAULT_BROWSER_USER_AGENT);
      if (redirectReferer && !headers.has('referer')) headers.set('referer', redirectReferer);
      const response = await fetchWithTimeout(fetcher, currentUrl, { ...init, headers, redirect: 'manual' }, requestTimeoutMs);
      this.load(currentUrl, response.headers);
      if (response.status < 300 || response.status >= 400) return { response, finalUrl: currentUrl };
      const location = response.headers.get('location');
      if (!location) return { response, finalUrl: currentUrl };
      const previous = currentUrl;
      const nextUrl = new URL(location, currentUrl).toString();
      const crossOrigin = new URL(previous).origin !== new URL(nextUrl).origin;
      if (crossOrigin && options.allowCrossOriginRedirects === false) {
        throw new Error('开放平台写请求发生跨站跳转，已停止操作');
      }
      if (options.allowedOrigins && !options.allowedOrigins.has(new URL(nextUrl).origin)) {
        throw new Error('开放平台跳转到了不受信任的站点，已停止操作');
      }
      currentUrl = nextUrl;
      redirectReferer = crossOrigin ? undefined : previous;
      if (crossOrigin) {
        const nextHeaders = new Headers(init.headers);
        for (const name of ['authorization', 'cookie', 'origin', 'referer', 'x-csrf-token', 'x-flow-key']) nextHeaders.delete(name);
        init = { ...init, headers: nextHeaders };
      }
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && init.method?.toUpperCase() === 'POST')) {
        const nextHeaders = new Headers(init.headers);
        nextHeaders.delete('content-type');
        nextHeaders.delete('content-length');
        init = { ...init, method: 'GET', body: undefined, headers: nextHeaders };
      }
    }
    throw new Error('开放平台重定向次数过多');
  }

  private load(responseUrl: string, headers: Headers): void {
    const rawCookies = typeof (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : splitSetCookie(headers.get('set-cookie'));
    for (const raw of rawCookies) {
      const parsed = parseSetCookie(responseUrl, raw);
      if (!parsed) continue;
      const index = this.cookies.findIndex(cookie =>
        cookie.name === parsed.name && cookie.domain === parsed.domain && cookie.path === parsed.path);
      if (parsed.expiresAt !== undefined && parsed.expiresAt <= Date.now()) {
        if (index >= 0) this.cookies.splice(index, 1);
      } else if (index >= 0) {
        this.cookies[index] = parsed;
      } else {
        this.cookies.push(parsed);
      }
    }
    this.cookies = pruneExpiredCookies(this.cookies);
  }
}

export function extractOpenPlatformCsrf(html: string): string | null {
  return (html.match(/\bwindow\.csrfToken\s*=\s*(['"])([^'"]+)\1/) ??
    html.match(/\bcsrfToken\s*:\s*(['"])([^'"]+)\1/))?.[2] ?? null;
}

export function extractOpenPlatformOwnerIdentity(html: string): OpenPlatformOwnerIdentity | null {
  const match = /\bwindow\.user\s*=\s*/g.exec(html);
  if (!match) return null;
  const json = balancedJson(html, match.index + match[0].length);
  if (!json) return null;
  try {
    const user = asRecord(JSON.parse(json));
    const userId = pickString(user, ['id', 'userId', 'user_id']);
    const userName = pickString(user, ['name', 'userName', 'user_name']) ??
      pickString(asRecord(user.displayName), ['value']);
    const tenantId = pickString(user, ['tenantId', 'tenant_id']);
    const tenantName = pickString(asRecord(user.tenantDisplayName), ['value']) ??
      pickString(user, ['tenantName', 'tenant_name']);
    if (!userId || !userName || !tenantId || !tenantName) return null;
    return { userId, userName, tenantId, tenantName };
  } catch {
    return null;
  }
}

/** Redacts likely credentials even when Feishu echoes them in an error body. */
export function safeOpenPlatformError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(["']?(?:cookie|set-cookie|csrf(?:[_-]?token)?|app[_ -]?secret|secret|token|authorization)["']?\s*:\s*)["'][^"']*["']/gi, '$1"***"')
    .replace(/\b(cookie|set-cookie|csrf(?:[_-]?token)?|app[_ -]?secret|secret|token|authorization)\b\s*[:=]\s*[^\s,;)}\]]+/gi, '$1=***')
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_=-]{24,}\b/g, '***')
    .slice(0, 500);
}

function isStoredCookie(value: unknown): value is StoredOpenPlatformCookie {
  const item = value as Partial<StoredOpenPlatformCookie> | null;
  return Boolean(item && typeof item === 'object' &&
    typeof item.name === 'string' && typeof item.value === 'string' &&
    typeof item.domain === 'string' && typeof item.path === 'string' &&
    typeof item.secure === 'boolean' && typeof item.httpOnly === 'boolean' &&
    typeof item.hostOnly === 'boolean');
}

function pruneExpiredCookies(cookies: StoredOpenPlatformCookie[]): StoredOpenPlatformCookie[] {
  const now = Date.now();
  return cookies.filter(cookie => cookie.expiresAt === undefined || cookie.expiresAt > now);
}

function cookieHeader(cookies: StoredOpenPlatformCookie[], requestUrl: string): string {
  const url = new URL(requestUrl);
  return pruneExpiredCookies(cookies)
    .filter(cookie => {
      if (cookie.secure && url.protocol !== 'https:') return false;
      const host = url.hostname.toLowerCase();
      const domain = cookie.domain.replace(/^\./, '').toLowerCase();
      if (cookie.hostOnly ? host !== domain : host !== domain && !host.endsWith(`.${domain}`)) return false;
      if (url.pathname === cookie.path) return true;
      return url.pathname.startsWith(cookie.path) && (cookie.path.endsWith('/') || url.pathname[cookie.path.length] === '/');
    })
    .sort((left, right) => right.path.length - left.path.length)
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function splitSetCookie(value: string | null): string[] {
  if (!value) return [];
  const result: string[] = [];
  let start = 0;
  let inExpires = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value.slice(Math.max(0, index - 7), index + 1).toLowerCase().endsWith('expires=')) inExpires = true;
    if (inExpires && value[index] === ';') inExpires = false;
    if (!inExpires && value[index] === ',') {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(value.slice(start).trim());
  return result.filter(Boolean);
}

function parseSetCookie(responseUrl: string, raw: string): StoredOpenPlatformCookie | null {
  const url = new URL(responseUrl);
  const parts = raw.split(';').map(part => part.trim()).filter(Boolean);
  const first = parts.shift();
  const separator = first?.indexOf('=') ?? -1;
  if (!first || separator <= 0) return null;
  const cookie: StoredOpenPlatformCookie = {
    name: first.slice(0, separator),
    value: first.slice(separator + 1),
    domain: url.hostname,
    path: '/',
    secure: false,
    httpOnly: false,
    hostOnly: true,
  };
  for (const part of parts) {
    const equal = part.indexOf('=');
    const key = (equal >= 0 ? part.slice(0, equal) : part).toLowerCase();
    const value = equal >= 0 ? part.slice(equal + 1) : '';
    if (key === 'domain' && value) {
      const domain = value.replace(/^\./, '').toLowerCase();
      const responseHost = url.hostname.toLowerCase();
      if (responseHost !== domain && !responseHost.endsWith(`.${domain}`)) return null;
      cookie.domain = value.toLowerCase();
      cookie.hostOnly = false;
    } else if (key === 'path' && value) cookie.path = value;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'samesite' && value) cookie.sameSite = value;
    else if (key === 'expires' && value) {
      const expiry = Date.parse(value);
      if (Number.isFinite(expiry)) cookie.expiresAt = expiry;
    } else if (key === 'max-age' && value) {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) cookie.expiresAt = Date.now() + seconds * 1_000;
    }
  }
  return cookie;
}

function balancedJson(input: string, start: number): string | null {
  if (input[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return input.slice(start, index + 1);
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function numericCode(payload: unknown): number | undefined {
  const code = asRecord(payload).code;
  if (typeof code === 'number') return code;
  if (typeof code === 'string' && /^-?\d+$/.test(code)) return Number(code);
  return undefined;
}

function payloadMessage(payload: unknown): string {
  const record = asRecord(payload);
  return safeOpenPlatformError(pickString(record, ['msg', 'message', 'error_msg', 'error']) ?? '未返回错误说明');
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function assertLoginPayload(payload: unknown, prefix: string): void {
  if (numericCode(payload) === 0) return;
  throw new Error(`${prefix}：${payloadMessage(payload)}`);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isTrustedFeishuAuthUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['feishu.cn', 'larkoffice.com'].some(domain =>
      url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

async function fetchWithTimeout(
  fetcher: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const upstream = init.signal;
  const relayAbort = () => controller.abort(upstream?.reason);
  if (upstream?.aborted) relayAbort();
  else upstream?.addEventListener('abort', relayAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('开放平台请求超时')), timeoutMs);
  timer.unref?.();
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && !upstream?.aborted) throw new Error('开放平台请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
    upstream?.removeEventListener('abort', relayAbort);
  }
}
