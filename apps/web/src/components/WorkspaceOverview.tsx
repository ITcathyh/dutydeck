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
import { Button, Card, EmptyState, IconButton, Kbd, Skeleton, StatusBadge } from './primitives';
import { createTaskAffordance } from './ui';

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
  return <button
    type="button"
    data-task-priority={section}
    onClick={() => onSelect(session.id)}
    className="group flex min-h-[72px] w-full items-start gap-3 border-t border-subtle px-4 py-3 text-left first:border-t-0 hover:bg-hover sm:items-center sm:px-5"
  >
    {/* 徽标文案与归档优先判据都来自 effectiveStatus，由 StatusBadge 单点消费；这里不再拼配色字符串。 */}
    <span className="mt-0.5 shrink-0 sm:mt-0"><StatusBadge session={session}/></span>
    <span className="min-w-0 flex-1">
      <strong className="block truncate text-body font-semibold text-primary" title={summary?.prompt}>{summary?.prompt ?? fallbackRunTitle(session.source)}</strong>
      <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-caption text-secondary">
        <span>{workspaceName(session.cwd)}</span><span aria-hidden="true">·</span><span>{agent?.name ?? session.agentId}</span>
        {section === 'attention' && <><span aria-hidden="true">·</span><span className="font-medium text-primary">{attentionReasonForSession(session)}</span></>}
        {queuedCommands > 0 && <span className="rounded-sm bg-queued-soft px-1.5 py-0.5 font-medium text-queued">待执行指令 {queuedCommands} 条</span>}
      </span>
    </span>
    <span className="flex shrink-0 flex-col items-end gap-1 text-caption text-subtle">
      <span title={updatedAt ? new Date(updatedAt).toLocaleString('zh-CN') : undefined}>更新于 {relativeTime}</span>
      {/* runId 是契约 §2 点名允许 text-meta 的低频元数据。 */}
      <span className="hidden font-mono text-meta sm:block">{shortRunId(session)}</span>
    </span>
    <ArrowRight aria-hidden="true" size={16} className="mt-1 shrink-0 text-subtle group-hover:text-action sm:mt-0"/>
  </button>;
}

/**
 * 页首那句话的唯一副本。
 *
 * 数字全部取自 counts，与筛选芯片、分区标题同源（都只读 workbenchCounts →
 * sessionMatchesView → workbenchTaskSection 这一条链）。这里刻意不写
 * `sessions.filter(...)`：在调用点旁边裸判状态正是 workspace-model.ts 三处
 * 长注释反复记录的那类故障——芯片说 0、分区说 12。
 */
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
  return '当前任务都已处理，可以开始一个新目标。';
}

/**
 * 任务列表区的三种空状态。
 *
 * 这三支原本挤在一个 1400+ 字符的三元嵌套里（旧 WorkspaceOverview.tsx:147），
 * 读的人无法确认「哪个条件走到哪一支」，改一支就得重读整行。拆开之后三支各自
 * 独立，语义差别也才看得出来：
 *
 *   guide    首次使用，一条任务都没有 → 带主 CTA 的引导，这是 EmptyState 的 guide 档。
 *   positive 有任务，但当前筛选视图筛不出 → 「没有待办」是好消息，绿勾，不是失望的灰。
 *            契约 §10 明写这一档「不得用灰色失望感呈现」：把「你已经处理完了」
 *            画成灰色空盒子，是在为一件好事道歉。
 *
 * 注意 guide 这一支不用 EmptyState 原语：它要同时给两个按钮（创建任务 + 绑定飞书），
 * 而 EmptyState 的 primaryAction/secondaryAction 都只收 label + onClick，
 * 传不了 createTask 的 disabled 态（Agent 检测中必须禁用，见 ui.tsx:createTaskAffordance
 * 的注释：不禁用就会把人送去设置页）。原语已冻结，所以这一支保留手写结构，
 * 但配色与字号仍走语义类。
 */
