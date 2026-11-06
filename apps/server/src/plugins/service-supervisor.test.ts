import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginServiceSupervisor } from './service-supervisor.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

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
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(supervisor.status('crash')).toMatchObject({ status: 'crashed', lastExitCode: 7, restarts: 1, entry: f.entry });
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

  it('refuses to replace a running service spec', async () => {
    const f = await fixture(`setInterval(() => {}, 1000);`);
    const supervisor = new PluginServiceSupervisor(undefined, 1_000);
    supervisor.register({ plugin: 'sample', root: f.root, entry: f.entry, dataDir: f.dataDir });
    await supervisor.start('sample');
    expect(() => supervisor.register({ plugin: 'sample', root: '/candidate', entry: '/candidate/service.mjs', dataDir: '/candidate/data' })).toThrow('PLUGIN_SERVICE_RUNNING');
    await supervisor.stop('sample');
  });
});
