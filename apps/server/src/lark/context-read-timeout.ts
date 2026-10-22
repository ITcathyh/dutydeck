export const LARK_CONTEXT_READ_TIMEOUT_MS = 15_000;

export async function withLarkContextReadTimeout<T>(read: Promise<T> | ((signal: AbortSignal) => Promise<T>), label: string, timeoutMs = LARK_CONTEXT_READ_TIMEOUT_MS, callerSignal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  const signal = callerSignal ? AbortSignal.any([callerSignal, abort.signal]) : abort.signal;
  let onAbort: () => void = () => {};
  try {
    signal.throwIfAborted();
    return await Promise.race([
      typeof read === 'function' ? read(signal) : read,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
        timer = setTimeout(() => abort.abort(new Error(`${label}超时`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
