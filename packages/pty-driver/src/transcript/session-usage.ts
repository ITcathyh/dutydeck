import { constants, createReadStream } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { realCwd } from '../cli-paths.js';
import { codexRateLimits, contextUsage, type NativeTokenUsage, type SessionUsageSnapshot } from '@dutydeck/shared';

export interface NativeUsageSource { client: 'codex' | 'claude'; path: string; dataRoot: string; nativeSessionId: string; cwd: string }
interface Cursor { inode: number; device: number; mtime: number; offset: number; pending: Buffer; skippingLine: boolean; bound: boolean; invalid: boolean; partial: boolean; snapshot: SessionUsageSnapshot; messages: Map<string, NativeTokenUsage> }
const cursors = new Map<string, Cursor>();
const pendingReads = new Map<string, Promise<SessionUsageSnapshot | undefined>>();
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const copy = (snapshot: SessionUsageSnapshot): SessionUsageSnapshot => structuredClone(snapshot);

function tokens(raw: any, client: NativeUsageSource['client'], observedAt: string): NativeTokenUsage | undefined {
  if (!raw || !Number.isFinite(Date.parse(observedAt))) return;
  const input = count(raw.input_tokens);
  const cached = count(client === 'codex' ? raw.cached_input_tokens : raw.cache_read_input_tokens);
  if (client === 'codex' && input !== undefined && cached !== undefined && cached > input) return;
  const values = {
    inputTokens: input === undefined ? undefined : client === 'codex' ? input - (cached ?? 0) : input,
    outputTokens: count(raw.output_tokens), cacheReadTokens: cached,
    cacheWriteTokens: count(client === 'codex' ? raw.cache_write_input_tokens : raw.cache_creation_input_tokens)
  };
  const present = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
  const totalTokens = client === 'codex' ? count(raw.total_tokens)
    : Object.values(values).every(value => value !== undefined) ? count(Object.values(values).reduce<number>((sum, value) => sum + value!, 0)) : undefined;
  if (!Object.keys(present).length && totalTokens === undefined) return;
  return { source: client === 'codex' ? 'codex_transcript' : 'claude_transcript', scope: 'current_native_session', observedAt, ...present, ...(totalTokens !== undefined ? { totalTokens } : {}) };
}

/** Only a content-bound main stream, read incrementally. No account requests or ledger writes. */
export function readNativeTranscriptUsage(source: NativeUsageSource): Promise<SessionUsageSnapshot | undefined> {
  const key = JSON.stringify(source);
  const active = pendingReads.get(key);
  if (active) return active.then(result => result && copy(result));
  const read = readUsage(source, key).finally(() => pendingReads.delete(key));
  pendingReads.set(key, read);
  return read;
}

