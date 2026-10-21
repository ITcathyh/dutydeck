import { Archive, BookOpen, ChevronRight, FileDiff, LineChart, MessageSquare, PanelRightOpen, Pencil, RotateCcw, Square, Terminal } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Agent, Session, SessionUsage, Task } from '../api';
import type { StreamStatus } from '../sse';
import { sessionDisplayName } from '../run-summary';
import { nextActionForState, sessionErrorSummary, sessionWorkspaceName } from '../workspace-model';
import { Badge, Banner, Button, IconButton, Tabs } from './primitives';
import { effectiveStatus, permissionLabels, stateTone } from './ui';
import { usd } from './usageFormat';

function ConnectionState({ status }: { status: StreamStatus }) {
  const label = status === 'open' ? '实时同步' : status === 'reconnecting' ? '正在重连' : '正在连接';
  // 圆点是真正的正圆，rounded-full 在这里合法（契约 §3 只禁止把它用在矩形上）。
  return <span title={label} className="inline-flex shrink-0 items-center gap-1.5 text-meta text-subtle"><span className={`h-1.5 w-1.5 rounded-full ${status === 'open' ? 'bg-action' : status === 'reconnecting' ? 'ui-status-pulse bg-warning-solid' : 'bg-neutral-solid'}`}/><span className="hidden sm:inline">{label}</span></span>;
}

export type RunDetailTab = 'timeline' | 'changes' | 'terminal';

export function RunDetailTabs({ value, onChange, terminalAvailable = true }: { value: RunDetailTab; onChange(value: RunDetailTab): void; terminalAvailable?: boolean }) {
  return <Tabs value={value} onChange={onChange} label="任务内容" items={[
    { id: 'timeline', label: '对话', icon: <MessageSquare size={13}/> },
    { id: 'changes', label: '改动', icon: <FileDiff size={13}/> },
    ...(terminalAvailable ? [{ id: 'terminal' as const, label: '终端', icon: <Terminal size={13}/> }] : [])
  ]}/>;
}

