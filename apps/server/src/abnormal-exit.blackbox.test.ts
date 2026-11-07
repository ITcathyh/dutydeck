import { spawnSync } from 'node:child_process';
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
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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
