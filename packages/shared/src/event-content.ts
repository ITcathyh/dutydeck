/** ACP content with bounded non-text payloads. URIs are evidence references, never read/download grants. */
export type EventContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data?: string; uri?: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string; blob?: string } }
  | { type: 'resource_link'; uri: string; name?: string; mimeType?: string; description?: string }
  | { type: 'unsupported'; originalType: string; reason: 'unsupported_type' | 'invalid_content' | 'content_budget' };

/** Non-text payload budgets; existing text replies retain their original data.text. */
export const eventContentLimits = Object.freeze({ parts: 64, partBytes: 128 * 1024, totalBytes: 256 * 1024 });
const encoder = new TextEncoder();
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const string = (value: unknown) => typeof value === 'string' ? value : undefined;
const short = (value: unknown) => string(value)?.slice(0, 2048);
const unsupported = (originalType: string, reason: Extract<EventContentPart, { type: 'unsupported' }>['reason']): EventContentPart => ({ type: 'unsupported', originalType: originalType.slice(0, 80), reason });

/** Tool content wraps ACP ContentBlock in {type:'content',content}; diff/terminal stay visible. */
export function normalizeEventContent(value: unknown): EventContentPart[] {
  const input = Array.isArray(value) ? value : value == null ? [] : [value];
  const parts: EventContentPart[] = [];
  let bytes = 2, nonTextCount = 0, omitted = false;
  for (let index = 0; index < input.length; index++) {
    let item = record(input[index]);
    if (item?.type === 'content') item = record(item.content);
    const type = short(item?.type) ?? 'unknown';
    if (type === 'text' && typeof item?.text === 'string') {
      const last = parts.at(-1);
      if (last?.type === 'text') parts[parts.length - 1] = { type: 'text', text: last.text + item.text };
      else parts.push({ type: 'text', text: item.text });
      continue;
    }
    if (++nonTextCount >= eventContentLimits.parts) {
      if (!omitted) parts.push(unsupported('remaining_non_text_content', 'content_budget'));
      omitted = true;
      continue;
    }
    const resourceMetadata = record(item?.resource);
    const metadata = [item?.type, item?.mimeType, item?.uri, item?.name, item?.description, resourceMetadata?.uri, resourceMetadata?.mimeType];
    let part: EventContentPart;
    if (type === 'image' && typeof item?.mimeType === 'string' && (typeof item.data === 'string' || typeof item.uri === 'string')) {
      part = { type, mimeType: short(item.mimeType)!, ...(string(item.data) !== undefined ? { data: item.data as string } : {}), ...(short(item.uri) !== undefined ? { uri: short(item.uri) } : {}) };
    } else if (type === 'resource') {
      const resource = record(item?.resource);
      part = typeof resource?.uri === 'string' ? { type, resource: { uri: short(resource.uri)!, ...(short(resource.mimeType) ? { mimeType: short(resource.mimeType) } : {}), ...(string(resource.text) !== undefined ? { text: resource.text as string } : {}), ...(string(resource.blob) !== undefined ? { blob: resource.blob as string } : {}) } } : unsupported(type, 'invalid_content');
    } else if (type === 'resource_link' && typeof item?.uri === 'string') {
      part = { type, uri: short(item.uri)!, ...(short(item.name) ? { name: short(item.name) } : {}), ...(short(item.mimeType) ? { mimeType: short(item.mimeType) } : {}), ...(short(item.description) ? { description: short(item.description) } : {}) };
    } else if (type === 'unsupported' && ['content_budget', 'unsupported_type', 'invalid_content'].includes(String(item?.reason))) part = unsupported(short(item?.originalType) ?? 'unknown', item?.reason as Extract<EventContentPart, { type: 'unsupported' }>['reason']);
    else part = unsupported(type, ['text', 'image', 'resource_link'].includes(type) ? 'invalid_content' : 'unsupported_type');
    // Oversized URIs cannot silently turn into a reference to a different target.
    if (metadata.some(value => typeof value === 'string' && value.length > 2048)) part = unsupported(type, 'content_budget');
    // Reject giant strings before JSON encoding; UTF-8 bytes can only be larger.
    const payload = part.type === 'image' ? part.data : part.type === 'resource' ? Math.max(part.resource.text?.length ?? 0, part.resource.blob?.length ?? 0) : undefined;
    if ((typeof payload === 'number' ? payload : payload?.length ?? 0) > eventContentLimits.partBytes || encoder.encode(JSON.stringify(part)).byteLength > eventContentLimits.partBytes) part = unsupported(type, 'content_budget');
    const size = encoder.encode(JSON.stringify(part)).byteLength + 1;
    if (bytes + size + 512 > eventContentLimits.totalBytes) {
      if (!omitted) parts.push(unsupported('remaining_non_text_content', 'content_budget'));
      omitted = true;
      continue;
    }
    bytes += size;
    parts.push(part);
  }
  return parts;
}

