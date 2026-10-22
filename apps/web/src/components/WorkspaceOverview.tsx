import { useEffect, useState } from 'react';
import { AlertTriangle, Archive, ArrowRight, CheckCircle2, ChevronRight, CircleDot, MessageSquare, Search, Plus, Radio, Settings2 } from 'lucide-react';
import type { Agent, LarkBotConfig, RunSummary, Session } from '../api';
import {
  attentionReasonForSession,
  formatRelativeTime,
  orderSessionsForWorkbench,
  sessionAttention,
  type WorkbenchTaskSection,
  type WorkbenchView,
  workbenchCounts,
  workbenchTaskSection,
  workbenchViewLabels,
  workbenchViewOrder,
  sessionWorkspaceName
} from '../workspace-model';
import { fallbackRunTitle, sessionDisplayName } from '../run-summary';
import { Badge, Button, Card, EmptyState, Skeleton, StatusBadge } from './primitives';
import { createTaskAffordance } from './ui';
import { formatLarkNavSummary, projectLarkBotStatus } from '../lark-status';
import { shortcutDefinitions, workbenchViewShortcutIds } from '../useKeyboardShortcuts';

export type WorkspaceListFilters = { query: string; project: string };

type OverviewProps = {
  sessions: Session[];
  summaries: Record<string, RunSummary>;
  agents: Agent[];
  loading: boolean;
  agentsLoading?: boolean;
  larkBots: LarkBotConfig[];
  larkBotsLoading?: boolean;
  larkListeningDisabled?: boolean;
  larkBotsFailed?: boolean;
  larkBotsRetrying?: boolean;
  onRetryLarkBots?(): void;
  view: WorkbenchView;
  onViewChange(view: WorkbenchView): void;
  mode?: 'home' | 'tasks';
  filters?: WorkspaceListFilters;
  onFiltersChange?(filters: WorkspaceListFilters): void;
  onOpenChanges?(id: string): void;
  onSelect(id: string): void;
  onSelectAttention?(id: string): void;
  onBulkArchive?(ids: string[]): void;
  onCreate(): void;
  onOpenAgentSetup(): void;
  onOpenLarkSetup(): void;
  onManageBots?(): void;
};

const filterIcons: Record<WorkbenchView, typeof Radio> = {
  all: CircleDot,
  // 「待你处理」现在把失败/已停止也收进来，仍用警示图标，与它在信息层级里的优先级一致。
  attention: AlertTriangle,
  active: Radio,
  completed: CheckCircle2,
  archived: Archive
};

const sectionDot: Record<WorkbenchTaskSection, string> = {
  attention: 'bg-attention-solid', active: 'bg-info-solid', continue: 'bg-neutral-solid', recent: 'bg-success-solid'
};
const SECTION_PREVIEW = 5;
const viewShortcutKeys = (view: WorkbenchView) => shortcutDefinitions.find(definition => definition.id === workbenchViewShortcutIds[view])?.keys;
const sectionView: Record<WorkbenchTaskSection, WorkbenchView> = { attention: 'attention', active: 'active', continue: 'all', recent: 'completed' };
const sectionCopy: Record<WorkbenchTaskSection, { title: string; description: string }> = {
  attention: { title: '需要你处理', description: '需要决定或恢复的任务' },
  active: { title: '正在推进', description: 'Agent 正在执行或已排队等待执行' },
  continue: { title: '继续上次的工作', description: '可继续补充目标与指令' },
  recent: { title: '已完成', description: '本轮已完成，改动与验证分别检查' }
};

