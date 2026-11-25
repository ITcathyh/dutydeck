// Resolve the ONE verified text source attached to a `/job`.
//
// Single safety rule: never dispatch without a clear original message that is
// provably in the current chat/topic.
//
//  - an explicit quote/parent wins only after read-back proves same chat and
//    same thread/root, or that the parent is the trusted topic root itself;
//  - missing scope attribution, deleted/recalled messages and bodies made only
//    of literal placeholders are rejected (the commander is asked to quote);
//  - merge_forward children are read only when upperMessageId proves the
//    parent-child relation;
//  - without a quote, a forward is used only when the current `omt_` topic can
//    be enumerated completely and exactly one forward older than the command is
//    confirmable. With no topic id we never scan the chat-wide history;
//  - an incomplete list/pagination, several candidates or an unreadable
//    candidate all end in “please quote it”;
//  - list payloads are never trusted as material: the chosen id is re-fetched;
//  - nothing is ever taken from mentioned accounts;
//  - the final text is clipped to Rove's per-entry 4000 Unicode code points.

import { extractMessageText } from './commands.mjs';

/** Rove tasksource clips one submitted text entry at 4000 runes/code points. */
export const ROVE_ENTRY_CODEPOINTS = 4000;

const TRUNC_SUFFIX = '\n…（材料过长，已截断）';

/** Effective cap in Unicode code points; callers can only ask for less. */
function effectiveCodePointLimit(maxChars) {
  const asked = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : ROVE_ENTRY_CODEPOINTS;
  return Math.min(asked, ROVE_ENTRY_CODEPOINTS);
}

/** Clip without splitting surrogate pairs, keeping total code points <= limit. */
export function clipToCodePoints(text, maxChars = ROVE_ENTRY_CODEPOINTS) {
  const limit = effectiveCodePointLimit(maxChars);
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= limit) return String(text ?? '');
  const suffix = Array.from(TRUNC_SUFFIX);
  const head = chars.slice(0, Math.max(0, limit - suffix.length));
  return [...head, ...suffix].join('');
}

// Unresolved Feishu mention keys (`@_user_1`, `@_all`) are literal placeholders
// in raw message content. The English literal is the API body of a
// merge_forward envelope (see the repo's message-content fixtures).
const MENTION_PLACEHOLDER = /@(?:_user_\d+|_all)\b/g;
const LITERAL_PLACEHOLDER_BODIES = new Set(['Merged and Forwarded Message']);

/**
 * @returns {null | 'empty' | 'mention_placeholder' | 'literal_placeholder'}
 *          null when the extracted body carries real readable text.
 */
export function textBodyProblem(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return 'empty';
  if (LITERAL_PLACEHOLDER_BODIES.has(trimmed)) return 'literal_placeholder';
  if (!/\S/u.test(trimmed.replace(MENTION_PLACEHOLDER, ''))) return 'mention_placeholder';
  return null;
}

/**
 * Only a native merged-forward message is a provable forward through the Open
 * API. Plain typed text is deliberately not a candidate, and speculative raw
 * `forward`/`origin` flags are not proof either.
 */
export function isForwardCandidate(message) {
  return Boolean(message && message.messageType === 'merge_forward');
}

/** Lenient scope filter for server-filtered list pages; the authoritative check is verifyScope. */
function inScope(message, chatId, threadId) {
  if (!message) return false;
  // Partial API items may omit chat id: a present-but-different one rejects.
  if (message.chatId && message.chatId !== chatId) return false;
  if (threadId && message.threadId && message.threadId !== threadId) return false;
  return true;
}

/**
 * Authoritative same-chat/topic proof on a re-fetched item. Missing attribution
 * fails closed rather than being treated as “probably same scope”.
 *
 * @returns {{ok:true} | {ok:false, reason:'cross_scope', detail:string}}
 */
