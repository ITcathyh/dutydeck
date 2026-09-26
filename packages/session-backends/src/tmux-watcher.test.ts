import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { TmuxBackend } from './tmux-backend.js';

type Watcher = { startExitWatcher(): void; stopExitWatcher(): void; getPidAsync(): Promise<number | null> };
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
    let resolve!: (value: 'missing') => void;
    const probe = vi.spyOn(TmuxBackend, 'probeSessionAsync').mockImplementation(() => new Promise(done => { resolve = done; }));
    const { watcher, exit } = watch();
    await vi.advanceTimersByTimeAsync(5000);
    expect(probe).toHaveBeenCalledTimes(1);
    watcher.stopExitWatcher();
    resolve('missing');
    await vi.advanceTimersByTimeAsync(1000);
    expect(exit).not.toHaveBeenCalled();
  });

  it('requires three consecutive failures and treats unknown as inconclusive', async () => {
    vi.useFakeTimers();
    const probe = vi.spyOn(TmuxBackend, 'probeSessionAsync');
    probe.mockResolvedValueOnce('missing').mockResolvedValueOnce('missing').mockResolvedValueOnce('unknown').mockResolvedValue('missing');
    const { watcher, exit } = watch();
    const pid = vi.spyOn(watcher, 'getPidAsync');
    await vi.advanceTimersByTimeAsync(5000);
    expect(exit).not.toHaveBeenCalled();
    expect(pid).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('checks a live pane PID asynchronously and resets consecutive failures', async () => {
    vi.useFakeTimers();
    vi.spyOn(TmuxBackend, 'probeSessionAsync').mockResolvedValueOnce('missing').mockResolvedValueOnce('exists').mockResolvedValue('missing');
    const { watcher, exit } = watch();
    vi.spyOn(watcher, 'getPidAsync').mockResolvedValue(process.pid);
    await vi.advanceTimersByTimeAsync(4000);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('keeps HTTP responsive while four real local tmux command fixtures sleep', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tmux-slow-fixture-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const executable = join(directory, 'tmux');
    writeFileSync(executable, `#!${process.execPath}\nsetTimeout(() => { if (process.argv[2] === 'display-message') console.log(${process.pid}); }, 150);\n`, { mode: 0o755 });
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
