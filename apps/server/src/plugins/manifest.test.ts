import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPluginDirectory, parseCommandMarkdown, PluginValidationError } from './manifest.js';

const examplePlugin = resolve(import.meta.dirname, '../../../../examples/plugins/hello');

async function writePlugin(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

const issuesOf = async (root: string) => {
  try { await loadPluginDirectory(root); }
  catch (error) { if (error instanceof PluginValidationError) return error.issues; throw error; }
  throw new Error('expected validation to fail');
};

describe('loadPluginDirectory', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'dutydeck-plugin-manifest-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('loads the hello example with one command, one trigger and one hook', async () => {
    const plugin = await loadPluginDirectory(examplePlugin);
    expect(plugin.manifest.name).toBe('hello');
    expect(plugin.commands).toEqual([expect.objectContaining({ name: 'greet', argumentHint: '<名字>' })]);
    expect([...plugin.triggers.keys()]).toEqual(['ping']);
    expect(plugin.capabilities).toEqual(['hooks:task.received']);
  });

  it('a declarative plugin needs no trusted capabilities; agents do', async () => {
    await writePlugin(root, {
      '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'docs' }),
      'commands/summary.md': '---\ndescription: "总结"\n---\n总结 $ARGUMENTS',
      'skills/lint/SKILL.md': '---\nname: lint\ndescription: lint\n---\nbody'
    });
    const plugin = await loadPluginDirectory(root);
    expect(plugin.capabilities).toEqual([]);
    expect(plugin.commands).toEqual([{ name: 'summary', description: '总结', template: '总结 $ARGUMENTS' }]);
    expect(plugin.skillsDir).toBe(join(root, 'skills'));

    await writePlugin(root, { 'agents/reviewer.json': JSON.stringify({ id: 'reviewer', name: 'Reviewer', command: 'reviewer-agent' }) });
    const withAgent = await loadPluginDirectory(root);
    expect(withAgent.agents.map(agent => agent.id)).toEqual(['reviewer']);
    expect(withAgent.capabilities).toEqual(['agents']);
  });

  it('reports the file and field of every problem at once', async () => {
    await writePlugin(root, {
      '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'bad', agents: 'missing-agents' }),
      'commands/help.md': '内置命令重名',
      'commands/Bad.md': 'x',
      'commands/empty.md': '---\ndescription: x\n---\n',
      'triggers/ping.json': JSON.stringify({ auth: { type: 'token' }, target: { botAppId: '{{config.bot}}', chatId: 'oc' }, prompt: 'x' }),
      'triggers/broken.json': '{',
      'hooks/hooks.json': JSON.stringify({ 'task.received': [{ command: 'x' }] })
    });
    const issues = await issuesOf(root);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: '.dutydeck-plugin/plugin.json', field: 'agents' }),
      expect.objectContaining({ file: 'commands/help.md', message: expect.stringContaining('内置命令') }),
      expect.objectContaining({ file: 'commands/Bad.md' }),
      expect.objectContaining({ file: 'commands/empty.md' }),
      expect.objectContaining({ file: 'triggers/ping.json', field: 'target.botAppId' }),
      expect.objectContaining({ file: 'triggers/broken.json', message: expect.stringContaining('JSON') }),
      expect.objectContaining({ file: 'hooks/hooks.json', field: 'task.received.0.timeout' })
    ]));
  });

  it('rejects a bad manifest with the manifest path in the message', async () => {
    await writePlugin(root, { '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'Bad Name' }) });
    await expect(loadPluginDirectory(root)).rejects.toThrow(/\.dutydeck-plugin\/plugin\.json name/);
    await rm(join(root, '.dutydeck-plugin'), { recursive: true });
    await expect(loadPluginDirectory(root)).rejects.toThrow(/plugin\.json.*读取失败/);
  });

  it('refuses component paths that resolve outside the plugin', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'dutydeck-plugin-outside-'));
    try {
      await writePlugin(root, { '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'escape' }) });
      await symlink(outside, join(root, 'commands'));
      expect(await issuesOf(root)).toEqual([expect.objectContaining({ field: 'commands', message: expect.stringContaining('之外') })]);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it('marks hooks and providers as capabilities that need trust', async () => {
    await writePlugin(root, {
      '.dutydeck-plugin/plugin.json': JSON.stringify({ name: 'ci', providers: 'index.mjs' }),
      'index.mjs': 'export default () => {}',
      'hooks/hooks.json': JSON.stringify({ notify: [{ command: 'true', timeout: 1000 }], 'permission.request': [{ command: 'true', timeout: 1000 }] })
    });
    expect((await loadPluginDirectory(root)).capabilities).toEqual(['hooks:permission.request', 'hooks:notify', 'providers']);
  });

  it('parses command frontmatter', () => {
    expect(parseCommandMarkdown('---\ndescription: \'说明\'\nargument-hint: <x>\n---\n\nbody\n')).toEqual({ frontmatter: { description: '说明', 'argument-hint': '<x>' }, body: 'body' });
    expect(parseCommandMarkdown('no frontmatter')).toEqual({ frontmatter: {}, body: 'no frontmatter' });
  });
});
