import { createHash } from 'node:crypto';
import { z } from 'zod';
import { watchFindingSchema, type ConfigRepository } from '@dutydeck/shared';
export { watchFindingSchema } from '@dutydeck/shared';
import type { DoctorCheck } from './doctor/types.js';

export const WATCH_PREFIX = 'watch_findings/';
export const WATCH_FIRST_RUN_MS = 5 * 60_000;
export const WATCH_INTERVAL_MS = 60 * 60_000;
export const WATCH_NOTIFICATION_RETRY_MS = 55 * 60_000;
/** 私信没确认成功时，隔这么久再巡检一次重发，赶在 WATCH_NOTIFICATION_RETRY_MS 的幂等窗口内。 */
export const WATCH_NOTIFICATION_RETRY_DELAY_MS = 5 * 60_000;
export const WATCH_RECOVERED_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const WATCH_RECOVERED_LIMIT = 1_000;
export const WATCH_RECEIVER_WARN_MS = 24 * 60 * 60_000;
const receiverTypes = ['open_id', 'union_id', 'user_id'] as const;
/** 机器人没有可私信的接收人：since 起记在这里给 doctor 看，告警每天最多一条。 */
const unreachableSchema = z.object({ since: z.string().datetime(), warnedAt: z.string().datetime().optional() }).strict();
const readUnreachable = (raw: string | undefined | null) => {
  try { const parsed = raw ? unreachableSchema.safeParse(JSON.parse(raw)) : undefined; return parsed?.success ? parsed.data : undefined; } catch { return undefined; }
};
const notificationSchema = z.object({
  schemaVersion: z.literal(1), idempotencyKey: z.string().min(1), ownerId: z.string().min(1), ownerIdType: z.enum(receiverTypes).optional(),
  text: z.string().min(1), status: z.enum(['pending', 'completed', 'unknown']),
  attemptedAt: z.string().datetime().optional(),
  members: z.array(z.object({ fingerprint: z.string(), episode: z.number().int().positive() }).strict()).min(1)
}).strict();
export type WatchFinding = z.infer<typeof watchFindingSchema>;
export type WatchSignal = Pick<WatchFinding, 'kind' | 'objectId' | 'title' | 'since' | 'location'>;
export type WatchReceiver = { id: string; type: (typeof receiverTypes)[number] };
export type WatchScope = { appId: string; signals: WatchSignal[]; ownerId?: string; ownerIdType?: WatchReceiver['type']; notify: boolean };
/** 没记类型的旧记录按前缀推断，与改动前的发送方式一致。 */
export const watchReceiverType = (id: string, type?: WatchReceiver['type']) => type ?? (id.startsWith('on_') ? 'union_id' : 'open_id');
export const watchFingerprint = (kind: string, objectId: string) =>
  createHash('sha256').update(JSON.stringify([kind, objectId])).digest('hex');
const parse = (value: string) => { try { return watchFindingSchema.safeParse(JSON.parse(value)); } catch { return undefined; } };

export function readWatchFindings(rows: Array<{ key: string; value: string }>): WatchFinding[] {
  return rows.flatMap(row => {
    const result = parse(row.value);
    return result?.success && row.key === `${WATCH_PREFIX}${result.data.appId}/${result.data.fingerprint}` ? [result.data] : [];
  });
}

export function watchSummary(findings: WatchFinding[]): string {
  const lines: string[] = [];
  const grouped = new Map<string, WatchFinding[]>();
  for (const finding of findings) {
    if (['queue_blocked', 'result_unknown', 'schedule_overdue', 'schedule_error', 'schedule_never_enabled', 'session_stop_blocked', 'terminal_missing',
      'task_report_waiting', 'task_report_blocked', 'inbox_backlog'].includes(finding.kind)) {
      const group = grouped.get(finding.kind) ?? []; group.push(finding); grouped.set(finding.kind, group);
    } else lines.push(`${finding.title}；自 ${finding.since}；${finding.location}`);
  }
  for (const group of grouped.values()) lines.push(`${group[0]!.title} ${group.length} 项；自 ${group.map(f => f.since).sort()[0]}；${[...new Set(group.map(f => f.location))].join('、')}`);
  return `巡检发现 ${findings.length} 个新问题。\n${lines.join('\n')}`;
}

