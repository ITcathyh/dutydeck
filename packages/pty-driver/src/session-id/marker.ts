/**
 * Session fingerprint marker.
 *
 * The driver injects this block into the FIRST prompt of every pty-cli
 * session. Every CLI we bridge records the submitted prompt text somewhere
 * durable (claude jsonl, codex/traex history.jsonl + rollout, grok
 * prompt_history.jsonl, opencode part table), so the marker becomes the
 * bridge between "dockmux's session id" and "the CLI's own session id".
 *
 * Why a prompt marker and not a time window:
 *   A time window + cwd cannot separate two dockmux sessions started in the
 *   same repo within the same second — a common case (a burst of topics).
 *   Picking wrong there resumes SOMEONE ELSE'S conversation, which is worse
 *   than not resuming at all. The marker is per-session unique by
 *   construction, so a hit is proof of identity rather than a guess.
 *   Recency is used only to break ties among several records that all carry
 *   the SAME marker (a session legitimately resumed more than once).
 *
 * The lookups search for the raw session id substring rather than the whole
 * tag, so they keep working if the surrounding wording ever changes; the tag
 * only exists to keep the marker readable to the model (and to make it
 * obvious in a transcript that the line is bookkeeping, not a user request).
 */

/** Shortest session id we will search for. A very short id could appear
 *  inside unrelated prose / uuids and produce a false identity match, so we
 *  refuse to use it as a fingerprint at all (callers degrade instead). */
export const MIN_MARKER_SESSION_ID_LENGTH = 8;

/** The marker block injected into the first prompt. */
export function buildSessionMarker(sessionId: string): string {
  return `<dockmux_session_id>${sessionId}</dockmux_session_id>`;
}

/** True when a session id is distinctive enough to be used as a fingerprint. */
export function isUsableMarker(sessionId: string): boolean {
  return typeof sessionId === 'string' && sessionId.trim().length >= MIN_MARKER_SESSION_ID_LENGTH;
}
