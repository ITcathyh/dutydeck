import { Activity, Archive, ArrowLeft, BookOpen, ChevronRight, FileDiff, LineChart, MessageSquare, MoreHorizontal, PanelRightOpen, Pencil, RotateCcw, Square, Terminal } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Agent, RunSummary, Session, SessionUsage, Task } from '../api';
import type { SessionSyncState } from '../useSessionStream';
import { sessionDisplayName } from '../run-summary';
import { sessionErrorSummary, sessionWorkspaceName } from '../workspace-model';
import { Badge, Banner, Button, IconButton, Tabs } from './primitives';
import { MenuButton, type MenuEntry } from './MenuButton';
import { effectiveStatus, stateTone } from './ui';
import { count, usd } from './usageFormat';
import { elapsedMilliseconds, formatElapsed } from '../tool-presentation';
import type { TimelineDensity } from '../view-preferences';

export function connectionLabel(status: SessionSyncState) {
  if (status.transport !== 'open') return status.transport === 'reconnecting' ? '正在重连' : '正在连接';
  return status.content === 'ready' ? '实时同步' : status.content === 'failed' ? status.retrying ? '记录同步失败，正在重试' : '记录同步失败' : '已连接，正在补齐记录';
}
function ConnectionState({ status }: { status: SessionSyncState }) {
  const label = connectionLabel(status);
  const ready = status.transport === 'open' && status.content === 'ready';
  const calibrated = status.lastCalibratedAt ? `；最近校准 ${new Date(status.lastCalibratedAt).toLocaleTimeString()}` : '';
  return <span title={label + calibrated} className="inline-flex shrink-0 items-center gap-1.5 text-meta text-subtle"><span className={`h-1.5 w-1.5 rounded-full ${ready ? 'bg-neutral-solid' : 'ui-status-pulse bg-warning-solid'}`}/><span className="hidden sm:inline">{label}</span>{status.content === 'failed' && !status.retrying && <button className="text-info" onClick={status.retry}>重试同步</button>}</span>;
}

export type RunDetailTab = 'timeline' | 'changes' | 'terminal';

