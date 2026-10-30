import { useEffect, useState } from 'react';
import { useQueries, useQuery, type Query } from '@tanstack/react-query';
import type { AutomationScheduleSummary } from '@dutydeck/shared';
import { api, ApiError, type Agent, type RunSummary, type Session } from '../api';
import { currentInstance, instanceHomePath, instancePagePath } from '../instance';
import { useExperimental } from '../experimental';
import { Banner, Button, Card, EmptyState, Spinner, Input, Field, Select } from './primitives';
import { NewSessionModal, type NewSessionModalProps } from './NewSessionModal';
import { ScheduleFoundationPanel } from './ScheduleFoundationPanel';
import { scheduleNextExecution, scheduleRule, SessionAutomationPanel } from './SessionAutomationPanel';
import { AutomationRunDetail } from './AutomationRunDetail';
import { automationTime } from './AutomationHistory';

const healthLabels = { blocked: '等待人工核对', queued: '等待执行资源', running: '正在执行', delivery: '等待结果投递', disabled: '已停用', ready: '等待到期', error: '需要处理错误' };
const pageSize = 20;
const poll = (query: Query) => query.state.error ? false : 10_000;
const coverage = (error: Error) => error instanceof ApiError && error.status === 403 ? '无权限（forbidden）' : error instanceof ApiError && [404, 405].includes(error.status) ? '版本不支持（unsupported）' : '未连通（unavailable）';

function PlanState({ item, instanceId }: { item: AutomationScheduleSummary; instanceId: string }) {
  const { schedule, blocker, overdue } = item;
  const wait = blocker ? Math.max(0, Math.floor((Date.now() - new Date(blocker.waitingSince).getTime()) / 60_000)) : 0;
  return <div className="space-y-1 text-caption">
    <p className={item.health === 'blocked' || item.health === 'error' ? 'text-warning' : 'text-secondary'}>{healthLabels[item.health]}</p>
    {blocker && <div className="break-all text-warning">
      <p>{blocker.restricted ? '无权查看的执行正在占用所需资源' : blocker.taskId ? `阻塞来源：任务 ${blocker.taskId}${blocker.attemptId ? ` · 尝试 ${blocker.attemptId}` : ''}` : '阻塞来源暂时无法定位'} · 自 {automationTime(blocker.waitingSince, schedule.timezone)} 等待约 {wait} 分钟。{blocker.status === 'reconcile_required' ? '原执行结果未知；后续计划等待核对，不会自动重发。' : '等待此执行释放资源。'}</p>
      {!blocker.restricted && blocker.sessionId && blocker.taskId && <a className="text-link underline" href={`${instanceId ? `/instances/${instanceId}` : ''}/sessions/${encodeURIComponent(blocker.sessionId)}?reconcileTask=${encodeURIComponent(blocker.taskId)}#unknown-task-${encodeURIComponent(blocker.taskId)}`}>查看阻塞证据并核对</a>}
    </div>}
    {overdue && <p className="text-warning">受影响的原定时点区间：{automationTime(overdue.from, schedule.timezone)} 至 {automationTime(overdue.to, schedule.timezone)}（按日历推算，并非这些时点已经执行失败）。</p>}
  </div>;
}

