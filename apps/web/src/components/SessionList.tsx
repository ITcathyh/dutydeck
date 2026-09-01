import { useMemo } from 'react';
import { FolderKanban, Plus, Settings2, ShieldCheck } from 'lucide-react';
import type { Agent, LarkBotConfig, RunSummary, Session } from '../api';
import { useMediaQuery } from '../useMediaQuery';
import { groupSessionsByWorkspace, type WorkbenchView } from '../workspace-model';
import { createTaskAffordance, DockmuxIcon } from './ui';
import { Skeleton } from './primitives';
import { SessionRow } from './SessionRow';

export type SessionListProps = {
  open: boolean;
  onClose(): void;
  sessions: Session[];
  summaries: Record<string, RunSummary>;
  sessionsLoading: boolean;
  agents: Agent[];
  agentsLoading?: boolean;
  larkBots: LarkBotConfig[];
  activeSessionId?: string;
  view: WorkbenchView;
  onSelect(id?: string): void;
  onNewSession(): void;
  onOpenControlCenter(): void;
  authRequired?: boolean;
};

/**
 * 工作区导航。
 *
 * 这里刻意不再渲染状态筛选：状态筛选是总览页的职责，而侧栏在桌面端恒常可见
 * （md:static），两份筛选曾经必然同屏并列。侧栏回答「按目录找任务」，
 * 总览页回答「按状态找任务」，两条正交的检索路径各留一处。
 *
 * 配色走独立的 sidebar-* 深色盘（契约 §6）：双主题下恒深色，不与内容表面
 * surface/muted 混用。下面几处「明明有原语却仍然手写」的地方，原因都是这一条——
 * 原语只覆盖内容表面色盘，套到恒深色底上会在浅色主题下变成深字压深底。
 */
