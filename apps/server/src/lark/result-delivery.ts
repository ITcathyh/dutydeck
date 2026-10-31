import { createHash, randomUUID } from 'node:crypto';
import type { ConfigRepository } from '@dutydeck/shared';
import { COMPLETION_REACTION_EMOJI, FAILURE_REACTION_EMOJI, reactionDedupeKey, type ReactionRecord } from './reaction-records.js';
import { isLarkReplyTargetUnavailable, larkFailureKind } from './api-gate.js';
import { isLarkMessageUnupdatable } from './card-renderer.js';
import { buildLarkCard, larkCardFinalOutputText, larkCardShownResult, LarkServiceError, type LarkCardInput, type LarkCardService, type LarkWriteGuard } from './service.js';
import type { StoredLarkConfig } from './config.js';
import { larkTaskAgentGuid } from './task-agent.js';
import { planTaskOf } from '../plan-mode.js';

// Live delivery and restart reconciliation share one provider UUID per process card.
export const larkResultKey = (processMessageId: string) =>
  `result_${createHash('sha256').update(processMessageId).digest('hex').slice(0, 40)}`;

/**
 * 静默进展下没有过程卡，改用「任务 id + 轮次」当结果幂等锚点。
 * 实时链路与重启对账必须算出同一个串，否则对账会把同一份结果再发一次。
 */
export const larkSilentResultAnchor = (taskId: string, turn: number | undefined) => `silent:${taskId}:${turn ?? 0}`;

const saveReactionRecord = async (store: ConfigRepository | undefined, key: string, expected: string | undefined, record: ReactionRecord) => {
  if (store?.compareAndSet) return store.compareAndSet(key, expected, JSON.stringify(record));
  if (store) { await store.set(key, JSON.stringify(record)); return true; }
  return true;
};

// ConfigRepository implementations without a compare-and-set primitive still
// need same-process single-flight to prevent concurrent provider side effects.
const deliveryFlights = new Map<string, Promise<unknown>>();
const reactionFlights = new Map<string, Promise<boolean>>();
const reactionFlightStates = new Map<string, boolean>();
const DELIVERY_CLAIM_LEASE_MS = 120_000;
const DELIVERY_CLAIM_WAIT_MS = 250;
export type DeliveryConcurrencyOptions = { allowConcurrent?: boolean };

type DeliveryClaim = { owner: string; expiresAt: number };

/** Claim a provider side effect before invoking it. A confirmed receipt wins
 * immediately; a live claim is waited on briefly, while an expired claim can
 * be recovered after a crashed sender. */
