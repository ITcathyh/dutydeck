import { useMemo, useState } from 'react';
import { CalendarClock, ChevronRight, Coins, FolderKanban, Home, ListTodo, PanelLeftClose, PanelLeftOpen, MessagesSquare, Plus, Settings2, ShieldCheck, SlidersHorizontal, Users } from 'lucide-react';
import type { WorkspaceOrganization } from '@dutydeck/shared';
import type { Agent, LarkBotConfig, RunSummary, Session } from '../api';
import type { PrimaryNav } from '../app-route';
import { useMediaQuery } from '../useMediaQuery';
import { groupSessionsByWorkspace, sessionMatchesView, type WorkbenchView, type WorkspaceGroup } from '../workspace-model';
import { formatLarkNavSummary } from '../lark-status';
import { createTaskAffordance, DutydeckIcon } from './ui';
import { IconButton, Skeleton } from './primitives';
import { RemoteAccessLogout } from './AuthGate';
import { SessionRow } from './SessionRow';
import { SidebarNav, type SidebarNavGroup } from './SidebarNav';
import { useExperimental } from '../experimental';

export type SessionListProps = {
  open: boolean;
  collapsed?: boolean;
  onToggleCollapsed?(): void;
  onClose(): void;
  sessions: Session[];
  summaries: Record<string, RunSummary>;
  sessionsLoading: boolean;
  agents: Agent[];
  agentsLoading?: boolean;
  larkBots: LarkBotConfig[];
  /** 与总览页协作卡片同源：未就绪时两处必须都说「正在读取」，不得一处谎报「尚未接入」。 */
  larkBotsLoading?: boolean;
  larkListeningDisabled?: boolean;
  /** Bot 状态读取失败：hint 必须说「状态未确认」，不得谎报「尚未配置机器人」。 */
  larkBotsFailed?: boolean;
  activeSessionId?: string;
  view: WorkbenchView;
  onSelect(id?: string): void;
  onNewSession(): void;
  onOpenControlCenter(): void;
  /** 飞书 Bot 绑定向导（?panel=lark-setup）。 */
  onOpenLarkSetup(): void;
  /** 群与权限草稿（?panel=groups）。 */
  onOpenGroups(): void;
  /** 任务执行计划与导入草稿（?panel=automation）。 */
  onOpenSchedules(): void;
  /** 用量与成本汇总、月度上限（?panel=usage）。 */
  onOpenUsage?(): void;
  /**
   * 主区一级视图；当前项由调用方维护，切换不改变项目树。
   */
  primaryNav?: PrimaryNav;
  /** 切换主区一级视图。不传时不渲染这一组导航（供仅列任务的用法复用）。 */
  onPrimaryNavChange?(nav: PrimaryNav): void;
  authRequired?: boolean;
  organization?: WorkspaceOrganization;
  onManageWorkspaces?(): void;
};

