import type { CountMetric, FileMetrics, PulseBucket, RawTokenUsage, TraceEventTokens } from '@dutydeck/shared';

export type JsonObject = Record<string, unknown>;
export const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
export const safeToken = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export function metric(value: number | null, reason?: string, status: CountMetric['status'] = value === null ? 'unavailable' : 'available', evidenceCount = value === null ? 0 : 1, missingCount = value === null ? 1 : 0, quality: CountMetric['quality'] = value === null ? 'unknown' : 'exact'): CountMetric {
  return { value, status, quality, evidenceCount, missingCount, reasonCodes: reason ? [reason] : [] };
}
const sum = (values: Array<number | null | undefined>): number | null => {
  if (values.some(value => value == null)) return null;
  const total = (values as number[]).reduce((a, b) => a + b, 0);
  return safeToken(total) ? total : null;
};
const names = ['input', 'cached', 'write', 'output', 'reasoning', 'total', 'uncached'] as const;
type Field = typeof names[number];
const wireFields: Record<Exclude<Field, 'uncached'>, string> = { input: 'input_tokens', cached: 'cached_input_tokens', write: 'cache_write_input_tokens', output: 'output_tokens', reasoning: 'reasoning_output_tokens', total: 'total_tokens' };
class Counter {
  seen = false;
  valid = false;
  last = 0;
  observed = 0;
  exact = false;
  pendingReset = false;
  samples = 0;
  present = 0;
  conflict: string | undefined;
  baseline: NonNullable<RawTokenUsage['baselineStatus']> = 'unknown_baseline';

  record(value: unknown, present: boolean): number | null {
    if (!present) { if (this.seen) this.samples++; return null; }
    this.samples++;
    if (!safeToken(value)) {
      this.seen = true;
      this.conflict ??= 'INVALID_TOKEN_FIELD';
      this.baseline = 'contradictory';
      return null;
    }
    this.present++;
    this.valid = true;
    let delta: number | null = null;
    if (!this.seen) {
      this.exact = this.pendingReset || value === 0;
      this.baseline = this.pendingReset ? 'epoch_reset' : value === 0 ? 'zero_confirmed' : 'unknown_baseline';
      delta = this.exact ? value : null;
    } else if (this.pendingReset) {
      this.baseline = 'epoch_reset';
      delta = value;
    } else if (!this.conflict) {
      if (value < this.last) this.conflict = 'UNEXPECTED_COUNTER_DROP';
      else delta = value - this.last;
    }
    this.seen = true;
    this.pendingReset = false;
    this.last = value;
    if (delta !== null) {
      if (!safeToken(this.observed + delta)) { this.conflict = 'INTEGER_OVERFLOW'; delta = null; }
      else this.observed += delta;
    }
    if (this.conflict) this.baseline = 'contradictory';
    return delta;
  }

  normalized(reason: string, unverified = false): CountMetric {
    if (!this.seen) return metric(null, reason);
    const gap = this.samples - this.present;
    if (unverified) return metric(null, 'DIALECT_BUCKETS_UNVERIFIED', 'partial', this.present, gap + 1);
    if (this.conflict) return metric(null, this.conflict, 'conflict', this.present, Math.max(1, gap));
    if (gap) return metric(null, 'FIELD_MISSING_IN_SAMPLE', 'partial', this.present, gap);
    if (!this.exact) return metric(null, 'UNKNOWN_BASELINE', 'partial', this.present, 1, 'inferred');
    return metric(this.observed, undefined, 'available', this.present);
  }

