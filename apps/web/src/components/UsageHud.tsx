import type { RateLimitWindow } from '@dutydeck/shared';
import type { SessionUsage } from '../api';
import type { ContextStats } from '../composer-utils';

const tokens = (value: number) => value.toLocaleString('zh-CN');
const percentage = (value: number) => `${Number(value.toFixed(1))}%`;
function Meter({ label, value }: { label: string; value?: number }) {
  return value === undefined ? null : <div role="progressbar" aria-label={label} aria-valuenow={Math.min(100, value)} aria-valuemin={0} aria-valuemax={100} className="mt-1 h-1 overflow-hidden rounded-sm bg-muted"><div className="h-full bg-action" style={{ width: `${Math.min(100, value)}%` }}/></div>;
}
function Quota({ label, window, pending }: { label: string; window?: RateLimitWindow; pending: string }) {
  const expired = Boolean(window && window.resetsAt * 1000 <= Date.now());
  return <div className="min-w-0">
    <div className="flex items-baseline justify-between gap-2"><span className="text-subtle">账户{label}额度</span><strong className="font-medium text-primary">{window ? `已用 ${percentage(window.usedPercent)}${expired ? '（已过期）' : ''}` : pending}</strong></div>
    {window && !expired && <div className="mt-1 text-subtle">剩余 {percentage(100 - window.usedPercent)}</div>}
    <Meter label={`${label}额度已用`} value={!expired ? window?.usedPercent : undefined}/>
    {window && <div className="mt-1 text-subtle" title={`采样于 ${new Date(window.observedAt).toLocaleString('zh-CN')}`}>{expired ? '等待最新数据 · ' : ''}{new Date(window.resetsAt * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 重置</div>}
    {window && <div className="mt-0.5 text-subtle">上报于 {new Date(window.observedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>}
  </div>;
}

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
  return <section aria-label="任务用量" className="shrink-0 border-b border-t border-default bg-surface px-3 py-2 text-caption sm:px-5">
    <div className="grid grid-cols-2 gap-x-5 gap-y-2 lg:grid-cols-4">
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-2"><span className="text-subtle">Context</span><strong className="font-medium text-primary">{percent !== undefined ? percentage(percent) : used !== undefined ? `${tokens(used)} token` : pending}</strong></div>
        <Meter label="上下文已用" value={percent}/>
        {used !== undefined && <div className="mt-1 text-subtle">{tokens(used)} / {size === undefined ? '容量未提供' : tokens(size)}{size === undefined ? '' : ' token'}</div>}
        {current?.source === 'claude_transcript' && <div className="mt-0.5 text-subtle">最近请求输入 · 不含本次输出</div>}
        {current?.observedAt && <div className="mt-0.5 text-subtle">采样于 {new Date(current.observedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>}
      </div>
      <Quota label="5h" window={snapshot?.rateLimits?.fiveHour} pending={pending}/>
      <Quota label="7天" window={snapshot?.rateLimits?.sevenDay} pending={pending}/>
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-2"><span className="text-subtle">{useNative ? '原生会话累计 token' : '累计 token'}</span><strong className="font-medium text-primary">{useNative ? `${nativePartial ? '≥ ' : ''}${tokens(nativeTotal)}` : hasTokens ? `${missing || partial ? '≥ ' : ''}${tokens(total)}` : usage ? '暂无数据' : pending}</strong></div>
        {useNative && native && <>
          <div className="mt-1 text-subtle">当前原生会话 · 不含子步骤</div>
          {nativePartial && <div className="mt-0.5 text-subtle">日志用量仅部分可读</div>}
          <details className="mt-1 text-subtle"><summary className="cursor-pointer">输入 / 输出 / 缓存明细</summary><div>输入 {reading(native.inputTokens)} · 输出 {reading(native.outputTokens)} · 缓存读 {reading(native.cacheReadTokens)} · 缓存写 {reading(native.cacheWriteTokens)}</div></details>
          <div className="mt-0.5 text-subtle">{native.source === 'codex_transcript' ? 'Codex' : 'Claude'} 日志 · {new Date(native.observedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
          {hasTokens && <div className="mt-1 text-subtle">账本已知累计 ≥ {tokens(total)} token{subSteps?.entries ? ' · 含子步骤' : ''}</div>}
        </>}
        {hasTokens && !useNative && <details className="mt-1 text-subtle"><summary className="cursor-pointer">输入 / 输出 / 缓存明细{(subSteps?.entries ?? 0) > 0 ? ' · 含子步骤' : ''}</summary><div>输入 {tokens(sum('inputTokens'))} · 输出 {tokens(sum('outputTokens'))} · 缓存读 {tokens(sum('cacheReadTokens'))} · 缓存写 {tokens(sum('cacheWriteTokens'))}</div></details>}
        {native && !useNative && <div className="mt-1 text-subtle" title={`${native.source === 'codex_transcript' ? 'Codex' : 'Claude'} 日志 · ${new Date(native.observedAt).toLocaleString('zh-CN')}`}>当前原生会话 {nativePartial ? '≥ ' : ''}{tokens(nativeTotal)} token · 不含子步骤</div>}
        {missing > 0 && <div className="mt-1 text-subtle">{missing} 次执行无 token 数据</div>}
        {partial > 0 && <div className="mt-1 text-subtle">{partial} 次执行仅有部分 token 数据</div>}
      </div>
    </div>
    {(error || snapshot?.error) && <div role="status" className="mt-1 text-warning">{error ? '用量刷新失败，已显示的数据可能未更新' : snapshot?.error}</div>}
  </section>;
}
