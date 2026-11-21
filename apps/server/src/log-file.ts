import { existsSync, renameSync, rmSync, statSync } from 'node:fs';

export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_LOG_BACKUPS = 3;

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
