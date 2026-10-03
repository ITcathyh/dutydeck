import type {
  CountMetric,
  ContinuousMetric,
  FileMetrics,
  InsightAvailability,
  Metric,
  RefreshState
} from '@dutydeck/shared';
import type { InsightFreshness } from '@dutydeck/shared';

// 纯展示格式化与标签：与页面、对比、导出共用同一口径（设计 §6.3）。

export const qualityLabels: Record<Metric['quality'], string> = {
  exact: '精确',
  derived: '推导',
  estimated: '估算',
  inferred: '推断',
  observed: '观测',
  heuristic: '启发式',
  unknown: '未知',
  unavailable: '不可用'
};

export const metricStatusLabels: Record<Metric['status'], string> = {
  available: '可用',
  partial: '部分',
  conflict: '冲突',
  unavailable: '不可用'
};

export const refreshStateLabels: Record<RefreshState, string> = {
  idle: '尚未分析',
  queued: '排队中',
  running: '分析中',
  succeeded: '分析完成',
  failed: '分析失败',
  cancelled: '已取消',
  interrupted: '已中断'
};

export const availabilityLabels: Record<InsightAvailability, string> = {
  none: '无快照',
  partial: '部分覆盖',
  complete: '完整覆盖'
};

export const freshnessLabels: Record<InsightFreshness, string> = {
  current: '最新',
  stale: '已过期',
  unknown: '新鲜度未知'
};

/** 作业是否仍在进行中：只有 queued / running 需要轮询。 */
export const isRefreshInFlight = (state: RefreshState) => state === 'queued' || state === 'running';

/** null 与 0 严格不同：null 渲染为「未知」，0 照常显示 0。 */
export const metricValueText = (metric: Metric): string => {
  if (metric.value === null) return '未知';
  return metric.value.toLocaleString('zh-CN');
};

export const formatCount = (metric: CountMetric | null | undefined): string =>
  !metric ? '未知' : metricValueText(metric);

/** 耗时指标（毫秒）格式化为中文时长；null 为未知。 */
export const formatDurationMs = (metric: ContinuousMetric | null | undefined): string => {
  if (!metric || metric.value === null) return '未知';
  return formatDuration(metric.value);
};

export const formatDuration = (ms: number): string => {
  if (ms === 0) return '0 毫秒';
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${Number(seconds.toFixed(1))} 秒`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds - minutes * 60);
  return restSeconds ? `${minutes} 分 ${restSeconds} 秒` : `${minutes} 分`;
};

/** 0–1 的比率显示为百分比；契约不保证服务端不返回超界值，这里只做展示。 */
export const formatRate = (metric: ContinuousMetric | null | undefined): string => {
  if (!metric || metric.value === null) return '未知';
  return `${(metric.value * 100).toFixed(1)}%`;
};

/** 悬浮详情：原值口径、质量、状态、证据/缺失分母与原因码。 */
export const metricTitle = (metric: Metric): string => {
  const parts = [
    `质量：${qualityLabels[metric.quality]}`,
    `状态：${metricStatusLabels[metric.status]}`,
    `证据 ${metric.evidenceCount} · 缺失 ${metric.missingCount}`
  ];
  if (metric.reasonCodes.length) parts.push(`原因：${metric.reasonCodes.join('、')}`);
  return parts.join('\n');
};

export const formatTime = (iso: string | null | undefined): string => {
  if (!iso) return '未知时间';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { hour12: false });
};

export type MetricKey = keyof FileMetrics;

interface MetricMeta {
  label: string;
  kind: 'count' | 'duration' | 'rate';
}

export const metricMeta: Record<MetricKey, MetricMeta> = {
  inputUncached: { label: '未缓存输入 token', kind: 'count' },
  cacheRead: { label: '缓存读取 token', kind: 'count' },
  cacheWrite: { label: '缓存写入 token', kind: 'count' },
  output: { label: '输出 token', kind: 'count' },
  reasoningOutput: { label: '推理输出 token（输出子集）', kind: 'count' },
  totalTracked: { label: '可追踪 token 合计', kind: 'count' },
  rawInput: { label: '源记录输入 token', kind: 'count' },
  rawOutput: { label: '源记录输出 token', kind: 'count' },
  rawTotal: { label: '源记录总 token', kind: 'count' },
  peakContext: { label: '上下文峰值 token', kind: 'count' },
  contextWindow: { label: '上下文窗口 token', kind: 'count' },
  elapsedDurationMs: { label: '总时长（源时间）', kind: 'duration' },
  activeDurationMs: { label: '活动时长', kind: 'duration' },
  idleDurationMs: { label: '观测空档（>5 分钟间隔）', kind: 'duration' },
  pairedToolDurationMs: { label: '已配对工具耗时', kind: 'duration' },
  userTurns: { label: '用户轮次', kind: 'count' },
  assistantTurns: { label: '模型轮次', kind: 'count' },
  toolCalls: { label: '工具调用总数', kind: 'count' },
  toolFailures: { label: '工具失败', kind: 'count' },
  toolSuccesses: { label: '工具成功', kind: 'count' },
  toolUnknowns: { label: '工具结果未知', kind: 'count' },
  toolFailureRate: { label: '工具失败率', kind: 'rate' },
  compactionCount: { label: '上下文压缩次数', kind: 'count' },
  subagentCount: { label: '子 Agent 数', kind: 'count' }
};

export const formatMetricByKey = (key: MetricKey, metric: Metric): string =>
  metricMeta[key].kind === 'duration'
    ? formatDurationMs(metric as ContinuousMetric)
    : metricMeta[key].kind === 'rate'
      ? formatRate(metric as ContinuousMetric)
      : metricValueText(metric);

export const traceKindLabels: Record<string, string> = {
  user_message: '用户消息',
  agent_message: '模型消息',
  tool_call: '工具调用',
  tool_result: '工具结果',
  tool_summary: '工具摘要',
  reasoning: '推理',
  context_compacted: '上下文压缩',
  token_sample: 'Token 样本',
  subagent_start: '子 Agent 开始',
  subagent_stop: '子 Agent 结束',
  mutation_append: '文件追加',
  mutation_replace: '文件替换',
  mutation_rollback: '文件回滚',
  system: '系统'
};

export const traceResultLabels: Record<'success' | 'failure' | 'unknown', string> = {
  success: '成功',
  failure: '失败',
  unknown: '结果未知'
};

export const clientLabels: Record<'codex' | 'claude' | 'traex', string> = {
  codex: 'Codex',
  claude: 'Claude',
  traex: 'TraeX'
};
