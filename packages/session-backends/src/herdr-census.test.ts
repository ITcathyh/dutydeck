import { afterEach, describe, expect, it, vi } from 'vitest';
import { HerdrBackend } from './herdr-backend.js';

const sample = vi.hoisted(() => ({ enabled: false, mode: '', failed: false, envReads: 0 }));
const login = (scope: string) => `1:name=systemd:/user.slice/user-${process.getuid!()}.slice/${scope}\n`;
const name = `dutydeck-${'a'.repeat(32)}`, pid = 9999999;
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const identity = { host: 'host', boot: 'boot', namespace: 'namespace', pid: 100, start: '100' };
  const error = (code: string) => Object.assign(new Error(code), { code });
  return { ...actual,
    existsSync: (path: unknown) => path === '/fixture/state.json' || actual.existsSync(path as string),
    readdirSync: (path: unknown, ...args: unknown[]) => sample.enabled && path === '/proc' ? [String(9999999)] : (actual.readdirSync as any)(path, ...args),
    readFileSync: (path: unknown, ...args: unknown[]) => {
      if (path === '/fixture/state.json') return JSON.stringify({ launch_id: 'b'.repeat(64), owner: 'fixture', name: `dutydeck-${'a'.repeat(32)}`, root: identity, process_cgroup: login(sample.mode === 'service-original-disjoint' ? 'user@1001.service/app.slice/dutydeck.service' : 'session-10.scope') });
      if (!sample.enabled || !String(path).startsWith('/proc/9999999/')) return (actual.readFileSync as any)(path, ...args);
      if (String(path).endsWith('/stat')) {
        if (sample.failed && sample.mode === 'gone') throw error('ENOENT');
        const fields = Array(20).fill('0');
        fields[0] = sample.failed && ['Z', 'X', 'reused', 'disjoint-reused'].includes(sample.mode) ? (sample.mode === 'X' ? 'X' : 'Z') : 'R';
        fields[19] = sample.envReads > 1 && sample.mode === 'retry-reused' ? '120' : sample.mode === 'preexisting' ? '90' : sample.failed && ['reused', 'disjoint-reused'].includes(sample.mode) ? '120' : '110';
        return `${9999999} (fixture) ${fields.join(' ')}`;
      }
      if (String(path).endsWith('/status')) return `Uid:\t${process.getuid!()}\t${process.getuid!()}\t${process.getuid!()}\t${process.getuid!()}\n`;
      if (String(path).endsWith('/cgroup')) {
        if (sample.mode === 'unknown-cgroup') throw error('EACCES');
        if (sample.mode === 'unified-disjoint') return `0::/user.slice/user-${process.getuid!()}.slice/session-11.scope\n`;
        return login(['disjoint-login', 'owned-disjoint', 'disjoint-reused', 'service-original-disjoint', 'retry-identity-unknown'].includes(sample.mode) ? 'session-11.scope' : sample.mode === 'other-service' ? 'user@1001.service/other.service' : 'session-10.scope');
      }
      if (String(path).endsWith('/comm')) return 'fixture\n';
      if (String(path).endsWith('/environ')) {
        sample.envReads++;
        if (sample.envReads > 1 && ['retry-owned', 'retry-nonmarker', 'retry-reused', 'retry-identity-unknown'].includes(sample.mode)) return sample.mode === 'retry-nonmarker' ? 'unrelated=value\0' : `dutydeck_terminal_launch_id=${'b'.repeat(64)}\0`;
        if (sample.mode === 'owned' || sample.mode === 'owned-disjoint') return `dutydeck_terminal_launch_id=${'b'.repeat(64)}\0`;
        if (sample.mode === 'old-marker') return `dutydeck_terminal_launch_id=${'c'.repeat(64)}\0`;
        sample.failed = true; throw error('EACCES');
      }
      throw error('ENOENT');
    },
  };
});
afterEach(() => { sample.enabled = false; vi.useRealTimers(); vi.restoreAllMocks(); });
function census(mode: string) {
  Object.assign(sample, { enabled: true, mode, failed: false, envReads: 0 });
  const backend = new HerdrBackend(name, { binary: 'unused', stateFile: '/fixture/state.json', ownerId: 'fixture', processProbe: {
    identify: pid => {
      if (mode === 'retry-identity-unknown') throw Object.assign(new Error('identity unreadable'), { code: 'EACCES' });
      return { host: 'host', boot: 'boot', namespace: 'namespace', pid, start: '110' };
    }, observe: () => 'alive',
  } });
  return (backend as any).ownedProcesses() as Array<{ pid: number }>;
}
describe('Herdr ownership census observations', () => {
  it('binds original cgroup membership in the immutable retirement identity', () => {
    const backend = new HerdrBackend(name, { binary: 'unused', stateFile: '/fixture/state.json', ownerId: 'fixture', processProbe: {
      identify: pid => ({ host: 'host', boot: 'boot', namespace: 'namespace', pid, start: '110' }), observe: () => 'alive',
    } });
    const state = (backend as any).state;
    expect(() => (backend as any).validateIdentity({ ...state, process_cgroup: login('session-11.scope'), identities: [state.root] })).toThrow('HERDR_RETIREMENT_SCOPE_CONFLICT');
  });
  it.each(['Z', 'X', 'gone'])('accepts EACCES only after original process is demonstrably %s', mode => {
    expect(census(mode)).toEqual([]); expect(sample.envReads).toBe(1);
  });
  it.each(['live', 'reused', 'retry-reused', 'disjoint-reused', 'unknown-cgroup', 'other-service'])('keeps %s unreadable identity unresolved and retains safe diagnostic metadata', mode => {
    expect(() => census(mode)).toThrow(`HERDR_OWNERSHIP_CENSUS_UNKNOWN pid=${pid} stage=environ errno=EACCES`);
  });
  it('classifies a single restored environ read using the same physical identity', () => {
    expect(census('retry-owned')).toEqual([{ host: 'host', boot: 'boot', namespace: 'namespace', pid, start: '110' }]); expect(sample.envReads).toBe(2);
    expect(census('retry-nonmarker')).toEqual([]); expect(sample.envReads).toBe(2);
  });
  it('never excludes a restored readable marker when physical identity is unknown in another login scope', () => {
    expect(() => census('retry-identity-unknown')).toThrow(`HERDR_OWNERSHIP_CENSUS_UNKNOWN pid=${pid} stage=identity errno=EACCES`);
    expect(sample.envReads).toBe(2);
  });
  it('excludes only unreadable processes proven in an independent login scope', () => {
    for (const mode of ['disjoint-login', 'service-original-disjoint', 'unified-disjoint']) {
      expect(census(mode)).toEqual([]); expect(sample.envReads).toBe(2);
    }
    expect(census('owned-disjoint')).toEqual([{ host: 'host', boot: 'boot', namespace: 'namespace', pid, start: '110' }]);
  });
  it('excludes pre-launch processes without attempting their unreadable environment', () => {
    expect(census('preexisting')).toEqual([]); expect(sample.envReads).toBe(0);
  });
  it('recognizes only the immutable current launch marker', () => {
    expect(census('owned')).toEqual([{ host: 'host', boot: 'boot', namespace: 'namespace', pid, start: '110' }]);
    expect(census('old-marker')).toEqual([]);
  });
});

