import { createHash, randomUUID } from 'node:crypto';
import { constants, realpathSync, statSync } from 'node:fs';
import { link, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { extractEventArtifactReferences, RuntimeError, type ArtifactSnapshot, type ArtifactSnapshotReference, type RepositoryBundle } from '@dutydeck/shared';
import { protectedPathFinding } from '@dutydeck/shared/secret-guard';
import { secretDirectoryForDatabase } from '@dutydeck/secret-provider';
import { readBoundedBytes } from './bounded-file.js';

export const artifactSnapshotPrefix = 'artifact.snapshot.';
export const artifactSnapshotLimit = 20 * 1024 * 1024;
export const artifactPreviewLimit = 16 * 1024;
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(1).max(1024);
export const artifactSnapshotReferenceSchema = z.object({ taskId: identity, attemptId: identity, eventId: identity, sequence: z.number().int().nonnegative().safe(), partIndex: z.number().int().nonnegative().safe(), revision: identity }).strict();
const snapshotSchema = artifactSnapshotReferenceSchema.extend({ version: z.literal(1), id: hex, sessionId: identity, size: z.number().int().min(0).max(artifactSnapshotLimit), sha256: hex, capturedAt: z.string().datetime(), mimeType: z.enum(['text/plain', 'application/octet-stream']), name: z.string().min(1).max(180).refine(value => !/[\x00-\x1f\x7f/\\]/.test(value)) }).strict();
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const refParts = (ref: ArtifactSnapshotReference) => [ref.taskId, ref.attemptId, ref.eventId, ref.sequence, ref.partIndex, ref.revision];
const snapshotId = (sessionId: string, ref: ArtifactSnapshotReference, sha256: string) => hash(JSON.stringify([sessionId, ...refParts(ref), sha256]));
function fail(code: string, message: string, status = 400): never { throw new RuntimeError(code, message, status); }
const within = (root: string, path: string) => { const part = relative(root, path); return part !== '..' && !part.startsWith('../') && !isAbsolute(part); };
const linux = () => { if (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) fail('ARTIFACT_PLATFORM_UNSUPPORTED', '当前平台无法安全校验文件描述符，只支持 Linux。', 503); };
const openFlags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
const descriptorPath = (file: FileHandle) => `/proc/self/fd/${file.fd}`;
const safeName = (name: string) => name.replace(/[\x00-\x1f\x7f/\\]/g, '_').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '_').slice(0, 180).replace(/[\uD800-\uDBFF]$/, '_') || 'artifact';
function textOf(data: Buffer): string | undefined {
  try { const text = new TextDecoder('utf-8', { fatal: true }).decode(data); return /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) ? undefined : text; } catch { return undefined; }
}