export function AutomationOverview({ sessions, summaries = {}, onSelectSession, agents = [], capabilities, onOpenAgentSetup }: { agents?: Agent[]; capabilities?: NewSessionModalProps['capabilities']; onOpenAgentSetup?(): void; sessions: Session[]; summaries?: Record<string, RunSummary>; onSelectSession(sessionId: string): void }) {
  const [creating, setCreating] = useState(false);
  const [createdSession, setCreatedSession] = useState<Session>();
  const [selected, setSelected] = useState<{ sessionId: string; scheduleId?: string }>();
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [experimental] = useExperimental();
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState('');
  const [enabled, setEnabled] = useState('');
  const [health, setHealth] = useState('');
  const [scope, setScope] = useState('all');
  const [pages, setPages] = useState<Record<string, number>>({});
  const peers = useQuery({ queryKey: ['instances'], queryFn: api.instances, retry: false, staleTime: Infinity });
  const sources = [{ id: '', name: '主实例' }, ...(peers.data?.instances ?? [])];
  if (currentInstance() && !sources.some(item => item.id === currentInstance())) sources.push({ id: currentInstance()!, name: '当前实例' });
  const visibleSources = sources.filter(item => scope === 'all' || item.id === (scope === 'main' ? '' : scope));
  const params = new URLSearchParams(window.location.search);
  const runSession = params.get('automationSession'), runSchedule = params.get('schedule'), runId = params.get('run');
  const runOpen = Boolean(runSession && runSchedule && runId);
  const queries = useQueries({ queries: visibleSources.map(source => {
    const search = new URLSearchParams({ offset: String((pages[source.id] ?? 0) * pageSize), limit: String(pageSize), sort: 'attention' });
    if (name.trim()) search.set('name', name.trim());
    if (agentId.trim()) search.set('agentId', agentId.trim());
    if (enabled) search.set('enabled', enabled);
    if (health) search.set('health', health);
    return { queryKey: ['automation-schedules', source.id || null, search.toString()], queryFn: () => api.automationSchedules(search, source.id || null), retry: false, enabled: !selected && !runOpen, refetchInterval: poll, refetchIntervalInBackground: false };
  }) });
  const selectedId = selected?.sessionId;
  const selectedDetails = useQuery({ queryKey: ['session', currentInstance(), selectedId], queryFn: () => api.session(selectedId!), enabled: Boolean(selectedId) && !sessions.some(item => item.id === selectedId) && createdSession?.id !== selectedId, retry: false });
  const selectedSession = sessions.find(session => session.id === selectedId) ?? (createdSession?.id === selectedId ? createdSession : undefined) ?? selectedDetails.data;
  const failed = queries.filter(query => query.isError).length;
  const successful = queries.filter(query => query.isSuccess);
  const counts = successful.reduce<Record<string, number>>((sum, query) => { for (const [key, value] of Object.entries(query.data!.counts)) sum[key] = (sum[key] ?? 0) + value; return sum; }, {});
  const reset = () => setPages({});
  const openPlan = (sourceId: string, sessionId: string, scheduleId?: string) => {
    if (sourceId === (currentInstance() ?? '')) setSelected({ sessionId, scheduleId });
    else window.location.assign(`${instanceHomePath(sourceId || undefined)}?${new URLSearchParams({ nav: 'automation', planSession: sessionId, ...(scheduleId ? { plan: scheduleId } : {}) })}`);
  };
  const deepSession = params.get('planSession');
  useEffect(() => {
    if (!deepSession) return;
    const deepPlan = params.get('plan');
    params.delete('planSession'); params.delete('plan');
    history.replaceState(history.state, '', `${window.location.pathname}?${params}`);
    setSelected({ sessionId: deepSession, scheduleId: deepPlan ?? undefined });
  }, [deepSession]);
  return <div className="min-w-0 space-y-5">
    {runOpen ? <><a className="text-link underline" href={instancePagePath('/?nav=automation')}>返回计划中心</a><AutomationRunDetail sessionId={runSession!} scheduleId={runSchedule!} occurrenceId={runId!}/></> : selected ? <section className="space-y-3">
      <Button onClick={() => setSelected(undefined)}>返回计划中心</Button>
      {selectedSession ? <><Button onClick={() => onSelectSession(selectedSession.id)}>打开所属任务</Button><SessionAutomationPanel key={selectedSession.id} session={selectedSession} initialScheduleId={selected.scheduleId} openCreateForm={!selected.scheduleId} taskTitle={summaries[selectedSession.id]?.prompt}/></> : selectedDetails.isError ? <Banner tone="danger">所属任务读取失败：{selectedDetails.error.message}</Banner> : <Spinner label="读取所属任务"/>}
    </section> : <section className="space-y-3" aria-label="计划中心">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-title font-semibold">计划中心</h2><Button variant="primary" onClick={() => setCreating(true)}>创建定时任务</Button></div>
      <p className="text-caption text-secondary">按异常优先显示定时任务，仅汇总已配置且有权访问的实例。协作委托请到 <a href={instancePagePath('/?nav=groups')} className="text-link underline">群聊管理</a> 查看。</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="实例"><Select value={scope} onChange={event => { setScope(event.target.value); reset(); }}><option value="all">全部已配置实例</option>{sources.map(source => <option key={source.id} value={source.id || 'main'}>{source.name}{source.id === currentInstance() ? '（当前）' : ''}</option>)}</Select></Field>
        <Field label="计划名称"><Input value={name} onChange={event => { setName(event.target.value); reset(); }}/></Field>
        <Field label="Agent"><Input value={agentId} onChange={event => { setAgentId(event.target.value); reset(); }} placeholder="Agent 标识"/></Field>
        <Field label="启用状态"><Select value={enabled} onChange={event => { setEnabled(event.target.value); reset(); }}><option value="">全部</option><option value="true">已启用</option><option value="false">已停用</option></Select></Field>
        <Field label="健康状态"><Select value={health} onChange={event => { setHealth(event.target.value); reset(); }}><option value="">全部</option>{Object.entries(healthLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></Field>
      </div>
      {peers.isError && <Banner tone="warning" action={{ label: '重试实例发现', onClick: () => void peers.refetch() }}>实例列表不可用，覆盖范围不完整（partial）。</Banner>}
      <p className="text-caption text-secondary" role="status">覆盖：{successful.length}/{visibleSources.length} 个实例已读取{failed || peers.isError ? ' · 部分覆盖（partial），失败范围不是零计划' : queries.some(query => query.isPending) ? ' · 正在读取' : ' · 已配置范围已读取'}。</p>
      {!!successful.length && <p className="text-caption text-secondary">已读取实例的全部计划（不随筛选变化）：{Object.entries(healthLabels).map(([key, label]) => `${label} ${counts[key] ?? 0}`).join(' · ')}{failed ? '；其他实例状态未知' : ''}</p>}
      {visibleSources.map((source, index) => {
        const query = queries[index]!;
        const page = pages[source.id] ?? 0;
        return <section key={source.id} className="space-y-2" aria-label={source.name}>
          <h3 className="text-body font-semibold">{source.name}{source.id === currentInstance() ? '（当前实例）' : ''}</h3>
          {query.isPending && <Spinner label="读取计划"/>}
          {query.isError && <Banner tone="warning" action={{ label: '重试', onClick: () => void query.refetch() }}>{coverage(query.error)}：无法确认此范围的计划数量。{query.error.message}</Banner>}
          {query.data && !query.isError && <>
            {!query.data.total && <EmptyState title="没有符合条件的会话定时计划" description="可调整筛选，或在当前实例创建计划。"/>}
            {query.data.items.map(item => <Card as="article" padding="sm" key={item.schedule.id} className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2"><strong className="break-words text-body">{item.schedule.name} · {item.schedule.enabled ? '已启用' : '已停用'}</strong><Button onClick={() => openPlan(source.id, item.session.id, item.schedule.id)}>查看 / 管理计划</Button></div>
              <p className="break-all text-caption text-subtle">{item.session.title || item.session.id} · {item.session.agentId} · {item.schedule.mode === 'independent' ? '独立计划，仅显式指令' : item.schedule.mode === 'fresh' ? '每次新会话，不带聊天历史' : '沿用任务上下文'}</p>
              <p className="text-caption text-secondary">{scheduleRule(item.schedule)}</p>
              <PlanState item={item} instanceId={source.id}/>
              <p className="text-caption text-secondary">{scheduleNextExecution(item.schedule)}</p>
              {item.schedule.disabledReason && <p className="text-caption text-warning">停用原因：{item.schedule.disabledReason === 'Session is no longer active' ? '来源任务已结束或归档' : item.schedule.disabledReason === 'Schedule authorization is no longer available' ? '计划执行权限已失效' : item.schedule.disabledReason}</p>}
              <details className="text-caption"><summary className="cursor-pointer">指令与最近运行</summary><p className="whitespace-pre-wrap break-words py-2">{item.schedule.prompt}</p>{item.latestOccurrence ? <a className="text-link underline" href={`${instanceHomePath(source.id || undefined)}?${new URLSearchParams({ nav: 'automation', automationSession: item.session.id, schedule: item.schedule.id, run: item.latestOccurrence.id })}`}>查看最近运行 · {automationTime(item.latestOccurrence.scheduledForUtc, item.schedule.timezone)}</a> : <p>尚无触发记录</p>}</details>
            </Card>)}
            {query.data.total > pageSize && <div className="flex flex-wrap items-center gap-2"><Button disabled={!page} onClick={() => setPages({ ...pages, [source.id]: page - 1 })}>上一页</Button><span className="text-caption">{source.name} · 计划第 {page * pageSize + 1}–{Math.min((page + 1) * pageSize, query.data.total)} 条 / {query.data.total} 条</span><Button disabled={(page + 1) * pageSize >= query.data.total} onClick={() => setPages({ ...pages, [source.id]: page + 1 })}>下一页</Button></div>}
          </>}
        </section>;
      })}
      <details><summary className="cursor-pointer text-caption">现有任务的 CI 等待与自动化</summary><div className="mt-2 flex flex-wrap gap-2">{sessions.map(session => <Button key={session.id} onClick={() => setSelected({ sessionId: session.id })}>{summaries[session.id]?.prompt || session.id} · CI / 计划</Button>)}</div></details>
    </section>}
    {creating && <NewSessionModal open mode="schedule" agents={agents} capabilities={capabilities} onClose={() => setCreating(false)} onOpenAgentSetup={onOpenAgentSetup ? () => { setCreating(false); onOpenAgentSetup(); } : undefined} onSessionCreated={session => { setCreatedSession(session); setSelected({ sessionId: session.id }); setCreating(false); }}/>}
    {experimental && <Card as="section" tone="muted" padding="md" className="space-y-2"><h2 className="text-body font-semibold">导入与管理草稿</h2><p className="text-caption text-secondary">仅保存草稿，草稿不会自动执行。</p><Button onClick={() => setDraftsOpen(true)}>管理草稿</Button></Card>}
    {experimental && <ScheduleFoundationPanel open={draftsOpen} onClose={() => setDraftsOpen(false)}/>}
  </div>;
}
