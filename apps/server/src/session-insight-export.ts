import {
  SESSION_INSIGHT_LIMITS,
  type FileMetrics,
  type HostEvidenceSnapshot,
  type Metric,
  type SessionInsightCompareResponse,
  type SessionInsightEventItem,
  type SessionInsightSnapshotRecord
} from '@dutydeck/shared';

import {
  assertFrozenSnapshotConsistent,
  compareSessionSnapshots,
  FILE_METRIC_KEYS as ALL_METRIC_KEYS,
  SessionInsightReportError
} from './session-insight-compare.js';

// ============================================================================
// 对外签名（T4c 在同一 read txn 内冻结 snapshot 与关键 events 后调用）
// ============================================================================

export interface SessionInsightExportSideInput {
  snapshot: SessionInsightSnapshotRecord;
  /** 调用方按 snapshot.summary.keyEvidenceEventIds 在同一事务冻结的有限关键事件 */
  events: readonly SessionInsightEventItem[];
}

export type SessionInsightExportInput =
  | ({ kind: 'session'; format: 'markdown' | 'html' } & SessionInsightExportSideInput)
  | {
      kind: 'comparison';
      format: 'markdown' | 'html';
      left: SessionInsightExportSideInput;
      right: SessionInsightExportSideInput;
    };

export interface SessionInsightReport {
  content: string;
  contentType: 'text/markdown; charset=utf-8' | 'text/html; charset=utf-8';
  /** 只含安全 ID 与快照固定日期，不含路径、空格或用户任意输入 */
  filename: string;
}

const REPORT_LIMIT_MESSAGE = 'Report output exceeds the fixed size limit';
const EVIDENCE_MISMATCH_MESSAGE = 'Evidence event does not belong to the frozen snapshot';

// ============================================================================
// 共享格式化（MD / HTML 与单/双快照复用；只展示快照内已有证据，不重算）
// ============================================================================

const DURATION_KEYS = new Set<keyof FileMetrics>([
  'elapsedDurationMs',
  'activeDurationMs',
  'idleDurationMs',
  'pairedToolDurationMs'
]);

export const METRIC_LABELS: Record<keyof FileMetrics, string> = {
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

const STATUS_LABELS: Record<string, string> = {
  available: '',
  partial: '部分',
  conflict: '冲突',
  unavailable: '不可用'
};

const QUALITY_LABELS: Record<string, string> = {
  exact: '',
  derived: '推导',
  estimated: '估计',
  inferred: '推断',
  observed: '观察',
  heuristic: '启发',
  unknown: '未知',
  unavailable: '不可用'
};

const COMPARE_REASON_LABELS: Record<string, string> = {
  METRIC_VERSION_MISMATCH: '指标版本不一致',
  SCOPE_VERSION_MISMATCH: '范围口径不一致',
  MISSING_METRIC_SIDE: '一侧缺指标',
  NULL_METRIC_VALUE: '数值未知',
  BASELINE_ZERO: '基线为零'
};

function compareReasonText(code: string): string {
  if (code === 'LEFT_CONFLICT' || code === 'RIGHT_CONFLICT') {
    return `${code === 'LEFT_CONFLICT' ? '左' : '右'}侧数值冲突`;
  }
  if (code === 'LEFT_PARTIAL' || code === 'RIGHT_PARTIAL') {
    return `${code === 'LEFT_PARTIAL' ? '左' : '右'}侧部分数据`;
  }
  if (code === 'LEFT_UNAVAILABLE' || code === 'RIGHT_UNAVAILABLE') {
    return `${code === 'LEFT_UNAVAILABLE' ? '左' : '右'}侧不可用`;
  }
  return COMPARE_REASON_LABELS[code] ?? code;
}

function formatInteger(value: number): string {
  return value.toLocaleString('en-US');
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)} 分钟`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)} 秒`;
  return `${Math.round(ms)} ms`;
}

/** 指标原始值的纯展示格式化，不做任何重新计算或单位换算以外的推断。 */
function formatMetricValue(key: keyof FileMetrics, metric: Metric): string {
  if (metric.value === null) return '未知';
  if (key === 'toolFailureRate') return `${(metric.value * 100).toFixed(1)}%`;
  if (DURATION_KEYS.has(key)) return formatDuration(metric.value);
  return formatInteger(metric.value);
}

function metricAnnotations(metric: Metric): string[] {
  const notes: string[] = [];
  const status = STATUS_LABELS[metric.status];
  if (status) notes.push(status);
  const quality = QUALITY_LABELS[metric.quality];
  if (quality) notes.push(quality);
  return notes;
}

function formatMetricCell(key: keyof FileMetrics, metric: Metric): string {
  const base = formatMetricValue(key, metric);
  const notes = metricAnnotations(metric);
  return notes.length > 0 ? `${base}（${notes.join('，')}）` : base;
}

