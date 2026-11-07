import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { targetGuard } from './target-server.js';

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });

async function fixture() {
  const guard = targetGuard(request => request.method === 'POST' && request.url === '/api/target');
  const received: unknown[] = [];
  const server = createServer(async (request, response) => {
    if (!guard.accept(request, response)) return;
    let raw = ''; for await (const chunk of request) raw += chunk;
    let body: unknown;
    try { body = JSON.parse(raw); } catch { request.socket.destroy(); return; }
    received.push(body);
    response.setHeader('content-type', 'application/json'); response.end('{"ok":true}');
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { guard, received, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

it('answers non-target requests with 404 without handing them to the handler', async () => {
  const h = await fixture();
  expect((await fetch(`${h.base}/probe`)).status).toBe(404);
  expect((await fetch(`${h.base}/probe`, { method: 'POST', body: 'not json' })).status).toBe(404);
  expect((await fetch(`${h.base}/api/target`)).status).toBe(404);
  expect(h.received).toEqual([]);
});

it('keeps only non-target /api/ requests as strays', async () => {
  const h = await fixture();
  await fetch(`${h.base}/probe`, { method: 'POST', body: 'not json' });
  await fetch(`${h.base}/api/other`, { method: 'POST', body: '{}' });
  await fetch(`${h.base}/api/target`);
  expect(h.guard.strayRequests).toEqual(['POST /api/other', 'GET /api/target']);
  expect(h.received).toEqual([]);
});

it('passes target requests through to the handler unchanged', async () => {
  const h = await fixture();
  const response = await fetch(`${h.base}/api/target`, { method: 'POST', body: '{"value":1}' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(h.received).toEqual([{ value: 1 }]);
  expect(h.guard.strayRequests).toEqual([]);
});
