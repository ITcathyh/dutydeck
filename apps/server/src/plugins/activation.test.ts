import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createRepositories, currentProcessIdentity } from '@dutydeck/storage';
import { PLUGIN_STORE_DIAGNOSTIC, PluginHost } from './host.js';
import { pluginDoctorChecks } from './doctor.js';
import { runPluginCli } from './cli.js';
import { createCliUi } from '../cli-ui.js';
import { PluginStore } from './store.js';
import { pluginActivationBlockers, validateProviderRegistration } from './activation.js';
import { writePlugin } from './scenario-fixtures.test-helpers.js';
import { lazyBundleForTest } from '../../../../tests/support/bundle-for-test.js';

// Every activation starts a validation process, and the two-Host case starts two Hosts:
// run them as bundles instead of paying a TypeScript loader cold start each time.
const validationWorker = lazyBundleForTest('activation-worker', resolve(import.meta.dirname, 'activation-worker.ts'));
const hostBundle = lazyBundleForTest('activation-host', resolve(import.meta.dirname, 'host.ts'));
afterAll(async () => { await Promise.all([validationWorker.cleanup(), hostBundle.cleanup()]); });

const fixture = (version: string) => ({
  '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'versioned', version, providers: 'provider.mjs', userConfig: { token: { description: 'Authentication token', sensitive: true } } }),
  'provider.mjs': `export default api => { api.registerHookHandler('notify', async () => ({ additionalContext: 'provider-${version}' })); };`,
  'hooks/hooks.json': JSON.stringify({ 'task.beforeRun': [{ command: ['node', 'hook.mjs'], timeout: 2000 }] }),
  'hook.mjs': `console.log(JSON.stringify({updatedPrompt:'hook-${version}'}));`,
  'skills/example/SKILL.md': `---\nname: example\ndescription: versioned fixture\n---\nskill-${version}`
});

