import Fastify from 'fastify';
import { registerLarkRoutes } from './routes.js';
import { LarkLongConnectionListener, LarkMessageCoordinator } from './listener.js';
import type { StoredLarkConfig } from './config.js';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkbenchFetch } from '../workbench-fetch.js';
import { __testOnly_resetLarkGate } from './api-gate.js';
import { createLarkCardService, type LarkCardService } from './service.js';

const ws = vi.hoisted(() => ({ handlers: {} as Record<string, (event: unknown) => unknown> }));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  LoggerLevel: { warn: 'warn' },
  EventDispatcher: class {
    register(handlers: typeof ws.handlers) { ws.handlers = handlers; return this; }
  },
  WSClient: class {
    constructor(private readonly options: { onReady: () => void }) {}
    async start() { this.options.onReady(); }
    close() {}
  }
}));

let server: Server;
let baseUrl: string;
let route: (path: string, response: ServerResponse) => void;
let paths: string[];
let disconnected: number;
const services: LarkCardService[] = [];
const json = (response: ServerResponse, body: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
const token = (response: ServerResponse) => json(response, { code: 0, tenant_access_token: 'synthetic', expire: 3600 });
const service = (env: NodeJS.ProcessEnv = {}, fetcher = globalThis.fetch) => {
  const value = createLarkCardService({ LARK_APP_ID: 'cli_deadline', LARK_APP_SECRET: 'synthetic', LARK_OPEN_API_BASE_URL: baseUrl,
    LARK_API_QPS: '1000', LARK_API_RETRY_BASE_MS: '2', LARK_API_REQUEST_TIMEOUT_MS: '150', ...env }, fetcher);
  services.push(value); return value;
};
beforeEach(async () => {
  paths = []; disconnected = 0;
  route = (path, response) => path.includes('/auth/') ? token(response) : json(response, { code: 0 });
  server = createServer((request, response) => {
    paths.push(request.url!);
    response.on('close', () => { if (!response.writableEnded) disconnected++; });
    request.resume();
    route(request.url!, response);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  for (const value of services.splice(0)) value.close();
  __testOnly_resetLarkGate(); vi.restoreAllMocks();
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('Lark end-to-end request deadline', () => {
  it.each(['token', 'headers', 'body'])('physically cancels a stalled %s', async phase => {
    route = (path, response) => {
      if (path.includes('/auth/')) { if (phase !== 'token') token(response); return; }
      if (phase === 'body') { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"code":'); }
    };
    const started = Date.now();
    await expect(service().callOpenApi('/slow')).rejects.toMatchObject({ name: expect.stringMatching(/^(AbortError|TimeoutError)$/) });
    expect(Date.now() - started).toBeLessThan(800);
    await vi.waitFor(() => expect(disconnected).toBe(1));
    expect(paths).toHaveLength(phase === 'token' ? 1 : 2);
  });

  it('does not restart the deadline after authentication completes', async () => {
    route = (path, response) => {
      if (path.includes('/auth/')) { setTimeout(() => token(response), 90); return; }
      response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"code":');
      setTimeout(() => response.end('0}'), 110);
    };
    await expect(service().callOpenApi('/slow-body')).rejects.toMatchObject({ name: expect.stringMatching(/^(AbortError|TimeoutError)$/) });
    await vi.waitFor(() => expect(disconnected).toBe(1));
  });

  it('bounds the token-bucket queue and cancels it on client lifecycle shutdown', async () => {
    const http = createWorkbenchFetch();
    const client = service({ LARK_API_QPS: '1', LARK_API_BURST: '1', LARK_API_REQUEST_TIMEOUT_MS: '1000' }, http.fetch);
    const pending = client.callOpenApi('/queued');
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(paths).toHaveLength(1));
    http.close();
    await rejected;
    expect(paths.every(path => path.includes('/auth/'))).toBe(true);
  });

  it('expires while queued for a token without opening a business connection', async () => {
    await expect(service({ LARK_API_QPS: '1', LARK_API_BURST: '1' }).callOpenApi('/queued')).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(paths).toHaveLength(1);
  });

  it('honors Retry-After without another HTTP attempt beyond the total deadline', async () => {
    route = (path, response) => {
      if (path.includes('/auth/')) { token(response); return; }
      response.setHeader('retry-after', '10'); json(response, { code: 230020 }, 429);
    };
    await expect(service().callOpenApi('/limited')).rejects.toHaveProperty('name', 'TimeoutError');
    expect(paths.filter(path => path === '/limited')).toHaveLength(1);
  });

  it.each(['contact', 'multipart', 'resource'] as const)('covers %s response-body consumption', async kind => {
    route = (path, response) => {
      if (path.includes('/auth/')) { token(response); return; }
      response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"code":');
    };
    const client = service();
    const pending = kind === 'contact' ? client.getContactUser('ou_test', 'open_id')
      : kind === 'resource' ? client.downloadMessageResource('om_test', 'file_test', 'file')
      : client.uploadFile({ filename: 'sample.txt', data: new Uint8Array([65]), idempotencyKey: 'synthetic-upload' });
    await expect(pending).rejects.toHaveProperty('name', expect.stringMatching(/^(AbortError|TimeoutError)$/));
    await vi.waitFor(() => expect(disconnected).toBe(1));
  });

  it('shares one failure budget across terminal retries and preserves the upstream error', async () => {
    route = (path, response) => path.includes('/auth/') ? token(response) : json(response, { code: 503 }, 503);
    const client = service({ LARK_API_REQUEST_TIMEOUT_MS: '1000' });
    let last: unknown;
    await client.withRequestBudget(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await client.update({ messageId: 'om_test', state: 'completed', markdown: 'done' }); }
        catch (error) { last = error; if ((error as { larkRequestExhausted?: boolean }).larkRequestExhausted) break; }
      }
    });
    expect(last).toMatchObject({ code: 'LARK_OPENAPI_ERROR', details: { upstreamHttpStatus: 503 }, larkRequestExhausted: true });
    expect(paths.filter(path => path.includes('/messages/'))).toHaveLength(4);
  });
});


describe('default HTTP lifecycle wiring', () => {
  it('closes a route request before waiting for Fastify shutdown', async () => {
    route = () => {};
    const app = Fastify();
    await registerLarkRoutes(app, { listeningDisabled: true, env: { LARK_OPEN_API_BASE_URL: baseUrl, LARK_API_REQUEST_TIMEOUT_MS: '5000' } });
    const pending = app.inject({ method: 'POST', url: '/api/lark/bot/inspect', payload: { appId: 'cli_route', appSecret: 'synthetic' } });
    try {
      await vi.waitFor(() => expect(paths).toHaveLength(1));
      await app.close();
      expect((await pending).statusCode).toBe(500);
      await vi.waitFor(() => expect(disconnected).toBe(1));
    } finally { await app.close(); }
  });

  it('stopping a listener aborts its initial authentication without opening a websocket', async () => {
    route = () => {};
    const listener = new LarkLongConnectionListener({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }, {
      env: { LARK_OPEN_API_BASE_URL: baseUrl, LARK_API_REQUEST_TIMEOUT_MS: '5000' }
    });
    const pending = listener.start({ appId: 'cli_listener', appSecret: 'synthetic', listening: true } as StoredLarkConfig);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'LARK_LISTENER_START_FAILED' });
    try {
      await vi.waitFor(() => expect(paths).toHaveLength(1));
      listener.stop();
      await rejected;
      expect(listener.listening).toBe(false);
      await vi.waitFor(() => expect(disconnected).toBe(1));
    } finally { listener.stop(); }
  });
});


