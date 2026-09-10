import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import type { ConfigRepository } from '@dutydeck/shared';
import { AgentGroupToolError } from './agent-tools.js';

export const artifactFileLimit = 30 * 1024 * 1024;
export const artifactImageLimit = 10 * 1024 * 1024;

export interface ArtifactTarget { chatId: string; replyTo?: string; inThread?: boolean }
export interface ArtifactClient {
  uploadFile(input: { data: Uint8Array; filename: string; idempotencyKey: string }): Promise<string>;
  uploadImage(input: { data: Uint8Array; filename: string; idempotencyKey: string }): Promise<string>;
  sendFile(input: ArtifactTarget & { fileKey: string; idempotencyKey: string }): Promise<{ messageId: string; chatId?: string }>;
  sendImage(input: ArtifactTarget & { imageKey: string; idempotencyKey: string }): Promise<{ messageId: string; chatId?: string }>;
}

interface Record { fingerprint: string; target: ArtifactTarget; image: boolean; providerUuid: string; providerKey?: string; messageId?: string; chatId?: string; leaseUntil?: number; state: 'uploading' | 'uploaded' | 'sending' | 'sent' }
const keyFor = (sessionId: string, key: string) => `lark.artifact_delivery.${sessionId}.${createHash('sha256').update(key).digest('hex')}`;
const stableKey = (sessionId: string, source: string, target: ArtifactTarget, image: boolean) => `artifact-${createHash('sha256').update(JSON.stringify({ sessionId, source, target, image })).digest('hex').slice(0, 40)}`;
const providerUuidFor = (sessionId: string, key: string) => `dutydeck-${createHash('sha256').update(`${sessionId}\0${key}`).digest('hex').slice(0, 40)}`;

export async function readArtifact(cwd: string, input: string, image: boolean) {
  const root = await realpath(cwd);
  const supplied = resolve(root, input);
  const canonical = await realpath(supplied).catch(() => { throw new AgentGroupToolError('ARTIFACT_NOT_FOUND', '要发送的文件不存在或无法解析。', 404); });
  const canonicalRelative = relative(root, canonical);
  if (canonicalRelative === '..' || canonicalRelative.startsWith('../')) throw new AgentGroupToolError('ARTIFACT_PATH_OUT_OF_SCOPE', '只能发送当前会话工作目录内的文件。', 403);
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)).catch(() => { throw new AgentGroupToolError('ARTIFACT_OPEN_FAILED', '无法安全打开要发送的文件。', 400); });
  try {
    // O_NOFOLLOW protects only the final component. Anchor the already-opened
    // descriptor back to the workspace before reading, so a swapped parent
    // directory cannot redirect this fd outside the session cwd.
    if (process.platform !== 'linux') throw new AgentGroupToolError('ARTIFACT_OPEN_FAILED', '当前平台无法安全验证已打开文件的工作目录范围。', 400);
    const opened = await realpath(`/proc/self/fd/${handle.fd}`).catch(() => { throw new AgentGroupToolError('ARTIFACT_OPEN_FAILED', '无法安全验证已打开文件的工作目录范围。', 400); });
    const openedRelative = relative(root, opened);
    if (openedRelative === '..' || openedRelative.startsWith('../')) throw new AgentGroupToolError('ARTIFACT_PATH_OUT_OF_SCOPE', '只能发送当前会话工作目录内的文件。', 403);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0) throw new AgentGroupToolError('ARTIFACT_NOT_REGULAR_FILE', '只能发送非空普通文件。', 400);
    const limit = image ? artifactImageLimit : artifactFileLimit;
    if (stat.size > limit) throw new AgentGroupToolError('ARTIFACT_TOO_LARGE', `文件超过本轮 ${image ? '图片 10 MiB' : '文件 30 MiB'} 上限。`, 413);
    const buffer = new Uint8Array(limit + 1); let offset = 0;
    while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    if (offset > limit) throw new AgentGroupToolError('ARTIFACT_TOO_LARGE', `文件超过本轮 ${image ? '图片 10 MiB' : '文件 30 MiB'} 上限。`, 413);
    const data = buffer.slice(0, offset);
    if (!data.length) throw new AgentGroupToolError('ARTIFACT_NOT_REGULAR_FILE', '只能发送非空普通文件。', 400);
    return { data, filename: basename(canonical), fingerprint: createHash('sha256').update(data).digest('hex') };
  } finally { await handle.close(); }
}

