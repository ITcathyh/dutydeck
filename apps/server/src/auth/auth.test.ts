import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import type { ConfigRepository } from '@dutydeck/shared';
import {
  AUTH_TOKEN_CONFIG_KEY,
  AUTH_COOKIE_NAME,
  extractCookie,
  extractBearerToken,
  generateAuthToken,
  getAuthToken,
  isSameOriginRequest,
  loadOrCreateAuthToken,
  LOGIN_LINK_TTL_MS,
  LoginLinkStore,
  registerBrowserAuthRoutes,
  registerAuthMiddleware,
  rotateAuthToken,
  runAuthTokenCommand,
  tokensEqual,
  type AuthMiddlewareOptions
} from './auth.js';

/** 内存假 ConfigRepository：只实现 get/set 两个方法 */
function memoryConfigs(initial: Record<string, string> = {}): ConfigRepository {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    async get(key) { return store.get(key); },
    async set(key, value) { store.set(key, value); }
  };
}

describe('generateAuthToken', () => {
  it('生成 43 字符 base64url（无填充）', () => {
    for (let i = 0; i < 10; i++) {
      const token = generateAuthToken();
      expect(token).toHaveLength(43);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('两次生成结果不同', () => {
    expect(generateAuthToken()).not.toBe(generateAuthToken());
  });
});

describe('configs 存取', () => {
  it('getAuthToken 不存在返回 null', async () => {
    expect(await getAuthToken(memoryConfigs())).toBeNull();
  });

  it('getAuthToken 空串/纯空白视为未配置', async () => {
    expect(await getAuthToken(memoryConfigs({ [AUTH_TOKEN_CONFIG_KEY]: '   ' }))).toBeNull();
  });

  it('loadOrCreate 首次 created=true、二次 created=false 且复用同一 token', async () => {
    const configs = memoryConfigs();
    const first = await loadOrCreateAuthToken(configs);
    expect(first.created).toBe(true);
    expect(first.token).toHaveLength(43);
    const second = await loadOrCreateAuthToken(configs);
    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
    expect(await getAuthToken(configs)).toBe(first.token);
  });

  it('并发 loadOrCreate 只创建一个 token，所有调用方拿到同一串', async () => {
    // 竞态窗口在「读到值」与「写回」之间：get 必须先取快照再让出，
    // 否则 8 次读会被自然串行化（后来的读到先前的写），竞态根本不发生。
    const store = new Map<string, string>();
    let setCalls = 0;
    const configs: ConfigRepository = {
      async get(key) {
        const value = store.get(key);
        await new Promise(r => setTimeout(r, 5));
        return value;
      },
      async set(key, value) { setCalls++; store.set(key, value); }
    };

    const results = await Promise.all(Array.from({ length: 8 }, () => loadOrCreateAuthToken(configs)));
    const tokens = new Set(results.map(r => r.token));
    expect(tokens.size).toBe(1);
    expect(setCalls).toBe(1);
    // created 只对真正建号的那一次为 true（日志不重复）
    expect(results.filter(r => r.created)).toHaveLength(1);
    // 落盘的就是大家手里那一串
    expect(await getAuthToken(configs)).toBe(results[0]!.token);
  });

  it('rotate 后 token 变化且旧 token 失效', async () => {
    const configs = memoryConfigs();
    const old = (await loadOrCreateAuthToken(configs)).token;
    const next = await rotateAuthToken(configs);
    expect(next).not.toBe(old);
    expect(await getAuthToken(configs)).toBe(next);
    expect(tokensEqual(old, next)).toBe(false);
  });

  it('runAuthTokenCommand 无 rotate 走 loadOrCreate', async () => {
    const configs = memoryConfigs();
    const first = await runAuthTokenCommand(configs, {});
    expect(first).toEqual({ token: expect.any(String), created: true, rotated: false });
    const second = await runAuthTokenCommand(configs, {});
    expect(second).toEqual({ token: first.token, created: false, rotated: false });
  });

  it('runAuthTokenCommand rotate=true 无条件轮换', async () => {
    const configs = memoryConfigs();
    const before = await runAuthTokenCommand(configs, {});
    const rotated = await runAuthTokenCommand(configs, { rotate: true });
    expect(rotated).toEqual({ token: expect.any(String), created: false, rotated: true });
    expect(rotated.token).not.toBe(before.token);
    expect(await getAuthToken(configs)).toBe(rotated.token);
  });
});

describe('tokensEqual', () => {
  it('相同 token 相等', () => {
    const token = generateAuthToken();
    expect(tokensEqual(token, token)).toBe(true);
    expect(tokensEqual('abc', 'abc')).toBe(true);
  });

  it('不同 token 不等', () => {
    expect(tokensEqual('abc', 'abd')).toBe(false);
  });

  it('长度不同不等', () => {
    expect(tokensEqual('abc', 'abcd')).toBe(false);
    expect(tokensEqual('', 'abc')).toBe(false);
  });
});

describe('isSameOriginRequest', () => {
  it('accepts exact direct and reverse-proxy origins', () => {
    expect(isSameOriginRequest({ origin: 'http://dutydeck.test:4310', host: 'dutydeck.test:4310' })).toBe(true);
    expect(isSameOriginRequest({ origin: 'https://dutydeck.example.com', host: '127.0.0.1:4310', 'x-forwarded-host': 'dutydeck.example.com', 'x-forwarded-proto': 'https' })).toBe(true);
  });

  it('rejects cross-origin, null and malformed browser origins', () => {
    expect(isSameOriginRequest({ origin: 'https://evil.example', host: 'dutydeck.test:4310' })).toBe(false);
    expect(isSameOriginRequest({ origin: 'null', host: 'dutydeck.test:4310' })).toBe(false);
    expect(isSameOriginRequest({ origin: 'not a url', host: 'dutydeck.test:4310' })).toBe(false);
  });
});

describe('extractBearerToken', () => {
  it('正常 Bearer', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
  });

  it('scheme 大小写不敏感、容忍多余空白', () => {
    expect(extractBearerToken('bearer  abc123  ')).toBe('abc123');
  });

  it('无 Bearer 前缀返回 undefined', () => {
    expect(extractBearerToken('abc123')).toBeUndefined();
    expect(extractBearerToken('Basic abc123')).toBeUndefined();
  });

  it('空/undefined/只有 scheme 返回 undefined', () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken('')).toBeUndefined();
    expect(extractBearerToken('Bearer')).toBeUndefined();
  });
});

