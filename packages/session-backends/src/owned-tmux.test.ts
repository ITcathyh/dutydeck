import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { childProcessIdentity, observeProcess } from '../../storage/src/process-identity.js';
import { captureOwnedTmuxIdentity, stopOwnedTmux, verifyOwnedTmuxExit, type OwnedTmuxScope, type ProcessProbe } from './owned-tmux.js';

const probe: ProcessProbe = { identify: childProcessIdentity, observe: observeProcess };
let root: string;
let socket: string;
const env = { ...process.env, TMUX: '', TMUX_TMPDIR: '' };
function tmux(...args: string[]) { return execFileSync('/usr/bin/tmux', ['-S', socket, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function scope(name = 'owned'): OwnedTmuxScope { return { socketPath: socket, sessionName: name, ownerId: `dutydeck:${name}`, hostname: hostname(), uid: process.getuid!() }; }
function create(name = 'owned') {
  tmux('new-session', '-d', '-s', name, '/bin/sh');
  tmux('set-option', '-t', name, '@dutydeck_owner_id', `dutydeck:${name}`);
}
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'dd-owned-tmux-'))); socket = join(root, 'socket'); });
afterEach(() => { try { tmux('kill-server'); } catch {} rmSync(root, { recursive: true, force: true }); });

describe('owned tmux physical exit proofs (real isolated server and process identity)', () => {
  it('stops only exact owned target, verifies proof again, and admits a later task', async () => {
    create(); create('other');
    const identity = captureOwnedTmuxIdentity(scope(), probe)!;
    const proof = await stopOwnedTmux(identity, probe);
    expect(proof.identities.length).toBeGreaterThan(0);
    expect(proof.identities.every(item => observeProcess(item) === 'dead')).toBe(true);
    expect(verifyOwnedTmuxExit(proof, probe)).toBe(true);
    expect(tmux('has-session', '-t', '=other')).toBe('');
    create(); // replacement is not covered by the old proof
    expect(verifyOwnedTmuxExit(proof, probe)).toBe(false);
    await stopOwnedTmux(captureOwnedTmuxIdentity(scope(), probe)!, probe);
  });
  it('rejects a missing initial socket and permits a batch missing target after the last verified stop', async () => {
    expect(() => captureOwnedTmuxIdentity(scope(), probe)).toThrow('PATH_UNAVAILABLE');
    create();
    const proof = await stopOwnedTmux(captureOwnedTmuxIdentity(scope(), probe)!, probe);
    expect(captureOwnedTmuxIdentity(scope('next'), probe, proof)).toBeUndefined();
  });
  it('accepts already-proven natural exit of the last session before stop', async () => {
    create(); const identity = captureOwnedTmuxIdentity(scope(), probe)!;
    tmux('send-keys', '-t', 'owned', 'exit', 'Enter');
    const proof = { ...identity, stoppedAt: new Date().toISOString() };
    for (let tries = 0; !verifyOwnedTmuxExit(proof, probe) && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    expect(verifyOwnedTmuxExit(proof, probe)).toBe(true);
    expect(verifyOwnedTmuxExit(await stopOwnedTmux(identity, probe), probe)).toBe(true);
  });
  it('rejects owner mutation between capture and stop without killing the target', async () => {
    create(); const identity = captureOwnedTmuxIdentity(scope(), probe)!;
    tmux('set-option', '-t', 'owned', '@dutydeck_owner_id', 'foreign');
    await expect(stopOwnedTmux(identity, probe)).rejects.toThrow('OWNER_MISMATCH');
    expect(tmux('has-session', '-t', '=owned')).toBe('');
  });
  it('refuses unknown process observations and foreign namespaces', async () => {
    create(); const identity = captureOwnedTmuxIdentity(scope(), probe)!;
    await expect(stopOwnedTmux(identity, { ...probe, observe: () => 'unknown' })).rejects.toThrow('PROCESS_STATE_CHANGED');
    identity.server.namespace = 'foreign';
    await expect(stopOwnedTmux(identity, probe)).rejects.toThrow('PROCESS_STATE_CHANGED');
    expect(tmux('has-session', '-t', '=owned')).toBe('');
  });
  it('is independent of later TMUX/TMUX_TMPDIR namespace changes', async () => {
    create(); const identity = captureOwnedTmuxIdentity(scope(), probe)!;
    const saved = process.env.TMUX_TMPDIR;
    process.env.TMUX_TMPDIR = join(root, 'different');
    try { expect(verifyOwnedTmuxExit(await stopOwnedTmux(identity, probe), probe)).toBe(true); }
    finally { if (saved === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = saved; }
  });
  it('rechecks ownership after the durable pre-kill callback', async () => {
    create(); const identity = captureOwnedTmuxIdentity(scope(), probe)!;
    let saved = false;
    await expect(stopOwnedTmux(identity, probe, async captured => {
      expect(captured.identities.length).toBeGreaterThan(0);
      saved = true;
      tmux('set-option', '-t', 'owned', '@dutydeck_owner_id', 'foreign');
    })).rejects.toThrow('OWNER_MISMATCH');
    expect(saved).toBe(true);
    expect(tmux('has-session', '-t', '=owned')).toBe('');
  });
  it('refuses children created during the durable pre-kill callback', async () => {
    create(); const identity = captureOwnedTmuxIdentity(scope(), probe)!;
    let child: ReturnType<typeof childProcessIdentity> | undefined;
    try {
      await expect(stopOwnedTmux(identity, probe, async () => {
        const pidFile = join(root, 'child-pid');
        tmux('send-keys', '-t', 'owned', `sleep 30 & echo $! > ${pidFile}; wait`, 'Enter');
        for (let tries = 0; tries < 100; tries++) {
          try { child = childProcessIdentity(Number(readFileSync(pidFile, 'utf8').trim())); break; }
          catch { await new Promise(resolve => setTimeout(resolve, 10)); }
        }
        expect(child).toBeDefined();
      })).rejects.toThrow('PROCESS_SET_CHANGED');
      expect(tmux('has-session', '-t', '=owned')).toBe('');
    } finally { if (child && observeProcess(child) === 'alive') process.kill(child.pid, 'SIGTERM'); }
  });
  it('does not treat an unlinked live server socket as proof of target absence', async () => {
    create(); create('other');
    const identity = captureOwnedTmuxIdentity(scope(), probe)!;
    const proof = await stopOwnedTmux(identity, probe);
    create(); // a replacement pane lives on the still-running server
    rmSync(socket);
    expect(observeProcess(identity.server)).toBe('alive');
    expect(verifyOwnedTmuxExit(proof, probe)).toBe(false);
    process.kill(identity.server.pid, 'SIGUSR1');
    await new Promise(resolve => setTimeout(resolve, 100));
  });
  it('does not accept a socket path replaced by an ordinary file', async () => {
    create(); const identity = captureOwnedTmuxIdentity(scope(), probe)!;
    rmSync(socket); writeFileSync(socket, 'replacement');
    await expect(stopOwnedTmux(identity, probe)).rejects.toThrow('PATH_TYPE_MISMATCH');
    // Recreate only this test server socket for cleanup.
    rmSync(socket);
    process.kill(identity.server.pid, 'SIGUSR1');
    await new Promise(resolve => setTimeout(resolve, 100));
  });
});
