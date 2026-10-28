import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { it, expect } from 'vitest';

it('installs the public SDK tarball outside the workspace and compiles every provider author contract without private packages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-sdk-consumer-'));
  try {
    const sdk = resolve(import.meta.dirname, '../../../../packages/plugin-sdk');
    const pack = (source: string) => join(root, JSON.parse(execFileSync('npm', ['pack', source, '--ignore-scripts', '--json', '--pack-destination', root], { cwd: root, encoding: 'utf8' }))[0].filename);
    const sdkTar = pack(sdk);
    const tsTar = pack(dirname(await realpath(resolve(import.meta.dirname, '../../../../node_modules/typescript/package.json'))));
    await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', sdkTar, tsTar], { cwd: root, stdio: 'pipe' });
    await writeFile(join(root, 'index.ts'), `import { definePlugin, PLUGIN_API_VERSION, type PluginBindingContext, type PluginToolManuals } from '@dutydeck/plugin-sdk';
const manuals: PluginToolManuals = {read:{guide:{description:'Optional guide',path:'manuals/guide.md',maxBytes:1024}}};
void manuals;
const resource = (_input: unknown, binding: PluginBindingContext) => String(binding.config.project);
export default definePlugin(api => {
 api.registerQuery({ name:'read', description:'Read', version:'1', inputSchema:{type:'object',properties:{},additionalProperties:false}, resource, async execute(input, context) { return {binding:context.binding.bindingId}; } });
 api.registerAction({ name:'write', description:'Write', version:'1', inputSchema:{type:'object',properties:{},additionalProperties:false}, resource, async execute(input, context) { return {receipt:context.actionId}; }, async reconcile(context) { return {status:'succeeded',receipt:context.original.id}; } });
 api.registerCiProvider({ id:'ci', displayName:'CI', matchRepository:() => undefined });
 api.registerResultTool({ name:'export', description:'Export', inputSchema:{ parse(input: unknown) { return input; } }, async execute() { return {files:[]}; } });
 api.registerScenarioProvider({ id:'docs', async context({binding}) { return {items:[],missing:[String(binding?.revision)]}; } });
});
if (PLUGIN_API_VERSION !== 1) throw new Error('unsupported');\n`);
    execFileSync(process.execPath, ['node_modules/typescript/lib/tsc.js', 'index.ts', '--strict', '--module', 'NodeNext', '--target', 'ES2022', '--outDir', 'dist'], { cwd: root, stdio: 'pipe' });
    execFileSync(process.execPath, ['dist/index.js'], { cwd: root, stdio: 'pipe' });
    execFileSync(process.execPath, ['--conditions=development', 'dist/index.js'], { cwd: root, stdio: 'pipe' });
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', 'console.log(import.meta.resolve("@dutydeck/plugin-sdk"))'], { cwd: root, encoding: 'utf8' })).toContain(`${root}/node_modules/@dutydeck/plugin-sdk/dist/index.js`);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);

it('bundles an independently installed SDK into a detached plugin tarball and calls it through the real Host', async () => {
  const { build } = await import('esbuild');
  const { mkdir, readFile } = await import('node:fs/promises');
  const { PluginStore } = await import('./store.js');
  const { PluginHost } = await import('./host.js');
  const { PluginBusinessToolService } = await import('./tool-service.js');
  const { PluginToolGrants } = await import('./tool-grants.js');
  const { PluginToolLedger } = await import('./tool-ledger.js');
  const { createRepositories } = await import('@dutydeck/storage');
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-sdk-plugin-'));
  let host: InstanceType<typeof PluginHost> | undefined;
  let repos: ReturnType<typeof createRepositories> | undefined;
  try {
    const author = join(root, 'author'); await mkdir(join(author, '.dutydeck-plugin'), { recursive: true });
    const sdk = resolve(import.meta.dirname, '../../../../packages/plugin-sdk');
    const sdkTar = join(root, JSON.parse(execFileSync('npm', ['pack', sdk, '--ignore-scripts', '--json', '--pack-destination', root], { cwd: root, encoding: 'utf8' }))[0].filename);
    await writeFile(join(author, 'package.json'), JSON.stringify({ name: 'sdk-consumer-plugin', version: '1.0.0', type: 'module', files: ['dist', '.dutydeck-plugin', 'manuals'] }));
    execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', sdkTar], { cwd: author, stdio: 'pipe' });
    await writeFile(join(author, '.dutydeck-plugin/plugin.json'), JSON.stringify({ name: 'sdk-consumer', version: '1.0.0', apiVersion: 1, providers: 'dist/index.mjs', toolManuals: { read: { guide: { description: 'Optional packaged guide', path: 'manuals/guide.md', maxBytes: 1024 } } }, bindingConfig: { project: { type: 'string', description: 'Project', required: true } } }));
    await mkdir(join(author, 'manuals')); await writeFile(join(author, 'manuals/guide.md'), 'Detached optional guide');
    await writeFile(join(author, 'index.ts'), `import { definePlugin, PLUGIN_API_VERSION, type PluginBindingContext } from '@dutydeck/plugin-sdk';
export default definePlugin(api => {
 const base = {version:'1',description:'SDK tool',inputSchema:{type:'object' as const,properties:{},additionalProperties:false as const},resource:(_input:unknown,binding:PluginBindingContext)=>String(binding.config.project)};
 api.registerQuery({...base,name:'read',async execute(_input,context){return {api:PLUGIN_API_VERSION,project:String(context.binding.config.project),actor:context.identity.actor.id};}});
 api.registerAction({...base,name:'write',async execute(_input,context){return {receipt:context.actionId};}});
});\n`);
    const output = join(author, 'dist/index.mjs');
    const bundled = await build({ entryPoints: [join(author, 'index.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm', metafile: true });
    expect(Object.keys(bundled.metafile!.inputs).some(path => path.includes('author/node_modules/@dutydeck/plugin-sdk/'))).toBe(true);
    expect(await readFile(output, 'utf8')).not.toMatch(/from ["']@dutydeck\//);
    const tarball = join(root, JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: author, encoding: 'utf8' }))[0].filename);
    await rm(author, { recursive: true, force: true });
    const store = new PluginStore(join(root, 'data')); await store.install(`npm:${tarball}`, { yes: true });
    host = await PluginHost.load({ dataDir: store.dataDir }); expect(host.diagnostics).toEqual([]);
    const manifest = host.active.find(item => item.entry.name === 'sdk-consumer')!.plugin.manifest;
    const binding = host.bindings.save({ plugin: 'sdk-consumer', workspaceRoot: root, enabled: true, config: { project: 'project-A' }, secrets: {}, skills: [], expectedRevision: 0 }, manifest);
    repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    const actor = { kind: 'installation_owner' as const, id: 'installation_owner' as const }; const grants = new PluginToolGrants(repos.config);
    for (const tool of ['read', 'write']) await grants.set({ id: tool, toolId: `sdk-consumer/${tool}`, bindingId: binding.id, actor, effects: [tool === 'read' ? 'read' : 'write'], resources: ['project-A'], operations: ['invoke'] });
    const service = new PluginBusinessToolService(host, grants, new PluginToolLedger(repos.config), { resolve: async () => ({ identity: { sessionId: 's', taskId: 't', attemptId: 'a', runId: 'r', actor, channel: 'web', cwd: root, workspaceRoot: root }, assertCurrent: async () => {} }) });
    expect((await service.describe('sdk-consumer/read')).tool.manuals).toEqual([{ id: 'guide', description: 'Optional packaged guide', maxBytes: 1024 }]);
    expect(await service.manual('sdk-consumer/read', 'guide')).toMatchObject({ text: 'Detached optional guide', packageVersion: '1.0.0', truncated: false });
    expect(await service.call('sdk-consumer/read', {}, 'query')).toEqual({ output: { api: 1, project: 'project-A', actor: 'installation_owner' } });
    expect(await service.call('sdk-consumer/write', {}, 'action')).toMatchObject({ status: 'succeeded', receipt: expect.stringMatching(/^pt_/) });
    await grants.revoke('read');
    await expect(service.manual('sdk-consumer/read', 'guide')).rejects.toMatchObject({ code: 'PLUGIN_TOOL_FORBIDDEN' });
    await grants.set({ id: 'read', toolId: 'sdk-consumer/read', bindingId: binding.id, actor, effects: ['read'], resources: ['project-A'], operations: ['invoke'] });
    await store.setEnabled('sdk-consumer', false);
    await expect(service.manual('sdk-consumer/read', 'guide')).rejects.toMatchObject({ code: 'PLUGIN_DISABLED' });
  } finally { repos?.close(); await host?.dispose(); await rm(root, { recursive: true, force: true }); }
}, 60_000);
