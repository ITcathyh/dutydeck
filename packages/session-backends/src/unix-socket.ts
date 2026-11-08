import { readFileSync } from 'node:fs';

/**
 * Kernel view of a Unix socket path, independent of the file system entry:
 * a listening socket stays bound after its file is unlinked (for example by
 * /tmp cleanup), so a missing file alone does not prove there is no server.
 * - `bound`: /proc/net/unix lists a socket for this exact path;
 * - `unbound`: the table was read and parsed, and no entry has this path;
 * - `unknown`: not Linux, the table is unreadable, or its format is unexpected.
 */
export type UnixSocketState = 'bound' | 'unbound' | 'unknown';

const HEADER = 'Num RefCount Protocol Flags Type St Inode Path';
const ROW = /^[0-9a-f]+:\s+(?:[0-9a-f]+\s+){5}\d+(?:[ \t]+(.*))?$/i;

/** Classify `path` against the text of /proc/net/unix. */
export function parseUnixSocketState(table: string, path: string): UnixSocketState {
  const [header, ...lines] = table.split('\n');
  if (header?.trim().split(/\s+/).join(' ') !== HEADER) return 'unknown';
  for (const line of lines) {
    if (!line) continue;
    const match = ROW.exec(line);
    if (!match) return 'unknown';
    if (match[1] === path) return 'bound';
  }
  return 'unbound';
}

export function unixSocketState(path: string): UnixSocketState {
  if (process.platform !== 'linux') return 'unknown';
  let table: string;
  try { table = readFileSync('/proc/net/unix', 'utf8'); } catch { return 'unknown'; }
  return parseUnixSocketState(table, path);
}
