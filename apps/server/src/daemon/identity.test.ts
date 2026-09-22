import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as storage from '@dutydeck/storage';
import * as daemon from './daemon.js';
import { daemonRestart, daemonStart, daemonStatus, daemonStop, markDaemonReady } from './command.js';
import { sleep } from './time.js';

vi.mock('./time.js', () => ({ sleep: vi.fn() }));
const identity: storage.ProcessIdentity = { host: 'machine', boot: 'boot', namespace: 'pid:[123]', pid: 12345678, start: '100' };
const state = (patch: Partial<daemon.DaemonState> = {}): daemon.DaemonState => ({ pid: identity.pid, processIdentity: { ...identity }, startedAt: 'generation-one', ready: true, cwd: '/unused', ...patch });

describe('daemon identity and generation protection', () => {
  let root: string;
  let dir: string;
  let now: number;
  let alive: boolean;
  let target: storage.ProcessIdentity;
  let signal: ReturnType<typeof vi.spyOn>;
  let launch: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'daemon-identity-'));
    dir = daemon.defaultDaemonDir(root);
    vi.stubEnv('HOME', root);
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    now = 0;
    alive = true;
    target = { ...identity };
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.mocked(sleep).mockImplementation(async ms => { now += ms; });
    vi.spyOn(storage, 'currentProcessIdentity').mockImplementation(() => ({ ...identity, pid: process.pid }));
    vi.spyOn(storage, 'childProcessIdentity').mockImplementation(() => target);
    signal = vi.spyOn(process, 'kill').mockImplementation((_pid, sig) => {
      if (!alive && sig === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return true;
    });
    launch = vi.spyOn(daemon, 'daemonize').mockImplementation(options => {
      daemon.writeState(dir, state({ startedAt: options!.startedAt!, cwd: root }));
      return { pid: identity.pid, processIdentity: identity, exited: new Promise(() => {}) };
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  const sent = () => signal.mock.calls.filter(([, sig]) => sig !== 0);

  it('verifies complete matching Linux identity', () => {
    expect(daemon.inspectDaemonState(state()).status).toBe('verified');
  });
  it.each(['boot', 'namespace', 'start', 'pid'] as const)('marks a target %s mismatch stale', field => {
    target = { ...identity, [field]: field === 'pid' ? identity.pid + 1 : 'different' };
    expect(daemon.inspectDaemonState(state()).status).toBe('stale');
    daemon.writeState(dir, state());
    expect(daemonStatus()).toMatchObject({ running: false, processStatus: 'stale' });
  });
  it.each(['host', 'namespace'] as const)('refuses a record belonging to another %s', field => {
    expect(daemon.inspectDaemonState(state({ processIdentity: { ...identity, [field]: 'elsewhere' } })).status).toBe('unverifiable');
  });
  it('marks an older boot and a dead legacy PID stale', () => {
    expect(daemon.inspectDaemonState(state({ processIdentity: { ...identity, boot: 'old' } })).status).toBe('stale');
    alive = false;
    expect(daemon.inspectDaemonState(state({ processIdentity: undefined })).status).toBe('stale');
  });
  it('blocks start, stop and restart for live legacy records without signals or state deletion', async () => {
    const legacy = state({ processIdentity: undefined, cwd: root });
    daemon.writeState(dir, legacy);
    const serve = vi.fn();
    expect(await daemonStop()).toMatchObject({ ok: false, processStatus: 'unverifiable' });
    expect(await daemonStart({}, { serve })).toMatchObject({ ok: false, processStatus: 'unverifiable' });
    expect(await daemonRestart({}, { serve })).toMatchObject({ ok: false, action: 'restart' });
    expect(daemonStatus()).toMatchObject({ running: false, processStatus: 'unverifiable', error: expect.stringContaining('manually') });
    expect(daemon.readDaemonStatus(dir)).toEqual(legacy);
    expect(sent()).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
    expect(serve).not.toHaveBeenCalled();
  });
  it.each(['local', 'target', 'malformed'] as const)('keeps state and sends no signals when %s identity is unavailable', async kind => {
    daemon.writeState(dir, state());
    if (kind === 'malformed') target = { ...identity, start: '' };
    else vi.mocked(kind === 'local' ? storage.currentProcessIdentity : storage.childProcessIdentity).mockImplementation(() => { throw new Error('EACCES'); });
    expect(await daemonStop()).toMatchObject({ ok: false, processStatus: 'unverifiable' });
    expect(daemon.readDaemonStatus(dir)).toEqual(state());
    expect(sent()).toEqual([]);
  });
  it('preserves unreadable state and does not fall back to a remembered daemon', async () => {
    daemon.writeState(dir, state());
    writeFileSync(daemon.daemonPaths(dir).stateFile, '{broken');
    const other = join(root, 'other');
    daemon.writeState(other, state());
    daemon.writeLastDaemonDir(other, root);
    expect(daemon.resolveDaemonDir(root, root)).toBe(dir);
    expect(await daemonStop()).toMatchObject({ ok: false, processStatus: 'unverifiable' });
    expect(await daemonStart({}, { serve: vi.fn() })).toMatchObject({ ok: false });
    expect(readFileSync(daemon.daemonPaths(dir).stateFile, 'utf8')).toBe('{broken');
    expect(sent()).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
  });
  it('never sends KILL to the new PID occupant after TERM', async () => {
    daemon.writeState(dir, state());
    vi.mocked(sleep).mockImplementation(async ms => { now += ms; target = { ...identity, start: 'new' }; });
    expect(await daemonStop()).toMatchObject({ ok: true, state: 'stopped' });
    expect(sent()).toEqual([[identity.pid, 'SIGTERM']]);
    expect(daemon.readDaemonStatus(dir)).toBeUndefined();
  });
  it('preserves a replacement generation and refuses restart after TERM', async () => {
    const first = state({ cwd: root });
    const next = state({ startedAt: 'generation-two', cwd: root });
    daemon.writeState(dir, first);
    vi.mocked(sleep).mockImplementation(async ms => { now += ms; daemon.writeState(dir, next); alive = false; });
    expect(await daemonRestart({}, { serve: vi.fn() })).toMatchObject({ ok: false, action: 'restart' });
    expect(daemon.readDaemonStatus(dir)).toEqual(next);
    expect(sent()).toEqual([[identity.pid, 'SIGTERM']]);
    expect(launch).not.toHaveBeenCalled();
  });
  it('checks the disk generation again immediately before cleanup', () => {
    const first = state();
    daemon.writeState(dir, state({ startedAt: 'replacement' }));
    expect(daemon.clearGeneration(dir, first)).toBe(false);
    expect(daemon.readDaemonStatus(dir)?.startedAt).toBe('replacement');
  });
  it('refuses escalation when identity becomes unreadable after TERM', async () => {
    daemon.writeState(dir, state());
    vi.mocked(sleep).mockImplementation(async ms => { now += ms; vi.mocked(storage.childProcessIdentity).mockImplementation(() => { throw new Error('denied'); }); });
    expect(await daemonStop()).toMatchObject({ ok: false, processStatus: 'unverifiable' });
    expect(sent()).toEqual([[identity.pid, 'SIGTERM']]);
    expect(daemon.readDaemonStatus(dir)).toEqual(state());
  });
  it('does not claim stopped or erase records when signaling fails', async () => {
    daemon.writeState(dir, state());
    signal.mockImplementation((_pid, sig) => { if (sig !== 0) throw new Error('denied'); return true; });
    expect(await daemonStop()).toMatchObject({ ok: false, running: true });
    expect(daemon.readDaemonStatus(dir)).toEqual(state());
  });
  it('escalates only after revalidation and waits for actual exit', async () => {
    daemon.writeState(dir, state());
    signal.mockImplementation((_pid, sig) => {
      if (sig === 'SIGKILL') alive = false;
      if (sig === 0 && !alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return true;
    });
    expect(await daemonStop()).toMatchObject({ ok: true, state: 'stopped' });
    expect(sent()).toEqual([[identity.pid, 'SIGTERM'], [identity.pid, 'SIGKILL']]);
  });
  it('keeps state when the process survives KILL', async () => {
    daemon.writeState(dir, state());
    expect(await daemonStop()).toMatchObject({ ok: false, running: true });
    expect(daemon.readDaemonStatus(dir)).toEqual(state());
  });
  it('starts, reports status and restarts a verified generation', async () => {
    expect(await daemonStart({}, { serve: vi.fn() })).toMatchObject({ ok: true, state: 'started' });
    expect(daemonStatus()).toMatchObject({ running: true, processStatus: 'verified' });
    vi.mocked(sleep).mockImplementation(async ms => { now += ms; alive = false; });
    launch.mockImplementation(options => {
      alive = true;
      daemon.writeState(dir, state({ startedAt: options!.startedAt!, cwd: root }));
      return { pid: identity.pid, processIdentity: identity, exited: new Promise(() => {}) };
    });
    expect(await daemonRestart({}, { serve: vi.fn() })).toMatchObject({ ok: true, state: 'restarted' });
  });
  it.each(['pid', 'startedAt', 'identity', 'not-ready', 'missing-capture'] as const)('rejects %s readiness instead of returning success on timeout', async mismatch => {
    launch.mockImplementation(options => {
      const next = state({ startedAt: options!.startedAt!, cwd: root });
      if (mismatch === 'pid') next.pid++;
      if (mismatch === 'startedAt') next.startedAt = 'previous';
      if (mismatch === 'identity') next.processIdentity = { ...identity, start: 'other' };
      if (mismatch === 'not-ready') next.ready = false;
      daemon.writeState(dir, next);
      return { pid: identity.pid, processIdentity: mismatch === 'missing-capture' ? undefined : identity, exited: new Promise(() => {}) };
    });
    expect(await daemonStart({}, { serve: vi.fn() })).toMatchObject({ ok: false, error: expect.stringContaining('timeout') });
  });
  it('retains startup failure log filtering', async () => {
    launch.mockImplementation(() => {
      writeFileSync(daemon.daemonPaths(dir).logFile, 'Error token=do-not-echo\nError EADDRINUSE\n');
      return { pid: identity.pid, processIdentity: identity, exited: Promise.resolve({ code: 1, signal: null }) };
    });
    const result = await daemonStart({}, { serve: vi.fn() });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('EADDRINUSE') });
    expect(result.error).not.toContain('do-not-echo');
  });
  it('does not overwrite a replacement state when the old child reports ready', () => {
    daemon.writeState(dir, state());
    expect(() => markDaemonReady(dir)).toThrow('replacement record preserved');
    expect(daemon.readDaemonStatus(dir)).toEqual(state());
  });
  it.each(['pid', 'identity', 'startedAt'] as const)('preserves a %s replacement when the actual child ready callback arrives late', async field => {
    let ready: (() => void) | undefined;
    await daemonStart({}, { serve: (_options, onReady) => { ready = onReady; } }, {
      HOME: root, DUTYDECK_DAEMONIZED: '1', DUTYDECK_DAEMON_STARTED_AT: 'original-launch'
    });
    const replacement = daemon.readDaemonStatus(dir)!;
    if (field === 'pid') replacement.pid++;
    if (field === 'identity') replacement.processIdentity = { ...replacement.processIdentity!, start: 'replacement-birth' };
    if (field === 'startedAt') replacement.startedAt = 'replacement-launch';
    daemon.writeState(dir, replacement);
    expect(() => ready!()).toThrow('replacement record preserved');
    expect(daemon.readDaemonStatus(dir)).toEqual(replacement);
  });
  it('allows initial ready publication without a record and repeated publication for the same generation', () => {
    markDaemonReady(dir, { address: 'first-ready' }, 'original-launch');
    expect(daemon.readDaemonStatus(dir)).toMatchObject({ ready: true, startedAt: 'original-launch', address: 'first-ready' });
    markDaemonReady(dir, { address: 'second-ready' }, 'original-launch');
    expect(daemon.readDaemonStatus(dir)).toMatchObject({ ready: true, startedAt: 'original-launch', address: 'second-ready' });
  });
  it('refuses unknown legacy restart before changing to an untrusted recorded cwd', async () => {
    daemon.writeState(dir, state({ processIdentity: undefined, cwd: '/nonexistent-daemon-path' }));
    const chdir = vi.spyOn(process, 'chdir').mockImplementation(() => { throw new Error('must not chdir'); });
    expect(await daemonRestart({}, { serve: vi.fn() })).toMatchObject({ ok: false, processStatus: 'unverifiable' });
    expect(chdir).not.toHaveBeenCalled();
  });
  it('treats a proven target namespace change as stale, but an ENOENT capture with a live PID as unknown', () => {
    vi.mocked(storage.childProcessIdentity).mockImplementation(() => { throw new Error('PROCESS_NAMESPACE_UNSUPPORTED'); });
    expect(daemon.inspectDaemonState(state()).status).toBe('stale');
    vi.mocked(storage.childProcessIdentity).mockImplementation(() => { throw Object.assign(new Error('cannot read'), { code: 'ENOENT' }); });
    expect(daemon.inspectDaemonState(state()).status).toBe('unverifiable');
  });
  it('captures child and ready identities while retaining metadata', async () => {
    await daemonStart({ database: 'custom.db' }, { serve: (_options, ready) => ready!() }, { HOME: root, DUTYDECK_DAEMONIZED: '1', DUTYDECK_DAEMON_STARTED_AT: 'launch-time' });
    const before = daemon.readDaemonStatus(dir)!;
    daemon.writeState(dir, { ...before, host: 'custom-host' });
    markDaemonReady(dir, { address: 'ready-address' }, before.startedAt);
    expect(daemon.readDaemonStatus(dir)).toMatchObject({ startedAt: 'launch-time', host: 'custom-host', ready: true, processIdentity: { ...identity, pid: process.pid }, database: join(root, 'custom.db') });
  });
});
