import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { it, expect } from 'vitest';
import { buildApp } from '../app.js';
import { PluginStore } from './store.js';
import { PluginHost } from './host.js';

it('sends the real Web API save/explain JSON over HTTP through Fastify parsing and returns validation feedback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-binding-http-'));
  const fetcher = globalThis.fetch;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const source = join(root,'package'); await mkdir(join(source,'.dutydeck-plugin'),{recursive:true});
    await writeFile(join(source,'.dutydeck-plugin/plugin.json'),JSON.stringify({name:'sample',apiVersion:1,bindingConfig:{count:{type:'integer',required:true,description:'Count'}}}));
    const store=new PluginStore(join(root,'data'));await store.install(source);
    const host=await PluginHost.load({dataDir:store.dataDir});
    app=await buildApp({} as any,{pluginBindings:{host,authorize:async()=>true}});
    let address=await app.listen({host:'127.0.0.1',port:0});
    const clientPath=join(root,'client.mjs');
    await build({entryPoints:[resolve(import.meta.dirname,'../../../../apps/web/src/api.ts')],outfile:clientPath,bundle:true,format:'esm',platform:'browser'});
    const {pluginBindingsApi}=await import(pathToFileURL(clientPath).href);
    // Only supply the browser's URL origin; native fetch sends the actual headers/body over HTTP.
    globalThis.fetch=(input,init)=>fetcher(new URL(String(input),address),init);
    expect(await pluginBindingsApi.save({plugin:'sample',botAppId:'bot',enabled:true,config:{count:2},secrets:{},skills:[],expectedRevision:0})).toMatchObject({binding:{revision:1,config:{count:2}}});
    expect(await pluginBindingsApi.explain({plugin:'sample',botAppId:'bot'})).toMatchObject({binding:{revision:1,config:{count:2}}});
    await expect(pluginBindingsApi.save({plugin:'sample',botAppId:'bot',enabled:true,config:{count:'bad'},secrets:{},skills:[],expectedRevision:1})).rejects.toMatchObject({code:'PLUGIN_BINDING_INVALID',status:400});
    await app.close();
    await writeFile(join(store.pluginDir('sample'),'broken.mjs'),'throw new Error("provider broken");');
    await writeFile(join(store.pluginDir('sample'),'.dutydeck-plugin/plugin.json'),JSON.stringify({name:'sample',providers:'broken.mjs',bindingConfig:{count:{type:'integer',required:true,description:'Count'}}}));
    const failed=await PluginHost.load({dataDir:store.dataDir});expect(failed.active.some(item=>item.entry.name==='sample')).toBe(false);
    app=await buildApp({} as any,{pluginBindings:{host:failed,authorize:async()=>true}});address=await app.listen({host:'127.0.0.1',port:0});
    await expect(failed.requiredSkillRequests({botAppId:'bot'})).rejects.toMatchObject({code:'PLUGIN_BINDING_UNAVAILABLE'});
    expect(await pluginBindingsApi.save({plugin:'sample',botAppId:'bot',enabled:false,config:{count:2},secrets:{},skills:[],expectedRevision:1})).toMatchObject({binding:{enabled:false,revision:2}});
    expect(await failed.requiredSkillRequests({botAppId:'bot'})).toEqual([]);

  } finally {globalThis.fetch=fetcher;await app?.close();await rm(root,{recursive:true,force:true});}
});

it('edits workspace aliases through real HTTP without resolving the server path in the CLI process', async () => {
  const { symlink } = await import('node:fs/promises');
  const { execFile } = await import('node:child_process');
  const { createRequire } = await import('node:module');
  const { promisify } = await import('node:util');
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-binding-alias-'));
  let host: PluginHost | undefined; let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const source = join(root, 'package'); await mkdir(join(source, '.dutydeck-plugin'), { recursive: true });
    await writeFile(join(source, '.dutydeck-plugin/plugin.json'), JSON.stringify({ name: 'sample', apiVersion: 1, bindingConfig: { count: { type: 'integer', description: 'Count', required: true }, token: { type: 'secret', description: 'Credential', required: true } } }));
    const project = join(root, 'project'); const alias = join(root, 'project-link'); await mkdir(project); await symlink(project, alias);
    const store = new PluginStore(join(root, 'data')); await store.install(source, { scope: `workspace:${project}` });
    store.secretProvider(true)!.writeExclusive('plugin.sample.one', Buffer.from('synthetic-secret'));
    host = await PluginHost.load({ dataDir: store.dataDir });
    app = await buildApp({} as any, { pluginBindings: { host, authorize: async request => request.headers.authorization === 'Bearer owner' } });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const script = join(root, 'client.mjs');
    await writeFile(script, `import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {runSettingsCli} from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../settings-cli.ts')).href)};
const [url,project,alias] = process.argv.slice(2);
// Only the server process may canonicalize these paths, as with another runtime's filesystem.
for (const [object,key] of [[fs,'realpathSync'],[fsp,'realpath']]) { const original=object[key]; object[key]=function(path,...args){if(String(path).startsWith(project)||String(path).startsWith(alias)) throw new Error('CLIENT_WORKSPACE_FS_FORBIDDEN'); return original.call(this,path,...args);}; }
syncBuiltinESMExports();
const run=(workspaceRoot,pairs,expectedRevision)=>runSettingsCli('plugin-binding-set',{url,database:'/remote/runtime.db',pluginName:'sample',workspaceRoot,pairs,expectedRevision},{readState:()=>({ready:false}),readToken:()=> 'owner'});
const first=await run(project,['config={"count":3}','secrets={"token":"plugin.sample.one"}']);
const edited=await run(project+'/.',['config={"count":4}']);
const disabled=await run(alias,['enabled=false']);
let stale;try{await run(alias+'/.',['enabled=true'],'1');}catch(error){stale=error.code;}
const enabled=await run(alias+'/.',['enabled=true']);
console.log(JSON.stringify({first,edited,disabled,enabled,stale}));`);
    const result = await promisify(execFile)(process.execPath, ['--conditions=development', '--import', createRequire(import.meta.url).resolve('tsx'), script, address, project, alias], { cwd: root });
    const output = JSON.parse(result.stdout);
    expect(output.first.binding).toMatchObject({ revision: 1, workspaceRoot: project });
    expect(output.edited.binding).toMatchObject({ revision: 2, config: { count: 4 }, secrets: { token: 'plugin.sample.one' } });
    expect(output.disabled.binding).toMatchObject({ revision: 3, enabled: false, config: { count: 4 }, secrets: { token: 'plugin.sample.one' } });
    expect(output.stale).toBe('PLUGIN_BINDING_CONFLICT');
    expect(output.enabled.binding).toMatchObject({ revision: 4, enabled: true, workspaceRoot: project, config: { count: 4 }, secrets: { token: 'plugin.sample.one' } });
    expect(host.bindings.list()).toHaveLength(1);
  } finally { await app?.close(); await host?.dispose(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
