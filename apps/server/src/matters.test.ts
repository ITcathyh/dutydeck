import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { matterRelations, readSessionTaskReport, writeTaskReport, type Session, type TaskRecord } from '@dutydeck/shared';
import { MattersService } from './matters.js';
import { buildApp } from './app.js';

const session = (id: string, state = 'idle'): Session => ({ id, state: state as Session['state'], agentId: 'a', cwd: '/tmp', runId: id, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' });
afterEach(() => vi.restoreAllMocks());
describe('matter tracking', () => {
  it.each(matterRelations.filter(relation => !['origin', 'created_in'].includes(relation)))('inherits %s without changing accepted task input', async relation => {
    const repos = createRepositories(':memory:');
    try {
      const service = new MattersService(repos);
      const task: TaskRecord = { id: 't', sessionId: 'parent', prompt: 'original goal', status: 'completed', createdAt: '', updatedAt: '' };
      await repos.tasks.save(task);
      await service.session('child', { sourceSessionId: 'parent', relation, title: 'later goal' });
      await service.accepted(session('child'), { ...task, id: 't2', sessionId: 'child' });
      await service.accepted(session('child'), { ...task, id: 't2', sessionId: 'child' });
      expect(service.summary('child')?.id).toBe(service.summary('parent')?.id);
      expect(service.summary('child')?.title).toBe('original goal');
      expect(repos.matters!.links(service.summary('child')!.id)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'session', refId: 'child', relation }), expect.objectContaining({ kind: 'task', refId: 't2' })]));
      expect(await repos.tasks.get!('t')).toEqual(task);
      await service.accepted(session('plain-new'), { ...task, id: 't3', sessionId: 'plain-new' });
      expect(service.summary('plain-new')?.id).not.toBe(service.summary('child')?.id);
    } finally { repos.close(); }
  });
  it('lists fork sessions identically from the source or any fork, and leaves other relations out', async () => {
    const repos = createRepositories(':memory:');
    try {
      const service = new MattersService(repos);
      await service.session('source', { title: 'goal' });
      expect(service.summary('source')?.forkSessionIds).toBeUndefined();
      await service.session('fork-1', { sourceSessionId: 'source', relation: 'fork' });
      await service.session('fork-2', { sourceSessionId: 'fork-1', relation: 'fork' });
      await service.session('resumed', { sourceSessionId: 'source', relation: 'resume' });
      for (const id of ['source', 'fork-1', 'fork-2']) expect(service.summary(id)?.forkSessionIds?.sort()).toEqual(['fork-1', 'fork-2']);
      expect(service.summary('source')?.sessionIds).toEqual(expect.arrayContaining(['source', 'fork-1', 'fork-2', 'resumed']));
    } finally { repos.close(); }
  });
  it('only logs association failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new MattersService({ matters: { ensureSession() { throw new Error('write failed'); } } as any, sessions: {} as any, tasks: {} as any });
    await expect(service.accepted(session('one'), { id: 't', prompt: 'go', sessionId: 'one' } as TaskRecord)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('MATTER_LINK_FAILED');
  });
  it('filters inaccessible siblings, schedules and origins, and derives the visible status', async () => {
    const repos = createRepositories(':memory:');
    const all = [session('hidden', 'completed'), session('visible', 'completed')];
    const service = new MattersService(repos);
    await service.session('hidden', { title: 'private source', originChatId: 'oc_secret', originMessageId: 'om_secret' });
    await service.session('visible', { sourceSessionId: 'hidden', relation: 'handoff' });
    const id = service.summary('visible')!.id;
    const runtime = { listSessions: async () => all, getSession: async (id: string) => all.find(session => session.id === id) } as any;
    const app = await buildApp(runtime, { matters: repos.matters, executionPolicy: { authorize: async (_request, sessionId) => ({ allowed: sessionId === 'visible' } as any) } });
    try {
      const list = (await app.inject('/api/sessions')).json();
      expect(list).toHaveLength(1); expect(list[0].matter).toMatchObject({ title: '事项', sessionIds: ['visible'], status: 'done' });
      const detail = (await app.inject(`/api/matters/${id}`)).json();
      expect(detail.sessions.map((session: Session) => session.id)).toEqual(['visible']);
      expect(detail).toMatchObject({ title: '事项', status: 'done', schedules: [] }); expect(detail.originUrl).toBeUndefined();
      all[1]!.state = 'thinking';
      expect((await app.inject(`/api/matters/${id}`)).json().status).toBe('open');
      expect((await app.inject('/api/matters/unknown')).statusCode).toBe(404);
    } finally { await app.close(); repos.close(); }
  });
});