/** 本任务累计用量：自身执行加归到它名下的编排子步骤；还没有任何记录时不显示。 */
export function usageLabel(usage?: SessionUsage) {
  if (!usage) return undefined;
  const { own, subSteps } = usage;
  const entries = own.entries + subSteps.entries;
  if (!entries) return undefined;
  if (own.unavailable + subSteps.unavailable === entries) return { text: '本任务账本：无用量数据', detail: usage.snapshot?.nativeTokens ? '原生会话 token 见下方；此读数不计入账本费用' : '已完成的执行未记录 token 与成本' };
  const estimated = own.estimatedCostUsd + subSteps.estimatedCostUsd;
  const unknown = (own.unknownCostEntries ?? (own.unpriced ?? 0) + own.unavailable)
    + (subSteps.unknownCostEntries ?? (subSteps.unpriced ?? 0) + subSteps.unavailable);
  const extra = [unknown ? `另有 ${unknown} 次费用未知` : '', subSteps.entries ? `含子步骤 ${usd(subSteps.costUsd)}` : '', estimated > 0 ? `含估算 ${usd(estimated)}` : ''].filter(Boolean).join('，');
  const tokens = (key: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens') => (own[key] + subSteps[key]).toLocaleString('zh-CN');
  return { text: `本任务${unknown ? '已知费用' : '累计'} ${usd(own.costUsd + subSteps.costUsd)}${extra ? `（${extra}）` : ''}`, detail: `输入 ${tokens('inputTokens')} · 输出 ${tokens('outputTokens')} · 缓存读 ${tokens('cacheReadTokens')} · 缓存写 ${tokens('cacheWriteTokens')} token` };
}

export function RunHeader({ session, agent, taskPrompt, streamStatus, queuedTasks, tools, rawVisible, rawAvailable, restarting, onInterrupt, onRestart, onOpenPrompt, onArchive, onToggleRaw, onRename, onOpenInsight }: {
  session: Session;
  agent?: Agent;
  taskPrompt?: string;
  streamStatus: StreamStatus;
  queuedTasks: Task[];
  usage?: SessionUsage;
  /** 目标、工作目录等面板入口，排在「分析」前面。 */
  tools?: ReactNode;
  rawVisible: boolean;
  rawAvailable: boolean;
  restarting: boolean;
  onInterrupt(): void;
  onRestart(): void;
  onOpenPrompt(): void;
  onArchive(): void;
  onToggleRaw(): void;
  onRename?(): void;
  onOpenInsight(): void;
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
  return <header className="shrink-0 bg-surface">
    <div className="flex flex-wrap items-center gap-x-2 px-3 pt-2 sm:px-5">
      <div className="min-w-0 grow basis-48">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="max-w-28 shrink-0 truncate text-body font-medium text-subtle sm:max-w-44" title={workspace}>{workspace}</span>
          <ChevronRight size={13} className="shrink-0 text-subtle"/>
          <h1 className="min-w-0 flex-1 truncate text-title font-semibold text-primary" title={taskGoal}>{taskGoal}</h1>
          {!managed && <IconButton label="重命名会话" onClick={() => onRename?.()}><Pencil size={13}/></IconButton>}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-caption text-subtle">
          <span className="shrink-0 truncate">{agent?.name ?? session.agentId}</span>
          {/* 完全信任是飞书 Bot 的默认姿态，用提醒色标出即可，红字留给真正的失败。 */}
          {session.permissionMode && <><span className="shrink-0">·</span><span title="本任务的权限姿态" className={`shrink-0 ${session.permissionMode === 'full-trust' ? 'text-warning' : 'text-subtle'}`}>{permissionLabels[session.permissionMode]}</span></>}
        </div>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {status.busy && !managed && <IconButton label="中断当前任务" onClick={onInterrupt}><Square size={14}/></IconButton>}
        {session.systemPrompt && <IconButton label="查看系统提示词" onClick={onOpenPrompt}><BookOpen size={14}/></IconButton>}
        {tools}
        <Button aria-label="会话分析" variant="ghost" onClick={onOpenInsight} icon={<LineChart size={14}/>}><span className="hidden lg:inline">分析</span></Button>
        <Button aria-label="原始日志" variant="ghost" tone={rawVisible ? 'inverse' : 'default'} disabled={!rawAvailable} onClick={onToggleRaw} icon={rawVisible ? <PanelRightOpen size={14}/> : <Terminal size={14}/>}><span className="hidden lg:inline">日志</span></Button>
        {!status.archived && !managed && <IconButton label="归档任务" onClick={onArchive}><Archive size={15}/></IconButton>}
      </div>
    </div>
    {/*
      状态条。圆点是这里唯一带 aria-label 的 span，状态文案在它右边的 <strong> 里——
      RunHeader.dom.test.tsx 用这两个结构做选择器，别给别的 span 加 aria-label。
      运行态圆点的配色来自 ui.tsx:stateTone，那是全站唯一的 state→色 映射，不在调用点
      另抄一份。归档与兜底这两支是 RunHeader 自己写的，与 stateTone 同用语义类。
    */}
    <div className="flex min-h-10 items-center gap-2.5 px-3 pb-2 pt-1 sm:px-5">
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-sm bg-muted px-2 py-0.5">
        <span aria-label={status.label} className={`h-2 w-2 shrink-0 rounded-full ${status.archived ? 'bg-neutral-solid' : stateTone[session.state] ?? 'bg-neutral-solid'}`}/>
        <strong className="text-caption font-semibold text-primary">{status.label}</strong>
      </span>
      <span className="min-w-0 flex-1 truncate text-caption text-secondary">{nextAction}</span>
      {status.recoverable && !managed && <Button variant="secondary" size="sm" loading={restarting} onClick={onRestart} icon={<RotateCcw size={13}/>}>重新启动</Button>}
      {queuedTasks.length > 0 && <Badge tone="queued">待执行指令 {queuedTasks.length} 条</Badge>}
      <ConnectionState status={streamStatus}/>
    </div>
    {errorSummary && <div className="px-3 pb-3 sm:px-5"><Banner tone="danger" title="失败详情">{errorSummary}</Banner></div>}
  </header>;
}
