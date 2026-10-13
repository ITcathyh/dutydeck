import { createHash } from 'node:crypto';
import { z } from 'zod';
import { executionTaskId } from '@dutydeck/storage';
import { makeId, parseLarkSourceId, RuntimeError, type UsageBackgroundLimits, type UsageBackgroundBudget, type AttemptRef, type RepositoryBundle, type Session, type TaskRequestV1, type UsageCap, type UsageCapScope, type UsageCategory, type UsageGroup, type UsageLedgerEntry, type UsageTotals, type UsageFilter, type UsageReport, type UsageReportFilter, type UsageTaskPage, type JsonValue } from '@dutydeck/shared';
import { isLarkPerGroupMemoryPool, larkMemoryScopeOfPool } from './lark/memory.js';

const rateSchema = z.object({ inputPerMTok: z.number().nonnegative(), cachedInputPerMTok: z.number().nonnegative(), outputPerMTok: z.number().nonnegative(), cacheWritePerMTok: z.number().nonnegative().optional(), provider: z.string().trim().min(1).optional() }).strict();
const pricingSchema = z.object({ version: z.string().trim().min(1).optional(), default: rateSchema, models: z.array(rateSchema.extend({ match: z.string().trim().min(1) }).strict()) }).strict();
export type UsagePricing = z.infer<typeof pricingSchema> & { source?: 'builtin' | 'custom' };
const backgroundLimitsSchema = z.object({ defaultMonthlyTasks: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), bots: z.record(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).optional() }).strict();
export function parseUsageBackgroundLimits(json?: string): UsageBackgroundLimits {
  return json?.trim() ? backgroundLimitsSchema.parse(JSON.parse(json)) : {};
}

/**
 * 估算单价（美元 / 百万 token），只在 Agent 不报成本时使用（codex-acp、终端模式 Claude），结果一律标为估算。
 * OpenAI 部分按公开标价（https://openai.com/api/pricing ，2025 年末版本）录入，未与实际账单核对。
 * Claude 部分取自 Anthropic 官方定价页（https://platform.claude.com/docs/en/about-claude/pricing ，2026-10-13 查阅）：
 * 输入、缓存读、缓存写、输出四项；缓存写按 5 分钟档（1 小时档单价更高，账本不区分，所以含 1 小时缓存写的会被低估）。
 * 没有计入的官方加价：美国境内推理（inference_geo=us）1.1 倍、Opus 快速模式、Batch 折扣；账本读不到这些开关。
 * Haiku 5.5 的单价按单次请求的提示长度分档（10 万 token 内 / 超过），账本只有整轮合计，分不了档，所以不录入，记为未定价。
 * 匹配规则：按模型名最长前缀（型号边界）匹配，内置表不对未知型号使用 default；Claude 型号名在前缀之后只允许
 * 日期后缀（-YYYYMMDD）或 -latest，所以 claude-opus-5-6 不会落到 claude-opus-5 的价格上。
 * 自定义 default 是明确的兜底估算。token 按 ACP 适配器的口径：inputTokens 不含缓存命中，缓存命中单列在 cachedReadTokens，
 * 两者分别按 input、cachedInput 计。已安装的 codex-acp 1.12.1-preview.4 在 dist/index.js 的 toTokenCount 里把
 * inputTokens 换算成 inputTokens - cachedInputTokens，toPromptUsage 再把 cachedInputTokens 报成 cachedReadTokens；
 * claude-agent-acp 沿用 Anthropic 的 input_tokens，本来就不含缓存。
 * 部署时可用 DUTYDECK_USAGE_PRICING_JSON 整表覆盖。
 */
const claudeRate = (inputPerMTok: number, cacheWritePerMTok: number, cachedInputPerMTok: number, outputPerMTok: number) => ({ inputPerMTok, cachedInputPerMTok, outputPerMTok, cacheWritePerMTok });
export const defaultUsagePricing: UsagePricing = {
  source: 'builtin', version: 'public-2026-10-v2',
  default: { inputPerMTok: 1.25, cachedInputPerMTok: 0.125, outputPerMTok: 10 },
  models: [
    { match: 'gpt-5.2', inputPerMTok: 1.75, cachedInputPerMTok: 0.175, outputPerMTok: 14 },
    { match: 'gpt-5.1-codex-mini', inputPerMTok: 0.25, cachedInputPerMTok: 0.025, outputPerMTok: 2 },
    { match: 'gpt-5-mini', inputPerMTok: 0.25, cachedInputPerMTok: 0.025, outputPerMTok: 2 },
    { match: 'gpt-5-nano', inputPerMTok: 0.05, cachedInputPerMTok: 0.005, outputPerMTok: 0.4 },
    { match: 'gpt-5', inputPerMTok: 1.25, cachedInputPerMTok: 0.125, outputPerMTok: 10 },
    { match: 'claude-fable-5-1', ...claudeRate(10, 12.5, 0.25, 50) },
    { match: 'claude-fable-5', ...claudeRate(10, 12.5, 1, 50) },
    { match: 'claude-opus-5-5', ...claudeRate(4, 5, 0.2, 20) },
    { match: 'claude-opus-5', ...claudeRate(5, 6.25, 0.5, 25) },
    { match: 'claude-opus-4-8', ...claudeRate(5, 6.25, 0.5, 25) },
    { match: 'claude-opus-4-7', ...claudeRate(5, 6.25, 0.5, 25) },
    { match: 'claude-opus-4-6', ...claudeRate(5, 6.25, 0.5, 25) },
    { match: 'claude-opus-4-5', ...claudeRate(5, 6.25, 0.5, 25) },
    { match: 'claude-sonnet-5-5', ...claudeRate(2, 2.5, 0.1, 10) },
    { match: 'claude-sonnet-5', ...claudeRate(2, 2.5, 0.2, 10) },
    { match: 'claude-sonnet-4-6', ...claudeRate(3, 3.75, 0.3, 15) },
    { match: 'claude-sonnet-4-5', ...claudeRate(3, 3.75, 0.3, 15) },
    { match: 'claude-haiku-4-5', ...claudeRate(1, 1.25, 0.1, 5) }
  ]
};
export function parseUsagePricing(json?: string): UsagePricing {
  return json?.trim() ? { ...pricingSchema.parse(JSON.parse(json)), source: 'custom' } : defaultUsagePricing;
}

