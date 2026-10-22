import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writePlugin } from './scenario-fixtures.test-helpers.js';
import { PluginStore } from './store.js';

let directory: string;
let store: PluginStore;
const children: ChildProcess[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dutydeck-token-concurrency-'));
  store = new PluginStore(join(directory, 'data'));
  const source = join(directory, 'source');
  await writePlugin(source, {
    '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'tokens' }),
    ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`triggers/t${i}.json`, JSON.stringify({ auth: { type: 'token' }, target: { botAppId: 'cli_a', chatId: 'oc_b' }, prompt: '{{payload.text}}' })]))
  });
  await store.install(source);
});
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL'); await exited;
  }
  await rm(directory, { recursive: true, force: true });
});

async function writer(operation: string, trigger: string, hold = false) {
  const messages: Array<{ type: string; ok?: boolean; code?: string; token?: string; created?: boolean }> = [];
  const child = fork(new URL('./token-writer.test-helper.mjs', import.meta.url), [store.dataDir, operation, 'tokens', trigger, ...(hold ? ['hold'] : [])], {
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

it('preserves every acknowledged token from concurrent calls in one process', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => store.ensureTriggerToken('tokens', `t${i}`)));
  for (const [i, result] of results.entries()) expect(store.triggerToken('tokens', `t${i}`)).toBe(result.token);
  expect((await stat(join(store.pluginsDir, '.trigger-tokens.json'))).mode & 0o777).toBe(0o600);
  expect((await readdir(store.pluginsDir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

it.each(['create', 'rotate'])('preserves every acknowledged %s from independent unmodified processes', async operation => {
  const previous = operation === 'rotate' ? await Promise.all(Array.from({ length: 8 }, (_, i) => store.ensureTriggerToken('tokens', `t${i}`))) : [];
  const workers = await Promise.all(Array.from({ length: 8 }, (_, i) => writer(operation === 'create' ? 'ensure' : operation, `t${i}`)));
  for (const worker of workers) worker.start();
  const results = await Promise.all(workers.map(worker => worker.result()));
  for (const [i, result] of results.entries()) {
    expect(result).toMatchObject({ ok: true, created: true });
    expect(store.triggerToken('tokens', `t${i}`)).toBe(result.token);
    if (operation === 'rotate') expect(result.token).not.toBe(previous[i]!.token);
  }
});

it('creates one stable token for independent callers of the same trigger', async () => {
  const workers = await Promise.all(Array.from({ length: 4 }, () => writer('ensure', 't0')));
  for (const worker of workers) worker.start();
  const results = await Promise.all(workers.map(worker => worker.result()));
  expect(results.every(result => result.ok)).toBe(true);
  expect(results.filter(result => result.created)).toHaveLength(1);
  expect(new Set(results.map(result => result.token))).toEqual(new Set([store.triggerToken('tokens', 't0')]));
});

it('rechecks installation after waiting for uninstall and does not recreate removed tokens', async () => {
  await store.ensureTriggerToken('tokens', 't0');
  const uninstall = await writer('uninstall', '', true), token = await writer('rotate', 't0');
  uninstall.start(); await uninstall.wait('locked');
  token.start(); await token.wait('attempt');
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(token.seen('result')).toBe(false);
  uninstall.release();
  expect(await uninstall.result()).toMatchObject({ ok: true });
  expect(await token.result()).toMatchObject({ ok: false, code: 'PLUGIN_NOT_INSTALLED' });
  expect(store.triggerToken('tokens', 't0')).toBeUndefined();
});

it('releases a killed token owner and preserves the next successful write', async () => {
  const owner = await writer('ensure', 't0', true);
  owner.start(); await owner.wait('locked');
  const exited = new Promise(resolve => owner.child.once('exit', resolve));
  owner.child.kill('SIGKILL'); await exited;
  const next = await writer('ensure', 't1'); next.start();
  const result = await next.result();
  expect(result).toMatchObject({ ok: true, created: true });
  expect(store.triggerToken('tokens', 't1')).toBe(result.token);
  expect(await readdir(store.pluginsDir)).toContain('.config-lock.sqlite');
});

it('serializes two rotations of the same trigger in acquisition order', async () => {
  const original = await store.ensureTriggerToken('tokens', 't0');
  const first = await writer('rotate', 't0', true), second = await writer('rotate', 't0');
  first.start(); await first.wait('locked');
  second.start(); await second.wait('attempt');
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(second.seen('result')).toBe(false);
  first.release();
  const a = await first.result(), b = await second.result();
  expect(a).toMatchObject({ ok: true, created: true });
  expect(b).toMatchObject({ ok: true, created: true });
  expect(new Set([original.token, a.token, b.token]).size).toBe(3);
  expect(store.triggerToken('tokens', 't0')).toBe(b.token);
});

it('releases the lock after malformed token data is rejected', async () => {
  const path = join(store.pluginsDir, '.trigger-tokens.json');
  await writeFile(path, 'invalid json');
  await expect(store.ensureTriggerToken('tokens', 't0')).rejects.toThrow();
  await writeFile(path, '{}');
  const result = await store.ensureTriggerToken('tokens', 't0');
  expect(store.triggerToken('tokens', 't0')).toBe(result.token);
  expect((await readdir(store.pluginsDir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
});
