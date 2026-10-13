import type { UsageTotalsResponse as UsageTotals } from '../api';

export const usd = (value: number) => `$${value.toFixed(2)}`;
export const count = (value: number) => value.toLocaleString('zh-CN');

/** 成本里估算的部分单独标出；PTY 等不上报用量的记录只计次数，不算进成本。 */
export function usageText(totals: UsageTotals) {
  const parts = [`已知费用 ${usd(totals.costUsd)}${totals.estimatedCostUsd > 0 ? `（含估算 ${usd(totals.estimatedCostUsd)}）` : ''}`,
    `输入 ${count(totals.inputTokens)} · 输出 ${count(totals.outputTokens)} token`, `${count(totals.entries)} 次`];
  parts.push(`计价覆盖率 ${totals.costCoverage === null ? '暂无记录' : typeof totals.costCoverage === 'number' && Number.isFinite(totals.costCoverage) ? `${Math.round(totals.costCoverage * 100)}%` : '未知'}`);
  if (totals.unpriced) parts.push(`${count(totals.unpriced)} 次有 token、费用未知`);
  if (totals.unavailable) parts.push(`${count(totals.unavailable)} 次无用量数据`);
  return parts.join(' · ');
}
