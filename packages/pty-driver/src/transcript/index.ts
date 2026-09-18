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
import type { CliPathEnv } from '../cli-paths.js';
import type { TranscriptEventSource } from './tail.js';
import { ClaudeTranscriptTailer, type ClaudeTranscriptTailerOptions } from './claude.js';
import { CodexTranscriptTailer, type CodexTranscriptTailerOptions } from './codex.js';
import { TraexTranscriptTailer, type TraexTranscriptTailerOptions } from './traex.js';
import { GrokTranscriptTailer, type GrokTranscriptTailerOptions } from './grok.js';

export type { TranscriptCursor, TranscriptEventSource } from './tail.js';
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
  /**
   * dutydeck's session id, used to identify WHICH transcript in a shared
   * location belongs to this session.
   *
   * Several CLIs key their transcript location by cwd alone, so every dutydeck
   * session started in one repo writes into the same directory. Resolving by
   * recency there silently attaches a sibling's transcript: the timeline then
   * shows another session's answer, or the turn is failed as "no final output"
   * while the correct transcript sits on disk untouched. Sources that can be
   * session-scoped use this; the rest fall back to recency and are documented
   * as such at their resolver.
   */
  sessionId?: string;
  /** Poll interval in ms (default 300). */
  pollIntervalMs?: number;
  /**
   * The environment the CLI child process was actually spawned with
   * (`PtyCliDriver.spawnEnv()`), NOT the daemon's `process.env`.
   *
   * The data-dir variables live in the child: the driver strips `CLAUDE_*`
   * from it, and `agent.env` may point `CODEX_HOME` / `CLAUDE_CONFIG_DIR` /
   * `HOME` elsewhere for multi-account or sandbox isolation. Reading the
   * daemon's env instead makes the tailer watch a directory the CLI never
   * writes to — the turn then reports no output at all. Defaults to
   * `process.env` for callers with no child (tests, tooling).
   */
  env?: CliPathEnv;
}

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
export const TRANSCRIPT_ADAPTER_IDS = ['claude-code', 'seed', 'relay', 'codex', 'traex', 'grok'] as const;

/** Pick a transcript tailer by adapter id. CLIs without a native transcript
 *  (or not yet ported) return undefined — the caller falls back to
 *  screen-pattern detection only. */
export function createTranscriptTailer(
  adapterId: string,
  opts: CreateTranscriptTailerOptions,
): TranscriptEventSource | undefined {
  switch (adapterId) {
    // Claude Code and its two forks: identical JSONL dialect and project-dir
    // layout; the fork's data root arrives via opts.env (see above).
    case 'claude-code':
    case 'seed':
    case 'relay':
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
