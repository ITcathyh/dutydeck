import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createRepositories } from '@dutydeck/storage';
import { RuntimeError, type PluginToolIdentity } from '@dutydeck/shared';
import { createPluginManagementAuthorizer } from './management-auth.js';
import { RelayCapabilityRegistry } from '@dutydeck/relay';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../app.js';
import { PluginBusinessToolRegistry } from './business-tools.js';
import { PluginBusinessToolService } from './tool-service.js';
import { PluginToolLedger } from './tool-ledger.js';
import { PluginToolGrants } from './tool-grants.js';
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const work of cleanup.splice(0).reverse()) await work(); });
async function harness(mode: 'local' | 'token' = 'token') {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' }); cleanup.push(() => repos.close());
  const registry = new PluginBusinessToolRegistry();
  const identity: PluginToolIdentity = { sessionId: 's', taskId: 't', attemptId: 'a', runId: 'r', actor: { kind: 'installation_owner', id: 'installation_owner' }, channel: 'web', cwd: '/tmp/worktree', workspaceRoot: '/tmp/project' };
  const schema = { type: 'object' as const, properties: { ticket: { type: 'string' as const } }, required: ['ticket'], additionalProperties: false as const };
  const query = vi.fn(async () => ({ title: 'Ticket' }));
  let lost = false;
  const execute = vi.fn(async () => { if (lost) throw new Error('lost response'); return { receipt: 'closed' }; });
  const reconcile = vi.fn(async () => ({ status: 'succeeded' as const, receipt: 'verified' }));
  for (const [kind, name, handler] of [['query', 'get', query], ['action', 'close', execute]] as const) registry.register('tickets', 'global', '1', kind, { name, description: name, version: '1', inputSchema: schema, resource: input => `ticket:${(input as any).ticket}`, execute: handler, reconcile } as any);
  const binding = { bindingId: 'b', revision: 1, plugin: 'tickets', config: {}, getSecret: async () => undefined };
  const grants = new PluginToolGrants(repos.config);
  for (const tool of ['get', 'close']) await grants.set({ id: tool, toolId: `tickets/${tool}`, bindingId: 'b', actor: identity.actor, effects: [tool === 'get' ? 'read' : 'write'], resources: ['ticket:T1'], operations: ['invoke', 'reconcile'] });
  const service = new PluginBusinessToolService({ businessTools: registry, resolveBinding: async () => binding }, grants, new PluginToolLedger(repos.config), { resolve: async (token, turn) => {
    if (token !== 'session-capability' || turn !== 'attempt-capability') throw new RuntimeError('PLUGIN_TOOL_UNAUTHORIZED', 'denied', 401);
    return { identity, assertCurrent: async () => {} };
  } });
  const app = await buildApp({} as any, { auth: { mode, getToken: async () => 'owner-token', localOnly: mode === 'local' }, pluginBusinessTools: { service, grants, origin: 'http://127.0.0.1', authorize: createPluginManagementAuthorizer({ authEnabled: true, mode, getToken: async () => 'owner-token' }) } });
  cleanup.push(() => app.close());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as { port: number }; const url = `http://127.0.0.1:${address.port}`;
  return { app, url, grants, registry, identity, binding, schema, query, execute, reconcile, sessionToken: new RelayCapabilityRegistry(repos.sessions, url, 'test-signing-secret').tokenFor('s'), turnToken: randomBytes(32).toString('base64url'), lose: () => { lost = true; } };
}
it.each(['local', 'token'] as const)('actual %s app rejects task credentials for every grant management method', async mode => {
  const h = await harness(mode);
  const grant = { id: 'new-grant', toolId: 'tickets/close', bindingId: 'b', actor: { kind: 'installation_owner', id: 'installation_owner' }, effects: ['write'], resources: ['*'], operations: ['invoke'] };
  const credentials = [
    { authorization: `Bearer ${h.sessionToken}` },
    { authorization: `Bearer ${h.turnToken}` },
    { authorization: `Bearer ${h.sessionToken}`, 'x-dutydeck-tool-turn': h.turnToken },
    { authorization: 'Bearer owner-token', 'x-dutydeck-tool-turn': h.turnToken },
    { 'x-dutydeck-work-turn': h.turnToken },
    { 'x-dutydeck-result-turn': h.turnToken }
  ];
  for (const headers of credentials) for (const method of ['GET', 'PUT', 'DELETE'] as const) {
    const response = await fetch(`${h.url}/api/plugins/tool-grants${method === 'DELETE' ? '/get' : ''}`, { method, headers: { ...headers, ...(method === 'PUT' ? { 'content-type': 'application/json' } : {}) } as Record<string, string>, ...(method === 'PUT' ? { body: JSON.stringify(grant) } : {}) });
    expect([401, 403], JSON.stringify({ mode, method, headers, body: await response.text() })).toContain(response.status);
  }
  expect((await h.grants.list()).map(g => [g.id, g.enabled])).toEqual([['close', true], ['get', true]]);
  const headers = { authorization: 'Bearer owner-token', 'content-type': 'application/json' };
  expect((await fetch(`${h.url}/api/plugins/tool-grants`, { headers })).status).toBe(200);
  expect((await fetch(`${h.url}/api/plugins/tool-grants`, { method: 'PUT', headers, body: JSON.stringify(grant) })).status).toBe(200);
  expect((await fetch(`${h.url}/api/plugins/tool-grants/new-grant`, { method: 'DELETE', headers: { authorization: 'Bearer owner-token' } })).status).toBe(200);
  if (mode === 'local') expect((await fetch(`${h.url}/api/plugins/tool-grants`)).status).toBe(200);
});
it('official MCP client over real HTTP initializes, lists, queries, deduplicates and reconciles', async () => {
  const h = await harness();
  const client = new Client({ name: 'dutydeck-test', version: '1' }); cleanup.push(() => client.close());
  const transport = new StreamableHTTPClientTransport(new URL(`${h.url}/api/plugin-tools/mcp`), { requestInit: { headers: { authorization: 'Bearer session-capability', 'x-dutydeck-tool-turn': 'attempt-capability' } } });
  await client.connect(transport);
  expect((await client.listTools()).tools.map(t => t.name)).toEqual(['tickets__get', 'tickets__close', 'dutydeck_reconcile']);
  const query = await client.callTool({ name: 'tickets__get', arguments: { input: { ticket: 'T1' }, callId: 'q1' }, _meta: { actor: 'forged', workspaceRoot: '/forged' } });
  expect(query.structuredContent).toEqual({ output: { title: 'Ticket' } });
  expect(h.query).toHaveBeenCalledWith({ ticket: 'T1' }, expect.objectContaining({ identity: expect.objectContaining({ actor: { kind: 'installation_owner', id: 'installation_owner' }, cwd: '/tmp/worktree', workspaceRoot: '/tmp/project' }) }));
  const first = await client.callTool({ name: 'tickets__close', arguments: { input: { ticket: 'T1' }, callId: 'a1' } });
  const duplicate = await client.callTool({ name: 'tickets__close', arguments: { input: { ticket: 'T1' }, callId: 'a1' } });
  expect(duplicate.structuredContent).toEqual(first.structuredContent); expect(h.execute).toHaveBeenCalledTimes(1);
  expect((await client.callTool({ name: 'tickets__close', arguments: { input: { ticket: 'T1' } } })).isError).toBe(true);
  h.lose(); const unknown = await client.callTool({ name: 'tickets__close', arguments: { input: { ticket: 'T1' }, callId: 'a2' } });
  expect(unknown.structuredContent).toMatchObject({ status: 'unknown' });
  const checked = await client.callTool({ name: 'dutydeck_reconcile', arguments: { actionId: (unknown.structuredContent as any).actionId } });
  expect(checked.structuredContent).toMatchObject({ status: 'succeeded', receipt: 'verified' }); expect(h.execute).toHaveBeenCalledTimes(2); expect(h.reconcile).toHaveBeenCalledTimes(1);
  const badOrigin = await fetch(`${h.url}/api/plugin-tools/mcp`, { method: 'POST', headers: { authorization: 'Bearer session-capability', 'x-dutydeck-tool-turn': 'attempt-capability', origin: 'https://evil.test', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }); expect(badOrigin.status).toBe(403);
});

it('serves authorized summaries and direct descriptions while retaining the full legacy list', async () => {
  const h = await harness(); const headers = { authorization: 'Bearer session-capability', 'x-dutydeck-tool-turn': 'attempt-capability' };
  const get = (path: string) => h.app.inject({ method: 'GET', url: `/api/plugin-tools/${path}`, headers });
  const full = (await get('list')).json(); const summary = (await get('summary')).json();
  expect(full.tools[0].inputSchema).toBeDefined(); expect(summary.tools[0].inputSchema).toBeUndefined(); expect(summary.tools.map((tool: any) => tool.id)).toEqual(full.tools.map((tool: any) => tool.id));
  expect((await get('describe?tool=tickets%2Fget')).json()).toMatchObject({ tool: { id: 'tickets/get', inputSchema: full.tools[0].inputSchema }, truncated: false });
  await h.grants.revoke('get');
  expect((await get('describe?tool=tickets%2Fget')).statusCode).toBe(403);
  expect((await get('manual?tool=tickets%2Fget&id=guide')).statusCode).toBe(403);
  expect((await get('describe?tool=unknown%2Fget')).statusCode).toBe(404);
  expect((await h.app.inject({ method: 'GET', url: '/api/plugin-tools/summary' })).statusCode).toBe(401);
});


it('measures response characters and HTTP round trips for two tools and 50 complex tools', async () => {
  const h = await harness(); let requests = 0;
  const read = async (path: string) => {
    requests++;
    const response = await fetch(`${h.url}/api/plugin-tools/${path}`, { headers: { authorization: 'Bearer session-capability', 'x-dutydeck-tool-turn': 'attempt-capability' } });
    const body = await response.text(); expect(response.status).toBe(200);
    return { value: JSON.parse(body), chars: body.length };
  };
  const small = await read('list'); expect(requests).toBe(1);
  expect(small.value.tools.map((tool: any) => tool.inputSchema)).toEqual([h.schema, h.schema]);
  const complex = { type: 'object' as const, properties: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field${index}`, { type: 'string' as const, description: `Parameter ${index}: ${'Detailed purpose. '.repeat(8)}`, maxLength: 1000 }])), additionalProperties: false as const };
  for (let index = 0; index < 48; index++) {
    const name = `action${index}`;
    h.registry.register('tickets', 'global', '1', 'action', { name, description: 'Complex action', version: '1', inputSchema: complex, resource: () => '*', execute: async () => ({ receipt: 'unused' }) });
    await h.grants.set({ id: name, toolId: `tickets/${name}`, bindingId: 'b', actor: h.identity.actor, effects: ['write'], resources: ['*'], operations: ['invoke'] });
  }
  requests = 0; const full = await read('list'); expect(requests).toBe(1); expect(full.value.tools).toHaveLength(50);
  requests = 0; const summary = await read('summary'); expect(requests).toBe(1);
  const described = await read('describe?tool=tickets%2Faction0'); expect(requests).toBe(2); expect(described.value.tool.inputSchema).toEqual(complex);
  requests = 0; await read('describe?tool=tickets%2Faction0'); expect(requests).toBe(1);
  expect(summary.chars).toBeLessThan(full.chars / 4);
  console.info(`catalog HTTP benchmark synthetic: two tools full=${small.chars} chars/1 request; 50 tools full=${full.chars} chars/1 request, summary=${summary.chars} chars/1 request; summary+describe=2 requests, known-ID describe=1 request`);
});
