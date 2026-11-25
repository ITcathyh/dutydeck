import { afterEach, describe, expect, it } from 'vitest';
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

async function startStub(handler: Handler, tokenMode: 'static' | 'rotating' = 'static'): Promise<Stub> {
  const requests: Stub['requests'] = [];
  let tokenCalls = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = req.url ?? '/';
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
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const fastClient = (stub: Stub, extra: Record<string, any> = {}) => new LarkApiClient({
  appId: 'cli_x', appSecret: 'secret', baseUrl: stub.baseUrl, timeoutMs: 1_000,
  retryBaseMs: 2, rateLimitRetries: 2, ...extra,
});

let stub: Stub | undefined;
afterEach(async () => { if (stub) await stub.close(); stub = undefined; });

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
});
