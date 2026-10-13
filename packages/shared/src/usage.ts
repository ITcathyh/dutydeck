/**
 * 用量账本：每轮 Agent 执行（一个 attempt）记一条，按 Bot、群、触发人、来源汇总，
 * 并据此执行每个 Bot / 每个群的月度成本上限。
 */
export const usageCategories = ['explicit', 'proactive', 'scheduled', 'background'] as const;
/** explicit：群、私聊、Web 里人发起；proactive：群参与主动介入；scheduled：定时任务、持续委托；background：判定、记忆提取、回复生成等。 */
export type UsageCategory = (typeof usageCategories)[number];
/** reported：Agent 报了成本；estimated：费率完整；unpriced：有 token 但无法完整计价；unavailable：无用量。 */
export type UsageDataStatus = 'reported' | 'estimated' | 'unpriced' | 'unavailable';

export interface UsageLedgerEntry {
  id: string;
  recordedAt: string;
  appId?: string;
  chatId?: string;
  sessionId: string;
  taskId: string;
  attemptId: string;
  /** 编排子步骤、Leader/Worker 归到发起它的根任务；根任务自身不填。 */
  rootTaskId?: string;
  rootSessionId?: string;
  actorId?: string;
  category: UsageCategory;
  /** 细分来源，例如 lark_group、lark_p2p、web、decision、memory、work_item。 */
  origin: string;
  agentId: string;
  model?: string;
  /** 实际服务商只采用读数明确提供的证据；不能从 Agent 名称推断。 */
  provider?: string;
  modelSource?: 'reading' | 'task' | 'session' | 'agent' | 'unknown' | 'legacy_unknown';
  pricingSource?: 'reported' | 'builtin_model' | 'custom_model' | 'custom_default' | 'unmatched' | 'none' | 'legacy_unknown';
  pricingVersion?: string;
  pricingMatch?: string;
  unpricedReason?: 'unknown_model' | 'cache_write_rate_missing' | 'legacy_cache_write_rate_unknown' | 'usage_incomplete';
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  costEstimated: boolean;
  dataStatus: UsageDataStatus;
  /** Agent 报的会话累计成本读数，下一轮求差的基线。 */
  cumulativeCostUsd?: number;
  /** 本轮 token 取自的 ACPX 按请求用量键；同一会话里同一个键只计一次。 */
  usageRef?: string;
}

export interface UsageTotals {
  entries: number;
  /** Records reporting tokens; cost-only records are not token zeroes. */
  tokenEntries?: number;
  partialTokenEntries?: number;
  costUsd: number;
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 没有用量数据的记录数（PTY 等）。 */
  unavailable: number;
  unpriced: number;
  pricedEntries: number;
  unknownCostEntries: number;
  /** 已计价记录 / 总记录；没有记录时为 null，不代表免费。 */
  costCoverage: number | null;
}
/** model 筛选里表示「没有记下型号」的记录。 */
export const usageUnknownModel = '__unknown__';
/** since 含、until 不含（ISO 时刻）；model 可取 usageUnknownModel。 */
export interface UsageFilter { since?: string; until?: string; appId?: string; chatId?: string; sessionId?: string; rootSessionId?: string; model?: string; agentId?: string; origin?: string }
/** day 按 daemon 本地时区的日历日分组（YYYY-MM-DD），升序；其余按成本降序。 */
export type UsageDimension = 'appId' | 'chatId' | 'actorId' | 'category' | 'model' | 'agentId' | 'origin' | 'day';
/** 缺 model（或 appId 等）的分组表示该维度未知，不并入任何已知值。 */
export interface UsageGroup extends UsageTotals { appId?: string; chatId?: string; actorId?: string; category?: UsageCategory; model?: string; agentId?: string; origin?: string; day?: string }
/**
 * 一个根任务名下的用量：根任务自身与归到它的编排子步骤各记一次，合并成一行，不重复计数。
 * sessionId 是任务详情所在的会话（子步骤指向发起它的根会话）。
 */
