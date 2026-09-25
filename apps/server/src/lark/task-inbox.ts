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
}
const prefix = (appId: string) => `lark.inbox.${appId}.`;
export class LarkTaskInbox {
  private readonly boot = randomUUID();
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
  async adoptAccepted(record: LarkInboxRecord) {
    if (record.state !== 'accepted') return undefined;
    const next = { ...record, boot: this.boot };
    return await this.store.compareAndSet!(prefix(record.appId) + record.event.messageId, JSON.stringify(record), JSON.stringify(next)) ? next : undefined;
  }
  async update(record: LarkInboxRecord, patch: Partial<Pick<LarkInboxRecord, 'state' | 'sessionId' | 'cardId' | 'taskId' | 'error' | 'turn' | 'request' | 'materials' | 'event' | 'workflowRequestId' | 'redispatch'>>) {
    const next = { ...record, ...patch };
    if (!await this.store.compareAndSet!(prefix(record.appId) + record.event.messageId, JSON.stringify(record), JSON.stringify(next))) {
      throw new Error('Lark inbox claim was lost');
    }
    Object.assign(record, next);
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
