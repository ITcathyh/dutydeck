/**
 * Bounded filesystem helpers shared by the session-id resolvers.
 *
 * Every helper is best-effort: a missing/unreadable/hostile path yields an
 * empty result rather than an exception. Resume must never fail because a
 * CLI's data directory looks unexpected — the driver degrades to treating
 * the dutydeck session id as the CLI session id.
 */
import { closeSync, existsSync, openSync, opendirSync, readSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

/** Read at most `maxBytes` from the START of a file. Session metadata and the
 *  first user prompt both live near the head, so a head window keeps the scan
 *  O(window) on multi-MB rollout files. */
export function readHead(path: string, maxBytes: number): string {
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) return '';
    size = st.size;
  } catch {
    return '';
  }
  const len = Math.min(size, Math.max(0, maxBytes));
  if (len === 0) return '';
  const buf = Buffer.alloc(len);
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const read = readSync(fd, buf, 0, len, 0);
    return buf.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** Read at most `maxBytes` from the END of a file, dropping the (almost
 *  certainly partial) first line when the window did not start at byte 0.
 *  Append-only index files (history.jsonl) put recent sessions at the end. */
export function readTail(path: string, maxBytes: number): string {
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) return '';
    size = st.size;
  } catch {
    return '';
  }
  const start = Math.max(0, size - Math.max(1, maxBytes));
  const len = size - start;
  if (len <= 0) return '';
  const buf = Buffer.alloc(len);
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const read = readSync(fd, buf, 0, len, start);
    let text = buf.subarray(0, read).toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

export interface ScannedFile {
  path: string;
  mtimeMs: number;
}

export interface WalkOptions {
  /** Max directory depth below the root (root itself is depth 0). */
  maxDepth: number;
  /** Stop after visiting this many directory entries (hostile-tree guard). */
  maxEntries?: number;
  /** Accept a file by its basename. */
  accept: (name: string) => boolean;
}

const DEFAULT_MAX_ENTRIES = 20_000;

/**
 * Iterative, depth-limited walk collecting files whose basename is accepted.
 * Symlinked directories are not followed (Dirent.isDirectory() is false for a
 * symlink), so a link loop cannot hang the scan.
 */
export function walkFiles(root: string, opts: WalkOptions): ScannedFile[] {
  if (!existsSync(root)) return [];
  try {
    if (!statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const out: ScannedFile[] = [];
  let visited = 0;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let directory: ReturnType<typeof opendirSync>;
    try {
      directory = opendirSync(dir);
    } catch {
      continue;
    }
    try {
      let entry: Dirent | null;
      while ((entry = directory.readSync()) !== null) {
        if (++visited > maxEntries) return out;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < opts.maxDepth) stack.push({ dir: full, depth: depth + 1 });
        } else if (entry.isFile() && opts.accept(entry.name)) {
          try {
            const st = statSync(full);
            if (st.isFile()) out.push({ path: full, mtimeMs: st.mtimeMs });
          } catch {
            // Vanished between readdir and stat — ignore.
          }
        }
      }
    } finally {
      try { directory.closeSync(); } catch { /* already closed */ }
    }
  }
  return out;
}

/** Newest first. */
export function byMtimeDesc(a: ScannedFile, b: ScannedFile): number {
  return b.mtimeMs - a.mtimeMs;
}

/** Parse a JSONL blob, yielding successfully parsed objects in file order.
 *  Malformed lines (including a truncated tail) are skipped. */
export function parseJsonlObjects(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch {
      // Partial or malformed line — skip.
    }
  }
  return out;
}
