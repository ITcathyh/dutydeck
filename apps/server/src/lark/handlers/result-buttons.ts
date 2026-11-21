import { isTerminalTaskStatus } from '@dutydeck/shared';
import { createHash } from 'node:crypto';
import { readLarkConfig } from '../config.js';
import { renderLarkRecordExport } from '../card-renderer.js';
import { sendLarkFile } from '../result-delivery.js';
import { parseOptionalCardTask } from '../persisted-card-task.js';
import { larkCardChannel, sendTaskCard } from '../coordinator-core.js';
import type { CallbackHandler } from './button-context.js';

export const exportTrace: CallbackHandler = async (ctx, { workflow, operatorOpenId, context, key }) => {
  if (!operatorOpenId || !context?.messageId || !context.chatId || !ctx.reconcileConfig || !ctx.cardMappings || !ctx.runtime.getEvents) {
    return { type: 'error', content: '记录入口已失效，请在原任务卡上操作。' };
  }
  try {
    const config = await readLarkConfig(ctx.store, ctx.reconcileConfig.appId);
    if (!config?.listening) return { type: 'warning', content: '机器人已停用，无法导出记录。' };
    const mapping = typeof workflow.task_id === 'string' ? await ctx.cardMappings.get(larkCardChannel(config.appId), workflow.task_id) : undefined;
    const saved = parseOptionalCardTask(mapping?.extra);
    if (!mapping || !saved?.runtime_task_id || saved.app_id !== config.appId || saved.chat_id !== context.chatId
      || ![saved.card_message_id, saved.final_message_id].includes(context.messageId)
      || saved.chat_type !== 'group' && saved.sender_open_id !== operatorOpenId
      || String(saved.turn) !== workflow.turn
      || !await ctx.currentAccess(config, saved.chat_id, saved.chat_type ?? 'group', operatorOpenId, 'task.view_result', mapping.sessionId, saved.sender_open_id)) {
      return { type: 'warning', content: '当前账号无权导出此任务记录，或卡片已失效。' };
    }
    const task = (await ctx.runtime.getTasks?.(mapping.sessionId))?.find(item => item.id === saved.runtime_task_id);
    if (!task) return { type: 'warning', content: '原任务记录不存在，无法导出。' };
    if (task.status === 'queued' || task.status === 'cancelled') {
      return { type: 'warning', content: '任务尚未执行，暂无执行记录可导出。' };
    }
    // The platform callback has a short deadline. Authorize first, then
    // deliver to the persisted chat/topic, never to callback-supplied IDs.
    void (async () => {
      try {
        const events = await ctx.runtime.getEvents!(mapping.sessionId);
        const start = events.findIndex(item => item.type === 'text' && (item.data as any)?.role === 'user' && (item.data as any)?.taskId === task.id);
        if (start < 0) throw new Error('原任务记录不完整，无法安全限定导出范围。');
        // Stop at the next user task as well as the terminal event: an
        // incomplete old turn must not export a later user's records.
        const end = events.findIndex((item, index) => index > start && (item.type === 'text' && (item.data as any)?.role === 'user'
          || item.type === 'task' && (item.data as any)?.task?.id === task.id && isTerminalTaskStatus((item.data as any)?.task?.status)));
        const text = renderLarkRecordExport(events.slice(start + 1, end < 0 ? undefined : end));
        const current = await readLarkConfig(ctx.store, config.appId);
        if (!current?.listening || !await ctx.currentAccess(current, saved.chat_id, saved.chat_type ?? 'group', operatorOpenId, 'task.view_result', mapping.sessionId, saved.sender_open_id)) return;
        const key = `trace_${createHash('sha256').update([config.appId, task.id, text].join('\0')).digest('hex').slice(0, 40)}`;
        await sendLarkFile(ctx.service, { chatId: saved.chat_id,
          replyMessageId: saved.reply_message_id ?? saved.card_message_id, replyInThread: saved.reply_in_thread }, {
          data: Buffer.from(text, 'utf8'), filename: '公开执行记录.md', idempotencyKey: key
        }, ctx.log, ctx.store);
      } catch (error) {
        ctx.log.warn({ error, taskId: task.id }, '导出执行记录失败');
        await sendTaskCard(ctx.service, { messageId: saved.card_message_id ?? task.id, chatId: saved.chat_id,
          chatType: saved.chat_type ?? 'group', threadId: saved.thread_id, messageType: 'text', content: '', mentions: [] }, {
          state: 'failed', readOnly: true, taskName: '记录未能导出',
          markdown: '未能获取或发送本轮完整公开记录，请稍后重试。'
        }, ctx.log).catch(() => undefined);
      }
    })();
    return { type: 'success', content: '正在导出公开执行记录，文件将发送到原任务会话。' };
  } catch (error) {
    ctx.log.warn({ error }, '受理记录导出失败');
    return { type: 'error', content: '暂时无法导出，请稍后重试。' };
  }
};
