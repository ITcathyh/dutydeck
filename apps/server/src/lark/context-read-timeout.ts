export const LARK_CONTEXT_READ_TIMEOUT_MS = 15_000;

export async function withLarkContextReadTimeout<T>(read: Promise<T>, label: string, timeoutMs = LARK_CONTEXT_READ_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
