// Resolve the ONE verified text source attached to a `/job`.
//
// Single safety rule: never dispatch without a clear original message that is
// provably in the current chat/topic.
//
//  - an explicit quote wins only after read-back proves same chat and topic;
//    a topic reply's automatic parent_id == root_id is not a quote;
//  - missing scope attribution, deleted/recalled messages and bodies made only
//    of literal placeholders are rejected (the commander is asked to quote);
//  - merge_forward children are read only when upperMessageId proves the
//    parent-child relation;
//  - without a quote, enumerate the current topic completely, including its
//    root. Use its only earlier merge_forward, or the root when it is the
//    sole earlier message. With no topic id we never scan the chat history;
//  - an incomplete list/pagination, several candidates or an unreadable
//    candidate all end in “please quote it”;
//  - list payloads are never trusted as material: the chosen id is re-fetched;
//  - nothing is ever taken from mentioned accounts;
//  - the final text is clipped to Rove's per-entry 4000 Unicode code points.

import { extractMessageText, MAX_MATERIAL_CHOICES } from './commands.mjs';

/** Rove tasksource clips one submitted text entry at 4000 runes/code points. */
export const ROVE_ENTRY_CODEPOINTS = 4000;

const TRUNC_SUFFIX = '\n…（材料过长，已截断）';
const MATERIAL_TEXT_TYPES = new Set(['text', 'post']);
const PREVIEW_CODEPOINTS = 80;

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
  const suffix = Array.from(TRUNC_SUFFIX).slice(0, limit);
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

