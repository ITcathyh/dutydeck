// Resolve the ONE verified text source attached to a `/job`.
//
// Rules (approved prototype + task contract):
//  - an explicit quote/parent wins;
//  - otherwise use a forward only when there is exactly one *confirmable* forward
//    in the current chat/thread; several -> ask the commander to quote one;
//  - never reach into a colleague's private chat: only the current chat/thread
//    copy read back with the bot's own token is used;
//  - event placeholders (especially merge_forward) are never trusted: every
//    candidate is re-fetched through getMessageItems and scope-checked;
//  - the result is exactly one `{ messageId, text }` material.

import { extractMessageText } from './commands.mjs';

export function isForwardCandidate(message) {
  if (!message) return false;
  if (message.messageType === 'merge_forward') return true;
  const raw = message.raw ?? {};
  // Explicit forward descriptors when the fake/real API exposes one. Plain typed
  // text is deliberately NOT a confirmable forward.
  return raw.forward === true
    || (raw.forward && typeof raw.forward === 'object')
    || Boolean(raw.forward_from)
    || Boolean(raw.origin && raw.origin.message_id);
}

function inScope(message, chatId, threadId) {
  if (!message) return false;
  if (message.chatId && message.chatId !== chatId) return false;
  // Partial API items may omit thread id: a present-but-different one rejects.
  if (threadId && message.threadId && message.threadId !== threadId) return false;
  return true;
}

/** Flatten a verified message (or merge_forward items) to one text body. */
export function verifiedText(target, items, maxChars) {
  if (!target) return '';
  let text = '';
  if (target.messageType === 'merge_forward' && Array.isArray(items) && items.length) {
    const children = items.some((i) => i.upperMessageId)
      ? items.filter((i) => i.upperMessageId === target.messageId)
      : items.filter((i) => i.messageId !== target.messageId);
    const parts = [];
    for (const child of children) {
      if (!child) continue;
      const body = extractMessageText(child.messageType, child.content);
      if (body && body.trim()) parts.push(body.trim());
      // Nested merge_forward is not expanded automatically (no new authorization).
    }
    text = parts.join('\n\n');
  } else {
    text = extractMessageText(target.messageType, target.content);
  }
  text = (text ?? '').trim();
  if (maxChars && text.length > maxChars) text = `${text.slice(0, maxChars)}\n…（材料过长，已截断）`;
  return text;
}

/**
 * @param {object} args
 * @param {import('./lark-api.mjs').LarkApiClient} args.client
 * @param {object} args.event normalized inbound identity fields
 */
export async function resolveMaterial({ client, event, maxChars = 20_000, scanLimit = 30 }) {
  const { chatId, threadId, parentId, messageId: commandMessageId } = event;
  const scopeThread = threadId || null;

  // 1) Explicit quote / parent reference.
  if (parentId) {
    let items;
    try {
      items = await client.getMessageItems(parentId);
    } catch (error) {
      return classifyReadError(error);
    }
    const parent = items.find((i) => i.messageId === parentId) ?? items[0] ?? null;
    if (!parent || parent.messageId !== parentId) return { status: 'need', reason: 'inaccessible' };
    if (parent.chatId && parent.chatId !== chatId) return { status: 'need', reason: 'cross_scope' };
    if (scopeThread && parent.threadId && parent.threadId !== scopeThread) return { status: 'need', reason: 'cross_scope' };
    if (parent.rootId && event.rootId && parent.rootId !== event.rootId && !parent.threadId) {
      return { status: 'need', reason: 'cross_scope' };
    }
    const text = verifiedText(parent, items.filter((i) => inScope(i, chatId, scopeThread)), maxChars);
    if (!text) return { status: 'need', reason: 'no_text' };
    return { status: 'ok', material: { messageId: parentId, text } };
  }

  // 2) No quote: scan the current thread (preferred) or recent chat.
  let listed = [];
  try {
    if (threadId && threadId.startsWith('omt_')) {
      const page = await client.listMessages({ containerIdType: 'thread', containerId: threadId, pageSize: scanLimit });
      listed = page.items;
    } else {
      const page = await client.listMessages({ containerIdType: 'chat', containerId: chatId, pageSize: scanLimit });
      listed = page.items;
      // When the command belongs to a root topic, keep only that topic.
      if (event.rootId) {
        listed = listed.filter((m) => m.rootId === event.rootId || m.threadId === threadId || m.messageId === event.rootId);
      }
    }
  } catch (error) {
    return classifyReadError(error);
  }

  const candidates = listed.filter((m) => m
    && m.messageId !== commandMessageId
    && inScope(m, chatId, scopeThread)
    && isForwardCandidate(m));

  if (candidates.length === 0) return { status: 'need', reason: 'none' };
  if (candidates.length > 1) return { status: 'need', reason: 'multiple', candidateCount: candidates.length };

  const candidate = candidates[0];
  let items;
  try {
    items = await client.getMessageItems(candidate.messageId);
  } catch (error) {
    return classifyReadError(error);
  }
  const verified = items.find((i) => i.messageId === candidate.messageId) ?? candidate;
  if (verified.chatId && verified.chatId !== chatId) return { status: 'need', reason: 'cross_scope' };
  const text = verifiedText(verified, items.filter((i) => inScope(i, chatId, scopeThread)), maxChars);
  if (!text) return { status: 'need', reason: 'no_text' };
  return { status: 'ok', material: { messageId: candidate.messageId, text } };
}

function classifyReadError(error) {
  if (error && (error.kind === 'not_found' || error.kind === 'forbidden' || error.kind === 'bad_request')) {
    return { status: 'need', reason: 'inaccessible', detail: error.message };
  }
  // network/server/auth are worth retrying rather than asking the user immediately.
  return { status: 'error', error: error?.message ?? String(error) };
}
