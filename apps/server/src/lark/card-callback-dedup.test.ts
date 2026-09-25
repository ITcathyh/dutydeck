import { describe, expect, it, vi } from 'vitest';
import { LarkCardCallbackDeduper, larkCardCallbackKeys } from './card-callback-dedup.js';

describe('飞书卡片回调去重', () => {
  it('同一 event_id 的重推只处理一次，并直接拿到第一次的结果', async () => {
    const deduper = new LarkCardCallbackDeduper();
    const handle = vi.fn(async () => ({ toast: { type: 'success', content: '执行端已接受本次批准。' } }));
    const first = await deduper.run(larkCardCallbackKeys({ event_id: 'ev_1', token: 'c-1' }), handle);
    const second = await deduper.run(larkCardCallbackKeys({ event_id: 'ev_1', token: 'c-1' }), handle);
    expect(handle).toHaveBeenCalledOnce();
    expect(second).toBe(first);
  });

  it('第一次仍在处理时到达的重推等待同一个结果，不并发执行', async () => {
    const deduper = new LarkCardCallbackDeduper();
    let release!: (value: string) => void;
    const handle = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
    const first = deduper.run(['event:ev_slow'], handle);
    const second = deduper.run(['event:ev_slow'], handle);
    expect(handle).toHaveBeenCalledOnce();
    release('done');
    await expect(Promise.all([first, second])).resolves.toEqual(['done', 'done']);
  });

  it('没有事件 id 时按回调 token 去重；不同点击、缺少两者的回调都照常处理', async () => {
    const deduper = new LarkCardCallbackDeduper();
    const handle = vi.fn(async () => 'ok');
    await deduper.run(larkCardCallbackKeys({ token: 'c-same' }), handle);
    await deduper.run(larkCardCallbackKeys({ token: 'c-same' }), handle);
    expect(handle).toHaveBeenCalledTimes(1);
    await deduper.run(larkCardCallbackKeys({ event_id: 'ev_a', token: 'shared' }), handle);
    await deduper.run(larkCardCallbackKeys({ event_id: 'ev_b', token: 'shared' }), handle);
    expect(handle).toHaveBeenCalledTimes(3);
    await deduper.run(larkCardCallbackKeys({}), handle);
    await deduper.run(larkCardCallbackKeys(undefined), handle);
    expect(handle).toHaveBeenCalledTimes(5);
  });

  it('去重记录过了 TTL 就清掉，同一键再来会重新处理', async () => {
    let now = 1_000;
    const deduper = new LarkCardCallbackDeduper(60_000, () => now);
    const handle = vi.fn(async () => 'ok');
    await deduper.run(['event:ev_ttl'], handle);
    now += 59_999;
    await deduper.run(['event:ev_ttl'], handle);
    expect(handle).toHaveBeenCalledOnce();
    now += 1;
    await deduper.run(['event:ev_ttl'], handle);
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it('第一次处理失败时重推拿到同一个失败，不再执行第二遍', async () => {
    const deduper = new LarkCardCallbackDeduper();
    const handle = vi.fn(async () => { throw new Error('boom'); });
    await expect(deduper.run(['event:ev_fail'], handle)).rejects.toThrow('boom');
    await expect(deduper.run(['event:ev_fail'], handle)).rejects.toThrow('boom');
    expect(handle).toHaveBeenCalledOnce();
  });
});
