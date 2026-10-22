import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginHost } from './host.js';
import { PluginStore } from './store.js';
import { PluginRuntimeHooks } from './integration.js';
import { prepareBoundTaskPrompt } from './bound-skills.js';
import { setPluginSkillRoots } from '../skill-catalog.js';
import { ReadonlyParticipationDecider } from '../lark/readonly-decider.js';
import { createAlarmHarness, SCENARIO_BOT, SCENARIO_CHAT, SCENARIO_REQUESTER } from '../lark/scenario-pack.test-helpers.js';
vi.mock('../lark/open-platform-session.js', () => ({ connectLarkOpenPlatformSession: vi.fn() }));
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('runs a detached team-faq tarball for two groups, freezes only the selected scenario, and delivers bound SOPs through actual readonly and @ flows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-faq-tarball-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'); await cp(resolve(import.meta.dirname, '../../../../plugins/team-faq'), source, { recursive: true });
  const manifestPath = join(source, '.dutydeck-plugin/plugin.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.bindingConfig.token = { type: 'secret', required: true, description: 'Synthetic credential' }; await writeFile(manifestPath, JSON.stringify(manifest));
  for (const [name, body] of [['selected', 'SELECTED-SCENARIO-SOP'], ['unused', 'UNSELECTED-SCENARIO-SOP']]) { await mkdir(join(source, 'skills', name!), { recursive: true }); await writeFile(join(source, 'skills', name!, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n${body}`); }
  const scenarioPath = join(source, 'scenarios/team-faq.json'); const pack = JSON.parse(await readFile(scenarioPath, 'utf8'));
  pack.skills = ['team-faq/selected']; await writeFile(scenarioPath, JSON.stringify(pack));
  await writeFile(join(source, 'scenarios/unused.json'), JSON.stringify({ ...pack, id: 'unused', skills: ['team-faq/unused'] }));
  const direct = JSON.parse(await readFile(resolve(import.meta.dirname, '../../../../builtin-plugins/alarm/scenarios/alarm.json'), 'utf8'));
  delete direct.correlation; direct.id = 'direct-faq'; direct.skills = ['team-faq/selected'];
  await writeFile(join(source, 'scenarios/direct-faq.json'), JSON.stringify(direct));
  const tarball = join(root, JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: source, encoding: 'utf8' }))[0].filename);
  await rm(source, { recursive: true, force: true });
  const store = new PluginStore(join(root, 'data')); await store.install(`npm:${tarball}`, { yes: true });
  const host = await PluginHost.load({ dataDir: store.dataDir }); expect(host.diagnostics).toEqual([]);
  cleanups.push(setPluginSkillRoots(scope => host.skillEntries(scope)));
  const active = host.active.find(item => item.entry.name === 'team-faq')!;
  for (const [chatId, label] of [[SCENARIO_CHAT, 'GROUP-A'], ['oc_other', 'GROUP-B']]) {
    const docs = join(root, label!); await mkdir(docs); await writeFile(join(docs, 'orders.md'), `## orders\norders ${label} evidence`);
    store.secretProvider(true)!.writeExclusive(`plugin.team-faq.${label}`, Buffer.from(`${label}-token`));
    host.bindings.save({ plugin: 'team-faq', botAppId: SCENARIO_BOT.appId, chatId, enabled: true, config: { docs_dir: docs }, secrets: { token: `plugin.team-faq.${label}` }, skills: [], expectedRevision: 0 }, active.plugin.manifest);
  }
  const provider = host.scenarios.get('team-faq')!.providers.get('runbook')!;
  const results = await Promise.all([SCENARIO_CHAT, 'oc_other'].map(chatId => provider.context({ scope: { appId: SCENARIO_BOT.appId, chatId }, message: { messageId:'message',chatId,senderKind:'human',messageType:'text',text:'orders?',mentionsSelf:false,mentionsOther:false }, params:{ topics:['orders'],docs:['orders.md'] } })));
  expect(results[0]).toMatchObject({status:'ok',value:{items:[{text:expect.stringContaining('GROUP-A')}]}}); expect(results[1]).toMatchObject({status:'ok',value:{items:[{text:expect.stringContaining('GROUP-B')}]}});
  expect(await Promise.all([SCENARIO_CHAT, 'oc_other'].map(async chatId => (await host.resolveBinding('team-faq', { botAppId: SCENARIO_BOT.appId, chatId }))!.getSecret('token')))).toEqual(['GROUP-A-token','GROUP-B-token']);
  const hooks = new PluginRuntimeHooks(host.hooks); let decider!: ReadonlyParticipationDecider;
  const h = await createAlarmHarness({ participation:'selective', scenarios:host.scenarios,
    runtimeOptions:{ prepareTaskPrompt:(session,prompt,skills,context) => prepareBoundTaskPrompt(host,hooks,session,prompt,skills,context) },
    decide:(...args)=>decider.decide(...args), respond:(...args)=>decider.respond(...args),
    answer:prompt=>prompt.includes('你是群参与的只读判定器') ? JSON.stringify({action:'reply',reason:'evidence',evidenceIds:[/当前触发观察 id："([^"]+)"/u.exec(prompt)![1]],updates:[]}) : JSON.stringify({response:'Documented answer'}) });
  cleanups.push(()=>h.close()); decider = new ReadonlyParticipationDecider({runtime:h.runtime,repos:h.repos,workspaceRoot:join(h.cwd,'readonly')});
  const duty=await h.repos.collaboration.getDuty(h.scope); await h.participation.updateDuty(h.scope,{expectedRevision:duty.revision,scenarios:{'team-faq':{enabled:true,params:{topics:['orders'],docs:['orders.md']}}}},'owner');
  await h.receive(h.fromUser({messageId:'auto',text:'orders help?'})); await h.settle('auto'); await h.settle('auto');
  expect(h.prompts).toHaveLength(2);
  for(const prompt of h.prompts){ expect(prompt).toContain('Use the runbook supplied');expect(prompt).toContain('SELECTED-SCENARIO-SOP');expect(prompt).not.toContain('UNSELECTED-SCENARIO-SOP');expect(prompt).toContain('GROUP-A');expect(prompt).not.toContain('GROUP-B'); }
  await h.receive(h.fromUser({messageId:'explicit',text:'@_user_1 orders help?',mentionBot:true})); await h.settle('explicit');
  expect(h.prompts).toHaveLength(3);
  expect(h.prompts.at(-1)).toContain('Use the runbook supplied');expect(h.prompts.at(-1)).not.toContain('SELECTED-SCENARIO-SOP');expect(h.prompts.at(-1)).not.toContain('UNSELECTED-SCENARIO-SOP');
  const current = await h.repos.collaboration.getDuty(h.scope);
  await h.repos.collaboration.updateDuty(h.scope, { expectedRevision: current.revision, scenarios: { 'direct-faq': { enabled: true, params: { sources: [{appId:'cli_source',name:'Source'}] }, requesterId:SCENARIO_REQUESTER, packVersion:'1.1.0' } } }, SCENARIO_REQUESTER);
  await h.receive(h.fromBot({appId:'cli_source',openId:'ou_source'}, {messageId:'direct',content:JSON.stringify({text:'orders alarm'})})); await h.settle('direct');
  expect(h.prompts).toHaveLength(4); expect(h.prompts.at(-1)).toContain('SELECTED-SCENARIO-SOP'); expect(h.prompts.at(-1)).toContain('Use the runbook supplied'); expect(h.prompts.at(-1)).not.toContain('UNSELECTED-SCENARIO-SOP');
  expect(h.dispatched.at(-1)?.scenario).toMatchObject({mode:'direct', skills:{refs:['team-faq/selected']}});
  const oldContext = await host.resolveBinding('team-faq', {botAppId:SCENARIO_BOT.appId,chatId:SCENARIO_CHAT});
  await store.setEnabled('team-faq',false); await expect(oldContext!.getSecret('token')).rejects.toMatchObject({code:'PLUGIN_DISABLED'});
},60_000);
