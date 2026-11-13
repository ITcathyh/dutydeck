import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { bundleCliForTest } from '../../../tests/support/bundle-for-test.js';
import { writeLastDaemonDir } from './daemon/daemon.js';

let cli: string;
let cleanupCli: (() => Promise<void>) | undefined;
beforeAll(async () => { ({ path: cli, cleanup: cleanupCli } = await bundleCliForTest('abnormal-exit')); });
afterAll(async () => { await cleanupCli?.(); });
const roots: string[] = [];
const children = new Set<ChildProcess>();
afterEach(() => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  children.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))); });
});
const listTree = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : [];

it('a foreground instance without DUTYDECK_DAEMON_DIR records a failed start only beside its own database', async () => {
  const port = String(await freePort());
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-abnormal-exit-cli-')); roots.push(root);
  // 另一个实例：last-daemon-dir 指向它，前台实例崩溃时不能写到这里。
  const otherInstance = join(root, 'other', '.dutydeck'); mkdirSync(join(otherInstance, 'daemon'), { recursive: true });
  writeLastDaemonDir(join(otherInstance, 'daemon'), root);
  const scratch = join(root, 'scratch'); mkdirSync(scratch);
  const start = (database: string) => spawnSync(process.execPath, [cli, '--local-only', '--port', port, '--no-lark-listen'], {
    cwd: scratch, encoding: 'utf8', timeout: 60_000,
    env: { HOME: root, PATH: process.env.PATH, DUTYDECK_DATABASE_URL: database, DUTYDECK_DEFAULT_CWD: scratch, DUTYDECK_AGENTS_JSON: '{not json' }
  });
  // 数据库目录还不存在：这个库从没打开过，什么都不写，也不替它建目录。
  const fresh = start(join(scratch, 'fresh', 'dutydeck.db'));
  expect(fresh.status, fresh.stderr).not.toBe(0);
  expect(existsSync(join(scratch, 'fresh'))).toBe(false);

  const database = join(scratch, 'data', 'dutydeck.db'); mkdirSync(join(scratch, 'data'));
  const result = start(database);
  expect(result.status, result.stderr).not.toBe(0);
  const record = JSON.parse(readFileSync(join(scratch, 'data', 'last-abnormal-exit.json'), 'utf8'));
  expect(record).toMatchObject({ kind: 'startup', exitCode: 1, database });
  expect(record.error).toMatch(/DUTYDECK_AGENTS_JSON/);
  expect(Date.now() - Date.parse(record.at)).toBeLessThan(5 * 60_000);
  expect(listTree(join(root, 'other')).filter(path => path.includes('last-abnormal-exit'))).toEqual([]);
  expect(listTree(join(root, '.dutydeck')).filter(path => path.includes('last-abnormal-exit'))).toEqual([]);
});

it('a crash after the service is up records a redacted fatal exit beside the database it opened', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-abnormal-exit-fatal-')); roots.push(root);
  const scratch = join(root, 'scratch'); mkdirSync(join(scratch, 'data'), { recursive: true });
  const database = join(scratch, 'data', 'dutydeck.db');
  // 服务打印监听地址后抛一个未捕获异常，模拟运行中崩溃。
  const preload = join(root, 'crash-after-listen.mjs');
  writeFileSync(preload, `const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => { const result = write(chunk, ...rest); if (String(chunk).includes('listening on')) setImmediate(() => { throw new Error('synthetic crash password=hunter2-secret'); }); return result; };
`);
  const result = spawnSync(process.execPath, ['--import', preload, cli, '--local-only', '--port', String(await freePort()), '--no-lark-listen'], {
    cwd: scratch, encoding: 'utf8', timeout: 90_000,
    env: { HOME: root, PATH: process.env.PATH, DUTYDECK_DATABASE_URL: database, DUTYDECK_DEFAULT_CWD: scratch, DUTYDECK_AGENTS_JSON: '[]', DUTYDECK_DISABLE_LARK_LISTENER: 'true' }
  });
  expect(result.status, result.stderr).not.toBe(0);
  expect(result.stderr).toContain('synthetic crash');
  const raw = readFileSync(join(scratch, 'data', 'last-abnormal-exit.json'), 'utf8');
  expect(JSON.parse(raw)).toMatchObject({ kind: 'fatal', exitCode: 1, database, error: expect.stringContaining('synthetic crash') });
  expect(raw).not.toContain('hunter2-secret');
});