export interface UsageTaskRow extends UsageTotals {
  taskId: string;
  sessionId: string;
  appId?: string;
  chatId?: string;
  agentId: string;
  origin: string;
  models: string[];
  firstRecordedAt: string;
  lastRecordedAt: string;
  /** 其中来自子步骤的记录数。 */
  subStepEntries: number;
}
/** 明细查询里的精确匹配筛选；model 可取 usageUnknownModel。 */
export interface UsageReportFilter { model?: string; agentId?: string; appId?: string; origin?: string }
export interface UsageReport {
  /** 日历日按这个时区切分；offsetMinutes 是现在的 UTC 偏移（东八区为 480）。 */
  timezone: { name: string; offsetMinutes: number };
  /** from / to 是含首尾的本地日历日；since 含、until 不含（ISO 时刻）。 */
  range: { from: string; to: string; since: string; until: string };
  filter: UsageReportFilter;
  totals: UsageTotals;
  /** 范围内每个有记录的日历日，升序；没有记录的日子不出现，由界面补零。 */
  daily: UsageGroup[];
  models: UsageGroup[];
  agents: UsageGroup[];
  bots: UsageGroup[];
  origins: UsageGroup[];
  /** 筛选下拉的候选：只受时间范围限制，不受其它筛选影响；models 里的 null 表示有记录没有记下型号。 */
  options: { models: Array<string | null>; agentIds: string[]; appIds: string[]; origins: string[] };
}
export interface UsageTaskPage { total: number; tasks: UsageTaskRow[] }

export type UsageCapScope = 'bot' | 'group';
export interface UsageCap { scope: UsageCapScope; appId: string; chatId?: string; monthlyCostUsd: number; updatedAt: string }

/** 未配置即关闭；启用后约束所有自动根任务的准入次数，不是美元预留。 */
export interface UsageBackgroundLimits { defaultMonthlyTasks?: number; bots?: Record<string, number> }
export interface UsageBackgroundUsage { appId: string; tasks: number }
export interface UsageBackgroundBudget extends UsageBackgroundLimits { month: string; usage: UsageBackgroundUsage[] }

export interface UsageLedgerRepository {
  /** 同一 attempt 只记一条；已记过返回 false。 */
  append(entry: UsageLedgerEntry): Promise<boolean>;
  hasAttempt(attemptId: string): Promise<boolean>;
  /** 按 taskId 幂等、按 Bot/月原子认领；失败返回 false。 */
  claimBackgroundTask(appId: string, month: string, taskId: string, limit: number): Promise<boolean>;
  backgroundTaskCounts(month: string): Promise<UsageBackgroundUsage[]>;
  hasUsageRef(sessionId: string, usageRef: string): Promise<boolean>;
  /** 上一次记下的会话累计成本；账本里没有时取事件表里其他轮次最后一次上报的累计成本。 */
  lastCumulativeCost(sessionId: string, excludeAttemptId?: string): Promise<number | undefined>;
  /** Read-only entries for authorized offline analysis; does not change billing aggregation. */
  listEntries(filter: UsageFilter, taskIds?: string[]): Promise<UsageLedgerEntry[]>;
  totals(filter: UsageFilter): Promise<UsageTotals>;
  summarize(dimension: UsageDimension, filter: UsageFilter): Promise<UsageGroup[]>;
  /** 按根任务合并后的分页列表，最近的在前；各行合计等于同一筛选下的 totals。 */
  listTasks(filter: UsageFilter, page: { limit: number; offset: number }): Promise<UsageTaskPage>;
  listCaps(): Promise<UsageCap[]>;
  setCap(cap: Omit<UsageCap, 'updatedAt'>): Promise<UsageCap>;
  deleteCap(scope: UsageCapScope, appId: string, chatId?: string): Promise<boolean>;
  /** 每个上限、每个月、每个阈值只认领成功一次；发送失败时 release 让下一次重试。 */
  claimAlert(scope: UsageCapScope, appId: string, chatId: string | undefined, month: string, threshold: number): Promise<boolean>;
  releaseAlert(scope: UsageCapScope, appId: string, chatId: string | undefined, month: string, threshold: number): Promise<void>;
}
