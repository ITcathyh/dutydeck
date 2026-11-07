import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ConfigRepository } from '@dutydeck/shared';
import { protectedPathFinding } from '@dutydeck/shared/secret-guard';
import { secretDirectoryForDatabase } from '@dutydeck/secret-provider';
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

export interface ArtifactTurn { taskId: string; attemptId?: string }

interface Record { fingerprint: string; target: ArtifactTarget; image: boolean; providerUuid: string; providerKey?: string; messageId?: string; chatId?: string; leaseUntil?: number; state: 'uploading' | 'uploaded' | 'sending' | 'sent' }
const keyFor = (sessionId: string, key: string) => `lark.artifact_delivery.${sessionId}.${createHash('sha256').update(key).digest('hex')}`;
// 默认键只在同一轮任务尝试内去重：sent 记录长期保留，不带轮次时之后每一轮发同一文件都会被当成重放吞掉。
const stableKey = (sessionId: string, source: string, target: ArtifactTarget, image: boolean, turn?: ArtifactTurn) =>
  `artifact-${createHash('sha256').update(JSON.stringify({ sessionId, ...(turn ? { task: turn.taskId, attempt: turn.attemptId ?? '' } : {}), source, target, image })).digest('hex').slice(0, 40)}`;
const providerUuidFor = (sessionId: string, key: string) => `dutydeck-${createHash('sha256').update(`${sessionId}\0${key}`).digest('hex').slice(0, 40)}`;

const insideRoot = (root: string, path: string) => {
  const inner = relative(root, path);
  return inner !== '..' && !inner.startsWith('../') && !isAbsolute(inner);
};

export interface ArtifactScope {
  /** 给出时，系统临时目录下本会话独立的交付目录也可以发；其他会话写在临时目录里的文件不行。 */
  sessionId?: string;
  /** 实例数据目录、数据库与密钥文件等：其中的文件不发；会话工作目录本身在某一项下面（如默认 worktree）时那一项不算。 */
  privatePaths?: readonly string[];
}

export function instancePrivatePaths(databaseUrl: string): string[] {
  if (databaseUrl === ':memory:') return [];
  const database = resolve(databaseUrl); const dataDirectory = dirname(database);
  return [dataDirectory, secretDirectoryForDatabase(database), ...['artifact-snapshots', 'plugins', 'insight-tmp', 'lark-resources'].map(name => join(dataDirectory, name)),
    database, `${database}-wal`, `${database}-shm`];
}

export async function artifactScratchDirectory(sessionId: string) {
  if (!/^[\w-]{1,128}$/.test(sessionId)) return undefined;
  return realpath(tmpdir()).then(dir => join(dir, 'dutydeck-artifacts', sessionId), () => undefined);
}

export async function readArtifact(cwd: string, input: string, image: boolean, scope: ArtifactScope = {}) {
  const root = await realpath(cwd);
  // 范围一律按解析掉符号链接之后的真实路径判断；交付目录本身不解析，被换成符号链接时里面的文件落不进范围。
  const scratch = scope.sessionId ? await artifactScratchDirectory(scope.sessionId) : undefined;
  const roots = [root, scratch].filter((item): item is string => Boolean(item));
  const privatePaths = [...scope.privatePaths ?? [], ...await Promise.all((scope.privatePaths ?? []).map(item => realpath(item).catch(() => item)))];
  const assertAllowed = (path: string) => {
    const base = roots.find(item => insideRoot(item, path));
    if (!base) throw new AgentGroupToolError('ARTIFACT_PATH_OUT_OF_SCOPE', scratch ? `只能发送当前会话工作目录或本会话临时交付目录（${scratch}）内的文件。` : '只能发送当前会话工作目录内的文件。', 403);
    // 凭据规则按相对所在范围的路径匹配：默认 worktree 在 ~/.dutydeck/workspaces 下，绝对路径整条都会命中数据目录规则。
    if (protectedPathFinding(relative(base, path), { cwd: '/' }) || privatePaths.some(item => insideRoot(item, path) && !insideRoot(item, root)))
      throw new AgentGroupToolError('ARTIFACT_PROTECTED', '凭据、会话记录及实例内部数据不能发送。', 403);
  };
  const supplied = resolve(root, input);
  const canonical = await realpath(supplied).catch(() => { throw new AgentGroupToolError('ARTIFACT_NOT_FOUND', '要发送的文件不存在或无法解析。', 404); });
  assertAllowed(canonical);
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)).catch(() => { throw new AgentGroupToolError('ARTIFACT_OPEN_FAILED', '无法安全打开要发送的文件。', 400); });
  try {
    // O_NOFOLLOW protects only the final component. Anchor the already-opened
    // descriptor back to the workspace before reading, so a swapped parent
    // directory cannot redirect this fd outside the session cwd.
    if (process.platform !== 'linux') throw new AgentGroupToolError('ARTIFACT_OPEN_FAILED', '当前平台无法安全验证已打开文件的工作目录范围。', 400);
    const opened = await realpath(`/proc/self/fd/${handle.fd}`).catch(() => { throw new AgentGroupToolError('ARTIFACT_OPEN_FAILED', '无法安全验证已打开文件的工作目录范围。', 400); });
    assertAllowed(opened);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0) throw new AgentGroupToolError('ARTIFACT_NOT_REGULAR_FILE', '只能发送非空普通文件。', 400);
    // 硬链接能把范围外的凭据文件换个名字放进工作目录，路径规则看不出来。
    if (stat.nlink !== 1) throw new AgentGroupToolError('ARTIFACT_NOT_REGULAR_FILE', '只能发送普通文件；硬链接不允许发送。', 400);
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

export async function deliverArtifact(input: { configs: ConfigRepository; sessionId: string; cwd: string; client: ArtifactClient; path: string; target: ArtifactTarget; image: boolean; idempotencyKey?: string; turn?: ArtifactTurn; privatePaths?: readonly string[] }) {
  if (!input.configs.compareAndSet) throw new AgentGroupToolError('ARTIFACT_CAS_REQUIRED', '当前存储不支持交付幂等所需的 CAS。', 503);
  const artifact = await readArtifact(input.cwd, input.path, input.image, { sessionId: input.sessionId, privatePaths: input.privatePaths });
  const suppliedKey = input.idempotencyKey?.trim();
  if (suppliedKey && suppliedKey.length > 80) throw new AgentGroupToolError('INVALID_IDEMPOTENCY_KEY', 'idempotencyKey 不能超过 80 个字符。', 400);
  const idempotencyKey = suppliedKey || stableKey(input.sessionId, artifact.fingerprint, input.target, input.image, input.turn);
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
