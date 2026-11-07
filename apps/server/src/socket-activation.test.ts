import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inheritedSocketMismatch, takeInheritedListenSocket } from './socket-activation.js';

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

  it('端口与配置不一致时报错', () => {
    expect(inheritedSocketMismatch({ address: '127.0.0.1', port: 4310, family: 'IPv4' }, { host: '127.0.0.1', port: 4310 })).toBeUndefined();
    expect(inheritedSocketMismatch({ address: '127.0.0.1', port: 4311, family: 'IPv4' }, { host: '127.0.0.1', port: 4310 })).toContain('4311');
    expect(inheritedSocketMismatch('/tmp/x.sock', { host: '127.0.0.1', port: 4310 })).toContain('非 TCP');
  });
});

it('继承的监听 socket 交给 Fastify，只有这一个地址，子进程看不到它', async () => {
  // 父进程充当 systemd：持有监听 socket，从 fd 3 传给子进程，LISTEN_PID 由 sh 的 exec 保持为子进程 pid。
  const holder = createServer();
  await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve));
  const { port } = holder.address() as { port: number };
  const module = fileURLToPath(new URL('./socket-activation.ts', import.meta.url));
  const script = `import Fastify from 'fastify';
import { execFileSync } from 'node:child_process';
import { takeInheritedListenSocket, inheritedSocketMismatch, inheritedListenOptions } from ${JSON.stringify(module)};
const inherited = takeInheritedListenSocket();
const app = Fastify();
app.get('/health', async () => ({ ok: true, pid: process.pid }));
await app.listen(inheritedListenOptions(inherited.fd));
// 只有继承来的那一个 socket：Fastify 没有额外绑定 ::1 等地址。
const addresses = app.addresses().length;
const childFds = execFileSync('sh', ['-c', 'ls /proc/$$/fd']).toString().split(/\\s+/).filter(Boolean);
process.stdout.write(JSON.stringify({ mismatch: inheritedSocketMismatch(app.server.address(), { host: '127.0.0.1', port: ${port} }) ?? null, env: process.env.LISTEN_FDS ?? null, childFds, addresses }) + '\\n');
process.on('SIGTERM', () => app.close().then(() => process.exit(0)));`;
  const child = spawn('sh', ['-c', `LISTEN_PID=$$ LISTEN_FDS=1 exec "$0" --import tsx --input-type=module -e "$1"`, process.execPath, script], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe', (holder as unknown as { _handle: { fd: number } })._handle.fd]
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  // 交出后父进程关掉自己这份：否则两边都在同一个 socket 上 accept，请求可能落到父进程。systemd 自己不 accept。
  await new Promise(resolve => holder.close(resolve));
  try {
    let stdout = '', stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const line = await new Promise<string>((resolve, reject) => {
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('\n')) resolve(stdout.trim()); });
      child.once('exit', code => reject(new Error(`child exited ${code}: ${stderr}`)));
    });
    expect(JSON.parse(line)).toEqual({ mismatch: null, env: null, childFds: ['0', '1', '2'], addresses: 1 });
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await response.json()).toMatchObject({ ok: true, pid: child.pid });
  } finally {
    child.kill('SIGTERM');
    await exited;
  }
}, 30_000);
