import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { WORKSPACE_ORGANIZATION_CONFIG_KEY, WorkspaceOrganizationService, type WorkspaceOrganizationListedSession } from './workspace-organization.js';

const repositories: Array<ReturnType<typeof createRepositories>> = [];
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
});

const makeSession = (id: string, cwd: string, extra: Partial<WorkspaceOrganizationListedSession> = {}): WorkspaceOrganizationListedSession => ({
  id, cwd, source: undefined, ...extra
}) as WorkspaceOrganizationListedSession;

const createService = (sessions: WorkspaceOrganizationListedSession[], repos = createRepositories(':memory:')) => {
  if (!repositories.includes(repos)) repositories.push(repos);
  return { service: new WorkspaceOrganizationService({ config: repos.config, listSessions: async () => sessions }), repos };
};

describe('WorkspaceOrganizationService', () => {
  it('persists configuration across service instances backed by the same real repository', async () => {
    const sessions = [makeSession('s1', '/data/repo-a'), makeSession('s2', '/data/repo-b')];
    const { service, repos } = createService(sessions);
    const created = await service.createGroup('  中文组 ');
    const groupId = created.createdGroupId!;
    expect(groupId).toMatch(/^wg_/);
    expect(created.workspaces.find(group => group.id === groupId)).toMatchObject({ name: '中文组', custom: true });

    // 全新 service 实例、同一份 SQLite 数据。
    const reloaded = createService(sessions, repos).service;
    const snapshot = await reloaded.getSnapshot();
    expect(snapshot.organization.groups).toEqual([{ id: groupId, name: '中文组' }]);
    expect(await repos.config.get(WORKSPACE_ORGANIZATION_CONFIG_KEY)).toBe(JSON.stringify(snapshot.organization));
  });

  it('merges worktree sessions with their source by default and applies directory rules to future sessions', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    const sessions = [
      makeSession('s1', '/data/repo-a'),
      makeSession('s2', '/data/.worktrees/wt2', { workspaceSourceCwd: '/data/repo-a' })
    ];
    const service = createService(sessions, repos).service;
    const before = await service.getSnapshot();
    expect(before.workspaces.find(group => group.id === '/data/repo-a')!.sessionIds).toEqual(['s1', 's2']);

    const { createdGroupId } = await service.createGroup('A 组');
    const bound = await service.assign({ groupId: createdGroupId, directories: ['/data/repo-a/'] });
    expect(bound.workspaces.find(group => group.id === createdGroupId)!.sessionIds).toEqual(['s1', 's2']);

    // 规则对未来同目录任务继承：新 service 实例 + 多一个同目录任务，共用同一份配置。
    const grown = createService([...sessions, makeSession('s3', '/data/repo-a')], repos).service;
    const inherited = await grown.getSnapshot();
    expect(inherited.workspaces.find(group => group.id === createdGroupId)!.sessionIds).toEqual(['s1', 's2', 's3']);
  });

  it('lets session overrides win over directory rules and restores them on reset', async () => {
    const { service } = createService([makeSession('s1', '/data/repo-a'), makeSession('s2', '/data/repo-a')]);
    const groupA = (await service.createGroup('A')).createdGroupId!;
    const groupB = (await service.createGroup('B')).createdGroupId!;
    await service.assign({ groupId: groupA, directories: ['/data/repo-a'] });
    await service.assign({ groupId: groupB, sessionIds: ['s1'] });

    const moved = await service.getSnapshot();
    expect(moved.workspaces.find(group => group.id === groupB)!.sessionIds).toEqual(['s1']);
    expect(moved.workspaces.find(group => group.id === groupA)!.sessionIds).toEqual(['s2']);

    // 重置单任务覆盖：恢复目录规则；B 组仍存在但为空。
    const reset = await service.assign({ groupId: null, sessionIds: ['s1'] });
    expect(reset.workspaces.find(group => group.id === groupA)!.sessionIds).toEqual(['s1', 's2']);
    expect(reset.workspaces.some(group => group.id === groupB && group.sessionIds.length === 0)).toBe(true);
  });

  it('deletes a group without deleting sessions and never changes their cwd', async () => {
    const sessions = [makeSession('s1', '/data/repo-a'), makeSession('s2', '/data/repo-b')];
    const originalCwds = sessions.map(session => session.cwd);
    const { service } = createService(sessions);
    const groupId = (await service.createGroup('临时组')).createdGroupId!;
    await service.assign({ groupId, sessionIds: ['s1'], directories: ['/data/repo-b'] });
    const deleted = await service.deleteGroup(groupId);
    expect(deleted.organization.groups).toEqual([]);
    expect(deleted.organization.sessionGroups).toEqual({});
    expect(deleted.organization.directoryGroups).toEqual({});
    // 任务全部回到自动目录组，cwd 原样。
    expect(deleted.workspaces.find(group => group.id === '/data/repo-a')!.sessionIds).toEqual(['s1']);
    expect(deleted.workspaces.find(group => group.id === '/data/repo-b')!.sessionIds).toEqual(['s2']);
    expect(sessions.map(session => session.cwd)).toEqual(originalCwds);
  });

  it('rejects duplicate names, invalid names and unknown targets', async () => {
    const { service } = createService([makeSession('s1', '/data/repo-a')]);
    await service.createGroup('同名');
    await expect(service.createGroup('同名')).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.createGroup('   ')).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.createGroup('x'.repeat(81))).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.renameGroup('wg_missing', '新名')).rejects.toMatchObject({ statusCode: 404 });
    const groupId = (await service.createGroup('原')).createdGroupId!;
    await expect(service.renameGroup(groupId, '同名')).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.assign({ groupId: 'wg_missing', sessionIds: ['s1'] })).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.deleteGroup('wg_missing')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('validates directory and session batches before writing anything', async () => {
    const sessions = [makeSession('s1', '/data/repo-a'), makeSession('work1', '/data/repo-w', { source: 'work_item' })];
    const { service } = createService(sessions);
    const groupId = (await service.createGroup('G')).createdGroupId!;
    const before = await service.getSnapshot();

    // 相对目录 -> 400；不存在任务 / work_item 托管任务 -> 404；空批量 -> 400。
    await expect(service.assign({ groupId, directories: ['relative/dir'] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.assign({ groupId, sessionIds: ['s1', 'missing'] })).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.assign({ groupId, sessionIds: ['s1', 'work1'] })).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.assign({ groupId })).rejects.toMatchObject({ statusCode: 400 });

    const after = await service.getSnapshot();
    expect(after.organization).toEqual(before.organization);
  });

  it('loses no writes under concurrent mutations (CAS)', async () => {
    const sessions = Array.from({ length: 20 }, (_unused, index) => makeSession(`s${index}`, '/data/repo-a'));
    const { service } = createService(sessions);
    const groupId = (await service.createGroup('G')).createdGroupId!;
    // 20 个并发的单任务覆盖全部必须生效；read+set 会丢写，CAS 不会。
    const results = await Promise.allSettled(
      sessions.map(session => service.assign({ groupId, sessionIds: [session.id] }))
    );
    expect(results.every(result => result.status === 'fulfilled')).toBe(true);
    const snapshot = await service.getSnapshot();
    expect(snapshot.organization.sessionGroups).toEqual(Object.fromEntries(sessions.map(session => [session.id, groupId])));
  });

  it('excludes work_item sessions but keeps archived ones in the snapshot', async () => {
    const sessions = [
      makeSession('normal', '/data/repo-a'),
      makeSession('archived', '/data/repo-a', { archivedAt: '2026-09-20T00:00:00.000Z' }),
      makeSession('managed', '/data/repo-a', { source: 'work_item' })
    ];
    const snapshot = (await createService(sessions).service.getSnapshot());
    const auto = snapshot.workspaces.find(group => group.id === '/data/repo-a')!;
    expect(auto.sessionIds).toEqual(['normal', 'archived']);
    expect(auto.sessionIds).not.toContain('managed');
  });

  it('fails closed without compareAndSet support', () => {
    expect(() => new WorkspaceOrganizationService({
      config: { get: async () => undefined } as never,
      listSessions: async () => []
    })).toThrow(/compareAndSet/);
  });
});