function TaskRow({ session, summary, agent, section, onSelect, selection }: {
  session: Session;
  summary?: RunSummary;
  agent?: Agent;
  section: WorkbenchTaskSection;
  onSelect(id: string): void;
  selection?: { checked: boolean; disabled: boolean; onChange(): void };
}) {
  const updatedAt = session.updatedAt || session.createdAt;
  const relativeTime = formatRelativeTime(updatedAt);
  const queuedCommands = summary?.queuedCount ?? 0;
  const title = sessionDisplayName(session, summary?.prompt, fallbackRunTitle(session.source));
  const attention = sessionAttention(session, summary);
  const checkboxLabel = sessionDisplayName(session, summary?.prompt, sessionWorkspaceName(session));
  return <div className={`flex border-t border-default first:border-t-0 ${section === 'attention' ? 'bg-surface' : ''}`}>
    {selection && <label className="flex min-h-10 min-w-10 shrink-0 cursor-pointer items-center justify-center pl-2" title={selection.disabled ? '此步骤由目标管理，请从原目标处理' : undefined}>
      <input type="checkbox" aria-label={`选择任务：${checkboxLabel}`} checked={selection.checked} disabled={selection.disabled} onChange={selection.onChange} className="h-4 w-4 accent-action"/>
    </label>}
    <button
    type="button"
    data-task-priority={section}
    onClick={() => onSelect(session.id)}
    className="group grid min-h-[72px] w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 px-4 py-3 text-left transition-colors duration-fast ease-out hover:bg-muted sm:flex sm:items-center sm:gap-3 sm:px-5"
  >
    {/* 徽标文案与归档优先判据都来自 effectiveStatus，由 StatusBadge 单点消费；这里不再拼配色字符串。 */}
    <span className="mt-0.5 shrink-0 sm:mt-0"><StatusBadge session={session}/></span>
    <span className="min-w-0 flex-1">
      <strong className="line-clamp-2 text-body font-medium text-primary sm:line-clamp-none sm:block sm:truncate" title={title}>{title}</strong>
      <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-caption text-secondary">
        <span>{sessionWorkspaceName(session)}</span><span aria-hidden="true">·</span><span>{agent?.name ?? session.agentId}</span>
        {section === 'attention' && <><span aria-hidden="true">·</span><span className="font-medium text-primary"><span>{attention === 'decision' ? '需要决定' : '需要恢复'}</span> · <span>{attentionReasonForSession(session)}</span></span></>}
        {queuedCommands > 0 && <span className="rounded-sm bg-queued-soft px-1.5 py-0.5 font-medium text-queued">待执行指令 {queuedCommands} 条</span>}
      </span>
    </span>
    <span className="col-span-2 flex shrink-0 items-center justify-between gap-1 text-caption text-subtle sm:flex-col sm:items-end">
      <span title={updatedAt ? new Date(updatedAt).toLocaleString('zh-CN') : undefined}>更新于 {relativeTime}</span>
      {session.state === 'waiting_for_permission' && <span className="font-medium text-action sm:hidden">查看审批 →</span>}
    </span>
    <ArrowRight aria-hidden="true" size={16} className="hidden shrink-0 text-subtle transition-[color,transform] duration-fast ease-out group-hover:translate-x-0.5 group-hover:text-action sm:block"/>
  </button></div>;
}

function headlineFor({ loading, agentsLoading, counts, hasAgents }: {
  loading: boolean;
  agentsLoading: boolean;
  counts: ReturnType<typeof workbenchCounts>;
  hasAgents: boolean;
}): string {
  if (loading || agentsLoading) return '正在同步任务状态…';
  if (counts.all === 0) return hasAgents ? '还没有任务。写下第一个目标，让 Agent 开始执行。' : '还没有任务。先准备 Agent，再创建第一个任务。';
  if (counts.attention) return `${counts.attention} 个任务需要你先处理，${counts.active} 个正在进行。`;
  if (counts.active) return `没有阻塞项，${counts.active} 个任务正在进行。`;
  if (counts.continuable) return `没有待处理事项，${counts.continuable} 个任务可以继续。`;
  return '当前任务都已处理，可以开始一个新目标。';
}

function TaskListEmpty({ hasAgents, createTask }: {
  hasAgents: boolean;
  createTask: ReturnType<typeof createTaskAffordance>;
}) {
  return <Card padding="lg">
    <span className="grid h-10 w-10 place-items-center rounded-md bg-action-soft text-action"><Plus size={19}/></span>
    <h2 className="mt-4 text-title font-semibold text-primary">{hasAgents ? '从第一个明确目标开始' : '先准备一个可用 Agent'}</h2>
    <p className="mt-1 max-w-xl text-body text-secondary">{hasAgents ? '可在飞书私聊发目标或群聊 @机器人 下达任务；也可以在这里创建任务直接执行。' : 'Dutydeck 会自动发现这台机器上已安装并登录的 Agent CLI。准备完成后，就能把它连接到飞书或直接创建任务。'}</p>
    <div className="mt-5 flex flex-wrap gap-2">
      <Button variant="secondary" disabled={createTask.disabled} onClick={createTask.onClick} iconEnd={<ArrowRight size={15}/>}>{hasAgents ? '创建第一个任务' : createTask.label}</Button>
    </div>
  </Card>;
}

