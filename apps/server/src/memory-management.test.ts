import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { RuntimeError, type MemoryJob } from '@dutydeck/shared';
import { LarkMemoryStore, larkMemoryFingerprint, larkMemoryScope } from './lark/memory.js';
import { registerMemoryManagementRoutes } from './memory-management-routes.js';
import { createCliProgram } from './cli-program.js';
import { runMemoryManagementCli } from './memory-management-cli.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const shared = larkMemoryScope('bot', 'oc_here', 'group');
async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-memory-manage-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'state.db');
  const repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' }); cleanups.push(() => repos.close());
  const other = createRepositories(path); cleanups.push(() => other.close());
  const store = new LarkMemoryStore(repos.config); const concurrent = new LarkMemoryStore(other.config);
  const app = Fastify(); cleanups.push(() => app.close());
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof RuntimeError ? error.statusCode : 500).send({ error: { code: (error as RuntimeError).code, message: error.message } }));
  registerMemoryManagementRoutes(app, { store,
    scope: async sessionId => sessionId === 'private' ? larkMemoryScope('bot', 'ou_private', 'p2p') : sessionId === 'per-group' ? larkMemoryScope('bot', 'oc_here', 'group', 'per-group') : shared,
    authorize: async request => { if (request.headers.authorization !== 'Bearer owner') throw new RuntimeError('DENIED', 'denied', 403); },
    sourceSession: async entry => entry.taskId === 'allowed-task' ? 'visible' : entry.sessionId,
    canViewSource: async (_request, sessionId) => sessionId === 'visible' });
  return { repos, store, concurrent, app };
}
it('manages the actual pool with search, authorized origins, CAS revisions and deletion without crossing scopes', async () => {
  const { store, concurrent, app } = await harness();
  const hidden = await store.add(shared, { content: '部署使用 pnpm', source: 'extraction', sessionId: 'hidden-session', taskId: 'hidden-task', messageId: 'hidden-message', chatId: 'oc_hidden', createdBy: 'hidden-actor' });
  const visible = await store.add(shared, { content: '测试使用 vitest', source: 'extraction', sessionId: 'background-extraction-session', taskId: 'allowed-task' });
  const headers = { authorization: 'Bearer owner' };
  expect((await app.inject('/api/sessions/s1/memory-pool')).statusCode).toBe(403);
  const list = await app.inject({ url: '/api/sessions/s1/memory-pool', headers });
  expect(list.statusCode).toBe(200);
  for (const secret of ['hidden-session', 'hidden-task', 'hidden-message', 'oc_hidden', 'hidden-actor', 'background-extraction-session']) expect(list.body).not.toContain(secret);
  expect(list.json().entries.find((entry: { id: string }) => entry.id === visible.id).origin).toEqual({ label: '来源会话', sessionId: 'visible', taskId: 'allowed-task' });
  const search = await app.inject({ url: '/api/sessions/s1/memory-pool?q=pnpm', headers });
  expect(search.json().entries.map((entry: { id: string }) => entry.id)).toEqual([hidden.id]);
  for (const session of ['private', 'per-group']) expect((await app.inject({ url: `/api/sessions/${session}/memory-pool`, headers })).json().entries).toEqual([]);
  const fingerprint = list.json().fingerprint;
  const updated = await app.inject({ method: 'PATCH', url: `/api/sessions/s1/memory-pool/${hidden.id}`, headers, payload: { content: '部署使用 npm', expectedFingerprint: fingerprint } });
  expect(updated.statusCode).toBe(200);
  const revised = updated.json().entry;
  expect(revised).toMatchObject({ source: 'user', createdBy: 'installation_owner', supersedes: [hidden.id] });
  await expect(concurrent.revise(shared, visible.id, { content: '不能覆盖', expectedFingerprint: fingerprint, actor: 'second-page' })).rejects.toMatchObject({ code: 'MEMORY_CONCURRENT_CHANGE' });
  expect((await store.listAll(shared)).find(entry => entry.id === hidden.id)).toMatchObject({ supersededBy: revised.id, deletedAt: expect.any(String) });
  const removed = await app.inject({ method: 'DELETE', url: `/api/sessions/s1/memory-pool/${revised.id}`, headers });
  expect(removed.statusCode).toBe(200);
  expect((await store.list(shared)).map(entry => entry.content)).toEqual(['测试使用 vitest']);
});
it('rejects secrets and stale background jobs after manual revisions and deletions with two real database connections', async () => {
  const { store, concurrent, repos } = await harness();
  const original = await store.add(shared, { content: '旧发布说明', source: 'extraction' });
  const versions = await store.jobVersions(shared);
  const job: MemoryJob = { id: 'memory_' + 'a'.repeat(64), scope: { appId: shared.appId, pool: shared.pool }, revision: 0, claimToken: 'claim', kind: 'extraction', mode: 'compatible', input: {}, inputDigest: 'b'.repeat(64), versions, sessionId: 'ses_memory_' + 'a'.repeat(64), sessionInput: { agentId: 'agent', source: 'lark-memory', sourceId: 'bot:groups:memory' }, requests: [], state: 'prepared', createdAt: new Date().toISOString() };
  await repos.memoryJobs.create(job);
  await repos.config.set('lark.memory.state.bot.groups', JSON.stringify({ v: 1, running: { token: 'claim' } }));
  const fingerprint = larkMemoryFingerprint(await store.list(shared));
  await expect(store.revise(shared, original.id, { content: 'password = secret', expectedFingerprint: fingerprint, actor: 'owner' })).rejects.toMatchObject({ code: 'MEMORY_CREDENTIAL_REJECTED' });
  const revised = await concurrent.revise(shared, original.id, { content: '人工修正发布说明', expectedFingerprint: fingerprint, actor: 'owner' });
  const late = () => store.applyJob(shared, repos.memoryJobs, job, [{ op: 'add', input: { content: '旧发布说明', source: 'extraction' } }], () => ({}), []);
  await expect(late()).rejects.toMatchObject({ code: 'MEMORY_CONCURRENT_CHANGE' });
  await concurrent.remove(shared, revised.id, 'owner');
  await expect(late()).rejects.toMatchObject({ code: 'MEMORY_CONCURRENT_CHANGE' });
  expect(await store.list(shared)).toEqual([]);
  expect((await repos.memoryJobs.get(job.scope, job.id))?.receipt).toBeUndefined();
});
it('uses the authenticated local HTTP path for CLI search and revision; errors preserve conflict details', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ fingerprint: 'version', entries: [] }), { status: 200 }));
  const dependencies = { readState: () => undefined, readToken: () => 'owner', fetcher };
  const target = { url: 'http://127.0.0.1:12345', database: '/tmp/isolated.db', session: 's/a' };
  await runMemoryManagementCli('pool-list', undefined, { ...target, query: '部署' }, dependencies);
  expect(fetcher).toHaveBeenLastCalledWith(new URL('http://127.0.0.1:12345/api/sessions/s%2Fa/memory-pool?q=%E9%83%A8%E7%BD%B2'), expect.objectContaining({ method: 'GET', headers: { authorization: 'Bearer owner' } }));
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ error: { code: 'MEMORY_CONCURRENT_CHANGE', message: 'reload' } }), { status: 409 }));
  await expect(runMemoryManagementCli('pool-revise', 'mem_00000001', { ...target, content: '修正', expectedFingerprint: 'stale' }, dependencies)).rejects.toMatchObject({ code: 'MEMORY_CONCURRENT_CHANGE', message: 'reload' });
});

it('parses explicit management selectors and concurrency versions without inferring the current pool', async () => {
  const memoryManagement = vi.fn(); const program = createCliProgram('test', { memoryManagement });
  await program.parseAsync(['node', 'dutydeck', 'memory', 'manage', 'pool-revise', 'mem_00000001', '--session', 's1', '--content', '修正', '--expected-fingerprint', 'read-version', '--url', 'http://127.0.0.1:12345', '--database', '/tmp/isolated.db']);
  expect(memoryManagement).toHaveBeenCalledWith('pool-revise', 'mem_00000001', expect.objectContaining({ session: 's1', content: '修正', expectedFingerprint: 'read-version', database: '/tmp/isolated.db' }));
});