  raw(reason: string): CountMetric {
    if (!this.seen) return metric(null, reason);
    if (!this.valid) return metric(null, 'INVALID_TOKEN_FIELD', 'conflict');
    return metric(this.last, undefined, 'available', this.present, this.samples - this.present, 'observed');
  }
}
interface MessageField { value?: number; previous?: number; conflict?: string }
interface MessageUsage { fields: Record<Field, MessageField>; identity: boolean; at: string | null }
const emptyFields = (): Record<Field, MessageField> => Object.fromEntries(names.map(name => [name, {}])) as Record<Field, MessageField>;
export interface TokenObservation { tokens: TraceEventTokens; rawUsage: RawTokenUsage }
interface PulseSample { at: string | null; values: Partial<Record<Field, number | null>>; conflicts: Partial<Record<Field, string>>; identity?: boolean }

// One state per source: missing usage is never silently converted into zero.
export class TokenAnalysis {
  readonly counters = Object.fromEntries(names.map(name => [name, new Counter()])) as Record<Field, Counter>;
  readonly messages = new Map<string, MessageUsage>();
  samples = 0;
  peak: number | null = null;
  window: number | null = null;
  constructor(readonly client: string) {}

  reset(): void { for (const counter of Object.values(this.counters)) counter.pendingReset = true; }

  cumulative(info: JsonObject): TokenObservation {
    this.samples++;
    const usage = object(info.total_token_usage);
    const values: Partial<Record<Field, unknown>> = {};
    const delta: Partial<Record<Field, number | null>> = {};
    for (const [name, key] of Object.entries(wireFields) as Array<[Exclude<Field, 'uncached'>, string]>) {
      const actualKey = name === 'write' && !(key in usage) ? 'cache_creation_input_tokens' : key;
      values[name] = usage[actualKey];
      delta[name] = this.counters[name].record(usage[actualKey], actualKey in usage);
    }
    if (this.client !== 'traex') {
      const present = 'input_tokens' in usage && 'cached_input_tokens' in usage;
      const uncached = safeToken(values.input) && safeToken(values.cached) ? Math.max(0, values.input - values.cached) : null;
      delta.uncached = this.counters.uncached.record(uncached, present || ('input_tokens' in usage && !safeToken(values.input)) || ('cached_input_tokens' in usage && !safeToken(values.cached)));
    }
    if (safeToken(info.model_context_window) && info.model_context_window > 0) this.window = info.model_context_window;
    const context = object(info.last_token_usage).total_tokens;
    if (safeToken(context) && context > 0) this.peak = Math.max(this.peak ?? 0, context);
    const raw = (name: Field): number | null => safeToken(values[name]) ? values[name] as number : null;
    return {
      tokens: { inputUncached: delta.uncached ?? null, cacheRead: this.client === 'traex' ? null : delta.cached, cacheWrite: this.client === 'traex' ? null : delta.write, output: delta.output, reasoning: delta.reasoning, total: delta.total },
      rawUsage: { dialect: this.client === 'traex' ? 'traex_mutation_token' : 'codex_total_last', inputTokens: raw('input'), cachedInputTokens: raw('cached'), cacheCreationInputTokens: raw('write'), outputTokens: raw('output'), reasoningOutputTokens: raw('reasoning'), totalTokens: raw('total'), observedDelta: delta.total ?? (this.client === 'traex' ? null : sum([delta.uncached, delta.cached, delta.output])), baselineStatus: 'total_tokens' in usage ? this.counters.total.baseline : this.counters.uncached.seen ? this.counters.uncached.baseline : this.counters.input.baseline }
    };
  }