function topicConflicts(message, { threadId, rootId }) {
  return Boolean((threadId && message.threadId && message.threadId !== threadId)
    || (rootId && message.rootId && message.rootId !== rootId));
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

  if (topicConflicts(target, event)) return { ok: false, reason: 'cross_scope', detail: 'topic_mismatch' };
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

function nativeTopicId(value) {
  return typeof value === 'string' && value.startsWith('omt_') && value.length > 4 ? value : null;
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
      if (!MATERIAL_TEXT_TYPES.has(child.messageType)) continue;
      const body = extractMessageText(child.messageType, child.content);
      if (!body || textBodyProblem(body)) continue;
      parts.push(body.trim());
      // Nested merge_forward is not expanded automatically (no new authorization).
    }
    text = parts.join('\n\n');
  } else if (MATERIAL_TEXT_TYPES.has(target.messageType)) {
    text = extractMessageText(target.messageType, target.content);
  }
  text = (text ?? '').trim();
  return textBodyProblem(text) ? text : clipToCodePoints(text, maxChars);
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
  const { chatId, parentId, messageId: commandMessageId, selectedMaterialId } = event;
  const limit = effectiveCodePointLimit(maxChars);
  let rootId = event.rootId || null;
  let topicId = nativeTopicId(event.threadId);
  event = { ...event, threadId: topicId };

  // With the root missing, a topic reply's parent is ambiguous until we can
  // prove which message is the root from the command's own detail.
  if (topicId && !rootId && commandMessageId) {
    const command = await readVerifiedMessage(client, commandMessageId, event, 'command_detail_missing');
    if (command.status === 'error') return command;
    if (command.status === 'ok') {
      rootId = command.target.rootId;
      event = { ...event, rootId, createTime: event.createTime ?? command.target.createTime };
    }
  }

  if (!selectedMaterialId && parentId && parentId !== rootId && (rootId || !topicId)) {
    return materialFromRead(await readVerifiedMessage(client, parentId, event, 'reference_not_readable'), limit);
  }
  if (!rootId || rootId === commandMessageId) {
    return need('none', { detail: topicId ? 'root_attribution_missing' : 'no_topic' });
  }

  let root;
  // The thread listing may exclude its root. For discovery, read the root by
  // ID so it cannot go missing from the candidate set.
  if (!selectedMaterialId || !topicId || selectedMaterialId === rootId) {
    root = await readVerifiedMessage(client, rootId, event, 'root_detail_missing');
    if (root.status !== 'ok') return root;
    topicId ??= nativeTopicId(root.target.threadId);
  }
  if (!topicId) return need('none', { detail: 'no_topic' });
  event = { ...event, threadId: topicId };
  const topic = { threadId: topicId, rootId };

  if (selectedMaterialId) {
    const anchor = await resolveCommandTime(client, event, []);
    if (anchor.abort) return anchor.abort;
    if (anchor.time == null) return need('incomplete', { detail: 'command_time_unknown' });
    const selected = selectedMaterialId === rootId ? root
      : await readVerifiedMessage(client, selectedMaterialId, event, 'selected_detail_missing');
    const result = materialFromRead(selected, limit, topic);
    if (result.status === 'ok' && (selectedMaterialId === commandMessageId || !isChoice(selected.target, anchor.time))) {
      return need('inaccessible', { detail: 'selected_no_longer_eligible' });
    }
    return result;
  }

  const budget = Number.isInteger(scanLimit) && scanLimit > 0 ? scanLimit : 30;
  const listed = [];
  let pageToken;
  const seenTokens = new Set();
  let complete = false;
  try {
    // Drain continuation pages up to `budget` items so uniqueness is provable.
    while (listed.length < budget) {
      const pageSize = Math.min(50, budget - listed.length);
      const page = await client.listMessages({
        containerIdType: 'thread', containerId: topicId, pageSize, pageToken,
      });
      if (!page || !Array.isArray(page.items) || typeof page.hasMore !== 'boolean'
        || page.items.some((item) => !item?.messageId)) return need('incomplete', { detail: 'malformed_page' });
      if (page.items.length > pageSize) return need('incomplete', { detail: 'scan_window_truncated' });
      if (page.items.length === 0 && page.hasMore && page.pageToken) {
        return need('incomplete', { detail: 'empty_continuation_page' });
      }
      listed.push(...page.items);
      if (!page.hasMore) { complete = true; break; }
      if (!page.pageToken || seenTokens.has(page.pageToken)) return need('incomplete', { detail: 'bad_page_token' });
      seenTokens.add(page.pageToken);
      pageToken = page.pageToken;
    }
  } catch (error) {
    return classifyReadError(error);
  }
  // Budget exhausted while the server still reports older messages: there may
  // be another forward outside the window, so uniqueness is not provable.
  if (!complete) return need('incomplete', { detail: 'scan_window_truncated' });

  // Do not count embedded children, or count the root again if the list included it.
  const replies = [...new Map(listed.filter((m) =>
    m.messageId !== commandMessageId && m.messageId !== rootId && !m.upperMessageId
    && (!m.chatId || m.chatId === chatId) && !topicConflicts(m, event),
  ).map((m) => [m.messageId, m])).values()];
  const candidates = [root.target, ...replies].filter(isForwardCandidate);
  const anchor = await resolveCommandTime(client, event, listed);
  if (anchor.abort) return anchor.abort;
  if (anchor.time == null) return need('incomplete', { detail: 'command_time_unknown' });

  if (candidates.length) {
    if (candidates.some((m) => parseMessageTime(m.createTime) == null)) return need('incomplete', { detail: 'candidate_time_unknown' });
    const earlier = candidates.filter((c) => parseMessageTime(c.createTime) < anchor.time);
    if (earlier.length === 0) return need('none', { detail: 'no_forward_before_command' });
    if (earlier.length > 1) {
      return withChoices(need('multiple', { candidateCount: earlier.length }), {
        client, event, root, messages: earlier, commandTime: anchor.time, topic,
      });
    }
    const chosenId = earlier[0].messageId;
    const chosen = chosenId === rootId ? root : await readVerifiedMessage(client, chosenId, event, 'candidate_detail_missing');
    if (chosen.status === 'ok' && (!isForwardCandidate(chosen.target) || chosen.target.upperMessageId)) {
      return need('incomplete', { detail: 'candidate_type_changed' });
    }
    if (chosen.status === 'ok' && !predates(chosen.target, anchor.time)) {
      return need('incomplete', { detail: 'candidate_time_unknown' });
    }
    return materialFromRead(chosen, limit, topic);
  }

  // A single forwarded message can become the root as ordinary text. Only
  // use it when the root is the sole message that could precede this command.
  const earlierReplies = replies.filter((m) => (parseMessageTime(m.createTime) ?? 0) <= anchor.time);
  if (earlierReplies.length) {
    return withChoices(need('none', { detail: 'topic_root_not_only_source' }), {
      client, event, root, messages: [root.target, ...earlierReplies], commandTime: anchor.time, topic,
    });
  }
  const rootTime = parseMessageTime(root.target.createTime);
  if (rootTime == null) return need('incomplete', { detail: 'candidate_time_unknown' });
  if (rootTime >= anchor.time) return need('none', { detail: 'no_forward_before_command' });
  const result = materialFromRead(root, limit, topic);
  if (result.status === 'ok' && (root.target.upperMessageId || isJobMessage(root.target)
    || (root.target.sender?.sender_type && root.target.sender.sender_type !== 'user'))) {
    return need('none', { detail: 'topic_root_not_material' });
  }
  return result;
}

