import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import type { RateLimitWindow } from '@dutydeck/shared';
import type { SessionUsage } from '../api';
import type { ContextStats } from '../composer-utils';

const tokens = (value: number) => value.toLocaleString('zh-CN');
const percentage = (value: number) => `${Number(value.toFixed(1))}%`;
const shortTime = (value: string | number) => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function Meter({ label, value }: { label: string; value?: number }) {
  return value === undefined ? null : <div role="progressbar" aria-label={label} aria-valuenow={Math.min(100, value)} aria-valuemin={0} aria-valuemax={100} className="h-1 w-12 shrink-0 overflow-hidden rounded-sm bg-muted"><div className="h-full bg-action" style={{ width: `${Math.min(100, value)}%` }}/></div>;
}
/** 摘要行里的一格：标签、读数和可选的进度条，次要说明都放进展开后的明细。 */
function Reading({ label, hint, value, children }: { label: string; hint?: string; value: string; children?: ReactNode }) {
  return <div className="flex min-w-0 items-center gap-2"><span title={hint} className="min-w-0 truncate text-subtle">{label}</span><strong className="shrink-0 font-medium text-primary">{value}</strong>{children}</div>;
}
const quotaExpired = (window?: RateLimitWindow) => Boolean(window && window.resetsAt * 1000 <= Date.now());
function QuotaReading({ label, window, pending }: { label: string; window?: RateLimitWindow; pending: string }) {
  const expired = quotaExpired(window);
  return <Reading label={`${label}额度`} hint={`账户${label === '5h' ? ' 5 小时' : ' 7 天'}额度`} value={window ? `已用 ${percentage(window.usedPercent)}${expired ? '（已过期）' : ''}` : pending}>
    <Meter label={`${label}额度已用`} value={!expired ? window?.usedPercent : undefined}/>
  </Reading>;
}
function QuotaDetail({ window }: { window?: RateLimitWindow }) {
  if (!window) return <div/>;
  const expired = quotaExpired(window);
  return <div className="min-w-0">
    {!expired && <div>剩余 {percentage(100 - window.usedPercent)}</div>}
    <div title={`采样于 ${new Date(window.observedAt).toLocaleString('zh-CN')}`}>{expired ? '等待最新数据 · ' : ''}{shortTime(window.resetsAt * 1000)} 重置</div>
    <div>上报于 {shortTime(window.observedAt)}</div>
  </div>;
}

