import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { buildApp } from './app.js';
import { AUTH_COOKIE_NAME, registerAuthMiddleware, signSessionShareToken } from './auth/auth.js';
import { BOT_SESSION_ROUTES_KEY, isSharedInstanceRead, registerInstanceProxy, rewriteSharedSessionProxyUrl } from './instance-proxy.js';
import { registerTerminalRoutes } from './terminal/terminal-ws.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const cookie = { cookie: `${AUTH_COOKIE_NAME}=admin` };

async function shard(id: string, mode: 'local' | 'open' | 'token' = 'local') {
  let secret = 'original-shared-secret';
  let writes = 0;
  const app = Fastify({ rewriteUrl: rewriteSharedSessionProxyUrl });
  registerAuthMiddleware(app, { mode, localOnly: mode === 'local', getToken: async () => 'admin', getShareSecret: async () => secret });
  for (const suffix of ['', '/events', '/tasks', '/stream', '/workspace']) {
    app.get<{ Params: { id: string } }>(`/api/sessions/:id${suffix}`, async (request, reply) => {
      if (request.params.id === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
      if (request.params.id !== `ses_${id}`) return reply.code(404).send({ error: 'missing' });
      if (suffix === '/stream') return reply.type('text/event-stream').send(`data: ${JSON.stringify({ id })}\n\n`);
      return { id, sessionId: request.params.id };
    });
  }
  app.post('/api/sessions/:id/send', async () => ({ writes: ++writes }));
  registerTerminalRoutes(app, { provider: { lookupTerminalStream: () => ({ status: 'no-session' }) }, auth: { mode, check: token => token === 'admin' } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  cleanup.push(() => app.close());
  return { app, id, name: id, url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
    token: (sessionId = `ses_${id}`) => signSessionShareToken(secret, sessionId), rotate: () => { secret += '-rotated'; }, writes: () => writes };
}

async function world() {
  const a = await shard('a'), b = await shard('b');
  let secret = 'original-shared-secret';
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-instance-share-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>sharing shell</title>');
  const config = { get: async (key: string) => key === BOT_SESSION_ROUTES_KEY ? JSON.stringify({ version: 1, routes: { ses_a: 'a', ses_b: 'b' } }) : null };
  const main = await buildApp({ getSession: async (id: string) => id === 'ses_main' ? { id } : undefined } as any, {
    webRoot: root,
    lark: { config, listeningDisabled: true } as any,
    instances: [a, b],
    auth: { mode: 'token', localOnly: false, getToken: async () => 'admin', getShareSecret: async () => secret },
    terminal: { provider: { lookupTerminalStream: () => ({ status: 'no-session' }) }, auth: { mode: 'token', check: token => token === 'admin' } },
  });
  await main.listen({ host: '127.0.0.1', port: 0 });
  cleanup.push(() => main.close());
  const url = `http://127.0.0.1:${(main.server.address() as AddressInfo).port}`;
  return { a, b, main, url, rotate: () => { secret += '-rotated'; }, token: () => signSessionShareToken(secret, 'ses_main') };
}

describe('migrated bot sharing', () => {
  it('does not expose an older loopback peer that has no share enforcement', async () => {
    const oldPeer = Fastify();
    oldPeer.get('/api/sessions/:id', async () => ({ private: 'legacy data' }));
    await oldPeer.listen({ host: '127.0.0.1', port: 0 });
    cleanup.push(() => oldPeer.close());
    const main = await buildApp({} as any, {
      instances: [{ id: 'old', name: 'Old', url: `http://127.0.0.1:${(oldPeer.server.address() as AddressInfo).port}` }],
      auth: { mode: 'token', localOnly: false, getToken: async () => 'admin' },
    });
    await main.listen({ host: '127.0.0.1', port: 0 }); cleanup.push(() => main.close());
    const base = `http://127.0.0.1:${(main.server.address() as AddressInfo).port}/api/instances/old/sessions/ses_legacy`;
    expect((await fetch(`${base}?share=forged`)).status).toBe(404);
    expect(await (await fetch(base, { headers: cookie })).json()).toEqual({ private: 'legacy data' });
  });

  it('redirects old pages and serves new shells while all four reads reach the owning shard', async () => {
    const w = await world();
    for (const method of ['GET', 'HEAD'] as const) for (const page of ['share', 'sessions']) {
      const response = await fetch(`${w.url}/${page}/ses_a`, { method, redirect: 'manual' });
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(`/instances/a/${page}/ses_a`);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect((await fetch(`${w.url}/share/ses_main`)).status).toBe(200);
    expect((await fetch(`${w.url}/instances/a/share/ses_a`)).status).toBe(200);
    for (const peer of [w.a, w.b]) for (const suffix of ['', '/events', '/tasks', '/stream']) {
      const response = await fetch(`${w.url}/api/instances/${peer.id}/sessions/ses_${peer.id}${suffix}?share=${peer.token()}`);
      expect(response.status, suffix).toBe(200);
      if (suffix === '/stream') {
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        expect(await response.text()).toContain('data:');
      } else expect(await response.json()).toMatchObject({ id: peer.id });
    }
    expect((await fetch(`${w.url}/api/instances/a/sessions/ses_a?share=${w.a.token()}`, { method: 'HEAD' })).status).toBe(200);
  });

  it('keeps main/A/B key rotation independent and never falls back to main credentials', async () => {
    const w = await world();
    const mainToken = w.token(), aToken = w.a.token(), bToken = w.b.token();
    const read = (id: string, token: string) => fetch(`${w.url}${id === 'main' ? '/api' : `/api/instances/${id}`}/sessions/ses_${id}?share=${token}`, { headers: cookie });
    w.rotate();
    expect((await read('main', mainToken)).status).toBe(401);
    expect((await read('main', w.token())).status).toBe(200);
    expect((await read('a', aToken)).status).toBe(200);
    expect((await read('b', bToken)).status).toBe(200);
    w.a.rotate();
    expect((await read('a', aToken)).status).toBe(401);
    expect((await read('a', w.a.token())).status).toBe(200);
    expect((await read('b', bToken)).status).toBe(200);
    w.b.rotate();
    expect((await read('b', bToken)).status).toBe(401);
    expect((await read('b', w.b.token())).status).toBe(200);
    expect((await read('a', w.a.token())).status).toBe(200);
    expect((await read('main', w.token())).status).toBe(200);
  });

  it('denies forged/malformed capabilities, writes and terminals, retaining normal administrator access', async () => {
    const w = await world();
    const base = `${w.url}/api/instances/a/sessions/ses_a`, token = w.a.token();
    for (const path of [`?share=forged`, '?share=', `?share=${token}&share=${token}`, `/workspace?share=${token}`]) {
      expect((await fetch(base + path, { headers: cookie })).status, path).toBe(401);
    }
    expect((await fetch(`${w.url}/api/instances/a/sessions/ses_b?share=${token}`)).status).toBe(401);
    expect((await fetch(`${base}/send?share=${token}`, { method: 'POST', headers: cookie })).status).toBe(401);
    expect((await fetch(`${base}/send`, { method: 'POST' })).status).toBe(401);
    expect(w.a.writes()).toBe(0);
    expect((await fetch(`${base}/send`, { method: 'POST', headers: cookie })).status).toBe(200);
    expect(w.a.writes()).toBe(1);
    for (const url of [`${w.url}/api/instances/a/terminal/ses_a`, `${w.a.url}/api/terminal/ses_a`]) {
      for (const headers of [undefined, cookie]) {
        const socket = new WebSocket(`${url.replace('http:', 'ws:')}?share=${token}`, { headers });
        socket.on('error', () => {}); // Closing an explicitly rejected handshake emits an error.
        const status = await new Promise<number | undefined>(resolve => socket.on('unexpected-response', (_request, response) => { response.resume(); socket.close(); resolve(response.statusCode); }));
        expect(status).toBe(401);
      }
    }
    expect((await fetch(`${w.url}/api/instances/a/sessions/missing?share=${w.a.token('missing')}`)).status).toBe(404);
    expect((await fetch(`${w.url}/api/instances/a/sessions/forbidden?share=${w.a.token('forbidden')}`)).status).toBe(403);
    await w.a.app.close();
    expect((await fetch(`${base}?share=${token}`)).status).toBe(502);
    expect((await fetch(`${w.url}/api/instances/b/sessions/ses_b?share=${w.b.token()}`)).status).toBe(200);
  });

  it.each(['local', 'open', 'token'] as const)('enforces share tokens before %s authority and retains origin protection', async mode => {
    const peer = await shard('a', mode);
    for (const url of ['/api/sessions/ses_a?share=', '/api/sessions/ses_a?share=bad', '/api/sessions/ses_a/workspace?share=' + peer.token()]) {
      expect((await peer.app.inject({ url, headers: { host: 'localhost', ...cookie } })).statusCode).toBe(401);
    }
    expect((await peer.app.inject({ method: 'POST', url: `/api/sessions/ses_a/send?share=${peer.token()}`, headers: { host: 'localhost', ...cookie } })).statusCode).toBe(401);
    expect((await peer.app.inject({ url: '/api/shared-sessions/ses_a', headers: { host: 'localhost', ...cookie } })).statusCode).toBe(404);
    for (const url of ['/api/shared-sessions/ses_a?share=', `/api/shared-sessions/ses_a/send?share=${peer.token()}`, `/api/shared-sessions/ses_a%2fworkspace?share=${peer.token()}`]) {
      expect((await peer.app.inject({ url, headers: { host: 'localhost', ...cookie } })).statusCode).toBe(401);
    }
    expect((await peer.app.inject({ method: 'POST', url: `/api/shared-sessions/ses_a?share=${peer.token()}`, headers: { host: 'localhost', ...cookie } })).statusCode).toBe(401);
    if (mode !== 'token') expect((await peer.app.inject({ url: `/api/sessions/ses_a?share=${peer.token()}`, headers: { host: 'localhost', origin: 'https://attacker.example' } })).statusCode).toBe(403);
  });

  it('validates migration routes before serving and restricts normalized proxy paths', async () => {
    for (const value of [{ version: 2, routes: {} }, { version: 1, routes: { ses_a: 'unknown' } }]) {
      const app = Fastify(); cleanup.push(() => app.close());
      await expect(registerInstanceProxy(app, [], undefined, { get: async () => JSON.stringify(value) } as any)).rejects.toThrow();
    }
    const peers = [{ id: 'a', name: 'a', url: 'http://127.0.0.1:1234' }];
    for (const path of ['../sessions/ses_a', 'sessions/%2e%2e/ses_a', 'sessions/%252e%252e', 'sessions/ses_a%2fworkspace', 'sessions/ses_a/../../config', 'sessions/ses_a\\..\\config']) {
      expect(isSharedInstanceRead({ method: 'GET', url: `/api/instances/a/${path}?share=valid` }, peers), path).toBe(false);
    }
    expect(isSharedInstanceRead({ method: 'GET', url: '/api/instances/unknown/sessions/ses_a?share=valid' }, peers)).toBe(false);
  });
});
