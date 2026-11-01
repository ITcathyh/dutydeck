import type { LarkMessageEvent } from './listener.js';

/** 飞书 API / 引用使用真实消息；入站去重继续使用 event.messageId。 */
export const larkMessageAnchor = (event: Pick<LarkMessageEvent, 'messageId' | 'replyMessageId'>) => event.replyMessageId ?? event.messageId;