describe('immutable plugin activation', () => {
  let directory: string, source: string, store: PluginStore;
  const hosts: PluginHost[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dutydeck-plugin-activation-'));
    source = join(directory, 'source');
    store = new PluginStore(join(directory, 'data'), join(directory, 'no-builtins'), undefined, await validationWorker.path());
    await writePlugin(source, fixture('1.0.0'));
    await store.install(source, { yes: true });
  });
  afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose(); await rm(directory, { recursive: true, force: true }); });
  const load = async () => { const host = await PluginHost.load({ dataDir: store.dataDir, builtinRoot: store.builtinRoot }); hosts.push(host); return host; };
  const stage = async (version = '2.0.0') => { await writePlugin(source, fixture(version)); return store.update('versioned', { yes: true }); };
  const versions = async (host: PluginHost) => ({
    provider: (await host.hooks.run('notify', { payload: {} })).additionalContext,
    hook: (await host.hooks.run('task.beforeRun', { payload: {} })).updatedPrompt,
    skill: await readFile(join(host.skillRoots({ workspaceRoot: directory })[0]!, 'example/SKILL.md'), 'utf8')
  });

  it('keeps v1 provider, command hook and skill together while v2 is staged; activates and rolls back offline', async () => {
    const host = await load(), root = store.pluginDir('versioned');
    const original = await versions(host);
    expect(original).toMatchObject({ provider: ['provider-1.0.0'], hook: 'hook-1.0.0', skill: expect.stringContaining('skill-1.0.0') });
    await stage();
    expect(store.pluginDir('versioned')).toBe(root);
    expect(await versions(host)).toEqual(original);
    await expect(store.activate('versioned')).rejects.toMatchObject({ code: 'PLUGIN_ACTIVATION_BLOCKED' });
    await host.dispose();
    const active = await store.activate('versioned');
    expect(active.version).toBe('2.0.0');
    expect(active.previous?.id).not.toBe(active.active?.id);
    expect(active.candidate).toBeUndefined();
    expect(await readFile(join(root, 'hook.mjs'), 'utf8')).toContain('1.0.0');
    const next = await load();
    expect(await versions(next)).toMatchObject({ provider: ['provider-2.0.0'], hook: 'hook-2.0.0', skill: expect.stringContaining('skill-2.0.0') });
    expect((await store.activationStatus('versioned')).hosts).toEqual([expect.objectContaining({ activated: true, artifact: active.active!.id })]);
    await next.dispose();
    await store.rollback('versioned');
    expect(store.pluginDir('versioned')).toBe(root);
    expect(await versions(await load())).toEqual(original);
  });

  it('does not switch while any of two Hosts sharing the directory still holds its lease', async () => {
    const first = await load(), second = await load();
    await stage();
    await first.dispose();
    expect((await store.activationStatus('versioned')).hosts).toHaveLength(1);
    await expect(store.activate('versioned')).rejects.toMatchObject({ code: 'PLUGIN_ACTIVATION_BLOCKED' });
    await second.dispose();
    expect((await store.activate('versioned')).version).toBe('2.0.0');
  });

  it('starts with built-in plugins only while the store lock stays busy, reports the lock file, then loads all after the lock is released', async () => {
    const lock = new Database(join(store.pluginsDir, '.config-lock.sqlite'));
    let degraded: PluginHost;
    try {
      lock.exec('BEGIN IMMEDIATE');
      // 锁等待按 Date.now() 计截止、真实 setTimeout 重试；只伪造 Date 并逐步拨快，免得真等 30 秒。
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        let settled = false;
        const started = Date.now();
        const loading = load().finally(() => { settled = true; });
        while (!settled) {
          await new Promise(resolve => setTimeout(resolve, 10));
          vi.setSystemTime(Date.now() + 1_000);
        }
        degraded = await loading;
        // 多等一会儿：要盖过一次 plugin activate 的隔离验证（15 秒）。
        expect(Date.now() - started).toBeGreaterThanOrEqual(30_000);
      } finally { vi.useRealTimers(); }
      expect(degraded.active.map(item => item.entry.name)).toEqual([]);
      expect(degraded.degraded).toContain(join(store.pluginsDir, '.config-lock.sqlite'));
      expect(degraded.diagnostics).toEqual([expect.objectContaining({ plugin: PLUGIN_STORE_DIAGNOSTIC, message: expect.stringContaining('只加载了内置插件') })]);
      expect((await store.activationStatus('versioned')).hosts).toEqual([]);
      expect(await pluginDoctorChecks(store.dataDir, store.builtinRoot)).toContainEqual(expect.objectContaining({ id: 'plugins.store', level: 'fail', detail: expect.stringContaining('.config-lock.sqlite') }));
    } finally { lock.close(); }
    expect((await load()).active.map(item => item.entry.name)).toEqual(['versioned']);
    await degraded!.dispose();
    expect((await pluginDoctorChecks(store.dataDir, store.builtinRoot)).map(check => check.id)).not.toContain('plugins.store');
  }, 15_000);

  it('starts with built-in plugins only when plugins.lock.json is corrupt and names the file', async () => {
    const lockFile = join(store.pluginsDir, 'plugins.lock.json');
    await writeFile(lockFile, '{"version": 1, "plugins": {');
    const host = await load();
    expect(host.active).toEqual([]);
    expect(host.diagnostics).toEqual([expect.objectContaining({ plugin: PLUGIN_STORE_DIAGNOSTIC, message: expect.stringContaining(lockFile) })]);
    const checks = await pluginDoctorChecks(store.dataDir, store.builtinRoot);
    expect(checks).toContainEqual(expect.objectContaining({ id: 'plugins.store', level: 'fail' }));
    expect(checks).toContainEqual(expect.objectContaining({ id: 'plugins.lock', level: 'fail', detail: expect.stringContaining(lockFile) }));
  });

  it('prunes stopped and dead leases of the same database at startup, keeping live, foreign and unreadable records', async () => {
    const hostsDir = join(store.pluginsDir, '.hosts');
    for (let index = 0; index < 3; index += 1) await (await load()).dispose();
    const crashed = { identity: { ...currentProcessIdentity(), start: 'not-this-process' }, database: resolve(store.database), stopped: false, plugins: { versioned: 'legacy' } };
    await writeFile(join(hostsDir, 'crashed.json'), JSON.stringify(crashed));
    await writeFile(join(hostsDir, 'foreign.json'), JSON.stringify({ ...crashed, database: join(directory, 'other.db'), stopped: true }));
    await writeFile(join(hostsDir, 'broken.json'), '{');
    const live = await load();
    const files = (await readdir(hostsDir)).filter(file => file.endsWith('.json')).sort();
    expect(files).toHaveLength(3);
    expect(files).toEqual(expect.arrayContaining(['broken.json', 'foreign.json']));
    await live.dispose();
  });

  it('refuses uninstall while a Host still references any artifact', async () => {
    const host = await load(), root = store.pluginDir('versioned');
    await stage();
    await expect(store.uninstall('versioned')).rejects.toMatchObject({ code: 'PLUGIN_ACTIVATION_BLOCKED' });
    expect(await readFile(join(root, 'hook.mjs'), 'utf8')).toContain('1.0.0');
    await host.dispose(); await store.uninstall('versioned');
    expect(store.list()).toEqual([]);
    await expect(readFile(join(root, 'hook.mjs'))).rejects.toThrow();
  });

  it('keeps two real Host processes safe across one crash and reclaims their stale leases after both exit', async () => {
    const program = `import {PluginHost} from ${JSON.stringify(await hostBundle.path())}; await PluginHost.load(${JSON.stringify({ dataDir: store.dataDir, builtinRoot: store.builtinRoot })}); process.send('ready'); setInterval(()=>{},1000);`;
    const children = Array.from({ length: 2 }, () => spawn(process.execPath, ['--input-type=module', '-e', program], { cwd: resolve(import.meta.dirname, '../../../..'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
    try {
      await Promise.all(children.map(child => Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`Host child exited ${code}`); })])));
      await stage();
      await expect(store.activate('versioned')).rejects.toMatchObject({ code: 'PLUGIN_ACTIVATION_BLOCKED' });
      children[0]!.kill('SIGKILL'); await once(children[0]!, 'exit');
      expect((await store.activationStatus('versioned')).hosts).toHaveLength(1);
      await expect(store.activate('versioned')).rejects.toMatchObject({ code: 'PLUGIN_ACTIVATION_BLOCKED' });
      children[1]!.kill('SIGKILL'); await once(children[1]!, 'exit');
      expect((await store.activate('versioned')).version).toBe('2.0.0');
    } finally { for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } }
  });

  it('keeps a legacy installed path valid and can roll back to it without moving an active consumer root', async () => {
    const lockPath = join(store.pluginsDir, 'plugins.lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    const originalRoot = store.pluginDir('versioned'), legacyRoot = join(store.pluginsDir, 'versioned');
    await rename(originalRoot, legacyRoot); delete lock.plugins.versioned.active;
    await writeFile(lockPath, JSON.stringify(lock));
    const old = await load();
    expect(old.active[0]!.plugin.root).toBe(legacyRoot);
    await stage();
    expect(store.pluginDir('versioned')).toBe(legacyRoot);
    expect(await versions(old)).toMatchObject({ hook: 'hook-1.0.0', provider: ['provider-1.0.0'] });
    await old.dispose(); await store.activate('versioned'); await store.rollback('versioned');
    expect(store.pluginDir('versioned')).toBe(legacyRoot);
    expect(await versions(await load())).toMatchObject({ hook: 'hook-1.0.0', provider: ['provider-1.0.0'] });
  });

  it('refuses broken or modified candidates and preserves the selected root', async () => {
    const original = store.pluginDir('versioned');
    await stage();
    await writeFile(join(store.artifactDir('versioned', store.get('versioned').candidate), 'provider.mjs'), 'throw new Error("changed")');
    await expect(store.activate('versioned')).rejects.toMatchObject({ code: 'PLUGIN_ARTIFACT_CHANGED' });
    await writePlugin(source, { 'provider.mjs': 'throw new Error("load failure")' }); await store.update('versioned', { yes: true });
    await expect(store.activate('versioned')).rejects.toMatchObject({ code: 'PLUGIN_ACTIVATION_FAILED' });
    expect(store.get('versioned').candidate?.validation?.status).toBe('failed');
    expect(store.pluginDir('versioned')).toBe(original);
    expect((await readdir(join(store.pluginsDir, '.staging')))).toEqual([]);
  });

  it('repairs a damaged candidate from the same source offline without replacing any live root', async () => {
    const host = await load(), activeRoot = store.pluginDir('versioned');
    await stage();
    const candidate = store.get('versioned').candidate!;
    const root = store.artifactDir('versioned', candidate);
    await writeFile(join(root, 'provider.mjs'), 'throw new Error("damaged")');
    await expect(store.update('versioned', { yes: true })).rejects.toMatchObject({ code: 'PLUGIN_ACTIVATION_BLOCKED' });
    expect(await readFile(join(root, 'provider.mjs'), 'utf8')).toContain('damaged');
    expect(await versions(host)).toMatchObject({ provider: ['provider-1.0.0'], hook: 'hook-1.0.0' });
    await host.dispose();
    await expect(store.activate('versioned')).rejects.toMatchObject({ code: 'PLUGIN_ARTIFACT_CHANGED' });
    await store.update('versioned', { yes: true });
    expect(store.get('versioned').candidate!.id).toBe(candidate.id);
    expect(store.pluginDir('versioned')).toBe(activeRoot);
    await store.activate('versioned');
    expect(await versions(await load())).toMatchObject({ provider: ['provider-2.0.0'], hook: 'hook-2.0.0' });
    expect(await readFile(join(activeRoot, 'hook.mjs'), 'utf8')).toContain('1.0.0');
    expect(await readdir(join(store.pluginsDir, '.staging'))).toEqual([]);
  });

  it.each(['active', 'previous'] as const)('never repairs a damaged %s artifact in place', async role => {
    const root = store.pluginDir('versioned');
    if (role === 'previous') { await stage(); await store.activate('versioned'); await writePlugin(source, fixture('1.0.0')); }
    await writeFile(join(root, 'provider.mjs'), 'throw new Error("damaged")');
    await expect(store.update('versioned', { yes: true })).rejects.toMatchObject({ code: 'PLUGIN_ARTIFACT_CHANGED' });
    expect(await readFile(join(root, 'provider.mjs'), 'utf8')).toContain('damaged');
  });

  it('uses actual Host registration validation, not merely a successful provider import', async () => {
    await stage();
    await writePlugin(source, { 'provider.mjs': "export default api => api.registerCiProvider({id:'invalid',matchRepository:()=>undefined})" });
    await store.update('versioned', { yes: true });
    await expect(store.activate('versioned')).rejects.toMatchObject({ code: 'PLUGIN_ACTIVATION_FAILED' });
    expect(store.get('versioned').version).toBe('1.0.0');
  });

  it('does not expose provider configuration in activation errors, status or static doctor checks', async () => {
    const canary = 'activation-secret-canary-9c72';
    await writePlugin(source, {
      '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'versioned', version: '2.0.0', providers: 'provider.mjs', userConfig: { token: { description: 'Authentication token', sensitive: true } } }),
      'provider.mjs': `import {writeFileSync} from 'node:fs'; export default api => { writeFileSync(${JSON.stringify(join(directory, 'secret-seen'))}, String(api.config.token === ${JSON.stringify(canary)})); throw new Error(api.config.token) }`
    });
    await store.update('versioned', { yes: true });
    await store.setConfig('versioned', 'token', Buffer.from(canary));
    const output: string[] = [];
    const ui = createCliUi({ stdout: { write: text => { output.push(text); } }, stderr: { write: text => { output.push(text); } } });
    await expect(runPluginCli('activate', ['versioned'], { database: store.database, json: true }, { ui, builtinRoot: store.builtinRoot, validationWorker: await validationWorker.path() })).rejects.toMatchObject({ code: 'PLUGIN_ACTIVATION_FAILED', message: expect.not.stringContaining(canary) });
    await runPluginCli('status', ['versioned'], { database: store.database, json: true }, { ui, builtinRoot: store.builtinRoot });
    expect(await readFile(join(directory, 'secret-seen'), 'utf8')).toBe('true');
    expect(output.join('')).not.toContain(canary);
    expect(JSON.stringify(await pluginDoctorChecks(store.dataDir, store.builtinRoot))).not.toContain(canary);
    expect(store.get('versioned').candidate?.validation?.status).toBe('failed');
  });

  it('keeps doctor static without importing an installed provider', async () => {
    await store.uninstall('versioned');
    const marker = join(directory, 'provider-imported');
    await writePlugin(source, { 'provider.mjs': `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'imported'); export default () => {};` });
    await store.install(source, { yes: true });
    expect((await pluginDoctorChecks(store.dataDir, store.builtinRoot))[0]).toMatchObject({ level: 'ok' });
    expect(existsSync(marker)).toBe(false);
    await load();
    expect(await readFile(marker, 'utf8')).toBe('imported');
  });

  it('rejects paused recovery/queued work and this plugin unknown actions, but not unrelated or terminal history', async () => {
    const repos = createRepositories(store.database);
    await stage();
    try {
      await repos.config.set('plugin.tools.action.other', JSON.stringify({ plugin: 'other', status: 'unknown' }));
      await repos.config.set('plugin.tools.action.old', JSON.stringify({ plugin: 'versioned', status: 'succeeded' }));
      expect(await pluginActivationBlockers(store.pluginsDir, 'versioned', store.database)).toEqual([]);
      await repos.config.set('plugin.tools.action.mine', JSON.stringify({ plugin: 'versioned', status: 'unknown' }));
      await expect(store.activate('versioned')).rejects.toMatchObject({ code: 'PLUGIN_ACTIVATION_BLOCKED', message: expect.stringContaining('unknown') });
      await repos.config.set('plugin.tools.action.mine', JSON.stringify({ plugin: 'versioned', status: 'failed' }));
      await repos.sessions.save({ id: 's', agentId: 'a', state: 'running', cwd: directory, runId: 'r', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await repos.tasks.create({ id: 'recovering', sessionId: 's', prompt: 'wait', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await expect(store.activate('versioned')).rejects.toMatchObject({ code: 'PLUGIN_ACTIVATION_BLOCKED', message: expect.stringContaining('tmux') });
      await repos.tasks.save({ ...(await repos.tasks.get!('recovering'))!, status: 'completed' });
      expect((await store.activate('versioned')).version).toBe('2.0.0');
    } finally { repos.close(); }
  });

  it('validates a candidate with an auto service without starting that service', async () => {
    const marker = join(directory, 'service-pid');
    await writePlugin(source, {
      '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'versioned', version: '2.0.0', providers: 'provider.mjs', service: { entry: 'service.mjs', mode: 'auto' } }),
      'provider.mjs': 'export default () => {};',
      'service.mjs': `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`
    });
    await store.update('versioned', { yes: true });
    try {
      expect((await store.activate('versioned')).version).toBe('2.0.0');
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (existsSync(marker)) try { process.kill(-Number(await readFile(marker, 'utf8')), 'SIGKILL'); } catch {}
    }
  });

  it('bounds isolated provider registration even for a synchronous infinite loop', async () => {
    await writeFile(join(source, 'provider.mjs'), 'while (true) {}');
    await expect(validateProviderRegistration({ root: source, dataDir: join(directory, 'validate'), entry: store.get('versioned'), config: {} }, 1_000, await validationWorker.path())).rejects.toThrow('超时');
  });
});
