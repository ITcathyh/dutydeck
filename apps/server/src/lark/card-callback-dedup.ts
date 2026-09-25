// 飞书卡片回调去重：同一次点击可能被平台重复推送（相同 event_id 或回调 token），
// 重推直接拿第一次的处理结果（第一次还在处理就等它），不把同一次点击再交给主控执行一遍。
// 记录只在内存里保留 TTL 这么久：平台重推发生在几秒到几分钟内；进程重启后的重推仍由各动作自己的 CAS 兜底。

/** 去重记录保留时长。 */
export const larkCardCallbackDedupTtlMs = 10 * 60_000;

/**
 * 回调的去重键：优先用事件 id（平台重推同一事件时 event_id 不变），没有事件 id 才退回回调 token。
 * SDK 把 header 与 event 平铺成一个对象，event.token 缺席时 token 会变成对所有事件都相同的校验 token，
 * 两个键同时参与匹配会把不同的点击误当成一次。
 */
export const larkCardCallbackKeys = (event: { event_id?: unknown; token?: unknown } | undefined) =>
  typeof event?.event_id === 'string' && event.event_id ? [`event:${event.event_id}`]
    : typeof event?.token === 'string' && event.token ? [`token:${event.token}`] : [];

export class LarkCardCallbackDeduper {
  private readonly seen = new Map<string, { expiresAt: number; result: Promise<unknown> }>();

  constructor(private readonly ttlMs = larkCardCallbackDedupTtlMs, private readonly now: () => number = Date.now) {}

  run<T>(keys: string[], handle: () => Promise<T>): Promise<T> {
    const at = this.now();
    for (const [key, entry] of this.seen) if (entry.expiresAt <= at) this.seen.delete(key);
    for (const key of keys) {
      const entry = this.seen.get(key);
      if (entry) return entry.result as Promise<T>;
    }
    const result = handle();
    for (const key of keys) this.seen.set(key, { expiresAt: at + this.ttlMs, result });
    return result;
  }
}