export function RunDetailTabs({ value, onChange, terminalAvailable = true, changesCount }: { value: RunDetailTab; onChange(value: RunDetailTab): void; terminalAvailable?: boolean; changesCount?: number }) {
  return <Tabs value={value} onChange={onChange} label="任务内容" items={[
    { id: 'timeline', label: '对话', icon: <MessageSquare size={13}/> },
    { id: 'changes', label: '改动', icon: <FileDiff size={13}/>, badge: changesCount !== undefined && changesCount > 0 ? <span className="ml-1 rounded-full bg-muted px-1.5 py-0.2 text-meta tabular-nums text-secondary">{changesCount}</span> : undefined },
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
  const tokens = (key: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens') => count(own[key] + subSteps[key]);
  return { text: `本任务${unknown ? '已知费用' : '累计'} ${usd(own.costUsd + subSteps.costUsd)}${extra ? `（${extra}）` : ''}`, detail: `输入 ${tokens('inputTokens')} · 输出 ${tokens('outputTokens')} · 缓存读 ${tokens('cacheReadTokens')} · 缓存写 ${tokens('cacheWriteTokens')} token` };
}

export function RunHeader({
  session,
  summary,
  agent,
  taskPrompt,
  streamStatus,
  queuedTasks,
  tools,
  rawVisible,
  rawAvailable,
  restarting,
  onInterrupt,
  onRestart,
  onOpenPrompt,
  onArchive,
  onToggleRaw,
  onRename,
  onOpenInsight,
  onOpenTrace,
  onBack,
  backLabel = '返回任务',
  inspectorOpen,
  onToggleInspector,
  detailTab,
  onDetailTabChange,
  terminalAvailable = true,
  density,
  onDensityChange,
  changesCount,
  elapsedText,
  startedAt
}: {
  session: Session;
  summary?: RunSummary;
  agent?: Agent;
  taskPrompt?: string;
  streamStatus: SessionSyncState;
  queuedTasks: Task[];
  usage?: SessionUsage;
  /** 目标等面板入口，排在「更多操作」前面。 */
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
  onOpenTrace?(): void;
  onBack?(): void;
  backLabel?: string;
  inspectorOpen?: boolean;
  onToggleInspector?(): void;
  detailTab?: RunDetailTab;
  onDetailTabChange?(value: RunDetailTab): void;
  terminalAvailable?: boolean;
  density?: TimelineDensity;
  onDensityChange?(value: TimelineDensity): void;
  changesCount?: number;
  elapsedText?: string;
  startedAt?: string;
}) {
  const managed = session.source === 'work_item';
  const workspace = sessionWorkspaceName(session);
  const taskGoal = sessionDisplayName(session, taskPrompt, '未命名任务');
  // 状态文案、是否呼吸、能否重新启动全部来自同一个判断，见 ui.tsx:effectiveStatus。
  // 归档任务显示「已归档」，仅在执行中且有当前轮开始时间时计算并刷新耗时。
  const status = effectiveStatus(session, summary);
  const isAttention = status.label === '等你审批' || status.label === '等你回答' || status.label === '等你核对';
  const dotClass = status.archived
    ? 'bg-neutral-solid'
    : isAttention
    ? 'bg-attention-solid'
    : status.label === '执行中'
    ? 'bg-info-solid'
    : stateTone[session.state] ?? 'bg-neutral-solid';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!status.busy || !startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status.busy, startedAt]);

  const elapsed = useMemo(() => {
    if (!status.busy) return undefined;
    if (elapsedText) return elapsedText;
    if (!startedAt) return undefined;
    const start = Date.parse(startedAt);
    if (!Number.isFinite(start)) return undefined;
    const ms = Math.max(0, now - start);
    return formatElapsed(ms);
  }, [status.busy, elapsedText, startedAt, now]);
  const errorSummary = sessionErrorSummary(session.error);
  const menu: MenuEntry[] = [
    ...(!managed ? [{ id: 'rename', label: '重命名会话', icon: <Pencil size={14}/>, onSelect: () => onRename?.() }] : []),
    ...(session.systemPrompt ? [{ id: 'prompt', label: '查看系统提示词', icon: <BookOpen size={14}/>, onSelect: onOpenPrompt }] : []),
    { id: 'insight', label: '会话分析', icon: <LineChart size={14}/>, onSelect: onOpenInsight },
    ...(onOpenTrace ? [{ id: 'trace', label: '会话追踪', icon: <Activity size={14}/>, onSelect: onOpenTrace }] : []),
    { id: 'raw', label: '原始日志', icon: <Terminal size={14}/>, checked: rawVisible, disabled: !rawAvailable, onSelect: onToggleRaw },
    ...(!status.archived && !managed ? [{ id: 'archive-separator', separator: true as const }, { id: 'archive', label: '归档任务', icon: <Archive size={14}/>, tone: 'danger' as const, onSelect: onArchive }] : [])
  ];

  return <header className="shrink-0 border-b border-default bg-canvas">
    {/* 第一行：返回、标题、状态（含用时）、中断、结果检视等 */}
    <div className="ui-thread flex min-h-12 items-center gap-2 pt-1">
      {onBack && <IconButton label={backLabel} onClick={onBack}><ArrowLeft size={16}/></IconButton>}
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="max-w-24 shrink-0 truncate text-body text-subtle sm:max-w-44" title={workspace}>{workspace}</span>
        <ChevronRight aria-hidden="true" size={13} className="shrink-0 text-subtle"/>
        <h1 className="min-w-0 truncate text-title font-semibold tracking-tight text-primary" title={taskGoal}>{taskGoal}</h1>
        {/*
          状态胶囊。圆点是这里唯一带 aria-label 的 span，状态文案在它右边的 <strong> 里——
          RunHeader.dom.test.tsx 用这两个结构做选择器，保持无障碍和测试一致。
        */}
        <span className="ml-1 inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted py-0.5 pl-2 pr-2.5">
          <span aria-label={status.label} className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`}/>
          <strong className="text-caption font-semibold text-primary">{status.label}</strong>
          {status.busy && elapsed && <span className="text-caption text-subtle tabular-nums">{elapsed}</span>}
        </span>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {status.busy && !managed && <Button variant="secondary" size="sm" aria-label="中断当前任务" onClick={onInterrupt} icon={<Square size={13}/>}>中断</Button>}
        {tools}
        <MenuButton label="更多操作" icon={<MoreHorizontal size={16}/>} items={menu}/>
        {onToggleInspector && <Button variant={inspectorOpen ? 'secondary' : 'ghost'} size="sm" aria-label="结果检视" aria-pressed={inspectorOpen} data-result-inspector-trigger icon={<PanelRightOpen size={14}/>} onClick={onToggleInspector}>结果检视</Button>}
      </div>
    </div>

    {/* 第二行：对话 / 改动 / 终端 tabs 与信息密度选择器 */}
    <div className="ui-thread flex min-h-10 min-w-0 items-center gap-3 pb-1 text-caption text-subtle">
      {detailTab && onDetailTabChange ? <div className="min-w-0 flex-1 sm:flex-initial">
        <RunDetailTabs value={detailTab} onChange={onDetailTabChange} terminalAvailable={terminalAvailable} changesCount={changesCount}/>
      </div> : <div className="min-w-0 flex-1"/>}
      {density && onDensityChange && (
        <div role="group" aria-label="信息密度" className="inline-flex items-center rounded-md border border-subtle bg-muted p-0.5 text-caption">
          {(['summary', 'standard', 'detail'] as const).map(d => (
            <button
              key={d}
              type="button"
              aria-pressed={density === d}
              onClick={() => onDensityChange(d)}
              className={`rounded px-2 py-0.5 font-medium transition-colors ${density === d ? 'bg-surface text-primary shadow-sm' : 'text-subtle hover:text-secondary'}`}
            >
              {d === 'summary' ? '摘要' : d === 'standard' ? '标准' : '详细'}
            </button>
          ))}
        </div>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {status.recoverable && !managed && <Button variant="secondary" size="sm" loading={restarting} onClick={onRestart} icon={<RotateCcw size={13}/>}>重新启动</Button>}
        {queuedTasks.length > 0 && <Badge tone="queued">待执行指令 {queuedTasks.length} 条</Badge>}
        <ConnectionState status={streamStatus}/>
      </div>
    </div>
    {errorSummary && <div className="ui-thread pb-3"><Banner tone="danger" title="失败详情">{errorSummary}</Banner></div>}
  </header>;
}
