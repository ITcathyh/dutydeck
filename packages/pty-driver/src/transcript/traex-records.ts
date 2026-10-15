import type { NormalizedDriverEvent } from '@dutydeck/shared';
import { mapCodexEntry } from './codex.js';
import { traexDisplayCompletions, traexUserText } from './input-receipt.js';

function text(value: any): string {
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? value.filter(b => ['text', 'Text', 'output_text'].includes(b?.type) && typeof b.text === 'string').map(b => b.text).join('') : '';
}

/** Only validated display UserMessages acknowledge input. Model-visible items
 * can include injected role:user records and cannot serve as receipts. */
export function traexEntries(entry: any, threadId?: string): any[] {
  const p = entry?.payload;
  if (entry?.type !== 'history_mutation') return [entry];
  if (p?.operation !== 'append' || typeof p.turn_id !== 'string' || !p.turn_id) return [];
  const completions = traexDisplayCompletions(p, threadId);
  const reasoning = new Map(completions.filter((c: any) => c.item?.type === 'Reasoning' && typeof c.item.id === 'string').map((c: any) => [c.item.id, c.item]));
  const entries: any[] = [];
  const addReasoning = (item: any) => {
    const summary = Array.isArray(item.summary_text) ? item.summary_text.filter((v: unknown) => typeof v === 'string' && v) : [];
    const raw = Array.isArray(item.raw_content) ? item.raw_content.filter((v: unknown) => typeof v === 'string' && v) : [];
    entries.push({ ...entry, type: 'response_item', payload: { type: 'reasoning', turn_id: p.turn_id, id: item.id,
      summary: summary.map((text: string) => ({ type: 'summary_text', text })), content: raw.map((text: string) => ({ type: 'reasoning_text', text })) } });
  };
  for (const item of Array.isArray(p.items) ? p.items : []) {
    if (item?.role === 'user') continue;
    if (item?.type === 'reasoning' && reasoning.has(item.id)) { addReasoning(reasoning.get(item.id)); reasoning.delete(item.id); }
    else if (item?.type !== 'message') entries.push({ ...entry, type: 'response_item', payload: { ...item, turn_id: p.turn_id,
      ...(['function_call_output', 'custom_tool_call_output'].includes(item?.type) && Array.isArray(item.output) ? { output: text(item.output) } : {}) } });
  }
  for (const item of reasoning.values()) addReasoning(item);
  for (const c of completions) {
    let item = c.item;
    if (item?.type === 'Reasoning') continue;
    if (item?.type === 'UserMessage') {
      const input = traexUserText(item);
      if (input === undefined) continue;
      // Receipt matching and NativeTurn must see the same validated body.
      item = { ...item, content: input };
    }
    entries.push({ ...entry, type: 'event_msg', payload: { type: 'item_completed', turn_id: p.turn_id, item } });
  }
  return entries;
}

export function mapTraexRecord(entry: any): NormalizedDriverEvent[] | undefined {
  const shared = mapCodexEntry(entry);
  if (shared) return shared;
  const p = entry?.payload;
  if (entry?.type !== 'event_msg') return undefined;
  const item = p?.type === 'agent_message' ? p : p?.type === 'item_completed' && (p.item?.type ?? p.item?.item_type) === 'AgentMessage' ? p.item : undefined;
  if (!item) return undefined;
  const body = text(item.message ?? item.text ?? item.content);
  if (!body) return undefined;
  if (item.phase && item.phase !== 'final' && item.phase !== 'final_answer') return [{ type: 'thinking', data: { text: body, phase: item.phase } }];
  return [{ type: 'text', data: { text: body } }];
}

/** Keep phase-less mirrors until terminal; an explicit commentary mirror must
 * never be promoted to a final answer just because another omits phase. */
export class TraexMessageProjection {
  private turn?: string;
  private readonly messages = new Map<string, { text: string; phase?: string }>();
  private readonly emitted = new Set<string>();
  private lastText?: string;
  reset(): void { this.turn = this.lastText = undefined; this.messages.clear(); this.emitted.clear(); }
  map(entry: any): NormalizedDriverEvent[] | undefined {
    const p = entry?.payload;
    if (p?.turn_id && p.turn_id !== this.turn) { this.reset(); this.turn = p.turn_id; }
    const events = mapTraexRecord(entry);
    if (entry?.type === 'response_item' && p?.type === 'reasoning' && typeof p.id === 'string') {
      const key = `reasoning\0${p.id}`;
      if (this.emitted.has(key)) return undefined;
      if (events?.length) this.emitted.add(key);
    }
    const item = entry?.type === 'response_item' && p?.type === 'message' && p.role === 'assistant' ? p
      : entry?.type === 'event_msg' && (p?.type === 'agent_message' ? p : p?.type === 'item_completed' && (p.item?.type ?? p.item?.item_type) === 'AgentMessage' ? p.item : undefined);
    if (item && typeof item.id === 'string') {
      const previous = this.messages.get(item.id);
      const body = !item.phase && previous?.phase ? previous.text : text(item.message ?? item.text ?? item.content);
      const phase = item.phase ?? previous?.phase;
      this.messages.set(item.id, { text: body, phase });
      if (!phase) return undefined;
      const key = `${item.id}\0${['final', 'final_answer'].includes(phase) ? 'final' : phase}\0${body}`;
      if (this.emitted.has(key)) return undefined;
      this.emitted.add(key);
      if (phase === 'final' || phase === 'final_answer') this.lastText = body;
      return phase !== item.phase ? undefined : events ?? (body && phase !== 'final' && phase !== 'final_answer'
        ? [{ type: 'thinking', data: { text: body, phase } }] : undefined);
    }
    if (entry?.type === 'event_msg' && p?.type === 'task_complete') {
      const result = [...(events ?? [])];
      if (!p.last_agent_message) {
        const candidate = [...this.messages.values()].reverse().find(m => !m.phase || m.phase === 'final' || m.phase === 'final_answer');
        if (candidate?.text && candidate.text !== this.lastText) result.unshift({ type: 'text', data: { text: candidate.text } });
      } else if (p.last_agent_message === this.lastText) return result.filter(e => e.type !== 'text');
      this.lastText = result.find(e => e.type === 'text')?.data.text ?? this.lastText;
      return result.length ? result : undefined;
    }
    if (events?.some(e => e.type === 'text')) this.lastText = events.find(e => e.type === 'text')!.data.text;
    return events;
  }
}
