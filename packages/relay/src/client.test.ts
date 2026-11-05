import { createServer, type ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { RelayHttpClient } from './client.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0)) await close(); });

async function slowServer() {
  let held: ServerResponse | undefined;
  const server = createServer((_request, response) => { held = response; });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/api/relay`, held: () => held };
}

it('keeps a long ask open past the 300 second response-header limit of the built-in fetch', async () => {
  const server = await slowServer();
  const client = new RelayHttpClient({ env: { dutydeck_relay_url: server.url, dutydeck_relay_token: 'fixture-token' } });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  let failure: unknown;
  const pending = client.post('/sessions/self/ask', { question: 'q', timeoutMs: 600_000 }, 630_000).catch(error => { failure = error; });
  await vi.waitFor(() => expect(server.held()).toBeDefined());
  await vi.advanceTimersByTimeAsync(310_000);
  await new Promise(resolve => setImmediate(resolve));
  expect(failure).toBeUndefined();
  server.held()!.setHeader('content-type', 'application/json');
  server.held()!.end(JSON.stringify({ status: 'answered', answer: 'ok' }));
  expect(await pending).toEqual({ status: 'answered', answer: 'ok' });
  expect(failure).toBeUndefined();
});

it('still bounds a request by the caller deadline', async () => {
  const server = await slowServer();
  const client = new RelayHttpClient({ env: { dutydeck_relay_url: server.url, dutydeck_relay_token: 'fixture-token' } });
  await expect(client.post('/sessions/self/send', { text: 'x' }, 200)).rejects.toMatchObject({ code: 'RELAY_UNAVAILABLE', exitCode: 3 });
});
