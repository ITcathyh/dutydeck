/**
 * Transcript event extraction: tail CLI JSONL transcripts and emit
 * normalized driver events (thinking / tool_call / tool_result / text)
 * as the rich-data source for trace cards.
 */
import type { NormalizedDriverEvent } from '@dockmux/shared';
import type { TranscriptEventSource } from './tail.js';
import { ClaudeTranscriptTailer, type ClaudeTranscriptTailerOptions } from './claude.js';
import { CodexTranscriptTailer, type CodexTranscriptTailerOptions } from './codex.js';

export type { TranscriptEventSource } from './tail.js';
export { JsonlTailer, type JsonlTailerOptions, type TranscriptEntry } from './tail.js';
export {
  ClaudeTranscriptTailer,
  resolveClaudeTranscriptPath,
  mapClaudeEntry,
  type ClaudeTranscriptTailerOptions,
} from './claude.js';
export {
  CodexTranscriptTailer,
  resolveCodexRolloutPath,
  mapCodexEntry,
  type CodexTranscriptTailerOptions,
} from './codex.js';

export interface CreateTranscriptTailerOptions {
  cwd: string;
  /** Explicit transcript path (skips directory resolution + switching). */
  transcriptPath?: string;
  /** Poll interval in ms (default 300). */
  pollIntervalMs?: number;
}

/** Pick a transcript tailer by adapter id. CLIs without a native transcript
 *  (or not yet ported) return undefined — the caller falls back to
 *  screen-pattern detection only. */
export function createTranscriptTailer(
  adapterId: string,
  opts: CreateTranscriptTailerOptions,
): TranscriptEventSource | undefined {
  switch (adapterId) {
    case 'claude-code':
      return new ClaudeTranscriptTailer(opts as ClaudeTranscriptTailerOptions);
    case 'codex':
      return new CodexTranscriptTailer(opts as CodexTranscriptTailerOptions);
    default:
      return undefined;
  }
}

// Re-export the event type for convenience of consumers.
export type { NormalizedDriverEvent };
