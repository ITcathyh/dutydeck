import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { Session } from '@dutydeck/shared';
import { PluginHost } from './host.js';
import { PluginStore } from './store.js';
import { loadDaemonPlugins } from './service-wiring.js';
import { PluginRuntimeHooks } from './integration.js';
import { prepareBoundTaskPrompt } from './bound-skills.js';
import { discoverSkills, setPluginSkillRoots } from '../skill-catalog.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function fixture(hook = false, required = true, workspace = false) {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-bound-skills-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  for (const part of ['.dutydeck-plugin', 'skills/answer', 'references']) await mkdir(join(source, part), { recursive: true });
  await writeFile(join(source, '.dutydeck-plugin/plugin.json'), JSON.stringify({ name: 'sample', skills: 'skills', ...(required ? { requiredSkills: ['sample/answer'] } : {}), skillResources: { answer: [{ path: 'references/policy.md', maxBytes: 1024 }] }, ...(hook ? { providers: 'index.mjs' } : {}) }));
  await writeFile(join(source, 'skills/answer/SKILL.md'), '---\nname: answer\ndescription: >-\n  Answer only\n  from evidence.\n---\nRequired SOP: cite sources.');
  await writeFile(join(source, 'references/policy.md'), 'REFERENCE-V1');
  if (hook) await writeFile(join(source, 'index.mjs'), 'export default api => api.registerHookHandler("task.beforeRun", () => ({ updatedPrompt: "replacement" }));');
  const store = new PluginStore(join(root, 'data')); await store.install(source, { yes: true, scope: workspace ? `workspace:${root}` : 'bot:bot' });
  const host = await PluginHost.load({ dataDir: store.dataDir, builtinRoot: join(root, 'none') });
  cleanup.push(setPluginSkillRoots(scope => host.skillEntries(scope)));
  for (const chatId of ['a', 'b']) host.bindings.save({ plugin: 'sample', botAppId: 'bot', chatId, enabled: true, config: {}, secrets: {}, skills: [], expectedRevision: 0 }, host.active[0]!.plugin.manifest);
  const hooks = new PluginRuntimeHooks(host.hooks);
  const session = (chatId: string, source = 'lark') => ({ id: `session-${chatId}`, cwd: root, source, sourceId: `bot:${chatId}`, permissionMode: source === 'lark' ? 'ask' : 'deny-all' } as Session);
  return { root, store, host, hooks, session };
}

it('resolves package IDs and multiline YAML, inlines the same SOP for explicit and deny-all tasks, and freezes resources', async () => {
  const f = await fixture();
  const catalog = await discoverSkills(f.root, { botAppId: 'bot', homeDirectory: f.root });
  expect(catalog[0]).toMatchObject({ ref: 'sample/answer', description: 'Answer only from evidence.' });
  expect(await discoverSkills(f.root, { botAppId: 'other', homeDirectory: f.root })).toEqual([]);
  const [explicit, automatic] = await Promise.all([
    prepareBoundTaskPrompt(f.host, f.hooks, f.session('a'), 'question', undefined, { homeDirectory: f.root }),
    prepareBoundTaskPrompt(f.host, f.hooks, f.session('b', 'lark-response'), 'reply', undefined, { homeDirectory: f.root })
  ]);
  for (const result of [explicit, automatic]) {
    expect(result.agentPrompt).toContain('Required SOP: cite sources.'); expect(result.agentPrompt).toContain('REFERENCE-V1');
    expect(result.skillDeliveries[0]).toMatchObject({ ref: 'sample/answer', status: 'included', required: true, resources: [{ path: 'references/policy.md', digest: expect.any(String) }] });
  }
  expect(explicit.skillDeliveries[0]!.binding!.id).not.toBe(automatic.skillDeliveries[0]!.binding!.id);
  await writeFile(join(f.store.pluginDir('sample'), 'references/policy.md'), 'REFERENCE-V2');
  expect(explicit.agentPrompt).not.toContain('REFERENCE-V2');
});
it('marks legacy hook replacement and rejects removal of a bound required SOP', async () => {
  const f = await fixture(true, false);
  const legacy = await prepareBoundTaskPrompt(f.host, f.hooks, f.session('a'), 'question', ['sample/answer'], { homeDirectory: f.root });
  expect(legacy.agentPrompt).toBe('replacement'); expect(legacy.skillDeliveries[0]?.status).toBe('replaced');
  const binding = f.host.bindings.list()[0]!; const { id, revision, ...values } = binding;
  f.host.bindings.save({ ...values, skills: ['sample/answer'], expectedRevision: revision }, f.host.active[0]!.plugin.manifest);
  await expect(prepareBoundTaskPrompt(f.host, f.hooks, f.session('a'), 'question', undefined, { homeDirectory: f.root })).rejects.toMatchObject({ code: 'REQUIRED_SKILL_REPLACED' });
  const background = await prepareBoundTaskPrompt(f.host, f.hooks, f.session('a', 'lark-response'), 'question', undefined, { homeDirectory: f.root });
  expect(background.agentPrompt).toContain('Required SOP:');
});
it('rejects reference text escaping the installed package', async () => {
  const f = await fixture();
  const outside = join(f.root, 'outside.md'); await writeFile(outside, 'SECRET');
  const target = join(f.store.pluginDir('sample'), 'references/policy.md'); await rm(target); await symlink(outside, target);
  await expect(prepareBoundTaskPrompt(f.host, f.hooks, f.session('a'), 'question', undefined, { homeDirectory: f.root })).rejects.toMatchObject({ code: 'SKILL_RESOURCE_INVALID' });
});

