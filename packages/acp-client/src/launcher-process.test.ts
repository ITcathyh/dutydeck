import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseProcStat, procStatExited } from '@dutydeck/shared';

const launcher = resolve('packages/acp-client/agents/launcher-process.mjs');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const cleanupUnknownExitCode = 120;

interface Result { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; elapsed: number }
interface Harness {
  child: ChildProcess;
  directory: string;
  ownGroup: boolean;
  result: Promise<Result>;
  output: { stdout: string; stderr: string };
}
const active = new Set<Harness>();

const identityHelper = `
  import { readFileSync as fixtureReadFileSync, writeFileSync } from 'node:fs';
  const recordProcess = (file, pid) => {
    const raw = fixtureReadFileSync('/proc/' + pid + '/stat', 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    writeFileSync(file, pid + ' ' + fields[19] + ' ' + fields[2] + '\\n');
  };
`;

function startLauncher(script: string, options: { ownGroup?: boolean; beforeLaunch?: string; pauseOutputMs?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dd-launcher-process-'));
  mkdirSync(join(directory, 'reports'));
  const ownGroup = options.ownGroup ?? false;
  const agentPidFile = join(directory, 'agent.pid');
  const forceGroupAlive = ownGroup ? `
    const originalKill = process.kill.bind(process);
    process.kill = (pid, signal) => {
      if (pid < 0 && (signal === 0 || signal === 'SIGKILL')) throw Object.assign(new Error('synthetic group probe failure'), { code: 'EPERM' });
      return originalKill(pid, signal);
    };
  ` : '';
  const bootstrap = `
    import { launchAgent } from ${JSON.stringify(pathToFileURL(launcher).href)};
    ${identityHelper}
    ${forceGroupAlive}
    const child = launchAgent(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(`${identityHelper}\n${script}`)}], process.env, { stdio: ['ignore', 'pipe', 'pipe'] });
    recordProcess(${JSON.stringify(agentPidFile)}, child.pid);
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
    child.stderr!.pause();
    setTimeout(() => { child.stdout!.resume(); child.stderr!.resume(); }, options.pauseOutputMs);
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

async function bounded(harness: Harness, timeoutMs = 20_000): Promise<Result> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      harness.result,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('launcher did not finish within the test bound')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer!); }
}

/** Signal only the exact live identity recorded by our fixture. Invalid records never become a numeric kill target. */
function signalRecordedProcess(file: string, ownGroup: boolean, signal: (target: number) => void = target => { process.kill(target, 'SIGKILL'); }) {
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw error; }
  const match = /^([1-9]\d*) ([1-9]\d*) ([1-9]\d*)\n$/.exec(raw);
  if (!match) return 'invalid';
  const recorded = { pid: Number(match[1]), start: match[2], pgid: Number(match[3]) };
  if (recorded.pid <= 1 || recorded.pgid <= 1 || (ownGroup && recorded.pgid !== recorded.pid)) return 'invalid';
  let current: ReturnType<typeof parseProcStat>;
  try { current = parseProcStat(readFileSync(`/proc/${recorded.pid}/stat`, 'utf8')); }
  catch { return 'gone'; }
  if (procStatExited(current) || current.start !== recorded.start || current.pgid !== recorded.pgid || (ownGroup && current.pgid !== recorded.pid)) return 'identity-mismatch';
  signal(ownGroup ? -recorded.pgid : recorded.pid);
  return 'signalled';
}

afterEach(() => {
  const errors: unknown[] = [];
  for (const harness of active) {
    if (harness.child.exitCode === null && harness.child.signalCode === null) {
      try { harness.child.kill('SIGKILL'); } catch (error) { errors.push(error); }
    }
    for (const [name, ownGroup] of [['agent.pid', harness.ownGroup], ['escaped.pid', false]] as const) {
      const file = join(harness.directory, name);
      if (!existsSync(file)) continue;
      try {
        const status = signalRecordedProcess(file, ownGroup);
        if (status === 'invalid') errors.push(new Error(`invalid process identity record: ${name}`));
      } catch (error) { errors.push(error); }
    }
    rmSync(harness.directory, { recursive: true, force: true });
  }
  active.clear();
  if (errors.length) throw new AggregateError(errors, 'launcher fixture cleanup failed');
});

it('never turns an empty, non-canonical, or unsafe PID record into a signal', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dd-launcher-pid-record-'));
  const file = join(directory, 'agent.pid');
  const targets: number[] = [];
  try {
    for (const raw of ['', '  ', '0 1 1\n', '1 1 1\n', '-2 1 2\n', '01 1 1\n', '2x 1 2\n', '2 1\n']) {
      writeFileSync(file, raw);
      expect(signalRecordedProcess(file, false, target => targets.push(target)), JSON.stringify(raw)).toBe('invalid');
    }
    writeFileSync(file, `${process.pid} 1 1\n`);
    expect(signalRecordedProcess(file, false, target => targets.push(target))).not.toBe('signalled');
    expect(targets).toEqual([]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
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
}, 30_000);

it('waits beyond five seconds for slow stdout and stderr readers without changing the exit code', async () => {
  const stdout = `start-${'x'.repeat(256 * 1024)}-end`;
  const stderr = `err-start-${'e'.repeat(128 * 1024)}-err-end`;
  const harness = startLauncher(`
    import { spawn } from 'node:child_process';
    import { join } from 'node:path';
    const writer = spawn(process.execPath, ['--input-type=module', '-e', \`
      process.stdout.write('start-' + 'x'.repeat(${256 * 1024}) + '-end', () => {
        process.stderr.write('err-start-' + 'e'.repeat(${128 * 1024}) + '-err-end', () => process.exit(0));
      });
    \`], { stdio: ['ignore', 'inherit', 'inherit'] });
    recordProcess(join(process.env.fixture_dir, 'escaped.pid'), writer.pid);
    writer.unref();
    process.exit(7);
  `, { pauseOutputMs: 6_200 });
  const result = await bounded(harness);
  expect(result.code).toBe(7);
  expect(result.stdout).toBe(stdout);
  expect(result.stderr).toBe(stderr);
  expect(result.elapsed).toBeGreaterThanOrEqual(6_000);
}, 30_000);

it('bounds an inherited stdout descriptor after child exit and preserves the read tail', async () => {
  const harness = startLauncher(`
    import { spawn } from 'node:child_process';
    import { join } from 'node:path';
    const escaped = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true, stdio: ['ignore', 'inherit', 'ignore'],
    });
    recordProcess(join(process.env.fixture_dir, 'escaped.pid'), escaped.pid);
    escaped.unref();
    process.stdout.write('tail-before-undrained');
  `);
  const result = await bounded(harness);
  expect(result.code).toBe(cleanupUnknownExitCode);
  expect(result.elapsed).toBeGreaterThanOrEqual(4_500);
  expect(result.stdout).toBe('tail-before-undrained');
  expect(result.stderr).toContain('sourcesClosed=false destinationFlushed=true groupExited=true');
}, 30_000);

it('retains the report and identifies process-group proof as the only failed cleanup state', async () => {
  const harness = startLauncher('process.stdout.write("group-tail");', { ownGroup: true });
  const result = await bounded(harness);
  expect(result.code).toBe(cleanupUnknownExitCode);
  expect(result.elapsed).toBeGreaterThanOrEqual(4_500);
  expect(result.stdout).toBe('group-tail');
  expect(result.stderr).toContain('sourcesClosed=true destinationFlushed=true groupExited=false');
  const reports = readdirSync(join(harness.directory, 'reports'));
  expect(reports).toHaveLength(1);
  const report = readFileSync(join(harness.directory, 'reports', reports[0]!), 'utf8');
  expect(report).toContain('dutydeck_cleanup_unknown {"sourcesClosed":true,"destinationFlushed":true,"groupExited":false}\n');
}, 30_000);

it('bounds inherited-source and process-group delays together', async () => {
  const harness = startLauncher(`
    import { spawn } from 'node:child_process';
    import { join } from 'node:path';
    const escaped = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true, stdio: ['ignore', 'inherit', 'ignore'],
    });
    recordProcess(join(process.env.fixture_dir, 'escaped.pid'), escaped.pid);
    escaped.unref();
    process.stdout.write('combined-tail');
  `, { ownGroup: true });
  const result = await bounded(harness);
  expect(result.code).toBe(cleanupUnknownExitCode);
  expect(result.elapsed).toBeLessThan(9_000);
  expect(result.stdout).toBe('combined-tail');
  expect(result.stderr).toContain('sourcesClosed=false destinationFlushed=true groupExited=false');
  expect(readdirSync(join(harness.directory, 'reports'))).toHaveLength(1);
}, 30_000);

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
}, 30_000);

