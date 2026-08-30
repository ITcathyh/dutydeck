import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { ConfigRepository } from '@dockmux/shared';
import {
  AUTH_TOKEN_CONFIG_KEY,
  extractBearerToken,
  generateAuthToken,
  getAuthToken,
  isLoopbackAddress,
  loadOrCreateAuthToken,
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

describe('isLoopbackAddress', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('%s 是 loopback', address => {
    expect(isLoopbackAddress(address)).toBe(true);
  });

  it.each(['192.168.1.1', '8.8.8.8', '10.0.0.1', '0.0.0.0', '::ffff:8.8.8.8'])('%s 不是 loopback', address => {
    expect(isLoopbackAddress(address)).toBe(false);
  });

  it('undefined 不是 loopback', () => {
    expect(isLoopbackAddress(undefined)).toBe(false);
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

describe('registerAuthMiddleware', () => {
  const TOKEN = 'test-token-abcdefghijklmnopqrstuvwxyz123456';

  /** 真 fastify + 测试路由；inject 默认 remoteAddress=127.0.0.1（loopback） */
  function buildApp(options: AuthMiddlewareOptions) {
    const app = Fastify();
    registerAuthMiddleware(app, options);
    app.get('/api/protected', async () => ({ ok: true }));
    app.post('/api/protected', async () => ({ ok: true }));
    app.get('/api/lark/agent-tools/self', async () => ({ ok: 'agent-tools' }));
    return app;
  }

  it('localOnly=true 全部放行（非 loopback、无 token 也放行）', async () => {
    const app = buildApp({ getToken: async () => null, localOnly: true });
    const response = await app.inject({ method: 'GET', url: '/api/protected', remoteAddress: '8.8.8.8' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await app.close();
  });

  it('loopback ip 放行（inject 默认 127.0.0.1）', async () => {
    const app = buildApp({ getToken: async () => TOKEN, localOnly: false });
    const response = await app.inject({ method: 'GET', url: '/api/protected' });
    expect(response.statusCode).toBe(200);
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

  it('非 loopback 正确 ?token= 放行（SSE EventSource / WS 升级场景）', async () => {
    const app = buildApp({ getToken: async () => TOKEN, localOnly: false });
    const response = await app.inject({
      method: 'GET',
      url: `/api/protected?token=${encodeURIComponent(TOKEN)}`,
      remoteAddress: '203.0.113.7'
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('Authorization 头优先于 ?token=', async () => {
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

  it('loopback / exempt 请求不触发 getToken（豁免判定不查库）', async () => {
    const getToken = vi.fn(async () => TOKEN);
    const app = Fastify();
    registerAuthMiddleware(app, {
      getToken,
      localOnly: false,
      exempt: (_method, pathname) => pathname.startsWith('/api/lark/agent-tools/')
    });
    app.get('/api/protected', async () => ({ ok: true }));
    app.get('/api/lark/agent-tools/self', async () => ({ ok: true }));
    await app.inject({ method: 'GET', url: '/api/protected' });
    await app.inject({ method: 'GET', url: '/api/lark/agent-tools/self', remoteAddress: '8.8.8.8' });
    expect(getToken).not.toHaveBeenCalled();
    await app.close();
  });
});