interface Tokens { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
/** Claude Code 会在型号后加 [1m]；Bedrock / Vertex 的型号带区域与厂商前缀、-v1:0 / @日期 后缀。统一成官方 API 型号名再匹配。 */
function normalizeModelName(model: string | undefined) {
  const name = (model ?? '').trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
  const claude = name.replace(/^(?:[a-z]{2,6}\.)?anthropic\./, '');
  return claude.startsWith('claude-') ? claude.replace(/-v\d+(?::\d+)?$/, '').replace(/@(\d{8})$/, '-$1') : name;
}
function matchesModel(name: string, prefix: string) {
  if (name === prefix) return true;
  if (!name.startsWith(`${prefix}-`)) return false;
  return !prefix.startsWith('claude-') || /^-(?:\d{8}|latest)$/.test(name.slice(prefix.length));
}
function priceSelection(pricing: UsagePricing, model: string | undefined, provider = 'unknown') {
  const name = normalizeModelName(model);
  const matchesProvider = (rate: z.infer<typeof rateSchema>) => !rate.provider || rate.provider.toLowerCase() === provider.toLowerCase();
  const matched = pricing.models.filter(entry => matchesProvider(entry) && matchesModel(name, entry.match.toLowerCase())).sort((a, b) => b.match.length - a.match.length)[0];
  const builtin = pricing.source === 'builtin';
  const rate = matched ?? (!builtin && matchesProvider(pricing.default) ? pricing.default : undefined);
  const pricingSource: UsageLedgerEntry['pricingSource'] = matched ? (builtin ? 'builtin_model' : 'custom_model') : rate ? 'custom_default' : 'unmatched';
  // Include the actual table in the hash: editing prices without a version bump
  // still leaves a distinct durable provenance key.
  const pricingVersion = `${pricing.version ?? (builtin ? 'builtin' : 'custom')}:${createHash('sha256').update(JSON.stringify(pricing)).digest('hex').slice(0, 32)}`;
  return { rate, pricingSource, pricingVersion, ...(matched ? { pricingMatch: matched.match } : {}) };
}

export function estimateCostUsd(pricing: UsagePricing, model: string | undefined, tokens: Tokens, provider?: string): number | undefined {
  const { rate } = priceSelection(pricing, model, provider);
  if (!rate || (tokens.cacheWriteTokens ?? 0) > 0 && rate.cacheWritePerMTok === undefined) return undefined;
  return ((tokens.inputTokens ?? 0) * rate.inputPerMTok + (tokens.cacheReadTokens ?? 0) * rate.cachedInputPerMTok
    + (tokens.outputTokens ?? 0) * rate.outputPerMTok + (tokens.cacheWriteTokens ?? 0) * (rate.cacheWritePerMTok ?? 0)) / 1_000_000;
}

/** 会话累计读数与上一次求差；读数变小说明 Agent 进程重启、累计从零开始，本次读数整体就是增量。 */
export function cumulativeDelta(previous: number | undefined, current: number): number {
  return previous === undefined || current < previous ? current : current - previous;
}

const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
/** ACP 驱动 turn_usage 事件的读数：usageRef/breakdown 是本轮 token（增量），cost 是会话累计成本。 */
export interface UsageReading {
  provider?: unknown; model?: unknown; usageRef?: unknown; breakdown?: Record<string, unknown>; cost?: { amount?: unknown; currency?: unknown };
  /** 终端模式 Claude：一轮里有多个型号时，breakdown 总量按型号的拆分（每个型号按自己的单价估算）；model 缺省的组用任务型号。 */
  byModel?: Array<{ model?: unknown; breakdown?: Record<string, unknown> }>;
  /** 终端模式 Claude：本轮有部分用量读不到（子代理文件读失败或格式不认识），已读到的 token 只是下限，费用记为未知。 */
  partial?: unknown;
}
type Measured = Pick<UsageLedgerEntry, keyof Tokens | 'costUsd' | 'costEstimated' | 'dataStatus' | 'cumulativeCostUsd' | 'usageRef' | 'pricingSource' | 'pricingVersion' | 'pricingMatch' | 'unpricedReason'>;

/**
 * 读数换算成一条记录的用量：token 只在这个 usageRef 第一次出现时计入（本轮增量直接累加）；
 * 成本优先用 Agent 报的会话累计值与基线求差，没有就按单价表估算，两样都没有记为无数据。
 */
export function measureUsage(input: { reading?: UsageReading; freshTokens: boolean; baselineCostUsd?: number; model?: string; provider?: string; pricing: UsagePricing }): Measured {
  const { reading } = input;
  const usageRef = typeof reading?.usageRef === 'string' ? reading.usageRef : undefined;
  const breakdown = input.freshTokens && usageRef && reading?.breakdown && typeof reading.breakdown === 'object' ? reading.breakdown : undefined;
  const tokensOf = (source: Record<string, unknown>): Tokens => ({
    inputTokens: finite(source.inputTokens), outputTokens: finite(source.outputTokens),
    cacheReadTokens: finite(source.cachedReadTokens), cacheWriteTokens: finite(source.cachedWriteTokens)
  });
  const tokens: Tokens = breakdown ? tokensOf(breakdown) : {};
  const groups = breakdown && Array.isArray(reading?.byModel) && reading.byModel.length > 1
    ? reading.byModel.filter(group => group?.breakdown && typeof group.breakdown === 'object').map(group => ({
      model: typeof group.model === 'string' && group.model.trim() ? group.model.trim() : input.model, tokens: tokensOf(group.breakdown!) }))
    : undefined;
  const hasTokens = Object.values(tokens).some(value => value !== undefined);
  const currency = typeof reading?.cost?.currency === 'string' ? reading.cost.currency.toUpperCase() : 'USD';
  const cumulative = currency === 'USD' ? finite(reading?.cost?.amount) : undefined;
  const counted = hasTokens ? { ...tokens, usageRef } : {};
  if (cumulative !== undefined) return { ...counted, costUsd: cumulativeDelta(input.baselineCostUsd, cumulative), costEstimated: false, dataStatus: 'reported', cumulativeCostUsd: cumulative, pricingSource: 'reported' };
  if (hasTokens) {
    // 多个型号的一轮：每个型号各按自己的单价估算再相加，任何一个估不出来，整轮就记为未定价。
    const parts = (groups ?? [{ model: input.model, tokens }]).map(group => ({
      ...priceSelection(input.pricing, group.model, input.provider), cost: estimateCostUsd(input.pricing, group.model, group.tokens, input.provider) }));
    const unpriced = parts.find(part => part.cost === undefined);
    const { rate, cost: _cost, ...selected } = unpriced ?? parts[0]!;
    const matches = [...new Set(parts.flatMap(part => part.pricingMatch ?? []))];
    const provenance = { ...selected, ...(matches.length ? { pricingMatch: matches.join(' + ') } : {}) };
    if (reading?.partial === true) return { ...counted, ...provenance, costEstimated: false, dataStatus: 'unpriced', unpricedReason: 'usage_incomplete' };
    return unpriced
      ? { ...counted, ...provenance, costEstimated: false, dataStatus: 'unpriced', unpricedReason: rate ? 'cache_write_rate_missing' : 'unknown_model' }
      : { ...counted, ...provenance, costUsd: parts.reduce((total, part) => total + part.cost!, 0), costEstimated: true, dataStatus: 'estimated' };
  }
  return { costEstimated: false, dataStatus: 'unavailable', pricingSource: 'none' };
}

/** 从会话来源解析 Bot 与群/会话；子步骤等不带这些信息的会话返回空，由根任务补齐。 */
export function usageScopeOf(session: Pick<Session, 'source' | 'sourceId'>): { appId?: string; chatId?: string; chatType?: string } {
  if (!session.sourceId) return {};
  const { appId, chatId, chatType: kind } = parseLarkSourceId(session.sourceId);
  if (!appId || !chatId) return {};
  if (session.source === 'lark') return { appId, chatId, chatType: kind };
  if (session.source === 'lark-decision' || session.source === 'lark-response') return { appId, chatId, chatType: 'group' };
  // 记忆会话按池划分：群聊共用 groups 池，按群独立的池归到那个群，私聊一人一池（池名即会话 id）。
  if (session.source === 'lark-memory') {
    if (chatId === 'groups') return { appId };
    const pool = larkMemoryScopeOfPool({ appId, pool: chatId });
    return isLarkPerGroupMemoryPool(pool) ? { appId, chatId: pool.chatId, chatType: 'group' } : { appId, chatId, chatType: 'p2p' };
  }
  return {};
}

/** 按任务请求与会话来源归类；子步骤（work_item、lark-leader）的类别由调用方沿用根任务。 */
export function classifyUsage(session: Pick<Session, 'source' | 'sourceId'>, request: TaskRequestV1 | undefined, proactive: boolean): { category: UsageCategory; origin: string } {
  if (request?.namespace === 'schedule') return { category: 'scheduled', origin: parseLarkSourceId(session.sourceId).scope[0] === 'collaboration' ? 'mandate' : 'schedule' };
  if (request?.namespace === 'automation') return { category: 'scheduled', origin: 'ci' };
  if (session.source === 'lark-decision') return { category: 'background', origin: 'decision' };
  if (session.source === 'lark-response') return { category: 'background', origin: 'response' };
  if (session.source === 'lark-memory') return { category: 'background', origin: 'memory' };
  if (session.source === 'work_item') return { category: 'background', origin: 'work_item' };
  if (session.source === 'lark-leader') return { category: 'background', origin: 'leader' };
  if (request?.actor.kind === 'installation_owner' || !session.source) return { category: 'explicit', origin: 'web' };
  if (session.source === 'lark') {
    if (proactive) return { category: 'proactive', origin: 'participation' };
    return { category: 'explicit', origin: usageScopeOf(session).chatType === 'p2p' ? 'lark_p2p' : 'lark_group' };
  }
  return { category: 'background', origin: session.source.slice(0, 64) };
}

/**
 * 群参与判定（lark-decision）和回复生成（lark-response）会话的用量，给 /status 的参与行用。
 * PTY 等拿不到成本的会话只有条数，费用记为未知，不能当 0 加总。
 */
export async function participationUsage(repo: Pick<RepositoryBundle['usage'], 'listEntries'>, scope: { appId: string; chatId: string }, since: string) {
  const entries = (await repo.listEntries({ since, appId: scope.appId, chatId: scope.chatId })).filter(entry => entry.origin === 'decision' || entry.origin === 'response');
  return { entries: entries.length, costUsd: entries.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0), unknown: entries.filter(entry => entry.costUsd === undefined).length };
}

