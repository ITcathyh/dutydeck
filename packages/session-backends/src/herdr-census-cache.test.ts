import { afterEach, expect, it, vi } from 'vitest';
import { HerdrBackend } from './herdr-backend.js';

const launch = 'b'.repeat(64), uid = process.getuid!();
type Proc = { start: string; uid: number; environ: string; envRange: [string, string] };
const proc = vi.hoisted(() => ({ table: new Map<string, Proc>(), reads: { status: 0, environ: 0 } }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const error = (code: string) => Object.assign(new Error(code), { code });
  return { ...actual,
    existsSync: (path: unknown) => path === '/fixture/cache.json' || actual.existsSync(path as string),
    readdirSync: (path: unknown, ...args: unknown[]) => path === '/proc' ? [...proc.table.keys()] : (actual.readdirSync as any)(path, ...args),
    readFileSync: (path: unknown, ...args: unknown[]) => {
      if (path === '/fixture/cache.json') return JSON.stringify({ launch_id: launch, owner: 'fixture', name: `dutydeck-${'a'.repeat(32)}`, root: { host: 'host', boot: 'boot', namespace: 'namespace', pid: 100, start: '100' } });
      const match = /^\/proc\/(\d+)\/(\w+)$/.exec(String(path));
      if (!match) return (actual.readFileSync as any)(path, ...args);
      const entry = proc.table.get(match[1]!);
      if (!entry) throw error('ENOENT');
      if (match[2] === 'stat') {
        // Fields 3..52 after "pid (comm) ": state, …, starttime (22), …, env_start (50), env_end (51).
        const fields = Array(50).fill('0');
        fields[0] = 'S'; fields[19] = entry.start; fields[47] = entry.envRange[0]; fields[48] = entry.envRange[1];
        return `${match[1]} (fixture) ${fields.join(' ')}`;
      }
      if (match[2] === 'status') { proc.reads.status++; return `Uid:\t${entry.uid}\t${entry.uid}\t${entry.uid}\t${entry.uid}\n`; }
      if (match[2] === 'environ') { proc.reads.environ++; return entry.environ; }
      throw error('ENOENT');
    },
  };
});
afterEach(() => { proc.table.clear(); });

const owned = `dutydeck_terminal_launch_id=${launch}\0`;
function backend() {
  proc.reads = { status: 0, environ: 0 };
  proc.table.set('200', { start: '110', uid, environ: owned, envRange: ['1000', '2000'] });
  proc.table.set('201', { start: '110', uid, environ: 'unrelated=1\0', envRange: ['3000', '4000'] });
  proc.table.set('202', { start: '110', uid: uid + 1, environ: owned, envRange: ['0', '0'] });
  return new HerdrBackend(`dutydeck-${'a'.repeat(32)}`, { binary: 'unused', stateFile: '/fixture/cache.json', ownerId: 'fixture', processProbe: {
    identify: pid => ({ host: 'host', boot: 'boot', namespace: 'namespace', pid, start: proc.table.get(String(pid))!.start }), observe: () => 'alive',
  } });
}
const census = (target: HerdrBackend) => ((target as any).ownedProcesses() as Array<{ pid: number }>).map(item => item.pid);

it('classifies each unchanged process once and then reuses the verdict from /proc/<pid>/stat alone', () => {
  const target = backend();
  expect(census(target)).toEqual([200]);
  expect(proc.reads).toEqual({ status: 3, environ: 2 });
  expect(census(target)).toEqual([200]);
  expect(proc.reads).toEqual({ status: 3, environ: 2 });
});

it('classifies a process again after exec moves its environment, a PID reuse, or a launch change', () => {
  const target = backend();
  expect(census(target)).toEqual([200]);
  // exec keeps pid and start time but rebuilds the stack: the marker is gone now.
  proc.table.set('200', { ...proc.table.get('200')!, environ: 'unrelated=1\0', envRange: ['5000', '6000'] });
  // A new process reusing PID 201 inherited the marker.
  proc.table.set('201', { start: '120', uid, environ: owned, envRange: ['3000', '4000'] });
  expect(census(target)).toEqual([201]);
  expect(proc.reads).toEqual({ status: 5, environ: 4 });
  (target as any).state.launch_id = 'c'.repeat(64);
  expect(census(target)).toEqual([]);
  expect(proc.reads).toEqual({ status: 8, environ: 6 });
});

it('drops verdicts for processes that left /proc on a full scan', () => {
  const target = backend();
  census(target);
  proc.table.delete('201');
  census(target);
  expect([...(target as any).processVerdicts.keys()].map((key: string) => key.split(':')[0]).sort()).toEqual(['200', '202']);
});
