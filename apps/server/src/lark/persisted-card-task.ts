import { turnRecordSchema, type PersistedLarkCardTask } from './turn-record.js';

/** 解析卡片映射的 extra；JSON 损坏时抛错。 */
export function parseCardTask(extra: string) {
  return turnRecordSchema.parse(JSON.parse(extra));
}

// Routing and delivery diagnostics also read older mappings that contain only their own fields.
const fieldSchema = turnRecordSchema.partial();
export function parseCardFields(extra: string | null | undefined) {
  return extra ? fieldSchema.parse(JSON.parse(extra)) : undefined;
}

/** 同 parseCardTask，extra 为空时返回 undefined。 */
export function parseOptionalCardTask(extra: string | null | undefined) {
  return extra ? parseCardTask(extra) : undefined;
}

export const persistedMessageAnchor = (saved: PersistedLarkCardTask, externalId: string) =>
  saved.anchor_message_id ?? saved.reply_message_id ?? externalId;

export function persistedReplyTarget(saved: PersistedLarkCardTask) {
  const { anchor_message_id, reply_message_id, root_message_id } = saved;
  let replyMessageId: string | undefined;
  if (anchor_message_id === undefined) {
    replyMessageId = reply_message_id?.trim() || (root_message_id?.trim().startsWith('om_') ? root_message_id.trim() : undefined);
  } else if (saved.chat_type === 'group' || reply_message_id || root_message_id?.startsWith('om_')) {
    replyMessageId = anchor_message_id;
  }
  return { chatId: saved.chat_id, replyMessageId, replyInThread: saved.reply_in_thread };
}
