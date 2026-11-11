import { buildTimeline, buildTimelineSections } from '../../web/src/timeline.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import Fastify from 'fastify';
import { registerTaskRoutes, auditTaskClient, taskClient, taskConversation, taskLimit, taskStatus, taskWaiting } from './task-routes.js';
import type { AgentEvent, Session } from '@dutydeck/shared';
const at = '2026-11-11T00:00:00.000Z';
const session = { id: 's', agentId: 'mock', state: 'idle', cwd: '/tmp/example', runId: 'r', createdAt: at, updatedAt: at, source: 'web' } as Session;
const task = { id: 't', sessionId: 's', prompt: 'user prompt', status: 'completed', createdAt: at, updatedAt: at };
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); vi.useRealTimers(); });
function runtime() {
  return { listSessions: vi.fn(async () => [session]), listAgents: vi.fn(async () => [{ id: 'mock', name: 'Mock', command: 'codex', args: [] }]), getSession: vi.fn(async () => session),
    getTasks: vi.fn(async (_id: string) => [task]), getEvents: vi.fn(async () => []), getPendingPermissions: vi.fn((_id: string) => []), getVerifications: vi.fn(async () => []),
    getDriver: vi.fn(() => ({})), dispatch: vi.fn(async () => task), interrupt: vi.fn(async () => ({ interrupted: true })), publishSessionEvent: vi.fn(async () => {}), recordClientAudit: vi.fn(async () => {}) };
}
describe('open task projections', () => {
  it('validates limits and clients', () => {
    expect(taskLimit(undefined, 50)).toBe(50); expect(taskLimit('200', 40)).toBe(200);
    expect(() => taskLimit('201', 40)).toThrow(); expect(() => taskLimit('1.2', 40)).toThrow();
    expect(taskClient({ client: 'phone-1' })).toBe('phone-1'); expect(taskClient({})).toBeUndefined();
    expect(() => taskClient({ client: 'Phone' })).toThrow();
  });
  it.each([['running', 'running'], ['queued', 'queued'], ['completed', 'done'], ['failed', 'failed'], ['cancelled', 'stopped'], ['interrupted', 'stopped'], ['reconcile_required', 'unknown'], ['legacy_unresolved', 'unknown']])('maps %s to %s', (status, expected) => {
    expect(taskStatus(session, [{ ...task, status }], [])).toBe(expected);
    expect(taskStatus(session, [{ ...task, status }], [{}])).toBe('waiting');
    expect(taskStatus({ ...session, archivedAt: at }, [{ ...task, status }], [])).toBe('stopped');
  });
  it('projects bounded permissions and choice values', () => {
    expect(taskWaiting([{ id: 'p', title: 'p'.repeat(600), status: 'pending', operation: { source: 'acp_tool_call', command: 'x'.repeat(3000) } }], [{ id: 'a', sessionId: 's', question: 'Choose', status: 'pending', createdAt: at, expiresAt: at, choices: [{ label: 'Yes', value: 'yes' }] }])).toMatchObject([
      { id: 'p', prompt: 'p'.repeat(500), detail: 'x'.repeat(2000), free_text: false, options: [{ id: 'allow' }, { id: 'deny' }] },
      { id: 'a', kind: 'question', free_text: true, options: [{ id: 'yes', kind: 'answer' }] }
    ]);
  });
  it('merges tools, hides thinking/audit, deduplicates final output and truncates the newest conversation', () => {
    const event = (type: AgentEvent['type'], data: unknown, n: number): AgentEvent => ({ id: `e${n}`, sessionId: 's', taskId: 't', sequence: n, timestamp: at, type, data });
    const events = [event('task', task, 1), event('thinking', { text: 'private thought' }, 2), event('tool_call', { id: 'tool', name: 'read', status: 'running' }, 3), event('tool_result', { id: 'tool', name: 'read', output: 'one\ntwo' }, 4), event('text', { text: 'z'.repeat(4100) }, 5), event('completed', { text: 'z'.repeat(4100) }, 6), event('text', { audit: 'external_client', client: 'phone' }, 7)];
    const result = taskConversation(events, [task], 40);
    expect(result.items.map(i => i.role)).toEqual(['user', 'tool', 'assistant']);
    expect(result.items[1]!.text).toBe('read: one two'); expect(result.items[2]!.text).toHaveLength(4000); expect(result.truncated).toBe(true);
    expect(taskConversation(events, [task], 1).items).toHaveLength(1);
    expect(taskConversation([], [task], 1)).toEqual({ items: [{ role: 'user', text: task.prompt, at }], truncated: false });
  });
  it('does not duplicate persisted prompts and joins streaming reply fragments', () => {
    const event = (type: AgentEvent['type'], data: unknown, n: number): AgentEvent => ({ id: `e${n}`, sessionId: 's', taskId: 't', sequence: n, timestamp: at, type, data });
    const events = [event('task', { task: { id: 't', status: 'running' } }, 1), event('text', { role: 'user', text: task.prompt, taskId: 't' }, 2), event('text', { text: 'Hello ' }, 3), event('text', { text: 'world' }, 4), event('completed', { text: 'Hello world' }, 5)];
    expect(taskConversation(events, [task], 40)).toEqual({ items: [{ role: 'user', text: task.prompt, at }, { role: 'assistant', text: 'Hello world', at }], truncated: false });
  });

  it('uses the existing visibility filter and action policy', async () => {
    const r = runtime(); r.listSessions.mockResolvedValue([session, { ...session, id: 'hidden', updatedAt: '2026-11-12T00:00:00.000Z' }]);
    const app = await buildApp(r as any, { executionPolicy: { authorize: async (_req, id, _boundary, action) => ({ allowed: id !== 'hidden' && action !== 'run.interrupt', code: 'forbidden', reason: 'denied', action, source: 'owner' }) } }); apps.push(app);
    const response = await app.inject('/api/tasks'); expect(response.statusCode).toBe(200);
    expect(response.json().tasks).toMatchObject([{ id: 's', status: 'done', agent: 'codex', verification: { state: 'none' }, actions: ['send'] }]);
    expect(r.getTasks).toHaveBeenCalledTimes(1);
    expect((await app.inject('/api/tasks?limit=201')).statusCode).toBe(400);
    expect((await app.inject('/api/tasks/s')).json()).toEqual({ items: [{ role: 'user', text: task.prompt, at }], truncated: false });
  });
  it('excludes archived sessions before applying the newest-first limit', async () => {
    const r = runtime();
    r.listSessions.mockResolvedValue([
      session,
      { ...session, id: 'archived', state: 'stopped', archivedAt: at, updatedAt: '2026-11-13T00:00:00.000Z' },
      { ...session, id: 'stopped', state: 'stopped', updatedAt: '2026-11-12T00:00:00.000Z' },
    ]);
    const app = await buildApp(r as any); apps.push(app);
    const response = await app.inject('/api/tasks?limit=1');
    expect(response.statusCode).toBe(200);
    expect(response.json().tasks).toMatchObject([{ id: 'stopped', status: 'stopped' }]);
    expect(response.json().tasks).toHaveLength(1);
    expect(r.getTasks.mock.calls).toEqual([['stopped']]);
    expect((await app.inject('/api/tasks')).json().tasks.map((item: { id: string }) => item.id)).toEqual(['stopped', 's']);
  });
  it('selects current work and recent completions before the limit and enriches only selected origins', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(at));
    const old = '2026-11-01T00:00:00.000Z';
    const boundary = '2026-11-10T00:00:00.000Z';
    const states: Record<string, { status: string; updatedAt: string }[]> = {
      running: [{ status: 'running', updatedAt: old }], queued: [{ status: 'queued', updatedAt: old }],
      waiting: [{ status: 'running', updatedAt: old }], done: [{ status: 'completed', updatedAt: '2026-11-10T23:00:00.000Z' }],
      boundary: [{ status: 'completed', updatedAt: boundary }], expired: [{ status: 'completed', updatedAt: '2026-11-09T23:59:59.999Z' }],
      future: [{ status: 'completed', updatedAt: '2026-11-11T00:00:00.001Z' }], invalid: [{ status: 'completed', updatedAt: 'invalid' }],
      failed: [{ status: 'completed', updatedAt: at }, { status: 'failed', updatedAt: at }],
      latest: [{ status: 'completed', updatedAt: old }, { status: 'completed', updatedAt: at }], fallback: [],
      managed: [{ status: 'queued', updatedAt: old }], denied: [{ status: 'running', updatedAt: old }]
    };
    const r = runtime();
    r.listSessions.mockResolvedValue([
      ...Array.from({ length: 205 }, (_, i) => ({ ...session, id: `history${i}`, updatedAt: at })),
      ...Object.keys(states).map(id => ({ ...session, id, state: id === 'fallback' ? 'completed' as const : 'idle' as const,
        updatedAt: id === 'waiting' ? '2026-11-02T00:00:00.000Z' : ['running', 'queued', 'managed', 'denied'].includes(id) ? old : at, ...(id === 'managed' ? { source: 'work_item' } : {}) })),
      { ...session, id: 'archived', archivedAt: at }, { ...session, id: 'hidden' }
    ]);
    r.getTasks.mockImplementation(async id => (states[id] ?? [{ status: 'completed', updatedAt: old }]).map((record, i) => ({ ...task, id: `${id}-${i}`, ...record })));
    r.getPendingPermissions.mockImplementation(id => id === 'waiting' ? [{ id: 'p', title: 'Approve', status: 'pending' }] as any : []);
    const source = vi.fn(async (_session: Session) => undefined);
    const app = Fastify();
    registerTaskRoutes(app, r as any, { filterViewable: async (_req, sessions) => sessions.filter(s => s.id !== 'hidden'), authorize: async () => {}, can: async (_req, id) => id !== 'denied', source });
    try {
      const response = await app.inject('/api/tasks?recent=true&limit=200');
      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.tasks.map((t: any) => t.id)).toEqual(['waiting', 'running', 'queued', 'managed', 'denied', 'latest', 'fallback', 'done', 'boundary']);
      expect(data.tasks.map((t: any) => t.status)).toEqual(['waiting', 'running', 'queued', 'queued', 'running', 'done', 'done', 'done', 'done']);
      expect(data.tasks.find((t: any) => t.id === 'boundary').updated_at).toBe(boundary);
      expect(data.tasks.find((t: any) => t.id === 'done').updated_at).toBe(states.done![0]!.updatedAt);
      expect(data.archivable).toEqual(['waiting', 'running', 'queued', 'latest', 'fallback', 'done', 'boundary']);
      expect(data.tasks.find((t: any) => t.id === 'done').actions).toEqual(['send']);
      expect(data.tasks.find((t: any) => t.id === 'managed').actions).toEqual([]);
      expect(source.mock.calls.map(([s]) => s.id)).toEqual(data.tasks.map((t: any) => t.id));
      expect(r.getTasks.mock.calls.flat()).not.toContain('hidden'); expect(r.getTasks.mock.calls.flat()).not.toContain('archived');
      source.mockClear();
      const limited = (await app.inject('/api/tasks?recent=true&limit=1')).json();
      expect(limited.tasks.map((t: any) => t.id)).toEqual(['waiting']); expect(limited.archivable).toEqual(['waiting']); expect(source).toHaveBeenCalledOnce();
      expect((await app.inject('/api/tasks?recent=invalid')).statusCode).toBe(400);
    } finally { await app.close(); vi.restoreAllMocks(); }
  });
  it('requires archive authority before auditing or changing state and preserves the named owner', async () => {
    const r = { ...runtime(), archive: vi.fn(async () => ({ ...session, archivedAt: at })) };
    let allowed = false;
    const authorize = vi.fn(async (_req, _id, _boundary, action) => ({ allowed, code: 'forbidden', reason: 'denied', action, source: 'owner' }));
    const app = await buildApp(r as any, { executionPolicy: { authorize } }); apps.push(app);
    const request = { method: 'POST' as const, url: '/api/sessions/s/archive', payload: { client: 'rovetap' } };
    expect((await app.inject(request)).statusCode).toBe(403);
    expect(r.archive).not.toHaveBeenCalled(); expect(r.recordClientAudit).not.toHaveBeenCalled();
    allowed = true;
    expect((await app.inject({ ...request, payload: { client: 'Bad client' } })).statusCode).toBe(400);
    expect(r.archive).not.toHaveBeenCalled();
    const response = await app.inject(request);
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ id: 's', archivedAt: at });
    expect(authorize).toHaveBeenLastCalledWith(expect.anything(), 's', 'session', 'run.interrupt');
    expect(r.recordClientAudit).toHaveBeenCalledWith('s', 'archive', 'rovetap');
    expect(r.archive).toHaveBeenCalledWith('s', { kind: 'installation_owner', id: 'installation_owner' });
  });
  it('returns an empty list when every session is archived and keeps history readable', async () => {
    const r = runtime();
    const archived = { ...session, state: 'stopped' as const, archivedAt: at };
    r.listSessions.mockResolvedValue([archived]); r.getSession.mockResolvedValue(archived);
    const app = await buildApp(r as any); apps.push(app);
    expect((await app.inject('/api/tasks')).json()).toEqual({ tasks: [] });
    expect(r.getTasks).not.toHaveBeenCalled();
    const history = await app.inject('/api/tasks/s');
    expect(history.statusCode).toBe(200);
    expect(history.json().items).toEqual([{ role: 'user', text: task.prompt, at }]);
  });
  it('never dispatches unsupported steering and records client without changing the actor', async () => {
    const r = runtime(); const app = await buildApp(r as any); apps.push(app);
    const unsupported = await app.inject({ method: 'POST', url: '/api/sessions/s/send', payload: { prompt: 'steer', mode: 'steer', strictSteer: true, client: 'phone' } });
    expect(unsupported.statusCode).toBe(400); expect(r.dispatch).not.toHaveBeenCalled();
    const sent = await app.inject({ method: 'POST', url: '/api/sessions/s/send', payload: { prompt: 'queued', client: 'phone' } });
    expect(sent.statusCode).toBe(202); expect(r.recordClientAudit).toHaveBeenCalledWith('s', 'send', 'phone');
    expect(r.publishSessionEvent).not.toHaveBeenCalled();
    await auditTaskClient(r as any, 's', 'interrupt'); expect(r.recordClientAudit).toHaveBeenCalledTimes(1);
  });
  it('withdraws an unsupported steering fallback and reports uncertainty without retrying', async () => {
    const r = { ...runtime(), getTasks: async () => [{ ...task, status: 'running' }], getDriver: () => ({ steer: async () => 'unsupported' }), injectQueued: vi.fn(async () => ({ task: { ...task, status: 'queued' }, outcome: 'unsupported' })), cancelQueued: vi.fn(async () => ({ ...task, status: 'cancelled' })) };
    r.dispatch.mockResolvedValue({ ...task, status: 'queued' });
    const app = await buildApp(r as any); apps.push(app);
    const payload = { prompt: 'steer', mode: 'steer', strictSteer: true };
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s/send', payload })).json()).toMatchObject({ error: { code: 'invalid_argument' } });
    expect(r.cancelQueued).toHaveBeenCalledTimes(1);
    r.injectQueued.mockResolvedValue({ task: { ...task, status: 'queued' }, outcome: 'unknown' });
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s/send', payload })).json()).toMatchObject({ error: { code: 'unknown_outcome' } });
    expect(r.dispatch).toHaveBeenCalledTimes(2);
  });

  it('keeps the Web final reply unchanged after external client auditing', async () => {
    const events: AgentEvent[] = [
      { id: 'user', sessionId: 's', taskId: 't', sequence: 1, type: 'text', timestamp: at, data: { text: task.prompt, role: 'user' } },
      { id: 'reply', sessionId: 's', taskId: 't', sequence: 2, type: 'text', timestamp: at, data: { text: 'Final answer', role: 'assistant' } }
    ];
    const records: unknown[] = [];
    const r = { ...runtime(), publishSessionEvent: async (_id: string, type: AgentEvent['type'], data: unknown) => { events.push({ id: 'audit', sessionId: 's', sequence: 3, type, timestamp: at, data }); }, recordClientAudit: async (...args: unknown[]) => { records.push(args); } };
    const before = buildTimelineSections(buildTimeline(events, [task]), [task]);
    await auditTaskClient(r as any, 's', 'interrupt', 'phone');
    expect(buildTimelineSections(buildTimeline(events, [task]), [task])).toEqual(before);
    expect(records).toEqual([['s', 'interrupt', 'phone']]);
  });
  it('uses the newest verification of the current task and preserves stale evidence', async () => {
    const r = runtime();
    const failed = { id: 'new', taskId: 't', command: 'pnpm test', status: 'failed', startedAt: '2026-11-11T02:00:00Z', stale: false };
    const passed = { ...failed, id: 'old', status: 'passed', startedAt: '2026-11-11T01:00:00Z' };
    r.getVerifications.mockResolvedValue([{ ...failed, id: 'other-task', taskId: 'other', status: 'passed', startedAt: '2026-11-11T03:00:00Z' }, failed, passed] as any);
    const app = await buildApp(r as any); apps.push(app);
    expect((await app.inject('/api/tasks')).json().tasks[0].verification).toMatchObject({ state: 'failed', summary: 'pnpm test: failed' });
    r.getVerifications.mockResolvedValue([{ ...failed, stale: true }, passed] as any);
    expect((await app.inject('/api/tasks')).json().tasks[0].verification).toMatchObject({ state: 'none', summary: 'pnpm test: failed (stale)' });
  });

  it('bounds concurrent origin reads and returns fallback origins within the whole request budget', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(at));
    const r = runtime(); const sessions = Array.from({ length: 8 }, (_, index) => ({ ...session, id: `s${index}`, source: 'lark' }));
    r.listSessions.mockResolvedValue(sessions);
    let active = 0, maxActive = 0;
    const source = vi.fn(async (session: Session) => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(done => setTimeout(done, 2000)); active--;
      return { channel: 'lark' as const, chat: { id: 'oc_example', name: `Chat ${session.id}`, type: 'group' as const, url: 'https://client.example.test/chat' }, originAvailable: true };
    });
    const app = Fastify();
    registerTaskRoutes(app, r as any, { filterViewable: async (_req, sessions) => sessions, authorize: async () => {}, can: async () => true, source });
    await app.ready();
    let response: Awaited<ReturnType<typeof app.inject>> | undefined;
    const request = app.inject('/api/tasks').then(value => { response = value; return value; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(maxActive).toBe(4);
      await vi.advanceTimersByTimeAsync(3000);
      expect(response).toBeDefined();
      const data = (await request).json();
      expect(data.tasks).toHaveLength(8);
      expect(data.tasks.slice(0, 4).map((task: any) => task.origin.label)).toEqual(['Chat s0', 'Chat s1', 'Chat s2', 'Chat s3']);
      expect(data.tasks.slice(4).every((task: any) => !task.origin.url)).toBe(true);
      expect(maxActive).toBe(4);
    } finally { await vi.runAllTimersAsync(); await request; await app.close(); }
  });
  it('distinguishes a settled request from a missing request', async () => {
    const r = runtime(); r.getEvents.mockResolvedValue([{ type: 'permission_request', data: { id: 'p', status: 'approved' } }] as any);
    const app = await buildApp(r as any); apps.push(app);
    expect((await app.inject('/api/sessions/s/waiting/p')).json()).toMatchObject({ error: { code: 'already_resolved' } });
    expect((await app.inject('/api/sessions/s/waiting/missing')).statusCode).toBe(404);
  });
});
