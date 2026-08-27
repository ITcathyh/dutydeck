import * as lark from '@larksuiteoapi/node-sdk';

// 飞书群形态查询（话题群 vs 普通群）。
// 移植自 botmux 的 getChatMode：Lark 客户端允许随时把群在「普通模式/话题模式」间切换，
// 该切换写的是 group_message_type（'chat' ↔ 'thread'），而 chat_mode 是建群时的拓扑分类、
// 转换后仍保持 'group'。所以两者都要认：chat_mode === 'topic' 或 group_message_type === 'thread'
// 都判定为话题群。查询结果做进程内缓存（TTL 5 分钟），避免每条消息都打一次 OpenAPI。

export type LarkChatMode = 'topic' | 'group' | 'p2p';

interface CachedChatMode {
  mode: LarkChatMode;
  cachedAt: number;
}

const CHAT_MODE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1_000;
const chatModeCache = new Map<string, CachedChatMode>();

// 按 appId 复用 SDK Client；appSecret 轮换后自动重建。
const clients = new Map<string, { client: lark.Client; appSecret: string }>();

function chatModeClient(appId: string, appSecret: string): lark.Client {
  const existing = clients.get(appId);
  if (existing && existing.appSecret === appSecret) return existing.client;
  const client = new lark.Client({ appId, appSecret, loggerLevel: lark.LoggerLevel.warn });
  clients.set(appId, { client, appSecret });
  return client;
}

function cacheChatMode(appId: string, chatId: string, mode: LarkChatMode): LarkChatMode {
  const key = `${appId}::${chatId}`;
  chatModeCache.set(key, { mode, cachedAt: Date.now() });
  // 简单的容量上限：超限时淘汰最旧的一半，避免长生命周期进程里缓存无限增长。
  if (chatModeCache.size > MAX_CACHE_ENTRIES) {
    const overflow = chatModeCache.size - Math.floor(MAX_CACHE_ENTRIES / 2);
    let index = 0;
    for (const cacheKey of chatModeCache.keys()) {
      chatModeCache.delete(cacheKey);
      if (++index >= overflow) break;
    }
  }
  return mode;
}

/** 同步读取缓存的群形态；未缓存或已过期时返回 undefined。 */
export function getCachedChatMode(appId: string, chatId: string): LarkChatMode | undefined {
  const cached = chatModeCache.get(`${appId}::${chatId}`);
  if (cached && Date.now() - cached.cachedAt < CHAT_MODE_TTL_MS) return cached.mode;
  return undefined;
}

function parseChatMode(data: unknown): LarkChatMode | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  const rawMode = String(record.chat_mode ?? '').toLowerCase();
  const rawGroupMessageType = String(record.group_message_type ?? '').toLowerCase();
  if (rawMode === 'p2p') return 'p2p';
  if (rawMode === 'topic' || rawGroupMessageType === 'thread') return 'topic';
  if (rawMode === 'group') return 'group';
  // 空值或未来新增的枚举值：无法确认，返回 undefined 让调用方走宽容默认。
  return undefined;
}

/**
 * 查询群形态（带缓存）。宽容默认：任何无法确认的情况（网络错误、权限不足、未知枚举）
 * 都按 'group' 处理并缓存——把话题群误判成普通群（顶层平铺）比把普通群误判成话题群
 * （每条消息强拆话题）更安全，与 botmux getChatMode 的 lenient 行为一致。
 * 本函数永不抛异常。
 */
export async function getChatMode(
  appId: string,
  appSecret: string,
  chatId: string,
  options: { forceRefresh?: boolean } = {}
): Promise<LarkChatMode> {
  if (!options.forceRefresh) {
    const cached = getCachedChatMode(appId, chatId);
    if (cached) return cached;
  }
  try {
    const client = chatModeClient(appId, appSecret);
    const response = await client.im.chat.get({
      path: { chat_id: chatId },
      params: { user_id_type: 'open_id' }
    }) as { code?: number; msg?: string; data?: unknown };
    if (response && response.code !== 0) return cacheChatMode(appId, chatId, 'group');
    const mode = parseChatMode(response?.data);
    return cacheChatMode(appId, chatId, mode ?? 'group');
  } catch {
    return cacheChatMode(appId, chatId, 'group');
  }
}

/** 清空缓存（主要供测试使用）。 */
export function clearLarkChatModeCache(): void {
  chatModeCache.clear();
}
