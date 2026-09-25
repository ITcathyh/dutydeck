import { createHash } from 'node:crypto';
import { z } from 'zod';
import { makeId, RuntimeError, type AttemptRef, type RepositoryBundle, type Session, type TaskRequestV1, type UsageCap, type UsageCapScope, type UsageCategory, type UsageGroup, type UsageLedgerEntry, type UsageTotals } from '@dutydeck/shared';

const rateSchema = z.object({ inputPerMTok: z.number().nonnegative(), cachedInputPerMTok: z.number().nonnegative(), outputPerMTok: z.number().nonnegative() }).strict();
const pricingSchema = z.object({ default: rateSchema, models: z.array(rateSchema.extend({ match: z.string().trim().min(1) }).strict()) }).strict();
export type UsagePricing = z.infer<typeof pricingSchema>;

/**
 * 估算单价（美元 / 百万 token），只在 Agent 不报成本时使用（codex-acp），结果一律标为估算。
 * 默认值按 OpenAI API 公开标价（https://openai.com/api/pricing ，2025 年末版本）录入，未与实际账单核对；
 * 按模型名最长前缀匹配，匹配不到用 default。token 按 ACP 适配器的口径：inputTokens 不含缓存命中，缓存命中单列在 cachedReadTokens，
 * 两者分别按 input、cachedInput 计。已安装的 codex-acp 1.12.1-preview.4 在 dist/index.js 的 toTokenCount 里把
 * inputTokens 换算成 inputTokens - cachedInputTokens，toPromptUsage 再把 cachedInputTokens 报成 cachedReadTokens；
 * claude-agent-acp 沿用 Anthropic 的 input_tokens，本来就不含缓存。
 * 部署时可用 DUTYDECK_USAGE_PRICING_JSON 整表覆盖。
 */
export const defaultUsagePricing: UsagePricing = {
  default: { inputPerMTok: 1.25, cachedInputPerMTok: 0.125, outputPerMTok: 10 },
  models: [
    { match: 'gpt-5.2', inputPerMTok: 1.75, cachedInputPerMTok: 0.175, outputPerMTok: 14 },
    { match: 'gpt-5.1-codex-mini', inputPerMTok: 0.25, cachedInputPerMTok: 0.025, outputPerMTok: 2 },
    { match: 'gpt-5-mini', inputPerMTok: 0.25, cachedInputPerMTok: 0.025, outputPerMTok: 2 },
    { match: 'gpt-5-nano', inputPerMTok: 0.05, cachedInputPerMTok: 0.005, outputPerMTok: 0.4 },
    { match: 'gpt-5', inputPerMTok: 1.25, cachedInputPerMTok: 0.125, outputPerMTok: 10 }
  ]
};
export function parseUsagePricing(json?: string): UsagePricing {
  return json?.trim() ? pricingSchema.parse(JSON.parse(json)) : defaultUsagePricing;
}

