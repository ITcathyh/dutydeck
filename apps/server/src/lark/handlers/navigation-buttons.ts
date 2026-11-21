import { larkPermissionMode, readLarkConfig } from '../config.js';
import { parseLarkHelpPageValue, renderLarkCommandHelp } from '../commands.js';
import { larkPluginCommandHelp } from '../plugin-commands.js';
import type { LarkMessageEvent } from '../listener.js';
import type { CallbackHandler } from './button-context.js';

export const helpPage: CallbackHandler = async (ctx, { workflow, operatorOpenId, context }) => {
  const pageValue = parseLarkHelpPageValue(workflow);
  if (!pageValue) return { type: 'error', content: '无法识别帮助页码。' };
  if (!context?.messageId || !context.chatId || !operatorOpenId || !ctx.reconcileConfig) {
    return { type: 'error', content: '帮助卡片已失效，请重新发送 /help。' };
  }
  try {
    const config = await readLarkConfig(ctx.store, ctx.reconcileConfig.appId);
    if (!config?.listening) return { type: 'warning', content: '机器人已停用，无法查看命令帮助。' };
    if (!await ctx.isOperatorAllowed(config, operatorOpenId, context.chatId)) {
      return { type: 'warning', content: '当前账号无权使用命令帮助。' };
    }
    const pluginCommands = larkPluginCommandHelp({ botAppId: config.appId, ...(config.workspace ? { cwd: config.workspace } : {}) });
    const help = renderLarkCommandHelp(ctx.larkRouteCapabilities(), { page: pageValue.page, ...(pluginCommands.length ? { pluginCommands } : {}) });
    await ctx.service.update({ messageId: context.messageId, taskId: context.messageId, taskName: help.title,
      state: 'completed', readOnly: true, permissionMode: larkPermissionMode(config), markdown: help.text, elements: help.elements });
    return { type: 'success', content: `帮助第 ${help.page}/${help.totalPages} 页。` };
  } catch (error) {
    ctx.log.warn({ error }, '翻页命令帮助失败');
    return { type: 'error', content: '翻页失败，请稍后重试或重新发送 /help。' };
  }
};

export const taskPage: CallbackHandler = async (ctx, { workflow, operatorOpenId, context }) => {
  if (workflow.dutydeck_task_dashboard !== 'page' || typeof workflow.page !== 'number'
    || !Number.isSafeInteger(workflow.page) || workflow.page < 1) return { type: 'error', content: '无法识别任务列表页码。' };
  if (!context?.messageId || !context.chatId || !operatorOpenId || !ctx.reconcileConfig) {
    return { type: 'error', content: '任务列表已失效，请重新发送 /tasks。' };
  }
  try {
    const saved = await ctx.store.get(`lark.task_dashboard.${ctx.reconcileConfig.appId}.${context.messageId}`);
    if (!saved) return { type: 'warning', content: '任务列表已失效，请重新发送 /tasks。' };
    const event = JSON.parse(saved) as LarkMessageEvent;
    if (event.chatId !== context.chatId || event.senderOpenId !== operatorOpenId) {
      return { type: 'warning', content: '请发送 /tasks 查看你自己的任务列表。' };
    }
    const config = await readLarkConfig(ctx.store, ctx.reconcileConfig.appId);
    if (!config?.listening) return { type: 'warning', content: '机器人已停用，无法刷新任务列表。' };
    const elements = await ctx.taskDashboard(event, config, workflow.page);
    await ctx.service.update({ messageId: context.messageId, taskId: event.messageId, taskName: '任务导航',
      state: 'completed', readOnly: true, permissionMode: larkPermissionMode(config), elements });
    return { type: 'success', content: '任务列表已更新。' };
  } catch (error) {
    ctx.log.warn({ error }, '刷新任务列表失败');
    return { type: 'error', content: '刷新失败，请稍后重试或重新发送 /tasks。' };
  }
};
