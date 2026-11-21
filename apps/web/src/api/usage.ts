import type {
  SessionUsageSnapshot,
  UsageBackgroundBudget,
  UsageCap,
  UsageGroup,
  UsageReport,
  UsageReportQuery,
  UsageSummaryWindow as SharedUsageSummaryWindow,
  UsageTaskPage,
  UsageTotals
} from '@dutydeck/shared';
import { json, send } from './client';

type UsageCoverage = Pick<UsageTotals, 'unpriced' | 'pricedEntries' | 'unknownCostEntries' | 'costCoverage'>;
/** Older instances omit coverage fields; absence means unknown, not zero. */
export type UsageTotalsResponse = Omit<UsageTotals, keyof UsageCoverage> & Partial<UsageCoverage>;
export type UsageGroupResponse = Omit<UsageGroup, keyof UsageCoverage> & Partial<UsageCoverage>;

export type UsageSummaryWindow = SharedUsageSummaryWindow<UsageTotalsResponse, UsageGroupResponse>;

export type UsageSummary = { month: UsageSummaryWindow; week: UsageSummaryWindow; caps: UsageCap[]; backgroundBudget?: UsageBackgroundBudget };
/** own：本任务自己的执行；subSteps：归到本任务名下的编排子步骤与 Leader 规划。 */
export type SessionUsage = { own: UsageTotalsResponse; subSteps: UsageTotalsResponse; snapshot?: SessionUsageSnapshot };

const usageQuery = (query: UsageReportQuery & { limit?: number; offset?: number }) => new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => [key, String(value)])).toString();
export type UsageCapInput = { scope: 'bot'; appId: string; monthlyCostUsd: number } | { scope: 'group'; appId: string; chatId: string; monthlyCostUsd: number };

export const usageRequests = {
  usageReport: (query: UsageReportQuery) => json<UsageReport>(`/api/usage/report?${usageQuery(query)}`, { cache: 'no-store' }),
  usageTasks: (query: UsageReportQuery & { limit: number; offset: number }) => json<UsageTaskPage>(`/api/usage/tasks?${usageQuery(query)}`, { cache: 'no-store' }),
  usageSummary: () => json<UsageSummary>('/api/usage/summary', { cache: 'no-store' }),
  setUsageCap: (body: UsageCapInput) => send<UsageCap>('PUT', '/api/usage/caps', body),
  deleteUsageCap: ({ scope, appId, chatId }: Pick<UsageCap, 'scope' | 'appId' | 'chatId'>) => json<{ deleted: boolean }>(`/api/usage/caps?${new URLSearchParams({ scope, appId, ...(chatId ? { chatId } : {}) })}`, { method: 'DELETE' }),
  sessionUsage: (id: string) => json<SessionUsage>(`/api/sessions/${encodeURIComponent(id)}/usage`),
};
