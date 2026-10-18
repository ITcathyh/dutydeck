import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCliUi } from '../cli-ui.js';
import { runPluginCli } from './cli.js';
import { parsePluginSource, PluginStore } from './store.js';

const examplePlugin = resolve(import.meta.dirname, '../../../../examples/plugins/hello');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

async function writePlugin(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
}
const declarative = (name: string, version = '1.0.0') => ({
  '.dutydeck-plugin/plugin.json': JSON.stringify({ name, version, userConfig: { region: { description: 'r' }, api_key: { description: 'k', sensitive: true } } }),
  'commands/summary.md': '总结 $ARGUMENTS',
  'triggers/build.json': JSON.stringify({ auth: { type: 'token' }, target: { botAppId: 'cli_a', chatId: 'oc_b' }, prompt: '{{payload.text}}' })
});
const hookFiles = { 'hooks/hooks.json': JSON.stringify({ 'task.completed': [{ command: 'true', timeout: 1000 }] }) };

describe('PluginStore', () => {
  let temp: string;
  let store: PluginStore;
  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'dutydeck-plugin-store-'));
    store = new PluginStore(join(temp, 'data'));
  });
  afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

  it('classifies install sources', () => {
    expect(parsePluginSource('./hello', '/work')).toEqual({ kind: 'local', spec: '/work/hello' });
    expect(parsePluginSource('/abs/hello')).toEqual({ kind: 'local', spec: '/abs/hello' });
    expect(parsePluginSource('https://example.com/p.git#v1')).toEqual({ kind: 'git', spec: 'https://example.com/p.git', ref: 'v1' });
    expect(parsePluginSource('git+ssh://git@example.com/p.git')).toEqual({ kind: 'git', spec: 'ssh://git@example.com/p.git' });
    expect(parsePluginSource('@scope/pkg@1.2.0', temp)).toEqual({ kind: 'npm', spec: '@scope/pkg@1.2.0' });
    expect(parsePluginSource('npm:./local', temp)).toEqual({ kind: 'npm', spec: './local' });
    expect(() => parsePluginSource('https://example.com/p.git#--upload-pack=touch /tmp/x')).toThrow('无效');
    expect(() => parsePluginSource('npm:--registry=http://evil')).toThrow('无效');
  });

  it('installs a declarative local plugin, records the lock entry and uninstalls everything', async () => {
    const source = join(temp, 'src');
    await writePlugin(source, declarative('docs'));
    const entry = await store.install(source, { scope: 'bot:cli_a' });
    expect(entry).toMatchObject({ name: 'docs', version: '1.0.0', source: { kind: 'local', spec: source }, resolved: { version: '1.0.0' }, scope: 'bot:cli_a', enabled: true, trustedCapabilities: [] });
    expect(entry.installedAt).toBe(entry.updatedAt);
    expect(JSON.parse(await readFile(join(temp, 'data/plugins/plugins.lock.json'), 'utf8'))).toEqual({ version: 1, plugins: { docs: entry } });
    expect(await readFile(join(temp, 'data/plugins/docs/commands/summary.md'), 'utf8')).toBe('总结 $ARGUMENTS');
    await expect(store.install(source)).rejects.toMatchObject({ code: 'PLUGIN_ALREADY_INSTALLED' });

    expect((await store.setEnabled('docs', false)).enabled).toBe(false);
    const { token } = await store.ensureTriggerToken('docs', 'build');
    expect(store.triggerToken('docs', 'build')).toBe(token);
    expect((await stat(join(temp, 'data/plugins/.trigger-tokens.json'))).mode & 0o777).toBe(0o600);
    expect(await store.ensureTriggerToken('docs', 'build')).toEqual({ token, created: false });
    const rotated = await store.ensureTriggerToken('docs', 'build', true);
    expect(rotated.created).toBe(true);
    expect(rotated.token).not.toBe(token);
    await expect(store.ensureTriggerToken('docs', 'nope')).rejects.toMatchObject({ code: 'PLUGIN_TRIGGER_NOT_FOUND' });

    await store.setConfig('docs', 'region', Buffer.from('cn'));
    await expect(store.setConfig('docs', 'api_key', Buffer.from('s3cret'), true)).rejects.toMatchObject({ code: 'PLUGIN_CONFIG_SENSITIVE' });
    expect((await store.setConfig('docs', 'api_key', Buffer.from('s3cret'))).sensitive).toBe(true);
    await store.setConfig('docs', 'api_key', Buffer.from('rotated'));
    await expect(store.setConfig('docs', 'other', Buffer.from('x'))).rejects.toMatchObject({ code: 'PLUGIN_CONFIG_UNKNOWN' });
    expect(store.plainConfig('docs')).toEqual({ region: 'cn' });
    expect(await readFile(join(temp, 'data/plugins/.config.json'), 'utf8')).not.toContain('s3cret');

    await store.uninstall('docs');
    expect(store.list()).toEqual([]);
    expect(store.triggerToken('docs', 'build')).toBeUndefined();
    expect(store.plainConfig('docs')).toEqual({});
    expect(store.secretProvider(false)!.inspect('plugin.docs.api_key').availability).toBe('missing');
    await expect(stat(store.pluginDir('docs'))).rejects.toThrow();
  });

  it('requires trust for hooks: refuses without confirmation, honours --yes and a declined prompt', async () => {
    await expect(store.install(examplePlugin)).rejects.toMatchObject({ code: 'PLUGIN_TRUST_REQUIRED', message: expect.stringContaining('node hooks/log-event.mjs') });
    await writePlugin(join(temp, 'agent'), { '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'agent-only' }), 'agents/a.json': JSON.stringify({ id: 'a', name: 'A', command: 'my-agent', args: ['--acp'], permissionMode: 'full-trust' }) });
    await expect(store.install(join(temp, 'agent'))).rejects.toMatchObject({ code: 'PLUGIN_TRUST_REQUIRED', message: expect.stringContaining('agent a：my-agent --acp（权限模式 full-trust）') });
    await expect(store.install(examplePlugin, { confirm: async () => false })).rejects.toMatchObject({ code: 'PLUGIN_TRUST_DECLINED' });
    expect(store.list()).toEqual([]);
    const confirm = vi.fn(async () => true);
    const entry = await store.install(examplePlugin, { confirm });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ plugin: 'hello', capabilities: ['hooks:task.received'] }));
    expect(entry.trustedCapabilities).toEqual(['hooks:task.received']);
  });

  it('installs from a local git repo pinned by sha and re-confirms when update adds capabilities', async () => {
    const repo = join(temp, 'repo');
    await writePlugin(repo, declarative('gitdemo'));
    git(repo, 'init', '--quiet', '-b', 'main');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'v1');
    const firstSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'tag', 'v1');

    const entry = await store.install(`file://${repo}#v1`);
    expect(entry).toMatchObject({ source: { kind: 'git', spec: `file://${repo}`, ref: 'v1' }, resolved: { sha: firstSha, version: '1.0.0' } });
    await expect(stat(join(store.pluginDir('gitdemo'), '.git'))).rejects.toThrow();
    expect(await store.update('gitdemo')).toMatchObject({ changed: false });

    // 新提交加了 hook：按 ref 跟随需要把 ref 指向新提交
    await writePlugin(repo, { ...declarative('gitdemo', '1.1.0'), ...hookFiles });
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'v1.1');
    git(repo, 'tag', '-f', 'v1');
    const secondSha = git(repo, 'rev-parse', 'HEAD');

    await expect(store.update('gitdemo')).rejects.toMatchObject({ code: 'PLUGIN_TRUST_REQUIRED' });
    await expect(store.update('gitdemo', { confirm: async () => false })).rejects.toMatchObject({ code: 'PLUGIN_TRUST_DECLINED' });
    expect(store.get('gitdemo')).toMatchObject({ resolved: { sha: firstSha }, trustedCapabilities: [] });
    expect(await readFile(join(store.pluginDir('gitdemo'), '.dutydeck-plugin/plugin.json'), 'utf8')).toContain('1.0.0');

    const confirm = vi.fn(async () => true);
    const updated = await store.update('gitdemo', { confirm });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ capabilities: ['hooks:task.completed'] }));
    expect(updated).toMatchObject({ changed: true, entry: { version: '1.1.0', resolved: { sha: secondSha }, trustedCapabilities: ['hooks:task.completed'], installedAt: entry.installedAt } });
    // 能力没变时不再询问
    const again = vi.fn(async () => true);
    expect(await store.update('gitdemo', { confirm: again })).toMatchObject({ changed: false });
    expect(again).not.toHaveBeenCalled();
  });

  it('reports same-version local content replacement as changed', async () => {
    const source = join(temp, 'local');
    await writePlugin(source, declarative('local'));
    await store.install(source);
    await writePlugin(source, { 'commands/summary.md': 'new contents' });
    expect(await store.update('local')).toMatchObject({ changed: true });
    expect(await readFile(join(store.pluginDir('local'), 'commands/summary.md'), 'utf8')).toBe('new contents');
  });

  it('installs an npm package from a local tarball source and records its version', async () => {
    const pkg = join(temp, 'pkg');
    await writePlugin(pkg, { ...declarative('npmdemo', '2.0.0'), 'package.json': JSON.stringify({ name: 'npmdemo-plugin', version: '2.0.1', files: ['.dutydeck-plugin', 'commands', 'triggers'] }) });
    const entry = await store.install(`npm:${pkg}`);
    expect(entry).toMatchObject({ name: 'npmdemo', source: { kind: 'npm', spec: pkg }, resolved: { version: '2.0.1' } });
  }, 60_000);
});

