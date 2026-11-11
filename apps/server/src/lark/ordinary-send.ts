import { createHash } from 'node:crypto';
import type { ConfigRepository } from '@dutydeck/shared';
import type { LarkMessageResult } from './service.js';

export class OrdinarySendError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 409) { super(message); }
}

interface SendRecord {
  version: 1;
  scope: string;
  idempotencyKey: string;
  payloadDigest: string;
  providerUuid: string;
  firstAttemptAt?: number;
  status: 'pending' | 'sent' | 'unknown';
  receipt?: LarkMessageResult;
  updatedAt: number;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const unknown = () => new OrdinarySendError('GROUP_SEND_RESULT_UNKNOWN', '发送结果未知，已停止自动重发。请使用 message/messages 核实原消息。');

/** A started attempt is never retried, including after process exit or a lost response. */
export async function sendOrdinaryMessage(store: ConfigRepository, input: {
  scope: string; idempotencyKey: string; payload: unknown;
  beforeSend: () => Promise<void>; beforeReceipt: () => Promise<void>;
  send: (providerUuid: string) => Promise<LarkMessageResult>;
}): Promise<LarkMessageResult> {
  if (!store.compareAndSet) throw new OrdinarySendError('GROUP_SEND_STORAGE_UNAVAILABLE', '发送需要持久化 compare-and-set 存储。', 503);
  const key = `lark.send.${hash(JSON.stringify([input.scope, input.idempotencyKey]))}`;
  const payloadDigest = hash(JSON.stringify(input.payload));
  const read = async () => {
    const raw = await store.get(key);
    if (raw === undefined) return undefined;
    const record = JSON.parse(raw) as SendRecord;
    if (record.version !== 1 || record.scope !== input.scope || record.idempotencyKey !== input.idempotencyKey
      || !['pending', 'sent', 'unknown'].includes(record.status) || !record.providerUuid) throw new OrdinarySendError('GROUP_SEND_STORAGE_INVALID', '发送记录无效，已停止发送。', 503);
    if (record.payloadDigest !== payloadDigest) throw new OrdinarySendError('GROUP_SEND_CONTENT_CONFLICT', '同一 idempotencyKey 已绑定另一份内容或发送目标。');
    return { raw, record };
  };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let saved = await read();
    if (!saved) {
      const record: SendRecord = { version: 1, scope: input.scope, idempotencyKey: input.idempotencyKey, payloadDigest,
        providerUuid: input.idempotencyKey, status: 'pending', updatedAt: Date.now() };
      const raw = JSON.stringify(record);
      if (!await store.compareAndSet(key, undefined, raw)) continue;
      saved = { raw, record };
    }
    if (saved.record.status === 'sent' && saved.record.receipt?.messageId) {
      await input.beforeReceipt();
      return saved.record.receipt;
    }
    if (saved.record.status !== 'pending' || saved.record.firstAttemptAt !== undefined) throw unknown();
    await input.beforeSend();
    const started: SendRecord = { ...saved.record, firstAttemptAt: Date.now(), updatedAt: Date.now() };
    const startedRaw = JSON.stringify(started);
    // If this write throws after committing, do not call the platform: a retry must read the authoritative record.
    if (!await store.compareAndSet(key, saved.raw, startedRaw)) continue;
    try {
      const receipt = await input.send(started.providerUuid);
      if (!receipt.messageId) throw unknown();
      const sent: SendRecord = { ...started, status: 'sent', receipt, updatedAt: Date.now() };
      if (await store.compareAndSet(key, startedRaw, JSON.stringify(sent))) return receipt;
    } catch {
      // A response or receipt write may have been lost after either side committed.
    }
    const current = await read().catch(() => { throw unknown(); });
    if (current?.record.status === 'sent' && current.record.receipt?.messageId) {
      await input.beforeReceipt();
      return current.record.receipt;
    }
    if (current?.raw === startedRaw) {
      await store.compareAndSet(key, startedRaw, JSON.stringify({ ...started, status: 'unknown', updatedAt: Date.now() })).catch(() => false);
    }
    throw unknown();
  }
  throw new OrdinarySendError('GROUP_SEND_CONFLICT', '发送记录正在变化，请使用相同 idempotencyKey 重试。');
}
