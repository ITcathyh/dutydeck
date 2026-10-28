import { eventContentLimits, normalizeEventContent, type EventContentPart } from '@dutydeck/shared';
import { MarkdownContent } from '../MarkdownContent';

/** Only embedded raster bytes are previewed. A URI never triggers a fetch. */
export function EventContent({ data }: { data: { text?: string; parts?: unknown } }) {
  const parts: EventContentPart[] = [];
  let nonTextBytes = 2, nonTextCount = 0, omitted = false;
  for (const raw of Array.isArray(data.parts) ? data.parts : []) {
    // Timeline text combines many individually accepted deltas and legacy messages.
    if (raw?.type === 'text' && typeof raw.text === 'string') { parts.push({ type: 'text', text: raw.text }); continue; }
    const part = normalizeEventContent(raw)[0];
    if (!part) continue;
    const bytes = new TextEncoder().encode(JSON.stringify(part)).byteLength + 1;
    if (++nonTextCount > eventContentLimits.parts || nonTextBytes + bytes + 512 > eventContentLimits.totalBytes) {
      if (!omitted) parts.push({ type: 'unsupported', originalType: 'remaining_non_text_content', reason: 'content_budget' });
      omitted = true;
      continue;
    }
    nonTextBytes += bytes;
    parts.push(part);
  }
  if (!parts.length) return <MarkdownContent>{data.text ?? ''}</MarkdownContent>;
  return <div className="space-y-2">{parts.map((part, index) => {
    if (part.type === 'text') return <MarkdownContent key={index}>{part.text}</MarkdownContent>;
    if (part.type === 'unsupported') return <p key={index} className="text-caption text-warning">{part.reason === 'content_budget' ? '内容超过记录上限' : part.reason === 'invalid_content' ? '内容格式无效' : '暂不支持的内容类型'}：{part.originalType}</p>;
    if (part.type === 'image') {
      const preview = /^image\/(?:png|jpeg|gif|webp|avif)$/.test(part.mimeType) && part.data && /^[A-Za-z0-9+/]*={0,2}$/.test(part.data);
      return <figure key={index} className="rounded-lg border border-default p-3">
        <figcaption className="text-caption text-secondary">图片 · {part.mimeType}</figcaption>
        {preview ? <img src={`data:${part.mimeType};base64,${part.data}`} alt="Agent 提供的图片" loading="lazy" className="mt-2 max-h-96 max-w-full object-contain"/> : <p className="text-caption text-subtle">未提供可预览的内嵌图片。</p>}
        {part.uri && <p className="break-all font-mono text-caption text-subtle">{part.uri}</p>}
      </figure>;
    }
    const resource = part.type === 'resource' ? part.resource : part;
    return <div key={index} className="rounded-lg border border-default p-3 text-caption">
      <p className="font-medium text-secondary">{part.type === 'resource_link' ? part.name || '资源引用' : '内嵌资源'}{resource.mimeType ? ` · ${resource.mimeType}` : ''}</p>
      <p className="break-all font-mono text-subtle">{resource.uri}</p>
      {part.type === 'resource_link' && part.description && <p>{part.description}</p>}
      {part.type === 'resource' && part.resource.text !== undefined && <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all">{part.resource.text}</pre>}
      {part.type === 'resource' && part.resource.blob !== undefined && <p className="text-subtle">已记录二进制内容；未自动打开。</p>}
      <p className="text-subtle">此引用不授予下载权限。</p>
    </div>;
  })}</div>;
}
