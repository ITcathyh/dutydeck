import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import type { IncomingMessage } from 'node:http';
import type { TerminalStream } from '@dockmux/shared';
import {
  registerTerminalRoutes,
  type TerminalRouteAuth,
  type TerminalStreamHandle,
  type TerminalStreamProvider
} from './terminal-ws.js';

/** 假 TerminalStream：可手动触发 onData/onExit，记录 write/resize/dispose 调用 */
interface FakeStream {
  stream: TerminalStream;
  handle: TerminalStreamHandle;
  emitData(data: string): void;
  emitExit(code: number | null): void;
  writeCalls: string[];
  resizeCalls: Array<[number, number]>;
  disposeCount: number;
}

function createFakeStream(): FakeStream {
  const dataCallbacks: Array<(data: string) => void> = [];
  const exitCallbacks: Array<(code: number | null) => void> = [];
  const writeCalls: string[] = [];
  const resizeCalls: Array<[number, number]> = [];
  let disposeCount = 0;
  const stream: TerminalStream = {
    onData(callback) { dataCallbacks.push(callback); },
    write(data) { writeCalls.push(data); },
    resize(cols, rows) { resizeCalls.push([cols, rows]); },
    dispose() { disposeCount++; }
  };
  const handle: TerminalStreamHandle = {
    stream,
    onExit(callback) { exitCallbacks.push(callback); }
  };
  return {
    stream,
    handle,
    emitData(data) { for (const callback of dataCallbacks) callback(data); },
    emitExit(code) { for (const callback of exitCallbacks) callback(code); },
    writeCalls,
    resizeCalls,
    get disposeCount() { return disposeCount; }
  };
}

type ProviderEntry = TerminalStreamHandle | 'no-session' | 'unsupported';

function providerFrom(map: Record<string, ProviderEntry>): TerminalStreamProvider {
  return {
    lookupTerminalStream(sessionId) {
      const value = map[sessionId];
      if (value === 'no-session' || value === undefined) return { status: 'no-session' };
      if (value === 'unsupported') return { status: 'unsupported' };
      return { status: 'ready', handle: value };
    }
  };
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
});

async function startServer(provider: TerminalStreamProvider, auth?: TerminalRouteAuth): Promise<{ app: FastifyInstance; port: number }> {
  const app = Fastify({ logger: false });
  registerTerminalRoutes(app, { provider, auth });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apps.push(app);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { app, port: address.port };
}

function connect(port: number, path: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** 期望升级被拒：读 HTTP 状态码与 JSON body（ws 客户端默认会 abort，需监听 unexpected-response） */
function expectUpgradeRejected(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    ws.on('unexpected-response', (_request, response) => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk as Buffer));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    ws.on('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    ws.once('message', data => {
      try { resolve(JSON.parse(data.toString())); }
      catch (error) { reject(error); }
    });
    ws.once('error', reject);
  });
}

function closed(ws: WebSocket): Promise<void> {
  return new Promise(resolve => ws.once('close', () => resolve()));
}

