// Request authentication, envelope normalization and the transactional inbox.
//
// This is the security boundary. Trust order:
//   1. handler bearer (shared secret with Dutydeck eventHandlers)
//   2. outer app_id exactly equals the configured bot app
//   3. sender is a user or bot with an open_id from the event
//   4. chat is an explicitly bound dispatch group
//   5. commander is listed by open_id, or the dispatch group allows all bots
// Failures at 1-2 are transport-level rejects. Failures at 3-5 are recognized
// `/job` commands that we stop (so Dutydeck never spawns an agent). An
// unlisted user in the bound group gets an explanatory reply. Unlisted bots
// are declined silently to avoid automated reply loops.

import { timingSafeEqual } from 'node:crypto';
import { parseJobCommand, renderMentionText, extractMessageText, isForwardedMessage, materialChoiceCode, MAX_MATERIAL_CHOICES } from './commands.mjs';
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
export function normalizeEnvelope(body, selfOpenId = '') {
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

  const messageType = typeof message.message_type === 'string' ? message.message_type : 'text';
  // Only text sent directly by the sender can be a command. Rich text and
  // other non-text messages (post/image/file/merge_forward/...) and messages
  // carrying forward provenance yield no command text, so they continue
  // through Dutydeck instead of being claimed as /job.
  const commandText = messageType === 'text' && !isForwardedMessage(message)
    ? renderMentionText(extractMessageText(messageType, message.content), mentions, selfOpenId)
    : '';

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
    messageType,
    // Real im.message.receive_v1 events carry message.create_time as a
    // millisecond string. It is the trusted command anchor used to prove a
    // no-quote forward predates the command.
    createTime: message.create_time ?? message.createTime ?? null,
    eventMessageCreateTime: message.create_time,
    parentId: typeof message.parent_id === 'string' ? message.parent_id : '',
    rootId: typeof message.root_id === 'string' ? message.root_id : '',
    threadId: typeof message.thread_id === 'string' ? message.thread_id : '',
    rawText: commandText,
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

function findMaterialSelection(state, env, appId, code) {
  const now = Date.now();
  let match;
  for (const job of Object.values(state.jobs)) {
    if (job.stage !== 'needs_input' || job.selectedMaterialId || job.pairfob || job.submit?.state !== 'idle'
      || job.appId !== appId || job.chatId !== env.chatId || job.commanderOpenId !== env.senderOpenId
      || job.threadId !== env.threadId || (job.rootId && env.rootId && job.rootId !== env.rootId)
      || !(job.materialChoicesExpireAt > now) || !Array.isArray(job.materialChoices)) continue;
    for (const choice of job.materialChoices.slice(0, MAX_MATERIAL_CHOICES)) {
      if (materialChoiceCode(job.sourceKey, choice.messageId) !== code) continue;
      if (match) return undefined; // A short-code collision cannot resolve a job.
      match = { job, messageId: choice.messageId };
    }
  }
  return match;
}

function messageCreatedSince(value, since) {
  const time = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  return Number.isSafeInteger(time) && time > 0 && time >= since;
}

/**
 * Persist a recognized `/job` exactly once and decide propagation.
 *
 * @returns {Promise<{status:number, body:object, kickSourceKey?:string}>}
 */
export async function receiveEnvelope({ body, authorization }, { config, store, worker }) {
  const authError = checkTransportAuth({ authorization, body }, config);
  if (authError) return authError;

  const env = normalizeEnvelope(body, config.selfOpenId);
  if (!env || !env.eventId) return { status: 400, body: { error: { code: 'bad_event', message: 'missing event/event_id' } } };

  const aliases = [...config.projectAliases];
  const parsed = parseJobCommand(env.rawText, { defaultAlias: config.pairfob.project, aliases });
  if (parsed.kind === 'not-command') {
    // Ordinary traffic is never persisted as a job and continues to Dutydeck.
    return { status: 200, body: { event_id: env.eventId, decision: 'continue' } };
  }

  const userSender = env.senderType === 'user';
  const botSender = env.senderType === 'app' || env.senderType === 'bot';
  const botAllowed = botSender && config.allowAllBotCommanders === true
    && (env.chatType === 'group' || env.chatType === 'topic_group');
  const senderIdentified = Boolean(env.senderOpenId.trim());
  const dispatchChat = env.chatId && config.allowedChatIds.has(env.chatId);
  const commanderListed = config.commanderOpenIds.has(env.senderOpenId);
  const since = config.additionalBotCommandsSince;
  if (since !== undefined && (!botAllowed || !senderIdentified || !dispatchChat || commanderListed
    || !messageCreatedSince(env.eventMessageCreateTime, since))) {
    return { status: 200, body: { event_id: env.eventId, decision: 'continue' } };
  }

  if (!env.messageId) return { status: 400, body: { error: { code: 'bad_event', message: 'missing message_id' } } };

  // Authorization disposition (computed before the transaction; sets stage).
  let stage = 'queued';
  let reasonCode = null;
  let wantsReply = false;
  if ((!userSender && !botSender) || !senderIdentified) {
    stage = 'denied'; reasonCode = 'invalid_sender';
  } else if (!dispatchChat) {
    stage = 'denied'; reasonCode = 'chat_not_allowed';
  } else if (!botAllowed && !commanderListed) {
    stage = 'denied'; reasonCode = 'forbidden'; wantsReply = userSender;
  } else if (parsed.kind === 'unknown-project') {
    stage = 'needs_input'; reasonCode = 'unknown_project'; wantsReply = true;
  }

  // Validate instruction length for authorized dispatches. The upstream contract
  // counts Unicode code points, not UTF-16 units.
  const instructionCodePoints = parsed.kind === 'job' ? Array.from(parsed.instruction).length : 0;
  if (stage === 'queued' && parsed.kind === 'job' && instructionCodePoints > config.limits.maxInstructionChars) {
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

    if (parsed.kind === 'select-material' && stage === 'queued') {
      // A flat group quote can carry the topic root ID. Only the native topic
      // ID on this authenticated selection event proves it is a topic reply.
      const inTopic = env.threadId.startsWith('omt_') && env.threadId.length > 4;
      const selected = parsed.code && inTopic ? findMaterialSelection(state, env, config.appId, parsed.code) : undefined;
      if (selected) {
        const { job, messageId } = selected;
        job.selectedMaterialId = messageId;
        job.stage = 'queued';
        job.reasonCode = null;
        job.reasonDetail = null;
        job.nextRunAt = 0;
        job.updatedAt = nowIso;
        if (job.replies.need) job.replies.need.supersededAt = nowIso;
        state.messageIndex[env.messageId] = job.sourceKey;
        state.events[env.eventId] = { eventId: env.eventId, decision: 'stop', sourceKey: job.sourceKey, at: nowIso };
        return { mode: 'material-selected', decision: 'stop', sourceKey: job.sourceKey };
      }
      stage = 'denied';
      reasonCode = inTopic ? 'selection_unavailable' : 'selection_topic_required';
      if (!parsed.code) reasonCode = 'selection_usage';
      wantsReply = true;
    }

    const job = newJobRecord({ sourceKey, appId: config.appId, eventId: env.eventId, messageId: env.messageId });
    Object.assign(job, {
      chatId: env.chatId,
      chatType: env.chatType,
      threadId: env.threadId || env.rootId || null,
      rootId: env.rootId || null,
      parentId: env.parentId || null,
      commandCreateTime: env.createTime === null || env.createTime === undefined ? null : String(env.createTime),
      replyAnchor: parsed.kind === 'select-material' ? env.messageId : env.rootId || env.messageId,
      commanderOpenId: env.senderOpenId || null,
      commanderSenderType: env.senderType,
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
