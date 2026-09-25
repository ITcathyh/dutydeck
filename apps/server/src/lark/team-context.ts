import { createHash } from 'node:crypto';
import { RuntimeError, type CollaborationObservation, type CollaborationRepository, type CollaborationScope, type CollaborationTeamContext } from '@dutydeck/shared';
import { historicalObservation } from './context-bootstrap.js';
import { larkExecutionConfirmed, type StoredLarkConfig } from './config.js';
import type { LarkCardService, LarkChat } from './service.js';

interface ReaderOptions {
  repository: CollaborationRepository;
  readConfig(appId: string): Promise<StoredLarkConfig | undefined>;
  serviceFor(config: StoredLarkConfig): Pick<LarkCardService, 'listChats' | 'listChatMessages'>;
  canRead(scope: CollaborationScope): Promise<boolean>;
  now?: () => Date;
}
const sameScope = (a: CollaborationScope, b: CollaborationScope) => a.appId === b.appId && a.chatId === b.chatId;
const identity = (scope: CollaborationScope, value: string) => `team_${createHash('sha256').update(JSON.stringify([scope, value])).digest('hex')}`;
const enabled = (config: StoredLarkConfig | undefined): config is StoredLarkConfig => Boolean(config?.listening && config.groupToolsEnabled && larkExecutionConfirmed(config));

function relevance(query: string) {
  const words = query.toLowerCase().match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) ?? [];
  const terms = new Set(words.flatMap(word => /\p{Script=Han}/u.test(word)
    ? [word, ...Array.from({ length: Math.max(0, word.length - 1) }, (_, i) => word.slice(i, i + 2))]
    : [word]));
  return (text: string) => [...terms].reduce((score, term) => score + (text.toLowerCase().includes(term) ? term.length : 0), 0);
}

/** Host-controlled reads only: no source group activation, persistent writes or agent tools. */
export class LarkTeamContextReader {
  constructor(private readonly options: ReaderOptions) {}