it.each(['stopped', 'failed'])('derives a finished matter after a %s source was explicitly replaced, while preserving unknown results', async state => {
  const repos = createRepositories(':memory:');
  const service = new MattersService(repos);
  const sessions = [session('source', state), session('child', 'completed')];
  await service.session('source', { title: 'goal' }); await service.session('child', { sourceSessionId: 'source', relation: 'retry' });
  let unknown = false;
  const runtime = { listSessions: async () => sessions, getSession: async (id: string) => sessions.find(item => item.id === id), getTasks: async (id: string) => unknown && id === 'source' ? [{ status: 'reconcile_required' }] : [] } as any;
  const app = await buildApp(runtime, { matters: repos.matters });
  try {
    const id = service.summary('child')!.id;
    expect((await app.inject(`/api/matters/${id}`)).json().status).toBe('done');
    sessions[1]!.state = 'thinking';
    expect((await app.inject(`/api/matters/${id}`)).json().status).toBe('open');
    sessions[1]!.state = 'completed'; unknown = true;
    expect((await app.inject(`/api/matters/${id}`)).json().status).toBe('open');
  } finally { await app.close(); repos.close(); }
});


it('reads each matter once per session-list request and returns only local membership per session', async () => {
  const repos = createRepositories(':memory:'); const service = new MattersService(repos);
  const sessions = [session('one'), session('two'), session('three')];
  await service.session('one', { title: 'one matter' });
  await service.session('two', { sourceSessionId: 'one', relation: 'handoff' });
  await service.session('three', { sourceSessionId: 'two', relation: 'retry' });
  const links = vi.spyOn(repos.matters!, 'links');
  const tasks = vi.fn(async () => []);
  const runtime = { listSessions: async () => sessions, getTasks: tasks } as any;
  const app = await buildApp(runtime, { matters: repos.matters });
  try {
    const result = (await app.inject('/api/sessions')).json();
    expect(result).toHaveLength(3);
    expect(links).toHaveBeenCalledTimes(1);
    expect(tasks).toHaveBeenCalledTimes(2);
    expect(new Set(result.map((item: any) => item.matter.id)).size).toBe(1);
    for (const item of result) expect(item.matter.sessionIds).toEqual([item.id]);
    expect(result.reduce((count: number, item: any) => count + item.matter.sessionIds.length, 0)).toBe(3);
  } finally { await app.close(); repos.close(); }
});

it.each(['waiting', 'blocked'] as const)('keeps a matter open for the latest uncleared %s report, including a superseded source', async status => {
  const repos = createRepositories(':memory:'); const service = new MattersService(repos);
  const sessions = [session('source', 'stopped'), session('child', 'completed')];
  await service.session('source', { title: 'pending matter' });
  await service.session('child', { sourceSessionId: 'source', relation: 'retry' });
  const task: TaskRecord = { id: 'source_task', sessionId: 'source', prompt: 'goal', status: 'completed', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };
  await repos.tasks.save(task);
  const report = { schemaVersion: 1 as const, taskId: task.id, sessionId: 'source', status, question: '今天发布吗？', summary: '缺少账号', reportedAt: '2026-11-01T00:00:00.000Z' };
  const runtime = { listSessions: async () => sessions, getSession: async (id: string) => sessions.find(item => item.id === id), getTasks: (id: string) => repos.tasks.listBySession(id),
    getSessionTaskReport: async (id: string) => readSessionTaskReport(repos.config, id, await repos.tasks.listBySession(id)) } as any;
  const app = await buildApp(runtime, { matters: repos.matters });
  try {
    const id = service.summary('child')!.id;
    await writeTaskReport(repos.config, report);
    expect((await app.inject('/api/sessions')).json().every((item: any) => item.matter.status === 'open')).toBe(true);
    expect((await app.inject(`/api/matters/${id}`)).json().status).toBe('open');
    for (const finished of [{ ...report, status: 'ready' as const }, { ...report, status: 'dropped' as const }, { ...report, clearedAt: report.reportedAt }]) {
      await writeTaskReport(repos.config, finished);
      expect((await app.inject(`/api/matters/${id}`)).json().status).toBe('done');
    }
    await writeTaskReport(repos.config, report);
    await repos.tasks.save({ ...task, id: 'later_task', createdAt: '2026-11-01T00:01:00Z' });
    expect(await runtime.getSessionTaskReport('source')).toBeUndefined();
    expect((await app.inject(`/api/matters/${id}`)).json().status).toBe('done');
    expect((await app.inject('/api/sessions')).json().every((item: any) => item.matter.status === 'done')).toBe(true);
  } finally { await app.close(); repos.close(); }
});
