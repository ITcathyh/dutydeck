/**
 * Shared JSONL tail machinery for transcript event extraction.
 *
 * Polls a file (mtime/size, ~300ms), reads appended bytes, splits on line
 * boundaries (half lines stay buffered), JSON.parses each complete line
 * (malformed lines skipped), and hands parsed entries to a CLI-specific
 * mapper that emits NormalizedDriverEvents.
 *
 * Semantics:
 *  - Start at END: when a file is first picked up, reading begins at its
 *    current size — history is never replayed.
 *  - Rotation: when `watchForSwitch` is on, the path is re-resolved every
 *    tick; a newer file (session switch) becomes the tail target, again
 *    starting at its end.
 *  - Truncation: if the file shrinks under the cursor, reading restarts
 *    from byte 0 (defensive; Claude/Codex transcripts are append-only).
 *  - Transient fs errors never kill the poll loop.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { NormalizedDriverEvent } from '@dockmux/shared';

/** A durable position immediately after the last complete JSONL record.
 * Without a path there is no file identity, so the only valid offset is 0. */
export interface TranscriptCursor {
  path?: string;
  offset: number;
}

/** A live source of normalized driver events, backed by a CLI transcript. */
export interface TranscriptEventSource {
  start(): void;
  stop(): void;
  flush(): void;
  checkpoint(): TranscriptCursor;
  restore(cursor: TranscriptCursor): void;
  onEvent(cb: (e: NormalizedDriverEvent) => void): void;
}

/** Loose shape of a parsed JSONL entry — mappers narrow per CLI schema. */
export type TranscriptEntry = any;

export interface JsonlTailerOptions {
  /** Resolve the file to tail. Called on the first tick (until a file is
   *  found) and, when watchForSwitch is on, on every subsequent tick. */
  resolvePath: () => string | undefined;
  /** Map one parsed JSONL entry to zero or more normalized events. */
  mapEntry: (entry: TranscriptEntry) => NormalizedDriverEvent[] | undefined;
  /** Poll interval in ms. Default 300. */
  pollIntervalMs?: number;
  /** Re-resolve the path each tick and switch to a newer file. Default true. */
  watchForSwitch?: boolean;
}

const DEFAULT_POLL_MS = 300;

export class JsonlTailer implements TranscriptEventSource {
  private readonly resolvePath: () => string | undefined;
  private readonly mapEntry: (entry: TranscriptEntry) => NormalizedDriverEvent[] | undefined;
  private readonly pollIntervalMs: number;
  private readonly watchForSwitch: boolean;
  private readonly callbacks = new Set<(e: NormalizedDriverEvent) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentPath: string | undefined;
  private offset = 0;
  /** Bytes read after `pendingStartOffset` that do not yet end in a newline. */
  private pending = Buffer.alloc(0);
  private pendingStartOffset = 0;
  /** End of the last complete line. This is the only safe resume point. */
  private completedOffset = 0;
  private restoreCursor: TranscriptCursor | undefined;
  /** True while the resolved path does not exist yet. When the file is first
   *  created, reading starts at byte 0 — those bytes are the beginning of the
   *  session, not replayable history. Without this latch a file created
   *  between two ticks would be treated as "existing transcript" and its
   *  first (already-written) lines would be skipped. */
  private pendingBirth = false;

  constructor(opts: JsonlTailerOptions) {
    this.resolvePath = opts.resolvePath;
    this.mapEntry = opts.mapEntry;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.watchForSwitch = opts.watchForSwitch ?? true;
  }

