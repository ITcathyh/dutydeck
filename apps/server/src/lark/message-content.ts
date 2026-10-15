import { fromMarkdown } from 'mdast-util-from-markdown';

export type LarkResourceType = 'image' | 'file';

export interface LarkMessageResource {
  key: string;
  type: LarkResourceType;
  label: string;
  fileName?: string;
  /** 来自转发卡片里的图片；下载失败时只汇总一句，不逐张要求 Agent 告知用户。 */
  fromCard?: boolean;
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

/** 每条卡片消息最多取几张图片。 */
export const MAX_CARD_IMAGES = 4;

/** 深度优先收集卡片里 img 组件的 img_key（卡片 1.0、json_card 与 raw_card_content 附带的 attachment images），按出现顺序去重。 */
const collectCardImageKeys = (root: unknown, attachmentImages?: Record<string, any>): string[] => {
  const keys: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 16 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    const node = value as Record<string, any>;
    if (node.tag === 'code' || node.tag === 'code_block') return;
    // 只解析卡片 Markdown 组件的真实 image token；AST 会排除代码、转义及普通链接。
    if (node.tag === 'markdown' || node.tag === 'md' || node.tag === 'lark_md') {
      const property = asRecord(node.property);
      const markdown = [node.content, node.text, asRecord(node.text)?.content, property?.content, property?.text]
        .find(value => typeof value === 'string');
      if (typeof markdown === 'string' && markdown.includes('![')) {
        const collect = (token: { type: string; url?: string; children?: unknown[] }) => {
          if (token.type === 'image' && token.url && /^img_v\d+_[A-Za-z0-9_-]+$/i.test(token.url) && !keys.includes(token.url)) keys.push(token.url);
          for (const child of token.children ?? []) collect(child as typeof token);
        };
        collect(fromMarkdown(markdown));
      }
    }
    if (node.tag === 'img' || node.tag === 'image') {
      const property = asRecord(node.property);
      let key = [node.img_key, node.image_key, property?.img_key, property?.image_key, node.file_key].find(item => typeof item === 'string' && item.trim());
      // raw_card_content 下 img 节点的 imageID 映射到 json_attachment.images 的真实 key。
      if (!key && attachmentImages) {
        const imageId = [property?.imageID, property?.imageId, node.imageID, node.imageId]
          .find(item => item !== undefined && item !== null && String(item).trim());
        if (imageId !== undefined) {
          const entry = attachmentImages[String(imageId).trim()];
          const record = asRecord(entry);
          key = typeof entry === 'string' && entry.trim()
            ? entry.trim()
            : [record?.origin_key, record?.img_key, record?.image_key].find(item => typeof item === 'string' && item.trim());
        }
      }
      if (key && !keys.includes(key.trim())) keys.push(key.trim());
    }
    for (const child of Object.values(node)) visit(child, depth + 1);
  };
  visit(root, 0);
  return keys;
};

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

  const jsonAttachment = asRecord(parsed?.json_attachment);
  const atUsers = asRecord(jsonAttachment?.at_users);
  const attachmentImages = asRecord(jsonAttachment?.images);

  const resources: LarkMessageResource[] = [];
  const seenResources = new Set<string>();
  const addResource = (type: LarkResourceType, keyValue: unknown, fileNameValue?: unknown, cardLabel?: string) => {
    const key = String(keyValue ?? '').trim();
    if (!key || seenResources.has(`${type}:${key}`)) return '';
    seenResources.add(`${type}:${key}`);
    const fileName = String(fileNameValue ?? '').trim() || undefined;
    const label = cardLabel ?? resourceLabel(type, fileName);
    resources.push({ key, type, label, ...(fileName ? { fileName } : {}), ...(cardLabel ? { fromCard: true } : {}) });
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
      if (content !== undefined && content !== null && typeof content !== 'object' && String(content) !== '') return String(content);
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
    if (tag === 'at') {
      const explicitName = String(node.user_name ?? node.name ?? property?.user_name ?? property?.userName ?? '').trim();
      const rawId = String(property?.userID ?? property?.user_id ?? node.user_id ?? node.userID ?? node.text ?? '').trim();
      let name = explicitName;
      if (!name && rawId && atUsers) {
        const byKey = asRecord(atUsers[rawId]);
        if (byKey?.content) {
          name = String(byKey.content).trim();
        } else {
          const found = Object.values(atUsers).map(asRecord).find(u => u && (u.user_id === rawId || u.mention_key === rawId || u.content === rawId));
          if (found?.content) name = String(found.content).trim();
        }
      }
      const label = (name || rawId).replace(/^@+/, '');
      return label ? `@${label}` : '';
    }
    if (tag === 'img' || tag === 'image') return addResource('image', node.image_key ?? node.file_key, node.file_name);
    if (tag === 'file' || tag === 'media' || tag === 'audio' || tag === 'video') {
      return addResource('file', node.file_key, node.file_name ?? node.name);
    }
    if (tag === 'emotion') return String(node.emoji_type ?? node.text ?? '[表情]');
    // 告警卡的「服务 / 集群 / 规则 / 报警时间」放在 div 的 fields 里，一项一行；正文亦存放于 property.text。
    if (tag === 'div') {
      const fields = node.fields ?? property?.fields;
      if (Array.isArray(fields)) {
        return [node.text ?? property?.text, ...fields.map(field => asRecord(field)?.text ?? field)]
          .map(value => renderNode(value).trim()).filter(Boolean).join('\n');
      }
      return renderNode(node.children ?? node.elements ?? property?.children ?? property?.elements ?? node.content ?? node.text ?? property?.content ?? property?.text ?? '');
    }
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
    const topLevelFiles = Array.isArray(parsed?.files) ? parsed.files : Array.isArray(body?.files) ? body.files : [];
    const fileMarkers: string[] = [];
    for (const file of topLevelFiles) {
      const descriptor = asRecord(file);
      if (!descriptor) continue;
      const fileKey = typeof descriptor.file_key === 'string' ? descriptor.file_key.trim() : '';
      if (!fileKey) continue;
      const marker = addResource('file', fileKey, descriptor.file_name ?? descriptor.name);
      if (marker) fileMarkers.push(marker);
    }
    return { text: [title, ...paragraphs, ...fileMarkers].filter(Boolean).join('\n\n'), resources };
  }

  if (messageType === 'interactive') {
    const rawCard = typeof parsed?.json_card === 'string' ? parseJson(parsed.json_card) : undefined;
    const card = rawCard ?? parsed;
    const headerProperty = asRecord(card?.header?.property);
    const bodyProperty = asRecord(card?.body?.property);
    const title = renderNode(headerProperty?.title ?? card?.header?.title ?? card?.title).trim();
    const subtitle = renderNode(headerProperty?.subtitle ?? card?.header?.subtitle).trim();
    const bodyElements = bodyProperty?.elements ?? card?.body?.elements ?? card?.elements;
    const body = (Array.isArray(bodyElements)
      ? bodyElements.map(renderNode).map(value => value.trim()).filter(Boolean).join('\n\n')
      : renderNode(bodyElements)).trim();
    const hasBodyElements = Array.isArray(bodyElements)
      ? bodyElements.length > 0
      : Boolean(bodyElements && typeof bodyElements === 'object' && Object.keys(bodyElements).length > 0);
    // 转发的告警卡片常带趋势图：和普通图片消息一样交给下载流程，最多 MAX_CARD_IMAGES 张。
    const imageKeys = collectCardImageKeys(card, attachmentImages);
    // image_key 形态也可能已在正文渲染时入列；与 Markdown 图片共用同一条卡片的上限。
    const allowedImages = new Set(imageKeys.slice(0, MAX_CARD_IMAGES));
    for (let index = resources.length - 1; index >= 0; index--) {
      if (resources[index]!.type === 'image' && !allowedImages.has(resources[index]!.key)) resources.splice(index, 1);
    }
    const imageMarkers: string[] = [];
    for (const [index, imageKey] of imageKeys.slice(0, MAX_CARD_IMAGES).entries()) {
      const marker = addResource('image', imageKey, undefined, `卡片图片 ${index + 1}`);
      if (marker) imageMarkers.push(marker);
    }
    if (imageKeys.length > MAX_CARD_IMAGES) imageMarkers.push(`（卡片里还有 ${imageKeys.length - MAX_CARD_IMAGES} 张图片未读取）`);
    const hasImages = imageKeys.length > 0 || resources.some(resource => resource.type === 'image');
    const unparsedBodyNotice = hasBodyElements && !body && !hasImages ? '（卡片正文未能解析，只读到标题）' : '';
    const sections = [title, subtitle, body, imageMarkers.join(' '), unparsedBodyNotice].filter(Boolean);
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
