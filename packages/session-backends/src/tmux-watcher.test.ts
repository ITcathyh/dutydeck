import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { TmuxBackend } from './tmux-backend.js';
import { runCommand } from './command.js';
vi.mock('./command.js', async original => {
  const actual = await original<typeof import('./command.js')>();
  return { ...actual, runCommand: vi.fn(actual.runCommand) };
});

type Watcher = { startExitWatcher(): void; stopExitWatcher(): void; probePaneAsync(): Promise<{ probe: 'missing' | 'unknown' | 'exists'; pid: number | null }> };
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
function watch() {
  const backend = new TmuxBackend('isolated-fixture');
  const watcher = backend as unknown as Watcher;
  const exit = vi.fn();
  backend.onExit(exit);
  watcher.startExitWatcher();
  cleanup.push(() => watcher.stopExitWatcher());
  return { backend, watcher, exit };
}

describe('asynchronous tmux exit watcher', () => {
  it('is single-flight and ignores results from a detached watcher', async () => {
    vi.useFakeTimers();
    let resolve!: (value: { probe: 'missing'; pid: null }) => void;
    const { watcher, exit } = watch();
    const probe = vi.spyOn(watcher, 'probePaneAsync').mockImplementation(() => new Promise(done => { resolve = done; }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(probe).toHaveBeenCalledTimes(1);
    watcher.stopExitWatcher();
    resolve({ probe: 'missing', pid: null });
    await vi.advanceTimersByTimeAsync(1000);
    expect(exit).not.toHaveBeenCalled();
  });

  it('requires three consecutive failures and treats unknown as inconclusive', async () => {
    vi.useFakeTimers();
    const { watcher, exit } = watch();
    const probe = vi.spyOn(watcher, 'probePaneAsync');
    probe.mockResolvedValueOnce({ probe: 'missing', pid: null }).mockResolvedValueOnce({ probe: 'missing', pid: null }).mockResolvedValueOnce({ probe: 'unknown', pid: null }).mockResolvedValue({ probe: 'missing', pid: null });
    await vi.advanceTimersByTimeAsync(5000);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('checks a live pane PID asynchronously and resets consecutive failures', async () => {
    vi.useFakeTimers();
    const { watcher, exit } = watch();
    vi.spyOn(watcher, 'probePaneAsync').mockResolvedValueOnce({ probe: 'missing', pid: null }).mockResolvedValueOnce({ probe: 'exists', pid: process.pid }).mockResolvedValue({ probe: 'missing', pid: null });
    await vi.advanceTimersByTimeAsync(4000);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('keeps HTTP responsive while four real local tmux command fixtures sleep', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tmux-slow-fixture-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const executable = join(directory, 'tmux');
    writeFileSync(executable, `#!${process.execPath}\nsetTimeout(() => { console.log('dutydeck-session-exists\\n${process.pid}'); }, 150);\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${directory}:${process.env.PATH}`);
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address() as { port: number };
    for (let index = 0; index < 4; index++) watch();
    await new Promise(resolve => setTimeout(resolve, 1010));
    const durations: number[] = [];
    for (let index = 0; index < 12; index++) {
      const start = performance.now();
      expect(await (await fetch(`http://127.0.0.1:${address.port}`)).text()).toBe('ok');
      durations.push(performance.now() - start);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(Math.max(...durations)).toBeLessThan(250);
  });
});

it.each([
  ['error connecting to /private/socket (Connection refused)', '', null, 'unknown'],
  ['lost server', '', 1, 'unknown'],
  ["can't find session: isolated-fixture", '', 1, 'missing'],
  ["can't find session: isolated-fixture", 'dutydeck-session-exists\n', 1, 'unknown'],
  ["can't find pane: isolated-fixture", 'dutydeck-session-exists\n', 1, 'unknown'],
  ['no server running on /private/socket', '', 1, 'missing'],
  ['error connecting to /private/socket (No such file or directory)', '', 1, 'missing'],
] as const)('classifies queue failure %s after stage %j', async (stderr, stdout, status, probe) => {
  const backend = new TmuxBackend('isolated-fixture') as unknown as Watcher;
  vi.mocked(runCommand).mockRejectedValueOnce({ stderr, stdout, status });
  expect(await backend.probePaneAsync()).toEqual({ probe, pid: null });
});
it.each(['', 'invalid', '-12', '1.5'])('treats invalid display PID %j as inconclusive', async pid => {
  const backend = new TmuxBackend('isolated-fixture') as unknown as Watcher;
  vi.mocked(runCommand).mockResolvedValueOnce(`dutydeck-session-exists\n${pid}\n`);
  expect(await backend.probePaneAsync()).toEqual({ probe: 'exists', pid: null });
});
it.each(['ESRCH', 'EPERM'])('only counts PID failure %s as exit when appropriate', async code => {
  vi.useFakeTimers(); const { watcher, exit } = watch();
  vi.spyOn(watcher, 'probePaneAsync').mockResolvedValue({ probe: 'exists', pid: 12345 });
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error(code), { code }); });
  await vi.advanceTimersByTimeAsync(3000); expect(exit).toHaveBeenCalledTimes(code === 'ESRCH' ? 1 : 0);
});
it('uses one client per tick against a real private tmux socket and observes session disappearance', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tmux-queue-real-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  vi.stubEnv('TMUX_TMPDIR', directory);
  const env = { ...process.env }; delete env.TMUX;
  await runCommand('tmux', ['-f', '/dev/null', 'new-session', '-d', '-s', 'isolated-fixture', 'sleep 30'], { env });
  cleanup.push(async () => { try { await runCommand('tmux', ['kill-server'], { env }); } catch { /* Already gone. */ } });
  const backend = new TmuxBackend('isolated-fixture') as unknown as Watcher;
  const calls = vi.mocked(runCommand).mock.calls.length;
  expect(await backend.probePaneAsync()).toMatchObject({ probe: 'exists', pid: expect.any(Number) });
  expect(vi.mocked(runCommand).mock.calls.length - calls).toBe(1);
  // Keep the server alive while the target disappears between queue stages.
  await runCommand('tmux', ['new-session', '-d', '-s', 'keeper', 'sleep 30'], { env });
  const race = await runCommand('tmux', [
    'has-session', '-t', 'isolated-fixture', ';',
    'display-message', '-p', 'dutydeck-session-exists', ';',
    'kill-session', '-t', 'isolated-fixture', ';',
    'display-message', '-p', '-t', 'isolated-fixture', '#{pane_pid}',
  ], { env }).catch(error => error);
  if (typeof race === 'string') {
    // tmux 3.3a returns success with an empty PID for a vanished target.
    expect(race.trim()).toBe('dutydeck-session-exists');
    vi.mocked(runCommand).mockResolvedValueOnce(race);
    expect(await backend.probePaneAsync()).toEqual({ probe: 'exists', pid: null });
  } else {
    expect(race.status).toBe(1); expect(race.stdout).toBe('dutydeck-session-exists\n');
    vi.mocked(runCommand).mockRejectedValueOnce(race);
    expect(await backend.probePaneAsync()).toEqual({ probe: 'unknown', pid: null });
  }
  const { watcher, exit } = watch();
  expect(await backend.probePaneAsync()).toEqual({ probe: 'missing', pid: null });
  await new Promise(resolve => setTimeout(resolve, 3200));
  expect(exit).toHaveBeenCalledTimes(1); watcher.stopExitWatcher();
});

it('keeps a timed-out queue inconclusive even if it also carries a missing-session message', async () => {
  const backend = new TmuxBackend('isolated-fixture') as unknown as Watcher;
  vi.mocked(runCommand).mockRejectedValueOnce({ status: 1, signal: 'SIGKILL', stderr: "can't find session: isolated-fixture" });
  expect(await backend.probePaneAsync()).toEqual({ probe: 'unknown', pid: null });
});
