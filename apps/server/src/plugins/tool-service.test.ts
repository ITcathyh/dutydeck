import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { RuntimeError, type PluginAction, type PluginToolBinding, type PluginToolIdentity } from '@dutydeck/shared';
import { PluginBusinessToolRegistry } from './business-tools.js';
import { PluginBusinessToolService } from './tool-service.js';
import { PluginToolLedger } from './tool-ledger.js';
import { PluginToolGrants } from './tool-grants.js';
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); vi.useRealTimers(); });
const alice: PluginToolIdentity = { sessionId: 'session', runId: 'run', taskId: 'task', attemptId: 'attempt', actor: { kind: 'channel', appId: 'app', id: 'alice' }, channel: 'lark', botAppId: 'app', chatId: 'chat', cwd: '/worktree', workspaceRoot: '/project' };
const schema = { type: 'object' as const, properties: { ticket: { type: 'string' as const } }, required: ['ticket'], additionalProperties: false as const };
async function harness() {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' }); cleanups.push(() => repos.close());
  const registry = new PluginBusinessToolRegistry();
  const execute = vi.fn(async () => ({ receipt: 'closed' }));
  const reconcile = vi.fn(async () => ({ status: 'succeeded' as const, receipt: 'confirmed' }));
  const definition: PluginAction = { name: 'close', description: 'Close', version: '1', inputSchema: schema, resource: input => `ticket:${(input as any).ticket}`, execute, reconcile };
  registry.register('tickets', 'bot:app', '1.0', 'action', definition);
  const binding: PluginToolBinding = { plugin: 'tickets', bindingId: 'binding', revision: 1, config: {}, getSecret: async () => undefined };
  const host = { businessTools: registry, resolveBinding: vi.fn(async () => binding as PluginToolBinding | undefined) };
  const grants = new PluginToolGrants(repos.config);
  const grant = { id: 'alice', toolId: 'tickets/close', bindingId: 'binding', actor: alice.actor, effects: ['write' as const], resources: ['ticket:T-1'], operations: ['invoke' as const, 'reconcile' as const] };
  await grants.set(grant);
  let identity = structuredClone(alice);
  const assertCurrent = vi.fn(async () => {});
  const authorities = { resolve: async () => ({ identity, assertCurrent }) };
  const ledger = new PluginToolLedger(repos.config);
  const service = new PluginBusinessToolService(host, grants, ledger, authorities, 25);
  return { repos, host, grants, grant, registry, ledger, service, execute, reconcile, binding, definition, assertCurrent, authorities, setIdentity: (value: PluginToolIdentity) => { identity = value; } };
}
describe('public business tools', () => {
  it('authorizes exact actor/tool/binding/effect/resource and rejects caller-supplied identity', async () => {
    const h = await harness();
    await expect(h.service.call('tickets/close', { ticket: 'T-2' }, 'call')).rejects.toMatchObject({ code: 'PLUGIN_TOOL_FORBIDDEN' });
    await expect(h.service.call('tickets/close', { ticket: 'T-1', actor: 'bob' }, 'call')).rejects.toMatchObject({ code: 'PLUGIN_TOOL_INVALID_INPUT' });
    await h.grants.set({ ...h.grant, effects: ['read'] });
    await expect(h.service.call('tickets/close', { ticket: 'T-1' }, 'call')).rejects.toMatchObject({ code: 'PLUGIN_TOOL_FORBIDDEN' });
    expect(h.execute).not.toHaveBeenCalled();
  });
  it('uses stable host namespace, rejects changed inputs, and does not reexecute across service restart', async () => {
    const h = await harness();
    const first = await h.service.call('tickets/close', { ticket: 'T-1' }, 'call') as any;
    expect(first.status).toBe('succeeded');
    const restarted = new PluginBusinessToolService(h.host, h.grants, new PluginToolLedger(h.repos.config), h.authorities);
    expect(await restarted.call('tickets/close', { ticket: 'T-1' }, 'call')).toEqual(first);
    await h.grants.set({ ...h.grant, resources: ['*'] });
    await expect(restarted.call('tickets/close', { ticket: 'T-2' }, 'call')).rejects.toMatchObject({ code: 'PLUGIN_TOOL_CALL_CONFLICT' });
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(await h.ledger.get(first.actionId)).toMatchObject({ plugin: 'tickets', handlerVersion: '1', bindingRevision: 1, original: alice });
    expect(h.host.resolveBinding).toHaveBeenCalledWith('tickets', expect.objectContaining({ cwd: '/project' }));
  });
  it('keeps one invocation when a Bot binding is replaced by a group binding', async () => {
    const h = await harness(); h.execute.mockRejectedValue(new Error('response lost'));
    const original = await h.service.call('tickets/close', { ticket: 'T-1' }, 'stable-call') as any;
    expect(original.status).toBe('unknown');
    h.binding.bindingId = 'group-binding';
    await h.grants.set({ ...h.grant, id: 'group-allow', bindingId: 'group-binding' });
    await expect(h.service.call('tickets/close', { ticket: 'T-1' }, 'stable-call')).rejects.toMatchObject({ code: 'PLUGIN_TOOL_CALL_CONFLICT' });
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect((await h.ledger.get(original.actionId))?.bindingId).toBe('binding');
  });
  it.each(['PLUGIN_UNAVAILABLE', 'PLUGIN_DISABLED', 'PLUGIN_BINDING_DISABLED'])('lists available tools when another package is unavailable: %s', async code => {
    const h = await harness();
    h.registry.register('off', 'global', '1', 'action', h.definition);
    h.host.resolveBinding.mockImplementation(async (plugin?: string) => { if (plugin === 'off') throw new RuntimeError(code, 'disabled', 403); return h.binding; });
    expect((await h.service.list()).tools.map(tool => tool.id)).toEqual(['tickets/close']);
    h.host.resolveBinding.mockRejectedValue(new Error('broken storage'));
    await expect(h.service.list()).rejects.toThrow('broken storage');
  });
  it('concurrent duplicate calls execute once', async () => {
    const h = await harness(); let release!: () => void;
    h.execute.mockImplementation(async () => { await new Promise<void>(r => { release = r; }); return { receipt: 'closed' }; });
    const first = h.service.call('tickets/close', { ticket: 'T-1' }, 'call');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const second = await h.service.call('tickets/close', { ticket: 'T-1' }, 'call') as any;
    expect(['sending', 'unknown']).toContain(second.status); release(); await first;
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
  it('does not execute after losing the durable sender claim race', async () => {
    const h = await harness();
    const originalClaim = h.ledger.claimExecution.bind(h.ledger);
    const releases: Array<() => void> = [];
    let claims = 0;
    vi.spyOn(h.ledger, 'claimExecution').mockImplementation(async (action, owner) => {
      const index = claims++;
      await new Promise<void>(resolve => { releases[index] = resolve; });
      return originalClaim(action, owner);
    });
    const second = new PluginBusinessToolService(h.host, h.grants, h.ledger, h.authorities, 25);
    const firstRun = h.service.call('tickets/close', { ticket: 'T-1' }, 'race-call');
    const secondRun = second.call('tickets/close', { ticket: 'T-1' }, 'race-call');
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[0]!();
    const first = await firstRun;
    releases[1]!();
    const duplicate = await secondRun;
    expect(h.execute).toHaveBeenCalledOnce();
    expect(first.status).toBe('succeeded');
    expect(duplicate.status).toBe('succeeded');
  });
  it('unknown requires explicit reconciliation and original plus current permissions', async () => {
    const h = await harness(); h.execute.mockRejectedValue(new Error('PRIVATE_ERROR_CANARY'));
    const action = await h.service.call('tickets/close', { ticket: 'T-1' }, 'call') as any;
    expect(action.status).toBe('unknown'); expect(JSON.stringify(action)).not.toContain('CANARY');
    await h.service.call('tickets/close', { ticket: 'T-1' }, 'call'); expect(h.execute).toHaveBeenCalledTimes(1); expect(h.reconcile).not.toHaveBeenCalled();
    const bob = { ...alice, actor: { kind: 'channel' as const, appId: 'app', id: 'bob' } }; h.setIdentity(bob);
    await expect(h.service.reconcile(action.actionId)).rejects.toMatchObject({ code: 'PLUGIN_TOOL_FORBIDDEN' });
    await h.grants.set({ ...h.grant, id: 'bob', actor: bob.actor, operations: ['reconcile'] });
    await h.grants.revoke('alice');
    await expect(h.service.reconcile(action.actionId)).rejects.toMatchObject({ code: 'PLUGIN_TOOL_FORBIDDEN' });
    await h.grants.set(h.grant);
    expect(await h.service.reconcile(action.actionId)).toMatchObject({ status: 'succeeded' });
    expect(h.reconcile).toHaveBeenCalledWith(expect.objectContaining({ identity: bob, original: expect.objectContaining({ original: alice }) }));
  });
  it('reconciles a crashed unsent intent without executing it', async () => {
    const h = await harness();
    const pending = await h.ledger.begin({ id: 'pt_unsent', plugin: 'tickets', tool: 'close', handlerVersion: '1', bindingId: 'binding', bindingRevision: 1, scopeKey: 'lark:app:chat', original: alice, input: { ticket: 'T-1' }, inputDigest: 'digest', resource: 'ticket:T-1' });
    expect(await h.service.reconcile(pending.action.id)).toMatchObject({ status: 'suppressed', error: 'PLUGIN_TOOL_NOT_SENT' });
    expect(h.execute).not.toHaveBeenCalled(); expect(h.reconcile).not.toHaveBeenCalled();
  });
  it('refuses incompatible handler or binding after restart', async () => {
    const h = await harness(); h.execute.mockRejectedValue(new Error());
    const action = await h.service.call('tickets/close', { ticket: 'T-1' }, 'call') as any;
    h.definition.version = '2';
    await expect(h.service.reconcile(action.actionId)).rejects.toMatchObject({ code: 'PLUGIN_TOOL_INCOMPATIBLE_ACTION' });
    h.definition.version = '1'; h.binding.revision = 2;
    await expect(h.service.reconcile(action.actionId)).rejects.toMatchObject({ code: 'PLUGIN_TOOL_INCOMPATIBLE_ACTION' });
    expect(h.reconcile).not.toHaveBeenCalled();
  });
  it('checks disabled binding, current task and revocation before executing', async () => {
    const h = await harness(); h.host.resolveBinding.mockResolvedValue(undefined);
    await expect(h.service.call('tickets/close', { ticket: 'T-1' }, 'call')).rejects.toMatchObject({ code: 'PLUGIN_TOOL_BINDING_REQUIRED' });
    h.host.resolveBinding.mockResolvedValue(h.binding); h.assertCurrent.mockRejectedValue(new Error('expired'));
    await expect(h.service.call('tickets/close', { ticket: 'T-1' }, 'call')).rejects.toThrow('expired');
    expect(h.execute).not.toHaveBeenCalled();
  });
  it('timeout aborts plugin signal and late completion cannot change unknown to success', async () => {
    const h = await harness(); let signal!: AbortSignal; let release!: (value: { receipt: string }) => void;
    h.execute.mockImplementation((...args: any[]) => { signal = args[1].signal; return new Promise(r => { release = r; }); });
    const action = await h.service.call('tickets/close', { ticket: 'T-1' }, 'call') as any;
    expect(signal.aborted).toBe(true); expect(action.status).toBe('unknown');
    await expect(h.service.reconcile(action.actionId)).rejects.toMatchObject({ code: 'PLUGIN_TOOL_ACTION_BUSY' });
    release({ receipt: 'late' }); await Promise.resolve();
    expect((await h.ledger.get(action.actionId))?.status).toBe('unknown');
  });
  it('uses the durable reconciliation lease across service instances', async () => {
    const h = await harness(); h.execute.mockRejectedValue(new Error('response lost'));
    const action = await h.service.call('tickets/close', { ticket: 'T-1' }, 'lease-call') as any;
    let release!: () => void;
    h.reconcile.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return { status: 'succeeded' as const, receipt: 'confirmed' }; });
    const second = new PluginBusinessToolService(h.host, h.grants, new PluginToolLedger(h.repos.config), h.authorities, 25);
    const firstRun = h.service.reconcile(action.actionId);
    const secondRun = second.reconcile(action.actionId);
    const resultsPromise = Promise.allSettled([firstRun, secondRun]);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    const results = await resultsPromise;
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: expect.objectContaining({ code: 'PLUGIN_TOOL_ACTION_BUSY' }) });
    expect(h.reconcile).toHaveBeenCalledOnce();
  });
  it('query schema is serialized and outputs are JSON-bounded; private export registry is not exposed', async () => {
    const h = await harness();
    h.registry.register('tickets', 'global', '1', 'query', { ...h.definition, name: 'get', execute: async () => ({ title: 'hello' }) });
    await h.grants.set({ ...h.grant, id: 'get', toolId: 'tickets/get', effects: ['read'] });
    expect(await h.service.call('tickets/get', { ticket: 'T-1' }, 'query')).toEqual({ output: { title: 'hello' } });
    expect((await h.service.list()).tools.find(t => t.id === 'tickets/get')?.inputSchema).toEqual(schema);
    await expect(h.service.call('private-export/export-report', {}, 'export')).rejects.toMatchObject({ code: 'PLUGIN_TOOL_NOT_FOUND' });
  });
});