function formatSigned(value: number, asPercent = false): string {
  const sign = value > 0 ? '+' : '';
  if (asPercent) return `${sign}${value.toFixed(1)}%`;
  return `${sign}${formatInteger(value)}`;
}

function formatDeltaValue(key: keyof FileMetrics, value: number): string {
  if (key === 'toolFailureRate') return formatSigned(value * 100, true);
  if (DURATION_KEYS.has(key)) {
    return `${value < 0 ? '-' : '+'}${formatDuration(Math.abs(value))}`;
  }
  return formatSigned(value);
}

function textOrUnknown(value: string | null | undefined): string {
  const normalized = normalizeInline(value);
  return normalized === '' ? '未知' : normalized;
}

/** 所有动态字段进入渲染前的统一归一化：折叠换行/制表符，去掉 C0 控制字符。 */
function normalizeInline(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function fixedDate(iso: string): string {
  return iso.slice(0, 10);
}

// ============================================================================
// HTML / Markdown 转义
// ============================================================================

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

/** 完整 HTML 转义；渲染器不产出任何动态 href/src/style，故无需 URL 白名单。 */
function escapeHtml(value: string | null | undefined): string {
  return normalizeInline(value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]!);
}

// 动态内容只出现在表格单元格或固定前缀之后；渲染前换行已被折叠为空格，
// 因此无法形成行首标题/引用/列表，也无法跨行伪造表格。只需转义：反斜杠、
// 反引号、管道符、链接括号与尖括号（防原始 HTML / autolink）、强调符。
const MD_ESCAPE_RE = /[\\`|()[\]<>*_]/g;

/**
 * Markdown 转义：转义单元格与行内上下文中真正的结构字符。
 * 换行已折叠，javascript:/data: 无法获得活动链接语法，且不内嵌任何原始 HTML。
 */
function escapeMarkdown(value: string | null | undefined): string {
  return normalizeInline(value).replace(MD_ESCAPE_RE, ch => `\\${ch}`);
}

// ============================================================================
// 关键证据选择（每快照最多 100 条；失败 → 慢调用 → 高 Token，确定顺序、去重、省略可见）
// ============================================================================

type EvidenceCategory = 'failure' | 'slow' | 'highToken' | 'other';

const EVIDENCE_CATEGORY_LABELS: Record<EvidenceCategory, string> = {
  failure: '失败',
  slow: '慢调用',
  highToken: '高 Token',
  other: '其他关键事件'
};

interface EvidenceRow {
  category: EvidenceCategory;
  eventId: string;
  ordinal: number;
  time: string | null;
  tool: string;
  kindLabel: string;
  statusLabel: string;
  duration: string;
  tokensTotal: string;
  inputOutput: string;
  excerpt: string;
}

interface EvidenceSelection {
  rows: EvidenceRow[];
  referencedUnique: number;
  referencedIncluded: number;
  referencedMissing: number;
  cappedOmitted: number;
  extraIncluded: number;
  extraOmitted: number;
}

const TRACE_KIND_LABELS: Partial<Record<SessionInsightEventItem['kind'], string>> = {
  tool_call: '工具调用',
  tool_result: '工具结果',
  tool_summary: '工具摘要',
  user_message: '用户消息',
  agent_message: '助手消息',
  reasoning: '推理',
  token_sample: 'Token 样本',
  context_compacted: '上下文压缩',
  subagent_start: '子 Agent 开始',
  subagent_stop: '子 Agent 结束',
  system: '系统'
};

function buildEvidenceRow(event: SessionInsightEventItem, category: EvidenceCategory): EvidenceRow {
  const status =
    event.resultStatus === null || event.resultStatus === undefined
      ? '未知'
      : event.resultStatus === 'success'
        ? '成功'
        : event.resultStatus === 'failure'
          ? '失败'
          : '未知';
  const duration =
    event.durationMs && event.durationMs.value !== null
      ? formatDuration(event.durationMs.value)
      : '未知';
  const tokens = event.tokens ?? null;
  const tokensTotal = tokens?.total === null || tokens?.total === undefined ? '未知' : formatInteger(tokens.total);
  const input = tokens?.inputUncached ?? null;
  const output = tokens?.output ?? null;
  const inputOutput =
    input === null && output === null
      ? '未知'
      : `入 ${input === null ? '未知' : formatInteger(input)} / 出 ${output === null ? '未知' : formatInteger(output)}`;
  const excerpt = normalizeInline(event.errorExcerpt) || normalizeInline(event.outputExcerpt) || normalizeInline(event.inputExcerpt);
  return {
    category,
    eventId: event.eventId,
    ordinal: event.ordinal,
    time: event.timestamp,
    tool: normalizeInline(event.toolName) || '—',
    kindLabel: TRACE_KIND_LABELS[event.kind] ?? event.kind,
    statusLabel: status,
    duration,
    tokensTotal,
    inputOutput,
    excerpt
  };
}

function selectEvidence(
  snapshot: SessionInsightSnapshotRecord,
  events: readonly SessionInsightEventItem[]
): EvidenceSelection {
  for (const event of events) {
    if (event.snapshotId !== snapshot.snapshotId) {
      throw new SessionInsightReportError('INSIGHT_INPUT_LIMIT', EVIDENCE_MISMATCH_MESSAGE);
    }
  }
  const byId = new Map<string, SessionInsightEventItem>();
  for (const event of events) byId.set(event.eventId, event);

  const keyIds = snapshot.summary.keyEvidenceEventIds;
  const ordered: { id: string; category: EvidenceCategory }[] = [];
  const seen = new Set<string>();
  const add = (id: string, category: EvidenceCategory): void => {
    if (seen.has(id)) return;
    seen.add(id);
    ordered.push({ id, category });
  };
  keyIds.failures.forEach(id => add(id, 'failure'));
  keyIds.slowCalls.forEach(id => add(id, 'slow'));
  keyIds.highTokenDeltas.forEach(id => add(id, 'highToken'));

  const limit = SESSION_INSIGHT_LIMITS.maxReportEvidenceCount;
  const rows: EvidenceRow[] = [];
  let referencedIncluded = 0;
  let referencedMissing = 0;
  let cappedOmitted = 0;

  for (const entry of ordered) {
    const event = byId.get(entry.id);
    if (!event) {
      referencedMissing += 1;
      continue;
    }
    if (rows.length >= limit) {
      cappedOmitted += 1;
      continue;
    }
    rows.push(buildEvidenceRow(event, entry.category));
    referencedIncluded += 1;
  }

  const referencedIds = seen;
  const extraIds = new Set<string>();
  const extras = events
    .filter(event => {
      if (referencedIds.has(event.eventId) || extraIds.has(event.eventId)) return false;
      extraIds.add(event.eventId);
      return true;
    })
    .sort((a, b) => (a.ordinal !== b.ordinal ? a.ordinal - b.ordinal : a.eventId.localeCompare(b.eventId)));
  let extraIncluded = 0;
  let extraOmitted = 0;
  for (const event of extras) {
    if (rows.length >= limit) {
      extraOmitted += 1;
      continue;
    }
    rows.push(buildEvidenceRow(event, 'other'));
    extraIncluded += 1;
  }

  return {
    rows,
    referencedUnique: ordered.length,
    referencedIncluded,
    referencedMissing,
    cappedOmitted,
    extraIncluded,
    extraOmitted
  };
}

// ============================================================================
// 报告中间模型（两侧共用同一构造，MD/HTML 只负责渲染）
// ============================================================================

interface SideModel {
  snapshot: SessionInsightSnapshotRecord;
  evidence: EvidenceSelection;
}

interface SourceRow {
  sourceKey: string;
  client: string;
  scope: string;
  stream: string;
  models: string;
  lines: string;
  traceRange: string;
  tokenSamples: string;
  subagent: string;
  inherited: string;
  omittedTraces: string;
  aggregation: string;
}

function buildSourceRows(snapshot: SessionInsightSnapshotRecord): SourceRow[] {
  return snapshot.summary.sources.map(source => {
    const coverage = source.coverage;
    const stream =
      source.streamIdentity.kind === 'subagent'
        ? `子 Agent（${source.streamIdentity.nativeAgentId}）`
        : '主流';
    return {
      sourceKey: source.sourceKey,
      client: source.client,
      scope: `${source.scopeRole === 'primary' ? '主来源' : source.scopeRole === 'subagent' ? '子 Agent' : '排除'} / ${source.status === 'ok' ? '完整' : source.status === 'partial' ? '部分' : '错误'}`,
      stream,
      models: source.models.length > 0 ? source.models.join(', ') : '未知',
      lines: `原始 ${coverage.rawLines} / 解析 ${coverage.parsedLines} / 错误 ${coverage.errorLines}`,
      traceRange: `${textOrUnknown(coverage.timeRange.start)} ~ ${textOrUnknown(coverage.timeRange.end)}`,
      tokenSamples: `可用 ${coverage.tokenSamplesAvailable} / 缺 ${coverage.tokenSamplesMissing}`,
      subagent: { none: '无', complete: '完整', partial: '部分', unknown: '未知' }[source.coverage.subagentDiscovery],
      inherited: { none: '无', detected: '检测到', unsupported: '不支持', unknown: '未知' }[source.coverage.inheritedHistory],
      omittedTraces:
        coverage.omittedTraceCount === 0
          ? '无'
          : `${coverage.omittedTraceCount}（${Object.entries(coverage.omittedTraceByCategory)
              .map(([code, count]) => `${code}:${count}`)
              .join('，')}）`,
      aggregation:
        source.aggregation.eligibility === 'eligible'
          ? '计入'
          : `排除（${source.aggregation.reasonCodes.join('，') || '原因未列明'}）`
    };
  });
}

function hostModel(host: HostEvidenceSnapshot) {
  return {
    goals: host.taskGoals.map(goal => ({
      taskId: goal.taskId,
      attempt: goal.attemptId ?? '—',
      goal: normalizeInline(goal.goal),
      status: normalizeInline(goal.status)
    })),
    omittedGoals: host.omittedGoalsCount,
    verifications: host.verificationSnapshot.map(verification => ({
      taskId: verification.taskId,
      passed: verification.passed ? '通过' : '未通过',
      stale: verification.stale ? '已过期' : '当前',
      summary: normalizeInline(verification.summary)
    })),
    omittedVerifications: host.omittedVerificationsCount,
    steeringCount: host.steeringRelations.length,
    steeringCompleted: host.steeringRelations.filter(relation => relation.completed).length,
    omittedSteering: host.omittedSteeringCount,
    modelConfigs: host.modelConfigs.map(config => ({
      taskId: config.taskId,
      configuredModel: config.configuredModel,
      provider: config.provider ?? '未知'
    })),
    omittedModelConfigs: host.omittedModelConfigsCount,
    ledger: host.usageLedgerProjection
      ? {
          range: `${textOrUnknown(host.usageLedgerProjection.recordedAtRange.start)} ~ ${textOrUnknown(host.usageLedgerProjection.recordedAtRange.end)}`,
          cost:
            host.usageLedgerProjection.totalCostEstimate === null ||
            host.usageLedgerProjection.totalCostEstimate === undefined
              ? '未知'
              : `${host.usageLedgerProjection.totalCostEstimate} ${host.usageLedgerProjection.currency ?? ''}`.trim(),
          unpriced: host.usageLedgerProjection.hasUnpricedUsage ? '是' : '否'
        }
      : null
  };
}

function evidenceSummaryText(selection: EvidenceSelection): string {
  const counts: Record<EvidenceCategory, number> = {
    failure: 0,
    slow: 0,
    highToken: 0,
    other: 0
  };
  for (const row of selection.rows) counts[row.category] += 1;
  const parts = [
    `失败 ${counts.failure}`,
    `慢调用 ${counts.slow}`,
    `高 Token ${counts.highToken}`
  ];
  if (counts.other > 0) parts.push(`其他 ${counts.other}`);
  const notes: string[] = [];
  if (selection.referencedMissing > 0) notes.push(`${selection.referencedMissing} 条引用未随快照提供`);
  if (selection.cappedOmitted > 0) notes.push(`${selection.cappedOmitted} 条引用超出 100 条上限`);
  if (selection.extraOmitted > 0) notes.push(`${selection.extraOmitted} 条冻结事件超出上限`);
  return `${selection.rows.length} 条（${parts.join(' / ')}）${notes.length > 0 ? `；省略：${notes.join('，')}` : ''}`;
}

// ============================================================================
// Markdown 渲染
// ============================================================================

type MdCell = string | number | null | undefined;

function mdRow(cells: MdCell[]): string {
  return `| ${cells.map(cell => escapeMarkdown(cell === null || cell === undefined ? '' : String(cell))).join(' | ')} |`;
}

function mdTable(headers: string[], rows: MdCell[][]): string {
  const header = mdRow(headers);
  const divider = `| ${headers.map(() => '---').join(' | ')} |`;
  return [header, divider, ...rows.map(mdRow)].join('\n');
}

function mdMetricsTable(metrics: FileMetrics, keys: readonly (keyof FileMetrics)[]): string {
  return mdTable(
    ['指标', '值'],
    keys.map(key => [METRIC_LABELS[key], formatMetricCell(key, metrics[key] as Metric)])
  );
}

function mdSideSection(indexLabel: string, side: SideModel): string {
  const { snapshot, evidence } = side;
  const summary = snapshot.summary;
  const manifest = snapshot.manifest;
  const host = hostModel(snapshot.hostEvidence);
  const sources = buildSourceRows(snapshot);
  const lines: string[] = [];

  lines.push(`## ${indexLabel}：快照 ${escapeMarkdown(snapshot.snapshotId)}`);
  lines.push('');
  lines.push(
    mdTable(
      ['项', '内容'],
      [
        ['会话', snapshot.sessionId],
        ['快照时间', snapshot.createdAt],
        ['日志时间范围', sources.length > 0 ? sources.map(s => s.traceRange).join('；') : '未知'],
        ['范围版本', summary.scopeVersion],
        ['绑定修订', manifest.bindingRevision],
        ['实际模型', `${summary.models.length > 0 ? summary.models.join(', ') : '未知'}${summary.isMultiModel ? '（多模型）' : ''}`],
        ['质量总览', { recorded: '已记录', derived_or_estimated: '推导或估计', unavailable: '不可用' }[summary.qualityOverview]],
        ['payloadBytes', snapshot.payloadBytes]
      ]
    )
  );
  lines.push('');

  lines.push('### 来源与覆盖');
  lines.push('');
  lines.push(
    mdTable(
      ['来源', '客户端', '范围/状态', '流', '模型', '行数', '日志时间范围', 'Token 样本', '子 Agent 发现', '继承历史', '省略 Trace', '合计口径'],
      sources.map(row => [
        row.sourceKey, row.client, row.scope, row.stream, row.models, row.lines,
        row.traceRange, row.tokenSamples, row.subagent, row.inherited, row.omittedTraces, row.aggregation
      ])
    )
  );
  lines.push('');

  lines.push('### 核心指标');
  lines.push('');
  lines.push(mdMetricsTable(summary.aggregateMetrics, ALL_METRIC_KEYS));
  lines.push('');

  lines.push('### 关键工具、错误与高 Token 证据');
  lines.push('');
  lines.push(`关键证据：${evidenceSummaryText(evidence)}（每快照固定上限 100 条）`);
  lines.push('');
  if (evidence.rows.length > 0) {
    lines.push(
      mdTable(
        ['类别', '事件 ID', '时间', '工具', '事件', '结果', '耗时', 'Token 总量', '入/出', '摘录'],
        evidence.rows.map(row => [
          EVIDENCE_CATEGORY_LABELS[row.category],
          row.eventId,
          textOrUnknown(row.time),
          row.tool,
          row.kindLabel,
          row.statusLabel,
          row.duration,
          row.tokensTotal,
          row.inputOutput,
          row.excerpt
        ])
      )
    );
    lines.push('');
  }

  lines.push('### 任务目标与宿主验证');
  lines.push('');
  if (host.goals.length > 0) {
    lines.push(mdTable(['任务', '尝试', '目标', '状态'], host.goals.map(g => [g.taskId, g.attempt, g.goal, g.status])));
    lines.push('');
  } else {
    lines.push('- 宿主证据未提供任务目标。');
    lines.push('');
  }
  if (host.omittedGoals > 0) lines.push(`- 另有 ${host.omittedGoals} 条任务目标因上限省略。`);
  lines.push(
    `验证记录 ${host.verifications.length} 条（省略 ${host.omittedVerifications} 条），steering ${host.steeringCount} 条（已完成 ${host.steeringCompleted}，省略 ${host.omittedSteering}）。验证状态只取自宿主记录，不从日志关键词推断。`
  );
  lines.push('');
  if (host.verifications.length > 0) {
    lines.push(mdTable(['任务', '结果', '时效', '摘要'], host.verifications.map(v => [v.taskId, v.passed, v.stale, v.summary || '—'])));
    lines.push('');
  }
  if (host.modelConfigs.length > 0) {
    lines.push('任务冻结模型配置：');
    lines.push('');
    lines.push(mdTable(['任务', '配置模型', '服务商'], host.modelConfigs.map(c => [c.taskId, c.configuredModel, c.provider])));
    lines.push('');
  }
  if (host.omittedModelConfigs > 0) lines.push(`- 另有 ${host.omittedModelConfigs} 条模型配置因上限省略。`);
  if (host.ledger) {
    lines.push(
      `费用账本只读投影：记账时间 ${escapeMarkdown(host.ledger.range)}；估算 ${escapeMarkdown(host.ledger.cost)}；含未计价用量：${escapeMarkdown(host.ledger.unpriced)}。报告不重新合计费用。`
    );
    lines.push('');
  }

  lines.push('### 分析版本');
  lines.push('');
  lines.push(
    mdTable(
      ['项', '值'],
      [
        ['schemaVersion', snapshot.versions.schemaVersion],
        ['engineVersion', snapshot.versions.engineVersion],
        ['parserVersion', snapshot.versions.parserVersion],
        ['metricVersion', snapshot.versions.metricVersion],
        ['redactionVersion', snapshot.versions.redactionVersion],
        ['scopeVersion', summary.scopeVersion]
      ]
    )
  );
  lines.push('');

  const trailing = manifest.sources
    .filter(source => (source.trailingBytes ?? 0) > 0)
    .map(source => `${escapeMarkdown(source.sourceKey)}:${source.trailingBytes} B`)
    .join('，');
  lines.push(
    `省略说明：关键证据见上；来源半行尾${trailing ? `（${trailing}）` : '无'}；分析覆盖省略 Trace 见来源表；宿主目标/验证/模型配置省略数见本节。报告不内嵌完整 JSONL、私有路径、环境变量或原始 stderr。`
  );
  lines.push('');
  return lines.join('\n');
}