describe('Herdr explicit stop census retries', () => {
  function stopFixture() {
    let killed = false;
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
    const backend = new HerdrBackend(name, { binary: 'unused', stateFile: '/fixture/state.json', ownerId: 'fixture', processProbe: {
      identify: pid => ({ host: 'host', boot: 'boot', namespace: 'namespace', pid, start: '110' }), observe: () => killed ? 'dead' : 'alive',
    } });
    const state = (backend as any).state; state.identities = [state.root];
    const snapshot = structuredClone(state);
    vi.spyOn(backend as any, 'persist').mockImplementation(() => {});
    vi.spyOn(backend, 'verifyOwnedIdentity').mockReturnValue(false);
    const capture = vi.spyOn(backend, 'captureOwnedIdentity').mockImplementation(() => structuredClone(snapshot));
    const kill = vi.spyOn(backend, 'kill').mockImplementation(() => { killed = true; });
    const proof = vi.spyOn(backend, 'isStopped').mockImplementation(() => killed);
    return { backend, state, snapshot, capture, kill, proof, signal };
  }
  const unknown = () => { throw new Error('HERDR_OWNERSHIP_CENSUS_UNKNOWN fixture'); };
  it('retries transient reads and pre-kill checks while preserving one receipt and the exact process fence', async () => {
    vi.useFakeTimers(); const f = stopFixture(), order: string[] = [];
    f.capture.mockImplementationOnce(unknown).mockImplementationOnce(() => { order.push('snapshot'); return f.snapshot; }).mockImplementationOnce(unknown);
    f.kill.mockImplementationOnce(unknown);
    const receipt = vi.fn(async snapshot => { expect(snapshot).toEqual(f.snapshot); order.push('receipt'); });
    const stopping = f.backend.stopOwnedIdentity(f.snapshot, receipt).catch(error => { throw error; });
    const checked = expect(stopping).resolves.toBeTruthy();
    await vi.advanceTimersByTimeAsync(100);
    await checked;
    expect(order).toEqual(['snapshot', 'receipt']); expect(receipt).toHaveBeenCalledTimes(1);
    expect(f.kill).toHaveBeenCalledTimes(2); expect(f.kill).toHaveBeenLastCalledWith(f.snapshot.identities);
    expect(f.proof).toHaveBeenCalledTimes(1);
  });
  it('times out persistent live unreadability without signaling or replacing the receipt', async () => {
    vi.useFakeTimers(); const f = stopFixture();
    f.capture.mockImplementationOnce(() => f.snapshot).mockImplementation(unknown);
    const receipt = vi.fn(async () => {}), stopping = f.backend.stopOwnedIdentity(f.snapshot, receipt).catch(error => error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await stopping).toMatchObject({ message: 'HERDR_OWNERSHIP_CENSUS_UNKNOWN fixture' });
    expect(receipt).toHaveBeenCalledTimes(1); expect(f.kill).not.toHaveBeenCalled(); expect(f.state.close_intent).toBeUndefined(); expect(f.signal).not.toHaveBeenCalled();
  });
  it('does not retry other ownership errors or signal newly observed processes after a receipt', async () => {
    vi.useFakeTimers(); const f = stopFixture();
    const foreign = { ...f.state.root, pid: 200, start: '120' };
    f.capture.mockImplementationOnce(() => f.snapshot).mockImplementationOnce(unknown).mockImplementation(() => ({ ...f.snapshot, identities: [...f.snapshot.identities, foreign] }));
    const receipt = vi.fn(async () => {}), stopping = f.backend.stopOwnedIdentity(f.snapshot, receipt).catch(error => error);
    await vi.advanceTimersByTimeAsync(25);
    expect(await stopping).toMatchObject({ message: 'HERDR_PROCESS_SET_CHANGED' });
    expect(receipt).toHaveBeenCalledTimes(1); expect(f.capture).toHaveBeenCalledTimes(3); expect(f.kill).not.toHaveBeenCalled(); expect(f.signal).not.toHaveBeenCalled();
  });
});
