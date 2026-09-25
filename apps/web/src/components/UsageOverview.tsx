import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UsageCap, UsageCategory, UsageGroup, UsageTotals } from '@dutydeck/shared';
import { api, type LarkBotConfig, type UsageSummaryWindow } from '../api';
import { Banner, Button, Card, EmptyState, Field, Input, Select, Spinner, Tabs } from './primitives';

type UsageRange = 'month' | 'week';

const categoryLabels: Record<UsageCategory, string> = { explicit: '显式请求', proactive: '主动介入', scheduled: '定时', background: '后台' };
const usd = (value: number) => `$${value.toFixed(2)}`;
const count = (value: number) => value.toLocaleString('zh-CN');

/** 成本里估算的部分单独标出；PTY 等不上报用量的记录只计次数，不算进成本。 */
function usageText(totals: UsageTotals) {
  const parts = [`${usd(totals.costUsd)}${totals.estimatedCostUsd > 0 ? `（含估算 ${usd(totals.estimatedCostUsd)}）` : ''}`,
    `输入 ${count(totals.inputTokens)} · 输出 ${count(totals.outputTokens)} token`, `${count(totals.entries)} 次`];
  if (totals.unavailable) parts.push(`${count(totals.unavailable)} 次无用量数据`);
  return parts.join(' · ');
}

function UsageList({ title, rows, label }: { title: string; rows: UsageGroup[]; label(row: UsageGroup): string }) {
  return <section aria-label={title} className="space-y-2">
    <h3 className="text-body font-semibold">{title}</h3>
    {rows.length ? <ul className="divide-y divide-subtle rounded-md border border-subtle bg-surface">
      {rows.map(row => <li key={`${row.appId}:${row.chatId}:${row.actorId}:${row.category}`} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 p-3">
        <span className="min-w-0 break-all text-body text-primary">{label(row)}</span>
        <span className="text-caption text-secondary">{usageText(row)}</span>
      </li>)}
    </ul> : <p className="text-caption text-secondary">暂无记录。</p>}
  </section>;
}

// 用量汇总与月度上限都跨所有 Bot，服务端只对安装管理员开放；只在「用量与成本」打开时挂载。
export function UsageOverview({ bots }: { bots: LarkBotConfig[] }) {
  const [range, setRange] = useState<UsageRange>('month');
  const summary = useQuery({ queryKey: ['usage-summary'], queryFn: api.usageSummary, retry: false, refetchInterval: 30_000, refetchIntervalInBackground: false });
  const groups = useQuery({ queryKey: ['lark-management-groups'], queryFn: api.managementGroups, staleTime: 30_000, enabled: bots.length > 0 });
  const botName = (appId?: string) => appId ? bots.find(bot => bot.appId === appId)?.name ?? appId : '未归属 Bot（Web 任务等）';
  const chatName = (chatId?: string) => chatId ? groups.data?.groups.find(group => group.chatId === chatId)?.name ?? chatId : '';

  if (summary.isPending) return <Spinner label="正在读取用量…"/>;
  if (summary.isError) return <Banner tone="danger" action={{ label: '重试', onClick: () => void summary.refetch() }}>用量读取失败：{summary.error.message}</Banner>;
  const window: UsageSummaryWindow = summary.data[range];

  return <div className="space-y-5">
    <Tabs<UsageRange> value={range} onChange={setRange} label="统计区间" items={[{ id: 'month', label: '本月' }, { id: 'week', label: '近 7 天' }]}/>
    <Card as="section" tone="muted" padding="md" className="space-y-1" aria-label="合计">
      <p className="text-caption text-secondary">{range === 'month' ? '本月' : '近 7 天'}合计（自 {new Date(window.since).toLocaleString('zh-CN', { hour12: false })}）</p>
      <p className="text-title font-semibold text-primary">{usd(window.totals.costUsd)}</p>
      <p className="text-caption text-secondary">{usageText(window.totals)}</p>
      <p className="text-caption text-subtle">Claude 等上报成本的 Agent 按上报值记；Codex 只报 token，按单价表估算并标为估算；PTY 终端 Agent 不上报用量。编排子步骤计入发起它的任务所在的群。</p>
    </Card>
    {!window.totals.entries ? <EmptyState title="暂无用量记录" description="任务执行完一轮后会在这里出现。"/> : <>
      <UsageList title="按机器人" rows={window.bots} label={row => botName(row.appId)}/>
      <UsageList title="按群" rows={window.chats} label={row => row.chatId ? `${chatName(row.chatId)} · ${botName(row.appId)}` : '不在群内（Web 任务、后台记忆等）'}/>
      <UsageList title="按触发人" rows={window.actors} label={row => row.actorId ?? '未记录触发人'}/>
      <UsageList title="按来源" rows={window.categories} label={row => row.category ? categoryLabels[row.category] : '未分类'}/>
    </>}
    <UsageCaps bots={bots} caps={summary.data.caps} month={summary.data.month} botName={botName} chatName={chatName} groups={groups.data?.groups ?? []}/>
  </div>;
}

