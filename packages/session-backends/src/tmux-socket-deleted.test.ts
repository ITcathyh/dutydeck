import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TmuxBackend, isTmuxAvailable } from './tmux-backend.js';

// /tmp cleanup (systemd-tmpfiles, macOS periodic) can delete a long-lived
// server's socket file while the server and its CLI keep running.
const tmuxDescribe = (await isTmuxAvailable()) && process.platform === 'linux' ? describe : describe.skip;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

tmuxDescribe('TmuxBackend exit watcher after its socket file is deleted', () => {
  let root: string, socket: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'dd-tmux-socket-gone-'));
    socket = join(root, `tmux-${process.getuid!()}`, 'default');
    vi.stubEnv('TMUX_TMPDIR', root);
    vi.stubEnv('TMUX', undefined);
    vi.stubEnv('TMUX_PANE', undefined);
  });
  afterAll(() => {
    try { execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ }
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('does not report exit while the known pane process still runs, and does once it exits', async () => {
    const backend = new TmuxBackend(`dd-socket-gone-${process.pid}`);
    const exit = vi.fn();
    backend.onExit(exit);
    await backend.spawn('/bin/sleep', ['1000'], { cwd: root, cols: 80, rows: 24, env: { HOME: root, PATH: process.env.PATH! } });
    const pid = (await backend.getPid())!;
    expect(alive(pid)).toBe(true);
    // Without a socket, kill-server cannot reach this server: clean up by PID.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'), server = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    try {
      // Let the watcher see the pane through the live server at least once.
      await new Promise(resolve => setTimeout(resolve, 1_500));
      rmSync(socket);
      expect(await TmuxBackend.probeSession(backend.sessionName)).toBe('missing');
      await new Promise(resolve => setTimeout(resolve, 5_000));
      expect(exit).not.toHaveBeenCalled();
      expect(alive(pid)).toBe(true);
      // The CLI really exits: with the socket still gone, the watcher reports it.
      process.kill(pid, 'SIGKILL');
      await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1), { timeout: 8_000, interval: 100 });
    } finally { for (const target of [pid, server]) if (alive(target)) process.kill(target, 'SIGKILL'); }
  }, 30_000);
});