export function verifyScope(target, event) {
  const chatId = event?.chatId;
  if (!target?.chatId || target.chatId !== chatId) {
    return { ok: false, reason: 'cross_scope', detail: target?.chatId ? 'chat_mismatch' : 'chat_attribution_missing' };
  }
  const threadId = event.threadId || null;
  const rootId = event.rootId || null;
  // A plain (non-topic) group has no narrower boundary than the current chat.
  if (!threadId && !rootId) return { ok: true };

  if (threadId && target.threadId && target.threadId === threadId) return { ok: true };
  if (rootId && target.rootId && target.rootId === rootId) return { ok: true };
  // The event's trusted root id matched by id: the referenced message itself is
  // the topic root, even if the root item omits thread/root attribution.
  if (rootId && target.messageId === rootId) return { ok: true };

  return {
    ok: false,
    reason: 'cross_scope',
    detail: target.threadId || target.rootId ? 'topic_mismatch' : 'topic_attribution_missing',
  };
}

function parseMessageTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Flatten a verified message (merge_forward children included) to one body.
 * Children are accepted ONLY with `upperMessageId === target.messageId`; there
 * is no “every other item” fallback. Callers pass the re-fetched items.
 */
export function verifiedText(target, items, maxChars = ROVE_ENTRY_CODEPOINTS) {
  if (!target) return '';
  let text = '';
  if (target.messageType === 'merge_forward' && Array.isArray(items)) {
    const children = items.filter((i) => i && i.upperMessageId === target.messageId && i.deleted !== true);
    const parts = [];
    for (const child of children) {
      const body = extractMessageText(child.messageType, child.content);
      if (!body || textBodyProblem(body)) continue;
      parts.push(body.trim());
      // Nested merge_forward is not expanded automatically (no new authorization).
    }
    text = parts.join('\n\n');
  } else {
    text = extractMessageText(target.messageType, target.content);
  }
  return clipToCodePoints((text ?? '').trim(), maxChars);
}

function need(reason, extra = {}) {
  return { status: 'need', reason, ...extra };
}

/**
 * @param {object} args
 * @param {import('./lark-api.mjs').LarkApiClient} args.client
 * @param {object} args.event normalized inbound identity fields
 * @param {number} [args.maxChars] hard-clamped to the Rove 4000 code point contract
 * @param {number} [args.scanLimit] max recent topic messages enumerated
 */
export async function resolveMaterial({ client, event, maxChars = ROVE_ENTRY_CODEPOINTS, scanLimit = 30 }) {
  const { chatId, parentId, messageId: commandMessageId } = event;
  const limit = effectiveCodePointLimit(maxChars);

  // 1) Explicit quote / parent reference: re-fetch and verify before reading.
  if (parentId) return readVerifiedMaterial(client, parentId, event, limit, 'reference_not_readable');

  // 2) No quote. Discovery is allowed ONLY inside a native `omt_` topic. A root
  //    id (`om_`) without an `omt_` thread would require a chat-wide scan, which
  //    is forbidden: ask for an explicit quote instead.
  const topicId = typeof event.threadId === 'string' && event.threadId.startsWith('omt_') ? event.threadId : null;
  if (!topicId) return need('none', { detail: 'no_topic' });

  const budget = Number.isInteger(scanLimit) && scanLimit > 0 ? scanLimit : 30;
  const listed = [];
  let pageToken;
  let complete = false;
  try {
    // Drain continuation pages up to `budget` items so uniqueness is provable.
    while (listed.length < budget) {
      const pageSize = Math.min(50, budget - listed.length);
      const page = await client.listMessages({
        containerIdType: 'thread', containerId: topicId, pageSize, pageToken,
      });
      if (!page || !Array.isArray(page.items)) return need('incomplete', { detail: 'malformed_page' });
      if (page.items.length === 0 && page.hasMore && page.pageToken) {
        return need('incomplete', { detail: 'empty_continuation_page' });
      }
      for (const item of page.items) {
        if (item) listed.push(item);
      }
      if (!page.hasMore) { complete = true; break; }
      if (!page.pageToken || page.pageToken === pageToken) return need('incomplete', { detail: 'bad_page_token' });
      pageToken = page.pageToken;
    }
  } catch (error) {
    return classifyReadError(error);
  }
  // Budget exhausted while the server still reports older messages: there may
  // be another forward outside the window, so uniqueness is not provable.
  if (!complete) return need('incomplete', { detail: 'scan_window_truncated' });

  const candidates = listed.filter((m) => m
    && m.messageId !== commandMessageId
    && inScope(m, chatId, topicId)
    && isForwardCandidate(m));

  if (candidates.length === 0) return need('none');

  // Only forwards OLDER than the command count. Resolve the command anchor's
  // time here: event field, the listed command itself, or a direct read-back.
  const anchor = await resolveCommandTime(client, event, listed);
  if (anchor.abort) return anchor.abort;
  if (anchor.time != null) {
    for (const candidate of candidates) {
      const candidateTime = parseMessageTime(candidate.createTime);
      if (candidateTime == null) return need('incomplete', { detail: 'candidate_time_unknown' });
    }
    const earlier = candidates.filter((c) => parseMessageTime(c.createTime) < anchor.time);
    if (earlier.length === 0) return need('none', { detail: 'no_forward_before_command' });
    if (earlier.length > 1) return need('multiple', { candidateCount: earlier.length });
    return readVerifiedMaterial(client, earlier[0].messageId, event, limit, 'candidate_detail_missing');
  }

  // Anchor time is definitively unavailable (e.g. missing on the event and
  // read-back not found): we cannot prove the candidate predates the command,
  // so even a single candidate is not green-lit. Ask for an explicit quote.
  return need('incomplete', { detail: 'command_time_unknown' });
}