async function claimDelivery(store: ConfigRepository, key: string, validate?: (value: unknown) => boolean, claimNamespace = key) {
  if (!store.compareAndSet) return;
  const claimKey = claimNamespace.startsWith('lark.delivery.')
    ? `lark.delivery_claim.${claimNamespace.slice('lark.delivery.'.length)}`
    : claimNamespace.startsWith('lark.reaction.')
      ? `lark.reaction_claim.${claimNamespace.slice('lark.reaction.'.length)}`
      : `${claimNamespace}.claim`;
  const owner = randomUUID();
  const deadline = Date.now() + DELIVERY_CLAIM_WAIT_MS;
  for (;;) {
    const confirmed = await store.get(key);
    if (confirmed) {
      try {
        const parsed = JSON.parse(confirmed);
        if (!validate || validate(parsed)) return { confirmed: parsed };
      } catch { /* Retry malformed receipts under the same provider UUID. */ }
    }
    const current = await store.get(claimKey);
    let live: DeliveryClaim | undefined;
    try { live = current ? JSON.parse(current) as DeliveryClaim : undefined; } catch { /* Replace malformed claims. */ }
    const now = Date.now();
    if (!live || live.expiresAt <= now) {
      const claim: DeliveryClaim = { owner, expiresAt: now + DELIVERY_CLAIM_LEASE_MS };
      if (await store.compareAndSet(claimKey, current, JSON.stringify(claim))) return { claimKey, claimRaw: JSON.stringify(claim) };
    }
    if (Date.now() >= deadline) throw new Error('LARK_DELIVERY_BUSY');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function releaseDeliveryClaim(store: ConfigRepository | undefined, claim: Awaited<ReturnType<typeof claimDelivery>>) {
  if (store?.compareAndSet && claim && 'claimKey' in claim && typeof claim.claimRaw === 'string') {
    await store.compareAndSet(claim.claimKey, claim.claimRaw, '');
  }
}

/**
 * 「完成时只贴表情」能否代替这一轮的结果卡。计划轮的计划正文和批准按钮都在结果卡上，任务通道的合成事件
 * 没有可贴的原消息：这两类照常发结果卡。实时交付与重启补发共用这一判断。
 */
export const larkCompletionReactionOnly = (config: Pick<StoredLarkConfig, 'completionReactionOnly'>, prompt: string, messageId: string) =>
  config.completionReactionOnly === true && planTaskOf(prompt) === undefined && !larkTaskAgentGuid(messageId);

/**
 * 一轮结束时在原始请求消息上贴状态表情：完成贴对勾，失败或中断贴叉号。
 * 同一条消息只留一枚：之后又有新终态（在原卡上重试后完成）时，先撤掉上一枚再贴这一枚。
 *
 * 先查 kv 幂等键再调平台再写回，重启对账反复进入时命中即返，绝不重复打表情；撤掉的记录标 removedAt，之后还能再贴。
 *
 * 返回是否确实送达：「完成时只贴表情」打开时对勾是用户唯一能看到的完成信号，贴失败还记成
 * 「已交付」，用户就什么都收不到了。失败只 warn（不抛），由调用方决定是否留给对账重试。
 */
export async function deliverLarkStatusReaction(
  service: Pick<LarkCardService, 'addReaction' | 'deleteReaction'>,
  input: { appId: string; messageId: string; completed: boolean },
  log: DeliveryLog,
  store?: ConfigRepository
): Promise<boolean> {
  // Serialize both terminal states for one message so a completion/failure race
  // cannot leave two reactions after each independently reads an empty record.
  const flightKey = `${input.appId}:${input.messageId}`;
  const existing = reactionFlights.get(flightKey);
  if (existing) {
    if (reactionFlightStates.get(flightKey) === input.completed) return existing;
    await existing;
    if (reactionFlightStates.get(flightKey) === input.completed) return true;
  }
  const flight = deliverLarkStatusReactionOnce(service, input, log, store);
  reactionFlights.set(flightKey, flight);
  reactionFlightStates.set(flightKey, input.completed);
  try { return await flight; } finally { if (reactionFlights.get(flightKey) === flight) reactionFlights.delete(flightKey); }
}

async function deliverLarkStatusReactionOnce(
  service: Pick<LarkCardService, 'addReaction' | 'deleteReaction'>,
  input: { appId: string; messageId: string; completed: boolean },
  log: DeliveryLog,
  store?: ConfigRepository
): Promise<boolean> {
  const [emojiType, previousEmoji] = input.completed
    ? [COMPLETION_REACTION_EMOJI, FAILURE_REACTION_EMOJI] : [FAILURE_REACTION_EMOJI, COMPLETION_REACTION_EMOJI];
  const key = reactionDedupeKey(input.appId, input.messageId, emojiType);
  let claim: Awaited<ReturnType<typeof claimDelivery>>;
  try {
    const saved = await store?.get(key);
    if (saved) {
      try { if (!(JSON.parse(saved) as ReactionRecord).removedAt) return true; }
      catch { /* Malformed receipts are repaired by the claim path below. */ }
    }
    claim = store ? await claimDelivery(store, key, value => {
      const record = value as Partial<ReactionRecord>;
      return typeof record.messageId === 'string' && typeof record.reactionId === 'string' && !record.removedAt;
    }, `lark.reaction.${input.appId}.${input.messageId}`) : undefined;
    if (claim?.confirmed !== undefined) return true;
    const previousKey = reactionDedupeKey(input.appId, input.messageId, previousEmoji);
    const previousRaw = await store?.get(previousKey);
    let previous: ReactionRecord | undefined;
    if (previousRaw) {
      try { previous = JSON.parse(previousRaw) as ReactionRecord; }
      catch { /* A malformed old receipt cannot identify a reaction to remove. */ }
    }
    if (previous && !previous.removedAt) {
      // 撤不掉也照贴新的：两枚并存总比停在过时的那一枚好。
      try {
        await service.deleteReaction(input.messageId, previous.reactionId);
        await saveReactionRecord(store, previousKey, previousRaw, { ...previous, removedAt: new Date().toISOString() });
      } catch (error) { log.warn({ error, key: previousKey }, '撤掉上一枚状态表情失败'); }
    }
    const result = await service.addReaction(input.messageId, emojiType);
    const persisted = await saveReactionRecord(store, key, saved, {
      messageId: result.messageId, emojiType, reactionId: result.reactionId, createdAt: new Date().toISOString()
    });
    if (!persisted && store) {
      const winner = await store.get(key);
      if (!winner) return false;
    }
    await releaseDeliveryClaim(store, claim);
    return true;
  } catch (error) {
    await releaseDeliveryClaim(store, claim);
    log.warn({ error, key }, '状态表情写入失败');
    return false;
  }
}

export type DeliveryTarget = { chatId: string; replyMessageId?: string; replyInThread?: boolean; allowReplyFallback?: boolean };
type DeliveryLog = { warn: (...args: any[]) => void };

// Save only successful provider responses. Each leg has its own UUID and durable
// receipt, so a restart after the file send retries only the missing summary.
async function delivered<T>(store: ConfigRepository | undefined, key: string, send: () => Promise<T>, validate?: (result: T) => boolean,
  options: DeliveryConcurrencyOptions = {}): Promise<T> {
  const existing = deliveryFlights.get(key);
  if (existing) {
    // A caller that explicitly owns an expired work-item lease may retry with
    // the same provider UUID. This escape hatch is only safe with a durable
    // CAS store; ordinary callers retain strict same-process single-flight.
    if (!options.allowConcurrent || !store?.compareAndSet) return existing as Promise<T>;
    return deliveredOnce(store, key, send, validate, true);
  }
  const flight = deliveredOnce(store, key, send, validate);
  deliveryFlights.set(key, flight);
  try { return await flight; } finally { if (deliveryFlights.get(key) === flight) deliveryFlights.delete(key); }
}

async function deliveredOnce<T>(store: ConfigRepository | undefined, key: string, send: () => Promise<T>, validate?: (result: T) => boolean, skipClaim = false): Promise<T> {
  const saved = await store?.get(key);
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as T;
      if (!validate || validate(parsed)) return parsed;
    } catch { /* Strict delivery retries malformed cache entries with the same provider UUID. */ }
  }
  const claim = store && !skipClaim ? await claimDelivery(store, key, validate as ((value: unknown) => boolean) | undefined) : undefined;
  if (claim?.confirmed !== undefined) return claim.confirmed as T;
  let result: T;
  try { result = await send(); }
  catch (error) {
    // Preserve the existing retry contract for provider failures. A failed
    // request has no confirmed receipt, so a later reconciliation may retry
    // the same provider UUID; concurrent callers were still serialized by the
    // claim while this attempt was in flight.
    await releaseDeliveryClaim(store, claim);
    throw error;
  }
  try {
    if (validate && !validate(result)) throw new Error(`Provider returned an invalid delivery receipt: ${key}`);
    if (store?.compareAndSet) {
      if (!await store.compareAndSet(key, validate ? saved : undefined, JSON.stringify(result))) {
        const winner = JSON.parse((await store.get(key))!) as T;
        if (validate && !validate(winner)) throw new Error(`Invalid delivery receipt: ${key}`);
        return winner;
      }
    } else if (store) await store.set(key, JSON.stringify(result));
    return result;
  } finally {
    await releaseDeliveryClaim(store, claim);
  }
}

