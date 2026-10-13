// 飞书出站消息的提醒分档：每条消息要不要 @ 发起人、能不能加急，都从这里一处决定。
// 新增一类出站消息，先在 noticeTiers 里定档；调用方只读本函数的结论，不再各自拼开关。
import { isBotSenderType, isGroupChat, senderGroupMention } from './card-mentions.js';

/**
 * action：需要用户动手（审批、提问、结果未知待处理）——@ 发起人，久无人处理可加急。
 * done：任务已有结果（完成或失败）——@ 发起人，不加急。
 * info：进度、状态更新——不 @，不加急。
 */
export type LarkNoticeTier = 'action' | 'done' | 'info';

export type LarkNoticeKind =
  | 'permission_card' | 'ask_card' | 'unknown_task_notice' | 'task_recovery_notice'
  | 'result' | 'failure_receipt'
  | 'progress' | 'status';

const noticeTiers: Record<LarkNoticeKind, LarkNoticeTier> = {
  permission_card: 'action', ask_card: 'action', unknown_task_notice: 'action', task_recovery_notice: 'action',
  result: 'done', failure_receipt: 'done',
  progress: 'info', status: 'info'
};

/** 提醒分档相关的 Bot 设置；StoredLarkConfig 满足这个形状，缺省字段按默认值处理。 */
export interface LarkNoticeSettings {
  /** 群卡片 @ 总开关（可按群覆盖）；关闭后任何档位都不 @。 */
  groupCardMention?: boolean;
  /** action 档是否 @，缺省开启。 */
  notifyMentionAction?: boolean;
  /** done 档是否 @，缺省开启。 */
  notifyMentionDone?: boolean;
  /** 免打扰时段，形如 22:00-08:00，按 daemon 本地时区，可跨零点；缺省不启用。 */
  notifyQuietHours?: string;
}

export interface LarkNoticeDecision {
  tier: LarkNoticeTier;
  /** 本条消息在该群聊、该发送方下允许 @（开关、群聊、非机器人都满足）；是否真有标签看 mention。 */
  mentionAllowed: boolean;
  /** 可直接嵌入卡片 markdown 的 @ 发起人标签；不 @ 时缺席。 */
  mention?: string;
  /** 久无人处理时是否可以加急。 */
  urgent: boolean;
  /** 现在处于免打扰时段且本条可加急时，加急最早可发的时刻（毫秒时间戳，即时段结束）。 */
  urgentNotBefore?: number;
}

const quietHoursPattern = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/** 解析 HH:MM-HH:MM；起止相同或格式不对返回 undefined。 */
export function parseLarkQuietHours(value: string | undefined): { start: number; end: number } | undefined {
  const match = quietHoursPattern.exec(value?.trim() ?? '');
  if (!match) return undefined;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  return start === end ? undefined : { start, end };
}

/** 现在在免打扰时段内时返回时段结束的时刻，否则 undefined；起点含、终点不含。 */
export function larkQuietHoursEndAt(value: string | undefined, now: number): number | undefined {
  const window = parseLarkQuietHours(value);
  if (!window) return undefined;
  const at = new Date(now);
  const minute = at.getHours() * 60 + at.getMinutes();
  const inside = window.start < window.end ? minute >= window.start && minute < window.end : minute >= window.start || minute < window.end;
  if (!inside) return undefined;
  const end = new Date(now);
  end.setHours(Math.floor(window.end / 60), window.end % 60, 0, 0);
  if (end.getTime() <= now) end.setDate(end.getDate() + 1);
  return end.getTime();
}

/**
 * 出站消息的唯一定档入口。event 缺省时只给出档位与加急结论，不渲染 @（加急管理器只关心后者）。
 * 免打扰时段内只有 action 档仍 @；action 档的加急推迟到时段结束。
 */
export function larkNotice(
  kind: LarkNoticeKind,
  settings: LarkNoticeSettings,
  event?: { chatType?: string; senderOpenId?: string; senderType?: string },
  now = Date.now()
): LarkNoticeDecision {
  const tier = noticeTiers[kind];
  const quietEnd = larkQuietHoursEndAt(settings.notifyQuietHours, now);
  const switchedOn = settings.groupCardMention === true && (tier === 'action'
    ? settings.notifyMentionAction !== false
    : tier === 'done' ? settings.notifyMentionDone !== false && quietEnd === undefined : false);
  const mentionAllowed = switchedOn && event !== undefined && isGroupChat(event.chatType) && !isBotSenderType(event.senderType);
  const mention = mentionAllowed ? senderGroupMention(true, event) : undefined;
  return {
    tier, mentionAllowed, ...(mention ? { mention } : {}),
    urgent: tier === 'action',
    ...(tier === 'action' && quietEnd !== undefined ? { urgentNotBefore: quietEnd } : {})
  };
}