export function SessionList({ open, collapsed = false, onToggleCollapsed, onClose, sessions, summaries, sessionsLoading, agents, agentsLoading = false, larkBots, larkBotsLoading = false, larkListeningDisabled = false, larkBotsFailed = false, activeSessionId, view, onSelect, onNewSession, onOpenControlCenter, onOpenLarkSetup, onOpenGroups, onOpenSchedules, onOpenUsage, primaryNav = 'tasks', onPrimaryNavChange, authRequired, organization, onManageWorkspaces }: SessionListProps) {
  const workspaces = useMemo(() => {
    const groups = groupSessionsByWorkspace(sessions, view, summaries, organization);
    const active = sessions.find(session => session.id === activeSessionId);
    if (!active || groups.some(group => group.sessions.some(session => session.id === active.id))) return groups;
    const activeGroup = groupSessionsByWorkspace([active], active.archivedAt ? 'archived' : 'all', summaries, organization).find(group => group.sessions.length);
    if (!activeGroup) return groups;
    const existing = groups.find(group => group.id === activeGroup.id);
    return existing ? groups.map(group => group.id === existing.id ? { ...group, sessions: [...group.sessions, active] } : group) : [...groups, activeGroup];
  }, [sessions, summaries, view, organization, activeSessionId]);
  const activeOutsideView = sessions.some(session => session.id === activeSessionId && !sessionMatchesView(session, view, summaries[session.id]));
  const matchesDesktop = useMediaQuery('(min-width: 768px)');
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const toggleWorkspace = (id: string) => setOverrides(current => ({ ...current, [id]: !isExpandedById(id) }));
  const containsActive = (workspace: WorkspaceGroup) => workspace.sessions.some(session => session.id === activeSessionId);
  const autoExpanded = (workspace: WorkspaceGroup) => workspaces.length === 1 || workspace.sessions.length === 1 || containsActive(workspace);
  const isExpandedById = (id: string) => {
    const workspace = workspaces.find(item => item.id === id);
    return overrides[id] ?? (workspace ? autoExpanded(workspace) : false);
  };
  const isExpanded = (workspace: WorkspaceGroup) => overrides[workspace.id] ?? autoExpanded(workspace);
  const desktop = typeof window === 'undefined' || typeof window.matchMedia !== 'function' ? true : matchesDesktop;
  const compact = collapsed && desktop;
  const [experimental] = useExperimental();
  const createTask = createTaskAffordance({ agents, agentsLoading, onCreate: onNewSession, onPrepareAgents: onOpenControlCenter });
  const hiddenOnMobile = !desktop && !open;

  const primaryNavGroups: SidebarNavGroup[] = onPrimaryNavChange ? [{ id: 'workspace', title: '工作台', items: [
    // 计数不含已归档，与任务中心「总览」统计卡同口径；sessions 里带着归档任务。
    { id: 'nav-home', label: '工作台', hint: '需要处理与继续的工作', Icon: Home, active: primaryNav === 'home', onClick: () => { onPrimaryNavChange('home'); onClose(); } },
    { id: 'nav-tasks', label: '全部任务', hint: `${sessions.filter(session => !session.archivedAt).length} 个任务 · 创建与跟进`, Icon: ListTodo, active: primaryNav === 'tasks', onClick: () => { onPrimaryNavChange('tasks'); onClose(); } },
    { id: 'nav-automation', label: '自动化', hint: '任务执行计划', Icon: CalendarClock, active: primaryNav === 'automation', onClick: () => { onPrimaryNavChange('automation'); onClose(); } },
    { id: 'nav-bots', label: '机器人', hint: formatLarkNavSummary({ bots: larkBots, listeningDisabled: larkListeningDisabled, loading: larkBotsLoading, failed: larkBotsFailed }), Icon: MessagesSquare, active: primaryNav === 'bots', onClick: () => { onPrimaryNavChange('bots'); onClose(); } },
    { id: 'nav-groups', label: '群聊', hint: '群内每个 Bot 的目录与触发', Icon: Users, active: primaryNav === 'groups', onClick: () => { onPrimaryNavChange('groups'); onClose(); } }
  ] }] : [];

  const navGroups: SidebarNavGroup[] = [
    { id: 'access', title: '接入与设置', items: [
      { id: 'settings', label: 'Agent 与设置', hint: `${agents.length} 个 Agent${larkBots.length ? ` · ${larkBots.length} 个 Bot` : ''}`, Icon: Settings2, onClick: onOpenControlCenter },
      { id: 'lark', label: '飞书接入', hint: formatLarkNavSummary({ bots: larkBots, listeningDisabled: larkListeningDisabled, loading: larkBotsLoading, failed: larkBotsFailed }), Icon: MessagesSquare, onClick: onOpenLarkSetup }
    ] },
    ...(!onPrimaryNavChange ? [{ id: 'automation-tools', title: '自动化', items: [
      { id: 'schedules', label: '定时任务', hint: experimental ? '任务执行计划与草稿' : '任务执行计划', Icon: CalendarClock, onClick: onOpenSchedules }
    ] }] : []),
    ...(experimental ? [{ id: 'experimental-tools', title: '实验功能', items: [
      { id: 'groups', label: '群与权限', hint: '策略草稿 · 尚未接入运行时', Icon: Users, onClick: onOpenGroups }
    ] }] : []),
    ...(onOpenUsage ? [{ id: 'usage', title: '成本', items: [
      { id: 'usage', label: '用量与成本', hint: '按 Bot、群、触发人、来源汇总 · 月度上限', Icon: Coins, onClick: onOpenUsage }
    ] }] : [])
  ];

  return <aside
    aria-label="Dutydeck 工作台导航"
    aria-hidden={hiddenOnMobile || undefined}
    inert={hiddenOnMobile || undefined}
    className={`ui-sidebar fixed inset-y-0 left-0 z-drawer flex w-sidebar flex-col overflow-hidden border-r border-sidebar-border bg-sidebar-surface text-sidebar-text transition-transform duration-normal ease-emphasized md:bottom-shell-gap md:left-shell-gap md:top-0 md:translate-x-0 md:border-r ${open ? 'translate-x-0' : '-translate-x-full'}`}
  >
    <div className={`flex shrink-0 items-center gap-2 ${compact ? 'h-auto flex-col px-0 pt-3 pb-1' : 'h-14 px-3'}`}>
      <DutydeckIcon className="h-7 w-7 shrink-0"/><strong className={`min-w-0 flex-1 text-title font-semibold tracking-[-.025em] text-sidebar-text-strong ${compact ? 'hidden' : ''}`}>dutydeck</strong>
      {onToggleCollapsed && <span className="hidden md:block"><IconButton label={collapsed ? '展开侧栏' : '收起侧栏'} onClick={onToggleCollapsed}>{collapsed ? <PanelLeftOpen size={16}/> : <PanelLeftClose size={16}/>}</IconButton></span>}
    </div>

    <div className={`shrink-0 pt-2 md:pt-3 ${compact ? 'px-2.5' : 'px-3'}`}>
      <button type="button" disabled={createTask.disabled} onClick={createTask.onClick} className={`flex min-h-10 w-full items-center justify-center gap-2 rounded-md border border-sidebar-border text-body font-medium text-sidebar-text transition-colors duration-fast ease-out hover:bg-sidebar-hover hover:text-sidebar-text-strong active:translate-y-px disabled:opacity-60 ${compact ? 'p-0' : 'px-3'}`}><Plus aria-hidden="true" size={16}/><span className={compact ? 'sr-only' : undefined}>{createTask.label}</span></button>
    </div>

    {onPrimaryNavChange && <div className="mt-1 shrink-0"><SidebarNav groups={primaryNavGroups} compact={compact}/></div>}

    <div className={`ui-sidebar-projects mt-3 min-h-0 flex-1 flex-col ${compact ? 'hidden' : 'flex'}`}><div className="flex items-center px-4 pb-2 text-caption font-semibold text-sidebar-text-muted"><FolderKanban size={13} className="mr-2"/>项目<span className="ml-auto font-mono text-meta">{workspaces.length}</span>{onManageWorkspaces && <span className="ml-1 -mr-2"><IconButton label="整理分组" size="sm" onClick={onManageWorkspaces}><SlidersHorizontal size={13}/></IconButton></span>}</div><div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">{sessionsLoading
      ? <Skeleton variant="block" lines={2} className="px-1 [&>div]:bg-sidebar-hover"/>
      : workspaces.length ? workspaces.map(workspace => {
        const expanded = isExpanded(workspace);
        return <section key={workspace.id} className="mb-1.5">
          <button
            type="button"
            onClick={() => toggleWorkspace(workspace.id)}
            aria-expanded={expanded}
            title={workspace.cwd}
            className="flex min-h-10 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left transition-colors duration-fast ease-out hover:bg-sidebar-hover"
          >
            <ChevronRight aria-hidden="true" size={13} className={`shrink-0 text-sidebar-text-muted transition-transform duration-fast ${expanded ? 'rotate-90' : ''}`}/>
            <span className="min-w-0 flex-1 truncate text-caption font-semibold text-sidebar-text">{workspace.name}</span>
            <span className="ml-1 shrink-0 font-mono text-meta text-sidebar-text-muted">{workspace.sessions.length}</span>
          </button>
          {(expanded || containsActive(workspace)) && <div className="ml-4 mt-0.5 border-l border-sidebar-border pl-1.5">{!expanded && <p className="px-2 text-meta text-sidebar-text-muted">当前任务</p>}{activeOutsideView && containsActive(workspace) && <p className="px-2 text-meta text-sidebar-text-muted">当前任务不在此筛选中</p>}{workspace.sessions.filter(session => expanded || session.id === activeSessionId).map(session => <SessionRow key={session.id} session={session} summary={summaries[session.id]} agent={agents.find(item => item.id === session.agentId)} botName={larkBots.find(bot => session.sourceId?.startsWith(`${bot.appId}:`))?.name} active={activeSessionId === session.id} onClick={() => { onSelect(session.id); onClose(); }}/>)}</div>}
        </section>;
      })
      : <div className="rounded-lg border border-dashed border-sidebar-border px-4 py-6 text-center text-caption text-sidebar-text-muted">当前视图没有任务。</div>}</div></div>

    <div className="mt-auto min-h-0 shrink overflow-y-auto border-t border-sidebar-border py-2"><SidebarNav groups={navGroups} compact={compact}/></div>
    <div className="flex shrink-0 items-center border-t border-sidebar-border pl-4 pr-2 text-meta text-sidebar-text-faint"><span className={`min-w-0 flex-1 py-2 ${compact ? 'hidden' : ''}`}>{authRequired === false ? <span className="flex items-center gap-1.5 text-sidebar-accent"><ShieldCheck size={12}/>受信开发机模式 · 无需 token</span> : '本机运行'}</span><RemoteAccessLogout/></div>
  </aside>;
}