/** A successful message response bound to the caller's frozen operation and destination. */
export interface LarkBoundDelivery {
  idempotencyKey: string;
  identity: string;
  chatId: string;
}
interface LarkBoundReceipt { messageId: string; chatId: string; identity: string }
const boundDeliveryKey = (input: LarkBoundDelivery) => `lark.delivery.${input.idempotencyKey}.message`;
const matchesBoundReceipt = (value: unknown, input: LarkBoundDelivery): value is LarkBoundReceipt => {
  const receipt = value as Partial<LarkBoundReceipt> | null;
  return Boolean(receipt && typeof receipt.messageId === 'string' && receipt.messageId.trim()
    && receipt.chatId === input.chatId && receipt.identity === input.identity);
};

/** Read local proof only; a missing or conflicting receipt never invokes the provider. */
export async function readConfirmedLarkBoundMessage(store: ConfigRepository, input: LarkBoundDelivery): Promise<LarkBoundReceipt | undefined> {
  const saved = await store.get(boundDeliveryKey(input));
  if (!saved) return;
  try { const receipt: unknown = JSON.parse(saved); if (matchesBoundReceipt(receipt, input)) return receipt; }
  catch { /* Invalid proof remains unknown. */ }
}

export async function sendLarkBoundMessage(store: ConfigRepository, input: LarkBoundDelivery,
  send: () => Promise<{ messageId: string; chatId?: string }>): Promise<LarkBoundReceipt> {
  // Do not repair a conflicting receipt by sending to a potentially different destination.
  if (await store.get(boundDeliveryKey(input))) {
    const confirmed = await readConfirmedLarkBoundMessage(store, input);
    if (!confirmed) throw new Error('Lark delivery receipt identity conflict');
    return confirmed;
  }
  const receipt = await delivered(store, boundDeliveryKey(input), async () => {
    // Another process may have persisted a conflicting proof while this caller waited for its claim.
    if (await store.get(boundDeliveryKey(input))) {
      const confirmed = await readConfirmedLarkBoundMessage(store, input);
      if (!confirmed) throw new Error('Lark delivery receipt identity conflict');
      return confirmed;
    }
    const result = await send();
    if (result.chatId !== undefined && result.chatId !== input.chatId) throw new Error('Lark delivery response destination conflict');
    return { messageId: result.messageId, chatId: input.chatId, identity: input.identity };
  }, result => matchesBoundReceipt(result, input));
  if (!matchesBoundReceipt(receipt, input)) throw new Error('Lark delivery receipt identity conflict');
  return receipt;
}