it.each(['deadline', 'stop'] as const)('bounds the default listener chat-mode reader on %s', async cancel => {
  route = (path, response) => {
    if (path.includes('/auth/')) { token(response); return; }
    if (path.includes('/bot/v3/info')) { json(response, { code: 0, bot: { open_id: 'ou_bot' } }); return; }
    if (path.includes('/chats/')) { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"code":'); return; }
    json(response, { code: 0, data: { message_id: 'om_welcome' } });
  };
  const records = new Map<string, string>();
  const listener = new LarkLongConnectionListener({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }, {
    env: { LARK_OPEN_API_BASE_URL: baseUrl, LARK_API_QPS: '1000', LARK_API_REQUEST_TIMEOUT_MS: cancel === 'stop' ? '5000' : '150' },
    welcomeStore: { get: async key => records.get(key), set: async (key, value) => { records.set(key, value); } }
  });
  try {
    await listener.start({ appId: `cli_chat_${cancel}`, appSecret: 'synthetic', listening: true, allowedUsers: [], allowedEmails: [] } as unknown as StoredLarkConfig);
    ws.handlers['im.chat.member.bot.added_v1']!({ chat_id: `oc_chat_${cancel}` });
    await vi.waitFor(() => expect(paths.some(path => path.includes('/chats/'))).toBe(true));
    if (cancel === 'stop') listener.stop();
    await vi.waitFor(() => expect(disconnected).toBe(1));
    if (cancel === 'stop') expect(paths.some(path => path.includes('/messages'))).toBe(false);
    else await vi.waitFor(() => expect(paths.some(path => path.includes('/messages'))).toBe(true));
  } finally { listener.stop(); }
});


it('bounds actual coordinator terminal PATCH retries while persisting the independent result', async () => {
  let messages = 0;
  route = (path, response) => {
    if (path.includes('/auth/')) { token(response); return; }
    if (path === '/open-apis/im/v1/messages/om_running') { json(response, { code: 503 }, 503); return; }
    if (path.includes('/im/v1/messages?')) { json(response, { code: 0, data: { message_id: ++messages === 1 ? 'om_running' : 'om_result' } }); return; }
    json(response, { code: 0, data: { image_key: 'img_fake', reaction_id: 'reaction_fake' } });
  };
  let subscriber: ((event: any) => void) | undefined;
  const session = { id: 'ses_test', agentId: 'mock', state: 'idle', protocol: 'acp', cwd: '/tmp', permissionMode: 'ask', runId: 'run_test', createdAt: '', updatedAt: '' };
  const runtime = {
    start: vi.fn(async () => session), getSession: vi.fn(async () => session),
    subscribe: vi.fn((_id: string, receive: typeof subscriber) => { subscriber = receive; return vi.fn(); }),
    send: vi.fn(async () => { subscriber?.({ id: 'evt', sessionId: session.id, sequence: 1, type: 'text', timestamp: '', data: { text: 'completed result' } }); }),
    interrupt: vi.fn(async () => {})
  };
  const client = service({ LARK_API_REQUEST_TIMEOUT_MS: '1000' });
  const saved: any[] = [];
  const mappings = { list: vi.fn(async () => []), get: vi.fn(), save: vi.fn(async (entry: any) => { saved.push(JSON.parse(entry.extra)); }) };
  const coordinator = new LarkMessageCoordinator(runtime as any, client, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, Math.random, 'ou_bot', undefined, mappings as any);
  const reconcile = vi.spyOn(coordinator as any, 'scheduleReconcile').mockImplementation(() => {});
  try {
    await coordinator.handle({ messageId: 'om_input', chatId: 'oc_test', chatType: 'p2p', messageType: 'text', content: '{"text":"run"}', mentions: [] }, {
      appId: 'cli_deadline', appSecret: 'synthetic', workspace: '/tmp', defaultAgentId: 'mock', listening: true, permissionMode: 'ask',
      groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1000, hideTraceOnComplete: false,
      allowedUsers: [], allowedEmails: [], highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: '', riskControlMode: 'off'
    } as StoredLarkConfig);
    await vi.waitFor(() => expect(saved.some(entry => entry.final_delivery_state === 'delivered' && entry.final_message_id === 'om_result'), JSON.stringify({ paths, saved })).toBe(true));
    expect(paths.filter(path => path === '/open-apis/im/v1/messages/om_running')).toHaveLength(4);
    expect(reconcile).toHaveBeenCalled();
    expect(messages).toBe(2);
  } finally { coordinator.stop(); }
});
