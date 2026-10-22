import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { descendantPids } from './descendant-pids.js';
import { HerdrBackend } from './herdr-backend.js';

vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  readFileSync: vi.fn(), readdirSync: vi.fn(), existsSync: () => false,
}));

const read = vi.mocked(readFileSync), list = vi.mocked(readdirSync);
const errno = (code: string) => Object.assign(new Error(code), { code });
function proc(entries: Array<[number, number, string?]>) {
  // Preserve the supplied directory order, including non-PID entries to ignore.
  list.mockReturnValue(['self', ...entries.map(([pid]) => String(pid)), '12x'] as any);
  read.mockImplementation((path: unknown) => {
    const entry = entries.find(([pid]) => path === `/proc/${pid}/stat`);
    if (!entry) throw errno('ENOENT');
    return `${entry[0]} (${entry[2] ?? 'fixture'}) S ${entry[1]} 0 0 0`;
  });
}
beforeEach(() => { vi.resetAllMocks(); });

describe('Linux descendant PID scan', () => {
  it('includes roots and keeps depth-first stack order across unsorted children and duplicate roots', () => {
    proc([[20, 10], [40, 20], [30, 10], [50, 30], [10, 1], [70, 60], [60, 1]]);
    const roots = [10, 60, 10];
    expect(descendantPids(roots)).toEqual([10, 30, 50, 20, 40, 60, 70]);
    expect(roots).toEqual([10, 60, 10]);
    expect(list).toHaveBeenCalledWith('/proc');
    expect(read.mock.calls.map(([path]) => path)).toEqual([20, 40, 30, 50, 10, 70, 60].map(pid => `/proc/${pid}/stat`));
  });

  it('parses the parent after the last closing bracket in a process name', () => {
    proc([[12, 10, 'worker (nested) ) with spaces'], [13, 12], [10, 1]]);
    expect(descendantPids([10])).toEqual([10, 12, 13]);
  });

  it('keeps a wide sibling group in DFS order and preserves the full stat scan order', () => {
    const siblings = Array.from({ length: 2000 }, (_, index) => 3000 - index);
    const entries: Array<[number, number]> = [...siblings.map((pid): [number, number] => [pid, 10]), [4000, 3000], [5000, 1], [10, 1]];
    proc(entries);
    const stats = new Map<string, string>();
    expect(descendantPids([10], stats)).toEqual([10, ...siblings.toReversed(), 4000]);
    expect([...stats]).toEqual(entries.map(([pid, parent]) => [String(pid), `${pid} (fixture) S ${parent} 0 0 0`]));
  });

  it('deduplicates overlapping roots and cyclic parent data', () => {
    proc([[10, 20], [20, 10], [30, 20]]);
    expect(descendantPids([20, 10, 20])).toEqual([20, 30, 10]);
  });

  it('ignores only vanished stat files and retains missing roots for caller identity checks', () => {
    proc([[10, 1], [20, 10], [30, 10]]);
    const original = read.getMockImplementation()!;
    read.mockImplementation((...args: Parameters<typeof readFileSync>) => {
      if (args[0] === '/proc/20/stat') throw errno('ENOENT');
      return original(...args);
    });
    expect(descendantPids([10, 99])).toEqual([99, 10, 30]);
  });

  it.each(['EACCES', 'EPERM', 'ESRCH'])('propagates a stat %s error', code => {
    proc([[10, 1]]);
    const failure = errno(code);
    read.mockImplementation(() => { throw failure; });
    expect(() => descendantPids([10])).toThrow(failure);
  });

  it.each(['ENOENT', 'EACCES'])('propagates a /proc directory %s error', code => {
    const failure = errno(code);
    list.mockImplementation(() => { throw failure; });
    expect(() => descendantPids([10])).toThrow(failure);
  });

  it('takes a fresh scan on each call and accepts no roots', () => {
    proc([[10, 1]]);
    expect(descendantPids([10])).toEqual([10]);
    proc([[10, 1], [20, 10]]);
    expect(descendantPids([10])).toEqual([10, 20]);
    expect(descendantPids([])).toEqual([]);
    expect(list).toHaveBeenCalledTimes(3);
  });
});

describe('Herdr descendant identity boundary', () => {
  function fixture() {
    const identify = vi.fn(pid => ({ host: 'host', boot: 'boot', namespace: 'namespace', pid, start: '100' }));
    const backend = new HerdrBackend(`dutydeck-${'a'.repeat(32)}`, {
      binary: 'unused', stateFile: '/fixture/state.json', ownerId: 'fixture',
      processProbe: { identify, observe: () => 'alive' },
    });
    const internal = backend as any;
    const checked = vi.spyOn(internal, 'checked').mockResolvedValue({ root: { pid: 10 } });
    return { internal, checked, identify };
  }

  it('checks ownership before scanning and identifies in DFS order without sorting', async () => {
    proc([[20, 10], [30, 10], [40, 20]]);
    const f = fixture();
    f.checked.mockImplementation(async () => {
      expect(list).not.toHaveBeenCalled(); expect(f.identify).not.toHaveBeenCalled();
      return { root: { pid: 10 } };
    });
    expect((await f.internal.descendants()).map((item: { pid: number }) => item.pid)).toEqual([10, 30, 20, 40]);
    expect(f.checked).toHaveBeenCalledExactlyOnceWith(false);
    expect(f.identify.mock.calls.map(([pid]) => pid)).toEqual([10, 30, 20, 40]);
  });

  it('does not scan or identify if ownership validation rejects', async () => {
    const f = fixture(), failure = new Error('HERDR_PROCESS_IDENTITY_CHANGED');
    f.checked.mockRejectedValue(failure);
    await expect(f.internal.descendants()).rejects.toThrow(failure);
    expect(list).not.toHaveBeenCalled(); expect(f.identify).not.toHaveBeenCalled();
  });

  it('still identifies a root absent from /proc and propagates identity failure', async () => {
    proc([]);
    const f = fixture(), failure = errno('ENOENT');
    f.identify.mockImplementation(() => { throw failure; });
    await expect(f.internal.descendants()).rejects.toThrow(failure);
    expect(f.identify).toHaveBeenCalledExactlyOnceWith(10);
  });
});
