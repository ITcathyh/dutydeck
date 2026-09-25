import { Archive, BookOpen, ChevronRight, Folder, MessageSquare, PanelRightOpen, Pencil, Square, Terminal } from 'lucide-react';
import type { Agent, Session, SessionUsage, Task } from '../api';
import type { StreamStatus } from '../sse';
import { sessionDisplayName } from '../run-summary';
import { nextActionForState, sessionErrorSummary, sessionWorkspaceName, shortRunId } from '../workspace-model';
import { Badge, Banner, Button, IconButton, Tabs } from './primitives';
import { effectiveStatus, permissionLabels, stateTone } from './ui';

function ConnectionState({ status }: { status: StreamStatus }) {
  const label = status === 'open' ? '实时同步' : status === 'reconnecting' ? '正在重连' : '正在连接';
  // 圆点是真正的正圆，rounded-full 在这里合法（契约 §3 只禁止把它用在矩形上）。
  return <span title={label} className="inline-flex shrink-0 items-center gap-1.5 text-meta text-subtle"><span className={`h-1.5 w-1.5 rounded-full ${status === 'open' ? 'bg-action' : status === 'reconnecting' ? 'ui-status-pulse bg-warning-solid' : 'bg-neutral-solid'}`}/><span className="hidden sm:inline">{label}</span></span>;
}

export type RunDetailTab = 'timeline' | 'terminal';

/*
  详情页 timeline|terminal 标签栏。App.tsx 已消费此组件（commit 1a1100f），
  手写的 role=tablist 与方向键处理一并删除，方向键/Home/End 归 Tabs 原语。
  面板 id 也已按原语约定改为 `tabpanel-<id>` / `tab-<id>`。
*/
export function RunDetailTabs({ value, onChange }: { value: RunDetailTab; onChange(value: RunDetailTab): void }) {
  return <Tabs value={value} onChange={onChange} label="任务内容" items={[
    { id: 'timeline', label: '执行记录', icon: <MessageSquare size={13}/> },
    { id: 'terminal', label: '终端', icon: <Terminal size={13}/> }
  ]}/>;
}

