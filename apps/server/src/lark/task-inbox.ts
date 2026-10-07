import type { LarkLaunchOptions } from './new-session.js';
import { randomUUID } from 'node:crypto';
import type { ConfigRepository, PromptPart } from '@dutydeck/shared';
import type { LarkMessageResource } from './message-content.js';
import type { LarkContextCursor } from './task-context.js';
import type { LarkMessageEvent } from './listener.js';
import type { LarkRedispatchInfo } from './turn-redispatch.js';

export type LarkInboxAdoption = Pick<LarkMessageEvent, 'senderOpenId' | 'senderType' | 'triage' | 'rootId' | 'threadId' | 'parentId'>;
export interface LarkInboxRecord {
  appId: string;
  event: LarkMessageEvent;
  /** 已验证编辑或内部告警派生时保留原始输入；event 用于重新路由或执行。 */
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
  request?: { prompt: string; scopeId: string; resources: LarkMessageResource[]; materialPrompt?: string; launchOptions?: LarkLaunchOptions };
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
}
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
    const { triage: _untrustedTriage, ...original } = event;
    const key = prefix(appId) + event.messageId;
    for (;;) {
      const raw = await this.store.get(key);
      const old = raw ? JSON.parse(raw) as LarkInboxRecord : undefined;
      if (old && (old.state !== 'unrouted' || old.boot === this.boot)) return undefined;
      const next: LarkInboxRecord = { ...(old ?? { appId, event: original, state: 'unrouted', receivedAt: new Date().toISOString(), receiptOrder: ++this.receiptOrder }), boot: this.boot };
      if (await this.store.compareAndSet!(key, raw, JSON.stringify(next))) return next;
    }
  }
  async lookup(appId: string, messageId: string): Promise<LarkInboxRecord | undefined> {
    const raw = await this.store.get(prefix(appId) + messageId);
    return raw ? JSON.parse(raw) as LarkInboxRecord : undefined;
  }
  async ownUnrouted(record: LarkInboxRecord) {
    const next = { ...record, boot: this.boot };
    return await this.store.compareAndSet!(prefix(record.appId) + record.event.messageId, JSON.stringify(record), JSON.stringify(next)) ? next : undefined;
  }
  /** 已验证编辑可重开 ignored 或已交还的 unrouted；正在认领/已受理的记录不替换。 */
  async reopenIgnored(appId: string, event: LarkMessageEvent) {
    const { triage: _untrustedTriage, ...original } = event;
    const old = await this.lookup(appId, event.messageId);
    if (!old || (old.state !== 'ignored' && (old.state !== 'unrouted' || old.boot))) return;
    const next: LarkInboxRecord = { appId, event: original, originalEvent: old.originalEvent ?? old.event,
      state: 'unrouted', boot: '', receivedAt: new Date().toISOString(), receiptOrder: ++this.receiptOrder };
    await this.store.compareAndSet!(prefix(appId) + event.messageId, JSON.stringify(old), JSON.stringify(next));
  }
  /** 普通群消息只保留短命去重回执；未路由、已受理和命令记录绝不参与清理。 */
  async pruneIgnored(appId: string, limit = 5_000) {
    if (!this.store.remove) return;
    const rows = (await this.store.list!(prefix(appId))).map(row => ({ ...row, record: JSON.parse(row.value) as LarkInboxRecord }))
      .filter(row => row.record.state === 'ignored')
      .sort((a, b) => Date.parse(b.record.receivedAt ?? '') - Date.parse(a.record.receivedAt ?? '') || (b.record.receiptOrder ?? 0) - (a.record.receiptOrder ?? 0));
    for (const [index, row] of rows.entries()) {
      if (index >= limit || Date.now() - Date.parse(row.record.receivedAt ?? '') > 86_400_000) await this.store.remove(row.key, row.value);
    }
  }
  async claim(appId: string, event: LarkMessageEvent, allowIgnored = false, adoption?: LarkInboxAdoption): Promise<LarkInboxRecord | undefined> {
    const key = prefix(appId) + event.messageId;
    const raw = await this.store.get(key);
    const old = raw ? JSON.parse(raw) as LarkInboxRecord : undefined;
    if (old && old.state !== 'unrouted' && !(allowIgnored && old.state === 'ignored') && (old.state !== 'received' || old.boot === this.boot)) return undefined;
    // Always replay the originally persisted request, never replacement event content.
    const next: LarkInboxRecord = { ...(old ?? { appId, event, receivedAt: new Date().toISOString() }), state: 'received', boot: this.boot };
    if (adoption) {
      next.originalEvent = old?.originalEvent ?? old?.event;
      next.event = { ...next.event, ...adoption };
    }
    return await this.store.compareAndSet!(key, raw, JSON.stringify(next)) ? next : undefined;
  }
  /**
   * 结果卡续问按钮代发的一条消息：请求内容和所属 scope 由服务端按原任务定好，交给 handle 之前先落库。
   * boot 留空，handle 里的 claim 会像认领上个进程留下的记录一样认领它；进程在认领前退出时，
   * 重启后 recoverable 也会把它捞回来重放。返回 false 说明这条消息已经登记过。
   */
  async seed(appId: string, event: LarkMessageEvent, request: NonNullable<LarkInboxRecord['request']>): Promise<boolean> {
    const record: LarkInboxRecord = { appId, event, boot: '', state: 'received', receivedAt: new Date().toISOString(), request };
    return this.store.compareAndSet!(prefix(appId) + event.messageId, undefined, JSON.stringify(record));
  }
  /**
   * 交还本进程的认领：boot 置空，保留 unrouted/received。本进程稍后可重新认领；
   * 进程先退出的话，重启后 recoverable 也会把它捞回来。记录已被改动时返回 undefined。
   */
  async release(record: LarkInboxRecord): Promise<LarkInboxRecord | undefined> {
    if (record.state !== 'received' && record.state !== 'unrouted') return undefined;
    const next: LarkInboxRecord = { ...record, boot: '' };
    return await this.store.compareAndSet!(prefix(record.appId) + record.event.messageId, JSON.stringify(record), JSON.stringify(next)) ? next : undefined;
  }
  /** 这条记录现在落库的版本；已被删除时返回 undefined。 */
  async reload(record: LarkInboxRecord): Promise<LarkInboxRecord | undefined> {
    const raw = await this.store.get(prefix(record.appId) + record.event.messageId);
    return raw ? JSON.parse(raw) as LarkInboxRecord : undefined;
  }
  /** 交还之后没被别的路径接手：记录原样还在。 */
  async unclaimed(record: LarkInboxRecord) {
    return await this.store.get(prefix(record.appId) + record.event.messageId) === JSON.stringify(record);
  }
  async adoptAccepted(record: LarkInboxRecord) {
    if (record.state !== 'accepted') return undefined;
    const next = { ...record, boot: this.boot };
    return await this.store.compareAndSet!(prefix(record.appId) + record.event.messageId, JSON.stringify(record), JSON.stringify(next)) ? next : undefined;
  }
  async update(record: LarkInboxRecord, patch: Partial<Pick<LarkInboxRecord, 'state' | 'sessionId' | 'cardId' | 'taskId' | 'error' | 'turn' | 'request' | 'materials' | 'event' | 'workflowRequestId' | 'redispatch' | 'mergeFrom' | 'mergedInto'>>) {
    // 同一认领的准备和 /new 可并发更新；串行合并字段，同时保留跨进程 CAS。
    const operation = (this.updates.get(record) ?? Promise.resolve()).then(async () => {
      const next = { ...record, ...patch };
      if (!await this.store.compareAndSet!(prefix(record.appId) + record.event.messageId, JSON.stringify(record), JSON.stringify(next))) {
        throw new Error('Lark inbox claim was lost');
      }
      Object.assign(record, next);
    });
    this.updates.set(record, operation.catch(() => {}));
    await operation;
  }

  async orphanedCommands(appId: string): Promise<LarkInboxRecord[]> {
    return (await this.store.list!(prefix(appId))).map(row => JSON.parse(row.value) as LarkInboxRecord)
      .filter(record => record.state === 'command' && record.boot !== this.boot);
  }
  async recoverable(appId: string): Promise<LarkInboxRecord[]> {
    return (await this.store.list!(prefix(appId))).map(row => JSON.parse(row.value) as LarkInboxRecord)
      .filter(record => (record.state === 'received' || record.state === 'unrouted') && record.boot !== this.boot)
      .sort((a, b) => Date.parse(a.receivedAt ?? '') - Date.parse(b.receivedAt ?? '') || (a.receiptOrder ?? 0) - (b.receiptOrder ?? 0));
  }
}
