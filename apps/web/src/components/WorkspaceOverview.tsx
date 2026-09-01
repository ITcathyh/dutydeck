import { AlertTriangle, Archive, ArrowRight, CheckCircle2, CircleDot, Clock3, Keyboard, MessageSquare, Plus, Radio, Search } from 'lucide-react';
import type { ReactNode } from 'react';
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
  workbenchViewLabels,
  workbenchViewOrder,
  workspaceName
} from '../workspace-model';
import { fallbackRunTitle } from '../run-summary';
import { createTaskAffordance, effectiveStatus, stateBadgeStyle } from './ui';

type OverviewProps = {
  sessions: Session[];
  summaries: Record<string, RunSummary>;
  agents: Agent[];
  loading: boolean;
  agentsLoading?: boolean;
  larkBots: number;
  larkBotsLoading?: boolean;
  view: WorkbenchView;
  onViewChange(view: WorkbenchView): void;
  onSelect(id: string): void;
  onCreate(): void;
  onOpenAgentSetup(): void;
  onOpenLarkSetup(): void;
  onOpenSearch?(): void;
  onOpenShortcuts?(): void;
  themeControl?: ReactNode;
};

const filterIcons: Record<WorkbenchView, typeof Radio> = {
  all: CircleDot,
  // 「待你处理」现在把失败/已停止也收进来，仍用警示图标，与它在信息层级里的优先级一致。
  attention: AlertTriangle,
  active: Radio,
  completed: CheckCircle2,
  archived: Archive
};

// 分区标题与副标题的唯一副本。副标题必须与 workbenchTaskSection 的实际归类一致。
//
// recent 是 workbenchTaskSection 的兜底分支（`return 'recent'`），但兜底不等于「装得很多」：
// 穷举 11 个 session 状态 × queuedCount 有无（共 22 种组合）后，落到 recent 的只有
// 「completed 且没有排队指令」这一种——attention 收走了 created/idle/interrupted/
// waiting_for_permission/failed/stopped，active 收走了 starting/thinking/running_tool/
// interrupting 以及任何「有排队指令」的组合（包括 completed 且排了指令的）。
// 既然这个分区装的就是筛选芯片「已完成」那一批，标题也叫「已完成」：叫「最近」会让
// 用户按芯片名在总览页找不到对应分区。分区 key 仍是 recent（内部标识，taskSectionRank、
// data-task-priority 与多处测试都用它），只有用户可见文案对齐芯片。
// 将来若给 sessionStates 加了新状态而没同时归入 attention/active，它会默默落到这里，
// 那时要改的是 workbenchTaskSection 的归类，以及这里的标题与副标题。
const sectionCopy: Record<WorkbenchTaskSection, { title: string; description: string }> = {
  attention: { title: '待你处理', description: '需要授权、补充指令、修正失败或恢复的任务' },
  active: { title: '进行中', description: 'Agent 正在执行或已排队等待执行' },
  recent: { title: '已完成', description: '已交付且没有后续排队指令的任务' }
};

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
  const status = effectiveStatus(session).label;
  return <button
    type="button"
    data-task-priority={section}
    onClick={() => onSelect(session.id)}
    className="group flex min-h-[72px] w-full items-start gap-3 border-t border-[var(--border-subtle)] px-4 py-3 text-left first:border-t-0 hover:bg-[var(--surface-hover)] sm:items-center sm:px-5"
  >
    <span className={`mt-0.5 inline-flex h-7 shrink-0 items-center rounded-full border px-2 text-xs font-semibold sm:mt-0 ${stateBadgeStyle(session)}`}>{status}</span>
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

