/** One deadline covers connection, headers and consumption of the response body. */
export function createWorkbenchFetch(): { fetch: typeof globalThis.fetch; close(): void } {
  const lifecycle = new AbortController();
  return {
    fetch: async (input, init) => {
      lifecycle.signal.throwIfAborted();
      const signals = [lifecycle.signal, AbortSignal.timeout(15_000)];
      if (input instanceof Request) signals.push(input.signal);
      if (init?.signal) signals.push(init.signal);
      return globalThis.fetch(input, { ...init, signal: AbortSignal.any(signals) });
    },
    close: () => lifecycle.abort(new DOMException('Workbench fetch is closed', 'AbortError'))
  };
}
