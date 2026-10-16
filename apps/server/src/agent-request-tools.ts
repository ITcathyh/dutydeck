/**
 * 飞书会话里的 Agent 替这一轮发起人办事，用户说人话就行，不用记命令：
 * - 定时任务（schedule request）：计划建好先停用，宿主在原话题发确认卡，用户点「启用」才开始。计划、执行身份、权限与回报位置
 *   都和用户在这里发 /schedule 相同。
 * - 其他 / 命令（command）：交给这个机器人的消息处理器，按用户在原话题自己发这条命令处理（见 lark/agent-command.ts）。
 * 两者都只能在正在执行的这一轮、以这一轮发起人的身份做；定时或自动续作触发的一轮不能做。
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RuntimeError, createSessionScheduleInputSchema, previewSessionSchedule, type PublicSessionSchedule } from '@dutydeck/shared';
import { agentGroupToolBearerToken, type LarkAgentToolsService } from './lark/agent-tools.js';
import type { SessionAutomationService } from './session-automation.js';

const requestSchema = z.object({
  prompt: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  every: z.number().int().min(1).max(525_600).optional(),
  cron: z.string().trim().min(1).optional(),
  at: z.string().trim().min(1).optional()
}).strict().refine(input => [input.every, input.cron, input.at].filter(value => value !== undefined).length === 1, { message: '--every、--cron、--at 只选一个' });

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
  app.post('/api/lark/agent-tools/schedules', async request => {
    const { sessionId, taskId, actorId } = await turnContext(request);
    const body = requestSchema.parse(request.body);
    const trigger = body.every !== undefined ? { kind: 'interval' as const, everySeconds: body.every * 60, anchorAt: new Date().toISOString() }
      : body.cron !== undefined ? { kind: 'cron' as const, expression: body.cron } : { kind: 'at' as const, localDateTime: body.at! };
    const input = createSessionScheduleInputSchema.parse({ name: body.name ?? body.prompt.slice(0, 100), prompt: body.prompt, trigger,
      timezone: 'Asia/Shanghai', dstPolicy: { gap: 'skip', overlap: 'first' }, condition: { kind: 'always' } });
    try { previewSessionSchedule({ id: 'preview', ...input }, new Date()); }
    catch (error) { throw new RuntimeError('SCHEDULE_REQUEST_INVALID', error instanceof Error ? error.message : String(error), 400); }
    // 同一轮里同样的请求重试时拿回同一个计划，不会再建一个、再发一张卡。
    const schedule = await options.automation.createSchedule(sessionId, input, actorId, {
      key: `agent-request:${createHash('sha256').update(JSON.stringify([taskId, body])).digest('hex')}`,
      prepareDelivery: id => options.prepareDelivery(sessionId, taskId, id)
    });
    if (schedule.enabled) return { pendingConfirmation: false, scheduleId: schedule.id, message: '用户已经启用了这个定时任务。' };
    await options.sendConfirmation(schedule);
    return { pendingConfirmation: true, scheduleId: schedule.id, message: '已发确认卡，用户点「启用」后才开始。只回一句已发卡，不要说已设置，也不要让用户发命令。' };
  });
}
