import { constants } from 'node:fs';
import { readBoundedBytes } from '../bounded-file.js';
import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RuntimeError } from '@dutydeck/shared';
import type { PluginToolManual } from '@dutydeck/shared';
import { isPathInside } from '../skill-catalog.js';

/** One declared file per request, bounded by the host ceiling even for an invalid direct declaration. */
export async function readPluginManual(rootPath: string, manual: PluginToolManual) {
  const invalid = () => new RuntimeError('PLUGIN_TOOL_MANUAL_INVALID', 'Optional manual must be bounded UTF-8 text inside the active package', 400);
  const limit = Math.min(manual.maxBytes, 64 * 1024);
  if (!Number.isSafeInteger(limit) || limit < 1) throw invalid();
  const root = await realpath(rootPath);
  const path = await realpath(resolve(root, manual.path)).catch(() => { throw invalid(); });
  if (!isPathInside(path, root)) throw invalid();
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    const actual = await realpath(`/proc/self/fd/${file.fd}`).catch(() => realpath(path));
    const disk = await stat(path);
    if (!info.isFile() || info.size > limit || !isPathInside(actual, root) || info.ino !== disk.ino || info.dev !== disk.dev) throw invalid();
    const bytes = await readBoundedBytes(file, limit + 1);
    const bytesRead = bytes.length;
    if (bytesRead > limit || bytes.includes(0)) throw invalid();
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw invalid(); }
    return { text, bytes: bytesRead, digest: createHash('sha256').update(bytes).digest('hex') };
  } finally { await file.close(); }
}
