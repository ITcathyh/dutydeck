import { z } from 'zod';
import { commitLarkAgentReply } from './agent-reply-delivery.js';
import { parseFinalCardBody, type FinalCardBody } from './final-card.js';
import { createHash } from 'node:crypto';
import { larkFailureKind } from './api-gate.js';
import { isLarkMessageUnupdatable } from './card-renderer.js';
import type { ConfigRepository, ChannelMapping } from '@dutydeck/shared';
import type { PersistedLarkCardTask } from './coordinator.js';
import { parseCardTask } from './persisted-card-task.js';
import { isLarkFinalContentAuditRejected, recordLarkResultAuditRejection, prepareLarkResult, readConfirmedLarkResult, sendLarkResult, sendLarkDeliveryText, type DeliveryTarget } from './result-delivery.js';
import { LarkServiceError, type LarkCardInput, type LarkCardService, type LarkWriteGuard } from './service.js';
import type { LarkAgentSessionBinding } from './agent-tools.js';

export interface ExplicitFinalScope {
  app_id: string; session_id: string; runtime_task_id: string; attempt_id: string;
  origin_message_id: string; turn: number; chat_id: string; chat_type: 'group' | 'p2p';
  reply_message_id: string; reply_in_thread: boolean;
}
export interface ExplicitFinalContext { scope: ExplicitFinalScope; taskName: string }
export interface ExplicitFinalReceipt {
  messageId: string; elements: Elements; attachmentMessageId?: string;
  /** Text receipts must never be used as a card-update or acceptance-workflow target. */
  textReceipt?: true;
  deliveryFailure?: string;
}
type Elements = Array<Record<string, any>>;
const relayIntentSchema = z.object({ target_id: z.string().min(1), sender_id: z.string().min(1), actor_id: z.string().min(1), text: z.string().min(1).max(22_000), provider_uuid: z.string().min(1).max(50) }).strict();
const relayRecordSchema = relayIntentSchema.extend({ status: z.enum(['pending', 'delivered']), message_id: z.string().min(1).optional(), delivery_unknown: z.boolean().optional() }).strict();
export interface ExplicitFinalDelivery { mode: 'publish' | 'reply-agent' | 'both'; relay?: z.infer<typeof relayIntentSchema> }
interface FinalRecord {
  version: 1; status: 'pending' | 'failed' | 'delivered'; scope: ExplicitFinalScope; content: string; provider_uuid: string;
  delivery_mode?: ExplicitFinalDelivery['mode']; relay?: z.infer<typeof relayRecordSchema>; revision?: number;
  task_name: string; card_body?: FinalCardBody; first_attempt_at?: number; audit_rejected?: boolean; delivery_unknown?: boolean; message_id?: string; attachment_message_id?: string; elements?: Elements;
}
const locks = new WeakMap<ConfigRepository, Map<string, Promise<unknown>>>();
export async function withExplicitFinalLock<T>(store: ConfigRepository | undefined, taskId: string, action: () => Promise<T>): Promise<T> {
  if (!store) return action();
  let pending = locks.get(store);
  if (!pending) { pending = new Map(); locks.set(store, pending); }
  const previous = pending.get(taskId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(action);
  pending.set(taskId, run);
  try { return await run; }
  finally { if (pending.get(taskId) === run) pending.delete(taskId); }
}

// Routing comes only from the exact persisted mapping, never from agent text.
export function explicitFinalContext(mapping: Pick<ChannelMapping, 'externalId' | 'sessionId'>, saved: PersistedLarkCardTask, attemptId?: string): ExplicitFinalContext | undefined {
  if (!attemptId || !saved.runtime_task_id || !saved.app_id || !saved.chat_id || !mapping.externalId.startsWith('om_')
    || !Number.isInteger(saved.turn) || !saved.task_name || !['group', 'p2p'].includes(saved.chat_type ?? '')) return;
  const reply = saved.reply_message_id ?? '';
  if (saved.chat_type === 'group' && reply !== mapping.externalId) return;
  if (saved.chat_type === 'p2p' && (reply || saved.reply_in_thread)) return;
  return { taskName: saved.task_name, scope: {
    app_id: saved.app_id, session_id: mapping.sessionId, runtime_task_id: saved.runtime_task_id, attempt_id: attemptId,
    origin_message_id: mapping.externalId, turn: saved.turn!, chat_id: saved.chat_id, chat_type: saved.chat_type as 'group' | 'p2p',
    reply_message_id: reply, reply_in_thread: saved.reply_in_thread === true
  } };
}
export async function resolveExplicitFinalContext(rows: ChannelMapping[], binding: LarkAgentSessionBinding, task: { taskId: string; attemptId?: string }): Promise<ExplicitFinalContext | undefined> {
  const matches = rows.flatMap(row => {
    try {
      const saved = parseCardTask(row.extra ?? '{}');
      if (row.channel !== `lark-card:${binding.appId}` || row.sessionId !== binding.sessionId || saved.runtime_task_id !== task.taskId) return [];
      return [{ row, saved }];
    } catch { return []; }
  });
  if (matches.length !== 1) return;
  const { row, saved } = matches[0]!;
  if (saved.app_id !== binding.appId || saved.chat_id !== binding.chatId || saved.chat_type !== binding.chatType
    || (binding.threadId && saved.thread_id !== binding.threadId)
    || (binding.threadRootMessageId && saved.scope_id !== `thread:${binding.threadRootMessageId}` && saved.reply_message_id !== binding.threadRootMessageId)
    || ((binding.threadId || binding.threadRootMessageId) && !saved.reply_in_thread)) return;
  return explicitFinalContext(row, saved, task.attemptId);
}
const digest = (scope: ExplicitFinalScope) => createHash('sha256').update(JSON.stringify(scope)).digest('hex');
const keyFor = (scope: ExplicitFinalScope) => `lark.explicit_final.${digest(scope)}`;
const uuidFor = (scope: ExplicitFinalScope) => `final_${digest(scope).slice(0, 40)}`;
const targetFor = (scope: ExplicitFinalScope): DeliveryTarget => ({ chatId: scope.chat_id,
  ...(scope.reply_message_id ? { replyMessageId: scope.reply_message_id, replyInThread: scope.reply_in_thread } : {}), allowReplyFallback: false });
async function readRecord(store: ConfigRepository, scope: ExplicitFinalScope, strict = false): Promise<FinalRecord | undefined> {
  const saved = await store.get(keyFor(scope));
  if (saved === undefined || saved === null) return;
  const invalid = () => { if (strict) throw new Error('Invalid explicit final record'); return undefined; };
  try {
    const record = JSON.parse(saved ?? 'null') as FinalRecord | null;
    if (!record || record.version !== 1 || !['pending', 'failed', 'delivered'].includes(record.status) || JSON.stringify(record.scope) !== JSON.stringify(scope)
      || record.provider_uuid !== uuidFor(scope) || typeof record.content !== 'string' || !record.content.trim()
      || typeof record.task_name !== 'string' || (record.message_id !== undefined && (typeof record.message_id !== 'string' || !record.message_id.trim()
        || !Array.isArray(record.elements) || !record.elements.every(item => item && typeof item === 'object')))) return invalid();
    if (record.delivery_mode !== undefined && !['publish', 'reply-agent', 'both'].includes(record.delivery_mode)) return invalid();
    if (record.delivery_mode && record.delivery_mode !== 'publish') {
      if (!Number.isInteger(record.revision) || record.revision! < 1) return invalid();
      relayRecordSchema.parse(record.relay);
      if ((record.relay!.status === 'delivered') !== Boolean(record.relay!.message_id) || record.delivery_mode === 'reply-agent' && record.message_id) return invalid();
    } else if (record.relay) return invalid();
    if ((record.status === 'delivered') !== complete(record)) return invalid();
    if (record.card_body) {
      parseFinalCardBody(record.card_body);
      if (record.message_id && JSON.stringify(record.elements) !== JSON.stringify(record.card_body.elements)) return invalid();
    }
    if (record.message_id && !record.card_body) {
      const output = record.elements?.find(item => item.element_id === 'final_output');
      if (!output || (output.content !== record.content && !(typeof record.attachment_message_id === 'string' && record.attachment_message_id.trim()
        && record.elements?.some(item => item.element_id === 'result_attachment')))) return invalid();
    }
    return record;
  } catch (error) { if (strict) throw error; return; }
}
async function saveRecord(store: ConfigRepository, record: FinalRecord) {
  if (record.delivery_mode && record.delivery_mode !== 'publish') {
    if (!store.compareAndSet) throw new LarkServiceError('FINAL_STORAGE_UNAVAILABLE', '多目标最终交付需要持久化 CAS 存储。', 503);
    const raw = await store.get(keyFor(record.scope));
    const previous = raw ? JSON.parse(raw) as FinalRecord : undefined;
    if ((previous?.revision ?? 0) !== (record.revision ?? 0)) throw new LarkServiceError('FINAL_RECORD_CONFLICT', '最终交付记录已更新，请重试原请求。', 409);
    const revision = (record.revision ?? 0) + 1;
    if (!await store.compareAndSet(keyFor(record.scope), raw, JSON.stringify({ ...record, revision }))) throw new LarkServiceError('FINAL_RECORD_CONFLICT', '最终交付记录已更新，请重试原请求。', 409);
    record.revision = revision;
  } else await store.set(keyFor(record.scope), JSON.stringify(record));
}
const relayIntent = (relay: FinalRecord['relay']) => relay && relayIntentSchema.parse({ target_id: relay.target_id, sender_id: relay.sender_id, actor_id: relay.actor_id, text: relay.text, provider_uuid: relay.provider_uuid });
const complete = (record: FinalRecord) => (record.delivery_mode === 'reply-agent' || Boolean(record.message_id))
  && (!record.relay || record.relay.status === 'delivered' && Boolean(record.relay.message_id));
const frozenIntent = (record: FinalRecord) => Boolean(record.card_body || record.delivery_mode && record.delivery_mode !== 'publish');
const authoritative = (record: FinalRecord, state: LarkCardInput['state']) => frozenIntent(record) || (state === 'completed' && (record.status !== 'failed' || record.audit_rejected));
const receiptFor = (record: FinalRecord): ExplicitFinalReceipt => ({ messageId: (record.message_id ?? record.relay?.message_id)!,
  elements: record.elements ?? [{ tag: 'markdown', element_id: 'final_output', content: record.content }], attachmentMessageId: record.attachment_message_id,
  ...(record.delivery_mode === 'reply-agent' ? { textReceipt: true as const } : {}) });

/** 仅返回至少一个指定目标已确认收到的摘要，供会话历史回看。 */
export async function readExplicitFinal(store: ConfigRepository, context: ExplicitFinalContext, strict = false): Promise<string | undefined> {
  const record = await readRecord(store, context.scope, strict);
  return record && (record.message_id || record.relay?.message_id) ? record.content : undefined;
}
export async function hasExplicitFinal(store: ConfigRepository | undefined, context: ExplicitFinalContext | undefined, state: LarkCardInput['state'] = 'completed') {
  const record = store && context ? await readRecord(store, context.scope) : undefined;
  return Boolean(record && authoritative(record, state));
}
export type ExplicitFinalTextReceiptReader = (mapping: Pick<ChannelMapping, 'externalId' | 'sessionId'>, saved: PersistedLarkCardTask, messageId: string) => Promise<boolean>;
/** Snapshot candidates once per reconciliation; verify the exact durable scope before treating a message as text. */
export async function explicitFinalTextReceiptReader(store: ConfigRepository | undefined): Promise<ExplicitFinalTextReceiptReader> {
  if (!store) return async () => false;
  if (!store.list) return async (_mapping, saved, messageId) => {
    if (saved.final_delivery_state === 'delivered' && saved.final_message_id === messageId && saved.final_card_input) return false;
    throw new LarkServiceError('FINAL_STORAGE_UNAVAILABLE', '无法核验最终回执类型，已停止验收绑定与更新。', 503);
  };
  const candidates = (await store.list('lark.explicit_final.')).flatMap(row => {
    try {
      const record = JSON.parse(row.value) as FinalRecord;
      return record && ['reply-agent', 'both'].includes(record.delivery_mode ?? '') && typeof record.relay?.message_id === 'string' && typeof record.scope?.attempt_id === 'string' ? [record] : [];
    } catch { return []; }
  });
  return async (mapping, saved, messageId) => {
    for (const candidate of candidates) {
      if (candidate.relay?.message_id !== messageId) continue;
      const context = explicitFinalContext(mapping, saved, candidate.scope.attempt_id);
      if (!context || JSON.stringify(context.scope) !== JSON.stringify(candidate.scope)) continue;
      const record = await readRecord(store, context.scope, true);
      if (record?.relay?.message_id === messageId) return true;
    }
    return false;
  };
}

const log = { warn: (..._args: any[]) => {} };
const finalInput = (record: FinalRecord) => ({
  state: 'running' as const, cardKind: 'result' as const, statusLabel: '答复已送达，执行尚未结束', readOnly: true,
  taskId: record.scope.origin_message_id, taskName: record.task_name, sessionId: record.scope.session_id, turn: record.scope.turn,
  capabilities: { canCancelQueued: false, canInterrupt: false, canRetry: false, canRefresh: false, canVerify: false },
  elements: record.card_body?.elements ?? [{ tag: 'markdown', element_id: 'final_output', content: record.content }],
  ...(record.card_body ? { cardBody: record.card_body } : {}), idempotencyKey: record.provider_uuid
});
/** Confirmed body only; never PATCH execution decorations during expired recovery. */
export async function readConfirmedExplicitFinal(store: ConfigRepository | undefined, service: LarkCardService, context: ExplicitFinalContext | undefined) {
  if (!store || !context) return;
  const record = await readRecord(store, context.scope);
  if (!record || record.status === 'failed' || record.audit_rejected) return;
  if (complete(record)) return receiptFor(record);
  if (record.delivery_mode === 'reply-agent' || record.relay?.status === 'pending') return;
  const receipt = await readConfirmedLarkResult(service, targetFor(record.scope), finalInput(record), log, store);
  if (receipt) await saveRecord(store, { ...record, status: 'delivered',
    message_id: receipt.messageId, elements: receipt.elements, attachment_message_id: receipt.attachmentMessageId });
  return receipt;
}
async function deliverPublication(store: ConfigRepository, service: LarkCardService, record: FinalRecord, beforeSend?: LarkWriteGuard) {
  if (record.message_id) return record;
  if (record.first_attempt_at === undefined) {
    record = { ...record, first_attempt_at: Date.now() };
    await saveRecord(store, record);
  }
  const authority = beforeSend;
  beforeSend = async () => {
    await authority?.();
    if (Date.now() - record.first_attempt_at! > 60 * 60_000) {
      throw new LarkServiceError('LARK_RESULT_RETRY_EXPIRED', '自动重试超过 1 小时仍未确认送达，已停止自动重试；结果可能已送达，也可能没有', 409);
    }
  };
  let providerFailed = false;
  let deliveryUnknown = record.delivery_unknown === true;
  let attachmentMessageId: string | undefined;
  const strictService = new Proxy(service, { get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (!['send', 'reply', 'uploadFile', 'sendFile', 'replyFile'].includes(String(property)) || typeof value !== 'function') return value;
    return async (...args: unknown[]) => {
      try {
        const result = await value.apply(target, args);
        if (['sendFile', 'replyFile'].includes(String(property))) attachmentMessageId = result?.messageId;
        return result;
      } catch (error) {
        providerFailed = true;
        if (larkFailureKind(error) === 'unknown') deliveryUnknown = true;
        throw error;
      }
    };
  } });
  let sent: Awaited<ReturnType<typeof sendLarkResult>>;
  try {
    if (record.audit_rejected || await store.get(`lark.delivery.${record.provider_uuid}.audit_rejected`)) {
      await sendLarkResult(strictService, targetFor(record.scope), { state: 'running', elements: [], idempotencyKey: record.provider_uuid }, log, store, beforeSend);
    }
    const prepared = await prepareLarkResult(strictService, targetFor(record.scope), finalInput(record), log, store, beforeSend);
    // A delivered (including cached) attachment makes this a partial delivery:
    // keep its intent retryable if the summary fails, never start a second result.
    attachmentMessageId = prepared.attachmentMessageId;
    sent = await sendLarkResult(strictService, targetFor(record.scope), prepared.input, log, store, beforeSend);
  } catch (error) {
    if (isLarkFinalContentAuditRejected(error)) {
      await recordLarkResultAuditRejection(service, targetFor(record.scope), record.provider_uuid, error, log, store, beforeSend);
      await saveRecord(store, { ...record, status: 'failed', audit_rejected: true, ...(deliveryUnknown ? { delivery_unknown: true } : {}) });
      throw error;
    }
    // An unknown response may already have delivered the answer. Keep that
    // uncertainty across retries, even if a later attempt is clearly rejected.
    if (deliveryUnknown) await saveRecord(store, { ...record, delivery_unknown: true });
    else if (providerFailed && !attachmentMessageId) await saveRecord(store, { ...record, status: 'failed' });
    throw error;
  }
  if (!sent.messageId?.trim()) throw new Error('Explicit final provider returned no message ID');
  // 答复卡被拒收后由 sendLarkResult 改成了节选加附件：附件在这次发送里产生。
  attachmentMessageId ??= sent.attachmentMessageId;
  const receipt: FinalRecord = { ...record, status: record.relay?.status === 'pending' ? 'pending' : 'delivered', message_id: sent.messageId, elements: sent.elements,
    ...(attachmentMessageId ? { attachment_message_id: attachmentMessageId } : {}) };
  await saveRecord(store, receipt);
  return receipt;
}
async function deliver(store: ConfigRepository, service: LarkCardService, record: FinalRecord, beforeSend?: LarkWriteGuard,
  beforeRelay?: (scope: ExplicitFinalScope, actorId: string) => Promise<void>) {
  if (record.delivery_mode !== 'reply-agent') record = await deliverPublication(store, service, record, beforeSend);
  if (record.relay?.status === 'pending') {
    if (!record.first_attempt_at) { record = { ...record, first_attempt_at: Date.now() }; await saveRecord(store, record); }
    const relay = record.relay!;
    const guard = async () => {
      await beforeSend?.();
      if (Date.now() - record.first_attempt_at! > 60 * 60_000) throw new LarkServiceError('LARK_RESULT_RETRY_EXPIRED', '回传已超过 1 小时重试窗口，结果待确认。', 409);
      await beforeRelay?.(record.scope, relay.actor_id);
      // The frozen sender is checked from the original message, never from a new turn.
      const original = await service.getMessage(record.scope.origin_message_id);
      if (original.chatId !== record.scope.chat_id || !['app', 'bot'].includes(original.sender?.type ?? '') || original.sender?.id?.toLowerCase() !== relay.sender_id.toLowerCase()) throw new LarkServiceError('FINAL_TARGET_MISMATCH', '原交接机器人身份已变更。', 403);
      let pageToken: string | undefined;
      let targetPresent = false;
      for (let page = 0; page < 20; page++) {
        const members = await service.listChatMembers({ chatId: record.scope.chat_id, memberTypes: ['bot'], pageSize: 100, ...(pageToken ? { pageToken } : {}) });
        targetPresent = members.items.some(member => [member.memberId, member.openId, member.appId].some(id => id?.toLowerCase() === relay.target_id.toLowerCase())
          && [member.memberId, member.openId, member.appId].some(id => id?.toLowerCase() === relay.sender_id.toLowerCase()));
        if (targetPresent || !members.hasMore || !members.pageToken) break;
        pageToken = members.pageToken;
      }
      if (!targetPresent) throw new LarkServiceError('FINAL_TARGET_MISMATCH', '原交接机器人已不在当前群内。', 403);
      await beforeRelay?.(record.scope, relay.actor_id);
      await beforeSend?.();
    };
    let sent: Awaited<ReturnType<typeof commitLarkAgentReply>>;
    try { sent = await commitLarkAgentReply(service, { originMessageId: record.scope.origin_message_id, text: relay.text, idempotencyKey: relay.provider_uuid }, guard); }
    catch (error) {
      if (larkFailureKind(error) === 'unknown') await saveRecord(store, { ...record, relay: { ...relay, delivery_unknown: true } });
      throw error;
    }
    if (!sent.messageId?.trim()) throw new Error('Reply-agent provider returned no message ID');
    record = { ...record, status: 'delivered', relay: { ...relay, status: 'delivered', message_id: sent.messageId } };
    await saveRecord(store, record);
  }
  return record;
}
// Caller holds the per-store/task lock, including authority/current-attempt checks.
export async function sendExplicitFinal(store: ConfigRepository, service: LarkCardService, context: ExplicitFinalContext, content: string, beforeSend?: LarkWriteGuard, cardBody?: FinalCardBody, delivery: ExplicitFinalDelivery = { mode: 'publish' }) {
  if (delivery.mode !== 'publish') delivery = { ...delivery, relay: relayIntentSchema.parse(delivery.relay) };
  let record = await readRecord(store, context.scope, true);
  if (record && ((record.delivery_mode ?? 'publish') !== delivery.mode || JSON.stringify(record.relay && relayIntent(record.relay)) !== JSON.stringify(delivery.relay) || record.content !== content || JSON.stringify(record.card_body) !== JSON.stringify(cardBody))) throw Object.assign(new Error('本轮已提交不同的最终答复，不能覆盖。'), { code: 'FINAL_CONTENT_CONFLICT', statusCode: 409 });
  if (!record) {
    record = { version: 1, status: 'pending', scope: context.scope, content, ...(delivery.mode !== 'publish' ? { delivery_mode: delivery.mode, relay: { ...delivery.relay!, status: 'pending' as const } } : {}), ...(cardBody ? { card_body: cardBody } : {}), task_name: context.taskName, provider_uuid: uuidFor(context.scope) };
    await saveRecord(store, record);
  }
  if (record.status === 'failed' && !record.audit_rejected) {
    record = { ...record, status: 'pending' };
    await saveRecord(store, record);
  }
  const receipt = await deliver(store, service, record, beforeSend);
  return receiptFor(receipt);
}
export async function completeExplicitFinal(store: ConfigRepository | undefined, service: LarkCardService, context: ExplicitFinalContext | undefined,
  input: LarkCardInput, decoration: Elements, beforeSend?: LarkWriteGuard, beforeRelay?: (scope: ExplicitFinalScope, actorId: string) => Promise<void>): Promise<ExplicitFinalReceipt | undefined> {
  if (!store || !context) return;
  const record = await readRecord(store, context.scope);
  if (!record || !authoritative(record, input.state ?? 'completed')) return;
  if (record.status === 'failed' && frozenIntent(record) && !record.audit_rejected) {
    const deliveryFailure = '最终答复未送达：已提交的卡片或交付请求被拒绝，已停止自动重发。请在工作台核对；本回执仅说明交付状态。';
    const notice = await sendLarkDeliveryText(service, targetFor(record.scope), { text: deliveryFailure,
      idempotencyKey: `final_failure_${digest(record.scope).slice(0, 32)}` }, store, beforeSend);
    return { messageId: notice.messageId, elements: [{ tag: 'markdown', element_id: 'explicit_final_failure', content: deliveryFailure }], textReceipt: true, deliveryFailure };
  }
  const receipt = await deliver(store, service, record, beforeSend, beforeRelay);
  if (receipt.delivery_mode === 'reply-agent') return receiptFor(receipt);
  const elements = [...decoration.filter(item => item.element_id === 'group_mention'), ...receipt.elements!,
    ...decoration.filter(item => item.element_id !== 'group_mention')];
  const prepared = await prepareLarkResult(service, targetFor(context.scope), { ...input, beforeSend,
    elements, ...(receipt.card_body ? { cardBody: { ...receipt.card_body, elements } } : {}), idempotencyKey: receipt.provider_uuid }, log, store, beforeSend);
  // Transient failures retry the same card. A permanently unavailable card gets
  // only a platform-status receipt; the already delivered answer is never copied.
  try { await service.update({ ...prepared.input, beforeSend, messageId: receipt.message_id! }); }
  catch (error) {
    if (!isLarkMessageUnupdatable(error)) throw error;
    const status = await sendLarkResult(service, targetFor(context.scope), { ...input,
      elements: [ ...decoration.filter(item => item.element_id === 'group_mention'),
        { tag: 'markdown', element_id: 'explicit_final_delivered', content: '正文已交付；原答复卡已无法更新。本卡提供平台执行状态、验证与验收入口。' },
        ...decoration.filter(item => item.element_id !== 'group_mention') ],
      idempotencyKey: `final_status_${digest(context.scope).slice(0, 32)}`
    }, log, store, beforeSend);
    return { ...status, attachmentMessageId: receipt.attachment_message_id ?? prepared.attachmentMessageId };
  }
  return { messageId: receipt.message_id!, elements: prepared.input.elements,
    attachmentMessageId: prepared.attachmentMessageId ?? receipt.attachment_message_id };
}