export function WorkspaceOverview({ sessions, summaries, agents, loading, agentsLoading = false, larkBots, larkBotsLoading = false, view, onViewChange, onSelect, onCreate, onOpenAgentSetup, onOpenLarkSetup, onOpenSearch, onOpenShortcuts, themeControl }: OverviewProps) {
  const counts = workbenchCounts(sessions, summaries);
  const ordered = orderSessionsForWorkbench(sessions, view, summaries);
  const selectedLabel = workbenchViewLabels[view];
  const createTask = createTaskAffordance({ agents, agentsLoading, onCreate, onPrepareAgents: onOpenAgentSetup });
  const sections: Array<{ id: WorkbenchTaskSection; sessions: Session[] }> = view === 'all'
    ? (['attention', 'active', 'recent'] as WorkbenchTaskSection[]).map(id => ({ id, sessions: ordered.filter(session => workbenchTaskSection(session, summaries[session.id]) === id) })).filter(section => section.sessions.length > 0)
    : [{ id: view === 'active' ? 'active' : view === 'attention' ? 'attention' : 'recent', sessions: ordered }];

  return <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--surface-canvas)]">
    <section aria-labelledby="workspace-overview-title" className="mx-auto w-full max-w-[1120px] px-4 pb-12 pt-14 sm:px-8 sm:pt-8 lg:px-10">
      <header className="flex flex-col gap-4 border-b border-[var(--border-default)] pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-[var(--text-secondary)]">任务中心</p>
          <h1 id="workspace-overview-title" className="mt-1 text-2xl font-semibold tracking-[-.035em] text-[var(--text-primary)] sm:text-[28px]">今天需要推进什么？</h1>
          {/* 这句话里的数字必须来自 counts，与下面的筛选芯片同源；分区标题也数同一个集合。 */}
          <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">{loading || agentsLoading ? '正在同步任务状态…' : counts.all === 0 ? (agents.length ? '还没有任务。写下第一个目标，让 Agent 开始执行。' : '还没有任务。先准备 Agent，再创建第一个任务。') : counts.attention ? `${counts.attention} 个任务需要你先处理，${counts.active} 个正在进行。` : counts.active ? `没有阻塞项，${counts.active} 个任务正在进行。` : '当前任务都已处理，可以开始一个新目标。'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onOpenSearch && <button type="button" onClick={onOpenSearch} className="flex min-h-10 flex-1 items-center gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--surface-default)] px-3 text-sm text-[var(--text-muted)] hover:border-[var(--action-primary)] hover:text-[var(--text-primary)] sm:flex-none sm:w-64"><Search aria-hidden="true" size={15}/><span className="min-w-0 flex-1 truncate text-left">搜索任务目标、工作区或 Agent</span><kbd className="hidden shrink-0 rounded border border-[var(--border-default)] bg-[var(--surface-muted)] px-1.5 font-sans text-[11px] font-semibold sm:inline">Ctrl K</kbd></button>}
          {themeControl}
          {onOpenShortcuts && <button type="button" onClick={onOpenShortcuts} aria-label="查看键盘快捷键" title="查看键盘快捷键" className="hidden min-h-10 min-w-10 place-items-center rounded-lg border border-[var(--border-default)] bg-[var(--surface-default)] text-[var(--text-secondary)] hover:border-[var(--action-primary)] hover:text-[var(--action-primary)] sm:grid"><Keyboard aria-hidden="true" size={16}/></button>}
          <button type="button" disabled={createTask.disabled} onClick={createTask.onClick} className="flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-[var(--action-primary)] px-4 text-sm font-semibold text-[var(--text-on-action)] hover:bg-[var(--action-primary-hover)] active:translate-y-px disabled:opacity-60"><Plus size={17}/>{createTask.label}</button>
        </div>
      </header>

      <section aria-label="任务筛选" className="-mx-1 mt-4 overflow-x-auto px-1 pb-1">
        <div className="flex min-w-max items-center gap-2">
          {workbenchViewOrder.map(id => {
            const Icon = filterIcons[id];
            return <button
              type="button"
              aria-pressed={view === id}
              onClick={() => onViewChange(id)}
              key={id}
              className={`flex min-h-10 items-center gap-2 rounded-lg border px-3 text-sm font-medium ${view === id ? 'border-[var(--action-primary)] bg-[var(--action-soft)] text-[var(--action-primary)]' : 'border-[var(--border-default)] bg-[var(--surface-default)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'}`}
            ><Icon aria-hidden="true" size={15}/><span>{workbenchViewLabels[id]}</span><strong className="font-mono text-xs tabular-nums">{loading ? '—' : counts[id]}</strong></button>;
          })}
          {!loading && counts.queuedCommands > 0 && <span className="flex min-h-10 items-center rounded-lg border border-dashed border-[var(--border-default)] px-3 text-xs text-[var(--text-muted)]">另有待执行指令 {counts.queuedCommands} 条</span>}
        </div>
      </section>

      <div className="mt-5 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
        <section aria-label="任务列表" className="min-w-0">
          {loading || agentsLoading ? <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-default)] p-4"><div className="h-16 animate-pulse rounded-lg bg-[var(--surface-muted)]"/><div className="mt-2 h-16 animate-pulse rounded-lg bg-[var(--surface-muted)]"/></div> : sections.length && ordered.length ? <div className="space-y-6">{sections.map(section => <section key={section.id} aria-labelledby={`task-section-${section.id}`}>
            <div className="mb-2 flex items-baseline justify-between gap-3"><div><h2 id={`task-section-${section.id}`} className="text-base font-semibold text-[var(--text-primary)]">{view === 'all' ? sectionCopy[section.id].title : selectedLabel}</h2><p className="mt-0.5 text-xs leading-5 text-[var(--text-secondary)]">{view === 'all' ? sectionCopy[section.id].description : '按最近更新排序'}</p></div><span className="text-xs font-medium tabular-nums text-[var(--text-muted)]">{section.sessions.length} 个</span></div>
            <div className="overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-default)]">{section.sessions.map(session => <TaskRow key={session.id} session={session} summary={summaries[session.id]} agent={agents.find(agent => agent.id === session.agentId)} section={section.id} onSelect={onSelect}/>)}</div>
          </section>)}</div> : view === 'all' && sessions.length === 0 ? <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-default)] px-5 py-7 sm:px-7"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--action-soft)] text-[var(--action-primary)]"><Plus size={19}/></span><h2 className="mt-4 text-base font-semibold text-[var(--text-primary)]">{agents.length ? '从第一个明确目标开始' : '先准备一个可用 Agent'}</h2><p className="mt-1 max-w-xl text-sm leading-6 text-[var(--text-secondary)]">{agents.length ? '描述要完成的事情，选择工作目录和 Agent；创建后会立即开始执行。' : 'Dockmux 会自动发现这台机器上已安装并登录的 Agent CLI。准备完成后，就能创建任务或把它连接到飞书。'}</p><div className="mt-5 flex flex-wrap gap-2"><button type="button" disabled={createTask.disabled} onClick={createTask.onClick} className="flex min-h-10 items-center gap-2 rounded-lg bg-[var(--action-primary)] px-4 text-sm font-semibold text-[var(--text-on-action)] disabled:opacity-60">{agents.length ? '创建第一个任务' : createTask.label}<ArrowRight size={15}/></button><button type="button" onClick={onOpenLarkSetup} className="flex min-h-10 items-center gap-2 rounded-lg border border-[var(--border-default)] px-4 text-sm font-medium text-[var(--text-primary)] hover:border-[var(--action-primary)]">绑定飞书 Bot</button></div></div> : <div className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-default)] px-6 py-10 text-center"><CheckCircle2 size={22} className="mx-auto text-[var(--status-success)]"/><h2 className="mt-3 text-sm font-semibold text-[var(--text-primary)]">当前视图没有任务</h2><p className="mt-1 text-sm text-[var(--text-secondary)]">选择其他状态，或创建一个新任务。</p></div>}
        </section>

        <aside aria-label="协作入口" className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-default)] p-4">
          <div className="flex items-center gap-2"><span className="grid h-9 w-9 place-items-center rounded-lg bg-[var(--status-info-soft)] text-[var(--status-info)]"><MessageSquare size={17}/></span><div><h2 className="text-sm font-semibold text-[var(--text-primary)]">飞书协作</h2><p className="text-xs text-[var(--text-secondary)]">{larkBotsLoading ? '正在读取接入状态…' : larkBots ? `${larkBots} 个机器人已接入` : '尚未接入机器人'}</p></div></div>
          <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">在飞书中下达任务、跟进执行与接收结果。</p>
          <button type="button" onClick={onOpenLarkSetup} className="mt-3 flex min-h-10 w-full items-center justify-between rounded-lg border border-[var(--border-default)] px-3 text-sm font-medium text-[var(--text-primary)] hover:border-[var(--action-primary)] hover:text-[var(--action-primary)]"><span>{larkBots ? '管理飞书 Bot' : '绑定飞书 Bot'}</span><ArrowRight size={15}/></button>
          <div className="mt-3 flex items-center gap-1.5 border-t border-[var(--border-subtle)] pt-3 text-xs text-[var(--text-muted)]"><Clock3 size={13}/><span>消息、卡片和群协作共用同一任务上下文</span></div>
        </aside>
      </div>
    </section>
  </div>;
}
