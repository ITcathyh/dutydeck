import { parseLarkSourceId } from '@dutydeck/shared';
import { executeScheduleCommand, scheduleRequestCard } from '../schedule-command.js';
import { readLarkConfig } from '../config.js';
import type { LarkMessageEvent } from '../listener.js';
import type { CallbackHandler } from './button-context.js';

export const scheduleToggle: CallbackHandler = async (ctx, { workflow, operatorOpenId, context, key }) => {
  const verb = (key === 'dutydeck_schedule_enable' ? 'enable' : 'disable') === 'enable' ? '启用' : '停用';
  const scheduleId = (workflow[key] as string).trim();
  if (!scheduleId || !context?.chatId || !operatorOpenId || !ctx.reconcileConfig) {
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

export const ciFix: CallbackHandler = async (ctx, { workflow, operatorOpenId, context }) => {
  const ciWebhook = ctx.automation?.ciWebhook;
  if (!ciWebhook || !ctx.reconcileConfig || !context?.messageId || !context.chatId || !operatorOpenId || typeof workflow.failure !== 'string') {
    return { type: 'error', content: 'CI 失败卡已失效，请发送 /ci 查看最新状态。' };
  }
  try {
    const config = await readLarkConfig(ctx.store, ctx.reconcileConfig.appId);
    if (!config?.listening) return { type: 'warning', content: '机器人已停用，无法开始修复。' };
    const subscription = await ciWebhook.get(workflow.dutydeck_ci_fix as string);
    const session = subscription ? await ctx.runtime.getSession(subscription.sessionId) : undefined;
    const { appId, chatId } = parseLarkSourceId(session?.source === 'lark' ? session.sourceId : undefined);
    if (!subscription || appId !== config.appId || chatId !== context.chatId) return { type: 'warning', content: '这张 CI 失败卡不属于当前会话。' };
    if (!await ctx.isOperatorAllowed(config, operatorOpenId, context.chatId, subscription.sessionId)) return { type: 'warning', content: '当前账号没有操作此任务的权限。' };
    return { type: 'success', content: await ciWebhook.requestFix(subscription.id, { failureKey: workflow.failure, cardMessageId: context.messageId }, operatorOpenId) };
  } catch (error) { return { type: 'error', content: error instanceof Error ? error.message : String(error) }; }
};

export const pullRequest: CallbackHandler = async (ctx, { workflow, operatorOpenId, context }) => {
  const pullRequests = ctx.automation?.pullRequests;
  if (!pullRequests || !ctx.reconcileConfig || !context?.messageId || !context.chatId || !operatorOpenId) return { type: 'error', content: '这张卡片已失效，请重新发送 /pr。' };
  try {
    const config = await readLarkConfig(ctx.store, ctx.reconcileConfig.appId);
    if (!config?.listening) return { type: 'warning', content: '机器人已停用，无法执行此操作。' };
    const record = await pullRequests.get(workflow.dutydeck_pr as string);
    const session = record ? await ctx.runtime.getSession(record.sessionId) : undefined;
    const { appId, chatId, chatType } = parseLarkSourceId(session?.source === 'lark' ? session.sourceId : undefined);
    if (!record || appId !== config.appId || chatId !== context.chatId) return { type: 'warning', content: '这张卡片不属于当前会话。' };
    const effective = chatType === 'group' && ctx.groupManager ? await ctx.groupManager.resolved(config, context.chatId) : config;
    if (!await ctx.isOperatorAllowed(effective, operatorOpenId, context.chatId, record.sessionId, record.actorId)) return { type: 'warning', content: '当前账号没有操作此任务的权限。' };
    const op = workflow.op;
    if (op === 'confirm') return { type: 'success', content: (await pullRequests.confirm(record.id, operatorOpenId, { messageId: context.messageId })).message };
    if (op === 'cancel' || op === 'stop') {
      const updated = await pullRequests.cancel(record.sessionId, record.id);
      return { type: 'success', content: updated.status === 'cancelled' ? '已取消，没有推送任何内容。' : updated.status === 'stopped' ? '已停止自动跟进，PR 本身不受影响。' : `当前状态：${updated.reason ?? updated.status}` };
    }
    // 推送前验证没过的卡上「仍然推送」：权限与确认推送相同（上面同一道门）。
    if (op === 'force_push') return { type: 'success', content: await pullRequests.forcePush(record.id, { messageId: context.messageId }) };
    if (op === 'answer' && typeof workflow.comment === 'string' && (workflow.choice === 'apply' || workflow.choice === 'ignore')) {
      return { type: 'success', content: await pullRequests.answer(record.id, { commentId: workflow.comment, choice: workflow.choice, cardMessageId: context.messageId }) };
    }
    return { type: 'error', content: '无法识别的操作。' };
  } catch (error) { return { type: 'error', content: error instanceof Error ? error.message : String(error) }; }
};

export const mandate: CallbackHandler = async (ctx, { workflow, operatorOpenId, context }) => {
  const cards = ctx.automation?.mandateCards;
  if (!cards || !ctx.reconcileConfig) return { type: 'error', content: '这张卡片已失效。' };
  try { return { type: 'success', content: await cards.callback(ctx.reconcileConfig.appId, workflow, operatorOpenId, { messageId: context?.messageId, chatId: context?.chatId }) }; }
  catch (error) { return { type: 'error', content: error instanceof Error ? error.message : String(error) }; }
};

export const workItem: CallbackHandler = async (ctx, { workflow, operatorOpenId, context }) => {
  if (!ctx.workbench || !ctx.reconcileConfig || !context) return { type: 'error', content: '目标卡片已失效。' };
  try { return { type: 'success', content: await ctx.workbench.callback(workflow, operatorOpenId, context, ctx.reconcileConfig) }; }
  catch (error) { return { type: 'error', content: error instanceof Error ? error.message : String(error) }; }
};
