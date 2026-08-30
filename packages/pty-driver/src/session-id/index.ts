/**
 * Session-id reverse lookup: given dockmux's own session id, recover the
 * session id the CLI generated for itself.
 *
 * WHY THIS EXISTS
 * ---------------
 * `driver.resume()` used to hand `adapter.buildResumeCommand(dockmuxSessionId)`
 * the dockmux id, which only works for CLIs where dockmux got to CHOOSE the id
 * (`claude --session-id <uuid>`, `grok --session-id <uuid>`). Most CLIs mint
 * their own id and never tell us, so those resumes either silently started a
 * brand-new session or — worse for `codex resume <id>` style CLIs — failed on
 * an id that does not exist.
 *
 * THE ANCHOR: a per-session marker in the first prompt
 * ----------------------------------------------------
 * The driver injects `<dockmux_session_id>…</dockmux_session_id>` into the
 * first prompt of every session. Each CLI durably records submitted prompt
 * text (claude jsonl, codex/trae history.jsonl, grok prompt_history.jsonl,
 * opencode's part table), so searching that text for the marker identifies
 * OUR session specifically.
 *
 * Rejected alternative — start-time window + cwd: two dockmux sessions can
 * legitimately start in the same repo within the same second, and a wrong
 * pick there resumes a SIBLING's conversation. That failure is silent and
 * worse than not resuming. Recency is therefore used only to bound how many
 * candidates are examined and to break ties among records that all carry the
 * same marker (a session resumed more than once).
 *
 * EVERY lookup is best-effort and total: unknown adapter, missing data dir,
 * hostile file, no match — all return undefined, and the driver degrades to
 * the previous behavior (dockmux session id used as the CLI session id).
 */
import type { SessionIdLookup, SessionIdLookupContext } from './types.js';
import { claudeSessionIdLookup } from './claude.js';
import { codexSessionIdLookup, traexSessionIdLookup } from './codex.js';
import { grokSessionIdLookup } from './grok.js';
import { opencodeSessionIdLookup } from './opencode.js';

export type { SessionIdLookup, SessionIdLookupContext } from './types.js';
export {
  buildSessionMarker,
  isUsableMarker,
  MIN_MARKER_SESSION_ID_LENGTH,
} from './marker.js';
export { claudeSessionIdLookup } from './claude.js';
export { codexSessionIdLookup, traexSessionIdLookup } from './codex.js';
export { grokSessionIdLookup } from './grok.js';
export { opencodeSessionIdLookup, readOpenCodeSessionId } from './opencode.js';

const LOOKUPS: SessionIdLookup[] = [
  claudeSessionIdLookup,
  codexSessionIdLookup,
  traexSessionIdLookup,
  grokSessionIdLookup,
  opencodeSessionIdLookup,
];

const BY_ADAPTER = new Map(LOOKUPS.map(l => [l.adapterId, l]));

/** Adapter ids that have a native session-id lookup. */
export function adapterIdsWithSessionIdLookup(): string[] {
  return [...BY_ADAPTER.keys()];
}

/**
 * Resolve the CLI's own session id for a dockmux session, or undefined when
 * it cannot be determined. NEVER throws: a resolver that blows up on
 * unexpected on-disk data is treated as "not found" so resume still proceeds
 * down the degraded path.
 */
export function resolveCliSessionId(
  adapterId: string,
  ctx: SessionIdLookupContext,
): string | undefined {
  const lookup = BY_ADAPTER.get(adapterId);
  if (!lookup) return undefined;
  try {
    const found = lookup.resolve(ctx);
    return typeof found === 'string' && found.length > 0 ? found : undefined;
  } catch {
    // A resolver must never break resume — degrade instead.
    return undefined;
  }
}
