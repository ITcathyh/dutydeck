import { agentSettingsRequestSchema } from './lark/agent-settings.js';
/**
 * 飞书会话里的 Agent 替这一轮发起人办事，用户说人话就行，不用记命令：
 * - 定时任务（schedule request）：计划建好先停用，宿主在原话题发确认卡，用户点「启用」才开始。计划、执行身份、权限与回报位置
 *   都和用户在这里发 /schedule 相同。
 * - 其他 / 命令（command）：交给这个机器人的消息处理器，按用户在原话题自己发这条命令处理（见 lark/agent-command.ts）。
 * - dutydeck agent 的查看类（views）和写入类（actions）：参数换成同一条 / 命令交给消息处理器，查看类的结果交回给 Agent，不发卡。
 * 都只能在正在执行的这一轮、以这一轮发起人的身份做；定时或自动续作触发的一轮不能做。不带 --turn 时按执行中的这一轮认。
 */
import { runAgentScheduleRequest } from './agent-schedule-request.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RuntimeError, type PublicSessionSchedule } from '@dutydeck/shared';
import { agentGroupToolBearerToken, type LarkAgentToolsService } from './lark/agent-tools.js';
import { AgentCommandParamError, agentActionCommand, larkAgentViews, type LarkAgentViewName } from './lark/agent-command.js';
import type { SessionAutomationService } from './session-automation.js';


const commandSchema = z.object({ command: z.string().trim().min(1).max(4000) }).strict();

/** 不是有人发的消息、而是自动提交的一轮：定时计划、CI 自动续作，以及 CI webhook 和 PR 跟进派发的修复轮（按派发键认）。 */
export const isAutomatedRequest = (request?: { namespace: string; key: string }) =>
  ['schedule', 'automation'].includes(request?.namespace ?? '') || /^(ci-webhook|pull-request):/.test(request?.key ?? '');

export interface AgentRequestToolsOptions {
  runtime: { getActiveTaskContext(sessionId: string): { taskId: string; actorId?: string } | undefined };
  /** 定时或自动续作触发的一轮不能再代办，免得每次到点又建一个计划、又发一条命令。 */
  automatedTask(taskId: string): boolean;
  tools: Pick<LarkAgentToolsService, 'requestContext' | 'assertWorkbenchTurn' | 'commands'>;
  automation: Pick<SessionAutomationService, 'createSchedule'>;
  /** 回报位置定为这一轮请求的那条消息，和用户在那里发 /schedule 一样。 */
  prepareDelivery(sessionId: string, taskId: string, scheduleId: string): Promise<void>;
  /** 把确认卡发到计划的回报位置；同一计划重复调用只发一张。 */
  sendConfirmation(schedule: PublicSessionSchedule): Promise<void>;
}

export async function registerAgentRequestTools(app: FastifyInstance, options: AgentRequestToolsOptions) {
  const turnContext = async (request: FastifyRequest) => {
    const binding = await options.tools.requestContext(agentGroupToolBearerToken(request.headers.authorization));
    const active = options.runtime.getActiveTaskContext(binding.sessionId);
    if (!active?.actorId) throw new RuntimeError('AGENT_REQUEST_ACTOR_REQUIRED', '只能在正在执行的飞书指令里代办。', 403);
    if (options.automatedTask(active.taskId)) throw new RuntimeError('AGENT_REQUEST_AUTOMATED', '定时任务或自动续作执行的这一轮不能代办。', 403);
    const turn = request.headers['x-dutydeck-work-turn'];
    options.tools.assertWorkbenchTurn(binding.sessionId, active.taskId, typeof turn === 'string' ? turn : undefined);
    return { appId: binding.appId, sessionId: binding.sessionId, taskId: active.taskId, actorId: active.actorId };
  };
  app.post('/api/lark/agent-tools/commands', async request => {
    const { appId, ...turn } = await turnContext(request);
    return await options.tools.commands.run(appId, { ...turn, command: commandSchema.parse(request.body).command });
  });
  app.post<{ Params: { name: string }; Body: Record<string, unknown> | undefined }>('/api/lark/agent-tools/actions/:name', async request => {
    const { appId, ...turn } = await turnContext(request);
    const { dryRun, ...params } = request.body ?? {};
    if (dryRun !== undefined && typeof dryRun !== 'boolean') throw new AgentCommandParamError('INVALID_ARGUMENT', '--dry-run 不带值。', [{ name: '--dry-run', reason: '不带值' }]);
    const { command, members } = agentActionCommand(request.params.name, params);
    return await options.tools.commands.run(appId, { ...turn, command, action: request.params.name, dryRun: dryRun === true, ...(members ? { members } : {}) });
  });
  app.get<{ Params: { name: string }; Querystring: { page?: string } }>('/api/lark/agent-tools/views/:name', async request => {
    const { appId, ...turn } = await turnContext(request);
    const view = request.params.name as LarkAgentViewName;
    if (!larkAgentViews.includes(view)) throw new AgentCommandParamError('AGENT_ACTION_UNKNOWN', `没有 ${request.params.name} 这个查看命令。`, [{ name: '<命令>', reason: `可用：${larkAgentViews.join('、')}` }]);
    const page = request.query.page === undefined ? undefined : Number(request.query.page);
    if (page !== undefined && (!Number.isInteger(page) || page < 1)) throw new AgentCommandParamError('INVALID_ARGUMENT', '--page 要是从 1 开始的整数。', [{ name: '--page', reason: '要是从 1 开始的整数' }]);
    return await options.tools.commands.view(appId, { ...turn, view, ...(page !== undefined ? { page } : {}) });
  });
  app.get('/api/lark/agent-tools/settings', async request => {
    const { appId, ...turn } = await turnContext(request);
    return options.tools.commands.settings(appId, { ...turn, action: 'show' });
  });
  app.post('/api/lark/agent-tools/settings', async request => {
    const { appId, ...turn } = await turnContext(request);
    const body = agentSettingsRequestSchema.parse(request.body);
    return options.tools.commands.settings(appId, { ...turn, action: 'set', ...body });
  });
  app.post('/api/lark/agent-tools/schedules', async request => {
    const { sessionId, taskId, actorId } = await turnContext(request);
    return runAgentScheduleRequest({ automation: options.automation,
      prepareDelivery: id => options.prepareDelivery(sessionId, taskId, id), sendConfirmation: options.sendConfirmation
    }, { sessionId, requestId: taskId, actorId }, request.body);
  });
}
