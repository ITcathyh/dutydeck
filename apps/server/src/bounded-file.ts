import type { FileHandle } from 'node:fs/promises';

/** A regular-file read can be short; continue up to the explicit byte allowance or EOF. */
export async function readBoundedBytes(file: Pick<FileHandle, 'read'>, maxBytes: number): Promise<Buffer> {
  const buffer = Buffer.alloc(maxBytes);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}
