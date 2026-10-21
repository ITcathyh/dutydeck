import type { LarkCardService, LarkWriteGuard } from './service.js';

/** Shared provider commit for reply-agent and its frozen final-delivery leg. */
export async function commitLarkAgentReply(service: Pick<LarkCardService, 'replyText'>,
  input: { originMessageId: string; text: string; idempotencyKey: string }, beforeSend?: LarkWriteGuard) {
  await beforeSend?.();
  return service.replyText({ messageId: input.originMessageId, text: input.text, replyInThread: true,
    idempotencyKey: input.idempotencyKey, ...(beforeSend ? { beforeSend } : {}) });
}
