import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliUi } from '../cli-ui.js';
import { discoverSkills, setPluginSkillRoots } from '../skill-catalog.js';
import { runPluginCli } from './cli.js';
import { PluginHost, resolveTriggerTarget } from './host.js';
import { directPack, markerProviders, providerPack, scenarioMessage } from './scenario-fixtures.test-helpers.js';
import { loadDaemonPlugins } from './service-wiring.js';
import { PluginStore } from './store.js';

const examplePlugin = resolve(import.meta.dirname, '../../../../examples/plugins/hello');

async function writePlugin(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

describe('PluginHost', () => {
  let temp: string;
  let dataDir: string;
  let store: PluginStore;
  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'dutydeck-plugin-host-'));
    dataDir = join(temp, 'data');
    store = new PluginStore(dataDir);
  });
  afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

  it('changes nothing when no plugin is installed', async () => {
    const loaded = await loadDaemonPlugins({ DUTYDECK_DATABASE_URL: join(dataDir, 'dutydeck.db') });
    expect(loaded.host).toBeUndefined();
    // 只有内置场景包（告警）时也不接线。
    expect(loaded.scenarios.list().map(entry => entry.pack.id)).toEqual(['alarm']);
    const host = await PluginHost.load({ dataDir });
    expect(host.diagnostics).toEqual([]);
    expect(host.agents).toEqual([]);
    expect(host.hooks.has('task.received')).toBe(false);
    expect(host.commands.commands).toEqual([]);
  });

  it('loads only enabled plugins with trusted capabilities and isolates failures', async () => {
    await writePlugin(join(temp, 'good'), { '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'good' }), 'agents/a.json': JSON.stringify({ id: 'good-agent', name: 'Good', command: 'node' }) });
    await writePlugin(join(temp, 'off'), { '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'off' }), 'commands/off.md': 'x' });
    await writePlugin(join(temp, 'broken'), { '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'broken', providers: 'index.mjs' }), 'index.mjs': 'export default () => { throw new Error("boom") }' });
    await store.install(join(temp, 'good'), { yes: true });
    await store.install(join(temp, 'off'));
    await store.setEnabled('off', false);
    await store.install(join(temp, 'broken'), { yes: true });
    await store.install(examplePlugin, { yes: true });
    // 安装后插件目录里多出一个 hook：未经确认的能力让整个插件不加载
    await writePlugin(store.pluginDir('hello'), { 'hooks/hooks.json': JSON.stringify({ 'task.received': [{ command: 'true', timeout: 1000 }], notify: [{ command: 'true', timeout: 1000 }] }) });

    const host = await PluginHost.load({ dataDir, builtinRoot: join(temp, 'no-builtin') });
    expect(host.active.map(item => item.entry.name)).toEqual(['good']);
    expect(host.agents.map(agent => agent.id)).toEqual(['good-agent']);
    expect(host.agents.map(agent => agent.origin)).toEqual(['plugin:good']);
    expect(host.diagnostics).toEqual([
      { plugin: 'broken', message: 'boom' },
      { plugin: 'hello', message: expect.stringContaining('hooks:notify') }
    ]);
  });

  it('registers provider CI providers and in-process hook handlers with the plugin config', async () => {
    await writePlugin(join(temp, 'ci'), {
      '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'ci-gitlab', providers: 'index.mjs', userConfig: { base_url: { description: 'url' } } }),
      'index.mjs': `export default function register(api) {
        api.registerCiProvider({ id: 'gitlab', displayName: 'GitLab CI', matchRepository: url => url.includes(api.config.base_url) ? { owner: 'a', name: 'b', slug: 'a/b' } : undefined, getPipelineStatus: async () => ({ state: 'success', runs: [] }), getFailureLogs: async () => [] });
        api.registerHookHandler('task.received', input => ({ additionalContext: api.plugin.name + ':' + input.payload.prompt }));
      }`
    });
    await store.install(join(temp, 'ci'), { yes: true });
    await store.setConfig('ci-gitlab', 'base_url', Buffer.from('gitlab.example.com'));
    const host = await PluginHost.load({ dataDir });
    expect(host.diagnostics).toEqual([]);
    expect(host.ciProviders.match('git@gitlab.example.com:a/b.git')?.provider.id).toBe('gitlab');
    expect(host.ciProviders.match('git@github.com:a/b.git')).toBeUndefined();
    expect((await host.hooks.run('task.received', { payload: { prompt: 'hi' } })).additionalContext).toEqual(['ci-gitlab:hi']);
  });

  it('skips a plugin whose providers clash, without leaving part of it registered', async () => {
    const provider = (id: string) => `{ id: '${id}', displayName: '${id}', matchRepository: () => ({ owner: 'o', name: 'r', slug: 'o/r' }), getPipelineStatus: async () => ({ state: 'unknown', runs: [] }), getFailureLogs: async () => [] }`;
    await writePlugin(join(temp, 'a'), { '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'a-ci', providers: 'index.mjs' }), 'index.mjs': `export default api => { api.registerCiProvider(${provider('shared')}); }` });
    await writePlugin(join(temp, 'b'), { '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'b-ci', providers: 'index.mjs' }), 'index.mjs': `export default api => { api.registerCiProvider(${provider('b-only')}); api.registerCiProvider(${provider('shared')}); }` });
    await store.install(join(temp, 'a'), { yes: true });
    await store.install(join(temp, 'b'), { yes: true });
    const host = await PluginHost.load({ dataDir, builtinRoot: join(temp, 'no-builtin') });
    expect(host.active.map(item => item.entry.name)).toEqual(['a-ci']);
    expect(host.ciProviders.list().map(item => item.provider.id)).toEqual(['shared']);
    expect(host.diagnostics).toEqual([{ plugin: 'b-ci', message: expect.stringContaining('a-ci') }]);
  });

  it('resolves trigger targets from userConfig and hides triggers until configured', async () => {
    await store.install(examplePlugin, { yes: true });
    expect((await PluginHost.load({ dataDir })).trigger('hello', 'ping')).toBeUndefined();
    await store.setConfig('hello', 'bot_app_id', Buffer.from('cli_hello'));
    await store.setConfig('hello', 'chat_id', Buffer.from('oc_hello'));
    const host = await PluginHost.load({ dataDir });
    expect(host.trigger('hello', 'ping')?.target).toEqual({ botAppId: 'cli_hello', chatId: 'oc_hello', session: 'new' });
    expect(host.trigger('hello', 'missing')).toBeUndefined();
    expect(resolveTriggerTarget({ botAppId: 'x{{ config.a }}', chatId: 'c', session: 'reuse' }, { a: '1' })).toEqual({ botAppId: 'x1', chatId: 'c', session: 'reuse' });
  });

  it('runs the example command hook with plugin env and data dir', async () => {
    await store.install(examplePlugin, { yes: true });
    const host = await PluginHost.load({ dataDir });
    expect((await host.hooks.run('task.received', { sessionId: 's1', payload: { prompt: 'hi' } })).outcomes).toEqual([expect.objectContaining({ plugin: 'hello', result: 'allow' })]);
    const logged = (await readFile(join(store.pluginDataDir('hello'), 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(logged).toEqual([{ event: 'task.received', plugin: 'hello', sessionId: 's1', payload: { prompt: 'hi' } }]);
  });

  it('adds plugin skills as one more catalog root, filtered by scope', async () => {
    await writePlugin(join(temp, 'skills-plugin'), { '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'skillful' }), 'skills/triage/SKILL.md': '---\nname: triage\ndescription: 分诊\n---\n正文' });
    await store.install(join(temp, 'skills-plugin'), { scope: 'bot:cli_s' });
    const host = await PluginHost.load({ dataDir });
    const workspace = join(temp, 'ws');
    const home = join(temp, 'home');
    await mkdir(workspace); await mkdir(home);
    const dispose = setPluginSkillRoots(context => host.skillRoots(context));
    try {
      expect(await discoverSkills(workspace, { homeDirectory: home })).toEqual([]);
      expect(await discoverSkills(workspace, { homeDirectory: home, botAppId: 'cli_s' })).toEqual([expect.objectContaining({ name: 'triage', source: 'plugin' })]);
    } finally { dispose(); }
    expect(await discoverSkills(workspace, { homeDirectory: home, botAppId: 'cli_s' })).toEqual([]);
  });
});

describe('pluginDoctorChecks', () => {
  let temp: string;
  beforeEach(async () => { temp = await mkdtemp(join(tmpdir(), 'dutydeck-plugin-doctor-')); });
  afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

  it('reports nothing without plugins, then setup gaps, untrusted capabilities and broken plugins', async () => {
    const { pluginDoctorChecks } = await import('./doctor.js');
    const dataDir = join(temp, 'data');
    // 只看外部插件：内置插件目录指向空目录。
    const builtinRoot = join(temp, 'no-builtin');
    expect(await pluginDoctorChecks(dataDir, builtinRoot)).toEqual([]);
    const store = new PluginStore(dataDir);
    await store.install(examplePlugin, { yes: true });
    expect(await pluginDoctorChecks(dataDir, builtinRoot)).toEqual([expect.objectContaining({ id: 'plugins.hello', level: 'warn', detail: expect.stringContaining('缺少配置') })]);
    await store.setConfig('hello', 'bot_app_id', Buffer.from('cli_a'));
    await store.setConfig('hello', 'chat_id', Buffer.from('oc_b'));
    expect(await pluginDoctorChecks(dataDir, builtinRoot)).toEqual([expect.objectContaining({ level: 'warn', command: 'dutydeck plugin trigger-token hello/ping' })]);
    await store.ensureTriggerToken('hello', 'ping');
    expect(await pluginDoctorChecks(dataDir, builtinRoot)).toEqual([expect.objectContaining({ level: 'ok' })]);
    await writePlugin(store.pluginDir('hello'), { 'hooks/hooks.json': JSON.stringify({ notify: [{ command: 'true', timeout: 1000 }] }) });
    expect(await pluginDoctorChecks(dataDir, builtinRoot)).toEqual([expect.objectContaining({ level: 'warn', command: 'dutydeck plugin update hello' })]);
    await writePlugin(store.pluginDir('hello'), { '.dutydeck-plugin/plugin.json': '{' });
    expect(await pluginDoctorChecks(dataDir, builtinRoot)).toEqual([expect.objectContaining({ level: 'fail', command: 'dutydeck plugin disable hello' })]);
    await store.setEnabled('hello', false);
    expect(await pluginDoctorChecks(dataDir, builtinRoot)).toEqual([expect.objectContaining({ level: 'skip' })]);
  });
});

describe('scenario packs: trust boundary, builtin plugins and wiring', () => {
  let temp: string;
  let dataDir: string;
  let builtinRoot: string;
  let marker: string;
  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'dutydeck-plugin-scenarios-'));
    dataDir = join(temp, 'data');
    builtinRoot = join(temp, 'builtin');
    marker = join(temp, 'imported.marker');
    await mkdir(builtinRoot);
  });
  afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

  const cli = async (action: Parameters<typeof runPluginCli>[0], args: string[], options: Parameters<typeof runPluginCli>[2] = {}) => {
    let out = '';
    const ui = createCliUi({ stdout: { write: chunk => { out += chunk; } }, stderr: { write: () => {} }, color: false });
    const result = await runPluginCli(action, args, { database: join(dataDir, 'dutydeck.db'), ...options }, { ui, cwd: temp, confirm: async () => false, builtinRoot });
    return { ...result, out };
  };
  const writeProviderPlugin = (root: string, name: string) => writePlugin(root, {
    '.dutydeck-plugin/plugin.json': JSON.stringify({ name, providers: 'index.mjs' }),
    'index.mjs': markerProviders(marker),
    'scenarios/pick.json': JSON.stringify(providerPack('pick'))
  });

  it('validate and an unconfirmed install never import provider code; a trusted load does', async () => {
    await writeProviderPlugin(join(temp, 'src'), 'picker');
    const validated = await cli('validate', ['./src']);
    expect(validated).toMatchObject({ ok: true, out: expect.stringContaining('pick@1.0.0（direct）') });
    const store = new PluginStore(dataDir, builtinRoot);
    await expect(store.install(join(temp, 'src'))).rejects.toMatchObject({ code: 'PLUGIN_TRUST_REQUIRED' });
    await expect(store.install(join(temp, 'src'), { confirm: async () => false })).rejects.toMatchObject({ code: 'PLUGIN_TRUST_DECLINED' });
    expect(store.list()).toEqual([]);
    expect(existsSync(marker)).toBe(false);

    await store.install(join(temp, 'src'), { yes: true });
    expect(existsSync(marker)).toBe(false);
    const host = await PluginHost.load({ dataDir, builtinRoot });
    expect(existsSync(marker)).toBe(true);
    expect(host.diagnostics).toEqual([]);
    const entry = host.scenarios.get('pick')!;
    expect(entry).toMatchObject({ plugin: 'picker', builtin: false, scope: 'global', digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await entry.providers.get('pick')!.match({ message: scenarioMessage('boom'), params: {} })).toMatchObject({ status: 'ok', value: { matched: true, dedupeKey: 'k' } });
  });

  it('loads builtin plugins first without trust confirmation, and they cannot be uninstalled or shadowed', async () => {
    await writeProviderPlugin(join(builtinRoot, 'sample'), 'sample');
    const host = await PluginHost.load({ dataDir, builtinRoot });
    expect(host.active.map(item => [item.entry.name, item.builtin, item.entry.trustedCapabilities])).toEqual([['sample', true, ['providers']]]);
    expect(host.scenarios.list().map(item => [item.pack.id, item.plugin, item.builtin])).toEqual([['pick', 'sample', true]]);

    await writePlugin(join(temp, 'shadow'), { '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'sample' }), 'commands/hi.md': '你好' });
    await expect(new PluginStore(dataDir, builtinRoot).install(join(temp, 'shadow'))).rejects.toMatchObject({ code: 'PLUGIN_NAME_BUILTIN' });
    await expect(new PluginStore(dataDir, builtinRoot).uninstall('sample')).rejects.toMatchObject({ code: 'PLUGIN_BUILTIN' });
    // 内置插件出现之前装过的同名外部插件：不加载，记诊断，内置的照常
    await new PluginStore(dataDir, join(temp, 'no-builtins')).install(join(temp, 'shadow'));
    const again = await PluginHost.load({ dataDir, builtinRoot });
    expect(again.active.map(item => [item.entry.name, item.builtin])).toEqual([['sample', true]]);
    expect(again.diagnostics).toEqual([{ plugin: 'sample', message: expect.stringContaining('内置插件') }]);
    expect(again.commands.commands).toEqual([]);

    const listed = JSON.parse((await cli('list', [], { json: true })).out);
    expect(listed.plugins).toEqual([
      expect.objectContaining({ name: 'sample', builtin: true, enabled: true }),
      expect.objectContaining({ name: 'sample', source: expect.objectContaining({ kind: 'local' }), problem: expect.stringContaining('内置插件') })
    ]);
    expect((await cli('list', [])).out).toContain('内置 · 已启用 · global');
  });

  it('skips only the pack whose provider is missing, lacks the method, or whose id is taken', async () => {
    await writePlugin(join(builtinRoot, 'sample'), { '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'sample' }), 'scenarios/demo.json': JSON.stringify(directPack('demo')) });
    await writePlugin(join(temp, 'mixed'), {
      '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'mixed', providers: 'index.mjs' }),
      'index.mjs': markerProviders(marker, `api.registerScenarioProvider({ id: 'other', match: () => ({ matched: true }) }); api.registerScenarioProvider({ id: 'keys', correlationKey: () => ({}) });`),
      'scenarios/pick.json': JSON.stringify(providerPack('pick')),
      'scenarios/keys.json': JSON.stringify(directPack('keys', { trigger: { senderKinds: ['bot'], sourceBotsParam: 'sources', match: { provider: 'keys' } } })),
      'scenarios/demo.json': JSON.stringify(directPack('demo')),
      'scenarios/plain.json': JSON.stringify(directPack('plain'))
    });
    await new PluginStore(dataDir, builtinRoot).install(join(temp, 'mixed'), { yes: true });
    const host = await PluginHost.load({ dataDir, builtinRoot });
    expect(host.scenarios.list().map(item => `${item.plugin}/${item.pack.id}`)).toEqual(['sample/demo', 'mixed/plain']);
    expect(host.diagnostics).toEqual([
      { plugin: 'mixed', scenario: 'demo', message: expect.stringContaining('sample') },
      { plugin: 'mixed', scenario: 'keys', message: expect.stringContaining('没有 match 方法') },
      { plugin: 'mixed', scenario: 'pick', message: expect.stringContaining('provider pick 没有注册') }
    ]);
  });

  it('a pack failing static checks is reported by host, plugin list and doctor while the plugin still loads', async () => {
    const { pluginDoctorChecks } = await import('./doctor.js');
    const { quota: _quota, ...noQuota } = directPack('broken');
    await writePlugin(join(builtinRoot, 'sample'), { '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'sample', version: '1.0.0' }), 'scenarios/broken.json': JSON.stringify(noQuota), 'scenarios/demo.json': JSON.stringify(directPack('demo')) });
    const host = await PluginHost.load({ dataDir, builtinRoot });
    expect(host.scenarios.list().map(item => item.pack.id)).toEqual(['demo']);
    expect(host.diagnostics).toEqual([{ plugin: 'sample', message: expect.stringContaining('scenarios/broken.json quota') }]);
    expect(JSON.parse((await cli('list', [], { json: true })).out).plugins).toEqual([expect.objectContaining({ name: 'sample', builtin: true, problem: expect.stringContaining('broken.json') })]);
    expect(await pluginDoctorChecks(dataDir, builtinRoot)).toEqual([expect.objectContaining({ id: 'plugins.sample', label: '内置插件 sample', level: 'warn', detail: expect.stringContaining('broken.json') })]);
    expect((await cli('validate', [join(builtinRoot, 'sample')])).ok).toBe(false);
  });

  it('install and update succeed but print the packs that will not load, worded like validate', async () => {
    const { quota: _quota, ...noQuota } = directPack('broken');
    await writePlugin(join(temp, 'packs'), { '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'packs' }), 'scenarios/broken.json': JSON.stringify(noQuota), 'scenarios/demo.json': JSON.stringify(directPack('demo')) });
    const installed = await cli('install', ['./packs']);
    expect(installed.ok).toBe(true);
    expect(installed.out).toContain('有场景包没通过校验，不会加载');
    expect(installed.out).toContain('scenarios/broken.json quota：direct 模式必须声明每小时上限参数');
    const updated = JSON.parse((await cli('update', ['packs'], { json: true })).out);
    expect(updated.plugins[0].scenarioIssues).toEqual([expect.objectContaining({ file: 'scenarios/broken.json', field: 'quota' })]);
  });

  it('pack ids declared by builtin plugins stay reserved even when the builtin plugin fails to load', async () => {
    await writePlugin(join(builtinRoot, 'sample'), {
      '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'renamed' }),
      'scenarios/demo.json': JSON.stringify(directPack('demo')),
      'scenarios/alarm.json': '{'
    });
    await writePlugin(join(temp, 'ext'), {
      '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'ext' }),
      'scenarios/alarm.json': JSON.stringify(directPack('alarm')),
      'scenarios/demo.json': JSON.stringify(directPack('demo')),
      'scenarios/plain.json': JSON.stringify(directPack('plain'))
    });
    await new PluginStore(dataDir, builtinRoot).install(join(temp, 'ext'));
    const host = await PluginHost.load({ dataDir, builtinRoot });
    expect(host.scenarios.list().map(item => `${item.plugin}/${item.pack.id}`)).toEqual(['ext/plain']);
    expect(host.diagnostics).toEqual([
      { plugin: 'sample', message: expect.stringContaining('renamed') },
      { plugin: 'ext', scenario: 'alarm', message: expect.stringContaining('保留给内置插件 sample') },
      { plugin: 'ext', scenario: 'demo', message: expect.stringContaining('保留给内置插件 sample') }
    ]);
  });

  it('with only builtin scenario packs the registry exists but nothing is wired into the daemon', async () => {
    const env = { DUTYDECK_DATABASE_URL: join(dataDir, 'dutydeck.db') };
    await writeProviderPlugin(join(builtinRoot, 'sample'), 'sample');
    const scenarioOnly = await loadDaemonPlugins(env, { builtinRoot });
    expect(scenarioOnly.host).toBeUndefined();
    expect(scenarioOnly.scenarios.list().map(item => item.pack.id)).toEqual(['pick']);

    await writePlugin(join(builtinRoot, 'sample'), { 'commands/hi.md': '你好' });
    const withCommand = await loadDaemonPlugins(env, { builtinRoot });
    expect(withCommand.host?.commands.commands.map(command => command.name)).toEqual(['hi']);

    await rm(join(builtinRoot, 'sample', 'commands'), { recursive: true });
    await writePlugin(join(temp, 'docs'), { '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'docs' }) });
    await new PluginStore(dataDir, builtinRoot).install(join(temp, 'docs'));
    expect((await loadDaemonPlugins(env, { builtinRoot })).host?.active.map(item => item.entry.name)).toEqual(['sample', 'docs']);
  });

  it('示例插件 team-faq（model 模式）能校验、确认后安装并和内置告警包一起加载，provider 按 docs_dir 读 runbook', async () => {
    const teamFaq = resolve(import.meta.dirname, '../../../../plugins/team-faq');
    expect(await cli('validate', [teamFaq])).toMatchObject({ ok: true, out: expect.stringContaining('team-faq@0.1.0（model）') });
    const store = new PluginStore(dataDir);
    await expect(store.install(teamFaq)).rejects.toMatchObject({ code: 'PLUGIN_TRUST_REQUIRED' });
    await store.install(teamFaq, { yes: true });
    const docs = join(temp, 'runbooks');
    await writePlugin(docs, { 'orders.md': '# 订单服务\n\n## 5xx 排查\n\n订单服务 5xx 先看网关日志。\n' });
    await store.setConfig('team-faq', 'docs_dir', Buffer.from(docs));
    const host = await PluginHost.load({ dataDir });
    expect(host.diagnostics).toEqual([]);
    expect(host.scenarios.list().map(item => [item.pack.id, item.pack.mode, item.builtin])).toEqual([['alarm', 'direct', true], ['team-faq', 'model', false]]);
    const context = await host.scenarios.get('team-faq')!.providers.get('runbook')!.context({ scope: { appId: 'cli_a', chatId: 'oc_a' },
      message: { ...scenarioMessage('订单服务 5xx 怎么排查'), senderKind: 'human' }, params: { topics: ['订单服务'], docs: ['orders.md'] }, maxChars: 6000 }, 3000);
    expect(context).toMatchObject({ status: 'ok', value: { items: expect.arrayContaining([expect.objectContaining({ id: 'orders.md#1', title: 'orders.md · 5xx 排查' })]), missing: [] } });
  });

  it('answers which packs apply by plugin scope, group binding and major version', async () => {
    await writePlugin(join(temp, 'scoped'), { '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'scoped' }), 'scenarios/demo.json': JSON.stringify(directPack('demo')) });
    await new PluginStore(dataDir, builtinRoot).install(join(temp, 'scoped'), { scope: 'bot:cli_a' });
    const { scenarios } = await PluginHost.load({ dataDir, builtinRoot });
    const binding = { enabled: true, params: { sources: ['cli_source'] }, packVersion: '1.0.0', requesterId: 'ou_a' };
    expect(scenarios.forScope({ botAppId: 'cli_b' })).toEqual([]);
    expect(scenarios.applicable({ botAppId: 'cli_a' }, { demo: binding }).map(item => item.entry.pack.id)).toEqual(['demo']);
    expect(scenarios.applicable({ botAppId: 'cli_a' }, {})).toEqual([]);
    expect(scenarios.applicable({ botAppId: 'cli_a' }, { demo: { ...binding, packVersion: '2.0.0' } })).toEqual([]);
    expect(scenarios.applicable({ botAppId: 'cli_a' }, { demo: { ...binding, params: { sources: [] } } })).toEqual([]);
  });
});