export function usageMonthStart(now: Date) { return new Date(now.getFullYear(), now.getMonth(), 1); }
const monthKey = (now: Date) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const usd = (value: number) => `$${value.toFixed(2)}`;
const capLabel = (scope: UsageCapScope) => scope === 'group' ? '本群' : '本机器人';
// 成本是多轮求差累加的浮点数，取整前留一点余量，避免 81% 显示成 80%。
const percent = (spent: number, cap: number) => Math.floor(spent / cap * 100 + 1e-6);
export const usageAlertThresholds = [75, 95] as const;
/** 「已用满」通知的认领档位：与 75/95 共用认领表，每个上限每月第一次拒绝新任务时发一次。 */
const usedUpThreshold = 100;
const digestKey = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const alertKey = (cap: UsageCap, month: string, threshold: number) => `usage_alert_${digestKey([cap.scope, cap.appId, cap.chatId ?? '', month, threshold])}`;

/** 本月有费用算不出来的记录（终端模式 Claude 读不到 token、模型没有单价）时，上限只覆盖了已知部分。 */
export function unknownUsageNote(totals: Pick<UsageTotals, 'unknownCostEntries' | 'unavailable' | 'unpriced'>) {
  return totals.unknownCostEntries > 0
    ? `注意：部分用量未知，上限可能不准（${totals.unknownCostEntries} 次任务的费用未知：${totals.unpriced} 次缺单价、${totals.unavailable} 次无用量数据，未计入已用金额）。`
    : '';
}

