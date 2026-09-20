import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AUTH_TOKEN_CONFIG_KEY } from '../auth/auth.js';
import type { DaemonState } from '../daemon/daemon.js';
import { syncLarkListener } from './listener-cli.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function harness() {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-listener-cli-'));
  roots.push(root);
  const database = join(root, 'state.db');
  writeFileSync(database, 'fixture');
  const config = { get: vi.fn(async () => 'PRIVATE_ACCESS_TOKEN'), set: vi.fn(async () => {}) };
  const state: DaemonState = { pid: process.pid, ready: true, cwd: root, database, address: 'http://127.0.0.1:4317', startedAt: 'now' };
  const fetcher = vi.fn(async () => Response.json({ appId: 'cli_bot', listening: true, activeListening: true }));
  const readState = vi.fn((): DaemonState | undefined => state);
  return { root, config, state, context: { config, database }, dependencies: { readState, fetcher }, fetcher };
}

it('authenticates a same-database local sync and confirms the exact app without persisting anything', async () => {
  const h = harness();
  const alias = join(h.root, 'alias.db');
  symlinkSync(h.context.database, alias);
  h.state.database = 'alias.db';
  expect(await syncLarkListener('cli_bot', h.context, h.dependencies)).toMatchObject({ activeListening: true });
  expect(h.config.get).toHaveBeenCalledWith(AUTH_TOKEN_CONFIG_KEY);
  expect(h.fetcher).toHaveBeenCalledWith('http://127.0.0.1:4317/api/lark/bots/cli_bot/listener/sync', expect.objectContaining({
    method: 'POST', body: '{}', redirect: 'error', signal: expect.any(AbortSignal),
    headers: { 'content-type': 'application/json', authorization: 'Bearer PRIVATE_ACCESS_TOKEN' },
  }));
  expect(h.config.set).not.toHaveBeenCalled();
});

it('allows a bound local network interface without sending credentials to arbitrary remote hosts', async () => {
  const h = harness();
  h.state.address = 'http://10.37.33.49:4317';
  const interfaces = () => ({ eth0: [{ address: '10.37.33.49', family: 'IPv4' as const, netmask: '255.255.0.0', mac: '00:00:00:00:00:00', internal: false, cidr: '10.37.33.49/16' }] });
  expect(await syncLarkListener('cli_bot', h.context, { ...h.dependencies, interfaces })).toMatchObject({ activeListening: true });
  expect(h.fetcher).toHaveBeenCalledWith(expect.stringContaining('http://10.37.33.49:4317/'), expect.anything());
});

it.each(['http://remote.example:4317', 'http://10.37.33.50:4317', 'http://127.0.0.1.evil.test', 'http://user:pass@127.0.0.1:4317', 'file:///tmp/server', 'http://0.0.0.0:4317'])('rejects unsafe daemon address %s before reading credentials', async address => {
  const h = harness(); h.state.address = address;
  expect(await syncLarkListener('cli_bot', h.context, { ...h.dependencies, interfaces: () => ({}) })).toMatchObject({ activeListening: false });
  expect(h.config.get).not.toHaveBeenCalled(); expect(h.fetcher).not.toHaveBeenCalled();
});

it.each(['http://localhost:4317', 'http://[::1]:4317', 'http://127.0.0.2:4317'])('accepts loopback address %s', async address => {
  const h = harness(); h.state.address = address;
  expect(await syncLarkListener('cli_bot', h.context, h.dependencies)).toMatchObject({ activeListening: true });
});

it('rejects a different database before reading credentials or sending any request', async () => {
  const h = harness();
  h.state.database = join(h.root, 'other.db'); writeFileSync(h.state.database, 'different');
  expect(await syncLarkListener('cli_bot', h.context, h.dependencies)).toMatchObject({ activeListening: false, message: expect.stringContaining('数据库') });
  expect(h.config.get).not.toHaveBeenCalled(); expect(h.fetcher).not.toHaveBeenCalled();
});

it.each(['absent', 'not_ready', 'dead'] as const)('does not connect when daemon is %s', async kind => {
  const h = harness();
  if (kind === 'absent') h.dependencies.readState.mockReturnValue(undefined);
  if (kind === 'not_ready') h.state.ready = false;
  if (kind === 'dead') h.state.pid = -1;
  expect(await syncLarkListener('cli_bot', h.context, h.dependencies)).toMatchObject({ activeListening: false, message: expect.stringContaining('启动服务') });
  expect(h.fetcher).not.toHaveBeenCalled(); expect(h.config.get).not.toHaveBeenCalled();
});

it('does not load or send a token when daemon authentication is disabled', async () => {
  const h = harness(); h.state.authEnabled = false;
  expect(await syncLarkListener('cli_bot', h.context, h.dependencies)).toMatchObject({ activeListening: true });
  expect(h.config.get).not.toHaveBeenCalled();
  expect(h.fetcher).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ headers: { 'content-type': 'application/json' } }));
});

it('requires an existing token without creating one', async () => {
  const h = harness(); h.config.get.mockResolvedValue('');
  expect(await syncLarkListener('cli_bot', h.context, h.dependencies)).toMatchObject({ activeListening: false });
  expect(h.config.set).not.toHaveBeenCalled(); expect(h.fetcher).not.toHaveBeenCalled();
});

it.each([404, 401, 409, 503])('reports HTTP %s without echoing credential-bearing response bodies', async status => {
  const h = harness(); h.fetcher.mockResolvedValue(Response.json({ error: 'PRIVATE_ACCESS_TOKEN' }, { status }));
  const result = await syncLarkListener('cli_bot', h.context, h.dependencies);
  expect(result.activeListening).toBe(false);
  expect(result.message).toContain(status === 404 ? '升级服务' : `HTTP ${status}`);
  expect(result.message).not.toContain('PRIVATE_ACCESS_TOKEN');
});

it.each([{ appId: 'other', listening: true, activeListening: true }, { appId: 'cli_bot', listening: true, activeListening: false }, { appId: 'cli_bot', activeListening: true }, null])('does not claim a connection from an incomplete response %j', async response => {
  const h = harness(); h.fetcher.mockResolvedValue(Response.json(response));
  expect(await syncLarkListener('cli_bot', h.context, h.dependencies)).toMatchObject({ activeListening: false });
});

it('redacts request errors and passes a bounded abort signal to the request', async () => {
  const h = harness(); h.fetcher.mockRejectedValue(new Error('timeout PRIVATE_ACCESS_TOKEN'));
  const result = await syncLarkListener('cli_bot', h.context, h.dependencies);
  expect(result).toMatchObject({ activeListening: false, message: expect.stringContaining('超时') });
  expect(result.message).not.toContain('PRIVATE_ACCESS_TOKEN');
  expect(h.fetcher).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ signal: expect.any(AbortSignal), redirect: 'error' }));
});
