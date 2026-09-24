import { useMemo, useState } from 'react';
import { CalendarClock, ChevronRight, FolderKanban, ListTodo, MessagesSquare, Plus, Settings2, ShieldCheck, Users } from 'lucide-react';
import type { Agent, LarkBotConfig, RunSummary, Session } from '../api';
import type { PrimaryNav } from '../app-route';
import { useMediaQuery } from '../useMediaQuery';
import { groupSessionsByWorkspace, type WorkbenchView, type WorkspaceGroup } from '../workspace-model';
import { formatLarkNavSummary } from '../lark-status';
import { createTaskAffordance, DutydeckIcon } from './ui';
import { Skeleton } from './primitives';
import { SessionRow } from './SessionRow';
import { SidebarNav, type SidebarNavGroup } from './SidebarNav';

export type SessionListProps = {
  open: boolean;
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
  /**
   * 主区一级视图。任务 / 机器人 / 群聊三选一，任何时刻只有一个为真；
   * 它决定 <main> 里渲染的是任务中心、Bot 管理还是群聊管理。
   */
  primaryNav?: PrimaryNav;
  /** 切换主区一级视图。不传时不渲染这一组导航（供仅列任务的用法复用）。 */
  onPrimaryNavChange?(nav: PrimaryNav): void;
  authRequired?: boolean;
};

/**
 * 工作台侧栏。
 *
 * 结构自上而下：品牌 → 创建操作 → 工作区任务列表（唯一可伸缩区）→ 功能导航 →
 * 运行环境状态。创建操作在**顶部**、导航在**底部**，是刻意的：创建是每天做几十次
 * 的高频动作，功能导航是每周点几次的低频跳转，把低频的放在拇指够不着也无所谓的
 * 位置，高频的留在视线起点。
 *
 * ## 浮动卡片，不是栅格列
 *
 * `fixed` + `inset-*-shell-gap` + `top-shell-top`，四周留 16px 空隙、带圆角和阴影，
 * 视觉上浮在画布之上。主区靠 `ml-main-inset`
 * 让位，那半边是 Team-Shell 的。两边必须同源：`--main-inset` 就定义成
 * `sidebar-w + shell-gap*2`，所以这里的 left/right 插入只能是 `shell-gap`，
 * 写死数字会在有人改 `--sidebar-w` 时留下空隙或压住正文，且没有任何测试会红。
 *
 * ## 状态筛选仍然不在这里
 *
 * 侧栏回答「按目录找任务」，总览页回答「按状态找任务」，两条正交的检索路径各留
 * 一处。桌面端侧栏恒常可见，两份筛选曾经必然同屏并列且各自漂移。底部新增的功能
 * 导航是第三件事——它是「去别的地方」，不是「在这里筛」，不与这条约束冲突。
 *
 * ## 关于配色
 *
 * `sidebar-*` 现在整组是 `var()` 引用（`--sidebar-surface: var(--surface-default)`
 * 等），跟随主题而不再是恒深色盘。原先几处「明明有原语却手写」的注释理由
 * （「原语的内容表面色套到恒深色底上会深字压深底」）已经失效，但手写保留：原语
 * 里没有 sidebar accent 这一档 variant，改用原语会让这几处颜色绕过 sidebar 语义层，
 * 将来 Team-Palette 想把侧栏重新分离出去就会漏改。语义类留着，成本为零。
 */