  claude(key: string, messageId: string, usage: JsonObject, at: string | null): TokenObservation | null {
    let message = this.messages.get(key);
    if (!message) { message = { fields: emptyFields(), identity: !!messageId, at }; this.messages.set(key, message); }
    if (!Object.keys(usage).length) return null;
    this.samples++;
    const values: Partial<Record<Field, number | null>> = {};
    let contributes = false;
    for (const name of names.filter(name => name !== 'total' && name !== 'uncached')) {
      const key = name === 'cached' ? 'cache_read_input_tokens' : name === 'write' ? 'cache_creation_input_tokens' : wireFields[name];
      const field = message.fields[name];
      if (!(key in usage)) { values[name] = null; continue; }
      const value = usage[key];
      if (!safeToken(value)) { field.conflict = 'USAGE_SNAPSHOT_CONFLICT'; values[name] = null; continue; }
      if (field.previous !== undefined && value < field.previous) field.conflict = 'USAGE_SNAPSHOT_CONFLICT';
      values[name] = field.previous === undefined ? value : Math.max(0, value - field.previous);
      if (field.value === undefined || value > field.value) contributes = true;
      field.value = Math.max(field.value ?? 0, value);
      field.previous = value;
    }
    if ((message.fields.reasoning.value ?? 0) > (message.fields.output.value ?? Infinity)) {
      message.fields.reasoning.conflict = 'USAGE_SNAPSHOT_CONFLICT'; message.fields.output.conflict = 'USAGE_SNAPSHOT_CONFLICT';
    }
    if (contributes && !Object.values(message.fields).some(field => field.conflict)) { message.at = at; }
    const raw = (key: string): number | null => safeToken(usage[key]) ? usage[key] as number : null;
    return { tokens: { inputUncached: values.input, cacheRead: values.cached, cacheWrite: values.write, output: values.output, reasoning: values.reasoning }, rawUsage: { dialect: 'claude_message_snapshot', baselineStatus: 'zero_confirmed', inputTokens: raw('input_tokens'), cachedInputTokens: raw('cache_read_input_tokens'), cacheCreationInputTokens: raw('cache_creation_input_tokens'), outputTokens: raw('output_tokens'), reasoningOutputTokens: raw('reasoning_output_tokens'), observedDelta: contributes ? sum(['input', 'cached', 'write', 'output'].map(name => message!.fields[name as Field].value)) : null } };
  }