/** A fixed host delivery-status receipt; it never contains the result body or changes its target. */
export async function sendLarkDeliveryText(service: Pick<LarkCardService, 'sendText' | 'replyText'>, target: DeliveryTarget,
  input: { text: string; idempotencyKey: string }, store: ConfigRepository, beforeSend?: LarkWriteGuard) {
  return delivered(store, `lark.delivery.${input.idempotencyKey}.message`, async () => {
    await beforeSend?.();
    return target.replyMessageId
      ? service.replyText({ ...input, messageId: target.replyMessageId, replyInThread: target.replyInThread, ...(beforeSend ? { beforeSend } : {}) })
      : service.sendText({ ...input, chatId: target.chatId, ...(beforeSend ? { beforeSend } : {}) });
  }, result => typeof result?.messageId === 'string' && Boolean(result.messageId.trim()));
}

export async function sendLarkFile(
  service: LarkCardService, target: DeliveryTarget,
  input: { data: Uint8Array; filename: string; idempotencyKey: string },
  log: DeliveryLog, store?: ConfigRepository, beforeSend?: LarkWriteGuard, options: DeliveryConcurrencyOptions = {}
) {
  const prefix = `lark.delivery.${input.idempotencyKey}`;
  // Uploads have no provider idempotency UUID; keep this leg strictly
  // single-flight even when the summary message is explicitly retried.
  const fileKey = await delivered(store, `${prefix}.upload`, async () => { await beforeSend?.(); return service.uploadFile({ ...input, ...(beforeSend ? { beforeSend } : {}) }); });
  return delivered(store, `${prefix}.message`, async () => {
    if (target.replyMessageId) {
      await beforeSend?.();
      try {
        return await service.replyFile({
          messageId: target.replyMessageId,
          ...(target.replyInThread ? { replyInThread: true } : {}),
          ...(beforeSend ? { beforeSend } : {}), fileKey,
          idempotencyKey: input.idempotencyKey,
        });
      } catch (error) {
        // 只有平台明确说原消息不能再回复才改发；超时、断连这类结果未知的失败原样抛出，由调用方用同一 UUID 重发同一个回复。
        if (target.allowReplyFallback === false || !isLarkReplyTargetUnavailable(error)) throw error;
        log.warn({ error, messageId: target.replyMessageId }, '回复文件失败，回退为会话内发送');
      }
    }
    await beforeSend?.();
    return service.sendFile({ ...(beforeSend ? { beforeSend } : {}), chatId: target.chatId, fileKey, idempotencyKey: input.idempotencyKey });
  }, target.allowReplyFallback === false ? result => typeof result?.messageId === 'string' && Boolean(result.messageId.trim()) : undefined, options);
}