/** Descriptor-relative traversal rejects every symlink below the trusted root. */
async function openScoped(rootPath: string, target: string, source: boolean): Promise<FileHandle> {
  linux();
  const root = await realpath(rootPath).catch(() => fail('ARTIFACT_NOT_FOUND', '文件目录已不存在。', 404));
  if (!within(root, target) || target === root) fail('ARTIFACT_OUT_OF_SCOPE', '只能保存当前会话工作目录内的普通文件。', 403);
  const parts = relative(root, target).split('/');
  const handles: FileHandle[] = [];
  let file: FileHandle | undefined;
  try {
    handles.push(await open(root, openFlags | constants.O_DIRECTORY));
    if (await realpath(descriptorPath(handles[0]!)) !== root) fail('ARTIFACT_UNSAFE_PATH', '目录已变化，请重新读取来源。', 409);
    for (const part of parts.slice(0, -1)) handles.push(await open(`${descriptorPath(handles.at(-1)!)}/${part}`, openFlags | constants.O_DIRECTORY));
    file = await open(`${descriptorPath(handles.at(-1)!)}/${parts.at(-1)!}`, openFlags);
    const opened = await realpath(descriptorPath(file));
    // A renamed ancestor must still point at the selected path inside this root.
    if (opened !== target || !within(root, opened)) fail('ARTIFACT_UNSAFE_PATH', '文件路径已变化，请重新读取来源。', 409);
    const stat = await file.stat();
    if (!stat.isFile() || source && stat.nlink !== 1) fail('ARTIFACT_NOT_REGULAR', '只支持普通文件；符号链接、硬链接与特殊文件不允许保存。', 400);
    return file;
  } catch (error) {
    await file?.close();
    if (error instanceof RuntimeError) throw error;
    fail('ARTIFACT_UNSAFE_PATH', '无法安全读取文件：文件不存在、是链接或路径已变化。', 400);
  } finally { await Promise.all(handles.map(handle => handle.close())); }
}
async function stableBytes(file: FileHandle): Promise<Buffer> {
  const before = await file.stat({ bigint: true });
  if (!before.isFile()) fail('ARTIFACT_NOT_REGULAR', '只能读取普通文件。');
  if (before.size > BigInt(artifactSnapshotLimit)) fail('ARTIFACT_TOO_LARGE', '文件超过 20 MiB 快照上限。', 413);
  const data = await readBoundedBytes(file, artifactSnapshotLimit + 1);
  if (data.length > artifactSnapshotLimit) fail('ARTIFACT_TOO_LARGE', '文件超过 20 MiB 快照上限。', 413);
  const after = await file.stat({ bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(data.length) !== after.size) fail('ARTIFACT_CHANGED', '读取期间文件发生变化，请重试。', 409);
  return data;
}

export class ArtifactSnapshots {
  readonly directory: string;
  private readonly dataDirectory: string;
  private readonly privateDirectories: string[];
  private readonly databaseFiles: string[];
  private readonly dataIdentity: { dev: number; ino: number };
  constructor(private readonly repos: Pick<RepositoryBundle, 'sessions' | 'events' | 'execution' | 'config'>, private readonly database: string) {
    this.dataDirectory = realpathSync(dirname(resolve(database)));
    this.dataIdentity = statSync(this.dataDirectory);
    this.directory = join(this.dataDirectory, 'artifact-snapshots');
    this.privateDirectories = [this.directory, secretDirectoryForDatabase(join(this.dataDirectory, basename(database))), join(this.dataDirectory, 'plugins'), join(this.dataDirectory, 'insight-tmp')];
    this.databaseFiles = [resolve(database), ...(database === ':memory:' ? [] : [realpathSync(database)])].flatMap(path => [path, `${path}-wal`, `${path}-shm`]);
  }
  private async session(sessionId: string) {
    const session = await this.repos.sessions.get(sessionId);
    if (!session) fail('SESSION_NOT_FOUND', '会话不存在。', 404);
    return session;
  }
  private metadata(raw: string, expectedId?: string): ArtifactSnapshot {
    let value: ArtifactSnapshot;
    try { value = snapshotSchema.parse(JSON.parse(raw)); } catch { return fail('ARTIFACT_METADATA_INVALID', '快照清单损坏，不能查看或下载。', 409); }
    if (value.id !== (expectedId ?? value.id) || snapshotId(value.sessionId, value, value.sha256) !== value.id) fail('ARTIFACT_METADATA_INVALID', '快照清单与来源摘要不一致。', 409);
    return value;
  }
  async list(sessionId: string): Promise<ArtifactSnapshot[]> {
    await this.session(sessionId);
    const config = this.repos.config;
    const rows = config.listByJsonField ? await config.listByJsonField(artifactSnapshotPrefix, { field: 'sessionId', values: [sessionId] }) : await config.list?.(artifactSnapshotPrefix) ?? [];
    return rows.map(row => this.metadata(row.value, row.key.slice(artifactSnapshotPrefix.length))).filter(item => item.sessionId === sessionId).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  }
  async capture(sessionId: string, input: ArtifactSnapshotReference): Promise<ArtifactSnapshot> {
    linux();
    if (this.database === ':memory:' || !this.repos.config.compareAndSet) fail('ARTIFACT_STORAGE_UNAVAILABLE', '当前实例没有持久快照存储。', 503);
    const checked = artifactSnapshotReferenceSchema.safeParse(input);
    if (!checked.success) fail('ARTIFACT_REFERENCE_INVALID', '请提供完整的已记录产物引用。');
    const session = await this.session(sessionId);
    const event = (await this.repos.events.listWindow(sessionId, { ...(input.sequence === 0 ? { beforeSequence: 1, direction: 'backward' as const } : { afterSequence: input.sequence - 1, direction: 'forward' as const }), limit: 1 }))[0];
    if (!event || event.sessionId !== sessionId || event.id !== input.eventId || event.sequence !== input.sequence) fail('ARTIFACT_REFERENCE_NOT_FOUND', '来源事件不属于此会话或已不可用。', 404);
    const ref = extractEventArtifactReferences(event).find(item => refParts(item).every((value, index) => value === refParts(input)[index]));
    if (!ref || ref.source === 'attachment_receipt') fail('ARTIFACT_REFERENCE_STALE', '产物版本或任务归属已不匹配，请重新加载来源。', 409);
    const attempt = this.repos.execution.getTaskExecution(input.taskId)?.attempts.find(item => item.attemptId === input.attemptId && item.sessionId === sessionId);
    if (!attempt) fail('ARTIFACT_REFERENCE_NOT_FOUND', '任务尝试不属于此会话。', 404);
    if (!ref.uri || /^[a-z][a-z0-9+.-]*:/i.test(ref.uri) && !ref.uri.startsWith('file:')) fail('ARTIFACT_LOCAL_ONLY', '仅支持工作目录内已登记的本地文件；远程与私有结果请使用原交付入口。', 400);
    let path: string;
    const root = await realpath(session.cwd).catch(() => fail('ARTIFACT_NOT_FOUND', '会话工作目录不可用。', 404));
    try {
      if (ref.uri.startsWith('file:')) { const url = new URL(ref.uri); if (url.search || url.hash) throw new Error(); path = fileURLToPath(url); }
      else path = resolve(root, ref.uri);
    } catch { return fail('ARTIFACT_REFERENCE_INVALID', '本地文件引用无效。'); }
    path = resolve(path);
    const canonical = await realpath(path).catch(() => path);
    const directories = [...this.privateDirectories, ...await Promise.all(this.privateDirectories.map(directory => realpath(directory).catch(() => directory)))];
    if (protectedPathFinding(path, { cwd: root }) || [path, canonical].some(candidate => directories.some(directory => within(directory, candidate)) || this.databaseFiles.includes(candidate))) fail('ARTIFACT_PROTECTED', '凭据、会话记录及实例内部数据不能保存为产物。', 403);
    const source = await openScoped(root, path, true);
    let data: Buffer;
    try { data = await stableBytes(source); if (await realpath(descriptorPath(source)) !== path) fail('ARTIFACT_CHANGED', '读取期间文件路径发生变化，请重试。', 409); } finally { await source.close(); }
    const sha256 = hash(data);
    const id = snapshotId(sessionId, input, sha256);
    const storageKey = artifactSnapshotPrefix + id;
    const existing = await this.repos.config.get(storageKey);
    if (existing) { const snapshot = this.metadata(existing, id); await this.read(sessionId, id); return snapshot; }
    const parent = await open(this.dataDirectory, openFlags | constants.O_DIRECTORY).catch(() => fail('ARTIFACT_STORAGE_UNSAFE', '实例数据目录不可安全访问。', 409));
    let directory: FileHandle | undefined;
    try {
      const parentStat = await parent.stat();
      if (parentStat.dev !== this.dataIdentity.dev || parentStat.ino !== this.dataIdentity.ino || await realpath(descriptorPath(parent)) !== this.dataDirectory) fail('ARTIFACT_STORAGE_UNSAFE', '实例数据目录已变化。', 409);
      const scopedDirectory = `${descriptorPath(parent)}/artifact-snapshots`;
      await mkdir(scopedDirectory, { recursive: true, mode: 0o700 });
      directory = await open(scopedDirectory, openFlags | constants.O_DIRECTORY);
      if (await realpath(descriptorPath(directory)) !== this.directory) fail('ARTIFACT_STORAGE_UNSAFE', '快照目录已变化。', 409);
      await directory.chmod(0o700);
      const temporary = `${descriptorPath(directory)}/.tmp-${randomUUID()}`;
      const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
      try { await link(temporary, `${descriptorPath(directory)}/${id}.bin`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      finally { await unlink(temporary); }
      await directory.sync();
    } finally { await directory?.close(); await parent.close(); }
    const metadata: ArtifactSnapshot = { version: 1, id, sessionId, ...input, size: data.length, sha256, capturedAt: new Date().toISOString(), mimeType: textOf(data) === undefined ? 'application/octet-stream' : 'text/plain', name: safeName(ref.name || basename(path)) };
    if (!await this.repos.config.compareAndSet!(storageKey, undefined, JSON.stringify(metadata))) {
      const winner = await this.repos.config.get(storageKey);
      if (!winner) fail('ARTIFACT_STORAGE_CONFLICT', '快照记录已变化，请重试。', 409);
      await this.read(sessionId, id);
      return this.metadata(winner, id);
    }
    // Publication never trusts a pre-existing blob, including a crashed writer's orphan.
    await this.read(sessionId, id);
    return metadata;
  }
  async read(sessionId: string, id: string): Promise<{ snapshot: ArtifactSnapshot; data: Buffer }> {
    await this.session(sessionId);
    if (!hex.safeParse(id).success) fail('ARTIFACT_NOT_FOUND', '快照不存在。', 404);
    const raw = await this.repos.config.get(artifactSnapshotPrefix + id);
    if (!raw) fail('ARTIFACT_NOT_FOUND', '快照不存在。', 404);
    const snapshot = this.metadata(raw, id);
    if (snapshot.sessionId !== sessionId) fail('ARTIFACT_NOT_FOUND', '快照不属于此会话。', 404);
    const file = await openScoped(this.directory, join(this.directory, `${id}.bin`), false);
    let data: Buffer;
    try { data = await stableBytes(file); } finally { await file.close(); }
    if (data.length !== snapshot.size || hash(data) !== snapshot.sha256) fail('ARTIFACT_INTEGRITY_FAILED', '快照文件与保存的摘要不一致，下载已拒绝。', 409);
    return { snapshot, data };
  }
  async preview(sessionId: string, id: string) {
    const { snapshot, data } = await this.read(sessionId, id);
    const text = snapshot.mimeType === 'text/plain' ? textOf(data) : undefined;
    return { snapshot, ...(text === undefined ? {} : { text: text.slice(0, artifactPreviewLimit) }), truncated: text !== undefined && text.length > artifactPreviewLimit };
  }
}
