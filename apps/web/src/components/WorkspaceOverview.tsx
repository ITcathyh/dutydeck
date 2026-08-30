import { AlertTriangle, Archive, ArrowUpRight, Bot, CheckCircle2, CircleDot, FolderKanban, ListEnd, MessageSquare, Plus, Radio, Sparkles } from 'lucide-react';
import type { Agent, RunSummary, Session } from '../api';
import { groupSessionsByWorkspace, shortRunId, type WorkbenchView, workbenchCounts } from '../workspace-model';
import { fallbackRunTitle } from '../run-summary';
import { stateLabels, stateTone } from './ui';

export function WorkspaceOverview({ sessions, summaries, agents, loading, larkBots, view, onViewChange, onSelect, onCreate, onOpenLark }: {
  sessions: Session[];
  summaries: Record<string, RunSummary>;
  agents: Agent[];
  loading: boolean;
  larkBots: number;
  view: WorkbenchView;
  onViewChange(view: WorkbenchView): void;
  onSelect(id: string): void;
  onCreate(): void;
  onOpenLark(): void;
}) {
  const counts = workbenchCounts(sessions, summaries);
  const workspaces = groupSessionsByWorkspace(sessions, view, summaries);
  const recent = workspaces.flatMap(workspace => workspace.sessions.map(session => ({ session, workspace }))).sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt)).slice(0, 6);
  const metrics: Array<{ id: WorkbenchView; label: string; Icon: typeof FolderKanban; tone: string; surface: string }> = [
    { id: 'all', label: '全部运行', Icon: FolderKanban, tone: 'text-slate-700', surface: 'bg-white' },
    { id: 'active', label: '正在推进', Icon: Radio, tone: 'text-teal-700', surface: 'bg-teal-50' },
    { id: 'queued', label: '排队等待', Icon: ListEnd, tone: 'text-indigo-700', surface: 'bg-indigo-50' },
    { id: 'attention', label: '等待处理', Icon: CircleDot, tone: 'text-amber-700', surface: 'bg-amber-50' },
    { id: 'failed', label: '需要恢复', Icon: AlertTriangle, tone: 'text-rose-700', surface: 'bg-rose-50' },
    { id: 'completed', label: '已经完成', Icon: CheckCircle2, tone: 'text-emerald-700', surface: 'bg-emerald-50' },
    { id: 'archived', label: '已经归档', Icon: Archive, tone: 'text-slate-500', surface: 'bg-slate-50' }
  ];
  const selectedLabel = metrics.find(metric => metric.id === view)?.label ?? '全部运行';
  return <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--canvas)]">
    <div className="mx-auto w-full max-w-[1180px] px-5 pb-12 pt-14 sm:px-8 sm:pt-12 lg:px-12">
      <section className="relative overflow-hidden rounded-[28px] border border-slate-800 bg-[var(--ink)] px-6 py-7 text-white shadow-[0_24px_70px_rgba(15,23,42,.18)] sm:px-8 sm:py-9">
        <div className="workbench-grid absolute inset-0 opacity-30"/>
        <div className="relative flex flex-col gap-7 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl"><div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[.18em] text-teal-300"><Radio size={13}/>Local agent operations</div><h1 className="mt-4 text-3xl font-semibold tracking-[-.045em] sm:text-4xl">把目标交给 Agent，<br className="hidden sm:block"/>把进展留在眼前。</h1><p className="mt-4 max-w-xl text-sm leading-6 text-slate-300">从工作区组织任务，集中查看正在执行、等待确认和需要恢复的运行。</p></div>
          <button type="button" onClick={onCreate} className="group flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-teal-300 px-4 text-sm font-semibold text-slate-950 shadow-[0_8px_30px_rgba(94,234,212,.18)] transition hover:bg-teal-200 active:scale-[.98]"><Plus size={16}/>创建任务<ArrowUpRight size={15} className="transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"/></button>
        </div>
      </section>

      <section aria-label="运行概览" className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
        {metrics.map(({ id, label, Icon, tone, surface }) => <button type="button" aria-pressed={view === id} onClick={() => onViewChange(id)} key={id} className={`rounded-2xl border p-4 text-left shadow-[0_1px_2px_rgba(15,23,42,.03)] transition hover:-translate-y-0.5 hover:shadow-md ${view === id ? 'border-slate-500 ring-2 ring-slate-900/10' : 'border-slate-200/80'} ${surface}`}><div className="flex items-center justify-between"><span className="text-[10px] font-semibold uppercase tracking-[.08em] text-slate-500">{label}</span><Icon size={15} className={tone}/></div><div className={`mt-3 text-3xl font-semibold tracking-[-.04em] tabular-nums ${tone}`}>{loading ? '—' : counts[id]}</div></button>)}
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1.55fr)_minmax(280px,.75fr)]">
        <section><div className="mb-3 flex items-end justify-between"><div><h2 className="text-base font-semibold tracking-[-.025em] text-slate-900">{view === 'all' ? '最近运行' : selectedLabel}</h2><p className="mt-1 text-xs text-slate-500">{view === 'all' ? '跨工作区继续上一次任务' : `跨工作区查看${selectedLabel}的任务`}</p></div><span className="text-[10px] font-medium uppercase tracking-[.12em] text-slate-400">Latest activity</span></div>
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_8px_28px_rgba(15,23,42,.045)]">{loading ? <div className="space-y-3 p-5"><div className="h-12 animate-pulse rounded-xl bg-slate-100"/><div className="h-12 animate-pulse rounded-xl bg-slate-100"/></div> : recent.length ? recent.map(({ session, workspace }, index) => { const agent = agents.find(item => item.id === session.agentId); const summary = summaries[session.id]; return <button type="button" key={session.id} onClick={() => onSelect(session.id)} className={`group flex w-full items-center gap-3 px-4 py-3.5 text-left transition hover:bg-slate-50 ${index ? 'border-t border-slate-100' : ''}`}><span className={`h-2 w-2 shrink-0 rounded-full ${session.archivedAt ? 'bg-slate-400' : stateTone[session.state] ?? 'bg-slate-400'}`}/><span className="min-w-0 flex-1"><strong className="block truncate text-[13px] font-semibold text-slate-800" title={summary?.prompt}>{summary?.prompt ?? fallbackRunTitle(session.source)}</strong><span className="mt-0.5 block truncate text-[11px] text-slate-500">{workspace.name} · {agent?.name ?? session.agentId} · <span className="font-mono text-[9px]">RUN {shortRunId(session)}</span></span></span><span className="shrink-0 text-[10px] font-medium text-slate-500">{session.archivedAt ? '已归档' : stateLabels[session.state] ?? session.state}</span><ArrowUpRight size={14} className="shrink-0 text-slate-300 transition group-hover:text-teal-600"/></button>; }) : <div className="px-6 py-12 text-center"><CheckCircle2 size={22} className="mx-auto text-teal-600"/><h3 className="mt-3 text-sm font-semibold text-slate-800">当前视图没有任务运行</h3><p className="mt-1 text-xs text-slate-500">选择其他状态，或创建一个新任务。</p></div>}</div>
        </section>

        <aside><div className="mb-3"><h2 className="text-base font-semibold tracking-[-.025em] text-slate-900">接入与协作</h2><p className="mt-1 text-xs text-slate-500">让任务从更多入口抵达</p></div><button type="button" onClick={onOpenLark} className="group w-full rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-[0_8px_28px_rgba(15,23,42,.04)] transition hover:border-teal-200 hover:shadow-[0_12px_36px_rgba(13,148,136,.08)]"><div className="flex items-start"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#3370ff] text-white"><MessageSquare size={18}/></span><span className="ml-auto flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[.1em] text-slate-400 group-hover:text-teal-700">Configure <ArrowUpRight size={12}/></span></div><div className="mt-5 text-sm font-semibold text-slate-900">飞书指挥台</div><p className="mt-1.5 text-xs leading-5 text-slate-500">{larkBots ? `${larkBots} 个机器人已接入。随时从飞书下达任务、跟进执行。` : '接入机器人，从飞书下达任务、接收进展并协同 Agent。'}</p><div className="mt-4 flex items-center gap-2 text-[10px] text-slate-400"><Bot size={12}/><span>消息 · 卡片 · 群协作</span><Sparkles size={11} className="ml-auto text-teal-500"/></div></button></aside>
      </div>
    </div>
  </div>;
}
