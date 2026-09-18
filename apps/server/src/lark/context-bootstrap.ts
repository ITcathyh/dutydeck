import type { CollaborationRepository, CollaborationScope, CollaborationObservation } from '@dutydeck/shared';
import type { StoredLarkConfig } from './config.js';
import type { LarkCardService, LarkChatMessage } from './service.js';
import { parseLarkMessageContent } from './message-content.js';

export function observationTime(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric < 1e12 ? numeric * 1000 : numeric) : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

export async function historicalObservation(scope: CollaborationScope, message: LarkChatMessage, now: string): Promise<Omit<CollaborationObservation, 'id' | 'sequence' | 'revision'>> {
  const missing: string[] = [];
  let text = '';
  if (message.deleted) missing.push('message_deleted');
  else {
    try {
      const parsed = await parseLarkMessageContent(message.messageType, message.rawContent, { messageId: message.messageId });
      text = parsed.text;
      if (parsed.resources.length) missing.push('resource_binary_not_loaded');
    } catch { missing.push('message_parse_failed'); }
  }
  if (text.length > 16000) missing.push('text_truncated');
  if (!message.createTime || message.createTime === '0') missing.push('event_time_unavailable');
  return { scope, source: 'lark.message', eventId: message.messageId, occurredAt: observationTime(message.createTime, now), receivedAt: now,
    senderId: message.sender?.id, senderKind: ['app', 'bot'].includes(message.sender?.type ?? '') ? 'bot' : message.sender?.id ? 'human' : 'system',
    threadId: message.threadId, messageId: message.messageId, text: text.slice(0, 16_000), refs: [message.messageId], origin: 'history', missing };
}

export interface ContextBootstrapOptions {
  repository: CollaborationRepository;
  authorize(scope: CollaborationScope): Promise<boolean>;
  readConfig(appId: string, chatId?: string): Promise<StoredLarkConfig | undefined>;
  serviceFor(config: StoredLarkConfig): Pick<LarkCardService, 'listChatMessages'>;
  readGroupDescription?(scope: CollaborationScope, config: StoredLarkConfig): Promise<string>;
  now?: () => Date;
  maxPages?: number;
}

/** Per-scope resumed bounded scan. Every page is saved before advancing its checkpoint. */
export class LarkContextBootstrap {
  private closed = false;
  private readonly running = new Map<string, Promise<void>>();
  private readonly descriptions = new Map<string, CollaborationObservation>();
  material(scope: CollaborationScope) { return this.descriptions.get(JSON.stringify([scope.appId, scope.chatId])); }
  constructor(private readonly options: ContextBootstrapOptions) {}
  close(): Promise<void> {
    this.closed = true;
    return Promise.allSettled([...this.running.values()]).then(() => undefined);
  }
  ensure(scope: CollaborationScope, refresh = false): Promise<void> {
    if (this.closed) return Promise.resolve();
    const key = JSON.stringify([scope.appId, scope.chatId]);
    const existing = this.running.get(key);
    if (existing) return existing;
    const run = this.scan(scope, refresh).finally(() => { this.running.delete(key); });
    this.running.set(key, run);
    return run;
  }
  private async scan(scope: CollaborationScope, refresh: boolean) {
    const repo = this.options.repository;
    const now = () => (this.options.now?.() ?? new Date()).toISOString();
    const settings = await repo.getSettings(scope);
    if (settings.participation === 'off' || !await this.options.authorize(scope)) return;
    const old = await repo.getBootstrap(scope);
    if (!refresh && old?.status === 'complete') return;
    const config = await this.options.readConfig(scope.appId, scope.chatId);
    if (this.closed || !config?.listening) return;
    let checkpoint: { token: string; start: number; end: string } | undefined;
    if (old?.status !== 'complete' && old?.cursor) {
      try { checkpoint = JSON.parse(old.cursor); } catch { /* Older opaque checkpoints restart safely via source dedupe. */ }
    }
    let cursor = checkpoint?.token;
    const end = checkpoint?.end ?? now();
    const start = checkpoint?.start ?? (refresh && old?.lastEventAt ? Date.parse(old.lastEventAt) - 1000 : Date.parse(end) - Math.min(settings.retentionDays, 7) * 86_400_000);
    const missing: string[] = [];
    let lastEventAt = old?.lastEventAt;
    const save = (status: 'running' | 'complete' | 'partial' | 'failed') => repo.saveBootstrap({ scope, status, ...(cursor ? { cursor: JSON.stringify({ token: cursor, start, end }) } : {}), lastEventAt, missing: [...new Set(missing)], updatedAt: now() });
    await save('running');
    try {
      if (this.closed) { missing.push('bootstrap_stopped'); await save('partial'); return; }
      if (this.options.readGroupDescription) {
        try {
          const description = await this.options.readGroupDescription(scope, config);
          const descriptionMissing = description.length > 16000 ? ['description_truncated'] : [];
          missing.push(...descriptionMissing);
          const observed = await repo.observe({ scope, source: 'lark.description', eventId: scope.chatId, occurredAt: '1970-01-01T00:00:00.000Z', receivedAt: end, senderKind: 'system', text: description.slice(0, 16_000), refs: [], origin: 'history', missing: descriptionMissing });
          this.descriptions.set(JSON.stringify([scope.appId, scope.chatId]), observed.observation);
        } catch { missing.push('group_description_unavailable'); }
      } else missing.push('group_description_unavailable');
      const seenTokens = new Set<string>();
      for (let page = 0; page < (this.options.maxPages ?? 4); page++) {
        if (this.closed) { missing.push('bootstrap_stopped'); await save('partial'); return; }
        const current = await repo.getSettings(scope);
        if (current.participation === 'off' || !await this.options.authorize(scope)) { missing.push('observation_permission_revoked'); await save('partial'); return; }
        if (this.closed) { missing.push('bootstrap_stopped'); await save('partial'); return; }
        const result = await this.options.serviceFor(config).listChatMessages({ chatId: scope.chatId, order: 'asc', pageSize: 50, startTime: Math.floor(start / 1000), endTime: Math.floor(Date.parse(end) / 1000), ...(cursor ? { pageToken: cursor } : {}) });
        const existingLive = new Set((await repo.listObservations(scope, { limit: 1000 })).filter(item => item.origin === 'live').map(item => item.eventId));
        for (const message of result.items) {
          if (message.chatId && message.chatId !== scope.chatId) { missing.push('message_scope_mismatch'); continue; }
          const observed = await historicalObservation(scope, message, now());
          if (!existingLive.has(message.messageId)) await repo.observe(observed);
          if (!lastEventAt || observed.occurredAt > lastEventAt) lastEventAt = observed.occurredAt;
          missing.push(...observed.missing);
        }
        if (!result.hasMore) { cursor = undefined; await save('complete'); return; }
        if (!result.pageToken || seenTokens.has(result.pageToken)) { missing.push('history_pagination_incomplete'); await save('partial'); return; }
        seenTokens.add(result.pageToken); cursor = result.pageToken;
        await save('running');
      }
      missing.push('history_page_budget_reached'); await save('partial');
    } catch (error) {
      missing.push(`history_read_failed:${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`);
      await save('failed');
    }
  }
}
