import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { ConfigRepository, TaskRepository } from '@dutydeck/shared';
import type { LarkInboxRecord } from './lark/task-inbox.js';
import type { LarkInteraction } from './lark/workflow-interactions.js';
import { existsSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_LOG_BACKUPS = 3;
export const DEFAULT_RESOURCE_TTL_MS = 24 * 60 * 60 * 1000;

/** Rotate an append-only log before a new autostart registration opens it. */
export function rotateLogFileSync(path: string, maxBytes = DEFAULT_LOG_MAX_BYTES, backups = DEFAULT_LOG_BACKUPS): boolean {
  if (!existsSync(path)) return false;
  let size: number;
  try { size = statSync(path).size; } catch { return false; }
  if (size <= maxBytes) return false;
  try { rmSync(`${path}.${backups}`, { force: true }); } catch { /* best effort; keep the active log */ }
  for (let index = backups - 1; index >= 1; index--) {
    const source = `${path}.${index}`;
    const target = `${path}.${index + 1}`;
    if (existsSync(source)) {
      try { renameSync(source, target); } catch { /* best effort; keep the active log */ }
    }
  }
  try { renameSync(path, `${path}.1`); return true; } catch { return false; }
}

const downloadingDirectories = new Set<string>();

/** Acquire before publishing a directory or starting any network read. */
export function holdLarkResourceDirectory(directory: string): () => void {
  const path = resolve(directory);
  downloadingDirectories.add(path);
  return () => { downloadingDirectories.delete(path); };
}

export interface ResourcePruneOptions {
  now?: number;
  ttlMs?: number;
  readProtectedDirectories(): Promise<ReadonlySet<string>>;
}

/** A partial protection snapshot must never authorize deletion. */
export async function pruneLarkResourceDirectories(root: string, options: ResourcePruneOptions): Promise<number> {
  const cutoff = (options.now ?? Date.now()) - (options.ttlMs ?? DEFAULT_RESOURCE_TTL_MS);
  let protectedDirectories: ReadonlySet<string>;
  let entries;
  try {
    protectedDirectories = await options.readProtectedDirectories();
    if (await realpath(root) !== resolve(root) || !(await lstat(root)).isDirectory()) return 0;
    entries = await readdir(root, { withFileTypes: true });
  } catch { return 0; }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const directory = resolve(root, entry.name);
    try {
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.mtimeMs >= cutoff || protectedDirectories.has(directory) || downloadingDirectories.has(directory)) continue;
      // rm does not follow a final symlink. Refuse changed/symlinked roots too.
      if (await realpath(root) !== resolve(root) || downloadingDirectories.has(directory)) continue;
      await rm(directory, { recursive: true, force: true });
      removed++;
    } catch { /* concurrent download or permission change; retry next sweep */ }
  }
  return removed;
}

/** Each database owns its bucket; legacy shared temporary roots are untouched. */
export function larkResourceRoot(databaseUrl: string): string {
  if (databaseUrl === ':memory:') return join(realpathSync(tmpdir()), 'dutydeck', 'lark-resources', randomUUID());
  const database = join(realpathSync(dirname(resolve(databaseUrl))), basename(databaseUrl));
  const namespace = createHash('sha256').update(database).digest('hex').slice(0, 20);
  return join(dirname(database), 'lark-resources', namespace);
}

/** Inbox records outlive accepted tasks; only pruneIgnored removes inbox rows. */
export async function readLarkResourceReferences(store: ConfigRepository, tasks: Pick<TaskRepository, 'get'>): Promise<Set<string>> {
  if (!store.list || !tasks.get) throw new Error('Attachment retention requires complete inbox and task reads');
  const rows = await store.list('lark.inbox.');
  const records = rows.map(row => JSON.parse(row.value) as LarkInboxRecord);
  const key = (appId: string, messageId: string) => `${appId}:${messageId}`;
  const held = new Set<string>();
  for (const record of records) {
    const task = record.taskId ? await tasks.get(record.taskId) : undefined;
    if (record.state === 'received' || record.state === 'unrouted'
      || (record.taskId && (!task || !['completed', 'failed', 'interrupted', 'cancelled'].includes(task.status)))) {
      held.add(key(record.appId, record.event.messageId));
    }
  }
  // Read interactions after task states so a deferred approval published before
  // task settlement cannot fall between an earlier interaction read and settlement.
  const interactions = (await store.list('lark.interaction.')).map(row => JSON.parse(row.value) as LarkInteraction);
  // Deferred confirmations can retain completed-task material and later seed a
  // new inbox. Keep the original while either the interaction or child is live.
  const workflowSources = new Map(interactions.map(interaction => [key(interaction.appId, interaction.id), interaction]));
  for (const interaction of interactions) if (interaction.kind !== 'result' && ['pending', 'resolving'].includes(interaction.state)) held.add(key(interaction.appId, interaction.event.messageId));
  let changed = true;
  while (changed) {
    const size = held.size;
    for (const record of records) {
      if (record.workflowRequestId && held.has(key(record.appId, record.event.messageId))) {
        const source = workflowSources.get(key(record.appId, record.workflowRequestId));
        if (source) held.add(key(source.appId, source.event.messageId));
      }
      if (record.mergedInto && held.has(key(record.appId, record.mergedInto))) held.add(key(record.appId, record.event.messageId));
    }
    changed = held.size !== size;
  }
  // Approval completion publishes its child inbox before closing the interaction.
  // If that handoff changed our inbox snapshot, retry on the next sweep.
  if (JSON.stringify(await store.list('lark.inbox.')) !== JSON.stringify(rows)) throw new Error('Attachment holders changed during collection');
  const directories = new Set<string>();
  for (const record of records) if (held.has(key(record.appId, record.event.messageId))) {
    if (record.resourceDirectories !== undefined && (!Array.isArray(record.resourceDirectories) || record.resourceDirectories.some(path => typeof path !== 'string'))) throw new Error('Invalid attachment references');
    for (const directory of record.resourceDirectories ?? []) directories.add(resolve(directory));
  }
  return directories;
}
