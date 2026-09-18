import type { CollaborationSnapshot, CollaborationFollowup, CollaborationObservation, CollaborationMandate } from '@dutydeck/shared';

const MAX_BYTES = 512 * 1024;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Model input only: never use this sampled copy for authorization or state transitions. */
export function boundCollaborationSnapshot(source: CollaborationSnapshot, followupId?: string): CollaborationSnapshot {
  const omitted = new Map<string, number>();
  const truncated = new Map<string, number>();
  const mark = (counts: Map<string, number>, field: string, count = 1) => counts.set(field, (counts.get(field) ?? 0) + count);
  const text = (value: string, limit: number, field: string) => {
    if (bytes(value) <= limit) return value;
    // JSON escaping and multibyte characters both count toward the persisted byte limit.
    let low = 0; let high = value.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (bytes(value.slice(0, mid)) <= limit) low = mid; else high = mid - 1;
    }
    if (low && /[\uD800-\uDBFF]/.test(value[low - 1]!)) low--;
    mark(truncated, field);
    return value.slice(0, low);
  };
  const list = (values: string[], limit: number, field: string) => {
    const selected: string[] = []; let size = 2;
    for (const value of values) {
      const next = bytes(value) + 1;
      if (size + next > limit) break;
      selected.push(value); size += next;
    }
    if (selected.length < values.length) mark(truncated, field, values.length - selected.length);
    return selected;
  };
  const missing = (original: string[], added: string[], limit = Infinity) => {
    const priority = new Set(['decision_text_truncated', 'context_text_truncated', 'context_metadata_truncated']);
    added = [...new Set([...added, ...original.filter(value => priority.has(value))])];
    original = original.filter(value => !priority.has(value));
    if (original.length + added.length <= 100 && bytes([...original, ...added]) <= limit) return { values: [...original, ...added], omitted: 0 };
    const rows: Array<{ text: string; count: number }> = [];
    for (const value of original) {
      const last = rows.at(-1);
      if (last && last.text.length + value.length + 2 <= 256) { last.text += `; ${value}`; last.count++; }
      else rows.push({ text: value, count: 1 });
    }
    const kept: string[] = []; let count = 0; let size = bytes(added) + 80;
    for (const row of rows) {
      if (kept.length >= 99 - added.length || size + bytes(row.text) + 1 > limit) break;
      kept.push(row.text); count += row.count; size += bytes(row.text) + 1;
    }
    const omitted = original.length - count;
    return { values: [...kept, ...(omitted ? [`missing_details_omitted=${omitted}`] : []), ...added], omitted };
  };
  const followup = (item: CollaborationFollowup): CollaborationFollowup => {
    const fields: Record<string, string> = {}; let size = 2; let count = 0;
    for (const key in item.fields) {
      if (!Object.hasOwn(item.fields, key)) continue;
      const value = item.fields[key]!;
      const next = bytes(key) + bytes(value) + 2;
      if (size + next <= 8192) { Object.defineProperty(fields, key, { value, enumerable: true, writable: true, configurable: true }); size += next; } else count++;
    }
    if (count) mark(truncated, 'followups.fields', count);
    return structuredClone({ ...item, fields, sourceRefs: list(item.sourceRefs, 8192, 'followups.sourceRefs'),
      externalRefs: list(item.externalRefs, 8192, 'followups.externalRefs'), taskIds: list(item.taskIds, 4096, 'followups.taskIds'),
      ...(item.result === undefined ? {} : { result: text(item.result, 8192, 'followups.result') }) });
  };
  const observation = (item: CollaborationObservation): CollaborationObservation => {
    const copied = structuredClone({ ...item, text: text(item.text, 8192, 'observations.text'), refs: list(item.refs, 2048, 'observations.refs') });
    if (copied.text === item.text && item.missing.includes('decision_text_truncated')) mark(truncated, 'observations.text');
    const flags = copied.text !== item.text ? ['context_text_truncated'] : [];
    if (copied.refs.length !== item.refs.length) flags.push('context_metadata_truncated');
    let gaps = missing(item.missing, flags, 2048);
    if (gaps.omitted) {
      gaps = missing(item.missing, [...flags, 'context_metadata_truncated'], 2048);
      mark(truncated, 'observations.missing', gaps.omitted);
    }
    copied.missing = gaps.values;
    return copied;
  };
  const mandate = (item: CollaborationMandate): CollaborationMandate => structuredClone({ ...item,
    prompt: text(item.prompt, 8192, 'mandates.prompt'), sourceRefs: list(item.sourceRefs, 4096, 'mandates.sourceRefs') });
  const result: CollaborationSnapshot = { ...source, scope: { ...source.scope }, settings: structuredClone(source.settings),
    observations: [], followups: [], mandates: [], ...(source.bootstrap ? { bootstrap: structuredClone(source.bootstrap) } : {}) };
  // Leave space for the two aggregate gap markers and a newly synthesized bootstrap descriptor.
  let used = bytes(result) + 2048;
  const add = <T>(items: T[], item: T) => {
    const size = bytes(item) + 1;
    if (used + size > MAX_BYTES) return false;
    items.push(item); used += size; return true;
  };
  const related = followupId ? source.followups.find(item => item.id === followupId) : undefined;
  if (related) {
    const item = followup(related);
    // Schema-bounded status/progress/steps plus settings and bootstrap fit the reserved envelope.
    if (!add(result.followups, item)) throw new Error('Associated followup exceeds collaboration snapshot bounds');
  } else if (followupId) mark(omitted, 'related_followup');
  const newest = [...source.observations].sort((a, b) => b.sequence - a.sequence);
  const pinned = ['lark.description', 'lark.memory'].flatMap(kind => newest.find(item => item.source === kind) ?? []);
  const messages = newest.filter(item => item.source !== 'lark.description' && item.source !== 'lark.memory');
  mark(omitted, 'observations', newest.length - pinned.length - Math.min(messages.length, 50));
  for (const item of [...pinned, ...messages.slice(0, 50)]) {
    if (!add(result.observations, observation(item))) mark(omitted, 'observations');
  }
  result.observations.sort((a, b) => a.sequence - b.sequence);
  const remaining = [
    ...source.followups.filter(item => item !== related).map(item => ({ kind: 'followups' as const, item })),
    ...source.mandates.map(item => ({ kind: 'mandates' as const, item }))
  ].sort((a, b) => b.item.updatedAt.localeCompare(a.item.updatedAt));
  for (const entry of remaining) {
    const added = entry.kind === 'followups' ? add(result.followups, followup(entry.item)) : add(result.mandates, mandate(entry.item));
    if (!added) mark(omitted, entry.kind);
  }
  const markers = [[omitted, 'context_omitted'], [truncated, 'context_truncated']] as const;
  const gaps = markers.flatMap(([counts, prefix]) => {
    const entries = [...counts].filter(([, count]) => count > 0);
    const rows: string[] = [];
    for (const [field, count] of entries) {
      const value = `${field}=${count}`;
      if (!rows.length || rows.at(-1)!.length + value.length + 1 > 256) rows.push(`${prefix}:${value}`);
      else rows[rows.length - 1] += `,${value}`;
    }
    return rows;
  });
  if (gaps.length) result.bootstrap = { ...result.bootstrap, scope: { ...source.scope }, status: 'partial',
    updatedAt: result.bootstrap?.updatedAt ?? source.settings.updatedAt, missing: missing(result.bootstrap?.missing ?? [], gaps).values };
  return result;
}
