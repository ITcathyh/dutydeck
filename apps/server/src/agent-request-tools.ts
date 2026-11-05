import { agentSettingsRequestSchema } from './lark/agent-settings.js';
/**
 * 飞书会话里的 Agent 替这一轮发起人办事，用户说人话就行，不用记命令：
 * - 定时任务（schedule request）：计划建好先停用，宿主在原话题发确认卡，用户点「启用」才开始。计划、执行身份、权限与回报位置
 *   都和用户在这里发 /schedule 相同。
 * - 其他 / 命令（command）：交给这个机器人的消息处理器，按用户在原话题自己发这条命令处理（见 lark/agent-command.ts）。
 * - dutydeck agent 的查看类（views）和写入类（actions）：参数换成同一条 / 命令交给消息处理器，查看类的结果交回给 Agent，不发卡。
 * 都只能在正在执行的这一轮、以这一轮发起人的身份做；定时或自动续作触发的一轮仅能请求停用自身周期计划。必须使用宿主在本轮提供的任务尝试凭证。
 */
import { runAgentScheduleRequest } from './agent-schedule-request.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RuntimeError, resolveScheduleDeadline, type PublicSessionSchedule } from '@dutydeck/shared';
import { agentGroupToolBearerToken, type LarkAgentToolsService } from './lark/agent-tools.js';
import { AgentCommandParamError, agentActionCommand, larkAgentViews, type LarkAgentViewName } from './lark/agent-command.js';
import type { SessionAutomationService } from './session-automation.js';


const commandSchema = z.object({ command: z.string().trim().min(1).max(4000) }).strict();

/** 不是有人发的消息、而是自动提交的一轮：定时计划、CI 自动续作，以及 CI webhook 和 PR 跟进派发的修复轮（按派发键认）。 */
export const isAutomatedRequest = (request?: { namespace: string; key: string }) =>
  ['schedule', 'automation'].includes(request?.namespace ?? '') || /^(ci-webhook|pull-request):/.test(request?.key ?? '');

export interface AgentRequestToolsOptions {
  runtime: { getActiveTaskContext(sessionId: string): { taskId: string; actorId?: string; attemptId?: string } | undefined };
  /** 定时或自动续作触发的一轮不能再代办，免得每次到点又建一个计划、又发一条命令。 */
  automatedTask(taskId: string): boolean;
  tools: Pick<LarkAgentToolsService, 'requestContext' | 'assertWorkbenchTurn' | 'commands'>;
  automation: Pick<SessionAutomationService, 'requestSchedule'> & Partial<Pick<SessionAutomationService, 'requestScheduleStop' | 'listBySession' | 'updateSchedule'>>;
  /** 回报位置定为这一轮请求的那条消息，和用户在那里发 /schedule 一样。 */
  prepareDelivery(sessionId: string, taskId: string, scheduleId: string): Promise<void>;
  /** 把确认卡发到计划的回报位置；同一计划重复调用只发一张。 */
  sendConfirmation(schedule: PublicSessionSchedule): Promise<void>;
}

