import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { childProcessIdentity, observeProcess } from '../../storage/src/process-identity.js';
import { captureOwnedTmuxAbsence, captureOwnedTmuxIdentity, stopOwnedTmux, verifyOwnedTmuxAbsence, verifyOwnedTmuxExit, type OwnedTmuxScope, type ProcessProbe } from './owned-tmux.js';

const probe: ProcessProbe = { identify: childProcessIdentity, observe: observeProcess };
let root: string;
let socket: string;
const env = { ...process.env, TMUX: '', TMUX_TMPDIR: '' };
function tmux(...args: string[]) { return execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function scope(name = 'owned'): OwnedTmuxScope { return { socketPath: socket, sessionName: name, ownerId: `dutydeck:${name}`, hostname: hostname(), uid: process.getuid!() }; }
function create(name = 'owned') {
  tmux('new-session', '-d', '-s', name, '/bin/sh');
  tmux('set-option', '-t', name, '@dutydeck_owner_id', `dutydeck:${name}`);
}
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'dd-owned-tmux-'))); socket = join(root, 'socket'); });
afterEach(() => { try { tmux('kill-server'); } catch {} rmSync(root, { recursive: true, force: true }); });

describe('owned tmux physical exit proofs (real isolated server and process identity)', () => {
  it.skipIf(process.platform !== 'linux')('proves absence from a stale socket file after the server was killed', async () => {
    create('other');
    const server = childProcessIdentity(Number(tmux('display-message', '-p', '-t', 'other', '#{pid}')));
    const stat = statSync(socket, { bigint: true });
    process.kill(server.pid, 'SIGKILL');
    await vi.waitFor(() => expect(readFileSync('/proc/net/unix', 'utf8').split('\n').some(line => line.endsWith(` ${socket}`))).toBe(false));
    expect(statSync(socket).isSocket()).toBe(true);
    const absence = (await captureOwnedTmuxAbsence(scope(), probe))!;
    expect(absence).toMatchObject({ absent: true, socket: { dev: String(stat.dev), ino: String(stat.ino) } });
    expect(await verifyOwnedTmuxAbsence(absence, probe)).toBe(true);
  });
  it('handles session names containing a separator without hiding a matching owner', async () => {
    create('unrelated|session');
    tmux('set-option', '-t', 'unrelated|session', '@dutydeck_owner_id', 'dutydeck:other');
    const absence = (await captureOwnedTmuxAbsence(scope(), probe))!;
    expect(absence).toMatchObject({ absent: true });
    expect(await verifyOwnedTmuxAbsence(absence, probe)).toBe(true);
    create(); tmux('rename-session', '-t', 'owned', 'renamed|session');
    expect(await captureOwnedTmuxAbsence(scope(), probe)).toBeUndefined();
    expect(await verifyOwnedTmuxAbsence(absence, probe)).toBe(false);
  });
  it.skipIf(process.getuid?.() === 0)('rejects an unrecognized tmux connection error instead of declaring absence', async () => {
    create('other');
    const absence = (await captureOwnedTmuxAbsence(scope(), probe))!;
    const mode = statSync(socket).mode & 0o7777;
    try {
      chmodSync(socket, 0);
      await expect(captureOwnedTmuxAbsence(scope(), probe)).rejects.toThrow();
      expect(await verifyOwnedTmuxAbsence(absence, probe)).toBe(false);
    } finally { chmodSync(socket, mode); }
  });
  it('does not prove absence when the owned session was renamed', async () => {
    create('other');
    const absence = (await captureOwnedTmuxAbsence(scope(), probe))!;
    create(); tmux('rename-session', '-t', 'owned', 'renamed');
    expect(tmux('show-options', '-v', '-t', 'renamed', '@dutydeck_owner_id')).toBe(scope().ownerId);
    expect(await captureOwnedTmuxAbsence(scope(), probe)).toBeUndefined();
    expect(await verifyOwnedTmuxAbsence(absence, probe)).toBe(false);
  });
  it.skipIf(process.platform !== 'linux')('proves absence for an initially absent socket only when no kernel binding remains', async () => {
    const absence = (await captureOwnedTmuxAbsence(scope(), probe))!;
    expect(absence).toMatchObject({ absent: true, scope: scope() });
    expect(await verifyOwnedTmuxAbsence(absence, probe)).toBe(true);
  });
  it.skipIf(process.platform !== 'linux')('does not prove absence for an absent socket still bound by a live server', async () => {
    create('other');
    const absence = (await captureOwnedTmuxAbsence(scope(), probe))!;
    const server = childProcessIdentity(Number(tmux('display-message', '-p', '-t', 'other', '#{pid}')));
    try {
      rmSync(socket);
      await expect(captureOwnedTmuxAbsence(scope(), probe)).rejects.toThrow('SOCKET_STILL_BOUND');
      expect(await verifyOwnedTmuxAbsence(absence, probe)).toBe(false);
    } finally {
      if (observeProcess(server) === 'alive') process.kill(server.pid, 'SIGTERM');
      await vi.waitFor(() => expect(readFileSync('/proc/net/unix', 'utf8').split('\n').some(line => line.endsWith(` ${socket}`))).toBe(false));
    }
  });
  it('proves absence on a verified live socket and rechecks it before use', async () => {
    create('other');
    const absence = (await captureOwnedTmuxAbsence(scope(), probe))!;
    expect(absence).toMatchObject({ absent: true, scope: scope() });
    expect(await verifyOwnedTmuxAbsence(absence, probe)).toBe(true);
    create();
    expect(await captureOwnedTmuxAbsence(scope(), probe)).toBeUndefined();
    expect(await verifyOwnedTmuxAbsence(absence, probe)).toBe(false);
    tmux('kill-server');
    rmSync(socket, { force: true });
    await vi.waitFor(async () => expect(await verifyOwnedTmuxAbsence(absence, probe)).toBe(process.platform === 'linux'));
  });
  it('stops only exact owned target, verifies proof again, and admits a later task', async () => {
    create(); create('other');
    const identity = (await captureOwnedTmuxIdentity(scope(), probe))!;
    expect(identity.identities.map(item => item.pid)).toEqual(identity.identities.map(item => item.pid).sort((a, b) => a - b));
    const proof = await stopOwnedTmux(identity, probe);
    expect(proof.identities.length).toBeGreaterThan(0);
    expect(proof.identities.every(item => observeProcess(item) === 'dead')).toBe(true);
    expect((await verifyOwnedTmuxExit(proof, probe))).toBe(true);
    expect(tmux('has-session', '-t', '=other')).toBe('');
    create(); // replacement is not covered by the old proof
    expect((await verifyOwnedTmuxExit(proof, probe))).toBe(false);
    await stopOwnedTmux((await captureOwnedTmuxIdentity(scope(), probe))!, probe);
  });
  it('drives the server through the tmux found on PATH, not a fixed install path', async () => {
    create();
    const bin = join(root, 'bin'), log = join(root, 'client.log');
    const real = execFileSync('/bin/sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim();
    mkdirSync(bin);
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\necho "$3" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    try {
      const proof = await stopOwnedTmux((await captureOwnedTmuxIdentity(scope(), probe))!, probe);
      expect(await verifyOwnedTmuxExit(proof, probe)).toBe(true);
      expect(readFileSync(log, 'utf8').split('\n')).toEqual(expect.arrayContaining(['has-session', 'if-shell']));
    } finally { vi.unstubAllEnvs(); }
  });
  it('refuses to capture a process set where /proc is unavailable, leaving the session alone', async () => {
    create();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const fake: ProcessProbe = { identify: pid => ({ host: 'host', boot: 'boot', namespace: 'pid', pid, start: '1' }), observe: () => 'alive' };
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    try { await expect(captureOwnedTmuxIdentity(scope(), fake)).rejects.toThrow('LEGACY_TMUX_PLATFORM_UNSUPPORTED'); }
    finally { Object.defineProperty(process, 'platform', platform); }
    expect(tmux('has-session', '-t', '=owned')).toBe('');
  });
  it('rejects a missing initial socket and permits a batch missing target after the last verified stop', async () => {
    await expect(captureOwnedTmuxIdentity(scope(), probe)).rejects.toThrow('PATH_UNAVAILABLE');
    create();
    const proof = await stopOwnedTmux((await captureOwnedTmuxIdentity(scope(), probe))!, probe);
    expect((await captureOwnedTmuxIdentity(scope('next'), probe, proof))).toBeUndefined();
  });
  it('accepts already-proven natural exit of the last session before stop', async () => {
    create(); const identity = (await captureOwnedTmuxIdentity(scope(), probe))!;
    tmux('send-keys', '-t', 'owned', 'exit', 'Enter');
    const proof = { ...identity, stoppedAt: new Date().toISOString() };
    for (let tries = 0; !(await verifyOwnedTmuxExit(proof, probe)) && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    expect((await verifyOwnedTmuxExit(proof, probe))).toBe(true);
    expect((await verifyOwnedTmuxExit(await stopOwnedTmux(identity, probe), probe))).toBe(true);
  });
  it('keeps an exact old exit proof valid after a new live server reuses the socket, without touching the replacement', async () => {
    create();
    const original = (await captureOwnedTmuxIdentity(scope(), probe))!;
    const proof = await stopOwnedTmux(original, probe);
    await vi.waitFor(() => expect(observeProcess(original.server)).toBe('dead'));
    create();
    const replacement = (await captureOwnedTmuxIdentity(scope(), probe))!;
    expect(observeProcess(replacement.server)).toBe('alive');
    expect(replacement.server).not.toEqual(original.server);
    expect(await verifyOwnedTmuxExit(proof, probe)).toBe(true);
    for (const state of ['alive', 'unknown'] as const) {
      const targetUncertain: ProcessProbe = { ...probe, observe: value => value.pid === proof.identities[0]!.pid ? state : probe.observe(value) };
      expect(await verifyOwnedTmuxExit(proof, targetUncertain)).toBe(false);
      const serverUncertain: ProcessProbe = { ...probe, observe: value => value.pid === proof.server.pid ? state : probe.observe(value) };
      expect(await verifyOwnedTmuxExit(proof, serverUncertain)).toBe(false);
    }
    expect(await verifyOwnedTmuxExit({ ...proof, identities: [] }, probe)).toBe(false);
    expect(await verifyOwnedTmuxExit({ ...proof, server: { ...proof.server, start: '' } }, probe)).toBe(false);
    // Repeated cleanup of the old identity cannot signal or query the replacement target.
    expect(await stopOwnedTmux(original, probe)).toMatchObject({ server: original.server, targetId: original.targetId });
    expect(tmux('has-session', '-t', '=owned')).toBe('');
    expect(observeProcess(replacement.server)).toBe('alive');
    expect(replacement.identities.every(value => observeProcess(value) === 'alive')).toBe(true);
  });
  it('does not release an old live server merely because another server replaces its unlinked socket', async () => {
    create(); create('other');
    const original = (await captureOwnedTmuxIdentity(scope(), probe))!;
    const proof = await stopOwnedTmux(original, probe);
    rmSync(socket);
    try {
      create('replacement');
      expect(observeProcess(original.server)).toBe('alive');
      expect(await verifyOwnedTmuxExit(proof, probe)).toBe(false);
      expect(tmux('has-session', '-t', '=replacement')).toBe('');
    } finally {
      if (observeProcess(original.server) === 'alive') process.kill(original.server.pid, 'SIGTERM');
    }
  });
  it('rejects owner mutation between capture and stop without killing the target', async () => {
    create(); const identity = (await captureOwnedTmuxIdentity(scope(), probe))!;
    tmux('set-option', '-t', 'owned', '@dutydeck_owner_id', 'foreign');
    await expect(stopOwnedTmux(identity, probe)).rejects.toThrow('OWNER_MISMATCH');
    expect(tmux('has-session', '-t', '=owned')).toBe('');
  });
  it('refuses unknown process observations and foreign namespaces', async () => {
    create(); const identity = (await captureOwnedTmuxIdentity(scope(), probe))!;
    await expect(stopOwnedTmux(identity, { ...probe, observe: () => 'unknown' })).rejects.toThrow('PROCESS_STATE_CHANGED');
    identity.server.namespace = 'foreign';
    await expect(stopOwnedTmux(identity, probe)).rejects.toThrow('PROCESS_STATE_CHANGED');
    expect(tmux('has-session', '-t', '=owned')).toBe('');
  });
  it('is independent of later TMUX/TMUX_TMPDIR namespace changes', async () => {
    create(); const identity = (await captureOwnedTmuxIdentity(scope(), probe))!;
    const saved = process.env.TMUX_TMPDIR;
    process.env.TMUX_TMPDIR = join(root, 'different');
    try { expect((await verifyOwnedTmuxExit(await stopOwnedTmux(identity, probe), probe))).toBe(true); }
    finally { if (saved === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = saved; }
  });
  it('rechecks ownership after the durable pre-kill callback', async () => {
    create(); const identity = (await captureOwnedTmuxIdentity(scope(), probe))!;
    let saved = false;
    await expect(stopOwnedTmux(identity, probe, async captured => {
      expect(captured.identities.length).toBeGreaterThan(0);
      saved = true;
      tmux('set-option', '-t', 'owned', '@dutydeck_owner_id', 'foreign');
    })).rejects.toThrow('OWNER_MISMATCH');
    expect(saved).toBe(true);
    expect(tmux('has-session', '-t', '=owned')).toBe('');
  });
  it('re-records children created during the durable pre-kill callback before killing', async () => {
    create(); const identity = (await captureOwnedTmuxIdentity(scope(), probe))!;
    let child: ReturnType<typeof childProcessIdentity> | undefined;
    const records: number[][] = [];
    try {
      const error = await stopOwnedTmux(identity, probe, async captured => {
        records.push(captured.identities.map(item => item.pid));
        if (child) return;
        const pidFile = join(root, 'child-pid');
        tmux('send-keys', '-t', 'owned', `sleep 30 & echo $! > ${pidFile}; wait`, 'Enter');
        for (let tries = 0; tries < 100; tries++) {
          try { child = childProcessIdentity(Number(readFileSync(pidFile, 'utf8').trim())); break; }
          catch { await new Promise(resolve => setTimeout(resolve, 10)); }
        }
        expect(child).toBeDefined();
      }).then(() => undefined, (failure: { code?: string; proof?: Parameters<typeof verifyOwnedTmuxExit>[0] }) => failure);
      // The child joined the durable record before kill-session, not only the in-memory proof.
      expect(records).toHaveLength(2);
      expect(records[0]).not.toContain(child!.pid);
      expect(records[1]).toContain(child!.pid);
      expect(() => tmux('has-session', '-t', '=owned')).toThrow();
      // The job-control background child survives the session hangup; being recorded, it is signalled once the session is gone.
      expect(error).toBeUndefined();
      expect(observeProcess(child!)).toBe('dead');
    } finally { if (child && observeProcess(child) === 'alive') process.kill(child.pid, 'SIGTERM'); }
  }, 20_000);
  // An agent running builds, tests or git keeps forking short-lived children:
  // a scanned child may exit before identify, and no two scans are identical.
  it.skipIf(process.platform !== 'linux')('captures and stops a pane that keeps forking short-lived children', async () => {
    for (let round = 0; round < 20; round++) {
      const name = `busy${round}`;
      tmux('new-session', '-d', '-s', name, 'while true; do sleep 0.03 & sleep 0.01; done');
      tmux('set-option', '-t', name, '@dutydeck_owner_id', `dutydeck:${name}`);
      await new Promise(resolve => setTimeout(resolve, 100));
      const identity = (await captureOwnedTmuxIdentity(scope(name), probe))!;
      expect(identity.identities.length).toBeGreaterThan(0);
      const proof = await stopOwnedTmux(identity, probe);
      expect(await verifyOwnedTmuxExit(proof, probe)).toBe(true);
      expect(() => tmux('has-session', '-t', `=${name}`)).toThrow();
    }
  }, 60_000);
  it.skipIf(process.platform !== 'linux')('stops a busy pane through the durable pre-kill callback', async () => {
    tmux('new-session', '-d', '-s', 'owned', 'while true; do sleep 0.03 & sleep 0.01; done');
    tmux('set-option', '-t', 'owned', '@dutydeck_owner_id', 'dutydeck:owned');
    const identity = (await captureOwnedTmuxIdentity(scope(), probe))!;
    let recorded: Set<string> = new Set();
    const proof = await stopOwnedTmux(identity, probe, async captured => { recorded = new Set(captured.identities.map(item => JSON.stringify(item))); });
    expect(await verifyOwnedTmuxExit(proof, probe)).toBe(true);
    expect(identity.identities.every(item => recorded.has(JSON.stringify(item)))).toBe(true);
    expect(() => tmux('has-session', '-t', '=owned')).toThrow();
  }, 30_000);
  it.skipIf(process.platform !== 'linux')('stops a pane whose children outlive every pre-kill record round but then exit on their own', async () => {
    tmux('new-session', '-d', '-s', 'owned', 'while true; do sleep 1 & sleep 0.02; done');
    tmux('set-option', '-t', 'owned', '@dutydeck_owner_id', 'dutydeck:owned');
    await new Promise(resolve => setTimeout(resolve, 200));
    const identity = (await captureOwnedTmuxIdentity(scope(), probe))!;
    const records: Array<Set<string>> = [];
    const proof = await stopOwnedTmux(identity, probe, async captured => { records.push(new Set(captured.identities.map(item => JSON.stringify(item)))); });
    // Every record round saw live newcomers; the stop went through the settle path instead of refusing.
    expect(records.length).toBeGreaterThan(5);
    expect(identity.identities.every(item => records.at(-1)!.has(JSON.stringify(item)))).toBe(true);
    expect(await verifyOwnedTmuxExit(proof, probe)).toBe(true);
    expect(() => tmux('has-session', '-t', '=owned')).toThrow();
  }, 60_000);
  it('proves exit by session absence when the pane root had already exited at capture', async () => {
    create('other');
    tmux('set-option', '-g', 'remain-on-exit', 'on');
    tmux('new-session', '-d', '-s', 'owned', 'true');
    tmux('set-option', '-t', 'owned', '@dutydeck_owner_id', 'dutydeck:owned');
    await vi.waitFor(() => expect(tmux('display-message', '-p', '-t', 'owned', '#{pane_dead}')).toBe('1'));
    const identity = (await captureOwnedTmuxIdentity(scope(), probe))!;
    expect(identity.identities).toEqual([]);
    expect(await verifyOwnedTmuxExit({ ...identity, stoppedAt: new Date().toISOString() }, probe)).toBe(false);
    const proof = await stopOwnedTmux(identity, probe);
    expect(() => tmux('has-session', '-t', '=owned')).toThrow();
    expect(await verifyOwnedTmuxExit(proof, probe)).toBe(true);
    // A new session with the original name is not covered by the empty proof.
    tmux('new-session', '-d', '-s', 'owned', '/bin/sh');
    expect(await verifyOwnedTmuxExit(proof, probe)).toBe(false);
  });
  it('rescans right before kill without a pre-kill callback and keeps a late detached child in the proof', async () => {
    create(); const identity = (await captureOwnedTmuxIdentity(scope(), probe))!;
    const pidFile = join(root, 'late-pid');
    let serverChecks = 0, child: ReturnType<typeof childProcessIdentity> | undefined;
    const spawning: ProcessProbe = { ...probe, observe: value => {
      if (value.pid === identity.server.pid && ++serverChecks === 2) {
        // Born after the earlier scans, survives kill-session's SIGHUP.
        tmux('send-keys', '-t', 'owned', `nohup sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}`, 'Enter');
        for (let tries = 0; tries < 200 && !child; tries++) {
          try { child = childProcessIdentity(Number(readFileSync(pidFile, 'utf8').trim())); }
          catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
        }
      }
      return probe.observe(value);
    } };
    try {
      const proof = await stopOwnedTmux(identity, spawning);
      expect(child).toBeDefined();
      expect(proof.identities.map(item => item.pid)).toContain(child!.pid);
      // Only a recorded survivor of the hangup is signalled, so the late child had to join the proof to be ended.
      expect(observeProcess(child!)).toBe('dead');
      expect(await verifyOwnedTmuxExit(proof, probe)).toBe(true);
    } finally { if (child && observeProcess(child) === 'alive') process.kill(child.pid, 'SIGKILL'); }
  }, 20_000);
  it('refuses to kill unrecorded children that keep appearing after the last pre-kill record round', async () => {
    create(); const identity = (await captureOwnedTmuxIdentity(scope(), probe))!;
    const children: Array<ReturnType<typeof childProcessIdentity>> = [];
    const records: number[][] = [];
    try {
      const failure = await stopOwnedTmux(identity, probe, async captured => {
        records.push(captured.identities.map(item => item.pid));
        const pidFile = join(root, `round-${records.length}`);
        tmux('send-keys', '-t', 'owned', `nohup sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}`, 'Enter');
        for (let tries = 0; tries < 200; tries++) {
          try { children.push(childProcessIdentity(Number(readFileSync(pidFile, 'utf8').trim()))); break; }
          catch { await new Promise(resolve => setTimeout(resolve, 10)); }
        }
      }).then(() => undefined, (error: { code?: string }) => error);
      expect(failure?.code).toBe('LEGACY_TMUX_PROCESS_SET_CHANGED');
      // Nothing was killed: the child born after the last durable record is not in it.
      expect(() => tmux('has-session', '-t', '=owned')).not.toThrow();
      expect(records.at(-1)).not.toContain(children.at(-1)!.pid);
      for (const child of children) expect(observeProcess(child)).toBe('alive');
    } finally { for (const child of children) if (observeProcess(child) === 'alive') process.kill(child.pid, 'SIGKILL'); }
  }, 30_000);
  it('does not treat an unlinked live server socket as proof of target absence', async () => {
    create(); create('other');
    const identity = (await captureOwnedTmuxIdentity(scope(), probe))!;
    const proof = await stopOwnedTmux(identity, probe);
    create(); // a replacement pane lives on the still-running server
    rmSync(socket);
    expect(observeProcess(identity.server)).toBe('alive');
    expect((await verifyOwnedTmuxExit(proof, probe))).toBe(false);
    process.kill(identity.server.pid, 'SIGUSR1');
    await new Promise(resolve => setTimeout(resolve, 100));
  });
  // A Claude pane root (program-status relay) may take 5s+2s to escalate to SIGKILL.
  function createHupIgnoring() {
    tmux('new-session', '-d', '-s', 'owned', 'trap "" HUP; exec sleep 600');
    tmux('set-option', '-t', 'owned', '@dutydeck_owner_id', 'dutydeck:owned');
    return Number(tmux('display-message', '-p', '-t', 'owned', '#{pane_pid}'));
  }
  // Only the exit-proof deadline reads Date.now; advance a virtual clock per read instead of waiting 10s.
  function virtualClock(step: (elapsed: number) => number) {
    const start = Date.now(); let elapsed = 0;
    return vi.spyOn(Date, 'now').mockImplementation(() => { const now = start + elapsed; elapsed += step(elapsed); return now; });
  }
  it('waits past the relay\'s worst-case exit before declaring the stop unproven', async () => {
    const pane = createHupIgnoring(), identity = (await captureOwnedTmuxIdentity(scope(), probe))!;
    let killed = false;
    const clock = virtualClock(elapsed => {
      if (!killed && elapsed >= 7_000) { killed = true; process.kill(pane, 'SIGKILL'); }
      return killed ? 1 : 250;
    });
    try {
      const proof = await stopOwnedTmux(identity, probe);
      clock.mockRestore();
      expect(killed).toBe(true);
      expect(await verifyOwnedTmuxExit(proof, probe)).toBe(true);
    } finally { clock.mockRestore(); try { process.kill(pane, 'SIGKILL'); } catch { /* Exited. */ } }
  }, 20_000);
  it('attaches a re-verifiable proof when exit stays unproven', async () => {
    const pane = createHupIgnoring(), identity = (await captureOwnedTmuxIdentity(scope(), probe))!;
    // Signals that cannot end the survivor (for example one in uninterruptible sleep) leave its exit unproven.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const clock = virtualClock(() => 1_000);
    try {
      const error = await stopOwnedTmux(identity, probe).then(() => undefined, (failure: { code?: string; proof?: Parameters<typeof verifyOwnedTmuxExit>[0] }) => failure);
      const signals = kill.mock.calls.filter(([pid]) => pid === pane).map(([, signal]) => signal);
      clock.mockRestore(); kill.mockRestore();
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(error?.code).toBe('LEGACY_TMUX_EXIT_UNPROVEN');
      expect(await verifyOwnedTmuxExit(error!.proof!, probe)).toBe(false);
      process.kill(pane, 'SIGKILL');
      await vi.waitFor(async () => expect(await verifyOwnedTmuxExit(error!.proof!, probe)).toBe(true));
    } finally { clock.mockRestore(); kill.mockRestore(); try { process.kill(pane, 'SIGKILL'); } catch { /* Exited. */ } }
  }, 20_000);
  it.skipIf(process.platform !== 'linux')('sends SIGTERM, then SIGKILL, to a recorded child that outlives kill-session', async () => {
    create();
    const pidFile = join(root, 'survivor-pid');
    tmux('send-keys', '-t', 'owned', `nohup sh -c 'trap "" TERM; echo $$ > ${pidFile}; exec sleep 600' >/dev/null 2>&1 &`, 'Enter');
    let child: ReturnType<typeof childProcessIdentity> | undefined;
    await vi.waitFor(() => { child = childProcessIdentity(Number(readFileSync(pidFile, 'utf8').trim())); });
    const identity = (await captureOwnedTmuxIdentity(scope(), probe))!;
    expect(identity.identities.map(item => item.pid)).toContain(child!.pid);
    const kill = vi.spyOn(process, 'kill');
    // Fast-forward the exit waits until SIGKILL is sent, then give the kernel real time to reap the survivor.
    const clock = virtualClock(() => kill.mock.calls.some(([, signal]) => signal === 'SIGKILL') ? 1 : 1_000);
    try {
      const proof = await stopOwnedTmux(identity, probe);
      const signals = kill.mock.calls.filter(([pid]) => pid === child!.pid).map(([, signal]) => signal);
      clock.mockRestore(); kill.mockRestore();
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(observeProcess(child!)).toBe('dead');
      expect(await verifyOwnedTmuxExit(proof, probe)).toBe(true);
    } finally { clock.mockRestore(); kill.mockRestore(); if (child && observeProcess(child) === 'alive') process.kill(child.pid, 'SIGKILL'); }
  }, 30_000);
  it.skipIf(process.platform !== 'linux')('ends a recorded survivor when a later stop finds the session already gone', async () => {
    create(); create('other');
    const pidFile = join(root, 'survivor-pid');
    tmux('send-keys', '-t', 'owned', `nohup sleep 600 >/dev/null 2>&1 & echo $! > ${pidFile}`, 'Enter');
    let child: ReturnType<typeof childProcessIdentity> | undefined;
    await vi.waitFor(() => { child = childProcessIdentity(Number(readFileSync(pidFile, 'utf8').trim())); });
    const identity = (await captureOwnedTmuxIdentity(scope(), probe))!;
    expect(identity.identities.map(item => item.pid)).toContain(child!.pid);
    try {
      tmux('send-keys', '-t', 'owned', 'exit', 'Enter');
      await vi.waitFor(() => expect(() => tmux('has-session', '-t', '=owned')).toThrow());
      expect(observeProcess(child!)).toBe('alive');
      const proof = await stopOwnedTmux(identity, probe);
      expect(observeProcess(child!)).toBe('dead');
      expect(await verifyOwnedTmuxExit(proof, probe)).toBe(true);
      expect(tmux('has-session', '-t', '=other')).toBe('');
    } finally { if (child && observeProcess(child) === 'alive') process.kill(child.pid, 'SIGKILL'); }
  }, 20_000);
  it('does not accept a socket path replaced by an ordinary file', async () => {
    create(); const identity = (await captureOwnedTmuxIdentity(scope(), probe))!;
    rmSync(socket); writeFileSync(socket, 'replacement');
    await expect(stopOwnedTmux(identity, probe)).rejects.toThrow('PATH_TYPE_MISMATCH');
    // Recreate only this test server socket for cleanup.
    rmSync(socket);
    process.kill(identity.server.pid, 'SIGUSR1');
    await new Promise(resolve => setTimeout(resolve, 100));
  });
});