function LarkBotsOverview({ bots, agents, loading, agentsLoading, listeningDisabled, failed, retrying, onRetry, onOpenLarkSetup, onOpenAgentSetup, onManageBots }: {
  bots: LarkBotConfig[];
  agents: Agent[];
  loading: boolean;
  agentsLoading: boolean;
  listeningDisabled: boolean;
  failed: boolean;
  retrying: boolean;
  onRetry(): void;
  onOpenLarkSetup(): void;
  onOpenAgentSetup(): void;
  onManageBots(): void;
}) {
  const summary = formatLarkNavSummary({ bots, listeningDisabled, loading, failed });
  const firstUse = !loading && !failed && bots.length === 0;
  const noAgents = agents.length === 0 && !agentsLoading;
  const exceptions = bots.map(bot => ({ bot, status: projectLarkBotStatus(bot, listeningDisabled, loading, failed) })).filter(({ status }) => status.key !== 'listening');

  return <Card as="aside" aria-label="协作入口" padding="sm" className="ui-lark-bots-card">
    <div className="ui-lark-bots-header flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-3"><span aria-hidden="true" className="ui-lark-bots-icon grid h-9 w-9 shrink-0 place-items-center rounded-md bg-info-soft text-info"><MessageSquare size={17}/></span><div><h2 className="text-body font-semibold text-primary">飞书机器人</h2><p className="text-caption text-secondary">{summary}</p></div></div>
      <Button variant={firstUse ? 'primary' : 'secondary'} onClick={firstUse ? onOpenLarkSetup : onManageBots} icon={firstUse ? <Plus size={15}/> : <Settings2 size={15}/>}>{firstUse ? '绑定飞书 Bot' : '管理飞书 Bot'}</Button>
    </div>
    {noAgents && <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning-border bg-warning-soft p-3 text-caption text-warning"><span>尚未检测到本机可用 Agent，机器人收到消息后无法执行任务。</span><Button variant="secondary" onClick={onOpenAgentSetup}>准备 Agent</Button></div>}
    {loading ? <div className="mt-3"><Skeleton variant="row"/></div> : failed ? <div className="mt-3 rounded-md border border-warning-border bg-warning-soft p-3 text-caption text-warning"><h3 className="font-semibold">无法读取飞书接入状态</h3><p className="mt-1">{bots.length ? '已有配置记录，但这一次状态读取失败，无法确认机器人当前能否收到消息。' : '状态读取失败，因此无法判断是否已配置机器人。配置入口仍然可用。'}</p><Button variant="secondary" className="mt-2" loading={retrying} disabled={retrying} onClick={onRetry}>{retrying ? '重试中…' : '重试'}</Button></div> : firstUse ? <div className="mt-3 rounded-md bg-muted p-4">
      <h3 className="text-body font-semibold text-primary">尚未配置飞书机器人</h3>
      <p className="mt-1 text-body text-secondary">绑定后在飞书私聊发送工程目标，或在群聊中 @机器人 下达任务；发送 <code className="rounded-sm bg-surface px-1.5 py-0.5 font-mono text-meta text-primary">/help</code> 查看可用操作。</p>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-caption text-secondary"><span className="flex items-center gap-1.5 font-medium"><CheckCircle2 size={14} className="text-success"/>私聊发目标</span><span className="flex items-center gap-1.5 font-medium"><CheckCircle2 size={14} className="text-success"/>群聊 @机器人</span><span className="flex items-center gap-1.5 font-medium"><CheckCircle2 size={14} className="text-success"/>/help 查看操作</span></div>
    </div> : null}
    {!loading && exceptions.length > 0 && <details className="group/bots mt-2"><summary className="flex min-h-10 cursor-pointer list-none items-center gap-1.5 text-caption font-medium text-warning [&::-webkit-details-marker]:hidden"><AlertTriangle aria-hidden="true" size={14} className="shrink-0"/>{exceptions.length} 个机器人需要检查<ChevronRight aria-hidden="true" size={13} className="shrink-0 transition-transform duration-fast group-open/bots:rotate-90"/></summary><div className="space-y-2">{exceptions.map(({ bot, status }) => <div key={bot.appId} className="rounded-md bg-muted p-3"><div className="flex flex-wrap items-center gap-2"><strong className="text-body font-medium">{bot.name || bot.tabLabel || bot.appId}</strong><Badge tone={status.tone}>{status.label}</Badge></div><p className="mt-1 text-caption text-secondary">{status.description}</p></div>)}</div></details>}
  </Card>;
}

export function WorkspaceOverview({ sessions, summaries, agents, loading, agentsLoading = false, larkBots, larkBotsLoading = false, larkListeningDisabled = false, larkBotsFailed = false, larkBotsRetrying = false, onRetryLarkBots, view, onViewChange, mode = 'home', filters, onFiltersChange, onOpenChanges, onSelect, onSelectAttention, onBulkArchive, onCreate, onOpenAgentSetup, onOpenLarkSetup, onManageBots = onOpenLarkSetup }: OverviewProps) {
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const home = mode === 'home' && view === 'all';
  const [localFilters, setLocalFilters] = useState<WorkspaceListFilters>({ query: '', project: '' });
  const { query, project } = home ? { query: '', project: '' } : filters ?? localFilters;
  const updateFilters = (next: WorkspaceListFilters) => {
    if (!filters) setLocalFilters(next);
    onFiltersChange?.(next);
  };
  useEffect(() => { setSelecting(false); setSelectedIds([]); }, [view, mode, query, project]);
  useEffect(() => {
    setSelectedIds(current => current.filter(id => sessions.some(session => session.id === id && !session.archivedAt && session.source !== 'work_item')));
  }, [sessions]);
  const counts = workbenchCounts(sessions, summaries);
  const allOrdered = orderSessionsForWorkbench(sessions, view, summaries);
  const search = query.trim().toLocaleLowerCase();
  const ordered = home ? allOrdered : allOrdered.filter(session => {
    if (project && sessionWorkspaceName(session) !== project) return false;
    return !search || [sessionDisplayName(session, summaries[session.id]?.prompt), sessionWorkspaceName(session), agents.find(agent => agent.id === session.agentId)?.name ?? session.agentId].join(' ').toLocaleLowerCase().includes(search);
  });
  const selectable = ordered.filter(session => !session.archivedAt && session.source !== 'work_item');
  const selected = selectable.filter(session => selectedIds.includes(session.id)).map(session => session.id);
  const allSelected = selectable.length > 0 && selected.length === selectable.length;
  const createTask = createTaskAffordance({ agents, agentsLoading, onCreate, onPrepareAgents: onOpenAgentSetup });
  const sectionIds: WorkbenchTaskSection[] = home && !selecting ? ['attention', 'active', 'continue'] : ['attention', 'active', 'continue', 'recent'];
  const sections = sectionIds.map(id => ({ id, sessions: ordered.filter(session => workbenchTaskSection(session, summaries[session.id]) === id) })).filter(section => section.sessions.length > 0 || (home && section.id === 'attention' && sessions.length > 0));
  const pending = loading || agentsLoading;
  const canBulkArchive = Boolean(onBulkArchive) && !pending && view !== 'archived' && (selectable.length > 0 || selecting);
  const deliveries = orderSessionsForWorkbench(sessions, 'completed', summaries).slice(0, 3);
  const projects = [...new Set(sessions.map(sessionWorkspaceName))].sort();
  const botStatusNeedsAttention = larkBotsFailed || (!larkBotsLoading && (larkBots.length === 0 || larkBots.some(bot => projectLarkBotStatus(bot, larkListeningDisabled, false, false).key !== 'listening')));
  const botsOverview = <LarkBotsOverview bots={larkBots} agents={agents} loading={larkBotsLoading} agentsLoading={agentsLoading} listeningDisabled={larkListeningDisabled} failed={larkBotsFailed} retrying={larkBotsRetrying} onRetry={() => onRetryLarkBots?.()} onOpenLarkSetup={onOpenLarkSetup} onOpenAgentSetup={onOpenAgentSetup} onManageBots={onManageBots}/>;

  return <div className="min-h-0 flex-1 overflow-y-auto bg-canvas">
    <section aria-labelledby="workspace-overview-title" className="mx-auto w-full max-w-[1440px] px-4 pb-12 pt-6 sm:px-8 sm:pt-8 lg:px-10">
      <header className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-caption text-subtle">{home ? new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date()) : 'WORKSPACE'}</p>
          <h1 id="workspace-overview-title" className="mt-1 text-display font-semibold tracking-[-.035em] text-primary">{home ? '工作台' : '全部任务'}</h1>
          <p className="mt-2 text-body text-secondary" role="status">{headlineFor({ loading, agentsLoading, counts, hasAgents: agents.length > 0 })}</p>
        </div>
        <Button variant="secondary" tone="inverse" disabled={createTask.disabled} onClick={createTask.onClick} icon={<Plus size={17}/>}>{createTask.label}</Button>
      </header>

      {botStatusNeedsAttention && <div className="mb-6">{botsOverview}</div>}

      {!home && <>
        <div className="flex flex-wrap gap-3">
          <label className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md border border-default bg-surface px-3 text-secondary"><Search aria-hidden="true" size={16}/><input aria-label="筛选当前任务列表" placeholder="搜索标题、项目或 Agent" value={query} onChange={event => updateFilters({ query: event.target.value, project })} className="min-w-0 flex-1 bg-transparent text-body text-primary outline-none"/></label>
          <select aria-label="筛选项目" value={project} onChange={event => updateFilters({ query, project: event.target.value })} className="min-h-10 max-w-full rounded-md border border-default bg-surface px-3 text-body text-secondary"><option value="">全部项目</option>{projects.map(name => <option key={name}>{name}</option>)}</select>
        </div>
        <section aria-label="任务筛选" className="mt-4">
          <div className="flex flex-wrap gap-1">{workbenchViewOrder.map(id => {
            const Icon = filterIcons[id]; const keys = viewShortcutKeys(id);
            return <button type="button" key={id} aria-pressed={view === id} onClick={() => onViewChange(id)} title={keys ? `${workbenchViewLabels[id]}（快捷键 ${keys}）` : undefined} className={`flex min-h-10 items-center gap-2 rounded-md border px-3 text-caption transition-colors duration-fast ${view === id ? 'border-default bg-surface font-medium text-primary' : 'border-transparent text-secondary hover:bg-hover'}`}><Icon aria-hidden="true" size={14}/><span>{workbenchViewLabels[id]}</span><span className="tabular-nums text-subtle">{pending ? '—' : counts[id]}</span></button>;
          })}</div>
          <div className="mt-3 flex flex-wrap justify-between gap-2 text-caption text-subtle"><span>{pending ? '正在同步任务…' : `${ordered.length} 个任务`}{counts.queuedCommands > 0 && ` · 另有待执行指令 ${counts.queuedCommands} 条`}</span><span>筛选仅影响此列表，侧栏保留完整项目</span></div>
        </section>
      </>}

      {canBulkArchive && !selecting && <div className="mb-2 flex justify-end" aria-label="批量清理任务"><Button variant="ghost" aria-label="批量清理" icon={<Archive size={15}/>} onClick={() => setSelecting(true)}>批量清理</Button></div>}
      {canBulkArchive && selecting && <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md bg-muted px-2 py-1" aria-label="批量清理任务">
        <label className="flex min-h-10 cursor-pointer items-center gap-2 px-2 text-caption text-secondary"><input type="checkbox" aria-label="全选当前视图" checked={allSelected} disabled={!selectable.length} ref={node => { if (node) node.indeterminate = selected.length > 0 && !allSelected; }} onChange={() => setSelectedIds(allSelected ? [] : selectable.map(session => session.id))} className="h-4 w-4 accent-action"/>全选当前视图</label>
        <span role="status" className="text-caption text-secondary">已选 {selected.length} 个任务</span>
        <Button variant="danger" disabled={!selected.length} icon={<Archive size={15}/>} onClick={() => onBulkArchive?.(selected)}>清理所选任务</Button>
        <Button variant="ghost" onClick={() => { setSelecting(false); setSelectedIds([]); }}>退出多选</Button>
      </div>}

      <div className={home && !selecting ? 'ui-workbench-grid' : 'mt-5'}>
        <section aria-label="任务列表" className="min-w-0">
          {pending ? <Card><Skeleton variant="block" lines={2}/></Card> : sessions.length === 0 && view === 'all' ? <TaskListEmpty hasAgents={agents.length > 0} createTask={createTask}/> : sections.length ? <div className="space-y-7">{sections.map(section => {
            const truncated = home && !selecting && section.sessions.length > SECTION_PREVIEW;
            const rows = truncated ? section.sessions.slice(0, SECTION_PREVIEW) : section.sessions;
            return <section key={section.id} aria-labelledby={`task-section-${section.id}`}>
              <div className="mb-3 flex items-center gap-2"><span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${sectionDot[section.id]}`}/><h2 id={`task-section-${section.id}`} className="text-title font-semibold text-primary">{sectionCopy[section.id].title}</h2><span className="text-caption tabular-nums text-subtle">{section.sessions.length}</span></div><p className="sr-only">{sectionCopy[section.id].description}</p>
              <div className={section.id === 'attention' ? 'overflow-hidden rounded-lg border border-default bg-surface' : 'border-y border-default'}>
                {rows.length ? rows.map(session => <TaskRow key={session.id} session={session} summary={summaries[session.id]} agent={agents.find(agent => agent.id === session.agentId)} section={section.id} onSelect={home && section.id === 'attention' ? onSelectAttention ?? onSelect : onSelect} selection={selecting ? { checked: selected.includes(session.id), disabled: session.source === 'work_item', onChange: () => setSelectedIds(current => current.includes(session.id) ? current.filter(id => id !== session.id) : [...current, session.id]) } : undefined}/>) : <EmptyState tone="positive" title="需要你处理的事项已清空" description="正在进行的任务会继续推进。"/>}
                {truncated && <button type="button" onClick={() => onViewChange(sectionView[section.id])} className="flex min-h-10 w-full items-center justify-center gap-2 border-t border-default px-3 py-2 text-caption text-action hover:bg-hover">查看全部 {section.sessions.length} 个{sectionCopy[section.id].title}的任务<ArrowRight aria-hidden="true" size={14}/></button>}
              </div>
            </section>;
          })}</div> : <Card padding="none"><EmptyState tone={!search && view === 'attention' ? 'positive' : 'neutral'} title={search || project ? '没有找到符合条件的任务' : '当前视图没有任务'} description={search ? `关键词“${query}” · ${workbenchViewLabels[view]}${project ? ` · ${project}` : ''}` : '选择其他状态，或创建一个新任务。'}/><div className="flex flex-wrap justify-center gap-2 pb-5"><Button variant="secondary" onClick={() => { updateFilters({ query, project: '' }); onViewChange('all'); }}>清除筛选</Button>{query && <Button variant="ghost" onClick={() => updateFilters({ query: '', project })}>清除搜索</Button>}</div></Card>}
        </section>
        {home && !selecting && <aside aria-label="最近交付" className="ui-workbench-rail">
          <h2 className="mb-4 text-caption font-medium text-subtle">最近交付</h2>
          {deliveries.length ? deliveries.map(session => <div key={session.id} className="mb-6 border-b border-default pb-5 last:mb-0 last:border-0">
            <StatusBadge session={session}/><h3 className="mt-3 text-body font-semibold text-primary">{sessionDisplayName(session, summaries[session.id]?.prompt, fallbackRunTitle(session.source))}</h3>
            <p className="mt-2 text-caption text-secondary">{sessionWorkspaceName(session)} · {formatRelativeTime(session.updatedAt || session.createdAt)}</p><p className="mt-2 text-caption text-subtle">本轮已完成，改动与验证请在任务中检查。</p>
            <Button variant="secondary" className="mt-3" iconEnd={<ArrowRight size={14}/>} onClick={() => onOpenChanges ? onOpenChanges(session.id) : onSelect(session.id)}>{onOpenChanges ? '检查交付' : '查看任务'}</Button>
          </div>) : <p className="text-caption text-secondary">新的交付会出现在这里。</p>}
          {!botStatusNeedsAttention && <div className="mt-6 border-t border-default pt-5">{botsOverview}</div>}
        </aside>}
      </div>
      {!home && !botStatusNeedsAttention && <div className="mt-8 border-t border-default pt-5">{botsOverview}</div>}
    </section>
  </div>;
}
