import { parseLarkSourceId, type Session, type SessionSourceContext } from '@dutydeck/shared';
import { isBotSenderType } from './card-mentions.js';
import { readLarkConfig } from './config.js';
import { withLarkContextReadTimeout } from './context-read-timeout.js';
import { parseOptionalCardTask } from './persisted-card-task.js';
import type { LarkRoutesOptions } from './routes.js';
import { createLarkCardService, type LarkCardService } from './service.js';

type SourceOptions = Pick<LarkRoutesOptions, 'cardMappings' | 'config' | 'service' | 'env' | 'fetcher'>;

export function createLarkSessionSourceResolver(options: SourceOptions) {
  const cache = new Map<string, { until: number; value: Promise<SessionSourceContext | undefined> }>();
  return async (session: Session): Promise<SessionSourceContext | undefined> => {
    if (session.source !== 'lark') return undefined;
    const { appId, chatId, chatType, scope } = parseLarkSourceId(session.sourceId);
    if (!appId || !chatId || (chatType !== 'group' && chatType !== 'p2p')) return undefined;
    const key = `${session.id}:${session.sourceId}`;
    const cached = cache.get(key);
    if (cached && cached.until > Date.now()) return cached.value;
    const resolve = async () => {
      const bot = await readLarkConfig(options.config, appId).catch(() => undefined);
      const host = bot?.brand === 'lark' ? 'applink.larksuite.com' : 'applink.feishu.cn';
      const chatUrl = new URL(`https://${host}/client/chat/open`);
      chatUrl.searchParams.set('openChatId', chatId);
      const rows = await options.cardMappings?.list(`lark-card:${appId}`).catch(() => []) ?? [];
      let origin: { mapping: typeof rows[number]; saved: NonNullable<ReturnType<typeof parseOptionalCardTask>> } | undefined;
      for (const mapping of rows.filter(row => row.sessionId === session.id && row.channel === `lark-card:${appId}`)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
        try {
          const saved = parseOptionalCardTask(mapping.extra);
          if (saved?.app_id && saved.app_id !== appId || saved?.chat_id && saved.chat_id !== chatId) continue;
          if (saved?.app_id === appId && saved.chat_id === chatId) origin = { mapping, saved };
        } catch { /* A broken earliest origin must not promote a later follow-up to the original request. */ }
        break;
      }
      const saved = origin?.saved;
      const scopedActor = scope[0] === 'user' && scope[1]?.startsWith('ou_') ? scope[1] : undefined;
      const storedActor = (saved?.turn ?? 1) <= 1 ? saved?.sender_open_id?.trim() : undefined;
      const actor = storedActor || scopedActor;
      const actorType = actor && actor === storedActor && saved?.sender_type
        ? isBotSenderType(saved.sender_type) ? 'bot' as const : saved.sender_type === 'user' ? 'user' as const : undefined : undefined;
      const context: SessionSourceContext = {
        channel: 'lark', chat: { id: chatId, name: chatType === 'p2p' ? '私聊' : chatId, type: chatType, url: chatUrl.toString() },
        ...(actor ? { initiator: { id: actor, name: actor, ...(actorType ? { type: actorType } : {}) } } : {}),
        originAvailable: Boolean(origin)
      };
      const topic = (threadId: string) => {
        const url = new URL(`https://${host}/client/thread/open`);
        for (const key of ['open_chat_id', 'openchatid']) url.searchParams.set(key, chatId);
        for (const key of ['open_thread_id', 'openthreadid']) url.searchParams.set(key, threadId);
        url.searchParams.set('thread_position', '-1');
        return { id: threadId, title: '打开来源话题', url: url.toString() };
      };
      const threadId = saved?.thread_id?.trim() || (scope[0] === 'thread' && scope[1]?.startsWith('omt_') ? scope[1] : undefined);
      if (threadId) context.topic = topic(threadId);
      const signal = AbortSignal.timeout(2_000);
      const fetcher: typeof fetch = (input, init) => (options.fetcher ?? globalThis.fetch)(input, {
        ...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])])
      });
      const client: LarkCardService | undefined = options.service ?? (bot ? createLarkCardService(options.env ?? process.env, fetcher, bot) : undefined);
      if (!client) return context;
      // Each completed read survives the overall deadline; return a snapshot so late reads cannot mutate it.
      const enrich = async () => {
        const readInitiator = async () => {
          const messageId = origin?.mapping.externalId.startsWith('om_') ? origin.mapping.externalId : saved?.reply_message_id?.trim();
          const message = messageId?.startsWith('om_') ? await client.getMessage(messageId).catch(() => undefined) : undefined;
          if (message && message.chatId === chatId && message.messageId === messageId) {
            const sender = message.sender;
            if (sender.id?.startsWith('ou_') && (!sender.idType || sender.idType === 'open_id')) {
              const type = isBotSenderType(sender.type) ? 'bot' : sender.type === 'user' ? 'user'
                : context.initiator?.id === sender.id ? context.initiator.type : undefined;
              context.initiator = { id: sender.id, name: sender.name?.trim() || sender.id, ...(type ? { type } : {}) };
            }
            if (!context.topic && message.threadId) context.topic = topic(message.threadId);
          }
          const initiator = context.initiator;
          if (initiator?.type === 'user') {
            const user = await client.getContactUser(initiator.id, 'open_id').catch(() => undefined);
            if (user?.openId === initiator.id && user.name?.trim()) initiator.name = user.name.trim();
          }
        };
        await Promise.all([
          chatType === 'group' ? client.getChatPreflightInfo(chatId).then(chat => { if (chat.name?.trim()) context.chat.name = chat.name.trim(); }).catch(() => {}) : undefined,
          readInitiator()
        ]);
        return structuredClone(context);
      };
      return withLarkContextReadTimeout(enrich(), '会话来源读取', 2_000).catch(() => structuredClone(context));
    };
    const value = resolve().catch(() => undefined);
    cache.delete(key);
    cache.set(key, { until: Date.now() + 60_000, value });
    while (cache.size > 200) cache.delete(cache.keys().next().value!);
    return value;
  };
}
