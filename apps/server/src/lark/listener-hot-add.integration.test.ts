import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import type { ConfigRepository } from '@dutydeck/shared';
import { saveLarkConfig } from './config.js';
import { registerLarkRoutes } from './routes.js';

// Keep the real HTTP routes, configuration store and listener pool. Only the
// external Feishu transport is replaced so connection lifetimes are observable.
const sockets = vi.hoisted(() => [] as Array<{ appId: string; start: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>);
vi.mock('@larksuiteoapi/node-sdk', () => ({
  LoggerLevel: { warn: 'warn' },
  EventDispatcher: class { register() { return this; } },
  WSClient: class {
    start = vi.fn(async () => {});
    close = vi.fn();
    constructor(readonly options: { appId: string }) {
      sockets.push({ appId: options.appId, start: this.start, close: this.close });
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
  } finally { await app.close(); }
  expect(sockets.every(socket => socket.close.mock.calls.length === 1)).toBe(true);
});
