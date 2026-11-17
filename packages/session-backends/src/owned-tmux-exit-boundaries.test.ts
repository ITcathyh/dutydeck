import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { childProcessIdentity, observeProcess } from '../../storage/src/process-identity.js';
import { parseProcStat, procStatExited } from '@dutydeck/shared';
import { captureOwnedTmuxIdentity, processIdentityKey, stopOwnedTmux, verifyOwnedTmuxExit, type OwnedTmuxIdentity, type OwnedTmuxScope, type PhysicalProcessIdentity, type ProcessProbe } from './owned-tmux.js';

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, readFileSync: vi.fn(original.readFileSync) };
});

const baseProbe: ProcessProbe = { identify: childProcessIdentity, observe: observeProcess };
const realRead = vi.mocked(readFileSync).getMockImplementation()!;
const originalKill = process.kill.bind(process);
const originalNow = Date.now.bind(Date);
let root: string, socket: string;
const env = { ...process.env, TMUX: '', TMUX_TMPDIR: '' };
function tmux(...args: string[]) { return execFileSync('tmux', ['-u', '-S', socket, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function scope(name = 'owned'): OwnedTmuxScope { return { socketPath: socket, sessionName: name, ownerId: `dutydeck:${name}`, hostname: hostname(), uid: process.getuid!() }; }
function create(name = 'owned') { tmux('new-session', '-d', '-s', name, '/bin/sh'); tmux('set-option', '-t', name, '@dutydeck_owner_id', `dutydeck:${name}`); }
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function syncUntil(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error(message); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }
}
async function controlledProcess(command: string) {
  const parent = spawn('/bin/sh', ['-c', `${command} & echo $!; read x`], { stdio: ['pipe', 'pipe', 'ignore'] });
  const child = await new Promise<PhysicalProcessIdentity>((resolve, reject) => {
    parent.stdout.once('data', data => { try { resolve(childProcessIdentity(Number(String(data).trim()))); } catch (error) { reject(error); } });
    parent.once('error', reject);
  });
  return { parent, child, release: () => { if (parent.stdin.writable && !parent.stdin.destroyed) parent.stdin.write('go\n'); } };
}
async function cleanupControlled(controlled?: Awaited<ReturnType<typeof controlledProcess>>) {
  if (!controlled) return;
  if (observeProcess(controlled.child) === 'alive') { try { originalKill(controlled.child.pid, 'SIGKILL'); } catch {} }
  controlled.release();
  if (controlled.parent.exitCode === null && controlled.parent.signalCode === null) { try { originalKill(controlled.parent.pid!, 'SIGKILL'); } catch {} }
  controlled.parent.stdin.destroy();
  await vi.waitFor(() => expect(observeProcess(controlled.child)).toBe('dead'));
}

beforeEach(() => {
  vi.mocked(readFileSync).mockImplementation(realRead);
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dd-owned-exit-boundary-'))); socket = join(root, 'socket');
});
afterEach(() => { try { tmux('kill-server'); } catch {} rmSync(root, { recursive: true, force: true }); });

type Boundary = 'before_survivors' | 'term_grace' | 'final_kill_grace' | 'replacement' | 'tracing';
async function runBoundary(mode: Boundary) {
  let controlled: Awaited<ReturnType<typeof controlledProcess>> | undefined;
  const clock = mode === 'final_kill_grace' ? vi.spyOn(Date, 'now') : undefined;
  const kill = vi.spyOn(process, 'kill');
  try {
    create(); create('other');
    const gate = join(root, 'exit-gate'), termSeen = join(root, 'term-seen'), fixture = join(root, 'survivor.mjs');
    const onTerm = mode === 'tracing' ? 'process.on(\'SIGTERM\',()=>process.exit(0));' : `process.on('SIGTERM',()=>writeFileSync(${JSON.stringify(termSeen)},'received'));`;
    writeFileSync(fixture, `import {existsSync,writeFileSync} from 'node:fs';process.on('SIGHUP',()=>{});${onTerm}setInterval(()=>{if(existsSync(${JSON.stringify(gate)}))process.exit(0);},5);\n`);
    controlled = await controlledProcess(`${quote(process.execPath)} ${quote(fixture)}`);
    const identity = (await captureOwnedTmuxIdentity(scope(), baseProbe))!;
    tmux('send-keys', '-t', 'owned', 'exit', 'Enter');
    await vi.waitFor(() => expect(() => tmux('has-session', '-t', '=owned')).toThrow());
    // Keep the real socket/server/target proof and control only this real child's exit timing.
    identity.identities = [controlled.child];
    if (mode === 'tracing') {
      vi.mocked(readFileSync).mockImplementation(((path: unknown, ...args: unknown[]) => {
        if (path === `/proc/${controlled!.child.pid}/stat`) {
          const raw = (realRead as any)(path, ...args) as string;
          if (procStatExited(parseProcStat(raw))) return raw;
          const close = raw.lastIndexOf(')');
          return `${raw.slice(0, close + 2)}t${raw.slice(close + 3)}`;
        }
        return (realRead as any)(path, ...args);
      }) as typeof readFileSync);
    }
    const signals: Array<string | number | undefined> = [];
    let sessionGoneCalls = 0, graceStarted = 0, released = false;
    const release = () => { writeFileSync(gate, 'exit'); controlled!.release(); syncUntil(() => observeProcess(controlled!.child) === 'dead', 'controlled child reap'); };
    const probing: ProcessProbe = { identify: childProcessIdentity, observe: value => {
      if (value.pid === identity.server.pid && (new Error().stack ?? '').includes('sessionGone')) {
        sessionGoneCalls++;
        if ((mode === 'before_survivors' || mode === 'replacement') && sessionGoneCalls === 1 || mode === 'term_grace' && sessionGoneCalls === 2) {
          if (mode === 'term_grace') expect(existsSync(termSeen)).toBe(true);
          release();
          if (mode === 'replacement') create('owned');
        }
      }
      return observeProcess(value);
    } };
    kill.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      expect(pid).toBe(controlled!.child.pid);
      expect(observeProcess(controlled!.child)).toBe('alive');
      expect(processIdentityKey(childProcessIdentity(pid))).toBe(processIdentityKey(controlled!.child));
      if (mode === 'tracing') expect(parseProcStat(readFileSync(`/proc/${controlled!.child.pid}/stat`, 'utf8')).state).toBe('t');
      signals.push(signal);
      // Keep the final child alive until the real grace deadline; SIGTERM was really delivered.
      if (mode === 'final_kill_grace' && signal === 'SIGKILL') return true;
      return originalKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill);
    if (clock) {
      clock.mockImplementation(() => {
        const now = originalNow();
        if (signals.at(-1) === 'SIGKILL' && (new Error().stack ?? '').includes('provenWithin')) {
          if (!graceStarted) graceStarted = now;
          else if (now - graceStarted >= 2_000 && !released) {
            released = true;
            expect(observeProcess(controlled!.child)).toBe('alive');
            release();
          }
        }
        return now;
      });
    }
    const stopping = stopOwnedTmux(identity, probing);
    if (mode === 'replacement') {
      const error = await stopping.then(() => undefined, (failure: { code?: string; proof?: unknown }) => failure);
      expect(error?.code).toBe('LEGACY_TMUX_EXIT_UNPROVEN');
      expect(error?.proof).toBeDefined();
      expect(await verifyOwnedTmuxExit(error!.proof as any, baseProbe)).toBe(false);
      expect(tmux('has-session', '-t', '=owned')).toBe('');
    } else {
      const proof = await stopping;
      if (mode === 'tracing') { controlled.release(); syncUntil(() => observeProcess(controlled!.child) === 'dead', 'tracing child reap'); }
      expect(await verifyOwnedTmuxExit(proof, baseProbe)).toBe(true);
      expect(proof.identities.every(item => observeProcess(item) === 'dead')).toBe(true);
      expect(released || mode !== 'final_kill_grace').toBe(true);
    }
    expect(tmux('has-session', '-t', '=other')).toBe('');
    expect(signals).toEqual(mode === 'before_survivors' || mode === 'replacement' ? [] : mode === 'term_grace' || mode === 'tracing' ? ['SIGTERM'] : ['SIGTERM', 'SIGKILL']);
  } finally {
    kill.mockRestore(); clock?.mockRestore();
    await cleanupControlled(controlled);
  }
}

describe.skipIf(process.platform !== 'linux')('owned tmux final exit boundaries', () => {
  it('rechecks the complete proof when exit lands before survivor sampling', async () => { await runBoundary('before_survivors'); }, 20_000);
  it('rechecks the complete proof when exit lands at the TERM grace boundary', async () => { await runBoundary('term_grace'); }, 20_000);
  it('treats tracing-stop t as alive and signals the exact recorded survivor', async () => { await runBoundary('tracing'); }, 20_000);
  it('rechecks the complete proof when exit lands at the final KILL grace boundary', async () => { await runBoundary('final_kill_grace'); }, 20_000);
  it('still rejects a same-name replacement and sends no signal at the final check', async () => { await runBoundary('replacement'); }, 20_000);

  it('accepts a real unreaped zombie without signalling it, while live and wrong identities stay unproven', async () => {
    const controlled = await controlledProcess('sleep 0.01');
    const kill = vi.spyOn(process, 'kill');
    try {
      await vi.waitFor(() => expect(procStatExited(parseProcStat(readFileSync(`/proc/${controlled.child.pid}/stat`, 'utf8')))).toBe(true));
      expect(observeProcess(controlled.child)).toBe('alive');
      const server = childProcessIdentity(process.pid);
      const probe: ProcessProbe = { identify: childProcessIdentity, observe: value => value.pid === process.pid ? 'dead' : observeProcess(value) };
      const identity: OwnedTmuxIdentity = { scope: { ...scope(), socketPath: join(root, 'unused') }, socket: { dev: '0', ino: '0' }, targetId: '$unused', server, identities: [controlled.child] };
      const proof = { ...identity, stoppedAt: new Date().toISOString() };
      expect(await verifyOwnedTmuxExit(proof, probe)).toBe(true);
      expect(await stopOwnedTmux(identity, probe)).toMatchObject({ targetId: '$unused' });
      expect(kill).not.toHaveBeenCalled();
      expect(await verifyOwnedTmuxExit({ ...proof, identities: [{ ...controlled.child, host: 'wrong' }] }, probe)).toBe(false);
      expect(await verifyOwnedTmuxExit({ ...proof, identities: [{ ...controlled.child, namespace: 'wrong' }] }, probe)).toBe(false);
      expect(await verifyOwnedTmuxExit({ ...proof, identities: [childProcessIdentity(controlled.parent.pid!)] }, probe)).toBe(false);
    } finally { kill.mockRestore(); await cleanupControlled(controlled); }
  }, 20_000);
});