describe('terminal WS proxy', () => {
  it('透传 PTY 输出为 data 帧', async () => {
    const fake = createFakeStream();
    const { port } = await startServer(providerFrom({ s1: fake.handle }));
    const ws = await connect(port, '/api/terminal/s1');

    // 先挂监听再 emit：WS 消息事件不缓冲，emit 时无监听者会丢帧
    const firstFrame = nextMessage(ws);
    fake.emitData('\x1b[31mhello\x1b[0m');
    expect(await firstFrame).toEqual({ type: 'data', data: '\x1b[31mhello\x1b[0m' });

    const secondFrame = nextMessage(ws);
    fake.emitData('second chunk');
    expect(await secondFrame).toEqual({ type: 'data', data: 'second chunk' });

    ws.close();
  });

  it('转发 input 消息到 stream.write', async () => {
    const fake = createFakeStream();
    const { port } = await startServer(providerFrom({ s1: fake.handle }));
    const ws = await connect(port, '/api/terminal/s1');

    ws.send(JSON.stringify({ type: 'input', data: 'ls -la\n' }));
    await vi.waitFor(() => expect(fake.writeCalls).toEqual(['ls -la\n']));

    ws.close();
  });

  it('转发 resize 消息到 stream.resize', async () => {
    const fake = createFakeStream();
    const { port } = await startServer(providerFrom({ s1: fake.handle }));
    const ws = await connect(port, '/api/terminal/s1');

    ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    await vi.waitFor(() => expect(fake.resizeCalls).toEqual([[120, 40]]));

    ws.close();
  });

  it('进程退出时发 exit 帧并关闭连接，且 dispose 只调一次', async () => {
    const fake = createFakeStream();
    const { port } = await startServer(providerFrom({ s1: fake.handle }));
    const ws = await connect(port, '/api/terminal/s1');

    const exitFrame = nextMessage(ws);
    const closePromise = closed(ws);
    fake.emitExit(0);

    expect(await exitFrame).toEqual({ type: 'exit', code: 0 });
    await closePromise;
    // exit 触发的 close 与 close 事件本身都走 cleanup，dispose 必须幂等；
    // 服务端 close 事件可能晚于客户端，用 waitFor 等待
    await vi.waitFor(() => expect(fake.disposeCount).toBe(1));
  });

  it('客户端断开时 dispose stream（不杀 PTY 进程）', async () => {
    const fake = createFakeStream();
    const { port } = await startServer(providerFrom({ s1: fake.handle }));
    const ws = await connect(port, '/api/terminal/s1');

    ws.close();
    await closed(ws);
    expect(fake.disposeCount).toBe(1);
  });

  it('每个连接独立订阅，互不影响', async () => {
    const fake = createFakeStream();
    const { port } = await startServer(providerFrom({ s1: fake.handle }));
    const first = await connect(port, '/api/terminal/s1');
    const second = await connect(port, '/api/terminal/s1');

    // 先挂监听再 emit：WS 消息事件不缓冲，emit 时无监听者会丢帧
    const firstBroadcast = nextMessage(first);
    const secondBroadcast = nextMessage(second);
    fake.emitData('broadcast');
    expect(await firstBroadcast).toEqual({ type: 'data', data: 'broadcast' });
    expect(await secondBroadcast).toEqual({ type: 'data', data: 'broadcast' });

    first.close();
    await closed(first);
    await vi.waitFor(() => expect(fake.disposeCount).toBe(1));

    // 第一个断开后第二个仍能收数据
    const stillAlive = nextMessage(second);
    fake.emitData('still alive');
    expect(await stillAlive).toEqual({ type: 'data', data: 'still alive' });

    second.close();
    await closed(second);
    expect(fake.disposeCount).toBe(2);
  });

  it('unsupported 的 session 升级被拒并回 HTTP 400', async () => {
    const { port } = await startServer(providerFrom({ acp: 'unsupported' }));
    const rejected = await expectUpgradeRejected(port, '/api/terminal/acp');
    expect(rejected.status).toBe(400);
    expect(JSON.parse(rejected.body)).toEqual({ type: 'error', message: 'terminal stream not supported for this session' });
  });

  it('不存在的 session 升级被拒并回 HTTP 404', async () => {
    const { port } = await startServer(providerFrom({}));
    const rejected = await expectUpgradeRejected(port, '/api/terminal/missing');
    expect(rejected.status).toBe(404);
    expect(JSON.parse(rejected.body)).toEqual({ type: 'error', message: 'session not found' });
  });

  it('sessionId 只取第一段且 decodeURIComponent', async () => {
    const fake = createFakeStream();
    const { port } = await startServer(providerFrom({ 'sess 1': fake.handle }));

    // 编码的空格 + 多余路径段：应解析出 'sess 1' 并升级成功
    const ws = await connect(port, '/api/terminal/sess%201/extra/segments');
    const frame = nextMessage(ws);
    fake.emitData('ok');
    expect(await frame).toEqual({ type: 'data', data: 'ok' });
    ws.close();
  });

  it('配置 auth 时 loopback 来源免认证', async () => {
    const fake = createFakeStream();
    const check = vi.fn(() => false);
    const auth: TerminalRouteAuth = { isLoopback: () => true, check };
    const { port } = await startServer(providerFrom({ s1: fake.handle }), auth);

    const ws = await connect(port, '/api/terminal/s1');
    const frame = nextMessage(ws);
    fake.emitData('ok');
    expect(await frame).toEqual({ type: 'data', data: 'ok' });
    expect(check).not.toHaveBeenCalled();
    ws.close();
  });

  it('非 loopback 无 token 时回 HTTP 401', async () => {
    const auth: TerminalRouteAuth = { isLoopback: () => false, check: () => false };
    const { port } = await startServer(providerFrom({ s1: createFakeStream().handle }), auth);

    const rejected = await expectUpgradeRejected(port, '/api/terminal/s1');
    expect(rejected.status).toBe(401);
    expect(JSON.parse(rejected.body)).toEqual({ type: 'error', message: 'unauthorized' });
  });

  it('非 loopback 错误 token 时回 HTTP 401', async () => {
    const auth: TerminalRouteAuth = { isLoopback: () => false, check: token => token === 'good-token' };
    const { port } = await startServer(providerFrom({ s1: createFakeStream().handle }), auth);

    const rejected = await expectUpgradeRejected(port, '/api/terminal/s1?token=bad-token');
    expect(rejected.status).toBe(401);
    expect(JSON.parse(rejected.body)).toEqual({ type: 'error', message: 'unauthorized' });
  });

  it('非 loopback 正确 token 时升级成功', async () => {
    const fake = createFakeStream();
    const auth: TerminalRouteAuth = { isLoopback: () => false, check: token => token === 'good-token' };
    const { port } = await startServer(providerFrom({ s1: fake.handle }), auth);

    const ws = await connect(port, '/api/terminal/s1?token=good-token');
    const frame = nextMessage(ws);
    fake.emitData('ok');
    expect(await frame).toEqual({ type: 'data', data: 'ok' });
    ws.close();
  });

  it('畸形 JSON 消息回 error 帧且不断开连接', async () => {
    const fake = createFakeStream();
    const { port } = await startServer(providerFrom({ s1: fake.handle }));
    const ws = await connect(port, '/api/terminal/s1');

    ws.send('not-json{');
    expect(await nextMessage(ws)).toEqual({ type: 'error', message: 'invalid JSON message' });
    expect(ws.readyState).toBe(WebSocket.OPEN);

    // 连接仍可用：合法 input 照常转发
    ws.send(JSON.stringify({ type: 'input', data: 'x' }));
    await vi.waitFor(() => expect(fake.writeCalls).toEqual(['x']));

    ws.close();
  });

  it('未知 type 的消息回 error 帧且不断开连接', async () => {
    const fake = createFakeStream();
    const { port } = await startServer(providerFrom({ s1: fake.handle }));
    const ws = await connect(port, '/api/terminal/s1');

    ws.send(JSON.stringify({ type: 'explode' }));
    expect(await nextMessage(ws)).toEqual({ type: 'error', message: 'unknown message type: explode' });
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
  });

  it('不拦截其它 pathname 的 upgrade 请求', async () => {
    const { app, port } = await startServer(providerFrom({}));
    const otherUpgrade = vi.fn((request: IncomingMessage, socket: { write(chunk: string): void; destroy(): void }) => {
      const pathname = new URL(request.url ?? '/', 'http://x').pathname;
      if (pathname.startsWith('/api/terminal/')) return;
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
    });
    app.server.on('upgrade', otherUpgrade);

    const rejected = await expectUpgradeRejected(port, '/api/other/thing');
    expect(rejected.status).toBe(404);
    expect(otherUpgrade).toHaveBeenCalledOnce();
  });
});
