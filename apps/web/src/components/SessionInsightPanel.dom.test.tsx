import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createContinuousMetric,
  createCountMetric,
  type AnalysisCoverage,
  type FileMetrics,
  type HostEvidenceSnapshot,
  type Metric,
  type SessionInsightCompareResponse,
  type SessionInsightDetailsResponse,
  type SessionInsightEventsResponse,
  type SessionInsightManifest,
  type SessionInsightSummary,
  type SessionInsightSourceSummary,
  type TraceEvent
} from '@dutydeck/shared';
import { api, ApiError, insightApi, type Session } from '../api';
import { setInstance } from '../instance';
import { SessionInsightPanel } from './SessionInsightPanel';

// ---- 夹具：用共享包的 metric 工厂保证语义完整（null≠0、分母齐全） ----

const cm = (value: number | null, patch: Partial<Parameters<typeof createCountMetric>[0]> = {}): Metric =>
  createCountMetric({ value, quality: value === null ? 'unknown' : 'exact', status: value === null ? 'unavailable' : 'available', ...patch });
const dm = (value: number | null, patch: Partial<Parameters<typeof createContinuousMetric>[0]> = {}): Metric =>
  createContinuousMetric({ value, quality: value === null ? 'unknown' : 'observed', status: value === null ? 'unavailable' : 'available', ...patch });

function metrics(patch: Partial<Record<keyof FileMetrics, Metric>> = {}): FileMetrics {
  const base: FileMetrics = {
    inputUncached: cm(0), cacheRead: cm(null), cacheWrite: cm(null), output: cm(0), reasoningOutput: cm(null),
    totalTracked: cm(0), rawInput: cm(0), rawOutput: cm(0), rawTotal: cm(null), peakContext: cm(0), contextWindow: cm(null),
    elapsedDurationMs: dm(0), activeDurationMs: dm(0), idleDurationMs: dm(null), pairedToolDurationMs: dm(0),
    userTurns: cm(0), assistantTurns: cm(0), toolCalls: cm(0), toolFailures: cm(0), toolSuccesses: cm(0), toolUnknowns: cm(0),
    toolFailureRate: dm(0), compactionCount: cm(0), subagentCount: cm(0)
  };
  return { ...base, ...patch };
}

function coverage(patch: Partial<AnalysisCoverage> = {}): AnalysisCoverage {
  return {
    rawLines: 10, parsedLines: 9, ignoredLines: 0, errorLines: 0,
    timeRange: { start: '2026-10-01T10:00:00.000Z', end: '2026-10-01T10:05:00.000Z' },
    missingTimestampCount: 0, disorderedTimestampCount: 0, retainedTraceCount: 9, omittedTraceCount: 0,
    omittedTraceByCategory: {}, tokenSamplesAvailable: 4, tokenSamplesMissing: 1,
    subagentDiscovery: 'none', inheritedHistory: 'none', ...patch
  };
}

const hostEvidence = (patch: Partial<HostEvidenceSnapshot> = {}): HostEvidenceSnapshot => ({
  capturedAt: '2026-10-01T10:05:01.000Z',
  taskGoals: [{ taskId: 't1', attemptId: 'a1', goal: '修复登录失败', status: 'running' }],
  omittedGoalsCount: 0,
  steeringRelations: [], omittedSteeringCount: 0,
  verificationSnapshot: [{ taskId: 't1', attemptId: 'a1', passed: false, stale: true }],
  omittedVerificationsCount: 0,
  modelConfigs: [{ taskId: 't1', attemptId: 'a1', configuredModel: 'gpt-model-x', provider: 'openai' }],
  omittedModelConfigsCount: 0,
  usageLedgerProjection: { recordedAtRange: { start: '2026-10-01T10:06:00.000Z', end: '2026-10-01T10:06:30.000Z' }, totalCostEstimate: 0.012, currency: 'USD', hasUnpricedUsage: true },
  digest: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  ...patch
});

let fixtureSeq = 0;
function sourceSummary(patch: Partial<SessionInsightSourceSummary> = {}): SessionInsightSourceSummary {
  const key = `src_main_${fixtureSeq++}`;
  return {
    sourceKey: key, client: 'codex', streamIdentity: { kind: 'main', nativeAgentId: null },
    sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    status: 'ok', scopeRole: 'primary', metrics: metrics(), models: ['gpt-model-x'], coverage: coverage(),
    relationship: { kind: 'none', parentNativeSessionId: null, parentNativeAgentId: null, evidenceRefs: [] },
    aggregation: { eligibility: 'eligible', reasonCodes: [] },
    keyEvidenceEventIds: { failures: ['evt-fail-1'], slowCalls: ['evt-slow-1'], highTokenDeltas: ['evt-token-1'] },
    ...patch
  };
}

function summary(patch: Partial<SessionInsightSummary> = {}): SessionInsightSummary {
  return {
    schemaVersion: 1, sessionId: 's1', snapshotId: 'snap_1', createdAt: '2026-10-01T10:05:02.000Z',
    scopeVersion: 'primary_verified_v1', primarySourceKey: 'src_main',
    models: ['gpt-model-x'], isMultiModel: false,
    aggregateMetrics: metrics(), qualityOverview: 'recorded',
    sources: [sourceSummary({ sourceKey: 'src_main' })],
    keyEvidenceEventIds: { failures: ['evt-fail-1'], slowCalls: ['evt-slow-1'], highTokenDeltas: ['evt-token-1'] },
    pulseBuckets: [],
    ...patch
  };
}