async function readUsage(source: NativeUsageSource, key: string): Promise<SessionUsageSnapshot | undefined> {
  const cwd = realCwd(source.cwd);
  const root = await realpath(source.dataRoot);
  const path = await realpath(source.path);
  if (!path.startsWith(root + sep)) return;
  const fd = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    if (!stat.isFile()) return;
    // Check the opened inode too: a path replacement must not redirect the read.
    const current = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { const actual = await current.stat(); if (actual.ino !== stat.ino || actual.dev !== stat.dev) return; }
    finally { await current.close(); }
    let cursor = cursors.get(key);
    if (!cursor || cursor.inode !== stat.ino || cursor.device !== stat.dev || stat.size < cursor.offset || stat.size === cursor.offset && stat.mtimeMs !== cursor.mtime) {
      cursor = { inode: stat.ino, device: stat.dev, mtime: stat.mtimeMs, offset: 0, pending: Buffer.alloc(0), skippingLine: false, bound: false, invalid: false, partial: false, snapshot: {}, messages: new Map() };
    }
    const accept = (line: Buffer) => {
      if (line.length > 1024 * 1024) { cursor!.partial = true; return; }
      let entry: any;
      try { entry = JSON.parse(line.toString('utf8')); } catch { if (source.client === 'claude' && line.length) cursor!.partial = true; return; }
      if (source.client === 'codex' && entry.type === 'session_meta') {
        if ((entry.payload?.id ?? entry.payload?.session_id) !== source.nativeSessionId || (typeof entry.payload?.cwd !== 'string' || realCwd(entry.payload.cwd) !== cwd)) cursor!.invalid = true;
        else cursor!.bound = true;
      }
      if (source.client === 'claude' && entry.isSidechain !== true) {
        if (entry.sessionId && entry.sessionId !== source.nativeSessionId || !cursor!.bound && entry.cwd && realCwd(entry.cwd) !== cwd) cursor!.invalid = true;
        if (entry.sessionId === source.nativeSessionId && typeof entry.cwd === 'string' && realCwd(entry.cwd) === cwd) cursor!.bound = true;
      }
      if (!cursor!.bound || cursor!.invalid) return;
      if (source.client === 'codex' && entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
        const context = contextUsage(entry.payload.info?.last_token_usage?.total_tokens, entry.payload.info?.model_context_window, entry.timestamp);
        const rateLimits = codexRateLimits(entry.payload.rate_limits, entry.timestamp);
        const total = tokens(entry.payload.info?.total_token_usage, 'codex', entry.timestamp);
        if (context) cursor!.snapshot.context = { ...context, source: 'codex_transcript' };
        if (rateLimits) cursor!.snapshot.rateLimits = { ...cursor!.snapshot.rateLimits, ...rateLimits };
        if (total) cursor!.snapshot.nativeTokens = total;
      }
      if (source.client === 'claude' && entry.type === 'assistant' && entry.isSidechain !== true && entry.isApiErrorMessage !== true && entry.message?.model !== '<synthetic>' && typeof entry.message?.id === 'string') {
        const total = tokens(entry.message.usage, 'claude', entry.timestamp);
        if (!total) return;
        // One API message is persisted for multiple content blocks/streaming snapshots.
        const previous = cursor!.messages.get(entry.message.id);
        if (previous && Date.parse(previous.observedAt) > Date.parse(total.observedAt)) return;
        cursor!.messages.set(entry.message.id, total);
        const input = [total.inputTokens, total.cacheReadTokens, total.cacheWriteTokens];
        const context = input.every(value => value !== undefined) ? contextUsage(input.reduce<number>((sum, value) => sum + value!, 0), undefined, entry.timestamp) : undefined;
        if (context && (!cursor!.snapshot.context || Date.parse(context.observedAt) >= Date.parse(cursor!.snapshot.context.observedAt))) cursor!.snapshot.context = { ...context, source: 'claude_transcript' };
      }
    };
    if (stat.size > cursor.offset) {
      if (stat.size - cursor.offset > 128 * 1024 * 1024) throw new Error('Transcript usage read limit exceeded');
      const stream = createReadStream(source.path, { fd: fd.fd, autoClose: false, start: cursor.offset, end: stat.size - 1 });
      for await (const chunk of stream) {
        const buffer = Buffer.concat([cursor.pending, chunk as Buffer]);
        let start = 0; let end: number;
        while ((end = buffer.indexOf(10, start)) >= 0) {
          if (!cursor.skippingLine) accept(buffer.subarray(start, end));
          cursor.skippingLine = false; start = end + 1;
        }
        cursor.pending = Buffer.from(buffer.subarray(start));
        if (cursor.pending.length > 1024 * 1024) { cursor.pending = Buffer.alloc(0); cursor.skippingLine = true; cursor.partial = true; }
      }
      cursor.offset = stat.size; cursor.mtime = stat.mtimeMs;
    }
    if (!cursor.bound || cursor.invalid) { cursors.delete(key); return; }
    if (cursor.messages.size) {
      const messages = [...cursor.messages.values()];
      const latest = messages.reduce((a, b) => Date.parse(a.observedAt) > Date.parse(b.observedAt) ? a : b);
      const total: NativeTokenUsage = { source: 'claude_transcript', scope: 'current_native_session', observedAt: latest.observedAt, ...(cursor.partial ? { partial: true } : {}) };
      for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'] as const) {
        // A missing field stays unknown, rather than turning into a complete zero.
        if (messages.every(message => message[field] !== undefined)) total[field] = count(messages.reduce((sum, message) => sum + message[field]!, 0));
      }
      cursor.snapshot.nativeTokens = total;
    }
    cursors.delete(key); cursors.set(key, cursor);
    if (cursors.size > 32) cursors.delete(cursors.keys().next().value!);
    return copy(cursor.snapshot);
  } finally { await fd.close(); }
}
