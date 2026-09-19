import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import { createWorkItemSchema, RuntimeError, toPublicAgent } from '@dutydeck/shared';
import type { LarkAgentToolsService } from './lark/agent-tools.js';
import { agentGroupToolBearerToken } from './lark/agent-tools.js';
import { discoverSkills } from './skill-catalog.js';
import type { WorkItemService } from './work-items.js';
import { runTemplateInput, templateNameInput, workInput } from './work-item-routes.js';

const requestKey = (taskId: string, key: string) => createHash('sha256').update(JSON.stringify([taskId, key])).digest('hex');

export interface WorkItemToolsOptions { runtime: DutydeckRuntime; work: WorkItemService; tools: LarkAgentToolsService }

export async function registerWorkItemTools(app: FastifyInstance, options: WorkItemToolsOptions) {
  const context = async (authorization?: string, turn?: string | string[]) => {
    const scope = await options.tools.workbenchContext(agentGroupToolBearerToken(authorization));
    const active = options.runtime.getActiveTaskContext(scope.sessionId);
    if (!active?.actorId) throw new RuntimeError('WORK_ITEM_ACTIVE_ACTOR_REQUIRED', '编排工具只接受当前正在执行的飞书指令', 403);
    options.tools.assertWorkbenchTurn(scope.sessionId, active.taskId, typeof turn === 'string' ? turn : undefined);
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
    return { skills: await discoverSkills(session!.cwd), delivery: 'prompt snapshot at step acceptance; tool authorization is checked separately' };
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
  app.get<{ Params: { id: string } }>(`${base}/:id`, async request => {
    const scope = await context(request.headers.authorization, request.headers['x-dutydeck-work-turn']);
    return options.work.get(scope.sessionId, request.params.id, scope.actorId);
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

/** confirmation=true 表示本话题的计划要等人工确认才派发，提示词必须如实告知 Agent。 */
export const workbenchAgentPrompt = (command = 'dutydeck work', confirmation = false) => `[Dutydeck 目标编排]
用户要求多 Agent 独立协作、可重复工作流或分阶段等待时，可通过以下本机工具安排后台步骤。普通单步工作直接完成。
- ${command} agents：查询本实例配置的 Agent ID。配置存在不证明工具已授权。
- ${command} skills：发现当前工作区的 Skill。步骤可用 skills:["名称"] 选择；内容在步骤接收时固定，不能据名称宣称工具已授权。
- ${command} list / show <目标编号>：读取本话题中当前操作者的目标与模板。
- ${command} create --file <JSON文件>：持久接收计划后返回目标编号。JSON 格式为 {"goal":"本次目标与允许分享的材料","idempotencyKey":"本轮稳定且唯一的请求键","plan":{"title":"流程名称","steps":[{"id":"analyze","title":"分析","kind":"agent","agentId":"从agents取得的ID","instruction":"具体任务及完整成果要求","dependsOn":[],"workspaceMode":"shared"},{"id":"report","title":"汇总","kind":"agent","agentId":"从agents取得的ID","instruction":"依据上游产物输出完整成果","dependsOn":["analyze"],"workspaceMode":"shared"}],"outputStepId":"report"}}。
最多 12 步，无循环；依赖全部完成后执行汇总，失败分支可独立重试。需要并行修改代码时显式使用 workspaceMode:worktree；shared 不提供写入隔离。每个后台步骤是独立 Session，只获得目标、步骤指令及上游成果；把必要来源和材料放入 goal/instruction，不转交无关群历史、账户信息或秘密。Agent 的最终回答被保存为步骤产物，不等于平台验证通过。
人工补充使用 kind:wait 的步骤，instruction 写具体问题，省略 agentId。可给后续步骤设置 when:{stepId:"上游等待ID",equals:"期望的完整回答"} 来选择分支。所有步骤必须通向一个不带条件的最终agent步骤。不要将普通完成反馈强制变为人工等待。
- ${command} save <目标编号> <流程名称>：保存不可变模板版本。
- ${command} run <模板编号> <版本> <新目标> --key <稳定请求键>：复用指定版本。
${confirmation
  ? '收到目标编号说明计划已持久接收，但状态是 awaiting_confirmation：一个步骤都还没派发。Dutydeck 会在本话题发出待确认卡片，用户点「开始执行」后才入队，点「取消计划」即作废。向用户简述分工和编号、说明需要其在卡片上确认后结束本轮，不要轮询确认结果。'
  : '收到目标编号说明计划已持久接收，不表示执行成功。向用户简述分工和编号后结束本轮。'}Dutydeck 会回传等待和最终成果，不要轮询占住父任务或另行重复发送最终报告。失败或结果未知时不要自动创建替代目标，先报告并由用户决定重试。工具不提供代替用户回答等待、批准权限或确认计划的入口。`;