/** 被上限拒绝时的说明：哪个上限、本月已用多少、谁能在哪里调高。 */
export function capRefusal(cap: UsageCap, spent: number, unknownNote = '') {
  return `${capLabel(cap.scope)}本月成本已达上限 ${usd(cap.monthlyCostUsd)}（已用 ${usd(spent)}），新任务不再执行，正在执行的任务不受影响。安装管理员可在 Dutydeck Web 的「用量与成本」里调高上限，否则下月 1 日起重新计算。${unknownNote}`;
}

interface Attribution { appId?: string; chatId?: string; actorId?: string; category: UsageCategory; origin: string; rootTaskId?: string; rootSessionId?: string }
export interface UsageParent { parentSessionId: string; parentTaskId?: string }
export interface UsageLedgerOptions {
  repositories: Pick<RepositoryBundle, 'usage' | 'sessions' | 'execution' | 'agents'>;
  pricing?: UsagePricing;
  backgroundLimits?: UsageBackgroundLimits;
  /** 编排子步骤、Leader 规划会话的发起方。 */
  parentOf?: (session: Session) => Promise<UsageParent | undefined>;
  /** 群参与判定为 act 后代为派发的消息。 */
  isProactive?: (appId: string, chatId: string, messageId: string) => Promise<boolean>;
  notify?: (target: { appId: string; chatId: string }, text: string, idempotencyKey: string) => Promise<void>;
  log?: { warn(object: unknown, message: string): void };
  now?: () => Date;
}
/** 明细查询：from / to 是 daemon 本地时区的日历日（YYYY-MM-DD，含首尾两天），其余是精确匹配的筛选。 */
export type UsageReportQuery = UsageReportFilter & { from?: string; to?: string };
const dayText = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
function parseDay(value: string, label: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : undefined;
  if (!date || dayText(date) !== value) throw new RuntimeError('USAGE_RANGE_INVALID', `${label} 需要是 YYYY-MM-DD 格式的日期`, 400);
  return date;
}
/** 缺省为含今天在内的最近 30 天。结束日含当天：until 取次日本地零点（不含）。 */
export function resolveUsageRange(query: Pick<UsageReportQuery, 'from' | 'to'>, now: Date) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = query.to ? parseDay(query.to, 'to') : today;
  const from = query.from ? parseDay(query.from, 'from') : new Date(to.getFullYear(), to.getMonth(), to.getDate() - 29);
  if (from > to) throw new RuntimeError('USAGE_RANGE_INVALID', 'from 不能晚于 to', 400);
  const until = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
  return { from: dayText(from), to: dayText(to), since: from.toISOString(), until: until.toISOString() };
}
export interface UsageSummaryWindow { since: string; totals: UsageTotals; bots: UsageGroup[]; chats: UsageGroup[]; actors: UsageGroup[]; categories: UsageGroup[] }

