import { afterEach, expect, it, vi } from 'vitest';
import { __testOnly_resetLarkGate } from './api-gate.js';
import { createLarkCardService, type LarkCardService } from './service.js';

const clients: LarkCardService[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.close()); __testOnly_resetLarkGate(); vi.useRealTimers(); });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const harness = (appId = 'cli_flight') => {
  let release!: () => void;
  let auth = 0, business = 0, aborted = 0;
  let fail = false;
  const fetcher = vi.fn(async (input: any, init?: RequestInit) => {
    if (String(input).includes('/auth/')) {
      auth++;
      await new Promise<void>((resolve, reject) => {
        release = resolve;
        init?.signal?.addEventListener('abort', () => { aborted++; reject(init.signal!.reason); }, { once: true });
      });
      if (fail) return json({ code: 99991663, msg: 'invalid credentials' });
      return json({ code: 0, tenant_access_token: appId, expire: 120 });
    }
    business++;
    expect((init?.headers as any).authorization).toBe(`Bearer ${appId}`);
    return json({ code: 0, data: { items: [] } });
  });
  const client = createLarkCardService({ LARK_APP_ID: appId, LARK_APP_SECRET: 'synthetic', LARK_API_QPS: '1000', LARK_API_BURST: '1000', LARK_API_REQUEST_TIMEOUT_MS: '1000' }, fetcher);
  clients.push(client);
  return { client, release: () => release(), counts: () => ({ auth, business, aborted }), fail: () => { fail = true; } };
};
const read = (client: LarkCardService, signal?: AbortSignal) => client.listChatMessages({ threadId: 'omt_test', pageSize: 20 }, signal);

it('coalesces 20 cold authentications while running all 20 business calls and keeping the warm cache', async () => {
  const h = harness();
  const requests = Array.from({ length: 20 }, () => read(h.client));
  await vi.waitFor(() => expect(h.counts()).toEqual({ auth: 1, business: 0, aborted: 0 }));
  h.release();
  expect(await Promise.all(requests)).toHaveLength(20);
  expect(h.counts()).toMatchObject({ auth: 1, business: 20 });
  await read(h.client);
  expect(h.counts()).toMatchObject({ auth: 1, business: 21 });
});

it('isolates the first waiter cancellation and starts a fresh flight after all waiters cancel', async () => {
  const h = harness();
  const first = new AbortController(), second = new AbortController();
  const one = read(h.client, first.signal), two = read(h.client, second.signal);
  const rejected = expect(one).rejects.toHaveProperty('name', 'AbortError');
  await vi.waitFor(() => expect(h.counts().auth).toBe(1));
  first.abort(); await rejected;
  expect(h.counts().aborted).toBe(0);
  h.release(); await two;
  expect(h.counts()).toMatchObject({ auth: 1, business: 1 });

  const all = harness('cli_all');
  const controller = new AbortController();
  const pending = read(all.client, controller.signal);
  const cancelled = expect(pending).rejects.toHaveProperty('name', 'AbortError');
  await vi.waitFor(() => expect(all.counts().auth).toBe(1));
  controller.abort(); await cancelled;
  await vi.waitFor(() => expect(all.counts().aborted).toBe(1));
  const retry = read(all.client);
  await vi.waitFor(() => expect(all.counts().auth).toBe(2));
  all.release(); await retry;
  expect(all.counts().business).toBe(1);
});

