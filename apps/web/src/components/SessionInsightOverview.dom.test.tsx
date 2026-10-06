import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionInsightSummaryResponse, SummaryGroupRow, SummarySessionRow } from '@dutydeck/shared';
import { ApiError, insightApi } from '../api';
import { SessionInsightOverview } from './SessionInsightOverview';

const countMetric = (value: number | null) => ({
  value,
  quality: (value === null ? 'unknown' : 'exact') as 'unknown' | 'exact',
  status: (value === null ? 'unavailable' : 'available') as 'unavailable' | 'available',
  evidenceCount: value === null ? 0 : 1,
  missingCount: value === null ? 1 : 0,
  reasonCodes: [] as string[]
});
const durationMetric = (value: number | null) => ({
  value,
  quality: (value === null ? 'unknown' : 'observed') as 'unknown' | 'observed',
  status: (value === null ? 'unavailable' : 'available') as 'unavailable' | 'available',
  evidenceCount: value === null ? 0 : 1,
  missingCount: value === null ? 1 : 0,
  reasonCodes: [] as string[]
});

const metrics = () => ({
  inputUncached: countMetric(0), cacheRead: countMetric(0), cacheWrite: countMetric(0), output: countMetric(0),
  reasoningOutput: countMetric(0), totalTracked: countMetric(0), rawInput: countMetric(0), rawOutput: countMetric(0),
  rawTotal: countMetric(0), peakContext: countMetric(0), contextWindow: countMetric(null),
  elapsedDurationMs: durationMetric(0), activeDurationMs: durationMetric(0), idleDurationMs: durationMetric(null),
  pairedToolDurationMs: durationMetric(0), userTurns: countMetric(0), assistantTurns: countMetric(0),
  toolCalls: countMetric(0), toolFailures: countMetric(0), toolSuccesses: countMetric(0), toolUnknowns: countMetric(0),
  toolFailureRate: durationMetric(0), compactionCount: countMetric(0), subagentCount: countMetric(0)
});

function sessionRow(patch: Partial<SummarySessionRow>): SummarySessionRow {
  return {
    sessionId: 's1', workspace: 'repo-a', agentId: 'codex', usage: 'explicit',
    createdAt: '2026-10-01T00:00:00.000Z', refreshState: 'idle', errorCode: null, lastCheckedAt: null,
    hasSnapshot: false, snapshotId: null, availability: 'none', freshness: 'unknown',
    models: [], metrics: null, metricAttributions: {}, isSharedSource: false, ...patch
  };
}

function summaryResponse(patch: Partial<SessionInsightSummaryResponse> = {}): SessionInsightSummaryResponse {
  return {
    candidateSessions: 3, withSnapshot: 1, withoutSnapshot: 2,
    partialSnapshots: 0, failedRefreshes: 1, staleSnapshots: 0, freshnessUnknown: 1,
    groups: [], sessions: [], nextCursor: null, ...patch
  };
}