  private async joined(config: StoredLarkConfig): Promise<LarkChat[]> {
    const client = this.options.serviceFor(config), chats = new Map<string, LarkChat>(), tokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      const page = await client.listChats(pageToken);
      for (const chat of page.items) if (chat.chatId.startsWith('oc_') && chat.chatMode !== 'p2p') chats.set(chat.chatId, chat);
      if (!page.hasMore) return [...chats.values()];
      if (!page.pageToken || tokens.has(page.pageToken)) throw new RuntimeError('TEAM_CONTEXT_PAGINATION_INCOMPLETE', '群列表分页不完整，无法确认团队上下文范围。', 502);
      pageToken = page.pageToken; tokens.add(pageToken);
    } while (true);
  }

  private external(scope: CollaborationScope, source: string, eventId: string, text: string, at: string, refs: string[]): CollaborationObservation {
    return { id: identity(scope, `${source}:${eventId}`), scope, source, eventId, sequence: 1, revision: 1,
      occurredAt: at, receivedAt: at, senderKind: 'system', text: text.slice(0, 16000), refs: refs.slice(0, 100), origin: 'external',
      missing: text.length > 16000 ? ['team_text_truncated'] : [] };
  }

  private async stored(scope: CollaborationScope, at: string) {
    const observations: CollaborationObservation[] = [], missing: string[] = [];
    let afterSequence = 0;
    for (let page = 0; page < 10; page++) {
      const items = await this.options.repository.listObservations(scope, { afterSequence, limit: 100 });
      for (const item of items) {
        if (!sameScope(scope, item.scope)) { missing.push('stored_scope_mismatch'); continue; }
        if (item.source === 'lark.message') observations.push({ ...item, scope, origin: item.origin === 'live' ? 'history' : item.origin });
      }
      if (items.length < 100) break;
      const next = Math.max(afterSequence, ...items.map(item => item.sequence));
      if (next <= afterSequence) { missing.push('stored_pagination_incomplete'); break; }
      afterSequence = next;
      if (page === 9) missing.push('stored_observation_limit_reached');
    }
    const followups = await this.options.repository.listFollowups(scope);
    for (const item of followups) {
      if (!sameScope(scope, item.scope)) { missing.push('stored_scope_mismatch'); continue; }
      observations.push(this.external(scope, 'lark.team.followup', item.id, JSON.stringify({ goal: item.goal, status: item.status,
        progress: item.progress, steps: item.steps, ownerId: item.ownerId, dueAt: item.dueAt, result: item.result,
        createdBy: item.createdBy, updatedBy: item.updatedBy, createdAt: item.createdAt, updatedAt: item.updatedAt }), item.updatedAt || at, [item.id, ...item.sourceRefs]));
    }
    return { observations, missing };
  }

  async read(originScope: CollaborationScope, query: string): Promise<CollaborationTeamContext> {
    const at = (this.options.now?.() ?? new Date()).toISOString();
    const context: CollaborationTeamContext = { query: query.slice(0, 2000), searchedAt: at, sources: [], observations: [] };
    const config = await this.options.readConfig(originScope.appId);
    if (!enabled(config) || config.appId !== originScope.appId) return context;
    const score = relevance(context.query);
    const candidates = [];
    for (const chat of await this.joined(config)) {
      if (chat.chatId === originScope.chatId) continue;
      const scope = { appId: originScope.appId, chatId: chat.chatId };
      let allowed = false;
      try { allowed = await this.options.canRead(scope); } catch { /* Unverified sources have no readable material. */ }
      let stored = { observations: [] as CollaborationObservation[], missing: [] as string[] };
      if (allowed) {
        try {
          stored = await this.stored(scope, at);
        } catch { stored.missing.push('stored_context_unavailable'); }
      }
      const named = Boolean(chat.name.trim() && context.query.toLowerCase().includes(chat.name.trim().toLowerCase()));
      if (!allowed && !named) continue;
      candidates.push({ chat, scope, allowed, ...stored, rank: (named ? 1_000_000 : 0) + score(chat.name)
        + Math.max(0, ...stored.observations.map(item => score(item.text))) });
    }
    candidates.sort((a, b) => b.rank - a.rank || a.chat.chatId.localeCompare(b.chat.chatId));
    for (const candidate of candidates.slice(0, 8)) {
      const source: CollaborationTeamContext['sources'][number] = { scope: candidate.scope, name: candidate.chat.name.slice(0, 256), status: 'complete', missing: [...candidate.missing] };
      context.sources.push(source);
      if (candidates.length > 8) source.missing.push('team_source_limit_reached');
      if (!candidate.allowed) { source.status = 'unavailable'; source.missing.push('context_read_denied'); continue; }
      try {
        // A successful platform read is required even when local observations exist.
        const page = await this.options.serviceFor(config).listChatMessages({ chatId: candidate.scope.chatId, order: 'desc', pageSize: 50 });
        if (page.hasMore) source.missing.push('recent_history_partial');
        const observations = new Map<string, CollaborationObservation>();
        const key = (item: CollaborationObservation) => item.messageId ? `message:${item.messageId}` : item.id;
        for (const item of candidate.observations) observations.set(key(item), item);
        for (const message of page.items) {
          if (message.chatId && message.chatId !== candidate.scope.chatId) { source.missing.push('message_scope_mismatch'); continue; }
          const item = { ...await historicalObservation(candidate.scope, message, at), id: identity(candidate.scope, message.messageId), sequence: 1, revision: 1 };
          observations.set(key(item), item);
        }
        context.observations.push(...observations.values());
        for (const item of observations.values()) source.missing.push(...item.missing);
        source.missing = [...new Set(source.missing)].slice(0, 100);
        if (source.missing.length) source.status = 'partial';
      } catch {
        source.status = 'unavailable'; source.missing.push('message_read_unavailable');
      }
    }
    context.observations.sort((a, b) => score(b.text) - score(a.text) || b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
    if (context.observations.length > 80) {
      const omitted = context.observations.slice(80);
      for (const source of context.sources) if (omitted.some(item => sameScope(item.scope, source.scope))) {
        source.status = 'partial'; source.missing = [...new Set([...source.missing, 'team_observation_limit_reached'])].slice(0, 100);
      }
      context.observations = context.observations.slice(0, 80);
    }
    for (const source of context.sources) source.missing = [...new Set(source.missing)].slice(0, 100);
    return context;
  }

  /** read 排序所用的词面相关度打分；分数为 0 表示文本与查询没有词面重合。 */
  scorer(query: string): (text: string) => number {
    return relevance(query.slice(0, 2000));
  }

  async authorize(originScope: CollaborationScope, context: CollaborationTeamContext): Promise<boolean> {
    try {
      const config = await this.options.readConfig(originScope.appId);
      if (!enabled(config) || config.appId !== originScope.appId) return false;
      if (context.sources.some(source => source.scope.appId !== originScope.appId || source.scope.chatId === originScope.chatId)) return false;
      if (!context.observations.length) return true;
      const chats = new Set((await this.joined(config)).map(chat => chat.chatId));
      for (const item of context.observations) {
        const source = context.sources.find(source => sameScope(source.scope, item.scope));
        if (!source || source.status === 'unavailable' || item.scope.appId !== originScope.appId || item.scope.chatId === originScope.chatId) return false;
      }
      for (const source of context.sources) {
        if (!context.observations.some(item => sameScope(item.scope, source.scope))) continue;
        if (!chats.has(source.scope.chatId) || !await this.options.canRead(source.scope)) return false;
        // Verify the platform's current read permission without changing frozen evidence.
        await this.options.serviceFor(config).listChatMessages({ chatId: source.scope.chatId, pageSize: 1, order: 'desc' });
      }
      return true;
    } catch { return false; }
  }
}
