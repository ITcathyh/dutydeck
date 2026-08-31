import { AlertTriangle, Archive, ArrowRight, CheckCircle2, CircleDot, Clock3, ListEnd, MessageSquare, Plus, Radio } from 'lucide-react';
import type { Agent, RunSummary, Session } from '../api';
import {
  attentionReasonForSession,
  formatRelativeTime,
  orderSessionsForWorkbench,
  shortRunId,
  type WorkbenchTaskSection,
  type WorkbenchView,
  workbenchCounts,
  workbenchTaskSection,
  workspaceName
} from '../workspace-model';
import { fallbackRunTitle } from '../run-summary';
import { stateLabels } from './ui';

type OverviewProps = {
  sessions: Session[];
  summaries: Record<string, RunSummary>;
  agents: Agent[];
  loading: boolean;
  larkBots: number;
  view: WorkbenchView;
  onViewChange(view: WorkbenchView): void;
  onSelect(id: string): void;
  onCreate(): void;
  onOpenAgentSetup(): void;
  onOpenLarkSetup(): void;
};

const filters: Array<{ id: WorkbenchView; label: string; Icon: typeof Radio }> = [
  { id: 'all', label: '总览', Icon: CircleDot },
  { id: 'attention', label: '待你处理', Icon: AlertTriangle },
  { id: 'active', label: '进行中', Icon: Radio },
  { id: 'queued', label: '有排队的运行', Icon: ListEnd },
  { id: 'failed', label: '失败', Icon: AlertTriangle },
  { id: 'completed', label: '已完成', Icon: CheckCircle2 },
  { id: 'archived', label: '已归档', Icon: Archive }
];

const sectionCopy: Record<WorkbenchTaskSection, { title: string; description: string }> = {
  attention: { title: '待你处理', description: '需要授权、补充指令或恢复的任务' },
  active: { title: '进行中', description: 'Agent 正在执行或已排队等待执行' },
  recent: { title: '最近', description: '已完成和最近更新的任务' }
};

function stateStyle(session: Session): string {
  if (session.archivedAt) return 'border-[var(--border-subtle)] bg-[var(--surface-muted)] text-[var(--text-muted)]';
  if (session.state === 'failed' || session.state === 'stopped') return 'border-[var(--status-danger-border)] bg-[var(--status-danger-soft)] text-[var(--status-danger)]';
  if (session.state === 'waiting_for_permission' || session.state === 'interrupted' || session.state === 'created' || session.state === 'idle') return 'border-[var(--status-warning-border)] bg-[var(--status-warning-soft)] text-[var(--status-warning)]';
  if (session.state === 'completed') return 'border-[var(--status-success-border)] bg-[var(--status-success-soft)] text-[var(--status-success)]';
  return 'border-[var(--status-info-border)] bg-[var(--status-info-soft)] text-[var(--status-info)]';
}

function TaskRow({ session, summary, agent, section, onSelect }: {
  session: Session;
  summary?: RunSummary;
  agent?: Agent;
  section: WorkbenchTaskSection;
  onSelect(id: string): void;
}) {
  const updatedAt = session.updatedAt || session.createdAt;
  const relativeTime = formatRelativeTime(updatedAt);
  const queuedCommands = summary?.queuedCount ?? 0;
  const status = session.archivedAt ? '已归档' : stateLabels[session.state] ?? session.state;
  return <button
    type="button"
    data-task-priority={section}
    onClick={() => onSelect(session.id)}
    className="group flex min-h-[72px] w-full items-start gap-3 border-t border-[var(--border-subtle)] px-4 py-3 text-left first:border-t-0 hover:bg-[var(--surface-hover)] sm:items-center sm:px-5"
  >
    <span className={`mt-0.5 inline-flex h-7 shrink-0 items-center rounded-full border px-2 text-xs font-semibold sm:mt-0 ${stateStyle(session)}`}>{status}</span>
    <span className="min-w-0 flex-1">
      <strong className="block truncate text-sm font-semibold leading-5 text-[var(--text-primary)]" title={summary?.prompt}>{summary?.prompt ?? fallbackRunTitle(session.source)}</strong>
      <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs leading-5 text-[var(--text-secondary)]">
        <span>{workspaceName(session.cwd)}</span><span aria-hidden="true">·</span><span>{agent?.name ?? session.agentId}</span>
        {section === 'attention' && <><span aria-hidden="true">·</span><span className="font-medium text-[var(--text-primary)]">{attentionReasonForSession(session)}</span></>}
        {queuedCommands > 0 && <span className="rounded-md bg-[var(--status-queued-soft)] px-1.5 py-0.5 font-medium text-[var(--status-queued)]">待执行指令 {queuedCommands} 条</span>}
      </span>
    </span>
    <span className="flex shrink-0 flex-col items-end gap-1 text-xs text-[var(--text-muted)]">
      <span title={updatedAt ? new Date(updatedAt).toLocaleString('zh-CN') : undefined}>更新于 {relativeTime}</span>
      <span className="hidden font-mono text-[11px] sm:block">{shortRunId(session)}</span>
    </span>
    <ArrowRight aria-hidden="true" size={16} className="mt-1 shrink-0 text-[var(--text-muted)] group-hover:text-[var(--action-primary)] sm:mt-0"/>
  </button>;
}

