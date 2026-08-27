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
import type { NormalizedDriverEvent } from '@dockmux/shared';

/** A live source of normalized driver events, backed by a CLI transcript. */
export interface TranscriptEventSource {
  start(): void;
  stop(): void;
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
  private pending = '';
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

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.currentPath = undefined;
    this.offset = 0;
    this.pending = '';
    this.pendingBirth = false;
  }

  private tick(): void {
    try {
      if (!this.currentPath) {
        const path = this.resolvePath();
        if (!path) return;
        const size = this.fileSize(path);
        if (size === undefined) {
          // File not created yet — keep resolving; read from 0 once it appears.
          this.pendingBirth = true;
          return;
        }
        this.currentPath = path;
        // Start at END for an existing transcript (never replay history);
        // start at 0 for a file we watched being born.
        this.offset = this.pendingBirth ? 0 : size;
        this.pendingBirth = false;
        this.pending = '';
        return;
      }
      if (this.watchForSwitch) {
        const path = this.resolvePath();
        if (path && path !== this.currentPath) {
          this.currentPath = path;
          this.offset = this.fileSize(path) ?? 0;
          this.pending = '';
          return;
        }
      }
      this.drain();
    } catch {
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
      this.pending = '';
      return;
    }
    if (size < this.offset) {
      // Truncated/rotated underneath us — re-read from the top.
      this.offset = 0;
      this.pending = '';
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
    this.offset += bytesRead;
    this.pending += buf.subarray(0, bytesRead).toString('utf8');

    let nl: number;
    while ((nl = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, nl);
      this.pending = this.pending.slice(nl + 1);
      this.handleLine(line);
    }
  }

  private handleLine(rawLine: string): void {
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
    for (const ev of events) {
      for (const cb of this.callbacks) cb(ev);
    }
  }

  private fileSize(path: string): number | undefined {
    try {
      return statSync(path).size;
    } catch {
      return undefined;
    }
  }
}
