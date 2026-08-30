/**
 * Transcript event extraction: tail CLI JSONL transcripts and emit
 * normalized driver events (thinking / tool_call / tool_result / text)
 * as the rich-data source for trace cards.
 *
 * Sources, and why these:
 *   claude-code — per-project JSONL, the richest source (thinking, tool
 *                 calls with inputs, tool results with pass/fail).
 *   codex       — rollout JSONL; reasoning summaries + typed tool calls.
 *   traex       — Codex's rollout dialect verbatim, plus two TRAE-only
 *                 final-answer records. Reuses mapCodexEntry, so the marginal
 *                 cost is a resolver and two extra branches.
 *   grok        — ACP `session/update` stream: the only non-Claude source
 *                 carrying thinking AND tool calls AND tool results with
 *                 stable ids, for zero native dependencies.
 *
 * Deliberately NOT ported: cursor (records no tool results at all — the
 * JSONL would only add final text the screen stream already carries),
 * hermes/mtr (botmux reaches their SQLite by shelling out to python3, an
 * unacceptable runtime dependency here), gemini/kimi (no on-disk
 * transcript). Those keep the raw_terminal fallback.
 */
import type { NormalizedDriverEvent } from '@dockmux/shared';
import type { TranscriptEventSource } from './tail.js';
import { ClaudeTranscriptTailer, type ClaudeTranscriptTailerOptions } from './claude.js';
import { CodexTranscriptTailer, type CodexTranscriptTailerOptions } from './codex.js';
import { TraexTranscriptTailer, type TraexTranscriptTailerOptions } from './traex.js';
import { GrokTranscriptTailer, type GrokTranscriptTailerOptions } from './grok.js';

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
  resolveNewestRollout,
  mapCodexEntry,
  type CodexTranscriptTailerOptions,
} from './codex.js';
export {
  TraexTranscriptTailer,
  resolveTraexRolloutPath,
  mapTraexEntry,
  type TraexTranscriptTailerOptions,
} from './traex.js';
export {
  GrokTranscriptTailer,
  resolveGrokUpdatesPath,
  mapGrokEntry,
  type GrokTranscriptTailerOptions,
} from './grok.js';

export interface CreateTranscriptTailerOptions {
  cwd: string;
  /** Explicit transcript path (skips directory resolution + switching). */
  transcriptPath?: string;
  /** Poll interval in ms (default 300). */
  pollIntervalMs?: number;
}

/** Adapter ids that have a structured transcript source. */
export const TRANSCRIPT_ADAPTER_IDS = ['claude-code', 'codex', 'traex', 'grok'] as const;

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
    case 'traex':
      return new TraexTranscriptTailer(opts as TraexTranscriptTailerOptions);
    case 'grok':
      return new GrokTranscriptTailer(opts as GrokTranscriptTailerOptions);
    default:
      return undefined;
  }
}

// Re-export the event type for convenience of consumers.
export type { NormalizedDriverEvent };