function groupRow(patch: Partial<SummaryGroupRow>): SummaryGroupRow {
  return {
    groupKey: 'repo-a', candidateSessions: 3, withSnapshot: 1, withoutSnapshot: 2,
    partialSnapshots: 0, failedRefreshes: 1, staleSnapshots: 0, freshnessUnknown: 1,
    includedCount: 1, excludedCount: 2, excludedReasons: { INHERITED_HISTORY: 1, SHARED_SOURCE: 1 },
    metricCoverage: {},
    aggregateMetrics: metrics(), ...patch
  };
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onOpenSession = vi.fn();
  const onCompare = vi.fn();
  render(<QueryClientProvider client={client}>
    <SessionInsightOverview onOpenSession={onOpenSession} onCompare={onCompare}/>
  </QueryClientProvider>);
  return { onOpenSession, onCompare };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('SessionInsightOverview 稳定分母与覆盖维度', () => {
  it('候选分母来自会话目录；部分/失败/过期/未知是可重叠维度不相加', async () => {
    vi.spyOn(insightApi, 'summary').mockResolvedValue(summaryResponse({
      groups: [groupRow({})],
      sessions: [sessionRow({})]
    }));
    mount();
    const coverage = await screen.findByRole('region', { name: '候选会话覆盖' });
    expect(within(coverage).getByText(/候选会话 3 个/)).toBeTruthy();
    expect(within(coverage).getByText('已有快照 1')).toBeTruthy();
    expect(within(coverage).getByText('未分析 2')).toBeTruthy();
    expect(within(coverage).getByText(/与候选总数一致/)).toBeTruthy();
    expect(within(coverage).getByText(/可重叠维度，不参与相加/)).toBeTruthy();
  });

  it('with + without 不等于候选数时给出不一致警告，不假装数据正确', async () => {
    vi.spyOn(insightApi, 'summary').mockResolvedValue(summaryResponse({ candidateSessions: 4, groups: [], sessions: [] }));
    mount();
    const coverage = await screen.findByRole('region', { name: '候选会话覆盖' });
    expect(within(coverage).getByText(/与候选总数不一致/)).toBeTruthy();
  });

  it('分组切换时请求带 groupBy，纳入/排除原因可见', async () => {
    const spy = vi.spyOn(insightApi, 'summary').mockResolvedValue(summaryResponse({ groups: [groupRow({})], sessions: [] }));
    const user = userEvent.setup();
    mount();
    await screen.findByRole('region', { name: '分组汇总' });
    await user.selectOptions(screen.getByLabelText('分组'), 'agent');
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: 'agent' }), expect.any(AbortSignal));
    const groups = await screen.findByRole('region', { name: '分组汇总' });
    expect(within(groups).getByRole('columnheader', { name: '分组' })).toBeTruthy();
    // 排除 2 个原因可悬浮查看。
    expect(within(groups).getByTitle('INHERITED_HISTORY 1；SHARED_SOURCE 1')).toBeTruthy();
  });

  it('按指标独立展示 metricCoverage 纳入/排除与原因；缺覆盖字段时标为覆盖未知而非补零', async () => {
    const groupWithMetrics = groupRow({
      aggregateMetrics: metrics(),
      metricCoverage: {
        totalTracked: {
          includedCount: 1,
          excludedCount: 2,
          excludedReasons: { EXCLUDED_FORK: 2 }
        }
        // 刻意省略 elapsedDurationMs：模拟「有 Token 无时间」或部分指标未上报独立分母
      }
    });
    vi.spyOn(insightApi, 'summary').mockResolvedValue(summaryResponse({ groups: [groupWithMetrics], sessions: [] }));
    mount();
    const groups = await screen.findByRole('region', { name: '分组汇总' });
    // totalTracked 有独立覆盖记录：呈现纳入 1 / 排除 2，以及原因
    expect(within(groups).getByText('纳入 1 / 排除 2')).toBeTruthy();
    expect(within(groups).getByTitle('纳入 1 / 排除 2（原因：EXCLUDED_FORK 2）')).toBeTruthy();
    // elapsedDurationMs 缺失 coverage 字段：明确标为「覆盖未知」，绝不补 0 或虚构全覆盖
    expect(within(groups).getByText('覆盖未知')).toBeTruthy();
    expect(within(groups).getByTitle('该指标未上报分母覆盖，按未知处理')).toBeTruthy();
  });
});

