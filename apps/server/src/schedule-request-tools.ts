/**
 * Agent 代用户设置定时任务：用户说「每天 9 点汇总」这类话就行，不用记 /schedule。
 * 计划建好先停用，宿主在原话题发确认卡，用户点「启用」才开始执行。计划、执行身份、权限与回报位置
 * 都和用户在这里发 /schedule 相同；Agent 只能在正在执行的这一轮、以这一轮发起人的身份建。
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
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

export interface ScheduleRequestToolsOptions {
  runtime: { getActiveTaskContext(sessionId: string): { taskId: string; actorId?: string } | undefined };
  /** 定时或自动续作触发的一轮不能再建计划，免得每次到点又建一个。 */
  automatedTask(taskId: string): boolean;
  tools: Pick<LarkAgentToolsService, 'scheduleContext' | 'assertWorkbenchTurn'>;
  automation: Pick<SessionAutomationService, 'createSchedule'>;
  /** 回报位置定为这一轮请求的那条消息，和用户在那里发 /schedule 一样。 */
  prepareDelivery(sessionId: string, taskId: string, scheduleId: string): Promise<void>;
  /** 把确认卡发到计划的回报位置；同一计划重复调用只发一张。 */
  sendConfirmation(schedule: PublicSessionSchedule): Promise<void>;
}

export async function registerScheduleRequestTools(app: FastifyInstance, options: ScheduleRequestToolsOptions) {
  app.post('/api/lark/agent-tools/schedules', async request => {
    const { sessionId } = await options.tools.scheduleContext(agentGroupToolBearerToken(request.headers.authorization));
    const active = options.runtime.getActiveTaskContext(sessionId);
    if (!active?.actorId) throw new RuntimeError('SCHEDULE_REQUEST_ACTOR_REQUIRED', '只能在正在执行的飞书指令里设置定时任务。', 403);
    if (options.automatedTask(active.taskId)) throw new RuntimeError('SCHEDULE_REQUEST_AUTOMATED', '定时任务自己执行的这一轮不能再设置定时任务。', 403);
    const turn = request.headers['x-dutydeck-work-turn'];
    options.tools.assertWorkbenchTurn(sessionId, active.taskId, typeof turn === 'string' ? turn : undefined);
    const body = requestSchema.parse(request.body);
    const trigger = body.every !== undefined ? { kind: 'interval' as const, everySeconds: body.every * 60, anchorAt: new Date().toISOString() }
      : body.cron !== undefined ? { kind: 'cron' as const, expression: body.cron } : { kind: 'at' as const, localDateTime: body.at! };
    const input = createSessionScheduleInputSchema.parse({ name: body.name ?? body.prompt.slice(0, 100), prompt: body.prompt, trigger,
      timezone: 'Asia/Shanghai', dstPolicy: { gap: 'skip', overlap: 'first' }, condition: { kind: 'always' } });
    try { previewSessionSchedule({ id: 'preview', ...input }, new Date()); }
    catch (error) { throw new RuntimeError('SCHEDULE_REQUEST_INVALID', error instanceof Error ? error.message : String(error), 400); }
    // 同一轮里同样的请求重试时拿回同一个计划，不会再建一个、再发一张卡。
    const schedule = await options.automation.createSchedule(sessionId, input, active.actorId, {
      key: `agent-request:${createHash('sha256').update(JSON.stringify([active.taskId, body])).digest('hex')}`,
      prepareDelivery: id => options.prepareDelivery(sessionId, active.taskId, id)
    });
    if (schedule.enabled) return { pendingConfirmation: false, scheduleId: schedule.id, message: '用户已经启用了这个定时任务。' };
    await options.sendConfirmation(schedule);
    return { pendingConfirmation: true, scheduleId: schedule.id, message: '已发确认卡，用户点「启用」后才开始。只回一句已发卡，不要说已设置，也不要让用户发命令。' };
  });
}
