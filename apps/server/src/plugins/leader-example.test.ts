import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { discoverSkills, setPluginSkillRoots } from '../skill-catalog.js';
import { prepareSkillPrompt } from '../skill-delivery.js';
import { PluginHost } from './host.js';
import { loadPluginDirectory, strictPluginIssues } from './manifest.js';
import { PluginStore } from './store.js';

const examplePlugin = resolve(import.meta.dirname, '../../../../examples/plugins/leader');
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('loads the leader example, resolves its skill by reference, and inlines only the declared references', async () => {
  const plugin = await loadPluginDirectory(examplePlugin);
  expect(plugin.manifest).toMatchObject({ name: 'leader-guide', skills: 'skills' });
  expect(await strictPluginIssues(plugin)).toEqual([]);

  const temp = await mkdtemp(join(tmpdir(), 'dutydeck-leader-example-'));
  cleanups.push(() => rm(temp, { recursive: true, force: true }));
  const store = new PluginStore(join(temp, 'data'));
  await store.install(examplePlugin, { yes: true, scope: 'bot:cli_leader' });
  const host = await PluginHost.load({ dataDir: store.dataDir, builtinRoot: join(temp, 'none') });
  expect(host.diagnostics).toEqual([]);
  cleanups.push(setPluginSkillRoots(scope => host.skillEntries(scope)));

  const workspace = join(temp, 'workspace');
  const catalog = await discoverSkills(workspace, { homeDirectory: temp, botAppId: 'cli_leader' });
  expect(catalog).toEqual([expect.objectContaining({
    ref: 'leader-guide/leader', name: 'leader', source: 'plugin',
    description: expect.stringContaining('Leader 指引'),
    resources: [{ path: 'references/decide-or-escalate.md', maxBytes: 8192 }, { path: 'references/acceptance.md', maxBytes: 8192 }]
  })]);
  // 没有绑到这个机器人的插件作用域，别的机器人看不到。
  expect(await discoverSkills(workspace, { homeDirectory: temp, botAppId: 'cli_other' })).toEqual([]);

  const prepared = await prepareSkillPrompt(workspace, 'plan the task', ['leader-guide/leader'], { homeDirectory: temp, botAppId: 'cli_leader' });
  const decide = await readFile(join(examplePlugin, 'references/decide-or-escalate.md'), 'utf8');
  const acceptance = await readFile(join(examplePlugin, 'references/acceptance.md'), 'utf8');
  const examples = await readFile(join(examplePlugin, 'references/escalation-examples.md'), 'utf8');
  expect(prepared.agentPrompt).toContain('上报格式');
  expect(prepared.agentPrompt).toContain(decide);
  expect(prepared.agentPrompt).toContain(acceptance);
  expect(prepared.agentPrompt).not.toContain(examples);
  expect(prepared.skillDeliveries).toEqual([expect.objectContaining({
    ref: 'leader-guide/leader', status: 'included',
    resources: [{ path: 'references/decide-or-escalate.md', digest: expect.any(String) }, { path: 'references/acceptance.md', digest: expect.any(String) }]
  })]);
});

it('lists every shipped file in package.json files', async () => {
  const pkg = JSON.parse(await readFile(join(examplePlugin, 'package.json'), 'utf8')) as { files: string[] };
  const shipped = (await readdir(examplePlugin)).filter(name => name !== 'package.json');
  expect([...pkg.files].sort()).toEqual(shipped.sort());
});
