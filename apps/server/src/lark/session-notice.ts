import { parseLarkSourceId, type RepositoryBundle, type Session } from '@dutydeck/shared';
import type { SessionNotice } from '@dutydeck/runtime';
import { safeLarkWebUrl } from './card-actions.js';
import { larkUnknownTaskNoticeKey, larkUnknownTaskNoticeRecordKey } from './task-recovery.js';
import { readLarkConfig, type StoredLarkConfig } from './config.js';
import type { PersistedLarkCardTask } from './coordinator.js';
import type { LarkCardService } from './service.js';

type Target = { appId: string; chatId: string; replyMessageId?: string; replyInThread?: boolean };

/**
 * 运行时的会话提醒（见 SessionNotice）转到飞书：飞书会话回复到这条任务的卡片所在话题，任务没有卡片（定时任务等）时用会话最近一张卡片的话题；
 * 独立定时任务会话发到计划的回报位置。排队受阻的任务自己有卡片时，卡上已写明「排队受阻」，不再另发。其余会话只有 Web 上那条提醒。
 */
export async function deliverLarkSessionNotice(repos: Pick<RepositoryBundle, 'config' | 'channelMappings'>,
  client: (config: StoredLarkConfig) => Pick<LarkCardService, 'sendText' | 'replyText'>, session: Session, notice: SessionNotice) {
  const target = await noticeTarget(repos, session, notice);
  if (!target) return;
  // 已有 master 的结果未知提醒（含发送结果待确认的意图）继续沿用，避免另发一条同类消息。
  if (notice.kind === 'unknown_task_overdue' && notice.attemptId
    && await repos.config.get(larkUnknownTaskNoticeRecordKey(larkUnknownTaskNoticeKey(target.appId, session.id, notice.taskId, notice.attemptId)))) return;
  const config = await readLarkConfig(repos.config, target.appId);
  if (!config?.listening) return;
  const base = config.webBaseUrl?.replace(/\/$/, '');
  const links = base ? notice.sessionIds.flatMap(id => safeLarkWebUrl(`${base}/sessions/${encodeURIComponent(id)}`) ?? []) : [];
  const text = links.length ? `${notice.message}\n\nWeb 处理入口：${links.join(' ')}` : notice.message;
  const idempotencyKey = `session_notice_${notice.id}`;
  if (target.replyMessageId) await client(config).replyText({ messageId: target.replyMessageId, text, idempotencyKey, ...(target.replyInThread ? { replyInThread: true } : {}) });
  else await client(config).sendText({ chatId: target.chatId, text, idempotencyKey });
}

async function noticeTarget(repos: Pick<RepositoryBundle, 'config' | 'channelMappings'>, session: Session, notice: SessionNotice): Promise<Target | undefined> {
  if (session.source === 'schedule') {
    const raw = session.sourceId ? await repos.config.get(`automation.delivery-target.${session.sourceId}`) : undefined;
    try { const target = raw ? JSON.parse(raw) as Target : undefined; return target?.appId && target.chatId ? target : undefined; }
    catch { return undefined; }
  }
  if (session.source !== 'lark') return undefined;
  const { appId, chatId } = parseLarkSourceId(session.sourceId);
  if (!appId || !chatId) return undefined;
  const cards = (await repos.channelMappings.list(`lark-card:${appId}`)).filter(mapping => mapping.sessionId === session.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    .flatMap(mapping => {
      try { const saved = JSON.parse(mapping.extra ?? 'null') as PersistedLarkCardTask | null; return saved?.chat_id === chatId ? [{ mapping, saved }] : []; }
      catch { return []; }
    });
  const own = cards.find(card => card.saved.runtime_task_id === notice.taskId);
  if (own && notice.kind === 'workspace_blocked') return undefined;
  const anchor = own ?? cards[0];
  // 私聊的卡片记录不写 reply_message_id，记录的 externalId 就是那条请求消息。
  const replyMessageId = anchor && (anchor.saved.reply_message_id ?? anchor.mapping.externalId);
  return { appId, chatId, ...(replyMessageId?.startsWith('om_') ? { replyMessageId, replyInThread: anchor!.saved.reply_in_thread === true } : {}) };
}