function renderMarkdownModel(model: ReportModel): string {
  const parts: string[] = [];
  if (model.kind === 'session') {
    parts.push(`# 会话分析报告`);
    parts.push('');
    parts.push(mdSideSection('会话快照', model.side));
  } else {
    parts.push('# 会话分析对比报告');
    parts.push('');
    parts.push(
      mdTable(
        ['项', '左侧', '右侧'],
        [
          ['会话', model.left.snapshot.sessionId, model.right.snapshot.sessionId],
          ['快照', model.left.snapshot.snapshotId, model.right.snapshot.snapshotId],
          ['快照时间', model.left.snapshot.createdAt, model.right.snapshot.createdAt],
          ['metricVersion', model.left.snapshot.versions.metricVersion, model.right.snapshot.versions.metricVersion],
          ['范围版本', model.left.snapshot.summary.scopeVersion, model.right.snapshot.summary.scopeVersion]
        ]
      )
    );
    parts.push('');
    parts.push(
      model.comparison.comparable
        ? '两侧指标版本与范围口径一致，下列差值按同一口径计算。'
        : `两侧不可比：${model.comparison.incomparableReasons.map(compareReasonText).join('，')}；不计算数值差值，不把不同任务的差异归因于模型。`
    );
    parts.push('');
    parts.push('### 指标对比');
    parts.push('');
    parts.push(
      mdTable(
        ['指标', '左侧', '右侧', '差值', '百分比变动', '说明'],
        ALL_METRIC_KEYS.map(key => {
          const diff = model.comparison.metricDiffs[key]!;
          let delta = '—';
          let percent = '—';
          let note = '';
          if (diff.comparable) {
            if (diff.delta !== null) delta = formatDeltaValue(key, diff.delta);
            if (diff.isBaselineZero) {
              percent = '—';
              note = '基线为零';
            } else if (diff.percentChange !== null) {
              percent = formatSigned(diff.percentChange, true);
            }
          } else {
            note = diff.reasonCodes.map(compareReasonText).join('，');
          }
          return [
            METRIC_LABELS[key],
            diff.leftValue === null ? '未知' : key === 'toolFailureRate' ? `${(diff.leftValue * 100).toFixed(1)}%` : DURATION_KEYS.has(key) ? formatDuration(diff.leftValue) : formatInteger(diff.leftValue),
            diff.rightValue === null ? '未知' : key === 'toolFailureRate' ? `${(diff.rightValue * 100).toFixed(1)}%` : DURATION_KEYS.has(key) ? formatDuration(diff.rightValue) : formatInteger(diff.rightValue),
            delta,
            percent,
            note
          ];
        })
      )
    );
    parts.push('');
    parts.push(mdSideSection('左侧', { snapshot: model.left.snapshot, evidence: model.left.evidence }));
    parts.push(mdSideSection('右侧', { snapshot: model.right.snapshot, evidence: model.right.evidence }));
  }
  return parts.join('\n');
}

