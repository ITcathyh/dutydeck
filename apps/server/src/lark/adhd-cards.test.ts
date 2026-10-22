import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import type { RelayAskBroker } from '@dutydeck/relay';
import type { LarkRuntime } from './listener.js';
import { buildLarkCard, LarkServiceError, type LarkCardService } from './service.js';
import { LarkWorkflowInteractions, type LarkInteractionContext } from './workflow-interactions.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});
const fixedTime = new Date('2026-10-22T00:03:00.000Z');
const ctx: LarkInteractionContext = {
  appId: 'app_example', sessionId: 'session_example', taskId: 'task_example', turn: 1,
  event: { messageId: 'om_example', chatId: 'oc_example', chatType: 'group', senderOpenId: 'ou_requester',
    messageType: 'text', content: '{"text":"确认写入待办"}', mentions: [] }
};

async function harness(adhdMode: boolean, options: { multiple?: boolean; freeText?: boolean; structured?: boolean; deny?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-adhd-cards-'));
  const repos = createRepositories(join(directory, 'state.db'));
  let active = true;
  const ask = { id: 'ask_example', sessionId: ctx.sessionId, status: 'pending', question: '确认把这件事记为待办？',
    expiresAt: '2026-10-22T00:08:00.000Z', multiple: options.multiple,
    choices: options.freeText ? undefined : [{ label: '确认写入', value: 'write' }, { label: '取消', value: 'cancel' }] };
  const broker = { get: () => ask, answer: vi.fn(async () => { ask.status = 'answered'; ask.choices = undefined; }) };
  const runtime = { getTasks: async () => active ? [{ id: ctx.taskId, status: 'running' }] : [] } as unknown as LarkRuntime;
  const reply = vi.fn(async (_input: any) => ({ messageId: 'om_question' }));
  const update = vi.fn(async (_input: any) => ({}));
  const service = { reply, update } as unknown as LarkCardService;
  const warn = vi.fn();
  const create = () => {
    const workflow = new LarkWorkflowInteractions(repos.config, runtime, service, broker as unknown as RelayAskBroker,
      async () => !options.deny, { log: { warn } });
    Object.defineProperty(workflow, 'boot', { value: 'boot_example' });
    return workflow;
  };
  let workflow = create();
  cleanups.push(async () => { workflow.close(); repos.close(); await rm(directory, { recursive: true, force: true }); });
  await workflow.observe(ctx, { id: 'event_example', sessionId: ctx.sessionId, sequence: 1, timestamp: fixedTime.toISOString(),
    type: 'text', data: { relay: 'ask', askId: ask.id } }, { adhdMode, structuredAskCards: options.structured !== false });
  const record = (await workflow.list(ctx.appId))[0]!;
  const respond = (patch: Record<string, unknown> = {}) => workflow.respond({ appId: ctx.appId, chatId: ctx.event.chatId,
    actorId: 'ou_requester', requestId: record.id, action: 'answer', answer: 'write', callback: true,
    cardId: record.cardId, generation: record.boot, ...patch });
  const cancel = () => { active = false; ask.status = 'cancelled'; };
  return { repos, record, broker, reply, update, warn, respond, cancel, ask, get workflow() { return workflow; },
    restart: async () => { workflow.close(); workflow = create(); await workflow.initialize(ctx.appId); } };
}

const resultInput = (adhdMode: boolean) => ({ cardKind: 'result' as const, adhdMode, state: 'completed' as const,
  taskId: 'task_example', taskName: '记录待办', turn: 1, readOnly: true, capabilities: { canFollowUp: true },
  elements: [{ tag: 'markdown', element_id: 'final_output', content: '已记录待办。' }] });

describe('ADHD card presentation', () => {
  it('matches 825e9ee card JSON byte for byte with ADHD disabled', async () => {
    vi.useFakeTimers({ now: fixedTime });
    const snapshots: Record<string, unknown> = { result: buildLarkCard(resultInput(false)) };
    for (const [name, options] of Object.entries({ single: {}, multiple: { multiple: true }, freeText: { freeText: true }, textOnly: { structured: false } })) {
      const h = await harness(false, options);
      snapshots[`${name}_pending`] = buildLarkCard(h.reply.mock.calls[0]![0]);
      await h.respond(options.multiple ? { selected: ['write', 'cancel'] } : options.freeText ? { answer: '明天提醒我' } : {});
      snapshots[`${name}_answered`] = buildLarkCard(h.update.mock.calls.at(-1)![0]);
    }
    const h = await harness(false);
    h.cancel();
    await h.workflow.reconcile(ctx.appId);
    snapshots.cancelled = buildLarkCard(h.update.mock.calls.at(-1)![0]);
    await expect(JSON.stringify(snapshots, null, 2)).toMatchFileSnapshot('./__fixtures__/adhd-off-825e9ee.json');
  });

  it('hides the result follow-up row only with ADHD enabled', () => {
    expect(JSON.stringify(buildLarkCard(resultInput(false)))).toContain('result_follow_up_row');
    expect(JSON.stringify(buildLarkCard(resultInput(true)))).not.toContain('result_follow_up_row');
  });

  it('shows buttons without deadline or duplicate choice list, then closes to the actual label', async () => {
    vi.useFakeTimers({ now: fixedTime });
    const h = await harness(true);
    const pending = JSON.stringify(buildLarkCard(h.reply.mock.calls[0]![0]));
    expect(pending).toContain('确认写入');
    expect(pending).toContain('callback');
    expect(pending).not.toContain('回答截止时间');
    expect(pending).not.toContain('可选项：');
    await h.respond();
    expect(h.broker.answer).toHaveBeenCalledWith('ask_example', 'write', { sessionId: ctx.sessionId });
    expect(h.update.mock.calls.at(-1)![0].elements).toEqual([{ tag: 'markdown', content: '已确认写入 · <at id=ou_requester></at> · 08:03' }]);
    const answered = JSON.stringify(buildLarkCard(h.update.mock.calls.at(-1)![0]));
    expect(answered).not.toContain('callback');
    expect(answered).not.toContain('task_status');
    expect(answered.match(/已确认写入/g)).toHaveLength(1);
    expect(answered).not.toContain('确认把这件事');
    await expect(h.respond()).rejects.toMatchObject({ code: 'LARK_INTERACTION_EXPIRED' });
    expect(h.broker.answer).toHaveBeenCalledTimes(1);
  });

  it.each(['cancelled', 'expired'] as const)('closes %s asks to one short line without buttons', async status => {
    vi.useFakeTimers({ now: fixedTime });
    const h = await harness(true);
    h.cancel(); h.ask.status = status;
    await h.workflow.reconcile(ctx.appId);
    expect(h.update.mock.calls.at(-1)![0].elements).toEqual([{ tag: 'markdown', content: '已结束，未执行' }]);
    const card = JSON.stringify(buildLarkCard(h.update.mock.calls.at(-1)![0]));
    expect(card).not.toContain('callback');
    expect(card).not.toContain('回答截止时间');
    expect(card).not.toContain('此请求已失效');
    expect(card).not.toContain('task_status');
    expect(card.match(/已结束，未执行/g)).toHaveLength(1);
  });

  it('keeps free-text answers off the closed group card', async () => {
    vi.useFakeTimers({ now: fixedTime });
    const h = await harness(true, { freeText: true });
    await h.respond({ answer: 'private-secret-0123456789'.repeat(40) });
    const input = h.update.mock.calls.at(-1)![0];
    expect(input.elements).toEqual([{ tag: 'markdown', content: '已回答 · <at id=ou_requester></at> · 08:03' }]);
    expect(JSON.stringify(buildLarkCard(input))).not.toContain('private-secret');
    expect(JSON.stringify(buildLarkCard(input))).not.toContain('task_status');
  });

  it('retains readable choices when structured buttons are disabled', async () => {
    vi.useFakeTimers({ now: fixedTime });
    const h = await harness(true, { structured: false });
    expect(JSON.stringify(h.reply.mock.calls)).toContain('可选项：');
  });
});

describe('closed card recovery for every bot', () => {

  it('recovers the chosen label if the process exits after the answered state is persisted', async () => {
    vi.useFakeTimers({ now: fixedTime });
    const h = await harness(true);
    await h.respond();
    const key = `lark.interaction.${ctx.appId}.${h.record.id}`;
    const answered = (await h.workflow.list(ctx.appId))[0]!;
    expect(answered.answerLabel).toBe('确认写入');
    delete answered.closeMessage; delete answered.closeRetryAt; delete answered.closeAttempts; delete answered.cardClosedAt;
    await h.repos.config.set(key, JSON.stringify(answered));
    h.update.mockClear();
    await h.restart();
    expect(h.update.mock.calls[0]![0].elements).toEqual([{ tag: 'markdown', content: '已确认写入 · <at id=ou_requester></at> · 08:03' }]);
    expect(JSON.stringify(buildLarkCard(h.update.mock.calls[0]![0]))).not.toContain('task_status');
  });

  it.each([false, true])('retries failed answered cards without active task heartbeats (ADHD=%s)', async adhdMode => {
    vi.useFakeTimers({ now: fixedTime });
    const h = await harness(adhdMode);
    h.update.mockRejectedValueOnce(new LarkServiceError('LARK_API_ERROR', 'PATCH failed: rate limited', 502, { upstreamCode: 99991400 }));
    expect(await h.respond()).toContain('卡片状态更新失败');
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ cardId: 'om_question', code: 99991400, message: 'PATCH failed: rate limited', attempt: 1 }), expect.any(String));
    h.cancel();
    await vi.advanceTimersByTimeAsync(6_001);
    expect(h.update).toHaveBeenCalledTimes(2);
    expect((await h.workflow.list(ctx.appId))[0]).toMatchObject({ state: 'answered', closeAttempts: 2, cardClosedAt: expect.any(String) });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.update).toHaveBeenCalledTimes(2);
    expect(h.broker.answer).toHaveBeenCalledTimes(1);
  });

  it.each(['answered', 'cancelled', 'expired'] as const)('persists and resumes a failed %s close across restart', async state => {
    vi.useFakeTimers({ now: fixedTime });
    const h = await harness(false);
    h.update.mockRejectedValueOnce(new Error('temporary PATCH failure'));
    if (state === 'answered') await h.respond();
    else { h.cancel(); h.ask.status = state; await h.workflow.reconcile(ctx.appId); }
    await h.restart();
    expect(h.update).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6_001);
    expect(h.update).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(h.update.mock.calls[1]![0])).not.toContain('callback');
    await h.restart();
    expect(h.update).toHaveBeenCalledTimes(2);
  });

  it('caps attempts and warnings at five, including after restart', async () => {
    vi.useFakeTimers({ now: fixedTime });
    const h = await harness(false);
    h.update.mockRejectedValue(new Error('PATCH unavailable'));
    await h.respond(); h.cancel();
    await vi.advanceTimersByTimeAsync(38_000);
    expect(h.update).toHaveBeenCalledTimes(4);
    vi.setSystemTime(new Date(fixedTime.getTime() + 180_000));
    expect(await h.workflow.reconcile(ctx.appId)).toBe(0);
    expect(h.update).toHaveBeenCalledTimes(5);
    expect(h.warn).toHaveBeenCalledTimes(5);
    expect((await h.workflow.list(ctx.appId))[0]!.closeAttempts).toBe(5);
    expect(await h.workflow.reconcile(ctx.appId)).toBe(0);
    await h.restart();
    expect(await h.workflow.reconcile(ctx.appId)).toBe(0);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(h.update).toHaveBeenCalledTimes(5);
    expect(h.warn).toHaveBeenCalledTimes(5);
  });
});
