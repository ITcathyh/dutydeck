import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ConfigRepository } from '@dutydeck/shared';
import { readLarkConfigs, saveLarkConfig } from './config.js';
import { LarkLongConnectionListenerPool } from './listener.js';
import { __testOnly_resetLarkGate } from './api-gate.js';
import { larkListenerStatusKey, type LarkListenerStatus } from './listener-status.js';

// 真实的连接池、监听器和配置存储；只替换飞书长连接 SDK，按脚本决定每条连接成败。
const transport = vi.hoisted(() => ({ outcomes: [] as Array<'ready' | 'fail' | 'hold'>, duplicate: false }));
const sockets = vi.hoisted(() => [] as Array<{ appId: string; appSecret: string; at: number; closed: boolean; ready: () => void; fail: (error: Error) => void; reconnecting: () => void; reconnected: () => void }>);
vi.mock('@larksuiteoapi/node-sdk', () => ({
  LoggerLevel: { warn: 'warn' },
  EventDispatcher: class { register() { return this; } },
  WSClient: class {
    private readonly socket;
    constructor(readonly options: { appId: string; appSecret: string; onReady: () => void; onError: (error: Error) => void; onReconnecting: () => void; onReconnected: () => void }) {
      // 同一个机器人在新建连接时不应还有没关掉的旧连接。
      if (sockets.some(socket => socket.appId === options.appId && !socket.closed)) transport.duplicate = true;
      this.socket = { appId: options.appId, appSecret: options.appSecret, at: Date.now(), closed: false, ready: options.onReady, fail: options.onError,
        reconnecting: options.onReconnecting, reconnected: options.onReconnected };
      sockets.push(this.socket);
    }
    async start() {
      const outcome = transport.outcomes.shift() ?? 'ready';
      if (outcome === 'ready') this.options.onReady();
      if (outcome === 'fail') this.options.onError(new Error('ws endpoint busy, token=abc123'));
    }
    close() { this.socket.closed = true; }
  },
}));

const fetcher: typeof fetch = async input => String(input).includes('/auth/v3/')
  ? Response.json({ code: 0, tenant_access_token: 'test-token', expire: 7200 })
  : Response.json({ code: 0, bot: { open_id: 'ou_bot' } });
const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const memoryStore = () => {
  const values = new Map<string, string>();
  const store: ConfigRepository = { get: async key => values.get(key), set: async (key, value) => { values.set(key, value); } };
  return { values, store };
};
const status = (values: Map<string, string>) => JSON.parse(values.get(larkListenerStatusKey)!) as LarkListenerStatus;
// 连接建立要走几轮 fetch 与 Promise，推进 0 毫秒让它们跑完，不挪动假时钟。
const settle = async () => { for (let index = 0; index < 20; index++) await vi.advanceTimersByTimeAsync(0); };

let pool: LarkLongConnectionListenerPool | undefined;
beforeEach(() => {
  // 限流闸门是模块级的，记着上一条用例假时钟里的时间，不清掉会让下一条用例的请求一直等。
  __testOnly_resetLarkGate();
  sockets.length = 0;
  transport.outcomes = [];
  transport.duplicate = false;
  vi.useFakeTimers();
});
afterEach(() => {
  pool?.stop();
  pool = undefined;
  vi.useRealTimers();
});

async function setup(outcomes: Array<'ready' | 'fail' | 'hold'>) {
  const { values, store } = memoryStore();
  await saveLarkConfig(store, undefined, { appId: 'cli_retry', appSecret: 'secret-1', permissionMode: 'ask', listening: true });
  transport.outcomes = outcomes;
  pool = new LarkLongConnectionListenerPool(log(), { workflowStore: store, fetcher, env: {} });
  return { values, store, pool };
}

it('keeps reconnecting after a failed start with 30s doubling backoff capped at 5 minutes, and reports it for doctor', async () => {
  const { values, store, pool } = await setup(['fail', 'fail', 'fail', 'fail', 'fail', 'fail', 'ready']);
  await expect(pool.sync(await readLarkConfigs(store))).rejects.toThrow('ws endpoint busy');
  expect(pool.activeAppIds).toEqual([]);
  const failed = status(values);
  expect(failed).toMatchObject({ pid: process.pid, active: [], retrying: [{ appId: 'cli_retry', nextRetryAt: new Date(sockets[0]!.at + 30_000).toISOString() }] });
  // 给 doctor 的错误已脱敏
  expect(failed.retrying[0]!.error).toContain('ws endpoint busy');
  expect(failed.retrying[0]!.error).not.toContain('abc123');

  for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
    const before = sockets.length;
    await vi.advanceTimersByTimeAsync(delay - 1);
    await settle();
    expect(sockets).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(sockets).toHaveLength(before + 1);
  }
  expect(sockets.slice(1).map((socket, index) => socket.at - sockets[index]!.at)).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  expect(pool.activeAppIds).toEqual(['cli_retry']);
  expect(status(values)).toMatchObject({ active: ['cli_retry'], retrying: [] });
  expect(transport.duplicate).toBe(false);
  // 连上之后不再有排定的重连
  await vi.advanceTimersByTimeAsync(600_000);
  await settle();
  expect(sockets).toHaveLength(7);
});