// ============================================================================
// HTML 渲染（自包含、无脚本、无外部资源；全部动态字段经 escapeHtml）
// ============================================================================

const HTML_STYLE = `
body{font-family:-apple-system,"Segoe UI",sans-serif;margin:24px;color:#1f2328;line-height:1.5}
h1{font-size:20px}h2{font-size:17px;margin-top:28px}h3{font-size:15px;margin-top:20px}
table{border-collapse:collapse;margin:8px 0;font-size:13px}
th,td{border:1px solid #d0d7de;padding:5px 9px;vertical-align:top;text-align:left}
th{background:#f6f8fa}.note{color:#57606a;font-size:13px}.banner{padding:8px 12px;border:1px solid #d0d7de;background:#f6f8fa;margin:10px 0}
`;

function htmlTable(headers: string[], rows: (string | number | null)[][]): string {
  const head = headers.map(header => `<th>${escapeHtml(header)}</th>`).join('');
  const body = rows
    .map(row => `<tr>${row.map(cell => `<td>${escapeHtml(cell === null || cell === undefined ? '' : String(cell))}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function htmlMetricsTable(metrics: FileMetrics, keys: readonly (keyof FileMetrics)[]): string {
  return htmlTable(
    ['指标', '值'],
    keys.map(key => [METRIC_LABELS[key], formatMetricCell(key, metrics[key] as Metric)])
  );
}

function htmlSideSection(indexLabel: string, side: SideModel): string {
  const { snapshot, evidence } = side;
  const summary = snapshot.summary;
  const manifest = snapshot.manifest;
  const host = hostModel(snapshot.hostEvidence);
  const sources = buildSourceRows(snapshot);
  const parts: string[] = [];

  parts.push(`<h2>${escapeHtml(indexLabel)}：快照 ${escapeHtml(snapshot.snapshotId)}</h2>`);
  parts.push(
    htmlTable(['项', '内容'], [
      ['会话', snapshot.sessionId],
      ['快照时间', snapshot.createdAt],
      ['日志时间范围', sources.map(s => s.traceRange).join('；') || '未知'],
      ['范围版本', summary.scopeVersion],
      ['绑定修订', manifest.bindingRevision],
      ['实际模型', `${summary.models.join(', ') || '未知'}${summary.isMultiModel ? '（多模型）' : ''}`],
      ['质量总览', { recorded: '已记录', derived_or_estimated: '推导或估计', unavailable: '不可用' }[summary.qualityOverview]],
      ['payloadBytes', snapshot.payloadBytes]
    ])
  );

  parts.push('<h3>来源与覆盖</h3>');
  parts.push(
    htmlTable(
      ['来源', '客户端', '范围/状态', '流', '模型', '行数', '日志时间范围', 'Token 样本', '子 Agent 发现', '继承历史', '省略 Trace', '合计口径'],
      sources.map(row => [
        row.sourceKey, row.client, row.scope, row.stream, row.models, row.lines,
        row.traceRange, row.tokenSamples, row.subagent, row.inherited, row.omittedTraces, row.aggregation
      ])
    )
  );

  parts.push('<h3>核心指标</h3>');
  parts.push(htmlMetricsTable(summary.aggregateMetrics, ALL_METRIC_KEYS));

  parts.push('<h3>关键工具、错误与高 Token 证据</h3>');
  parts.push(`<p class="note">关键证据：${escapeHtml(evidenceSummaryText(evidence))}（每快照固定上限 100 条）</p>`);
  if (evidence.rows.length > 0) {
    parts.push(
      htmlTable(
        ['类别', '事件 ID', '时间', '工具', '事件', '结果', '耗时', 'Token 总量', '入/出', '摘录'],
        evidence.rows.map(row => [
          EVIDENCE_CATEGORY_LABELS[row.category],
          row.eventId,
          textOrUnknown(row.time),
          row.tool,
          row.kindLabel,
          row.statusLabel,
          row.duration,
          row.tokensTotal,
          row.inputOutput,
          row.excerpt
        ])
      )
    );
  }

  parts.push('<h3>任务目标与宿主验证</h3>');
  if (host.goals.length > 0) {
    parts.push(htmlTable(['任务', '尝试', '目标', '状态'], host.goals.map(g => [g.taskId, g.attempt, g.goal, g.status])));
  } else {
    parts.push('<p class="note">宿主证据未提供任务目标。</p>');
  }
  if (host.omittedGoals > 0) parts.push(`<p class="note">另有 ${host.omittedGoals} 条任务目标因上限省略。</p>`);
  parts.push(
    `<p class="note">验证记录 ${host.verifications.length} 条（省略 ${host.omittedVerifications} 条），steering ${host.steeringCount} 条（已完成 ${host.steeringCompleted}，省略 ${host.omittedSteering}）。验证状态只取自宿主记录，不从日志关键词推断。</p>`
  );
  if (host.verifications.length > 0) {
    parts.push(htmlTable(['任务', '结果', '时效', '摘要'], host.verifications.map(v => [v.taskId, v.passed, v.stale, v.summary || '—'])));
  }
  if (host.modelConfigs.length > 0) {
    parts.push('<p>任务冻结模型配置：</p>');
    parts.push(htmlTable(['任务', '配置模型', '服务商'], host.modelConfigs.map(c => [c.taskId, c.configuredModel, c.provider])));
  }
  if (host.omittedModelConfigs > 0) parts.push(`<p class="note">另有 ${host.omittedModelConfigs} 条模型配置因上限省略。</p>`);
  if (host.ledger) {
    parts.push(
      `<p class="note">费用账本只读投影：记账时间 ${escapeHtml(host.ledger.range)}；估算 ${escapeHtml(host.ledger.cost)}；含未计价用量：${escapeHtml(host.ledger.unpriced)}。报告不重新合计费用。</p>`
    );
  }

  parts.push('<h3>分析版本</h3>');
  parts.push(
    htmlTable(['项', '值'], [
      ['schemaVersion', snapshot.versions.schemaVersion],
      ['engineVersion', snapshot.versions.engineVersion],
      ['parserVersion', snapshot.versions.parserVersion],
      ['metricVersion', snapshot.versions.metricVersion],
      ['redactionVersion', snapshot.versions.redactionVersion],
      ['scopeVersion', summary.scopeVersion]
    ])
  );
  const trailing = manifest.sources
    .filter(source => (source.trailingBytes ?? 0) > 0)
    .map(source => `${escapeHtml(source.sourceKey)}:${source.trailingBytes} B`)
    .join('，');
  parts.push(
    `<p class="note">省略说明：关键证据见上；来源半行尾${trailing ? `（${trailing}）` : '无'}；分析覆盖省略 Trace 见来源表；宿主目标/验证/模型配置省略数见本节。报告不内嵌完整 JSONL、私有路径、环境变量或原始 stderr。</p>`
  );
  return parts.join('\n');
}

function renderHtmlModel(model: ReportModel): string {
  const title = model.kind === 'session' ? '会话分析报告' : '会话分析对比报告';
  const parts: string[] = [];
  parts.push('<!DOCTYPE html>');
  parts.push('<html lang="zh-CN"><head><meta charset="utf-8">');
  parts.push(`<title>${escapeHtml(title)}</title>`);
  parts.push(`<style>${HTML_STYLE}</style>`);
  parts.push('</head><body>');
  parts.push(`<h1>${escapeHtml(title)}</h1>`);

  if (model.kind === 'session') {
    parts.push(htmlSideSection('会话快照', model.side));
  } else {
    parts.push(
      htmlTable(['项', '左侧', '右侧'], [
        ['会话', model.left.snapshot.sessionId, model.right.snapshot.sessionId],
        ['快照', model.left.snapshot.snapshotId, model.right.snapshot.snapshotId],
        ['快照时间', model.left.snapshot.createdAt, model.right.snapshot.createdAt],
        ['metricVersion', model.left.snapshot.versions.metricVersion, model.right.snapshot.versions.metricVersion],
        ['范围版本', model.left.snapshot.summary.scopeVersion, model.right.snapshot.summary.scopeVersion]
      ])
    );
    const banner = model.comparison.comparable
      ? '两侧指标版本与范围口径一致，下列差值按同一口径计算。'
      : `两侧不可比：${model.comparison.incomparableReasons.map(compareReasonText).join('，')}；不计算数值差值，不把不同任务的差异归因于模型。`;
    parts.push(`<div class="banner">${escapeHtml(banner)}</div>`);
    parts.push('<h3>指标对比</h3>');
    parts.push(
      htmlTable(
        ['指标', '左侧', '右侧', '差值', '百分比变动', '说明'],
        ALL_METRIC_KEYS.map(key => {
          const diff = model.comparison.metricDiffs[key]!;
          let delta = '—';
          let percent = '—';
          let note = '';
          const renderValue = (value: number | null): string => {
            if (value === null) return '未知';
            if (key === 'toolFailureRate') return `${(value * 100).toFixed(1)}%`;
            if (DURATION_KEYS.has(key)) return formatDuration(value);
            return formatInteger(value);
          };
          if (diff.comparable) {
            if (diff.delta !== null) delta = formatDeltaValue(key, diff.delta);
            if (diff.isBaselineZero) note = '基线为零';
            else if (diff.percentChange !== null) percent = formatSigned(diff.percentChange, true);
          } else {
            note = diff.reasonCodes.map(compareReasonText).join('，');
          }
          return [METRIC_LABELS[key], renderValue(diff.leftValue), renderValue(diff.rightValue), delta, percent, note];
        })
      )
    );
    parts.push(htmlSideSection('左侧', model.left));
    parts.push(htmlSideSection('右侧', model.right));
  }
  parts.push('</body></html>');
  return parts.join('\n');
}

// ============================================================================
// 模型装配与主入口
// ============================================================================

type ReportModel =
  | { kind: 'session'; side: SideModel }
  | {
      kind: 'comparison';
      comparison: SessionInsightCompareResponse;
      left: SideModel;
      right: SideModel;
    };

function buildSide(input: SessionInsightExportSideInput): SideModel {
  assertFrozenSnapshotConsistent(input.snapshot);
  return {
    snapshot: input.snapshot,
    evidence: selectEvidence(input.snapshot, input.events)
  };
}

function safeIdComponent(value: string, maxLength: number): string {
  const sanitized = value
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '')
    .slice(0, maxLength);
  return sanitized === '' || sanitized === '.' ? 'snapshot' : sanitized;
}

function reportFilename(model: ReportModel, format: 'markdown' | 'html'): string {
  const ext = format === 'html' ? 'html' : 'md';
  if (model.kind === 'session') {
    const snapshot = model.side.snapshot;
    return `session-insight-${safeIdComponent(snapshot.snapshotId, 48)}-${fixedDate(snapshot.createdAt)}.${ext}`;
  }
  const left = model.left.snapshot;
  const right = model.right.snapshot;
  return `session-insight-compare-${safeIdComponent(left.snapshotId, 24)}-${safeIdComponent(right.snapshotId, 24)}-${fixedDate(left.createdAt)}.${ext}`;
}

export function exportSessionInsightReport(input: SessionInsightExportInput): SessionInsightReport {
  const model: ReportModel =
    input.kind === 'session'
      ? { kind: 'session', side: buildSide(input) }
      : (() => {
          const left = buildSide(input.left);
          const right = buildSide(input.right);
          return {
            kind: 'comparison',
            comparison: compareSessionSnapshots({ left: input.left.snapshot, right: input.right.snapshot }),
            left,
            right
          };
        })();

  const content =
    input.format === 'html' ? renderHtmlModel(model) : renderMarkdownModel(model);

  // 双快照统一按最终 UTF-8 编码计数；超限抛固定错误码，绝不截断 HTML。
  if (utf8Bytes(content) > SESSION_INSIGHT_LIMITS.maxReportOutputBytes) {
    throw new SessionInsightReportError('INSIGHT_REPORT_LIMIT', REPORT_LIMIT_MESSAGE);
  }

  return {
    content,
    contentType: input.format === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
    filename: reportFilename(model, input.format)
  };
}