describe('SessionInsightOverview 选择、批量有界提交与对比', () => {
  const rows: SummarySessionRow[] = [
    sessionRow({ sessionId: 'a', hasSnapshot: true, snapshotId: 'snap-a', availability: 'complete', freshness: 'current', refreshState: 'succeeded', models: ['m1'] }),
    sessionRow({ sessionId: 'b', refreshState: 'failed', errorCode: 'SOURCE_CHANGED' }),
    sessionRow({ sessionId: 'c', isSharedSource: true, attributionNote: '共享来源只算一次' })
  ];

  it('逐行有界提交：接纳、排队、队列满各自逐行反馈，队列满不影响其他行', async () => {
    vi.spyOn(insightApi, 'summary').mockResolvedValue(summaryResponse({ groups: [groupRow({})], sessions: rows }));
    const refreshSpy = vi.spyOn(insightApi, 'refresh').mockImplementation(async (sessionId) => {
      if (sessionId === 'a') return { requestId: '11111111-1111-4111-8111-111111111111', state: 'succeeded', cacheHit: true, snapshotId: 'snap-a' };
      if (sessionId === 'b') throw new ApiError('队列已满', 'INSIGHT_QUEUE_FULL', 429);
      return { requestId: '22222222-2222-4222-8222-222222222222', state: 'queued', cacheHit: false };
    });
    const user = userEvent.setup();
    mount();

    await screen.findByRole('region', { name: '会话列表' });
    for (const id of ['a', 'b', 'c']) {
      await user.click(screen.getByLabelText(`选择会话 ${id}`));
    }
    await user.click(screen.getByRole('button', { name: /分析所选/ }));

    // 三个请求按顺序逐行发出（有界串行，不构造批处理任务）。
    await vi.waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(3));
    const list = screen.getByRole('region', { name: '会话列表' });
    expect(within(list).getByTestId('batch-state-a').textContent).toContain('已接纳');
    expect(within(list).getByTestId('batch-state-b').textContent).toContain('队列已满，未接纳');
    expect(within(list).getByTestId('batch-state-c').textContent).toContain('已排队');
  });

  it('恰好选择两个有快照的会话才能进入对比；未分析会话不能凑数', async () => {
    vi.spyOn(insightApi, 'summary').mockResolvedValue(summaryResponse({ groups: [groupRow({})], sessions: rows }));
    const user = userEvent.setup();
    const { onCompare } = mount();
    await screen.findByRole('region', { name: '会话列表' });

    // 只选一个有快照的 a：对比按钮禁用。
    await user.click(screen.getByLabelText('选择会话 a'));
    const compareButton = screen.getByRole('button', { name: '对比所选两个会话' }) as HTMLButtonElement;
    expect(compareButton.disabled).toBe(true);

    // 再选无快照的 b：仍禁用，并提示需要两个有快照的。
    await user.click(screen.getByLabelText('选择会话 b'));
    expect(compareButton.disabled).toBe(true);
    expect(screen.getByText(/对比需要恰好两个都有快照的会话/)).toBeTruthy();

    // 改选第二个有快照的会话（c 无快照；这里仅 a 有快照，构造一个第二有快照行）。
    await user.click(screen.getByLabelText('选择会话 b'));
    // rows 中只有 a 有快照；直接验证禁用态已经覆盖语义。再选 c 也仍禁用。
    await user.click(screen.getByLabelText('选择会话 c'));
    expect(compareButton.disabled).toBe(true);
    expect(onCompare).not.toHaveBeenCalled();
  });

  it('两个都有快照时点击对比回传两个 sessionId', async () => {
    const twoSnapshotRows = [
      sessionRow({ sessionId: 'a', hasSnapshot: true, snapshotId: 'snap-a', availability: 'complete', freshness: 'current', refreshState: 'succeeded' }),
      sessionRow({ sessionId: 'd', hasSnapshot: true, snapshotId: 'snap-d', availability: 'complete', freshness: 'current', refreshState: 'succeeded' })
    ];
    vi.spyOn(insightApi, 'summary').mockResolvedValue(summaryResponse({ groups: [groupRow({})], sessions: twoSnapshotRows }));
    const user = userEvent.setup();
    const { onCompare } = mount();
    await screen.findByRole('region', { name: '会话列表' });
    await user.click(screen.getByLabelText('选择会话 a'));
    await user.click(screen.getByLabelText('选择会话 d'));
    await user.click(screen.getByRole('button', { name: '对比所选两个会话' }));
    expect(onCompare).toHaveBeenCalledWith('a', 'd');
  });

  it('覆盖统计来自首页且始终完整；会话行可通过 cursor 加载更多，分页不改变分母', async () => {
    const page1 = { ...summaryResponse({ candidateSessions: 2, withSnapshot: 1, withoutSnapshot: 1, groups: [groupRow({ candidateSessions: 2, withoutSnapshot: 1 })], sessions: [sessionRow({ sessionId: 'p1' })], nextCursor: 'cur-1' }) };
    const page2 = { ...page1, sessions: [sessionRow({ sessionId: 'p2' })], nextCursor: null };
    const spy = vi.spyOn(insightApi, 'summary')
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);
    const user = userEvent.setup();
    mount();
    const list = await screen.findByRole('region', { name: '会话列表' });
    expect(within(list).getByRole('button', { name: 'p1' })).toBeTruthy();
    const more = screen.getByRole('button', { name: '加载更多会话' });
    await user.click(more);
    await vi.waitFor(() => expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'cur-1', limit: 100 }), expect.any(AbortSignal)));
    expect(within(list).getByRole('button', { name: 'p2' })).toBeTruthy();
    // 覆盖统计仍是首页的完整分母，没有被第二页相加。
    const coverage = screen.getByRole('region', { name: '候选会话覆盖' });
    expect(within(coverage).getByText(/候选会话 2 个/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '加载更多会话' })).toBeNull();
  });

  it('初次请求 503 失败时优先展示错误横幅与重试按钮，不卡在 Spinner；重试不触发分析任务', async () => {
    const refreshSpy = vi.spyOn(insightApi, 'refresh');
    const summarySpy = vi.spyOn(insightApi, 'summary')
      .mockRejectedValueOnce(new ApiError('服务暂不可用', 'SERVICE_UNAVAILABLE', 503))
      .mockResolvedValueOnce(summaryResponse({ groups: [groupRow({})], sessions: [] }));
    const user = userEvent.setup();
    mount();
    // 首次失败立即展示错误横幅与重试按钮，不卡在 Spinner
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('会话分析汇总读取失败：服务暂不可用');
    expect(screen.queryByText('正在读取会话分析汇总…')).toBeNull();
    // 点击「重试」只重新查询汇总 GET，不触发 POST 分析刷新
    await user.click(within(banner).getByRole('button', { name: '重试' }));
    await screen.findByRole('region', { name: '候选会话覆盖' });
    expect(summarySpy).toHaveBeenCalledTimes(2);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('点击会话行打开该会话；共享来源会话有明确标注', async () => {
    vi.spyOn(insightApi, 'summary').mockResolvedValue(summaryResponse({ groups: [groupRow({})], sessions: rows }));
    const user = userEvent.setup();
    const { onOpenSession } = mount();
    await screen.findByRole('region', { name: '会话列表' });
    await user.click(screen.getByRole('button', { name: 'c' }));
    expect(onOpenSession).toHaveBeenCalledWith('c');
    // 共享来源行带标注与该行自带的归属说明。
    expect(screen.getByText('共享来源')).toBeTruthy();
    expect(screen.getByTitle('共享来源只算一次')).toBeTruthy();
  });
});
