import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProcStat, procStatExited } from '@dutydeck/shared';
import { runIsolatedCommand } from './verification.js';
import { lazyBundleForTest } from '../../../tests/support/bundle-for-test.js';

const stdinFixture = lazyBundleForTest('verification-stdin', join(process.cwd(), 'packages/agent-runtime/tests/fixtures/verification-stdin.mts'));
afterAll(() => stdinFixture.cleanup());
const execFileAsync = promisify(execFile);

const directories: string[] = [];
const ownedPids = new Set<number>();
const ownedGroups = new Set<number>();

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-command-exit-'));
  directories.push(directory);
  return directory;
}

async function hasExited(pid: number) {
  try { return procStatExited(parseProcStat(await readFile(`/proc/${pid}/stat`, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

async function ownPidWhileRunning(cwd: string, group = false) {
  let pid = 0;
  await vi.waitFor(async () => {
    pid = Number((await readFile(join(cwd, 'child.pid'), 'utf8')).trim());
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  }, { timeout: 3_000, interval: 25 });
  (group ? ownedGroups : ownedPids).add(pid);
  return pid;
}

afterEach(async () => {
  for (const group of ownedGroups) {
    try { process.kill(-group, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  for (const pid of ownedPids) {
    try { process.kill(pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  ownedGroups.clear(); ownedPids.clear();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== 'linux')('isolated command process settlement', () => {
  it('settles a successful shell on exit even when a background child inherits its pipes: sleep 2 &', async () => {
    const cwd = await workspace();
    const result = await runIsolatedCommand('sleep 2 &', cwd, { timeoutMs: 1_000, maxOutputBytes: 4_096 });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, interrupted: false, output: '', outputTruncated: false });
    expect(result.cleanupError).toBeUndefined();
  });

  it.each([
    { command: 'printf ok', exitCode: 0, output: 'ok' },
    { command: 'printf failed; exit 7', exitCode: 7, output: 'failed' }
  ])('preserves the main shell result for exit $exitCode', async ({ command, exitCode, output }) => {
    const cwd = await workspace();
    const result = await runIsolatedCommand(command, cwd, { timeoutMs: 5_000, maxOutputBytes: 4_096 });
    expect(result).toMatchObject({ exitCode, output, timedOut: false, interrupted: false });
    expect(result.cleanupError).toBeUndefined();
  });

  it('kills and waits for background processes in the command process group', async () => {
    const cwd = await workspace();
    const running = runIsolatedCommand('sleep 30 & echo $! > child.pid', cwd, { timeoutMs: 5_000, maxOutputBytes: 4_096 });
    const pid = await ownPidWhileRunning(cwd);
    const result = await running;
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, interrupted: false });
    expect(result.cleanupError).toBeUndefined();
    await vi.waitFor(async () => expect(await hasExited(pid)).toBe(true), { timeout: 3_000, interval: 25 });
  });

  it('reports an observable pipe leak from a setsid descendant without calling it a main-process timeout', async () => {
    const cwd = await workspace();
    const running = runIsolatedCommand("setsid sh -c 'echo $$ > child.pid; exec sleep 30' & until [ -f child.pid ]; do sleep 0.01; done", cwd, { timeoutMs: 1_000, maxOutputBytes: 4_096 });
    await ownPidWhileRunning(cwd, true);
    const result = await running;
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, interrupted: false });
    expect(result.cleanupError).toMatch(/pipe/i);
  }, 15_000);

  it('does not claim containment for a setsid descendant whose pipes are fully redirected', async () => {
    const cwd = await workspace();
    const running = runIsolatedCommand("setsid sh -c 'echo $$ > child.pid; exec sleep 30' </dev/null >/dev/null 2>&1 & until [ -f child.pid ]; do sleep 0.01; done", cwd, { timeoutMs: 1_000, maxOutputBytes: 4_096 });
    const pid = await ownPidWhileRunning(cwd, true);
    const result = await running;
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, interrupted: false });
    expect(result.cleanupError).toBeUndefined();
    expect(await hasExited(pid)).toBe(false);
  });

  it('keeps a real main-process timeout distinct from cleanup failures', async () => {
    const cwd = await workspace();
    const result = await runIsolatedCommand('sleep 30', cwd, { timeoutMs: 1_000, maxOutputBytes: 4_096 });
    expect(result).toMatchObject({ timedOut: true, interrupted: false });
    expect(result.exitCode).toBeUndefined();
    expect(result.cleanupError).toBeUndefined();
  });

  it.each(['TERM', 'KILL'] as const)('settles a main shell terminated by SIG%s without inventing an exit code', async signal => {
    const cwd = await workspace();
    const result = await runIsolatedCommand(`kill -${signal} $$`, cwd, { timeoutMs: 5_000, maxOutputBytes: 4_096 });
    expect(result).toMatchObject({ timedOut: false, interrupted: false });
    expect(result.exitCode).toBeUndefined();
    expect(result.cleanupError).toBeUndefined();
  });

  it('drains and truncates large output after the main shell exits', async () => {
    const cwd = await workspace();
    const result = await runIsolatedCommand('head -c 200000 /dev/zero | tr "\\0" a', cwd, { timeoutMs: 5_000, maxOutputBytes: 16_384 });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, interrupted: false, outputTruncated: true });
    expect(result.output).toBe('a'.repeat(16_384));
    expect(result.cleanupError).toBeUndefined();
  });

  it('handles early-closed stdin in an independent Node process without changing other exit facts', async () => {
    const cwd = await workspace();
    execFileSync('git', ['-C', cwd, 'init', '-q']);
    execFileSync('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'baseline']);
    const { stdout, stderr } = await execFileAsync(process.execPath, [await stdinFixture.path(), cwd], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    expect(stderr).toBe('');
    const results = JSON.parse(stdout);
    expect(results.earlyExit).toMatchObject({ exitCode: 0, timedOut: false, interrupted: false });
    expect(results.earlyExit.error).toBeUndefined();
    expect(results.persisted).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(results.persisted.error).toBeUndefined();
    expect(results.normal).toMatchObject({ exitCode: 0, output: 'ok', timedOut: false, interrupted: false });
    expect(results.failure).toMatchObject({ exitCode: 7, output: 'failed', timedOut: false, interrupted: false });
    expect(results.spawnFailure.error).toBeTruthy();
    expect(results.spawnFailure.exitCode).not.toBe(0);
    expect(results.spawnFailure).toMatchObject({ timedOut: false, interrupted: false });
    expect(results.timedOut).toMatchObject({ timedOut: true, interrupted: false });
    expect(results.interrupted).toMatchObject({ timedOut: false, interrupted: true });
  }, 25_000);
});
