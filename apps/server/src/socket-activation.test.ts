import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { lazyBundleForTest } from '../../../tests/support/bundle-for-test.js';
import { inheritedSocketMismatch, takeInheritedListenSocket } from './socket-activation.js';

const childBundle = lazyBundleForTest('socket-activation-child', fileURLToPath(new URL('./socket-activation.child.mts', import.meta.url)));
afterAll(async () => { await childBundle.cleanup(); });

describe('takeInheritedListenSocket', () => {
  it('只认发给本进程的 socket，并从环境里删掉激活变量', () => {
    const env: NodeJS.ProcessEnv = { LISTEN_PID: '42', LISTEN_FDS: '1', LISTEN_FDNAMES: 'http', PATH: '/usr/bin' };
    expect(takeInheritedListenSocket(env, 42)).toEqual({ fd: 3 });
    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('发给别的进程时忽略，变量同样删掉', () => {
    const env: NodeJS.ProcessEnv = { LISTEN_PID: '7', LISTEN_FDS: '1' };
    expect(takeInheritedListenSocket(env, 42)).toBeUndefined();
    expect(env).toEqual({});
  });

  it('没有激活变量时不处理', () => {
    expect(takeInheritedListenSocket({}, 42)).toBeUndefined();
  });

  it('传入多个 socket 时拒绝启动，不猜该用哪个', () => {
    expect(takeInheritedListenSocket({ LISTEN_PID: '42', LISTEN_FDS: '2' }, 42)).toMatchObject({ error: expect.stringContaining('2 个') });
  });

  it('地址或端口与配置不一致时报错，保留 IPv4/IPv6 回环和双栈通配合法组合', () => {
    expect(inheritedSocketMismatch({ address: '127.0.0.1', port: 4310, family: 'IPv4' }, { host: '127.0.0.1', port: 4310 })).toBeUndefined();
    expect(inheritedSocketMismatch({ address: '::1', port: 4310, family: 'IPv6' }, { host: '::1', port: 4310 })).toBeUndefined();
    expect(inheritedSocketMismatch({ address: '::', port: 4310, family: 'IPv6' }, { host: '0.0.0.0', port: 4310 })).toBeUndefined();
    expect(inheritedSocketMismatch({ address: '0.0.0.0', port: 4310, family: 'IPv4' }, { host: '::', port: 4310 })).toBeUndefined();
    expect(inheritedSocketMismatch({ address: '0.0.0.0', port: 4310, family: 'IPv4' }, { host: '127.0.0.1', port: 4310 })).toContain('仅本机访问');
    expect(inheritedSocketMismatch({ address: '::', port: 4310, family: 'IPv6' }, { host: '::1', port: 4310 })).toContain('不一致');
    expect(inheritedSocketMismatch({ address: '127.0.0.1', port: 4311, family: 'IPv4' }, { host: '127.0.0.1', port: 4310 })).toContain('4311');
    expect(inheritedSocketMismatch('/tmp/x.sock', { host: '127.0.0.1', port: 4310 })).toContain('非 TCP');
  });
});

const nonLoopbackIpv4 = Object.values(networkInterfaces()).flat().find(entry => entry?.family === 'IPv4' && !entry.internal)?.address;

type SocketCase = {
  name: string;
  configHost: string;
  bindHost: string;
  mode: 'local' | 'token';
  requestHost: string;
  requestAddress: string;
  expectedStatus: number;
  mismatch: boolean;
  tokenRetry?: boolean;
};

const cases: SocketCase[] = [
  { name: 'IPv4 local 回环', configHost: '127.0.0.1', bindHost: '127.0.0.1', mode: 'local', requestHost: '127.0.0.1', requestAddress: '127.0.0.1', expectedStatus: 200, mismatch: false },
  { name: 'IPv4 local 配回环但继承 wildcard', configHost: '127.0.0.1', bindHost: '0.0.0.0', mode: 'local', requestHost: '127.0.0.1', requestAddress: nonLoopbackIpv4 ?? '', expectedStatus: 403, mismatch: true },
  { name: 'IPv6 local 回环', configHost: '::1', bindHost: '::1', mode: 'local', requestHost: '[::1]', requestAddress: '[::1]', expectedStatus: 200, mismatch: false },
  { name: 'IPv6 local 配回环但继承双栈 wildcard', configHost: '::1', bindHost: '::', mode: 'local', requestHost: '[::1]', requestAddress: nonLoopbackIpv4 ?? '', expectedStatus: 403, mismatch: true },
  { name: 'token 允许 IPv4 配置对应双栈 wildcard', configHost: '0.0.0.0', bindHost: '::', mode: 'token', requestHost: '127.0.0.1', requestAddress: nonLoopbackIpv4 || '127.0.0.1', expectedStatus: 401, mismatch: false, tokenRetry: true },
  { name: 'token 允许 IPv6 wildcard 配置对应 IPv4 wildcard', configHost: '::', bindHost: '0.0.0.0', mode: 'token', requestHost: '127.0.0.1', requestAddress: nonLoopbackIpv4 || '127.0.0.1', expectedStatus: 401, mismatch: false, tokenRetry: true }
];

async function runInheritedSocket(test: SocketCase, index: number) {
  const holder = createServer();
  await new Promise<void>((resolve, reject) => {
    holder.once('error', reject);
    holder.listen({ host: test.bindHost, port: 0, ...(test.bindHost === '::' && test.configHost !== '::1' ? { ipv6Only: false } : {}) }, resolve);
  });
  const address = holder.address();
  if (!address || typeof address === 'string') throw new Error('TCP fixture did not bind');
  const child = spawn('sh', ['-c', 'LISTEN_PID=$$ LISTEN_FDS=1 exec "$0" "$1"', process.execPath, await childBundle.path()], {
    env: { ...process.env, FIXTURE_CONFIG_HOST: test.configHost, FIXTURE_CONFIG_PORT: String(address.port), FIXTURE_AUTH_MODE: test.mode, FIXTURE_CHECK_FDS: String(index === 0) },
    stdio: ['pipe', 'pipe', 'pipe', (holder as unknown as { _handle: { fd: number } })._handle.fd]
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    child.stdout.on('data', () => {
      if (settled || !stdout.includes('\n')) return;
      settled = true; resolve();
    });
    child.once('exit', code => {
      if (settled) return;
      settled = true; reject(new Error(`child exited ${code} before listen: ${stderr}`));
    });
  });
  // systemd 自身不 accept；交出 fd 后关掉父进程这一份，请求只会到子进程。
  await new Promise<void>(resolve => holder.close(() => resolve()));
  let finished = false;
  try {
    await ready;
    const observed = JSON.parse(stdout.trim().split('\n')[0]!);
    expect(observed.address.address).toBe(test.bindHost);
    expect(observed.addresses).toBe(1);
    expect(observed.mismatch !== null).toBe(test.mismatch);
    if (index === 0) expect(observed.childFds).toEqual(['0', '1', '2']);
    const request = async (authorization?: string) => fetch(`http://${test.requestAddress}:${address.port}/api/fixture/control`, {
      method: 'POST',
      headers: { host: `${test.requestHost}:${address.port}`, ...(authorization ? { authorization } : {}) }
    });
    const response = await request();
    expect(response.status).toBe(test.expectedStatus);
    expect(await response.json()).toMatchObject(test.expectedStatus === 200 ? { ok: true } : { error: { code: test.mode === 'local' && test.mismatch ? 'REMOTE_NOT_ALLOWED' : 'UNAUTHORIZED' } });
    if (test.tokenRetry) {
      const accepted = await request('Bearer fixture-token-not-a-credential');
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({ ok: true, hasCredential: true });
    }
    child.stdin.end('finish\n');
    finished = true;
    expect(await exited, stderr).toBe(test.mismatch ? 1 : 0);
    if (test.mismatch) expect(stderr).toContain(observed.mismatch);
  } finally {
    if (!finished) child.kill('SIGKILL');
    await exited;
  }
}

for (const [index, test] of cases.entries()) {
  it(`真实继承 fd：${test.name}`, { skip: test.requestAddress === '', timeout: 30_000 }, async () => { await runInheritedSocket(test, index); });
}
