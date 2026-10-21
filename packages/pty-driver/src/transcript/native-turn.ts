import type { NormalizedDriverEvent } from '@dutydeck/shared';
import { codexInputText, normalizeInputText } from './input-receipt.js';

/** Native terminals are independent of reply text and only settle an exact
 * submitted input (or the first fresh input after a recovery cursor). */
export class NativeTurn {
  constructor(private readonly codexCapacity = false) {}
  private candidate?: string;
  private required = false;
  private turn?: string;
  private input?: any;
  private scoped = false;
  private recovering = false;
  private recoveredInput = false;
  private terminal = false;
  private error?: NormalizedDriverEvent;
  private cancelled = false;
  private detach?: () => void;

  reset(): void {
    this.detach?.(); this.detach = undefined;
    this.candidate = this.turn = this.input = undefined; this.required = false;
    this.scoped = this.recovering = this.recoveredInput = this.terminal = this.cancelled = false;
    this.error = undefined;
  }
  arm(signal: AbortSignal): void {
    this.reset(); this.required = true;
    const abort = () => { this.scoped = false; this.error = undefined; this.cancelled = this.terminal = false; };
    signal.addEventListener('abort', abort, { once: true });
    this.detach = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) abort();
  }
  restore(): void { this.reset(); this.recovering = true; }
  bindHistory(text: string): void {
    if (!this.scoped) this.bind({ type: 'event_msg', payload: { type: 'user_message', message: text } });
  }
  bind(entry: any): void {
    this.detach?.(); this.detach = undefined;
    this.input = entry; this.scoped = true; this.required = true; this.recovering = false;
    this.turn = entry.payload?.turn_id ?? this.candidate;
    this.error = undefined; this.cancelled = this.terminal = false;
  }
  observe(entry: any, baseline = false): boolean {
    const p = entry?.payload;
    const id = typeof p?.turn_id === 'string' && p.turn_id ? p.turn_id : undefined;
    if (entry?.type === 'event_msg' && (p?.type === 'task_started' || p?.type === 'turn_started')) {
      this.candidate = id;
      if (this.scoped && !this.turn && !this.terminal) this.turn = id;
    }
    const input = codexInputText(entry);
    if (!baseline && this.recovering && input !== undefined) { this.bind(entry); this.recoveredInput = true; }
    if (input !== undefined && this.scoped && entry !== this.input) {
      // Legacy/model and display records can mirror the same native input.
      if (id && this.turn && id !== this.turn) return false;
      // Inside the bound native turn, differing user records are context or
      // injected input (AGENTS.md, skills, steer), not a newer submission.
      if (!(this.turn && this.candidate === this.turn)
        && normalizeInputText(input) !== normalizeInputText(codexInputText(this.input) ?? '')) {
        this.scoped = false; this.error = undefined; this.terminal = this.cancelled = false;
      }
    }
    if (!this.scoped || (id && this.turn && id !== this.turn)) return false;
    if (!this.turn && id && !['task_complete', 'turn_aborted'].includes(p?.type)) this.turn = id;
    if (entry?.type === 'event_msg' && (p?.type === 'task_complete' || p?.type === 'turn_aborted')) {
      // A terminal without a native turn id cannot introduce its own ancestry.
      if (!id || id !== this.turn) return false;
      if (this.terminal) return true;
      this.terminal = true;
      if (p.type === 'turn_aborted') this.cancelled = true;
      else {
        this.error ??= nativeTaskError(p.error, this.codexCapacity);
        if (this.error) Object.assign(this.error.data, { nativeTerminal: true, nativeTurnId: id });
      }
    }
    return true;
  }
  activeTurnId(): string | undefined { return this.scoped && !this.terminal ? this.turn : undefined; }
  requiresBinding(): boolean { return this.required; }
  hasRecoveredInput(): boolean { return this.recoveredInput && this.scoped; }
  hasTerminal(): boolean { return this.terminal; }
  takeError(): NormalizedDriverEvent | undefined { const error = this.error; this.error = undefined; return error; }
  takeCancellation(): boolean { const cancelled = this.cancelled; this.cancelled = false; return cancelled; }
}

export function nativeTaskError(error: unknown, codexCapacity = false): NormalizedDriverEvent | undefined {
  if (error === null || error === undefined) return undefined;
  const raw = typeof error === 'string' ? error : JSON.stringify(error);
  const usage = /usage[_ -]?limit/i.test(raw);
  const rate = !usage && /rate[_ -]?limit|\b429\b/i.test(raw);
  const message = typeof error === 'string' ? error
    : typeof (error as any)?.message === 'string' ? (error as any).message : 'Native agent task failed';
  const info = typeof error === 'object' ? (error as any)?.codex_error_info ?? (error as any)?.codexErrorInfo ?? (error as any)?.code ?? (error as any)?.type : undefined;
  const capacity = codexCapacity && !usage && !rate && !/\b(?:400|401|403)\b|auth(?:entication|orization)?|quota|invalid[_ -]?request/i.test(raw)
    && (typeof info === 'string' && /^server_?overloaded$/i.test(info)
      || message === 'Selected model is at capacity. Please try a different model.');
  return { type: 'error', data: { code: capacity ? 'codex_capacity' : usage ? 'usage_limit_exceeded' : rate ? 'rate_limit' : 'native_task_failed', message: capacity ? `Codex 当前模型容量已满，请稍后重试或切换模型。\n原文：${message}` : message,
    retryable: capacity || rate, ...(capacity ? { nativeSource: 'codex', capacityReason: 'selected_model_capacity' } : {}) } };
}
