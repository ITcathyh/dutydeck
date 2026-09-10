import { randomUUID } from 'node:crypto';
import type { ConfigRepository } from '@dutydeck/shared';
import type { LarkMessageResource } from './message-content.js';
import type { LarkContextCursor } from './task-context.js';
import type { LarkMessageEvent } from './listener.js';

export interface LarkInboxRecord {
  appId: string;
  event: LarkMessageEvent;
  boot: string;
  state: 'received' | 'accepted' | 'command' | 'failed';
  sessionId?: string;
  cardId?: string;
  taskId?: string;
  turn?: number;
  request?: { prompt: string; scopeId: string; resources: LarkMessageResource[]; materialPrompt?: string };
  materials?: { prompt: string; cursor?: LarkContextCursor; readMessageIds: string[]; contextBefore?: string };
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
  async adoptAccepted(record: LarkInboxRecord) {
    if (record.state !== 'accepted') return undefined;
    const next = { ...record, boot: this.boot };
    return await this.store.compareAndSet!(prefix(record.appId) + record.event.messageId, JSON.stringify(record), JSON.stringify(next)) ? next : undefined;
  }
  async update(record: LarkInboxRecord, patch: Partial<Pick<LarkInboxRecord, 'state' | 'sessionId' | 'cardId' | 'taskId' | 'error' | 'turn' | 'request' | 'materials' | 'event'>>) {
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
