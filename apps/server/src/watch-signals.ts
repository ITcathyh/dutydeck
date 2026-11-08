import { createHash } from 'node:crypto';
import { z } from 'zod';
import { dispositionSchema } from './lark/disposition.js';
import { larkConfirmActionId } from './lark/confirm-cards.js';
import { larkMessageAnchor } from './lark/message-anchor.js';
import { listLarkInboxFields } from './lark/inbox-fields.js';
import { readTaskReportSafely, taskReportAttentionText, botAppIdOfSession, readStoredSessionSchedule, sessionScheduleOccurrenceSchema, type ConfigRepository, type RepositoryBundle, type SessionScheduleOccurrence, type Session } from '@dutydeck/shared';
import { larkResultDeliveryIssues } from './lark/reconciler.js';
import { larkListenerStatusKey, type LarkListenerStatus } from './lark/listener-status.js';
import { larkMemoryEnabled, type StoredLarkConfig } from './lark/config.js';
import type { LarkMemoryState } from './lark/memory.js';
import { checkLarkMemory } from './doctor/checks.js';
import { readWatchFindings, WATCH_PREFIX, type WatchReceiver, type WatchScope, type WatchSignal } from './watch.js';

export const WATCH_DISCONNECTED_MS = 5 * 60_000;
export const WATCH_QUEUED_MS = 60 * 60_000;
export const WATCH_UNKNOWN_MS = 24 * 60 * 60_000;
export const WATCH_SCHEDULE_OVERDUE_MS = 10 * 60_000;
export const WATCH_REPORT_MS = 24 * 60 * 60_000;
export const WATCH_INBOX_MS = 60 * 60_000;
export const WATCH_SCHEDULE_DISABLED_MS = 24 * 60 * 60_000;
const STOP_BLOCK_PREFIX = 'runtime_driver_stop_block:';
const RETRY_OCCURRENCE_PREFIX = 'occ_retry_';
// Validate the read projection and strict disposition; leave all other execution fields untouched.
const inboxProjection = z.object({
  appId: z.string(), state: z.enum(['unrouted', 'received', 'ignored', 'accepted', 'command', 'failed']),
  event: z.object({ messageId: z.string().min(1), chatId: z.string().min(1), replyMessageId: z.string().optional(), senderType: z.string().optional() }).passthrough(),
  receivedAt: z.string().datetime(), taskId: z.string().optional(), disposition: dispositionSchema.optional()
}).passthrough();
/** 巡检只读这些字段，不把记录正文读进来；拼回投影的形状再校验。 */
const inboxFields = ['appId', 'state', 'event.messageId', 'event.chatId', 'event.replyMessageId', 'event.senderType', 'receivedAt', 'taskId', 'disposition'] as const;
const inboxRecord = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries({ appId: fields.appId, state: fields.state,
  event: Object.fromEntries(Object.entries({ messageId: fields['event.messageId'], chatId: fields['event.chatId'], replyMessageId: fields['event.replyMessageId'], senderType: fields['event.senderType'] }).filter(([, value]) => value !== undefined)),
  receivedAt: fields.receivedAt, taskId: fields.taskId, disposition: fields.disposition }).filter(([, value]) => value !== undefined));
/**
 * 只可能报积压的记录：还没路由或已认领未受理的，以及等群参与判断或等确认的已忽略记录。有索引的存储按 state 和原因各取一次，
 * 合并后仍按键排序；没有投影能力的存储退回整前缀读取。
 */
