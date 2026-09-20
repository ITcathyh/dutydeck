import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import type { ConfigRepository } from '@dutydeck/shared';
import { saveLarkConfig } from './config.js';
import { registerLarkRoutes } from './routes.js';
import { LarkLongConnectionListener, LarkLongConnectionListenerPool } from './listener.js';

// Keep the real HTTP routes, configuration store and listener pool. Only the
// external Feishu transport is replaced so connection lifetimes are observable.
const transport = vi.hoisted(() => ({ autoReady: true }));
const sockets = vi.hoisted(() => [] as Array<{ appId: string; start: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; ready: () => void; fail: (error: Error) => void }>);
vi.mock('@larksuiteoapi/node-sdk', () => ({
  LoggerLevel: { warn: 'warn' },
  EventDispatcher: class { register() { return this; } },
  WSClient: class {
    start = vi.fn(async () => { if (transport.autoReady) this.options.onReady(); });
    close = vi.fn();
    constructor(readonly options: { appId: string; onReady: () => void; onError: (error: Error) => void }) {
      sockets.push({ appId: options.appId, start: this.start, close: this.close, ready: options.onReady, fail: options.onError });
    }
  },
}));

it('starts a new ask-mode bot through HTTP without restarting the server or existing bot connection', async () => {
  sockets.length = 0;
  const values = new Map<string, string>();
  const config: ConfigRepository = {
    get: async key => values.get(key),
    set: async (key, value) => { values.set(key, value); },
  };
  await saveLarkConfig(config, undefined, {
    appId: 'cli_existing', appSecret: 'existing-secret', defaultAgentId: 'ccflash',
    fullTrustConfirmed: true, listening: true,
  });
  const fetcher: typeof fetch = async input => {
    const url = String(input);
    if (url.includes('/auth/v3/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'test-token', expire: 7200 });
    if (url.includes('/bot/v3/info')) return Response.json({ code: 0, bot: { app_name: 'Test bot', open_id: 'ou_bot' } });
    throw new Error(`Unexpected request: ${url}`);
  };
  const app = Fastify();
  try {
    await registerLarkRoutes(app, { config, fetcher, env: {} });
    expect(sockets.map(socket => socket.appId)).toEqual(['cli_existing']);
    const existing = sockets[0]!;

    // The same two-stage save used by the UI: credentials, then Agent binding.
    const draft = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: {
      stage: 'lark', appId: 'cli_added', appSecret: 'added-secret', listening: false,
    } });
    expect(draft.statusCode).toBe(200);
    const enabled = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: {
      stage: 'agent', originalAppId: 'cli_added', defaultAgentId: 'ccflash',
      permissionMode: 'ask', fullTrustConfirmed: false, listening: true,
    } });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().bots).toEqual(expect.arrayContaining([
      expect.objectContaining({ appId: 'cli_existing', activeListening: true }),
      expect.objectContaining({ appId: 'cli_added', activeListening: true, permissionMode: 'ask', fullTrustConfirmed: false }),
    ]));
    expect(sockets.map(socket => socket.appId)).toEqual(['cli_existing', 'cli_added']);
    expect(existing.start).toHaveBeenCalledOnce();
    expect(existing.close).not.toHaveBeenCalled();
    expect(sockets[1]!.start).toHaveBeenCalledOnce();

    const status = await app.inject({ method: 'GET', url: '/api/lark/status' });
    expect(status.json().activeAppIds).toEqual(['cli_existing', 'cli_added']);

    // A CLI process writes the shared store, then tells the existing server to
    // load that bot. Concurrent notifications must not create duplicate sockets.
    await saveLarkConfig(config, undefined, {
      appId: 'cli_from_cli', appSecret: 'cli-secret', defaultAgentId: 'ccflash',
      permissionMode: 'ask', listening: true,
    });
    const saved = values.get('lark.bots');
    const notifications = await Promise.all([0, 1].map(() => app.inject({ method: 'POST', url: '/api/lark/bots/cli_from_cli/listener/sync', payload: {} })));
    for (const notification of notifications) {
      expect(notification.statusCode).toBe(200);
      expect(notification.json()).toEqual({ appId: 'cli_from_cli', listening: true, activeListening: true });
    }
    expect(values.get('lark.bots')).toBe(saved);
    expect(sockets.map(socket => socket.appId)).toEqual(['cli_existing', 'cli_added', 'cli_from_cli']);
    expect(sockets.every(socket => socket.start.mock.calls.length === 1 && socket.close.mock.calls.length === 0)).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/lark/bots/cli_missing/listener/sync' })).statusCode).toBe(404);
  } finally { await app.close(); }
  expect(sockets.every(socket => socket.close.mock.calls.length === 1)).toBe(true);
});

