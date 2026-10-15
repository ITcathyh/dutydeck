import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { deliveryCoordinator } from './delivery-coordinator.fixture.js';
import { explicitFinalContext, sendExplicitFinal } from './explicit-final.js';
import { larkResultKey } from './result-delivery.js';
import { performLarkCardReconcile } from './reconciler.js';

const retryExpiredReason = '自动重试超过 1 小时仍未确认送达，已停止自动重试；结果可能已送达，也可能没有';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function harness(kind: 'plain' | 'attachment' | 'fallback' | 'explicit-record' | 'explicit-summary') {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-receipt-recovery-'));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  let businessWrites = 0;
  const answer = kind === 'attachment' ? '完整正文与中文😀\n'.repeat(5000) : 'synthetic final answer';
  const h = await deliveryCoordinator(cwd, (async (url: string, init: RequestInit) => {
    if (url.includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'synthetic', expire: 7200 });
    businessWrites++;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (kind === 'fallback' && body.uuid === larkResultKey('om_process')) {
      return Response.json({ code: 230099, msg: 'synthetic card format rejection' }, { status: 400 });
    }
    return Response.json({ code: 0, data: { message_id: body.uuid?.startsWith('result_file_') ? 'om_file'
      : body.uuid?.startsWith('result_') || body.uuid?.startsWith('final_') ? 'om_result' : 'om_process',
      file_key: 'file_fixture', image_key: 'img_fixture', reaction_id: 'reaction' } });
  }) as typeof fetch, answer);
  cleanups.push(() => h.close());
  await vi.waitFor(() => expect(h.ready()).toBe(true));
  let explicitKey: string | undefined;
  if (kind.startsWith('explicit')) {
    const row = (await h.repos.channelMappings.list('lark-card:cli_delivery_fixture'))[0]!;
    const [task] = await h.runtime.getTasks(row.sessionId);
    const context = explicitFinalContext(row, JSON.parse(row.extra!), task!.currentAttemptId)!;
    expect(context).toBeTruthy();
    await sendExplicitFinal(h.repos.config, h.service, context, answer);
    explicitKey = `lark.explicit_final.${createHash('sha256').update(JSON.stringify(context.scope)).digest('hex')}`;
  }
  h.finish();
  await vi.waitFor(async () => expect(JSON.parse((await h.repos.channelMappings.list('lark-card:cli_delivery_fixture'))[0]!.extra!).final_message_id).toBe('om_result'));
  h.coordinator.stop();
  const row = (await h.repos.channelMappings.list('lark-card:cli_delivery_fixture'))[0]!;
  const saved = JSON.parse(row.extra!);
  // Crash state: provider receipt committed, but the final mapping commit did not happen.
  await h.repos.channelMappings.save({ ...row, extra: JSON.stringify({ ...saved,
    final_message_id: undefined, final_delivery_state: undefined, final_elements: undefined, final_card_input: undefined,
    final_attachment_message_id: undefined, final_delivery_first_failed_at: Date.now() - 2 * 60 * 60_000 }) });
  let confirmedElements = saved.final_elements;
  if (explicitKey) {
    const record = JSON.parse((await h.repos.config.get(explicitKey))!);
    confirmedElements = record.elements;
    await h.repos.config.set(explicitKey, JSON.stringify({ ...record, first_attempt_at: Date.now() - 2 * 60 * 60_000,
      ...(kind === 'explicit-summary' ? { status: 'pending', message_id: undefined, elements: undefined, attachment_message_id: undefined } : {}) }));
  }
  businessWrites = 0;
  const terminalDecoration = vi.fn(async () => ({ elements: [{ tag: 'markdown', content: 'new execution decoration' }] }));
  const resultElements = vi.fn(async () => [{ tag: 'markdown', content: 'new result action' }]);
  return { ...h, row, saved, explicitKey, confirmedElements, terminalDecoration, resultElements, writes: () => businessWrites, reconcile: async () => {
    await performLarkCardReconcile({ runtime: h.runtime, service: h.service, cardMappings: h.repos.channelMappings,
      deliveryStore: h.repos.config, terminalDecoration, resultElements, log: { info() {}, warn() {}, error() {} }, channel: row.channel, config: h.config });
    return JSON.parse((await h.repos.channelMappings.get(row.channel, row.externalId))!.extra!);
  } };
}

