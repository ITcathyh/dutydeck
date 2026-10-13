import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverSkills, setPluginSkillRoots } from '../skill-catalog.js';
import { PluginHost, resolveTriggerTarget } from './host.js';
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
    expect(await loadDaemonPlugins({ DUTYDECK_DATABASE_URL: join(dataDir, 'dutydeck.db') })).toBeUndefined();
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

    const host = await PluginHost.load({ dataDir });
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
    const host = await PluginHost.load({ dataDir });
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
    expect(await pluginDoctorChecks(dataDir)).toEqual([]);
    const store = new PluginStore(dataDir);
    await store.install(examplePlugin, { yes: true });
    expect(await pluginDoctorChecks(dataDir)).toEqual([expect.objectContaining({ id: 'plugins.hello', level: 'warn', detail: expect.stringContaining('缺少配置') })]);
    await store.setConfig('hello', 'bot_app_id', Buffer.from('cli_a'));
    await store.setConfig('hello', 'chat_id', Buffer.from('oc_b'));
    expect(await pluginDoctorChecks(dataDir)).toEqual([expect.objectContaining({ level: 'warn', command: 'dutydeck plugin trigger-token hello/ping' })]);
    await store.ensureTriggerToken('hello', 'ping');
    expect(await pluginDoctorChecks(dataDir)).toEqual([expect.objectContaining({ level: 'ok' })]);
    await writePlugin(store.pluginDir('hello'), { 'hooks/hooks.json': JSON.stringify({ notify: [{ command: 'true', timeout: 1000 }] }) });
    expect(await pluginDoctorChecks(dataDir)).toEqual([expect.objectContaining({ level: 'warn', command: 'dutydeck plugin update hello' })]);
    await writePlugin(store.pluginDir('hello'), { '.dutydeck-plugin/plugin.json': '{' });
    expect(await pluginDoctorChecks(dataDir)).toEqual([expect.objectContaining({ level: 'fail', command: 'dutydeck plugin disable hello' })]);
    await store.setEnabled('hello', false);
    expect(await pluginDoctorChecks(dataDir)).toEqual([expect.objectContaining({ level: 'skip' })]);
  });
});
