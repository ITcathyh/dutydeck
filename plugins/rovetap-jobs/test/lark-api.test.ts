import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { LarkApiClient } from '../service/lark-api.mjs';

// Standalone local stubs for the shared HTTP path: body-stall timeout,
// mid-stream disconnect, 429/frequency recovery, token refresh and definitive
// read/reply classifications. No temporary dirs or ports are fixed.

interface Stub {
  baseUrl: string;
  requests: Array<{ path: string; authorization?: string }>;
  close: () => Promise<void>;
}

type Handler = (req: any, res: any, body: string) => void | Promise<void>;

async function startStub(
  handler: Handler,
  tokenMode: 'static' | 'rotating' = 'static',
): Promise<Stub> {
  const requests: Stub['requests'] = [];
  let tokenCalls = 0;
  const prefix = `/${randomUUID()}`;
  const server: Server = createServer((req, res) => {
    if (!req.url?.startsWith(`${prefix}/`)) {
      req.resume();
      res.writeHead(404).end();
      return;
    }
    const path = req.url.slice(prefix.length);
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (path.includes('/tenant_access_token/')) {
        tokenCalls += 1;
        const token = tokenMode === 'rotating' ? `t${tokenCalls}` : 't-fake';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 0, tenant_access_token: token, expire: 7200 }));
        return;
      }
      requests.push({ path, authorization: req.headers.authorization });
      void handler(req, res, Buffer.concat(chunks).toString('utf8'));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  return {
    baseUrl: `http://127.0.0.1:${port}${prefix}`,
    requests,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const fastClient = (stub: Pick<Stub, 'baseUrl'>, extra: Record<string, any> = {}, fetcher?: typeof fetch) => new LarkApiClient({
  appId: 'cli_x', appSecret: 'secret', baseUrl: stub.baseUrl, timeoutMs: 1_000,
  retryBaseMs: 2, rateLimitRetries: 2, ...extra,
}, fetcher);

let stub: Stub | undefined;
afterEach(async () => {
  vi.useRealTimers();
  if (stub) await stub.close();
  stub = undefined;
});

describe('lark-api request / full-body timeout', () => {
  it('times out when headers arrive but the body never completes, instead of hanging', async () => {
    stub = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"code":0,"data":'); // headers + partial body, never res.end()
    });
    const client = fastClient(stub, { timeoutMs: 120 });
    const t0 = Date.now();
    await expect(client.request('/open-apis/im/v1/messages/om_stall')).rejects.toMatchObject({ kind: 'network' });
    expect(Date.now() - t0).toBeLessThan(1_500); // did not wait on undici's 300s body timeout
  });

  it('classifies a mid-body disconnect as a network failure', async () => {
    stub = await startStub((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"code":0');
      req.socket.destroy();
    });
    const client = fastClient(stub);
    await expect(client.request('/open-apis/im/v1/messages/om_cut')).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('lark-api rate limit backoff and recovery', () => {
  it('retries HTTP 429 and then succeeds', async () => {
    let calls = 0;
    stub = await startStub((_req, res) => {
      calls += 1;
      if (calls === 1) { res.writeHead(429, { 'content-type': 'application/json' }); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: { ok: true } }));
    });
    const client = fastClient(stub);
    await expect(client.request('/x')).resolves.toMatchObject({ data: { ok: true } });
    expect(calls).toBe(2);
  });

  it('retries the authoritative frequency business codes 99991400 and 230020', async () => {
    for (const code of [99991400, 230020]) {
      let calls = 0;
      const s = await startStub((_req, res) => {
        calls += 1;
        if (calls === 1) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ code, msg: 'rate' }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 0, data: { recovered: code } }));
      });
      try {
        const client = fastClient(s);
        const out = await client.request('/x');
        expect(out.data.recovered).toBe(code);
        expect(calls).toBe(2);
      } finally {
        await s.close();
      }
    }
  });

  it('surfaces rate_limited after bounded retries are exhausted', async () => {
    let calls = 0;
    stub = await startStub((_req, res) => {
      calls += 1;
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 99991400 }));
    });
    const client = fastClient(stub, { rateLimitRetries: 1 });
    await expect(client.request('/x')).rejects.toMatchObject({ kind: 'rate_limited', larkCode: 99991400 });
    expect(calls).toBe(2); // initial + one retry
  });
});