export function WorkspaceOverview({ sessions, summaries, agents, loading, larkBots, view, onViewChange, onSelect, onCreate, onOpenAgentSetup, onOpenLarkSetup }: OverviewProps) {
  const counts = workbenchCounts(sessions, summaries);
  const ordered = orderSessionsForWorkbench(sessions, view, summaries);
  const selectedLabel = filters.find(filter => filter.id === view)?.label ?? '总览';
  const blockingCount = counts.attention + counts.failed;
  const sections: Array<{ id: WorkbenchTaskSection; sessions: Session[] }> = view === 'all'
    ? (['attention', 'active', 'recent'] as WorkbenchTaskSection[]).map(id => ({ id, sessions: ordered.filter(session => workbenchTaskSection(session, summaries[session.id]) === id) })).filter(section => section.sessions.length > 0)
    : [{ id: view === 'active' || view === 'queued' ? 'active' : view === 'attention' || view === 'failed' ? 'attention' : 'recent', sessions: ordered }];

  return <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--surface-canvas)]">
    <section aria-labelledby="workspace-overview-title" className="mx-auto w-full max-w-[1120px] px-4 pb-12 pt-14 sm:px-8 sm:pt-8 lg:px-10">
      <header className="flex flex-col gap-4 border-b border-[var(--border-default)] pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-[var(--text-secondary)]">任务中心</p>
          <h1 id="workspace-overview-title" className="mt-1 text-2xl font-semibold tracking-[-.035em] text-[var(--text-primary)] sm:text-[28px]">今天需要推进什么？</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">{loading ? '正在同步任务状态…' : counts.all === 0 ? (agents.length ? '还没有任务。写下第一个目标，让 Agent 开始执行。' : '还没有任务。先准备 Agent，再创建第一个任务。') : blockingCount ? `${blockingCount} 个任务需要你先处理，${counts.active} 个正在进行。` : counts.active ? `没有阻塞项，${counts.active} 个任务正在进行。` : '当前任务都已处理，可以开始一个新目标。'}</p>
        </div>
        <button type="button" onClick={agents.length ? onCreate : onOpenAgentSetup} className="flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-[var(--action-primary)] px-4 text-sm font-semibold text-[var(--text-on-action)] hover:bg-[var(--action-primary-hover)] active:translate-y-px"><Plus size={17}/>{agents.length ? '创建任务' : '准备 Agent'}</button>
      </header>

      <section aria-label="运行概览" className="-mx-1 mt-4 overflow-x-auto px-1 pb-1">
        <div className="flex min-w-max items-center gap-2">
          {filters.map(({ id, label, Icon }) => <button
            type="button"
            aria-pressed={view === id}
            onClick={() => onViewChange(id)}
            key={id}
            className={`flex min-h-10 items-center gap-2 rounded-lg border px-3 text-sm font-medium ${view === id ? 'border-[var(--action-primary)] bg-[var(--action-soft)] text-[var(--action-primary)]' : 'border-[var(--border-default)] bg-[var(--surface-default)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'}`}
          ><Icon aria-hidden="true" size={15}/><span>{label}</span><strong className="font-mono text-xs tabular-nums">{loading ? '—' : counts[id]}</strong>{id === 'queued' && !loading && <span className="border-l border-current/20 pl-2 text-xs font-normal">待执行 {counts.queuedCommands} 条</span>}</button>)}
        </div>
      </section>

      <div className="mt-5 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
        <section aria-label="任务列表" className="min-w-0">
          {loading ? <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-default)] p-4"><div className="h-16 animate-pulse rounded-lg bg-[var(--surface-muted)]"/><div className="mt-2 h-16 animate-pulse rounded-lg bg-[var(--surface-muted)]"/></div> : sections.length && ordered.length ? <div className="space-y-6">{sections.map(section => <section key={section.id} aria-labelledby={`task-section-${section.id}`}>
            <div className="mb-2 flex items-baseline justify-between gap-3"><div><h2 id={`task-section-${section.id}`} className="text-base font-semibold text-[var(--text-primary)]">{view === 'all' ? sectionCopy[section.id].title : selectedLabel}</h2><p className="mt-0.5 text-xs leading-5 text-[var(--text-secondary)]">{view === 'all' ? sectionCopy[section.id].description : '按最近更新排序'}</p></div><span className="text-xs font-medium tabular-nums text-[var(--text-muted)]">{section.sessions.length} 个</span></div>
            <div className="overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-default)]">{section.sessions.map(session => <TaskRow key={session.id} session={session} summary={summaries[session.id]} agent={agents.find(agent => agent.id === session.agentId)} section={section.id} onSelect={onSelect}/>)}</div>
          </section>)}</div> : view === 'all' && sessions.length === 0 ? <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-default)] px-5 py-7 sm:px-7"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--action-soft)] text-[var(--action-primary)]"><Plus size={19}/></span><h2 className="mt-4 text-base font-semibold text-[var(--text-primary)]">{agents.length ? '从第一个明确目标开始' : '先准备一个可用 Agent'}</h2><p className="mt-1 max-w-xl text-sm leading-6 text-[var(--text-secondary)]">{agents.length ? '描述要完成的事情，选择工作目录和 Agent；创建后会立即开始执行。' : 'Dockmux 会自动发现这台机器上已安装并登录的 Agent CLI。准备完成后，就能创建任务或把它连接到飞书。'}</p><div className="mt-5 flex flex-wrap gap-2"><button type="button" onClick={agents.length ? onCreate : onOpenAgentSetup} className="flex min-h-10 items-center gap-2 rounded-lg bg-[var(--action-primary)] px-4 text-sm font-semibold text-[var(--text-on-action)]">{agents.length ? '创建第一个任务' : '查看 Agent 添加方法'}<ArrowRight size={15}/></button><button type="button" onClick={onOpenLarkSetup} className="flex min-h-10 items-center gap-2 rounded-lg border border-[var(--border-default)] px-4 text-sm font-medium text-[var(--text-primary)] hover:border-[var(--action-primary)]">绑定飞书 Bot</button></div></div> : <div className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-default)] px-6 py-10 text-center"><CheckCircle2 size={22} className="mx-auto text-[var(--status-success)]"/><h2 className="mt-3 text-sm font-semibold text-[var(--text-primary)]">当前视图没有任务</h2><p className="mt-1 text-sm text-[var(--text-secondary)]">选择其他状态，或创建一个新任务。</p></div>}
        </section>

        <aside aria-label="协作入口" className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-default)] p-4">
          <div className="flex items-center gap-2"><span className="grid h-9 w-9 place-items-center rounded-lg bg-[var(--status-info-soft)] text-[var(--status-info)]"><MessageSquare size={17}/></span><div><h2 className="text-sm font-semibold text-[var(--text-primary)]">飞书协作</h2><p className="text-xs text-[var(--text-secondary)]">{larkBots ? `${larkBots} 个机器人已接入` : '尚未接入机器人'}</p></div></div>
          <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">在飞书中下达任务、跟进执行与接收结果。</p>
          <button type="button" onClick={onOpenLarkSetup} className="mt-3 flex min-h-10 w-full items-center justify-between rounded-lg border border-[var(--border-default)] px-3 text-sm font-medium text-[var(--text-primary)] hover:border-[var(--action-primary)] hover:text-[var(--action-primary)]"><span>{larkBots ? '管理飞书 Bot' : '绑定飞书 Bot'}</span><ArrowRight size={15}/></button>
          <div className="mt-3 flex items-center gap-1.5 border-t border-[var(--border-subtle)] pt-3 text-xs text-[var(--text-muted)]"><Clock3 size={13}/><span>消息、卡片和群协作共用同一任务上下文</span></div>
        </aside>
      </div>
    </section>
  </div>;
}
