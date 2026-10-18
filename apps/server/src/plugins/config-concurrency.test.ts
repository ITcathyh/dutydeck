import Database from 'better-sqlite3';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PluginStore } from './store.js';

let directory: string;
let store: PluginStore;
const children: ChildProcess[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dutydeck-config-concurrency-'));
  store = new PluginStore(join(directory, 'data'));
  for (const name of ['one', 'two']) {
    const root = join(directory, name);
    await mkdir(join(root, '.dutydeck-plugin'), { recursive: true });
    await writeFile(join(root, '.dutydeck-plugin/plugin.json'), JSON.stringify({ name, userConfig: { first: { description: 'first' }, second: { description: 'second' }, secret: { description: 'secret', sensitive: true } } }));
    await store.install(root);
  }
});
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
  await rm(directory, { recursive: true, force: true });
});

async function writer(plugin: string, key: string, operation = 'set') {
  const messages: Array<{ type: string; ok?: boolean; message?: string }> = [];
  const child = fork(new URL('./config-writer.test-helper.mjs', import.meta.url), [store.dataDir, operation, plugin, key], {
    execArgv: ['--conditions=development', '--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  children.push(child);
  let stderr = ''; child.stderr!.on('data', chunk => { stderr += chunk; });
  child.on('message', message => messages.push(message as typeof messages[number]));
  await vi.waitFor(() => { expect(child.exitCode, stderr).toBeNull(); expect(messages.some(message => message.type === 'ready'), stderr).toBe(true); }, { timeout: 10_000 });
  return { child, messages, start: () => child.send('start'), release: () => child.send('release'), result: async () => {
    await vi.waitFor(() => expect(messages.some(message => message.type === 'result'), stderr).toBe(true), { timeout: 10_000 });
    return messages.find(message => message.type === 'result')!;
  } };
}

it.each(['one', 'two'])('preserves acknowledged keys from independent writers targeting one and %s', async secondPlugin => {
  const first = await writer('one', 'first'), second = await writer(secondPlugin, 'second');
  first.start(); second.start();
  await vi.waitFor(() => expect([...first.messages, ...second.messages].some(message => message.type === 'read')).toBe(true));
  // Hold the first snapshot long enough for the other process to attempt the same transaction.
  await new Promise(resolve => setTimeout(resolve, 100));
  for (const current of [first, second]) {
    if (current.messages.some(message => message.type === 'read')) current.release();
    else current.child.on('message', message => { if ((message as { type: string }).type === 'read') current.release(); });
  }
  expect(await first.result()).toMatchObject({ ok: true }); expect(await second.result()).toMatchObject({ ok: true });
  expect(store.plainConfig('one').first).toBe('first'); expect(store.plainConfig(secondPlugin).second).toBe('second');
  expect((await readdir(store.pluginsDir)).filter(name => name.startsWith('.config')).sort()).toEqual(['.config-lock.sqlite', '.config.json']);
});

it('serializes uninstall configuration cleanup with a writer for another plugin', async () => {
  await store.setConfig('one', 'first', Buffer.from('old'));
  const first = await writer('one', '', 'uninstall'), second = await writer('two', 'second');
  first.start();
  await vi.waitFor(() => expect(first.messages.some(message => message.type === 'read')).toBe(true));
  second.start(); await new Promise(resolve => setTimeout(resolve, 100));
  if (second.messages.some(message => message.type === 'read')) second.release();
  else second.child.on('message', message => { if ((message as { type: string }).type === 'read') second.release(); });
  first.release();
  expect(await first.result()).toMatchObject({ ok: true }); expect(await second.result()).toMatchObject({ ok: true });
  expect(store.plainConfig('one')).toEqual({}); expect(store.plainConfig('two')).toEqual({ second: 'second' });
});

it('recovers the lock after its owner is killed', async () => {
  const first = await writer('one', 'first'); first.start();
  await vi.waitFor(() => expect(first.messages.some(message => message.type === 'read')).toBe(true));
  first.child.kill('SIGKILL'); await new Promise(resolve => first.child.once('exit', resolve));
  await store.setConfig('two', 'second', Buffer.from('saved'));
  expect(store.plainConfig('two')).toEqual({ second: 'saved' });
  expect((await readdir(store.pluginsDir)).filter(name => name.startsWith('.config')).sort()).toEqual(['.config-lock.sqlite', '.config.json']);
});

it('releases the lock and clears input when reading configuration fails', async () => {
  const path = join(store.pluginsDir, '.config.json');
  await writeFile(path, 'invalid json');
  const value = Buffer.from('private');
  await expect(store.setConfig('one', 'first', value)).rejects.toThrow();
  expect(value.every(byte => byte === 0)).toBe(true);
  await writeFile(path, '{}');
  await store.setConfig('two', 'second', Buffer.from('saved'));
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ two: { second: 'saved' } });
  expect((await readdir(store.pluginsDir)).filter(name => name.startsWith('.config')).sort()).toEqual(['.config-lock.sqlite', '.config.json']);
});


it('keeps four independent contenders mutually exclusive after the owner is killed', async () => {
  const owner = await writer('one', 'first'); owner.start();
  await vi.waitFor(() => expect(owner.messages.some(message => message.type === 'read')).toBe(true));
  const contenders = await Promise.all(['one', 'two'].flatMap(plugin => ['first', 'second'].map(key => writer(plugin, key))));
  for (const contender of contenders) contender.start();
  await vi.waitFor(() => expect(contenders.every(contender => contender.messages.some(message => message.type === 'attempt'))).toBe(true));
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(contenders.some(contender => contender.messages.some(message => message.type === 'read'))).toBe(false);
  owner.child.kill('SIGKILL'); await new Promise(resolve => owner.child.once('exit', resolve));
  const pending = [...contenders];
  while (pending.length) {
    await vi.waitFor(() => expect(pending.some(contender => contender.messages.some(message => message.type === 'read'))).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 100));
    const entered = pending.filter(contender => contender.messages.some(message => message.type === 'read'));
    expect(entered).toHaveLength(1);
    entered[0]!.release();
    expect(await entered[0]!.result()).toMatchObject({ ok: true });
    pending.splice(pending.indexOf(entered[0]!), 1);
  }
  expect(store.plainConfig('one')).toEqual({ first: 'first', second: 'second' });
  expect(store.plainConfig('two')).toEqual({ first: 'first', second: 'second' });
  expect((await readdir(store.pluginsDir)).filter(name => name.startsWith('.config')).sort()).toEqual(['.config-lock.sqlite', '.config.json']);
});

