/**
 * Resume-id judgement helper.
 *
 * BACKGROUND
 * ----------
 * `driver.resume()` resolves the id it hands an adapter in three tiers: an
 * injected `cliSessionId`, a reverse lookup against the CLI's own on-disk
 * records, and — when both come up empty — the dutydeck session id itself.
 *
 * That last tier is only correct for CLIs where dutydeck PINNED the id at fresh
 * spawn (`claude --session-id <uuid>`, `grok --session-id`, `pi`, `mtr`). For a
 * CLI that mints its own id, the dutydeck id is a value the CLI has never seen,
 * and handing it over is strictly worse than not resuming:
 *
 *   `opencode -s ses_<uuid>` → "Session not found" → exit 1 → session failed
 *   `codex resume <unknown>` → same shape of failure
 *
 * So a CLI-minted-id adapter must return `null` from `buildResumeCommand` when
 * the id cannot be one of its own. The driver reads that as "start fresh
 * instead" and tells the user the context was dropped.
 *
 * WHY THE FULL `ses_`+UUID SHAPE, NOT THE PREFIX ALONE
 * ----------------------------------------------------
 * `ses_` alone is not a discriminator: OpenCode mints `ses_<base62>` and mtr
 * mints `ses_<26 alnum>` in their OWN namespaces. What identifies a dutydeck id
 * is the whole shape produced by `makeId('ses')` — `ses_` + `crypto.randomUUID()`
 * — whose hyphenated body no CLI-native `ses_` format here uses.
 *
 * WHY THE PREFIX IS REQUIRED, AND A BARE UUID IS NOT ENOUGH
 * ---------------------------------------------------------
 * A bare UUID must NOT be treated as "dutydeck's": codex and traex rollout ids
 * are themselves UUIDs (`01a02e6e-8e60-74a0-…`), so rejecting bare UUIDs would
 * throw away every legitimate codex resume. This is safe because the driver's
 * fallback tier returns `this.sessionId` verbatim — always the prefixed form.
 * Adapters that strip the prefix before resuming are the ones where dutydeck
 * pinned the id (claude family), and those must never call this at all.
 */

/** `ses_` + RFC-4122 UUID — the exact shape of `makeId('ses')`. */
const DUTYDECK_SESSION_ID_RE =
  /^ses_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this dutydeck's own session id rather than one the CLI minted?
 *
 * Use it in `buildResumeCommand` of any adapter whose CLI generates its own
 * session ids: a `true` here means the reverse lookup found nothing and the
 * driver fell back to the dutydeck id, so the only honest answer is `null`.
 *
 * Adapters whose CLI has a RECOGNISABLE native id format should prefer a
 * positive check against that format (see opencode's `OPENCODE_SESSION_ID_RE`):
 * it also rejects garbage this function cannot recognise. This helper is for
 * the CLIs whose ids are opaque, where "not ours" is all that can be proven.
 */
export function isDutydeckSessionId(sessionId: string): boolean {
  return DUTYDECK_SESSION_ID_RE.test(sessionId);
}

/**
 * The resume id to actually use, or `undefined` when there is none usable.
 *
 * `buildArgs`'s resume branch and `buildResumeCommand` must agree on a given
 * id: the driver asks `buildResumeCommand` whether resume is possible, then
 * builds the real argv from `buildArgs`. If only one of them vetoes the id,
 * the other silently produces a "resume" that resumes nothing — the CLI comes
 * up fine, the context is gone, and nobody is told. Route both through here.
 *
 * Returns undefined when the id is absent or is dutydeck's own session id (see
 * `isDutydeckSessionId`); an adapter whose CLI has a recognisable native id
 * format should test against that format instead.
 */
export function usableResumeId(resumeSessionId: string | undefined): string | undefined {
  if (!resumeSessionId) return undefined;
  return isDutydeckSessionId(resumeSessionId) ? undefined : resumeSessionId;
}
