import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCliAdapter, pinnedSessionUuid } from '@dutydeck/cli-adapters';
import { TmuxBackend } from '@dutydeck/session-backends';
import { agentConfigSchema } from '@dutydeck/shared';
import { createRepositories, childProcessIdentity, observeProcess } from '@dutydeck/storage';
import { DutydeckRuntime } from '../../agent-runtime/src/index.js';
import { PtyCliDriver } from './driver.js';

const script = fileURLToPath(new URL('./fixtures/claude-native-session.mjs', import.meta.url));
const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function fixture(child?: string) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dd-idle-cpu-')));
  vi.stubEnv('HOME', cwd); vi.stubEnv('TMUX_TMPDIR', cwd);
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const drivers: PtyCliDriver[] = [], launches: string[][] = [];
  const runtime = new DutydeckRuntime(repos, { cleanupIntervalMs: 0, driverIdleTimeoutMs: 0, driverIdleCpuAction: 'retire',
    probe: () => ({ available: true, protocol: 'pty-cli', resume: true }),
    ptyDriverFactory: (agent, _protocol, onEvent, onExit, sessionId) => {
      const driver = new PtyCliDriver({ agent, adapter: { ...createCliAdapter('seed'), prepareInput: undefined,
        buildArgs: context => {
          const args = [script, context.resume ? '--resume' : '--session-id', context.resumeSessionId ?? pinnedSessionUuid(context.sessionId)];
          launches.push(args); return args;
        }, writeInput: async (pty, prompt) => { await pty.write(JSON.stringify({ prompt }) + '\r'); } },
        backend: new TmuxBackend(`cpu-${sessionId}`, { ownerId: `dutydeck:${sessionId}` }),
        processProbe: { identify: childProcessIdentity, observe: observeProcess }, sessionId, onEvent, onExit });
      drivers.push(driver); return driver;
    },
  });
  close.push(async () => {
    await runtime.shutdown(); repos.close();
    try { execFileSync('tmux', ['-S', join(cwd, `tmux-${process.getuid!()}`, 'default'), 'kill-server'], { stdio: 'ignore' }); } catch { /* own server only */ }
    rmSync(cwd, { recursive: true, force: true });
  });
  const agent = agentConfigSchema.parse({ id: 'seed', name: 'fixture', command: process.execPath, args: [], cwd,
    env: { HOME: cwd, CLAUDE_CONFIG_DIR: cwd, FIXTURE_IDLE_CPU: '1', ...(child ? { FIXTURE_IDLE_CHILD: child } : {}) },
    permissionMode: 'full-trust', timeout: 30, protocol: 'pty-cli', capabilities: { resume: true } });
  await runtime.initialize([agent]); const session = await runtime.start({ agentId: agent.id, cwd });
  expect((await runtime.send(session.id, 'first')).status).toBe('completed');
  const driver = drivers[0]!;
  await vi.waitFor(() => expect(runtime.getActiveTaskContext(session.id)).toBeUndefined());
  await vi.waitFor(async () => expect(await driver.prepareForIdleRetirement()).toBe(true), { timeout: 10_000 });
  return { cwd, runtime, session, driver, drivers, launches };
}

it.skipIf(process.platform !== 'linux')('reclaims a real spinning private CLI and resumes its original native conversation', async () => {
  const h = await fixture();
  const original = h.driver.idleCpuProof(); expect(original).toBeDefined();
  const pid = h.driver.processIds()[0]!, identity = childProcessIdentity(pid);
  const clockStart = Date.now(), base = clockStart + 11 * 60_000;
  // Compress waiting only: scale both measured process CPU and elapsed wall
  // time by the same factor. Actual ratio, PID/birth, tree and resume checks remain real.
  const capture = h.driver.idleCpuProof.bind(h.driver);
  vi.spyOn(h.driver, 'idleCpuProof').mockImplementation(() => { const p = capture(); return p && { ...p, cpuMs: p.cpuMs * 100, sampledAt: base + (p.sampledAt - clockStart) * 100 }; });
  for (let i = 0; i < 20 && h.runtime.getDriver(h.session.id); i++) {
    await h.runtime.cleanupIdleDrivers(base + (Date.now() - clockStart) * 100);
    if (h.runtime.getDriver(h.session.id)) await new Promise(resolve => setTimeout(resolve, 800));
  }
  expect(h.runtime.getDriver(h.session.id)).toBeUndefined();
  expect(observeProcess(identity)).toBe('dead');
  expect((await h.runtime.send(h.session.id, 'second')).status).toBe('completed');
  expect(h.drivers).toHaveLength(2);
  expect(h.launches.at(-1)).toEqual([script, '--resume', original!.nativeSessionId]);
  await vi.waitFor(() => expect(h.drivers[1]!.idleCpuProof()?.nativeSessionId).toBe(original!.nativeSessionId));
}, 45_000);

it.skipIf(process.platform !== 'linux').each(['shell', 'watcher', 'mcp'])('preserves a real CLI with a live %s child', async child => {
  const h = await fixture(child);
  const childPid = Number(readFileSync(join(h.cwd, 'child.pid'), 'utf8'));
  const identity = childProcessIdentity(childPid);
  expect(h.driver.isIdle()).toBe(true);
  expect(h.driver.hasBackgroundWork()).toBe(false);
  expect(h.driver.idleCpuProof()).toBeUndefined();
  for (let i = 0; i < 5; i++) await h.runtime.cleanupIdleDrivers(Date.now() + (11 + i * 2) * 60_000);
  expect(h.runtime.getDriver(h.session.id)).toBe(h.driver);
  expect(observeProcess(identity)).toBe('alive');
}, 30_000);

it.skipIf(process.platform !== 'linux')('rejects an old input proof and fences terminal input synchronously before stop', async () => {
  const h = await fixture(); const original = h.driver.idleCpuProof()!; expect(original).toBeDefined();
  const stream = h.driver.createTerminalStream();
  const writing = stream.write('/compact\r');
  expect(h.driver.idleCpuProof()).toBeUndefined();
  expect(h.driver.beginIdleCpuRetirement(original)).toBe(false);
  await writing;
  await vi.waitFor(() => expect(h.driver.idleCpuProof()).toBeDefined());
  expect(await h.driver.prepareForIdleRetirement()).toBe(true);
  const current = h.driver.idleCpuProof()!;
  expect(current.inputRevision).toBeGreaterThan(original.inputRevision);
  expect(h.driver.beginIdleCpuRetirement(current)).toBe(true);
  await expect(stream.write('new input')).rejects.toThrow();
  await expect(h.driver.send('new turn')).rejects.toThrow();
  const pid = h.driver.processIds()[0]!, identity = childProcessIdentity(pid);
  vi.spyOn(h.driver, 'idleCpuProof').mockReturnValueOnce(undefined);
  expect(() => h.driver.stop()).toThrow('Idle CPU retirement proof changed');
  expect(observeProcess(identity)).toBe('alive');
  await expect(stream.write('still fenced')).rejects.toThrow();
  await h.driver.stop(); expect(await h.driver.isStopped()).toBe(true);
}, 30_000);