it('keeps workspace bindings and scoped skills available from a managed worktree, and honors current disable', async () => {
  const f = await fixture(false, true, true); const managed = await mkdtemp(join(tmpdir(), 'dutydeck-managed-')); cleanup.push(()=>rm(managed,{recursive:true,force:true}));
  f.host.bindings.save({ plugin:'sample',workspaceRoot:f.root,enabled:true,config:{},secrets:{},skills:[],expectedRevision:0 },f.host.active[0]!.plugin.manifest);
  for (const session of [{id:'web',cwd:f.root}, {id:'managed',cwd:managed,workspaceSourceCwd:f.root}]) {
    const result = await prepareBoundTaskPrompt(f.host,f.hooks,session as Session,'question',undefined,{homeDirectory:f.root});
    expect(result.agentPrompt).toContain('Required SOP:'); expect(result.skillDeliveries[0]?.binding?.revision).toBe(1);
  }
  await f.store.setEnabled('sample',false);
  await expect(prepareBoundTaskPrompt(f.host,f.hooks,{id:'web',cwd:f.root} as Session,'question',['sample/answer'],{homeDirectory:f.root})).rejects.toMatchObject({code:'PLUGIN_DISABLED'});
});
it('does not let an explicit skill reference bypass a disabled group binding', async () => {
  const f=await fixture(); const old=f.host.bindings.list()[0]!;const {id,revision,...values}=old;
  f.host.bindings.save({...values,enabled:false,expectedRevision:revision},f.host.active[0]!.plugin.manifest);
  await expect(prepareBoundTaskPrompt(f.host,f.hooks,f.session('a'),'question',['sample/answer'],{homeDirectory:f.root})).rejects.toMatchObject({code:'SKILL_NOT_FOUND'});
});

it('fails closed when a bound package cannot load, and recovers after revision-checked disable', async()=>{
  const f=await fixture(true,true);
  await writeFile(join(f.store.pluginDir('sample'),'broken.mjs'),'throw new Error("provider broken");');
  const manifestPath=join(f.store.pluginDir('sample'),'.dutydeck-plugin/plugin.json');const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  await writeFile(manifestPath,JSON.stringify({...manifest,providers:'broken.mjs'}));
  const loaded=await loadDaemonPlugins({DUTYDECK_DATABASE_URL:join(f.store.dataDir,'test.db')},{builtinRoot:join(f.root,'none')});
  expect(loaded.host).toBeDefined();const failed=loaded.host!;expect(failed.active).toHaveLength(0);
  await expect(prepareBoundTaskPrompt(failed,new PluginRuntimeHooks(failed.hooks),f.session('a'),'question')).rejects.toMatchObject({code:'PLUGIN_BINDING_UNAVAILABLE'});
  const saved=failed.bindings.list().find(binding=>binding.chatId==='a')!;const {id,revision,...input}=saved;
  failed.bindings.save({...input,enabled:false,expectedRevision:revision});
  expect((await prepareBoundTaskPrompt(failed,new PluginRuntimeHooks(failed.hooks),f.session('a'),'question')).agentPrompt).toBe('question');
});
