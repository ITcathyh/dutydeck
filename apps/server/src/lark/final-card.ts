import { LarkServiceError } from './service.js';
import { canonicalExecutionJson } from '@dutydeck/shared';
import { redactTraceText } from './secret-redaction.js';

export interface FinalCardBody { elements: Array<Record<string, any>>; direction?: 'vertical' | 'horizontal'; padding?: string; vertical_spacing?: string; horizontal_spacing?: string; horizontal_align?: string; vertical_align?: string }
const tags = new Set(['markdown', 'plain_text', 'hr', 'img', 'div', 'column_set', 'column', 'collapsible_panel', 'table', 'person', 'person_list', 'standard_icon', 'custom_icon', 'text_tag', 'note']);
/** Static Card 2.0 body only. Host callbacks, IDs and interactive components remain host-owned. */
export function parseFinalCardBody(raw: unknown): FinalCardBody {
  const invalid = () => new LarkServiceError('INVALID_FINAL_CARD', 'cardBody 必须是小于 28 KB 的静态 Card 2.0 body；不允许交互组件、回调或 element_id。', 400);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid();
  const body = raw as Record<string, unknown>;
  if (!Array.isArray(body.elements) || !body.elements.length || body.elements.some(item => !item || typeof item !== 'object' || Array.isArray(item) || typeof item.tag !== 'string')
    || Object.keys(body).some(key => !['elements', 'direction', 'padding', 'vertical_spacing', 'horizontal_spacing', 'horizontal_align', 'vertical_align'].includes(key))
    || body.direction !== undefined && !['vertical', 'horizontal'].includes(String(body.direction))
    || Object.entries(body).some(([key, value]) => key !== 'elements' && typeof value !== 'string')) throw invalid();
  let nodes = 0;
  const visit = (value: unknown, depth = 0): unknown => {
    if (++nodes > 2000 || depth > 20) throw invalid();
    if (typeof value === 'string') {
      if (/(?:javascript|vbscript|data)\s*:/i.test(value)) throw invalid();
      return redactTraceText(value);
    }
    if (Array.isArray(value)) return value.map(item => visit(item, depth + 1));
    if (value && typeof value === 'object') {
      const item = value as Record<string, unknown>;
      if (item.tag !== undefined && (typeof item.tag !== 'string' || !tags.has(item.tag))) throw invalid();
      if (['markdown', 'plain_text'].includes(String(item.tag)) && typeof item.content !== 'string'
        || item.tag === 'img' && (typeof item.img_key !== 'string' || !item.img_key.trim())
        || item.tag === 'column_set' && !Array.isArray(item.columns)
        || ['column', 'note', 'collapsible_panel'].includes(String(item.tag)) && !Array.isArray(item.elements)
        || item.tag === 'table' && (!Array.isArray(item.columns) || !Array.isArray(item.rows))) throw invalid();
      const result: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(item)) {
        if (['element_id', 'behaviors', 'action', 'actions', 'form_action_type', 'callback', 'value', '__proto__', 'constructor', 'prototype'].includes(key) || key.startsWith('dutydeck_')) throw invalid();
        if (key === 'url' && (typeof field !== 'string' || !/^https?:\/\//i.test(field))) throw invalid();
        result[key] = visit(field, depth + 1);
      }
      return result;
    }
    if (value === null || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') return value;
    throw invalid();
  };
  const normalized = canonicalExecutionJson(visit(body));
  if (Buffer.byteLength(normalized) > 28_000) throw invalid();
  return JSON.parse(normalized) as FinalCardBody;
}
