import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCliUi } from '../cli-ui.js';
import { runPluginCli } from './cli.js';
import { loadPluginDirectory } from './manifest.js';
import { parsePluginSource, PluginStore, type PluginTrustPrompt } from './store.js';
import { writePlugin } from './scenario-fixtures.test-helpers.js';

const examplePlugin = resolve(import.meta.dirname, '../../../../examples/plugins/hello');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

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
    expect(await readFile(join(store.pluginDir('docs'), 'commands/summary.md'), 'utf8')).toBe('总结 $ARGUMENTS');
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

  it.each(['file', 'directory', 'chain'] as const)('rejects an external %s symlink on both installation and update', async kind => {
    const source = join(temp, 'src');
    await writePlugin(source, declarative('linked'));
    await writePlugin(join(temp, 'outside'), { 'helper.mjs': 'export default "mutable";' });
    await store.install(source);
    const original = store.get('linked');
    if (kind === 'file') await symlink(join(temp, 'outside/helper.mjs'), join(source, 'helper.mjs'));
    if (kind === 'directory') await symlink(join(temp, 'outside'), join(source, 'helpers'));
    if (kind === 'chain') {
      await symlink('bridge/helper.mjs', join(source, 'helper.mjs'));
      await symlink(join(temp, 'outside'), join(source, 'bridge'));
    }
    await expect(store.update('linked')).rejects.toMatchObject({ code: 'PLUGIN_ARTIFACT_INVALID' });
    expect(store.get('linked')).toEqual(original);
    const fresh = new PluginStore(join(temp, 'fresh'));
    await expect(fresh.install(source)).rejects.toMatchObject({ code: 'PLUGIN_ARTIFACT_INVALID' });
    expect(fresh.list()).toEqual([]);
  });

  it('keeps relative internal directory and chained file links self-contained across updates', async () => {
    const source = join(temp, 'src');
    await writePlugin(source, { ...declarative('linked'), 'helpers/actual.mjs': 'export default "v1";' });
    await symlink('helpers', join(source, 'alias'));
    await symlink('actual.mjs', join(source, 'helpers/forward.mjs'));
    await symlink('alias/forward.mjs', join(source, 'helper.mjs'));
    await store.install(source);
    const first = store.pluginDir('linked');
    expect((await import(pathToFileURL(join(first, 'helper.mjs')).href)).default).toBe('v1');
    await writePlugin(source, { 'helpers/actual.mjs': 'export default "v2";' });
    const aliasedStore = new PluginStore(join(temp, 'data-link'));
    await symlink(store.dataDir, aliasedStore.dataDir);
    const update = await aliasedStore.update('linked');
    expect(update.changed).toBe(true);
    expect(update.entry.candidate?.id).not.toBe(update.entry.active?.id);
    const candidate = store.artifactDir('linked', update.entry.candidate);
    await rm(source, { recursive: true });
    expect((await import(pathToFileURL(join(candidate, 'helper.mjs')).href)).default).toBe('v2');
    expect(await readFile(join(first, 'helper.mjs'), 'utf8')).toContain('v1');
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
    expect(updated).toMatchObject({ changed: true, entry: { version: '1.0.0', resolved: { sha: firstSha }, candidate: { version: '1.1.0', resolved: { sha: secondSha }, trustedCapabilities: ['hooks:task.completed'] }, installedAt: entry.installedAt } });
    // 能力没变时不再询问
    const again = vi.fn(async () => true);
    expect(await store.update('gitdemo', { confirm: again })).toMatchObject({ changed: false });
    expect(again).not.toHaveBeenCalled();
  });

  it('reports added, removed and changed executable command digests without exposing their contents', async () => {
    const source = join(temp, 'review');
    await writePlugin(source, {
      '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'review', version: '1.0.0' }),
      'commands/summary.md': 'old command secret',
      'commands/remove.md': 'remove me',
      'agents/worker.json': JSON.stringify({ id: 'worker', name: 'Worker', command: 'node', args: ['old.mjs'] }),
      'hooks/hooks.json': JSON.stringify({ 'task.completed': [{ command: ['node', 'old-hook.mjs'], timeout: 1000 }] })
    });
    await store.install(source, { yes: true });
    await writePlugin(source, {
      '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'review', version: '2.0.0' }),
      'commands/summary.md': 'new command secret',
      'commands/added.md': 'added command secret',
      'agents/worker.json': JSON.stringify({ id: 'worker', name: 'Worker', command: 'node', args: ['new.mjs', '--flag'] }),
      'hooks/hooks.json': JSON.stringify({ 'task.completed': [{ command: ['node', 'new-hook.mjs'], timeout: 1000 }] })
    });
    await rm(join(source, 'commands/remove.md'));

    const updated = await store.update('review', { yes: true });
    expect(updated.changed).toBe(true);
    expect(updated.changes).toHaveLength(5);
    expect(updated.changes).toEqual(expect.arrayContaining([
      { kind: 'agent', name: 'worker', before: expect.stringMatching(/^[0-9a-f]{64}$/), after: expect.stringMatching(/^[0-9a-f]{64}$/) },
      { kind: 'hook', name: 'task.completed', before: expect.stringMatching(/^[0-9a-f]{64}$/), after: expect.stringMatching(/^[0-9a-f]{64}$/) },
      { kind: 'command', name: 'review:summary', before: expect.stringMatching(/^[0-9a-f]{64}$/), after: expect.stringMatching(/^[0-9a-f]{64}$/) },
      { kind: 'command', name: 'review:added', before: null, after: expect.stringMatching(/^[0-9a-f]{64}$/) },
      { kind: 'command', name: 'review:remove', before: expect.stringMatching(/^[0-9a-f]{64}$/), after: null }
    ]));
    expect(JSON.stringify(updated.changes)).not.toContain('secret');

    // 同一活动版本与候选的规范序列化摘要稳定，与文件键顺序和重复执行无关。
    const again = await store.update('review', { yes: true });
    expect(again.changed).toBe(false);
    expect(again.changes).toEqual(updated.changes);
  });

  it('ignores description-only changes in command review digests and prompts', async () => {
    const source = join(temp, 'descriptions');
    await writePlugin(source, {
      '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'descriptions', version: '1.0.0', description: 'old plugin description' }),
      'commands/summary.md': '---\ndescription: old command description\nargument-hint: <old>\n---\nsame $ARGUMENTS'
    });
    await store.install(source);
    await writePlugin(source, {
      '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'descriptions', version: '1.0.0', description: 'new plugin description' }),
      'commands/summary.md': '---\ndescription: new command description\nargument-hint: <new>\n---\nsame $ARGUMENTS'
    });
    const confirm = vi.fn(async () => true);
    const updated = await store.update('descriptions', { confirm });
    expect(updated.changed).toBe(true);
    expect(updated.changes).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('re-confirms changed commands interactively, keeps rejection atomic, and preserves non-interactive and --yes behavior', async () => {
    const source = join(temp, 'retrust');
    await writePlugin(source, {
      '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'retrust', version: '1.0.0' }),
      'commands/summary.md': 'old prompt',
      'hooks/hooks.json': JSON.stringify({ 'task.completed': [{ command: 'old-hook-command', timeout: 1000 }] })
    });
    await store.install(source, { yes: true });
    const original = store.get('retrust');
    await writePlugin(source, {
      'commands/summary.md': 'new prompt secret',
      'hooks/hooks.json': JSON.stringify({ 'task.completed': [{ command: 'new-hook-command-secret', timeout: 1000 }] })
    });

    const decline = vi.fn(async () => false);
    await expect(store.update('retrust', { confirm: decline })).rejects.toMatchObject({ code: 'PLUGIN_TRUST_DECLINED' });
    expect(store.get('retrust')).toEqual(original);
    expect(decline).toHaveBeenCalledWith(expect.objectContaining({ capabilities: [], details: [] }));
    const prompt = decline.mock.calls[0]![0];
    expect(prompt.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'command', name: 'retrust:summary' }),
      expect.objectContaining({ kind: 'hook', name: 'task.completed' })
    ]));
    expect(JSON.stringify(prompt)).not.toContain('new-hook-command-secret');
    expect(JSON.stringify(prompt)).not.toContain('new prompt secret');

    // 只有命令变化、没有新增能力时，无 confirm 不新增失败。
    const nonInteractive = await store.update('retrust');
    expect(nonInteractive.changes).toHaveLength(2);

    const confirm = vi.fn(async () => true);
    const accepted = await store.update('retrust', { yes: true, confirm });
    expect(accepted.changes).toEqual(nonInteractive.changes);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('redacts changed hook commands when an update also adds a provider', async () => {
    const source = join(temp, 'provider-review');
    const secret = 'update-provider-secret-canary';
    await writePlugin(source, {
      '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'provider-review', version: '1.0.0' }),
      'hooks/hooks.json': JSON.stringify({ 'task.completed': [{ command: 'old-hook-command', timeout: 1000 }] })
    });
    await store.install(source, { yes: true });
    const original = store.get('provider-review');
    await writePlugin(source, {
      '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'provider-review', version: '2.0.0', providers: 'provider.mjs' }),
      'provider.mjs': 'export default () => {};',
      'hooks/hooks.json': JSON.stringify({ 'task.completed': [{ command: ['node', 'hook.mjs', secret], timeout: 1000 }] })
    });

    const confirm = vi.fn(async () => false);
    await expect(store.update('provider-review', { confirm })).rejects.toMatchObject({ code: 'PLUGIN_TRUST_DECLINED' });
    const prompt = confirm.mock.calls[0]![0];
    expect(prompt.capabilities).toEqual(['providers']);
    expect(prompt.details).toEqual([]);
    expect(prompt.changes).toEqual([
      { kind: 'hook', name: 'task.completed', before: expect.stringMatching(/^[0-9a-f]{64}$/), after: expect.stringMatching(/^[0-9a-f]{64}$/) }
    ]);
    expect(JSON.stringify(prompt)).not.toContain(secret);

    const nonInteractive = await store.update('provider-review').then(
      () => { throw new Error('expected PLUGIN_TRUST_REQUIRED'); },
      error => error as Error
    );
    expect(nonInteractive).toMatchObject({ code: 'PLUGIN_TRUST_REQUIRED', message: expect.stringContaining('需要信任以下能力：providers') });
    expect(nonInteractive.message).toContain('hook task.completed');
    expect(nonInteractive.message).toMatch(/[0-9a-f]{64} → [0-9a-f]{64}/);
    expect(nonInteractive.message).not.toContain(secret);
    expect(store.get('provider-review')).toEqual(original);
  });

  it('reports same-version local content replacement as changed', async () => {
    const source = join(temp, 'local');
    await writePlugin(source, declarative('local'));
    await store.install(source);
    await writePlugin(source, { 'commands/summary.md': 'new contents' });
    expect(await store.update('local')).toMatchObject({ changed: true });
    expect(await readFile(join(store.pluginDir('local'), 'commands/summary.md'), 'utf8')).toBe('总结 $ARGUMENTS');
    expect(await readFile(join(store.artifactDir('local', store.get('local').candidate), 'commands/summary.md'), 'utf8')).toBe('new contents');
    await store.activate('local');
    expect(await readFile(join(store.pluginDir('local'), 'commands/summary.md'), 'utf8')).toBe('new contents');
  });

  it.each(['directory', 'manifest', 'hooks'] as const)('repairs a candidate with damaged %s using the active review base', async damage => {
    const source = join(temp, 'recovery');
    await writePlugin(source, declarative('recovery', '1.0.0'));
    await store.install(source);
    const original = store.get('recovery');
    const activeRoot = store.pluginDir('recovery');
    await writePlugin(source, { ...declarative('recovery', '2.0.0'), 'commands/summary.md': 'recovered command' });
    const staged = await store.update('recovery', { yes: true });
    const candidate = staged.entry.candidate!;
    const candidateRoot = store.artifactDir('recovery', candidate);

    if (damage === 'directory') await rm(candidateRoot, { recursive: true, force: true });
    if (damage === 'manifest') await writePlugin(candidateRoot, { '.dutydeck-plugin/plugin.json': '{' });
    if (damage === 'hooks') await writePlugin(candidateRoot, { 'hooks/hooks.json': '{' });

    const repaired = await store.update('recovery', { yes: true });
    expect(repaired.entry.active).toEqual(original.active);
    expect(repaired.entry.candidate?.id).toBe(candidate.id);
    expect(store.pluginDir('recovery')).toBe(activeRoot);
    const loaded = await loadPluginDirectory(candidateRoot);
    expect(loaded.manifest.version).toBe('2.0.0');
    expect(loaded.commands).toEqual([expect.objectContaining({ name: 'summary', template: 'recovered command' })]);
    expect(await readFile(join(activeRoot, 'commands/summary.md'), 'utf8')).toBe('总结 $ARGUMENTS');
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

  const cli = async (action: Parameters<typeof runPluginCli>[0], args: string[], options: Parameters<typeof runPluginCli>[2] = {}, confirm: ((prompt: PluginTrustPrompt) => Promise<boolean>) | null = async () => false) => {
    let out = '';
    const ui = createCliUi({ stdout: { write: chunk => { out += chunk; } }, stderr: { write: () => {} }, color: false });
    // 只看外部插件：内置插件目录指向空目录。
    const result = await runPluginCli(action, args, { database: join(temp, 'data/dutydeck.db'), ...options }, { ui, cwd: temp, ...(confirm ? { confirm } : {}), builtinRoot: join(temp, 'no-builtin') });
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

  it('prints activation guidance after staging local content without a version bump', async () => {
    await writePlugin(join(temp, 'local'), declarative('local'));
    await cli('install', ['./local']);
    await writePlugin(join(temp, 'local'), { 'commands/summary.md': 'new contents' });
    const result = await cli('update', ['local'], {}, null);
    expect(result.out).toContain('dutydeck plugin activate');
    expect(result.out).not.toContain('已是最新');
  });

  it('includes command names and before/after digests in human and JSON update output without echoing command contents', async () => {
    await writePlugin(join(temp, 'local'), declarative('local'));
    await cli('install', ['./local']);
    await writePlugin(join(temp, 'local'), { 'commands/summary.md': 'new command output-secret' });

    const human = await cli('update', ['local'], {}, null);
    expect(human.out).toContain('command local:summary');
    expect(human.out).toMatch(/[0-9a-f]{64}.*[0-9a-f]{64}/);
    expect(human.out).not.toContain('output-secret');

    const machine = JSON.parse((await cli('update', ['local'], { json: true }, null)).out);
    expect(machine.plugins).toHaveLength(1);
    expect(machine.plugins[0].changes).toEqual([
      { kind: 'command', name: 'local:summary', before: expect.stringMatching(/^[0-9a-f]{64}$/), after: expect.stringMatching(/^[0-9a-f]{64}$/) }
    ]);
    expect(JSON.stringify(machine)).not.toContain('output-secret');
  });

  it('validate exits non-zero and lists issues', async () => {
    await writePlugin(join(temp, 'bad'), { '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'bad', extra: 1 }) });
    const result = await cli('validate', ['bad']);
    expect(result.ok).toBe(false);
    expect(result.out).toContain('.dutydeck-plugin/plugin.json');
  });

  it('inspects and tests a plugin source without installing it', async () => {
    await writePlugin(join(temp, 'inspectable'), declarative('inspectable'));
    const inspected = JSON.parse((await cli('inspect', ['inspectable'], { json: true })).out);
    expect(inspected.plugin).toMatchObject({ name: 'inspectable', capabilities: ['commands', 'triggers'] });
    expect(inspected.digest).toMatch(/^[0-9a-f]{64}$/);
    const tested = JSON.parse((await cli('test', ['inspectable'], { json: true })).out);
    expect(tested).toMatchObject({ ok: true, active: true, summary: { commands: ['inspectable:summary'] } });
    expect(JSON.parse((await cli('list', [], { json: true })).out).plugins).toEqual([]);
  });
});