export class UsageLedger {
  private readonly pricing: UsagePricing;
  constructor(private readonly options: UsageLedgerOptions) { this.pricing = options.pricing ?? defaultUsagePricing; }
  private get repos() { return this.options.repositories; }
  private now() { return this.options.now?.() ?? new Date(); }

  private async attribute(session: Session, taskId: string | undefined, depth = 0): Promise<Attribution> {
    const request = taskId ? this.repos.execution.getAcceptedTask(taskId)?.request : undefined;
    const actorId = request && request.actor.kind !== 'unspecified' ? request.actor.id : undefined;
    if (depth < 4 && (session.source === 'work_item' || session.source === 'lark-leader')) {
      const parent = await this.options.parentOf?.(session);
      const parentSession = parent ? await this.repos.sessions.get(parent.parentSessionId) : undefined;
      if (parent && parentSession) {
        const root = await this.attribute(parentSession, parent.parentTaskId, depth + 1);
        return { ...root, actorId: root.actorId ?? actorId, origin: session.source === 'work_item' ? 'work_item' : 'leader',
          rootTaskId: root.rootTaskId ?? parent.parentTaskId, rootSessionId: root.rootSessionId ?? parentSession.id };
      }
    }
    const scope = usageScopeOf(session);
    const appId = scope.appId ?? (request?.actor.kind === 'channel' ? request.actor.appId : undefined);
    let proactive = false;
    if (session.source === 'lark' && scope.chatType === 'group' && scope.appId && request?.key.startsWith('lark:') && this.options.isProactive) {
      // 飞书任务的幂等键是 lark:<appId>:<messageId>:<turn>。
      const messageId = request.key.split(':').slice(2, -1).join(':');
      proactive = await this.options.isProactive(scope.appId, scope.chatId!, messageId).catch(() => false);
    }
    return { appId, chatId: scope.chatId, actorId, ...classifyUsage(session, request, proactive) };
  }

  /** runtime 的 recordUsage 钩子：ACP 按 turn_usage 读数记一条，没有读数的驱动在 completed 时记一条无数据。 */
  async record(session: Session, attempt: AttemptRef, data?: Record<string, unknown>): Promise<void> {
    const reading = data as UsageReading | undefined;
    try {
      const usage = this.repos.usage;
      if (!reading && await usage.hasAttempt(attempt.attemptId)) return;
      const current = await this.repos.sessions.get(session.id) ?? session;
      const attribution = await this.attribute(current, attempt.taskId);
      const accepted = this.repos.execution.getAcceptedTask(attempt.taskId);
      const frozenModel = accepted?.input?.version === 2 ? accepted.input.executionOptions.model : undefined;
      const reportedModel = typeof reading?.model === 'string' && reading.model.trim() ? reading.model.trim() : undefined;
      const model = reportedModel ?? frozenModel ?? current.model ?? (await this.repos.agents.get(current.agentId))?.model;
      const modelSource: UsageLedgerEntry['modelSource'] = reportedModel ? 'reading' : frozenModel ? 'task' : current.model ? 'session' : model ? 'agent' : 'unknown';
      const provider = typeof reading?.provider === 'string' && reading.provider.trim() ? reading.provider.trim() : 'unknown';
      const usageRef = typeof reading?.usageRef === 'string' ? reading.usageRef : undefined;
      const freshTokens = usageRef ? !await usage.hasUsageRef(current.id, usageRef) : false;
      const baselineCostUsd = reading?.cost ? await usage.lastCumulativeCost(current.id, attempt.attemptId) : undefined;
      const entry: UsageLedgerEntry = {
        id: makeId('usage'), recordedAt: this.now().toISOString(), sessionId: current.id, taskId: attempt.taskId, attemptId: attempt.attemptId,
        ...attribution, agentId: current.agentId, provider, modelSource, ...(model ? { model } : {}),
        ...measureUsage({ reading, freshTokens, baselineCostUsd, model, provider, pricing: this.pricing })
      };
      if (await usage.append(entry)) void this.alert(entry).catch(error => this.options.log?.warn({ error, appId: entry.appId }, '用量上限提醒发送失败'));
    } catch (error) {
      this.options.log?.warn({ error, sessionId: session.id, taskId: attempt.taskId }, '用量记账失败');
    }
  }

  private async capsFor(appId: string, chatId?: string): Promise<UsageCap[]> {
    return (await this.repos.usage.listCaps()).filter(cap => cap.appId === appId && (cap.scope === 'bot' || cap.chatId === chatId));
  }
  private spent(cap: UsageCap, since: Date) {
    return this.repos.usage.totals({ since: since.toISOString(), appId: cap.appId, ...(cap.scope === 'group' ? { chatId: cap.chatId } : {}) });
  }

