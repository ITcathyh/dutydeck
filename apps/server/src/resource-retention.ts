import { readdir, rm, stat } from 'node:fs/promises';
import { existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

export interface ResourcePruneOptions {
  now?: number;
  ttlMs?: number;
}

/** Remove only old message directories; active downloads remain untouched. */
export async function pruneLarkResourceDirectories(root: string, options: ResourcePruneOptions = {}): Promise<number> {
  const now = options.now ?? Date.now();
  const cutoff = now - (options.ttlMs ?? DEFAULT_RESOURCE_TTL_MS);
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { return 0; }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const directory = join(root, entry.name);
    try {
      const metadata = await stat(directory);
      if (metadata.mtimeMs >= cutoff) continue;
      await rm(directory, { recursive: true, force: true });
      removed++;
    } catch { /* concurrent download or permission change; retry next sweep */ }
  }
  return removed;
}

export function larkResourceRoot(tmpRoot: string): string {
  return join(tmpRoot, 'dutydeck', 'lark-resources');
}

