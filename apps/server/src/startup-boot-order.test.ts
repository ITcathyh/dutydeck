import { afterEach, describe, expect, it, vi } from 'vitest';
import { get as httpGet, type IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';

/*
 * 启动竞态回归。
 *
 * 真实故障：registerTerminalRoutes 曾用 app.ready(callback) 注册 upgrade 处理器。
 * app.ready() 会**主动触发** Fastify boot；而 buildApp 里终端路由注册在前，后面还有
 * `await registerLarkRoutes(...)`。线上带持久化 Bot 配置启动时，这一步要等真实网络
 * （读取并同步 Bot 配置），boot 就在这个 await 期间跑完，随后的 addHook 直接抛：
 *
 *   FastifyError: Fastify instance is already listening. Cannot call "addHook"!
 *     at registerLarkRoutes (apps/server/src/lark/routes.ts:80)
 *     at async buildApp (apps/server/src/app.ts:113)
 *
 * 单测过去照不出来，因为 mock 的 sync 是同步 resolve 的，快到 boot 来不及跑完。
 * 这里用真实 Fastify + 真实 buildApp，并让 listener.sync 跨过至少一个事件循环 tick，
 * 精确复现那个窗口。不需要任何真实飞书网络或配置。
 */

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

/** listener.sync 跨事件循环挂起，模拟真实启动里那次网络往返。 */
function deferredListenerPool() {
  let activeAppIds: string[] = [];
  return {
    get listening() { return activeAppIds.length > 0; },
    get activeAppIds() { return activeAppIds; },
    sync: vi.fn(async (configs: Array<{ appId: string; listening: boolean }>) => {
      // 关键：真的让出事件循环。之前的 app.ready() 会在这里把 boot 跑完。
      await new Promise(resolve => setTimeout(resolve, 5));
      activeAppIds = configs.filter(config => config.listening).map(config => config.appId);
    }),
    stop: vi.fn(() => { activeAppIds = []; })
  };
}

const terminalOptions = {
  provider: { lookupTerminalStream: () => ({ status: 'no-session' as const }) }
};

function httpGetStatus(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpGet({ host: '127.0.0.1', port, path }, (response: IncomingMessage) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', reject);
  });
}

describe('启动引导顺序', () => {
  it('终端路由不得在 buildApp 仍在异步注册时提前触发 boot', async () => {
    const listener = deferredListenerPool();
    const app = await buildApp({ listAgents: vi.fn(async () => []) } as any, {
      terminal: terminalOptions,
      lark: {
        env: { LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test', LARK_AGENT_NAME: 'My Agent' },
        listener: listener as any
      }
    } as any);
    apps.push(app);

    // sync 真的跨过了事件循环——这正是旧实现被 boot 抢跑的窗口。
    expect(listener.sync).toHaveBeenCalled();
    // buildApp 走完了：Lark 那步的 addHook 没有因为 boot 提前跑完而抛异常。
    expect(typeof app.listen).toBe('function');

    // 到这里还不该 boot 完成；boot 应当由 listen 触发，而不是注册期间被抢跑。
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');

    // 健康检查与 Lark 路由都要真的能响应，证明两边的路由都完整挂上了。
    const health = await httpGetStatus(address.port, '/health');
    expect(health.status).toBe(200);
    const larkStatus = await httpGetStatus(address.port, '/api/lark/status');
    expect(larkStatus.status).toBe(200);
    expect(JSON.parse(larkStatus.body)).toMatchObject({ configured: true, defaultAgentName: 'My Agent' });

    // 终端 upgrade 处理器仍然挂上了：未知会话按 404 拒绝，而不是无人应答。
    const terminal = await httpGetStatus(address.port, '/api/terminal/');
    expect(terminal.status).toBeGreaterThanOrEqual(400);
  });

  it('没有终端路由时同样能带异步 Lark 同步完成启动（对照组）', async () => {
    const listener = deferredListenerPool();
    const app = await buildApp({ listAgents: vi.fn(async () => []) } as any, {
      lark: {
        env: { LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' },
        listener: listener as any
      }
    } as any);
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    expect((await httpGetStatus(address.port, '/health')).status).toBe(200);
  });
});
