import type { ConfigRepository, PublicSessionSchedule } from '@dutydeck/shared';
import { RuntimeError, describeScheduleTrigger } from '@dutydeck/shared';
import type { SessionAutomationService } from '../session-automation.js';
import type { LarkMessageEvent } from './listener.js';
import type { StoredLarkConfig } from './config.js';
import type { LarkCardInput } from './service.js';

/**
 * Agent 代建计划的确认卡，发出和点按钮后原位重绘共用：做什么、什么时候、发到哪。
 * 没启用时给「启用」，启用后给「停用」；按钮带 card: 'request'，回调据此只重绘这张卡。
 */
export function scheduleRequestCard(schedule: Pick<PublicSessionSchedule, 'id' | 'prompt' | 'trigger' | 'timezone' | 'enabled' | 'nextDueAt'>, replyInThread: boolean): LarkCardInput & { elements: Array<Record<string, unknown>> } {
  const prompt = schedule.prompt.replace(/\s+/g, ' ').trim();
  const next = schedule.nextDueAt ? new Date(schedule.nextDueAt).toLocaleString('zh-CN', { timeZone: schedule.timezone, hour12: false }) : undefined;
  return {
    taskId: schedule.id, taskName: '定时任务', readOnly: true, retryable: false,
    ...(schedule.enabled ? { state: 'completed' as const, statusLabel: '已启用' } : { state: 'running' as const, statusLabel: '待启用', awaitingHuman: true }),
    elements: [
      { tag: 'markdown', element_id: 'schedule_request', content: [
        `**做什么**：${prompt.length > 200 ? `${prompt.slice(0, 200)}…` : prompt}`,
        `**什么时候**：${describeScheduleTrigger(schedule.trigger, schedule.timezone)}`,
        `**发到哪**：${replyInThread ? '本话题' : '本会话'}`,
        schedule.enabled ? `已启用${next ? `，下一次 ${next}` : ''}。每次的结果卡上也能停用。` : '点「启用」后开始，不点不会执行。'
      ].join('\n') },
      { tag: 'button', element_id: 'schedule_request_toggle', text: { tag: 'plain_text', content: schedule.enabled ? '停用' : '启用' }, type: schedule.enabled ? 'default' : 'primary',
        behaviors: [{ type: 'callback', value: { [schedule.enabled ? 'dutydeck_schedule_disable' : 'dutydeck_schedule_enable']: schedule.id, card: 'request' } }], margin: '0px' }
    ]
  };
}

export async function executeScheduleCommand(automation: SessionAutomationService, store: ConfigRepository | undefined, sessionId: string, text: string, event: LarkMessageEvent, config: StoredLarkConfig) {
  const [action, id, ...rest] = text.trim().split(/\s+/).filter(Boolean);
  if (!action) {
    const records = await automation.listBySession(sessionId, event.senderOpenId);
    return records.schedules.map(item => `**${item.enabled ? '已启用' : '已停用'} · ${item.name}**\n${item.prompt}\n下一次：${item.nextDueAt ?? '停用中'}\n\`/schedule ${item.enabled ? 'disable' : 'enable'} ${item.id}\``).join('\n\n') || '此话题暂无计划。\n\n`/schedule every 分钟 指令` 创建停用的计划；核对回执后用 `/schedule enable 编号` 启用。';
  }
  let schedule: PublicSessionSchedule;
  if (action === 'every' && id && rest.length) {
    const minutes = Number(id);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 525600) throw new RuntimeError('SCHEDULE_INTERVAL_INVALID', '分钟数须为 1 到 525600 的整数', 400);
    const prompt = rest.join(' ');
    schedule = await automation.createSchedule(sessionId, { name: prompt.slice(0, 100), prompt,
      trigger: { kind: 'interval', everySeconds: minutes * 60, anchorAt: '1970-01-01T00:00:00.000Z' }, timezone: 'Asia/Shanghai', dstPolicy: { gap: 'skip', overlap: 'first' }, condition: { kind: 'always' } }, event.senderOpenId, {
      key: `${config.appId}:${event.messageId}`,
      prepareDelivery: async automationId => {
        if (!store?.compareAndSet) throw new RuntimeError('SCHEDULE_ORIGIN_UNAVAILABLE', '无法持久保存此话题的回报位置', 503);
        await store.compareAndSet(`automation.delivery-target.${automationId}`, undefined, JSON.stringify({ appId: config.appId, chatId: event.chatId, replyMessageId: event.messageId, replyInThread: event.chatType === 'group' }));
      }
    });
    return `已保存「${schedule.name}」，每 ${minutes} 分钟执行一次，当前停用。\n\n执行内容：${schedule.prompt}\n\n启用：\`/schedule enable ${schedule.id}\``;
  }
  if (['enable', 'disable'].includes(action) && id && !rest.length) {
    const items = await automation.listBySession(sessionId, event.senderOpenId);
    const existing = items.schedules.find(item => item.id === id);
    if (!existing) throw new RuntimeError('SCHEDULE_NOT_FOUND', '当前话题没有此计划', 404);
    schedule = await automation.updateSchedule(sessionId, id, { expectedRevision: existing.revision, enabled: action === 'enable' }, event.senderOpenId);
    return `「${schedule.name}」${schedule.enabled ? '已启用' : '已停用'}。${schedule.nextDueAt ? `\n下一次：${schedule.nextDueAt}` : ''}`;
  }
  throw new RuntimeError('SCHEDULE_COMMAND_INVALID', '用法：/schedule；/schedule every 分钟 指令；/schedule enable 编号；/schedule disable 编号', 400);
}
