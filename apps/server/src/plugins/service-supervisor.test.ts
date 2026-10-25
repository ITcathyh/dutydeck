import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
      await supervisor.stop('sample');
      expect(supervisor.status('sample')).toMatchObject({ status: 'stopped', root: f.root, entry: f.entry });
      await supervisor.stopAll();
    } finally { delete process.env.DUTYDECK_PLUGIN_TEST_SECRET; }
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

  it('refuses to replace a running service spec', async () => {
    const f = await fixture(`setInterval(() => {}, 1000);`);
    const supervisor = new PluginServiceSupervisor(undefined, 1_000);
    supervisor.register({ plugin: 'sample', root: f.root, entry: f.entry, dataDir: f.dataDir });
    await supervisor.start('sample');
    expect(() => supervisor.register({ plugin: 'sample', root: '/candidate', entry: '/candidate/service.mjs', dataDir: '/candidate/data' })).toThrow('PLUGIN_SERVICE_RUNNING');
    await supervisor.stop('sample');
  });
});