  /** runtime 的 admitTask 钩子：本月已用满 Bot 或群上限时拒绝新任务。子步骤属于已派发的根任务，不在这里拦。 */
  async admit(session: Session, request: TaskRequestV1): Promise<void> {
    if (request.namespace === 'work_item' || session.source === 'work_item' || session.source === 'lark-leader') return;
    const scope = usageScopeOf(session);
    const appId = scope.appId ?? (request.actor.kind === 'channel' ? request.actor.appId : undefined);
    const reason = appId ? await this.refusal(appId, scope.chatId, request) : undefined;
    if (reason) throw new RuntimeError('USAGE_CAP_EXCEEDED', reason, 429);
    if (!appId) return;
    const limit = this.options.backgroundLimits?.bots?.[appId] ?? this.options.backgroundLimits?.defaultMonthlyTasks;
    if (limit === undefined) return;
    let proactive = false;
    if (session.source === 'lark' && scope.chatType === 'group' && request.key.startsWith('lark:')) {
      proactive = await this.options.isProactive?.(appId, scope.chatId!, request.key.split(':').slice(2, -1).join(':')) ?? false;
    }
    if (classifyUsage(session, request, proactive).category === 'explicit') return;
    const taskId = executionTaskId(request.namespace, request.sessionId, request.key);
    if (!await this.repos.usage.claimBackgroundTask(appId, monthKey(this.now()), taskId, limit)) {
      throw new RuntimeError('USAGE_BACKGROUND_CAP_EXCEEDED', this.automaticCapMessage(limit), 429);
    }
  }

  /** Read-only early gate; admit still atomically claims the task allowance. */
  async automaticRefusal(appId: string): Promise<string | undefined> {
    const limit = this.options.backgroundLimits?.bots?.[appId] ?? this.options.backgroundLimits?.defaultMonthlyTasks;
    if (limit === undefined) return undefined;
    const used = (await this.repos.usage.backgroundTaskCounts(monthKey(this.now()))).find(row => row.appId === appId)?.tasks ?? 0;
    return used >= limit ? this.automaticCapMessage(limit) : undefined;
  }

  private automaticCapMessage(limit: number) {
    return `本机器人本月自动任务已达 ${limit} 次上限，新的后台、主动介入和定时任务暂停。显式请求与在途任务不受影响；安装管理员可调整自动任务月度次数配置。`;
  }

  /**
   * 本月已用满时返回拒绝说明（群上限比 Bot 上限具体，先报群），没用满返回空。
   * 群参与在判定前直接调用，其余经 admit。每次拒绝都在群里说明，见 explain。
   */
  async refusal(appId: string, chatId?: string, request?: Pick<TaskRequestV1, 'namespace' | 'key'>): Promise<string | undefined> {
    const since = usageMonthStart(this.now());
    for (const cap of (await this.capsFor(appId, chatId)).sort((a, b) => a.scope === b.scope ? 0 : a.scope === 'group' ? -1 : 1)) {
      const totals = await this.spent(cap, since);
      if (totals.costUsd < cap.monthlyCostUsd) continue;
      const reason = capRefusal(cap, totals.costUsd, unknownUsageNote(totals));
      void this.explain(cap, chatId, reason, request).catch(error => this.options.log?.warn({ error, appId }, '用量上限说明发送失败'));
      return reason;
    }
    return undefined;
  }

  /**
   * 群上限发到该群，Bot 上限发到这次被拒的群或私聊。每个上限每月第一次拒绝时发一条「已用满」通知；
   * 之后定时任务（schedule / automation）每次被拒再说一次本次未执行，因为它本该在群里回报结果，其余请求由各自的入口说明。
   */
  private async explain(cap: UsageCap, chatId: string | undefined, reason: string, request?: Pick<TaskRequestV1, 'namespace' | 'key'>) {
    const target = cap.scope === 'group' ? cap.chatId : chatId;
    if (!target?.startsWith('oc_') || !this.options.notify) return;
    const month = monthKey(this.now());
    if (await this.repos.usage.claimAlert(cap.scope, cap.appId, cap.chatId, month, usedUpThreshold)) {
      try { await this.options.notify({ appId: cap.appId, chatId: target }, `用量提醒：${reason}`, alertKey(cap, month, usedUpThreshold)); }
      catch (error) {
        await this.repos.usage.releaseAlert(cap.scope, cap.appId, cap.chatId, month, usedUpThreshold);
        throw error;
      }
      return;
    }
    if (request?.namespace === 'schedule' || request?.namespace === 'automation') {
      await this.options.notify({ appId: cap.appId, chatId: target }, `定时任务本次未执行：${reason}`, `usage_blocked_${digestKey(request.key)}`);
    }
  }

  /** 用到上限的 75%、95% 各提醒一次：群上限发到该群，Bot 上限发到这次用量所在的群或私聊。 */
  private async alert(entry: UsageLedgerEntry) {
    if (!entry.appId || !entry.costUsd || !this.options.notify) return;
    const now = this.now();
    const month = monthKey(now);
    for (const cap of await this.capsFor(entry.appId, entry.chatId)) {
      const chatId = cap.scope === 'group' ? cap.chatId : entry.chatId;
      if (!chatId?.startsWith('oc_')) continue;
      const totals = await this.spent(cap, usageMonthStart(now));
      const spent = totals.costUsd;
      const claimed: number[] = [];
      for (const threshold of usageAlertThresholds) {
        if (spent >= cap.monthlyCostUsd * threshold / 100 && await this.repos.usage.claimAlert(cap.scope, cap.appId, cap.chatId, month, threshold)) claimed.push(threshold);
      }
      if (!claimed.length) continue;
      const text = `用量提醒：${capLabel(cap.scope)}本月成本已用 ${usd(spent)}，达到月度上限 ${usd(cap.monthlyCostUsd)} 的 ${percent(spent, cap.monthlyCostUsd)}%。用满上限后新任务会被拒绝，正在执行的任务不受影响。${unknownUsageNote(totals)}`;
      try { await this.options.notify({ appId: cap.appId, chatId }, text, alertKey(cap, month, claimed.at(-1)!)); }
      catch (error) {
        for (const threshold of claimed) await this.repos.usage.releaseAlert(cap.scope, cap.appId, cap.chatId, month, threshold);
        throw error;
      }
    }
  }

