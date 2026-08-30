/**
 * TRAE CLI (traex) rollout tailer.
 *
 * TRAE is a Codex fork and writes the SAME rollout dialect, one directory
 * level deeper:
 *   <TRAE_HOME>/cli/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl
 * (TRAE_HOME defaults to ~/.trae; Codex's is <CODEX_HOME>/sessions/…)
 *
 * Because the record dialect is shared, entry mapping is `mapCodexEntry`
 * verbatim rather than a copy — a divergence in one CLI's parser would
 * otherwise silently skip events in the other. The TRAE-specific dialects
 * that Codex lacks are added on top:
 *
 *   event_msg agent_message (phase 'final_answer' or phase-less)
 *     → text. TRAE kept a phase field Codex dropped, and later TRAE builds
 *       dropped it again; both are the visible final answer.
 *   event_msg item_completed with an AgentMessage item
 *     → text (0.201.4+ mirrors the assistant message there).
 *
 * `event_msg task_complete.last_agent_message` (handled by mapCodexEntry) is
 * still the durable end-of-turn marker; the extra dialects only recover a
 * final answer that TRAE recorded elsewhere.
 */
import type { NormalizedDriverEvent } from '@dockmux/shared';
import { traeSessionsRoot } from '../cli-paths.js';
import { JsonlTailer, type TranscriptEventSource } from './tail.js';
import { mapCodexEntry, resolveNewestRollout } from './codex.js';

/** Locate the newest TRAE rollout jsonl. Like Codex, TRAE rollout paths do
 *  not encode the cwd, so `cwd` is accepted for API symmetry only. */
export function resolveTraexRolloutPath(_cwd?: string): string | undefined {
  return resolveNewestRollout(traeSessionsRoot());
}

/** Text of a TRAE `agent_message` / AgentMessage payload. TRAE puts the text
 *  on `message` (string) in the event dialect and on `text` in the item
 *  dialect; both shapes appear across the 0.201.x line. */
function traexAgentText(payload: any): string {
  if (typeof payload?.message === 'string') return payload.message;
  if (typeof payload?.text === 'string') return payload.text;
  return '';
}

/**
 * Map one TRAE rollout entry. Delegates to the Codex mapper first (shared
 * dialect) and only handles the TRAE-only records itself.
 */
export function mapTraexEntry(entry: any): NormalizedDriverEvent[] | undefined {
  const shared = mapCodexEntry(entry);
  if (shared) return shared;
  if (!entry || typeof entry !== 'object' || entry.type !== 'event_msg') return undefined;
  const p = entry.payload;
  if (!p || typeof p !== 'object') return undefined;

  // Dialect A: event_msg agent_message. A `final_answer` phase marks the
  // visible reply; a phase-less record is the later build that dropped the
  // field. Any OTHER phase is mid-turn narration and must not be emitted.
  if (p.type === 'agent_message') {
    const phase = typeof p.phase === 'string' ? p.phase : undefined;
    if (phase !== undefined && phase !== 'final' && phase !== 'final_answer') return undefined;
    const text = traexAgentText(p);
    return text.length > 0 ? [{ type: 'text', data: { text } }] : undefined;
  }

  // Dialect B: event_msg item_completed wrapping an AgentMessage item.
  if (p.type === 'item_completed') {
    const item = p.item;
    if (!item || typeof item !== 'object') return undefined;
    if (item.type !== 'AgentMessage' && item.item_type !== 'AgentMessage') return undefined;
    const text = traexAgentText(item);
    return text.length > 0 ? [{ type: 'text', data: { text } }] : undefined;
  }

  return undefined;
}

export interface TraexTranscriptTailerOptions {
  cwd: string;
  /** Explicit rollout path. When given, directory scanning and file
   *  switching are disabled. */
  transcriptPath?: string;
  /** Poll interval in ms (default 300). */
  pollIntervalMs?: number;
}

export class TraexTranscriptTailer implements TranscriptEventSource {
  private readonly tailer: JsonlTailer;

  constructor(opts: TraexTranscriptTailerOptions) {
    const explicit = opts.transcriptPath;
    this.tailer = new JsonlTailer({
      resolvePath: explicit ? () => explicit : () => resolveTraexRolloutPath(opts.cwd),
      mapEntry: mapTraexEntry,
      pollIntervalMs: opts.pollIntervalMs,
      watchForSwitch: !explicit,
    });
  }

  start(): void { this.tailer.start(); }
  stop(): void { this.tailer.stop(); }
  onEvent(cb: (e: NormalizedDriverEvent) => void): void { this.tailer.onEvent(cb); }
}