  metrics(): Pick<FileMetrics, 'inputUncached' | 'cacheRead' | 'cacheWrite' | 'output' | 'reasoningOutput' | 'totalTracked' | 'rawInput' | 'rawOutput' | 'rawTotal' | 'peakContext' | 'contextWindow'> {
    const c = this.counters;
    const noUsage = this.client === 'claude' ? this.messages.size === 0 : !c.input.seen && !c.output.seen && !c.total.seen;
    if (noUsage) return {
      inputUncached: metric(null, 'NO_TOKEN_USAGE_OBSERVED'), cacheRead: metric(null, 'CACHE_BUCKET_OMITTED'), cacheWrite: metric(null, 'CACHE_BUCKET_OMITTED'), output: metric(null, 'NO_TOKEN_USAGE_OBSERVED'), reasoningOutput: metric(null, 'NO_REASONING_EVIDENCE'), totalTracked: metric(null, 'NO_TOKEN_USAGE_OBSERVED'), rawInput: metric(null, 'NO_TOKEN_USAGE_OBSERVED'), rawOutput: metric(null, 'NO_TOKEN_USAGE_OBSERVED'), rawTotal: metric(null, 'SOURCE_TOTAL_OMITTED'), peakContext: metric(this.peak, this.peak === null ? 'NO_CONTEXT_OBSERVED' : undefined), contextWindow: metric(this.window, this.window === null ? 'NO_CONTEXT_WINDOW_METADATA' : undefined)
    };
    const claudeMetric = (name: Field, reason: string): CountMetric => {
      const messages = [...this.messages.values()];
      return aggregate(messages.map(message => ({ value: message.fields[name].value ?? null, conflict: message.fields[name].conflict, identity: message.identity })), reason, 'FIELD_MISSING_IN_MESSAGE');
    };
    const isClaude = this.client === 'claude';
    let input = isClaude ? claudeMetric('input', 'NO_TOKEN_USAGE_OBSERVED') : c.uncached.normalized('INPUT_OMITTED');
    if (!isClaude && !c.uncached.seen && c.input.seen) input = { ...c.input.normalized('INPUT_OMITTED'), value: null, status: c.input.conflict ? 'conflict' : 'partial', reasonCodes: c.input.conflict ? [c.input.conflict] : ['CACHED_INPUT_OMITTED', ...(!c.input.exact ? ['UNKNOWN_BASELINE'] : [])] };
    const dialect = this.client === 'traex';
    if (dialect) input = metric(null, 'DIALECT_BUCKETS_UNVERIFIED', 'partial');
    const cached = isClaude ? claudeMetric('cached', 'CACHE_BUCKET_OMITTED') : c.cached.normalized('CACHE_BUCKET_OMITTED', dialect);
    const write = isClaude ? claudeMetric('write', 'CACHE_BUCKET_OMITTED') : c.write.normalized('CACHE_BUCKET_OMITTED', dialect);
    const output = isClaude ? claudeMetric('output', 'NO_TOKEN_USAGE_OBSERVED') : c.output.normalized('OUTPUT_OMITTED', dialect);
    const reasoning = isClaude ? claudeMetric('reasoning', 'NO_REASONING_EVIDENCE') : c.reasoning.normalized('NO_REASONING_EVIDENCE', dialect);
    let total = tracked([input, cached, write, output]);
    if (dialect) total = metric(null, 'DIALECT_BUCKETS_UNVERIFIED', 'partial');
    else if (!isClaude && total.status === 'available' && (write.value ?? 0) > 0) total = metric(null, 'CACHE_WRITE_UNVERIFIED', 'partial');
    else if (!isClaude && total.status === 'available' && c.total.exact && !c.total.conflict && c.total.samples === c.total.present && total.value !== c.total.observed) total = metric(null, 'TRACKED_TOTAL_MISMATCH', 'partial');
    const asRaw = (m: CountMetric): CountMetric => ({ ...m, quality: m.status === 'available' ? 'observed' : m.quality });
    return { inputUncached: input, cacheRead: cached, cacheWrite: write, output, reasoningOutput: reasoning, totalTracked: total, rawInput: isClaude ? asRaw(input) : c.input.raw('RAW_INPUT_OMITTED'), rawOutput: isClaude ? asRaw(output) : c.output.raw('RAW_OUTPUT_OMITTED'), rawTotal: isClaude ? metric(null, 'SOURCE_TOTAL_OMITTED') : c.total.raw('SOURCE_TOTAL_OMITTED'), peakContext: metric(this.peak, this.peak === null ? 'NO_CONTEXT_OBSERVED' : undefined, undefined, undefined, undefined, this.peak === null ? 'unknown' : 'observed'), contextWindow: metric(this.window, this.window === null ? 'NO_CONTEXT_WINDOW_METADATA' : undefined, undefined, undefined, undefined, this.window === null ? 'unknown' : 'observed') };
  }

  pulse(start: string | null, end: string | null): PulseBucket[] {
    const collector = new PulseAnalysis(this.client, start, end);
    for (const message of this.messages.values()) {
      collector.add({ at: message.at, identity: message.identity, values: Object.fromEntries(names.map(name => [name, message.fields[name].value ?? null])), conflicts: Object.fromEntries(names.flatMap(name => message.fields[name].conflict ? [[name, message.fields[name].conflict]] : [])) });
    }
    return collector.finish();
  }
}
export type { PulseSample };
function aggregate(fields: Array<{ value: number | null; conflict?: string; identity: boolean }>, reason: string, missingReason: string): CountMetric {
  const present = fields.filter(field => field.value !== null).length;
  const missing = fields.length - present;
  const conflict = fields.find(field => field.conflict)?.conflict;
  if (conflict) return metric(null, conflict, 'conflict', present, Math.max(1, missing));
  if (!present) return metric(null, reason, 'unavailable', 0, Math.max(1, missing));
  const total = sum(fields.filter(field => field.value !== null).map(field => field.value));
  if (total === null) return metric(null, 'INTEGER_OVERFLOW', 'conflict', present, 1);
  if (missing || fields.some(field => !field.identity)) return metric(null, missingReason, 'partial', present, missing);
  return metric(total, undefined, 'available', present);
}
function tracked(fields: CountMetric[]): CountMetric {
  const conflict = fields.find(field => field.status === 'conflict');
  if (conflict) return metric(null, conflict.reasonCodes[0], 'conflict');
  if (fields.some(field => field.status !== 'available')) return metric(null, 'CACHE_BUCKETS_UNVERIFIED', 'partial');
  const total = sum(fields.map(field => field.value));
  return total === null ? metric(null, 'INTEGER_OVERFLOW', 'conflict') : metric(total);
}

