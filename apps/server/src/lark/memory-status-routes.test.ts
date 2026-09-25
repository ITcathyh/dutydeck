import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigRepository } from '@dutydeck/shared';
import { saveLarkConfig } from './config.js';
import { registerLarkRoutes } from './routes.js';
import { LarkMemoryStore, type LarkMemoryStatus } from './memory.js';
import { LarkMemoryPipeline } from './memory-pipeline.js';

describe('GET /api/lark/bots/:appId/memory/status', () => {
  const apps: FastifyInstance[] = [];
  const map = new Map<string, string>();
  const config: ConfigRepository = {
    get: async key => map.get(key),
    set: async (key, value) => { map.set(key, value); }
  };

  const fetcher: typeof fetch = async input => {
    const url = String(input);
    if (url.includes('/auth/v3/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 'test-token', expire: 7200 });
    }
    if (url.includes('/bot/v3/info')) {
      return Response.json({ code: 0, bot: { app_name: 'Test Bot', open_id: 'ou_bot' } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  beforeEach(() => {
    map.clear();
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()));
  });

  async function createServer(options: {
    memoryPipeline?: any;
    omitMemory?: boolean;
  } = {}) {
    const app = Fastify();
    apps.push(app);
    await registerLarkRoutes(app, {
      config,
      fetcher,
      env: {},
      listeningDisabled: true,
      ...(options.omitMemory ? {} : {
        memory: {
          store: {} as any,
          projection: {} as any,
          pipeline: options.memoryPipeline
        }
      })
    });
    return app;
  }

  async function registerTestBot(appId: string, memoryEnabled = true) {
    await saveLarkConfig(config, undefined, {
      appId,
      appSecret: 'test-secret',
      defaultAgentId: 'agent',
      fullTrustConfirmed: true,
      memoryEnabled,
      listening: false
    });
  }

  it('机器人存在且运行成功时正常返回，包含群池状态且无 lastRunLabel', async () => {
    await registerTestBot('cli_test_bot', true);

    const mockStatus: LarkMemoryStatus = {
      appId: 'cli_test_bot',
      pool: 'groups',
      shared: true,
      liveEntries: 12,
      topics: 3,
      pendingTurns: 2,
      lastExtractionAt: '2026-09-25T10:00:00.000Z',
      lastConsolidationAt: '2026-09-25T12:00:00.000Z',
      lastRun: {
        kind: 'extraction',
        at: '2026-09-25T10:00:00.000Z',
        ok: true,
        added: 2,
        superseded: 0,
        retired: 0,
        retopiced: 0,
        rejected: 0
      }
    };

    const pipeline = {
      status: vi.fn(async () => mockStatus)
    };

    const app = await createServer({ memoryPipeline: pipeline });
    const response = await app.inject({
      method: 'GET',
      url: '/api/lark/bots/cli_test_bot/memory/status'
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.appId).toBe('cli_test_bot');
    expect(body.enabled).toBe(true);
    expect(body.groups.liveEntries).toBe(12);
    expect(body.groups.topics).toBe(3);
    expect(body.groups.pendingTurns).toBe(2);
    expect(body.groups.lastRun.ok).toBe(true);
    expect(body.groups.lastRunLabel).toBeUndefined();
    expect(pipeline.status).toHaveBeenCalledWith({
      appId: 'cli_test_bot',
      chatId: 'groups',
      pool: 'groups'
    });
  });

  it('机器人配置 memoryEnabled 为 false 时，返回 enabled: false', async () => {
    await registerTestBot('cli_test_disabled', false);

    const mockStatus: LarkMemoryStatus = {
      appId: 'cli_test_disabled',
      pool: 'groups',
      shared: true,
      liveEntries: 0,
      topics: 0,
      pendingTurns: 0
    };

    const pipeline = {
      status: vi.fn(async () => mockStatus)
    };

    const app = await createServer({ memoryPipeline: pipeline });
    const response = await app.inject({
      method: 'GET',
      url: '/api/lark/bots/cli_test_disabled/memory/status'
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      appId: 'cli_test_disabled',
      enabled: false,
      groups: expect.objectContaining({ liveEntries: 0 })
    });
  });

  it('失败时的 lastRunLabel 情况 1：已知错误码格式化为「错误码（中文说明）」', async () => {
    await registerTestBot('cli_test_fail1', true);

    const mockStatus: LarkMemoryStatus = {
      appId: 'cli_test_fail1',
      pool: 'groups',
      shared: true,
      liveEntries: 5,
      topics: 2,
      pendingTurns: 4,
      lastRun: {
        kind: 'extraction',
        at: '2026-09-25T11:00:00.000Z',
        ok: false,
        added: 0,
        superseded: 0,
        retired: 0,
        retopiced: 0,
        rejected: 0,
        error: 'MEMORY_RUN_TIMEOUT'
      }
    };

    const pipeline = { status: vi.fn(async () => mockStatus) };
    const app = await createServer({ memoryPipeline: pipeline });
    const response = await app.inject({
      method: 'GET',
      url: '/api/lark/bots/cli_test_fail1/memory/status'
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.groups.lastRun.ok).toBe(false);
    expect(body.groups.lastRunLabel).toBe('MEMORY_RUN_TIMEOUT（记忆会话运行超时）');
  });

  it('失败时的 lastRunLabel 情况 2：未知错误码返回「未知错误」', async () => {
    await registerTestBot('cli_test_fail2', true);

    const mockStatus: LarkMemoryStatus = {
      appId: 'cli_test_fail2',
      pool: 'groups',
      shared: true,
      liveEntries: 5,
      topics: 2,
      pendingTurns: 4,
      lastRun: {
        kind: 'consolidation',
        at: '2026-09-25T11:00:00.000Z',
        ok: false,
        added: 0,
        superseded: 0,
        retired: 0,
        retopiced: 0,
        rejected: 0,
        error: 'SOME_UNLISTED_CODE'
      }
    };

    const pipeline = { status: vi.fn(async () => mockStatus) };
    const app = await createServer({ memoryPipeline: pipeline });
    const response = await app.inject({
      method: 'GET',
      url: '/api/lark/bots/cli_test_fail2/memory/status'
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.groups.lastRun.ok).toBe(false);
    expect(body.groups.lastRunLabel).toBe('未知错误');
  });

  it('失败时的 lastRunLabel 情况 3：非大写下划线错误文本返回「运行异常（详见服务日志）」，不泄漏原始报错', async () => {
    await registerTestBot('cli_test_fail3', true);

    const mockStatus: LarkMemoryStatus = {
      appId: 'cli_test_fail3',
      pool: 'groups',
      shared: true,
      liveEntries: 5,
      topics: 2,
      pendingTurns: 4,
      lastRun: {
        kind: 'extraction',
        at: '2026-09-25T11:00:00.000Z',
        ok: false,
        added: 0,
        superseded: 0,
        retired: 0,
        retopiced: 0,
        rejected: 0,
        error: 'TypeError: Cannot read properties of undefined (reading /secret/path)'
      }
    };

    const pipeline = { status: vi.fn(async () => mockStatus) };
    const app = await createServer({ memoryPipeline: pipeline });
    const response = await app.inject({
      method: 'GET',
      url: '/api/lark/bots/cli_test_fail3/memory/status'
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.groups.lastRun.ok).toBe(false);
    expect(body.groups.lastRunLabel).toBe('运行异常（详见服务日志）');
    expect(JSON.stringify(body)).not.toContain('/secret/path');
  });

  it('机器人不存在时返回 404', async () => {
    const app = await createServer({ memoryPipeline: { status: vi.fn() } });
    const response = await app.inject({
      method: 'GET',
      url: '/api/lark/bots/cli_non_existent/memory/status'
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: 'LARK_BOT_NOT_FOUND' }
    });
  });

  it('未注入 memory pipeline 选项时返回 503 与 MEMORY_STATUS_UNAVAILABLE', async () => {
    await registerTestBot('cli_test_no_mem', true);

    const app = await createServer({ omitMemory: true });
    const response = await app.inject({
      method: 'GET',
      url: '/api/lark/bots/cli_test_no_mem/memory/status'
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: 'MEMORY_STATUS_UNAVAILABLE' }
    });
  });

  it('读取群池状态不会触发任何群的迁移（旧的按群账本 key 仍在）', async () => {
    await registerTestBot('cli_test_migration', true);

    // 预置旧的单群账本数据
    const legacyKey = 'lark.memory.cli_test_migration.oc_chat_legacy';
    const legacyData = JSON.stringify({
      v: 1,
      entries: [
        {
          id: 'mem_legacy1',
          content: '旧群历史记忆',
          source: 'user',
          topic: 'general',
          createdAt: '2026-09-20T10:00:00.000Z'
        }
      ]
    });
    map.set(legacyKey, legacyData);

    const store = new LarkMemoryStore(config);
    const pipeline = new LarkMemoryPipeline({
      runtime: {} as any,
      controlActorId: 'actor',
      repos: {} as any,
      store,
      projection: {} as any,
      readConfig: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any
    });

    const app = await createServer({ memoryPipeline: pipeline });
    const response = await app.inject({
      method: 'GET',
      url: '/api/lark/bots/cli_test_migration/memory/status'
    });

    expect(response.statusCode).toBe(200);
    // 旧的按群账本 key 依然完好无损，没有被迁移或重写成迁移占位符
    expect(map.get(legacyKey)).toBe(legacyData);
  });
});