it('a foreground SIGKILL is recorded by the next generation without journal access', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-abnormal-exit-sigkill-')); roots.push(root);
  const scratch = join(root, 'scratch'); mkdirSync(join(scratch, 'data'), { recursive: true });
  const database = join(scratch, 'data', 'dutydeck.db');
  const launch = async () => {
    const child = spawn(process.execPath, [cli, '--local-only', '--port', String(await freePort()), '--no-lark-listen'], {
      cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'],
      env: { HOME: root, PATH: process.env.PATH, DUTYDECK_DATABASE_URL: database, DUTYDECK_DEFAULT_CWD: scratch, DUTYDECK_AGENTS_JSON: '[]', DUTYDECK_DISABLE_LARK_LISTENER: 'true' }
    });
    children.add(child);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    let stdout = '', stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`service did not become ready: ${stderr}`)), 60_000);
      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.includes('listening on')) { clearTimeout(timer); resolve(); }
      });
      void exited.then(exit => { clearTimeout(timer); reject(new Error(`service exited before ready ${JSON.stringify(exit)}: ${stderr}`)); });
    });
    return { child, exited };
  };
  const first = await launch();
  first.child.kill('SIGKILL');
  expect(await first.exited).toEqual({ code: null, signal: 'SIGKILL' });
  const second = await launch();
  try {
    const record = JSON.parse(readFileSync(join(scratch, 'data', 'last-abnormal-exit.json'), 'utf8'));
    expect(record).toMatchObject({ kind: 'fatal', exitCode: 1, database, runId: expect.any(String), pid: first.child.pid });
    expect(record.error).toMatch(/clean-exit|pending|unknown/i);
    expect(record.kind).not.toBe('signal');
  } finally {
    second.child.kill('SIGTERM');
    await second.exited;
  }
}, 90_000);

it('a clean foreground stop does not create an abnormal record on the next start', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-clean-exit-cli-')); roots.push(root);
  const scratch = join(root, 'scratch'); mkdirSync(join(scratch, 'data'), { recursive: true });
  const database = join(scratch, 'data', 'dutydeck.db');
  const launch = async () => {
    const child = spawn(process.execPath, [cli, '--local-only', '--port', String(await freePort()), '--no-lark-listen'], {
      cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'],
      env: { HOME: root, PATH: process.env.PATH, DUTYDECK_DATABASE_URL: database, DUTYDECK_DEFAULT_CWD: scratch, DUTYDECK_AGENTS_JSON: '[]', DUTYDECK_DISABLE_LARK_LISTENER: 'true' }
    });
    children.add(child);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    let stdout = '', stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`service did not become ready: ${stderr}`)), 60_000);
      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.includes('listening on')) { clearTimeout(timer); resolve(); }
      });
      void exited.then(exit => { clearTimeout(timer); reject(new Error(`service exited before ready ${JSON.stringify(exit)}: ${stderr}`)); });
    });
    return { child, exited };
  };
  const first = await launch();
  const firstRunId = JSON.parse(readFileSync(join(scratch, 'data', 'last-abnormal-exit.json'), 'utf8')).lifecycle.runId;
  first.child.kill('SIGTERM');
  expect(await first.exited).toEqual({ code: 0, signal: null });
  const stopped = JSON.parse(readFileSync(join(scratch, 'data', 'last-abnormal-exit.json'), 'utf8'));
  expect(stopped['clean-exit']).toMatchObject({ runId: firstRunId, reason: 'stopped', signal: 'SIGTERM' });
  expect(stopped.kind).toBeUndefined();

  const second = await launch();
  const restarted = JSON.parse(readFileSync(join(scratch, 'data', 'last-abnormal-exit.json'), 'utf8'));
  expect(restarted.kind).toBeUndefined();
  expect(restarted.history).toBeUndefined();
  expect(restarted.lifecycle.runId).not.toBe(firstRunId);
  second.child.kill('SIGTERM');
  expect(await second.exited).toEqual({ code: 0, signal: null });
}, 90_000);