interface BucketField { sum: number; present: number; missing: number; conflict?: string }
interface Bucket { samples: number; identityUnverified: boolean; fields: Record<Field, BucketField> }

// Only 1,000 aggregates are retained, regardless of the number of token samples.
export class PulseAnalysis {
  private readonly groups = new Map<number, Bucket>();
  private readonly begin: number;
  private readonly end: number;
  private readonly span: number;
  constructor(private readonly client: string, start: string | null, end: string | null) {
    this.begin = start ? Date.parse(start) : NaN;
    this.end = end ? Date.parse(end) : NaN;
    this.span = Math.max(1, (this.end - this.begin) / 1000);
  }
  add(sample: PulseSample): void {
    if (!sample.at || !Number.isFinite(this.begin) || !Number.isFinite(this.end)) return;
    const index = Math.min(999, Math.max(0, Math.floor((Date.parse(sample.at) - this.begin) / this.span)));
    let bucket = this.groups.get(index);
    if (!bucket) { bucket = { samples: 0, identityUnverified: false, fields: Object.fromEntries(names.map(name => [name, { sum: 0, present: 0, missing: 0 }])) as Record<Field, BucketField> }; this.groups.set(index, bucket); }
    bucket.samples++;
    if (sample.identity === false) bucket.identityUnverified = true;
    for (const name of names) {
      const field = bucket.fields[name], value = sample.values[name];
      field.conflict ??= sample.conflicts[name];
      if (value == null) field.missing++;
      else { field.present++; if (!safeToken(field.sum + value)) field.conflict = 'INTEGER_OVERFLOW'; else field.sum += value; }
    }
  }
  finish(): PulseBucket[] {
    return [...this.groups].sort(([a], [b]) => a - b).map(([index, bucket]) => {
      const get = (name: Field): CountMetric => {
        const field = bucket.fields[name];
        if (field.conflict) return metric(null, field.conflict, 'conflict', field.present, Math.max(1, field.missing));
        if (!field.present) return metric(null, 'NO_TOKEN_EVIDENCE', 'unavailable', 0, field.missing);
        if (bucket.identityUnverified) return metric(null, 'MESSAGE_IDENTITY_UNVERIFIED', 'partial', field.present, field.missing);
        if (field.missing) return metric(null, 'FIELD_MISSING_IN_SAMPLE', 'partial', field.present, field.missing);
        return metric(field.sum, undefined, 'available', field.present);
      };
      const input = get(this.client === 'claude' ? 'input' : 'uncached'), cached = get('cached'), write = get('write'), output = get('output'), reasoning = get('reasoning');
      let total = tracked([input, cached, write, output]);
      if (this.client === 'traex') total = metric(null, 'DIALECT_BUCKETS_UNVERIFIED', 'partial');
      else if (this.client !== 'claude' && (write.value ?? 0) > 0) total = metric(null, 'CACHE_WRITE_UNVERIFIED', 'partial');
      return { startAt: new Date(this.begin + index * this.span).toISOString(), endAt: new Date(Math.max(this.begin + index * this.span + 1, Math.min(this.end, this.begin + (index + 1) * this.span))).toISOString(), tokens: { inputUncached: input, cacheRead: cached, cacheWrite: write, output, reasoning, total }, sampleCount: bucket.samples, missingCount: 0 };
    });
  }
}
