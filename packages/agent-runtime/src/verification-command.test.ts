import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProcStat, procStatExited } from '@dutydeck/shared';
import { runIsolatedCommand } from './verification.js';

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
});