export async function deliverArtifact(input: { configs: ConfigRepository; sessionId: string; cwd: string; client: ArtifactClient; path: string; target: ArtifactTarget; image: boolean; idempotencyKey?: string }) {
  if (!input.configs.compareAndSet) throw new AgentGroupToolError('ARTIFACT_CAS_REQUIRED', '当前存储不支持交付幂等所需的 CAS。', 503);
  const artifact = await readArtifact(input.cwd, input.path, input.image);
  const suppliedKey = input.idempotencyKey?.trim();
  if (suppliedKey && suppliedKey.length > 80) throw new AgentGroupToolError('INVALID_IDEMPOTENCY_KEY', 'idempotencyKey 不能超过 80 个字符。', 400);
  const idempotencyKey = suppliedKey || stableKey(input.sessionId, artifact.fingerprint, input.target, input.image);
  const storageKey = keyFor(input.sessionId, idempotencyKey);
  let expected = await input.configs.get(storageKey);
  let existing = expected ? JSON.parse(expected) as Record : undefined;
  const same = existing && existing.fingerprint === artifact.fingerprint && JSON.stringify(existing.target) === JSON.stringify(input.target) && existing.image === input.image;
  if (existing && !same) throw new AgentGroupToolError('ARTIFACT_IDEMPOTENCY_CONFLICT', '同一交付键不能用于不同文件或目标。', 409);
  if (existing?.state === 'sent') return { messageId: existing.messageId!, chatId: existing.chatId, idempotencyKey, replayed: true };
  const now = Date.now(); const leaseUntil = now + 60_000; const providerUuid = providerUuidFor(input.sessionId, idempotencyKey);
  let record = existing;
  if (!record) {
    record = { fingerprint: artifact.fingerprint, target: input.target, image: input.image, providerUuid, state: 'uploading', leaseUntil };
    if (!await input.configs.compareAndSet(storageKey, undefined, JSON.stringify(record))) throw new AgentGroupToolError('ARTIFACT_DELIVERY_IN_PROGRESS', '同一交付正在处理中，请稍后重试。', 409);
  } else if ((record.state === 'uploading' || record.state === 'sending')) {
    if ((record.leaseUntil ?? 0) > now) throw new AgentGroupToolError('ARTIFACT_DELIVERY_IN_PROGRESS', '同一交付正在处理中，请稍后重试。', 409);
    const reclaimed: Record = { ...record, state: record.state, leaseUntil };
    if (!await input.configs.compareAndSet(storageKey, expected, JSON.stringify(reclaimed))) throw new AgentGroupToolError('ARTIFACT_DELIVERY_IN_PROGRESS', '同一交付正在处理中，请稍后重试。', 409);
    record = reclaimed;
  }
  if (record.state === 'uploading') {
    const providerKey = input.image
      ? await input.client.uploadImage({ data: artifact.data, filename: artifact.filename, idempotencyKey: record.providerUuid })
      : await input.client.uploadFile({ data: artifact.data, filename: artifact.filename, idempotencyKey: record.providerUuid });
    const uploaded: Record = { ...record, providerKey, state: 'uploaded', leaseUntil: undefined };
    if (!await input.configs.compareAndSet(storageKey, JSON.stringify(record), JSON.stringify(uploaded))) throw new AgentGroupToolError('ARTIFACT_DELIVERY_IN_PROGRESS', '交付状态已变化，请重试。', 409);
    record = uploaded;
  }
  if (record.state === 'uploaded') {
    const sending: Record = { ...record, state: 'sending', leaseUntil };
    if (!await input.configs.compareAndSet(storageKey, JSON.stringify(record), JSON.stringify(sending))) throw new AgentGroupToolError('ARTIFACT_DELIVERY_IN_PROGRESS', '交付状态已变化，请重试。', 409);
    record = sending;
  }
  let result: { messageId: string; chatId?: string };
  try {
    result = input.image
      ? await input.client.sendImage({ ...input.target, imageKey: record.providerKey!, idempotencyKey: record.providerUuid })
      : await input.client.sendFile({ ...input.target, fileKey: record.providerKey!, idempotencyKey: record.providerUuid });
  } catch (error) {
    const uploaded: Record = { ...record, state: 'uploaded', leaseUntil: undefined };
    await input.configs.compareAndSet(storageKey, JSON.stringify(record), JSON.stringify(uploaded));
    throw error;
  }
  const sent: Record = { ...record, state: 'sent', leaseUntil: undefined, messageId: result.messageId, chatId: result.chatId };
  if (!await input.configs.compareAndSet(storageKey, JSON.stringify(record), JSON.stringify(sent))) throw new AgentGroupToolError('ARTIFACT_DELIVERY_IN_PROGRESS', '交付已提交，请重试查询结果。', 409);
  return { ...result, idempotencyKey, replayed: false };
}
