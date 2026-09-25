/**
 * 用量账本：每轮 Agent 执行（一个 attempt）记一条，按 Bot、群、触发人、来源汇总，
 * 并据此执行每个 Bot / 每个群的月度成本上限。
 */
export const usageCategories = ['explicit', 'proactive', 'scheduled', 'background'] as const;
/** explicit：群、私聊、Web 里人发起；proactive：群参与主动介入；scheduled：定时任务、持续委托；background：判定、记忆提取、回复生成等。 */
export type UsageCategory = (typeof usageCategories)[number];
/** reported：Agent 报了成本；estimated：只有 token，按单价表估算；unavailable：驱动不提供用量（PTY 等）。 */
export type UsageDataStatus = 'reported' | 'estimated' | 'unavailable';

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
  costUsd: number;
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 没有用量数据的记录数（PTY 等）。 */
  unavailable: number;
}
export interface UsageFilter { since?: string; appId?: string; chatId?: string; sessionId?: string; rootSessionId?: string }
export type UsageDimension = 'appId' | 'chatId' | 'actorId' | 'category';
export interface UsageGroup extends UsageTotals { appId?: string; chatId?: string; actorId?: string; category?: UsageCategory }

export type UsageCapScope = 'bot' | 'group';
export interface UsageCap { scope: UsageCapScope; appId: string; chatId?: string; monthlyCostUsd: number; updatedAt: string }

export interface UsageLedgerRepository {
  /** 同一 attempt 只记一条；已记过返回 false。 */
  append(entry: UsageLedgerEntry): Promise<boolean>;
  hasAttempt(attemptId: string): Promise<boolean>;
  hasUsageRef(sessionId: string, usageRef: string): Promise<boolean>;
  /** 上一次记下的会话累计成本；账本里没有时取事件表里其他轮次最后一次上报的累计成本。 */
  lastCumulativeCost(sessionId: string, excludeAttemptId?: string): Promise<number | undefined>;
  totals(filter: UsageFilter): Promise<UsageTotals>;
  summarize(dimension: UsageDimension, filter: UsageFilter): Promise<UsageGroup[]>;
  listCaps(): Promise<UsageCap[]>;
  setCap(cap: Omit<UsageCap, 'updatedAt'>): Promise<UsageCap>;
  deleteCap(scope: UsageCapScope, appId: string, chatId?: string): Promise<boolean>;
  /** 每个上限、每个月、每个阈值只认领成功一次；发送失败时 release 让下一次重试。 */
  claimAlert(scope: UsageCapScope, appId: string, chatId: string | undefined, month: string, threshold: number): Promise<boolean>;
  releaseAlert(scope: UsageCapScope, appId: string, chatId: string | undefined, month: string, threshold: number): Promise<void>;
}