it('clears failed flights, isolates app identities, and closes in-flight authentication', async () => {
  const bad = harness('cli_bad'); bad.fail();
  const rejected = expect(read(bad.client)).rejects.toMatchObject({ code: 'LARK_OPENAPI_ERROR' });
  await vi.waitFor(() => expect(bad.counts().auth).toBe(1)); bad.release(); await rejected;
  const retry = expect(read(bad.client)).rejects.toMatchObject({ code: 'LARK_OPENAPI_ERROR' });
  await vi.waitFor(() => expect(bad.counts().auth).toBe(2)); bad.release(); await retry;
  const a = harness('cli_a'), b = harness('cli_b');
  const pendingA = read(a.client), pendingB = read(b.client);
  await vi.waitFor(() => { expect(a.counts().auth).toBe(1); expect(b.counts().auth).toBe(1); });
  const closed = expect(pendingA).rejects.toHaveProperty('name', 'AbortError');
  a.client.close(); await closed;
  b.release(); await pendingB;
  expect(a.counts()).toMatchObject({ business: 0, aborted: 1 });
  expect(b.counts().business).toBe(1);
});

it('lets a short deadline expire without aborting a later waiter or extending its budget', async () => {
  const h = harness();
  const short = AbortSignal.timeout(30);
  const one = read(h.client, short);
  const rejected = expect(one).rejects.toHaveProperty('name', 'TimeoutError');
  const two = read(h.client);
  await rejected;
  expect(h.counts().aborted).toBe(0);
  h.release(); await two;
  expect(h.counts()).toMatchObject({ auth: 1, business: 1 });
});

it('refreshes at the existing token expiry boundary', async () => {
  const h = harness();
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
  const first = read(h.client);
  await vi.waitFor(() => expect(h.counts().auth).toBe(1)); h.release(); await first;
  now.mockReturnValue(60_999); await read(h.client);
  expect(h.counts().auth).toBe(1);
  now.mockReturnValue(61_000);
  const refresh = read(h.client);
  await vi.waitFor(() => expect(h.counts().auth).toBe(2)); h.release(); await refresh;
  now.mockRestore();
});

it('exhausts a waiter at its own remaining retry budget while a fresh waiter finishes authentication', async () => {
  let auth = 0, business = 0;
  let release!: () => void;
  let refreshing!: () => void;
  const atRefresh = new Promise<void>(resolve => { refreshing = resolve; });
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
  const client = createLarkCardService({ LARK_APP_ID: 'cli_remaining', LARK_APP_SECRET: 'synthetic', LARK_API_QPS: '1000', LARK_API_BURST: '1000', LARK_API_RETRY_BASE_MS: '1', LARK_API_REQUEST_TIMEOUT_MS: '1000' }, async (input: any) => {
    if (String(input).includes('/auth/')) {
      auth++;
      if (auth === 2) { refreshing(); await new Promise<void>(resolve => { release = resolve; }); return new Response(JSON.stringify({ code: 503 }), { status: 503 }); }
      return json({ code: 0, tenant_access_token: 'synthetic', expire: 120 });
    }
    if (String(input).endsWith('/consume')) return json({ code: 99991663, msg: 'deterministic failure' });
    business++; return json({ code: 0, data: { items: [] } });
  });
  clients.push(client);
  const short = client.withRequestBudget(async () => {
    for (let i = 0; i < 3; i++) await expect(client.callOpenApi('/consume')).rejects.toMatchObject({ code: 'LARK_OPENAPI_ERROR' });
    now.mockReturnValue(61_000);
    return read(client);
  });
  const exhausted = expect(short).rejects.toMatchObject({ code: 'LARK_OPENAPI_ERROR', details: { upstreamHttpStatus: 503 }, larkRequestExhausted: true });
  await atRefresh;
  const fresh = read(client);
  release();
  await exhausted;
  await fresh;
  expect(auth).toBe(3);
  expect(business).toBe(1);
  now.mockRestore();
});

it('keeps authentication flights separate for service instances with the same app id', async () => {
  const a = harness('cli_same'), b = harness('cli_same');
  const first = read(a.client), second = read(b.client);
  await vi.waitFor(() => { expect(a.counts().auth).toBe(1); expect(b.counts().auth).toBe(1); });
  a.release(); b.release();
  await Promise.all([first, second]);
  expect(a.counts().business).toBe(1); expect(b.counts().business).toBe(1);
});
