import { spawn } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { RelayHttpClient } from './client.js';
import { targetGuard } from '../../../tests/support/target-server.js';

const relayCall = () => targetGuard(request => request.method === 'POST' && request.url!.startsWith('/api/relay/sessions/self/'));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0)) await close(); });

async function slowServer() {
  let held: ServerResponse | undefined;
  const guard = relayCall();
  const server = createServer((request, response) => { if (guard.accept(request, response)) held = response; });
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

it('lets the CLI process exit right after the response instead of holding a keep-alive socket', async () => {
  const guard = relayCall();
  const server = createServer((request, response) => {
    if (!guard.accept(request, response)) return;
    request.resume(); request.on('end', () => { response.setHeader('content-type', 'application/json'); response.end('{"ok":true}'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const { port } = server.address() as { port: number };
  const script = `import { RelayHttpClient } from ${JSON.stringify(fileURLToPath(new URL('./client.ts', import.meta.url)))};
await new RelayHttpClient({ env: { dutydeck_relay_url: 'http://127.0.0.1:${port}/api/relay', dutydeck_relay_token: 't' } }).post('/sessions/self/send', { text: 'x' });
process.stdout.write(String(Date.now()));`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: fileURLToPath(new URL('../../../', import.meta.url)) });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  const exitedAt = await new Promise<number>(resolve => child.on('exit', () => resolve(Date.now())));
  expect(Number(stdout)).toBeGreaterThan(0);
  expect(exitedAt - Number(stdout)).toBeLessThan(500);
}, 30_000);

it('waits for a restarting service when the connection is refused, then delivers once', async () => {
  // 先占一个端口再释放，得到当前没人监听的地址；服务稍后在同一端口起来，模拟部署重启。
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const received: string[] = [];
  let restarted: (() => Promise<void>) | undefined;
  const sleeps: number[] = [];
  const client = new RelayHttpClient({
    env: { dutydeck_relay_url: `http://127.0.0.1:${port}/api/relay`, dutydeck_relay_token: 't' },
    sleep: async ms => {
      sleeps.push(ms);
      if (sleeps.length === 2) await restarted?.();
    }
  });
  restarted = async () => {
    const server = createServer((request, response) => {
      let text = '';
      request.on('data', chunk => { text += chunk; });
      request.on('end', () => { if (request.url === '/api/relay/sessions/self/send') received.push(text); response.setHeader('content-type', 'application/json'); response.end('{"ok":true}'); });
    });
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  };
  expect(await client.post('/sessions/self/send', { text: 'x' })).toEqual({ ok: true });
  expect(received).toEqual([JSON.stringify({ text: 'x' })]);
  expect(sleeps).toEqual([1_000, 1_000]);
});

it('does not retry errors other than a refused connection', async () => {
  const fetcher = vi.fn(async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); }) as unknown as typeof fetch;
  const sleep = vi.fn(async () => {});
  const client = new RelayHttpClient({ env: { dutydeck_relay_url: 'http://127.0.0.1:1/api/relay', dutydeck_relay_token: 't' }, fetcher, sleep });
  await expect(client.post('/sessions/self/send', { text: 'x' })).rejects.toMatchObject({ code: 'RELAY_UNAVAILABLE' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});

it('stops retrying a refused connection at the caller deadline', async () => {
  const fetcher = vi.fn(async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); }) as unknown as typeof fetch;
  const client = new RelayHttpClient({ env: { dutydeck_relay_url: 'http://127.0.0.1:1/api/relay', dutydeck_relay_token: 't' }, fetcher, sleep: async () => {} });
  // 期限不足一次重试间隔：只尝试一次就报不可用。
  await expect(client.post('/sessions/self/send', { text: 'x' }, 500)).rejects.toMatchObject({ code: 'RELAY_UNAVAILABLE', exitCode: 3 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
