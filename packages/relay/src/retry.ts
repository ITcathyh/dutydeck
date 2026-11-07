/** 服务重启或部署期间端口暂时没人监听；与部署健康检查的上限一致。 */
export const UNAVAILABLE_RETRY_MS = 90_000;
const UNAVAILABLE_RETRY_INTERVAL_MS = 1_000;

/** 只有连接被拒能证明请求没送达服务端，重试不会重复执行；其他网络错误照常报错。 */
const connectionRefused = (error: unknown): boolean => {
  const value = error as { code?: unknown; cause?: { code?: unknown } } | undefined;
  return value?.code === 'ECONNREFUSED' || value?.cause?.code === 'ECONNREFUSED';
};

export const defaultRetrySleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * 连接被拒时每秒重试一次，累计等待不超过 `budgetMs`（默认 90 秒）；`signal` 已中止或其他错误立即抛出。
 * 回传通道和群协作工具共用，等待服务重启而不重复执行已送达的请求。
 */
export async function retryWhileRefused<T>(attempt: () => Promise<T>, options: {
  sleep?: (ms: number) => Promise<void>;
  budgetMs?: number;
  signal?: AbortSignal;
} = {}): Promise<T> {
  const { sleep = defaultRetrySleep, budgetMs = UNAVAILABLE_RETRY_MS, signal } = options;
  for (let waited = 0; ; waited += UNAVAILABLE_RETRY_INTERVAL_MS) {
    try { return await attempt(); }
    catch (error) {
      if (!connectionRefused(error) || signal?.aborted || waited + UNAVAILABLE_RETRY_INTERVAL_MS > budgetMs) throw error;
      await sleep(UNAVAILABLE_RETRY_INTERVAL_MS);
    }
  }
}