const downgradedResultKey = (key: string) => `result_d_${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;

// 飞书卡片的表格上限：单个 Markdown 组件最多 4 个表格，整张卡最多 5 个表格组件。官方没写 Markdown 表格是否计入整卡上限，
// 外部项目报告超过时同样被拒收（230099 / ErrCode 11310），这里按计入处理。
const larkCardTableLimits = { markdown: 4, card: 5 } as const;
const markdownTableDelimiter = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
/** 表头行后面紧跟分隔行（| --- |）算一个表格；代码块里的不算。 */
const markdownTableCount = (text: string) => {
  let inFence = false;
  let previous = '';
  let count = 0;
  for (const line of text.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) inFence = !inFence;
    else if (!inFence && previous.includes('|') && line.includes('|') && markdownTableDelimiter.test(line)) count++;
    previous = inFence ? '' : line;
  }
  return count;
};
/** 卡上每个 Markdown 组件、以及整张卡（开头段和折叠段一起算）的表格数都在上限内。 */
const withinTableLimits = (elements: unknown) => {
  let total = 0;
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.every(visit);
    if (!value || typeof value !== 'object') return true;
    const record = value as Record<string, unknown>;
    if (record.tag === 'table') total++;
    if (record.tag === 'markdown' && typeof record.content === 'string') {
      const count = markdownTableCount(record.content);
      if (count > larkCardTableLimits.markdown) return false;
      total += count;
    }
    return Object.values(record).every(visit);
  };
  return visit(elements) && total <= larkCardTableLimits.card;
};
/** 结果卡被平台按卡片内容拒收：230099 卡片内容创建失败（表格超限、非法图片等），230025 超过消息体积上限。 */
const isLarkResultCardRejected = (error: unknown) => error instanceof LarkServiceError && [230099, 230025].includes(Number(error.details?.upstreamCode));

/** forceAttachment：整卡已被平台拒收，这次直接走「节选 + 附件」，节选卡换一个 UUID（内容不同）。 */
export async function prepareLarkResult(
  service: LarkCardService,
  target: DeliveryTarget,
  input: LarkCardInput & { elements: Array<Record<string, any>>; idempotencyKey: string },
  log: DeliveryLog,
  store?: ConfigRepository,
  beforeSend?: LarkWriteGuard,
  forceAttachment = false,
  options: DeliveryConcurrencyOptions = {}
): Promise<{ input: LarkCardInput & { elements: Array<Record<string, any>>; idempotencyKey: string }; attachmentMessageId?: string }> {
  beforeSend ??= input.beforeSend;
  if (input.cardBody && forceAttachment) throw new LarkServiceError('INVALID_FINAL_CARD', '自定义卡片被平台拒收，请修正静态卡片内容后重新提交。', 400);
  const resultInput = { ...input, cardKind: 'result' as const };
  const output = resultInput.elements.find(element => element.element_id === 'final_output')?.content;
  const card = buildLarkCard(resultInput);
  // 长结论在卡上拆成「开头 + 折叠」两段，按拼起来的全文判断整份结论是否都在卡上；卡面改写过图片和本机路径链接、
  // 拿走了「需要你：」行，按改写后的文字比。
  // 表格数超过飞书上限的卡一定会被拒收，同样按放不下处理。
  const fits = !forceAttachment && (!output || typeof output === 'string'
    && larkCardFinalOutputText(card.body.elements as Array<Record<string, unknown>>) === larkCardShownResult(output) && withinTableLimits(card.body.elements));
  let attachmentMessageId: string | undefined;
  if (forceAttachment) resultInput.idempotencyKey = downgradedResultKey(input.idempotencyKey);
  if (!fits) {
    // 附件名用结果卡标题（结论第一句）：去掉文件名里不能出现的字符，群里看到的是一个能读懂的名字。
    const filename = `${(input.taskName ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60).replace(/[. ]+$/, '') || '执行结果'}.md`;
    const acceptance = input.elements.some(element => element.element_id === 'workflow_accept')
      ? '\n\n---\n\n结果验收：回复本文件消息「验收通过」即可确认；需要修改时，回复本文件消息并说明修改要求。'
      : '';
    const file = await sendLarkFile(service, target, {
      data: Buffer.from(`${output}${acceptance}`, 'utf8'), filename,
      idempotencyKey: `result_file_${createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 36)}`
    }, log, store, beforeSend);
    attachmentMessageId = file.messageId;
    const head = Array.from(String(output)).slice(0, 700).join('');
    // 节选可能切在代码块中间，补上收尾的围栏。
    const excerpt = (head.match(/^\s*(?:```|~~~)/gm)?.length ?? 0) % 2 ? `${head}…\n\`\`\`` : `${head}…`;
    // An exact excerpt is not a business-outcome summary. Keep it explicitly
    // labelled; never infer success from a finished agent turn.
    resultInput.elements = [
      // 节选按 Markdown 渲染：卡面不再露出 ---、###、** 这些符号。
      { tag: 'markdown', element_id: 'final_output', text_align: 'left', text_size: 'normal_v2', margin: '0px', content: `**正文开头节选（非完整结论）**\n\n${excerpt}` },
      { tag: 'div', element_id: 'result_attachment', text: { tag: 'plain_text', content: `完整正文已发送为附件「${filename}」。未完成事项与下一步请以全文为准；可引用本卡或附件反馈。` } },
      // 验证状态行必须跟着摘要卡走：结果转成附件后，卡上只剩节选，
      // 「这份结论有没有被平台验证过」比节选本身更需要留在能看见的地方。
      ...input.elements.filter(element => ['verification_status', 'context_hint', 'workflow_result_status', 'workflow_accept', 'workflow_changes', 'disable_schedule'].includes(String(element.element_id))
        || String(element.element_id).startsWith('workflow_plan_')),
      ...input.elements.filter(element => element.element_id === 'group_mention')
    ];
  }
  return { input: resultInput, ...(attachmentMessageId ? { attachmentMessageId } : {}) };
}

