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
//    root. An earlier merge_forward can be used automatically only if there
//    is no other possible material. A text root may stand alone as material;
//  - for several possible sources offer verified choices, and ask the
//    commander to quote when history or message details cannot be verified;
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
 * API. Forwarded single messages can appear as the same text types as typed
 * messages, so a plausible text reply always needs human confirmation.
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
  }
  if (!topicId) {
    if (!commandMessageId) return need('none', { detail: 'no_topic' });
    const command = await readVerifiedMessage(client, commandMessageId, { chatId }, 'command_detail_missing');
    if (command.status === 'error') return command;
    if (command.status !== 'ok') return need('none', { detail: 'no_topic' });
    if (topicConflicts(command.target, event)) return need('cross_scope', { detail: 'topic_mismatch' });

    // An OpenAPI detail without thread_id can be a flat quote even when
    // there is a separately opened topic on the same quoted message.
    topicId = nativeTopicId(command.target.threadId);
    if (!topicId) {
      if (!selectedMaterialId && parentId === rootId
        && command.target.parentId === rootId && command.target.rootId === rootId) {
        return materialFromRead(root, limit);
      }
      return need('none', { detail: 'no_topic' });
    }
    if (topicConflicts(root.target, { rootId, threadId: topicId })) {
      return need('cross_scope', { detail: 'topic_mismatch' });
    }
    event = { ...event, createTime: event.createTime ?? command.target.createTime };
  }
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
  const candidates = (isForwardCandidate(root.target) ? [root.target, ...replies] : replies)
    .filter((m) => supportsMaterial(m) && !m.deleted && !isNonHuman(m));
  const anchor = await resolveCommandTime(client, event, listed);
  if (anchor.abort) return anchor.abort;
  if (anchor.time == null) return need('incomplete', { detail: 'command_time_unknown' });
  if (candidates.some((m) => parseMessageTime(m.createTime) == null)) return need('incomplete', { detail: 'candidate_time_unknown' });
  const earlier = candidates.filter((m) => predates(m, anchor.time));
  if (earlier.length > MAX_MATERIAL_CHOICES) return need('multiple', { candidateCount: earlier.length });

  const reads = [];
  for (const candidate of earlier) {
    const read = candidate.messageId === rootId ? root
      : await readVerifiedMessage(client, candidate.messageId, event, 'candidate_detail_missing');
    if (read.status === 'need' && read.detail === 'deleted') continue;
    if (read.status !== 'ok') return read;
    if (read.target.messageType !== candidate.messageType || read.target.upperMessageId) {
      return need('incomplete', { detail: 'candidate_type_changed' });
    }
    if (!predates(read.target, anchor.time)) return need('incomplete', { detail: 'candidate_time_unknown' });
    if (isNonHuman(read.target) || isJobMessage(read.target)) continue;
    if (!isForwardCandidate(read.target) && read.target.sender?.sender_type !== 'user') {
      return need('incomplete', { detail: 'candidate_sender_unknown' });
    }
    const problem = textBodyProblem(verifiedText(read.target, read.items));
    if (problem) return need('no_text', { detail: problem });
    reads.push(read);
  }

  if (reads.some((read) => isForwardCandidate(read.target))) {
    if (reads.length === 1) return materialFromRead(reads[0], limit, topic);
    return withChoices(need('multiple', { candidateCount: reads.length }), reads, anchor.time, topic);
  }
  if (reads.length) {
    return withChoices(need('none', { detail: 'topic_root_not_only_source' }), [root, ...reads], anchor.time, topic);
  }
  if (candidates.some(isForwardCandidate) && !earlier.some(isForwardCandidate)) {
    return need('none', { detail: 'no_forward_before_command' });
  }
  if (replies.some((m) => !supportsMaterial(m) && !m.deleted && !isNonHuman(m)
    && (parseMessageTime(m.createTime) ?? 0) <= anchor.time)) {
    return need('none', { detail: 'topic_root_not_only_source' });
  }
  // A single forwarded message can become the root as ordinary text. Only
  // use it when no other earlier message could be material for this command.
  const rootTime = parseMessageTime(root.target.createTime);
  if (rootTime == null) return need('incomplete', { detail: 'candidate_time_unknown' });
  if (rootTime >= anchor.time) return need('none', { detail: 'no_forward_before_command' });
  const result = materialFromRead(root, limit, topic);
  if (result.status === 'ok' && (root.target.upperMessageId || isJobMessage(root.target)
    || isNonHuman(root.target))) {
    return need('none', { detail: 'topic_root_not_material' });
  }
  return result;
}

function predates(message, commandTime) {
  const time = parseMessageTime(message.createTime);
  return time != null && time < commandTime;
}

function supportsMaterial(message) {
  return isForwardCandidate(message) || MATERIAL_TEXT_TYPES.has(message.messageType);
}

function isNonHuman(message) {
  const sender = message.sender?.sender_type;
  return Boolean(sender && sender !== 'user');
}

function isJobMessage(message) {
  return message.messageType === 'text'
    && /^(?:@\S+\s+)*\/job(?=\s|$)/iu.test(extractMessageText('text', message.content).trim());
}

function isChoice(message, commandTime) {
  return supportsMaterial(message) && predates(message, commandTime) && !message.deleted && !message.upperMessageId
    && message.sender?.sender_type === 'user' && !isJobMessage(message);
}

function withChoices(result, reads, commandTime, topic) {
  const choices = [];
  for (const { target, items } of reads) {
    if (!isChoice(target, commandTime)) continue;
    const text = verifiedText(target, items);
    if (textBodyProblem(text)) continue;
    const chars = Array.from(text.replace(MENTION_PLACEHOLDER, '').replace(/\s+/gu, ' ').trim());
    if (!chars.length) continue;
    const preview = chars.length <= PREVIEW_CODEPOINTS ? chars.join('')
      : `${chars.slice(0, PREVIEW_CODEPOINTS - 1).join('')}…`;
    choices.push({ messageId: target.messageId, preview });
  }
  return choices.length && choices.length <= MAX_MATERIAL_CHOICES
    ? { ...result, ...topic, commandCreateTime: String(commandTime), choices } : result;
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