function manifest(patch: Partial<SessionInsightManifest> = {}): SessionInsightManifest {
  return {
    snapshotId: 'snap_1', sessionId: 's1', createdAt: '2026-10-01T10:05:02.000Z', bindingRevision: 3,
    scopeVersion: 'primary_verified_v1', hostEvidenceDigest: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    sources: [],
    versions: { schemaVersion: 1, engineVersion: '0.1.0', parserVersion: 'v3', metricVersion: 'v1', redactionVersion: 'r1' },
    ...patch
  };
}

function detailsResponse(patch: Partial<SessionInsightDetailsResponse> = {}): SessionInsightDetailsResponse {
  return {
    status: {
      sessionId: 's1', refreshState: 'idle', availability: 'none', freshness: 'unknown',
      currentSnapshotId: null, requestId: null, errorCode: null, lastCheckedAt: '2026-10-01T10:05:03.000Z'
    },
    summary: null, manifest: null, hostEvidence: null,
    hostExecutionFallback: { hasExecutionRecords: true },
    ...patch
  };
}

const traceEvent = (id: string, patch: Partial<TraceEvent> = {}): TraceEvent => ({
  eventId: id, sourceKey: 'src_main', nativeSessionId: 'native-s1',
  lineNumber: 1, byteOffset: 0, subeventIndex: 0,
  timestamp: '2026-10-01T10:01:00.000Z', timeQuality: 'exact', kind: 'tool_call',
  toolName: 'shell', resultStatus: 'failure',
  inputExcerpt: 'npm test', errorExcerpt: 'exit code 1', evidenceRefs: [], isSnapshotLocalId: false,
  ...patch
});

function eventsPage(ids: string[], nextCursor: string | null): SessionInsightEventsResponse {
  return {
    snapshotId: 'snap_1',
    items: ids.map((id, index) => ({ ...traceEvent(id, { lineNumber: index + 1 }), snapshotId: 'snap_1', ordinal: index })),
    nextCursor,
    totalMatching: 3
  };
}

// ---- 渲染助手 ----

function mountPanel(props: Partial<Parameters<typeof SessionInsightPanel>[0]> = {}) {
  const sessionsSpy = vi.spyOn(api, 'sessions').mockResolvedValue(sessionsList);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onCompareSessionChange = vi.fn();
  const onClose = vi.fn();
  const rendered = render(
    <QueryClientProvider client={client}>
      <SessionInsightPanel sessionId="s1" compareSessionId={null} onCompareSessionChange={onCompareSessionChange} onClose={onClose} {...props}/>
    </QueryClientProvider>
  );
  return { client, onCompareSessionChange, onClose, sessionsSpy, ...rendered };
}

const sessionsList: Session[] = [
  { id: 's1', agentId: 'codex', state: 'idle', cwd: '/repo/a', runId: 'r1', createdAt: '', updatedAt: '' },
  { id: 's2', agentId: 'codex', state: 'idle', cwd: '/repo/b', runId: 'r2', createdAt: '', updatedAt: '' }
];

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setInstance(undefined); });

describe('SessionInsightPanel 未分析 / 刷新 / 取消', () => {
  it('未分析时显示明确引导，GET 详情不隐式触发分析；点击「分析此会话」才 POST', async () => {
    const detailsSpy = vi.spyOn(insightApi, 'details').mockResolvedValue(detailsResponse());
    const refreshSpy = vi.spyOn(insightApi, 'refresh').mockResolvedValue({ requestId: '11111111-1111-4111-8111-111111111111', state: 'queued', cacheHit: false });
    vi.spyOn(insightApi, 'events');
    const user = userEvent.setup();
    mountPanel();

    expect(await screen.findByText('此会话还没有分析快照')).toBeTruthy();
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(detailsSpy).toHaveBeenCalledWith('s1', null, expect.any(AbortSignal));

    await user.click(screen.getByRole('button', { name: '分析此会话' }));
    await waitFor(() => expect(refreshSpy).toHaveBeenCalledWith('s1'));
  });

  it('queued 时可以取消刷新：DELETE 对应 requestId，取消后状态更新', async () => {
    vi.spyOn(insightApi, 'details')
      .mockResolvedValueOnce(detailsResponse({
        status: { sessionId: 's1', refreshState: 'queued', availability: 'none', freshness: 'unknown', currentSnapshotId: null, requestId: 'req-1', errorCode: null }
      }))
      .mockResolvedValueOnce(detailsResponse({
        status: { sessionId: 's1', refreshState: 'cancelled', availability: 'none', freshness: 'unknown', currentSnapshotId: null, requestId: 'req-1', errorCode: null }
      }));
    const cancelSpy = vi.spyOn(insightApi, 'cancel').mockResolvedValue({ success: true, state: 'cancelled' });
    const user = userEvent.setup();
    mountPanel();

    const cancelButton = await screen.findByRole('button', { name: '取消刷新' });
    await user.click(cancelButton);
    await waitFor(() => expect(cancelSpy).toHaveBeenCalledWith('s1', 'req-1'));
    expect(await screen.findByText('已取消')).toBeTruthy();
  });

  it('队列满（429 INSIGHT_QUEUE_FULL）逐行提示且不占任务队列语义', async () => {
    vi.spyOn(insightApi, 'details').mockResolvedValue(detailsResponse());
    vi.spyOn(insightApi, 'refresh').mockRejectedValue(new ApiError('队列已满', 'INSIGHT_QUEUE_FULL', 429));
    const user = userEvent.setup();
    mountPanel();
    await user.click(await screen.findByRole('button', { name: '分析此会话' }));
    expect(await screen.findByText(/分析队列已满，此会话未被接纳/)).toBeTruthy();
  });
});