  onEvent(cb: (e: NormalizedDriverEvent) => void): void {
    this.callbacks.add(cb);
  }

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.pollIntervalMs);
  }

  flush(): void { this.tick(); }

  checkpoint(): TranscriptCursor {
    return this.currentPath
      ? { path: this.currentPath, offset: this.completedOffset }
      : { offset: 0 };
  }

  restore(cursor: TranscriptCursor): void {
    if (this.timer) throw new Error('Transcript cursor can only be restored before start()');
    if (!cursor || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0
      || (cursor.path !== undefined && typeof cursor.path !== 'string')
      || (cursor.path === undefined && cursor.offset !== 0)) {
      throw new Error('Invalid transcript cursor');
    }
    if (cursor.path) {
      const path = this.resolvePath();
      if (path !== cursor.path) {
        throw new TranscriptRestoreError(`Transcript restore rejected: cursor path ${cursor.path} differs from resolved path ${path ?? 'undefined'}`);
      }
      const size = this.fileSize(path);
      if (size === undefined) {
        throw new TranscriptRestoreError(`Transcript restore rejected: cursor file is unavailable at ${path}`);
      }
      if (size < cursor.offset) {
        throw new TranscriptRestoreError(`Transcript restore rejected: ${path} is ${size} bytes, before cursor offset ${cursor.offset}`);
      }
    }
    this.currentPath = undefined;
    this.offset = 0;
    this.pending = Buffer.alloc(0);
    this.pendingStartOffset = 0;
    this.completedOffset = 0;
    this.pendingBirth = false;
    this.restoreCursor = { ...cursor };
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.currentPath = undefined;
    this.offset = 0;
    this.pending = Buffer.alloc(0);
    this.pendingStartOffset = 0;
    this.completedOffset = 0;
    this.pendingBirth = false;
    this.restoreCursor = undefined;
  }

  private tick(): void {
    try {
      if (!this.currentPath) {
        const path = this.resolvePath();
        if (!path) {
          if (this.restoreCursor?.path) {
            throw new TranscriptRestoreError(`Transcript restore rejected: resolver did not return ${this.restoreCursor.path}`);
          }
          return;
        }
        if (this.restoreCursor?.path && path !== this.restoreCursor.path) {
          throw new TranscriptRestoreError(`Transcript restore rejected: cursor path ${this.restoreCursor.path} differs from resolved path ${path}`);
        }
        const size = this.fileSize(path);
        if (size === undefined) {
          if (this.restoreCursor?.path) {
            throw new TranscriptRestoreError(`Transcript restore rejected: cursor file is unavailable at ${path}`);
          }
          // File not created yet — keep resolving; read from 0 once it appears.
          this.pendingBirth = true;
          return;
        }
        this.currentPath = path;
        if (this.restoreCursor) {
          const restoreOffset = this.restoreCursor.offset;
          if (size < restoreOffset) {
            throw new TranscriptRestoreError(`Transcript restore rejected: ${path} is ${size} bytes, before cursor offset ${restoreOffset}`);
          }
          this.offset = restoreOffset;
          this.completedOffset = restoreOffset;
          this.pendingStartOffset = restoreOffset;
          this.pending = Buffer.alloc(0);
          this.pendingBirth = false;
          this.restoreCursor = undefined;
          // A recovered tailer must replay bytes appended while it was down
          // on its first tick, rather than wait for the next poll.
          this.drain();
          return;
        }
        // Start at END for an existing transcript (never replay history);
        // start at 0 for a file we watched being born.
        this.offset = this.pendingBirth ? 0 : size;
        if (this.pendingBirth) {
          this.completedOffset = 0;
          this.pendingStartOffset = 0;
          this.pending = Buffer.alloc(0);
        } else {
          // EOF is not necessarily a JSONL boundary: a CLI can be in the
          // middle of writing a multibyte character or its trailing newline.
          // Retain only that unfinished suffix. History before its last
          // newline remains intentionally unobserved, while a later restore
          // resumes at a real complete-line boundary.
          const partial = this.trailingPartial(path, size);
          this.completedOffset = partial.offset;
          this.pendingStartOffset = partial.offset;
          this.pending = partial.bytes;
        }
        this.pendingBirth = false;
        return;
      }
      if (this.watchForSwitch) {
        const path = this.resolvePath();
        if (path && path !== this.currentPath) {
          this.currentPath = path;
          this.offset = this.fileSize(path) ?? 0;
          this.completedOffset = this.offset;
          this.pendingStartOffset = this.offset;
          this.pending = Buffer.alloc(0);
          return;
        }
      }
      this.drain();
    } catch (err) {
      if (err instanceof TranscriptRestoreError) throw err;
      // A transient fs error must never kill the poll loop.
    }
  }

  private drain(): void {
    const path = this.currentPath;
    if (!path) return;
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      // File vanished (rotation/cleanup) — drop it and re-resolve next tick.
      this.currentPath = undefined;
      this.offset = 0;
      this.pending = Buffer.alloc(0);
      this.pendingStartOffset = 0;
      this.completedOffset = 0;
      return;
    }
    if (size < this.offset) {
      // Truncated/rotated underneath us — re-read from the top.
      this.offset = 0;
      this.pending = Buffer.alloc(0);
      this.pendingStartOffset = 0;
      this.completedOffset = 0;
    }
    if (size === this.offset) return;

    const len = size - this.offset;
    const buf = Buffer.alloc(len);
    const fd = openSync(path, 'r');
    let bytesRead = 0;
    try {
      bytesRead = readSync(fd, buf, 0, len, this.offset);
    } finally {
      closeSync(fd);
    }
    const readStart = this.offset;
    this.offset += bytesRead;
    if (this.pending.length === 0) this.pendingStartOffset = readStart;
    this.pending = Buffer.concat([this.pending, buf.subarray(0, bytesRead)]);

    let nl: number;
    while ((nl = this.pending.indexOf(0x0a)) >= 0) {
      const lineBytes = this.pending.subarray(0, nl);
      const lineOffset = this.pendingStartOffset;
      this.pending = this.pending.subarray(nl + 1);
      this.pendingStartOffset += nl + 1;
      this.completedOffset = this.pendingStartOffset;
      this.handleLine(lineBytes.toString('utf8'), lineOffset);
    }
  }

  private handleLine(rawLine: string, lineOffset: number): void {
    const line = rawLine.trim();
    if (!line) return;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return; // Malformed line — skip silently.
    }
    if (!entry || typeof entry !== 'object') return;
    let events: NormalizedDriverEvent[] | undefined;
    try {
      events = this.mapEntry(entry as TranscriptEntry);
    } catch {
      return; // A mapper hiccup must not kill the loop.
    }
    if (!events) return;
    for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
      const ev = events[eventIndex]!;
      const sourceId = createHash('sha256')
        .update(this.currentPath ?? '')
        .update('\0')
        .update(String(lineOffset))
        .update('\0')
        .update(rawLine)
        .update('\0')
        .update(String(eventIndex))
        .digest('hex');
      for (const cb of this.callbacks) cb({ ...ev, sourceId } as NormalizedDriverEvent);
    }
  }

  private fileSize(path: string): number | undefined {
    try {
      return statSync(path).size;
    } catch {
      return undefined;
    }
  }

  /** Read bytes after the last newline without replaying complete history. */
  private trailingPartial(path: string, size: number): { offset: number; bytes: Buffer } {
    const blockSize = 64 * 1024;
    const fd = openSync(path, 'r');
    try {
      let end = size;
      while (end > 0) {
        const start = Math.max(0, end - blockSize);
        const block = Buffer.alloc(end - start);
        const bytesRead = readSync(fd, block, 0, block.length, start);
        const newline = block.subarray(0, bytesRead).lastIndexOf(0x0a);
        if (newline >= 0) {
          const offset = start + newline + 1;
          const bytes = Buffer.alloc(size - offset);
          readSync(fd, bytes, 0, bytes.length, offset);
          return { offset, bytes };
        }
        end = start;
      }
      const bytes = Buffer.alloc(size);
      readSync(fd, bytes, 0, bytes.length, 0);
      return { offset: 0, bytes };
    } finally {
      closeSync(fd);
    }
  }
}

/** Errors that would otherwise turn a recovery into a silent wrong replay. */
class TranscriptRestoreError extends Error {}
