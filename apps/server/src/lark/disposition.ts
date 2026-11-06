import { z } from 'zod';
import { RuntimeError, type ConfigRepository } from '@dutydeck/shared';
import type { LarkInboxRecord } from './task-inbox.js';
import { listLarkInboxFields } from './inbox-fields.js';

export const dispositionReasons = {
  not_addressed: '没有叫本机器人，且不满足免 @ 条件', bot_message: '机器人消息未触发执行',
  access_denied: '发送人没有访问权限', group_unbound: '群配置尚未生效', bot_loop_guard: '机器人回合门禁拦截',
  command_rejected: '命令被拒绝', participation_handled: '已由群参与直接处理', participation_confirmation: '等待你确认是否执行', participation_observes: '等待群参与判断',
  participation_silent: '群参与判断为静默', participation_merged: '合并到另一条消息判断',
  backlog_expired: '积压超过 60 分钟，不再执行', listening_disabled: '机器人已停止监听',
  participation_observe_only: '观察模式只记录判断', participation_stale: '配置、授权或上下文已变化', participation_reply_budget: '主动发言次数已用完', participation_duplicate: '已有相同内容的回复，避免重复投递', participation_replied: '已由群参与直接回复',
  participation_failed: '群参与判断失败，保持静默', participation_budget: '群参与判断预算已用完', participation_usage_cap: '成本上限已用完',
  identity_failed: '无法确认发送人身份', context_failed: '上下文读取失败', plan_unsupported: 'Agent 不支持先出计划',
  execution_denied: '机器人没有执行权限', duplicate_delivery: '重复投递，沿用首次处理',
  input_rejected: '输入确认未通过', parsing_failed: '消息解析失败', processing_failed: '请求处理失败',
  workflow_handled: '已作为工作流交互处理', busy_supplement: '作为当前任务的补充处理', command_handled: '已作为命令处理'
} as const;
export const dispositionSchema = z.object({ schemaVersion: z.literal(1), reason: z.enum(Object.keys(dispositionReasons) as [keyof typeof dispositionReasons, ...(keyof typeof dispositionReasons)[]]), detail: z.string().max(500).optional(), decisionId: z.string().optional() }).strict();
export type Disposition = z.infer<typeof dispositionSchema>;
export async function annotateDisposition(store: ConfigRepository, appId: string, messageId: string, patch: Disposition & { mergedInto?: string }, log?: { warn(details: unknown, message: string): void }) {
  try { await writeDisposition(store, appId, messageId, patch); }
  catch (error) { (log ?? console).warn({ error, appId, messageId }, '记录消息去向失败，继续处理'); }
}
async function writeDisposition(store: ConfigRepository, appId: string, messageId: string, patch: Disposition & { mergedInto?: string }) {
  const { mergedInto, ...fields } = patch;
  const disposition = dispositionSchema.parse(fields);
  const key = `lark.inbox.${appId}.${messageId}`;
  for (;;) {
    const raw = await store.get(key);
    if (!raw) return;
    const record = JSON.parse(raw) as LarkInboxRecord;
    if (!['unrouted', 'ignored'].includes(record.state)) return;
    if (disposition.reason === 'participation_observes' && record.reason && record.reason !== 'participation_observes') return;
    const next = { ...record, disposition, reason: disposition.reason, detail: disposition.detail, ...(mergedInto ? { mergedInto } : {}) };
    if (await store.compareAndSet!(key, raw, JSON.stringify(next))) return;
  }
}
const dispositionFields = ['appId', 'event.messageId', 'event.chatId', 'state', 'reason', 'detail', 'receivedAt', 'event.senderOpenId', 'event.senderType',
  'snippet', 'mergedInto', 'sessionId', 'taskId', 'disposition.decisionId', 'duplicateCount'] as const;
type DispositionRow = { key: string; appId: string; messageId: string; chatId: string; state: LarkInboxRecord['state']; reason?: Disposition['reason']; detail?: string; receivedAt?: string;
  senderOpenId?: string; senderType?: string; snippet?: string; mergedInto?: string; sessionId?: string; taskId?: string; decisionId?: string; duplicateCount?: number };
/**
 * 只读去向页要的字段；正文只为最终显示、又没有摘要的那几条读。有索引的存储按时间倒序只取最近的已忽略记录，
 * 失败和命令被拒的记录按 state / 原因单独取；没有索引能力的存储退回整前缀投影。
 */
