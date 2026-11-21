import { expect, it } from 'vitest';
import type { LarkTask } from './coordinator.js';
import type { StoredLarkConfig } from './config.js';
import { planTerminalDelivery, type TerminalState } from './terminal-plan.js';
import { toRecord, turnRecordSchema } from './turn-record.js';

const states: TerminalState[] = ['completed', 'failed', 'interrupted', 'cancelled'];
const sources = ['om_request', 'confirmation_approval', 'reaction_start'];
it.each(states)('live and persisted %s turns agree on the complete delivery plan', state => {
  for (const id of sources) for (const reactionOnly of [false, true]) for (const fallback of [false, true]) {
    for (const mention of [false, true]) for (const plan of [false, true]) for (const silent of [false, true]) {
      const anchor = id === 'om_request' ? id : 'om_original';
      const prompt = plan ? '/plan investigate' : 'investigate';
      const config = { appId: 'app', groupCardMention: mention, completionReactionOnly: reactionOnly } as StoredLarkConfig;
      const live: LarkTask = { id, config, prompt, state, startedAt: 1, turn: 1, resources: [], events: [],
        group: { tail: Promise.resolve() }, epoch: 0, scopeId: 'thread:om_original',
        event: { messageId: id, replyMessageId: anchor, chatId: 'chat', chatType: 'group', senderType: 'user',
          senderOpenId: 'ou_sender', threadId: 'topic', messageType: 'text', mentions: [], content: prompt },
        cardMessageId: silent ? undefined : 'om_process', fallbackNote: fallback ? 'switch' : undefined };
      const saved = turnRecordSchema.parse({ task_name: prompt, prompt, state, started_at: 1, turn: 1,
        app_id: 'app', chat_id: 'chat', chat_type: 'group', sender_type: 'user', sender_open_id: 'ou_sender',
        anchor_message_id: anchor, reply_message_id: anchor, reply_in_thread: true,
        card_message_id: silent ? undefined : 'om_process', fallback_note: fallback ? 'switch' : undefined });
      const facts = { state, now: 1000 };
      const realtime = planTerminalDelivery(toRecord(live), id, config, facts);
      expect(planTerminalDelivery(saved, id, config, facts)).toEqual(realtime);
      expect(realtime.kind).toBe(state === 'completed' && reactionOnly && !fallback && !plan ? 'reaction' : 'result');
      expect(realtime.closeProcess).toBe(!silent);
      expect(realtime.target).toEqual({ chatId: 'chat', replyMessageId: anchor, replyInThread: true });
      expect(realtime.reaction).toEqual(state === 'cancelled' ? undefined : { appId: 'app', messageId: anchor, completed: state === 'completed' });
      expect(Boolean(realtime.mention)).toBe(mention);
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
