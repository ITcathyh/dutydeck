import { test, expect } from '@playwright/test';
import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  launchSessionInsightTestServer,
  type SessionInsightTestEnvironment
} from './session-insight-harness.js';
import type { TestServerInstance } from './harness.js';
import type { Metric, MetricComparison, TraceEvent } from '@dutydeck/shared';

// 报告渲染器 apps/server/src/session-insight-export.ts METRIC_LABELS 的完整映射，
// 用于在 MD/HTML 报告中按真实标签定位指标行（标签与 UI 的 metricMeta 不同）。
const EXPORT_METRIC_LABELS: Record<string, string> = {
  inputUncached: '未缓存输入',
  cacheRead: '缓存读取',
  cacheWrite: '缓存写入',
  output: '输出 Token',
  reasoningOutput: '推理 Token',
  totalTracked: '已追踪 Token 合计',
  rawInput: '源输入累计',
  rawOutput: '源输出累计',
  rawTotal: '源总量',
  peakContext: '上下文峰值',
  contextWindow: '上下文窗口',
  elapsedDurationMs: '总时长',
  activeDurationMs: '活跃时长',
  idleDurationMs: '观测空档',
  pairedToolDurationMs: '工具配对耗时',
  userTurns: '用户轮次',
  assistantTurns: '助手轮次',
  toolCalls: '工具调用',
  toolFailures: '调用失败',
  toolSuccesses: '调用成功',
  toolUnknowns: '结果未知',
  toolFailureRate: '失败率',
  compactionCount: '压缩次数',
  subagentCount: '子 Agent 数'
};

// 纯整数计数类指标（报告按 en-US 整数渲染，可直接比对具体数字）。
const INTEGER_METRIC_KEYS = [
  'inputUncached', 'cacheRead', 'cacheWrite', 'output', 'reasoningOutput',
  'totalTracked', 'rawInput', 'rawOutput', 'rawTotal', 'peakContext', 'contextWindow',
  'userTurns', 'assistantTurns', 'toolCalls', 'toolFailures', 'toolSuccesses',
  'toolUnknowns', 'compactionCount', 'subagentCount'
];

// 与 export 渲染器一致的整数值格式（en-US 分组）。
const formatExportInteger = (value: number) => value.toLocaleString('en-US');

/**
 * 还原 escapeMarkdown 的单元格转义（`\\` + 结构字符 → 原字符），
 * 用于在 Markdown 报告中精确断言含下划线的 snapshotId / sessionId 原值。
 */
