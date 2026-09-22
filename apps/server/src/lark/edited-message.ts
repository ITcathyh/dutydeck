import type { LarkChatMessage } from './service.js';
import type { LarkMessageEvent } from './listener.js';

/**
 * 飞书「修改」消息走的是富文本编辑器：一条原本的 text 消息保存后，REST 回读的
 * body.content 会变成 {"text":"<p>正文</p>"}（多段为多个 <p>），而正常 WS 事件
 * 是 {"text":"正文"}。若不解包，字面 HTML 会漏给执行侧，且 `<p>/solve …</p>`
 * 这类编辑补 @ 的斜杠命令会让群闸 startsWith('/') 失效。这里只把「整段恰好被一个
 * 或多个 <p> 包裹」的 text 还原成按换行连接的纯文本；能确认整体就是段落包裹时才
 * 处理，并还原段内 br 与必要文本实体；其它标签保留。rich post 不走这里，原样保留。
 */
export function unwrapEditedTextContent(rawContent: string): string {
  let parsed: any;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return rawContent;
  }
  const text = parsed?.text;
  if (typeof text !== 'string' || !text.includes('<p>')) return rawContent;
  const paragraphs = [...text.matchAll(/<p>([\s\S]*?)<\/p>/g)].map(match => match[1]);
  // 去掉所有 <p>…</p> 后若还有非空白残留，说明 <p> 只是正文的一部分，保持原样。
  const residual = text.replace(/<p>[\s\S]*?<\/p>/g, '').trim();
  if (paragraphs.length === 0 || residual !== '') return rawContent;
  const entities: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
  const unwrapped = paragraphs.join('\n').replace(/<br\s*\/?\s*>/g, '\n')
    .replace(/&(?:amp|lt|gt|quot|nbsp|#39);/g, entity => entities[entity]!);
  return JSON.stringify({ ...parsed, text: unwrapped });
}

export interface BuildEditedMessageEventInput {
  /** updated_v1 事件通知里的 message_id；必须与权威详情一致，防止错配响应。 */
  eventMessageId: string;
  /** service.getMessage 按 message_id 回读的权威当前消息。 */
  detail: LarkChatMessage;
  botOpenId: string;
  /** 现有群形态查询；失败时调用方让其抛出，绝不猜测 chatType。 */
  resolveChatType: (appId: string, chatId: string) => Promise<'topic' | 'group' | 'p2p'>;
  appId: string;
}

/**
 * 用消息详情（而非事件正文）构造与 receive_v1 同构的 LarkMessageEvent。
 * 任一身份/消息校验不满足时返回 undefined；群形态查询异常交由调用方记录并忽略。
 * 关键身份约束：sender 永远取详情里的**原作者**，编辑操作者不进入事件。
 */
export async function buildEditedMessageEvent(input: BuildEditedMessageEventInput): Promise<LarkMessageEvent | undefined> {
  const { eventMessageId, detail, botOpenId, resolveChatType, appId } = input;
  if (detail.messageId !== eventMessageId) return undefined;
  if (detail.deleted) return undefined;
  const chatId = detail.chatId;
  if (!chatId) return undefined;
  // 编辑补 @ 只处理人类原消息：bot/app 消息（含卡片刷新）不触发任务。
  if (detail.sender.type !== 'user' || detail.sender.idType !== 'open_id' || !detail.sender.id) return undefined;
  // 必须显式 @ 当前 bot，且 mention 身份域必须是 open_id（与 receive 路径同判据）。
  const mentionsBot = detail.mentions.some(mention => mention.idType === 'open_id' && mention.id === botOpenId);
  if (!mentionsBot) return undefined;
  const chatMode = await resolveChatType(appId, chatId);
  return {
    messageId: detail.messageId,
    chatId,
    chatType: chatMode === 'p2p' ? 'p2p' : 'group',
    ...(detail.rootId ? { rootId: detail.rootId } : {}),
    ...(detail.parentId ? { parentId: detail.parentId } : {}),
    ...(detail.threadId ? { threadId: detail.threadId } : {}),
    createTime: detail.createTime,
    messageType: detail.messageType,
    content: detail.messageType === 'text' ? unwrapEditedTextContent(detail.rawContent) : detail.rawContent,
    senderOpenId: detail.sender.id,
    senderType: detail.sender.type,
    mentions: detail.mentions.map(mention => ({
      key: mention.key ?? '',
      name: mention.name ?? '',
      // REST 详情只给 id/id_type，没有 WS 的 mentioned_type；匹配只靠 open_id，不猜类型。
      ...(mention.idType === 'open_id' && mention.id ? { openId: mention.id } : {})
    }))
  };
}