interface Tokens { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
export function estimateCostUsd(pricing: UsagePricing, model: string | undefined, tokens: Tokens): number {
  const name = model?.toLowerCase() ?? '';
  const rate = pricing.models.filter(entry => name.startsWith(entry.match.toLowerCase())).sort((a, b) => b.match.length - a.match.length)[0] ?? pricing.default;
  return ((tokens.inputTokens ?? 0) * rate.inputPerMTok + (tokens.cacheReadTokens ?? 0) * rate.cachedInputPerMTok + (tokens.outputTokens ?? 0) * rate.outputPerMTok) / 1_000_000;
}

/** 会话累计读数与上一次求差；读数变小说明 Agent 进程重启、累计从零开始，本次读数整体就是增量。 */
export function cumulativeDelta(previous: number | undefined, current: number): number {
  return previous === undefined || current < previous ? current : current - previous;
}

const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
/** ACP 驱动 turn_usage 事件的读数：usageRef/breakdown 是本轮 token（增量），cost 是会话累计成本。 */
export interface UsageReading { usageRef?: unknown; breakdown?: Record<string, unknown>; cost?: { amount?: unknown; currency?: unknown } }
type Measured = Pick<UsageLedgerEntry, keyof Tokens | 'costUsd' | 'costEstimated' | 'dataStatus' | 'cumulativeCostUsd' | 'usageRef'>;

/**
 * 读数换算成一条记录的用量：token 只在这个 usageRef 第一次出现时计入（本轮增量直接累加）；
 * 成本优先用 Agent 报的会话累计值与基线求差，没有就按单价表估算，两样都没有记为无数据。
 */
export function measureUsage(input: { reading?: UsageReading; freshTokens: boolean; baselineCostUsd?: number; model?: string; pricing: UsagePricing }): Measured {
  const { reading } = input;
  const usageRef = typeof reading?.usageRef === 'string' ? reading.usageRef : undefined;
  const breakdown = input.freshTokens && usageRef && reading?.breakdown && typeof reading.breakdown === 'object' ? reading.breakdown : undefined;
  const tokens: Tokens = breakdown ? {
    inputTokens: finite(breakdown.inputTokens), outputTokens: finite(breakdown.outputTokens),
    cacheReadTokens: finite(breakdown.cachedReadTokens), cacheWriteTokens: finite(breakdown.cachedWriteTokens)
  } : {};
  const hasTokens = Object.values(tokens).some(value => value !== undefined);
  const currency = typeof reading?.cost?.currency === 'string' ? reading.cost.currency.toUpperCase() : 'USD';
  const cumulative = currency === 'USD' ? finite(reading?.cost?.amount) : undefined;
  const counted = hasTokens ? { ...tokens, usageRef } : {};
  if (cumulative !== undefined) return { ...counted, costUsd: cumulativeDelta(input.baselineCostUsd, cumulative), costEstimated: false, dataStatus: 'reported', cumulativeCostUsd: cumulative };
  if (hasTokens) return { ...counted, costUsd: estimateCostUsd(input.pricing, input.model, tokens), costEstimated: true, dataStatus: 'estimated' };
  return { costEstimated: false, dataStatus: 'unavailable' };
}

/** 从会话来源解析 Bot 与群/会话；子步骤等不带这些信息的会话返回空，由根任务补齐。 */
export function usageScopeOf(session: Pick<Session, 'source' | 'sourceId'>): { appId?: string; chatId?: string; chatType?: string } {
  if (!session.sourceId) return {};
  const [appId, chatId, kind] = session.sourceId.split(':');
  if (!appId || !chatId) return {};
  if (session.source === 'lark') return { appId, chatId, chatType: kind };
  if (session.source === 'lark-decision' || session.source === 'lark-response') return { appId, chatId, chatType: 'group' };
  // 记忆会话按池划分：群聊共用 groups 池，私聊一人一池（池名即会话 id）。
  if (session.source === 'lark-memory') return chatId === 'groups' ? { appId } : { appId, chatId, chatType: 'p2p' };
  return {};
}

/** 按任务请求与会话来源归类；子步骤（work_item、lark-leader）的类别由调用方沿用根任务。 */
export function classifyUsage(session: Pick<Session, 'source' | 'sourceId'>, request: TaskRequestV1 | undefined, proactive: boolean): { category: UsageCategory; origin: string } {
  if (request?.namespace === 'schedule') return { category: 'scheduled', origin: session.sourceId?.split(':')[3] === 'collaboration' ? 'mandate' : 'schedule' };
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

/** 被上限拒绝时的说明：哪个上限、本月已用多少、谁能在哪里调高。 */
export function capRefusal(cap: UsageCap, spent: number) {
  return `${capLabel(cap.scope)}本月成本已达上限 ${usd(cap.monthlyCostUsd)}（已用 ${usd(spent)}），新任务不再执行，正在执行的任务不受影响。安装管理员可在 Dutydeck Web 的「用量与成本」里调高上限，否则下月 1 日起重新计算。`;
}

interface Attribution { appId?: string; chatId?: string; actorId?: string; category: UsageCategory; origin: string; rootTaskId?: string; rootSessionId?: string }
export interface UsageParent { parentSessionId: string; parentTaskId?: string }
export interface UsageLedgerOptions {
  repositories: Pick<RepositoryBundle, 'usage' | 'sessions' | 'execution' | 'agents'>;
  pricing?: UsagePricing;
  /** 编排子步骤、Leader 规划会话的发起方。 */
  parentOf?: (session: Session) => Promise<UsageParent | undefined>;
  /** 群参与判定为 act 后代为派发的消息。 */
  isProactive?: (appId: string, chatId: string, messageId: string) => Promise<boolean>;
  notify?: (target: { appId: string; chatId: string }, text: string, idempotencyKey: string) => Promise<void>;
  log?: { warn(object: unknown, message: string): void };
  now?: () => Date;
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
      const model = current.model ?? (await this.repos.agents.get(current.agentId))?.model;
      const usageRef = typeof reading?.usageRef === 'string' ? reading.usageRef : undefined;
      const freshTokens = usageRef ? !await usage.hasUsageRef(current.id, usageRef) : false;
      const baselineCostUsd = reading?.cost ? await usage.lastCumulativeCost(current.id, attempt.attemptId) : undefined;
      const entry: UsageLedgerEntry = {
        id: makeId('usage'), recordedAt: this.now().toISOString(), sessionId: current.id, taskId: attempt.taskId, attemptId: attempt.attemptId,
        ...attribution, agentId: current.agentId, ...(model ? { model } : {}),
        ...measureUsage({ reading, freshTokens, baselineCostUsd, model, pricing: this.pricing })
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
    return this.repos.usage.totals({ since: since.toISOString(), appId: cap.appId, ...(cap.scope === 'group' ? { chatId: cap.chatId } : {}) }).then(totals => totals.costUsd);
  }

  /** runtime 的 admitTask 钩子：本月已用满 Bot 或群上限时拒绝新任务。子步骤属于已派发的根任务，不在这里拦。 */
  async admit(session: Session, request: TaskRequestV1): Promise<void> {
    if (request.namespace === 'work_item' || session.source === 'work_item' || session.source === 'lark-leader') return;
    const scope = usageScopeOf(session);
    const appId = scope.appId ?? (request.actor.kind === 'channel' ? request.actor.appId : undefined);
    const reason = appId ? await this.refusal(appId, scope.chatId, request) : undefined;
    if (reason) throw new RuntimeError('USAGE_CAP_EXCEEDED', reason, 429);
  }

  /**
   * 本月已用满时返回拒绝说明（群上限比 Bot 上限具体，先报群），没用满返回空。
   * 群参与在判定前直接调用，其余经 admit。每次拒绝都在群里说明，见 explain。
   */
  async refusal(appId: string, chatId?: string, request?: Pick<TaskRequestV1, 'namespace' | 'key'>): Promise<string | undefined> {
    const since = usageMonthStart(this.now());
    for (const cap of (await this.capsFor(appId, chatId)).sort((a, b) => a.scope === b.scope ? 0 : a.scope === 'group' ? -1 : 1)) {
      const spent = await this.spent(cap, since);
      if (spent < cap.monthlyCostUsd) continue;
      const reason = capRefusal(cap, spent);
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
      const spent = await this.spent(cap, usageMonthStart(now));
      const claimed: number[] = [];
      for (const threshold of usageAlertThresholds) {
        if (spent >= cap.monthlyCostUsd * threshold / 100 && await this.repos.usage.claimAlert(cap.scope, cap.appId, cap.chatId, month, threshold)) claimed.push(threshold);
      }
      if (!claimed.length) continue;
      const text = `用量提醒：${capLabel(cap.scope)}本月成本已用 ${usd(spent)}，达到月度上限 ${usd(cap.monthlyCostUsd)} 的 ${percent(spent, cap.monthlyCostUsd)}%。用满上限后新任务会被拒绝，正在执行的任务不受影响。`;
      try { await this.options.notify({ appId: cap.appId, chatId }, text, alertKey(cap, month, claimed.at(-1)!)); }
      catch (error) {
        for (const threshold of claimed) await this.repos.usage.releaseAlert(cap.scope, cap.appId, cap.chatId, month, threshold);
        throw error;
      }
    }
  }

  async summary(): Promise<{ month: UsageSummaryWindow; week: UsageSummaryWindow; caps: UsageCap[] }> {
    const now = this.now();
    const window = async (since: Date): Promise<UsageSummaryWindow> => {
      const filter = { since: since.toISOString() };
      const [totals, bots, chats, actors, categories] = await Promise.all([this.repos.usage.totals(filter), this.repos.usage.summarize('appId', filter),
        this.repos.usage.summarize('chatId', filter), this.repos.usage.summarize('actorId', filter), this.repos.usage.summarize('category', filter)]);
      return { since: filter.since, totals, bots, chats, actors, categories };
    };
    return { month: await window(usageMonthStart(now)), week: await window(new Date(now.getTime() - 7 * 86_400_000)), caps: await this.repos.usage.listCaps() };
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
      return `${capLabel(scope)} ${usd(totals.costUsd)}（${limit}${estimated}）`;
    };
    return `**本月用量**：${[...(chatId ? [await part('group')] : []), await part('bot')].join(' · ')}`;
  }

  listCaps() { return this.repos.usage.listCaps(); }
  setCap(cap: Omit<UsageCap, 'updatedAt'>) { return this.repos.usage.setCap(cap); }
  deleteCap(scope: UsageCapScope, appId: string, chatId?: string) { return this.repos.usage.deleteCap(scope, appId, chatId); }
}
