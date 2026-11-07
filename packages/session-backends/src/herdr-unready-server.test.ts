import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { childProcessIdentity, observeProcess } from '@dutydeck/storage';
import { HerdrBackend } from './herdr-backend.js';

const name = `dutydeck-${'f'.repeat(32)}`;
const probe = { identify: childProcessIdentity, observe: observeProcess };
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dd-herdr-unready-'));
  const binary = join(directory, 'herdr'), pidFile = join(directory, 'server.pid'), stateFile = join(directory, 'identity.json');
  // The fake server ignores SIGTERM and never shows up as running in the session list.
  writeFileSync(binary, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('herdr 0.9.0');
else if (args.includes('server')) {
  process.on('SIGTERM', () => {});
  require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  setInterval(() => {}, 1000);
} else if (args.includes('list')) console.log(JSON.stringify({ sessions: [] }));
else process.exit(2);
`, { mode: 0o700 });
  cleanups.push(() => {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      try { if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(binary)) process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ }
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const options = { binary, stateFile, ownerId: 'fixture', processProbe: probe, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } };
  return { directory, stateFile, options };
}

/** Every Date.now() read advances by `step`, so the 10s readiness and 5s signal waits pass quickly. */
function fastClock(step = 3000) {
  const now = Date.now.bind(Date);
  let skew = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now() + (skew += step));
}

describe.skipIf(process.platform !== 'linux')('Herdr dedicated server that never becomes ready', () => {
  it('retires the spawned server and leaves a reservation that proves stopped', async () => {
    const f = fixture();
    vi.spyOn(HerdrBackend.prototype as any, 'ownedProcesses').mockReturnValue([]);
    fastClock();
    const backend = new HerdrBackend(name, f.options);
    await expect(backend.spawn('/bin/sh', ['-c', 'true'], { cwd: f.directory, cols: 80, rows: 24, env: {} })).rejects.toThrow('did not become ready');
    const state = JSON.parse(readFileSync(f.stateFile, 'utf8'));
    expect(state).toMatchObject({ launching: true, close_intent: true, pane: null, socket: '' });
    expect(observeProcess(state.server)).toBe('dead');
    expect(await new HerdrBackend(name, f.options).isStopped()).toBe(true);
    expect(await backend.isStopped()).toBe(true);
  }, 30_000);

  it('stops a recorded unready server left behind by a controller that died while waiting', async () => {
    const f = fixture();
    vi.spyOn(HerdrBackend.prototype as any, 'ownedProcesses').mockReturnValue([]);
    const server = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    cleanups.unshift(() => { if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL'); });
    await new Promise(resolve => server.stdout!.once('data', resolve));
    const identity = childProcessIdentity(server.pid!);
    writeFileSync(f.stateFile, JSON.stringify({
      launch_id: '7'.repeat(64), owner: 'fixture', name, socket: '', dev: '', ino: '', server: identity, root: identity, pane: null,
      launching: true, process_cgroup: readFileSync(`/proc/${server.pid}/cgroup`, 'utf8'), identities: [identity],
    }));
    const backend = new HerdrBackend(name, f.options);
    expect(await backend.isStopped()).toBe(false);
    fastClock();
    await backend.stopOwnedIdentity();
    expect(observeProcess(identity)).toBe('dead');
    expect(server.signalCode).toBe('SIGKILL');
    expect(await backend.isStopped()).toBe(true);
  }, 30_000);
});