/** 本任务累计用量：自身执行加归到它名下的编排子步骤；还没有任何记录时不显示。 */
function usageLabel(usage?: SessionUsage) {
  if (!usage) return undefined;
  const { own, subSteps } = usage;
  const entries = own.entries + subSteps.entries;
  if (!entries) return undefined;
  if (own.unavailable + subSteps.unavailable === entries) return { text: '本任务累计：无用量数据', detail: '此 Agent 不上报 token 与成本' };
  const usd = (value: number) => `$${value.toFixed(2)}`;
  const estimated = own.estimatedCostUsd + subSteps.estimatedCostUsd;
  const extra = [subSteps.entries ? `含子步骤 ${usd(subSteps.costUsd)}` : '', estimated > 0 ? `含估算 ${usd(estimated)}` : ''].filter(Boolean).join('，');
  const tokens = (key: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens') => (own[key] + subSteps[key]).toLocaleString('zh-CN');
  return { text: `本任务累计 ${usd(own.costUsd + subSteps.costUsd)}${extra ? `（${extra}）` : ''}`, detail: `输入 ${tokens('inputTokens')} · 输出 ${tokens('outputTokens')} · 缓存读 ${tokens('cacheReadTokens')} · 缓存写 ${tokens('cacheWriteTokens')} token` };
}

export function RunHeader({ session, agent, taskPrompt, streamStatus, queuedTasks, usage, rawVisible, rawAvailable, restarting, onInterrupt, onRestart, onOpenPrompt, onArchive, onToggleRaw, onRename }: {
  session: Session;
  agent?: Agent;
  taskPrompt?: string;
  streamStatus: StreamStatus;
  queuedTasks: Task[];
  usage?: SessionUsage;
  rawVisible: boolean;
  rawAvailable: boolean;
  restarting: boolean;
  onInterrupt(): void;
  onRestart(): void;
  onOpenPrompt(): void;
  onArchive(): void;
  onToggleRaw(): void;
  onRename?(): void;
}) {
  const managed = session.source === 'work_item';
  const workspace = sessionWorkspaceName(session);
  const taskGoal = sessionDisplayName(session, taskPrompt, '未命名任务');
  // 状态文案、是否呼吸、能否重新启动全部来自同一个判断，见 ui.tsx:effectiveStatus。
  // 这里曾经四处直接读 session.state，归档任务因此显示「思考中」+ 呼吸动画，
  // 并且给出可点击的「重新启动」按钮——归档是只读，那是功能缺陷。
  const status = effectiveStatus(session);
  // nextActionForState 的入参只有 state，拿不到 archivedAt，改签名会波及
  // workspace-model 里 attentionReasonForSession 等调用点；归档分支放在这里。
  const nextAction = managed ? '此步骤由目标管理；请从原目标处理授权、重试或停止' : status.archived ? '已归档任务只读；可查看历史记录，不能再下指令' : nextActionForState(session.state);
  // 下一步提示让用户「查看失败详情」，但详情页原先根本没有失败详情，只有总览页有。
  // 脱敏管线在 workspace-model:sessionErrorSummary，这里只读不改。
  // 归档任务同样要能看到：历史失败原因是只读信息，不是可操作项。
  const errorSummary = sessionErrorSummary(session.error);
  const usageLine = usageLabel(usage);
  return <header className="shrink-0 bg-surface">
    <div className="flex min-h-14 items-center gap-2 px-3 pt-1 sm:px-5">
      {/*
        这里原先有一枚 md:hidden 的汉堡，无障碍名同样是「打开工作台导航」。
        全局顶栏落地后导航入口收归 TopBar，再留一枚就等于同一屏上有两个同名按钮：
        读屏用户听到两遍，getByRole 也会抛 "found multiple elements"。

        缺陷 7：这一行原先塞了 workspace / 任务目标 / runId / cwd / Agent / 权限模式六类信息，
        移动端只剩一个截断标题。现在拆成两层：主行只回答「这是哪个仓库的什么任务」，
        工作目录等次要信息下沉到副行，runId 与右侧操作居中对齐。cwd 与 runId 在窄屏用 CSS 隐藏（不是条件渲染），
        Agent 名与权限姿态任何视口都留在可访问树里。
      */}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="max-w-28 shrink-0 truncate text-body font-medium text-subtle sm:max-w-44" title={workspace}>{workspace}</span>
          <ChevronRight size={13} className="shrink-0 text-subtle"/>
          <h1 className="min-w-0 flex-1 truncate text-title font-semibold text-primary" title={taskGoal}>{taskGoal}</h1>
          {!managed && <IconButton label="重命名会话" onClick={() => onRename?.()}><Pencil size={13}/></IconButton>}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-caption text-subtle">
          <span className="hidden min-w-0 items-center gap-1 sm:flex"><Folder size={11} className="shrink-0"/><span title={session.cwd} className="truncate">{session.cwd}</span><span className="shrink-0">·</span></span>
          <span className="shrink-0 truncate">{agent?.name ?? session.agentId}</span>
          {session.permissionMode && <><span className="shrink-0">·</span><span title="本任务的权限姿态" className={`shrink-0 font-medium ${session.permissionMode === 'full-trust' ? 'text-danger' : 'text-subtle'}`}>{permissionLabels[session.permissionMode]}</span></>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {/* runId 是低频元数据，text-meta 唯一合法的用途。 */}
        <span className="hidden shrink-0 pr-2 font-mono text-meta tracking-[.08em] text-subtle sm:inline">{shortRunId(session)}</span>
        {status.busy && !managed && <IconButton label="中断当前任务" onClick={onInterrupt}><Square size={14}/></IconButton>}
        {session.systemPrompt && <IconButton label="查看系统提示词" onClick={onOpenPrompt}><BookOpen size={14}/></IconButton>}
        {!status.archived && !managed && <IconButton label="归档任务" onClick={onArchive}><Archive size={15}/></IconButton>}
        <Button aria-label="原始日志" variant="secondary" tone={rawVisible ? 'inverse' : 'default'} disabled={!rawAvailable} onClick={onToggleRaw} icon={rawVisible ? <PanelRightOpen size={14}/> : <Terminal size={14}/>}><span className="hidden sm:inline">日志</span></Button>
      </div>
    </div>
    {/*
      状态条。圆点是这里唯一带 aria-label 的 span，状态文案在它右边的 <strong> 里——
      RunHeader.dom.test.tsx 用这两个结构做选择器，别给别的 span 加 aria-label。
      运行态圆点的配色来自 ui.tsx:stateTone，那是全站唯一的 state→色 映射，不在调用点
      另抄一份。归档与兜底这两支是 RunHeader 自己写的，与 stateTone 同用语义类。
    */}
    <div className="flex min-h-10 items-center gap-2.5 px-3 pb-1.5 sm:px-5">
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-sm bg-muted px-2 py-0.5">
        <span aria-label={status.label} className={`h-2 w-2 shrink-0 rounded-full ${status.busy ? 'ui-status-pulse' : ''} ${status.archived ? 'bg-neutral-solid' : stateTone[session.state] ?? 'bg-neutral-solid'}`}/>
        <strong className="text-caption font-semibold text-primary">{status.label}</strong>
      </span>
      <span className="min-w-0 flex-1 truncate text-caption text-secondary">{nextAction}</span>
      {status.recoverable && !managed && <Button variant="danger" size="sm" loading={restarting} onClick={onRestart}>重新启动</Button>}
      {queuedTasks.length > 0 && <Badge tone="queued">待执行指令 {queuedTasks.length} 条</Badge>}
      {usageLine && <span title={usageLine.detail} className="hidden shrink-0 text-caption text-subtle sm:inline">{usageLine.text}</span>}
      <ConnectionState status={streamStatus}/>
    </div>
    {errorSummary && <div className="px-3 pb-3 sm:px-5"><Banner tone="danger" title="失败详情">{errorSummary}</Banner></div>}
  </header>;
}
