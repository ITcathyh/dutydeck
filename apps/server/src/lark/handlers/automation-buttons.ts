import { executeScheduleCommand, scheduleRequestCard } from '../schedule-command.js';
import { readLarkConfig } from '../config.js';
import type { LarkMessageEvent } from '../listener.js';
import type { CallbackHandler } from './button-context.js';

export const scheduleToggle: CallbackHandler = async (ctx, { workflow, operatorOpenId, context, key }) => {
  const verb = (key === 'dutydeck_schedule_enable' ? 'enable' : 'disable') === 'enable' ? '启用' : '停用';
  const scheduleId = (workflow[key] as string).trim();
  if (!scheduleId || !context?.chatId || !operatorOpenId || !ctx.reconcileConfig || !ctx.store) {
    return { type: 'error', content: `卡片已失效，无法${verb}计划。` };
  }
  const automation = ctx.automation;
  if (!automation) return { type: 'error', content: '当前服务尚未接入定时任务。' };
  const scheduleRecord = await automation.getSchedule(scheduleId);
  if (!scheduleRecord) return { type: 'warning', content: '当前话题没有此计划' };

  // 核对回调所在的卡片、聊天是否和计划冻结的投递位置一致，防止跨会话改动他人的计划
  const rawTarget = await ctx.store.get(`automation.delivery-target.${scheduleId}`);
  type DeliveryTarget = { appId: string; chatId: string; replyMessageId?: string; messageId?: string; replyInThread?: boolean };
  let target: DeliveryTarget | null = null;
  try { target = JSON.parse(rawTarget ?? 'null'); } catch {}
  if (!target || target.appId !== ctx.reconcileConfig.appId || target.chatId !== context.chatId) {
    return { type: 'warning', content: `这张卡不属于这个计划，无法${verb}。` };
  }
  if (context.messageId && target.messageId && target.messageId !== context.messageId) {
    return { type: 'warning', content: `这张卡不属于这个计划，无法${verb}。` };
  }

  const config = await readLarkConfig(ctx.store, ctx.reconcileConfig.appId);
  if (!config?.listening) return { type: 'warning', content: '机器人已停用，无法执行此操作。' };
  if (!await ctx.isOperatorAllowed(config, operatorOpenId, context.chatId, scheduleRecord.sessionId)) {
    return { type: 'warning', content: '当前账号没有操作此任务的权限。' };
  }
  try {
    const dummyEvent: LarkMessageEvent = {
      messageId: context.messageId ?? '',
      chatId: context.chatId,
      chatType: context.chatId.startsWith('oc_') ? 'group' : 'p2p',
      senderOpenId: operatorOpenId,
      messageType: 'text',
      content: '',
      mentions: []
    };
    const content = await executeScheduleCommand(
      automation,
      ctx.store,
      scheduleRecord.sessionId,
      `${(key === 'dutydeck_schedule_enable' ? 'enable' : 'disable')} ${scheduleId}`,
      dummyEvent,
      config
    );
    // 确认卡原位改成新状态；结果卡上的「停用此计划」不重绘，结果正文保持原样。
    if (workflow?.card === 'request' && context.messageId) {
      const messageId = context.messageId, replyInThread = target.replyInThread === true;
      void automation.listBySession(scheduleRecord.sessionId, operatorOpenId)
        .then(({ schedules }) => { const schedule = schedules.find(item => item.id === scheduleId); return schedule && ctx.service.update({ messageId, ...scheduleRequestCard(schedule, replyInThread) }); })
        .catch(error => ctx.log.warn({ error, scheduleId }, '定时任务确认卡未能更新'));
    }
    return { type: 'success', content };
  } catch (error) {
    return { type: 'warning', content: error instanceof Error ? error.message : String(error) };
  }
};
