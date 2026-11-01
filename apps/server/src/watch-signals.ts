import { botAppIdOfSession, readStoredSessionSchedule, sessionScheduleOccurrenceSchema, type RepositoryBundle, type Session } from '@dutydeck/shared';
import { larkResultDeliveryIssues } from './lark/reconciler.js';
import { larkListenerStatusKey, type LarkListenerStatus } from './lark/listener-status.js';
import { larkMemoryEnabled, type StoredLarkConfig } from './lark/config.js';
import type { LarkMemoryState } from './lark/memory.js';
import { checkLarkMemory } from './doctor/checks.js';
import { readWatchFindings, WATCH_PREFIX, type WatchScope, type WatchSignal } from './watch.js';

export const WATCH_DISCONNECTED_MS = 5 * 60_000;
export const WATCH_QUEUED_MS = 60 * 60_000;
export const WATCH_UNKNOWN_MS = 24 * 60 * 60_000;
export const WATCH_SCHEDULE_OVERDUE_MS = 10 * 60_000;
const decode = <T>(raw: string | null | undefined): T | undefined => { try { return raw ? JSON.parse(raw) as T : undefined; } catch { return undefined; } };
const time = (value: string | undefined, fallback: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback;
const chatLink = (chatId: string, bot?: StoredLarkConfig) => `https://applink.${bot?.brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
const sessionLocation = (session: Session, bot?: StoredLarkConfig) => {
  if (bot?.webBaseUrl) return bot.webBaseUrl.replace(/\/$/, '') + '/sessions/' + encodeURIComponent(session.id);
  const chatId = session.source === 'lark' ? session.sourceId?.split(':')[1] : undefined;
  return chatId ? `${chatLink(chatId, bot)}（会话 ${session.id}）` : `工作台会话 ${session.id}；dutydeck doctor`;
};

/** Read existing state only: no task mutation, probe, recovery, retry, or config migration. */
export async function collectWatchScopes(repos: RepositoryBundle, bots: StoredLarkConfig[], options: {
  now?: Date; listeningDisabled?: boolean; appId?: string;
} = {}): Promise<WatchScope[]> {
  const now = options.now ?? new Date();
  const at = now.toISOString();
  const selected = options.appId ? bots.filter(bot => bot.appId === options.appId) : bots;
  const scopes: WatchScope[] = selected.map(bot => ({
    appId: bot.appId, signals: [], ownerId: bot.allowedUsers.find(user => /^(ou_|on_)/.test(user.openId))?.openId,
    notify: !options.listeningDisabled && bot.listening
  }));
  // The Web process has no bot but still checks its own tasks and schedules.
  if (!scopes.length) scopes.push({ appId: options.appId ?? 'web', signals: [], notify: false });
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
    if (!larkMemoryEnabled(bot)) continue;
    const prefix = `lark.memory.state.${bot.appId}.`;
    const rows = await repos.config.list?.(prefix) ?? [];
    const memoryCheck = checkLarkMemory({ raw: JSON.stringify([bot]), values: Object.fromEntries(rows.map(row => [row.key, row.value])) }, now);
    if (memoryCheck.level === 'warn') add(scope, {
      kind: 'memory_stalled', objectId: bot.appId, title: '后台记忆提取积压',
      since: at, location: 'dutydeck doctor；对应聊天 /memory'
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
  for (const session of sessions) {
    const scope = scopeOf(session);
    if (!scope) continue;
    for (const task of await repos.tasks.listBySession(session.id)) {
      if (task.status === 'queued' && now.getTime() - Date.parse(task.createdAt) > WATCH_QUEUED_MS
        && repos.execution.getTaskExecution(task.id)?.blockers.some(blocker => blocker.code.startsWith('WORKSPACE_'))) add(scope, {
        kind: 'queue_blocked', objectId: task.id, title: '排队超过 1 小时且当前工作目录受阻',
        since: time(task.createdAt, at), location: locationOf(session)
      });
      if (task.status === 'reconcile_required' && now.getTime() - Date.parse(task.updatedAt) > WATCH_UNKNOWN_MS) add(scope, {
        kind: 'result_unknown', objectId: task.id, title: '结果未知超过 24 小时',
        since: time(task.updatedAt, at), location: locationOf(session)
      });
    }
  }
  for (const row of await repos.config.list?.('session_automation/schedule/') ?? []) {
    const raw = decode<unknown>(row.value);
    if (!raw) continue;
    const schedule = readStoredSessionSchedule(raw);
    const session = bySession.get(schedule.sessionId);
    const scope = session ? scopeOf(session) : undefined;
    if (!scope || !session || !schedule.enabled || schedule.deletedAt) continue;
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

