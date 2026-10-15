import { SCENARIO_LIMITS, type ScenarioContextResult, type ScenarioMatchResult, type ScenarioMessage, type ScenarioProvider } from '@dutydeck/shared';

export type DeadlineResult<T> =
  | { status: 'ok'; value: T; durationMs: number }
  | { status: 'timeout'; durationMs: number }
  | { status: 'error'; error: string; durationMs: number };

export interface LateResult { status: 'ok' | 'error'; afterMs: number }

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * 在截止时间内等 provider 的结果。到点后不再等待并发出 abort；abort 不等于 provider 停下，
 * 之后才到的结果丢弃并交给 onLate 记诊断。同步阻塞的调用无法打断，返回时已超时的结果同样丢弃。
 */
export function callWithDeadline<T>(call: (signal: AbortSignal) => T | Promise<T>, timeoutMs: number, onLate?: (late: LateResult) => void): Promise<DeadlineResult<T>> {
  const controller = new AbortController();
  const started = Date.now();
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort(new Error(`超过 ${timeoutMs}ms 截止时间`));
      resolve({ status: 'timeout', durationMs: Date.now() - started });
    }, timeoutMs);
    const finish = (result: { status: 'ok'; value: T } | { status: 'error'; error: string }) => {
      const durationMs = Date.now() - started;
      if (!settled && durationMs > timeoutMs) {
        settled = true;
        clearTimeout(timer);
        controller.abort(new Error(`超过 ${timeoutMs}ms 截止时间`));
        resolve({ status: 'timeout', durationMs });
      }
      if (settled) { onLate?.({ status: result.status, afterMs: durationMs }); return; }
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, durationMs });
    };
    let work: Promise<T>;
    try { work = Promise.resolve(call(controller.signal)); }
    catch (error) { work = Promise.reject(error); }
    work.then(value => finish({ status: 'ok', value }), error => finish({ status: 'error', error: message(error) }));
  });
}

type Log = { warn(data: Record<string, unknown>, message: string): void };

/**
 * 场景 provider 的三处调用，每处都有截止时间：match 500ms；context 按包声明（默认 5s、上限 15s）；
 * correlationKey 用调用方给的本轮剩余时间（整轮 1s）。核心只通过这里调用 provider。
 */
export class ScenarioProviderCaller {
  constructor(readonly plugin: string, readonly provider: ScenarioProvider, private readonly log?: Log) {}

  private late(method: string) {
    return (late: LateResult) => this.log?.warn({ plugin: this.plugin, provider: this.provider.id, method, ...late }, '场景 provider 迟到的结果已丢弃');
  }

  async match(input: { message: ScenarioMessage; params: Readonly<Record<string, unknown>> }): Promise<DeadlineResult<ScenarioMatchResult>> {
    const match = this.provider.match;
    if (!match) return { status: 'error', error: `provider ${this.provider.id} 没有 match`, durationMs: 0 };
    const result = await callWithDeadline(signal => match.call(this.provider, { ...input, signal }), SCENARIO_LIMITS.matchTimeoutMs, this.late('match'));
    if (result.status !== 'ok') return result;
    const value = result.value as Partial<ScenarioMatchResult> | undefined;
    if (typeof value?.matched !== 'boolean' || (value.dedupeKey !== undefined && (typeof value.dedupeKey !== 'string' || value.dedupeKey.length > 200))) {
      return { status: 'error', error: 'match 返回值应为 { matched: boolean, dedupeKey?: string }', durationMs: result.durationMs };
    }
    return { status: 'ok', value: { matched: value.matched, ...(value.dedupeKey ? { dedupeKey: value.dedupeKey } : {}) }, durationMs: result.durationMs };
  }

  context(input: { scope: { appId: string; chatId: string }; message: ScenarioMessage; params: Readonly<Record<string, unknown>>; maxChars?: number }, timeoutMs?: number): Promise<DeadlineResult<ScenarioContextResult>> {
    const context = this.provider.context;
    if (!context) return Promise.resolve({ status: 'error', error: `provider ${this.provider.id} 没有 context`, durationMs: 0 });
    const limits = SCENARIO_LIMITS.context;
    const deadline = Math.min(timeoutMs ?? limits.timeoutMs.default, limits.timeoutMs.max);
    const maxChars = Math.min(input.maxChars ?? limits.maxChars.default, limits.maxChars.max);
    return callWithDeadline(signal => context.call(this.provider, { ...input, maxChars, signal }), deadline, this.late('context'));
  }

  /** remainingMs：本轮关联剩下的时间，封顶 1s。 */
  correlationKey(input: { entries: Array<{ label: string; lines: string[] }> }, remainingMs: number = SCENARIO_LIMITS.correlationTimeoutMs): Promise<DeadlineResult<Record<string, string> | undefined>> {
    const correlationKey = this.provider.correlationKey;
    if (!correlationKey) return Promise.resolve({ status: 'error', error: `provider ${this.provider.id} 没有 correlationKey`, durationMs: 0 });
    const deadline = Math.max(0, Math.min(remainingMs, SCENARIO_LIMITS.correlationTimeoutMs));
    return callWithDeadline(() => correlationKey.call(this.provider, input), deadline, this.late('correlationKey'));
  }
}
