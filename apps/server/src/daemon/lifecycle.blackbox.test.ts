import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { childProcessIdentity } from '@dutydeck/storage/helpers';
import { bundleCliForTest } from '../../../../tests/support/bundle-for-test.js';
import { daemonPaths, defaultDaemonDir, inspectDaemon, pidAlive, readDaemonStatus, writeState } from './daemon.js';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
// The fixture, the daemon it detaches (a re-exec of the same file) and the CLI run as bundles: through the
// TypeScript loader every start, restart, status and stop paid a multi-second cold start.
let fixture: string;
let cli: string;
const cleanups: Array<() => Promise<void>> = [];
beforeAll(async () => {
  const bundles = await Promise.all([
    bundleCliForTest('daemon-lifecycle', join(workspace, 'apps/server/src/daemon/fixtures/lifecycle.ts')),
    bundleCliForTest('daemon-lifecycle-cli')
  ]);
  cleanups.push(...bundles.map(bundle => bundle.cleanup));
  [fixture, cli] = bundles.map(bundle => bundle.path) as [string, string];
});
afterAll(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });
let root: string;
// 打包产物十几 MB，同一文件内多次启动共用 V8 代码缓存，省掉重复解析。
const childEnv = () => ({ HOME: root, PATH: process.env.PATH, NODE_COMPILE_CACHE: join(dirname(cli), 'compile-cache') });
function invoke(file: string, args: string[]) {
  return spawnSync(process.execPath, [file, ...args], { cwd: root, env: childEnv(), encoding: 'utf8', timeout: 25_000 });
}
function lifecycle(action: string) {
  const result = invoke(fixture, [action]);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout);
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'daemon-lifecycle-')); });
afterEach(() => {
  // Only a child launched by this isolated fixture is ever eligible for cleanup.
  const state = readDaemonStatus(defaultDaemonDir(root));
  if (state?.cwd === root && inspectDaemon(defaultDaemonDir(root)).status === 'verified') invoke(fixture, ['stop']);
  rmSync(root, { recursive: true, force: true });
});
describe('daemon detached process and CLI black box', () => {
  it('starts, waits for its own ready identity, restarts, and stops real owned child processes', () => {
    const start = lifecycle('start');
    expect(start).toMatchObject({ ok: true, state: 'started', running: true });
    expect(readDaemonStatus(defaultDaemonDir(root))?.processIdentity).toEqual(childProcessIdentity(start.pid));
    expect(lifecycle('status')).toMatchObject({ running: true, pid: start.pid, ready: true, processStatus: 'verified' });
    const restarted = lifecycle('restart');
    expect(restarted).toMatchObject({ ok: true, state: 'restarted', running: true });
    expect(restarted.pid).not.toBe(start.pid);
    expect(pidAlive(start.pid)).toBe(false);
    // daemonize 出的 restart 子进程 stderr 重定向进守护日志；父进程已 drain 完，
    // 子进程必须静默跳过，否则新进程起不来时这行会占掉 tailDaemonLog 取的 3 行之一。
    const log = readFileSync(daemonPaths(defaultDaemonDir(root)).logFile, 'utf8');
    expect(log).not.toContain('跳过任务等待');
    expect(log).not.toContain('守护进程未运行');
    expect(lifecycle('stop')).toMatchObject({ ok: true, state: 'stopped', running: false, pid: restarted.pid });
    expect(lifecycle('status')).toMatchObject({ running: false, processStatus: 'stale' });
    expect(pidAlive(restarted.pid)).toBe(false);
  }, 60_000);
  it('rotates an oversized daemon log before the detached child opens it', () => {
    const log = daemonPaths(defaultDaemonDir(root)).logFile;
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, Buffer.alloc(11 * 1024 * 1024, 'a'));
    expect(lifecycle('start')).toMatchObject({ ok: true, state: 'started' });
    expect(statSync(`${log}.1`).size).toBe(11 * 1024 * 1024);
    expect(existsSync(log) ? statSync(log).size : 0).toBeLessThan(1024 * 1024);
    expect(lifecycle('stop')).toMatchObject({ ok: true, state: 'stopped' });
  }, 60_000);
  it('two concurrent starts leave exactly one verified daemon', async () => {
    const run = () => new Promise<{ status: number | null; stdout: string }>(resolve => {
      const child = spawn(process.execPath, [fixture, 'start'], { cwd: root, env: childEnv() });
      let stdout = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.once('exit', status => resolve({ status, stdout }));
    });
    const results = (await Promise.all([run(), run()])).map(result => JSON.parse(result.stdout.trim().split('\n').at(-1)!));
    const started = results.filter(result => result.ok);
    expect(started).toHaveLength(1);
    expect(inspectDaemon(defaultDaemonDir(root)).status).toBe('verified');
    expect(readDaemonStatus(defaultDaemonDir(root))?.pid).toBe(started[0].pid);
    // 落败的一方不能留下第二个活着的服务进程。
    const loserPid = results.find(result => !result.ok)?.pid;
    if (loserPid && loserPid !== started[0].pid) expect(pidAlive(loserPid)).toBe(false);
  }, 60_000);
  it('shows unknown identity in human and JSON status without recommending start', () => {
    const legacy = { pid: process.pid, ready: true, cwd: '/legacy-fixture', startedAt: 'legacy' };
    writeState(defaultDaemonDir(root), legacy);
    const human = invoke(cli, ['daemon', 'status']);
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toContain('身份无法验证');
    expect(human.stdout).not.toContain('守护进程未运行');
    expect(human.stdout).not.toContain('dutydeck start');
    const json = invoke(cli, ['daemon', 'status', '--json']);
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ processStatus: 'unverifiable', running: false, pid: process.pid });
    expect(readDaemonStatus(defaultDaemonDir(root))).toEqual(legacy);
  }, 30_000);
});
