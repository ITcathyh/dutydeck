import { createHash } from 'node:crypto';
import type { ConfigRepository } from '@dutydeck/shared';
import { COMPLETION_REACTION_EMOJI, reactionDedupeKey, type ReactionRecord } from './reaction-records.js';
import { buildLarkCard, type LarkCardInput, type LarkCardService } from './service.js';

// Live delivery and restart reconciliation share one provider UUID per process card.
export const larkResultKey = (processMessageId: string) =>
  `result_${createHash('sha256').update(processMessageId).digest('hex').slice(0, 40)}`;

/**
 * 静默进展下没有过程卡，改用「任务 id + 轮次」当结果幂等锚点。
 * 实时链路与重启对账必须算出同一个串，否则对账会把同一份结果再发一次。
 */
export const larkSilentResultAnchor = (taskId: string, turn: number | undefined) => `silent:${taskId}:${turn ?? 0}`;

/**
 * 完成时只贴表情：对原始请求消息贴一次完成表情。
 *
 * 先查 kv 幂等键再调平台再写回，重启对账反复进入时命中即返，绝不重复打表情。
 *
 * 返回是否确实送达：这一枚表情是开关打开后用户唯一能看到的完成信号，贴失败还记成
 * 「已交付」，用户就什么都收不到了。失败只 warn（不抛），由调用方留给对账重试。
 */
export async function deliverLarkCompletionReaction(
  service: Pick<LarkCardService, 'addReaction'>,
  input: { appId: string; messageId: string },
  log: DeliveryLog,
  store?: ConfigRepository
): Promise<boolean> {
  const key = reactionDedupeKey(input.appId, input.messageId, COMPLETION_REACTION_EMOJI);
  try {
    if (await store?.get(key)) return true;
    const result = await service.addReaction(input.messageId, COMPLETION_REACTION_EMOJI);
    const record: ReactionRecord = {
      messageId: result.messageId, emojiType: COMPLETION_REACTION_EMOJI,
      reactionId: result.reactionId, createdAt: new Date().toISOString()
    };
    if (store?.compareAndSet) await store.compareAndSet(key, undefined, JSON.stringify(record));
    else await store?.set(key, JSON.stringify(record));
    return true;
  } catch (error) {
    log.warn({ error, key }, '完成表情写入失败，等待对账重试');
    return false;
  }
}

export type DeliveryTarget = { chatId: string; replyMessageId?: string; replyInThread?: boolean; allowReplyFallback?: boolean };
type DeliveryLog = { warn: (...args: any[]) => void };

// Save only successful provider responses. Each leg has its own UUID and durable
// receipt, so a restart after the file send retries only the missing summary.
async function delivered<T>(store: ConfigRepository | undefined, key: string, send: () => Promise<T>, validate?: (result: T) => boolean): Promise<T> {
  const saved = await store?.get(key);
  if (saved) {
    const parsed = JSON.parse(saved) as T;
    if (!validate || validate(parsed)) return parsed;
    throw new Error(`Invalid delivery receipt: ${key}`);
  }
  const result = await send();
  if (validate && !validate(result)) throw new Error(`Provider returned an invalid delivery receipt: ${key}`);
  if (store?.compareAndSet) {
    if (!await store.compareAndSet(key, undefined, JSON.stringify(result))) {
      const winner = JSON.parse((await store.get(key))!) as T;
      if (validate && !validate(winner)) throw new Error(`Invalid delivery receipt: ${key}`);
      return winner;
    }
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
      } catch (error) { if (target.allowReplyFallback === false) throw error; log.warn({ error, messageId: target.replyMessageId }, '回复文件失败，回退为会话内发送'); }
    }
    return service.sendFile({ chatId: target.chatId, fileKey, idempotencyKey: input.idempotencyKey });
  }, target.allowReplyFallback === false ? result => typeof result?.messageId === 'string' && Boolean(result.messageId.trim()) : undefined);
}

export async function prepareLarkResult(
  service: LarkCardService,
  target: DeliveryTarget,
  input: LarkCardInput & { elements: Array<Record<string, any>>; idempotencyKey: string },
  log: DeliveryLog,
  store?: ConfigRepository
): Promise<{ input: LarkCardInput & { elements: Array<Record<string, any>>; idempotencyKey: string }; attachmentMessageId?: string }> {
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
      // 验证状态行必须跟着摘要卡走：结果转成附件后，卡上只剩节选，
      // 「这份结论有没有被平台验证过」比节选本身更需要留在能看见的地方。
      ...input.elements.filter(element => ['evidence', 'verification_status', 'workflow_result_status', 'workflow_accept', 'workflow_changes'].includes(String(element.element_id)))
    ];
  }
  return { input: resultInput, ...(attachmentMessageId ? { attachmentMessageId } : {}) };
}

export async function sendLarkResult(
  service: LarkCardService, target: DeliveryTarget,
  input: LarkCardInput & { elements: Array<Record<string, any>>; idempotencyKey: string },
  log: DeliveryLog, store?: ConfigRepository
): Promise<{ messageId: string; elements: Array<Record<string, any>>; attachmentMessageId?: string }> {
  const { input: resultInput, attachmentMessageId } = await prepareLarkResult(service, target, input, log, store);
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
      } catch (error) { if (target.allowReplyFallback === false) throw error; log.warn({ error, messageId: target.replyMessageId, chatId: target.chatId }, '回复执行结果失败，回退为会话内发送'); }
    }
    if (target.replyMessageId && target.allowReplyFallback === false) throw new Error('Explicit final requires reply support');
    return { ...await service.send({ ...resultInput, chatId: target.chatId }), elements };
  }, target.allowReplyFallback === false ? result => typeof result?.messageId === 'string' && Boolean(result.messageId.trim())
    && JSON.stringify(result.elements) === JSON.stringify(elements) : undefined);
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
