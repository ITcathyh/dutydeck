import assert from 'node:assert/strict';
import test from 'node:test';
import { createEchoHandler, extractP2pText, MessageDedupe } from './lark-card-echo-bot.mjs';

const event = overrides => ({
  sender: { sender_type: 'user' },
  message: {
    message_id: 'om_input',
    chat_id: 'oc_chat',
    chat_type: 'p2p',
    message_type: 'text',
    content: JSON.stringify({ text: '**你好**' }),
    ...overrides
  }
});

test('extracts only user p2p text messages', () => {
  assert.deepEqual(extractP2pText(event()), { messageId: 'om_input', chatId: 'oc_chat', text: '**你好**' });
  assert.equal(extractP2pText(event({ chat_type: 'group' })), undefined);
  assert.equal(extractP2pText(event({ message_type: 'image' })), undefined);
  assert.equal(extractP2pText(event({ content: '{broken' })), undefined);
  assert.equal(extractP2pText({ ...event(), sender: { sender_type: 'app' } }), undefined);
});

test('dedupe allows retry after failure and expires completed messages', () => {
  let now = 10;
  const dedupe = new MessageDedupe({ ttlMs: 5, now: () => now });
  assert.equal(dedupe.begin('om_1'), true);
  assert.equal(dedupe.begin('om_1'), false);
  dedupe.finish('om_1', false);
  assert.equal(dedupe.begin('om_1'), true);
  dedupe.finish('om_1', true);
  assert.equal(dedupe.begin('om_1'), false);
  now = 16;
  assert.equal(dedupe.begin('om_1'), true);
});

test('replies once with a green completed card containing the input markdown', async () => {
  const calls = [];
  const handler = createEchoHandler({
    cardClient: {
      async replyCard(messageId, card) {
        calls.push({ messageId, card });
        return { messageId: 'om_reply' };
      }
    },
    dedupe: new MessageDedupe(),
    log: {}
  });
  await Promise.all([handler(event()), handler(event())]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].messageId, 'om_input');
  assert.equal(calls[0].card.header.template, 'green');
  assert.equal(calls[0].card.body.elements[0].content, '**你好**');
});
