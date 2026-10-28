import { afterEach, expect, it, vi } from 'vitest';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import { createRepositories } from '@dutydeck/storage';
import { RelayCapabilityRegistry } from '@dutydeck/relay';
import { installationOwnerTaskActor, type AgentConfig } from '@dutydeck/shared';
import { LarkAgentToolCapabilityRegistry } from '../lark/agent-tools.js';
import { TaskPluginToolIdentity } from './tool-identity.js';
import { buildApp } from '../app.js';
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const work of cleanup.splice(0).reverse()) await work(); });
async function harness(channel: 'web' | 'lark') {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' }); cleanup.push(() => repos.close());
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const runtime = new DutydeckRuntime(repos, { probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: (_config, _protocol, emit) => ({ start: async () => {}, resume: async () => {}, stop: async () => { release(); }, interrupt: async () => { release(); }, send: async () => { await gate; emit({ type: 'text', data: { text: 'done' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); } } satisfies AgentDriver) });
  const agent: AgentConfig = { id: 'fake', name: 'Fake', command: 'node', args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 60, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]); cleanup.push(async () => { release(); await runtime.shutdown(); });
  const session = await runtime.start({ agentId: 'fake', source: channel, ...(channel === 'lark' ? { sourceId: 'cli_app:oc_chat:group:user:ou_alice' } : {}) });
  if (channel === 'web') {
    const app = await buildApp(runtime, { executionPolicy: { authorize: async (_request, _sessionId, _boundary, action) => ({ allowed: true, action, source: 'owner' }) } }); cleanup.push(() => app.close());
    const result = await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/send`, payload: { prompt: 'query ticket' } }); expect(result.statusCode).toBe(202);
  } else await runtime.dispatch(session.id, 'query ticket', 'queue', 'query ticket', undefined, 'ou_alice', 'lark:cli_app:msg:1');
  await vi.waitFor(() => expect(runtime.getActiveTaskContext(session.id)?.attemptId).toBeTruthy());
  const active = runtime.getActiveTaskContext(session.id)!;
  const relay = new RelayCapabilityRegistry(repos.sessions, 'http://localhost', 'synthetic-secret');
  const turns = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://localhost', 'synthetic-turn-secret'); cleanup.push(() => turns.close());
  const identity = new TaskPluginToolIdentity(repos, relay, turns, runtime);
  return { repos, runtime, session, active, identity, token: relay.tokenFor(session.id), turn: turns.workbenchTurnToken(session.id, active.taskId, active.attemptId!), release };
}
it.each(['web', 'lark'] as const)('uses persisted %s actor and rejects stale/missing/other-session capabilities', async channel => {
  const h = await harness(channel);
  const authority = await h.identity.resolve(h.token, h.turn);
  expect(authority.identity.actor).toEqual(channel === 'web' ? { kind: 'installation_owner', id: installationOwnerTaskActor } : { kind: 'channel', appId: 'cli_app', id: 'ou_alice' });
  expect(authority.identity.channel).toBe(channel);
  if (channel === 'web') expect(authority.identity.chatId).toBeUndefined();
  await authority.assertCurrent();
  await expect(h.identity.resolve(undefined, h.turn)).rejects.toMatchObject({ code: 'PLUGIN_TOOL_UNAUTHORIZED' });
  await expect(h.identity.resolve(h.token, 'wrong')).rejects.toMatchObject({ code: 'PLUGIN_TOOL_TURN_EXPIRED' });
  h.release(); await vi.waitFor(() => expect(h.repos.execution.getAcceptedTask(h.active.taskId)?.task.status).toBe('completed'));
  await expect(authority.assertCurrent()).rejects.toMatchObject({ code: 'PLUGIN_TOOL_TURN_EXPIRED' });
});
it.each(['unspecified', 'automated', 'owner-in-channel', 'other-app'] as const)('rejects persisted invalid actor: %s', async scenario => {
  const h = await harness('lark'); const original = h.repos.execution.getAcceptedTask(h.active.taskId)!;
  const actor = scenario === 'unspecified' ? { kind: 'unspecified' } : scenario === 'owner-in-channel' ? { kind: 'installation_owner', id: installationOwnerTaskActor } : { kind: 'channel', appId: scenario === 'other-app' ? 'other' : 'cli_app', id: 'ou_alice' };
  vi.spyOn(h.repos.execution, 'getAcceptedTask').mockReturnValue({ ...original, request: { ...original.request!, actor: actor as any, ...(scenario === 'automated' ? { namespace: 'schedule' as const } : {}) } });
  await expect(h.identity.resolve(h.token, h.turn)).rejects.toMatchObject({ code: 'PLUGIN_TOOL_REQUESTER_REQUIRED' });
});

it('runs the actual CLI through current task identity, authorization and optional manual reads', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join, resolve } = await import('node:path');
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util'); const { createRequire } = await import('node:module');
  const { PluginBusinessToolRegistry } = await import('./business-tools.js'); const { PluginBusinessToolService } = await import('./tool-service.js');
  const { PluginToolGrants } = await import('./tool-grants.js'); const { PluginToolLedger } = await import('./tool-ledger.js');
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-tool-cli-identity-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const h = await harness('web');
  const registry = new PluginBusinessToolRegistry(); const execute = vi.fn(async () => null);
  registry.register('tickets', 'global', '1.0', 'query', { name: 'read', description: 'Read', version: '1', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, resource: () => '*', execute });
  const binding = { plugin: 'tickets', bindingId: 'b', revision: 1, config: {}, getSecret: async () => undefined };
  const grants = new PluginToolGrants(h.repos.config); await grants.set({ id: 'owner', toolId: 'tickets/read', bindingId: 'b', actor: { kind: 'installation_owner', id: installationOwnerTaskActor }, effects: ['read'], resources: ['*'], operations: ['invoke'] });
  await writeFile(join(root, 'guide.md'), 'Current task manual');
  const service = new PluginBusinessToolService({ businessTools: registry, resolveBinding: async () => binding, toolManuals: () => ({ root, version: '1.0', manuals: { read: { guide: { description: 'Guide', path: 'guide.md', maxBytes: 100 } } } }) }, grants, new PluginToolLedger(h.repos.config), h.identity);
  const app = await buildApp(h.runtime, { pluginBusinessTools: { service, grants, origin: 'http://127.0.0.1', authorize: async () => false } }); cleanup.push(() => app.close());
  await app.listen({ host: '127.0.0.1', port: 0 }); const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const cli = resolve(import.meta.dirname, '../cli.ts'); const loader = createRequire(import.meta.url).resolve('tsx');
  const run = (args: string[]) => promisify(execFile)(process.execPath, ['--import', loader, cli, 'tool', ...args, '--turn', h.turn], { cwd: root, env: { PATH: process.env.PATH, HOME: root, NODE_OPTIONS: '--conditions=development', dutydeck_relay_url: `${url}/api/relay`, dutydeck_relay_token: h.token }, timeout: 15_000 });
  expect(JSON.parse((await run(['list', '--summary'])).stdout).tools).toEqual([{ id: 'tickets/read', description: 'Read', version: '1', effect: 'read' }]);
  expect(JSON.parse((await run(['describe', 'tickets/read'])).stdout).tool.inputSchema.type).toBe('object');
  expect(JSON.parse((await run(['manual', 'tickets/read', 'guide'])).stdout).text).toBe('Current task manual');
  expect(execute).not.toHaveBeenCalled();
  h.release(); await vi.waitFor(() => expect(h.repos.execution.getAcceptedTask(h.active.taskId)?.task.status).toBe('completed'));
  await expect(run(['describe', 'tickets/read'])).rejects.toMatchObject({ stderr: expect.stringContaining('PLUGIN_TOOL_TURN_EXPIRED') });
}, 30_000);
