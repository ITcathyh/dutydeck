import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { installationOwnerTaskActor, RuntimeError, type ConfigRepository, type PolicyAction, type PolicyDecision } from '@dutydeck/shared';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import { planAgentPrompt, planApprovedPrompt, planDecisionWindowMs, planPrompt, planRevisePrompt, planTaskOf, planUnsupportedReason } from './plan-mode.js';

export interface PlanRouteOptions {
  /** 记 Web 上对计划的决定（一次性 CAS）；未提供时不注册计划路由。 */
  store: ConfigRepository;
}

type RequireSessionExecution = (request: FastifyRequest, sessionId: string, boundary: 'session' | 'high_risk', action: PolicyAction) => Promise<PolicyDecision | undefined>;
/** open：上次提交失败后放开，可以再决定一次。 */
type PlanDecision = { state: 'open' | 'resolving' | 'approved' | 'needs_changes' | 'cancelled'; action: 'approve' | 'revise' | 'cancel'; at: string };

const startSchema = z.object({ prompt: z.string() }).strict();
const decideSchema = z.object({ action: z.enum(['approve', 'revise', 'cancel']), feedback: z.string().max(2000).optional() }).strict();
/** 每个动作的权限与飞书计划卡同一口径：批准、取消与中断同级（发起人本来就能直接发这个任务）；修改意见是追加一轮。 */
const decisionPolicy = { approve: ['session', 'run.interrupt'], revise: ['session', 'turn.append'], cancel: ['session', 'run.interrupt'] } as const;
const decisionKey = (sessionId: string, taskId: string) => `plan.web.${sessionId}.${taskId}`;
const decided = { approve: 'approved', revise: 'needs_changes', cancel: 'cancelled' } as const;

/**
 * Web 上的先出计划：计划轮与飞书 /plan 同一套（请求原文带 /plan、任务以 deny-all 运行），
 * 批准、提修改意见、取消在会话页的计划卡上做。飞书会话从飞书 /plan 发起，Web 只展示计划，决定留在飞书计划卡上。
 */
