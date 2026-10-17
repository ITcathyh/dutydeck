import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createSessionScheduleInputSchema, describeScheduleTrigger, previewSessionSchedule, type PublicSessionSchedule } from '@dutydeck/shared';
import { AgentCommandParamError, agentParamIssues } from './lark/agent-command.js';
import type { SessionAutomationService } from './session-automation.js';

const requestSchema = z.object({
  prompt: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  every: z.number().int().min(1).max(525_600).optional(),
  cron: z.string().trim().min(1).optional(),
  at: z.string().trim().min(1).optional(),
  dryRun: z.boolean().optional()
}).strict().refine(input => [input.every, input.cron, input.at].filter(value => value !== undefined).length === 1, { message: '--every、--cron、--at 只选一个', path: ['trigger'] });
const scheduleParam = (key: string) => key === 'trigger' ? '--every/--cron/--at' : `--${key}`;

export function parseAgentScheduleRequest(raw: unknown) {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    const params = agentParamIssues(parsed.error, scheduleParam);
    throw new AgentCommandParamError('INVALID_ARGUMENT', params.map(param => `${param.name}：${param.reason}`).join('；'), params, '运行 dutydeck agent schedule create --help 看用法。');
  }
  const { dryRun, ...body } = parsed.data;
  const trigger = body.every !== undefined ? { kind: 'interval' as const, everySeconds: body.every * 60, anchorAt: new Date().toISOString() }
    : body.cron !== undefined ? { kind: 'cron' as const, expression: body.cron } : { kind: 'at' as const, localDateTime: body.at! };
  const input = createSessionScheduleInputSchema.parse({ name: body.name ?? body.prompt.slice(0, 100), prompt: body.prompt, trigger,
    timezone: 'Asia/Shanghai', dstPolicy: { gap: 'skip', overlap: 'first' }, condition: { kind: 'always' } });
  let next: ReturnType<typeof previewSessionSchedule>;
  try { next = previewSessionSchedule({ id: 'preview', ...input }, new Date()); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AgentCommandParamError('SCHEDULE_REQUEST_INVALID', message, [{ name: scheduleParam(body.every !== undefined ? 'every' : body.cron !== undefined ? 'cron' : 'at'), reason: message }]);
  }
  return { body, dryRun, input, next };
}

export interface LarkScheduleMessageOrigin { appId: string; chatId: string; messageId: string; replyInThread: boolean }
export interface LarkScheduleRequests {
  prepareDelivery(sessionId: string, origin: LarkScheduleMessageOrigin, scheduleId: string): Promise<void>;
  sendConfirmation(schedule: PublicSessionSchedule, notice?: string): Promise<void>;
}

export async function runAgentScheduleRequest(options: {
  automation: Pick<SessionAutomationService, 'createSchedule'>;
  prepareDelivery(scheduleId: string): Promise<void>;
  sendConfirmation(schedule: PublicSessionSchedule): Promise<void>;
}, origin: { sessionId: string; requestId: string; actorId: string }, raw: unknown) {
  const { sessionId, requestId, actorId } = origin;
  const { body, dryRun, input, next } = parseAgentScheduleRequest(raw);
  if (dryRun) return { dryRun: true, needsConfirmation: true, schedule: { name: input.name, prompt: input.prompt, when: describeScheduleTrigger(input.trigger, input.timezone), timezone: input.timezone, ...(next ? { nextRunAt: next.localLabel } : {}) },
    confirmCard: { title: '定时任务', body: `**做什么**：${input.prompt}\n**什么时候**：${describeScheduleTrigger(input.trigger, input.timezone)}\n点「启用」后开始，不点不会执行。` },
    effect: '在本轮请求消息下发启用卡；计划先建成停用状态，用户点「启用」后才开始，结果发回当前对话。' };
  // 同一条消息里同样的请求重试时拿回同一个计划，不会再建一个、再发一张卡。
  const schedule = await options.automation.createSchedule(sessionId, input, actorId, {
    key: `agent-request:${createHash('sha256').update(JSON.stringify([requestId, body])).digest('hex')}`,
    prepareDelivery: id => options.prepareDelivery(id)
  });
  if (schedule.enabled) return { pendingConfirmation: false, scheduleId: schedule.id, message: '用户已经启用了这个定时任务。' };
  await options.sendConfirmation(schedule);
  return { pendingConfirmation: true, scheduleId: schedule.id, message: '已发确认卡，用户点「启用」后才开始。只回一句已发卡，不要说已设置，也不要让用户发命令。' };
}