  async summary(): Promise<{ month: UsageSummaryWindow; week: UsageSummaryWindow; caps: UsageCap[]; backgroundBudget: UsageBackgroundBudget }> {
    const now = this.now();
    const window = async (since: Date): Promise<UsageSummaryWindow> => {
      const filter = { since: since.toISOString() };
      const [totals, bots, chats, actors, categories] = await Promise.all([this.repos.usage.totals(filter), this.repos.usage.summarize('appId', filter),
        this.repos.usage.summarize('chatId', filter), this.repos.usage.summarize('actorId', filter), this.repos.usage.summarize('category', filter)]);
      return { since: filter.since, totals, bots, chats, actors, categories };
    };
    return { month: await window(usageMonthStart(now)), week: await window(new Date(now.getTime() - 7 * 86_400_000)), caps: await this.repos.usage.listCaps(), backgroundBudget: { ...this.options.backgroundLimits, month: monthKey(now), usage: await this.repos.usage.backgroundTaskCounts(monthKey(now)) } };
  }

  /** 用量明细：日趋势与按型号 / agent / 机器人 / 来源的分布，同一时间范围与筛选下各部分合计一致。 */
  async report(query: UsageReportQuery): Promise<UsageReport> {
    const range = resolveUsageRange(query, this.now());
    const rangeFilter: UsageFilter = { since: range.since, until: range.until };
    const filter = this.usageFilter(query, range);
    const usage = this.repos.usage;
    const [totals, daily, models, agents, bots, origins, allModels, allAgents, allBots, allOrigins] = await Promise.all([
      usage.totals(filter), usage.summarize('day', filter), usage.summarize('model', filter), usage.summarize('agentId', filter), usage.summarize('appId', filter), usage.summarize('origin', filter),
      usage.summarize('model', rangeFilter), usage.summarize('agentId', rangeFilter), usage.summarize('appId', rangeFilter), usage.summarize('origin', rangeFilter)
    ]);
    const known = <T>(values: Array<T | undefined>) => values.filter((value): value is T => value !== undefined).sort();
    return {
      timezone: { name: Intl.DateTimeFormat().resolvedOptions().timeZone, offsetMinutes: -this.now().getTimezoneOffset() },
      range, filter: { ...(query.model ? { model: query.model } : {}), ...(query.agentId ? { agentId: query.agentId } : {}), ...(query.appId ? { appId: query.appId } : {}), ...(query.origin ? { origin: query.origin } : {}) },
      totals, daily, models, agents, bots, origins,
      options: { models: [...known(allModels.map(group => group.model)), ...(allModels.some(group => group.model === undefined) ? [null] : [])], agentIds: known(allAgents.map(group => group.agentId)), appIds: known(allBots.map(group => group.appId)), origins: known(allOrigins.map(group => group.origin)) }
    };
  }

  /** 同一时间范围与筛选下按根任务合并的分页列表（子步骤并入根任务，不重复计数）。 */
  tasks(query: UsageReportQuery, page: { limit: number; offset: number }): Promise<UsageTaskPage> {
    return this.repos.usage.listTasks(this.usageFilter(query, resolveUsageRange(query, this.now())), page);
  }

  private usageFilter(query: UsageReportQuery, range: { since: string; until: string }): UsageFilter {
    return { since: range.since, until: range.until, ...(query.model ? { model: query.model } : {}), ...(query.agentId ? { agentId: query.agentId } : {}), ...(query.appId ? { appId: query.appId } : {}), ...(query.origin ? { origin: query.origin } : {}) };
  }

  /** 任务详情：本会话自身的用量，加上归到它名下的编排子步骤。 */
  async sessionUsage(sessionId: string): Promise<{ own: UsageTotals; subSteps: UsageTotals }> {
    const [own, subSteps] = await Promise.all([this.repos.usage.totals({ sessionId }), this.repos.usage.totals({ rootSessionId: sessionId })]);
    return { own, subSteps };
  }

  /** 飞书 /status 里的一行：当前 Bot 与当前群的本月用量和上限。 */
  async describe(appId: string, chatId?: string): Promise<string> {
    const since = usageMonthStart(this.now());
    const caps = await this.capsFor(appId, chatId);
    const part = async (scope: UsageCapScope) => {
      const totals = await this.repos.usage.totals({ since: since.toISOString(), appId, ...(scope === 'group' ? { chatId } : {}) });
      const cap = caps.find(item => item.scope === scope);
      const estimated = totals.estimatedCostUsd > 0 ? `，含估算 ${usd(totals.estimatedCostUsd)}` : '';
      const limit = cap ? `上限 ${usd(cap.monthlyCostUsd)}，已用 ${percent(totals.costUsd, cap.monthlyCostUsd)}%` : '未设上限';
      const unknown = totals.unknownCostEntries ? `；另有 ${totals.unknownCostEntries} 次费用未知（${totals.unpriced} 次缺费率、${totals.unavailable} 次无用量），美元上限不覆盖这部分` : '';
      return `${capLabel(scope)} ${usd(totals.costUsd)}（${limit}${estimated}）${unknown}`;
    };
    return `**本月用量**：${[...(chatId ? [await part('group')] : []), await part('bot')].join(' · ')}`;
  }

