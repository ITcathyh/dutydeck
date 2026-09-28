import type { LarkLaunchOptions } from './new-session.js';
import { randomUUID } from 'node:crypto';
import type { ConfigRepository } from '@dutydeck/shared';
import type { LarkMessageResource } from './message-content.js';
import type { LarkContextCursor } from './task-context.js';
import type { LarkMessageEvent } from './listener.js';
import type { LarkRedispatchInfo } from './turn-redispatch.js';

export interface LarkInboxRecord {
  appId: string;
  event: LarkMessageEvent;
  boot: string;
  state: 'received' | 'accepted' | 'command' | 'failed';
  sessionId?: string;
  cardId?: string;
  taskId?: string;
  turn?: number;
  workflowRequestId?: string;
  request?: { prompt: string; scopeId: string; resources: LarkMessageResource[]; materialPrompt?: string; launchOptions?: LarkLaunchOptions };
  materials?: { prompt: string; cursor?: LarkContextCursor; readMessageIds: string[]; contextBefore?: string };
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
  constructor(private readonly store: ConfigRepository) {
    if (!store.compareAndSet || !store.list) throw new Error('Lark inbox requires persistent CAS and prefix listing');
  }
  async claim(appId: string, event: LarkMessageEvent): Promise<LarkInboxRecord | undefined> {
    const key = prefix(appId) + event.messageId;
    const raw = await this.store.get(key);
    const old = raw ? JSON.parse(raw) as LarkInboxRecord : undefined;
    if (old && (old.state !== 'received' || old.boot === this.boot)) return undefined;
    // Always replay the originally persisted request, never replacement event content.
    const next: LarkInboxRecord = { ...(old ?? { appId, event, state: 'received' as const }), boot: this.boot };
    return await this.store.compareAndSet!(key, raw, JSON.stringify(next)) ? next : undefined;
  }
  /**
   * 结果卡续问按钮代发的一条消息：请求内容和所属 scope 由服务端按原任务定好，交给 handle 之前先落库。
   * boot 留空，handle 里的 claim 会像认领上个进程留下的记录一样认领它；进程在认领前退出时，
   * 重启后 recoverable 也会把它捞回来重放。返回 false 说明这条消息已经登记过。
   */
  async seed(appId: string, event: LarkMessageEvent, request: NonNullable<LarkInboxRecord['request']>): Promise<boolean> {
    const record: LarkInboxRecord = { appId, event, boot: '', state: 'received', request };
    return this.store.compareAndSet!(prefix(appId) + event.messageId, undefined, JSON.stringify(record));
  }
  /**
   * 交还本进程的认领：boot 置空，仍是 received。本进程稍后重试时 claim 能重新认领；
   * 进程先退出的话，重启后 recoverable 也会把它捞回来。记录已被改动时返回 undefined。
   */
  async release(record: LarkInboxRecord): Promise<LarkInboxRecord | undefined> {
    if (record.state !== 'received') return undefined;
    const next: LarkInboxRecord = { ...record, boot: '' };
    return await this.store.compareAndSet!(prefix(record.appId) + record.event.messageId, JSON.stringify(record), JSON.stringify(next)) ? next : undefined;
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
      .filter(record => record.state === 'received' && record.boot !== this.boot);
  }
}
