import type { ConfigRepository, PublicSessionSchedule } from '@dutydeck/shared';
import { RuntimeError } from '@dutydeck/shared';
import type { SessionAutomationService } from '../session-automation.js';
import type { LarkMessageEvent } from './listener.js';
import type { StoredLarkConfig } from './config.js';

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
