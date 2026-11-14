import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { startAcceptedResponseLossProxy } from './send-idempotency-proxy.js';

describe('accepted response loss proxy', () => {
  it('does not consume the drop allowance on a rejected send, then drops the first accepted response', async () => {
    let sends = 0;
    const upstream = http.createServer((request, response) => {
      if (request.method !== 'POST' || request.url !== '/api/sessions/s1/send') {
        response.writeHead(404).end();
        return;
      }
      sends++;
      response.setHeader('content-type', 'application/json');
      response.setHeader('connection', 'close');
      if (sends === 1) response.writeHead(400).end(JSON.stringify({ accepted: false, error: { code: 'BAD_SEND' } }));
      else response.writeHead(202).end(JSON.stringify({ accepted: true, task: { id: 'task-1' } }));
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const proxy = await startAcceptedResponseLossProxy((upstream.address() as AddressInfo).port);
    const send = () => fetch(`${proxy.baseUrl}/api/sessions/s1/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ prompt: 'test', mode: 'queue', idempotencyKey: 'request-1' })
    });
    try {
      const rejected = await send();
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ accepted: false });
      expect(proxy.exchanges).toHaveLength(1);
      expect(proxy.exchanges[0]).toMatchObject({ responseStatus: 400, dropped: false });

      const truncated = await send();
      expect(truncated.status).toBe(202);
      await expect(truncated.json()).rejects.toThrow();
      expect(proxy.exchanges).toHaveLength(2);
      expect(proxy.exchanges[1]).toMatchObject({ responseStatus: 202, dropped: true });
      expect(proxy.exchanges[1]?.responseBody).toMatchObject({ accepted: true, task: { id: 'task-1' } });
    } finally {
      await proxy.close();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });

  it('drops exactly one of two concurrent accepted responses', async () => {
    const pending: http.ServerResponse[] = [];
    const upstream = http.createServer((request, response) => {
      if (request.method !== 'POST' || request.url !== '/api/sessions/s1/send') {
        response.writeHead(404).end();
        return;
      }
      pending.push(response);
      if (pending.length !== 2) return;
      for (const [index, item] of pending.splice(0).entries()) {
        item.writeHead(202, { 'content-type': 'application/json', connection: 'close' });
        item.end(JSON.stringify({ accepted: true, task: { id: `task-${index + 1}` } }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const proxy = await startAcceptedResponseLossProxy((upstream.address() as AddressInfo).port);
    const send = () => fetch(`${proxy.baseUrl}/api/sessions/s1/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ prompt: 'concurrent', mode: 'queue', idempotencyKey: 'request-1' })
    });
    try {
      const responses = await Promise.all([send(), send()]);
      const bodies = await Promise.all(responses.map(response => response.json().catch(() => undefined)));
      expect(responses.map(response => response.status)).toEqual([202, 202]);
      expect(bodies.filter(body => body === undefined)).toHaveLength(1);
      expect(proxy.exchanges).toHaveLength(2);
      expect(proxy.exchanges.filter(exchange => exchange.dropped)).toHaveLength(1);
      expect(proxy.exchanges.every(exchange => exchange.responseBody?.accepted === true)).toBe(true);
    } finally {
      await proxy.close();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });
});