export async function registerAgentRequestTools(app: FastifyInstance, options: AgentRequestToolsOptions) {
  const turnContext = async (request: FastifyRequest, allowAutomated = false) => {
    const binding = await options.tools.requestContext(agentGroupToolBearerToken(request.headers.authorization));
    const active = options.runtime.getActiveTaskContext(binding.sessionId);
    if (!active?.actorId) throw new RuntimeError('AGENT_REQUEST_ACTOR_REQUIRED', '只能在正在执行的飞书指令里代办。', 403);
    if (!allowAutomated && options.automatedTask(active.taskId)) throw new RuntimeError('AGENT_REQUEST_AUTOMATED', '定时任务或自动续作执行的这一轮不能代办。', 403);
    const turn = request.headers['x-dutydeck-work-turn'];
    options.tools.assertWorkbenchTurn(binding.sessionId, active.taskId, active.attemptId, typeof turn === 'string' ? turn : undefined);
    return { appId: binding.appId, sessionId: binding.sessionId, taskId: active.taskId, actorId: active.actorId };
  };
  app.post('/api/lark/agent-tools/schedules/stop-self', async request => {
    z.object({}).strict().parse(request.body ?? {});
    const { sessionId, taskId, actorId } = await turnContext(request, true);
    const active = options.runtime.getActiveTaskContext(sessionId);
    if (!active?.attemptId || active.taskId !== taskId || !options.automation.requestScheduleStop) throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Only an active scheduled task may request self stop', 403);
    return options.automation.requestScheduleStop(sessionId, taskId, active.attemptId, actorId);
  });
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
  app.patch<{ Params: { id: string } }>('/api/lark/agent-tools/schedules/:id', async request => {
    const { sessionId, actorId, taskId } = await turnContext(request);
    const body = z.object({ prompt: z.string().trim().min(1).optional(), name: z.string().trim().min(1).optional(),
      every: z.number().int().positive().optional(), cron: z.string().min(1).optional(), at: z.string().min(1).optional(),
      mode: z.enum(['session', 'fresh']).optional(), until: z.string().trim().min(1).max(2_000).optional(), deadline: z.string().trim().min(1).optional(),
      dryRun: z.boolean().optional() }).strict().parse(request.body);
    if ([body.every, body.cron, body.at].filter(value => value !== undefined).length > 1) throw new RuntimeError('SCHEDULE_REQUEST_INVALID', '--every、--cron、--at 只选一个。', 400);
    if (!options.automation.listBySession || !options.automation.updateSchedule) throw new RuntimeError('SESSION_AUTOMATION_UNAVAILABLE', '当前实例不支持更新计划。', 503);
    const current = (await options.automation.listBySession(sessionId, actorId)).schedules.find(item => item.id === request.params.id);
    if (!current) throw new RuntimeError('SESSION_AUTOMATION_SCHEDULE_NOT_FOUND', '本事项没有这个可见的计划。', 404);
    const { every, cron, at, dryRun, until, deadline, ...rest } = body;
    let deadlineAt: string | undefined;
    if (deadline !== undefined) {
      // 与新建一致按北京时间解释，不随计划时区变化；错误提示也写的是北京时间。
      try { deadlineAt = resolveScheduleDeadline(deadline, 'Asia/Shanghai'); }
      catch { throw new AgentCommandParamError('INVALID_ARGUMENT', '--deadline 要写北京时间 YYYY-MM-DDTHH:mm。', [{ name: '--deadline', reason: '格式 YYYY-MM-DDTHH:mm' }]); }
    }
    const fields = { ...rest, ...(until !== undefined ? { completionCondition: until } : {}), ...(deadlineAt ? { deadlineAt } : {}) };
    const trigger = every !== undefined ? { kind: 'interval' as const, everySeconds: every * 60, anchorAt: new Date().toISOString() }
      : cron !== undefined ? { kind: 'cron' as const, expression: cron } : at !== undefined ? { kind: 'at' as const, localDateTime: at } : undefined;
    if (!trigger && Object.values(fields).every(value => value === undefined)) throw new RuntimeError('SCHEDULE_REQUEST_INVALID', '请提供要修改的时间或内容。', 400);
    const patch = { ...fields, ...(trigger ? { trigger } : {}), expectedRevision: current.revision, enabled: false };
    if (dryRun) return { dryRun: true, scheduleId: current.id, needsConfirmation: true, effect: '更新原计划并暂停，用户确认启用后执行。' };
    const schedule = await options.automation.updateSchedule(current.sessionId, current.id, patch, actorId);
    await options.sendConfirmation(schedule);
    return { scheduleId: schedule.id, updated: true, pendingConfirmation: true, message: '已更新原计划并发确认卡，用户确认启用后执行。' };
  });
  app.post('/api/lark/agent-tools/schedules', async request => {
    const { sessionId, taskId, actorId } = await turnContext(request);
    return runAgentScheduleRequest({ automation: options.automation,
      prepareDelivery: id => options.prepareDelivery(sessionId, taskId, id), sendConfirmation: options.sendConfirmation
    }, { sessionId, requestId: taskId, actorId }, request.body);
  });
}
