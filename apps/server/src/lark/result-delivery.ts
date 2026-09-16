import { createHash } from 'node:crypto';
import type { ConfigRepository } from '@dutydeck/shared';
import { buildLarkCard, type LarkCardInput, type LarkCardService } from './service.js';

// Live delivery and restart reconciliation share one provider UUID per process card.
export const larkResultKey = (processMessageId: string) =>
  `result_${createHash('sha256').update(processMessageId).digest('hex').slice(0, 40)}`;

type DeliveryTarget = { chatId: string; replyMessageId?: string; replyInThread?: boolean };
type DeliveryLog = { warn: (...args: any[]) => void };

// Save only successful provider responses. Each leg has its own UUID and durable
// receipt, so a restart after the file send retries only the missing summary.
async function delivered<T>(store: ConfigRepository | undefined, key: string, send: () => Promise<T>): Promise<T> {
  const saved = await store?.get(key);
  if (saved) return JSON.parse(saved) as T;
  const result = await send();
  if (store?.compareAndSet) {
    if (!await store.compareAndSet(key, undefined, JSON.stringify(result))) return JSON.parse((await store.get(key))!) as T;
  } else if (store) await store.set(key, JSON.stringify(result));
  return result;
}

export async function sendLarkFile(
  service: LarkCardService, target: DeliveryTarget,
  input: { data: Uint8Array; filename: string; idempotencyKey: string },
  log: DeliveryLog, store?: ConfigRepository
) {
  const prefix = `lark.delivery.${input.idempotencyKey}`;
  const fileKey = await delivered(store, `${prefix}.upload`, () => service.uploadFile(input));
  return delivered(store, `${prefix}.message`, async () => {
    if (target.replyMessageId) {
      try {
        return await service.replyFile({
          messageId: target.replyMessageId,
          ...(target.replyInThread ? { replyInThread: true } : {}),
          fileKey,
          idempotencyKey: input.idempotencyKey,
        });
      } catch (error) { log.warn({ error, messageId: target.replyMessageId }, '回复文件失败，回退为会话内发送'); }
    }
    return service.sendFile({ chatId: target.chatId, fileKey, idempotencyKey: input.idempotencyKey });
  });
}

export async function sendLarkResult(
  service: LarkCardService,
  target: DeliveryTarget,
  input: LarkCardInput & { elements: Array<Record<string, any>>; idempotencyKey: string },
  log: DeliveryLog,
  store?: ConfigRepository
): Promise<{ messageId: string; elements: Array<Record<string, any>>; attachmentMessageId?: string }> {
  const resultInput = { ...input, cardKind: 'result' as const };
  const output = resultInput.elements.find(element => element.element_id === 'final_output')?.content;
  const card = buildLarkCard(resultInput);
  const fits = !output || card.body.elements.some(element => element.element_id === 'final_output' && 'content' in element && element.content === output);
  let attachmentMessageId: string | undefined;
  if (!fits) {
    const filename = `${(input.taskName?.trim() || '执行结果').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 60)}.md`;
    const acceptance = input.elements.some(element => element.element_id === 'workflow_accept')
      ? '\n\n---\n\n结果验收：回复本文件消息「验收通过」即可确认；需要修改时，回复本文件消息并说明修改要求。'
      : '';
    const file = await sendLarkFile(service, target, {
      data: Buffer.from(`${output}${acceptance}`, 'utf8'), filename,
      idempotencyKey: `result_file_${createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 36)}`
    }, log, store);
    attachmentMessageId = file.messageId;
    // An exact excerpt is not a business-outcome summary. Keep it explicitly
    // labelled and plain text; never infer success from a finished agent turn.
    resultInput.elements = [
      ...input.elements.filter(element => element.element_id === 'group_mention'),
      { tag: 'div', element_id: 'final_output', text: { tag: 'plain_text', content: `正文开头节选（非完整结论）：\n${Array.from(String(output)).slice(0, 1000).join('')}…` } },
      { tag: 'div', element_id: 'result_attachment', text: { tag: 'plain_text', content: `完整正文已发送为附件「${filename}」。未完成事项与下一步请以全文为准；可引用本卡或附件反馈。` } },
      ...input.elements.filter(element => ['evidence', 'workflow_result_status', 'workflow_accept', 'workflow_changes'].includes(String(element.element_id)))
    ];
  }
  const elements = resultInput.elements;
  const sent = await delivered(store, `lark.delivery.${input.idempotencyKey}.summary`, async () => {
    if (target.replyMessageId && typeof service.reply === 'function') {
      try {
        const result = await service.reply({
          ...resultInput,
          messageId: target.replyMessageId,
          ...(target.replyInThread ? { replyInThread: true } : {}),
        });
        return { ...result, elements };
      } catch (error) { log.warn({ error, messageId: target.replyMessageId, chatId: target.chatId }, '回复执行结果失败，回退为会话内发送'); }
    }
    return { ...await service.send({ ...resultInput, chatId: target.chatId }), elements };
  });
  return { ...sent, ...(attachmentMessageId ? { attachmentMessageId } : {}) };
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
