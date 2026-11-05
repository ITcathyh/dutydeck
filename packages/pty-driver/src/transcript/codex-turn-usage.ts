/**
 * Per-turn token usage of a Codex rollout, reported as status/turn_usage in the shape the Claude tailer uses.
 *
 * Current Codex writes one `token_usage_record` per model response (keyed by `response_id`, with that
 * response's own usage); those are summed, each id once. Older rollouts only have `event_msg token_count`;
 * there the cumulative `total_token_usage` is differenced: the same token_count is often written several
 * times in a row, so summing its `last_token_usage` would count one response repeatedly. Resume appends to
 * the same rollout and continues the cumulative total; a total already seen (a repeated line, or history
 * copied into a fork) is skipped. A smaller, new total means the counter restarted: that
 * response's own `last_token_usage` is kept as a lower bound and the reading is marked partial (the ledger
 * then records the tokens with an unknown cost, usage_incomplete), never a negative difference.
 *
 * Records before the tailer's start point (baseline) only seed the seen ids and the cumulative reference,
 * so a restore or a generation replay never books history again. The usageRef names the native thread and
 * the last response counted (its response_id; on older rollouts the timestamp of the last token_count), so
 * re-reading the same records after a restore yields the same ref and the ledger keeps the tokens once.
 */
import { codexTerminalUsageRefPrefix, type NormalizedDriverEvent } from '@dutydeck/shared';

interface Tokens { input: number; cached: number; cacheWrite: number; output: number; total: number }
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
/** Codex input_tokens includes the cached part, as in readNativeTranscriptUsage. */
function tokensOf(raw: any): Tokens | undefined {
  const input = count(raw?.input_tokens), output = count(raw?.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  return { input, cached: Math.min(count(raw.cached_input_tokens) ?? 0, input), cacheWrite: count(raw.cache_write_input_tokens) ?? 0, output, total: count(raw.total_tokens) ?? input + output };
}
/** Bound on remembered response ids and cumulative totals; they only guard against re-reading the same records. */
const SEEN_KEYS_MAX = 20_000;

export class CodexTurnUsage {
  private readonly seen = new Set<string>();
  /** The CLI writes token_usage_record; token_count is then display-only. */
  private records = false;
  private reference?: Tokens;
  private pending?: Omit<Tokens, 'total'>;
  private lastRef?: string;
  private partial = false;
  private model?: string;
  private metaId?: string;

  constructor(private readonly nativeId: () => string | undefined) {}

  observe(entry: any, baseline: boolean): void {
    const p = entry?.payload;
    if (!p || typeof p !== 'object') return;
    if (entry.type === 'session_meta') { this.metaId ??= typeof p.id === 'string' ? p.id : undefined; return; }
    if (entry.type === 'turn_context') { if (typeof p.model === 'string' && p.model.trim()) this.model = p.model.trim(); return; }
    if (entry.type === 'token_usage_record') {
      this.records = true;
      const own = this.nativeId() ?? this.metaId, id = typeof p.response_id === 'string' && p.response_id ? p.response_id : undefined;
      const usage = tokensOf(p.usage);
      if (!id || !usage || this.seen.has(id) || own && typeof p.thread_id === 'string' && p.thread_id !== own) return;
      this.remember(id);
      if (!baseline) this.add(usage, id);
      return;
    }
    if (entry.type === 'event_msg' && p.type === 'token_count') {
      const total = tokensOf(p.info?.total_token_usage);
      if (!total) return;
      // A cumulative total seen before is a repeated line or history copied into a fork/generation file.
      const key = `total_${total.total}`;
      if (this.seen.has(key)) return;
      this.remember(key);
      const previous = this.reference;
      this.reference = total;
      if (baseline || this.records) return;
      const restarted = !!previous && total.total < previous.total;
      const delta = previous && !restarted
        ? { input: Math.max(0, total.input - previous.input), cached: Math.max(0, total.cached - previous.cached), cacheWrite: Math.max(0, total.cacheWrite - previous.cacheWrite), output: Math.max(0, total.output - previous.output) }
        : tokensOf(p.info?.last_token_usage);
      if (restarted) this.partial = true;
      if (delta) this.add(delta, typeof entry.timestamp === 'string' ? entry.timestamp : `total_${total.total}`);
    }
  }

  private remember(key: string): void {
    this.seen.add(key);
    while (this.seen.size > SEEN_KEYS_MAX) this.seen.delete(this.seen.values().next().value as string);
  }

  private add(usage: Omit<Tokens, 'total'>, ref: string): void {
    const pending = this.pending ??= { input: 0, cached: 0, cacheWrite: 0, output: 0 };
    pending.input += usage.input; pending.cached += Math.min(usage.cached, usage.input); pending.cacheWrite += usage.cacheWrite; pending.output += usage.output;
    this.lastRef = ref;
  }

  /** Usage counted since the previous call; undefined when the rollout recorded none (the ledger then books the turn as unknown, never zero). */
  take(): NormalizedDriverEvent | undefined {
    const pending = this.pending, partial = this.partial;
    this.pending = undefined; this.partial = false;
    if (!pending) return undefined;
    return { type: 'status', data: {
      state: 'turn_usage', usageRef: `${codexTerminalUsageRefPrefix}${this.nativeId() ?? this.metaId ?? 'unknown'}:${this.lastRef}`,
      ...(this.model ? { model: this.model } : {}),
      breakdown: { inputTokens: pending.input - pending.cached, outputTokens: pending.output, cachedReadTokens: pending.cached, cachedWriteTokens: pending.cacheWrite },
      ...(partial ? { partial: true } : {}),
    } };
  }
}