describe('lark-api token refresh and definitive classifications', () => {
  it('refreshes an invalid tenant token once and retries the request', async () => {
    stub = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (_req.headers.authorization === 'Bearer t1') {
        return res.end(JSON.stringify({ code: 99991663, msg: 'token expired' }));
      }
      res.end(JSON.stringify({ code: 0, data: { ok: true } }));
    }, 'rotating');
    const client = fastClient(stub);
    await expect(client.request('/x')).resolves.toMatchObject({ data: { ok: true } });
    const authed = stub.requests;
    expect(authed).toHaveLength(2);
    expect(authed[0].authorization).toBe('Bearer t1');
    expect(authed[1].authorization).toBe('Bearer t2'); // forced refresh, not the cached token
  });

  it('maps 230002 read failure to not_found and 230049 reply to unknown/inFlight', async () => {
    stub = await startStub((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url!.includes('/messages/om_gone?')) {
        return res.end(JSON.stringify({ code: 230002, msg: 'not found' }));
      }
      if (req.url!.endsWith('/reply')) {
        return res.end(JSON.stringify({ code: 230049, msg: 'same uuid sending' }));
      }
      res.end(JSON.stringify({ code: 0 }));
    });
    const client = fastClient(stub);
    await expect(client.getMessageItems('om_gone')).rejects.toMatchObject({ kind: 'not_found', larkCode: 230002 });

    const reply = await client.replyText({ replyToMessageId: 'om_r', text: 'x', uuid: 'u' });
    expect(reply).toMatchObject({ outcome: 'unknown', inFlight: true, code: 230049 });
  });

  it('marks 230072 reply as a definitive target-unavailable failure', async () => {
    stub = await startStub((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 230072, msg: 'merge forward message not support thread reply' }));
    });
    const client = fastClient(stub);
    const reply = await client.replyText({ replyToMessageId: 'om_merge_root', text: '接单回执', uuid: 'u1' });
    expect(reply).toMatchObject({ outcome: 'failed', code: 230072, replyTargetUnavailable: true });
  });

  it('treats 230071 (the chat lacks topics) as a refusal without redirect eligibility', async () => {
    stub = await startStub((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 230071, msg: 'chat thread unavailable' }));
    });
    const client = fastClient(stub);
    const reply = await client.replyText({ replyToMessageId: 'om_any', text: '回执', uuid: 'u71' });
    expect(reply).toMatchObject({ outcome: 'failed', code: 230071 });
    expect(reply.replyTargetUnavailable).toBeFalsy();
  });
});

describe('lark-api receipt absolute 1h deadline across token/backoff/POST', () => {
  const base = { baseUrl: 'http://127.0.0.1' };
  const tokenPath = base.baseUrl + '/open-apis/auth/v3/tenant_access_token/internal/';
  const replyPath = base.baseUrl + '/open-apis/im/v1/messages/om_r/reply';
  const messagePath = base.baseUrl + '/open-apis/im/v1/messages/om_material?user_id_type=open_id&card_msg_content_type=raw_card_content';
  const confirmation = { outcome: 'unknown', reason: expect.stringMatching(/^deadline:/) };
  const tokenPayload = { code: 0, tenant_access_token: 't-refreshed', expire: 7200 };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  function replyBeforeDeadline(client: LarkApiClient, deadlineAt = Date.now() + 400) {
    return client.replyText({ replyToMessageId: 'om_r', text: 'x', uuid: 'u', deadlineAt });
  }

  function primeToken(client: LarkApiClient) {
    client.token = 't-cached';
    client.tokenExpiresAt = Date.now() + 60_000;
  }

  it('does not start any network call once the deadline has elapsed', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = fastClient(base, {}, fetcher);
    await expect(replyBeforeDeadline(client, Date.now())).resolves.toMatchObject(confirmation);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not repeat a POST when the deadline ends the 429 Retry-After wait', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', {
      status: 429, headers: { 'retry-after': '30' },
    }));
    const client = fastClient(base, {}, fetcher);
    primeToken(client);

    const reply = replyBeforeDeadline(client);
    const settled = vi.fn();
    void reply.then(settled);
    await vi.advanceTimersByTimeAsync(399);
    expect(settled).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([replyPath]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(reply).resolves.toMatchObject(confirmation);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([replyPath]);
  });

  it('aborts an in-flight token refresh and never sends a second reply POST', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ code: 99991663 }))
      .mockImplementationOnce(async (_url, options) => {
        const signal = options!.signal!;
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });
    const client = fastClient(base, {}, fetcher);
    primeToken(client);

    const reply = replyBeforeDeadline(client);
    await vi.advanceTimersByTimeAsync(399);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([replyPath, tokenPath]);
    const tokenSignal = fetcher.mock.calls[1][1]!.signal!;
    expect(tokenSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(reply).resolves.toMatchObject(confirmation);
    expect(tokenSignal.aborted).toBe(true);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([replyPath, tokenPath]);
  });

  it('rechecks the deadline just before the reply POST after acquiring a token', async () => {
    const token = Promise.withResolvers<Response>();
    const fetcher = vi.fn<typeof fetch>().mockReturnValueOnce(token.promise);
    const client = fastClient(base, {}, fetcher);
    const deadlineAt = Date.now() + 400;

    const reply = replyBeforeDeadline(client, deadlineAt);
    vi.setSystemTime(deadlineAt); // Simulate crossing the deadline before the timeout callback runs.
    token.resolve(Response.json(tokenPayload));
    await expect(reply).resolves.toMatchObject(confirmation);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([tokenPath]);
  });

  it('stops waiting at the reply deadline without cancelling a material read sharing the token', async () => {
    const token = Promise.withResolvers<Response>();
    const fetcher = vi.fn<typeof fetch>().mockReturnValueOnce(token.promise)
      .mockResolvedValueOnce(Response.json({ code: 0, data: { items: [{ message_id: 'om_material' }] } }));
    const client = fastClient(base, {}, fetcher);
    const material = client.getMessageItems('om_material');

    const reply = replyBeforeDeadline(client);
    await vi.advanceTimersByTimeAsync(400);
    await expect(reply).resolves.toMatchObject(confirmation);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([tokenPath]);

    token.resolve(Response.json(tokenPayload));
    await expect(material).resolves.toMatchObject([{ messageId: 'om_material' }]);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([tokenPath, messagePath]);
  });
});