export function SessionList({ open, onClose, sessions, summaries, sessionsLoading, agents, agentsLoading = false, larkBots, activeSessionId, view, onSelect, onNewSession, onOpenControlCenter, authRequired }: SessionListProps) {
  const workspaces = useMemo(() => groupSessionsByWorkspace(sessions, view, summaries), [sessions, summaries, view]);
  const matchesDesktop = useMediaQuery('(min-width: 768px)');
  // 读不到 media query 时侧栏必须保守地当作桌面（可见、可访问）。当成移动端会让
  // hiddenOnMobile 翻真，整个导航带上 inert + aria-hidden 从可访问树里摘掉：
  // SSR 首屏会丢掉侧栏，jsdom（默认没有 window.matchMedia）里则是所有按名字取
  // 侧栏节点的用例集体失败。useMediaQuery 的通用默认是「读不到当不命中」，方向
  // 与这里相反——不命中对别处只是少一点样式，对侧栏却是整块消失，所以这条反向
  // fallback 留在调用点，不去改那个通用 hook。
  const desktop = typeof window === 'undefined' || typeof window.matchMedia !== 'function' ? true : matchesDesktop;
  const createTask = createTaskAffordance({ agents, agentsLoading, onCreate: onNewSession, onPrepareAgents: onOpenControlCenter });
  const hiddenOnMobile = !desktop && !open;
  return <aside aria-label="Dockmux 工作台导航" aria-hidden={hiddenOnMobile || undefined} inert={hiddenOnMobile || undefined} className={`fixed inset-y-0 left-0 z-drawer flex w-[304px] shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar-surface text-sidebar-text shadow-sidebar transition-transform duration-normal ease-emphasized md:static md:w-[292px] md:translate-x-0 md:shadow-none ${open ? 'translate-x-0' : '-translate-x-full'}`}>
    <div className="flex h-16 min-w-[292px] items-center gap-2.5 px-4"><DockmuxIcon className="h-8 w-8 shrink-0"/><span><strong className="block text-body font-semibold tracking-[-.025em] text-sidebar-text-strong">Dockmux</strong><span className="block text-caption text-sidebar-text-muted">Agent 任务台</span></span></div>
    <div className="min-w-[292px] px-3">
      {/* 主按钮手写而不是用 <Button>：原语没有 sidebar accent 这一档 variant，
          而侧栏是独立色盘（§6）。min-h-10 是触控下限（§9），也是多处用例按名字
          取这颗按钮的前提，不能改小。40px 高按 §3 取 rounded-md（10px）。 */}
      <button type="button" disabled={createTask.disabled} onClick={createTask.onClick} className="flex min-h-10 w-full items-center justify-center gap-2 rounded-md bg-sidebar-accent px-3 text-body font-semibold text-sidebar-accent-text transition hover:brightness-110 active:translate-y-px disabled:opacity-60"><Plus size={16}/>{createTask.label}</button>
    </div>

    <div className="mt-5 flex min-h-0 min-w-[292px] flex-1 flex-col"><div className="flex items-center px-4 pb-2 text-caption font-semibold text-sidebar-text-muted"><FolderKanban size={13} className="mr-2"/>工作区<span className="ml-auto font-mono text-meta">{workspaces.length}</span></div><div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">{sessionsLoading
      /* Skeleton 的条子写死 bg-muted（内容表面色），直接铺在恒深色侧栏上是 §6 明禁的
         混用。原语只有内容表面一档，这里用 arbitrary variant 覆盖条子底色而不是
         另造一个骨架副本。 */
      ? <Skeleton variant="block" lines={2} className="px-1 [&>div]:bg-sidebar-hover"/>
      : workspaces.length ? workspaces.map(workspace => <section key={workspace.id} className="mb-3"><div className="flex min-w-0 items-center px-2 pb-1.5"><span className="min-w-0 flex-1 truncate text-caption font-semibold text-sidebar-text" title={workspace.cwd}>{workspace.name}</span><span className="ml-2 font-mono text-meta text-sidebar-text-muted">{workspace.sessions.length}</span></div>{workspace.sessions.map(session => <SessionRow key={session.id} session={session} summary={summaries[session.id]} agent={agents.find(item => item.id === session.agentId)} botName={larkBots.find(bot => session.sourceId?.startsWith(`${bot.appId}:`))?.name} active={activeSessionId === session.id} onClick={() => { onSelect(session.id); onClose(); }}/>)}</section>)
      /* 空态不用 <EmptyState>：原语取 text-secondary / text-subtle / bg-muted，全是内容
         表面色，放到恒深色侧栏上浅色主题下就是深字压深底，读不出来。手写保留，颜色
         走 sidebar 语义类。框高约 66px（py-6 + 一行 18px），按 §3 取 rounded-lg。 */
      : <div className="rounded-lg border border-dashed border-sidebar-border px-4 py-6 text-center text-caption text-sidebar-text-muted">当前视图没有任务。</div>}</div></div>

    {/* 底部入口同样手写：sidebar 色盘 + min-h-10 触控下限，理由同上。 */}
    <div className="min-w-[292px] border-t border-sidebar-border px-2.5 py-2"><button type="button" onClick={onOpenControlCenter} className="flex min-h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-body font-medium text-sidebar-text-muted transition hover:bg-sidebar-hover hover:text-sidebar-text-strong"><Settings2 size={15} className="text-sidebar-accent"/><span>Agent 与设置</span><span className="ml-auto font-mono text-caption text-sidebar-text-muted">{agents.length} Agent{larkBots.length > 0 ? ` · ${larkBots.length} Bot` : ''}</span></button></div>
    <div className="min-w-[292px] border-t border-sidebar-border px-4 py-2.5 text-meta text-sidebar-text-faint">{authRequired === false ? <span className="flex items-center gap-1.5 text-sidebar-accent"><ShieldCheck size={12}/>受信开发机模式 · 无需 token</span> : '本机运行 · ACPX 0.13'}</div>
  </aside>;
}