function unescapeMarkdown(value: string): string {
  return value.replace(/\\([\\`|()[\]<>*_])/g, '$1');
}

/** 从 Markdown 表格中按指标标签取出值单元格（已解转义）；找不到返回 null。 */
function findMdMetricCell(markdown: string, label: string): string | null {
  const prefix = `| ${label} |`;
  const line = markdown.split('\n').find(row => row.includes(prefix));
  if (!line) return null;
  const cells = line.split('|').map(cell => cell.trim());
  // 行形如 '' | label | value | ''，值在第 3 段。
  return cells[2] ? unescapeMarkdown(cells[2]) : null;
}

test.describe('Session Insight E2E Browser Acceptance', () => {
  let env: SessionInsightTestEnvironment;
  let serverInstance: TestServerInstance;

  test.beforeAll(async () => {
    // 启动完全隔离的测试服务与三客户端受控 Agent 环境
    env = await launchSessionInsightTestServer({ prefix: 'dutydeck-acc-si-' });
    serverInstance = env.instance;
  });

  test.afterAll(async () => {
    if (serverInstance) {
      await serverInstance.cleanup();
    }
  });

  /** 通过真实 events API 按游标翻页定位指定 eventId，返回该事件完整 item。 */
  async function fetchEventById(
    sessionId: string,
    snapshotId: string,
    eventId: string
  ): Promise<TraceEvent | null> {
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 30; pageIndex += 1) {
      const params = new URLSearchParams({ snapshotId, limit: '200' });
      if (cursor) params.set('cursor', cursor);
      const res = await serverInstance.request(
        'GET',
        `/api/sessions/${sessionId}/insight/events?${params.toString()}`
      );
      expect(res.status, `events API failed: ${res.text}`).toBe(200);
      const found = (res.json.items as TraceEvent[]).find(item => item.eventId === eventId);
      if (found) return found;
      if (!res.json.nextCursor) return null;
      cursor = res.json.nextCursor as string;
    }
    return null;
  }

  /** 触发刷新并轮询至 refreshState 进入终态，返回终态。 */
  async function refreshAndWaitTerminal(sessionId: string): Promise<string> {
    const refreshRes = await serverInstance.request(
      'POST',
      `/api/sessions/${sessionId}/insight/refresh`
    );
    expect([200, 202]).toContain(refreshRes.status);
    const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
    let state = '';
    await expect.poll(async () => {
      const res = await serverInstance.request('GET', `/api/sessions/${sessionId}/insight`);
      state = res.json?.status?.refreshState ?? '';
      return state;
    }, { timeout: 90_000, intervals: [500, 1_000, 2_000] }).toMatch(/succeeded|failed|cancelled|interrupted/);
    expect(terminal.has(state)).toBe(true);
    return state;
  }

  // ==========================================================================
  // 场景 1: 三客户端真实原生日志解析与 Claude 主+子流覆盖
  // ==========================================================================
  test('Scenario 1: analyzes real-native Codex, TraeX, and Claude (main + subagent) sessions', async ({ page }) => {
    test.setTimeout(180_000);

    // 1. 分别为 Claude、Codex、TraeX 创建并运行真实受控任务会话
    const claudeSession = await env.createSession('claude', 'TEST_CLAUDE_INSIGHT_TASK');
    const codexSession = await env.createSession('codex', 'TEST_CODEX_INSIGHT_TASK');
    const traexSession = await env.createSession('traex', 'TEST_TRAEX_INSIGHT_TASK');

    expect(claudeSession.nativeAgentId).toBeTruthy();

    // 2. 验证 Claude 会话（主流 + 子流）的 UI 交互与数据呈现
    await page.goto(`${serverInstance.baseUrl}/sessions/${claudeSession.sessionId}`);

    // 点击 RunHeader 上的「会话分析」按钮
    const insightButton = page.getByRole('button', { name: '会话分析' });
    await expect(insightButton).toBeVisible();
    await insightButton.click();

    // 弹出会话分析 Dialog
    const dialog = page.getByRole('dialog', { name: '会话分析' });
    await expect(dialog).toBeVisible();

    // 未分析时显示 EmptyState 主 CTA「分析此会话」，无条件点击
    const analyzeCta = dialog.getByRole('button', { name: '分析此会话' });
    await expect(analyzeCta).toBeVisible();
    await analyzeCta.click();

    // 等待分析完成并展示快照概要
    await expect(dialog.getByText('分析完成')).toBeVisible({ timeout: 60_000 });
    const summarySection = dialog.getByLabel('快照概要');
    await expect(summarySection).toBeVisible();

    // 验证实际模型集合包含真实模型 gemini-3.8-flash
    await expect(summarySection.getByText('gemini-3.8-flash')).toBeVisible();

    // 验证数据覆盖与质量中包含主流与子流
    const coverageSection = dialog.getByLabel('数据覆盖与质量');
    await expect(coverageSection).toBeVisible();
    await expect(coverageSection.getByText(/主来源（Claude）/)).toBeVisible();
    await expect(
      coverageSection.getByText(new RegExp(`子 Agent \\(${claudeSession.nativeAgentId}\\)`))
    ).toBeVisible();

    // 验证来源与加总范围中列明主来源与子 Agent 身份。
    // 主流与子流的客户端名都是 Claude，客户端名取首个；子 Agent 身份用唯一 agentId 精确断言。
    const sourcesSection = dialog.getByLabel('来源与加总范围');
    await expect(sourcesSection).toBeVisible();
    await expect(sourcesSection.getByText('Claude').first()).toBeVisible();
    await expect(sourcesSection.getByText(`子 Agent ${claudeSession.nativeAgentId}`)).toBeVisible();

    // 通过 API 验证服务端快照详情完整记录主子流
    const claudeApiRes = await serverInstance.request('GET', `/api/sessions/${claudeSession.sessionId}/insight`);
    expect(claudeApiRes.status).toBe(200);
    expect(claudeApiRes.json.status.refreshState).toBe('succeeded');
    expect(claudeApiRes.json.summary.sources.length).toBeGreaterThanOrEqual(2);
    const subSource = claudeApiRes.json.summary.sources.find(
      (s: any) => s.streamIdentity.kind === 'subagent'
    );
    expect(subSource).toBeDefined();
    expect(subSource.streamIdentity.nativeAgentId).toBe(claudeSession.nativeAgentId);

    // 3. 验证 Codex 会话（深链与真实模型）
    await page.goto(`${serverInstance.baseUrl}/sessions/${codexSession.sessionId}?panel=insight`);
    const codexDialog = page.getByRole('dialog', { name: '会话分析' });
    await expect(codexDialog).toBeVisible();
    const codexAnalyzeBtn = codexDialog.getByRole('button', { name: '分析此会话' });
    await expect(codexAnalyzeBtn).toBeVisible();
    await codexAnalyzeBtn.click();

    await expect(codexDialog.getByText('分析完成')).toBeVisible({ timeout: 60_000 });
    await expect(codexDialog.getByLabel('快照概要').getByText('gpt-6-astra')).toBeVisible();

    // 4. 验证 TraeX 会话（深链与真实模型）
    await page.goto(`${serverInstance.baseUrl}/sessions/${traexSession.sessionId}?panel=insight`);
    const traexDialog = page.getByRole('dialog', { name: '会话分析' });
    await expect(traexDialog).toBeVisible();
    const traexAnalyzeBtn = traexDialog.getByRole('button', { name: '分析此会话' });
    await expect(traexAnalyzeBtn).toBeVisible();
    await traexAnalyzeBtn.click();

    await expect(traexDialog.getByText('分析完成')).toBeVisible({ timeout: 60_000 });
    await expect(traexDialog.getByLabel('快照概要').getByText('GPT-6-Astra')).toBeVisible();
  });

  // ==========================================================================
  // 场景 2: 证据定位必须命中真实 eventId/sourceKey（失败调用 + 高 Token）
  // ==========================================================================
  test('Scenario 2: locates the exact failure and high-token evidence events by real eventId and sourceKey', async ({ page }) => {
    test.setTimeout(120_000);

    // Codex 真实日志包含明确的失败命令（exit 1）与多次两万至九万 token 增量
    const session = await env.createSession('codex', 'LOCATE_FAILURE_AND_HIGH_TOKEN_TASK');

    await page.goto(`${serverInstance.baseUrl}/sessions/${session.sessionId}?panel=insight`);
    const dialog = page.getByRole('dialog', { name: '会话分析' });
    await expect(dialog).toBeVisible();

    // 首次触发分析
    const analyzeBtn = dialog.getByRole('button', { name: '分析此会话' });
    await expect(analyzeBtn).toBeVisible();
    await analyzeBtn.click();

    await expect(dialog.getByText('分析完成')).toBeVisible({ timeout: 60_000 });

    // 从 API 取得摘要中固定的关键证据 eventId（真实值，不猜）
    const details = (await serverInstance.request('GET', `/api/sessions/${session.sessionId}/insight`)).json;
    const snapshotId: string = details.summary.snapshotId;
    const failureEventId: string = details.summary.keyEvidenceEventIds.failures[0];
    const highTokenEventId: string = details.summary.keyEvidenceEventIds.highTokenDeltas[0];
    expect(snapshotId).toBeTruthy();
    expect(failureEventId, 'fixture 必须包含至少一个真实失败调用证据').toBeTruthy();
    expect(highTokenEventId, 'fixture 必须包含至少一个真实高 Token 证据').toBeTruthy();

    // 通过真实 events API 翻页核验两个 eventId 确实属于该固定快照，并取出 sourceKey
    const failureEvent = await fetchEventById(session.sessionId, snapshotId, failureEventId);
    expect(failureEvent, '失败证据 eventId 必须能在 events API 中找到').not.toBeNull();
    expect(failureEvent!.sourceKey).toBeTruthy();
    expect(failureEvent!.resultStatus).toBe('failure');

    const highTokenEvent = await fetchEventById(session.sessionId, snapshotId, highTokenEventId);
    expect(highTokenEvent, '高 Token 证据 eventId 必须能在 events API 中找到').not.toBeNull();
    expect(highTokenEvent!.sourceKey).toBeTruthy();
    expect(highTokenEvent!.tokens).not.toBeNull();

    const evidenceSection = dialog.getByLabel('关键证据定位');
    const timeline = dialog.getByLabel('源时间线与事件');
    await expect(evidenceSection).toBeVisible();
    await expect(timeline).toBeVisible();

    // 1. 无条件点击失败调用证据按钮，断言高亮的正是 API 核验过的那条事件
    const failureButton = evidenceSection.getByRole('button', { name: /失败调用/ }).first();
    await expect(failureButton).toBeVisible();
    await failureButton.click();

    const highlightedFailureRow = timeline.locator('li.bg-action-soft');
    // 证据可能不在事件首页，组件会自动逐页后翻，给足定位时间。
    await expect(highlightedFailureRow).toBeVisible({ timeout: 30_000 });
    // 展开区精确包含该事件的完整 eventId 与 sourceKey（真实长 ID，非标签文字）
    await expect(highlightedFailureRow.getByText('失败', { exact: true })).toBeVisible();
    await expect(highlightedFailureRow).toContainText(failureEventId);
    await expect(highlightedFailureRow).toContainText(failureEvent!.sourceKey);

    // 2. 无条件点击高 Token 证据按钮，断言高亮事件携带真实 Token 样本且 id/sourceKey 精确匹配
    const highTokenButton = evidenceSection.getByRole('button', { name: /高 Token/ }).first();
    await expect(highTokenButton).toBeVisible();
    await highTokenButton.click();

    const highlightedTokenRow = timeline.locator('li.bg-action-soft');
    await expect(highlightedTokenRow).toBeVisible({ timeout: 30_000 });
    await expect(highlightedTokenRow).toContainText(highTokenEventId);
    await expect(highlightedTokenRow).toContainText(highTokenEvent!.sourceKey);
    // Token 样本至少展示一个真实数值桶
    const tokenRowText = (await highlightedTokenRow.textContent()) ?? '';
    expect(tokenRowText).toMatch(/未缓存输入 \d+|缓存读 \d+|缓存写 \d+|输出 \d+|合计 \d+/);
  });

  // ==========================================================================
  // 场景 3: 完整冷热总览分母一致性（会话目录 count 与精确等式断言）
  // ==========================================================================
  test('Scenario 3: session overview preserves denominator across cold and warm cache', async ({ page }) => {
    test.setTimeout(90_000);

    // 显式创建一个全新的未分析会话，确保候选会话中同时存在已分析和未分析状态
    const unanalyzedRes = await serverInstance.request('POST', '/api/sessions', {
      cwd: serverInstance.sourceRepo,
      agentId: 'codex'
    });
    expect(unanalyzedRes.status).toBe(200);

    // 从会话目录读取全部真实会话数
    const allSessions = (await serverInstance.request('GET', '/api/sessions')).json;
    const totalCandidateCount = Array.isArray(allSessions) ? allSessions.length : 0;
    expect(totalCandidateCount).toBeGreaterThanOrEqual(2);

    // 1. Cold 缓存：通过真实 API 校验分母恒等式
    const initialSummaryRes = await serverInstance.request('GET', '/api/insights/summary');
    expect(initialSummaryRes.status).toBe(200);
    const initialSummary = initialSummaryRes.json;

    expect(initialSummary.candidateSessions).toBe(totalCandidateCount);
    expect(initialSummary.withSnapshot).toBeGreaterThanOrEqual(1);
    expect(initialSummary.withoutSnapshot).toBeGreaterThanOrEqual(1);
    // 核心等式：已有快照 + 未分析 严格等于候选总数
    expect(initialSummary.withSnapshot + initialSummary.withoutSnapshot).toBe(initialSummary.candidateSessions);

    // 打开用量与成本页面下的会话分析 tab: ?panel=usage&view=insight
    await page.goto(`${serverInstance.baseUrl}/?panel=usage&view=insight`);

    const overviewSection = page.getByLabel('候选会话覆盖');
    await expect(overviewSection).toBeVisible();

    // 精确比对页面实际展示的数字，拒绝仅断言说明文字
    await expect(
      overviewSection.getByText(new RegExp(`候选会话 ${initialSummary.candidateSessions} 个`))
    ).toBeVisible();
    await expect(overviewSection.getByText(`已有快照 ${initialSummary.withSnapshot}`)).toBeVisible();
    await expect(overviewSection.getByText(`未分析 ${initialSummary.withoutSnapshot}`)).toBeVisible();
    await expect(
      overviewSection.getByText(`已有快照 + 未分析 = ${initialSummary.candidateSessions}，与候选总数一致。`)
    ).toBeVisible();

    // 2. Warm 缓存（热缓存）：刷新页面验证分母完全不变
    await page.reload();
    const overviewWarm = page.getByLabel('候选会话覆盖');
    await expect(overviewWarm).toBeVisible();

    const warmSummaryRes = await serverInstance.request('GET', '/api/insights/summary');
    expect(warmSummaryRes.status).toBe(200);
    const warmSummary = warmSummaryRes.json;

    expect(warmSummary.candidateSessions).toBe(initialSummary.candidateSessions);
    expect(warmSummary.withSnapshot).toBe(initialSummary.withSnapshot);
    expect(warmSummary.withoutSnapshot).toBe(initialSummary.withoutSnapshot);
    expect(warmSummary.withSnapshot + warmSummary.withoutSnapshot).toBe(warmSummary.candidateSessions);

    await expect(
      overviewWarm.getByText(new RegExp(`候选会话 ${warmSummary.candidateSessions} 个`))
    ).toBeVisible();
    await expect(overviewWarm.getByText(`已有快照 ${warmSummary.withSnapshot}`)).toBeVisible();
    await expect(overviewWarm.getByText(`未分析 ${warmSummary.withoutSnapshot}`)).toBeVisible();
  });

  // ==========================================================================
  // 场景 4: 固定两 snapshot 对比——真实数值/zero-baseline/不可比，
  //         且左侧日志真实增长并产生新快照后，已打开的对比仍锁定旧快照
  // ==========================================================================
  test('Scenario 4: fixed compare shows real metric values and zero-baseline delta, and stays pinned after a real new snapshot', async ({ page }) => {
    test.setTimeout(180_000);

    // Claude（主+子流均无工具失败）在左，Codex（一次 exit 1 失败）在右
    const sessionLeft = await env.createSession('claude', 'COMPARE_LEFT_SESSION');
    const sessionRight = await env.createSession('codex', 'COMPARE_RIGHT_SESSION');

    expect(await refreshAndWaitTerminal(sessionLeft.sessionId)).toBe('succeeded');
    expect(await refreshAndWaitTerminal(sessionRight.sessionId)).toBe('succeeded');

    // 记录两侧固定的 snapshotId
    const leftDetails = (await serverInstance.request('GET', `/api/sessions/${sessionLeft.sessionId}/insight`)).json;
    const rightDetails = (await serverInstance.request('GET', `/api/sessions/${sessionRight.sessionId}/insight`)).json;
    const leftSnapshotId: string = leftDetails.summary.snapshotId;
    const rightSnapshotId: string = rightDetails.summary.snapshotId;
    expect(leftSnapshotId).toBeTruthy();
    expect(rightSnapshotId).toBeTruthy();
    expect(leftSnapshotId).not.toBe(rightSnapshotId);

    // 通过对比 API 校验同口径对比响应与真实指标
    const compareApiRes = await serverInstance.request('POST', '/api/insights/compare', {
      left: { sessionId: sessionLeft.sessionId, snapshotId: leftSnapshotId },
      right: { sessionId: sessionRight.sessionId, snapshotId: rightSnapshotId }
    });
    expect(compareApiRes.status).toBe(200);
    const compareData = compareApiRes.json;
    expect(compareData.left.snapshotId).toBe(leftSnapshotId);
    expect(compareData.right.snapshotId).toBe(rightSnapshotId);

    // 真实 fixture 事实：Claude toolFailures=0，Codex toolFailures=1 → 基线为零、绝对差 +1
    const toolFailuresDiff: MetricComparison = compareData.metricDiffs.toolFailures;
    expect(compareData.left.aggregateMetrics.toolFailures.value).toBe(0);
    expect(compareData.right.aggregateMetrics.toolFailures.value).toBe(1);
    expect(toolFailuresDiff.comparable).toBe(true);
    expect(toolFailuresDiff.isBaselineZero).toBe(true);
    expect(toolFailuresDiff.leftValue).toBe(0);
    expect(toolFailuresDiff.rightValue).toBe(1);
    expect(toolFailuresDiff.delta).toBe(1);
    expect(toolFailuresDiff.percentChange).toBeNull();

    // 独立核验一个真实 null/不可比指标——且必须是 UI 差异表实际渲染的指标行。
    // comparableMetricKeys 与 SessionInsightCompare.tsx 中渲染的行集合保持一致。
    const comparableMetricKeys = [
      'elapsedDurationMs', 'activeDurationMs', 'pairedToolDurationMs', 'idleDurationMs',
      'userTurns', 'assistantTurns', 'toolCalls', 'toolFailures', 'toolFailureRate',
      'inputUncached', 'cacheRead', 'cacheWrite', 'output', 'reasoningOutput',
      'totalTracked', 'peakContext', 'compactionCount', 'subagentCount'
    ];
    const incomparableEntry = Object.entries(compareData.metricDiffs).find(
      ([key, diff]) =>
        comparableMetricKeys.includes(key) &&
        key !== 'toolFailures' &&
        !(diff as MetricComparison).comparable
    ) as [string, MetricComparison] | undefined;
    expect(incomparableEntry, '真实 Claude/Codex 快照对比必须在差异表中至少有一项不可比指标').toBeDefined();
    const [incomparableKey, incomparableDiff] = incomparableEntry!;
    expect(incomparableDiff.comparable).toBe(false);
    expect(incomparableDiff.reasonCodes.length).toBeGreaterThan(0);

    // 通过深链打开对比: /sessions/<left>?panel=insight&compare=<right>
    await page.goto(`${serverInstance.baseUrl}/sessions/${sessionLeft.sessionId}?panel=insight&compare=${sessionRight.sessionId}`);
    const dialog = page.getByRole('dialog', { name: '会话分析' });
    await expect(dialog).toBeVisible();

    const compareSection = dialog.getByLabel('两会话对比');
    await expect(compareSection).toBeVisible();

    // 检查展示两侧会话与固定快照 ID
    await expect(compareSection.getByText(`左侧：会话 ${sessionLeft.sessionId}`)).toBeVisible();
    await expect(compareSection.getByText(`右侧：会话 ${sessionRight.sessionId}`)).toBeVisible();
    await expect(compareSection.getByText(`快照 ${leftSnapshotId}`).first()).toBeVisible();
    await expect(compareSection.getByText(`快照 ${rightSnapshotId}`).first()).toBeVisible();

    // 在差异表中精确定位「工具失败」行：0 / 1 / 基线为零，绝对差 +1
    const metricDiffs = compareSection.getByLabel('指标差异');
    await expect(metricDiffs).toBeVisible();
    const toolFailuresRow = metricDiffs
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: '工具失败', exact: true }) });
    await expect(toolFailuresRow).toBeVisible();
    const failureCells = toolFailuresRow.getByRole('cell');
    await expect(failureCells.nth(1)).toHaveText('0');
    await expect(failureCells.nth(2)).toHaveText('1');
    const deltaCell = failureCells.nth(3);
    await expect(deltaCell).toHaveText('基线为零，绝对差 +1');
    await expect(deltaCell).toHaveAttribute('title', '左侧基线为 0，不显示无穷大或百分比改善。');

    // 在差异表中精确定位真实不可比指标行：差值单元格固定为「不可比」，title 给出原因
    const incomparableUiLabel = incomparableKey; // 下表用 data-label 反查
    const metricLabelByKey: Record<string, string> = {
      elapsedDurationMs: '总时长（源时间）',
      activeDurationMs: '活动时长',
      pairedToolDurationMs: '已配对工具耗时',
      idleDurationMs: '观测空档（>5 分钟间隔）',
      userTurns: '用户轮次',
      assistantTurns: '模型轮次',
      toolCalls: '工具调用总数',
      toolFailures: '工具失败',
      toolFailureRate: '工具失败率',
      inputUncached: '未缓存输入 token',
      cacheRead: '缓存读取 token',
      cacheWrite: '缓存写入 token',
      output: '输出 token',
      reasoningOutput: '推理输出 token（输出子集）',
      totalTracked: '可追踪 token 合计',
      peakContext: '上下文峰值 token',
      compactionCount: '上下文压缩次数',
      subagentCount: '子 Agent 数'
    };
    const incomparableRow = metricDiffs
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: metricLabelByKey[incomparableUiLabel] ?? incomparableUiLabel, exact: true }) });
    await expect(incomparableRow).toBeVisible();
    await expect(incomparableRow.getByRole('cell').nth(3)).toHaveText('不可比');
    await expect(incomparableRow.getByRole('cell').nth(3)).toHaveAttribute('title', incomparableDiff.reasonCodes.join('、'));

    // === 真实变更防漂移：向左侧主流追加一条合法、同 native ID 的新 assistant 记录 ===
    const lastMainLine = readFileSync(sessionLeft.mainPath, 'utf8').trim().split('\n').pop()!;
    const lastMainEntry = JSON.parse(lastMainLine);
    const syntheticEntry = {
      parentUuid: lastMainEntry.uuid,
      isSidechain: false,
      message: {
        content: [{ text: 'T7B_SYNTHETIC_APPEND_MARKER', type: 'text' as const }],
        id: `msg_t7b_${randomUUID().replace(/-/g, '')}`,
        model: 'gemini-3.8-flash',
        role: 'assistant',
        stop_reason: 'end_turn',
        stop_sequence: null,
        type: 'message',
        usage: {
          input_tokens: 5123,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 456,
          output_tokens_details: { thinking_tokens: 0 },
          server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
          service_tier: 'standard',
          cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }
        }
      },
      stop_details: null,
      apiBlockIndex: 0,
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      effort: 'max',
      perTurnEffort: null,
      userType: 'external',
      entrypoint: 'sdk-cli',
      cwd: lastMainEntry.cwd,
      sessionId: sessionLeft.nativeSessionId,
      version: '2.1.288',
      gitBranch: lastMainEntry.gitBranch ?? 'feat/insight-fixtures-20261003'
    };
    appendFileSync(sessionLeft.mainPath, JSON.stringify(syntheticEntry) + '\n', 'utf8');

    // 在已打开的面板上点击「重新分析」（让 React 真正经历刷新与详情失效）
    await dialog.getByRole('button', { name: '重新分析' }).click();
    await expect(dialog.getByText('分析完成')).toBeVisible({ timeout: 90_000 });

    // 服务端必须因日志内容真实增长而发布一个不同的新快照（不是 cache hit）
    await expect.poll(async () => {
      const res = await serverInstance.request('GET', `/api/sessions/${sessionLeft.sessionId}/insight`);
      return res.json?.status?.currentSnapshotId;
    }, { timeout: 30_000 }).not.toBe(leftSnapshotId);

    const newLeftDetails = (await serverInstance.request('GET', `/api/sessions/${sessionLeft.sessionId}/insight`)).json;
    const newLeftSnapshotId: string = newLeftDetails.status.currentSnapshotId;
    expect(newLeftSnapshotId).toBeTruthy();
    expect(newLeftSnapshotId).not.toBe(leftSnapshotId);

    // 对比视图在用户未重新选择前必须继续锁定打开时的两个固定快照
    await expect(compareSection.getByText(`快照 ${leftSnapshotId}`).first()).toBeVisible();
    await expect(compareSection.getByText(`快照 ${rightSnapshotId}`).first()).toBeVisible();
    await expect(compareSection.getByText(`快照 ${newLeftSnapshotId}`)).toHaveCount(0);
  });

  // ==========================================================================
  // 场景 5: Markdown / HTML 报告与固定快照、具体指标值逐项一致
  //          （MD 解转义后精确比对，HTML 用 DOM 读文本）
  // ==========================================================================
  test('Scenario 5: Markdown and HTML reports carry the exact pinned IDs and the same concrete metric values as the snapshot', async ({ page, context }) => {
    test.setTimeout(120_000);

    const session = await env.createSession('claude', 'TEST_REPORT_EXPORT_TASK');
    expect(await refreshAndWaitTerminal(session.sessionId)).toBe('succeeded');

    const details = (await serverInstance.request('GET', `/api/sessions/${session.sessionId}/insight`)).json;
    const currentSnapshotId: string = details.summary.snapshotId;
    const metrics: Record<string, Metric> = details.summary.aggregateMetrics;
    const models: string[] = details.summary.models;
    expect(currentSnapshotId).toBeTruthy();
    expect(models.length).toBeGreaterThan(0);

    // 选取必须逐值核验的指标：toolFailures（真实 0）、一个真实非零整数指标、
    // 以及一个真实 null（未知）指标。全部动态取自快照 API 的实际值，不写死。
    expect(metrics.toolFailures.value).toBe(0);
    const nonzeroKey = INTEGER_METRIC_KEYS.find(
      key => typeof metrics[key]?.value === 'number' && (metrics[key]!.value as number) > 0
    );
    expect(nonzeroKey, 'Claude 快照必须至少有一个非零整数指标').toBeTruthy();
    const nullKey = Object.keys(metrics).find(key => metrics[key]?.value === null);
    expect(nullKey, 'Claude 快照必须至少有一个 null/未知指标').toBeTruthy();

    const expectedCells: Array<{ key: string; label: string; expected: string }> = [
      { key: 'toolFailures', label: EXPORT_METRIC_LABELS.toolFailures, expected: formatExportInteger(0) },
      { key: nonzeroKey!, label: EXPORT_METRIC_LABELS[nonzeroKey!]!, expected: formatExportInteger(metrics[nonzeroKey!]!.value as number) },
      { key: nullKey!, label: EXPORT_METRIC_LABELS[nullKey!]!, expected: '未知' }
    ];

    await page.goto(`${serverInstance.baseUrl}/sessions/${session.sessionId}?panel=insight`);
    const dialog = page.getByRole('dialog', { name: '会话分析' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('分析完成')).toBeVisible();

    // 1. 触发 Markdown 导出下载，无条件校验非空路径
    const [downloadMd] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('button', { name: '导出 Markdown' }).click()
    ]);
    const mdFilename = downloadMd.suggestedFilename();
    expect(mdFilename).toMatch(/^session-insight-.*\.md$/);
    const mdPath = await downloadMd.path();
    expect(mdPath).toBeTruthy();
    const mdContent = readFileSync(mdPath!, 'utf8');

    // Markdown 标准转义会把 snapshotId/sessionId 中的下划线渲染为 \_；
    // 原始文本必须是转义形态，解转义后必须精确还原为真实 ID。
    const escapeMarkdown = (value: string) => value.replace(/[\\`|()[\]<>*_]/g, ch => `\\${ch}`);
    expect(mdContent).toContain(`快照 ${escapeMarkdown(currentSnapshotId)}`);
    expect(unescapeMarkdown(mdContent)).toContain(currentSnapshotId);
    expect(unescapeMarkdown(mdContent)).toContain(session.sessionId);
    expect(mdContent).toContain(models[0]);

    // 逐指标核验 Markdown「核心指标」表中的真实值（非零指标与未知指标分别验证）
    for (const { label, expected } of expectedCells) {
      const cell = findMdMetricCell(mdContent, label);
      expect(cell, `Markdown 报告必须包含指标行：${label}`).not.toBeNull();
      expect(cell!.startsWith(expected), `Markdown 指标 ${label} 应为 ${expected}，实际 ${cell}`).toBe(true);
    }

    // 2. 触发 HTML 导出下载，无条件校验非空路径
    const [downloadHtml] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('button', { name: '导出 HTML' }).click()
    ]);
    const htmlFilename = downloadHtml.suggestedFilename();
    expect(htmlFilename).toMatch(/^session-insight-.*\.html$/);
    const htmlPath = await downloadHtml.path();
    expect(htmlPath).toBeTruthy();
    const htmlContent = readFileSync(htmlPath!, 'utf8');

    // HTML 必须自包含，绝不外链外部脚本
    expect(htmlContent).not.toMatch(/<script\b/i);

    // 用真实 DOM 读取 HTML 文本，精确核验快照 ID、会话 ID、模型与逐指标值
    const reportPage = await context.newPage();
    try {
      await reportPage.setContent(htmlContent);

      const heading = reportPage.getByRole('heading', { level: 2 }).filter({ hasText: '会话快照' });
      await expect(heading).toContainText(currentSnapshotId);

      // 会话信息表中精确展示 sessionId
      const infoRow = reportPage.getByRole('row').filter({ has: reportPage.getByRole('cell', { name: '会话', exact: true }) });
      await expect(infoRow.getByRole('cell').nth(1)).toHaveText(session.sessionId);
      await expect(reportPage.getByText(models[0]!).first()).toBeVisible();

      // 核心指标表逐行核验与 API 快照一致的具体数值
      for (const { label, expected } of expectedCells) {
        const row = reportPage.getByRole('row').filter({ has: reportPage.getByRole('cell', { name: label, exact: true }) });
        await expect(row).toBeVisible();
        const valueCell = row.getByRole('cell').nth(1);
        const cellText = (await valueCell.textContent()) ?? '';
        expect(cellText.startsWith(expected), `HTML 指标 ${label} 应为 ${expected}，实际 ${cellText}`).toBe(true);
      }
    } finally {
      await reportPage.close();
    }
  });
});
