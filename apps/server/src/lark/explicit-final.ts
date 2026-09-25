import { createHash } from 'node:crypto';
import { isLarkMessageUnupdatable } from './card-renderer.js';
import type { ConfigRepository, ChannelMapping } from '@dutydeck/shared';
import type { PersistedLarkCardTask } from './coordinator.js';
import { prepareLarkResult, sendLarkResult, type DeliveryTarget } from './result-delivery.js';
import type { LarkCardInput, LarkCardService } from './service.js';
import type { LarkAgentSessionBinding } from './agent-tools.js';

export interface ExplicitFinalScope {
  app_id: string; session_id: string; runtime_task_id: string; attempt_id: string;
  origin_message_id: string; turn: number; chat_id: string; chat_type: 'group' | 'p2p';
  reply_message_id: string; reply_in_thread: boolean;
}
export interface ExplicitFinalContext { scope: ExplicitFinalScope; taskName: string }
type Elements = Array<Record<string, any>>;
interface FinalRecord {
  version: 1; status: 'pending' | 'failed' | 'delivered'; scope: ExplicitFinalScope; content: string; provider_uuid: string;
  task_name: string; message_id?: string; attachment_message_id?: string; elements?: Elements;
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
      const saved = JSON.parse(row.extra ?? '{}') as PersistedLarkCardTask;
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
async function readRecord(store: ConfigRepository, scope: ExplicitFinalScope): Promise<FinalRecord | undefined> {
  const saved = await store.get(keyFor(scope));
  try {
    const record = JSON.parse(saved ?? 'null') as FinalRecord | null;
    if (!record || record.version !== 1 || !['pending', 'failed', 'delivered'].includes(record.status) || JSON.stringify(record.scope) !== JSON.stringify(scope)
      || record.provider_uuid !== uuidFor(scope) || typeof record.content !== 'string' || !record.content.trim()
      || typeof record.task_name !== 'string' || (record.message_id !== undefined && (typeof record.message_id !== 'string' || !record.message_id.trim()
        || !Array.isArray(record.elements) || !record.elements.every(item => item && typeof item === 'object')))) return;
    if ((record.status === 'delivered') !== Boolean(record.message_id)) return;
    if (record.message_id) {
      const output = record.elements?.find(item => item.element_id === 'final_output');
      if (!output || (output.content !== record.content && !(typeof record.attachment_message_id === 'string' && record.attachment_message_id.trim()
        && record.elements?.some(item => item.element_id === 'result_attachment')))) return;
    }
    return record;
  } catch { return; }
}
/** 本轮已提交且未失败的显式最终答复正文（只读），供会话历史回看。 */
export async function readExplicitFinal(store: ConfigRepository, context: ExplicitFinalContext): Promise<string | undefined> {
  const record = await readRecord(store, context.scope);
  return record && record.status !== 'failed' ? record.content : undefined;
}
export async function hasExplicitFinal(store: ConfigRepository | undefined, context: ExplicitFinalContext | undefined) {
  const record = store && context ? await readRecord(store, context.scope) : undefined;
  return Boolean(record && record.status !== 'failed');
}
const log = { warn: (..._args: any[]) => {} };
async function deliver(store: ConfigRepository, service: LarkCardService, record: FinalRecord) {
  if (record.message_id) return record;
  let providerFailed = false;
  const strictService = new Proxy(service, { get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (!['send', 'reply', 'uploadFile', 'sendFile', 'replyFile'].includes(String(property)) || typeof value !== 'function') return value;
    return async (...args: unknown[]) => { try { return await value.apply(target, args); } catch (error) { providerFailed = true; throw error; } };
  } });
  let sent: Awaited<ReturnType<typeof sendLarkResult>>;
  let attachmentMessageId: string | undefined;
  try {
    const prepared = await prepareLarkResult(strictService, targetFor(record.scope), {
      state: 'running', cardKind: 'result', statusLabel: '答复已送达，执行尚未结束', readOnly: true,
      taskId: record.scope.origin_message_id, taskName: record.task_name, sessionId: record.scope.session_id, turn: record.scope.turn,
      capabilities: { canCancelQueued: false, canInterrupt: false, canRetry: false, canRefresh: false, canVerify: false },
      elements: [{ tag: 'markdown', element_id: 'final_output', content: record.content }], idempotencyKey: record.provider_uuid
    }, log, store);
    // A delivered (including cached) attachment makes this a partial delivery:
    // keep its intent retryable if the summary fails, never start a second result.
    attachmentMessageId = prepared.attachmentMessageId;
    sent = await sendLarkResult(strictService, targetFor(record.scope), prepared.input, log, store);
  } catch (error) {
    if (providerFailed && !attachmentMessageId) await store.set(keyFor(record.scope), JSON.stringify({ ...record, status: 'failed' }));
    throw error;
  }
  if (!sent.messageId?.trim()) throw new Error('Explicit final provider returned no message ID');
  const receipt: FinalRecord = { ...record, status: 'delivered', message_id: sent.messageId, elements: sent.elements,
    ...(attachmentMessageId ? { attachment_message_id: attachmentMessageId } : {}) };
  await store.set(keyFor(record.scope), JSON.stringify(receipt));
  return receipt;
}
// Caller holds the per-store/task lock, including authority/current-attempt checks.
export async function sendExplicitFinal(store: ConfigRepository, service: LarkCardService, context: ExplicitFinalContext, content: string) {
  let record = await readRecord(store, context.scope);
  if (record && record.content !== content) throw Object.assign(new Error('本轮已提交不同的最终答复，不能覆盖。'), { code: 'FINAL_CONTENT_CONFLICT', statusCode: 409 });
  if (!record) {
    record = { version: 1, status: 'pending', scope: context.scope, content, task_name: context.taskName, provider_uuid: uuidFor(context.scope) };
    await store.set(keyFor(context.scope), JSON.stringify(record));
  }
  if (record.status === 'failed') {
    record = { ...record, status: 'pending' };
    await store.set(keyFor(record.scope), JSON.stringify(record));
  }
  const receipt = await deliver(store, service, record);
  return { messageId: receipt.message_id!, elements: receipt.elements!, attachmentMessageId: receipt.attachment_message_id };
}
export async function completeExplicitFinal(store: ConfigRepository | undefined, service: LarkCardService, context: ExplicitFinalContext | undefined,
  input: LarkCardInput, decoration: Elements) {
  if (!store || !context) return;
  const record = await readRecord(store, context.scope);
  if (!record || record.status === 'failed') return;
  const receipt = await deliver(store, service, record);
  const elements = [...decoration.filter(item => item.element_id === 'group_mention'), ...receipt.elements!,
    ...decoration.filter(item => item.element_id !== 'group_mention')];
  const prepared = await prepareLarkResult(service, targetFor(context.scope), { ...input,
    elements, idempotencyKey: receipt.provider_uuid }, log, store);
  // Transient failures retry the same card. A permanently unavailable card gets
  // only a platform-status receipt; the already delivered answer is never copied.
  try { await service.update({ ...prepared.input, messageId: receipt.message_id! }); }
  catch (error) {
    if (!isLarkMessageUnupdatable(error)) throw error;
    const status = await sendLarkResult(service, targetFor(context.scope), { ...input,
      elements: [ ...decoration.filter(item => item.element_id === 'group_mention'),
        { tag: 'markdown', element_id: 'explicit_final_delivered', content: '正文已交付；原答复卡已无法更新。本卡提供平台执行状态、验证与验收入口。' },
        ...decoration.filter(item => item.element_id !== 'group_mention') ],
      idempotencyKey: `final_status_${digest(context.scope).slice(0, 32)}`
    }, log, store);
    return { ...status, attachmentMessageId: receipt.attachment_message_id ?? prepared.attachmentMessageId };
  }
  return { messageId: receipt.message_id!, elements: prepared.input.elements,
    attachmentMessageId: prepared.attachmentMessageId ?? receipt.attachment_message_id };
}