/**
 * @returns {Promise<{time:number|null, abort?:undefined} | {time?:undefined, abort:object}>}
 *   `abort` is a retryable resolveMaterial result when an anchor read fails
 *   transiently; otherwise `time:null` means the anchor cannot be dated for
 *   definitive reasons. The caller treats that as fail-closed: without a
 *   provable command time no unquoted candidate is trusted.
 */
async function resolveCommandTime(client, event, listed) {
  const fromEvent = parseMessageTime(event.commandCreateTime ?? event.createTime);
  if (fromEvent != null) return { time: fromEvent };

  const commandMessageId = event.messageId;
  const listedAnchor = listed.find((m) => m && m.messageId === commandMessageId);
  let time = parseMessageTime(listedAnchor?.createTime);
  if (time != null) return { time };

  if (!commandMessageId || typeof client?.getMessageItems !== 'function') return { time: null };
  try {
    const items = await client.getMessageItems(commandMessageId);
    const anchorMessage = (items ?? []).find((i) => i && i.messageId === commandMessageId) ?? null;
    time = parseMessageTime(anchorMessage?.createTime);
    return { time };
  } catch (error) {
    const classified = classifyReadError(error);
    // Transient network/server/auth failures must be retried, not decided on.
    if (classified.status === 'error') return { abort: classified };
    // Definitive anchor read rejection: date unknown; the caller fails closed
    // and asks for a quote rather than trusting an undated candidate.
    return { time: null };
  }
}

/** Read material only from the verified message detail. */
async function readVerifiedMaterial(client, messageId, event, limit, missingDetail) {
  let items;
  try {
    items = await client.getMessageItems(messageId);
  } catch (error) {
    return classifyReadError(error);
  }
  // No fallback to the list object: list content is only a placeholder hint.
  const verified = (items ?? []).find((i) => i && i.messageId === messageId) ?? null;
  if (!verified) return need('inaccessible', { detail: missingDetail });
  if (verified.deleted === true) return need('inaccessible', { detail: 'deleted' });

  const scope = verifyScope(verified, event);
  if (!scope.ok) return need(scope.reason, { detail: scope.detail });

  const text = verifiedText(verified, items, limit);
  const problem = textBodyProblem(text);
  if (problem) return need('no_text', { detail: problem });
  return { status: 'ok', material: { messageId, text } };
}

function classifyReadError(error) {
  if (error && (error.kind === 'not_found' || error.kind === 'forbidden' || error.kind === 'bad_request')) {
    return { status: 'need', reason: 'inaccessible', detail: error.message };
  }
  // network/server/auth are worth retrying rather than asking the user immediately.
  return { status: 'error', error: error?.message ?? String(error) };
}
