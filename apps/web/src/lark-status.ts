import type { LarkBotConfig } from './api';
import type { BadgeTone } from './components/primitives/Badge';

export type LarkBotStatusKey =
  | 'loading'
  | 'unknown'
  | 'incomplete'
  | 'daemon_disabled'
  | 'paused'
  | 'not_started'
  | 'listening';

export type LarkBotStatus = {
  key: LarkBotStatusKey;
  label: string;
  description: string;
  tone: BadgeTone;
};

export function projectLarkBotStatus(
  bot?: LarkBotConfig,
  listeningDisabled = false,
  loading = false,
  failed = false
): LarkBotStatus {
  if (loading) {
    return {
      key: 'loading',
      label: '状态加载中',
      description: '正在同步飞书状态…',
      tone: 'neutral'
    };
  }

  // 查询失败时状态未确认：既不能说「配置未完成」，也不能沿用缓存说「监听已启动」。
  if (failed) {
    return {
      key: 'unknown',
      label: '状态未确认',
      description: '读取飞书接入状态失败，无法确认是否能收到消息',
      tone: 'warning'
    };
  }

  if (!bot || !bot.setupComplete) {
    return {
      key: 'incomplete',
      label: '配置未完成',
      description: '尚未选择默认 Agent 或确认执行权限',
      tone: 'warning'
    };
  }

  if (listeningDisabled) {
    return {
      key: 'daemon_disabled',
      label: '本次启动禁用监听',
      description: '服务端启动参数已禁用监听',
      tone: 'warning'
    };
  }

  if (!bot.listening) {
    return {
      key: 'paused',
      label: '本实例未开启监听',
      description: '当前服务未开启此机器人的监听；若已在其他实例运行，请到对应实例查看',
      tone: 'neutral'
    };
  }

  if (!bot.activeListening) {
    return {
      key: 'not_started',
      label: '监听尚未启动',
      description: '已配置监听，但服务监听尚未启动',
      tone: 'danger'
    };
  }

  return {
    key: 'listening',
    label: '监听已启动',
    description: '监听已启动，可到飞书发送消息',
    tone: 'success'
  };
}

export function formatLarkNavSummary({
  bots,
  listeningDisabled = false,
  loading = false,
  failed = false
}: {
  bots?: LarkBotConfig[];
  listeningDisabled?: boolean;
  loading?: boolean;
  /** 查询失败：请求挂了既不能说「尚未配置」，也不能沿用旧数据说「在线」。 */
  failed?: boolean;
}): string {
  if (loading) return '正在读取接入状态…';
  // 失败优先于 bots：有缓存时 bots 非空，但这一轮 refetch 失败，状态同样未确认。
  if (failed) return bots?.length ? `${bots.length} 个机器人 · 状态未确认` : '接入状态读取失败';
  if (!bots || bots.length === 0) return '尚未配置机器人';

  const count = bots.length;
  /*
    先逐个投影，再看聚合，不在这里前置判 listeningDisabled。

    原先 listeningDisabled 是一条提前 return，与 projectLarkBotStatus 的分支顺序
    （setupComplete 先于 listeningDisabled）互相矛盾：一个未配置完成的 Bot 撞上
    全局禁用监听时，卡片说「配置未完成」、侧栏 hint 却说「本次启动禁用监听」，
    同屏两处对同一个 Bot 给出不同判据。

    两个条件本来都可能同时为真，这里修的是**判据只有一份**：聚合口径一律以投影
    结果为准，「本次启动禁用监听」只在每个 Bot 都落到 daemon_disabled 时才作为
    整体结论显示。这不表示禁用监听不算阻塞——它在 projectLarkBotStatus 里仍然
    排在 listening/activeListening 之前。
  */
  const statuses = bots.map(bot => projectLarkBotStatus(bot, listeningDisabled, false));
  const activeCount = statuses.filter(s => s.key === 'listening').length;

  if (activeCount === count) {
    return `${count} 个机器人 · 监听已启动`;
  }
  if (statuses.every(s => s.key === 'daemon_disabled')) {
    return `${count} 个机器人 · 本次启动禁用监听`;
  }
  if (statuses.every(s => s.key === 'incomplete')) {
    return `${count} 个机器人 · 配置未完成`;
  }
  if (statuses.every(s => s.key === 'paused')) {
    return `${count} 个机器人 · 本实例未开启监听`;
  }
  if (statuses.every(s => s.key === 'not_started')) {
    return `${count} 个机器人 · 监听未启动`;
  }
  return `${count} 个机器人 · ${activeCount} 个监听中`;
}

const LARK_APPLINK_PREFIX = 'lark://applink.feishu.cn/client/bot/open?appId=';

export function buildLarkBotAppLink(appId?: string): string | undefined {
  if (!appId || typeof appId !== 'string') return undefined;
  const trimmed = appId.trim();
  if (!trimmed) return undefined;
  return `${LARK_APPLINK_PREFIX}${encodeURIComponent(trimmed)}`;
}
