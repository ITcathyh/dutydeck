import { useEffect, useState } from 'react';
import { AlertTriangle, Archive, ArrowRight, CheckCircle2, CircleDot, MessageSquare, Plus, Radio, Settings2 } from 'lucide-react';
import type { Agent, LarkBotConfig, RunSummary, Session } from '../api';
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
  sessionWorkspaceName
} from '../workspace-model';
import { fallbackRunTitle } from '../run-summary';
import { Badge, Button, Card, EmptyState, Skeleton, StatusBadge } from './primitives';
import { createTaskAffordance } from './ui';
import { formatLarkNavSummary, projectLarkBotStatus } from '../lark-status';

type OverviewProps = {
  sessions: Session[];
  summaries: Record<string, RunSummary>;
  agents: Agent[];
  loading: boolean;
  agentsLoading?: boolean;
  larkBots: LarkBotConfig[];
  larkBotsLoading?: boolean;
  larkListeningDisabled?: boolean;
  /** Bot 状态读取失败：不得映射成「尚未配置」或沿用缓存宣称在线。 */
  larkBotsFailed?: boolean;
  larkBotsRetrying?: boolean;
  onRetryLarkBots?(): void;
  view: WorkbenchView;
  onViewChange(view: WorkbenchView): void;
  onSelect(id: string): void;
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
  return <div className="flex border-t border-subtle first:border-t-0">
    {selection && <label className="flex min-h-10 min-w-10 shrink-0 cursor-pointer items-center justify-center pl-2" title={selection.disabled ? '此步骤由目标管理，请从原目标处理' : undefined}>
      <input type="checkbox" aria-label={`选择任务：${summary?.prompt ?? sessionWorkspaceName(session)}`} checked={selection.checked} disabled={selection.disabled} onChange={selection.onChange} className="h-4 w-4 accent-action"/>
    </label>}
    <button
    type="button"
    data-task-priority={section}
    onClick={() => onSelect(session.id)}
    className="group grid min-h-[72px] w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-hover sm:flex sm:items-center sm:gap-3 sm:px-5"
  >
    {/* 徽标文案与归档优先判据都来自 effectiveStatus，由 StatusBadge 单点消费；这里不再拼配色字符串。 */}
    <span className="mt-0.5 shrink-0 sm:mt-0"><StatusBadge session={session}/></span>
    <span className="min-w-0 flex-1">
      <strong className="block text-body font-semibold text-primary sm:truncate" title={summary?.prompt}>{summary?.prompt ?? fallbackRunTitle(session.source)}</strong>
      <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-caption text-secondary">
        <span>{sessionWorkspaceName(session)}</span><span aria-hidden="true">·</span><span>{agent?.name ?? session.agentId}</span>
        {section === 'attention' && <><span aria-hidden="true">·</span><span className="font-medium text-primary">{attentionReasonForSession(session)}</span></>}
        {queuedCommands > 0 && <span className="rounded-sm bg-queued-soft px-1.5 py-0.5 font-medium text-queued">待执行指令 {queuedCommands} 条</span>}
      </span>
    </span>
    <span className="col-span-2 flex shrink-0 items-center justify-between gap-1 text-caption text-subtle sm:flex-col sm:items-end">
      <span title={updatedAt ? new Date(updatedAt).toLocaleString('zh-CN') : undefined}>更新于 {relativeTime}</span>
      {session.state === 'waiting_for_permission' && <span className="font-medium text-action sm:hidden">查看审批 →</span>}
      {/* runId 是契约 §2 点名允许 text-meta 的低频元数据。 */}
      <span className="hidden font-mono text-meta sm:block">{shortRunId(session)}</span>
    </span>
    <ArrowRight aria-hidden="true" size={16} className="hidden shrink-0 text-subtle group-hover:text-action sm:block"/>
  </button></div>;
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
 * 任务列表区的两种空状态。
 *
 * 这两支原本挤在一个 1400+ 字符的三元嵌套里（旧 WorkspaceOverview.tsx:147），
 * 读的人无法确认「哪个条件走到哪一支」，改一支就得重读整行。拆开之后各自
 * 独立，语义差别也才看得出来：
 *
 *   guide    首次使用，一条任务都没有 → 带主 CTA 的引导。
 *   positive 有任务，但当前筛选视图筛不出 → 「没有待办」是好消息，绿勾，不是失望的灰。
 *            契约 §10 明写这一档「不得用灰色失望感呈现」：把「你已经处理完了」
 *            画成灰色空盒子，是在为一件好事道歉。
 *
 * guide 这一支保留手写结构，理由是 **标题必须是真 heading**：
 * `scripts/e2e-smoke.mjs:488` 用 `getByRole('heading', { name: '从第一个明确目标开始' })`
 * 断言它，而 EmptyState 原语把 title 渲染成 `<p>`（primitives/EmptyState.tsx:38），
 * 换过去会让那条断言失效。
 *
 * 此处原先还写着另一条理由——「EmptyState 的 primaryAction 传不了 disabled 态」——
 * 那是错的：`primitives/EmptyState.tsx:13` 从 Phase 1 起就有 `disabled?: boolean`，
 * 41 行也确实透传。别再用那条理由论证任何事。
 */
function TaskListEmpty({ firstUse, hasAgents, createTask }: {
  firstUse: boolean;
  hasAgents: boolean;
  createTask: ReturnType<typeof createTaskAffordance>;
}) {
  if (!firstUse) return <Card padding="none">
    <EmptyState
      tone="positive"
      title="当前视图没有任务"
      description="选择其他状态，或创建一个新任务。"
    />
  </Card>;

  /*
    只有一颗按钮，且是次操作。这里原先并排放着「绑定飞书 Bot」，但 Bot 概览卡片
    恒渲染同一个入口，且无 Bot 时文案逐字相同——首次使用（无任务 + 无 Bot，
    也就是全新装完打开的样子）时同屏出现两颗可及名完全一致的按钮，
    `getByRole('button', { name: '绑定飞书 Bot' })` 直接抛 found multiple elements。
    现有用例全部恰好绕开了那个组合，所以它一直没被发现。

    首次绑定是引导卡片里的主 CTA；
    Web 创建任务是次操作，这里用 secondary。
  */
  return <Card padding="lg">
    <span className="grid h-10 w-10 place-items-center rounded-md bg-action-soft text-action"><Plus size={19}/></span>
    <h2 className="mt-4 text-title font-semibold text-primary">{hasAgents ? '从第一个明确目标开始' : '先准备一个可用 Agent'}</h2>
    <p className="mt-1 max-w-xl text-body text-secondary">{hasAgents ? '可在飞书私聊发目标或群聊 @机器人 下达任务；也可以在这里创建任务直接执行。' : 'Dutydeck 会自动发现这台机器上已安装并登录的 Agent CLI。准备完成后，就能把它连接到飞书或直接创建任务。'}</p>
    <div className="mt-5 flex flex-wrap gap-2">
      <Button variant="secondary" disabled={createTask.disabled} onClick={createTask.onClick} iconEnd={<ArrowRight size={15}/>}>{hasAgents ? '创建第一个任务' : createTask.label}</Button>
    </div>
  </Card>;
}

/** 接入摘要与异常沿用侧栏的真实状态投影；首次使用保留完整引导。 */
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

  return <Card as="aside" aria-label="协作入口" padding="sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2"><MessageSquare size={18} className="shrink-0 text-info"/><div><h2 className="text-body font-semibold text-primary">飞书机器人</h2><p className="text-caption text-secondary">{summary}</p></div></div>
      <Button variant={firstUse ? 'primary' : 'secondary'} onClick={firstUse ? onOpenLarkSetup : onManageBots} icon={firstUse ? <Plus size={15}/> : <Settings2 size={15}/>}>{firstUse ? '绑定飞书 Bot' : '管理飞书 Bot'}</Button>
    </div>
    {noAgents && <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning-border bg-warning-soft p-3 text-caption text-warning"><span>尚未检测到本机可用 Agent，机器人收到消息后无法执行任务。</span><Button variant="secondary" onClick={onOpenAgentSetup}>准备 Agent</Button></div>}
    {loading ? <div className="mt-3"><Skeleton variant="row"/></div> : failed ? <div className="mt-3 rounded-md border border-warning-border bg-warning-soft p-3 text-caption text-warning"><h3 className="font-semibold">无法读取飞书接入状态</h3><p className="mt-1">{bots.length ? '已有配置记录，但这一次状态读取失败，无法确认机器人当前能否收到消息。' : '状态读取失败，因此无法判断是否已配置机器人。配置入口仍然可用。'}</p><Button variant="secondary" className="mt-2" loading={retrying} disabled={retrying} onClick={onRetry}>{retrying ? '重试中…' : '重试'}</Button></div> : firstUse ? <div className="mt-3 rounded-md bg-muted p-4">
      <h3 className="text-body font-semibold text-primary">尚未配置飞书机器人</h3>
      <p className="mt-1 text-body text-secondary">绑定后在飞书私聊发送工程目标，或在群聊中 @机器人 下达任务；发送 <code className="rounded-sm bg-surface px-1.5 py-0.5 font-mono text-meta text-primary">/help</code> 查看可用操作。</p>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-caption text-secondary"><span className="flex items-center gap-1.5 font-medium"><CheckCircle2 size={14} className="text-success"/>私聊发目标</span><span className="flex items-center gap-1.5 font-medium"><CheckCircle2 size={14} className="text-success"/>群聊 @机器人</span><span className="flex items-center gap-1.5 font-medium"><CheckCircle2 size={14} className="text-success"/>/help 查看操作</span></div>
    </div> : null}
    {!loading && exceptions.length > 0 && <details className="mt-2"><summary className="min-h-11 cursor-pointer py-3 text-caption font-medium text-warning">{exceptions.length} 个机器人需要检查</summary><div className="space-y-2">{exceptions.map(({ bot, status }) => <div key={bot.appId} className="rounded-md bg-muted p-3"><div className="flex flex-wrap items-center gap-2"><strong className="text-body font-medium">{bot.name || bot.tabLabel || bot.appId}</strong><Badge tone={status.tone}>{status.label}</Badge></div><p className="mt-1 text-caption text-secondary">{status.description}</p></div>)}</div></details>}
  </Card>;
}

export function WorkspaceOverview({ sessions, summaries, agents, loading, agentsLoading = false, larkBots, larkBotsLoading = false, larkListeningDisabled = false, larkBotsFailed = false, larkBotsRetrying = false, onRetryLarkBots, view, onViewChange, onSelect, onBulkArchive, onCreate, onOpenAgentSetup, onOpenLarkSetup, onManageBots = onOpenLarkSetup }: OverviewProps) {
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  useEffect(() => { setSelecting(false); setSelectedIds([]); }, [view]);
  useEffect(() => {
    setSelectedIds(current => current.filter(id => sessions.some(session => session.id === id && !session.archivedAt && session.source !== 'work_item')));
  }, [sessions]);
  const counts = workbenchCounts(sessions, summaries);
  const ordered = orderSessionsForWorkbench(sessions, view, summaries);
  const selectable = ordered.filter(session => !session.archivedAt && session.source !== 'work_item');
  const selected = selectable.filter(session => selectedIds.includes(session.id)).map(session => session.id);
  const allSelected = selectable.length > 0 && selected.length === selectable.length;
  const selectedLabel = workbenchViewLabels[view];
  const createTask = createTaskAffordance({ agents, agentsLoading, onCreate, onPrepareAgents: onOpenAgentSetup });
  const sections: Array<{ id: WorkbenchTaskSection; sessions: Session[] }> = view === 'all'
    ? (['attention', 'active', 'recent'] as WorkbenchTaskSection[]).map(id => ({ id, sessions: ordered.filter(session => workbenchTaskSection(session, summaries[session.id]) === id) })).filter(section => section.sessions.length > 0)
    : [{ id: view === 'active' ? 'active' : view === 'attention' ? 'attention' : 'recent', sessions: ordered }];
  // 骨架必须盖住 agents 还在检测的那一段：先闪一次空状态会让用户以为「真的没有任务」。
  const pending = loading || agentsLoading;
  const hasTasks = sections.length > 0 && ordered.length > 0;

  return <div className="min-h-0 flex-1 overflow-y-auto bg-canvas">
    <section aria-labelledby="workspace-overview-title" className="mx-auto w-full max-w-[1120px] px-4 pb-12 pt-6 sm:px-8 sm:pt-8 lg:px-10">
      <header className="flex flex-col gap-4 border-b border-default pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-body font-medium text-secondary">任务中心</p>
          <h1 id="workspace-overview-title" className="mt-1 text-display font-semibold tracking-[-.035em] text-primary">今天需要推进什么？</h1>
          {/* 这句话里的数字必须来自 counts，与下面的筛选芯片同源；分区标题也数同一个集合。 */}
          <p className="mt-2 text-body text-secondary">{headlineFor({ loading, agentsLoading, counts, hasAgents: agents.length > 0 })}</p>
        </div>
        {/*
          这里只放「创建任务」一枚控件，且是**次操作**：飞书 Bot 是 agent 交互核心，
          首次使用时的强主 CTA 是下面 Bot 概览里的「绑定飞书 Bot」。
          搜索、外观切换、快捷键帮助都在全局顶栏（TopBar）里常驻：它们此前在这里也
          各有一份，但 App.tsx 的调用点从加上顶栏那天起就不再传 onOpenSearch /
          onOpenShortcuts / themeControl，三段代码因此永不渲染。留着不是「备用」——
          一旦有人把 prop 接回来，同屏立刻出现两个可及名逐字相同的搜索框与快捷键钮，
          读屏连播两遍，getByRole 直接抛 found multiple elements（TopBar.tsx:64-69
          记着同类事故）。
        */}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" disabled={createTask.disabled} onClick={createTask.onClick} icon={<Plus size={17}/>}>{createTask.label}</Button>
        </div>
      </header>

      {/* 已有 Bot 用紧凑摘要，给待处理任务留出首屏。 */}
      <div className="mt-6">
        <LarkBotsOverview bots={larkBots} agents={agents} loading={larkBotsLoading} agentsLoading={agentsLoading} listeningDisabled={larkListeningDisabled} failed={larkBotsFailed} retrying={larkBotsRetrying} onRetry={() => onRetryLarkBots?.()} onOpenLarkSetup={onOpenLarkSetup} onOpenAgentSetup={onOpenAgentSetup} onManageBots={onManageBots}/>
      </div>

      <section aria-label="任务筛选" className="-mx-1 mt-6 overflow-x-auto px-1 pb-1">
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

      {onBulkArchive && !pending && view !== 'archived' && (selectable.length > 0 || selecting) && <div className="mt-4 flex flex-wrap items-center gap-2" aria-label="批量清理任务">
        {selecting ? <>
          <label className="flex min-h-10 cursor-pointer items-center gap-2 px-2 text-caption text-secondary">
            <input type="checkbox" aria-label="全选当前视图" checked={allSelected} disabled={!selectable.length} ref={node => { if (node) node.indeterminate = selected.length > 0 && !allSelected; }} onChange={() => setSelectedIds(allSelected ? [] : selectable.map(session => session.id))} className="h-4 w-4 accent-action"/>
            全选当前视图
          </label>
          <span role="status" className="text-caption text-secondary">已选 {selected.length} 个任务</span>
          <Button variant="danger" disabled={!selected.length} icon={<Archive size={15}/>} onClick={() => onBulkArchive(selected)}>清理所选任务</Button>
          <Button variant="ghost" onClick={() => { setSelecting(false); setSelectedIds([]); }}>退出多选</Button>
        </> : <Button variant="secondary" icon={<Archive size={15}/>} onClick={() => setSelecting(true)}>批量清理</Button>}
      </div>}

      {/* Bot 概览已占据首屏上段，任务列表在这里独占整个宽度，不再留右侧次列。 */}
      <div className="mt-5">
        <section aria-label="任务列表" className="min-w-0">
          {pending
            ? <Card><Skeleton variant="block" lines={2}/></Card>
            : hasTasks
              ? <div className="space-y-6">{sections.map(section => <section key={section.id} aria-labelledby={`task-section-${section.id}`}>
                {/*
                  分区标题不再挂条数。同一个数字此前在同屏出现三遍：页首那句散文
                  （headlineFor：「N 个任务需要你先处理，N 个正在进行」）、筛选芯片
                  的计数、以及这里的「N 个」。三者同源 counts，不会数错，但读者要
                  读三遍才知道是同一件事。规范 §5.1 只要求**页首**回答「有几个阻塞项、
                  有几个正在进行」，芯片计数是筛选器的一部分，这第三份没有依据。

                  非 all 视图下更明显：标题退化成 selectedLabel，与正上方那枚
                  aria-pressed 的芯片同名同数，相距不到 100px。

                  副标题同样只在 all 视图给：非 all 时它原是「按最近更新排序」，
                  而 orderSessionsForWorkbench 在三个分区下都按时间排序，
                  那句话对谁都成立，因此不携带任何信息。
                */}
                <div className="mb-2">
                  <h2 id={`task-section-${section.id}`} className="text-title font-semibold text-primary">{view === 'all' ? sectionCopy[section.id].title : selectedLabel}</h2>
                  {view === 'all' && <p className="mt-0.5 text-caption text-secondary">{sectionCopy[section.id].description}</p>}
                </div>
                <Card padding="none" className="overflow-hidden">{section.sessions.map(session => <TaskRow key={session.id} session={session} summary={summaries[session.id]} agent={agents.find(agent => agent.id === session.agentId)} section={section.id} onSelect={onSelect} selection={selecting ? { checked: selected.includes(session.id), disabled: session.source === 'work_item', onChange: () => setSelectedIds(current => current.includes(session.id) ? current.filter(id => id !== session.id) : [...current, session.id]) } : undefined}/>)}</Card>
              </section>)}</div>
              : <TaskListEmpty firstUse={view === 'all' && sessions.length === 0} hasAgents={agents.length > 0} createTask={createTask}/>}
        </section>
      </div>
    </section>
  </div>;
}
