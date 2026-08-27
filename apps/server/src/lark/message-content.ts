export type LarkResourceType = 'image' | 'file';

export interface LarkMessageResource {
  key: string;
  type: LarkResourceType;
  label: string;
  fileName?: string;
}

export interface ParsedLarkMessage {
  text: string;
  resources: LarkMessageResource[];
}

/**
 * 合并转发（merge_forward）消息需要通过 message_id 拉取被转发的子消息列表。
 * 该回调由调用方注入，返回该消息 API 响应中的全部 items（首条为合并转发消息本身，其余为被转发的子消息）。
 */
export interface LarkMessageItemsFetcher {
  (messageId: string): Promise<Array<{ messageId: string; messageType: string; content: string; sender?: { name?: string }; upperMessageId?: string }>>;
}

export interface ParseLarkMessageOptions {
  messageId?: string;
  fetchMessageItems?: LarkMessageItemsFetcher;
}

const asRecord = (value: unknown): Record<string, any> | undefined => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, any>
  : undefined;

const parseJson = (content: string): Record<string, any> | undefined => {
  try { return asRecord(JSON.parse(content)); }
  catch { return undefined; }
};

function resourceLabel(type: LarkResourceType, fileName?: string) {
  if (fileName?.trim()) return `${type === 'image' ? '图片' : '文件'}「${fileName.trim()}」`;
  return type === 'image' ? '图片' : '文件';
}