it('waits for another connection asynchronously and releases its transaction on completion', async () => {
  const lock = new Database(join(store.pluginsDir, '.config-lock.sqlite'), { timeout: 0 });
  lock.exec('BEGIN IMMEDIATE');
  const started = Date.now();
  const timer = setTimeout(() => lock.close(), 30);
  try {
    await store.setConfig('one', 'first', Buffer.from('saved'));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(store.plainConfig('one')).toEqual({ first: 'saved' });
    const next = new Database(join(store.pluginsDir, '.config-lock.sqlite'), { timeout: 0 });
    try { expect(() => next.exec('BEGIN IMMEDIATE')).not.toThrow(); }
    finally { next.close(); }
  } finally { clearTimeout(timer); if (lock.open) lock.close(); }
});

it('bounds contention without releasing a live owner and clears the waiting input', async () => {
  const lock = new Database(join(store.pluginsDir, '.config-lock.sqlite'), { timeout: 0 });
  lock.exec('BEGIN IMMEDIATE');
  const value = Buffer.from('private');
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(now).mockReturnValue(now + 10_001);
  try {
    await expect(store.setConfig('one', 'secret', value)).rejects.toMatchObject({ code: 'PLUGIN_CONFIG_BUSY' });
    expect(value.every(byte => byte === 0)).toBe(true);
    expect(lock.inTransaction).toBe(true);
    expect(store.plainConfig('one')).toEqual({});
  } finally { clock.mockRestore(); lock.close(); }
  await store.setConfig('one', 'first', Buffer.from('saved'));
  expect(store.plainConfig('one')).toEqual({ first: 'saved' });
});


it('clears sensitive input after saving and after rejecting an unsafe value source', async () => {
  const saved = Buffer.from('synthetic-secret');
  expect(await store.setConfig('one', 'secret', saved)).toEqual({ sensitive: true });
  expect(saved.every(byte => byte === 0)).toBe(true);
  expect(store.plainConfig('one')).toEqual({});
  const rejected = Buffer.from('synthetic-rejected');
  await expect(store.setConfig('one', 'secret', rejected, true)).rejects.toMatchObject({ code: 'PLUGIN_CONFIG_SENSITIVE' });
  expect(rejected.every(byte => byte === 0)).toBe(true);
});
