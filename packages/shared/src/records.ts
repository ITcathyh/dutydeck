/** 是不是普通对象（排除 null 和数组）。 */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 普通对象原样返回，其余返回空对象。 */
export const asRecord = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};

/** Error 取 message，其余值转字符串。 */
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** 至多 `limit` 个并发跑完 `values`，结果按输入顺序返回；任一拒绝则整体拒绝。 */
export async function mapLimit<T, R>(values: readonly T[], limit: number, run: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) { const index = next++; out[index] = await run(values[index]!, index); }
  }));
  return out;
}

/** `onTimeout` 返回值作为拒绝原因，不返回时用默认的超时错误；计时器不阻止进程退出。 */
export const withTimeout = <T>(work: Promise<T>, timeout: number, onTimeout?: () => unknown): Promise<T> => new Promise((resolvePromise, reject) => {
  const timer = setTimeout(() => { reject(onTimeout?.() ?? new Error(`超过 ${timeout}ms 未返回`)); }, timeout);
  (timer as { unref?(): void }).unref?.();
  work.then(value => { clearTimeout(timer); resolvePromise(value); }, error => { clearTimeout(timer); reject(error); });
});

/** 按 /bin/sh 单引号规则整体转义（' 变为 '\''）。 */
export const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/** 转义正则元字符，使字符串按字面量匹配。 */
export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
