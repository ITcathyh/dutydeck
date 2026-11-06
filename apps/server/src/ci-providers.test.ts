import { afterEach, expect, it, vi } from 'vitest';
import type { CiProvider } from '@dutydeck/shared';
import { CiProviderRegistry } from './ci-providers.js';

const repository = { owner: 'octo', name: 'repo', slug: 'octo/repo' };
const base = { displayName: 'Slow CI', matchRepository: () => repository } satisfies Partial<CiProvider>;
afterEach(() => { vi.useRealTimers(); });

it('uses a provider-declared time limit, clamped to the host ceiling per method, and aborts the call signal', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const warn = vi.fn();
  const signals: AbortSignal[] = [];
  const hang = (context?: { signal: AbortSignal }) => { signals.push(context!.signal); return new Promise<never>(() => {}); };
  const registry = new CiProviderRegistry({ log: { warn } });
  registry.register('slow', {
    ...base, id: 'slow',
    callTimeoutMs: { listReviewComments: 60_000, getPipelineStatus: 600_000 },
    listReviewComments: (_repository, _number, context) => hang(context),
    getPipelineStatus: (_query, context) => hang(context),
    getPullRequest: (_repository, _number, context) => hang(context)
  });
  const provider = registry.get('slow')!;
  const outcome = (promise: Promise<unknown>) => promise.then(() => 'resolved', (error: { code?: string }) => error.code ?? 'rejected');
  const comments = outcome(provider.listReviewComments!(repository, 1));
  const pipeline = outcome(provider.getPipelineStatus!({ repository, sha: 'a'.repeat(40) }));
  const state = outcome(provider.getPullRequest!(repository, 1));
  await vi.advanceTimersByTimeAsync(25_000);
  // 没声明的方法用默认 25 秒；声明 10 分钟的 getPipelineStatus 被夹回 25 秒（CI 订阅租约 30 秒）。
  expect(await state).toBe('CI_PROVIDER_TIMEOUT');
  expect(await pipeline).toBe('CI_PROVIDER_TIMEOUT');
  let commentsDone = false; void comments.then(() => { commentsDone = true; });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(commentsDone).toBe(false);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await comments).toBe('CI_PROVIDER_TIMEOUT');
  expect(signals.every(signal => signal.aborted)).toBe(true);
  expect(warn.mock.calls.map(([data]) => [data.method, data.timeoutMs])).toEqual([['getPipelineStatus', 25_000], ['getPullRequest', 25_000], ['listReviewComments', 60_000]]);
});
