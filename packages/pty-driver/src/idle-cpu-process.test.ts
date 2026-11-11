import { afterEach, expect, it, vi } from 'vitest';
const files = vi.hoisted(() => new Map<string, string>());
vi.mock('node:fs', () => ({
  readFileSync: vi.fn((path: string) => { const value = files.get(path); if (value === undefined) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return value; }),
  readdirSync: vi.fn((path: string) => path === '/proc/10/task' ? ['10'] : path === '/proc/20/task' ? ['20'] : ['30']),
}));
import { readFileSync } from 'node:fs';
import { IdleCpuProcess } from './idle-cpu-process.js';
function stat(pid: number, start: string, own = 100, children = 0, state = 'S') {
  const fields = Array(52).fill('0'); fields[0] = state; fields[11] = String(own); fields[13] = String(children); fields[19] = start;
  return `${pid} (fixture) ${fields.join(' ')}`;
}
function put(pid: number, start = '1', children = '') { files.set(`/proc/${pid}/stat`, stat(pid, start)); files.set(`/proc/${pid}/task/${pid}/children`, children); }
afterEach(() => { files.clear(); vi.clearAllMocks(); });
it('samples only the owned root CPU, not historical reaped-child CPU', () => {
  put(10); files.set('/proc/10/stat', stat(10, '1', 100, 99_999));
  expect(new IdleCpuProcess(10, '1').sample()).toBe(1000);
});
it('rejects reused/missing roots, partial child scans and unreadable tasks', () => {
  const sampler = new IdleCpuProcess(10, '1'); put(10, '2'); expect(sampler.sample()).toBeUndefined();
  files.delete('/proc/10/stat'); expect(sampler.sample()).toBeUndefined();
  put(10); files.delete('/proc/10/task/10/children'); expect(sampler.sample()).toBeUndefined();
});
it('rechecks birth after the tree scan', () => {
  put(10); let reads = 0;
  vi.mocked(readFileSync).mockImplementation((path: any) => {
    if (path === '/proc/10/stat' && ++reads === 2) return stat(10, '2');
    return files.get(path)!;
  });
  expect(new IdleCpuProcess(10, '1').sample()).toBeUndefined();
  vi.mocked(readFileSync).mockImplementation((path: any) => { const v = files.get(path); if (v === undefined) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return v; });
});
it('rejects every live child and remembers descendants after reparenting', () => {
  const sampler = new IdleCpuProcess(10, '1'); put(10); expect(sampler.sample()).toBe(1000);
  put(10, '1', '20'); put(20, '2', '30'); put(30, '3'); expect(sampler.sample()).toBeUndefined();
  put(10); files.delete('/proc/20/stat'); expect(sampler.sample()).toBeUndefined();
  files.set('/proc/30/stat', stat(30, '3', 0, 0, 'Z')); expect(sampler.sample()).toBe(1000);
});
it('does not treat a reused descendant PID as the old child', () => {
  const sampler = new IdleCpuProcess(10, '1'); put(10, '1', '20'); put(20, '2'); expect(sampler.sample()).toBeUndefined();
  put(10); put(20, '3'); expect(sampler.sample()).toBe(1000);
});
