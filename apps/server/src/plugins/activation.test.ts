import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createRepositories } from '@dutydeck/storage';
import { PluginHost } from './host.js';
import { pluginDoctorChecks } from './doctor.js';
import { runPluginCli } from './cli.js';
import { createCliUi } from '../cli-ui.js';
import { PluginStore } from './store.js';
import { pluginActivationBlockers, validateProviderRegistration } from './activation.js';
import { writePlugin } from './scenario-fixtures.test-helpers.js';

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
    store = new PluginStore(join(directory, 'data'), join(directory, 'no-builtins'));
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

  it('fails Host startup when the store lease cannot be acquired, then succeeds after the lock is released', async () => {
    const lock = new Database(join(store.pluginsDir, '.config-lock.sqlite'));
    try {
      lock.exec('BEGIN IMMEDIATE');
      await expect(load()).rejects.toMatchObject({ code: 'PLUGIN_CONFIG_BUSY' });
      expect((await store.activationStatus('versioned')).hosts).toEqual([]);
    } finally { lock.close(); }
    expect((await load()).active.map(item => item.entry.name)).toEqual(['versioned']);
  }, 15_000);

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
    const entry = resolve(import.meta.dirname, 'host.ts');
    const program = `import {PluginHost} from ${JSON.stringify(entry)}; await PluginHost.load(${JSON.stringify({ dataDir: store.dataDir, builtinRoot: store.builtinRoot })}); process.send('ready'); setInterval(()=>{},1000);`;
    const children = Array.from({ length: 2 }, () => spawn(process.execPath, ['--conditions=development', '--import', 'tsx', '--input-type=module', '-e', program], { cwd: resolve(import.meta.dirname, '../../../..'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
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
    await expect(runPluginCli('activate', ['versioned'], { database: store.database, json: true }, { ui, builtinRoot: store.builtinRoot })).rejects.toMatchObject({ code: 'PLUGIN_ACTIVATION_FAILED', message: expect.not.stringContaining(canary) });
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

  it('bounds isolated provider registration even for a synchronous infinite loop', async () => {
    await writeFile(join(source, 'provider.mjs'), 'while (true) {}');
    await expect(validateProviderRegistration({ root: source, dataDir: join(directory, 'validate'), entry: store.get('versioned'), config: {} }, 1500)).rejects.toThrow('超时');
  });
});