/** Each instance has one runner. A stable provider UUID also covers a crash after send but before saving its receipt. */
export class DutydeckWatch {
  private running?: Promise<boolean>;
  constructor(private readonly options: {
    store: ConfigRepository;
    collect(): Promise<WatchScope[]>;
    send(input: { appId: string; ownerId: string; ownerIdType?: WatchReceiver['type']; text: string; idempotencyKey: string }): Promise<unknown>;
    warn(details: unknown, message: string): void;
    now?: () => Date;
  }) {}
  /** 返回 true 表示有私信没确认成功，应在 WATCH_NOTIFICATION_RETRY_DELAY_MS 后再跑一次。 */
  run(): Promise<boolean> {
    if (this.running) return this.running;
    this.running = this.inspect().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async pruneRecovered(appId: string, at: string) {
    if (!this.options.store.remove) return;
    try {
      const prefix = `${WATCH_PREFIX}${appId}/`;
      const raw = await this.options.store.get(prefix + 'notification');
      const notification = raw ? notificationSchema.parse(JSON.parse(raw)) : undefined;
      const protectedIds = new Set(notification?.status === 'pending' ? notification.members.map(member => member.fingerprint) : []);
      const recovered = (await this.options.store.list?.(prefix) ?? []).flatMap(row => {
        const finding = readWatchFindings([row])[0];
        return finding?.recoveredAt ? [{ ...row, finding }] : [];
      }).sort((a, b) => Date.parse(b.finding.recoveredAt!) - Date.parse(a.finding.recoveredAt!) || a.key.localeCompare(b.key));
      let kept = recovered.filter(row => protectedIds.has(row.finding.fingerprint)).length;
      for (const row of recovered) {
        if (protectedIds.has(row.finding.fingerprint)) continue;
        if (Date.parse(at) - Date.parse(row.finding.recoveredAt!) < WATCH_RECOVERED_RETENTION_MS && kept < WATCH_RECOVERED_LIMIT) { kept++; continue; }
        try { await this.options.store.remove(row.key, row.value); }
        catch (error) { this.options.warn({ appId, error }, '清理已恢复巡检记录失败'); }
      }
    } catch (error) { this.options.warn({ appId, error }, '清理已恢复巡检记录失败'); }
  }
  private async inspect(): Promise<boolean> {
    let retry = false;
    const scopes = await this.options.collect();
    const at = (this.options.now?.() ?? new Date()).toISOString();
    for (const scope of scopes) {
      const prefix = `${WATCH_PREFIX}${scope.appId}/`;
      const previous = new Map(readWatchFindings(await this.options.store.list?.(prefix) ?? []).map(f => [f.fingerprint, f]));
      const active = new Set<string>();
      const pending: WatchFinding[] = [];
      for (const signal of scope.signals) {
        const fingerprint = watchFingerprint(signal.kind, signal.objectId);
        if (active.has(fingerprint)) continue;
        active.add(fingerprint);
        const prior = previous.get(fingerprint);
        const finding: WatchFinding = watchFindingSchema.parse({
          schemaVersion: 1, appId: scope.appId, fingerprint, ...signal,
          since: prior && !prior.recoveredAt && prior.since < signal.since ? prior.since : signal.since,
          firstSeenAt: prior && !prior.recoveredAt ? prior.firstSeenAt : at,
          lastSeenAt: at, episode: prior ? prior.episode + (prior.recoveredAt ? 1 : 0) : 1,
          ...(prior && !prior.recoveredAt && prior.notifiedAt ? { notifiedAt: prior.notifiedAt } : {}),
          ...(prior && !prior.recoveredAt && prior.notificationUnknownAt ? { notificationUnknownAt: prior.notificationUnknownAt } : {})
        });
        await this.options.store.set(prefix + fingerprint, JSON.stringify(finding));
        previous.set(fingerprint, finding);
        if (!finding.notifiedAt && !finding.notificationUnknownAt) pending.push(finding);
      }
      for (const prior of previous.values()) if (!active.has(prior.fingerprint) && !prior.recoveredAt) {
        const recovered = { ...prior, recoveredAt: at };
        await this.options.store.set(prefix + prior.fingerprint, JSON.stringify(recovered));
        previous.set(prior.fingerprint, recovered);
      }
      await this.pruneRecovered(scope.appId, at);
      if (!scope.notify) continue;
      const notificationKey = prefix + 'notification';
      const rawNotification = await this.options.store.get(notificationKey);
      const oldNotification = rawNotification ? notificationSchema.parse(JSON.parse(rawNotification)) : undefined;
      const deliver = async (notification: z.infer<typeof notificationSchema>) => {
        const live = notification.members.flatMap(member => {
          const finding = previous.get(member.fingerprint);
          return finding && finding.episode === member.episode && !finding.recoveredAt && !finding.notifiedAt && !finding.notificationUnknownAt ? [finding] : [];
        });
        if (live.length && notification.attemptedAt && Date.parse(at) - Date.parse(notification.attemptedAt) >= WATCH_NOTIFICATION_RETRY_MS) {
          for (const finding of live) {
            const unknown = { ...finding, notificationUnknownAt: at };
            await this.options.store.set(prefix + finding.fingerprint, JSON.stringify(unknown));
            previous.set(finding.fingerprint, unknown);
          }
          await this.options.store.set(notificationKey, JSON.stringify({ ...notification, status: 'unknown' }));
          return;
        }
        if (live.length) {
          notification = { ...notification, attemptedAt: notification.attemptedAt ?? at };
          await this.options.store.set(notificationKey, JSON.stringify(notification));
          await this.options.send({ appId: scope.appId, ownerId: notification.ownerId, ...(notification.ownerIdType ? { ownerIdType: notification.ownerIdType } : {}),
            text: notification.text, idempotencyKey: notification.idempotencyKey });
          for (const finding of live) {
            const notified = { ...finding, notifiedAt: at };
            await this.options.store.set(prefix + finding.fingerprint, JSON.stringify(notified));
            previous.set(finding.fingerprint, notified);
          }
        }
        await this.options.store.set(notificationKey, JSON.stringify({ ...notification, status: 'completed' }));
      };
      const unreachableKey = prefix + 'unreachable';
      const rawUnreachable = await this.options.store.get(unreachableKey);
      if (!scope.ownerId) {
        const unreachable = readUnreachable(rawUnreachable) ?? { since: at };
        const warn = pending.length > 0 && (!unreachable.warnedAt || Date.parse(at) - Date.parse(unreachable.warnedAt) >= WATCH_RECEIVER_WARN_MS);
        const next = JSON.stringify(warn ? { ...unreachable, warnedAt: at } : unreachable);
        if (next !== rawUnreachable) await this.options.store.set(unreachableKey, next);
        if (warn) this.options.warn({ appId: scope.appId, code: 'WATCH_RECEIVER_MISSING', count: pending.length }, '巡检发现问题，但找不到可私信的接收人，未发送私信（每天最多提示一次）');
        continue;
      }
      if (rawUnreachable) await (this.options.store.remove ? this.options.store.remove(unreachableKey, rawUnreachable) : this.options.store.set(unreachableKey, ''));
      try {
        // Freeze both UUID and payload before any provider write. A partial receipt-save failure
        // or newly found issue cannot change an uncertain notification's identity.
        if (oldNotification?.status === 'pending') {
          if (oldNotification.ownerId === scope.ownerId && watchReceiverType(oldNotification.ownerId, oldNotification.ownerIdType) === watchReceiverType(scope.ownerId, scope.ownerIdType)) await deliver(oldNotification);
          else await this.options.store.set(notificationKey, JSON.stringify({ ...oldNotification, status: 'completed' }));
        }
        const unsent = pending.filter(f => { const current = previous.get(f.fingerprint); return !current?.notifiedAt && !current?.notificationUnknownAt; });
        if (!unsent.length) continue;
        const idempotencyKey = 'watch_' + createHash('sha256')
          .update(JSON.stringify([scope.appId, scope.ownerId, unsent.map(f => [f.fingerprint, f.episode, f.firstSeenAt]).sort()])).digest('hex').slice(0, 40);
        const notification = notificationSchema.parse({ schemaVersion: 1, idempotencyKey,
          ownerId: scope.ownerId, ...(scope.ownerIdType ? { ownerIdType: scope.ownerIdType } : {}), text: watchSummary(unsent), status: 'pending',
          members: unsent.map(f => ({ fingerprint: f.fingerprint, episode: f.episode })) });
        await this.options.store.set(notificationKey, JSON.stringify(notification));
        await deliver(notification);
      } catch (error) {
        retry = true;
        this.options.warn({ appId: scope.appId, error }, '巡检私信未确认成功，几分钟后重试');
      }
    }
    return retry;
  }
}

/** Stop timers first and drain the in-flight read/send before repositories and HTTP clients close. */
export function startDutydeckWatch(watch: { run(): Promise<boolean | void> }, warn: (error: unknown) => void) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let running: Promise<void> | undefined;
  const tick = () => {
    if (stopped) return;
    let retry = false;
    running = watch.run().then(pending => { retry = pending === true; }, warn).finally(() => {
      running = undefined;
      if (!stopped) { timer = setTimeout(tick, retry ? WATCH_NOTIFICATION_RETRY_DELAY_MS : WATCH_INTERVAL_MS); timer.unref(); }
    });
  };
  timer = setTimeout(tick, WATCH_FIRST_RUN_MS); timer.unref();
  return async () => { stopped = true; clearTimeout(timer); await running; };
}

