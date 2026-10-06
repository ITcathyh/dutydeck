import { afterEach, describe, expect, it, vi } from 'vitest';
import { get as httpGet, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createRepositories } from '@dutydeck/storage';
import { buildApp } from './app.js';
import { AUTH_COOKIE_NAME, getShareLinkSecret, SHARE_LINK_SECRET_CONFIG_KEY, signSessionShareToken, type AuthMiddlewareOptions } from './auth/auth.js';

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const event = (sequence: number, text = `output-${sequence}`) => ({ id: `e${sequence}`, sessionId: 's1', sequence, type: 'text', timestamp: '2026-10-06T00:00:00.000Z', data: { text } });

async function server(options: { mode?: 'local' | 'open' | 'token'; getShareSecret?: AuthMiddlewareOptions['getShareSecret']; replay?: (id: string, options: any) => Promise<any[]>; instances?: any[] } = {}) {
  let secret = 'before';
  let listener = (_event: any) => {};
  const unsubscribe = vi.fn();
  const getShareSecret = vi.fn(options.getShareSecret ?? (async () => secret));
  const runtime: any = {
    getEventWindow: vi.fn(options.replay ?? (async () => [])),
    subscribe: vi.fn((_id: string, next: typeof listener) => { listener = next; return unsubscribe; })
  };
  const mode = options.mode ?? 'token';
  const app = await buildApp(runtime, { instances: options.instances, auth: { mode, localOnly: mode === 'local', getToken: async () => 'admin', getShareSecret } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  cleanup.push(() => app.close());
  return { app, runtime, unsubscribe, getShareSecret, url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, emit: (next: any) => listener(next), rotate: () => { secret = 'after'; }, token: () => signSessionShareToken(secret, 's1') };
}

async function stream(url: string, pause = false) {
  let text = '', closed = false;
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpGet(url, { headers: { cookie: `${AUTH_COOKIE_NAME}=admin` } }, resolve);
    request.on('error', reject);
    cleanup.push(() => request.destroy());
  });
  response.on('data', chunk => { text += chunk.toString(); });
  response.on('error', () => {}); // Revocation deliberately aborts the HTTP response.
  response.once('close', () => { closed = true; });
  cleanup.push(() => response.destroy());
  if (pause) response.pause();
  else await vi.waitFor(() => expect(text).toContain(': connected'));
  return { response, text: () => text, closed: () => closed };
}

async function expectRevoked(s: Awaited<ReturnType<typeof stream>>, unsubscribe: ReturnType<typeof vi.fn>) {
  await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce(), { timeout: 2_500 });
  await vi.waitFor(() => expect(s.closed()).toBe(true), { timeout: 2_500 });
}