export function SessionList({ open, onClose, sessions, summaries, sessionsLoading, agents, agentsLoading = false, larkBots, larkBotsLoading = false, larkListeningDisabled = false, larkBotsFailed = false, activeSessionId, view, onSelect, onNewSession, onOpenControlCenter, onOpenLarkSetup, onOpenGroups, onOpenSchedules, primaryNav = 'tasks', onPrimaryNavChange, authRequired }: SessionListProps) {
  const workspaces = useMemo(() => groupSessionsByWorkspace(sessions, view, summaries), [sessions, summaries, view]);
  const matchesDesktop = useMediaQuery('(min-width: 768px)');
  /**
   * 折叠状态只记「用户手动改过的那些」，其余交给下面的默认规则。
   *
   * 不预填成「全部折叠」的完整表：那样一来新出现的工作区（飞书新建任务、别处
   * 起的会话）会因为不在表里而拿不到状态，得再补一层兜底；而且用户展开过的组
   * 在 sessions 刷新后会被重置——15 秒一次的 refetch 会让它自己收起来。
   */
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const toggleWorkspace = (id: string) => setOverrides(current => ({ ...current, [id]: !isExpandedById(id) }));
  /*
    默认展开规则两条，都以「折叠是否真的省行」为准：

    1. 当前打开任务所在的组 —— 选中态藏在折叠区里等于没有选中态。e2e 旅程 6 正是按
       `nav.getByRole('button', { name: /ALPHA_MARKER/ })` 取行再读 aria-current。

    2. 只有一条任务的组 —— 折叠它把「1 行任务」换成「1 行组头」，一行也没省，却让
       用户点两次才够得到那条任务。App.dom.test 里「切到另一个工作区的任务」两条用例
       就是撞在这上面失败的：那不是测试过时，是默认折叠一条任务的组确实是纯负担。
       降噪的收益全部来自多任务的组（18 条压到 4 行），这条规则不削弱它。

    3. 只剩一个工作区 —— 折叠后侧栏只有一行组头，看起来像没有任务，而折叠要解决的
       「多个组挤在一起」此时并不存在。

    用户手动折叠过（override === false）时仍然尊重用户，默认规则都让位。
  */
  const containsActive = (workspace: WorkspaceGroup) => workspace.sessions.some(session => session.id === activeSessionId);
  const autoExpanded = (workspace: WorkspaceGroup) => workspaces.length === 1 || workspace.sessions.length === 1 || containsActive(workspace);
  const isExpandedById = (id: string) => {
    const workspace = workspaces.find(item => item.id === id);
    return overrides[id] ?? (workspace ? autoExpanded(workspace) : false);
  };
  const isExpanded = (workspace: WorkspaceGroup) => overrides[workspace.id] ?? autoExpanded(workspace);
  // 读不到 media query 时侧栏必须保守地当作桌面（可见、可访问）。当成移动端会让
  // hiddenOnMobile 翻真，整个导航带上 inert + aria-hidden 从可访问树里摘掉：
  // SSR 首屏会丢掉侧栏，jsdom（默认没有 window.matchMedia）里则是所有按名字取
  // 侧栏节点的用例集体失败。useMediaQuery 的通用默认是「读不到当不命中」，方向
  // 与这里相反——不命中对别处只是少一点样式，对侧栏却是整块消失，所以这条反向
  // fallback 留在调用点，不去改那个通用 hook。
  const desktop = typeof window === 'undefined' || typeof window.matchMedia !== 'function' ? true : matchesDesktop;
  const createTask = createTaskAffordance({ agents, agentsLoading, onCreate: onNewSession, onPrepareAgents: onOpenControlCenter });
  const hiddenOnMobile = !desktop && !open;

  /**
   * 导航项的选取。**每一项都是在补一条原本没有常驻入口的路**，不是把已有按钮再抄一份。
   *
   * 分两组，切的是「配置什么」的聚焦划分（dutydeck 当前核心聚焦在接入与自动化两类场景，
   * 避免划分过多导致空壳分组）。
   *
   * · 接入 —— 让任务能从外部进来：Agent 是执行者，飞书是消息入口。
   * · 自动化 —— 让任务不靠人点也能发生：群策略当前只有草稿态；定时入口查看
   *   任务执行计划，导入定义另存为草稿。
   *
   * 刻意**不放**进来的（都已有常驻可见入口，第二份只是噪音）：
   * · 任务中心 / 回首页 —— 顶栏品牌位（TopBar 的 onGoHome）。
   * · 搜索 / 命令面板、外观、快捷键帮助 —— 顶栏右侧三枚控件。
   * · 创建任务 —— 就在这块导航正上方。
   * · 已归档 —— 它是总览页的状态筛选（数字键 5），放进侧栏就是在侧栏里重建了一份
   *   状态筛选，正是上面那条正交约束禁止的事。
   */
  /*
    主区一级导航。切的是 <main> 里渲染什么（任务中心 / Bot 管理 / 群聊管理），
    切完侧栏仍在，所以三项都带 active，用户看得见自己在哪。

    机器人和群聊是一级目的地而不是设置页分区：日常操作要的是「选中对象后直接改」，
    「设置中心 → 分区 → 弹窗 → 再选对象」正是本轮要消灭的层级。

    hint 的口径与下面「飞书接入」同源（formatLarkNavSummary），不另造措辞。
  */
  const primaryNavGroups: SidebarNavGroup[] = onPrimaryNavChange ? [{ id: 'workspace', title: '工作台', items: [
    { id: 'nav-tasks', label: '任务', hint: `${sessions.length} 个任务 · 创建与跟进`, Icon: ListTodo, active: primaryNav === 'tasks', onClick: () => { onPrimaryNavChange('tasks'); onClose(); } },
    { id: 'nav-bots', label: '机器人', hint: formatLarkNavSummary({ bots: larkBots, listeningDisabled: larkListeningDisabled, loading: larkBotsLoading, failed: larkBotsFailed }), Icon: MessagesSquare, active: primaryNav === 'bots', onClick: () => { onPrimaryNavChange('bots'); onClose(); } },
    { id: 'nav-groups', label: '群聊', hint: '群内每个 Bot 的目录与触发', Icon: Users, active: primaryNav === 'groups', onClick: () => { onPrimaryNavChange('groups'); onClose(); } }
  ] }] : [];

  const navGroups: SidebarNavGroup[] = [
    { id: 'access', title: '接入', items: [
      // 唯一一项本来就有常驻入口的，因为它原本就在这个位置，移走等于制造回归；
      // 计数从原来的行尾挪进 hint，理由见下面 292→248 的说明。
      { id: 'settings', label: 'Agent 与设置', hint: `${agents.length} 个 Agent${larkBots.length ? ` · ${larkBots.length} 个 Bot` : ''}`, Icon: Settings2, onClick: onOpenControlCenter },
      /*
        飞书接入状态与总览页同源真实投影（formatLarkNavSummary），
        绝不把未完成配置或禁用监听谎报为「已接入」。
      */
      { id: 'lark', label: '飞书接入', hint: formatLarkNavSummary({ bots: larkBots, listeningDisabled: larkListeningDisabled, loading: larkBotsLoading, failed: larkBotsFailed }), Icon: MessagesSquare, onClick: onOpenLarkSetup }
    ] },
    { id: 'automation', title: '自动化', items: [
      /*
        hint 是**能力声明**，不是描述性文案，改动前先读 SidebarNav 的头注释。

        群策略不是「暂未完成」而是类型层面写死的：`FoundationCapability.runtimeWired`
        是字面量 `false`（api.ts），服务端恒挂对应 blocker，用词逐字取自
        GroupPolicyModal「尚未接入运行时」。

        定时入口展示真实 session 自动化总览：任务内创建并启用的计划会按时运行，
        导入定义仅保存为草稿，hint 与 ControlCenterModal 自动化分区同源，不统称
        「不会自动执行」。

        门控刻意不做：`disabled` 会让用户既进不去也看不到为什么。面板自己会把
        状态列全，进得去才读得到；而且可用性判定要读 foundationApi/scheduleApi
        的 capabilities，为了给侧栏画个灰按钮就多拉两个查询，代价与收益不成比例。
      */
      { id: 'groups', label: '群与权限', hint: '策略草稿 · 尚未接入运行时', Icon: Users, onClick: onOpenGroups },
      { id: 'schedules', label: '定时任务', hint: '任务执行计划与草稿', Icon: CalendarClock, onClick: onOpenSchedules }
    ] }
  ];

  return <aside
    aria-label="Dutydeck 工作台导航"
    aria-hidden={hiddenOnMobile || undefined}
    inert={hiddenOnMobile || undefined}
    /*
      移动端是贴边全高的抽屉（inset-y-0 left-0，靠 translate-x 滑入滑出），
      桌面端才变成四周留白的浮动卡片。两套定位共用一个节点、只靠 md: 前缀切换，
      不做两份 DOM——抽屉的 inert/aria-hidden 与焦点管理只写一次才不会漏。

      shadow 在移动端和桌面端都保留：抽屉浮在遮罩之上，卡片浮在画布之上，
      都需要与背后拉开层次。
    */
    className={`fixed inset-y-0 left-0 z-drawer flex w-sidebar flex-col overflow-hidden border-r border-sidebar-border bg-sidebar-surface text-sidebar-text shadow-sidebar transition-transform duration-normal ease-emphasized md:bottom-shell-gap md:left-shell-gap md:top-shell-top md:translate-x-0 md:rounded-lg md:border ${open ? 'translate-x-0' : '-translate-x-full'}`}
  >
    {/*
      品牌块在移动端才渲染。桌面端顶栏已有可点的品牌位（TopBar 的「Dutydeck 首页」），
      再挂一份不可点的同名文字，读屏会连读两次「Dutydeck」，而其中一个还不是控件。
      移动端顶栏被抽屉遮住，这里是唯一的品牌锚点，保留。
    */}
    <div className="flex h-14 shrink-0 items-center gap-2.5 px-4 md:hidden"><DutydeckIcon className="h-8 w-8 shrink-0"/><span><strong className="block text-body font-semibold tracking-[-.025em] text-sidebar-text-strong">Dutydeck</strong><span className="block text-caption text-sidebar-text-muted">Agent 任务台</span></span></div>

    <div className="shrink-0 px-3 pt-2 md:pt-3">
      {/* 手写而不是用 <Button>：原语没有 sidebar 这一层语义色。
          min-h-10 是触控下限（§9），也是多处用例按名字取这颗按钮的前提，不能改小。
          40px 高按 §3 取 rounded-md（10px）。

          层级是**次操作**：飞书 Bot 是 agent 交互核心，首屏强主 CTA 是 Bot 概览里的
          「绑定/管理飞书 Bot」。这颗原先是整块 sidebar-accent 实底，在桌面端与那颗
          同屏时抢主入口。改成描边 + 常规字重，配色仍走 sidebar-* 语义层（不借用内容
          表面色），键盘与 disabled 行为不变。 */}
      <button type="button" disabled={createTask.disabled} onClick={createTask.onClick} className="flex min-h-10 w-full items-center justify-center gap-2 rounded-md border border-sidebar-border px-3 text-body font-medium text-sidebar-text transition-colors duration-fast ease-out hover:bg-sidebar-hover hover:text-sidebar-text-strong active:translate-y-px disabled:opacity-60"><Plus size={16}/>{createTask.label}</button>
    </div>

    {/*
      主区一级导航，在任务列表**之上**。

      它与底部那两组导航本质不同：底部打开的是浮层，这三项换的是 <main> 里渲染
      什么，切完侧栏还在，所以带 aria-current（SidebarNav 的 active）。

      放在顶部而不是底部，是因为「今天要处理哪个对象」是进站第一个决定：任务、
      某个 Bot、某个群。放到底部会让机器人和群聊看起来像设置的附属项，那正是
      本轮要消灭的「设置中心 → 分区 → 弹窗 → 再选对象」层级。

      onPrimaryNavChange 不传时整组不渲染：仅列任务的调用点不该长出三颗点不动的按钮。
    */}
    {onPrimaryNavChange && <div className="mt-1 shrink-0"><SidebarNav groups={primaryNavGroups}/></div>}

    {/* 任务列表是唯一 flex-1 的区块：卡片高度固定（top/bottom 都钉死），多出来的
        任务在这里滚，导航区和状态行不参与滚动，始终可见。 */}
    <div className={`mt-3 min-h-0 flex-1 flex-col ${primaryNav === 'tasks' ? 'flex' : 'hidden'}`}><div className="flex items-center px-4 pb-2 text-caption font-semibold text-sidebar-text-muted"><FolderKanban size={13} className="mr-2"/>工作区<span className="ml-auto font-mono text-meta">{workspaces.length}</span></div><div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">{sessionsLoading
      /* Skeleton 的条子写死 bg-muted，与 sidebar-hover 现在同源但不同名；这里用
         arbitrary variant 覆盖条子底色，让它跟着 sidebar 语义层走而不是内容表面层。 */
      ? <Skeleton variant="block" lines={2} className="px-1 [&>div]:bg-sidebar-hover"/>
      : workspaces.length ? workspaces.map(workspace => {
        const expanded = isExpanded(workspace);
        return <section key={workspace.id} className="mb-1.5">
          {/*
            分组标题是折叠开关。原先它是个不可点的 div，18 条任务全部平铺——
            侧栏于是变成主区任务列表的一份低配副本（见 SessionRow 的头注释）。
            折叠之后默认只剩「目录名 + 条数」，实测 18 行降到 4 行。
            单任务的组默认仍展开，理由见上面 autoExpanded 的注释。

            min-h-10 是触控下限（§9），也让 shell.spec.ts:264 那条两轴命中区断言过关；
            40px 高按 §3 取 rounded-md。
          */}
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
          {expanded && <div className="mt-0.5">{workspace.sessions.map(session => <SessionRow key={session.id} session={session} summary={summaries[session.id]} agent={agents.find(item => item.id === session.agentId)} botName={larkBots.find(bot => session.sourceId?.startsWith(`${bot.appId}:`))?.name} active={activeSessionId === session.id} onClick={() => { onSelect(session.id); onClose(); }}/>)}</div>}
        </section>;
      })
      /* 空态不用 <EmptyState>：原语取 text-secondary / text-subtle / bg-muted，走的是
         内容表面色盘。侧栏色现在虽与内容色同源，但语义层是两套，混用会让侧栏在
         色盘再次分离时漏改。框高约 66px（py-6 + 一行 18px），按 §3 取 rounded-lg。 */
      : <div className="rounded-lg border border-dashed border-sidebar-border px-4 py-6 text-center text-caption text-sidebar-text-muted">当前视图没有任务。</div>}</div></div>

    <div className={`${primaryNav === 'tasks' ? '' : 'mt-auto'} shrink-0 border-t border-sidebar-border pt-1`}>{onPrimaryNavChange
      ? <details className="group/tools px-2.5"><summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-md px-2 text-caption font-medium text-sidebar-text transition-colors duration-fast ease-out hover:bg-sidebar-hover hover:text-sidebar-text-strong [&::-webkit-details-marker]:hidden"><Settings2 aria-hidden="true" size={14} className="shrink-0 text-sidebar-text-muted"/>设置与工具<ChevronRight aria-hidden="true" size={13} className="ml-auto shrink-0 text-sidebar-text-muted transition-transform duration-fast group-open/tools:rotate-90"/></summary><SidebarNav groups={navGroups}/></details>
      : <SidebarNav groups={navGroups}/>}</div>

    {/* 运行环境状态。它是事实陈述不是入口，所以在导航区之外、不做成按钮。 */}
    <div className="shrink-0 border-t border-sidebar-border px-4 py-2 text-meta text-sidebar-text-faint">{authRequired === false ? <span className="flex items-center gap-1.5 text-sidebar-accent"><ShieldCheck size={12}/>受信开发机模式 · 无需 token</span> : '本机运行 · ACPX 0.13'}</div>
  </aside>;
}
