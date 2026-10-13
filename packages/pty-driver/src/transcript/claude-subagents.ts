/**
 * Sub-agent transcripts of a Claude Code session.
 *
 * Claude Code 2.1.x does not write Task / Explore / workflow sub-agent records into the main transcript. They go to
 * <main transcript without .jsonl>/subagents/**\/agent-*.jsonl: one file per agent, nested agents flat beside their
 * parent, workflow runs one level down (subagents/workflows/<run>/agent-*.jsonl). Records keep the main file's shape
 * (`message.id`, `message.model`, `message.usage`, `isSidechain: true`) and a forked agent can repeat its parent's
 * records, so callers de-duplicate by message id.
 *
 * Files are read like the main transcript: from the remembered byte offset, complete lines only. Files that exist when
 * the reader starts are history (offset = their last line boundary); files that appear later are read from byte 0.
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const MAX_DEPTH = 4;
const MAX_FILES = 2_000;
/** Unread bytes taken from one file per read; a longer backlog is consumed in the next reads. */
const MAX_READ_BYTES = 32 * 1024 * 1024;
const BLOCK_BYTES = 64 * 1024;

export class ClaudeSubagentReader {
  private readonly offsets = new Map<string, number>();
  /** Set when history from before this reader cannot be told apart from the current turn's records. */
  private historyUnknown = false;

  constructor(private readonly mainPath: () => string | undefined) {}

  /** Treat every file already on disk as earlier turns' usage. `unknownHistory`: the turn in progress may already have
   *  written to them (the tailer was restored mid-turn), so the next read reports that it may be incomplete. */
  baseline(unknownHistory = false): void {
    const { files } = this.list();
    for (const file of files) {
      try { this.offsets.set(file, lineBoundary(file)); } catch { /* vanished: nothing to skip */ }
    }
    this.historyUnknown = unknownHistory && files.length > 0;
  }

  /**
   * Feed every record appended since the last read to `onEntry`, which returns false for a record it could not read.
   * Returns false when anything could not be read or understood: the usage seen so far is then not the full picture.
   */
  read(onEntry: (entry: any) => boolean): boolean {
    let complete = !this.historyUnknown;
    this.historyUnknown = false;
    const { files, ok } = this.list();
    if (!ok) complete = false;
    for (const file of files) {
      try {
        const offset = this.offsets.get(file) ?? 0;
        const size = statSync(file).size;
        if (size < offset) { this.offsets.set(file, size); complete = false; continue; }
        if (size === offset) continue;
        const chunk = readRange(file, offset, Math.min(size - offset, MAX_READ_BYTES));
        const end = chunk.lastIndexOf(0x0a);
        if (end < 0) {
          // An unfinished line is waited for, unless it is longer than anything we would read.
          if (chunk.length >= MAX_READ_BYTES) { this.offsets.set(file, offset + chunk.length); complete = false; }
          continue;
        }
        this.offsets.set(file, offset + end + 1);
        for (const line of chunk.subarray(0, end).toString('utf8').split('\n')) {
          if (!line.trim()) continue;
          let entry: unknown;
          try { entry = JSON.parse(line); } catch { complete = false; continue; }
          if (!entry || typeof entry !== 'object' || !onEntry(entry)) complete = false;
        }
      } catch {
        complete = false;
      }
    }
    return complete;
  }

  private list(): { files: string[]; ok: boolean } {
    const main = this.mainPath();
    const files: string[] = [];
    if (!main) return { files, ok: true };
    let ok = true;
    const walk = (dir: string, depth: number) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch (error) {
        // No sub-agents yet is the normal case; anything else means we cannot see them.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ok = false;
        return;
      }
      for (const entry of entries) {
        if (files.length >= MAX_FILES) { ok = false; return; }
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { if (depth < MAX_DEPTH) walk(path, depth + 1); }
        else if (entry.isFile() && entry.name.startsWith('agent-') && entry.name.endsWith('.jsonl')) files.push(path);
      }
    };
    walk(join(dirname(main), basename(main, '.jsonl'), 'subagents'), 0);
    return { files: files.sort(), ok };
  }
}

function readRange(path: string, start: number, length: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    return buf.subarray(0, readSync(fd, buf, 0, length, start));
  } finally { closeSync(fd); }
}

/** Offset just after the file's last newline (0 when it has none): the start of the line being written, if any. */
function lineBoundary(path: string): number {
  const size = statSync(path).size;
  for (let end = size; end > 0; end -= BLOCK_BYTES) {
    const start = Math.max(0, end - BLOCK_BYTES);
    const newline = readRange(path, start, end - start).lastIndexOf(0x0a);
    if (newline >= 0) return start + newline + 1;
  }
  return 0;
}