export async function parseLarkMessageContent(
  messageType: string,
  content: string,
  options: ParseLarkMessageOptions = {}
): Promise<ParsedLarkMessage> {
  const parsed = parseJson(content);
  if (messageType === 'text') return { text: String(parsed?.text ?? content).trim(), resources: [] };

  const resources: LarkMessageResource[] = [];
  const seenResources = new Set<string>();
  const addResource = (type: LarkResourceType, keyValue: unknown, fileNameValue?: unknown) => {
    const key = String(keyValue ?? '').trim();
    if (!key || seenResources.has(`${type}:${key}`)) return '';
    seenResources.add(`${type}:${key}`);
    const fileName = String(fileNameValue ?? '').trim() || undefined;
    const label = resourceLabel(type, fileName);
    resources.push({ key, type, label, ...(fileName ? { fileName } : {}) });
    return `[${label}]`;
  };

  const renderNode = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(renderNode).filter(Boolean).join('');
    const node = asRecord(value);
    if (!node) return '';
    const tag = String(node.tag ?? '');
    const property = asRecord(node.property);
    if (tag === 'text' || tag === 'plain_text' || tag === 'markdown' || tag === 'code' || tag === 'code_block') {
      const content = node.text ?? node.content ?? property?.content ?? property?.text;
      if (content !== undefined && content !== null && String(content) !== '') return String(content);
    }
    if (tag === 'br') return '\n';
    if (tag === 'a') {
      const text = String(node.text ?? node.href ?? node.url ?? '');
      const href = String(node.href ?? node.url ?? '');
      return href && href !== text ? `${text} (${href})` : text;
    }
    if (tag === 'link') {
      const text = String(node.text ?? node.content ?? property?.content ?? '');
      const url = asRecord(property?.url);
      const href = String(node.href ?? node.url ?? url?.url ?? '');
      return href && href !== text ? `${text} (${href})` : text;
    }
    if (tag === 'at') return `@${String(node.user_name ?? node.name ?? node.text ?? '')}`;
    if (tag === 'img' || tag === 'image') return addResource('image', node.image_key ?? node.file_key, node.file_name);
    if (tag === 'file' || tag === 'media' || tag === 'audio' || tag === 'video') {
      return addResource('file', node.file_key, node.file_name ?? node.name);
    }
    if (tag === 'emotion') return String(node.emoji_type ?? node.text ?? '[表情]');
    return renderNode(node.children ?? node.elements ?? property?.children ?? property?.elements ?? node.content ?? node.text ?? property?.content ?? '');
  };

  if (messageType === 'post' || messageType === 'rich_text') {
    const localized = parsed && !Array.isArray(parsed.content) && !Array.isArray(parsed.content_v2)
      ? asRecord(parsed.zh_cn) ?? asRecord(parsed.en_us) ?? Object.values(parsed).map(asRecord).find(Boolean)
      : undefined;
    const body = localized ?? parsed;
    const title = String(body?.title ?? '').trim();
    const rows = Array.isArray(body?.content_v2) ? body.content_v2 : Array.isArray(body?.content) ? body.content : [];
    const paragraphs = rows.map((row: unknown) => renderNode(row).trim()).filter(Boolean);
    return { text: [title, ...paragraphs].filter(Boolean).join('\n\n'), resources };
  }

  if (messageType === 'interactive') {
    const rawCard = typeof parsed?.json_card === 'string' ? parseJson(parsed.json_card) : undefined;
    const card = rawCard ?? parsed;
    const headerProperty = asRecord(card?.header?.property);
    const bodyProperty = asRecord(card?.body?.property);
    const title = renderNode(headerProperty?.title ?? card?.header?.title).trim();
    const subtitle = renderNode(headerProperty?.subtitle ?? card?.header?.subtitle).trim();
    const bodyElements = bodyProperty?.elements ?? card?.body?.elements ?? card?.elements;
    const body = (Array.isArray(bodyElements)
      ? bodyElements.map(renderNode).map(value => value.trim()).filter(Boolean).join('\n\n')
      : renderNode(bodyElements)).trim();
    const sections = [title, subtitle, body].filter(Boolean);
    return { text: sections.join('\n\n') || '收到一张没有可读文本的飞书卡片。', resources };
  }

  if (messageType === 'image') {
    const marker = addResource('image', parsed?.image_key, parsed?.file_name);
    return { text: marker || '收到一张飞书图片，但消息中没有可读取的图片标识。', resources };
  }
  if (['file', 'audio', 'media', 'video'].includes(messageType)) {
    const marker = addResource('file', parsed?.file_key, parsed?.file_name ?? parsed?.name);
    return { text: marker || `收到一条飞书${messageType}消息，但消息中没有可读取的资源标识。`, resources };
  }

  if (messageType === 'merge_forward') {
    const fetchItems = options.fetchMessageItems;
    const messageId = options.messageId;
    if (!fetchItems || !messageId) {
      const idHint = messageId ? `（message_id: ${messageId}）` : '';
      return { text: `收到一条合并转发消息${idHint}。如需查看转发的具体内容，请使用获取消息详情工具按 message_id 拉取。`, resources };
    }
    try {
      const items = await fetchItems(messageId);
      // 合并转发消息的响应中，items 包含合并转发消息本身及其被转发的子消息。
      // 子消息的 upper_message_id 指向合并转发消息的 message_id；若 API 未返回该字段，
      // 则退化为取除首条（合并转发消息本身）之外的所有 items。
      const children = items.some(item => item.upperMessageId)
        ? items.filter(item => item.upperMessageId === messageId)
        : items.slice(1);
      const parts: string[] = [];
      for (const child of children) {
        const childParsed = await parseLarkMessageContent(child.messageType, child.content, {
          ...options,
          messageId: child.messageId
        });
        const senderName = child.sender?.name?.trim();
        parts.push(senderName ? `${senderName}: ${childParsed.text}` : childParsed.text);
        resources.push(...childParsed.resources);
      }
      const text = parts.filter(Boolean).join('\n\n');
      return { text: text || '收到一条合并转发消息，但其中没有可读取的内容。', resources };
    } catch {
      return { text: '收到一条合并转发消息，但拉取其中内容失败。', resources };
    }
  }

  const fallbackText = String(parsed?.text ?? parsed?.content ?? '').trim();
  return { text: fallbackText || `收到一条暂不支持的飞书消息（类型：${messageType || 'unknown'}）。`, resources };
}
