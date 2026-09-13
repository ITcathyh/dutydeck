import { createHash } from 'node:crypto';
import { buildLarkCard, type LarkCardInput, type LarkCardService } from './service.js';

// Live delivery and restart reconciliation share one provider UUID per process card.
export const larkResultKey = (processMessageId: string) =>
  `result_${createHash('sha256').update(processMessageId).digest('hex').slice(0, 40)}`;

export async function sendLarkResult(
  service: LarkCardService,
  target: { chatId: string; replyMessageId?: string; replyInThread?: boolean },
  input: LarkCardInput & { elements: Array<Record<string, any>>; idempotencyKey: string },
  log: { warn: (...args: any[]) => void }
) {
  const output = input.elements.find(element => element.element_id === 'final_output')?.content;
  const card = buildLarkCard(input);
  const fits = !output || card.body.elements.some(element => element.element_id === 'final_output' && 'content' in element && element.content === output);
  // A result must never pass through the trace snapshot's truncation fallback.
  // Oversized answers are delivered as the single result message's Markdown file.
  const acceptance = input.elements.some(element => element.element_id === 'workflow_accept')
    ? '\n\n---\n\n结果验收：回复本文件消息「验收通过」即可确认；需要修改时，回复本文件消息并说明修改要求。'
    : '';
  const fileKey = fits ? undefined : await service.uploadFile({
    data: Buffer.from(`${output}${acceptance}`, 'utf8'), filename: '执行结果.md', idempotencyKey: input.idempotencyKey
  });
  if (target.replyMessageId && typeof service.reply === 'function') {
    try {
      const reply = { messageId: target.replyMessageId, ...(target.replyInThread ? { replyInThread: true } : {}), idempotencyKey: input.idempotencyKey };
      const result = fileKey ? await service.replyFile({ ...reply, fileKey }) : await service.reply({ ...input, ...reply });
      return { ...result, elements: fits ? input.elements : undefined };
    } catch (error) {
      log.warn({ error, messageId: target.replyMessageId, chatId: target.chatId }, '回复执行结果失败，回退为会话内发送');
    }
  }
  const result = fileKey
    ? await service.sendFile({ chatId: target.chatId, fileKey, idempotencyKey: input.idempotencyKey })
    : await service.send({ ...input, chatId: target.chatId });
  return { ...result, elements: fits ? input.elements : undefined };
}

/**
 * 以普通卡片 PATCH 整卡覆盖被点击的消息（非流式，延迟再久也不影响原消息可转发）。
 *
 * 返回 null 表示调用方应回退为发送新卡，两种情形：
 * 1. 卡内含最终结果且超出卡片预算——PATCH 不能附带文件，硬覆盖会把长结果截断成假凭证；
 * 2. 平台更新失败（消息被撤回、超过更新窗口等）。
 */
export async function patchLarkCard(
  service: LarkCardService,
  target: { messageId: string },
  input: LarkCardInput & { elements: Array<Record<string, any>> },
  log: { warn: (...args: any[]) => void }
): Promise<{ messageId: string } | null> {
  const output = input.elements.find(element => element.element_id === 'final_output')?.content;
  const card = buildLarkCard(input);
  const fits = !output || card.body.elements.some(element => element.element_id === 'final_output' && 'content' in element && element.content === output);
  if (!fits) return null;
  try {
    return await service.update({ ...input, messageId: target.messageId });
  } catch (error) {
    log.warn({ error, messageId: target.messageId }, 'PATCH 更新卡片失败，回退为发送新卡');
    return null;
  }
}
