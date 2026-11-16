import { currentProcessIdentity } from '@dutydeck/storage/helpers';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundleCliForTest } from '../../../../tests/support/bundle-for-test.js';
import { daemonStatus, daemonStatusWithForeground } from './command.js';
import { daemonPaths, defaultDaemonDir, writeState } from './daemon.js';

const servers: Server[] = [];
let tmp: string;
let dir: string;
let cli: string;
let cleanupCli: (() => Promise<void>) | undefined;

beforeAll(async () => { ({ path: cli, cleanup: cleanupCli } = await bundleCliForTest('foreground-status')); }, 60_000);
afterAll(async () => { await cleanupCli?.(); });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dutydeck-foreground-status-'));
  dir = defaultDaemonDir(tmp);
  vi.spyOn(process, 'cwd').mockReturnValue(tmp);
  vi.stubEnv('HOME', tmp);
  vi.stubEnv('DUTYDECK_DAEMON_DIR', dir);
  vi.stubEnv('DUTYDECK_HOST', '127.0.0.1');
  vi.stubEnv('DUTYDECK_PORT', '14310');
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

async function localServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', () => resolve()));
  return (server.address() as AddressInfo).port;
}

const healthResponse = (body: unknown, init: ResponseInit = {}) => Response.json(body, {
  ...init,
  headers: { 'x-dutydeck-product': 'dutydeck', ...init.headers }
});

const oldFields = () => {
  const { running, processStatus, error, ready, address, pid, logFile, startedAt, authEnabled, authentication } = daemonStatus();
  return { running, processStatus, error, ready, address, pid, logFile, startedAt, authEnabled, authentication };
};