describe('extractCookie', () => {
  it('matches the exact cookie name and preserves a base64url token', () => {
    expect(extractCookie(`theme=dark; ${AUTH_COOKIE_NAME}=abc_123-XYZ; other=value`)).toBe('abc_123-XYZ');
    expect(extractCookie(`${AUTH_COOKIE_NAME}_old=wrong`)).toBeUndefined();
  });
});

describe('registerAuthMiddleware', () => {
  const TOKEN = 'test-token-abcdefghijklmnopqrstuvwxyz123456';

  /** 真 fastify + 测试路由。remote 模式不再按回源 IP 绕过认证。 */
  function buildApp(options: AuthMiddlewareOptions) {
    const app = Fastify();
    registerAuthMiddleware(app, options);
    app.get('/api/protected', async () => ({ ok: true }));
    app.post('/api/protected', async () => ({ ok: true }));
    app.get('/api/lark/agent-tools/self', async () => ({ ok: 'agent-tools' }));
    return app;
  }

  it('localOnly=true 无需 token，但只接受 loopback Host', async () => {
    const app = buildApp({ getToken: async () => null, localOnly: true });
    const response = await app.inject({ method: 'GET', url: '/api/protected', remoteAddress: '8.8.8.8' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    const rebound = await app.inject({ method: 'GET', url: '/api/protected', headers: { host: 'attacker.example:4310' } });
    expect(rebound.statusCode).toBe(403);
    expect(rebound.json().error.code).toBe('HOST_NOT_ALLOWED');
    const crossOrigin = await app.inject({ method: 'GET', url: '/api/protected', headers: { host: '127.0.0.1:4310', origin: 'https://attacker.example' } });
    expect(crossOrigin.statusCode).toBe(403);
    expect(crossOrigin.json().error.code).toBe('ORIGIN_NOT_ALLOWED');
    await app.close();
  });

  it('remote 模式即使回源来自 loopback 也必须认证', async () => {
    const app = buildApp({ getToken: async () => TOKEN, localOnly: false });
    const response = await app.inject({ method: 'GET', url: '/api/protected' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('explicit open mode skips tokens but keeps exact browser Origin checks', async () => {
    const getToken = vi.fn(async () => TOKEN);
    const app = buildApp({ getToken, localOnly: false, mode: 'open' });
    const open = await app.inject({ method: 'GET', url: '/api/protected', headers: { host: 'devbox.example:4310', origin: 'http://devbox.example:4310' } });
    expect(open.statusCode).toBe(200);
    const cli = await app.inject({ method: 'POST', url: '/api/protected', headers: { host: 'devbox.example:4310' } });
    expect(cli.statusCode).toBe(200);
    const crossOrigin = await app.inject({ method: 'POST', url: '/api/protected', headers: { host: 'devbox.example:4310', origin: 'https://evil.example' } });
    expect(crossOrigin.statusCode).toBe(403);
    expect(crossOrigin.json().error.code).toBe('ORIGIN_NOT_ALLOWED');
    expect(getToken).not.toHaveBeenCalled();
    await app.close();
  });

  it('非 loopback 无 token → 401', async () => {
    const app = buildApp({ getToken: async () => TOKEN, localOnly: false });
    const response = await app.inject({ method: 'GET', url: '/api/protected', remoteAddress: '8.8.8.8' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    await app.close();
  });

  it('非 loopback 错误 token → 401', async () => {
    const app = buildApp({ getToken: async () => TOKEN, localOnly: false });
    const response = await app.inject({
      method: 'GET',
      url: '/api/protected',
      remoteAddress: '8.8.8.8',
      headers: { authorization: 'Bearer wrong-token' }
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('非 loopback 正确 Bearer 放行', async () => {
    const app = buildApp({ getToken: async () => TOKEN, localOnly: false });
    const response = await app.inject({
      method: 'GET',
      url: '/api/protected',
      remoteAddress: '203.0.113.7',
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('非 loopback 正确 HttpOnly cookie 放行', async () => {
    const app = buildApp({ getToken: async () => TOKEN, localOnly: false });
    const response = await app.inject({
      method: 'GET',
      url: '/api/protected',
      remoteAddress: '203.0.113.7',
      headers: { cookie: `${AUTH_COOKIE_NAME}=${TOKEN}` }
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('URL query token 不再作为凭据，避免泄露到访问日志', async () => {
    const app = buildApp({ getToken: async () => TOKEN, localOnly: false });
    const response = await app.inject({
      method: 'GET',
      url: `/api/protected?token=${encodeURIComponent(TOKEN)}`,
      remoteAddress: '203.0.113.7'
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('Authorization 头有效且无关 query 被忽略', async () => {
    const app = buildApp({ getToken: async () => TOKEN, localOnly: false });
    const response = await app.inject({
      method: 'GET',
      url: '/api/protected?token=wrong',
      remoteAddress: '8.8.8.8',
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('cookie 请求拒绝跨 Origin，允许完全同源或无 Origin API 客户端', async () => {
    const app = buildApp({ getToken: async () => TOKEN, localOnly: false });
    const crossOrigin = await app.inject({ method: 'POST', url: '/api/protected', remoteAddress: '203.0.113.7', headers: { host: 'dutydeck.test', origin: 'https://evil.example', cookie: `${AUTH_COOKIE_NAME}=${TOKEN}` } });
    expect(crossOrigin.statusCode).toBe(403);
    expect(crossOrigin.json().error.code).toBe('ORIGIN_NOT_ALLOWED');
    const sameOrigin = await app.inject({ method: 'POST', url: '/api/protected', remoteAddress: '203.0.113.7', headers: { host: 'dutydeck.test', origin: 'http://dutydeck.test', cookie: `${AUTH_COOKIE_NAME}=${TOKEN}` } });
    expect(sameOrigin.statusCode).toBe(200);
    const apiClient = await app.inject({ method: 'POST', url: '/api/protected', remoteAddress: '203.0.113.7', headers: { cookie: `${AUTH_COOKIE_NAME}=${TOKEN}` } });
    expect(apiClient.statusCode).toBe(200);
    await app.close();
  });

  it('exempt 路径放行（/api/lark/agent-tools/* 自有 Bearer），非豁免路径仍 401', async () => {
    const app = buildApp({
      getToken: async () => TOKEN,
      localOnly: false,
      exempt: (_method, pathname) => pathname.startsWith('/api/lark/agent-tools/')
    });
    const exempted = await app.inject({ method: 'GET', url: '/api/lark/agent-tools/self', remoteAddress: '8.8.8.8' });
    expect(exempted.statusCode).toBe(200);
    expect(exempted.json()).toEqual({ ok: 'agent-tools' });
    const blocked = await app.inject({ method: 'GET', url: '/api/protected', remoteAddress: '8.8.8.8' });
    expect(blocked.statusCode).toBe(401);
    await app.close();
  });

  it('token 未配置（getToken 返回 null）非豁免 → 401（fail closed）', async () => {
    const app = buildApp({ getToken: async () => null, localOnly: false });
    const response = await app.inject({
      method: 'GET',
      url: '/api/protected',
      remoteAddress: '8.8.8.8',
      headers: { authorization: 'Bearer anything' }
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('local-only / exempt 请求不触发 getToken（豁免判定不查库）', async () => {
    const getToken = vi.fn(async () => TOKEN);
    const app = Fastify();
    registerAuthMiddleware(app, {
      getToken,
      localOnly: false,
      exempt: (_method, pathname) => pathname.startsWith('/api/lark/agent-tools/')
    });
    app.get('/api/protected', async () => ({ ok: true }));
    app.get('/api/lark/agent-tools/self', async () => ({ ok: true }));
    await app.inject({ method: 'GET', url: '/api/lark/agent-tools/self', remoteAddress: '8.8.8.8' });
    expect(getToken).not.toHaveBeenCalled();
    await app.close();

    const localGetToken = vi.fn(async () => TOKEN);
    const local = buildApp({ getToken: localGetToken, localOnly: true });
    await local.inject({ method: 'GET', url: '/api/protected', remoteAddress: '8.8.8.8' });
    expect(localGetToken).not.toHaveBeenCalled();
    await local.close();
  });
});

describe('browser auth routes', () => {
  const TOKEN = 'test-token-abcdefghijklmnopqrstuvwxyz123456';

  function buildApp(localOnly = false) {
    const app = Fastify();
    const options: AuthMiddlewareOptions = { getToken: async () => TOKEN, localOnly };
    registerBrowserAuthRoutes(app, options);
    return app;
  }

  it('reports remote unauthenticated state without exposing the token', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/auth/status', remoteAddress: '203.0.113.7' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ authenticated: false, required: true });
    expect(response.body).not.toContain(TOKEN);
    await app.close();
  });

  it('logs in once and authenticates status through an HttpOnly cookie', async () => {
    const app = buildApp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '203.0.113.7',
      payload: { token: TOKEN }
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers['set-cookie'];
    expect(cookie).toContain(`${AUTH_COOKIE_NAME}=${TOKEN}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(login.body).not.toContain(TOKEN);

    const status = await app.inject({
      method: 'GET',
      url: '/api/auth/status',
      remoteAddress: '203.0.113.7',
      headers: { cookie }
    });
    expect(status.json()).toEqual({ authenticated: true, required: true });
    await app.close();
  });

  it('rejects a wrong token and logout clears the cookie', async () => {
    const app = buildApp();
    const rejected = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.7', payload: { token: 'wrong' } });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.headers['set-cookie']).toBeUndefined();
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', remoteAddress: '203.0.113.7' });
    expect(logout.headers['set-cookie']).toContain(`${AUTH_COOKIE_NAME}=`);
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');
    await app.close();
  });

  it('keeps local-only access frictionless', async () => {
    const app = buildApp(true);
    const status = await app.inject({ method: 'GET', url: '/api/auth/status', remoteAddress: '203.0.113.7' });
    expect(status.json()).toEqual({ authenticated: true, required: false });
    await app.close();
  });

  it('reports explicit open access as authenticated without requiring a token', async () => {
    const app = Fastify();
    registerBrowserAuthRoutes(app, { getToken: async () => { throw new Error('must not read token'); }, localOnly: false, mode: 'open' });
    expect((await app.inject({ method: 'GET', url: '/api/auth/status' })).json()).toEqual({ authenticated: true, required: false });
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} })).json()).toEqual({ authenticated: true, required: false });
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout' })).json()).toEqual({ authenticated: true, required: false });
    await app.close();
  });
});

describe('one-time login links', () => {
  const TOKEN = 'test-token-abcdefghijklmnopqrstuvwxyz123456';
  const remote = { remoteAddress: '203.0.113.7' } as const;

  function buildLinkApp(links: LoginLinkStore, options: { stream?: { write(line: string): void } } = {}) {
    const app = options.stream ? Fastify({ logger: { level: 'info', stream: options.stream } }) : Fastify();
    registerBrowserAuthRoutes(app, { mode: 'token', getToken: async () => TOKEN, localOnly: false, loginLinks: links });
    return app;
  }

  it('码有 256 位随机熵，服务端只按哈希保存', () => {
    const links = new LoginLinkStore();
    const code = links.issue('ses_1');
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(links.issue('ses_1')).not.toBe(code);
    const stored = JSON.stringify([...(links as any).links.entries()]);
    expect(stored).not.toContain(code);
    expect(stored).toContain(createHash('sha256').update(code).digest('hex'));
  });

  it('兑换后设置与 /api/auth/login 完全相同的 cookie，并跳转到绑定的会话页', async () => {
    const links = new LoginLinkStore();
    const app = buildLinkApp(links);
    const code = links.issue('ses_bound/1');
    const redeemed = await app.inject({ method: 'GET', url: `/api/auth/link?code=${code}`, ...remote });
    expect(redeemed.statusCode).toBe(302);
    expect(redeemed.headers.location).toBe('/sessions/ses_bound%2F1');
    expect(redeemed.headers['cache-control']).toBe('no-store');
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: TOKEN }, ...remote });
    expect(redeemed.headers['set-cookie']).toBe(login.headers['set-cookie']);
    const status = await app.inject({ method: 'GET', url: '/api/auth/status', headers: { cookie: redeemed.headers['set-cookie'] as string }, ...remote });
    expect(status.json()).toEqual({ authenticated: true, required: true });
    await app.close();
  });

  it('重复使用、过期、伪造和缺失的码都只返回同一个错误页，不发 cookie', async () => {
    let now = 1_000_000;
    const links = new LoginLinkStore(() => now);
    const app = buildLinkApp(links);
    const used = links.issue('ses_1');
    expect((await app.inject({ method: 'GET', url: `/api/auth/link?code=${used}`, ...remote })).statusCode).toBe(302);
    const expired = links.issue('ses_1');
    now += LOGIN_LINK_TTL_MS;
    const failures = await Promise.all([
      `/api/auth/link?code=${used}`,
      `/api/auth/link?code=${expired}`,
      `/api/auth/link?code=${'x'.repeat(43)}`,
      '/api/auth/link'
    ].map(url => app.inject({ method: 'GET', url, ...remote })));
    for (const failure of failures) {
      expect(failure.statusCode).toBe(400);
      expect(failure.headers['set-cookie']).toBeUndefined();
      expect(failure.headers['content-type']).toContain('text/html');
      expect(failure.body).toBe(failures[0]!.body);
      expect(failure.body).toContain('登录链接已失效');
      expect(failure.body).not.toContain('ses_1');
    }
    await app.close();
  });

  it('同一个码并发兑换只成功一次', async () => {
    const links = new LoginLinkStore();
    const app = buildLinkApp(links);
    const code = links.issue('ses_1');
    const responses = await Promise.all(Array.from({ length: 8 }, () => app.inject({ method: 'GET', url: `/api/auth/link?code=${code}`, ...remote })));
    expect(responses.filter(response => response.statusCode === 302)).toHaveLength(1);
    expect(responses.filter(response => response.headers['set-cookie'])).toHaveLength(1);
    await app.close();
  });

  it('本机免密或 --no-auth 时不兑换任何码', async () => {
    const links = new LoginLinkStore();
    for (const mode of ['local', 'open'] as const) {
      const app = Fastify();
      registerBrowserAuthRoutes(app, { mode, getToken: async () => TOKEN, localOnly: mode === 'local', loginLinks: links });
      const response = await app.inject({ method: 'GET', url: `/api/auth/link?code=${links.issue('ses_1')}` });
      expect(response.statusCode).toBe(400);
      expect(response.headers['set-cookie']).toBeUndefined();
      await app.close();
    }
  });

  it('请求日志只记兑换路径，不记登录码', async () => {
    const lines: string[] = [];
    const links = new LoginLinkStore();
    const app = buildLinkApp(links, { stream: { write: line => { lines.push(line); } } });
    const code = links.issue('ses_1');
    expect((await app.inject({ method: 'GET', url: `/api/auth/link?code=${code}`, ...remote })).statusCode).toBe(302);
    await app.inject({ method: 'GET', url: `/api/auth/link?code=${code}`, ...remote });
    const log = lines.join('');
    expect(log).toContain('"url":"/api/auth/link"');
    expect(log).toContain('incoming request');
    expect(log).not.toContain(code);
    expect(log).not.toContain('code=');
    await app.close();
  });
});