/** Adjacent text chunks must remain one Markdown document in the timeline. */
export function appendEventContent(previous: readonly EventContentPart[], current: readonly EventContentPart[]): EventContentPart[] {
  // These are accepted event parts. The single-event persistence budget must not
  // truncate an accumulated answer or a legacy data.text message.
  const result = [...previous];
  for (const part of current) {
    const last = result.at(-1);
    if (part.type === 'text' && last?.type === 'text') result[result.length - 1] = { type: 'text', text: last.text + part.text };
    else result.push(part);
  }
  return result;
}

export const eventContentText = (parts: readonly EventContentPart[]) => parts.filter((part): part is Extract<EventContentPart, { type: 'text' }> => part.type === 'text').map(part => part.text).join('');
export function eventHasContent(data: { text?: unknown; parts?: unknown } | undefined): boolean {
  return Boolean(typeof data?.text === 'string' && data.text.trim() || Array.isArray(data?.parts) && data.parts.some(part => part?.type === 'text' ? typeof part.text === 'string' && part.text.trim() : Boolean(part?.type && part.type !== 'unsupported')));
}

export interface EventArtifactReference {
  taskId: string; attemptId: string; eventId: string; sequence: number; partIndex: number;
  uri?: string; name?: string; mimeType?: string;
  /** Event identity is an immutable recorded revision, not a digest of the current URI target. */
  revision: string;
  status: 'recorded' | 'delivered';
  source: 'structured_tool_result' | 'assistant_attachment' | 'attachment_receipt';
}
export interface ArtifactSourceEvent {
  id: string; sequence: number; type: string; taskId?: string; attemptId?: string; data: unknown;
}

/** No path guesses, file reads, remote fetches, or provider-supplied task/attempt identity. */
export function extractEventArtifactReferences(event: ArtifactSourceEvent): EventArtifactReference[] {
  if (!event.taskId || !event.attemptId || !Number.isSafeInteger(event.sequence) || event.sequence < 0) return [];
  const data = record(event.data);
  const tool = event.type === 'tool_result' && data?.status === 'completed';
  const assistant = event.type === 'text' && data?.role !== 'user';
  if (!tool && !assistant) return [];
  const common = { taskId: event.taskId, attemptId: event.attemptId, eventId: event.id, sequence: event.sequence };
  const refs: EventArtifactReference[] = normalizeEventContent(data?.parts).flatMap((part, partIndex) => {
    if (part.type === 'text' || part.type === 'unsupported') return [];
    const resource = part.type === 'resource' ? part.resource : part;
    return [{ ...common, partIndex, ...(resource.uri ? { uri: resource.uri } : {}), ...(part.type === 'resource_link' && part.name ? { name: part.name } : {}), ...(resource.mimeType ? { mimeType: resource.mimeType } : {}), revision: `event:${event.id}:${event.sequence}:${partIndex}`, status: 'recorded' as const, source: tool ? 'structured_tool_result' as const : 'assistant_attachment' as const }];
  });
  // Existing private-result tools return this receipt without exposing file bytes or download rights.
  const receipt = record(data?.output);
  if (tool && receipt?.status === 'delivered' && typeof receipt.deliveryId === 'string' && typeof receipt.fileCount === 'number' && receipt.fileCount > 0) {
    refs.push({ ...common, partIndex: -1, uri: `dutydeck-result:${receipt.deliveryId.slice(0, 256)}`, revision: `event:${event.id}:${event.sequence}:receipt`, status: 'delivered', source: 'attachment_receipt' });
  }
  return refs;
}
