import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { buildApp } from '../app.js';
import { isPluginTriggerRequest } from '../plugins/routes.js';
import { isRelayCapabilityRequest } from '../relay-routes.js';
import { registerAuthMiddleware, signSessionShareToken } from './auth.js';

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const servers: Server[] = [];
const tempDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

/** 任何 runtime 方法被调到都记下来：未认证的请求一次都不该走到业务层。 */
function recordingRuntime() {
  const calls: string[] = [];
  const runtime = new Proxy({}, {
    get: (_target, key) => key === 'then' ? undefined : async (...args: unknown[]) => {
      calls.push(String(key));
      return key === 'listSessions' || key === 'getEventWindow' || key === 'getTasks' ? [] : { id: String(args[0] ?? 'ses_1') };
    }
  });
  return { runtime: runtime as any, calls };
}

/** 被代理的对端实例：只记下收到过哪些请求。 */
async function recordingPeer() {
  const hits: string[] = [];
  const server = createServer((request, response) => { hits.push(`${request.method} ${request.url}`); response.end('[]'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

async function tokenApp(runtime: any, peer?: string) {
  const webRoot = await mkdtemp(join(tmpdir(), 'dutydeck-auth-path-')); tempDirectories.push(webRoot);
  await mkdir(join(webRoot, 'assets'));
  await writeFile(join(webRoot, 'index.html'), '<main>Dutydeck UI</main>');
  await writeFile(join(webRoot, 'assets', 'app.js'), 'globalThis.dutydeck = true;');
  const app = await buildApp(runtime, {
    webRoot,
    instances: peer ? [{ id: 'tag', name: 'Tag', url: peer }] : [],
    auth: { mode: 'token', getToken: async () => 'secret-token', localOnly: false, getShareSecret: async () => 'share-secret' }
  });
  apps.push(app);
  return app;
}

const remote = { remoteAddress: '8.8.8.8' } as const;

// 每个路径都按「路由解码后」的样子落在 /api/sessions 或 /api/sessions/ses_1/send 上。
const ENCODED_SESSION_LIST = ['/%61pi/sessions', '/a%70i/sessions', '/ap%69/sessions', '/%61%70%69/sessions', '/api/%73essions'];
// 落在实例代理路由 /api/instances/:id/* 上。
const ENCODED_PROXY = ['/a%70i/instances/tag/sessions', '/%61pi/instances/tag/sessions', '/api/%69nstances/tag/sessions', '/a%70i/instances/tag/sessions/ses_1/send'];
const ENCODED_SEND = ['/%61pi/sessions/ses_1/send', '/api/sessions/%73es_1/send', '/api/sessions/ses_1/%73end'];
// 不会命中 /api 路由的变体：允许落到静态壳或 404，但不能是 200 的 API 数据，也不能走到业务层。
const UNROUTED = ['/%41PI/sessions', '/API/sessions', '/api%2Fsessions', '/%61pi%2Fsessions', '//api/sessions', '/./api/sessions',
  '/x/../api/sessions', '/%2e/api/sessions', '/x/%2e%2e/api/sessions', '/api/sessions;x', '/api;/sessions', '/api/sessions/', '/api'];
// 原始路径看着像豁免前缀，路由实际走到别处：不能借豁免名单放行。
const EXEMPT_LOOKALIKES = ['/api/hooks/../sessions', '/api/lark/agent-tools/../../sessions', '/api/hooks/..%2F..%2Fsessions',
  '/api/relay/sessions/x%2F..%2F..%2F..%2Fsessions/send', '/api/auth/status/../../sessions'];

describe('认证豁免与路由用同一份路径', () => {
  it('百分号编码命中 /api 路由时 GET/POST 都要 401，业务层一次都不调用', async () => {
    const { runtime, calls } = recordingRuntime();
    const app = await tokenApp(runtime);
    for (const url of ENCODED_SESSION_LIST) {
      for (const method of ['GET', 'POST'] as const) {
        const response = await app.inject({ method, url, payload: method === 'POST' ? { agentId: 'claude' } : undefined, ...remote });
        expect(response.statusCode, `${method} ${url}`).toBe(401);
      }
    }
    for (const url of ENCODED_SEND) {
      expect((await app.inject({ method: 'POST', url, payload: { prompt: 'hi' }, ...remote })).statusCode, `POST ${url}`).toBe(401);
    }
    expect(calls).toEqual([]);
  });

  it('编码写法命中实例代理路由时也要 401，请求不转发到对端', async () => {
    const peer = await recordingPeer();
    const { runtime } = recordingRuntime();
    const app = await tokenApp(runtime, peer.url);
    for (const url of ENCODED_PROXY) {
      for (const method of ['GET', 'POST'] as const) {
        const response = await app.inject({ method, url, payload: method === 'POST' ? { prompt: 'hi' } : undefined, ...remote });
        expect(response.statusCode, `${method} ${url}`).toBe(401);
      }
    }
    expect(peer.hits).toEqual([]);
    // 对照：正常写法带 token 才会转发。
    expect((await app.inject({ method: 'GET', url: '/api/instances/tag/sessions', ...remote })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/instances/tag/sessions', headers: { authorization: 'Bearer secret-token' }, ...remote })).statusCode).toBe(200);
    expect(peer.hits).toEqual(['GET /api/sessions']);
  });

  it('其余写法要么 401，要么落到静态壳/404，都碰不到会话数据', async () => {
    const { runtime, calls } = recordingRuntime();
    const app = await tokenApp(runtime);
    for (const url of [...UNROUTED, ...EXEMPT_LOOKALIKES]) {
      for (const method of ['GET', 'POST'] as const) {
        const response = await app.inject({ method, url, payload: method === 'POST' ? { prompt: 'hi', agentId: 'claude' } : undefined, ...remote });
        const servedShell = response.statusCode === 200 && response.body === '<main>Dutydeck UI</main>';
        expect(response.statusCode === 401 || response.statusCode === 404 || response.statusCode === 400 || servedShell, `${method} ${url} → ${response.statusCode} ${response.body.slice(0, 80)}`).toBe(true);
      }
    }
    expect(calls).toEqual([]);
  });

  it('带 token 照常访问；静态页、健康检查和分享页的公开范围不变', async () => {
    const { runtime, calls } = recordingRuntime();
    const app = await tokenApp(runtime);
    const authorization = { authorization: 'Bearer secret-token' };
    expect((await app.inject({ method: 'GET', url: '/api/sessions', headers: authorization, ...remote })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/%61pi/sessions', headers: authorization, ...remote })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/sessions', ...remote })).statusCode).toBe(401);
    for (const url of ['/', '/sessions/ses_1', '/share/ses_1', '/assets/app.js', '/health']) {
      expect((await app.inject({ method: 'GET', url, ...remote })).statusCode, url).toBe(200);
    }
    expect((await app.inject({ method: 'GET', url: '/api/auth/status', ...remote })).json()).toEqual({ authenticated: false, required: true });
    const share = signSessionShareToken('share-secret', 'ses_1');
    calls.length = 0;
    expect((await app.inject({ method: 'GET', url: `/api/sessions/ses_1?share=${share}`, ...remote })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/%61pi/sessions/ses_1?share=${share}`, ...remote })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/sessions/ses_2?share=${share}`, ...remote })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/%61pi/sessions/ses_1/send?share=${share}`, payload: { prompt: 'hi' }, ...remote })).statusCode).toBe(401);
    expect(calls).not.toContain('send');
  });
});

describe('参数里解码出的 / 不能凑出豁免路径', () => {
  it('%2F 拼出来像 relay 或插件触发器的路径，不带 token 一律 401；真正的豁免路由照常放行', async () => {
    const app = Fastify();
    registerAuthMiddleware(app, {
      mode: 'token', getToken: async () => 'secret-token', localOnly: false,
      exempt: (method, pathname) => isRelayCapabilityRequest(method, pathname) || isPluginTriggerRequest(method, pathname)
    });
    // 受保护的路由：静态前缀和豁免路径相同，参数里的 / 一旦被拆成多段就会撞上豁免正则。
    app.post('/api/relay/sessions/:id', async () => ({ reached: 'protected' }));
    app.post('/api/plugins/:plugin', async () => ({ reached: 'protected' }));
    app.post('/api/plugins/:plugin/triggers', async () => ({ reached: 'protected' }));
    app.get('/api/plugin-triggers/v1/:what', async () => ({ reached: 'protected' }));
    // 真正的豁免路由。
    app.post('/api/relay/sessions/:id/send', async () => ({ reached: 'relay' }));
    app.post('/api/plugins/:plugin/triggers/:id', async () => ({ reached: 'trigger' }));
    try {
      for (const [method, url] of [
        ['POST', '/api/relay/sessions/x%2Fsend'],
        ['POST', '/api/relay/sessions/x%2fask'],
        ['POST', '/api/plugins/p%2Ftriggers%2Ft'],
        ['POST', '/api/plugins/p/triggers?x=%2Ft'],
        ['GET', '/api/plugin-triggers/v1/runs%2Fr1'],
      ] as const) {
        const response = await app.inject({ method, url, remoteAddress: '8.8.8.8' });
        expect(response.statusCode, `${method} ${url} → ${response.body}`).toBe(401);
      }
      expect((await app.inject({ method: 'POST', url: '/api/relay/sessions/self/send', remoteAddress: '8.8.8.8' })).json()).toEqual({ reached: 'relay' });
      expect((await app.inject({ method: 'POST', url: '/api/plugins/p/triggers/t', remoteAddress: '8.8.8.8' })).json()).toEqual({ reached: 'trigger' });
      expect((await app.inject({ method: 'POST', url: '/api/plugins/p%2Ftriggers%2Ft', headers: { authorization: 'Bearer secret-token' }, remoteAddress: '8.8.8.8' })).json()).toEqual({ reached: 'protected' });
    } finally {
      await app.close();
    }
  });
});