it('preserves signal exit semantics after a normal output drain', async () => {
  const harness = startLauncher('process.stdout.write("signal-tail"); process.kill(process.pid, "SIGTERM");');
  const result = await bounded(harness);
  expect(result.code).toBe(143);
  expect(result.stdout).toBe('signal-tail');
  expect(result.stderr).not.toMatch(/timed out/);
}, 30_000);

it('does not report success when output forwarding fails after an Agent exit 0', async () => {
  const harness = startLauncher(`
    import { spawn } from 'node:child_process';
    import { join } from 'node:path';
    const escaped = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true, stdio: ['ignore', 'inherit', 'ignore'],
    });
    recordProcess(join(process.env.fixture_dir, 'escaped.pid'), escaped.pid);
    escaped.unref();
    process.exitCode = 0;
  `, {
    beforeLaunch: 'child.once("exit", () => child.stdout.destroy(new Error("synthetic source failure")));',
  });
  const result = await bounded(harness);
  expect(result.code).toBe(1);
  expect(result.stderr).not.toMatch(/post-exit cleanup.*timed out/);
}, 30_000);

it('keeps real source errors distinct from the expected timeout destruction', async () => {
  const harness = startLauncher('setInterval(() => {}, 1000);', {
    beforeLaunch: 'child.stdout.destroy(new Error("synthetic source failure"));',
  });
  const result = await bounded(harness);
  expect(result.code).not.toBe(0);
  expect(result.stderr).not.toMatch(/post-exit cleanup.*timed out/);
}, 30_000);
