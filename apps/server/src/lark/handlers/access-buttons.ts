import { readLarkConfig } from '../config.js';
import { parseRepairCardActionValue } from '../repair.js';
import type { CallbackHandler } from './button-context.js';

export const repair: CallbackHandler = async (ctx, { workflow, operatorOpenId, context }) => {
  const parsedRepair = parseRepairCardActionValue(workflow);
  if (!parsedRepair) return { type: 'error', content: '修复操作无法识别，请重新发送 /repair。' };
  if (!ctx.reconcileConfig || parsedRepair.appId !== ctx.reconcileConfig.appId) {
    return { type: 'error', content: '确认卡与当前飞书应用不匹配，请重新发送 /repair。' };
  }
  if (!context?.messageId || !context.chatId || !operatorOpenId) {
    return { type: 'error', content: '修复确认已失效，请重新发送 /repair。' };
  }
  try {
    const config = await readLarkConfig(ctx.store, ctx.reconcileConfig.appId);
    if (!config?.listening) return { type: 'warning', content: '机器人已停用，无法执行修复。' };
    // /repair 发布的是整个飞书应用的新版本，属安装级动作，必须走 high_risk 门或部署静态
    // 白名单，不能复用「操作本人任务」的 own_runs 授权（开放发言群的普通成员也有后者）。
    const repairAuth = await ctx.isRepairOperatorAllowed(config, operatorOpenId, context.chatId);
    if (!repairAuth.allowed) {
      const content = repairAuth.reason === 'unconfigured'
        ? '未配置操作白名单时，飞书里不能执行 /repair，请在 Web 上操作。'
        : '当前账号无权执行 /repair：需要安装管理员权限。';
      return { type: 'warning', content };
    }
    // 卡片回调不携带发送者类型：bot 没有邮箱（平台 230001），借此把协作 bot 挡在发布动作外。
    const emails = await ctx.service.getUserEmails(operatorOpenId).catch(() => [] as string[]);
    if (!emails.length) return { type: 'warning', content: '/repair 只能由人类成员执行。' };
    // 发布链路含十余个开放平台串行写请求、耗时必然超过卡片回调 3 秒 SLA。
    // 所有门禁在此之前同步完成；通过后把发布与结果卡 PATCH 放到后台，回调立即回执。
    const flightKey = `${parsedRepair.appId}:${context.messageId}`;
    if (ctx.repairInFlight.has(flightKey)) {
      return { type: 'warning', content: '修复正在执行中，完成后会更新这张卡片，请勿重复点击。' };
    }
    ctx.repairInFlight.add(flightKey);
    void ctx.executeRepairFlight(config, parsedRepair.appId, context.messageId)
      .finally(() => ctx.repairInFlight.delete(flightKey));
    return { type: 'success', content: '已开始执行修复，完成后会更新这张卡片，请勿重复点击。' };
  } catch (error) {
    ctx.log.warn({ error }, '受理 /repair 失败');
    return { type: 'error', content: '修复操作受理失败，请稍后重试；本次未完成发布。' };
  }
};