/*
  摘要和明细按容器宽度排布：窄检视栏单列，宽面板可自动分列。
  采样、重置时间、来源和分项仍在折叠明细里，pr-14 对齐右侧「明细」开关。
*/
export function UsageHud({ usage, context, loading, error }: { usage?: SessionUsage; context?: ContextStats; loading?: boolean; error?: boolean }) {
  const pending = error ? '加载失败' : loading ? '加载中…' : '未提供';
  const snapshot = usage?.snapshot;
  const sampled = snapshot?.context;
  const current = context?.used !== undefined && (!sampled || !context.observedAt || Date.parse(context.observedAt) >= Date.parse(sampled.observedAt)) ? context : sampled;
  const used = current?.used;
  const size = current?.size;
  const percent = used !== undefined && size ? used / size * 100 : undefined;
  const own = usage?.own;
  const subSteps = usage?.subSteps;
  const entries = (own?.entries ?? 0) + (subSteps?.entries ?? 0);
  const tokenEntries = (own?.tokenEntries ?? (own ? own.entries - own.unavailable : 0)) + (subSteps?.tokenEntries ?? (subSteps ? subSteps.entries - subSteps.unavailable : 0));
  const missing = entries - tokenEntries;
  const partial = (own?.partialTokenEntries ?? 0) + (subSteps?.partialTokenEntries ?? 0);
  const sum = (key: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens') => (own?.[key] ?? 0) + (subSteps?.[key] ?? 0);
  const total = sum('inputTokens') + sum('outputTokens') + sum('cacheReadTokens') + sum('cacheWriteTokens');
  const hasTokens = entries > missing && entries > 0;
  const native = snapshot?.nativeTokens;
  const useNative = Boolean(native && (!hasTokens || missing > 0 || partial > 0));
  const nativeTotal = native?.totalTokens ?? (native ? (native.inputTokens ?? 0) + (native.outputTokens ?? 0) + (native.cacheReadTokens ?? 0) + (native.cacheWriteTokens ?? 0) : 0);
  const nativePartial = native && (native.partial || native.totalTokens === undefined && [native.inputTokens, native.outputTokens, native.cacheReadTokens, native.cacheWriteTokens].some(value => value === undefined));
  const reading = (value?: number) => value === undefined ? '未提供' : tokens(value);
  // 终端类 Agent 通常一条用量都没有，整行「未提供」只是噪音，这时不占位。
  if (!loading && !error && !snapshot?.error && used === undefined && !snapshot?.rateLimits?.fiveHour && !snapshot?.rateLimits?.sevenDay && !entries && !native) return null;
  return <section aria-label="任务用量" className="shrink-0 border-y border-default bg-surface px-3 text-caption sm:px-5">
    <details className="group">
      <summary className="flex min-h-9 cursor-pointer list-none items-center py-1.5 [&::-webkit-details-marker]:hidden">
        <div className="grid min-w-0 flex-1 grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-x-5 gap-y-1">
          <Reading label="上下文" value={percent !== undefined ? percentage(percent) : used !== undefined ? `${tokens(used)} token` : pending}><Meter label="上下文已用" value={percent}/></Reading>
          <QuotaReading label="5h" window={snapshot?.rateLimits?.fiveHour} pending={pending}/>
          <QuotaReading label="7天" window={snapshot?.rateLimits?.sevenDay} pending={pending}/>
          <Reading label={useNative ? '会话 token' : '累计 token'} hint={useNative ? '当前原生会话累计 token，读自 Agent 日志，不含子步骤' : '本任务账本累计 token'} value={useNative ? `${nativePartial ? '≥ ' : ''}${tokens(nativeTotal)}` : hasTokens ? `${missing || partial ? '≥ ' : ''}${tokens(total)}` : usage ? '暂无数据' : pending}/>
        </div>
        <span className="flex w-14 shrink-0 items-center justify-end gap-0.5 text-subtle group-hover:text-primary">明细<ChevronDown size={13} className="transition-transform duration-fast group-open:rotate-180"/></span>
      </summary>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-x-5 gap-y-2 pb-2 pr-14 text-subtle">
        <div className="min-w-0">
          {used !== undefined && <div>{tokens(used)} / {size === undefined ? '容量未提供' : tokens(size)}{size === undefined ? '' : ' token'}</div>}
          {context?.compacted ? <div>已压缩 {tokens(context.compacted)} token</div> : null}
          {current?.source === 'claude_transcript' && <div>最近请求输入 · 不含本次输出</div>}
          {current?.observedAt && <div>采样于 {shortTime(current.observedAt)}</div>}
        </div>
        <QuotaDetail window={snapshot?.rateLimits?.fiveHour}/>
        <QuotaDetail window={snapshot?.rateLimits?.sevenDay}/>
        <div className="min-w-0">
          {useNative && native && <>
            <div>当前原生会话 · 不含子步骤</div>
            {nativePartial && <div>日志用量仅部分可读</div>}
            <div>输入 {reading(native.inputTokens)} · 输出 {reading(native.outputTokens)} · 缓存读 {reading(native.cacheReadTokens)} · 缓存写 {reading(native.cacheWriteTokens)}</div>
            <div>{native.source === 'codex_transcript' ? 'Codex' : 'Claude'} 日志 · {shortTime(native.observedAt)}</div>
            {hasTokens && <div>账本已知累计 ≥ {tokens(total)} token{subSteps?.entries ? ' · 含子步骤' : ''}</div>}
          </>}
          {hasTokens && !useNative && <div>输入 {tokens(sum('inputTokens'))} · 输出 {tokens(sum('outputTokens'))} · 缓存读 {tokens(sum('cacheReadTokens'))} · 缓存写 {tokens(sum('cacheWriteTokens'))}{(subSteps?.entries ?? 0) > 0 ? ' · 含子步骤' : ''}</div>}
          {native && !useNative && <div title={`${native.source === 'codex_transcript' ? 'Codex' : 'Claude'} 日志 · ${new Date(native.observedAt).toLocaleString('zh-CN')}`}>当前原生会话 {nativePartial ? '≥ ' : ''}{tokens(nativeTotal)} token · 不含子步骤</div>}
          {missing > 0 && <div>{missing} 次执行无 token 数据</div>}
          {partial > 0 && <div>{partial} 次执行仅有部分 token 数据</div>}
        </div>
      </div>
    </details>
    {(error || snapshot?.error) && <div role="status" className="pb-1.5 text-warning">{error ? '用量刷新失败，已显示的数据可能未更新' : snapshot?.error}</div>}
  </section>;
}
