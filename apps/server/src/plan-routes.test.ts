import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig, PermissionMode, PolicyAction } from '@dutydeck/shared';
import { buildApp } from './app.js';
import { planApprovedPrompt, planInstructionBlock } from './plan-mode.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** 真实 Runtime + 存储；驱动记录每一轮的权限模式。请求头 x-deny 列出这次要拒绝的权限动作。 */
async function harness(agent: Partial<AgentConfig> = {}) {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const turns: Array<{ prompt: string; mode: PermissionMode }> = [];
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (config, _protocol, emit) => {
      let mode = config.permissionMode;
      const driver: AgentDriver = { start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {}, setPermissionMode: next => { mode = next; },
        send: async prompt => { turns.push({ prompt, mode }); emit({ type: 'text', data: { text: mode === 'deny-all' ? '计划：1. 改文案' : '已执行' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); } };
      return driver;
    }
  });
  const config: AgentConfig = { id: 'claude', name: 'Claude Code', command: 'claude-agent-acp', args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false, ...agent };
  await runtime.initialize([config]);
  const app = await buildApp(runtime, { plan: { store: repos.config }, executionPolicy: { authorize: async (request, _id, _boundary, action: PolicyAction) => {
    const denied = String(request.headers['x-deny'] ?? '').split(',').includes(action);
    return { allowed: !denied, action, code: denied ? 'POLICY_DENIED' : 'allowed', reason: denied ? '没有权限' : '', source: denied ? 'explicit_deny' : 'owner' };
  } } });
  cleanups.push(async () => { await app.close(); await runtime.shutdown(); repos.close(); });
  const session = await runtime.start({ agentId: config.id });
  const settle = (count: number) => vi.waitFor(async () => expect((await runtime.getTasks(session.id)).filter(task => task.status === 'completed')).toHaveLength(count));
  const state = async () => (await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/plan` })).json();
  const decide = (taskId: string, body: Record<string, unknown>, deny?: string) => app.inject({ method: 'POST', url: `/api/sessions/${session.id}/plan/${taskId}`, payload: body, ...(deny ? { headers: { 'x-deny': deny } } : {}) });
  return { repos, runtime, app, session, turns, settle, state, decide };
}

describe('Web plan routes', () => {
  it('plans with writes denied, then executes once in the session mode after approval', async () => {
    const h = await harness();
    const started = await h.app.inject({ method: 'POST', url: `/api/sessions/${h.session.id}/plan`, payload: { prompt: '把登录页报错改成中文' } });
    expect(started.statusCode).toBe(202);
    await h.settle(1);
    expect(h.turns[0]).toMatchObject({ mode: 'deny-all', prompt: expect.stringContaining(planInstructionBlock) });
    const plan = await h.state();
    expect(plan).toMatchObject({ state: 'pending', taskId: started.json().task.id, operable: true });

    // 批准与中断同一道权限，不要求高风险审批权限。
    expect((await h.decide(plan.taskId, { action: 'approve' }, 'run.interrupt')).statusCode).toBe(403);
    const approved = await h.decide(plan.taskId, { action: 'approve' }, 'high_risk.execute');
    expect(approved.json()).toMatchObject({ state: 'approved' });
    await h.settle(2);
    expect(h.turns[1]).toMatchObject({ mode: 'ask', prompt: planApprovedPrompt });
    expect((await h.decide(plan.taskId, { action: 'approve' })).json().error.code).toBe('PLAN_STALE');
    expect(h.turns).toHaveLength(2);
    expect(await h.state()).toEqual({ state: 'none' });
  });

  it('re-plans on revision, runs nothing on cancel and accepts one decision per plan', async () => {
    const h = await harness();
    await h.app.inject({ method: 'POST', url: `/api/sessions/${h.session.id}/plan`, payload: { prompt: '整理依赖' } });
    await h.settle(1);
    const first = await h.state();
    expect((await h.decide(first.taskId, { action: 'revise', feedback: ' ' })).json().error.code).toBe('PLAN_FEEDBACK_REQUIRED');
    expect((await h.decide(first.taskId, { action: 'revise', feedback: '只动 devDependencies' })).json()).toMatchObject({ state: 'needs_changes' });
    await h.settle(2);
    expect(h.turns[1]).toMatchObject({ mode: 'deny-all', prompt: expect.stringContaining('只动 devDependencies') });
    const second = await h.state();
    expect(second).toMatchObject({ state: 'pending' });
    expect(second.taskId).not.toBe(first.taskId);
    expect((await h.decide(second.taskId, { action: 'cancel' })).json()).toEqual({ state: 'cancelled' });
    expect(await h.state()).toMatchObject({ state: 'cancelled' });
    expect((await h.decide(second.taskId, { action: 'approve' })).json().error.code).toBe('PLAN_ALREADY_DECIDED');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(h.turns).toHaveLength(2);
  });

  it('refuses to plan on an Agent that cannot block writes', async () => {
    const h = await harness({ id: 'codex', name: 'Codex', command: 'codex-acp' });
    const started = await h.app.inject({ method: 'POST', url: `/api/sessions/${h.session.id}/plan`, payload: { prompt: '整理依赖' } });
    expect(started.statusCode).toBe(422);
    expect(started.json().error).toMatchObject({ code: 'PLAN_UNSUPPORTED', message: expect.stringContaining('不支持先出计划') });
    expect(await h.runtime.getTasks(h.session.id)).toEqual([]);
  });

  it('rejects Web plan creation in a Lark session before dispatch while preserving ordinary send', async () => {
    const h = await harness();
    const session = await h.runtime.start({ agentId: 'claude', source: 'lark', sourceId: 'test:chat:group' });
    const dispatch = vi.spyOn(h.runtime, 'dispatch');
    const started = await h.app.inject({ method: 'POST', url: `/api/sessions/${session.id}/plan`, payload: { prompt: '整理依赖' } });
    expect(started.statusCode).toBe(409);
    expect(started.json().error).toMatchObject({ code: 'PLAN_IN_LARK', message: expect.stringContaining('/plan') });
    expect(dispatch).not.toHaveBeenCalled();
    expect(await h.runtime.getTasks(session.id)).toEqual([]);
    expect(h.turns).toEqual([]);

    const sent = await h.app.inject({ method: 'POST', url: `/api/sessions/${session.id}/send`, payload: { prompt: '普通消息', mode: 'queue' } });
    expect(sent.statusCode).toBe(202);
    await vi.waitFor(() => expect(h.turns).toEqual([{ prompt: '普通消息', mode: 'ask' }]));
  });

  it('leaves Feishu plans to the Feishu card', async () => {
    const h = await harness();
    await h.runtime.dispatch(h.session.id, '/plan 整理依赖', 'queue', '整理依赖', undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'deny-all');
    await h.settle(1);
    vi.spyOn(h.runtime, 'getSession').mockImplementation(async id => ({ ...(await h.repos.sessions.get(id))!, source: 'lark' }));
    const plan = await h.state();
    expect(plan).toMatchObject({ state: 'pending', operable: false });
    expect((await h.decide(plan.taskId, { action: 'approve' })).json().error.code).toBe('PLAN_IN_LARK');
  });
});
