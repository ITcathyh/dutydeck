import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pluginManifestSchema, resolvePluginConfig } from '@dutydeck/shared';
import { PluginBindings } from './bindings.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-bindings-')); directories.push(root);
  const secrets = new Map([['plugin.tickets.a', 'A'], ['plugin.tickets.b', 'B']]);
  const bindings = new PluginBindings(root, ref => secrets.get(ref));
  const manifest = pluginManifestSchema.parse({ name: 'tickets', apiVersion: 1, bindingConfig: {
    project: { type: 'string', description: 'Project', required: true }, limit: { type: 'integer', description: 'Limit', default: 10, min: 1, max: 20 },
    token: { type: 'secret', description: 'Credential', required: true }
  } });
  const save = (chatId: string, project: string, token: string) => bindings.save({ plugin: 'tickets', botAppId: 'bot', chatId, enabled: true, config: { project }, secrets: { token }, skills: [], expectedRevision: 0 }, manifest);
  return { root, bindings, manifest, save, secrets };
}

describe('package bindings', () => {
  it('isolates two group configurations and secret accessors, with immutable snapshots', async () => {
    const f = await fixture(); f.save('a', 'one', 'plugin.tickets.a'); f.save('b', 'two', 'plugin.tickets.b');
    const a = f.bindings.resolve('tickets', { botAppId: 'bot', chatId: 'a' }, f.manifest)!;
    const b = f.bindings.resolve('tickets', { botAppId: 'bot', chatId: 'b' }, f.manifest)!;
    expect(await Promise.all([a.getSecret('token'), b.getSecret('token')])).toEqual(['A', 'B']);
    expect(a.config).toEqual({ project: 'one', limit: 10 }); expect(b.config.project).toBe('two');
    expect(() => { (a.config as any).project = 'other'; }).toThrow();
    expect(JSON.stringify(a)).not.toContain('plugin.tickets.a');
    await expect(a.getSecret('undeclared')).rejects.toMatchObject({ code: 'PLUGIN_SECRET_UNDECLARED' });
  });
  it('preserves group disable over Bot fallback and rejects stale secret access', async () => {
    const f = await fixture(); const initial = f.save('a', 'one', 'plugin.tickets.a');
    const old = f.bindings.resolve('tickets', { botAppId: 'bot', chatId: 'a' }, f.manifest)!;
    const { id, revision, ...input } = initial;
    f.bindings.save({ ...input, enabled: false, expectedRevision: revision }, f.manifest);
    expect(() => f.bindings.resolve('tickets', { botAppId: 'bot', chatId: 'a' }, f.manifest)).toThrow('disabled');
    await expect(old.getSecret('token')).rejects.toMatchObject({ code: 'PLUGIN_BINDING_STALE' });
    expect(() => f.bindings.save({ ...input, expectedRevision: revision }, f.manifest)).toThrow('changed');
  });
  it('uses canonical exact workspace targets without a Bot-to-workspace fallback', async () => {
    const f = await fixture(); const project = join(f.root, 'project'); await mkdir(project);
    const binding = f.bindings.save({ plugin: 'tickets', workspaceRoot: `${project}/.`, enabled: true, config: { project: 'web' }, secrets: { token: 'plugin.tickets.a' }, skills: [], expectedRevision: 0 }, f.manifest);
    expect(f.bindings.resolve('tickets', { cwd: project }, f.manifest)?.bindingId).toBe(binding.id);
    expect(f.bindings.resolve('tickets', { botAppId: 'unknown', cwd: project }, f.manifest)).toBeUndefined();
    expect(f.bindings.resolve('tickets', { cwd: f.root }, f.manifest)).toBeUndefined();
  });
  it('rejects unsupported APIs, malformed defaults and explicit null rather than substituting defaults', async () => {
    const f = await fixture();
    expect(() => resolvePluginConfig(f.manifest.bindingConfig!, { project: 'x', limit: null }, { token: 'plugin.tickets.a' })).toThrow('Invalid configuration limit');
    expect(pluginManifestSchema.safeParse({ name: 'bad', bindingConfig: { count: { type: 'integer', description: 'Count', enum: ['one'] } } }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ name: 'bad', bindingConfig: { text: { type: 'string', description: 'Text', min: -1 } } }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ name: 'bad', apiVersion: 2 }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ name: 'bad', bindingConfig: { count: { type: 'integer', description: 'Count', default: 'one' } } }).success).toBe(false);
    expect(() => f.bindings.save({ plugin: 'tickets', botAppId: 'bot', enabled: true, config: { project: 'x', token: 'plaintext' }, secrets: {}, skills: [], expectedRevision: 0 }, f.manifest)).toThrow();
  });
});

it('releases its cross-process write lock after a real SIGKILL', async () => {
  const { spawn } = await import('node:child_process'); const { createRequire } = await import('node:module');
  const f=await fixture();f.save('a','one','plugin.tickets.a');
  const sqlite=createRequire(import.meta.url).resolve('better-sqlite3');
  const child=spawn(process.execPath,['--input-type=module','-e',`import Database from ${JSON.stringify(sqlite)}; const db=new Database(${JSON.stringify(join(f.root,'plugins/.binding-lock.sqlite'))});db.exec('BEGIN IMMEDIATE');process.send('locked');setInterval(()=>{},1000);`],{stdio:['ignore','ignore','pipe','ipc']});
  try {
    await new Promise<void>((resolve,reject)=>{child.once('message',()=>resolve());child.once('error',reject);child.once('exit',()=>reject(new Error('lock process exited before ready')));});
    expect(()=>f.save('b','two','plugin.tickets.b')).toThrow('Another binding update');
    const closed=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await closed;
    expect(f.save('b','two','plugin.tickets.b').revision).toBe(1);
    expect(f.bindings.list()).toHaveLength(2);
  } finally {if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
});

it('can revoke an existing binding after credentials disappear, without editing config or creating a target', async()=>{
  const f=await fixture();const saved=f.save('a','one','plugin.tickets.a');f.secrets.clear();const {id,revision,...input}=saved;
  expect(()=>f.bindings.save({...input,enabled:false,config:{project:'changed'},expectedRevision:revision})).toThrow('unchanged');
  expect(()=>f.bindings.save({...input,chatId:'new',enabled:false,expectedRevision:0})).toThrow('existing exact target');
  expect(f.bindings.save({...input,enabled:false,expectedRevision:revision})).toMatchObject({enabled:false,revision:2});
});