export function registerPlanRoutes(app: FastifyInstance, runtime: DutydeckRuntime, requireSessionExecution: RequireSessionExecution, options: PlanRouteOptions) {
  const actorOf = (decision: PolicyDecision | undefined) => decision?.source === 'owner' ? installationOwnerTaskActor : undefined;
  const session = async (id: string) => {
    const found = await runtime.getSession(id);
    if (!found) throw new RuntimeError('SESSION_NOT_FOUND', 'Session is missing', 404);
    return found;
  };
  const latestTask = async (id: string) => (await runtime.getTasks(id)).reduce<Awaited<ReturnType<typeof runtime.getTasks>>[number] | undefined>(
    (last, task) => !last || Date.parse(task.createdAt) >= Date.parse(last.createdAt) ? task : last, undefined);
  const dispatchPlan = async (id: string, material: string, actor: string | undefined, key?: string) => {
    const current = await session(id);
    const reason = planUnsupportedReason(current, (await runtime.listAgents()).find(agent => agent.id === current.agentId));
    if (reason) throw new RuntimeError('PLAN_UNSUPPORTED', reason, 422);
    return runtime.dispatch(id, planPrompt(material), 'queue', planAgentPrompt(material), undefined, actor, key, undefined, undefined, undefined, undefined, 'deny-all');
  };

  app.get<{ Params: { id: string } }>('/api/sessions/:id/plan', async request => {
    await requireSessionExecution(request, request.params.id, 'session', 'task.view_result');
    const current = await session(request.params.id);
    const latest = await latestTask(request.params.id);
    if (!latest || planTaskOf(latest.prompt) === undefined) return { state: 'none' };
    if (latest.status === 'queued' || latest.status === 'running') return { state: 'planning', taskId: latest.id };
    if (latest.status !== 'completed') return { state: 'none' };
    const raw = await options.store.get(decisionKey(current.id, latest.id));
    const decision = raw ? JSON.parse(raw) as PlanDecision : undefined;
    if (decision && decision.state !== 'resolving' && decision.state !== 'open') return { state: decision.state, taskId: latest.id };
    const expiresAt = new Date(Date.parse(latest.updatedAt) + planDecisionWindowMs).toISOString();
    if (Date.parse(expiresAt) <= Date.now()) return { state: 'expired', taskId: latest.id };
    return { state: 'pending', taskId: latest.id, expiresAt, operable: current.source !== 'lark' };
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/plan', async (request, reply) => {
    const prompt = startSchema.parse(request.body).prompt.trim();
    if (!prompt) throw new RuntimeError('INVALID_PROMPT', 'Prompt must not be empty', 400);
    const decision = await requireSessionExecution(request, request.params.id, 'session', 'turn.append');
    if ((await session(request.params.id)).source === 'lark') throw new RuntimeError('PLAN_IN_LARK', '飞书会话请在飞书发送 /plan 发起计划，并在飞书计划卡上批准、修改或取消。', 409);
    return reply.code(202).send({ accepted: true, task: await dispatchPlan(request.params.id, prompt, actorOf(decision)) });
  });

  app.post<{ Params: { id: string; taskId: string } }>('/api/sessions/:id/plan/:taskId', async request => {
    const { action, feedback = '' } = decideSchema.parse(request.body);
    const [boundary, policy] = decisionPolicy[action];
    const authorized = await requireSessionExecution(request, request.params.id, boundary, policy);
    const current = await session(request.params.id);
    if (current.source === 'lark') throw new RuntimeError('PLAN_IN_LARK', '这份计划来自飞书，请在飞书的计划卡上批准、修改或取消。', 409);
    const latest = await latestTask(current.id);
    if (!latest || latest.id !== request.params.taskId || planTaskOf(latest.prompt) === undefined || latest.status !== 'completed') {
      throw new RuntimeError('PLAN_STALE', '会话里已经有更新的任务，这份计划不再能批准或修改。需要的话请重新先出计划。', 409);
    }
    if (Date.parse(latest.updatedAt) + planDecisionWindowMs <= Date.now()) throw new RuntimeError('PLAN_EXPIRED', '计划出来已超过 24 小时，不再接受批准；需要的话请重新先出计划。', 409);
    if (action === 'revise' && !feedback.trim()) throw new RuntimeError('PLAN_FEEDBACK_REQUIRED', '请先写下修改意见再提交。', 400);
    // 一份计划只接受一次决定：先占住，提交成功再落终态；提交失败放开，可以再点。
    const key = decisionKey(current.id, latest.id);
    const previous = await options.store.get(key);
    const claim = JSON.stringify({ state: 'resolving', action, at: new Date().toISOString() } satisfies PlanDecision);
    // 占住后进程退出、没派发出去的认领，一分钟后可以重新决定（派发过的话最新任务已不是这份计划）。
    const held = previous ? JSON.parse(previous) as PlanDecision : undefined;
    const reusable = !held || held.state === 'open' || held.state === 'resolving' && Date.now() - Date.parse(held.at) > 60_000;
    if (!reusable || !await options.store.compareAndSet!(key, previous, claim)) {
      throw new RuntimeError('PLAN_ALREADY_DECIDED', '这份计划已经处理过了。', 409);
    }
    let task: unknown;
    try {
      const actor = actorOf(authorized);
      // 幂等键按计划任务：同一份计划的下一轮只会派发一次。
      if (action === 'approve') task = await runtime.dispatch(current.id, planApprovedPrompt, 'queue', planApprovedPrompt, undefined, actor, `plan:${latest.id}`);
      if (action === 'revise') task = await dispatchPlan(current.id, planTaskOf(planRevisePrompt(feedback))!, actor, `plan:${latest.id}`);
    } catch (error) {
      await options.store.compareAndSet!(key, claim, JSON.stringify({ state: 'open', action, at: new Date().toISOString() } satisfies PlanDecision));
      throw error;
    }
    await options.store.set(key, JSON.stringify({ state: decided[action], action, at: new Date().toISOString() } satisfies PlanDecision));
    return { state: decided[action], ...(task ? { task } : {}) };
  });
}