export async function queryDispositions(store: ConfigRepository, input: { appId?: string; messageId?: string; chatId?: string; since?: string }) {
  const durations: Record<string, number> = { '24h': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000 };
  if (input.since && !durations[input.since]) throw new RuntimeError('INBOX_RANGE_INVALID', '时间范围仅支持 24h、7d、30d', 400);
  const since = Date.now() - durations[input.since ?? '24h']!;
  const prefix = `lark.inbox.${input.appId ? input.appId + '.' : ''}`;
  const limit = input.messageId ? 100 : 500;
  let candidates: Array<{ key: string; fields: Record<string, unknown> | undefined }>;
  if (input.messageId && input.appId) {
    const raw = await store.get(prefix + input.messageId);
    candidates = raw ? [{ key: prefix + input.messageId, fields: projectRecord(raw) }] : [];
  } else if (input.messageId && store.listJsonFields) {
    const keys = (await store.listJsonFields(prefix, ['event.messageId'])).filter(row => row.fields?.['event.messageId'] === input.messageId);
    candidates = await Promise.all(keys.map(async ({ key }) => { const raw = await store.get(key); return { key, fields: raw === undefined ? undefined : projectRecord(raw) }; }));
  } else if (!input.messageId && store.listRecentIgnoredLarkInbox && store.listJsonFields) {
    const others = [...await store.listJsonFields(prefix, dispositionFields, { field: 'state', values: ['failed'] }),
      ...await store.listJsonFields(prefix, dispositionFields, { field: 'disposition.reason', values: ['command_rejected'] })];
    candidates = [...new Map([...others, ...await store.listRecentIgnoredLarkInbox({ ...(input.appId ? { appId: input.appId } : {}), since: new Date(since).toISOString(),
      ...(input.chatId !== undefined ? { chatId: input.chatId } : {}), limit, paths: dispositionFields })].map(row => [row.key, row])).values()];
  } else candidates = await listLarkInboxFields(store, prefix, dispositionFields);
  const rows = candidates.map(({ key, fields }): DispositionRow => {
    if (!fields) throw new SyntaxError(`Malformed Lark inbox record ${key}`);
    const value = (path: (typeof dispositionFields)[number]) => fields[path] as never;
    return { key, appId: value('appId'), messageId: value('event.messageId'), chatId: value('event.chatId'), state: value('state'), reason: value('reason'), detail: value('detail'),
      receivedAt: value('receivedAt'), senderOpenId: value('event.senderOpenId'), senderType: value('event.senderType'), snippet: value('snippet'), mergedInto: value('mergedInto'),
      sessionId: value('sessionId'), taskId: value('taskId'), decisionId: value('disposition.decisionId'), duplicateCount: value('duplicateCount') };
  });
  const selected = rows.filter(row => (!input.messageId || row.messageId === input.messageId) && (!input.chatId || row.chatId === input.chatId)
    && (input.messageId || (row.state === 'ignored' && !['participation_handled', 'participation_replied'].includes(row.reason ?? '') || row.state === 'failed' && !row.taskId || row.reason === 'command_rejected') && Date.parse(row.receivedAt ?? '') >= since))
    .sort((a, b) => Date.parse(b.receivedAt ?? '') - Date.parse(a.receivedAt ?? ''))
    .slice(0, limit);
  return Promise.all(selected.map(async row => ({ appId: row.appId, messageId: row.messageId, chatId: row.chatId, state: row.state,
    reason: row.reason, detail: row.detail ?? (row.reason ? dispositionReasons[row.reason] : '旧记录未记录原因'), receivedAt: row.receivedAt,
    sender: row.senderOpenId ?? row.senderType ?? '未知发送人', snippet: row.snippet ?? messageSnippet(await storedContent(store, row.key)), mergedInto: row.mergedInto,
    sessionId: row.sessionId, taskId: row.taskId, decisionId: row.decisionId, duplicateCount: row.duplicateCount, duplicateReason: row.duplicateCount ? 'duplicate_delivery' : undefined })));
}
const projectRecord = (raw: string) => {
  let record: Record<string, unknown>;
  try { record = JSON.parse(raw) as Record<string, unknown>; } catch { return undefined; }
  return Object.fromEntries(dispositionFields.map(path => [path, path.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown> | undefined)?.[part], record)]));
};
const storedContent = async (store: ConfigRepository, key: string) => {
  const raw = await store.get(key);
  return raw ? String((JSON.parse(raw) as LarkInboxRecord).event.content ?? '') : '';
};

function messageSnippet(content: string) { try { const parsed = JSON.parse(content); if (typeof parsed.text === 'string') return parsed.text.slice(0, 160); } catch {} return content.slice(0, 160); }
