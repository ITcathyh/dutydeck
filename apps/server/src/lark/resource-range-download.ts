import type { FileHandle } from 'node:fs/promises';

// Range validation and positional-write approach adapted from botmux 1b6e05358 (MIT).
// Copyright (c) 2026 botmux contributors. Full license: THIRD_PARTY_NOTICES.md.
export const larkResourceFileLimitBytes = 512 * 1024 * 1024;
export const larkResourceRangeBytes = 32_000_000;

export class ResourceRangeError extends Error {}
export class ResourceStreamError extends Error {}
export const resourceFileTooLarge = () => new ResourceRangeError('飞书附件超过 Dutydeck 单文件 512 MiB 本地下载上限。');

export function validateResourceRange(response: Response, start: number, end: number, total?: number): number {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
  const size = match ? Number(match[3]) : NaN;
  if (response.status !== 206 || !match || Number(match[1]) !== start || Number(match[2]) !== end
    || !Number.isSafeInteger(size) || size <= end || total !== undefined && size !== total) {
    throw new ResourceRangeError('飞书附件分片响应的状态或 Content-Range 无效。');
  }
  if (size > larkResourceFileLimitBytes) throw resourceFileTooLarge();
  return size;
}

/** Stream at a fixed offset. Only reader failures are transport errors; disk/protocol failures never retry. */
export async function writeResourceStream(response: Response, file: FileHandle, offset: number, signal: AbortSignal, expected?: number) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))
    || expected !== undefined && Number(length) !== expected)) throw new ResourceRangeError('飞书附件 Content-Length 无效。');
  if (length !== null && offset + Number(length) > larkResourceFileLimitBytes) throw resourceFileTooLarge();
  const reader = response.body?.getReader();
  let received = 0;
  const abort = () => { void reader?.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (reader) {
      signal.throwIfAborted();
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); }
      catch (error) { signal.throwIfAborted(); throw new ResourceStreamError(error instanceof Error ? error.message : String(error)); }
      signal.throwIfAborted();
      if (chunk.done) break;
      const buffer = chunk.value;
      if (expected !== undefined && received + buffer.length > expected) throw new ResourceRangeError('飞书附件分片正文超出请求区间。');
      if (offset + received + buffer.length > larkResourceFileLimitBytes) throw resourceFileTooLarge();
      let written = 0;
      while (written < buffer.length) {
        signal.throwIfAborted();
        const result = await file.write(buffer, written, buffer.length - written, offset + received + written);
        if (!result.bytesWritten) throw new Error('附件文件写入未取得进展。');
        written += result.bytesWritten;
      }
      received += buffer.length;
    }
    if (expected !== undefined && received !== expected || length !== null && received !== Number(length)) {
      throw new ResourceRangeError('飞书附件正文长度与响应声明不符。');
    }
    signal.throwIfAborted();
    return received;
  } finally {
    signal.removeEventListener('abort', abort);
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}

/** Error responses must not turn an arbitrarily large body into an in-memory JSON allocation. */
export async function readResourceError(response: Response, signal: AbortSignal): Promise<Record<string, any>> {
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 32 * 1024) return {};
      chunks.push(chunk.value);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return payload && typeof payload === 'object' ? payload : {};
  } catch { signal.throwIfAborted(); return {}; }
  finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
