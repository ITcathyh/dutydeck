import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

/** 启动同步挂起到测试放行，模拟飞书长连接还在握手。 */
function heldListenerPool(outcome: 'connected' | 'failed') {
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  return {
    finish,
    pool: {
      listening: false,
      activeAppIds: [] as string[],
      sync: vi.fn(async () => { await held; if (outcome === 'failed') throw new Error('connect failed'); }),
      stop: vi.fn()
    }
  };
}

async function app(lark: Record<string, unknown>) {
  const built = await buildApp({ listAgents: vi.fn(async () => []) } as any, { lark: { env: { LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, ...lark } } as any);
  apps.push(built);
  return built;
}

const ready = async (built: FastifyInstance) => (await built.inject({ method: 'GET', url: '/health/ready' })).json();

describe('/health/ready', () => {
  it.each(['connected', 'failed'] as const)('启动时的飞书长连接同步结束前未就绪，结束后（%s）就绪', async outcome => {
    const listener = heldListenerPool(outcome);
    const built = await app({ listener: listener.pool });
    expect(await ready(built)).toEqual({ ok: true, ready: false, pending: ['飞书长连接还在建立'] });
    // /health 只表示进程在接请求，不受就绪影响。
    expect((await built.inject({ method: 'GET', url: '/health' })).json()).toEqual({ ok: true });
    listener.finish();
    await vi.waitFor(async () => expect(await ready(built)).toEqual({ ok: true, ready: true, pending: [] }));
  });

  it('关闭飞书监听的实例直接就绪', async () => {
    const listener = heldListenerPool('connected');
    const built = await app({ listener: listener.pool, listeningDisabled: true });
    expect(await ready(built)).toEqual({ ok: true, ready: true, pending: [] });
    expect(listener.pool.sync).not.toHaveBeenCalled();
  });

  it('开启认证时不需要令牌，供部署与重启在本机探测', async () => {
    const authed = await buildApp({ listAgents: vi.fn(async () => []) } as any, {
      auth: { localOnly: false, mode: 'token', getToken: async () => 'fixture-token' },
      lark: { env: {}, listeningDisabled: true }
    } as any);
    apps.push(authed);
    expect((await authed.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
    expect((await authed.inject({ method: 'GET', url: '/api/lark/status' })).statusCode).toBe(401);
  });
});