/** Only documented audit/sensitive-content codes count; general card/permission failures do not. */
export const isLarkFinalContentAuditRejected = (error: unknown) => error instanceof LarkServiceError
  && larkFailureKind(error) === 'rejected'
  && ([230022, 230028, 11312, 11248].includes(Number(error.details?.upstreamCode))
    || Number(error.details?.upstreamCode) === 18054 && /sensitive|audit|敏感|审[核计]/i.test(error.message));

const contentAuditNotice = '本轮结果被飞书内容安全审核拒收，原文不会自动重发。请在有权访问的工作台查看结果；如需发送到聊天，请先脱敏。';

async function notifyContentAudit(service: LarkCardService, target: DeliveryTarget, key: string,
  log: DeliveryLog, store?: ConfigRepository, beforeSend?: LarkWriteGuard) {
  const uuid = `audit_${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
  try {
    await delivered(store, `lark.delivery.${key}.audit_notice`, async () => {
      await beforeSend?.();
      const input = { text: contentAuditNotice, idempotencyKey: uuid, ...(beforeSend ? { beforeSend } : {}) };
      if (target.replyMessageId) {
        try { return await service.replyText({ ...input, messageId: target.replyMessageId, replyInThread: target.replyInThread }); }
        catch (error) { if (target.allowReplyFallback === false || !isLarkReplyTargetUnavailable(error)) throw error; }
      }
      await beforeSend?.();
      return service.sendText({ ...input, chatId: target.chatId });
    }, result => typeof result?.messageId === 'string' && Boolean(result.messageId.trim()));
  } catch (error) {
    // The original result stays failed even if the separate fixed notice cannot be delivered.
    await store?.set(`lark.delivery.${key}.audit_notice_error`, error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300));
    log.warn({ error, idempotencyKey: key }, '内容审核拒收提示投递失败，原结果仍未送达');
  }
}

export async function recordLarkResultAuditRejection(service: LarkCardService, target: DeliveryTarget, key: string,
  error: unknown, log: DeliveryLog, store?: ConfigRepository, beforeSend?: LarkWriteGuard) {
  if (!isLarkFinalContentAuditRejected(error)) return;
  await store?.set(`lark.delivery.${key}.audit_rejected`, String((error as LarkServiceError).details?.upstreamCode));
  await notifyContentAudit(service, target, key, log, store, beforeSend);
}

export async function sendLarkResult(
  service: LarkCardService, target: DeliveryTarget,
  input: LarkCardInput & { elements: Array<Record<string, any>>; idempotencyKey: string },
  log: DeliveryLog, store?: ConfigRepository, beforeSend?: LarkWriteGuard, options: DeliveryConcurrencyOptions = {}
): Promise<{ messageId: string; elements: Array<Record<string, any>>; attachmentMessageId?: string }> {
  beforeSend ??= input.beforeSend;
  const auditKey = `lark.delivery.${input.idempotencyKey}.audit_rejected`;
  const previous = await store?.get(auditKey);
  if (previous) {
    await notifyContentAudit(service, target, input.idempotencyKey, log, store, beforeSend);
    throw new LarkServiceError('LARK_OPENAPI_ERROR', '最终结果已被飞书内容审核拒收。', 502, { upstreamCode: Number(previous), upstreamHttpStatus: 400 });
  }
  try {
    const prepared = await prepareLarkResult(service, target, input, log, store, beforeSend, false, options);
    try { return await sendPreparedLarkResult(service, target, prepared, log, store, beforeSend, options); }
    catch (error) {
      const output = input.elements.find(element => element.element_id === 'final_output')?.content;
      if (prepared.attachmentMessageId || typeof output !== 'string' || !output || !isLarkResultCardRejected(error)) throw error;
      log.warn({ error, idempotencyKey: input.idempotencyKey }, '结果卡被飞书拒收，改为正文节选加附件发送');
      return await sendPreparedLarkResult(service, target, await prepareLarkResult(service, target, input, log, store, beforeSend, true, options), log, store, beforeSend, options);
    }
  } catch (error) {
    if (isLarkFinalContentAuditRejected(error)) {
      // Persist rejection before the notice: restart reconciliation never resends the rejected body.
      await recordLarkResultAuditRejection(service, target, input.idempotencyKey, error, log, store, beforeSend);
    }
    throw error;
  }
}

/** Recover confirmed receipts only. The guard forbids every missing upload/send leg. */
export async function readConfirmedLarkResult(
  service: LarkCardService, target: DeliveryTarget,
  input: LarkCardInput & { elements: Array<Record<string, any>>; idempotencyKey: string },
  log: DeliveryLog, store?: ConfigRepository
): Promise<{ messageId: string; elements: Array<Record<string, any>>; attachmentMessageId?: string } | undefined> {
  if (!store || await store.get(`lark.delivery.${input.idempotencyKey}.audit_rejected`)) return;
  const missing = () => { throw new LarkServiceError('LARK_RESULT_RECEIPT_MISSING', '完整结果尚无已确认回执。', 409); };
  for (const fallback of [false, true]) {
    const key = fallback ? downgradedResultKey(input.idempotencyKey) : input.idempotencyKey;
    if (!await store.get(`lark.delivery.${key}.summary`)) continue;
    try {
      const prepared = await prepareLarkResult(service, { ...target, allowReplyFallback: false }, input, log, store, missing, fallback);
      const output = prepared.input.elements.find(item => item.element_id === 'final_output')?.content;
      const sent = await delivered<{ messageId: string; elements: Array<Record<string, any>> }>(store, `lark.delivery.${key}.summary`, async () => missing(), result =>
        typeof result?.messageId === 'string' && Boolean(result.messageId.trim()) && Array.isArray(result.elements)
        && result.elements.every(item => item && typeof item === 'object')
        && (output === undefined ? JSON.stringify(result.elements) === JSON.stringify(prepared.input.elements)
          : result.elements.find(item => item.element_id === 'final_output')?.content === output)
        && (!prepared.attachmentMessageId || result.elements.some(item => item.element_id === 'result_attachment')));
      // Return what was actually confirmed, not new decorations or a regenerated attachment filename.
      return { ...sent, ...(prepared.attachmentMessageId ? { attachmentMessageId: prepared.attachmentMessageId } : {}) };
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof LarkServiceError && error.code === 'LARK_RESULT_RECEIPT_MISSING')) throw error;
    }
  }
}

async function sendPreparedLarkResult(
  service: LarkCardService, target: DeliveryTarget, prepared: Awaited<ReturnType<typeof prepareLarkResult>>,
  log: DeliveryLog, store?: ConfigRepository, beforeSend?: LarkWriteGuard, options: DeliveryConcurrencyOptions = {}
): Promise<{ messageId: string; elements: Array<Record<string, any>>; attachmentMessageId?: string }> {
  const { input: resultInput, attachmentMessageId } = prepared;
  const elements = resultInput.elements;
  const sent = await delivered(store, `lark.delivery.${resultInput.idempotencyKey}.summary`, async () => {
    if (target.replyMessageId && typeof service.reply === 'function') {
      await beforeSend?.();
      try {
        const result = await service.reply({
          ...resultInput, ...(beforeSend ? { beforeSend } : {}),
          messageId: target.replyMessageId,
          ...(target.replyInThread ? { replyInThread: true } : {}),
        });
        return { ...result, elements };
      } catch (error) {
        if (target.allowReplyFallback === false || !isLarkReplyTargetUnavailable(error)) throw error;
        log.warn({ error, messageId: target.replyMessageId, chatId: target.chatId }, '回复执行结果失败，回退为会话内发送');
      }
    }
    if (target.replyMessageId && target.allowReplyFallback === false) throw new Error('Explicit final requires reply support');
    await beforeSend?.();
    return { ...await service.send({ ...resultInput, ...(beforeSend ? { beforeSend } : {}), chatId: target.chatId }), elements };
  }, target.allowReplyFallback === false ? result => typeof result?.messageId === 'string' && Boolean(result.messageId.trim())
    && JSON.stringify(result.elements) === JSON.stringify(elements) : undefined, options);
  return { ...sent, ...(attachmentMessageId ? { attachmentMessageId } : {}) };
}

/**
 * 以普通卡片 PATCH 整卡覆盖被点击的消息（非流式，延迟再久也不影响原消息可转发）。
 *
 * 返回 null 表示 PATCH 没有成功，是否改发新卡由调用方决定，两种情形：
 * 1. 卡内含最终结果且超出卡片预算——PATCH 不能附带文件，硬覆盖会把长结果截断成假凭证；
 * 2. 平台更新失败（消息被撤回、超过更新窗口等）。
 */
export async function patchLarkCard(
  service: LarkCardService,
  target: { messageId: string },
  input: LarkCardInput & { elements: Array<Record<string, any>> },
  log: { warn: (...args: any[]) => void },
  onUnupdatable?: () => void
): Promise<{ messageId: string } | null> {
  const output = input.elements.find(element => element.element_id === 'final_output')?.content;
  const card = buildLarkCard(input);
  // 长结论在卡上拆成「开头 + 折叠」两段，按拼起来的全文判断整份结论是否都在卡上。
  const fits = !output || larkCardFinalOutputText(card.body.elements as Array<Record<string, unknown>>) === output;
  if (!fits) return null;
  try {
    return await service.update({ ...input, messageId: target.messageId });
  } catch (error) {
    if (isLarkMessageUnupdatable(error)) onUnupdatable?.();
    log.warn({ error, messageId: target.messageId }, 'PATCH 更新卡片失败');
    return null;
  }
}
