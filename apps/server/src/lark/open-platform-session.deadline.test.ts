import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { connectLarkOpenPlatformSession, writeOpenPlatformSessionCookies } from './open-platform-session.js';
import { OpenPlatformConfigurationJobManager } from './open-platform-jobs.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(dripPath: string) {
  const directory = mkdtempSync(join(tmpdir(), 'dutydeck-open-platform-deadline-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const sessionFilePath = join(directory, 'session.json');
  const pending = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    if (path === dripPath) {
      pending.add(response);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{');
      const timer = setInterval(() => response.write(' '), 10);
      response.on('close', () => { clearInterval(timer); pending.delete(response); });
      return;
    }
    if (path === '/app') {
      response.end('<script>window.csrfToken="fixture-csrf";window.user={"id":"user","name":"Alice","tenantId":"tenant","tenantName":"Test"};</script>');
      return;
    }
    response.setHeader('content-type', 'application/json');
    if (path === '/accounts/qrlogin/init') {
      response.setHeader('x-flow-key', 'fixture-flow');
      response.end(JSON.stringify({ code: 0, data: { step_info: { token: 'fixture-qr' } } }));
      return;
    }
    response.end(JSON.stringify({ code: 0 }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const port = (server.address() as { port: number }).port;
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
  };
  const cache = () => writeOpenPlatformSessionCookies(sessionFilePath, [{
    name: 'session', value: 'fixture', domain: '.feishu.cn', path: '/', secure: true, httpOnly: true, hostOnly: false,
  }]);
  return { sessionFilePath, fetchImpl, pending, cache };
}

it('ends a dripping QR response and releases the configuration slot for another app', async () => {
  const f = await fixture('/accounts/qrlogin/init');
  const configure = vi.fn();
  const manager = new OpenPlatformConfigurationJobManager({
    connect: options => connectLarkOpenPlatformSession({ ...options, sessionFilePath: f.sessionFilePath, fetchImpl: f.fetchImpl, requestTimeoutMs: 100 }),
    configure,
  });
  const first = manager.start('cli_first', { forceLogin: true });
  expect(() => manager.start('cli_second')).toThrow('仍在进行');
  await expect(manager.wait(first.id)).resolves.toMatchObject({ status: 'failed', error: '开放平台请求超时' });
  expect(configure).not.toHaveBeenCalled();
  const second = manager.start('cli_second', { forceLogin: true });
  await expect(manager.wait(second.id)).resolves.toMatchObject({ status: 'failed' });
  await vi.waitFor(() => expect(f.pending.size).toBe(0));
}, 2_000);

it('bounds the cached console body read before falling back to login', async () => {
  const f = await fixture('/app'); f.cache();
  await expect(connectLarkOpenPlatformSession({ ...f, allowQrLogin: false, requestTimeoutMs: 100 })).rejects.toThrow('本机登录态不可用');
  await vi.waitFor(() => expect(f.pending.size).toBe(0));
}, 2_000);

it('preserves an unknown write outcome when its JSON body never ends', async () => {
  const f = await fixture('/developers/v1/test'); f.cache();
  const { client } = await connectLarkOpenPlatformSession({ ...f, requestTimeoutMs: 100 });
  await expect(client.postJson('/developers/v1/test', {})).rejects.toThrow('开放平台请求超时');
  await vi.waitFor(() => expect(f.pending.size).toBe(0));
}, 2_000);

it('limits a dripping poll body to the remaining QR wait budget', async () => {
  const f = await fixture('/accounts/qrlogin/polling');
  await expect(connectLarkOpenPlatformSession({ ...f, forceLogin: true, requestTimeoutMs: 10_000, maxWaitMs: 100, pollIntervalMs: 0 })).rejects.toThrow('开放平台请求超时');
  await vi.waitFor(() => expect(f.pending.size).toBe(0));
}, 2_000);
