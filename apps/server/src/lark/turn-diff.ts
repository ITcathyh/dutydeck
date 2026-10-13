import { randomUUID } from 'node:crypto';
import type { ChannelMappingRepository, ConfigRepository } from '@dutydeck/shared';
import { formatTurnDiffSummary, type TurnDiffRecord, type TurnDiffReviewComment } from '../turn-diff.js';
import type { TurnDiffReviewRequest } from '../turn-diff-routes.js';
import type { LarkCardElement } from './card-renderer.js';
import type { LarkConfirmCards } from './confirm-cards.js';
import { readLarkConfigs } from './config.js';
import { larkCardChannel } from './coordinator-core.js';
import { larkTurnDiffUrl } from './detail-link.js';
import { parseOptionalCardTask } from './persisted-card-task.js';

// 飞书里的「查看改动」：结果卡上的改动摘要行，和分享链接上提交的行评论在原话题里的确认卡。

/** 确认卡种类按机器人分开：每个机器人的协调器各自登记处理函数，点击只由发卡的那个机器人处理。 */
export const larkTurnDiffReviewKind = (appId: string) => `turn_diff_review.${appId}`;

/** 结果卡上的「改动 3 个文件 +42 −7 · 查看改动」；这一轮没有改动或没有记录时不显示。 */
export function larkTurnDiffElement(record: TurnDiffRecord | undefined, webBaseUrl?: string): LarkCardElement | undefined {
  if (!record?.summary || record.summary.files === 0) return undefined;
  const link = webBaseUrl ? ` · [查看改动](${larkTurnDiffUrl(webBaseUrl, record.sessionId, record.taskId)})` : '';
  return { tag: 'markdown', element_id: 'turn_diff', content: `${formatTurnDiffSummary(record.summary)}${link}` };
}

/** 评论内容来自没有核实身份的人：放进代码块，反引号换成形近字符，写什么都跑不出代码块、变不成链接或格式。 */
const fenced = (text: string) => `\`\`\`\n${text.replaceAll('`', 'ˋ')}\n\`\`\``;
const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}…` : text;

export function larkTurnDiffReviewBody(comments: TurnDiffReviewComment[]): string {
  const items = comments.map((item, index) => `**${index + 1}.** ${item.side === 'new' ? '改动后' : '改动前'}第 ${item.line} 行\n${fenced(`${clip(item.path, 200)}\n${clip(item.code, 400)}\n\n意见：${clip(item.comment, 500)}`)}`);
  return ['有人在「查看改动」分享链接上对这一轮的改动提了评审意见（提交人身份没有核实）。点「交给 Agent 修改」后，意见会作为新一轮请求交给 Agent，并标明是待评估的评审意见。', ...items].join('\n\n');
}

/**
 * 在这一轮所在的飞书话题里发确认卡。话题按卡片映射找：先找就是这一轮的任务，找不到就用同一会话最近的一条；
 * 卡回复在结果卡下面（没有结果卡时回复过程卡或原消息）。
 */
export async function requestLarkTurnDiffReview(deps: { configs: ConfigRepository; mappings: ChannelMappingRepository; confirmations?: Pick<LarkConfirmCards, 'request'> },
  review: TurnDiffReviewRequest): Promise<'sent' | 'no_origin' | 'unavailable'> {
  const candidates: Array<{ appId: string; externalId: string; saved: NonNullable<ReturnType<typeof parseOptionalCardTask>> }> = [];
  for (const bot of await readLarkConfigs(deps.configs)) {
    for (const mapping of await deps.mappings.list(larkCardChannel(bot.appId))) {
      if (mapping.sessionId !== review.sessionId) continue;
      try { const saved = parseOptionalCardTask(mapping.extra); if (saved) candidates.push({ appId: bot.appId, externalId: mapping.externalId, saved }); } catch { /* 损坏的映射不算 */ }
    }
  }
  const origin = candidates.find(item => item.saved.runtime_task_id === review.taskId) ?? candidates.sort((left, right) => right.saved.started_at - left.saved.started_at)[0];
  if (!origin) return 'no_origin';
  if (!deps.confirmations) return 'unavailable';
  const { saved } = origin;
  try {
    const record = await deps.confirmations.request({
      kind: larkTurnDiffReviewKind(origin.appId), scope: { appId: origin.appId, chatId: saved.chat_id },
      requesterId: saved.sender_open_id ?? 'turn_diff_share_link',
      replyTo: { messageId: saved.final_message_id ?? saved.card_message_id ?? saved.reply_message_id ?? origin.externalId, ...(saved.thread_id ? { threadId: saved.thread_id } : {}) },
      title: `代码评审意见（${review.comments.length} 条）`, summary: larkTurnDiffReviewBody(review.comments),
      payload: { session_id: review.sessionId, task_id: review.taskId, lark_task_id: origin.externalId, prompt: review.prompt },
      dedupeKey: `${review.taskId}:${randomUUID()}`, confirmLabel: '交给 Agent 修改'
    });
    return record ? 'sent' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
