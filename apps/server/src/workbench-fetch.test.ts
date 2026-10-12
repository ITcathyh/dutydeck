import { createServer, type Server } from 'node:http';
import { getEventListeners, once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkbenchFetch, requestSignal } from './workbench-fetch.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
};

let server: Server;
let baseUrl: string;
let client: ReturnType<typeof createWorkbenchFetch>;
let received: ReturnType<typeof deferred>;
let disconnected: ReturnType<typeof deferred>;
let requestCount: number;

beforeEach(async () => {
  received = deferred();
  disconnected = deferred();
  requestCount = 0;
  server = createServer((request, response) => {
    requestCount++;
    request.on('close', disconnected.resolve);
    received.resolve();
    if (request.url === '/headers') return;
    response.writeHead(200, { 'content-type': 'text/plain' });
    if (request.url === '/body') response.write('unfinished body');
    else response.end('complete body');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server');
  baseUrl = `http://127.0.0.1:${address.port}`;
  client = createWorkbenchFetch();
});

afterEach(async () => {
  client.close();
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe('createWorkbenchFetch', () => {
  it('returns a normal response and lets its body be consumed', async () => {
    const response = await client.fetch(`${baseUrl}/ok`, { method: 'POST', body: 'input' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('complete body');
    expect(requestCount).toBe(1);
  });

  it('aborts a body still pending at the actual 15-second total deadline', async () => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => nativeTimeout(100));
    const response = await client.fetch(`${baseUrl}/body`);
    const body = response.text();
    expect(timeout).toHaveBeenCalledWith(15_000);
    await expect(body).rejects.toMatchObject({ name: expect.stringMatching(/^(AbortError|TimeoutError)$/) });
    await disconnected.promise;
  });

  it('actually cancels a request that never receives headers at its deadline', async () => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => nativeTimeout(100));
    await expect(client.fetch(`${baseUrl}/headers`)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(timeout).toHaveBeenCalledWith(15_000);
    await disconnected.promise;
  });

  it('closes an in-flight request before headers and rejects new requests', async () => {
    const pending = client.fetch(`${baseUrl}/headers`);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await received.promise;
    client.close();
    client.close();
    await rejected;
    await disconnected.promise;
    await expect(client.fetch(`${baseUrl}/ok`)).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestCount).toBe(1);
  });

  it('closes an in-flight response body after headers have arrived', async () => {
    const response = await client.fetch(`${baseUrl}/body`);
    const rejected = expect(response.text()).rejects.toMatchObject({ name: 'AbortError' });
    client.close();
    await rejected;
    await disconnected.promise;
  });

  it.each(['request', 'init'] as const)('preserves cancellation from the %s signal when both signals are supplied', async source => {
    const requestAbort = new AbortController();
    const initAbort = new AbortController();
    const request = new Request(`${baseUrl}/body`, { signal: requestAbort.signal });
    const response = await client.fetch(request, { signal: initAbort.signal });
    const rejected = expect(response.text()).rejects.toMatchObject({ name: 'AbortError' });
    (source === 'request' ? requestAbort : initAbort).abort();
    await rejected;
    await disconnected.promise;
  });
});

describe('requestSignal', () => {
  it('follows long-lived signals without adding them to AbortSignal.any and releases them at the deadline', async () => {
    const lifecycle = new AbortController();
    const any = vi.spyOn(AbortSignal, 'any');
    const signal = requestSignal([lifecycle.signal, undefined], 50);
    expect(any.mock.calls.flat(2)).not.toContain(lifecycle.signal);
    expect(getEventListeners(lifecycle.signal, 'abort')).toHaveLength(1);
    await vi.waitFor(() => expect(signal.reason).toMatchObject({ name: 'TimeoutError' }));
    expect(getEventListeners(lifecycle.signal, 'abort')).toHaveLength(0);
  });

  it('aborts with the reason of the long-lived signal, including one aborted before the request', () => {
    const lifecycle = new AbortController();
    const signal = requestSignal([lifecycle.signal], 15_000);
    const reason = new Error('closed');
    lifecycle.abort(reason);
    expect(signal.reason).toBe(reason);
    expect(requestSignal([new AbortController().signal, lifecycle.signal], 15_000).reason).toBe(reason);
  });

  it('keeps the workbench lifecycle signal out of AbortSignal.any for every request', async () => {
    const any = vi.spyOn(AbortSignal, 'any');
    for (let index = 0; index < 3; index++) await (await client.fetch(`${baseUrl}/ok`)).text();
    expect(any).toHaveBeenCalledTimes(3);
    expect(any.mock.calls.flat(2)).not.toContain(client.fetch.signal);
  });
});