it.each([
  { listeningDisabled: true, listening: true, permissionMode: 'ask' },
  { listeningDisabled: false, listening: false, permissionMode: 'ask' },
  { listeningDisabled: false, listening: true, permissionMode: 'full-trust' },
])('does not override listening or execution restrictions: %j', async options => {
  const values = new Map([['lark.bots', JSON.stringify([{ appId: 'cli_blocked', appSecret: 'secret', ...options, fullTrustConfirmed: false }])]]);
  const config: ConfigRepository = { get: async key => values.get(key), set: async (key, value) => { values.set(key, value); } };
  const listener = { listening: false, activeAppIds: [], sync: vi.fn(async () => {}), stop: vi.fn() };
  const app = Fastify();
  try {
    await registerLarkRoutes(app, { config, listener, listeningDisabled: options.listeningDisabled });
    listener.sync.mockClear();
    const response = await app.inject({ method: 'POST', url: '/api/lark/bots/cli_blocked/listener/sync' });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('LARK_LISTENING_DISABLED');
    expect(listener.sync).not.toHaveBeenCalled();
  } finally { await app.close(); }
});

it('reports failed activation without claiming the saved bot is listening', async () => {
  const values = new Map([['lark.bots', JSON.stringify([{ appId: 'cli_failed', appSecret: 'secret', listening: true, permissionMode: 'ask' }])]]);
  const config: ConfigRepository = { get: async key => values.get(key), set: async (key, value) => { values.set(key, value); } };
  const listener = { listening: false, activeAppIds: [], sync: vi.fn(async () => { throw new Error('transport private details'); }), stop: vi.fn() };
  const app = Fastify();
  try {
    await registerLarkRoutes(app, { config, listener });
    const response = await app.inject({ method: 'POST', url: '/api/lark/bots/cli_failed/listener/sync' });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('LARK_LISTENER_START_FAILED');
    expect(response.body).not.toContain('transport private details');
  } finally { await app.close(); }
});

it.each(['ready', 'error', 'timeout'] as const)('waits for actual WebSocket readiness before reporting hot-add: %s', async outcome => {
  sockets.length = 0;
  transport.autoReady = false;
  const values = new Map<string, string>();
  const config: ConfigRepository = { get: async key => values.get(key), set: async (key, value) => { values.set(key, value); } };
  const fetcher: typeof fetch = async input => String(input).includes('/auth/v3/')
    ? Response.json({ code: 0, tenant_access_token: 'test-token', expire: 7200 })
    : Response.json({ code: 0, bot: { open_id: 'ou_bot' } });
  const app = Fastify();
  let request: ReturnType<typeof app.inject> | undefined;
  try {
    await registerLarkRoutes(app, { config, fetcher, env: {} });
    await saveLarkConfig(config, undefined, { appId: 'cli_wait', appSecret: 'secret', permissionMode: 'ask', listening: true });
    vi.useFakeTimers();
    let settled = false;
    request = app.inject({ method: 'POST', url: '/api/lark/bots/cli_wait/listener/sync' });
    void request.then(() => { settled = true; });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0]!.start).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/lark/status' })).json().activeAppIds).toEqual([]);
    if (outcome === 'ready') sockets[0]!.ready();
    else {
      if (outcome === 'error') sockets[0]!.fail(new Error('private transport details'));
      else await vi.advanceTimersByTimeAsync(20_000);
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      expect(settled).toBe(false);
      if (outcome === 'error') sockets[1]!.fail(new Error('private transport details'));
      else await vi.advanceTimersByTimeAsync(20_000);
    }
    const response = await request;
    expect(response.statusCode).toBe(outcome === 'ready' ? 200 : 503);
    expect(response.body).not.toContain('private transport details');
    expect((await app.inject({ method: 'GET', url: '/api/lark/status' })).json().activeAppIds).toEqual(outcome === 'ready' ? ['cli_wait'] : []);
    if (outcome !== 'ready') expect(sockets.every(socket => socket.close.mock.calls.length === 1)).toBe(true);
  } finally {
    transport.autoReady = true;
    sockets.forEach(socket => socket.fail(new Error('test cleanup')));
    await request;
    await app.close(); vi.useRealTimers();
  }
});

it('keeps a concurrent user stop after the first connection attempt fails', async () => {
  const values = new Map<string, string>();
  const config: ConfigRepository = { get: async key => values.get(key), set: async (key, value) => { values.set(key, value); } };
  await saveLarkConfig(config, undefined, { appId: 'cli_race', appSecret: 'secret', permissionMode: 'ask', listening: false });
  let rejectConnection!: (error: Error) => void;
  const connecting = new Promise<void>((_, reject) => { rejectConnection = reject; });
  const start = vi.spyOn(LarkLongConnectionListener.prototype, 'start').mockImplementationOnce(() => connecting).mockResolvedValue();
  const listener = new LarkLongConnectionListenerPool({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
  const app = Fastify();
  let enabling: PromiseLike<unknown> | undefined;
  let disabling: PromiseLike<unknown> | undefined;
  try {
    await registerLarkRoutes(app, { config, listener });
    enabling = app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_race', listening: true } }).then(response => response);
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    disabling = app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_race', listening: false } }).then(response => response);
    await vi.waitFor(() => expect(JSON.parse(values.get('lark.bots')!)[0].listening).toBe(false));
    rejectConnection(new Error('first connection failed'));
    await Promise.all([enabling, disabling]);
    expect(start).toHaveBeenCalledOnce();
    const status = await app.inject({ method: 'GET', url: '/api/lark/config' });
    expect(status.json().bots[0]).toMatchObject({ listening: false, activeListening: false });
  } finally {
    rejectConnection(new Error('test cleanup'));
    await Promise.allSettled([enabling, disabling]);
    await app.close(); start.mockRestore();
  }
});
