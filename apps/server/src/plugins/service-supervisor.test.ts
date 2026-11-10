import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseProcStat, procStatExited } from '@dutydeck/shared';
import { PluginServiceSupervisor } from './service-supervisor.js';

const roots: string[] = [];
const processGroups = new Set<number>();
afterEach(async () => {
  // 即使 supervisor 的回归断言失败，也只清理本测试启动的进程组。
  for (const pid of processGroups) {
    try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  processGroups.clear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-plugin-service-'));
  roots.push(root);
  const entry = join(root, 'service.mjs');
  await writeFile(entry, source);
  return { root, entry, dataDir: join(root, 'data') };
}

describe('PluginServiceSupervisor', () => {
  it('starts and stops a service with a minimal child environment', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'dutydeck-service-env-')), 'env.json');
    roots.push(file.replace(/\/env\.json$/, ''));
    const f = await fixture(`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(file)}, JSON.stringify(process.env)); setInterval(() => {}, 1000);`);
    process.env.DUTYDECK_PLUGIN_TEST_SECRET = 'ambient-secret';
    process.env.DUTYDECK_DATABASE_URL = 'ambient-database';
    try {
      const supervisor = new PluginServiceSupervisor(undefined, 1_000);
      supervisor.register({ plugin: 'sample', root: f.root, entry: f.entry, dataDir: f.dataDir, config: { project: 'demo', token: 'should-not-pass' } });
      expect((await supervisor.start('sample')).status).toBe('running');
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (await access(file).then(() => true, () => false)) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const env = JSON.parse(await readFile(file, 'utf8')) as Record<string, string>;
      expect(env.DUTYDECK_PLUGIN_NAME).toBe('sample');
      expect(env.DUTYDECK_PLUGIN_CONFIG_PROJECT).toBe('demo');
      expect(env.DUTYDECK_PLUGIN_CONFIG_TOKEN).toBeUndefined();
      expect(env.DUTYDECK_PLUGIN_TEST_SECRET).toBeUndefined();
      expect(env.DUTYDECK_DATABASE_URL).toBeUndefined();
      await supervisor.stop('sample');
      expect(supervisor.status('sample')).toMatchObject({ status: 'stopped', root: f.root, entry: f.entry });
      await supervisor.stopAll();
    } finally { delete process.env.DUTYDECK_PLUGIN_TEST_SECRET; delete process.env.DUTYDECK_DATABASE_URL; }
  });

  it('isolates a crash and allows an explicit restart with the same active artifact', async () => {
    const f = await fixture(`process.exit(7);`);
    const supervisor = new PluginServiceSupervisor(undefined, 1_000);
    supervisor.register({ plugin: 'crash', root: f.root, entry: f.entry, dataDir: f.dataDir });
    expect((await supervisor.start('crash')).entry).toBe(f.entry);
    await vi.waitFor(() => expect(supervisor.status('crash')).toMatchObject({ status: 'crashed', lastExitCode: 7, restarts: 1, entry: f.entry }), { timeout: 10_000 });
    expect((await supervisor.start('crash')).status).toBe('running');
    await supervisor.stop('crash');
  });

  it('automatically restarts auto services with a bounded retry budget', async () => {
    const f = await fixture(`import { existsSync, readFileSync, writeFileSync } from 'node:fs'; const file = process.env.DUTYDECK_PLUGIN_ROOT + '/count'; const count = existsSync(file) ? Number(readFileSync(file, 'utf8')) + 1 : 1; writeFileSync(file, String(count)); if (count < 3) process.exit(7); setInterval(() => {}, 1000);`);
    const supervisor = new PluginServiceSupervisor(undefined, 1_000, { restartBaseDelayMs: 50 });
    supervisor.register({ plugin: 'auto', root: f.root, entry: f.entry, dataDir: f.dataDir, mode: 'auto' });
    await supervisor.start('auto');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = supervisor.status('auto');
      if (status.status === 'running' && status.restarts >= 2) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(supervisor.status('auto')).toMatchObject({ status: 'running', restarts: 2 });
    await supervisor.stop('auto');
  });

  it('stops retrying an auto service after the finite crash budget', async () => {
    const f = await fixture('process.exit(9);');
    const warn = vi.fn();
    const supervisor = new PluginServiceSupervisor({ warn }, 1_000, { restartBaseDelayMs: 50 });
    supervisor.register({ plugin: 'loop', root: f.root, entry: f.entry, dataDir: f.dataDir, mode: 'auto' });
    await supervisor.start('loop');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = supervisor.status('loop');
      if (status.status === 'crashed' && status.restarts >= 4) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(supervisor.status('loop')).toMatchObject({ status: 'crashed', restarts: 4, lastExitCode: 9 });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ plugin: 'loop', restarts: 4 }), expect.stringContaining('已停止自动重启'));
    await supervisor.stop('loop');
  });

  it('backs off auto restarts at second scale by default', async () => {
    const f = await fixture('process.exit(9);');
    const supervisor = new PluginServiceSupervisor(undefined, 1_000);
    supervisor.register({ plugin: 'slow-retry', root: f.root, entry: f.entry, dataDir: f.dataDir, mode: 'auto' });
    await supervisor.start('slow-retry');
    await vi.waitFor(() => expect(supervisor.status('slow-retry')).toMatchObject({ status: 'crashed', restarts: 1 }));
    // 旧的 50ms 退避会在这段时间里把重试用完。
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(supervisor.status('slow-retry')).toMatchObject({ status: 'crashed', restarts: 1 });
    await supervisor.stop('slow-retry');
  });

  it('resets the retry budget after a service ran stably, so rare crashes keep being restarted', async () => {
    // 每次运行 40ms 后退出；把「稳定运行」门槛设为 20ms，相当于每次都是稳定运行几周后偶发崩溃。
    const f = await fixture('setTimeout(() => process.exit(5), 40);');
    let now = 0;
    const supervisor = new PluginServiceSupervisor(undefined, 1_000, { restartBaseDelayMs: 10, stableRunMs: 60_000, now: () => now });
    supervisor.register({ plugin: 'rare', root: f.root, entry: f.entry, dataDir: f.dataDir, mode: 'auto' });
    const tick = setInterval(() => { now += 61_000; }, 5);
    try {
      await supervisor.start('rare');
      await vi.waitFor(() => expect((supervisor.status('rare') as { restarts: number }).restarts).toBeGreaterThanOrEqual(6), { timeout: 10_000, interval: 50 });
    } finally { clearInterval(tick); await supervisor.stop('rare'); }
  });

  it('rate-limits stderr logging per plugin and reports what was suppressed', async () => {
    const f = await fixture(`let n = 0; const timer = setInterval(() => { process.stderr.write('line ' + (n++) + '\\n'); if (n === 30) { clearInterval(timer); setInterval(() => {}, 1000); } }, 2);`);
    const warn = vi.fn();
    let now = 0;
    const supervisor = new PluginServiceSupervisor({ warn }, 1_000, { stderrLogLimit: 5, stderrWindowMs: 60_000, now: () => now });
    supervisor.register({ plugin: 'noisy', root: f.root, entry: f.entry, dataDir: f.dataDir });
    try {
      await supervisor.start('noisy');
      await new Promise(resolve => setTimeout(resolve, 800));
      const stderrLogs = () => warn.mock.calls.filter(([data]) => 'stderr' in data);
      expect(stderrLogs()).toHaveLength(5);
      now += 61_000;
      (supervisor as any).logStderr((supervisor as any).records.get('noisy'), 'after window');
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ plugin: 'noisy', suppressed: expect.any(Number) }), expect.any(String));
      expect(stderrLogs()).toHaveLength(6);
    } finally { await supervisor.stop('noisy'); }
  });

  it.runIf(process.platform === 'linux')('waits for and kills a TERM-resistant worker after its parent exits', async () => {
    const f = await fixture(`import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
spawn(process.execPath, [process.env.DUTYDECK_PLUGIN_ROOT + '/worker.mjs'], { stdio: 'ignore' });
process.on('SIGTERM', () => { writeFileSync(process.env.DUTYDECK_PLUGIN_ROOT + '/parent-exited', 'yes'); process.exit(0); });
setInterval(() => {}, 1000);`);
    await writeFile(join(f.root, 'worker.mjs'), `import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
writeFileSync(process.env.DUTYDECK_PLUGIN_ROOT + '/worker-ready', String(process.pid));
setInterval(() => {}, 1000);`);
    const supervisor = new PluginServiceSupervisor(undefined, 500);
    supervisor.register({ plugin: 'worker', ...f });
    try {
      processGroups.add((await supervisor.start('worker')).pid!);
      const worker = await readyPid(join(f.root, 'worker-ready'));
      const stopped = await supervisor.stop('worker');
      expect(await readFile(join(f.root, 'parent-exited'), 'utf8')).toBe('yes');
      expect(await processAlive(worker)).toBe(false);
      expect(stopped).toMatchObject({ status: 'stopped' });
      expect(stopped).not.toHaveProperty('pid');
    } finally { await supervisor.stopAll(); }
  });

  it('serializes stop, start and restart without losing the replacement child', async () => {
    const f = await fixture(`import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 150));
writeFileSync(process.env.DUTYDECK_PLUGIN_ROOT + '/' + process.pid, String(process.pid));
setInterval(() => {}, 1000);`);
    const supervisor = new PluginServiceSupervisor(undefined, 1_000);
    supervisor.register({ plugin: 'race', ...f });
    try {
      const first = await supervisor.start('race');
      processGroups.add(first.pid!);
      await readyPid(join(f.root, String(first.pid)));
      const stopping = supervisor.stop('race');
      const starting = supervisor.start('race');
      expect(() => supervisor.register({ plugin: 'race', ...f })).toThrow('PLUGIN_SERVICE_RUNNING');
      expect(await stopping).toMatchObject({ status: 'stopped' });
      const second = await starting;
      processGroups.add(second.pid!);
      await readyPid(join(f.root, String(second.pid)));
      const third = await supervisor.start('race');
      processGroups.add(third.pid!);
      expect(third.pid).toBe(second.pid);
      expect(second.pid).not.toBe(first.pid);
      expect(supervisor.status('race')).toMatchObject({ status: 'running', pid: second.pid });
      expect(await processAlive(first.pid!)).toBe(false);
      const restarting = supervisor.restart('race');
      const stopAfterRestart = supervisor.stop('race');
      const restarted = await restarting;
      processGroups.add(restarted.pid!);
      expect(restarted.pid).not.toBe(second.pid);
      expect(await stopAfterRestart).toMatchObject({ status: 'stopped' });
      expect(await processAlive(second.pid!)).toBe(false);
      expect(await processAlive(restarted.pid!)).toBe(false);
    } finally { await supervisor.stopAll(); }
  });

  it.runIf(process.platform !== 'win32')('keeps ownership and rejects stop when the process group cannot be cleared', async () => {
    const f = await fixture(`import { writeFileSync } from 'node:fs'; writeFileSync(process.env.DUTYDECK_PLUGIN_ROOT + '/ready', String(process.pid)); setInterval(() => {}, 1000);`);
    const supervisor = new PluginServiceSupervisor(undefined, 100);
    supervisor.register({ plugin: 'uncleared', ...f });
    try {
      const started = await supervisor.start('uncleared');
      processGroups.add(started.pid!);
      await readyPid(join(f.root, 'ready'));
      const kill = process.kill.bind(process);
      const signal = vi.spyOn(process, 'kill').mockImplementation((pid, name) => {
        if (pid === -started.pid! && (name === 'SIGTERM' || name === 'SIGKILL')) return true;
        return kill(pid, name);
      });
      try {
        await expect(supervisor.stop('uncleared')).rejects.toThrow('PLUGIN_SERVICE_STOP_TIMEOUT');
        expect(supervisor.status('uncleared')).toMatchObject({ status: 'stopping', pid: started.pid });
        expect(await processAlive(started.pid!)).toBe(true);
      } finally { signal.mockRestore(); }
      expect(await supervisor.stop('uncleared')).toMatchObject({ status: 'stopped' });
      expect(await processAlive(started.pid!)).toBe(false);
    } finally { await supervisor.stopAll(); }
  });

  it.runIf(process.platform === 'linux')('cleans a crashed service group before its automatic replacement starts', async () => {
    const f = await fixture(`import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
const root = process.env.DUTYDECK_PLUGIN_ROOT;
if (!existsSync(root + '/worker-ready')) {
  spawn(process.execPath, [root + '/worker.mjs'], { stdio: 'ignore' });
  setInterval(() => { if (existsSync(root + '/worker-ready')) process.exit(7); }, 10);
} else { writeFileSync(root + '/replacement-ready', String(process.pid)); setInterval(() => {}, 1000); }`);
    await writeFile(join(f.root, 'worker.mjs'), `import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
writeFileSync(process.env.DUTYDECK_PLUGIN_ROOT + '/worker-ready', String(process.pid));
setInterval(() => {}, 1000);`);
    const supervisor = new PluginServiceSupervisor(undefined, 200, { restartBaseDelayMs: 20 });
    supervisor.register({ plugin: 'auto-worker', ...f, mode: 'auto' });
    try {
      processGroups.add((await supervisor.start('auto-worker')).pid!);
      const worker = await readyPid(join(f.root, 'worker-ready'));
      const replacement = await readyPid(join(f.root, 'replacement-ready'));
      processGroups.add(replacement);
      expect(await processAlive(worker)).toBe(false);
      expect(supervisor.status('auto-worker')).toMatchObject({ status: 'running', pid: replacement, restarts: 1 });
      await supervisor.stop('auto-worker');
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(supervisor.status('auto-worker')).toMatchObject({ status: 'stopped', restarts: 1 });
    } finally { await supervisor.stopAll(); }
  });

  it('refuses to replace a running service spec', async () => {
    const f = await fixture(`setInterval(() => {}, 1000);`);
    const supervisor = new PluginServiceSupervisor(undefined, 1_000);
    supervisor.register({ plugin: 'sample', root: f.root, entry: f.entry, dataDir: f.dataDir });
    await supervisor.start('sample');
    expect(() => supervisor.register({ plugin: 'sample', root: '/candidate', entry: '/candidate/service.mjs', dataDir: '/candidate/data' })).toThrow('PLUGIN_SERVICE_RUNNING');
    await supervisor.stop('sample');
  });
});

async function readyPid(file: string): Promise<number> {
  let pid = 0;
  await vi.waitFor(async () => {
    pid = Number(await readFile(file, 'utf8'));
    expect(pid).toBeGreaterThan(0);
  }, { timeout: 10_000, interval: 20 });
  return pid;
}

async function processAlive(pid: number): Promise<boolean> {
  try {
    if (process.platform === 'linux') return !procStatExited(parseProcStat(await readFile(`/proc/${pid}/stat`, 'utf8')));
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}