it('reads the latest configuration before each reconnect and stops once the bot is disabled or deleted', async () => {
  const { values, store, pool } = await setup(['fail', 'fail']);
  await expect(pool.sync(await readLarkConfigs(store))).rejects.toThrow();
  // 等待期间换了凭据：重连用新的
  await saveLarkConfig(store, undefined, { originalAppId: 'cli_retry', appSecret: 'secret-2' });
  await vi.advanceTimersByTimeAsync(30_000);
  await settle();
  expect(sockets.map(socket => socket.appSecret)).toEqual(['secret-1', 'secret-2']);

  // 等待期间关了监听：到点不再连，也不再排下一次
  await saveLarkConfig(store, undefined, { originalAppId: 'cli_retry', listening: false });
  await vi.advanceTimersByTimeAsync(60_000);
  await settle();
  expect(sockets).toHaveLength(2);
  expect(status(values)).toMatchObject({ active: [], retrying: [] });
  await vi.advanceTimersByTimeAsync(600_000);
  await settle();
  expect(sockets).toHaveLength(2);
});

it('cancels a scheduled reconnect on manual sync and on shutdown, restarting the backoff from 30 seconds', async () => {
  const { store, pool } = await setup(['fail', 'fail', 'fail']);
  await expect(pool.sync(await readLarkConfigs(store))).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(20_000);
  // 手动同步当场再连一次；原先 30 秒那次作废，失败后重新从 30 秒算起
  await expect(pool.sync(await readLarkConfigs(store))).rejects.toThrow();
  expect(sockets).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(29_999);
  await settle();
  expect(sockets).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  await settle();
  expect(sockets).toHaveLength(3);
  expect(sockets[2]!.at - sockets[1]!.at).toBe(30_000);

  pool.stop();
  await vi.advanceTimersByTimeAsync(600_000);
  await settle();
  expect(sockets).toHaveLength(3);
  expect(sockets.every(socket => socket.closed)).toBe(true);
});

it('never opens a second connection for the same bot while a manual sync races an in-flight reconnect', async () => {
  const { store, pool } = await setup(['fail', 'hold']);
  await expect(pool.sync(await readLarkConfigs(store))).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(30_000);
  await settle();
  // 重连的这条连接迟迟不就绪，期间用户手动同步
  expect(sockets).toHaveLength(2);
  const manual = pool.sync(await readLarkConfigs(store));
  await vi.advanceTimersByTimeAsync(5_000);
  await settle();
  expect(sockets).toHaveLength(2);
  sockets[1]!.ready();
  await manual;
  expect(pool.activeAppIds).toEqual(['cli_retry']);
  await vi.advanceTimersByTimeAsync(600_000);
  await settle();
  expect(sockets).toHaveLength(2);
  expect(transport.duplicate).toBe(false);
});

it('takes over with backoff only after the SDK gives up reconnecting an established connection', async () => {
  const { values, store, pool } = await setup(['ready', 'ready']);
  await pool.sync(await readLarkConfigs(store));
  expect(pool.activeAppIds).toEqual(['cli_retry']);
  // SDK 自己的断线重连用尽后才报 onError
  sockets[0]!.fail(new Error('WebSocket reconnect exhausted after 3 attempts'));
  await settle();
  expect(pool.activeAppIds).toEqual([]);
  expect(sockets[0]!.closed).toBe(true);
  expect(status(values).retrying).toEqual([expect.objectContaining({ appId: 'cli_retry', error: expect.stringContaining('reconnect exhausted') })]);
  await vi.advanceTimersByTimeAsync(30_000);
  await settle();
  expect(sockets).toHaveLength(2);
  expect(pool.activeAppIds).toEqual(['cli_retry']);
  expect(transport.duplicate).toBe(false);
});

it('reports a bot as reconnecting, not connected, while the SDK reconnects an established connection', async () => {
  const { values, store, pool } = await setup(['ready']);
  await pool.sync(await readLarkConfigs(store));
  expect(status(values)).toMatchObject({ active: ['cli_retry'], reconnecting: [] });
  // 连接断开，SDK 开始自己重连：实例还在，但记为重连中，不算已连上
  sockets[0]!.reconnecting();
  await settle();
  expect(status(values)).toMatchObject({ active: [], retrying: [], reconnecting: [{ appId: 'cli_retry', since: new Date(Date.now()).toISOString() }] });
  // SDK 重连中不另起连接
  await vi.advanceTimersByTimeAsync(600_000);
  await settle();
  expect(sockets).toHaveLength(1);
  sockets[0]!.reconnected();
  await settle();
  expect(status(values)).toMatchObject({ active: ['cli_retry'], reconnecting: [] });
});
