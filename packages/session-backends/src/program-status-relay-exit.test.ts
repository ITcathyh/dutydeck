import { expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

it('plain node relay and a SIGHUP-ignoring child both exit after their private tmux pane closes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dd-relay-exit-')), socket = join(root, 'tmux.sock');
  const fixture = join(root, 'child.mjs'), pidFile = join(root, 'child.pid'), preload = join(root, 'preload.mjs');
  const relay = fileURLToPath(new URL('../dist/program-status-relay.js', import.meta.url));
  writeFileSync(fixture, `import { writeFileSync } from 'node:fs'; process.on('SIGHUP', () => {}); writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);`);
  // The real relay runs its real escalation; only its 5s SIGNAL_EXIT_GRACE_MS is shortened, from outside.
  writeFileSync(preload, `const real = globalThis.setTimeout; globalThis.setTimeout = (callback, ms, ...args) => real(callback, ms === 5000 ? 100 : ms, ...args);`);
  const tmux = (...args: string[]) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let relayPid: number | undefined, childPid: number | undefined;
  const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } };
  try {
    tmux('new-session', '-d', '-s', 'relay-exit', process.execPath, '--import', pathToFileURL(preload).href, relay, process.execPath, fixture, pidFile);
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

// Claude prints on its way out; once the pane is gone those writes fail and the
// relay used to pause the inner PTY forever, so only the 5s+2s SIGKILL escalation
// ended it, past stopOwnedTmux's exit proof deadline.
it.each(['exit burst', 'continuous output'])('relay exits promptly after kill-session when the CLI writes during teardown (%s)', async mode => {
  const root = mkdtempSync(join(tmpdir(), 'dd-relay-kill-')), socket = join(root, 'tmux.sock');
  const fixture = join(root, 'child.mjs'), pidFile = join(root, 'child.pid');
  const relay = fileURLToPath(new URL('../dist/program-status-relay.js', import.meta.url));
  writeFileSync(fixture, `import { writeFileSync } from 'node:fs';
const chunk = 'x'.repeat(16 * 1024);
const flood = ${mode === 'continuous output'} ? setInterval(() => process.stdout.write(chunk), 5) : setInterval(() => {}, 1000);
process.on('SIGHUP', () => { clearInterval(flood); process.stdout.write(chunk.repeat(16), () => process.exit(0)); });
writeFileSync(process.argv[2], String(process.pid));`);
  const tmux = (...args: string[]) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let relayPid: number | undefined, childPid: number | undefined;
  const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } };
  try {
    tmux('new-session', '-d', '-s', 'relay-kill', process.execPath, relay, process.execPath, fixture, pidFile);
    relayPid = Number(tmux('display-message', '-p', '-t', 'relay-kill', '#{pane_pid}'));
    await vi.waitFor(() => { childPid = Number(readFileSync(pidFile, 'utf8')); expect(childPid).toBeGreaterThan(0); }, { timeout: 5_000 });
    await new Promise(resolve => setTimeout(resolve, 300));
    const killedAt = Date.now();
    tmux('kill-session', '-t', 'relay-kill');
    let relayExitMs: number | undefined;
    while (Date.now() - killedAt < 12_000) {
      if (gone(relayPid)) { relayExitMs = Date.now() - killedAt; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    console.log(`[relay-kill] mode=${mode} relayExitMs=${relayExitMs ?? '>12000'} childGone=${gone(childPid!)}`);
    expect(gone(childPid!)).toBe(true);
    expect(relayExitMs).toBeLessThan(1_500);
  } finally {
    try { tmux('kill-server'); } catch { /* Private server already exited. */ }
    for (const pid of [relayPid, childPid]) if (pid && !gone(pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ }
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
