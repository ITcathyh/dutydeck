import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { registerWorkItemTools } from './work-item-tools.js';

const { discover } = vi.hoisted(() => ({ discover: vi.fn() }));
vi.mock('./skill-catalog.js', async original => ({ ...await original<typeof import('./skill-catalog.js')>(), discoverSkillCatalog: discover }));
afterEach(() => vi.clearAllMocks());

it('exposes incomplete discovery and per-item diagnostics alongside the original skills and delivery fields', async () => {
  const app = Fastify();
  const listBySession = vi.fn(async () => []);
  const catalog = { skills: [{ name: 'good', description: 'Good', path: '/project/.agents/skills/good/SKILL.md', source: 'workspace' }], diagnostics: [{ path: '/project/.agents/skills/bad/SKILL.md', code: 'SKILL_METADATA_INVALID', message: 'Invalid YAML' }], partial: true, budget: { entries: 8192, candidates: 100, bytes: 500000, concurrentReads: 1 } };
  discover.mockResolvedValue(catalog);
  await registerWorkItemTools(app, {
    runtime: { getActiveTaskContext: () => ({ actorId: 'alice', taskId: 'task', attemptId: 'attempt' }), getSession: async () => ({ cwd: '/project' }) } as any,
    work: { listBySession } as any,
    tools: { workbenchContext: async (token: string) => { if (token !== 'session-token') throw Object.assign(new Error('Unauthorized'), { statusCode: 401 }); return { sessionId: 'session' }; }, assertWorkbenchTurn: (_session: string, _task: string, _attempt: string, turn: string) => { if (turn !== 'turn-token') throw Object.assign(new Error('Turn expired'), { statusCode: 403 }); } } as any
  });
  try {
    const url = '/api/lark/agent-tools/work-items/skills';
    const headers = { authorization: 'Bearer session-token', 'x-dutydeck-work-turn': 'turn-token' };
    expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ ...catalog, delivery: 'prompt snapshot at step acceptance; tool authorization is checked separately' });
    expect(listBySession).toHaveBeenCalledWith('session', 'alice'); expect(discover).toHaveBeenCalledWith('/project');
    discover.mockClear();
    expect((await app.inject({ method: 'GET', url, headers: { ...headers, 'x-dutydeck-work-turn': 'old-turn' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect(discover).not.toHaveBeenCalled();
  } finally { await app.close(); }
});

it('routes Agent plan revisions as Agent-sourced, with dryRun returning only the preview', async () => {
  const app = Fastify();
  const previewRevision = vi.fn(async () => ({ requiresConfirmation: true })), revise = vi.fn(async () => ({ status: 'awaiting_confirmation' }));
  await registerWorkItemTools(app, {
    runtime: { getActiveTaskContext: () => ({ actorId: 'alice', taskId: 'task', attemptId: 'attempt' }) } as any,
    work: { previewRevision, revise } as any,
    tools: { workbenchContext: async () => ({ sessionId: 'session' }), assertWorkbenchTurn: () => {} } as any
  });
  try {
    const plan = { title: 'P', outputStepId: 'a', steps: [{ id: 'a', title: 'A', kind: 'agent', agentId: 'alpha', instruction: 'Do', dependsOn: [] }] };
    const request = (body: unknown) => app.inject({ method: 'POST', url: '/api/lark/agent-tools/work-items/work_1/revise', headers: { authorization: 'Bearer token', 'x-dutydeck-work-turn': 'turn' }, payload: body as any });
    expect((await request({ expectedRevision: 3, plan, dryRun: true })).json()).toEqual({ requiresConfirmation: true });
    expect(previewRevision).toHaveBeenCalledWith('session', 'work_1', { expectedRevision: 3, plan }, 'alice', 'agent');
    expect((await request({ expectedRevision: 3, plan, reason: '收窄' })).json()).toEqual({ status: 'awaiting_confirmation' });
    expect(revise).toHaveBeenCalledWith('session', 'work_1', { expectedRevision: 3, plan, reason: '收窄' }, 'alice', 'agent');
    expect((await request({ expectedRevision: 3, plan: { ...plan, steps: [] } })).statusCode).toBe(400);
    expect((await request({ expectedRevision: 3, plan, extra: true })).statusCode).toBe(400);
  } finally { await app.close(); }
});
