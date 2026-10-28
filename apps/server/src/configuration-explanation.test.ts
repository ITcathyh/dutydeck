import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { agentConfigSchema, canonicalExecutionJson, type Session, type TaskRequestV1 } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { explainConfiguration } from './configuration-explanation.js';
import { buildApp } from './app.js';
import { createCliProgram } from './cli-program.js';
import { runSettingsCli } from './settings-cli.js';
import { LarkGroupManager } from './lark/group-management.js';
import { saveLarkConfig } from './lark/config.js';
import { prepareSkillPrompt } from './skill-delivery.js';
import { PluginHost } from './plugins/host.js';
import { PluginStore } from './plugins/store.js';
import { PluginToolLedger } from './plugins/tool-ledger.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const hash = (value: unknown) => createHash('sha256').update(canonicalExecutionJson(value)).digest('hex');
async function fixture(origin: Partial<Session> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'configuration-explain-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repos = createRepositories(':memory:'); cleanups.push(() => repos.close());
  repos.execution.upgradeLegacy();
  const claim = repos.control.attachRuntime('explain-test'); cleanups.push(() => claim.release());
  const execution = repos.execution.bind(claim);
  const agent = agentConfigSchema.parse({ id: 'agent', name: 'Agent', command: process.execPath, protocol: 'pipe', model: 'A', env: { SECRET_VALUE: 'environment-body' }, cwd: root });
  await repos.agents.save(agent);
  const session: Session = { id: 's', runId: 'r', agentId: agent.id, model: 'A', cwd: root, permissionMode: 'ask', state: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  Object.assign(session, origin);
  execution.createSession(session);
  return { root, repos, execution, agent, session, options: { repositories: repos } };
}
const section = (value: Awaited<ReturnType<typeof explainConfiguration>>, phase: string) => value.sections.find(item => item.phase === phase)!;

it('uses accepted input and actual skill delivery, keeps history distinct after saved/session changes, and selects attempts strictly', async () => {
  const { root, repos, execution, agent, session, options } = await fixture();
  const skill = join(root, '.agents/skills/review/SKILL.md'); await mkdir(join(root, '.agents/skills/review'), { recursive: true });
  await writeFile(skill, '---\nname: review\ndescription: Review\n---\nNever emit secret-body.');
  const prepared = await prepareSkillPrompt(root, 'hello', [skill]);
  const content = { version: 2 as const, prompt: 'hello', executionContext: { agentPrompt: prepared.agentPrompt, skillDeliveries: prepared.skillDeliveries }, executionOptions: { model: 'A', permissionMode: 'ask' as const }, contentSources: [] };
  const request: TaskRequestV1 = { version: 1, namespace: 'runtime', key: 'one', sessionId: 's', actor: { kind: 'unspecified' }, prompt: 'hello', mode: 'queue', skills: [skill], options: {}, sources: [], sourcePayload: null };
  const task = execution.acceptTask({ sessionId: 's', runId: 'r' }, request, { ...content, digest: hash(content) }, 'back').task!;
  const attempt = execution.claimNext({ sessionId: 's', runId: 'r' })!.attempt!;
  await repos.agents.save({ ...agent, model: 'B' }); await repos.sessions.save({ ...(await repos.sessions.get(session.id))!, model: 'C' });
  const result = await explainConfiguration(options, 's', { taskId: task.id, attemptId: attempt.attemptId });
  expect(section(result, 'saved').fields).toContainEqual(expect.objectContaining({ key: 'model', value: 'B' }));
  expect(section(result, 'session').fields).toContainEqual(expect.objectContaining({ key: 'model', value: 'C' }));
  expect(section(result, 'attempt').fields).toEqual(expect.arrayContaining([
    expect.objectContaining({ key: 'model', value: 'A' }), expect.objectContaining({ key: 'cwd', status: 'unknown' }),
    expect.objectContaining({ key: 'agentId', status: 'unknown' }), expect.objectContaining({ key: 'skill.0', value: expect.stringContaining(prepared.skillDeliveries[0]!.digest) })
  ]));
  expect(JSON.stringify(result)).not.toMatch(/secret-body|environment-body|agentPrompt|SECRET_VALUE/);
  await expect(explainConfiguration(options, 's', { taskId: task.id, attemptId: 'another' })).rejects.toMatchObject({ code: 'ATTEMPT_NOT_FOUND' });
  await expect(explainConfiguration(options, 's', { taskId: 'foreign-task' })).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
  await expect(explainConfiguration(options, 'missing')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
});

it('adapts the real group resolver for override, clear, inherit and Bot tool ceilings without remote calls on explain', async () => {
  const { root, repos, options } = await fixture({ source: 'lark', sourceId: 'cli_one:oc_one:group:chat' });
  await saveLarkConfig(repos.config, repos.agents, { appId: 'cli_one', appSecret: 'bot-secret-body', defaultAgentId: 'agent', workspace: root, defaultModel: 'B', fullTrustConfirmed: true });
  const remote = vi.fn(async () => ({ items: [{ chatId: 'oc_one', name: 'Group' }], hasMore: false }));
  const groups = new LarkGroupManager(repos, { client: config => ({ getBotInfo: async () => ({ openId: 'ou_bot' }), checkApplicationIdentity: async () => ({ verified: true, reportedAppId: config.appId }), listChats: remote }) as any });
  await groups.sync('cli_one');
  const binding = await groups.save('cli_one', 'oc_one', { expectedRevision: 0, patch: { modelOverride: { mode: 'set', value: 'A' }, groupToolsOverride: { read: 'allow', discover: 'inherit', send: 'allow' } } });
  const source = async () => section(await explainConfiguration({ ...options, groups }, 's'), 'saved').fields.find(item => item.key === 'group.model');
  const calls = remote.mock.calls.length;
  expect(await source()).toMatchObject({ value: 'A', source: 'group_override' });
  const clear = await groups.save('cli_one', 'oc_one', { expectedRevision: binding.binding!.revision, patch: { modelOverride: { mode: 'clear' } } });
  expect(await source()).toMatchObject({ status: 'unset', source: 'group_clear' });
  await groups.save('cli_one', 'oc_one', { expectedRevision: clear.binding!.revision, patch: { modelOverride: { mode: 'inherit' } } });
  expect(await source()).toMatchObject({ value: 'B', source: 'bot_default' });
  expect(remote.mock.calls.length).toBe(calls);
  const result = await explainConfiguration({ ...options, groups }, 's');
  expect(section(result, 'saved').fields).toContainEqual(expect.objectContaining({ key: 'group.tools.send', value: false, source: 'bot_ceiling' }));
  expect(JSON.stringify(result)).not.toContain('bot-secret-body');
});

it('resolves current plugin revisions while retaining the original action call revision and hiding action inputs, receipts and secrets', async () => {
  const { root, repos, execution, options } = await fixture();
  const source = join(root, 'package'); await mkdir(join(source, '.dutydeck-plugin'), { recursive: true });
  await writeFile(join(source, '.dutydeck-plugin/plugin.json'), JSON.stringify({ name: 'sample', apiVersion: 1, bindingConfig: { password: { type: 'secret', description: 'Credential' } } }));
  const store = new PluginStore(join(root, 'data')); await store.install(source);
  store.secretProvider(true)!.writeExclusive('plugin.sample.one', Buffer.from('plugin-secret-body'));
  const host = await PluginHost.load({ dataDir: store.dataDir }); cleanups.push(() => host.dispose());
  const binding = host.bindings.save({ plugin: 'sample', workspaceRoot: root, enabled: true, config: {}, secrets: { password: 'plugin.sample.one' }, skills: [], expectedRevision: 0 }, host.active.find(item => item.entry.name === 'sample')!.plugin.manifest);
  const content = { version: 2 as const, prompt: 'hello', executionContext: { agentPrompt: 'hello' }, executionOptions: { permissionMode: 'ask' as const }, contentSources: [] };
  const request: TaskRequestV1 = { version: 1, namespace: 'runtime', key: 'call', sessionId: 's', actor: { kind: 'unspecified' }, prompt: 'hello', mode: 'queue', skills: [], options: {}, sources: [], sourcePayload: null };
  const task = execution.acceptTask({ sessionId: 's', runId: 'r' }, request, { ...content, digest: hash(content) }, 'back').task!;
  const attempt = execution.claimNext({ sessionId: 's', runId: 'r' })!.attempt!;
  await new PluginToolLedger(repos.config).begin({ id: 'action', plugin: 'sample', tool: 'write', handlerVersion: '1', bindingId: binding.id, bindingRevision: 1, scopeKey: 'scope', original: { sessionId: 's', taskId: task.id, attemptId: attempt.attemptId, runId: 'r', channel: 'web', actor: { kind: 'installation_owner', id: 'installation_owner' }, cwd: root, workspaceRoot: root }, input: 'private-input', inputDigest: hash('private-input'), resource: 'private-resource', receipt: 'private-receipt' });
  const { id: _id, revision: _revision, ...bindingInput } = binding;
  host.bindings.save({ ...bindingInput, expectedRevision: 1 }, host.active.find(item => item.entry.name === 'sample')!.plugin.manifest);
  const result = await explainConfiguration({ ...options, host }, 's', { taskId: task.id });
  expect(result.sections.find(item => item.title === '插件 · 当前解析预览')!.fields).toContainEqual(expect.objectContaining({ key: 'plugin.sample', revision: 2 }));
  expect(section(result, 'tool_call').fields[0]!.reason).toContain('revision 1');
  expect(JSON.stringify(result)).not.toMatch(/plugin-secret-body|private-input|private-resource|private-receipt|plugin.sample.one/);
  const current = host.bindings.list()[0]!;
  const { id: _currentId, revision: _currentRevision, ...currentInput } = current;
  host.bindings.save({ ...currentInput, enabled: false, expectedRevision: 2 });
  const disabled = await explainConfiguration({ ...options, host }, 's');
  expect(disabled.sections.find(item => item.title === '插件 · 当前解析预览')!.fields).toContainEqual(expect.objectContaining({ value: 'PLUGIN_BINDING_DISABLED', revision: 3 }));
});

it('serves one no-store HTTP result to browser and local CLI, denies task capabilities and missing authorization, and validates task/attempt selection', async () => {
  const { root, repos, options } = await fixture();
  const app = await buildApp({} as any, { configurationExplanation: { ...options, authorize: async request => request.headers.authorization === 'Bearer owner' } }); cleanups.push(() => app.close());
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(`${url}/api/sessions/s/configuration`, { headers: { authorization: 'Bearer owner' } });
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  const cli = await runSettingsCli('configuration-explain', { url, database: '/unused', sessionId: 's' }, { readToken: () => 'owner' });
  expect(cli.sections).toEqual((await response.json()).sections);
  const database = join(root, 'cli-token.sqlite');
  const db = new Database(database); db.exec('CREATE TABLE configs (key TEXT PRIMARY KEY, value TEXT)'); db.prepare('INSERT INTO configs VALUES (?, ?)').run('auth.accessToken', 'owner'); db.close();
  const require = createRequire(import.meta.url);
  const command = await promisify(execFile)(process.execPath, [require.resolve('tsx/cli'), join(import.meta.dirname, 'cli.ts'), 'settings', 'explain', '--session', 's', '--url', url, '--database', database], { cwd: root, env: { PATH: process.env.PATH, HOME: root }, timeout: 10_000 });
  expect(JSON.parse(command.stdout).sections).toEqual(cli.sections);
  for (const headers of [{}, { authorization: 'Bearer owner', 'x-dutydeck-tool-turn': 'task-capability' }, { authorization: 'Bearer v1.fake' }]) expect((await app.inject({ url: '/api/sessions/s/configuration', headers })).statusCode).toBe(403);
  expect((await app.inject({ url: '/api/sessions/s/configuration?attemptId=orphan', headers: { authorization: 'Bearer owner' } })).statusCode).toBe(400);
  expect((await app.inject({ url: '/api/sessions/s/configuration?taskId=foreign', headers: { authorization: 'Bearer owner' } })).statusCode).toBe(404);
  expect((await app.inject({ url: '/api/sessions/missing/configuration', headers: { authorization: 'Bearer owner' } })).statusCode).toBe(404);
  await expect(runSettingsCli('configuration-explain', { sessionId: 's', attemptId: 'orphan' })).rejects.toMatchObject({ code: 'SETTINGS_ARGUMENT_REQUIRED' });
  expect(await repos.config.get('unrelated')).toBeUndefined();
});

it('wires the CLI parser to its same read-only handler', async () => {
  const settings = vi.fn();
  await createCliProgram('test', { settings }).parseAsync(['node', 'dutydeck', 'settings', 'explain', '--session', 's', '--task', 't', '--attempt', 'a']);
  expect(settings).toHaveBeenCalledWith('configuration-explain', expect.objectContaining({ sessionId: 's', taskId: 't', attemptId: 'a' }));
});

it('leaves legacy execution options and missing skill history unknown even when current defaults are known', async () => {
  const repos = createRepositories(':memory:'); cleanups.push(() => repos.close());
  const time = new Date().toISOString();
  await repos.agents.save(agentConfigSchema.parse({ id: 'agent', name: 'Agent', command: process.execPath, model: 'A' }));
  await repos.sessions.save({ id: 's', runId: 'r', agentId: 'agent', cwd: '/tmp', model: 'A', state: 'idle', createdAt: time, updatedAt: time });
  await repos.tasks.save({ id: 'legacy', sessionId: 's', prompt: 'old-private-prompt', status: 'completed', createdAt: time, updatedAt: time });
  repos.execution.upgradeLegacy();
  const result = await explainConfiguration({ repositories: repos }, 's', { taskId: 'legacy' });
  expect(section(result, 'attempt').fields).toEqual(expect.arrayContaining(['model', 'permissionMode', 'skills'].map(key => expect.objectContaining({ key, status: 'unknown' }))));
  expect(JSON.stringify(result)).not.toContain('old-private-prompt');
  expect(section(result, 'tool_call').fields[0]).toMatchObject({ status: 'unknown' });
});
