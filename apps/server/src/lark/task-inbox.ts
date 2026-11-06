import { dispositionSchema, type Disposition } from './disposition.js';
import type { LarkLaunchOptions } from './new-session.js';
import { createHash, randomUUID } from 'node:crypto';
import { RuntimeError, type ConfigRepository, type PromptPart } from '@dutydeck/shared';
import type { LarkMessageResource } from './message-content.js';
import type { LarkContextCursor } from './task-context.js';
import type { LarkMessageEvent } from './listener.js';
import type { LarkRedispatchInfo } from './turn-redispatch.js';
import { isBotSenderType } from './card-mentions.js';

export type LarkInboxAdoption = Pick<LarkMessageEvent, 'senderOpenId' | 'senderType' | 'scenario' | 'authorization' | 'rootId' | 'threadId' | 'parentId'> & { confirmedInputDigest?: string };
/** Bind confirmation to content, attachments and routing, independently of its confirmer and host evidence. */
export function larkConfirmationInputDigest(event: LarkMessageEvent): string {
  const { senderOpenId: _actor, senderType: _kind, authorization: _authorization, scenario: _scenario, triage: _triage, replyMessageId: _reply, ...input } = event;
  return createHash('sha256').update(JSON.stringify(input, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest('hex');
}
export interface LarkInboxRecord {
  reason?: Disposition['reason'];
  detail?: string;
  disposition?: Disposition;
  duplicateCount?: number;
  appId: string;
  event: LarkMessageEvent;
  /** 已验证编辑或内部场景派生时保留原始输入；event 用于重新路由或执行。 */
  originalEvent?: LarkMessageEvent;
  boot: string;
  state: 'unrouted' | 'ignored' | 'received' | 'accepted' | 'command' | 'failed';
  receiptOrder?: number;
  /** 首次落库时间。任务通道的合成事件没有 createTime，启动恢复靠它判断记录是否过期。 */
  receivedAt?: string;
  sessionId?: string;
  cardId?: string;
  taskId?: string;
  turn?: number;
  workflowRequestId?: string;
  fallbackNote?: string;
  fallbackFromSessionId?: string;
  lineage?: { sessionId: string; relation: import('@dutydeck/shared').MatterRelation };
  request?: { prompt: string; scopeId: string; resources: LarkMessageResource[]; materialPrompt?: string; launchOptions?: LarkLaunchOptions };
  /** Local attachment directories retained until this inbox and its task settle. */
  resourceDirectories?: string[];
  materials?: { prompt: string; promptParts?: PromptPart[]; cursor?: LarkContextCursor; readMessageIds: string[]; contextBefore?: string };
  /** 这一轮是服务重启切断之后的重投：Agent prompt 前附说明，count 也是下一次能不能自动重投的依据。 */
  redispatch?: LarkRedispatchInfo;
  error?: string;
  /**
   * 这条消息并入了同一人紧挨着的前一条排队消息：前一条的消息 id 与 runtime 任务，以及这条自己的原文。
   * 与合并后的 request.prompt 同一次写入；重启恢复时据此决定按合并后的原文还是自己的原文执行。
   */
  mergeFrom?: { messageId: string; sessionId: string; taskId: string; ownPrompt: string };
  /** 这条排队消息被并进了哪条消息（取消它之前写下）：恢复时据此确认它是被这次合并取消的。 */
  mergedInto?: string;
  /** 已忽略的其他机器人消息过了收养宽限后不留正文（event.content 置空），去向页只用这段摘要。 */
  snippet?: string;
  /** 本版本起被忽略的其他机器人消息：到这个时间清理把正文换成 snippet。之前就存在的记录没有这个字段，原样保留到过期。 */
  bodyExpiresAt?: string;
}
/**
 * 其他机器人的消息被忽略后，只在同一进程的场景包收养（botDuty 同步跑完、可能晚于忽略落库）时才会回放落库原文；
 * 宽限过后清理把正文换成摘要，之后不再接受收养。真人消息被忽略后仍可能经群参与确认卡（默认 24 小时有效）收养，
 * 回放和确认摘要都用落库原文，所以原样保留。
 */
export const LARK_IGNORED_BOT_BODY_GRACE_MS = 3_600_000;
/**
 * 已忽略记录按时间保留 30 天。每个机器人下其他机器人的消息和其余消息各自计数，另设安全上限：
 * 线上单机器人每天收 1,100–2,000 条入站消息（峰值 1,992），30 天峰值约 6 万条；瘦身后单条约 600B，约 36MB。
 */
export const LARK_IGNORED_RETENTION_LIMIT = 60_000;
export const LARK_IGNORED_RETENTION_MS = 30 * 86_400_000;
// 清空后重写字段会改变落库键顺序；只比较执行值，数组顺序仍有意义。
const executionRecord = ({ reason: _reason, detail: _detail, disposition: _disposition, duplicateCount: _duplicates, ...rest }: LarkInboxRecord) => JSON.stringify(rest, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
const prefix = (appId: string) => `lark.inbox.${appId}.`;
/**
 * 首张进度卡没送达时抛出的错误带这个标记：runtime 还没接到这条任务，
 * 入站侧据此保留 received 记录，稍后重试整条入站处理，而不是标成 failed。
 */
const firstCardUndelivered = Symbol('larkFirstCardUndelivered');
export const markLarkFirstCardUndelivered = (error: unknown): never => {
  throw error instanceof Error ? Object.assign(error, { [firstCardUndelivered]: true }) : error;
};
export const isLarkFirstCardUndelivered = (error: unknown) => error instanceof Error && firstCardUndelivered in error;
export class LarkTaskInbox {
  private readonly boot = randomUUID();
  private readonly updates = new WeakMap<LarkInboxRecord, Promise<void>>();
  private receiptOrder = 0;
  constructor(private readonly store: ConfigRepository) {
    if (!store.compareAndSet || !store.list) throw new Error('Lark inbox requires persistent CAS and prefix listing');
  }
  /** ACK 前仅做本地 CAS；重投不能替换原文，也不能重复启动路由。写入异常直接交给 SDK。 */
  async capture(appId: string, event: LarkMessageEvent): Promise<LarkInboxRecord | undefined> {
    const { authorization: _untrustedAuthorization, scenario: _untrustedScenario, triage: _untrustedTriage, replyMessageId: _untrustedReplyMessageId, ...original } = event;
    const key = prefix(appId) + event.messageId;
    for (;;) {
      const raw = await this.store.get(key);
      const old = raw ? JSON.parse(raw) as LarkInboxRecord : undefined;
      if (old && (old.state !== 'unrouted' || old.boot === this.boot)) {
        {
          const next = { ...old, duplicateCount: (old.duplicateCount ?? 0) + 1 };
          if (!await this.store.compareAndSet!(key, raw, JSON.stringify(next))) continue;
        }
        return undefined;
      }
      const next: LarkInboxRecord = { ...(old ?? { appId, event: original, state: 'unrouted', receivedAt: new Date().toISOString(), receiptOrder: ++this.receiptOrder }), boot: this.boot };
      if (await this.store.compareAndSet!(key, raw, JSON.stringify(next))) return next;
    }
  }
  async lookup(appId: string, messageId: string): Promise<LarkInboxRecord | undefined> {
    const raw = await this.store.get(prefix(appId) + messageId);
    return raw ? JSON.parse(raw) as LarkInboxRecord : undefined;
  }
  private async mutateClaim(record: LarkInboxRecord, change: (latest: LarkInboxRecord) => LarkInboxRecord): Promise<LarkInboxRecord | undefined> {
    const key = prefix(record.appId) + record.event.messageId;
    for (;;) {
      const raw = await this.store.get(key);
      const latest = raw ? JSON.parse(raw) as LarkInboxRecord : undefined;
      if (!latest || executionRecord(latest) !== executionRecord(record)) return;
      const next = change(latest);
      if (await this.store.compareAndSet!(key, raw, JSON.stringify(next))) return next;
    }
  }
  async ownUnrouted(record: LarkInboxRecord) {
    return this.mutateClaim(record, latest => ({ ...latest, boot: this.boot }));
  }
  /** 已验证编辑可重开 ignored 或已交还的 unrouted；正在认领/已受理的记录不替换。 */
  async reopenIgnored(appId: string, event: LarkMessageEvent) {
    const { authorization: _untrustedAuthorization, scenario: _untrustedScenario, triage: _untrustedTriage, replyMessageId: _untrustedReplyMessageId, ...original } = event;
    const old = await this.lookup(appId, event.messageId);
    if (!old || (old.state !== 'ignored' && (old.state !== 'unrouted' || old.boot))) return;
    const next: LarkInboxRecord = { appId, event: original, originalEvent: old.originalEvent ?? old.event,
      state: 'unrouted', boot: '', receivedAt: new Date().toISOString(), receiptOrder: ++this.receiptOrder };
    await this.mutateClaim(old, latest => ({ ...next, ...(latest.duplicateCount ? { duplicateCount: latest.duplicateCount } : {}) }));
  }
  /**
   * 已忽略记录保留 30 天去向，两类各自最多 limit 条；正文到期的其他机器人消息换成摘要。
   * 由存储用带索引的单条 SQL 完成，不把记录读进 JS；未路由、已受理和命令记录绝不参与。没有这个能力的存储不清理。
   */
  async pruneIgnored(appId: string, limit = LARK_IGNORED_RETENTION_LIMIT) {
    if (!this.store.pruneIgnoredLarkInbox) return;
    const now = Date.now();
    await this.store.pruneIgnoredLarkInbox(appId, { receivedBefore: new Date(now - LARK_IGNORED_RETENTION_MS).toISOString(), keep: limit, now: new Date(now).toISOString() });
  }
  async claim(appId: string, event: LarkMessageEvent, allowIgnored = false, adoption?: LarkInboxAdoption): Promise<LarkInboxRecord | undefined> {
    const key = prefix(appId) + event.messageId;
    for (;;) {
      const raw = await this.store.get(key);
      const old = raw ? JSON.parse(raw) as LarkInboxRecord : undefined;
      if (adoption?.confirmedInputDigest && (!old || larkConfirmationInputDigest(old.event) !== adoption.confirmedInputDigest)) {
        throw new RuntimeError('LARK_CONFIRMATION_INPUT_CHANGED', '原消息已修改，请重新确认', 409);
      }
      if (old && old.state !== 'unrouted' && !(allowIgnored && old.state === 'ignored') && (old.state !== 'received' || old.boot === this.boot)) return undefined;
      // 正文已换成摘要的已忽略记录没有可回放的原文，不再收养。
      if (old?.snippet !== undefined) return undefined;
      // Always replay the originally persisted request, never replacement event content.
      const next: LarkInboxRecord = { ...(old ?? { appId, event, receivedAt: new Date().toISOString() }), state: 'received', boot: this.boot };
      if (adoption) {
        next.originalEvent = old?.originalEvent ?? old?.event;
        const { confirmedInputDigest: _expected, ...fields } = adoption;
        next.event = { ...next.event, ...fields };
      }
      if (await this.store.compareAndSet!(key, raw, JSON.stringify(next))) return next;
    }
  }
  /**
   * Agent 代发、用户已确认的命令（agent-command.ts）：执行前按确认卡的消息落库为执行中的命令。
   * 进程在执行中退出时，重启后和用户自己发的命令一样回执「无法确认是否完成」。已登记过返回 undefined。
   */
  async startCommand(appId: string, event: LarkMessageEvent): Promise<LarkInboxRecord | undefined> {
    const record: LarkInboxRecord = { appId, event, boot: this.boot, state: 'command', receivedAt: new Date().toISOString() };
    return await this.store.compareAndSet!(prefix(appId) + event.messageId, undefined, JSON.stringify(record)) ? record : undefined;
  }
  /**
   * 结果卡续问按钮代发的一条消息：请求内容和所属 scope 由服务端按原任务定好，交给 handle 之前先落库。
   * boot 留空，handle 里的 claim 会像认领上个进程留下的记录一样认领它；进程在认领前退出时，
   * 重启后 recoverable 也会把它捞回来重放。返回 false 说明这条消息已经登记过。
   */
  async seed(appId: string, event: LarkMessageEvent, request: NonNullable<LarkInboxRecord['request']>, target?: Pick<LarkInboxRecord, 'sessionId' | 'workflowRequestId' | 'lineage'>): Promise<boolean> {
    const record: LarkInboxRecord = { appId, event, boot: '', state: 'received', receivedAt: new Date().toISOString(), request, ...target };
    return this.store.compareAndSet!(prefix(appId) + event.messageId, undefined, JSON.stringify(record));
  }
  /**
   * 交还本进程的认领：boot 置空，保留 unrouted/received。本进程稍后可重新认领；
   * 进程先退出的话，重启后 recoverable 也会把它捞回来。记录已被改动时返回 undefined。
   */
  async release(record: LarkInboxRecord): Promise<LarkInboxRecord | undefined> {
    if (record.state !== 'received' && record.state !== 'unrouted') return undefined;
    return this.mutateClaim(record, latest => ({ ...latest, boot: '' }));
  }
  /** 这条记录现在落库的版本；已被删除时返回 undefined。 */
  async reload(record: LarkInboxRecord): Promise<LarkInboxRecord | undefined> {
    const raw = await this.store.get(prefix(record.appId) + record.event.messageId);
    return raw ? JSON.parse(raw) as LarkInboxRecord : undefined;
  }
  /** 交还之后没被别的路径接手：记录原样还在。 */
  async unclaimed(record: LarkInboxRecord) {
    const latest = await this.reload(record);
    return Boolean(latest && executionRecord(latest) === executionRecord(record));
  }
  async adoptAccepted(record: LarkInboxRecord) {
    if (record.state !== 'accepted') return undefined;
    return this.mutateClaim(record, latest => ({ ...latest, boot: this.boot }));
  }
  async update(record: LarkInboxRecord, patch: Partial<Pick<LarkInboxRecord, 'state' | 'sessionId' | 'cardId' | 'taskId' | 'error' | 'turn' | 'request' | 'materials' | 'resourceDirectories' | 'event' | 'workflowRequestId' | 'lineage' | 'fallbackNote' | 'fallbackFromSessionId' | 'redispatch' | 'mergeFrom' | 'mergedInto' | 'reason' | 'detail' | 'disposition'>>) {
    // 同一认领的准备和 /new 可并发更新；串行合并字段，同时保留跨进程 CAS。
    const operation = (this.updates.get(record) ?? Promise.resolve()).then(async () => {
      const next = await this.mutateClaim(record, latest => {
        // 只有还没认领的记录能改成 ignored：它此时不可能带任务、交接链接或附件目录，附件清理据此跳过已忽略记录。
        if (patch.state === 'ignored' && latest.state !== 'unrouted') throw new RuntimeError('LARK_INBOX_IGNORE_REJECTED', `只有未路由的入站记录能标为已忽略，当前是 ${latest.state}`, 409);
        const confirmed = patch.taskId && latest.event.authorization?.via === 'participation_confirmed';
        const acceptedDisposition = confirmed ? dispositionSchema.parse({ schemaVersion: 1, reason: 'participation_handled', decisionId: latest.event.authorization?.decisionId }) : undefined;
        const bodyExpiresAt = patch.state === 'ignored' && isBotSenderType(latest.event.senderType)
          ? { bodyExpiresAt: new Date(Date.now() + LARK_IGNORED_BOT_BODY_GRACE_MS).toISOString() } : {};
        return { ...latest, ...patch, ...bodyExpiresAt, ...(patch.taskId ? { reason: acceptedDisposition?.reason, detail: undefined, disposition: acceptedDisposition } : {}),
          ...(patch.reason ? { disposition: dispositionSchema.parse({ schemaVersion: 1, reason: patch.reason, ...(patch.detail ? { detail: patch.detail } : {}) }) } : {}) };
      });
      if (!next) throw new Error('Lark inbox claim was lost');
      Object.assign(record, next);
    });
    this.updates.set(record, operation.catch(() => {}));
    await operation;
  }

  /** 按 state 读整条记录：有索引的存储只读命中的行，不把已忽略的记录读进来。 */
  private async inState(appId: string, states: LarkInboxRecord['state'][]): Promise<LarkInboxRecord[]> {
    const rows = this.store.listByJsonField ? await this.store.listByJsonField(prefix(appId), { field: 'state', values: states }) : await this.store.list!(prefix(appId));
    return rows.map(row => JSON.parse(row.value) as LarkInboxRecord).filter(record => states.includes(record.state));
  }
  async orphanedCommands(appId: string): Promise<LarkInboxRecord[]> {
    return (await this.inState(appId, ['command'])).filter(record => record.boot !== this.boot);
  }
  async recoverable(appId: string): Promise<LarkInboxRecord[]> {
    return (await this.inState(appId, ['received', 'unrouted'])).filter(record => record.boot !== this.boot)
      .sort((a, b) => Date.parse(a.receivedAt ?? '') - Date.parse(b.receivedAt ?? '') || (a.receiptOrder ?? 0) - (b.receiptOrder ?? 0));
  }
}