describe('unregistered foreground status probe', () => {
  it('adds only unregisteredForeground after both strict health shapes pass', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(healthResponse({ ok: true }))
      .mockResolvedValueOnce(healthResponse({ ok: true, ready: true, pending: [] }));
    const result = await daemonStatusWithForeground(process.env, { fetch: fetcher, requestTimeoutMs: 50 });
    expect(result).toEqual({ ...oldFields(), unregisteredForeground: { address: 'http://127.0.0.1:14310', ready: true } });
    expect(result.running).toBe(false);
    expect(result.processStatus).toBe('stale');
    expect(result.ready).toBe(false);
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/health', '/health/ready']);
    expect(fetcher.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true);
  });

  it('reports a structurally valid but unready foreground without changing legacy ready', async () => {
    const result = await daemonStatusWithForeground(process.env, {
      fetch: vi.fn()
        .mockResolvedValueOnce(healthResponse({ ok: true }))
        .mockResolvedValueOnce(healthResponse({ ok: true, ready: false, pending: ['listener pending'] })),
      requestTimeoutMs: 50
    });
    expect(result.unregisteredForeground).toEqual({ address: 'http://127.0.0.1:14310', ready: false });
    expect(result.ready).toBe(false);
    expect(result.running).toBe(false);
  });

  it.each([
    ['legacy generic health without a product header', () => Response.json({ ok: true }), () => Response.json({ ok: true, ready: true, pending: [] })],
    ['readiness without a product header', () => healthResponse({ ok: true }), () => Response.json({ ok: true, ready: true, pending: [] })],
    ['generic ok readiness', () => healthResponse({ ok: true }), () => healthResponse({ ok: true })],
    ['non-Dutydeck health body', () => healthResponse({ status: 'ok' }), () => healthResponse({ ok: true, ready: true, pending: [] })],
    ['HTML health', () => new Response('<html>ok</html>', { headers: { 'content-type': 'text/html' } }), () => healthResponse({ ok: true, ready: true, pending: [] })],
    ['health HTTP error', () => healthResponse({ ok: true }, { status: 503 }), () => healthResponse({ ok: true, ready: true, pending: [] })],
    ['redirect', () => new Response(null, { status: 302, headers: { location: 'http://example.invalid/health' } }), () => healthResponse({ ok: true, ready: true, pending: [] })],
    ['ready missing ok', () => healthResponse({ ok: true }), () => healthResponse({ ready: true, pending: [] })],
    ['ready non-boolean', () => healthResponse({ ok: true }), () => healthResponse({ ok: true, ready: 'true', pending: [] })],
    ['pending not an array', () => healthResponse({ ok: true }), () => healthResponse({ ok: true, ready: false, pending: 'listener' })],
    ['pending with non-string', () => healthResponse({ ok: true }), () => healthResponse({ ok: true, ready: false, pending: ['listener', 1] })]
  ])('leaves the original status for %s', async (_name, health, ready) => {
    const fetcher = vi.fn().mockImplementationOnce(health).mockImplementationOnce(ready);
    const result = await daemonStatusWithForeground(process.env, { fetch: fetcher, requestTimeoutMs: 50 });
    expect(result).toEqual(oldFields());
    expect(result.unregisteredForeground).toBeUndefined();
  });

  it('does not request readiness when health is invalid', async () => {
    const fetcher = vi.fn().mockResolvedValue(healthResponse({ ok: false }));
    await expect(daemonStatusWithForeground(process.env, { fetch: fetcher, requestTimeoutMs: 50 })).resolves.toEqual(oldFields());
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['health', 'ready'])('contains a rejected %s request without an unhandled rejection', async endpoint => {
    const fetcher = vi.fn().mockImplementation(async () => {
      if (endpoint === 'health' || fetcher.mock.calls.length > 1) throw new DOMException('timed out', 'TimeoutError');
      return healthResponse({ ok: true });
    });
    await expect(daemonStatusWithForeground(process.env, { fetch: fetcher, requestTimeoutMs: 50 })).resolves.toEqual(oldFields());
  });

  it('keeps the original status on connection refusal and a real short timeout', async () => {
    const refusedPort = await localServer((_req, res) => res.end());
    const refused = servers.splice(0, 1)[0]!;
    refused.closeAllConnections();
    await new Promise<void>(resolve => refused.close(() => resolve()));
    vi.stubEnv('DUTYDECK_PORT', String(refusedPort));
    await expect(daemonStatusWithForeground(process.env, { requestTimeoutMs: 100 })).resolves.toEqual(oldFields());

    const hangingPort = await localServer(() => {});
    vi.stubEnv('DUTYDECK_PORT', String(hangingPort));
    const started = Date.now();
    await expect(daemonStatusWithForeground(process.env, { requestTimeoutMs: 50 })).resolves.toEqual(oldFields());
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('does not probe a remote configured host, but accepts an explicitly local interface', async () => {
    vi.stubEnv('DUTYDECK_HOST', '192.0.2.123');
    const fetcher = vi.fn();
    await expect(daemonStatusWithForeground(process.env, { fetch: fetcher })).resolves.toEqual(oldFields());
    expect(fetcher).not.toHaveBeenCalled();

    const local = await daemonStatusWithForeground(process.env, {
      localAddresses: () => ['192.0.2.123'],
      fetch: vi.fn()
        .mockResolvedValueOnce(healthResponse({ ok: true }))
        .mockResolvedValueOnce(healthResponse({ ok: true, ready: true, pending: [] }))
    });
    expect(local.unregisteredForeground).toEqual({ address: 'http://192.0.2.123:14310', ready: true });
  });

  it('uses the explicit environment daemon directory instead of mixing it with process-global state', async () => {
    const explicitDir = join(tmp, 'explicit-instance', '.dutydeck', 'daemon');
    writeState(explicitDir, {
      pid: process.pid, processIdentity: currentProcessIdentity(), ready: true,
      startedAt: 'explicit', cwd: tmp, address: 'http://127.0.0.1:14310'
    });
    const fetcher = vi.fn();
    const result = await daemonStatusWithForeground({ ...process.env, DUTYDECK_DAEMON_DIR: explicitDir }, { fetch: fetcher });
    expect(result).toMatchObject({ running: true, processStatus: 'verified', address: 'http://127.0.0.1:14310' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('loads only the located service root .env when the current directory has none', async () => {
    writeFileSync(join(tmp, '.env'), 'DUTYDECK_HOST=127.0.0.1\nDUTYDECK_PORT=14311\n');
    const elsewhere = join(tmp, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(elsewhere);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(healthResponse({ ok: true }))
      .mockResolvedValueOnce(healthResponse({ ok: true, ready: true, pending: [] }));
    const result = await daemonStatusWithForeground({ HOME: tmp, DUTYDECK_DAEMON_DIR: dir }, { fetch: fetcher });
    expect(result.unregisteredForeground).toEqual({ address: 'http://127.0.0.1:14311', ready: true });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:14311/health', 'http://127.0.0.1:14311/health/ready'
    ]);

    const explicitFetcher = vi.fn()
      .mockResolvedValueOnce(healthResponse({ ok: true }))
      .mockResolvedValueOnce(healthResponse({ ok: true, ready: true, pending: [] }));
    const overridden = await daemonStatusWithForeground({ HOME: tmp, DUTYDECK_DAEMON_DIR: dir, DUTYDECK_PORT: '14312' }, { fetch: explicitFetcher });
    expect(overridden.unregisteredForeground?.address).toBe('http://127.0.0.1:14312');
  });

  it('does not fill missing current-directory values from a different service root .env', async () => {
    const serviceRoot = join(tmp, 'service-root');
    const current = join(tmp, 'current-directory');
    mkdirSync(serviceRoot, { recursive: true });
    mkdirSync(current, { recursive: true });
    const serviceDir = defaultDaemonDir(serviceRoot);
    writeFileSync(join(serviceRoot, '.env'), 'DUTYDECK_PORT=14311\nDUTYDECK_LOCAL_ONLY=false\n');
    writeFileSync(join(current, '.env'), 'DUTYDECK_HOST=127.0.0.1\n');
    vi.spyOn(process, 'cwd').mockReturnValue(current);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(healthResponse({ ok: true }))
      .mockResolvedValueOnce(healthResponse({ ok: true, ready: true, pending: [] }));
    // CLI 启动已经读取 current/.env；这里只模拟它产生的显式进程环境。
    const result = await daemonStatusWithForeground({ HOME: tmp, DUTYDECK_DAEMON_DIR: serviceDir, DUTYDECK_HOST: '127.0.0.1' }, { fetch: fetcher });
    expect(result.unregisteredForeground?.address).toBe('http://127.0.0.1:4310');
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).port)).toEqual(['4310', '4310']);
  });

  it('keeps an empty port on the schema default instead of turning it into port zero', async () => {
    vi.stubEnv('DUTYDECK_PORT', '');
    const fetcher = vi.fn()
      .mockResolvedValueOnce(healthResponse({ ok: true }))
      .mockResolvedValueOnce(healthResponse({ ok: true, ready: true, pending: [] }));
    const result = await daemonStatusWithForeground(process.env, { fetch: fetcher });
    expect(result.unregisteredForeground?.address).toBe('http://127.0.0.1:4310');
  });

  it('never probes a registered, stale, or malformed daemon record', async () => {
    const fetcher = vi.fn();
    writeState(dir, {
      pid: process.pid, processIdentity: currentProcessIdentity(), ready: true,
      startedAt: 'registered', cwd: tmp, address: 'http://127.0.0.1:14310'
    });
    await expect(daemonStatusWithForeground(process.env, { fetch: fetcher })).resolves.toEqual(oldFields());

    writeState(dir, { pid: 2 ** 22 + 12345, ready: true, startedAt: 'stale', cwd: tmp });
    await expect(daemonStatusWithForeground(process.env, { fetch: fetcher })).resolves.toEqual(oldFields());

    mkdirSync(dir, { recursive: true });
    writeFileSync(daemonPaths(dir).stateFile, '{malformed');
    await expect(daemonStatusWithForeground(process.env, { fetch: fetcher })).resolves.toEqual(oldFields());
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('status CLI', () => {
  async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], { cwd: tmp, env, timeout: 15_000 });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', status => resolve({ status, stdout, stderr }));
    });
  }

  it('prints the optional JSON field and human guidance without suggesting a second start', async () => {
    const requests: string[] = [];
    const port = await localServer((req, res) => {
      const path = req.url ?? '';
      if (path !== '/health' && path !== '/health/ready') {
        res.writeHead(404).end();
        return;
      }
      requests.push(path);
      res.writeHead(200, { 'content-type': 'application/json', 'x-dutydeck-product': 'dutydeck' });
      res.end(JSON.stringify(path === '/health' ? { ok: true } : { ok: true, ready: true, pending: [] }));
    });
    const env = {
      HOME: tmp,
      PATH: process.env.PATH ?? '',
      DUTYDECK_DAEMON_DIR: dir
    };
    const json = await runCli(['--host', '127.0.0.1', '--port', String(port), 'status', '--json'], env);
    expect(json.status, json.stderr).toBe(0);
    expect(requests, json.stdout).toEqual(['/health', '/health/ready']);
    expect(JSON.parse(json.stdout)).toMatchObject({
      running: false, processStatus: 'stale', ready: false,
      unregisteredForeground: { address: `http://127.0.0.1:${port}`, ready: true }
    });
    expect((await fetch(`http://127.0.0.1:${port}/unrelated`)).status).toBe(404);
    expect(requests).toEqual(['/health', '/health/ready']);
    const human = await runCli(['--local-only', '--port', String(port), 'status'], env);
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toContain('未登记前台服务');
    expect(human.stdout).toContain(`http://127.0.0.1:${port}`);
    expect(human.stdout).not.toContain('dutydeck start');
  });

  it('rejects a legacy generic health impersonator through the real CLI', async () => {
    const requests: string[] = [];
    const port = await localServer((req, res) => {
      const path = req.url ?? '';
      if (path !== '/health' && path !== '/health/ready') {
        res.writeHead(404).end();
        return;
      }
      requests.push(path);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(path === '/health' ? { ok: true } : { ok: true, ready: true, pending: [] }));
    });
    const result = await runCli(['--port', String(port), 'status', '--json'], {
      HOME: tmp, PATH: process.env.PATH ?? '', DUTYDECK_DAEMON_DIR: dir
    });
    expect(result.status, result.stderr).toBe(0);
    expect(requests).toEqual(['/health']);
    expect(JSON.parse(result.stdout).unregisteredForeground).toBeUndefined();
  });

  it('uses an explicit status port flag instead of a different environment port', async () => {
    const selected = await localServer((req, res) => {
      if (req.url !== '/health' && req.url !== '/health/ready') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-dutydeck-product': 'dutydeck' });
      res.end(JSON.stringify(req.url === '/health' ? { ok: true } : { ok: true, ready: true, pending: [] }));
    });
    const otherRequests: string[] = [];
    const other = await localServer((req, res) => {
      if (req.url !== '/health' && req.url !== '/health/ready') {
        res.writeHead(404).end();
        return;
      }
      otherRequests.push(req.url ?? '');
      res.writeHead(404).end();
    });
    const result = await runCli(['--port', String(selected), 'status', '--json'], {
      HOME: tmp, PATH: process.env.PATH ?? '', DUTYDECK_DAEMON_DIR: dir,
      DUTYDECK_HOST: '127.0.0.1', DUTYDECK_PORT: String(other)
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).unregisteredForeground?.address).toBe(`http://127.0.0.1:${selected}`);
    expect(otherRequests).toEqual([]);
  });

  it('refuses update before npm and refuses restart without spawning a daemon for an identified foreground', async () => {
    const port = await localServer((req, res) => {
      if (req.url !== '/health' && req.url !== '/health/ready') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-dutydeck-product': 'dutydeck' });
      res.end(JSON.stringify(req.url === '/health' ? { ok: true } : { ok: true, ready: true, pending: [] }));
    });
    const bin = join(tmp, 'fake-npm-bin');
    mkdirSync(bin, { recursive: true });
    const npmLog = join(tmp, 'npm-called');
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\nprintf called >> ${JSON.stringify(npmLog)}\nexit 99\n`, { mode: 0o755 });
    const env = { HOME: tmp, PATH: `${bin}:${process.env.PATH ?? ''}`, DUTYDECK_DAEMON_DIR: dir };

    const update = await runCli(['--port', String(port), 'update', '1.2.3', '--force'], env);
    expect(update.status).toBe(1);
    expect(update.stderr).toContain('在安装前拒绝更新');
    expect(update.stderr).toContain('原启动终端');
    expect(existsSync(npmLog)).toBe(false);

    const restart = await runCli(['--port', String(port), 'restart', '--force'], env);
    expect(restart.status).toBe(1);
    expect(restart.stdout).toContain('未启动新的 daemon');
    expect(restart.stdout).toContain('原启动终端');
    expect(existsSync(daemonPaths(dir).stateFile)).toBe(false);
  });

  it('skips the default-instance foreground probe for restart --unit while preserving the no-unit refusal', async () => {
    const requests: string[] = [];
    const port = await localServer((req, res) => {
      if (req.url !== '/health' && req.url !== '/health/ready') {
        res.writeHead(404).end();
        return;
      }
      requests.push(req.url!);
      res.writeHead(200, { 'content-type': 'application/json', 'x-dutydeck-product': 'dutydeck' });
      res.end(JSON.stringify(req.url === '/health' ? { ok: true } : { ok: true, ready: true, pending: [] }));
    });
    const bin = join(tmp, 'fake-systemctl-bin');
    mkdirSync(bin, { recursive: true });
    const systemctlLog = join(tmp, 'systemctl-log');
    writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}\nexit 1\n`, { mode: 0o755 });
    const env = { HOME: tmp, PATH: `${bin}:${process.env.PATH ?? ''}`, DUTYDECK_DAEMON_DIR: dir };

    const targeted = await runCli(['--port', String(port), 'restart', '--unit', 'dutydeck-review.service', '--force'], env);
    expect(targeted.status).toBe(1);
    expect(targeted.stdout).not.toContain('未登记前台 Dutydeck 服务');
    expect(requests).toEqual([]);
    expect(readFileSync(systemctlLog, 'utf8')).toContain('--user show dutydeck-review.service');

    const untargeted = await runCli(['--port', String(port), 'restart', '--force'], env);
    expect(untargeted.status).toBe(1);
    expect(untargeted.stdout).toContain('未登记前台 Dutydeck 服务');
    expect(untargeted.stdout).toContain('未启动新的 daemon');
    expect(requests).toEqual(['/health', '/health/ready']);
  });
});
