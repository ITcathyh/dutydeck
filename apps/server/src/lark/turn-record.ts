import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { StoredLarkConfig } from './config.js';
import type { LarkTask, LarkTaskState } from './coordinator.js';
import type { LarkMessageEvent } from './listener.js';
import { larkMessageAnchor } from './message-anchor.js';

export const recoveryKind = z.enum(['redispatch', 'relaunch', 'continue', 'settled']);
export const turnRecordSchema = z.object({
  launcher_recovery_note: z.boolean().optional(),
  result_feedback_state: z.string().optional(),
  retry_material_prompt: z.string().optional(),
  sender_open_id: z.string().optional(),
  sender_type: z.string().optional(),
  thread_id: z.string().optional(),
  scope_id: z.string().optional(),
  app_id: z.string(),
  chat_id: z.string(),
  anchor_message_id: z.string().optional(),
  fallback_note: z.string().optional(),
  reply_message_id: z.string().optional(),
  reply_in_thread: z.boolean().optional(),
  root_message_id: z.string().optional(),
  card_message_id: z.string().optional(),
  runtime_task_id: z.string().optional(),
  task_name: z.string(),
  prompt: z.string(),
  state: z.enum(['queued', 'running', 'interrupting', 'interrupted', 'completed', 'failed', 'cancelled', 'reconcile_required', 'legacy_unresolved']),
  started_at: z.number(),
  last_successful_elements: z.array(z.record(z.any())).optional(),
  recovery_read_only: z.boolean().optional(),
  recovery_status_key: z.string().optional(),
  relaunch_pending: z.boolean().optional(),
  chat_type: z.string().optional(),
  final_message_id: z.string().optional(),
  final_attachment_message_id: z.string().optional(),
  final_delivery_state: z.enum(['delivered', 'reaction', 'failed']).optional(),
  final_delivery_error: z.string().optional(),
  final_delivery_attempts: z.number().optional(),
  final_delivery_retry_at: z.number().optional(),
  final_delivery_first_failed_at: z.number().optional(),
  final_elements: z.array(z.record(z.any())).optional(),
  final_card_input: z.record(z.unknown()).optional(),
  progress_frozen: z.boolean().optional(),
  turn: z.number().optional(),
  earlier_message_ids: z.array(z.string()).optional(),
  verification_auto: z.object({
    phase: z.enum(['running', 'interrupted', 'skipped', 'repairing', 'exhausted', 'infrastructure']),
    round: z.number().optional(), error: z.string().optional(), turn: z.number(), record_id: z.string().optional()
  }).passthrough().optional(),
  scenario_recall: z.object({ packId: z.string(), line: z.string() }).passthrough().optional(),
  alert_recall: z.unknown().optional(),
  recovery: z.object({
    kind: recoveryKind, decided_at: z.number(), basis: z.string(),
    values: z.record(recoveryKind, z.record(z.unknown()))
  }).passthrough().refine(recovery => recovery.values[recovery.kind] !== undefined).optional()
}).passthrough();
export type PersistedLarkCardTask = z.infer<typeof turnRecordSchema>;
type Mapping = { externalId: string; sessionId: string };

export function recordEvent(saved: PersistedLarkCardTask, messageId: string): LarkMessageEvent {
  const replyMessageId = saved.anchor_message_id ?? saved.reply_message_id;
  return {
    messageId, ...(replyMessageId && replyMessageId !== messageId ? { replyMessageId } : {}),
    chatId: saved.chat_id, chatType: saved.chat_type ?? 'group', messageType: 'text', content: '', mentions: [],
    senderOpenId: saved.sender_open_id, ...(saved.sender_type ? { senderType: saved.sender_type } : {}),
    ...(saved.thread_id ? { threadId: saved.thread_id } : {})
  };
}