function predates(message, commandTime) {
  const time = parseMessageTime(message.createTime);
  return time != null && time < commandTime;
}

function couldBeChoice(message, commandTime) {
  return predates(message, commandTime) && !message.deleted && !message.upperMessageId
    && (isForwardCandidate(message) || MATERIAL_TEXT_TYPES.has(message.messageType));
}

function isJobMessage(message) {
  return message.messageType === 'text'
    && /^(?:@\S+\s+)*\/job(?=\s|$)/iu.test(extractMessageText('text', message.content).trim());
}

function isChoice(message, commandTime) {
  return couldBeChoice(message, commandTime) && message.sender?.sender_type === 'user' && !isJobMessage(message);
}

async function withChoices(result, { client, event, root, messages, commandTime, topic }) {
  const possible = messages.filter((m) => couldBeChoice(m, commandTime)
    && (!m.sender?.sender_type || m.sender.sender_type === 'user'));
  if (possible.length > MAX_MATERIAL_CHOICES) return result;

  const choices = [];
  for (const message of possible) {
    const read = message.messageId === topic.rootId ? root
      : await readVerifiedMessage(client, message.messageId, event, 'candidate_detail_missing');
    if (read.status !== 'ok') return result;
    const text = verifiedText(read.target, read.items);
    if (textBodyProblem(text) || !isChoice(read.target, commandTime)) continue;
    const chars = Array.from(text.replace(MENTION_PLACEHOLDER, '').replace(/\s+/gu, ' ').trim());
    if (!chars.length) continue;
    const preview = chars.length <= PREVIEW_CODEPOINTS ? chars.join('')
      : `${chars.slice(0, PREVIEW_CODEPOINTS - 1).join('')}…`;
    choices.push({ messageId: message.messageId, preview });
  }
  return choices.length ? { ...result, ...topic, commandCreateTime: String(commandTime), choices } : result;
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
  const isAnchor = (m) => m && m.messageId === commandMessageId
    && (!m.chatId || m.chatId === event.chatId) && !topicConflicts(m, event);
  const listedAnchor = listed.find(isAnchor);
  let time = parseMessageTime(listedAnchor?.createTime);
  if (time != null) return { time };

  if (!commandMessageId || typeof client?.getMessageItems !== 'function') return { time: null };
  try {
    const items = await client.getMessageItems(commandMessageId);
    const anchorMessage = (items ?? []).find(isAnchor);
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

/** Read and verify the envelope before examining any material body. */
async function readVerifiedMessage(client, messageId, event, missingDetail) {
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

  return { status: 'ok', target: verified, items };
}

function materialFromRead(read, limit, topic) {
  if (read.status !== 'ok') return read;
  const { target, items } = read;
  const text = verifiedText(target, items, limit);
  const problem = textBodyProblem(text);
  if (problem) return need('no_text', { detail: problem });
  return { status: 'ok', material: { messageId: target.messageId, text }, ...topic };
}

function classifyReadError(error) {
  if (error && (error.kind === 'not_found' || error.kind === 'forbidden' || error.kind === 'bad_request')) {
    return { status: 'need', reason: 'inaccessible', detail: error.message };
  }
  // network/server/auth are worth retrying rather than asking the user immediately.
  return { status: 'error', error: error?.message ?? String(error) };
}
