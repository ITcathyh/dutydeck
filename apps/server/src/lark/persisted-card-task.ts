import type { PersistedLarkCardTask } from './coordinator.js';

/** 解析卡片映射的 extra；JSON 损坏时抛错。 */
export function parseCardTask(extra: string) {
  return JSON.parse(extra) as PersistedLarkCardTask;
}

/** 同 parseCardTask，extra 为空时返回 undefined。 */
export function parseOptionalCardTask(extra: string | null | undefined) {
  return extra ? parseCardTask(extra) : undefined;
}

export const persistedMessageAnchor = (saved: PersistedLarkCardTask, externalId: string) =>
  saved.anchor_message_id ?? saved.reply_message_id ?? externalId;

/** 私聊和没有回复目标的旧记录仍在会话内发送。 */
export function persistedReplyTarget(saved: PersistedLarkCardTask, externalId: string) {
  const reply = saved.chat_type === 'group' || saved.reply_message_id || saved.root_message_id?.startsWith('om_');
  return { chatId: saved.chat_id, replyMessageId: reply ? persistedMessageAnchor(saved, externalId) : undefined,
    replyInThread: saved.reply_in_thread };
}
