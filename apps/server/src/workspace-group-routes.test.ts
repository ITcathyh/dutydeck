import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { createRepositories } from '@dutydeck/storage';
import { WorkspaceOrganizationService, type WorkspaceOrganizationListedSession } from './workspace-organization.js';

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const repositories: Array<ReturnType<typeof createRepositories>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const repository of repositories.splice(0)) repository.close();
});

const session = (id: string, cwd: string, extra: Partial<WorkspaceOrganizationListedSession> = {}): WorkspaceOrganizationListedSession =>
  ({ id, cwd, ...extra }) as WorkspaceOrganizationListedSession;

const setup = (sessions: WorkspaceOrganizationListedSession[], authorize: (request: unknown) => boolean = () => true) => {
  const repos = createRepositories(':memory:'); repositories.push(repos);
  const service = new WorkspaceOrganizationService({ config: repos.config, listSessions: async () => sessions });
  const listSessions = vi.fn(async () => sessions);
  // runtime 仅需提供 listSessions；service 注入的是同一会话集。
  const runtime = { listSessions } as never;
  return buildApp(runtime, { workspaceGroups: { service, authorize: authorize as never } });
};

describe('workspace group routes', () => {
  it('returns the empty snapshot and keeps archived sessions while excluding work_item', async () => {
    const app = await setup([
      session('s1', '/data/repo-a'),
      session('s2', '/data/repo-a', { archivedAt: '2026-09-20T00:00:00.000Z' }),
      session('w1', '/data/repo-a', { source: 'work_item' })
    ]); apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/api/workspace-groups' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.organization).toEqual({ groups: [], directoryGroups: {}, sessionGroups: {} });
    expect(body.workspaces.find((group: { id: string }) => group.id === '/data/repo-a').sessionIds).toEqual(['s1', 's2']);
  });

  it('supports the full create/rename/assign/reset/delete cycle', async () => {
    const app = await setup([session('s1', '/data/repo-a'), session('s2', '/data/repo-b')]); apps.push(app);

    const created = await app.inject({ method: 'POST', url: '/api/workspace-groups', payload: { name: ' 重点项目 ' } });
    expect(created.statusCode).toBe(200);
    const groupId = created.json().createdGroupId;
    expect(groupId).toMatch(/^wg_/);
    expect(created.json().organization.groups).toEqual([{ id: groupId, name: '重点项目' }]);

    const renamed = await app.inject({ method: 'PATCH', url: `/api/workspace-groups/${groupId}`, payload: { name: '改名后' } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().organization.groups[0].name).toBe('改名后');

    const assigned = await app.inject({
      method: 'PUT', url: '/api/workspace-groups/assignments',
      payload: { groupId, sessionIds: ['s1'], directories: ['/data/repo-b/'] }
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().workspaces.find((group: { id: string }) => group.id === groupId).sessionIds).toEqual(['s1', 's2']);

    const reset = await app.inject({
      method: 'PUT', url: '/api/workspace-groups/assignments',
      payload: { groupId: null, sessionIds: ['s1'], directories: ['/data/repo-b'] }
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().organization.sessionGroups).toEqual({});
    expect(reset.json().organization.directoryGroups).toEqual({});

    const deleted = await app.inject({ method: 'DELETE', url: `/api/workspace-groups/${groupId}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().organization.groups).toEqual([]);
  });

  it('rejects strict-schema violations and invalid input with 400', async () => {
    const app = await setup([session('s1', '/data/repo-a')]); apps.push(app);
    const created = await app.inject({ method: 'POST', url: '/api/workspace-groups', payload: { name: 'G', unexpected: 1 } });
    const groupId = created.json().createdGroupId;

    expect((await app.inject({ method: 'POST', url: '/api/workspace-groups', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/workspace-groups', payload: { name: 3 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `/api/workspace-groups/${groupId}`, payload: { name: 'G', x: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/workspace-groups/assignments', payload: { groupId } })).statusCode).toBe(400);
    expect((await app.inject({
      method: 'PUT', url: '/api/workspace-groups/assignments',
      payload: { groupId, directories: ['relative/x'] }
    })).statusCode).toBe(400);
  });

  it('maps unknown group and sessions to 404 and duplicate names to 409', async () => {
    const app = await setup([session('s1', '/data/repo-a')]); apps.push(app);
    await app.inject({ method: 'POST', url: '/api/workspace-groups', payload: { name: '同名' } });
    expect((await app.inject({ method: 'POST', url: '/api/workspace-groups', payload: { name: '同名' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PATCH', url: '/api/workspace-groups/wg_nope', payload: { name: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/workspace-groups/wg_nope' })).statusCode).toBe(404);
    expect((await app.inject({
      method: 'PUT', url: '/api/workspace-groups/assignments', payload: { groupId: 'wg_nope', sessionIds: ['s1'] }
    })).statusCode).toBe(404);
    const groupId = (await app.inject({ method: 'POST', url: '/api/workspace-groups', payload: { name: 'G' } })).json().createdGroupId;
    expect((await app.inject({
      method: 'PUT', url: '/api/workspace-groups/assignments', payload: { groupId, sessionIds: ['missing'] }
    })).statusCode).toBe(404);
  });

  it('requires installation-owner authorization for reads and writes and fails closed when unwired', async () => {
    const denied = await setup([session('s1', '/data/repo-a')], () => false); apps.push(denied);
    expect((await denied.inject({ method: 'GET', url: '/api/workspace-groups' })).statusCode).toBe(403);
    expect((await denied.inject({ method: 'POST', url: '/api/workspace-groups', payload: { name: 'X' } })).statusCode).toBe(403);
    expect((await denied.inject({ method: 'PUT', url: '/api/workspace-groups/assignments', payload: { groupId: null, sessionIds: ['s1'] } })).statusCode).toBe(403);
    await denied.close(); apps.pop();

    const repos = createRepositories(':memory:'); repositories.push(repos);
    const service = new WorkspaceOrganizationService({ config: repos.config, listSessions: async () => [] });
    const unwired = await buildApp({ listSessions: async () => [] } as never); apps.push(unwired);
    // options 未注入：fail closed，而不是放行。
    expect((await unwired.inject({ method: 'GET', url: '/api/workspace-groups' })).statusCode).toBe(403);
  });

  it('is blocked by browser auth middleware before reaching the owner gate (401 without token)', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    const service = new WorkspaceOrganizationService({ config: repos.config, listSessions: async () => [] });
    const app = await buildApp({ listSessions: async () => [] } as never, {
      auth: { mode: 'token', localOnly: false, getToken: async () => 'secret-token' },
      workspaceGroups: { service, authorize: () => true }
    }); apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/api/workspace-groups' })).statusCode).toBe(401);
    // 带 token 后通过 auth 中间件，进入路由。
    expect((await app.inject({ method: 'GET', url: '/api/workspace-groups', headers: { authorization: 'Bearer secret-token' } })).statusCode).toBe(200);
  });
});
