import { contextUsage, type ContextUsage, type RepositoryBundle } from '@dutydeck/shared';

const TTL_MS = 30_000;

/**
 * 会话列表徽标用的上下文占用：一次查询取全部会话最近一条用量事件，整体缓存 30 秒。
 * 只读事件表，不碰原生日志（那是 session-usage.ts 里单会话快照的做法，放在列表热路径上太重）。
 */
export function createSessionContexts(repos: RepositoryBundle, now: () => number = Date.now): () => Promise<ReadonlyMap<string, ContextUsage>> {
  let cached: { at: number; value: Promise<ReadonlyMap<string, ContextUsage>> } | undefined;
  return () => {
    if (cached && now() - cached.at < TTL_MS) return cached.value;
    const value = (async () => {
      const contexts = new Map<string, ContextUsage>();
      for (const row of await repos.events.listLatestContexts?.() ?? []) {
        const context = contextUsage(row.data.used, row.data.size, row.timestamp);
        if (context) contexts.set(row.sessionId, context);
      }
      return contexts;
    })();
    const entry = { at: now(), value };
    cached = entry;
    // 失败不缓存，下次轮询重试。
    value.catch(() => { if (cached === entry) cached = undefined; });
    return value;
  };
}
