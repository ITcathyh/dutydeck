import type { CiPipelineQuery, CiPipelineStatus, CiRun } from '@dutydeck/shared';
import { CiProviderRegistry } from './ci-providers.js';

/** 测试仓库的 origin；只有 ciProviders() 注册的测试提供方认领它。 */
export const TEST_CI_REMOTE = 'git@ci.example.com:octo/repo.git';

export type StatusMock = (query: CiPipelineQuery) => Promise<CiPipelineStatus>;

/** 测试用的 CI 构建结果；attempt 为 null 表示提供方没给重跑次数。 */
export function ciStatus(headSha: string, runs: Array<{ id: number; conclusion?: string; name?: string; status?: string; attempt?: number | null }> = []): CiPipelineStatus {
  const mapped: CiRun[] = runs.map(item => ({
    id: item.id,
    name: item.name ?? 'CI',
    attempt: item.attempt === null ? undefined as unknown as number : item.attempt ?? 1,
    headSha,
    status: (item.status ?? 'completed') === 'completed' ? 'completed' : 'running',
    ...(item.conclusion ? { conclusion: item.conclusion, result: item.conclusion === 'failure' ? 'failed' as const : 'success' as const } : {}),
    url: `https://ci.example.com/octo/repo/runs/${item.id}`
  }));
  const state = mapped.some(item => item.status !== 'completed') ? 'running' : mapped.some(item => item.result === 'failed') ? 'failed' : mapped.length ? 'success' : 'unknown';
  return { state, runs: mapped };
}

/** 只认 TEST_CI_REMOTE 的 CI 提供方，构建结果由 status 给出（缺省是这个提交没有构建）。 */
export function ciProviders(status?: StatusMock, id = 'test-ci') {
  const registry = new CiProviderRegistry();
  registry.register('test-ci-plugin', {
    id,
    displayName: 'Test CI',
    matchRepository: remote => remote === TEST_CI_REMOTE ? { owner: 'octo', name: 'repo', slug: 'octo/repo' } : undefined,
    getPipelineStatus: query => (status ?? (async () => ciStatus(query.sha)))(query)
  });
  return registry;
}
