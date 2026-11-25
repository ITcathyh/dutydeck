// Request authentication, envelope normalization and the transactional inbox.
//
// This is the security boundary. Trust order:
//   1. handler bearer (shared secret with Dutydeck eventHandlers)
//   2. outer app_id exactly equals the configured bot app
//   3. sender is a real human user with an open_id
//   4. chat is an explicitly bound dispatch group
//   5. commander open_id is explicitly allowed
// Failures at 1-2 are transport-level rejects. Failures at 3-5 are recognized
// `/job` commands that we stop (so Dutydeck never spawns an agent); only a real
// human in the bound group who lacks permission gets an explanatory reply.

import { timingSafeEqual } from 'node:crypto';
import { parseJobCommand, renderMentionText, extractMessageText } from './commands.mjs';
import { sourceKeyFor, newJobRecord } from './store.mjs';

export function bearerMatches(headerValue, expectedToken) {
  if (typeof headerValue !== 'string' || !expectedToken) return false;
  const provided = headerValue.startsWith('Bearer ') ? headerValue.slice(7) : headerValue;
  const a = Buffer.from(provided);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Accept both the Dutydeck pipeline envelope and a direct flattened event. */
export function normalizeEnvelope(body) {
  if (!body || typeof body !== 'object') return null;
  const envelope = body.event && typeof body.event === 'object'
    ? body
    : { app_id: body.app_id, handler_id: body.handler_id, event_type: body.event_type, event: body };
  const event = envelope.event;
  if (!event || typeof event !== 'object') return null;

  const sender = event.sender ?? {};
  const senderId = sender.sender_id ?? {};
  const message = event.message ?? {};
  const mentions = Array.isArray(message.mentions) ? message.mentions
    : Array.isArray(event.mentions) ? event.mentions : [];

  const rawContent = extractMessageText(message.message_type, message.content);
  const renderedText = renderMentionText(rawContent, mentions, undefined);

  return {
    outerAppId: typeof envelope.app_id === 'string' ? envelope.app_id : '',
    handlerId: envelope.handler_id,
    eventType: envelope.event_type,
    eventId: typeof event.event_id === 'string' ? event.event_id
      : (typeof envelope.event_id === 'string' ? envelope.event_id : ''),
    appId: typeof event.app_id === 'string' ? event.app_id : '',
    senderOpenId: typeof senderId.open_id === 'string' ? senderId.open_id : '',
    senderType: typeof sender.sender_type === 'string' ? sender.sender_type : '',
    messageId: typeof message.message_id === 'string' ? message.message_id : '',
    chatId: typeof message.chat_id === 'string' ? message.chat_id : '',
    chatType: typeof message.chat_type === 'string' ? message.chat_type : '',
    messageType: typeof message.message_type === 'string' ? message.message_type : 'text',
    parentId: typeof message.parent_id === 'string' ? message.parent_id : '',
    rootId: typeof message.root_id === 'string' ? message.root_id : '',
    threadId: typeof message.thread_id === 'string' ? message.thread_id : '',
    rawText: renderedText,
  };
}

/**
 * Authenticate transport + app. Returns an HTTP error result or null.
 */
export function checkTransportAuth({ authorization, body }, config) {
  if (!bearerMatches(authorization, config.handlerToken)) {
    return { status: 401, body: { error: { code: 'unauthorized', message: 'bad handler bearer' } } };
  }
  const outerAppId = body?.app_id;
  if (typeof outerAppId !== 'string' || outerAppId !== config.appId) {
    return { status: 403, body: { error: { code: 'app_mismatch', message: 'outer app_id is not bound to this handler' } } };
  }
  return null;
}

/**
 * Persist a recognized `/job` exactly once and decide propagation.
 *
 * @returns {Promise<{status:number, body:object, kickSourceKey?:string}>}
 */
export async function receiveEnvelope({ body, authorization }, { config, store, worker }) {
  const authError = checkTransportAuth({ authorization, body }, config);
  if (authError) return authError;

  const env = normalizeEnvelope(body);
  if (!env || !env.eventId) return { status: 400, body: { error: { code: 'bad_event', message: 'missing event/event_id' } } };

  const aliases = [...config.projectAliases];
  const parsed = parseJobCommand(env.rawText, { defaultAlias: config.pairfob.project, aliases });
  if (parsed.kind === 'not-command') {
    // Ordinary traffic is never persisted as a job and continues to Dutydeck.
    return { status: 200, body: { event_id: env.eventId, decision: 'continue' } };
  }

  if (!env.messageId) return { status: 400, body: { error: { code: 'bad_event', message: 'missing message_id' } } };

  // Authorization disposition (computed before the transaction; sets stage).
  let stage = 'queued';
  let reasonCode = null;
  let wantsReply = false;
  if (env.senderType !== 'user' || !env.senderOpenId) {
    stage = 'denied'; reasonCode = 'non_user'; wantsReply = false;
  } else if (!env.chatId || !config.allowedChatIds.has(env.chatId)) {
    stage = 'denied'; reasonCode = 'chat_not_allowed'; wantsReply = false;
  } else if (!config.commanderOpenIds.has(env.senderOpenId)) {
    stage = 'denied'; reasonCode = 'forbidden'; wantsReply = true;
  } else if (parsed.kind === 'unknown-project') {
    stage = 'needs_input'; reasonCode = 'unknown_project'; wantsReply = true;
  }

  // Validate instruction length for authorized dispatches.
  if (stage === 'queued' && parsed.kind === 'job' && parsed.instruction.length > config.limits.maxInstructionChars) {
    stage = 'needs_input'; reasonCode = 'instruction_too_long'; wantsReply = true;
  }

  const sourceKey = sourceKeyFor(config.appId, env.messageId);
  const nowIso = new Date().toISOString();

  const outcome = await store.mutate((state) => {
    const knownEvent = state.events[env.eventId];
    if (knownEvent) {
      return { mode: 'event-duplicate', decision: knownEvent.decision ?? 'stop', sourceKey: knownEvent.sourceKey };
    }
    const existingSourceKey = state.messageIndex[env.messageId];
    if (existingSourceKey && state.jobs[existingSourceKey]) {
      state.events[env.eventId] = { eventId: env.eventId, decision: 'stop', sourceKey: existingSourceKey, at: nowIso };
      return { mode: 'message-duplicate', decision: 'stop', sourceKey: existingSourceKey };
    }

    const job = newJobRecord({ sourceKey, appId: config.appId, eventId: env.eventId, messageId: env.messageId });
    Object.assign(job, {
      chatId: env.chatId,
      chatType: env.chatType,
      threadId: env.threadId || env.rootId || null,
      rootId: env.rootId || null,
      parentId: env.parentId || null,
      replyAnchor: env.rootId || env.messageId,
      commanderOpenId: env.senderOpenId || null,
      rawText: env.rawText,
      instruction: parsed.kind === 'job' ? parsed.instruction : '',
      alias: parsed.kind === 'job' ? parsed.alias : config.pairfob.project,
      explicitTarget: parsed.kind === 'job' ? parsed.explicitTarget : false,
      stage,
      reasonCode,
    });
    if (parsed.kind === 'unknown-project') job.unknownToken = parsed.token;
    // Insert before any outbound() lookup, which reads state.jobs[sourceKey].
    state.jobs[sourceKey] = job;
    if (wantsReply) {
      const reply = store.outbound(state, sourceKey, 'denial');
      reply.status = 'pending';
    }
    state.messageIndex[env.messageId] = sourceKey;
    state.events[env.eventId] = { eventId: env.eventId, decision: 'stop', sourceKey, at: nowIso };
    return { mode: 'created', decision: 'stop', sourceKey };
  });

  // Kick background processing without blocking the <2s receipt.
  if (worker && outcome.sourceKey) {
    queueMicrotask(() => { try { void worker.kick(outcome.sourceKey); } catch { /* logged by worker */ } });
  }

  return { status: 200, body: { event_id: env.eventId, decision: outcome.decision }, kickSourceKey: outcome.sourceKey };
}
