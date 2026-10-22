import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { LarkWorkflowInteractions, type LarkInteraction } from './workflow-interactions.js';
import { LarkServiceError, type LarkCardService } from './service.js';
import type { LarkRuntime } from './listener.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.useRealTimers(); });
const harness = async (kind: 'ask' | 'permission' | 'plan' = 'ask') => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-22T04:45:00Z'));
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-deferred-card-close-'));
  const repos = createRepositories(join(directory, 'state.db'));
  cleanups.push(async () => { repos.close(); await rm(directory, { recursive: true, force: true }); });
  const record: LarkInteraction = { id: 'request_one', appId: 'app_one', sessionId: 'ses_one', taskId: 'task_one', turn: 1,
    boot: 'boot_one', kind, nativeId: 'native_one', question: '继续吗？', state: 'pending', cardId: 'om_card', updatedAt: new Date().toISOString(),
    event: { messageId: 'om_request', chatId: 'oc_chat', chatType: 'group', messageType: 'text', content: '{"text":"原请求"}', senderOpenId: 'ou_owner', mentions: [] },
    ...(kind === 'ask' ? { adhdMode: true, durable: { choices: [{ label: '确认' }], snapshot: { prompt: '原请求', cwd: '/tmp', scopeId: 'scope_one' } } } : { expiresAt: '2026-10-23T04:45:00Z' }) };
  const key = `lark.interaction.${record.appId}.${record.id}`;
  await repos.config.set(key, JSON.stringify(record));
  const update = vi.fn(async () => ({}));
  const seed = vi.fn(async (_record: LarkInteraction) => undefined);
  const warn = vi.fn();
  const runtime = { getTasks: async () => [{ id: record.taskId, status: kind === 'plan' ? 'completed' : 'running', createdAt: new Date().toISOString() }],
    getPendingPermissions: async () => [{ id: record.nativeId, status: 'pending' }], resolvePermission: vi.fn(async () => true) } as unknown as LarkRuntime;
  const make = () => {
    const workflow = new LarkWorkflowInteractions(repos.config, runtime, { update } as unknown as LarkCardService, undefined, async () => true,
      { onConfirmation: seed, onPlanDecision: seed, confirmationAvailable: async () => true, log: { warn } });
    Object.defineProperty(workflow, 'boot', { value: 'boot_one' });
    cleanups.push(() => workflow.close());
    return workflow;
  };
  const response = { appId: record.appId, chatId: record.event.chatId, actorId: 'ou_owner', requestId: record.id,
    action: kind === 'ask' ? 'answer' as const : kind === 'plan' ? 'plan_approve' as const : 'approve' as const,
    answer: '确认', callback: true, deferClose: true, cardId: record.cardId, generation: record.boot };
  return { workflow: make(), make, repos, record, key, update, seed, warn, runtime, response };
};

it.each(['ask', 'permission', 'plan'] as const)('returns the %s Toast with persisted outcome and closes only after 1000ms', async kind => {
  const h = await harness(kind);
  expect(await h.workflow.respond(h.response)).toEqual(expect.any(String));
  expect((await h.workflow.list(h.record.appId))[0]).toMatchObject({ state: kind === 'ask' ? 'answered' : 'approved', closeMessage: expect.any(String) });
  expect(h.update).not.toHaveBeenCalled();
  await h.workflow.reconcile(h.record.appId);
  await vi.advanceTimersByTimeAsync(999);
  expect(h.update).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.update).toHaveBeenCalledOnce();
  expect((await h.workflow.list(h.record.appId))[0]!.cardClosedAt).toEqual(expect.any(String));
});

it('does not release a slow confirmation when a concurrent stale callback finishes first', async () => {
  const h = await harness();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  h.seed.mockImplementation(async () => blocked);
  const first = h.workflow.respond(h.response);
  await vi.waitFor(() => expect(h.seed).toHaveBeenCalledOnce());
  await expect(h.workflow.respond(h.response)).resolves.toBe('已登记，请勿重复确认。');
  await vi.advanceTimersByTimeAsync(1000);
  await h.workflow.reconcile(h.record.appId);
  expect(h.update).not.toHaveBeenCalled();
  release();
  await first;
  await vi.advanceTimersByTimeAsync(999);
  expect(h.update).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.update).toHaveBeenCalledOnce();
  expect(h.seed).toHaveBeenCalledOnce();
});

it('clears the delayed close on stop and repairs the persisted outcome on initialize', async () => {
  const h = await harness();
  await h.workflow.respond(h.response);
  h.workflow.close();
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.update).not.toHaveBeenCalled();
  await h.make().initialize(h.record.appId);
  expect(h.update).toHaveBeenCalledOnce();
  expect(h.seed).toHaveBeenCalledOnce();
});

it('keeps direct permission decisions inline without changing callback identity checks', async () => {
  const h = await harness('permission');
  await h.workflow.respond({ ...h.response, deferClose: false });
  expect(h.update).toHaveBeenCalledOnce();
});

it('preserves platform-error warnings and the five-attempt close limit after the delay', async () => {
  const h = await harness();
  h.update.mockRejectedValue(new LarkServiceError('LARK_API_ERROR', 'platform rejected PATCH', 400, { upstreamCode: 230099 }));
  await h.workflow.respond(h.response);
  expect(h.warn).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ cardId: 'om_card', code: 230099, message: 'platform rejected PATCH' }), expect.any(String));
  for (let index = 0; index < 8; index++) {
    const current = (await h.workflow.list(h.record.appId))[0]!;
    await h.repos.config.set(h.key, JSON.stringify({ ...current, closeRetryAt: 0 }));
    await h.workflow.reconcile(h.record.appId);
  }
  expect(h.update).toHaveBeenCalledTimes(5);
  expect((await h.workflow.list(h.record.appId))[0]!.closeAttempts).toBe(5);
});
