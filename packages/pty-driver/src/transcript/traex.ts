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
import { traeSessionsRoot, type CliPathEnv } from '../cli-paths.js';
import { resolveCliSessionId } from '../session-id/index.js';
import { JsonlTailer, type TranscriptEventSource } from './tail.js';
import { findRolloutBySessionId, mapCodexEntry, resolveNewestRollout } from './codex.js';

/**
 * Locate the TRAE rollout jsonl for a session.
 *
 * Same rule as Codex (identical rollout dialect, one level deeper root): with
 * `sessionId` the CLI's own id is recovered and the rollout addressed
 * directly, because the rollout root is global and an mtime pick can attach a
 * concurrent session's file — even one from another project. Without it the
 * newest rollout is returned, which is only unambiguous for a lone session.
 *
 * `env` must be the environment the CLI child received (see cli-paths.ts).
 */
export function resolveTraexRolloutPath(
  cwd?: string,
  env?: CliPathEnv,
  sessionId?: string,
): string | undefined {
  const root = traeSessionsRoot(env);
  if (sessionId && cwd) {
    const cliSessionId = resolveCliSessionId('traex', { sessionId, cwd, env });
    return cliSessionId ? findRolloutBySessionId(root, cliSessionId) : undefined;
  }
  return resolveNewestRollout(root);
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
  /** dockmux's session id. Required for correctness whenever more than one
   *  TRAE session may be running — the rollout root is global, so without it
   *  resolution falls back to "newest rollout anywhere". See
   *  resolveTraexRolloutPath. */
  sessionId?: string;
  /** Poll interval in ms (default 300). */
  pollIntervalMs?: number;
  /** The environment the CLI child was spawned with (defaults to process.env);
   *  `$TRAE_HOME` from `agent.env` only exists there. */
  env?: CliPathEnv;
}

export class TraexTranscriptTailer implements TranscriptEventSource {
  private readonly tailer: JsonlTailer;

  constructor(opts: TraexTranscriptTailerOptions) {
    const explicit = opts.transcriptPath;
    // Memoise the session-scoped resolution: JsonlTailer re-resolves every
    // ~300ms tick, and recovering the CLI's own session id means reading
    // history/rollout heads. The rollout path never changes once found, so
    // resolve until it succeeds and then hold the answer. See the Claude
    // tailer for the full reasoning.
    let resolved: string | undefined;
    const resolveOnce = () => (resolved ??= resolveTraexRolloutPath(opts.cwd, opts.env, opts.sessionId));
    this.tailer = new JsonlTailer({
      resolvePath: explicit
        ? () => explicit
        : opts.sessionId
          ? resolveOnce
          : () => resolveTraexRolloutPath(opts.cwd, opts.env),
      mapEntry: mapTraexEntry,
      pollIntervalMs: opts.pollIntervalMs,
      // See the Codex tailer — same dialect, same reasoning.
      watchForSwitch: !explicit,
    });
  }

  start(): void { this.tailer.start(); }
  flush(): void { this.tailer.flush(); }
  stop(): void { this.tailer.stop(); }
  onEvent(cb: (e: NormalizedDriverEvent) => void): void { this.tailer.onEvent(cb); }
}
