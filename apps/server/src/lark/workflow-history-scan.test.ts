import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { LarkWorkflowInteractions, type LarkInteraction } from './workflow-interactions.js';
import type { LarkCardService } from './service.js';
import type { LarkRuntime } from './listener.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.useRealTimers(); });
const harness = async (count: number) => {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-card-history-'));
  const repos = createRepositories(join(directory, 'state.db'));
  cleanups.push(async () => { repos.close(); await rm(directory, { recursive: true, force: true }); });
  const record: LarkInteraction = { id: 'history', appId: 'app', sessionId: 'session', taskId: 'task', turn: 1,
    boot: 'previous', kind: 'permission', nativeId: 'native', question: '继续吗？', state: 'approved', cardId: 'card',
    updatedAt: new Date().toISOString(), closeMessage: 'Approved', cardClosedAt: new Date().toISOString(),
    event: { messageId: 'request', chatId: 'chat', chatType: 'p2p', messageType: 'text', content: '', mentions: [] } };
  const save = (value: LarkInteraction) => repos.config.set(`lark.interaction.app.${value.id}`, JSON.stringify(value));
  for (let index = 0; index < count; index++) await save({ ...record, id: `history_${index}`, cardId: `card_${index}` });
  const update = vi.fn(async (_input: { messageId: string }) => ({}));
  const workflow = new LarkWorkflowInteractions(repos.config, {} as LarkRuntime, { update } as unknown as LarkCardService, undefined, async () => true);
  cleanups.push(() => workflow.close());
  return { repos, record, save, update, workflow };
};

it.each([100, 1000])('reads %i persisted closed cards a constant number of times during startup and reconciliation', async count => {
  const h = await harness(count);
  const list = vi.spyOn(h.repos.config, 'list'), get = vi.spyOn(h.repos.config, 'get');
  await h.workflow.initialize('app');
  expect(list).toHaveBeenCalledTimes(2);
  expect(get).toHaveBeenCalledTimes(count);
  expect(h.update).not.toHaveBeenCalled();
  list.mockClear();
  get.mockClear();
  await h.workflow.reconcile('app');
  expect(list).toHaveBeenCalledTimes(2);
  expect(get).toHaveBeenCalledTimes(count);
  expect(h.update).not.toHaveBeenCalled();
});

it('keeps retrying failed closures alongside history, successful cards, backoff and exhausted cards', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-22T04:45:00Z'));
  const h = await harness(100);
  const pending = { ...h.record, cardClosedAt: undefined };
  await h.save({ ...pending, id: 'success', cardId: 'success' });
  await h.save({ ...pending, id: 'failure', cardId: 'failure' });
  await h.save({ ...pending, id: 'backoff', cardId: 'backoff', closeAttempts: 1, closeRetryAt: Date.now() + 20_000 });
  await h.save({ ...pending, id: 'exhausted', cardId: 'exhausted', closeAttempts: 5 });
  h.update.mockImplementation(async input => { if (input.messageId === 'failure') throw new Error('Temporary PATCH failure'); return {}; });
  const list = vi.spyOn(h.repos.config, 'list');
  await h.workflow.initialize('app');
  expect(list.mock.calls.length).toBeLessThanOrEqual(4);
  expect(h.update.mock.calls.map(([input]) => input.messageId)).toEqual(['failure', 'success']);
  expect(JSON.parse((await h.repos.config.get('lark.interaction.app.failure'))!)).toMatchObject({ closeAttempts: 1, closeRetryAt: Date.now() + 5000 });
  await vi.advanceTimersByTimeAsync(5999);
  expect(h.update).toHaveBeenCalledTimes(2);
  h.update.mockImplementation(async () => ({}));
  await vi.advanceTimersByTimeAsync(1);
  expect(h.update.mock.calls.map(([input]) => input.messageId)).toEqual(['failure', 'success', 'failure']);
  expect(JSON.parse((await h.repos.config.get('lark.interaction.app.failure'))!)).toMatchObject({ closeAttempts: 2, cardClosedAt: expect.any(String) });
  await vi.advanceTimersByTimeAsync(15_000);
  expect(h.update.mock.calls.map(([input]) => input.messageId)).toEqual(['failure', 'success', 'failure', 'backoff']);
  h.workflow.close();
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps the failed card retry scheduled when a concurrent successful close finishes later', async () => {
  vi.useFakeTimers();
  const h = await harness(0);
  const success = { ...h.record, id: 'success', cardId: 'success', cardClosedAt: undefined };
  const failure = { ...h.record, id: 'failure', cardId: 'failure', cardClosedAt: undefined };
  await h.save(success);
  await h.save(failure);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  h.update.mockImplementation(async input => { if (input.messageId === 'success') await blocked; else throw new Error('Temporary PATCH failure'); return {}; });
  const closing = (h.workflow as any).renderClosed(success, 'Approved');
  expect(await (h.workflow as any).renderClosed(failure, 'Approved')).toBe(false);
  release();
  expect(await closing).toBe(true);
  expect(vi.getTimerCount()).toBe(1);
  h.update.mockImplementation(async () => ({}));
  await vi.advanceTimersByTimeAsync(6000);
  expect(h.update.mock.calls.filter(([input]) => input.messageId === 'failure')).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not restore the plan timer when stopped during the authoritative schedule read', async () => {
  vi.useFakeTimers();
  const h = await harness(0);
  await h.save({ ...h.record, kind: 'plan', state: 'pending', cardClosedAt: undefined, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  const list = h.repos.config.list!.bind(h.repos.config);
  vi.spyOn(h.repos.config, 'list').mockImplementation(async prefix => {
    const rows = await list(prefix);
    h.workflow.close();
    return rows;
  });
  await (h.workflow as any).schedulePlanCheck('app');
  expect(vi.getTimerCount()).toBe(0);
});
