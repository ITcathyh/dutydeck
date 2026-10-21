import { expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

it('plain node relay and a SIGHUP-ignoring child both exit after their private tmux pane closes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dd-relay-exit-')), socket = join(root, 'tmux.sock');
  const fixture = join(root, 'child.mjs'), pidFile = join(root, 'child.pid');
  const relay = fileURLToPath(new URL('../dist/program-status-relay.js', import.meta.url));
  writeFileSync(fixture, `import { writeFileSync } from 'node:fs'; process.on('SIGHUP', () => {}); writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);`);
  const tmux = (...args: string[]) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let relayPid: number | undefined, childPid: number | undefined;
  const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } };
  try {
    tmux('new-session', '-d', '-s', 'relay-exit', process.execPath, relay, process.execPath, fixture, pidFile);
    relayPid = Number(tmux('display-message', '-p', '-t', 'relay-exit', '#{pane_pid}'));
    await vi.waitFor(() => { childPid = Number(readFileSync(pidFile, 'utf8')); expect(childPid).toBeGreaterThan(0); }, { timeout: 5_000 });
    expect(gone(relayPid)).toBe(false); expect(gone(childPid!)).toBe(false);
    tmux('kill-pane', '-t', 'relay-exit');
    await vi.waitFor(() => { expect(gone(relayPid!)).toBe(true); expect(gone(childPid!)).toBe(true); }, { timeout: 12_000 });
  } finally {
    try { tmux('kill-server'); } catch { /* Private server already exited. */ }
    for (const pid of [relayPid, childPid]) if (pid && !gone(pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ }
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