it.each(['plain', 'attachment', 'fallback', 'explicit-record', 'explicit-summary'] as const)('restores a confirmed %s result through real reconciliation after the retry window without provider writes', async kind => {
  const h = await harness(kind);
  const restored = await h.reconcile();
  expect(h.writes()).toBe(0);
  expect(restored).toMatchObject({ final_delivery_state: 'delivered', final_message_id: 'om_result' });
  expect(restored.final_elements).toEqual(h.confirmedElements);
  expect(restored.final_card_input).toBeUndefined();
  expect(h.terminalDecoration).not.toHaveBeenCalled();
  expect(h.resultElements).not.toHaveBeenCalled();
  if (kind === 'attachment' || kind === 'fallback') expect(restored.final_attachment_message_id).toBe('om_file');
  await h.reconcile();
  expect(h.writes()).toBe(0);
});

it('does not promote an attachment-only receipt to a complete expired result', async () => {
  const h = await harness('attachment');
  await h.repos.config.set(`lark.delivery.${larkResultKey('om_process')}.summary`, 'null');
  const restored = await h.reconcile();
  expect(h.writes()).toBe(0);
  expect(restored).toMatchObject({ final_delivery_state: 'failed' });
  expect(restored.final_message_id).toBeUndefined();
});

it('rejects an expired cached summary whose elements do not match this result', async () => {
  const h = await harness('plain');
  await h.repos.config.set(`lark.delivery.${larkResultKey('om_process')}.summary`, JSON.stringify({ messageId: 'om_foreign', elements: [{ tag: 'markdown', element_id: 'final_output', content: 'foreign content' }] }));
  const restored = await h.reconcile();
  expect(h.writes()).toBe(0);
  expect(restored.final_delivery_state).toBe('failed');
  expect(restored.final_message_id).toBeUndefined();
});

it('recovers the exact historical retry-expired failure without reopening other deterministic failures', async () => {
  const h = await harness('plain');
  const current = (await h.repos.channelMappings.get(h.row.channel, h.row.externalId))!;
  const saved = JSON.parse(current.extra!);
  await h.repos.channelMappings.save({ ...current, extra: JSON.stringify({ ...saved,
    final_delivery_first_failed_at: undefined, final_delivery_state: 'failed', final_delivery_error: 'synthetic permission denied' }) });
  expect((await h.reconcile()).final_delivery_state).toBe('failed');
  expect(h.writes()).toBe(0);
  await h.repos.channelMappings.save({ ...current, extra: JSON.stringify({ ...saved,
    final_delivery_first_failed_at: undefined, final_delivery_state: 'failed', final_delivery_error: retryExpiredReason }) });
  expect(await h.reconcile()).toMatchObject({ final_delivery_state: 'delivered', final_message_id: 'om_result' });
  expect(h.writes()).toBe(0);
});

it('does not commit a recovered receipt after its persisted turn is replaced during the read', async () => {
  const h = await harness('plain');
  const get = h.repos.config.get.bind(h.repos.config);
  let replaced = false;
  vi.spyOn(h.repos.config, 'get').mockImplementation(async key => {
    if (!replaced && key === `lark.delivery.${larkResultKey('om_process')}.summary`) {
      replaced = true;
      const current = (await h.repos.channelMappings.get(h.row.channel, h.row.externalId))!;
      await h.repos.channelMappings.save({ ...current, extra: JSON.stringify({ ...JSON.parse(current.extra!), turn: 2 }) });
    }
    return get(key);
  });
  const restored = await h.reconcile();
  expect(replaced).toBe(true);
  expect(restored.turn).toBe(2);
  expect(restored.final_message_id).toBeUndefined();
  expect(h.writes()).toBe(0);
});

it('does not bypass a persisted content-audit rejection to restore a cached summary', async () => {
  const h = await harness('plain');
  await h.repos.config.set(`lark.delivery.${larkResultKey('om_process')}.audit_rejected`, '230028');
  expect((await h.reconcile()).final_delivery_state).toBe('failed');
  expect(h.writes()).toBe(0);
});

it.each([false, true])('does not reopen a failed explicit final during expired receipt recovery (audit: %s)', async audit => {
  const h = await harness('explicit-summary');
  const record = JSON.parse((await h.repos.config.get(h.explicitKey!))!);
  await h.repos.config.set(h.explicitKey!, JSON.stringify({ ...record, status: 'failed', audit_rejected: audit }));
  expect((await h.reconcile()).final_delivery_state).toBe('failed');
  expect(h.writes()).toBe(0);
});
