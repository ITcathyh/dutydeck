import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import { createWorkItemSchema, reviseWorkPlanSchema, RuntimeError, toPublicAgent } from '@dutydeck/shared';
import type { LarkAgentToolsService } from './lark/agent-tools.js';
import { agentGroupToolBearerToken } from './lark/agent-tools.js';
import { delegationBriefSchema, type LeaderDelegationService } from './leader-delegation.js';
import { discoverSkillCatalog } from './skill-catalog.js';
import type { WorkItemService } from './work-items.js';
import { runTemplateInput, templateNameInput, workInput } from './work-item-routes.js';

const agentReviseInput = reviseWorkPlanSchema.extend({ dryRun: z.boolean().optional() }).strict();
const requestKey = (taskId: string, key: string) => createHash('sha256').update(JSON.stringify([taskId, key])).digest('hex');

export interface WorkItemToolsOptions { runtime: DutydeckRuntime; work: WorkItemService; tools: LarkAgentToolsService; delegations?: LeaderDelegationService }

export async function registerWorkItemTools(app: FastifyInstance, options: WorkItemToolsOptions) {
  const context = async (authorization?: string, turn?: string | string[]) => {
    const scope = await options.tools.workbenchContext(agentGroupToolBearerToken(authorization));
    const active = options.runtime.getActiveTaskContext(scope.sessionId);
    if (!active?.actorId) throw new RuntimeError('WORK_ITEM_ACTIVE_ACTOR_REQUIRED', '编排工具只接受当前正在执行的飞书指令', 403);
    options.tools.assertWorkbenchTurn(scope.sessionId, active.taskId, active.attemptId, typeof turn === 'string' ? turn : undefined);
    return { sessionId: scope.sessionId, actorId: active.actorId, taskId: active.taskId };
  };
  const base = '/api/lark/agent-tools/work-items';
  app.get(`${base}/agents`, async request => {
    const scope = await context(request.headers.authorization, request.headers['x-dutydeck-work-turn']);
    await options.work.listBySession(scope.sessionId, scope.actorId);
    return { agents: (await options.runtime.listAgents()).map(toPublicAgent), readiness: 'configured; execution checks availability, tools and credentials remain provider-specific' };
  });
  app.get(`${base}/skills`, async request => {
    const scope = await context(request.headers.authorization, request.headers['x-dutydeck-work-turn']);
    await options.work.listBySession(scope.sessionId, scope.actorId);
    const session = await options.runtime.getSession(scope.sessionId);
    return { ...(await discoverSkillCatalog(session!.cwd)), delivery: 'prompt snapshot at step acceptance; tool authorization is checked separately' };
  });
  app.get(base, async request => {
    const scope = await context(request.headers.authorization, request.headers['x-dutydeck-work-turn']);
    return { items: await options.work.listBySession(scope.sessionId, scope.actorId), templates: await options.work.listTemplates(scope.sessionId, scope.actorId) };
  });
  app.post(base, async request => {
    const scope = await context(request.headers.authorization, request.headers['x-dutydeck-work-turn']);
    const input = workInput(createWorkItemSchema, request.body);
    return options.work.create(scope.sessionId, { ...input, idempotencyKey: requestKey(scope.taskId, input.idempotencyKey) }, scope.actorId);
  });
  app.post(`${base}/delegations`, async request => {
    const scope = await context(request.headers.authorization, request.headers['x-dutydeck-work-turn']);
    if (!options.delegations) throw new RuntimeError('LEADER_DELEGATION_DISABLED', '当前实例未启用 Leader 模式', 409);
    const input = workInput(delegationBriefSchema, request.body);
    return options.delegations.delegate(scope.sessionId, scope.actorId, scope.taskId, { ...input, idempotencyKey: requestKey(scope.taskId, input.idempotencyKey) });
  });
  app.get<{ Params: { id: string } }>(`${base}/:id`, async request => {
    const scope = await context(request.headers.authorization, request.headers['x-dutydeck-work-turn']);
    return options.work.get(scope.sessionId, request.params.id, scope.actorId);
  });
  // Agent 修订只能收窄计划；扩大范围或目标本身要求确认时记为待确认修订，由人工确认后生效。dryRun 只返回影响预览。
  app.post<{ Params: { id: string } }>(`${base}/:id/revise`, async request => {
    const scope = await context(request.headers.authorization, request.headers['x-dutydeck-work-turn']);
    const { dryRun, ...input } = workInput(agentReviseInput, request.body);
    return dryRun ? options.work.previewRevision(scope.sessionId, request.params.id, input, scope.actorId, 'agent')
      : options.work.revise(scope.sessionId, request.params.id, input, scope.actorId, 'agent');
  });
  app.post<{ Params: { id: string } }>(`${base}/:id/template`, async request => {
    const scope = await context(request.headers.authorization, request.headers['x-dutydeck-work-turn']);
    return options.work.saveTemplate(scope.sessionId, request.params.id, workInput(templateNameInput, request.body).name, scope.actorId);
  });
  app.post<{ Params: { id: string } }>(`${base}/templates/:id/run`, async request => {
    const scope = await context(request.headers.authorization, request.headers['x-dutydeck-work-turn']);
    const input = workInput(runTemplateInput, request.body);
    return options.work.runTemplate(scope.sessionId, request.params.id, input.version, input.goal, requestKey(scope.taskId, input.idempotencyKey), scope.actorId);
  });
}

export const workbenchAgentPrompt = (command = 'dutydeck work', confirmation = false) => `[Dutydeck 目标编排] 多 Agent 协作、可重复流程或分阶段等待用 ${command}，先读它的 --help（JSON、隔离、等待与审查协议）；普通单步工作直接完成。${confirmation ? '计划接收后为 awaiting_confirmation，要等用户点确认卡「开始执行」才派发。' : ''}收到目标编号只表示计划已接收，简述分工和编号后结束本轮，不轮询、不重复创建或群发报告；不能代用户确认、回答等待或批准权限。用户要求调整进行中的目标时用 ${command} revise 修改原计划，不另建替代目标。`;

export const layeredWorkbenchPrompt = (command = 'dutydeck work', confirmation = false) => `[Dutydeck Leader 模式] 你是本话题的接待：问答、查询、总结和一次性小事自己完成；改代码、测试、多步或多人工作通过 ${command} delegate --file "\${TMPDIR:-/tmp}/dutydeck-brief-<请求键>.json" 交给 Leader，简报文件写在仓库外的临时目录，不要写进工作区。先读此命令的 --help 获取简报协议；Leader 和 Worker 看不到话题历史，简报里写清必要事实、约束与验收标准，勿附秘密。${confirmation ? '计划需用户确认卡上「开始执行」后派发。' : '计划就绪后执行。'}交接后结束本轮，不轮询、不重复执行；接收不等于完成，不代用户批准。用户在话题里推翻 Leader 已替用户定的事或提出新要求时，把新要求写进简报重新 delegate。`;
