import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const launcher = resolve('packages/acp-client/agents/launcher-process.mjs');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface Result { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; elapsed: number }
interface Harness {
  child: ChildProcess;
  directory: string;
  ownGroup: boolean;
  result: Promise<Result>;
  output: { stdout: string; stderr: string };
}
const active = new Set<Harness>();

function startLauncher(script: string, options: { ownGroup?: boolean; beforeLaunch?: string; pauseOutputMs?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dd-launcher-process-'));
  mkdirSync(join(directory, 'reports'));
  const ownGroup = options.ownGroup ?? false;
  const agentPidFile = join(directory, 'agent.pid');
  const forceGroupAlive = ownGroup ? `
    const originalKill = process.kill.bind(process);
    process.kill = (pid, signal) => {
      if (signal === 0 && pid < 0) throw Object.assign(new Error('synthetic group probe failure'), { code: 'EPERM' });
      return originalKill(pid, signal);
    };
  ` : '';
  const bootstrap = `
    import { launchAgent } from ${JSON.stringify(pathToFileURL(launcher).href)};
    import { writeFileSync } from 'node:fs';
    ${forceGroupAlive}
    const child = launchAgent(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(script)}], process.env, { stdio: ['ignore', 'pipe', 'pipe'] });
    writeFileSync(${JSON.stringify(agentPidFile)}, String(child.pid));
    ${options.beforeLaunch ?? ''}
  `;
  const started = Date.now();
  const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
    env: {
      ...process.env,
      fixture_dir: directory,
      dutydeck_launcher_group: ownGroup ? '0' : '1',
      dutydeck_launcher_report: join(directory, 'reports'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  child.stdout!.on('data', chunk => { output.stdout += String(chunk); });
  child.stderr!.on('data', chunk => { output.stderr += String(chunk); });
  if (options.pauseOutputMs) {
    child.stdout!.pause();
    setTimeout(() => child.stdout!.resume(), options.pauseOutputMs);
  }
  const result = new Promise<Result>((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolveResult({ code, signal, ...output, elapsed: Date.now() - started }));
  });
  void result.catch(() => {});
  const harness = { child, directory, ownGroup, result, output };
  active.add(harness);
  return harness;
}

async function bounded(harness: Harness, timeoutMs = 12_000): Promise<Result> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      harness.result,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('launcher did not finish within the test bound')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer!); }
}

function killExact(pid: number, ownGroup = false) {
  try { process.kill(ownGroup ? -pid : pid, 'SIGKILL'); } catch { /* already gone */ }
}

afterEach(() => {
  for (const harness of active) {
    if (harness.child.pid) killExact(harness.child.pid);
    if (existsSync(join(harness.directory, 'agent.pid'))) {
      killExact(Number(readFileSync(join(harness.directory, 'agent.pid'), 'utf8')), harness.ownGroup);
    }
    if (existsSync(join(harness.directory, 'escaped.pid'))) {
      killExact(Number(readFileSync(join(harness.directory, 'escaped.pid'), 'utf8')));
    }
    rmSync(harness.directory, { recursive: true, force: true });
  }
  active.clear();
});

it('preserves large stdout and stderr through normal EOF and the child exit code', async () => {
  const stdout = 'x'.repeat(2 * 1024 * 1024);
  const stderr = 'e'.repeat(512 * 1024);
  const harness = startLauncher(`
    process.stdout.write('x'.repeat(${2 * 1024 * 1024}));
    process.stderr.write('e'.repeat(${512 * 1024}));
    process.exitCode = 7;
  `);
  const result = await bounded(harness);
  expect(result.code).toBe(7);
  expect(result.stdout).toBe(stdout);
  expect(result.stderr).toBe(stderr);
}, 20_000);

it('waits for a slow destination reader without truncating the tail', async () => {
  const stdout = `start-${'slow-reader-'.repeat(80_000)}-end`;
  const harness = startLauncher(`process.stdout.write('start-' + 'slow-reader-'.repeat(80_000) + '-end');`, { pauseOutputMs: 600 });
  const result = await bounded(harness);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(stdout);
  expect(result.stderr).toBe('');
}, 20_000);

it('bounds an inherited stdout descriptor after child exit and preserves the read tail', async () => {
  const harness = startLauncher(`
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const escaped = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true, stdio: ['ignore', 'inherit', 'ignore'],
    });
    writeFileSync(join(process.env.fixture_dir, 'escaped.pid'), String(escaped.pid));
    escaped.unref();
    process.stdout.write('tail-before-undrained');
  `);
  const result = await bounded(harness);
  expect(result.code).toBe(1);
  expect(result.elapsed).toBeGreaterThanOrEqual(4_500);
  expect(result.stdout).toBe('tail-before-undrained');
  expect(result.stderr).toMatch(/timed out.*drained=false/);
  expect(result.stderr).not.toContain('synthetic source failure');
}, 20_000);

it('shares the same deadline with post-exit process-group cleanup', async () => {
  const harness = startLauncher('process.stdout.write("group-tail");', { ownGroup: true });
  const result = await bounded(harness);
  expect(result.code).toBe(1);
  expect(result.elapsed).toBeGreaterThanOrEqual(4_500);
  expect(result.stdout).toBe('group-tail');
  expect(result.stderr).toMatch(/timed out.*drained=false/);
  expect(readdirSync(join(harness.directory, 'reports'))).toEqual([]);
}, 20_000);

it('does not start the drain deadline while the main child is still running', async () => {
  const harness = startLauncher('process.stdout.write("still-running"); setInterval(() => {}, 1000);');
  await sleep(5_400);
  expect(harness.child.exitCode).toBeNull();
  expect(harness.output.stderr).toBe('');
  harness.child.kill('SIGTERM');
  const result = await bounded(harness);
  expect(result.code).toBe(143);
  expect(result.stdout).toBe('still-running');
  expect(result.stderr).not.toMatch(/timed out/);
}, 20_000);

it('preserves signal exit semantics after a normal output drain', async () => {
  const harness = startLauncher('process.stdout.write("signal-tail"); process.kill(process.pid, "SIGTERM");');
  const result = await bounded(harness);
  expect(result.code).toBe(143);
  expect(result.stdout).toBe('signal-tail');
  expect(result.stderr).not.toMatch(/timed out/);
}, 20_000);

it('keeps real source errors distinct from the expected timeout destruction', async () => {
  const harness = startLauncher('setInterval(() => {}, 1000);', {
    beforeLaunch: 'child.stdout.destroy(new Error("synthetic source failure"));',
  });
  const result = await bounded(harness);
  expect(result.code).not.toBe(0);
  expect(result.elapsed).toBeLessThan(4_500);
  expect(result.stderr).not.toMatch(/timed out.*drained=false/);
}, 20_000);
