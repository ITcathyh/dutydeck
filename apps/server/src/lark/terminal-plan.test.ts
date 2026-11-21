import { expect, it } from 'vitest';
import type { LarkTask } from './coordinator.js';
import type { StoredLarkConfig } from './config.js';
import { planTerminalDelivery, type TerminalState } from './terminal-plan.js';
import { toRecord, turnRecordSchema } from './turn-record.js';

const states: TerminalState[] = ['completed', 'failed', 'interrupted', 'cancelled'];
const sources = ['om_request', 'confirmation_approval', 'reaction_start'];
it.each(states.flatMap(state => (['p2p', 'group'] as const).map(chatType => ({ state, chatType }))))('live and persisted $chatType $state turns agree with live delivery', ({ state, chatType }) => {
  const grouped = chatType === 'group';
  for (const id of sources) for (const reactionOnly of [false, true]) for (const fallback of [false, true]) {
    for (const mention of [false, true]) for (const plan of [false, true]) for (const silent of [false, true]) {
      const anchor = id === 'om_request' ? id : 'om_original';
      const prompt = plan ? '/plan investigate' : 'investigate';
      const config = { appId: 'app', groupCardMention: mention, completionReactionOnly: reactionOnly } as StoredLarkConfig;
      const live: LarkTask = { id, config, prompt, state, startedAt: 1, turn: 1, resources: [], events: [],
        group: { tail: Promise.resolve() }, epoch: 0, scopeId: 'thread:om_original',
        event: { messageId: id, replyMessageId: anchor, chatId: 'chat', chatType, senderType: 'user',
          senderOpenId: 'ou_sender', threadId: grouped ? 'topic' : undefined, messageType: 'text', mentions: [], content: prompt },
        cardMessageId: silent ? undefined : 'om_process', fallbackNote: fallback ? 'switch' : undefined };
      const saved = turnRecordSchema.parse({ task_name: prompt, prompt, state, started_at: 1, turn: 1,
        app_id: 'app', chat_id: 'chat', chat_type: chatType, sender_type: 'user', sender_open_id: 'ou_sender',
        anchor_message_id: anchor, reply_message_id: anchor, reply_in_thread: grouped || undefined,
        card_message_id: silent ? undefined : 'om_process', fallback_note: fallback ? 'switch' : undefined });
      const facts = { state, now: 1000, agentName: 'Test agent' };
      const realtime = planTerminalDelivery(toRecord(live), id, config, facts);
      expect(planTerminalDelivery(saved, id, config, facts)).toEqual(realtime);
      expect(realtime.kind).toBe(state === 'completed' && reactionOnly && !fallback && !plan ? 'reaction' : 'result');
      expect(realtime.closeProcess).toBe(!silent);
      expect(realtime.target).toEqual(grouped ? { chatId: 'chat', replyMessageId: anchor, replyInThread: true } : { chatId: 'chat' });
      expect(realtime.resultOptions).toEqual({ state, agentName: facts.agentName });
      expect(realtime.resultFollows).toBe(state !== 'completed' || !reactionOnly);
      expect(realtime.polish).toBe(state === 'completed' && !plan);
      expect(realtime.reaction).toEqual(state === 'cancelled' ? undefined : { appId: 'app', messageId: anchor, completed: state === 'completed' });
      expect(Boolean(realtime.mention)).toBe(grouped && mention);
      expect(realtime.fallbackElements.length).toBe(fallback ? 1 : 0);
    }
  }
});

it('keeps explicit results, confirmed receipts, quiet closures and unfinished delivery distinct', () => {
  const record = turnRecordSchema.parse({ app_id: 'app', chat_id: 'chat', task_name: 'task', prompt: 'task', state: 'completed', started_at: 1 });
  const config = { completionReactionOnly: true } as StoredLarkConfig;
  const result = (facts: Partial<Parameters<typeof planTerminalDelivery>[3]>, patch = {}) =>
    planTerminalDelivery({ ...record, ...patch }, 'om_key', config, { state: 'completed', now: 1, ...facts });
  expect(result({ explicit: true })).toMatchObject({ kind: 'result', polish: false });
  expect(result({ hasReport: true }).kind).toBe('result');
  expect(result({ receiptOnly: true })).toMatchObject({ kind: 'receipt_only', reaction: undefined });
  expect(result({ quiet: true })).toMatchObject({ kind: 'quiet', resultFollows: false });
  expect(result({}, { final_delivery_state: 'reaction' })).toMatchObject({ kind: 'delivered', reaction: undefined });
  expect(result({ resultDue: false }).kind).toBe('wait');
  expect(result({ state: 'interrupted', interruptedByUser: true })).toMatchObject({ kind: 'result', reaction: undefined });
});
