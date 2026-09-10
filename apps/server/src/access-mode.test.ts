import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
});

function fakeRuntime() {
  const unsubscribe = vi.fn();
  return {
    listAgents: vi.fn(async () => []),
    listSessions: vi.fn(async () => []),
    start: vi.fn(async () => ({ id: 'session-open' })),
    getEventWindow: vi.fn(async () => []),
    subscribe: vi.fn(() => unsubscribe),
    unsubscribe
  };
}

describe('remote access modes', () => {
  it('keeps default remote HTTP and SSE behind the token before handlers subscribe', async () => {
    const runtime = fakeRuntime();
    const app = await buildApp(runtime as any, {
      auth: { mode: 'token', getToken: async () => 'secret-token', localOnly: false }
    });
    apps.push(app);

    expect((await app.inject({ method: 'GET', url: '/api/sessions' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/sessions/s1/stream' })).statusCode).toBe(401);
    expect(runtime.listSessions).not.toHaveBeenCalled();
    expect(runtime.subscribe).not.toHaveBeenCalled();
  });

  it('serves status, business HTTP, and SSE without a token in explicit open mode', async () => {
    const runtime = fakeRuntime();
    const getToken = vi.fn(async () => { throw new Error('open mode must not read a token'); });
    const app = await buildApp(runtime as any, {
      auth: { mode: 'open', getToken, localOnly: false }
    });
    apps.push(app);

    expect((await app.inject({ method: 'GET', url: '/api/auth/status' })).json()).toEqual({ authenticated: true, required: false });
    expect((await app.inject({ method: 'GET', url: '/api/sessions' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/sessions', payload: { agentId: 'codex' } })).statusCode).toBe(200);
    expect(getToken).not.toHaveBeenCalled();

    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    const origin = `http://127.0.0.1:${address.port}`;
    const controller = new AbortController();
    const response = await fetch(`${origin}/api/sessions/s1/stream`, {
      headers: { Origin: origin },
      signal: controller.signal
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const first = await response.body!.getReader().read();
    expect(new TextDecoder().decode(first.value)).toContain(': connected');
    controller.abort();
    await vi.waitFor(() => expect(runtime.subscribe).toHaveBeenCalledOnce());
  });

  it('keeps exact Origin validation in open mode, including trusted proxy headers', async () => {
    const runtime = fakeRuntime();
    const app = await buildApp(runtime as any, {
      auth: { mode: 'open', getToken: async () => null, localOnly: false }
    });
    apps.push(app);

    const rejected = await app.inject({
      method: 'POST', url: '/api/sessions', payload: { agentId: 'codex' },
      headers: { host: 'devbox.example:4310', origin: 'https://evil.example' }
    });
    expect(rejected.statusCode).toBe(403);
    expect(runtime.start).not.toHaveBeenCalled();

    const rejectedStream = await app.inject({
      method: 'GET', url: '/api/sessions/s1/stream',
      headers: { host: 'devbox.example:4310', origin: 'https://evil.example' }
    });
    expect(rejectedStream.statusCode).toBe(403);
    expect(runtime.subscribe).not.toHaveBeenCalled();

    const proxied = await app.inject({
      method: 'POST', url: '/api/sessions', payload: { agentId: 'codex' },
      headers: {
        host: '127.0.0.1:4310',
        origin: 'https://dutydeck.example',
        'x-forwarded-host': 'dutydeck.example',
        'x-forwarded-proto': 'https'
      }
    });
    expect(proxied.statusCode).toBe(200);
  });
});