function TaskListEmpty({ firstUse, hasAgents, createTask, onOpenLarkSetup }: {
  firstUse: boolean;
  hasAgents: boolean;
  createTask: ReturnType<typeof createTaskAffordance>;
  onOpenLarkSetup(): void;
}) {
  if (!firstUse) return <Card padding="none">
    <EmptyState
      tone="positive"
      title="当前视图没有任务"
      description="选择其他状态，或创建一个新任务。"
    />
  </Card>;

  return <Card padding="lg">
    <span className="grid h-10 w-10 place-items-center rounded-md bg-action-soft text-action"><Plus size={19}/></span>
    <h2 className="mt-4 text-title font-semibold text-primary">{hasAgents ? '从第一个明确目标开始' : '先准备一个可用 Agent'}</h2>
    <p className="mt-1 max-w-xl text-body text-secondary">{hasAgents ? '描述要完成的事情，选择工作目录和 Agent；创建后会立即开始执行。' : 'Dockmux 会自动发现这台机器上已安装并登录的 Agent CLI。准备完成后，就能创建任务或把它连接到飞书。'}</p>
    <div className="mt-5 flex flex-wrap gap-2">
      <Button variant="primary" disabled={createTask.disabled} onClick={createTask.onClick} iconEnd={<ArrowRight size={15}/>}>{hasAgents ? '创建第一个任务' : createTask.label}</Button>
      <Button variant="secondary" onClick={onOpenLarkSetup}>绑定飞书 Bot</Button>
    </div>
  </Card>;
}

