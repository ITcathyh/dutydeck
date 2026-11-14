import { execFile, execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { missingRelativeImports } from '../apps/server/src/daemon/import-closure.mjs';

const execFileAsync = promisify(execFile);

/** Run after build:packages: no repository source or development export conditions in this probe. */
it('runs structured content through packed ACP/shared modules outside the checkout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-content-pack-'));
  const checkout = process.cwd();
  try {
    // dist comes from build:packages; skipping prepack avoids rebuilding the shared checkout's dist mid-run,
    // so refuse to pack a dist older than its sources instead of silently probing stale output.
    await Promise.all([['shared', '0.1.0'], ['acp-client', '0.1.0'], ['plugin-sdk', '1.0.0']].map(async ([name, version]) => {
      const newest = async (path: string) => Math.max(...await Promise.all((await readdir(path, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile() && !entry.name.includes('.test.')).map(async entry => (await stat(join(entry.parentPath, entry.name))).mtimeMs)));
      expect(await newest(resolve(checkout, 'packages', name!, 'dist')), `packages/${name}/dist is older than src; run pnpm build:packages`).toBeGreaterThanOrEqual(await newest(resolve(checkout, 'packages', name!, 'src')));
      await execFileAsync('pnpm', ['--config.ignore-scripts=true', '--filter', `@dutydeck/${name}`, 'pack', '--pack-destination', directory], { cwd: checkout });
      const target = join(directory, 'node_modules', '@dutydeck', name!);
      await mkdir(target, { recursive: true });
      await execFileAsync('tar', ['xzf', join(directory, `dutydeck-${name}-${version}.tgz`), '-C', target, '--strip-components=1']);
    }));
    for (const [name, target] of [['acpx', 'packages/acp-client/node_modules/acpx'], ['zod', 'packages/shared/node_modules/zod'], ['safe-regex2', 'packages/shared/node_modules/safe-regex2']]) await symlink(resolve(checkout, target!), join(directory, 'node_modules', name!), 'dir');
    await cp(resolve(checkout, 'tests/fixtures/mock-acp-agent.mjs'), join(directory, 'agent.mjs'));
    await writeFile(join(directory, 'probe.mjs'), `
import assert from 'node:assert/strict';
import { AcpxAdapter } from '@dutydeck/acp-client';
import { eventContentLimits, extractEventArtifactReferences } from '@dutydeck/shared';
const config = { id:'pack-fixture',name:'Pack fixture',command:process.execPath,args:[new URL('./agent.mjs',import.meta.url).pathname],protocol:'acp',cwd:process.cwd(),env:{},permissionMode:'deny-all',timeout:10,capabilities:{pause:false,resume:true},builtin:false };
const turns=[];
for(let run=0;run<2;run++) {
 const events=[]; const adapter=new AcpxAdapter(config,{sessionKey:'packed-persistent-key',onEvent:event=>events.push(event)});
 try { await adapter.start(); await adapter.send('structured content fixture'); } finally { await adapter.stop(); }
 turns.push(events.filter(event=>event.type==='text'||event.type==='tool_result').map(event=>event.data.parts));
}
assert.deepEqual(turns[0],turns[1]);
assert.deepEqual(turns[0].slice(1).map(parts=>parts[0].type),['image','resource','resource_link']);
assert.equal(eventContentLimits.parts,64);
assert.equal(extractEventArtifactReferences({id:'e',taskId:'t',attemptId:'a',sequence:1,type:'text',data:{parts:turns[0][1]}})[0].source,'assistant_attachment');
console.log('PACKED_CONTENT_OK');
`);
    const output = execFileSync(process.execPath, ['probe.mjs'], { cwd: directory, env: { PATH: process.env.PATH, HOME: directory }, encoding: 'utf8' });
    expect(output.trim()).toBe('PACKED_CONTENT_OK');
    const saved = await readFile(join(directory, 'node_modules', '@dutydeck', 'shared', 'dist', 'event-content.js'), 'utf8');
    expect(saved).toContain('normalizeEventContent');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('packs every deferred chunk and resource without acpx or drizzle as production dependencies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-startup-pack-'));
  const server = resolve(process.cwd(), 'apps/server');
  try {
    const { stdout } = await execFileAsync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: server });
    const [packed] = JSON.parse(stdout) as Array<{ filename: string }>;
    await execFileAsync('tar', ['xzf', join(directory, packed!.filename), '-C', directory]);
    const pkg = join(directory, 'package');
    const metadata = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8')) as { version: string; dependencies: Record<string, string> };
    expect(metadata.dependencies).not.toHaveProperty('acpx');
    expect(metadata.dependencies).not.toHaveProperty('drizzle-orm');
    for (const name of ['acpx', 'drizzle-orm']) expect(await stat(join(pkg, 'node_modules', name)).catch(() => undefined)).toBeUndefined();

    const cli = join(pkg, 'dist/cli.js');
    expect(missingRelativeImports(cli)).toEqual([]);
    const source = await readFile(cli, 'utf8');
    const deferred = /\bimport\s*\(\s*['"](\.\/chunk-[^'"]+)['"]\s*\)/.exec(source)?.[1];
    expect(deferred).toBeDefined();
    const deferredPath = resolve(dirname(cli), deferred!);
    await rename(deferredPath, `${deferredPath}.missing`);
    try { expect(missingRelativeImports(cli).join('\n')).toContain(deferredPath); }
    finally { await rename(`${deferredPath}.missing`, deferredPath); }

    const shipped = (await readdir(join(pkg, 'dist'), { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isFile() && /\.(?:js|mjs)$/.test(entry.name));
    const sources = new Map<string, string>();
    for (const entry of shipped) {
      const path = join(entry.parentPath, entry.name);
      const code = await readFile(path, 'utf8');
      sources.set(path, code);
      expect(code, entry.name).not.toMatch(/\b(?:import\s*\(\s*|require\s*\(\s*)['"](?:acpx(?:\/|$)|drizzle-orm(?:\/|$))/);
    }
    for (const resource of [
      'dist/assets/session-insight/cli.js',
      'dist/assets/dutydeck-bouncing-ball.webp',
      'dist/agents/env-launcher.mjs',
      'dist/agents/launcher-process.mjs',
      'public/index.html'
    ]) expect((await readFile(join(pkg, resource))).byteLength, resource).toBeGreaterThan(0);
    expect((await readdir(join(pkg, 'dist/builtin-plugins'))).length).toBeGreaterThan(0);

    for (const dependency of Object.keys(metadata.dependencies)) {
      const target = join(pkg, 'node_modules', dependency);
      await mkdir(dirname(target), { recursive: true });
      await symlink(await realpath(join(server, 'node_modules', dependency)), target, 'dir');
    }
    const env = { PATH: process.env.PATH, HOME: directory };
    const version = await execFileAsync(process.execPath, [cli, '--version'], { cwd: directory, env });
    expect(version.stdout.trim()).toBe(metadata.version);

    const acpChunk = [...sources].find(([path, code]) => path.includes('chunk-') && code.includes('var AcpxAdapter = class'))?.[0];
    const storageChunk = [...sources].find(([path, code]) => path.includes('chunk-') && code.includes('function createRepositories(filename'))?.[0];
    const builtinChunk = [...sources].find(([path, code]) => path.includes('chunk-') && code.includes('function defaultBuiltinPluginRoot()'))?.[0];
    const insightEngineChunk = [...sources].find(([path, code]) => path.includes('chunk-') && code.includes('async function resolveSessionInsightEngine(options = {})'))?.[0];
    const bouncingChunk = [...sources].find(([, code]) => code.includes('new URL("./assets/dutydeck-bouncing-ball.webp", import.meta.url)'))?.[0];
    expect(acpChunk).toBeDefined();
    expect(storageChunk).toBeDefined();
    expect(builtinChunk).toBeDefined();
    expect(insightEngineChunk).toBeDefined();
    expect(bouncingChunk).toBeDefined();
    expect((await readFile(resolve(dirname(bouncingChunk!), 'assets/dutydeck-bouncing-ball.webp'))).byteLength).toBeGreaterThan(0);
    const insightEntry = resolve(dirname(insightEngineChunk!), 'assets/session-insight/cli.js');
    const insight = await execFileAsync(process.execPath, [insightEntry, 'version', '--json'], { cwd: directory, env });
    expect(JSON.parse(insight.stdout)).toMatchObject({ schemaVersion: 1, engineVersion: 'dutydeck-ts-v1' });
    const builtinRoot = resolve(dirname(builtinChunk!), 'builtin-plugins');
    await cp(resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs'), join(directory, 'agent.mjs'));
    await writeFile(join(directory, 'probe-startup.mjs'), `
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { AcpxAdapter, listAcpxBuiltinAgents, prepareAcpxAgentLaunch } from ${JSON.stringify(pathToFileURL(acpChunk!).href)};
import { createRepositories } from ${JSON.stringify(pathToFileURL(storageChunk!).href)};
import { listBuiltinPlugins } from ${JSON.stringify(pathToFileURL(builtinChunk!).href)};
const config = { id:'pack-startup',name:'Pack startup',command:process.execPath,args:[new URL('./agent.mjs',import.meta.url).pathname],protocol:'acp',cwd:process.cwd(),env:{},permissionMode:'deny-all',timeout:10,capabilities:{pause:false,resume:true},builtin:false };
assert.ok(listBuiltinPlugins(${JSON.stringify(builtinRoot)}).length > 0);
for (const agent of listAcpxBuiltinAgents()) for (const arg of agent.argv) if (arg.endsWith('.mjs')) assert.ok(existsSync(arg),arg);
const launch = prepareAcpxAgentLaunch(config,{runtimeDirectory:new URL('./runtime-env',import.meta.url).pathname,sessionKey:'resource-probe',forceLauncher:true});
assert.ok(existsSync(launch.command[1]),launch.command[1]);
launch.cleanup();
const turns=[];
for(let run=0;run<2;run++) {
 const events=[]; const adapter=new AcpxAdapter(config,{sessionKey:'packed-startup-persistent',onEvent:event=>events.push(event)});
 try { await adapter.start(); await adapter.send('structured content fixture'); } finally { await adapter.stop(); }
 turns.push(events.filter(event=>event.type==='text'||event.type==='tool_result').map(event=>event.data.parts));
}
assert.deepEqual(turns[0],turns[1]);
assert.deepEqual(turns[0].slice(1).map(parts=>parts[0].type),['image','resource','resource_link']);
const database = new URL('./migration.db', import.meta.url).pathname;
const first = createRepositories(database);
await first.config.set('startup-probe','persisted');
first.close();
const reopened = createRepositories(database);
assert.equal(await reopened.config.get('startup-probe'),'persisted');
reopened.close();
console.log('PACKED_STARTUP_PROBE_OK');
`);
    const probe = execFileSync(process.execPath, ['probe-startup.mjs'], { cwd: directory, env, encoding: 'utf8' });
    expect(probe.trim()).toBe('PACKED_STARTUP_PROBE_OK');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
