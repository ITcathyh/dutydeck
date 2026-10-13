import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usageUnknownModel, type UsageTaskRow } from '@dutydeck/shared';
import { api, type UsageGroupResponse as UsageGroup, type UsageReportQuery, type UsageTotalsResponse as UsageTotals } from '../api';
import { Badge, Banner, Button, Card, EmptyState, Field, Input, Select, Spinner } from './primitives';
import { count, usageText, usd } from './usageFormat';

const PAGE_SIZE = 20;
const MAX_FILLED_DAYS = 120;
const unknownModelLabel = '未记录型号';

/** 含首尾的日历日（YYYY-MM-DD）。只做字符串日期运算，不受浏览器时区影响；范围过长时不补零，只显示有记录的日子。 */
function daysBetween(from: string, to: string): string[] | undefined {
  const start = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || (end - start) / 86_400_000 >= MAX_FILLED_DAYS) return undefined;
  return Array.from({ length: (end - start) / 86_400_000 + 1 }, (_, index) => new Date(start + index * 86_400_000).toISOString().slice(0, 10));
}
const utcOffset = (minutes: number) => `UTC${minutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`;
const unknownCount = (totals: Pick<UsageTotals, 'unknownCostEntries'>) => totals.unknownCostEntries ?? 0;

/** 已知费用与未知费用并列：只有未知记录的一行写「费用未知」，不显示 $0.00。 */
function costText(row: UsageTotals) {
  const unknown = unknownCount(row);
  if (!row.entries) return '无记录';
  if (unknown === row.entries) return '费用未知';
  return `${usd(row.costUsd)}${unknown ? ` + ${count(unknown)} 次费用未知` : ''}`;
}

function Breakdown({ title, rows, label }: { title: string; rows: UsageGroup[]; label(row: UsageGroup): string }) {
  return <section aria-label={title} className="space-y-2">
    <h3 className="text-body font-semibold">{title}</h3>
    {rows.length ? <ul className="divide-y divide-subtle rounded-md border border-subtle bg-surface">
      {rows.map(row => <li key={label(row)} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 p-3">
        <span className="min-w-0 break-all text-body text-primary">{label(row)}{row.unpriced ? <> <Badge tone="warning">未定价</Badge></> : null}</span>
        <span className="text-caption text-secondary">{usageText(row)}</span>
      </li>)}
    </ul> : <p className="text-caption text-secondary">暂无记录。</p>}
  </section>;
}

function DailyTrend({ from, to, rows }: { from: string; to: string; rows: UsageGroup[] }) {
  const byDay = new Map(rows.map(row => [row.day, row]));
  const days = daysBetween(from, to) ?? rows.map(row => row.day!);
  const max = Math.max(0, ...rows.map(row => row.costUsd));
  return <section aria-label="日趋势" className="space-y-2">
    <h3 className="text-body font-semibold">日趋势（已知费用）</h3>
    <ul className="divide-y divide-subtle rounded-md border border-subtle bg-surface">
      {days.map(day => {
        const row = byDay.get(day);
        const known = row && row.costUsd > 0;
        return <li key={day} className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 p-2 sm:grid-cols-[6rem_minmax(0,1fr)_auto]">
          <span className="text-caption tabular-nums text-secondary">{day}</span>
          <span className="h-2 rounded-sm bg-info-soft" aria-hidden="true">{known && max > 0 ? <span className="block h-2 rounded-sm bg-info-solid" style={{ width: `${Math.max(2, row.costUsd / max * 100)}%` }}/> : null}</span>
          <span className="col-span-2 text-caption text-secondary sm:col-span-1">{row ? costText(row) : '无记录'}</span>
        </li>;
      })}
    </ul>
  </section>;
}

function TaskList({ page, total, offset, setOffset, loading, botName, onOpenTask }: {
  page: UsageTaskRow[]; total: number; offset: number; setOffset(offset: number): void; loading: boolean; botName(appId?: string): string; onOpenTask?(sessionId: string): void;
}) {
  return <section aria-label="任务明细" className="space-y-2">
    <h3 className="text-body font-semibold">任务明细（共 {count(total)} 个根任务，编排子步骤已并入发起它的任务）</h3>
    {page.length ? <ul className="divide-y divide-subtle rounded-md border border-subtle bg-surface">
      {page.map(task => <li key={task.taskId} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 p-3">
        <span className="min-w-0 space-y-0.5">
          <Button size="sm" onClick={() => onOpenTask?.(task.sessionId)} aria-label={`打开任务 ${task.taskId}`}>{task.taskId}</Button>
          <span className="block text-caption text-secondary">
            {new Date(task.lastRecordedAt).toLocaleString('zh-CN', { hour12: false })} · {botName(task.appId)} · {task.agentId} · {task.origin} · {task.models.length ? task.models.join('、') : unknownModelLabel}
            {task.subStepEntries ? ` · 含 ${count(task.subStepEntries)} 条子步骤记录` : ''}
          </span>
        </span>
        <span className="text-caption text-secondary">{costText(task)} · {count(task.entries)} 次 · 输入 {count(task.inputTokens)} · 输出 {count(task.outputTokens)} token</span>
      </li>)}
    </ul> : <p className="text-caption text-secondary">{loading ? '正在读取…' : '这个范围内没有任务记录。'}</p>}
    {total > PAGE_SIZE && <div className="flex items-center gap-2">
      <Button size="sm" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>上一页</Button>
      <span className="text-caption text-secondary">{offset + 1}–{Math.min(total, offset + PAGE_SIZE)} / {count(total)}</span>
      <Button size="sm" disabled={offset + PAGE_SIZE >= total || loading} onClick={() => setOffset(offset + PAGE_SIZE)}>下一页</Button>
    </div>}
  </section>;
}