describe('dutydeck plugin CLI', () => {
  let temp: string;
  beforeEach(async () => { temp = await mkdtemp(join(tmpdir(), 'dutydeck-plugin-cli-')); });
  afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

  const cli = async (action: Parameters<typeof runPluginCli>[0], args: string[], options: Parameters<typeof runPluginCli>[2] = {}) => {
    let out = '';
    const ui = createCliUi({ stdout: { write: chunk => { out += chunk; } }, stderr: { write: () => {} }, color: false });
    // 只看外部插件：内置插件目录指向空目录。
    const result = await runPluginCli(action, args, { database: join(temp, 'data/dutydeck.db'), ...options }, { ui, cwd: temp, confirm: async () => false, builtinRoot: join(temp, 'no-builtin') });
    return { ...result, out };
  };

  it('init → validate → install --yes → list → trigger-token → disable → uninstall', async () => {
    expect((await cli('init', ['demo'])).ok).toBe(true);
    const validated = await cli('validate', ['demo']);
    expect(validated).toMatchObject({ ok: true, out: expect.stringContaining('/hello') });
    await cp(examplePlugin, join(temp, 'hello'), { recursive: true });
    await expect(cli('install', ['./hello'])).rejects.toMatchObject({ code: 'PLUGIN_TRUST_DECLINED' });
    expect((await cli('install', ['./hello'], { yes: true })).out).toContain('dutydeck restart');
    const listed = JSON.parse((await cli('list', [], { json: true })).out);
    expect(listed.plugins).toEqual([expect.objectContaining({ name: 'hello', enabled: true, trustedCapabilities: ['hooks:task.received'] })]);
    const token = JSON.parse((await cli('trigger-token', ['hello/ping'], { json: true })).out);
    expect(token).toMatchObject({ path: '/api/plugins/hello/triggers/ping', created: true, token: expect.any(String) });
    expect((await cli('disable', ['hello'])).ok).toBe(true);
    expect((await cli('list', [])).out).toContain('已停用');
    expect((await cli('uninstall', ['hello'])).ok).toBe(true);
    expect((await cli('list', [])).out).toContain('还没有安装插件');
  });

  it('prints restart guidance after updating local content without a version bump', async () => {
    await writePlugin(join(temp, 'local'), declarative('local'));
    await cli('install', ['./local']);
    await writePlugin(join(temp, 'local'), { 'commands/summary.md': 'new contents' });
    const result = await cli('update', ['local']);
    expect(result.out).toContain('dutydeck restart');
    expect(result.out).not.toContain('已是最新');
  });

  it('validate exits non-zero and lists issues', async () => {
    await writePlugin(join(temp, 'bad'), { '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'bad', extra: 1 }) });
    const result = await cli('validate', ['bad']);
    expect(result.ok).toBe(false);
    expect(result.out).toContain('.dutydeck-plugin/plugin.json');
  });
});