describe('SessionInsightPanel 指标质量与失败旧快照', () => {
  it('null 显示「未知」，真实 0 显示 0，两者可辨；未知非零项标注质量', async () => {
    vi.spyOn(insightApi, 'details').mockResolvedValue(detailsResponse({
      status: { sessionId: 's1', refreshState: 'succeeded', availability: 'complete', freshness: 'current', currentSnapshotId: 'snap_1' },
      summary: summary({
        aggregateMetrics: metrics({
          inputUncached: cm(120), cacheRead: cm(null), output: cm(0),
          totalTracked: cm(null, { status: 'partial', reasonCodes: ['CACHE_BUCKETS_UNVERIFIED'] })
        })
      }),
      manifest: manifest(),
      hostEvidence: hostEvidence()
    }));
    mountPanel();
    const tokenSection = await screen.findByRole('region', { name: 'Token 分布' });
    // 行级定位：真实 0 与未知各自可辨，不依赖页面上 0 出现几次。
    const rowByLabel = (label: string) => {
      const dt = within(tokenSection).getByText(label);
      return dt.parentElement!.querySelector('dd')!;
    };
    expect(rowByLabel('输出 token').textContent).toBe('0');
    expect(rowByLabel('未缓存输入 token').textContent).toBe('120');
    expect(rowByLabel('缓存读取 token').textContent).toContain('未知');
    expect(rowByLabel('可追踪 token 合计').textContent).toContain('未知');
  });

  it('分析失败但有旧快照时保留旧数据并标示失败，失败不阻塞读取旧快照', async () => {
    const oldSummary = summary({ snapshotId: 'snap_old', createdAt: '2026-09-20T08:00:00.000Z' });
    vi.spyOn(insightApi, 'details').mockResolvedValue(detailsResponse({
      status: { sessionId: 's1', refreshState: 'failed', availability: 'complete', freshness: 'stale', currentSnapshotId: 'snap_old', errorCode: 'SOURCE_CHANGED' },
      summary: oldSummary, manifest: manifest({ snapshotId: 'snap_old' }), hostEvidence: hostEvidence()
    }));
    mountPanel();
    expect(await screen.findByText('最近一次分析失败，以下为旧快照')).toBeTruthy();
    // 失败原因错误码在横幅内容中。
    expect(screen.getByText(/SOURCE_CHANGED/)).toBeTruthy();
    // 旧指标仍然可读。
    expect(screen.getByText('快照 snap_old')).toBeTruthy();
  });

  it('首次分析失败且无旧快照时失败横幅内提供「重新分析」入口，点击后重新发起分析并回到排队中', async () => {
    vi.spyOn(insightApi, 'details')
      .mockResolvedValueOnce(detailsResponse({
        status: { sessionId: 's1', refreshState: 'failed', availability: 'none', freshness: 'unknown', currentSnapshotId: null, requestId: null, errorCode: 'NO_VERIFIED_SOURCE' }
      }))
      // refresh 成功失效详情后的重查（以及 queued 轮询）都回到排队中。
      .mockResolvedValue(detailsResponse({
        status: { sessionId: 's1', refreshState: 'queued', availability: 'none', freshness: 'unknown', currentSnapshotId: null, requestId: 'req-retry', errorCode: null }
      }));
    const refreshSpy = vi.spyOn(insightApi, 'refresh').mockResolvedValue({ requestId: '33333333-3333-4333-8333-333333333333', state: 'queued', cacheHit: false });
    const user = userEvent.setup();
    mountPanel();

    // 失败且无旧快照：横幅内必须有可点击的重试入口（不是只有文字）。
    const failureBanner = await screen.findByRole('alert');
    const retryButton = within(failureBanner).getByRole('button', { name: '重新分析' });
    expect(within(failureBanner).getByText(/NO_VERIFIED_SOURCE/)).toBeTruthy();

    await user.click(retryButton);
    await waitFor(() => expect(refreshSpy).toHaveBeenCalledWith('s1'));

    // POST 返回 queued 并失效详情后，状态回到排队中，出现取消入口，失败横幅消失。
    expect(await screen.findByText('排队中')).toBeTruthy();
    expect(await screen.findByRole('button', { name: '取消刷新' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('host-only details：无原生快照但有宿主证据时展示任务目标/验证/成本与不支持原因，不崩溃也不建假来源', async () => {
    vi.spyOn(insightApi, 'details').mockResolvedValue(detailsResponse({
      status: { sessionId: 's1', refreshState: 'idle', availability: 'none', freshness: 'unknown', currentSnapshotId: null },
      summary: null,
      manifest: null,
      hostEvidence: hostEvidence({
        taskGoals: [{ taskId: 't-host-1', attemptId: 'a1', goal: '仅在宿主执行的任务', status: 'completed' }],
        verificationSnapshot: [{ taskId: 't-host-1', attemptId: 'a1', passed: true, stale: false, summary: '通过' }]
      }),
      hostExecutionFallback: {
        hasExecutionRecords: true,
        unsupportedReason: '当前 Agent 驱动（自定义 pipe 驱动）不支持原生日志绑定'
      }
    }));
    mountPanel();
    // 渲染无原生日志原因说明
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.getByText(/当前 Agent 驱动（自定义 pipe 驱动）不支持原生日志绑定/)).toBeTruthy();
    // 宿主任务目标与验证结果依然完整可见，不因 summary=null 被隐藏
    const hostSection = screen.getByRole('region', { name: '宿主验证与关联任务' });
    expect(within(hostSection).getByText(/仅在宿主执行的任务/)).toBeTruthy();
    expect(within(hostSection).getByText('：通过')).toBeTruthy();
    expect(within(hostSection).getByText(/费用账本只读投影/)).toBeTruthy();
  });

  it('正常 summary 存在但 hostEvidence=null 时提示缺证据，不发生运行时崩溃', async () => {
    vi.spyOn(insightApi, 'details').mockResolvedValue(detailsResponse({
      status: { sessionId: 's1', refreshState: 'succeeded', availability: 'complete', freshness: 'current', currentSnapshotId: 'snap_1' },
      summary: summary(),
      manifest: manifest(),
      hostEvidence: null // 契约允许 hostEvidence 为 null
    }));
    mountPanel();
    const hostSection = await screen.findByRole('region', { name: '宿主验证与关联任务' });
    expect(within(hostSection).getByText(/快照中没有关联的宿主执行、验证或费用证据/)).toBeTruthy();
  });

  it('多模型、宿主验证 stale 与 steering 语义如实展示，不把日志 test 当验证', async () => {
    vi.spyOn(insightApi, 'details').mockResolvedValue(detailsResponse({
      status: { sessionId: 's1', refreshState: 'succeeded', availability: 'complete', freshness: 'current', currentSnapshotId: 'snap_1' },
      summary: summary({ models: ['gpt-model-x', 'gpt-model-y'], isMultiModel: true }),
      manifest: manifest(),
      hostEvidence: hostEvidence({
        steeringRelations: [{ steeringTaskId: 'st1', targetTaskId: 't1', targetAttemptId: 'a1', completed: true }]
      })
    }));
    mountPanel();
    expect(await screen.findByText('多模型')).toBeTruthy();
    expect(screen.getByText('gpt-model-x、gpt-model-y')).toBeTruthy();
    expect(screen.getByText(/记录已过期 stale/)).toBeTruthy();
    expect(screen.getByText(/已投递完成（不计独立模型轮次）/)).toBeTruthy();
  });

  it('多来源会话的数据覆盖按来源分别展示，不以主来源冒充全部来源', async () => {
    const mainSource = sourceSummary({
      sourceKey: 'src_main', scopeRole: 'primary',
      coverage: coverage({ rawLines: 100, parsedLines: 95 })
    });
    const subSource = sourceSummary({
      sourceKey: 'src_sub_1', scopeRole: 'subagent',
      streamIdentity: { kind: 'subagent', nativeAgentId: 'worker-agent-9' },
      coverage: coverage({ rawLines: 40, parsedLines: 38 })
    });
    vi.spyOn(insightApi, 'details').mockResolvedValue(detailsResponse({
      status: { sessionId: 's1', refreshState: 'succeeded', availability: 'complete', freshness: 'current', currentSnapshotId: 'snap_1' },
      summary: summary({ sources: [mainSource, subSource] }),
      manifest: manifest(), hostEvidence: hostEvidence()
    }));
    mountPanel();
    const coverageSection = await screen.findByRole('region', { name: '数据覆盖与质量' });
    // 主来源与子 Agent 的覆盖各自以卡片呈现
    expect(within(coverageSection).getByText(/主来源（Codex）/)).toBeTruthy();
    expect(within(coverageSection).getByText(/子 Agent \(worker-agent-9\)（Codex）/)).toBeTruthy();
    expect(within(coverageSection).getByText('95')).toBeTruthy();
    expect(within(coverageSection).getByText('38')).toBeTruthy();
  });
});

describe('SessionInsightPanel 证据定位与事件分页', () => {
  function mountWithSnapshot() {
    vi.spyOn(insightApi, 'details').mockResolvedValue(detailsResponse({
      status: { sessionId: 's1', refreshState: 'succeeded', availability: 'complete', freshness: 'current', currentSnapshotId: 'snap_1' },
      summary: summary(), manifest: manifest(), hostEvidence: hostEvidence()
    }));
    const eventsSpy = vi.spyOn(insightApi, 'events').mockImplementation(async (_sessionId, query) => {
      if (!query.cursor) return eventsPage(['evt-fail-1'], 'cursor-2');
      if (query.cursor === 'cursor-2') return eventsPage(['evt-slow-1', 'evt-token-1', 'evt-other'], null);
      return eventsPage([], null);
    });
    return { ...mountPanel(), eventsSpy };
  }

  it('从摘要关键证据逐页定位到具体失败事件并高亮，支持失败工具筛选', async () => {
    const user = userEvent.setup();
    const { eventsSpy } = mountWithSnapshot();

    const evidence = await screen.findByRole('region', { name: '关键证据定位' });
    await user.click(within(evidence).getByRole('button', { name: /失败调用/ }));
    // 第一页没有 evt-fail-1 之外的定位流程：evt-fail-1 在第一页，直接高亮。
    await waitFor(() => expect(screen.getByText('L1')).toBeTruthy());

    // 定位另一证据（第二页）触发 cursor 翻页。
    await user.click(within(evidence).getByRole('button', { name: /最慢调用/ }));
    await waitFor(() => expect(eventsSpy).toHaveBeenCalledWith('s1', expect.objectContaining({ cursor: 'cursor-2' }), expect.any(AbortSignal)));
    expect((await screen.findAllByText(/evt-slow-1/)).length).toBeGreaterThan(0);

    // 失败筛选固定在当前快照，不跨快照。
    await user.selectOptions(screen.getByLabelText('结果'), 'failure');
    await waitFor(() => expect(eventsSpy).toHaveBeenCalledWith('s1', expect.objectContaining({ result: 'failure', cursor: undefined }), expect.any(AbortSignal)));
  });

  it('找到第二页证据后终止定位：用户手动点击上一页能停住，更改筛选不被自动翻页覆盖', async () => {
    const user = userEvent.setup();
    const { eventsSpy } = mountWithSnapshot();

    const evidence = await screen.findByRole('region', { name: '关键证据定位' });
    // 定位第二页的 evt-slow-1：翻到第 2 页并找到
    await user.click(within(evidence).getByRole('button', { name: /最慢调用/ }));
    await waitFor(() => expect(eventsSpy).toHaveBeenCalledWith('s1', expect.objectContaining({ cursor: 'cursor-2' }), expect.any(AbortSignal)));
    expect(await screen.findByText('快照 snap_1 · 匹配 3 条 · 第 2 页')).toBeTruthy();

    // 此时搜索已终止。用户手动点击「上一页」：回到第 1 页并停住，不再被自动翻到第二页
    eventsSpy.mockClear();
    await user.click(screen.getByRole('button', { name: '上一页' }));
    expect(await screen.findByText('快照 snap_1 · 匹配 3 条 · 第 1 页')).toBeTruthy();
    // 确认没有再次请求 cursor-2
    expect(eventsSpy).toHaveBeenCalledWith('s1', expect.objectContaining({ cursor: undefined }), expect.any(AbortSignal));

    // 用户手动选择类型筛选：重置到第 1 页，不被旧定位目标强行翻页
    eventsSpy.mockClear();
    await user.selectOptions(screen.getByLabelText('类型'), 'tool_call');
    expect(await screen.findByText('快照 snap_1 · 匹配 3 条 · 第 1 页')).toBeTruthy();
    expect(eventsSpy).toHaveBeenLastCalledWith('s1', expect.objectContaining({ kind: 'tool_call', cursor: undefined }), expect.any(AbortSignal));
  });

  it('刷新产生新快照后查看时事件分页与游标重置（固定快照事件分页）', async () => {
    const eventsSpy = vi.spyOn(insightApi, 'events').mockImplementation(async (_sessionId, query) => {
      // 新快照 snap_2 只有一页，游标为空。
      return { ...eventsPage([], null), snapshotId: query.snapshotId };
    });
    let currentSnapshot = 'snap_1';
    vi.spyOn(insightApi, 'details').mockImplementation(async () => detailsResponse({
      status: { sessionId: 's1', refreshState: 'succeeded', availability: 'complete', freshness: 'current', currentSnapshotId: currentSnapshot },
      summary: summary({ snapshotId: currentSnapshot }), manifest: manifest({ snapshotId: currentSnapshot }), hostEvidence: hostEvidence()
    }));
    vi.spyOn(insightApi, 'refresh').mockResolvedValue({ requestId: '22222222-2222-4222-8222-222222222222', state: 'succeeded', cacheHit: false, snapshotId: 'snap_2' });
    const user = userEvent.setup();
    mountPanel();
    await waitFor(() => expect(eventsSpy).toHaveBeenCalledWith('s1', expect.objectContaining({ snapshotId: 'snap_1', cursor: undefined }), expect.any(AbortSignal)));

    // 服务端发布新快照后用户点击「重新分析」，详情 invalidate 拿到 snap_2。
    currentSnapshot = 'snap_2';
    await user.click(screen.getByRole('button', { name: '重新分析' }));
    await waitFor(() => expect(screen.getByText('快照 snap_2')).toBeTruthy());
    // 事件请求固定到新快照且游标重置为首页。
    await waitFor(() => expect(eventsSpy).toHaveBeenCalledWith('s1', expect.objectContaining({ snapshotId: 'snap_2', cursor: undefined }), expect.any(AbortSignal)));
  });
});

describe('SessionInsightPanel 对比零基线与不可比', () => {
  function compareResponse(patch: Partial<SessionInsightCompareResponse> = {}): SessionInsightCompareResponse {
    const leftSummary = summary({ sessionId: 's1', snapshotId: 'snap_1' });
    const rightSummary = summary({ sessionId: 's2', snapshotId: 'snap_2' });
    return {
      left: leftSummary, right: rightSummary,
      leftManifest: manifest({ snapshotId: 'snap_1', sessionId: 's1' }),
      rightManifest: manifest({ snapshotId: 'snap_2', sessionId: 's2' }),
      leftHostEvidence: hostEvidence(), rightHostEvidence: hostEvidence({ taskGoals: [{ taskId: 't2', attemptId: null, goal: '完全不同的目标', status: 'completed' }] }),
      comparable: false, incomparableReasons: ['METRIC_VERSION_MISMATCH'],
      metricDiffs: {
        output: { leftValue: 0, rightValue: 50, delta: 50, percentChange: null, isBaselineZero: true, comparable: true, reasonCodes: ['BASELINE_ZERO'] },
        cacheRead: { leftValue: null, rightValue: 10, delta: null, percentChange: null, isBaselineZero: false, comparable: false, reasonCodes: ['LEFT_UNAVAILABLE'] },
        toolFailures: { leftValue: 2, rightValue: 1, delta: -1, percentChange: -50, isBaselineZero: false, comparable: true, reasonCodes: [] }
      },
      ...patch
    };
  }

  it('左侧基线为 0 只显示绝对差；未知值不可比；不同任务不归因模型', async () => {
    vi.spyOn(insightApi, 'details').mockImplementation(async (sessionId) => sessionId === 's2'
      ? detailsResponse({ status: { sessionId: 's2', refreshState: 'succeeded', availability: 'complete', freshness: 'current', currentSnapshotId: 'snap_2' }, summary: summary({ sessionId: 's2', snapshotId: 'snap_2' }) })
      : detailsResponse({ status: { sessionId: 's1', refreshState: 'succeeded', availability: 'complete', freshness: 'current', currentSnapshotId: 'snap_1' }, summary: summary(), manifest: manifest(), hostEvidence: hostEvidence() }));
    vi.spyOn(insightApi, 'compare').mockResolvedValue(compareResponse());
    const user = userEvent.setup();
    mountPanel({ compareSessionId: 's2' });

    expect(await screen.findByText('基线为零，绝对差 +50')).toBeTruthy();
    expect(screen.getAllByText('不可比').length).toBeGreaterThan(0);
    expect(screen.getByText(/两侧任务目标不同：指标差异不能归因于模型/)).toBeTruthy();
    // 不显示无穷大百分比。
    expect(screen.queryByText(/Infinity|∞/)).toBeNull();
  });

  it('右侧会话没有快照时提示先分析，且对比不隐式触发刷新', async () => {
    const refreshSpy = vi.spyOn(insightApi, 'refresh');
    vi.spyOn(insightApi, 'details').mockImplementation(async (sessionId) => sessionId === 's2'
      ? detailsResponse({ status: { sessionId: 's2', refreshState: 'idle', availability: 'none', freshness: 'unknown', currentSnapshotId: null } })
      : detailsResponse({ status: { sessionId: 's1', refreshState: 'succeeded', availability: 'complete', freshness: 'current', currentSnapshotId: 'snap_1' }, summary: summary(), manifest: manifest(), hostEvidence: hostEvidence() }));
    mountPanel({ compareSessionId: 's2' });
    expect(await screen.findByText(/对比会话 s2 还没有分析快照/)).toBeTruthy();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('已打开比较后主会话重新分析产生新快照，对比区与对比导出冻结在最初选定时快照，不随刷新漂移', async () => {
    let currentLeftSnapshot = 'snap_old';
    vi.spyOn(insightApi, 'details').mockImplementation(async (sessionId) => {
      if (sessionId === 's2') {
        return detailsResponse({
          status: { sessionId: 's2', refreshState: 'succeeded', availability: 'complete', freshness: 'current', currentSnapshotId: 'snap_s2' },
          summary: summary({ sessionId: 's2', snapshotId: 'snap_s2' }),
          manifest: manifest({ snapshotId: 'snap_s2', sessionId: 's2' }),
          hostEvidence: hostEvidence()
        });
      }
      return detailsResponse({
        status: { sessionId: 's1', refreshState: 'succeeded', availability: 'complete', freshness: 'current', currentSnapshotId: currentLeftSnapshot },
        summary: summary({ sessionId: 's1', snapshotId: currentLeftSnapshot }),
        manifest: manifest({ snapshotId: currentLeftSnapshot, sessionId: 's1' }),
        hostEvidence: hostEvidence()
      });
    });

    const compareSpy = vi.spyOn(insightApi, 'compare').mockImplementation(async (params) => {
      return compareResponse({
        left: summary({ sessionId: params.left.sessionId, snapshotId: params.left.snapshotId }),
        right: summary({ sessionId: params.right.sessionId, snapshotId: params.right.snapshotId }),
        leftManifest: manifest({ snapshotId: params.left.snapshotId, sessionId: params.left.sessionId }),
        rightManifest: manifest({ snapshotId: params.right.snapshotId, sessionId: params.right.sessionId })
      });
    });

    const exportSpy = vi.spyOn(insightApi, 'exportReport').mockResolvedValue({
      blob: new Blob(['# compare report']),
      filename: 'compare-report.md'
    });

    const user = userEvent.setup();
    mountPanel({ compareSessionId: 's2' });

    const compareSection = await screen.findByRole('region', { name: '两会话对比' });

    // 初始状态：对比区域已就绪，使用 snap_old 与 snap_s2
    await waitFor(() => expect(within(compareSection).getByText(/快照 snap_old\b/)).toBeTruthy());
    expect(within(compareSection).getByText(/快照 snap_s2\b/)).toBeTruthy();
    expect(compareSpy).toHaveBeenCalledWith(
      { left: { sessionId: 's1', snapshotId: 'snap_old' }, right: { sessionId: 's2', snapshotId: 'snap_s2' } },
      expect.any(AbortSignal)
    );

    // 模拟服务端重新分析成功，主会话产生新快照 snap_new
    currentLeftSnapshot = 'snap_new';
    vi.spyOn(insightApi, 'refresh').mockResolvedValue({
      requestId: 'req-new',
      state: 'succeeded',
      cacheHit: false,
      snapshotId: 'snap_new'
    });

    // 用户在主面板点击「重新分析」
    const refreshButtons = screen.getAllByRole('button', { name: '重新分析' });
    await user.click(refreshButtons[0]!);

    // 主面板摘要更新到 snap_new
    expect(await screen.findByText('快照 snap_new')).toBeTruthy();

    // 核心断言 1：对比区域依然冻结在 snap_old 与 snap_s2，不发生漂移！
    expect(within(compareSection).getByText(/快照 snap_old\b/)).toBeTruthy();
    expect(within(compareSection).getByText(/快照 snap_s2\b/)).toBeTruthy();
    expect(within(compareSection).queryByText(/快照 snap_new\b/)).toBeNull();
    // compareApi 绝不能被调用包含 snap_new 的对比请求
    expect(compareSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ left: expect.objectContaining({ snapshotId: 'snap_new' }) }),
      expect.any(AbortSignal)
    );

    // 核心断言 2：在对比区点击「导出 Markdown」，导出的 left 必须是冻结的 snap_old，而不是当前 current 的 snap_new！
    const exportCompareButton = within(compareSection).getByRole('button', { name: '导出 Markdown' });
    await user.click(exportCompareButton);

    expect(exportSpy).toHaveBeenCalledWith({
      kind: 'comparison',
      left: { sessionId: 's1', snapshotId: 'snap_old' },
      right: { sessionId: 's2', snapshotId: 'snap_s2' },
      format: 'markdown'
    });
  });

  it('切换对比会话后冻结快照重置到新选择的首次可用快照，不残留旧右侧缓存', async () => {
    const sideDetails = (id: string, snap: string) => detailsResponse({
      status: { sessionId: id, refreshState: 'succeeded', availability: 'complete', freshness: 'current', currentSnapshotId: snap },
      summary: summary({ sessionId: id, snapshotId: snap }),
      manifest: manifest({ snapshotId: snap, sessionId: id }),
      hostEvidence: hostEvidence()
    });
    vi.spyOn(insightApi, 'details').mockImplementation(async (id: string) => {
      if (id === 's2') return sideDetails('s2', 'snap_s2');
      if (id === 's3') return sideDetails('s3', 'snap_s3');
      return sideDetails('s1', 'snap_1');
    });
    const compareSpy = vi.spyOn(insightApi, 'compare').mockImplementation(async (params) =>
      compareResponse({
        left: summary({ sessionId: params.left.sessionId, snapshotId: params.left.snapshotId }),
        right: summary({ sessionId: params.right.sessionId, snapshotId: params.right.snapshotId }),
        leftManifest: manifest({ snapshotId: params.left.snapshotId, sessionId: params.left.sessionId }),
        rightManifest: manifest({ snapshotId: params.right.snapshotId, sessionId: params.right.sessionId })
      }));

    const { client, rerender } = mountPanel({ compareSessionId: 's2' });
    const compareSection = await screen.findByRole('region', { name: '两会话对比' });
    await waitFor(() => expect(within(compareSection).getByText(/快照 snap_s2\b/)).toBeTruthy());
    expect(compareSpy).toHaveBeenLastCalledWith(
      { left: { sessionId: 's1', snapshotId: 'snap_1' }, right: { sessionId: 's2', snapshotId: 'snap_s2' } },
      expect.any(AbortSignal)
    );

    // 用户改选另一会话 s3：props 更新，冻结对必须重建为 s3 的首次可用快照。
    rerender(
      <QueryClientProvider client={client}>
        <SessionInsightPanel sessionId="s1" compareSessionId="s3" onCompareSessionChange={vi.fn()} onClose={vi.fn()}/>
      </QueryClientProvider>
    );
    await waitFor(() => expect(compareSpy).toHaveBeenLastCalledWith(
      { left: { sessionId: 's1', snapshotId: 'snap_1' }, right: { sessionId: 's3', snapshotId: 'snap_s3' } },
      expect.any(AbortSignal)
    ));
    const refreshedSection = screen.getByRole('region', { name: '两会话对比' });
    expect(within(refreshedSection).getByText(/快照 snap_s3\b/)).toBeTruthy();
    expect(within(refreshedSection).queryByText(/快照 snap_s2\b/)).toBeNull();
  });
});

describe('SessionInsightPanel 导出与实例', () => {
  it('导出 Markdown / HTML 走实例 POST attachment 下载，文件名来自 Content-Disposition', async () => {
    setInstance('tag');
    vi.spyOn(insightApi, 'details').mockResolvedValue(detailsResponse({
      status: { sessionId: 's1', refreshState: 'succeeded', availability: 'complete', freshness: 'current', currentSnapshotId: 'snap_1' },
      summary: summary(), manifest: manifest(), hostEvidence: hostEvidence()
    }));
    vi.spyOn(insightApi, 'events').mockResolvedValue(eventsPage([], null));
    vi.spyOn(api, 'sessions').mockResolvedValue(sessionsList);
    const exportCalls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
      if (url.includes('/insights/export')) {
        exportCalls.push(init?.body ?? '');
        const format = JSON.parse(init!.body as string).format as string;
        return {
          ok: true, status: 200,
          headers: new Headers({ 'Content-Disposition': `attachment; filename="report.${format === 'html' ? 'html' : 'md'}"` }),
          blob: async () => new Blob([format === 'html' ? '<html></html>' : '# 报告'], { type: format === 'html' ? 'text/html' : 'text/markdown' })
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }));
    const createObjectURL = vi.fn(() => 'blob:mock-url');
    const revokeObjectURL = vi.fn();
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const user = userEvent.setup();
    try {
      mountPanel();
      await user.click(await screen.findByRole('button', { name: '导出 Markdown' }));
      await user.click(await screen.findByRole('button', { name: '导出 HTML' }));
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
    await vi.waitFor(() => expect(exportCalls).toHaveLength(2));
    expect(JSON.parse(exportCalls[0]!)).toMatchObject({ kind: 'session', sessionId: 's1', snapshotId: 'snap_1', format: 'markdown' });
    expect(JSON.parse(exportCalls[1]!)).toMatchObject({ kind: 'session', sessionId: 's1', snapshotId: 'snap_1', format: 'html' });
    // 请求落在实例代理前缀上。
    expect((vi.mocked(window.fetch)).mock.calls.some(call => String(call[0]) === '/api/instances/tag/insights/export')).toBe(true);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(clickSpy).toHaveBeenCalledTimes(2);
  });

  it('已选择对比 session 时点击单会话导出依然正常导出单会话固定快照，不受 compareSessionId 状态干扰', async () => {
    vi.spyOn(insightApi, 'details').mockImplementation(async (id: string) => id === 's2'
      ? detailsResponse({ status: { sessionId: 's2', refreshState: 'succeeded', availability: 'complete', freshness: 'current', currentSnapshotId: 'snap_2' }, summary: summary({ sessionId: 's2', snapshotId: 'snap_2' }) })
      : detailsResponse({ status: { sessionId: 's1', refreshState: 'succeeded', availability: 'complete', freshness: 'current', currentSnapshotId: 'snap_1' }, summary: summary(), manifest: manifest(), hostEvidence: hostEvidence() }));
    vi.spyOn(insightApi, 'events').mockResolvedValue(eventsPage([], null));
    vi.spyOn(api, 'sessions').mockResolvedValue(sessionsList);
    const exportSpy = vi.spyOn(insightApi, 'exportReport').mockResolvedValue({
      blob: new Blob(['# report']),
      filename: 'session-insight-s1.md'
    });
    const user = userEvent.setup();
    // 渲染时带上 compareSessionId="s2"
    mountPanel({ compareSessionId: 's2' });
    // 面板主体的「导出 Markdown」属于单会话导出
    const exportButtons = await screen.findAllByRole('button', { name: '导出 Markdown' });
    await user.click(exportButtons[0]!);
    expect(exportSpy).toHaveBeenCalledWith({ kind: 'session', sessionId: 's1', snapshotId: 'snap_1', format: 'markdown' });
  });
});

describe('SessionInsightPanel 实例隔离', () => {
  it('sessionsForCompare 的 queryKey 显式带当前实例，实例切换不串会话列表缓存', async () => {
    setInstance('work-bot');
    vi.spyOn(insightApi, 'details').mockResolvedValue(detailsResponse({
      status: { sessionId: 's1', refreshState: 'idle', availability: 'none', freshness: 'unknown', currentSnapshotId: null }
    }));
    const { client, sessionsSpy } = mountPanel();
    await screen.findByRole('region', { name: '两会话对比' });
    await vi.waitFor(() => expect(sessionsSpy).toHaveBeenCalled());
    // 缓存 key 必须包含实例 'work-bot'
    expect(client.getQueryData(['sessions', 'work-bot'])).toEqual(sessionsList);
    expect(client.getQueryData(['sessions', null])).toBeUndefined();
  });

  it('远端实例下详情与事件都走 /api/instances/<id> 前缀；切回主实例不带前缀', async () => {
    setInstance('tag');
    const fetchSpy = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      clone: () => ({ json: async () => ({}) }),
      json: async () => {
        if (url.includes('/events')) return { snapshotId: 'snap_1', items: [], nextCursor: null, totalMatching: 0 };
        return detailsResponse({
          status: { sessionId: 's1', refreshState: 'succeeded', availability: 'complete', freshness: 'current', currentSnapshotId: 'snap_1' },
          summary: summary(), manifest: manifest(), hostEvidence: hostEvidence()
        });
      },
      blob: async () => new Blob()
    }));
    vi.stubGlobal('fetch', fetchSpy);
    // 对比下拉的 /api/sessions 也走实例前缀；用真实 fetch stub 覆盖。
    mountPanel();
    await screen.findByRole('region', { name: '源时间线与事件' });
    const urls = fetchSpy.mock.calls.map(call => call[0] as string);
    expect(urls.some(url => url === '/api/instances/tag/sessions/s1/insight')).toBe(true);
    expect(urls.some(url => url.startsWith('/api/instances/tag/sessions/s1/insight/events?'))).toBe(true);
    // 没有任何分析请求漏到主实例路径。
    expect(urls.some(url => url.startsWith('/api/sessions/s1/insight'))).toBe(false);
  });
});
