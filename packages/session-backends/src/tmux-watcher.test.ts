import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { TmuxBackend, classifyPaneListing } from './tmux-backend.js';
import { runCommand } from './command.js';
vi.mock('./command.js', async original => {
  const actual = await original<typeof import('./command.js')>();
  return { ...actual, runCommand: vi.fn(actual.runCommand) };
});

type Watcher = { startExitWatcher(): void; stopExitWatcher(): void };
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.mocked(runCommand).mockReset(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
function watch(name = 'isolated-fixture') {
  const backend = new TmuxBackend(name);
  const watcher = backend as unknown as Watcher;
  const exit = vi.fn();
  backend.onExit(exit);
  watcher.startExitWatcher();
  cleanup.push(() => watcher.stopExitWatcher());
  return { backend, watcher, exit };
}
const listing = (...rows: Array<[string, string, number | string]>) => rows.map(row => `${row.join('\t')}\n`).join('');
const listCalls = () => vi.mocked(runCommand).mock.calls.filter(([, args]) => args[0] === 'list-panes');

describe('asynchronous tmux exit watcher', () => {
  it('is single-flight and ignores results from a detached watcher', async () => {
    vi.useFakeTimers();
    let resolve!: (value: string) => void;
    vi.mocked(runCommand).mockImplementation(() => new Promise(done => { resolve = done; }));
    const { watcher, exit } = watch();
    await vi.advanceTimersByTimeAsync(5000);
    expect(listCalls()).toHaveLength(1);
    watcher.stopExitWatcher();
    resolve('');
    await vi.advanceTimersByTimeAsync(1000);
    expect(exit).not.toHaveBeenCalled();
  });

  it('shares one list-panes client per tick across sessions', async () => {
    vi.useFakeTimers();
    vi.mocked(runCommand).mockResolvedValue(listing(['a', '11', process.pid], ['b', '11', process.pid], ['c', '11', process.pid]));
    const watchers = ['a', 'b', 'c'].map(name => watch(name));
    await vi.advanceTimersByTimeAsync(5000);
    expect(listCalls()).toHaveLength(5);
    expect(listCalls()[0]?.[1]).toEqual(['list-panes', '-a', '-F', '#{session_name}\t#{window_active}#{pane_active}\t#{pane_pid}']);
    expect(listCalls()[0]?.[2]).toMatchObject({ timeout: 3000 });
    for (const { exit } of watchers) expect(exit).not.toHaveBeenCalled();
    for (const { watcher } of watchers) watcher.stopExitWatcher();
    await vi.advanceTimersByTimeAsync(3000);
    expect(listCalls()).toHaveLength(5);
  });

  it('does not hand an in-flight listing to a watcher subscribed after it started', async () => {
    vi.useFakeTimers();
    const pending: Array<(value: string) => void> = [];
    vi.mocked(runCommand).mockImplementation(() => new Promise(done => { pending.push(done); }));
    const early = watch('early');
    await vi.advanceTimersByTimeAsync(1000);
    const late = watch('late');
    for (let index = 0; index < 3; index++) {
      pending.shift()?.('');
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(early.exit).toHaveBeenCalledTimes(1);
    expect(late.exit).not.toHaveBeenCalled();
  });

  it('fires only for the session that disappeared while others stay alive', async () => {
    vi.useFakeTimers();
    vi.mocked(runCommand).mockResolvedValue(listing(['a', '11', process.pid]));
    const a = watch('a'); const b = watch('b');
    await vi.advanceTimersByTimeAsync(3000);
    expect(b.exit).toHaveBeenCalledTimes(1);
    expect(a.exit).not.toHaveBeenCalled();
  });

  it('marks every watcher missing when no server owns the socket', async () => {
    vi.useFakeTimers();
    vi.mocked(runCommand).mockRejectedValue({ status: 1, stderr: 'no server running on /private/socket' });
    const a = watch('a'); const b = watch('b');
    await vi.advanceTimersByTimeAsync(2000);
    expect(a.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(a.exit).toHaveBeenCalledTimes(1); expect(b.exit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(a.exit).toHaveBeenCalledTimes(1);
  });

  it('requires three consecutive failures and treats unknown as inconclusive', async () => {
    vi.useFakeTimers();
    vi.mocked(runCommand).mockResolvedValueOnce('').mockResolvedValueOnce('')
      .mockRejectedValueOnce({ code: 'ETIMEDOUT', signal: 'SIGKILL', status: null, stderr: '' })
      .mockResolvedValueOnce('').mockResolvedValueOnce('')
      .mockRejectedValueOnce({ status: 1, stderr: 'error connecting to /private/socket (Connection refused)' })
      .mockResolvedValue('');
    const { exit } = watch();
    await vi.advanceTimersByTimeAsync(8000);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('checks a live pane PID and resets consecutive failures', async () => {
    vi.useFakeTimers();
    vi.mocked(runCommand).mockResolvedValueOnce('').mockResolvedValueOnce(listing(['isolated-fixture', '11', process.pid])).mockResolvedValue('');
    const { exit } = watch();
    await vi.advanceTimersByTimeAsync(4000);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('keeps other watchers running when one exit listener throws', async () => {
    vi.useFakeTimers();
    vi.mocked(runCommand).mockResolvedValue('');
    const first = new TmuxBackend('a');
    first.onExit(() => { throw new Error('listener crash'); });
    (first as unknown as Watcher).startExitWatcher();
    cleanup.push(() => (first as unknown as Watcher).stopExitWatcher());
    const second = watch('b');
    await vi.advanceTimersByTimeAsync(3000);
    expect(second.exit).toHaveBeenCalledTimes(1);
  });

  it('keeps HTTP responsive while real local tmux command fixtures sleep', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tmux-slow-fixture-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const executable = join(directory, 'tmux');
    writeFileSync(executable, `#!${process.execPath}\nsetTimeout(() => { console.log('isolated-fixture\\t11\\t${process.pid}'); }, 150);\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${directory}:${process.env.PATH}`);
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address() as { port: number };
    // Fire the first 1s watcher tick at once; the fixture command still really sleeps.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    for (let index = 0; index < 4; index++) watch();
    vi.advanceTimersByTime(1000);
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
  ['error connecting to /private/socket (Connection refused)', 1, undefined, 'unknown'],
  ['error connecting to /private/socket (Connection refused)', null, undefined, 'unknown'],
  ['lost server', 1, undefined, 'unknown'],
  ['server exited unexpectedly', 1, undefined, 'unknown'],
  ['no server running on /private/socket', 1, undefined, 'missing'],
  ['error connecting to /private/socket (No such file or directory)', 1, undefined, 'missing'],
  ['no server running on /private/socket', 1, 'SIGKILL', 'unknown'],
  ['', null, undefined, 'unknown'],
] as const)('classifies list failure %s (status %j, signal %j)', (stderr, status, signal, probe) => {
  expect(classifyPaneListing({ error: { stderr, status, signal } }, 'isolated-fixture')).toEqual({ probe, pid: null });
});
it('treats spawn failures and timeouts as inconclusive', () => {
  expect(classifyPaneListing({ error: Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }) }, 'x')).toEqual({ probe: 'unknown', pid: null });
  expect(classifyPaneListing({ error: { code: 'ETIMEDOUT', signal: 'SIGKILL', status: null, stderr: 'no server running' } }, 'x')).toEqual({ probe: 'unknown', pid: null });
});
it.each(['', 'invalid', '-12', '1.5'])('treats invalid pane PID %j as exists without pid', pid => {
  expect(classifyPaneListing({ stdout: listing(['isolated-fixture', '11', pid]) }, 'isolated-fixture')).toEqual({ probe: 'exists', pid: null });
});
it('matches exact names, reads the active pane, and tolerates foreign tab names', () => {
  const stdout = listing(['isolated-fixture-2', '11', 7], ['a\tb', '11', 8], ['isolated-fixture', '00', 9], ['isolated-fixture', '01', 10], ['isolated-fixture', '11', 11]) + 'garbage\n';
  expect(classifyPaneListing({ stdout }, 'isolated-fixture')).toEqual({ probe: 'exists', pid: 11 });
  expect(classifyPaneListing({ stdout }, 'isolated')).toEqual({ probe: 'missing', pid: null });
  expect(classifyPaneListing({ stdout }, 'a\tb')).toEqual({ probe: 'exists', pid: 8 });
  expect(classifyPaneListing({ stdout: listing(['isolated-fixture', '10', 12]) }, 'isolated-fixture')).toEqual({ probe: 'exists', pid: null });
});
it.each(['ESRCH', 'EPERM'])('only counts PID failure %s as exit when appropriate', async code => {
  vi.useFakeTimers();
  vi.mocked(runCommand).mockResolvedValue(listing(['isolated-fixture', '11', 12345]));
  const { exit } = watch();
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error(code), { code }); });
  await vi.advanceTimersByTimeAsync(3000); expect(exit).toHaveBeenCalledTimes(code === 'ESRCH' ? 1 : 0);
});
it('agrees with display-message against a real private tmux socket and observes session disappearance', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tmux-queue-real-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  vi.stubEnv('TMUX_TMPDIR', directory);
  const env = { ...process.env }; delete env.TMUX;
  await runCommand('tmux', ['-f', '/dev/null', 'new-session', '-d', '-s', 'isolated-fixture', 'sleep 30'], { env });
  cleanup.push(async () => { try { await runCommand('tmux', ['kill-server'], { env }); } catch { /* Already gone. */ } });
  await runCommand('tmux', ['split-window', '-t', 'isolated-fixture', 'sleep 30'], { env });
  await runCommand('tmux', ['new-window', '-t', 'isolated-fixture', 'sleep 30'], { env });
  await runCommand('tmux', ['new-session', '-d', '-s', 'keeper', 'sleep 30'], { env });
  const list = () => runCommand('tmux', ['list-panes', '-a', '-F', '#{session_name}\t#{window_active}#{pane_active}\t#{pane_pid}'], { env }).then(stdout => ({ stdout }), error => ({ error }));
  const expected = Number((await runCommand('tmux', ['display-message', '-p', '-t', 'isolated-fixture', '#{pane_pid}'], { env })).trim());
  expect(classifyPaneListing(await list(), 'isolated-fixture')).toEqual({ probe: 'exists', pid: expected });
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const { watcher, exit } = watch();
  const keeper = watch('keeper');
  await runCommand('tmux', ['kill-session', '-t', 'isolated-fixture'], { env });
  expect(classifyPaneListing(await list(), 'isolated-fixture')).toEqual({ probe: 'missing', pid: null });
  await vi.waitFor(() => { vi.advanceTimersByTime(1000); expect(exit).toHaveBeenCalled(); }, { timeout: 5_000, interval: 20 });
  vi.advanceTimersByTime(3000);
  expect(exit).toHaveBeenCalledTimes(1); expect(keeper.exit).not.toHaveBeenCalled(); watcher.stopExitWatcher();
  await runCommand('tmux', ['kill-server'], { env });
  expect(classifyPaneListing(await list(), 'keeper').probe).not.toBe('exists');
});