function project(task: LarkTask, state: LarkTaskState, taskName: string): PersistedLarkCardTask {
  return {
    ...(task.launcherRecoveryNote ? { launcher_recovery_note: true } : {}),
    anchor_message_id: larkMessageAnchor(task.event),
    ...(task.fallbackNote ? { fallback_note: task.fallbackNote } : {}),
    app_id: task.config.appId,
    sender_open_id: task.event.senderOpenId,
    ...(task.event.senderType ? { sender_type: task.event.senderType } : {}),
    thread_id: task.event.threadId,
    scope_id: task.scopeId,
    chat_id: task.event.chatId,
    ...(task.cardMessageId ? { card_message_id: task.cardMessageId } : {}),
    ...(task.runtimeTaskId ? { runtime_task_id: task.runtimeTaskId } : {}),
    task_name: taskName,
    prompt: task.prompt,
    ...(task.retryMaterialPrompt ? { retry_material_prompt: task.retryMaterialPrompt } : {}),
    state,
    chat_type: task.event.chatType,
    turn: task.turn,
    ...(task.finalMessageId
      ? { final_message_id: task.finalMessageId, final_delivery_state: task.finalDeliveryState ?? 'delivered' as const }
      : task.finalDeliveryState ? { final_delivery_state: task.finalDeliveryState } : {}),
    ...(task.finalDeliveryError ? { final_delivery_error: task.finalDeliveryError } : {}),
    ...(task.finalMessageId ? { final_delivery_first_failed_at: undefined }
      : task.finalDeliveryFirstFailedAt !== undefined ? { final_delivery_first_failed_at: task.finalDeliveryFirstFailedAt } : {}),
    ...(task.finalAttachmentMessageId ? { final_attachment_message_id: task.finalAttachmentMessageId } : {}),
    ...(task.finalElements ? { final_elements: task.finalElements } : {}),
    ...(task.finalCardInput ? { final_card_input: task.finalCardInput } : {}),
    ...(task.progressFrozen ? { progress_frozen: true } : {}),
    ...(task.lastSuccessfulElements?.length ? { last_successful_elements: task.lastSuccessfulElements } : {}),
    // 没有进展也写这个键（序列化时省略）：同一轮合并写时要能清掉旧的进展。
    verification_auto: task.autoVerification && { ...task.autoVerification },
    ...(task.scenarioRecall ? { scenario_recall: { packId: task.scenarioRecall.packId, line: task.scenarioRecall.line } } : {}),
    ...(task.event.replyMessageId && task.event.chatType !== 'group' ? { reply_message_id: task.event.replyMessageId } : {}),
    ...(task.event.chatType === 'group' ? {
      reply_message_id: larkMessageAnchor(task.event),
      ...(task.event.threadId?.trim() ? { reply_in_thread: true } : {})
    } : {}),
    started_at: task.startedAt!
  };
}

// Keep the original representation (including missing legacy fields) while a restored turn is live.
const originals = new WeakMap<LarkTask, { record: PersistedLarkCardTask; projection: PersistedLarkCardTask; sessionId: string }>();

export function toRecord(task: LarkTask, state = task.state, taskName = originals.get(task)?.record.task_name ?? task.prompt) {
  const fields = project(task, state, taskName);
  const original = originals.get(task);
  if (!original || original.sessionId !== task.sessionId || original.projection.turn !== task.turn) return fields;
  const record = { ...original.record };
  for (const field of new Set([...Object.keys(fields), ...Object.keys(original.projection)])) {
    if (!isDeepStrictEqual(fields[field], original.projection[field])) record[field] = fields[field];
  }
  return record;
}

// Restored snapshots may be older than reconciliation or a recovery decision. Only overlay their changes on today's row.
export function mergeRestoredRecord(task: LarkTask, fields: PersistedLarkCardTask, latest: PersistedLarkCardTask) {
  const original = originals.get(task);
  if (!original || original.sessionId !== task.sessionId || original.projection.turn !== fields.turn) return { ...latest, ...fields };
  const merged = { ...latest };
  for (const field of Object.keys(fields)) {
    if (!isDeepStrictEqual(fields[field], original.record[field])) merged[field] = fields[field];
  }
  return merged;
}

export function fromRecord(saved: PersistedLarkCardTask, mapping: Mapping, config: StoredLarkConfig): LarkTask {
  const task: LarkTask = {
    fallbackNote: saved.fallback_note,
    ...(saved.launcher_recovery_note ? { launcherRecoveryNote: true } : {}),
    id: mapping.externalId, group: { tail: Promise.resolve() }, config, state: saved.state,
    turn: saved.turn ?? 0, epoch: 0, scopeId: saved.scope_id ?? '', prompt: saved.prompt,
    ...(config.adhdMode === true && mapping.externalId.startsWith('confirmation_') && !saved.task_name.startsWith('持久确认记录 ID：') ? { displayName: saved.task_name } : {}),
    resources: [], events: [], sessionId: mapping.sessionId, startedAt: saved.started_at,
    ...(saved.runtime_task_id ? { runtimeTaskId: saved.runtime_task_id } : {}),
    ...(saved.card_message_id ? { cardMessageId: saved.card_message_id } : {}),
    ...(saved.final_message_id ? { finalMessageId: saved.final_message_id } : {}),
    ...(saved.final_delivery_error ? { finalDeliveryError: saved.final_delivery_error } : {}),
    ...(saved.final_delivery_first_failed_at !== undefined ? { finalDeliveryFirstFailedAt: saved.final_delivery_first_failed_at } : {}),
    ...(saved.final_delivery_state ? { finalDeliveryState: saved.final_delivery_state } : {}),
    ...(saved.final_attachment_message_id ? { finalAttachmentMessageId: saved.final_attachment_message_id } : {}),
    ...(saved.final_card_input ? { finalCardInput: saved.final_card_input } : {}),
    ...(saved.progress_frozen ? { progressFrozen: true } : {}),
    ...(saved.last_successful_elements ? { lastSuccessfulElements: saved.last_successful_elements } : {}),
    ...(saved.verification_auto ? { autoVerification: saved.verification_auto } : {}),
    finalElements: saved.final_elements,
    retryMaterialPrompt: saved.retry_material_prompt,
    event: recordEvent(saved, mapping.externalId)
  };
  originals.set(task, structuredClone({ record: saved, projection: project(task, task.state, saved.task_name), sessionId: mapping.sessionId }));
  return task;
}
