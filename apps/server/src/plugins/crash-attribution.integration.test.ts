import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, expect, it } from 'vitest';
import { pluginsInStack, registerPluginCodeRoot } from './crash-attribution.js';
import { writePlugin } from './scenario-fixtures.test-helpers.js';
import { readPluginQuarantine } from './quarantine.js';
import { PluginStore } from './store.js';
import { lazyBundleForTest } from '../../../../tests/support/bundle-for-test.js';

// 两个用例各起一个真实服务；打包版省掉 TypeScript 加载器的冷启动。
const cli = lazyBundleForTest('crash-attribution', resolve(import.meta.dirname, '../cli.ts'));
afterAll(() => cli.cleanup());
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function freePort() {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as { port: number };
  await new Promise<void>(done => probe.close(() => done()));
  return port;
}

it('names the plugin whose code directory appears in a stack', () => {
  const root = join(tmpdir(), 'dutydeck-attribution-root', 'demo');
  registerPluginCodeRoot('demo', root);
  expect(pluginsInStack(`Error: x\n    at Timeout._onTimeout (file://${root}/index.mjs:3:9)`)).toEqual(['demo']);
  expect(pluginsInStack(`Error: x\n    at f (${root}/lib/a.js:1:1)`)).toEqual(['demo']);
  expect(pluginsInStack(`Error: x\n    at f (${root}-other/a.js:1:1)`)).toEqual([]);
});

it('keeps the default crash exit, names the plugin and quarantines it when its async code throws after startup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dutydeck-plugin-crash-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const data = join(dir, 'data'), flag = join(dir, 'crash-now');
  await writePlugin(join(dir, 'src'), {
    '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'crashy', providers: 'index.mjs' }),
    // 注册后台定时器；测试看到服务就绪后放下标记，定时器里的未处理拒绝应让 daemon 按 Node 默认行为退出。
    'index.mjs': `import { existsSync } from 'node:fs';\nexport default () => { const timer = setInterval(() => { if (existsSync(${JSON.stringify(flag)})) { clearInterval(timer); Promise.reject(new Error('plugin boom')); } }, 50); };\n`
  });
  await new PluginStore(data).install(join(dir, 'src'), { yes: true });
  const port = await freePort();
  const child = spawn(process.execPath, [await cli.path(), '--local-only', '--port', String(port), '--no-lark-listen'], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', HOME: dir, DUTYDECK_DATABASE_URL: join(data, 'dutydeck.db'), DUTYDECK_DEFAULT_CWD: dir, DUTYDECK_DAEMON_DIR: join(dir, '.dutydeck', 'daemon') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  const deadline = Date.now() + 60_000;
  while (!stdout.includes('listening on') && child.exitCode === null && Date.now() < deadline) await new Promise(done => setTimeout(done, 100));
  expect(stdout, stderr).toContain('listening on');
  await writeFile(flag, '1');
  const [code] = await exited;
  expect(code).not.toBe(0);
  expect(stderr).toContain('plugin boom');
  expect(stderr).toContain('in-process plugin code: crashy');
  expect(stderr).toContain('Quarantined plugins: crashy');
  expect(readPluginQuarantine(join(data, 'plugins'), 'crashy')).toMatchObject({ plugin: 'crashy', reason: 'crash' });
}, 90_000);

it('does not quarantine a plugin whose provider load is interrupted by a normal stop signal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dutydeck-plugin-stop-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const data = join(dir, 'data'), entered = join(dir, 'registering');
  await writePlugin(join(dir, 'src'), {
    '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'slow', providers: 'index.mjs' }),
    // register 异步等待，模拟注册较慢的插件；进入后放下标记，测试据此在加载中途发 SIGTERM。
    'index.mjs': `import { writeFileSync } from 'node:fs';\nexport default async () => { writeFileSync(${JSON.stringify(entered)}, '1'); await new Promise(done => setTimeout(done, 10_000)); };\n`
  });
  await new PluginStore(data).install(join(dir, 'src'), { yes: true });
  const port = await freePort();
  const child = spawn(process.execPath, [await cli.path(), '--local-only', '--port', String(port), '--no-lark-listen'], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', HOME: dir, DUTYDECK_DATABASE_URL: join(data, 'dutydeck.db'), DUTYDECK_DEFAULT_CWD: dir, DUTYDECK_DAEMON_DIR: join(dir, '.dutydeck', 'daemon') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  const deadline = Date.now() + 60_000;
  while (!existsSync(entered) && child.exitCode === null && Date.now() < deadline) await new Promise(done => setTimeout(done, 50));
  expect(existsSync(entered), stderr).toBe(true);
  child.kill('SIGTERM');
  const [code] = await exited;
  expect(code).toBe(143);
  expect(readPluginQuarantine(join(data, 'plugins'), 'slow')).toBeUndefined();
}, 90_000);
