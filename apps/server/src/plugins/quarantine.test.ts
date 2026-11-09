import { readdir, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { currentProcessIdentity } from '@dutydeck/storage/helpers';
import { quarantineCrashedPlugins, registerPluginCodeRoot } from './crash-attribution.js';
import { pluginDoctorChecks } from './doctor.js';
import { PluginHost } from './host.js';
import { markProviderLoading, quarantinePlugin, readPluginQuarantine, releaseProviderLoadingMarkers } from './quarantine.js';
import { writePlugin } from './scenario-fixtures.test-helpers.js';
import { PluginStore } from './store.js';

let temp: string, dataDir: string, builtinRoot: string, store: PluginStore;
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'dutydeck-plugin-quarantine-'));
  dataDir = join(temp, 'data'); builtinRoot = join(temp, 'no-builtin');
  store = new PluginStore(dataDir, builtinRoot);
  await writePlugin(join(temp, 'src'), {
    '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'flaky', providers: 'index.mjs' }),
    'index.mjs': `export default api => api.registerHookHandler('notify', async () => ({}));\n`
  });
  await store.install(join(temp, 'src'), { yes: true });
});
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

const load = () => PluginHost.load({ dataDir, builtinRoot });

it('skips a crash-quarantined plugin at startup, reports it in doctor and status, and enable clears it', async () => {
  quarantinePlugin(store.pluginsDir, { plugin: 'flaky', reason: 'crash', at: '2026-01-01T00:00:00.000Z', origin: 'uncaughtException' });
  const host = await load();
  try {
    expect(host.active.map(item => item.entry.name)).toEqual([]);
    expect(host.diagnostics).toEqual([{ plugin: 'flaky', message: expect.stringContaining('dutydeck plugin enable flaky') }]);
  } finally { await host.dispose(); }
  expect(await pluginDoctorChecks(dataDir, builtinRoot)).toEqual([expect.objectContaining({ id: 'plugins.flaky', level: 'fail', command: 'dutydeck plugin enable flaky' })]);
  expect((await store.activationStatus('flaky')).quarantine).toMatchObject({ reason: 'crash' });
  // disable 不解除隔离；之后 enable 才解除。
  await store.setEnabled('flaky', false);
  expect(readPluginQuarantine(store.pluginsDir, 'flaky')).toBeDefined();
  await store.setEnabled('flaky', true);
  expect(readPluginQuarantine(store.pluginsDir, 'flaky')).toBeUndefined();
  const again = await load();
  try { expect(again.active.map(item => item.entry.name)).toEqual(['flaky']); } finally { await again.dispose(); }
});

it('treats a provider loading marker left by an exited process as a startup quarantine, but not one from a live process', async () => {
  const dir = join(store.pluginsDir, '.quarantine');
  await mkdir(dir, { recursive: true });
  const marker = (identity: unknown) => writeFile(join(dir, 'flaky.loading-1.json'), JSON.stringify({ plugin: 'flaky', at: '2026-01-01T00:00:00.000Z', identity }));
  // 另一个仍在运行的实例正在加载：不隔离。
  await marker(currentProcessIdentity());
  expect(readPluginQuarantine(store.pluginsDir, 'flaky')).toBeUndefined();
  // 同 PID、不同启动时间等同于写标记的进程已退出（卡死后被杀）。
  await marker({ ...currentProcessIdentity(), start: '1' });
  const host = await load();
  try {
    expect(host.active).toEqual([]);
    expect(host.diagnostics[0]?.message).toContain('加载它的 providers 时中断');
  } finally { await host.dispose(); }
});

it('removes its own loading marker after a provider loads or fails, so a normal restart does not quarantine', async () => {
  const host = await load();
  try { expect(host.active.map(item => item.entry.name)).toEqual(['flaky']); } finally { await host.dispose(); }
  await writePlugin(join(temp, 'broken'), { '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'broken', providers: 'index.mjs' }), 'index.mjs': 'export default () => { throw new Error("boom") }' });
  await store.install(join(temp, 'broken'), { yes: true });
  const failed = await load();
  try { expect(failed.diagnostics).toEqual([{ plugin: 'broken', message: expect.stringContaining('PLUGIN_PROVIDER_REGISTRATION_FAILED') }]); } finally { await failed.dispose(); }
  expect(await readdir(join(store.pluginsDir, '.quarantine'))).toEqual([]);
  expect(readPluginQuarantine(store.pluginsDir, 'broken')).toBeUndefined();
});

it('quarantines only plugins the daemon registered for quarantine', () => {
  registerPluginCodeRoot('daemon-loaded', join(temp, 'a'), store.pluginsDir);
  registerPluginCodeRoot('validation-only', join(temp, 'b'));
  expect(quarantineCrashedPlugins(['daemon-loaded', 'validation-only', 'unknown'], 'uncaughtException')).toEqual(['daemon-loaded']);
  expect(readPluginQuarantine(store.pluginsDir, 'daemon-loaded')).toMatchObject({ reason: 'crash', origin: 'uncaughtException' });
  expect(readPluginQuarantine(store.pluginsDir, 'validation-only')).toBeUndefined();
});

it('releases loading markers when startup is stopped by a signal, so an interrupted load is not quarantined', async () => {
  const dir = join(store.pluginsDir, '.quarantine');
  const done = markProviderLoading(store.pluginsDir, 'flaky');
  expect((await readdir(dir)).some(name => name.startsWith('flaky.loading-'))).toBe(true);
  releaseProviderLoadingMarkers();
  expect((await readdir(dir)).some(name => name.startsWith('flaky.loading-'))).toBe(false);
  // 加载完成后的清理对已删除的标记无害。
  done();
  expect(readPluginQuarantine(store.pluginsDir, 'flaky')).toBeUndefined();
});
