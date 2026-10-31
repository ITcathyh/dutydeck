import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { PluginCommandIdentity } from '@dutydeck/shared';
import { PluginBusinessToolRegistry } from './business-tools.js';
import { PluginCommandRegistry } from './commands.js';
import { PluginCommandQueryService } from './command-query.js';
import { PluginToolGrants } from './tool-grants.js';
import { pluginQueryReplyText } from '../lark/plugin-commands.js';
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(close => close()); });
async function harness() {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' }); cleanup.push(() => repos.close());
  const registry = new PluginBusinessToolRegistry();
  const execute = vi.fn(async () => ({ status: 'open' }));
  const tool = { name: 'get', description: 'read', version: '1', commandOutput: 'chat' as const, inputSchema: { type: 'object' as const, properties: { ticket: { type: 'string' as const, minLength: 1 } }, required: ['ticket'], additionalProperties: false as const }, resource: (input: unknown) => `ticket:${(input as { ticket: string }).ticket}`, execute };
  registry.register('tickets', 'bot:app', '1', 'query', tool);
  const binding = { plugin: 'tickets', bindingId: 'b', revision: 1, config: {}, getSecret: async () => undefined };
  const grants = new PluginToolGrants(repos.config);
  const identity: PluginCommandIdentity = { kind: 'command', eventId: 'event', channel: 'lark', botAppId: 'app', chatId: 'chat', actor: { kind: 'channel', appId: 'app', id: 'alice' }, cwd: '/repo', workspaceRoot: '/repo' };
  await grants.set({ id: 'read', actor: identity.actor, toolId: 'tickets/get', bindingId: 'b', effects: ['read'], operations: ['invoke'], resources: ['ticket:T-1'] });
  const host = { businessTools: registry, resolveBinding: vi.fn(async () => binding) };
  const service = new PluginCommandQueryService(host, grants, 10);
  const command = new PluginCommandRegistry([{ name: 'tickets', scope: 'bot:app', commands: [{ name: 'ticket-status', template: '', query: { tool: 'get', argument: 'ticket' } }] }]).commands[0]!;
  const authority = { identity, assertCurrent: vi.fn(async () => {}) };
  return { registry, tool, execute, binding, host, service, command, authority, grants };
}
it('rejects private queries, write actions, wrong scope, missing arguments and unauthorized resources before execution', async () => {
  const h = await harness();
  await expect(h.service.call(h.command, '', h.authority)).rejects.toMatchObject({ code: 'PLUGIN_TOOL_INVALID_INPUT' });
  await expect(h.service.call(h.command, 'T-2', h.authority)).rejects.toMatchObject({ code: 'PLUGIN_TOOL_FORBIDDEN' });
  await expect(h.service.call(h.command, 'T-1', { ...h.authority, identity: { ...h.authority.identity, botAppId: 'other' } })).rejects.toMatchObject({ code: 'PLUGIN_COMMAND_QUERY_UNAVAILABLE' });
  h.registry.unregister('tickets'); h.registry.register('tickets', 'bot:app', '1', 'query', { ...h.tool, commandOutput: undefined });
  await expect(h.service.call(h.command, 'T-1', h.authority)).rejects.toMatchObject({ code: 'PLUGIN_COMMAND_QUERY_UNAVAILABLE' });
  h.registry.unregister('tickets'); h.registry.register('tickets', 'bot:app', '1', 'action', { ...h.tool, execute: async () => ({ receipt: 'write' }) });
  await expect(h.service.call(h.command, 'T-1', h.authority)).rejects.toMatchObject({ code: 'PLUGIN_COMMAND_QUERY_UNAVAILABLE' });
  expect(h.execute).not.toHaveBeenCalled();
});
it.each(['grant', 'binding', 'registry', 'identity'] as const)('suppresses output when %s is revoked during execution', async change => {
  const h = await harness();
  h.execute.mockImplementationOnce(async () => {
    if (change === 'grant') await h.grants.revoke('read');
    if (change === 'binding') h.host.resolveBinding.mockResolvedValue({ ...h.binding, revision: 2 });
    if (change === 'registry') h.registry.unregister('tickets');
    if (change === 'identity') h.authority.assertCurrent.mockRejectedValue(new Error('revoked'));
    return { status: 'private output must not escape' };
  });
  await expect(h.service.call(h.command, 'T-1', h.authority)).rejects.toThrow();
});
it('bounds output and elapsed time without leaking provider exceptions', async () => {
  const h = await harness();
  h.execute.mockRejectedValueOnce(new Error('secret-provider-token'));
  await expect(h.service.call(h.command, 'T-1', h.authority)).rejects.toMatchObject({ code: 'PLUGIN_TOOL_QUERY_FAILED', message: 'Query failed or exceeded its output/time budget' });
  h.execute.mockResolvedValueOnce({ status: 'x'.repeat(64_001) });
  await expect(h.service.call(h.command, 'T-1', h.authority)).rejects.toMatchObject({ code: 'PLUGIN_TOOL_QUERY_FAILED' });
  h.execute.mockImplementationOnce(() => new Promise(() => {}));
  await expect(h.service.call(h.command, 'T-1', h.authority)).rejects.toMatchObject({ code: 'PLUGIN_TOOL_QUERY_FAILED' });
});
it('clips one reply at the UTF-8 JSON budget, preserving astral characters and an explicit truncation notice', () => {
  const text = pluginQueryReplyText('😀\n"'.repeat(10_000));
  expect(Buffer.byteLength(JSON.stringify({ text }))).toBeLessThanOrEqual(16_000);
  expect(text).toContain('已截断'); expect(text).not.toContain('�');
  expect(pluginQueryReplyText('')).toBe('查询完成，未返回内容。');
});

it('honors the existing synchronous tool hook and rechecks resource grants at the delivery attempt', async () => {
  const h = await harness();
  const gated = new PluginCommandQueryService(h.host, h.grants, 30, { toolBeforeCall: async () => 'deny' });
  await expect(gated.call(h.command, 'T-1', h.authority)).rejects.toMatchObject({ code: 'PLUGIN_TOOL_DENIED' });
  expect(h.execute).not.toHaveBeenCalled();
  const deliver = vi.fn(async (_output, beforeSend: () => Promise<void>) => { await h.grants.revoke('read'); await beforeSend(); });
  await expect(h.service.call(h.command, 'T-1', h.authority, deliver)).rejects.toMatchObject({ code: 'PLUGIN_TOOL_FORBIDDEN' });
  expect(deliver).toHaveBeenCalledOnce();
});