function UsageCaps({ bots, caps, month, botName, chatName, groups }: { bots: LarkBotConfig[]; caps: UsageCap[]; month: UsageSummaryWindow; botName(appId?: string): string; chatName(chatId?: string): string; groups: Array<{ chatId: string; name: string; bots: Array<{ appId: string }> }> }) {
  const qc = useQueryClient();
  const [scope, setScope] = useState<UsageCap['scope']>('bot');
  const [pickedAppId, setAppId] = useState('');
  // 机器人列表可能在面板打开后才读到，未选择时跟随第一个。
  const appId = pickedAppId || bots[0]?.appId || '';
  const [chatId, setChatId] = useState('');
  const [amount, setAmount] = useState('');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['usage-summary'] });
  const save = useMutation({ mutationFn: api.setUsageCap, onSuccess: () => { setAmount(''); refresh(); } });
  const remove = useMutation({ mutationFn: api.deleteUsageCap, onSuccess: refresh });
  const used = (cap: UsageCap) => (cap.scope === 'bot' ? month.bots.find(row => row.appId === cap.appId) : month.chats.find(row => row.appId === cap.appId && row.chatId === cap.chatId))?.costUsd ?? 0;
  // 可选的群：该 Bot 所在的群，加上本月在账本里出现过的群。
  const chatOptions = [...new Set([...groups.filter(group => group.bots.some(bot => bot.appId === appId)).map(group => group.chatId),
    ...month.chats.filter(row => row.appId === appId && row.chatId?.startsWith('oc_')).map(row => row.chatId!), ...(chatId ? [chatId] : [])])];
  const monthlyCostUsd = Number(amount);
  const ready = Boolean(appId) && monthlyCostUsd > 0 && (scope === 'bot' || Boolean(chatId));
  const edit = (cap: UsageCap) => { setScope(cap.scope); setAppId(cap.appId); setChatId(cap.chatId ?? ''); setAmount(String(cap.monthlyCostUsd)); };

  return <Card as="section" padding="md" className="space-y-3" aria-label="月度成本上限">
    <h3 className="text-body font-semibold">月度成本上限</h3>
    <p className="text-caption text-secondary">默认不设上限。本月用到上限的 75% 和 95% 时各在群里提醒一次，用满后第一次拒绝新任务时再通知一次；之后新任务在派发前被拒绝并说明原因，正在执行的任务不受影响。下月 1 日起重新计算。</p>
    {caps.length ? <ul className="divide-y divide-subtle rounded-md border border-subtle bg-surface">
      {caps.map(cap => <li key={`${cap.scope}:${cap.appId}:${cap.chatId ?? ''}`} className="flex flex-wrap items-center justify-between gap-2 p-3">
        <span className="min-w-0 break-all text-body text-primary">{cap.scope === 'bot' ? `机器人 ${botName(cap.appId)}` : `群 ${chatName(cap.chatId)} · ${botName(cap.appId)}`}</span>
        <span className="text-caption text-secondary">本月 {usd(used(cap))} / 上限 {usd(cap.monthlyCostUsd)}（{Math.floor(used(cap) / cap.monthlyCostUsd * 100 + 1e-6)}%）</span>
        <span className="flex gap-2"><Button size="sm" onClick={() => edit(cap)}>修改</Button><Button size="sm" variant="danger" loading={remove.isPending && remove.variables?.appId === cap.appId && remove.variables?.chatId === cap.chatId} onClick={() => remove.mutate(cap)}>删除</Button></span>
      </li>)}
    </ul> : <p className="text-caption text-secondary">当前没有设置上限。</p>}
    {bots.length ? <form className="grid gap-3 sm:grid-cols-2" onSubmit={event => {
      event.preventDefault();
      if (ready) save.mutate(scope === 'bot' ? { scope, appId, monthlyCostUsd } : { scope, appId, chatId, monthlyCostUsd });
    }}>
      <Field label="范围"><Select value={scope} onChange={event => setScope(event.target.value as UsageCap['scope'])}><option value="bot">整个机器人</option><option value="group">单个群</option></Select></Field>
      <Field label="机器人"><Select value={appId} onChange={event => { setAppId(event.target.value); setChatId(''); }}>{bots.map(bot => <option key={bot.appId} value={bot.appId}>{bot.name}</option>)}</Select></Field>
      {scope === 'group' && <Field label="群" hint={chatOptions.length ? undefined : '暂未发现该机器人所在的群'}><Select value={chatId} onChange={event => setChatId(event.target.value)}><option value="">选择群</option>{chatOptions.map(id => <option key={id} value={id}>{chatName(id)}</option>)}</Select></Field>}
      <Field label="每月上限（美元）"><Input type="number" inputMode="decimal" min="0.01" step="0.01" value={amount} onChange={event => setAmount(event.target.value)}/></Field>
      <div className="flex items-end sm:col-span-2"><Button type="submit" variant="primary" disabled={!ready} loading={save.isPending}>保存上限</Button></div>
    </form> : <p className="text-caption text-secondary">尚未接入飞书机器人，暂无可设置上限的对象。</p>}
    {(save.error || remove.error) && <Banner tone="danger">{(save.error ?? remove.error)!.message}</Banner>}
  </Card>;
}
