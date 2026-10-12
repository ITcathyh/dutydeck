export type LifecycleFetch = typeof globalThis.fetch & { signal?: AbortSignal };

/**
 * 一次请求的中止信号：任一常驻信号中止、超时或 others 中止都会中止它。
 * 常驻信号（服务生命周期）不能直接放进 AbortSignal.any：Node 22 会在常驻信号上为每个组合信号留一个弱引用，
 * 组合信号回收后，清理回调要把常驻信号上的全部引用遍历一遍，开销随累计请求数平方增长。
 * 这里在超时前监听常驻信号，超时后解除；超时后请求已被超时信号中止，结果与直接组合相同。
 */
export function requestSignal(longLived: readonly (AbortSignal | undefined)[], timeoutMs: number, others: readonly AbortSignal[] = []): AbortSignal {
  const linked = new AbortController();
  const timeout = AbortSignal.timeout(timeoutMs);
  const sources = longLived.filter((signal): signal is AbortSignal => signal !== undefined);
  const aborted = sources.find(signal => signal.aborted);
  if (aborted) linked.abort(aborted.reason);
  else {
    const follow = (event: Event) => linked.abort((event.target as AbortSignal).reason);
    for (const signal of sources) signal.addEventListener('abort', follow, { once: true });
    timeout.addEventListener('abort', () => { for (const signal of sources) signal.removeEventListener('abort', follow); }, { once: true });
  }
  return AbortSignal.any([linked.signal, timeout, ...others]);
}

/** The lifecycle signal is also available to callers while they queue or back off. */
export function createWorkbenchFetch(fetcher: typeof globalThis.fetch = globalThis.fetch): { fetch: LifecycleFetch; close(): void } {
  const lifecycle = new AbortController();
  const fetch: LifecycleFetch = async (input, init) => {
    lifecycle.signal.throwIfAborted();
    const signals: AbortSignal[] = [];
    if (input instanceof Request) signals.push(input.signal);
    if (init?.signal) signals.push(init.signal);
    return fetcher(input, { ...init, signal: requestSignal([lifecycle.signal, (fetcher as LifecycleFetch).signal], 15_000, signals) });
  };
  fetch.signal = (fetcher as LifecycleFetch).signal
    ? AbortSignal.any([lifecycle.signal, (fetcher as LifecycleFetch).signal!]) : lifecycle.signal;
  return { fetch, close: () => lifecycle.abort(new DOMException('Workbench fetch is closed', 'AbortError')) };
}
