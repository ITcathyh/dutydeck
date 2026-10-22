import { fork, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PluginStore } from './store.js';
import { PluginHost } from './host.js';

let directory: string;
let store: PluginStore;
const children: ChildProcess[] = [];
async function plugin(name: string) {
  const root = join(directory, name);
  await mkdir(join(root, '.dutydeck-plugin'), { recursive: true });
  await writeFile(join(root, '.dutydeck-plugin/plugin.json'), JSON.stringify({ name }));
  return root;
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dutydeck-lock-concurrency-'));
  store = new PluginStore(join(directory, 'data'));
  for (const name of ['one', 'two']) await store.install(await plugin(name));
});
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL'); await exited;
  }
  await rm(directory, { recursive: true, force: true });
});

async function writer(operation: string, target: string, hold = false) {
  const messages: Array<{ type: string; ok?: boolean; code?: string; message?: string }> = [];
  const child = fork(new URL('./lock-writer.test-helper.mjs', import.meta.url), [store.dataDir, operation, target, ...(hold ? ['hold'] : [])], {
    execArgv: ['--conditions=development', '--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  children.push(child);
  let stderr = ''; child.stderr!.on('data', chunk => { stderr += chunk; });
  child.on('message', message => messages.push(message as typeof messages[number]));
  const seen = (type: string) => messages.some(message => message.type === type);
  const wait = async (type: string) => { await vi.waitFor(() => expect(seen(type), stderr).toBe(true), { timeout: 10_000 }); };
  await wait('ready');
  return { child, seen, wait, start: () => child.send('start'), release: () => child.send('release'), result: async () => {
    await wait('result'); return messages.find(message => message.type === 'result')!;
  } };
}

it('preserves both acknowledged disables from independent unmodified processes', async () => {
  for (let round = 0; round < 8; round++) {
    await store.setEnabled('one', true); await store.setEnabled('two', true);
    const first = await writer('disable', 'one'), second = await writer('disable', 'two');
    first.start(); second.start();
    expect(await first.result()).toMatchObject({ ok: true });
    expect(await second.result()).toMatchObject({ ok: true });
    expect(store.list().map(entry => [entry.name, entry.enabled])).toEqual([['one', false], ['two', false]]);
  }
  const host = await PluginHost.load({ dataDir: store.dataDir, builtinRoot: join(directory, 'no-builtins') });
  expect(host.active).toEqual([]);
  expect(host.diagnostics).toEqual([]);
}, 30_000);

it.each(['disable', 'install', 'update', 'uninstall'])('coordinates %s with an independent lockfile writer', async operation => {
  const target = operation === 'install' ? await plugin('three') : 'two';
  const first = await writer('disable', 'one', true), second = await writer(operation, target, true);
  first.start(); await first.wait('snapshot');
  second.start(); await second.wait('attempt');
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(second.seen('snapshot')).toBe(false);
  first.release(); expect(await first.result()).toMatchObject({ ok: true });
  await second.wait('snapshot'); second.release();
  expect(await second.result()).toMatchObject({ ok: true });
  expect(store.get('one').enabled).toBe(false);
  if (operation === 'uninstall') expect(store.list().map(entry => entry.name)).toEqual(['one']);
  else expect(store.get(operation === 'install' ? 'three' : 'two').enabled).toBe(operation !== 'disable');
});

it('keeps serial and same-process changes and leaves no temporary lockfile writes', async () => {
  await store.setEnabled('one', false); await store.setEnabled('two', false);
  expect(store.list().every(entry => !entry.enabled)).toBe(true);
  await Promise.all([store.setEnabled('one', true), store.setEnabled('two', true)]);
  expect(store.list().every(entry => entry.enabled)).toBe(true);
  expect((await readdir(store.pluginsDir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

it('releases a killed owner without deleting the persistent SQLite lock file', async () => {
  const first = await writer('disable', 'one', true);
  first.start(); await first.wait('snapshot');
  const exited = new Promise(resolve => first.child.once('exit', resolve));
  first.child.kill('SIGKILL'); await exited;
  const second = await writer('disable', 'two'); second.start();
  expect(await second.result()).toMatchObject({ ok: true });
  expect(store.get('one').enabled).toBe(true);
  expect(store.get('two').enabled).toBe(false);
  expect(await readdir(store.pluginsDir)).toContain('.config-lock.sqlite');
});

it.each(['disable', 'uninstall', 'reinstall'])('rechecks the latest entry after update trust confirmation while another caller can %s', async operation => {
  const initial = store.get('one');
  await mkdir(join(directory, 'one/hooks'));
  await writeFile(join(directory, 'one/hooks/hooks.json'), JSON.stringify({ 'task.completed': [{ command: 'true', timeout: 1000 }] }));
  let confirm!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const pending = store.update('one', { confirm: async () => {
    entered(); await new Promise<void>(resolve => { confirm = resolve; }); return true;
  } });
  await ready;
  if (operation === 'disable') await store.setEnabled('one', false);
  else {
    await store.uninstall('one');
    if (operation === 'reinstall') {
      const replacement = await plugin('replacement');
      await writeFile(join(replacement, '.dutydeck-plugin/plugin.json'), JSON.stringify({ name: 'one' }));
      await store.install(replacement, { scope: 'bot:replacement' });
    }
  }
  confirm();
  if (operation === 'disable') {
    expect(await pending).toMatchObject({ entry: { enabled: false, active: initial.active, trustedCapabilities: [], candidate: { trustedCapabilities: ['hooks:task.completed'] } } });
    const saved = store.get('one');
    expect(saved.enabled).toBe(false);
    expect(saved.active).toEqual(initial.active);
    expect(saved.trustedCapabilities).toEqual([]);
    expect(saved.candidate?.id).not.toBe(initial.active?.id);
    expect(saved.candidate?.trustedCapabilities).toEqual(['hooks:task.completed']);
  } else if (operation === 'reinstall') {
    await expect(pending).rejects.toMatchObject({ code: 'PLUGIN_CHANGED' });
    expect(store.get('one')).toMatchObject({ scope: 'bot:replacement', source: { spec: join(directory, 'replacement') }, trustedCapabilities: [] });
  } else {
    await expect(pending).rejects.toMatchObject({ code: 'PLUGIN_NOT_INSTALLED' });
    expect(store.list().map(entry => entry.name)).toEqual(['two']);
  }
});
