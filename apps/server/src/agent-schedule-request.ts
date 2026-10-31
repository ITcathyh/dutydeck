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
  /** fresh：每次在新会话里执行，不带本对话历史；session：接着本对话做。不填时新建的循环计划用 fresh，一次性（--at）沿用本对话；更新同名计划时不改它的模式。 */
  mode: z.enum(['session', 'fresh']).optional(),
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
  let input: ReturnType<typeof createSessionScheduleInputSchema.parse>;
  let next: ReturnType<typeof previewSessionSchedule>;
  try {
    input = createSessionScheduleInputSchema.parse({ name: body.name ?? body.prompt.slice(0, 100), prompt: body.prompt, trigger,
      timezone: 'Asia/Shanghai', dstPolicy: { gap: 'skip', overlap: 'first' }, condition: { kind: 'always' }, ...(body.mode ? { mode: body.mode } : {}) });
    next = previewSessionSchedule({ id: 'preview', ...input }, new Date());
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AgentCommandParamError('SCHEDULE_REQUEST_INVALID', message, [{ name: scheduleParam(body.every !== undefined ? 'every' : body.cron !== undefined ? 'cron' : 'at'), reason: message }]);
  }
  return { body, dryRun, input, next };
}

export interface LarkScheduleMessageOrigin { appId: string; chatId: string; messageId: string; replyInThread: boolean }
export interface LarkScheduleRequests {
  prepareDelivery(sessionId: string, origin: LarkScheduleMessageOrigin, scheduleId: string): Promise<void>;
  sendConfirmation(schedule: PublicSessionSchedule, notice?: string, requestId?: string): Promise<void>;
}

export async function runAgentScheduleRequest(options: {
  automation: Pick<SessionAutomationService, 'requestSchedule'>;
  prepareDelivery(scheduleId: string): Promise<void>;
  sendConfirmation(schedule: PublicSessionSchedule, notice?: string, requestId?: string): Promise<void>;
}, origin: { sessionId: string; requestId: string; actorId: string }, raw: unknown) {
  const { sessionId, requestId, actorId } = origin;
  const { body, dryRun, input, next } = parseAgentScheduleRequest(raw);
  const newMode = body.mode === undefined && input.trigger.kind !== 'at' ? 'fresh' as const : undefined;
  if (dryRun) return { dryRun: true, needsConfirmation: true, schedule: { name: input.name, prompt: input.prompt, when: describeScheduleTrigger(input.trigger, input.timezone), timezone: input.timezone, ...(next ? { nextRunAt: next.localLabel } : {}) },
    confirmCard: { title: '定时任务', body: `**做什么**：${input.prompt}\n**什么时候**：${describeScheduleTrigger(input.trigger, input.timezone)}\n点「启用」后开始，不点不会执行。` },
    effect: `在本轮请求消息下发启用卡；计划先建成停用状态，用户点「启用」后才开始，结果发回当前对话。本对话已有同名计划时改为更新它，不新建。${(input.mode ?? newMode) === 'fresh' ? '每次在新会话里执行，不带本对话历史。' : ''}` };
  // 同一条消息里同样的请求重试时拿回同一个计划，不会再建一个、再发一张卡；同名计划改为更新。
  const { schedule, updated } = await options.automation.requestSchedule(sessionId, input, actorId, {
    key: `agent-request:${createHash('sha256').update(JSON.stringify([requestId, body])).digest('hex')}`, newMode,
    prepareDelivery: id => options.prepareDelivery(id)
  });
  const unchanged = updated !== undefined && !updated.changed;
  if (unchanged && schedule.enabled) {
    return { pendingConfirmation: false, updated: false, scheduleId: schedule.id, message: '本对话已有同名定时任务，设置相同且仍在启用，没有改动。' };
  }
  if (schedule.enabled) return { pendingConfirmation: false, scheduleId: schedule.id, message: '用户已经启用了这个定时任务。' };
  const notice = !updated ? undefined
    : updated.changed ? `已更新本对话里同名的现有任务「${schedule.name}」，没有新建。${updated.wasEnabled ? '原任务已暂停，' : ''}点「确认启用」后按下面的设置执行。`
      : `本对话已有同名任务「${schedule.name}」，设置相同，尚未启用，没有改动。点「确认启用」后开始执行。`;
  // 命中同名计划时卡片按请求去重：没有改动时修订号不变，只按修订去重会吞掉这次请求的卡；同一请求重试仍只发一张。
  try { await options.sendConfirmation(schedule, notice, updated ? requestId : undefined); }
  catch (error) {
    return { saved: true, pendingConfirmation: true, scheduleId: schedule.id, confirmationDelivery: 'failed' as const,
      warning: { code: 'SCHEDULE_CONFIRMATION_DELIVERY_FAILED', message: error instanceof Error ? error.message : String(error) },
      message: `计划已保存但确认卡未送达，当前停用，不会执行。可在本轮用相同参数重试补发确认卡，不要修改参数重复创建；也可告诉用户在当前对话发送 /schedule enable ${schedule.id} 手动启用。` };
  }
  if (unchanged) return { pendingConfirmation: true, updated: false, scheduleId: schedule.id, message: '本对话已有同名定时任务，设置相同但尚未启用，没有改动；已重新发确认卡，用户点「启用」后才开始。只回一句已重新发卡，不要说已更新或新建了任务，也不要让用户发命令。' };
  if (updated) return { pendingConfirmation: true, updated: true, scheduleId: schedule.id, message: '已更新同名的现有任务并发确认卡，用户点「启用」后按新设置执行。只回一句已更新现有任务并发卡，不要说新建了任务，也不要让用户发命令。' };
  return { pendingConfirmation: true, scheduleId: schedule.id, message: '已发确认卡，用户点「启用」后才开始。只回一句已发卡，不要说已设置，也不要让用户发命令。' };
}