export function checkWatchFindings(values: Readonly<Record<string, string | undefined>>, unavailable = false): DoctorCheck {
  const base = { id: 'watch.findings', label: '巡检发现' };
  if (unavailable) return { ...base, level: 'skip', detail: '数据库不可读，无法读取巡检发现' };
  const rows = Object.entries(values).flatMap(([key, value]) => key.startsWith(WATCH_PREFIX) && value ? [{ key, value }] : []);
  const findings = readWatchFindings(rows).filter(f => !f.recoveredAt).sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));
  const unreachable = rows.flatMap(row => {
    const appId = row.key.slice(WATCH_PREFIX.length, -'/unreachable'.length);
    if (!row.key.endsWith('/unreachable') || !appId || appId.includes('/')) return [];
    return readUnreachable(row.value) ? [`巡检无人接收：${appId} 没有可私信的接收人（允许名单和应用创建人都没有），发现只记在这里`] : [];
  });
  if (!findings.length && !unreachable.length) return { ...base, level: 'ok', detail: '没有未恢复的巡检问题（启动约 5 分钟后首次检查）' };
  return { ...base, level: 'warn', detail: [...unreachable, ...findings.map(f => `${f.title}；首次发现 ${f.firstSeenAt}；${f.location}${f.notificationUnknownAt ? '；巡检通知发送结果未知，不重复私信' : ''}`)].join('\n'),
    remedy: '按每项位置查看会话或守护进程日志，处理后等待下一轮巡检确认恢复。', verify: 'dutydeck doctor --json' };
}
