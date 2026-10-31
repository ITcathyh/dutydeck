import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createRepositories } from '@dutydeck/storage';
import { RelayCapabilityRegistry } from '@dutydeck/relay';
import { agentConfigSchema, RuntimeError } from '@dutydeck/shared';
import type { DriverFactory, RuntimeOptions } from '@dutydeck/runtime';
import { AUTH_PASSWORD_CONFIG_KEY, getAuthToken, hashPassword, issueBrowserSession } from './auth/auth.js';
import { startLocalServer } from './service.js';
import { larkBotsConfigKey } from './lark/config.js';
import { LarkMemoryStore, larkMemoryScope } from './lark/memory.js';
import { PROJECT_MEMORY_KEY, ProjectMemoryService } from './project-memory.js';
import { registerMemoryManagementRoutes } from './memory-management-routes.js';
import { registerProjectMemoryRoutes } from './project-memory-routes.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const work of cleanup.splice(0).reverse()) await work(); });
const turnHeaders = ['x-dutydeck-tool-turn', 'x-dutydeck-work-turn', 'x-dutydeck-result-turn'];
const scope = larkMemoryScope('cli_memory_auth', 'oc_auth', 'group');
const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('TCP port missing'); server.close(() => resolve(address.port));
  });
});
it.each(['local', 'open', 'token'] as const)('real %s service refuses task identities on every memory management endpoint', async mode => {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-memory-auth-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const database = join(root, 'state.db'); const port = await freePort();
  const repos = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' }); cleanup.push(() => repos.close());
  const passwordHash = await hashPassword('isolated-test-password');
  await repos.config.set(AUTH_PASSWORD_CONFIG_KEY, passwordHash);
  await repos.config.set(larkBotsConfigKey, JSON.stringify([{ appId: scope.appId, appSecret: 'fixture-secret', workspace: root, memoryEnabled: true, memoryAutoExtract: false, defaultAgentId: 'fake' }]));
  const service = await startLocalServer({ webRoot: root, env: { PATH: process.env.PATH, HOME: root, NODE_ENV: 'test', DUTYDECK_HOST: mode === 'local' ? '127.0.0.1' : '0.0.0.0', DUTYDECK_PORT: String(port), DUTYDECK_DEFAULT_CWD: root, DUTYDECK_DATABASE_URL: database, DUTYDECK_DAEMON_DIR: join(root, 'daemon'), DUTYDECK_AUTH: mode === 'open' ? 'false' : 'true', DUTYDECK_UNSAFE_NO_AUTH: mode === 'open' ? 'true' : undefined, DUTYDECK_DISABLE_LARK_LISTENER: 'true', DUTYDECK_AGENTS_JSON: '[]' } });
  cleanup.push(() => service.close());
  const runtime = service.runtime as unknown as { factory: DriverFactory; options: RuntimeOptions };
  runtime.options.probe = () => ({ protocol: 'acp', available: true, pause: false, resume: true });
  runtime.factory = () => ({ isIdle: () => true, hasBackgroundWork: () => false, start: async () => {}, stop: async () => {}, isStopped: async () => true, interrupt: async () => {}, send: async () => {} });
  await repos.agents.save(agentConfigSchema.parse({ id: 'fake', name: 'Fake', command: 'fake', protocol: 'acp', cwd: root }));
  const session = await service.runtime.start({ agentId: 'fake' });
  const lark = await service.runtime.start({ agentId: 'fake', source: 'lark', sourceId: `${scope.appId}:${scope.chatId}:group` });
  const base = `http://127.0.0.1:${port}`;
  const ownerToken = await getAuthToken(repos.config);
  const browserSession = issueBrowserSession(passwordHash);
  const owner = { authorization: `Bearer ${mode === 'open' ? browserSession : ownerToken}` };
  const request = (path: string, method = 'GET', headers: Record<string, string> = owner, body?: unknown) => fetch(`${base}${path}`, { method, headers: { origin: base, ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const created = await request('/api/project-memory', 'POST', owner, { name: 'Owner project' }); expect(created.status).toBe(200);
  const projectId = (await created.json()).project.id;
  const project = await (await request(`/api/project-memory/${projectId}`)).json();
  const added = await request(`/api/project-memory/${projectId}/entries`, 'POST', owner, { content: 'Project fact', expectedFingerprint: project.fingerprint }); expect(added.status).toBe(200);
  const entryId = (await added.json()).entry.id;
  expect((await request(`/api/sessions/${session.id}/project-memory`, 'PUT', owner, { projectId })).status).toBe(200);
  const store = new LarkMemoryStore(repos.config); const memory = await store.add(scope, { content: '群记忆', source: 'user' });
  expect((await request(`/api/sessions/${lark.id}/memory-pool`)).status).toBe(200);
  expect((await request('/api/project-memory', 'GET', { authorization: `Bearer ${browserSession}` })).status).toBe(200);
  expect((await request('/api/project-memory', 'GET', {})).status).toBe(mode === 'token' ? 401 : 200);

  const sessionToken = new RelayCapabilityRegistry(repos.sessions, base, 'fixture-signing-secret').tokenFor(session.id);
  const attemptToken = randomBytes(32).toString('base64url');
  const credentials = [
    { label: 'session Bearer', headers: { authorization: `Bearer ${sessionToken}` } },
    { label: 'raw attempt Bearer', headers: { authorization: `Bearer ${attemptToken}` } },
    ...turnHeaders.flatMap(header => [
      { label: header, headers: { [header]: attemptToken } },
      { label: `owner + ${header}`, headers: { ...owner, [header]: attemptToken } },
      { label: `session + ${header}`, headers: { authorization: `Bearer ${sessionToken}`, [header]: attemptToken } },
    ]),
  ];
  const operations = [
    { path: '/api/project-memory' }, { path: '/api/project-memory', method: 'POST', body: { name: 'Forbidden' } },
    { path: `/api/project-memory/${projectId}` }, { path: `/api/project-memory/${projectId}`, method: 'PATCH', body: { enabled: false } },
    { path: `/api/project-memory/${projectId}/entries`, method: 'POST', body: { content: 'Forbidden', expectedFingerprint: 'stale' } },
    { path: `/api/project-memory/${projectId}/entries/${entryId}`, method: 'PATCH', body: { content: 'Forbidden', expectedFingerprint: 'stale' } },
    { path: `/api/project-memory/${projectId}/entries/${entryId}`, method: 'DELETE' },
    { path: `/api/sessions/${session.id}/project-memory` }, { path: `/api/sessions/${session.id}/project-memory`, method: 'PUT', body: { projectId: null } },
    { path: `/api/sessions/${lark.id}/memory-pool` }, { path: `/api/sessions/${lark.id}/memory-pool/${memory.id}`, method: 'PATCH', body: { content: 'Forbidden', expectedFingerprint: 'stale' } },
    { path: `/api/sessions/${lark.id}/memory-pool/${memory.id}`, method: 'DELETE' },
  ];
  const before = await repos.config.get(PROJECT_MEMORY_KEY);
  for (const credential of credentials) for (const operation of operations) {
    const response = await request(operation.path, operation.method, credential.headers, operation.body);
    expect([401, 403], `${mode}: ${credential.label} ${operation.method ?? 'GET'} ${operation.path}`).toContain(response.status);
    await response.body?.cancel();
  }
  expect(await repos.config.get(PROJECT_MEMORY_KEY)).toBe(before);
  expect((await store.list(scope)).map(entry => entry.id)).toEqual([memory.id]);
  expect((await request(`/api/sessions/${session.id}/project-memory`)).status).toBe(200);
  expect((await request(`/api/sessions/${lark.id}/memory-pool`)).status).toBe(200);
}, 30_000);

it('route-level task guards reject capabilities even with permissive injected authorizers', async () => {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' }); cleanup.push(() => repos.close());
  const app = Fastify(); cleanup.push(() => app.close());
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof RuntimeError ? error.statusCode : 500).send({ message: error.message }));
  const authorize = vi.fn(async () => true); const authorizeSession = vi.fn(async () => {});
  registerMemoryManagementRoutes(app, { store: new LarkMemoryStore(repos.config), scope: async () => scope, authorize, sourceSession: async () => undefined, canViewSource: async () => false });
  registerProjectMemoryRoutes(app, { service: new ProjectMemoryService(repos.config, async id => ({ id })), authorize, authorizeSession });
  for (const headers of [{ authorization: 'Bearer v1.session-capability' }, ...turnHeaders.map(header => ({ authorization: 'Bearer owner', [header]: '' }))]) {
    expect((await app.inject({ url: '/api/project-memory', headers })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/sessions/one/project-memory', headers })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/sessions/one/memory-pool', headers })).statusCode).toBe(403);
  }
  expect(authorize).not.toHaveBeenCalled(); expect(authorizeSession).not.toHaveBeenCalled();
});