describe('share stream revocation', () => {
  it('observes another process rotating the SQLite share key before further output and accepts the new token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dutydeck-share-stream-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const filename = join(dir, 'dutydeck.db');
    const repositories = createRepositories(filename);
    cleanup.push(() => repositories.close());
    await repositories.config.set(SHARE_LINK_SECRET_CONFIG_KEY, 'before');
    const peer = await server({ getShareSecret: () => getShareLinkSecret(repositories.config) });
    const oldToken = signSessionShareToken('before', 's1');
    const s = await stream(`${peer.url}/api/sessions/s1/stream?share=${oldToken}`);
    peer.emit(event(1));
    await vi.waitFor(() => expect(s.text()).toContain('output-1'));
    const require = createRequire(import.meta.url);
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import Database from ${JSON.stringify(require.resolve('better-sqlite3'))};
      import { runShareKeyRotateCommand } from ${JSON.stringify(new URL('./auth/auth.ts', import.meta.url).href)};
      const db = new Database(process.argv[1]);
      await runShareKeyRotateCommand({ set: async (key, value) => { db.prepare('UPDATE configs SET value = ? WHERE key = ?').run(value, key); } });
      db.close();
    `, filename]);
    peer.emit(event(2, 'REVOKED_OUTPUT'));
    await expectRevoked(s, peer.unsubscribe);
    expect(s.text()).not.toContain('REVOKED_OUTPUT');
    expect((await peer.app.inject({ url: `/api/sessions/s1/events?share=${oldToken}`, headers: { cookie: `${AUTH_COOKIE_NAME}=admin` } })).statusCode).toBe(401);
    const newToken = signSessionShareToken((await getShareLinkSecret(repositories.config))!, 's1');
    const next = await stream(`${peer.url}/api/sessions/s1/stream?share=${newToken}`);
    peer.emit(event(3));
    await vi.waitFor(() => expect(next.text()).toContain('output-3'));
  });

  it.each(['local', 'open', 'token'] as const)('closes an idle %s share stream within the polling bound despite an administrator cookie', async mode => {
    const peer = await server({ mode });
    const s = await stream(`${peer.url}/api/sessions/s1/stream?share=${peer.token()}`);
    const rotatedAt = performance.now();
    peer.rotate();
    await expectRevoked(s, peer.unsubscribe);
    expect(performance.now() - rotatedAt).toBeLessThan(1_500);
  });

  it.each([0, 1])('does not disclose replay or buffered live events after rotation during a storage await (cursor %i)', async after => {
    let finish!: (events: any[]) => void;
    const replay = new Promise<any[]>(resolve => { finish = resolve; });
    const peer = await server({ replay: async () => replay });
    const s = await stream(`${peer.url}/api/sessions/s1/stream?after=${after}&share=${peer.token()}`);
    peer.emit(event(4, 'BUFFERED_REVOKED'));
    peer.rotate();
    finish([event(3, 'REPLAY_REVOKED')]);
    await expectRevoked(s, peer.unsubscribe);
    expect(s.text()).not.toContain('REVOKED');
  });

  it('interrupts a backpressured replay without loading another batch or waiting for drain', async () => {
    const peer = await server({ replay: async () => Array.from({ length: 1_000 }, (_, index) => event(index + 2, 'x'.repeat(32 * 1_024))) });
    let raw!: ServerResponse;
    peer.app.server.once('request', (_request, response) => { raw = response; });
    const s = await stream(`${peer.url}/api/sessions/s1/stream?after=1&share=${peer.token()}`, true);
    await vi.waitFor(() => expect(raw.writableNeedDrain).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(raw.writableNeedDrain).toBe(true);
    expect(raw.listenerCount('drain')).toBe(1);
    expect(peer.runtime.getEventWindow).toHaveBeenCalledTimes(1);
    peer.rotate();
    await vi.waitFor(() => expect(peer.unsubscribe).toHaveBeenCalledOnce(), { timeout: 2_500 });
    expect(peer.runtime.getEventWindow).toHaveBeenCalledTimes(1);
    s.response.resume();
    await vi.waitFor(() => expect(s.closed()).toBe(true));
  });

  it('closes during a backpressured live pump and clears queued output without waiting for drain', async () => {
    const peer = await server();
    let raw!: ServerResponse;
    peer.app.server.once('request', (_request, response) => { raw = response; });
    const s = await stream(`${peer.url}/api/sessions/s1/stream?share=${peer.token()}`);
    s.response.pause();
    for (let i = 1; i <= 500; i++) peer.emit(event(i, 'x'.repeat(32 * 1_024)));
    await vi.waitFor(() => expect(raw.writableNeedDrain).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(raw.writableNeedDrain).toBe(true);
    expect(raw.listenerCount('drain')).toBe(1);
    peer.rotate();
    peer.emit(event(501, 'REVOKED_QUEUED'));
    await vi.waitFor(() => expect(peer.unsubscribe).toHaveBeenCalledOnce(), { timeout: 2_500 });
    s.response.resume();
    await vi.waitFor(() => expect(s.closed()).toBe(true));
    expect(s.text()).not.toContain('REVOKED_QUEUED');
    expect(raw.listenerCount('drain')).toBe(0);
  });

  it('fails closed when an idle polling read fails', async () => {
    let fail = false;
    const peer = await server({ getShareSecret: async () => {
      if (fail) throw new Error('storage unavailable');
      return 'before';
    } });
    const s = await stream(`${peer.url}/api/sessions/s1/stream?share=${peer.token()}`);
    fail = true;
    await expectRevoked(s, peer.unsubscribe);
  });

  it('does not resume writing when a credential read finishes after client cleanup', async () => {
    let pending = false, finish!: (secret: string) => void;
    const peer = await server({ getShareSecret: async () => pending ? new Promise<string>(resolve => { finish = resolve; }) : 'before' });
    const s = await stream(`${peer.url}/api/sessions/s1/stream?share=${peer.token()}`);
    pending = true;
    peer.emit(event(1, 'LATE_OUTPUT'));
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    s.response.destroy();
    await vi.waitFor(() => expect(peer.unsubscribe).toHaveBeenCalledOnce());
    finish('before');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(s.text()).not.toContain('LATE_OUTPUT');
    expect(peer.unsubscribe).toHaveBeenCalledOnce();
  });

  it.each(['reject', 'hang'] as const)('fails closed on a %s secret getter without accumulating checks or writing after a late result', async failure => {
    let fail = false, finish!: (secret: string) => void;
    const peer = await server({ getShareSecret: async () => {
      if (!fail) return 'before';
      if (failure === 'reject') throw new Error('storage unavailable');
      return new Promise<string>(resolve => { finish = resolve; });
    } });
    const s = await stream(`${peer.url}/api/sessions/s1/stream?share=${peer.token()}`);
    const calls = peer.getShareSecret.mock.calls.length;
    fail = true;
    for (let i = 1; i <= 20; i++) peer.emit(event(i, 'REVOKED_LATE'));
    await expectRevoked(s, peer.unsubscribe);
    expect(peer.getShareSecret.mock.calls.length).toBe(calls + 1);
    finish?.('before');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(s.text()).not.toContain('REVOKED_LATE');
    expect(peer.unsubscribe).toHaveBeenCalledOnce();
  });

  it('keeps normal shares ordered through replay/live overlap and does not recheck administrator streams', async () => {
    let peer!: Awaited<ReturnType<typeof server>>;
    peer = await server({ replay: async () => { peer.emit(event(3)); peer.emit(event(2)); return [event(1), event(2)]; } });
    const shared = await stream(`${peer.url}/api/sessions/s1/stream?share=${peer.token()}`);
    await vi.waitFor(() => expect(shared.text()).toContain('output-3'));
    expect([...shared.text().matchAll(/^id: (\d+)/gm)].map(match => Number(match[1]))).toEqual([1, 2, 3]);
    await new Promise(resolve => setTimeout(resolve, 1_100));
    peer.emit(event(4));
    await vi.waitFor(() => expect(shared.text()).toContain('output-4'));
    expect(shared.closed()).toBe(false);
    shared.response.destroy();
    await vi.waitFor(() => expect(peer.unsubscribe).toHaveBeenCalledOnce());
    peer.runtime.getEventWindow.mockResolvedValue([]);
    const admin = await stream(`${peer.url}/api/sessions/s1/stream`);
    const calls = peer.getShareSecret.mock.calls.length;
    peer.rotate();
    await new Promise(resolve => setTimeout(resolve, 1_100));
    peer.emit(event(5));
    await vi.waitFor(() => expect(admin.text()).toContain('output-5'));
    expect(admin.closed()).toBe(false);
    expect(peer.getShareSecret.mock.calls.length).toBe(calls);
  });

  it('propagates revocation from a real owning peer to the shared proxy connection', async () => {
    const peer = await server({ mode: 'local' });
    const main = await server({ instances: [{ id: 'peer', name: 'Peer', url: peer.url }] });
    const s = await stream(`${main.url}/api/instances/peer/sessions/s1/stream?share=${peer.token()}`);
    peer.emit(event(1));
    await vi.waitFor(() => expect(s.text()).toContain('output-1'));
    peer.rotate();
    peer.emit(event(2, 'REVOKED_PROXY'));
    await expectRevoked(s, peer.unsubscribe);
    expect(s.text()).not.toContain('REVOKED_PROXY');
    expect((await fetch(`${main.url}/api/instances/peer/sessions/s1/events?share=${signSessionShareToken('before', 's1')}`)).status).toBe(401);
    const next = await stream(`${main.url}/api/instances/peer/sessions/s1/stream?share=${peer.token()}`);
    peer.emit(event(3));
    await vi.waitFor(() => expect(next.text()).toContain('output-3'));
  });
});