/** 用量明细：按日趋势，按型号 / agent / 机器人 / 来源筛选，并下钻到任务。同一范围与筛选下各部分合计一致。 */
export function UsageDetail({ botName, onOpenTask }: { botName(appId?: string): string; onOpenTask?(sessionId: string): void }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [filter, setFilter] = useState<{ model: string; agentId: string; appId: string; origin: string }>({ model: '', agentId: '', appId: '', origin: '' });
  const [offset, setOffset] = useState(0);
  const query: UsageReportQuery = { from, to, ...filter };
  const report = useQuery({ queryKey: ['usage-report', query], queryFn: () => api.usageReport(query), retry: false, placeholderData: previous => previous });
  const tasks = useQuery({ queryKey: ['usage-tasks', query, offset], queryFn: () => api.usageTasks({ ...query, limit: PAGE_SIZE, offset }), retry: false, placeholderData: previous => previous });
  const change = (patch: Partial<typeof filter>) => { setFilter(current => ({ ...current, ...patch })); setOffset(0); };

  if (report.isPending) return <Spinner label="正在读取用量明细…"/>;
  if (report.isError) return <Banner tone="danger" action={{ label: '重试', onClick: () => void report.refetch() }}>用量明细读取失败：{report.error.message}</Banner>;
  const data = report.data;
  const totals = data.totals as UsageTotals;
  const unknown = unknownCount(totals);

  return <div className="space-y-5">
    <p className="text-caption text-secondary">日期按 Dutydeck 服务所在的时区切分：{data.timezone.name}（{utcOffset(data.timezone.offsetMinutes)}），与浏览器时区无关。开始日与结束日都含当天。</p>
    <form className="grid gap-3 sm:grid-cols-3" aria-label="明细筛选" onSubmit={event => event.preventDefault()}>
      <Field label="开始日期"><Input type="date" value={from || data.range.from} max={to || data.range.to} onChange={event => { setFrom(event.target.value); setOffset(0); }}/></Field>
      <Field label="结束日期"><Input type="date" value={to || data.range.to} min={from || data.range.from} onChange={event => { setTo(event.target.value); setOffset(0); }}/></Field>
      <Field label="型号"><Select value={filter.model} onChange={event => change({ model: event.target.value })}>
        <option value="">全部型号</option>
        {data.options.models.map(model => <option key={model ?? usageUnknownModel} value={model ?? usageUnknownModel}>{model ?? unknownModelLabel}</option>)}
      </Select></Field>
      <Field label="Agent"><Select value={filter.agentId} onChange={event => change({ agentId: event.target.value })}><option value="">全部 Agent</option>{data.options.agentIds.map(id => <option key={id} value={id}>{id}</option>)}</Select></Field>
      <Field label="机器人"><Select value={filter.appId} onChange={event => change({ appId: event.target.value })}><option value="">全部机器人</option>{data.options.appIds.map(id => <option key={id} value={id}>{botName(id)}</option>)}</Select></Field>
      <Field label="来源"><Select value={filter.origin} onChange={event => change({ origin: event.target.value })}><option value="">全部来源</option>{data.options.origins.map(id => <option key={id} value={id}>{id}</option>)}</Select></Field>
    </form>
    <Card as="section" tone="muted" padding="md" className="space-y-1" aria-label="明细合计">
      <p className="text-caption text-secondary">{data.range.from} 至 {data.range.to} 合计</p>
      <p className="text-title font-semibold text-primary">已知费用 {usd(totals.costUsd)}</p>
      <p className="text-caption text-secondary">{usageText(totals)}</p>
    </Card>
    {unknown > 0 && <Banner tone="warning">部分用量未知：{count(unknown)} 次任务的费用算不出来（{count(totals.unpriced ?? 0)} 次缺单价、{count(totals.unavailable)} 次无用量数据），没有计入上面的已知费用，也不等于 0；月度上限只按已知费用判断，可能不准。</Banner>}
    {!totals.entries ? <EmptyState title="这个范围内没有用量记录" description="换一个日期范围或清除筛选。"/> : <>
      <DailyTrend from={data.range.from} to={data.range.to} rows={data.daily as UsageGroup[]}/>
      <Breakdown title="按型号" rows={data.models as UsageGroup[]} label={row => row.model ?? unknownModelLabel}/>
      <Breakdown title="按 Agent" rows={data.agents as UsageGroup[]} label={row => row.agentId ?? '未记录'}/>
      <Breakdown title="按机器人" rows={data.bots as UsageGroup[]} label={row => botName(row.appId)}/>
      <Breakdown title="按来源" rows={data.origins as UsageGroup[]} label={row => row.origin ?? '未记录'}/>
      <TaskList page={tasks.data?.tasks ?? []} total={tasks.data?.total ?? 0} offset={offset} setOffset={setOffset} loading={tasks.isPending || tasks.isFetching} botName={botName} onOpenTask={onOpenTask}/>
    </>}
    {tasks.isError && <Banner tone="danger" action={{ label: '重试', onClick: () => void tasks.refetch() }}>任务明细读取失败：{tasks.error.message}</Banner>}
  </div>;
}
