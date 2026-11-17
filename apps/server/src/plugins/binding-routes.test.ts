import { afterEach, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerPluginBindingRoutes } from './binding-routes.js';

afterEach(() => vi.restoreAllMocks());

it('dispatches only known plugin service actions and preserves authorization and lookup guards', async () => {
  const app = Fastify();
  const calls: string[] = [];
  const host = {
    active: [{ entry: { name: 'sample' }, plugin: { service: {} } }],
    services: Object.fromEntries(['start', 'stop', 'restart'].map(action => [action, async () => {
      calls.push(action);
      return { status: 'running' };
    }]))
  };
  registerPluginBindingRoutes(app, {
    host: host as any,
    authorize: async request => request.headers.authorization === 'Bearer synthetic-owner'
  });
  const send = (action: string, authorized = true, plugin = 'sample') => app.inject({
    method: 'POST',
    url: `/api/plugins/${plugin}/service/${action}`,
    headers: authorized ? { authorization: 'Bearer synthetic-owner' } : {}
  });
  try {
    expect((await send('stauts', false)).statusCode).toBe(403);
    expect((await send('stauts', true, 'absent')).statusCode).toBe(404);
    expect(calls).toEqual([]);
    for (const action of ['start', 'stop', 'restart']) expect((await send(action)).statusCode).toBe(200);
    expect(calls).toEqual(['start', 'stop', 'restart']);
    expect((await send('stauts')).statusCode).toBe(400);
    expect(calls).toEqual(['start', 'stop', 'restart']);
  } finally {
    await app.close();
  }
});
