import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { childProcessIdentity } from '@dutydeck/storage';
import { daemonPaths, defaultDaemonDir, inspectDaemon, pidAlive, readDaemonStatus, writeState } from './daemon.js';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const tsx = join(workspace, 'node_modules/.bin/tsx');
const fixture = join(workspace, 'apps/server/src/daemon/fixtures/lifecycle.ts');
const cli = join(workspace, 'apps/server/src/cli.ts');
let root: string;
function invoke(file: string, args: string[]) {
  return spawnSync(tsx, [file, ...args], { cwd: root, env: { HOME: root, PATH: process.env.PATH, NODE_OPTIONS: '--conditions=development' }, encoding: 'utf8', timeout: 25_000 });
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
    expect(lifecycle('stop')).toMatchObject({ ok: true, state: 'stopped', running: false, pid: restarted.pid });
    expect(lifecycle('status')).toMatchObject({ running: false, processStatus: 'stale' });
    expect(pidAlive(restarted.pid)).toBe(false);
  }, 60_000);
  it('detached restart 不会让被拉起的 restart 子进程在守护日志里再写一行「跳过任务等待」', () => {
    lifecycle('start');
    lifecycle('restart');
    // daemonize 出的 restart 子进程 stderr 重定向进守护日志；父进程已 drain 完，
    // 子进程必须静默跳过，否则新进程起不来时这行会占掉 tailDaemonLog 取的 3 行之一。
    const logFile = daemonPaths(defaultDaemonDir(root)).logFile;
    const log = readFileSync(logFile, 'utf8');
    expect(log).not.toContain('跳过任务等待');
    expect(log).not.toContain('守护进程未运行');
    lifecycle('stop');
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