  listCaps() { return this.repos.usage.listCaps(); }
  setCap(cap: Omit<UsageCap, 'updatedAt'>) { return this.repos.usage.setCap(cap); }
  deleteCap(scope: UsageCapScope, appId: string, chatId?: string) { return this.repos.usage.deleteCap(scope, appId, chatId); }
}

/** The caller supplies only already-authorized job records; this helper creates no public route. */
export async function tokenEfficiencyUsageReport(
  repos: Pick<RepositoryBundle, 'usage' | 'execution'>,
  input: { rootTaskIds: string[]; taskIds?: string[]; filter: UsageFilter;
    memoryJobs?: Array<{ id: string; scope: { appId: string; pool: string }; sessionId: string; input: JsonValue; requests: TaskRequestV1[] }> }
) {
  const executionAvailable = repos.execution.authority() === 'ledger_v1';
  const roots = new Set(input.rootTaskIds);
  const taskIds = new Set([...roots, ...(input.taskIds ?? [])]);
  const entries = await repos.usage.listEntries(input.filter);
  for (const entry of entries) if (entry.rootTaskId && roots.has(entry.rootTaskId)) taskIds.add(entry.taskId);
  const jobs = new Map<string, NonNullable<typeof input.memoryJobs>[number]>();
  for (const job of input.memoryJobs ?? []) {
    if (input.filter.appId !== undefined && job.scope.appId !== input.filter.appId) continue;
    const frozen = job.input as { turns?: Array<{ taskId?: unknown }> } | null;
    if (Array.isArray(frozen?.turns) && frozen.turns.some(turn => turn && typeof turn.taskId === 'string' && taskIds.has(turn.taskId))) jobs.set(job.id, job);
  }
  // A compatible session can run unrelated jobs. Match stable dispatch task identities, never its entire session.
  const jobTasks = new Set([...jobs.values()].flatMap(job => job.requests.map(request => executionTaskId(request.namespace, request.sessionId, request.key))));
  // Shared-pool rows have no chat/root-session attribution. Authorized frozen jobs supply
  // the exact identities to supplement; keep their app and the requested time window.
  const tasksByApp = new Map<string, Set<string>>();
  for (const job of jobs.values()) {
    const ids = tasksByApp.get(job.scope.appId) ?? new Set<string>();
    for (const request of job.requests) ids.add(executionTaskId(request.namespace, request.sessionId, request.key));
    tasksByApp.set(job.scope.appId, ids);
  }
  const jobEntries = (await Promise.all([...tasksByApp].map(([appId, ids]) => repos.usage.listEntries(
    { appId, ...(input.filter.since !== undefined ? { since: input.filter.since } : {}) }, [...ids]
  )))).flat();
  const selected = [...entries, ...jobEntries].filter(entry => taskIds.has(entry.taskId) || entry.rootTaskId && roots.has(entry.rootTaskId) || jobTasks.has(entry.taskId));
  const seenAttempts = new Set<string>(), seenUsage = new Set<string>();
  const unique = selected.filter(entry => {
    const attempt = JSON.stringify([entry.sessionId, entry.attemptId]);
    const usage = entry.usageRef ? JSON.stringify([entry.sessionId, entry.usageRef]) : undefined;
    if (seenAttempts.has(attempt) || usage && seenUsage.has(usage)) return false;
    seenAttempts.add(attempt); if (usage) seenUsage.add(usage); return true;
  });
  const policies: Record<string, number> = {};
  const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
  const tokens = Object.fromEntries(fields.map(field => {
    const reported = unique.filter(entry => typeof entry[field] === 'number');
    return [field, { value: reported.length ? reported.reduce((sum, entry) => sum + entry[field]!, 0) : null, reportedEntries: reported.length,
      coverage: unique.length ? reported.length / unique.length : null }];
  })) as Record<typeof fields[number], { value: number | null; reportedEntries: number; coverage: number | null }>;
  for (const entry of unique) {
    const policy = (executionAvailable ? repos.execution.getAcceptedTask(entry.taskId)?.input?.executionContext.promptPolicyVersion : undefined) ?? 'legacy_unversioned';
    policies[policy] = (policies[policy] ?? 0) + 1;
  }
  const allTasks = new Set([...taskIds, ...jobTasks]);
  const attempts = executionAvailable ? [...allTasks].flatMap(taskId => repos.execution.getTaskExecution(taskId)?.attempts ?? []) : [];
  const covered = new Set(unique.map(entry => entry.attemptId));
  return {
    executionCoverage: executionAvailable ? 'ledger_v1' as const : 'legacy_unavailable' as const,
    entries: unique.length, policies, tokens, memoryJobIds: [...jobs.keys()],
    accounting: 'shared_memory_jobs_counted_once' as const,
    unavailableEntries: unique.filter(entry => entry.dataStatus === 'unavailable').length,
    missingUsageAttempts: attempts.filter(attempt => !covered.has(attempt.attemptId)).map(attempt => attempt.attemptId),
    costUsd: unique.some(entry => entry.costUsd !== undefined) ? unique.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0) : null,
    taskStates: [...allTasks].map(taskId => ({ taskId, status: (executionAvailable ? repos.execution.getTaskExecution(taskId)?.task.status : undefined) ?? 'unavailable' }))
  };
}
