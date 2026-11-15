import { currentProcessIdentity } from '@dutydeck/storage/helpers';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const oldFields = () => {
  const { running, processStatus, error, ready, address, pid, logFile, startedAt, authEnabled, authentication } = daemonStatus();
  return { running, processStatus, error, ready, address, pid, logFile, startedAt, authEnabled, authentication };
};

describe('unregistered foreground status probe', () => {
  it('adds only unregisteredForeground after both strict health shapes pass', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ ok: true, ready: true, pending: [] }));
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
        .mockResolvedValueOnce(Response.json({ ok: true }))
        .mockResolvedValueOnce(Response.json({ ok: true, ready: false, pending: ['listener pending'] })),
      requestTimeoutMs: 50
    });
    expect(result.unregisteredForeground).toEqual({ address: 'http://127.0.0.1:14310', ready: false });
    expect(result.ready).toBe(false);
    expect(result.running).toBe(false);
  });

  it.each([
    ['generic ok readiness', () => Response.json({ ok: true }), () => Response.json({ ok: true })],
    ['non-Dutydeck health body', () => Response.json({ status: 'ok' }), () => Response.json({ ok: true, ready: true, pending: [] })],
    ['HTML health', () => new Response('<html>ok</html>', { headers: { 'content-type': 'text/html' } }), () => Response.json({ ok: true, ready: true, pending: [] })],
    ['health HTTP error', () => Response.json({ ok: true }, { status: 503 }), () => Response.json({ ok: true, ready: true, pending: [] })],
    ['redirect', () => new Response(null, { status: 302, headers: { location: 'http://example.invalid/health' } }), () => Response.json({ ok: true, ready: true, pending: [] })],
    ['ready missing ok', () => Response.json({ ok: true }), () => Response.json({ ready: true, pending: [] })],
    ['ready non-boolean', () => Response.json({ ok: true }), () => Response.json({ ok: true, ready: 'true', pending: [] })],
    ['pending not an array', () => Response.json({ ok: true }), () => Response.json({ ok: true, ready: false, pending: 'listener' })],
    ['pending with non-string', () => Response.json({ ok: true }), () => Response.json({ ok: true, ready: false, pending: ['listener', 1] })]
  ])('leaves the original status for %s', async (_name, health, ready) => {
    const fetcher = vi.fn().mockImplementationOnce(health).mockImplementationOnce(ready);
    const result = await daemonStatusWithForeground(process.env, { fetch: fetcher, requestTimeoutMs: 50 });
    expect(result).toEqual(oldFields());
    expect(result.unregisteredForeground).toBeUndefined();
  });

  it('does not request readiness when health is invalid', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: false }));
    await expect(daemonStatusWithForeground(process.env, { fetch: fetcher, requestTimeoutMs: 50 })).resolves.toEqual(oldFields());
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['health', 'ready'])('contains a rejected %s request without an unhandled rejection', async endpoint => {
    const fetcher = vi.fn().mockImplementation(async () => {
      if (endpoint === 'health' || fetcher.mock.calls.length > 1) throw new DOMException('timed out', 'TimeoutError');
      return Response.json({ ok: true });
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
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', status => resolve({ status, stdout, stderr }));
    });
  }

  it('prints the optional JSON field and human guidance without suggesting a second start', async () => {
    const requests: string[] = [];
    const port = await localServer((req, res) => {
      requests.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/health' ? { ok: true } : { ok: true, ready: true, pending: [] }));
    });
    const env = {
      HOME: tmp,
      PATH: process.env.PATH ?? '',
      DUTYDECK_DAEMON_DIR: dir,
      DUTYDECK_HOST: '127.0.0.1',
      DUTYDECK_PORT: String(port)
    };
    const json = await runCli(['status', '--json'], env);
    expect(json.status, json.stderr).toBe(0);
    expect(requests, json.stdout).toEqual(['/health', '/health/ready']);
    expect(JSON.parse(json.stdout)).toMatchObject({
      running: false, processStatus: 'stale', ready: false,
      unregisteredForeground: { address: `http://127.0.0.1:${port}`, ready: true }
    });
    const human = await runCli(['status'], env);
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toContain('未登记前台服务');
    expect(human.stdout).toContain(`http://127.0.0.1:${port}`);
    expect(human.stdout).not.toContain('dutydeck start');
  });
});
