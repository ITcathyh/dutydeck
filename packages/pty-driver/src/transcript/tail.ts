/**
 * Shared JSONL tail machinery for transcript event extraction.
 *
 * Polls a file (mtime/size, ~300ms), reads appended bytes, splits on line
 * boundaries (half lines stay buffered), JSON.parses each complete line
 * (malformed lines skipped), and hands parsed entries to a CLI-specific
 * mapper that emits NormalizedDriverEvents.
 *
 * Semantics:
 *  - Start at END for a file resolved at startup; if no transcript exists
 *    yet, read the first resolved file from 0 so the first answer is retained.
 *  - Rotation: when `watchForSwitch` is on, the path is re-resolved every
 *    tick; a newer file (session switch) becomes the tail target, again
 *    starting at its end.
 *  - Truncation: if the file shrinks under the cursor, reading restarts
 *    from byte 0 (defensive; Claude/Codex transcripts are append-only).
 *  - Transient fs errors never kill the poll loop.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { NormalizedDriverEvent } from '@dutydeck/shared';

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
  flush(): Promise<void>;
  checkpoint(): TranscriptCursor;
  restore(cursor: TranscriptCursor): void;
  onEvent(cb: (e: NormalizedDriverEvent) => void): void;
  /** Background sub-agents the CLI reported still running when its latest
   *  turn ended. Only sources whose transcript records it (Claude) implement this. */
  pendingBackgroundWork?(): number;
  /** Forget that report at a new prompt; the new turn's own end record decides. */
  resetBackgroundWork?(): void;
  /** Why the turn ends without an answer, when the CLI recorded it (Claude's
   *  API-error lines). Held back until the turn ends because later model output
   *  supersedes it. Taking it starts a clean slate for the next turn. */
  takeTurnError?(): NormalizedDriverEvent | undefined;
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
const READ_CHUNK_BYTES = 64 * 1024;
const TURN_BYTE_BUDGET = 256 * 1024;
// Parsing one JSON record is indivisible. Fail visibly and retain the last
// complete cursor rather than silently discard records or grow without bound.
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const yieldLoop = () => new Promise<void>(resolve => setImmediate(resolve));

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
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private generation = 0;
  private work: Promise<void> = Promise.resolve();
  private polling = false;
  private failure: Error | undefined;
  private pendingStartOffset = 0;
  /** End of the last complete line. This is the only safe resume point. */
  private completedOffset = 0;
  private restoreCursor: TranscriptCursor | undefined;
  /** True while no path can be resolved or the resolved path does not exist yet. When the file is first
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
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  /** Snapshot the file waterline now; later appends belong to a later drain. */
  async flush(): Promise<void> {
    const generation = this.generation;
    const path = this.currentPath && !this.watchForSwitch ? this.currentPath : this.resolvePath();
    const size = path ? this.fileSize(path) : undefined;
    const work = this.work.then(async () => {
      if (generation !== this.generation) return;
      if (this.failure) throw this.failure;
      await this.tick(path, size, generation);
    });
    this.work = work.catch(() => {});
    return work;
  }

  private poll(): void {
    if (this.polling || this.failure) return;
    this.polling = true;
    const generation = this.generation;
    void this.flush().catch(() => {}).finally(() => {
      if (generation === this.generation) this.polling = false;
    });
  }

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
    this.pending = []; this.pendingBytes = 0;
    this.pendingStartOffset = 0;
    this.completedOffset = 0;
    this.pendingBirth = false;
    this.restoreCursor = { ...cursor };
  }

  stop(): void {
    this.generation++;
    this.polling = false;
    this.failure = undefined;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.currentPath = undefined;
    this.offset = 0;
    this.pending = []; this.pendingBytes = 0;
    this.pendingStartOffset = 0;
    this.completedOffset = 0;
    this.pendingBirth = false;
    this.restoreCursor = undefined;
  }

  private async tick(resolvedPath: string | undefined, waterline: number | undefined, generation: number): Promise<void> {
    try {
      if (!this.currentPath) {
        const path = resolvedPath;
        if (!path) {
          if (this.restoreCursor?.path) {
            throw new TranscriptRestoreError(`Transcript restore rejected: resolver did not return ${this.restoreCursor.path}`);
          }
          this.pendingBirth = true;
          return;
        }
        if (this.restoreCursor?.path && path !== this.restoreCursor.path) {
          throw new TranscriptRestoreError(`Transcript restore rejected: cursor path ${this.restoreCursor.path} differs from resolved path ${path}`);
        }
        const size = waterline;
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
          this.pending = []; this.pendingBytes = 0;
          this.pendingBirth = false;
          this.restoreCursor = undefined;
          // A recovered tailer must replay bytes appended while it was down
          // on its first tick, rather than wait for the next poll.
          await this.drain(size, generation);
          return;
        }
        // Start at END for an existing transcript (never replay history);
        // start at 0 for a file we watched being born.
        this.offset = this.pendingBirth ? 0 : size;
        if (this.pendingBirth) {
          this.completedOffset = 0;
          this.pendingStartOffset = 0;
          this.pending = []; this.pendingBytes = 0;
        } else {
          // EOF is not necessarily a JSONL boundary: a CLI can be in the
          // middle of writing a multibyte character or its trailing newline.
          // Retain only that unfinished suffix. History before its last
          // newline remains intentionally unobserved, while a later restore
          // resumes at a real complete-line boundary.
          const partial = await this.trailingPartial(path, size, generation);
          if (generation !== this.generation) return;
          this.completedOffset = partial.offset;
          this.pendingStartOffset = partial.offset;
          this.pending = partial.bytes;
          this.pendingBytes = size - partial.offset;
        }
        const newlyCreated = this.pendingBirth;
        this.pendingBirth = false;
        if (newlyCreated) await this.drain(size, generation);
        return;
      }
      if (this.watchForSwitch) {
        const path = resolvedPath;
        if (path && path !== this.currentPath) {
          this.currentPath = path;
          this.offset = waterline ?? 0;
          const partial = waterline === undefined ? { offset: 0, bytes: [] } : await this.trailingPartial(path, waterline, generation);
          if (generation !== this.generation) return;
          this.completedOffset = this.pendingStartOffset = partial.offset;
          this.pending = partial.bytes;
          this.pendingBytes = this.offset - partial.offset;
          return;
        }
      }
      await this.drain(waterline, generation);
    } catch (err) {
      if (err instanceof TranscriptRestoreError) this.failure = err;
      // Poll catches transient failures; an explicit final drain must fail so
      // the driver cannot report completion before its records are delivered.
      throw err;
    }
  }

  private async drain(size: number | undefined, generation: number): Promise<void> {
    const path = this.currentPath;
    if (!path) return;
    if (size === undefined) {
      throw new Error('Transcript file became unavailable before its drain completed');
    }
    if (size < this.offset) {
      this.offset = this.completedOffset = this.pendingStartOffset = 0;
      this.pending = []; this.pendingBytes = 0;
    }
    if (size === this.offset) return;
    const fd = openSync(path, 'r');
    let budget = 0;
    let started = performance.now();
    try {
      while (this.offset < size && generation === this.generation) {
        const buf = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, size - this.offset));
        const bytesRead = readSync(fd, buf, 0, buf.length, this.offset);
        if (!bytesRead) throw new Error('Transcript file was truncated during its drain');
        let start = 0;
        while (start < bytesRead) {
          const newline = buf.indexOf(0x0a, start);
          const end = newline >= 0 && newline < bytesRead ? newline : bytesRead;
          this.appendSegment(buf.subarray(start, end));
          this.offset += end - start;
          if (end < bytesRead) {
            const lineOffset = this.pendingStartOffset;
            const raw = Buffer.concat(this.pending, this.pendingBytes).toString('utf8');
            this.offset++;
            this.pending = []; this.pendingBytes = 0;
            this.completedOffset = this.pendingStartOffset = this.offset;
            this.handleLine(raw, lineOffset);
          }
          start = end + 1;
        }
        budget += bytesRead;
        if (budget >= TURN_BYTE_BUDGET || performance.now() - started >= 8) {
          await yieldLoop();
          budget = 0; started = performance.now();
        }
      }
    } finally { closeSync(fd); }
  }

  private appendSegment(bytes: Buffer): void {
    if (this.pendingBytes + bytes.length > MAX_RECORD_BYTES) {
      this.failRecord();
    }
    if (bytes.length) this.pending.push(bytes);
    this.pendingBytes += bytes.length;
  }

  private failRecord(): never {
    this.failure = new Error(`Transcript record exceeds ${MAX_RECORD_BYTES} bytes at offset ${this.pendingStartOffset}`);
    for (const cb of this.callbacks) cb({ type: 'error', data: {
      code: 'transcript_record_too_large', message: this.failure.message, retryable: false,
    } });
    throw this.failure;
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
  private async trailingPartial(path: string, size: number, generation: number): Promise<{ offset: number; bytes: Buffer[] }> {
    const fd = openSync(path, 'r');
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      let end = size;
      let budget = 0;
      while (end > 0 && generation === this.generation) {
        const start = Math.max(0, end - READ_CHUNK_BYTES);
        const block = Buffer.alloc(end - start);
        const bytesRead = readSync(fd, block, 0, block.length, start);
        const newline = block.subarray(0, bytesRead).lastIndexOf(0x0a);
        const suffix = block.subarray(newline + 1, bytesRead);
        total += suffix.length;
        if (total > MAX_RECORD_BYTES) {
          this.pendingStartOffset = Math.max(0, size - total);
          this.failRecord();
        }
        chunks.push(suffix);
        if (newline >= 0) return { offset: start + newline + 1, bytes: chunks.reverse() };
        end = start;
        budget += bytesRead;
        if (budget >= TURN_BYTE_BUDGET) { await yieldLoop(); budget = 0; }
      }
      return { offset: 0, bytes: chunks.reverse() };
    } finally { closeSync(fd); }
  }
}

/** Errors that would otherwise turn a recovery into a silent wrong replay. */
class TranscriptRestoreError extends Error {}
