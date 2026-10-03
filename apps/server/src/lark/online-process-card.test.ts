import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OnlineProcessCard } from './online-process-card.js';
import { LarkServiceError, type LarkCardService } from './service.js';

const wait = vi.hoisted(() => vi.fn(async (_ms: number, _value?: unknown, _options?: unknown) => {}));
vi.mock('node:timers/promises', () => ({ setTimeout: wait }));
type CardUpdate = Parameters<LarkCardService['update']>[0];
const frame = (state: 'queued' | 'running' | 'completed' | 'cancelled', markdown = state) => ({ messageId: 'card', state, markdown });
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const upstream = (code: number) => new LarkServiceError('LARK_OPENAPI_ERROR', 'upstream failure', 502, { upstreamCode: code });
const fixture = () => {
  let current = true;
  const update = vi.fn(async (_input: CardUpdate) => ({ messageId: 'card' }));
  const report = vi.fn(async (_delivery: unknown) => {});
  const card = new OnlineProcessCard({ service: { update }, messageId: 'card', isCurrent: () => current, report });
  return { card, update, report, expire: () => { current = false; } };
};
beforeEach(() => { wait.mockReset().mockResolvedValue(undefined); });

describe('online process card delivery', () => {
  it('coalesces pending frames, settles every waiter, and keeps terminal ahead of late heartbeats', async () => {
    const f = fixture();
    const gate = deferred();
    f.update.mockImplementationOnce(async () => { await gate.promise; return { messageId: 'card' }; });
    const first = f.card.update(frame('running'));
    const superseded = f.card.update(frame('queued'));
    const terminal = f.card.update(frame('completed'));
    await expect(superseded).resolves.toEqual({ delivered: false });
    await expect(f.card.update(frame('running'))).resolves.toEqual({ delivered: false });
    gate.resolve();
    await expect(first).resolves.toMatchObject({ delivered: true });
    await expect(terminal).resolves.toEqual({ delivered: true, messageId: 'card' });
    expect(f.update.mock.calls.map(([input]) => input.state)).toEqual(['running', 'completed']);
    await expect(f.card.update(frame('completed'))).resolves.toEqual({ delivered: false });
  });

  it.each(['success', 'unupdatable'] as const)('does not report a stale in-flight %s or deliver its pending frame', async result => {
    const f = fixture();
    const gate = deferred();
    f.update.mockImplementationOnce(async () => { await gate.promise; return { messageId: 'card' }; });
    const first = f.card.update(frame('running'));
    const pending = f.card.update(frame('completed'));
    f.expire();
    if (result === 'success') gate.resolve(); else gate.reject(upstream(230031));
    await expect(first).resolves.toMatchObject({ delivered: result === 'success' });
    await expect(pending).resolves.toEqual({ delivered: false });
    expect(f.report).not.toHaveBeenCalled();
    expect(f.update).toHaveBeenCalledTimes(1);
  });

  it('stops retrying a terminal when the turn expires during backoff', async () => {
    const f = fixture();
    const gate = deferred();
    f.update.mockRejectedValueOnce(new Error('network'));
    wait.mockImplementationOnce(() => gate.promise);
    const terminal = f.card.update(frame('completed'));
    await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce());
    f.expire(); gate.resolve();
    await expect(terminal).resolves.toMatchObject({ delivered: false });
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(f.report).not.toHaveBeenCalled();
  });

  it('shares rate limiting between queued and terminal frames with a finite retry budget', async () => {
    const f = fixture();
    f.update.mockRejectedValue(upstream(230020));
    await expect(f.card.update(frame('queued'))).resolves.toMatchObject({ delivered: false });
    await expect(f.card.update(frame('completed'))).resolves.toMatchObject({ delivered: false });
    expect(f.update).toHaveBeenCalledTimes(4);
    expect(wait.mock.calls.map(([ms]) => Math.round(ms / 1_000))).toEqual([5, 10, 20]);
    expect(f.report).toHaveBeenLastCalledWith(expect.objectContaining({ frozen: false }));
  });

  it('drops a waiting heartbeat once a terminal arrives during rate-limit cooldown', async () => {
    const f = fixture();
    f.update.mockRejectedValueOnce(upstream(230020));
    await f.card.update(frame('running'));
    const gate = deferred();
    wait.mockImplementationOnce(() => gate.promise);
    const heartbeat = f.card.update(frame('running'));
    const terminal = f.card.update(frame('completed'));
    gate.resolve();
    await expect(heartbeat).resolves.toEqual({ delivered: false });
    await expect(terminal).resolves.toMatchObject({ delivered: true });
    expect(f.update.mock.calls.map(([input]) => input.state)).toEqual(['running', 'completed']);
  });

  it('does not retry once the shared HTTP request budget is exhausted', async () => {
    const f = fixture();
    f.update.mockRejectedValue(Object.assign(new Error('budget exhausted'), { larkRequestExhausted: true }));
    await expect(f.card.update(frame('completed'))).resolves.toMatchObject({ delivered: false });
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('runs terminal retries inside one shared HTTP request budget', async () => {
    const update = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue({ messageId: 'card' });
    const withRequestBudget = vi.fn(async (operation: (signal: AbortSignal) => Promise<void>) => operation(new AbortController().signal));
    const card = new OnlineProcessCard({ service: { update, withRequestBudget }, messageId: 'card', isCurrent: () => true, report: vi.fn() });
    await expect(card.update(frame('completed'))).resolves.toMatchObject({ delivered: true });
    expect(withRequestBudget).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('keeps successful delivery when its persistence report fails', async () => {
    const f = fixture();
    f.report.mockRejectedValueOnce(new Error('database locked'));
    await expect(f.card.update(frame('completed'))).resolves.toEqual({ delivered: true, messageId: 'card' });
    await expect(f.card.update(frame('running'))).resolves.toEqual({ delivered: false });
  });

  it('repairs rejected content in place and excludes transient queue counts from the retained snapshot', async () => {
    const f = fixture();
    await f.card.update({ ...frame('running'), elements: [
      { tag: 'markdown', element_id: 'progress', content: 'accepted' },
      { tag: 'markdown', element_id: 'queue_summary', content: '排队 2 条' }
    ] });
    f.update.mockRejectedValueOnce(upstream(230099));
    await expect(f.card.update(frame('completed'))).resolves.toMatchObject({ delivered: true });
    const repaired = f.update.mock.calls.at(-1)![0];
    expect(repaired.messageId).toBe('card');
    expect(JSON.stringify(repaired.elements)).toContain('accepted');
    expect(JSON.stringify(repaired.elements)).not.toContain('排队 2 条');
    expect(f.report).toHaveBeenLastCalledWith(expect.objectContaining({ repaired: true, frozen: true }));
  });

  it('serializes an absorbed receipt after an in-flight PATCH and rejects later ordinary terminal frames', async () => {
    const f = fixture();
    const gate = deferred();
    f.update.mockImplementationOnce(async () => { await gate.promise; return { messageId: 'card' }; });
    const first = f.card.update(frame('queued'));
    const pending = f.card.update(frame('cancelled'));
    const receipt = f.card.rewriteReceipt({ ...frame('cancelled'), markdown: '已并入下一条' });
    await expect(pending).resolves.toEqual({ delivered: false });
    await expect(f.card.update(frame('cancelled'))).resolves.toEqual({ delivered: false });
    gate.resolve();
    await first;
    await expect(receipt).resolves.toMatchObject({ delivered: true });
    expect(f.update.mock.calls.at(-1)![0].markdown).toBe('已并入下一条');
    expect(f.report).toHaveBeenCalledOnce();
  });

  it('allows a frozen cancelled card to become a receipt but never retries a permanently unupdatable card', async () => {
    const f = fixture();
    await f.card.update(frame('cancelled'));
    await expect(f.card.rewriteReceipt(frame('cancelled'))).resolves.toMatchObject({ delivered: true });
    const missing = fixture();
    missing.update.mockRejectedValue(upstream(230031));
    await missing.card.update(frame('queued'));
    await expect(missing.card.rewriteReceipt(frame('cancelled'))).resolves.toEqual({ delivered: false });
    expect(missing.update).toHaveBeenCalledOnce();
  });
});
