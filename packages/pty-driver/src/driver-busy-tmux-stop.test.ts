import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TmuxBackend, isTmuxAvailable, type ProcessProbe } from '@dutydeck/session-backends';
import { childProcessIdentity, observeProcess } from '@dutydeck/storage';
import type { AgentConfig } from '@dutydeck/shared';
import { PtyCliDriver } from './driver.js';

// An agent running builds, tests or git keeps forking short-lived children in its pane.
const agent: AgentConfig = {
  id: 'busy-tmux', name: 'Busy tmux', protocol: 'pty-cli', command: '/bin/sh', args: ['-c', 'while true; do sleep 0.03 & sleep 0.01; done'],
  cwd: '/tmp', env: {}, permissionMode: 'full-trust', timeout: 60, capabilities: { resume: true, pause: false }, builtin: false,
};
const tmuxDescribe = (await isTmuxAvailable()) && process.platform === 'linux' ? describe : describe.skip;

tmuxDescribe('PtyCliDriver stop on a busy tmux pane (isolated TMUX_TMPDIR)', () => {
  let directory: string;
  const saved = process.env.TMUX_TMPDIR, savedTmux = process.env.TMUX;
  beforeAll(() => { directory = mkdtempSync(join(tmpdir(), 'dd-busy-stop-')); process.env.TMUX_TMPDIR = directory; delete process.env.TMUX; });
  afterAll(() => {
    try { execFileSync('/usr/bin/tmux', ['kill-server'], { env: { ...process.env, TMUX_TMPDIR: directory, TMUX: '' }, stdio: 'ignore' }); } catch { /* Already empty. */ }
    if (saved === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = saved;
    if (savedTmux !== undefined) process.env.TMUX = savedTmux;
    rmSync(directory, { recursive: true, force: true });
  });

  it.each([false, true])('stops the pane and proves exit (identity missed while wiring: %s)', async missedAtWire => {
    const name = `dd-busy-stop-${missedAtWire ? 'missed' : 'wired'}-${process.pid}`;
    const backend = new TmuxBackend(name, { ownerId: `dutydeck:${name}` });
    // Simulate the wiring-time census race deterministically: identity is unavailable until start() returns.
    let failIdentity = missedAtWire;
    const probe: ProcessProbe = {
      identify: pid => { if (failIdentity) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return childProcessIdentity(pid); },
      observe: observeProcess,
    };
    const driver = new PtyCliDriver({
      agent, adapter: { id: 'fixture', capabilities: {}, buildArgs: () => [], writeInput() {} }, backend,
      sessionId: `ses_${name}`, processProbe: probe, onEvent() {}, onExit() {},
    });
    await driver.start();
    failIdentity = false;
    expect(await TmuxBackend.probeSession(name)).toBe('exists');
    await driver.stop();
    expect(await driver.isStopped()).toBe(true);
    expect(await TmuxBackend.probeSession(name)).toBe('missing');
  }, 30_000);
});
