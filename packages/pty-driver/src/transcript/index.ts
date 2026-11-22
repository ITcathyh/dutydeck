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
 * Deliberately not supported: cursor (records no tool results at all — the
 * JSONL would only add final text the screen stream already carries),
 * hermes/mtr (requires querying SQLite via python3, an
 * unacceptable runtime dependency here), gemini/kimi (no on-disk
 * transcript). Those keep the raw_terminal fallback.
 */
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import { getCliProfile, type CreateTranscriptTailerOptions } from '@dutydeck/cli-adapters';
import type { TranscriptEventSource } from './tail.js';
import { ClaudeTranscriptTailer } from './claude.js';
import { CodexTranscriptTailer } from './codex.js';
import { TraexTranscriptTailer } from './traex.js';
import { GrokTranscriptTailer } from './grok.js';

export type { TranscriptCursor, TranscriptEventSource, TranscriptPosition } from './tail.js';
export { JsonlTailer, type JsonlTailerOptions, type TranscriptEntry } from './tail.js';
export {
  ClaudeTranscriptTailer,
  resolveClaudeTranscriptPath,
  mapClaudeEntry,
  claudeApiError,
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

export type { CreateTranscriptTailerOptions } from '@dutydeck/cli-adapters';

/**
 * Adapter ids that have a structured transcript source.
 *
 * `seed` / `relay` are Claude Code forks and share its transcript dialect and
 * per-project JSONL layout verbatim (both are built by the same
 * `createClaudeFamilyAdapter` factory here, which follows the on-disk shape).
 * They differ only in WHERE that tree is rooted,
 * which is exactly what the `env` passthrough above resolves: whoever spawns
 * them must point `CLAUDE_CONFIG_DIR` at the fork's own data root through
 * `agent.env` — Seed's `<pkg>/.claude-runtime`, Relay's `~/.relay`. Without
 * that the tailer resolves `~/.claude`, which is Claude Code's tree, not
 * theirs. See the note in the driver on why the child's env is authoritative.
 */
export { TRANSCRIPT_ADAPTER_IDS } from './adapter-ids.js';

/** Pick a transcript tailer by adapter id. CLIs without a native transcript
 *  (or not yet ported) return undefined — the caller falls back to
 *  screen-pattern detection only. */
export function createTranscriptTailer(
  adapterId: string,
  opts: CreateTranscriptTailerOptions,
): TranscriptEventSource | undefined {
  return getCliProfile(adapterId)?.transcript?.(opts, transcriptReaders);
}

const transcriptReaders = {
  claude: ClaudeTranscriptTailer,
  codex: CodexTranscriptTailer,
  traex: TraexTranscriptTailer,
  grok: GrokTranscriptTailer,
};

export type { NormalizedDriverEvent };
