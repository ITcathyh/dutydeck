import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAgentCard, AgentCardTurn } from './lark-agent-card.mjs';

test('running card passes caller Markdown through unchanged', () => {
  const markdown = '### 自定义阶段\n\n🟡 用户自己决定状态展示\n\n`a very long command --without-dockmux-truncation`';
  const card = buildAgentCard({
    taskName: 'Agent Debug',
    taskId: '18779161860',
    elapsedSeconds: 35,
    markdown
  });
  assert.equal(card.schema, '2.0');
  assert.equal(card.header.template, 'violet');
  assert.equal(card.header.title.content, '🏗️ Dockmux 正在执行');
  assert.equal(card.header.subtitle.content, 'Agent Debug');
  assert.equal(card.body.elements[0].content, markdown);
  const footer = card.body.elements[2];
  assert.equal(footer.tag, 'column_set');
  assert.equal(footer.columns[1].width, '80px');
  assert.deepEqual(footer.columns[1].elements[0], {
    tag: 'button',
    text: { tag: 'plain_text', content: '中断' },
    type: 'danger',
    size: 'small',
    behaviors: [{ type: 'callback', value: { action: 'interrupt', task_id: '18779161860' } }],
    margin: '0px',
    element_id: 'interrupt'
  });
  assert.match(footer.columns[0].elements[0].content, /任务 #18779161860 · 已用时 35s/);
});

test('completed card contains only the final reply', () => {
  const card = buildAgentCard({
    agentName: 'Business Agent',
    state: 'completed',
    taskName: 'Agent Debug',
    taskId: '18779161860',
    elapsedSeconds: 35,
    markdown: '**最终回复**\n\n- 第一项\n- 第二项\n\n`build` 已通过。'
  });
  assert.equal(card.header.template, 'green');
  assert.equal(card.header.title.content, '✅ Business Agent 已完成');
  assert.equal(card.body.elements[0].content, '**最终回复**\n\n- 第一项\n- 第二项\n\n`build` 已通过。');
  assert.equal(card.body.elements[2].columns.length, 1);
});

test('one turn updates the same card and clears its timer', async () => {
  const calls = [];
  const client = {
    async sendCard() { calls.push(['send']); return { messageId: 'om_test', chatId: 'oc_test' }; },
    async updateCard(messageId, card) { calls.push(['update', messageId, card.header.template]); }
  };
  const turn = new AgentCardTurn(client, { receiveId: 'user@example.com', taskName: 'Task', taskId: '1', refreshIntervalMs: 10 });
  await turn.start('starting');
  turn.setMarkdown('done');
  await new Promise(resolve => setTimeout(resolve, 20));
  await turn.complete('final');
  assert.deepEqual(calls[0], ['send']);
  assert.ok(calls.some(call => call[0] === 'update' && call[1] === 'om_test' && call[2] === 'violet'));
  assert.deepEqual(calls.at(-1), ['update', 'om_test', 'green']);
  assert.equal(turn.timer, undefined);
});
