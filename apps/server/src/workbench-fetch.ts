export type LifecycleFetch = typeof globalThis.fetch & { signal?: AbortSignal };

/** The lifecycle signal is also available to callers while they queue or back off. */
export function createWorkbenchFetch(fetcher: typeof globalThis.fetch = globalThis.fetch): { fetch: LifecycleFetch; close(): void } {
  const lifecycle = new AbortController();
  const fetch: LifecycleFetch = async (input, init) => {
    lifecycle.signal.throwIfAborted();
    const signals = [lifecycle.signal, AbortSignal.timeout(15_000)];
    const upstream = (fetcher as LifecycleFetch).signal;
    if (upstream) signals.push(upstream);
    if (input instanceof Request) signals.push(input.signal);
    if (init?.signal) signals.push(init.signal);
    return fetcher(input, { ...init, signal: AbortSignal.any(signals) });
  };
  fetch.signal = (fetcher as LifecycleFetch).signal
    ? AbortSignal.any([lifecycle.signal, (fetcher as LifecycleFetch).signal!]) : lifecycle.signal;
  return { fetch, close: () => lifecycle.abort(new DOMException('Workbench fetch is closed', 'AbortError')) };
}