async function readInboxCandidates(config: ConfigRepository, appId: string) {
  const prefix = `lark.inbox.${appId}.`;
  if (!config.list) return [];
  if (!config.listJsonFields) return listLarkInboxFields(config, prefix, inboxFields);
  const rows = [...await config.listJsonFields(prefix, inboxFields, { field: 'state', values: ['unrouted', 'received'] }),
    ...await config.listJsonFields(prefix, inboxFields, { field: 'disposition.reason', values: ['participation_observes', 'participation_confirmation'] })];
  return [...new Map(rows.map(row => [row.key, row])).values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
const decode = <T>(raw: string | null | undefined): T | undefined => { try { return raw ? JSON.parse(raw) as T : undefined; } catch { return undefined; } };
const time = (value: string | undefined, fallback: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback;
const chatLink = (chatId: string, bot?: StoredLarkConfig) => `https://applink.${bot?.brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
const sessionLocation = (session: Session, bot?: StoredLarkConfig) => {
  if (bot?.webBaseUrl) return bot.webBaseUrl.replace(/\/$/, '') + '/sessions/' + encodeURIComponent(session.id);
  const chatId = session.source === 'lark' ? session.sourceId?.split(':')[1] : undefined;
  return chatId ? `${chatLink(chatId, bot)}（会话 ${session.id}）` : `工作台会话 ${session.id}；dutydeck doctor`;
};

/**
 * 巡检私信的接收人：允许名单第一人 → 创建这个应用的人。只认能管这个机器人的依据；群授权登记的成员（被拒也会登记）不算，
 * 否则摘要里其他群的链接和会话编号会发给无关的人。发送前用同一个函数复核，接收人变了就不发旧批次。
 */
export async function resolveWatchReceiver(config: ConfigRepository, bot: StoredLarkConfig): Promise<WatchReceiver | undefined> {
  const listed = bot.allowedUsers.find(user => /^(ou_|on_)/.test(user.openId))?.openId;
  if (listed) return { id: listed, type: listed.startsWith('on_') ? 'union_id' : 'open_id' };
  for (const row of await config.list?.('lark.app_creation.') ?? []) {
    const job = decode<{ id?: string; appId?: string }>(row.value);
    if (job?.appId !== bot.appId || !job.id) continue;
    const userId = decode<{ userId?: string }>(await config.get(`lark.app_creation_owner.${job.id}`))?.userId;
    if (userId) return { id: userId, type: 'user_id' };
  }
  return undefined;
}

/** Read existing state only: no task mutation, recovery, retry, or config migration; the terminal probe only lists tmux sessions. */
export async function collectWatchScopes(repos: RepositoryBundle, bots: StoredLarkConfig[], options: {
  now?: Date; listeningDisabled?: boolean; appId?: string;
  /** 只读确认会话的终端已不存在（不结束任何进程）；没有就不查这一项。 */
  terminalAbsent?: (session: Session) => Promise<boolean>;
} = {}): Promise<WatchScope[]> {
  const now = options.now ?? new Date();
  const at = now.toISOString();
  const selected = options.appId ? bots.filter(bot => bot.appId === options.appId) : bots;
  const scopes: WatchScope[] = await Promise.all(selected.map(async bot => {
    const receiver = await resolveWatchReceiver(repos.config, bot);
    return { appId: bot.appId, signals: [], ...(receiver ? { ownerId: receiver.id, ownerIdType: receiver.type } : {}),
      notify: !options.listeningDisabled && bot.listening };
  }));
  // Unscoped instances also check Web/CLI sessions when bots share the database.
  if (!options.appId || !scopes.length) scopes.push({ appId: options.appId ?? 'web', signals: [], notify: false });
  const botsByApp = new Map(selected.map(bot => [bot.appId, bot]));
  const locationOf = (session: Session) => sessionLocation(session, botsByApp.get(botAppIdOfSession(session) ?? options.appId ?? ''));
  const byApp = new Map(scopes.map(scope => [scope.appId, scope]));
  const sessions = await repos.sessions.list();
  const scopeOf = (session: Session) => {
    const appId = botAppIdOfSession(session);
    if (appId) return botsByApp.has(appId) ? byApp.get(appId) : undefined;
    return byApp.get('web') ?? (options.appId ? byApp.get(options.appId) : undefined);
  };
  const bySession = new Map(sessions.map(session => [session.id, session]));
  // 结果未知结案后任务状态不变，只有当前执行记录变成已结算；读不了账本（旧库）时按未结算报告。
  const unknownSettled = (taskId: string) => {
    try { return repos.execution.getTaskExecutionState(taskId)?.currentAttempt?.state === 'settled'; } catch { return false; }
  };
  const add = (scope: WatchScope, signal: WatchSignal) => scope.signals.push(signal);
  const status = decode<LarkListenerStatus>(await repos.config.get(larkListenerStatusKey));
  for (const bot of selected) {
    const scope = byApp.get(bot.appId)!;
    if (scope.notify) {
      const reconnect = status?.pid === process.pid ? status.reconnecting?.find(row => row.appId === bot.appId) : undefined;
      const retry = status?.pid === process.pid ? status.retrying?.find(row => row.appId === bot.appId) : undefined;
      if (reconnect && now.getTime() - Date.parse(reconnect.since) > WATCH_DISCONNECTED_MS) add(scope, {
        kind: 'lark_connection', objectId: bot.appId, title: '飞书长连接断开超过 5 分钟',
        since: time(reconnect.since, at), location: 'dutydeck doctor；守护进程日志'
      });
      // The persisted retry deadline reveals exponential backoff (at least the second failed start).
      else if (retry && (Date.parse(retry.nextRetryAt) - Date.parse(retry.failedAt) >= 60_000
        || now.getTime() - Date.parse(retry.failedAt) > WATCH_DISCONNECTED_MS)) add(scope, {
        kind: 'lark_connection', objectId: bot.appId, title: '飞书长连接持续重连失败',
        since: time(retry.failedAt, at), location: 'dutydeck doctor；守护进程日志'
      });
      else if ((!status || status.pid !== process.pid || !status.active?.includes(bot.appId) && !retry && !reconnect)
        && (!status || status.pid !== process.pid || now.getTime() - Date.parse(status.updatedAt) > WATCH_DISCONNECTED_MS)) add(scope, {
        kind: 'lark_connection', objectId: bot.appId, title: '飞书长连接没有当前进程的连接记录',
        since: at, location: 'dutydeck doctor；守护进程日志'
      });
    }
    const mappings = await repos.channelMappings.list(`lark-card:${bot.appId}`);
    for (const issue of larkResultDeliveryIssues(mappings)) {
      const mapping = mappings.find(row => row.externalId === issue.messageId)!;
      const card = decode<{ final_delivery_first_failed_at?: number }>(mapping.extra);
      const started = card?.final_delivery_first_failed_at;
      add(scope, { kind: 'result_delivery', objectId: issue.messageId, title: '结果投递未确认成功',
        since: typeof started === 'number' && Number.isFinite(started) ? new Date(started).toISOString() : at,
        location: `${chatLink(issue.chatId, bot)}（会话 ${issue.sessionId}）` });
    }
    for (const row of await readInboxCandidates(repos.config, bot.appId)) {
      const parsed = inboxProjection.safeParse(row.fields && inboxRecord(row.fields));
      if (!parsed.success) continue;
      const record = parsed.data;
      if (record.appId !== bot.appId || row.key !== `lark.inbox.${bot.appId}.${record.event.messageId}`
        || record.taskId || now.getTime() - Date.parse(record.receivedAt) <= WATCH_INBOX_MS) continue;
      const reason = record.disposition?.reason;
      let waiting = record.state === 'unrouted' || record.state === 'received';
      // 群参与只拿真人消息触发判断，机器人消息停在这里不会再有下文，不算积压。
      if (record.state === 'ignored' && reason === 'participation_observes' && record.event.senderType !== 'bot') waiting = true;
      if (record.state === 'ignored' && reason === 'participation_confirmation') {
        const place = { appId: bot.appId, chatId: record.event.chatId };
        const action = await repos.collaboration.getAction(place, larkConfirmActionId('participation_act', place, larkMessageAnchor(record.event)));
        const payload = action?.payload as { expiresAt?: string; payload?: { decisionId?: string } } | undefined;
        waiting = action?.kind === 'confirm.participation_act' && action.status === 'intent' && Boolean(action.receipt)
          && Date.parse(payload?.expiresAt ?? '') > now.getTime() && Boolean(record.disposition?.decisionId)
          && payload?.payload?.decisionId === record.disposition?.decisionId;
      }
      if (waiting) add(scope, { kind: 'inbox_backlog', objectId: record.event.messageId,
        title: '入站消息等待处理超过 1 小时', since: record.receivedAt, location: chatLink(record.event.chatId, bot) });
    }
    if (!larkMemoryEnabled(bot)) continue;
    const prefix = `lark.memory.state.${bot.appId}.`;
    const rows = await repos.config.list?.(prefix) ?? [];
    const memoryCheck = checkLarkMemory({ raw: JSON.stringify([bot]), values: Object.fromEntries(rows.map(row => [row.key, row.value])) }, now);
    if (memoryCheck.level === 'warn') add(scope, {
      kind: 'memory_stalled', objectId: bot.appId, title: '后台记忆提取积压',
      since: at, location: '在对应群里 @ 机器人（会自动补跑），或让它整理记忆'
    });
    for (const row of rows) {
      const state = decode<LarkMemoryState & { migratedTo?: string }>(row.value);
      if (!state || state.migratedTo) continue;
      const pool = row.key.slice(prefix.length);
      const jobs = await repos.memoryJobs.listScope({ appId: bot.appId, pool });
      for (const kind of ['extraction', 'consolidation'] as const) {
        const settled = jobs.filter(job => job.kind === kind && (['settled', 'failed'].includes(job.state) || job.state === 'applied' && Boolean(job.receipt))).slice(-2);
        if (settled.length === 2 && settled.every(job => job.state === 'failed')) add(scope, {
          kind: 'memory_failures', objectId: `${pool}:${kind}`, title: `后台记忆${kind === 'extraction' ? '提取' : '整理'}连续失败`,
          since: time(state.lastFailureAt?.[kind], at), location: pool.startsWith('oc_') ? chatLink(pool, bot) : '对应聊天 /memory；守护进程日志'
        });
      }
    }
  }
  // 与运行时同一判据：非空即受阻，清除时写回空串。
  const stopBlocked = new Set((await repos.config.list?.(STOP_BLOCK_PREFIX) ?? []).flatMap(row => row.value ? [row.key.slice(STOP_BLOCK_PREFIX.length)] : []));
  for (const session of sessions) {
    const scope = scopeOf(session);
    if (!scope) continue;
    const current = !session.archivedAt;
    if (current && stopBlocked.has(session.id)) add(scope, { kind: 'session_stop_blocked', objectId: session.id, title: '会话停止未核实，发给它的消息会失败',
      since: at, location: locationOf(session) });
    else if (current && options.terminalAbsent && session.protocol === 'pty-cli' && repos.execution.getResources(session.id).some(resource => resource.runId === session.runId
      && resource.kind === 'local_only' && resource.stage === 'created' && resource.identity && resource.observations.at(-1)?.state === 'live')) {
      // 探测失败（tmux 查不准）不当作终端已不在。
      if (await options.terminalAbsent(session).catch(() => false)) add(scope, { kind: 'terminal_missing', objectId: session.id,
        title: '终端已不在，记录仍是运行中', since: at, location: locationOf(session) });
    }
    const tasks = await repos.tasks.listBySession(session.id);
    const latest = [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
    const storedReport = latest ? await readTaskReportSafely(repos.config, latest.id) : undefined;
    const report = storedReport?.sessionId === session.id && !storedReport.clearedAt ? storedReport : undefined;
    if (report && taskReportAttentionText(report) && now.getTime() - Date.parse(report.reportedAt) > WATCH_REPORT_MS) add(scope, {
      kind: `task_report_${report.status}`, objectId: report.taskId,
      title: report.status === 'waiting' ? '任务等待决定超过 24 小时' : '任务受阻超过 24 小时',
      since: report.reportedAt, location: locationOf(session)
    });
    for (const task of tasks) {
      if (task.status === 'queued' && now.getTime() - Date.parse(task.createdAt) > WATCH_QUEUED_MS
        && repos.execution.getTaskExecution(task.id)?.blockers.some(blocker => blocker.code.startsWith('WORKSPACE_'))) add(scope, {
        kind: 'queue_blocked', objectId: task.id, title: '排队超过 1 小时且当前工作目录受阻',
        since: time(task.createdAt, at), location: locationOf(session)
      });
      if (task.status === 'reconcile_required' && now.getTime() - Date.parse(task.updatedAt) > WATCH_UNKNOWN_MS && !unknownSettled(task.id)) add(scope, {
        kind: 'result_unknown', objectId: task.id, title: '结果未知超过 24 小时',
        since: time(task.updatedAt, at), location: locationOf(session)
      });
    }
  }
  const occurrences = new Map<string, SessionScheduleOccurrence>();
  for (const row of await repos.config.list?.('session_automation/occurrence/') ?? []) {
    const parsed = sessionScheduleOccurrenceSchema.safeParse(decode<unknown>(row.value));
    if (parsed.success) occurrences.set(parsed.data.id, parsed.data);
  }
  // 原触发出错后在新会话重跑同一个计划时间（编号规则同 session-automation 的 retryOccurrenceId）：两条算一次运行，以重跑为准。
  const latestOccurrence = new Map<string, SessionScheduleOccurrence>();
  for (const occurrence of occurrences.values()) {
    if (occurrences.has(RETRY_OCCURRENCE_PREFIX + createHash('sha256').update(occurrence.id).digest('hex'))) continue;
    const latest = latestOccurrence.get(occurrence.scheduleId);
    if (!latest || occurrence.scheduledForUtc > latest.scheduledForUtc) latestOccurrence.set(occurrence.scheduleId, occurrence);
  }
  for (const row of await repos.config.list?.('session_automation/schedule/') ?? []) {
    const raw = decode<unknown>(row.value);
    if (!raw) continue;
    const schedule = readStoredSessionSchedule(raw);
    const session = bySession.get(schedule.sessionId);
    const scope = session ? scopeOf(session) : undefined;
    if (!scope || !session || schedule.deletedAt) continue;
    const latest = latestOccurrence.get(schedule.id);
    // 建好后从没跑过、也不是被系统停用的：多半是建完忘了启用。
    if (!schedule.enabled && !schedule.disabledAt && !latest && now.getTime() - Date.parse(schedule.createdAt) > WATCH_SCHEDULE_DISABLED_MS) add(scope, {
      kind: 'schedule_never_enabled', objectId: schedule.id, title: '定时计划建好超过 24 小时还没启用',
      since: time(schedule.createdAt, at), location: locationOf(session)
    });
    if (!schedule.enabled) continue;
    if (latest?.runStatus === 'error') add(scope, {
      kind: 'schedule_error', objectId: schedule.id, title: '定时计划上次触发出错',
      since: time(latest.updatedAt, at), location: locationOf(session)
    });
    let due = schedule.nextDueAt;
    if (schedule.pendingOccurrence) {
      const occurrence = decode<unknown>(await repos.config.get('session_automation/occurrence/' + schedule.pendingOccurrence.id));
      const parsed = sessionScheduleOccurrenceSchema.safeParse(occurrence);
      if (parsed.success) {
        const occurrence = parsed.data;
        if (!['pending', 'blocked', 'accepted'].includes(occurrence.runStatus) || occurrence.taskStartedAt) continue;
        if (occurrence.taskId) {
          const currentTask = await repos.tasks.get?.(occurrence.taskId);
          if (currentTask && currentTask.status !== 'queued') continue;
        }
      }
      due = schedule.pendingOccurrence.scheduledForUtc;
    }
    if (due && now.getTime() - Date.parse(due) > WATCH_SCHEDULE_OVERDUE_MS) add(scope, {
      kind: 'schedule_overdue', objectId: schedule.id, title: '定时计划逾期未开始',
      since: time(due, at), location: locationOf(session)
    });
  }
  const previous = readWatchFindings(await repos.config.list?.(WATCH_PREFIX) ?? []);
  for (const appId of new Set(previous.map(finding => finding.appId))) {
    if ((!options.appId || options.appId === appId) && !byApp.has(appId)) scopes.push({ appId, signals: [], notify: false });
  }
  return scopes;
}