export function WorkspaceOverview({ sessions, summaries, agents, loading, agentsLoading = false, larkBots, larkBotsLoading = false, view, onViewChange, onSelect, onCreate, onOpenAgentSetup, onOpenLarkSetup, onOpenSearch, onOpenShortcuts, themeControl }: OverviewProps) {
  const counts = workbenchCounts(sessions, summaries);
  const ordered = orderSessionsForWorkbench(sessions, view, summaries);
  const selectedLabel = workbenchViewLabels[view];
  const createTask = createTaskAffordance({ agents, agentsLoading, onCreate, onPrepareAgents: onOpenAgentSetup });
  const sections: Array<{ id: WorkbenchTaskSection; sessions: Session[] }> = view === 'all'
    ? (['attention', 'active', 'recent'] as WorkbenchTaskSection[]).map(id => ({ id, sessions: ordered.filter(session => workbenchTaskSection(session, summaries[session.id]) === id) })).filter(section => section.sessions.length > 0)
    : [{ id: view === 'active' ? 'active' : view === 'attention' ? 'attention' : 'recent', sessions: ordered }];
  // 骨架必须盖住 agents 还在检测的那一段：先闪一次空状态会让用户以为「真的没有任务」。
  const pending = loading || agentsLoading;
  const hasTasks = sections.length > 0 && ordered.length > 0;

  return <div className="min-h-0 flex-1 overflow-y-auto bg-canvas">
    <section aria-labelledby="workspace-overview-title" className="mx-auto w-full max-w-[1120px] px-4 pb-12 pt-14 sm:px-8 sm:pt-8 lg:px-10">
      <header className="flex flex-col gap-4 border-b border-default pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-body font-medium text-secondary">任务中心</p>
          <h1 id="workspace-overview-title" className="mt-1 text-display font-semibold tracking-[-.035em] text-primary">今天需要推进什么？</h1>
          {/* 这句话里的数字必须来自 counts，与下面的筛选芯片同源；分区标题也数同一个集合。 */}
          <p className="mt-2 text-body text-secondary">{headlineFor({ loading, agentsLoading, counts, hasAgents: agents.length > 0 })}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onOpenSearch && <button type="button" onClick={onOpenSearch} className="flex min-h-10 flex-1 items-center gap-2 rounded-md border border-default bg-surface px-3 text-body text-subtle hover:border-action hover:text-primary sm:w-64 sm:flex-none"><Search aria-hidden="true" size={15}/><span className="min-w-0 flex-1 truncate text-left">搜索任务目标、工作区或 Agent</span><span className="hidden shrink-0 sm:inline"><Kbd>Ctrl K</Kbd></span></button>}
          {themeControl}
          {/* IconButton 命中区恒 40px（契约 §9），视觉仍是 32px 的密集工具条尺寸。 */}
          {onOpenShortcuts && <span className="hidden sm:inline"><IconButton label="查看键盘快捷键" onClick={onOpenShortcuts}><Keyboard size={16}/></IconButton></span>}
          <Button variant="primary" disabled={createTask.disabled} onClick={createTask.onClick} icon={<Plus size={17}/>}>{createTask.label}</Button>
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
              className={`flex min-h-10 items-center gap-2 rounded-md border px-3 text-body font-medium ${view === id ? 'border-action bg-action-soft text-action' : 'border-default bg-surface text-secondary hover:bg-hover hover:text-primary'}`}
            ><Icon aria-hidden="true" size={15}/><span>{workbenchViewLabels[id]}</span><strong className="font-mono text-caption tabular-nums">{loading ? '—' : counts[id]}</strong></button>;
          })}
          {/* 待执行指令是「指令」口径，与芯片的「任务」口径不同，所以只作说明标签，不做可点击视图。 */}
          {!loading && counts.queuedCommands > 0 && <span className="flex min-h-10 items-center rounded-md border border-dashed border-default px-3 text-caption text-subtle">另有待执行指令 {counts.queuedCommands} 条</span>}
        </div>
      </section>

      <div className="mt-5 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
        <section aria-label="任务列表" className="min-w-0">
          {pending
            ? <Card><Skeleton variant="block" lines={2}/></Card>
            : hasTasks
              ? <div className="space-y-6">{sections.map(section => <section key={section.id} aria-labelledby={`task-section-${section.id}`}>
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <div>
                    <h2 id={`task-section-${section.id}`} className="text-title font-semibold text-primary">{view === 'all' ? sectionCopy[section.id].title : selectedLabel}</h2>
                    <p className="mt-0.5 text-caption text-secondary">{view === 'all' ? sectionCopy[section.id].description : '按最近更新排序'}</p>
                  </div>
                  <span className="text-caption font-medium tabular-nums text-subtle">{section.sessions.length} 个</span>
                </div>
                <Card padding="none" className="overflow-hidden">{section.sessions.map(session => <TaskRow key={session.id} session={session} summary={summaries[session.id]} agent={agents.find(agent => agent.id === session.agentId)} section={section.id} onSelect={onSelect}/>)}</Card>
              </section>)}</div>
              : <TaskListEmpty firstUse={view === 'all' && sessions.length === 0} hasAgents={agents.length > 0} createTask={createTask} onOpenLarkSetup={onOpenLarkSetup}/>}
        </section>

        <Card as="aside" aria-label="协作入口">
          <div className="flex items-center gap-2"><span className="grid h-9 w-9 place-items-center rounded-md bg-info-soft text-info"><MessageSquare size={17}/></span><div><h2 className="text-body font-semibold text-primary">飞书协作</h2><p className="text-caption text-secondary">{larkBotsLoading ? '正在读取接入状态…' : larkBots ? `${larkBots} 个机器人已接入` : '尚未接入机器人'}</p></div></div>
          <p className="mt-3 text-body text-secondary">在飞书中下达任务、跟进执行与接收结果。</p>
          <Button variant="secondary" fullWidth className="mt-3 justify-between" onClick={onOpenLarkSetup} iconEnd={<ArrowRight size={15}/>}>{larkBots ? '管理飞书 Bot' : '绑定飞书 Bot'}</Button>
          <div className="mt-3 flex items-center gap-1.5 border-t border-subtle pt-3 text-caption text-subtle"><Clock3 size={13}/><span>消息、卡片和群协作共用同一任务上下文</span></div>
        </Card>
      </div>
    </section>
  </div>;
}
