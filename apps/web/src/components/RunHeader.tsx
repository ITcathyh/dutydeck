import { Archive, BookOpen, ChevronRight, Folder, Menu, PanelRightOpen, Square, Terminal } from 'lucide-react';
import type { Agent, Session, Task } from '../api';
import type { StreamStatus } from '../sse';
import { nextActionForState, shortRunId, workspaceName } from '../workspace-model';
import { effectiveStatus, IconButton, permissionLabels, stateTone } from './ui';

function ConnectionState({ status }: { status: StreamStatus }) {
  const label = status === 'open' ? '实时同步' : status === 'reconnecting' ? '正在重连' : '正在连接';
  return <span title={label} className="inline-flex items-center gap-1.5 text-[10px] text-[var(--text-muted)]"><span className={`h-1.5 w-1.5 rounded-full ${status === 'open' ? 'bg-[var(--action-primary)]' : status === 'reconnecting' ? 'ui-status-pulse bg-[var(--status-warning-solid)]' : 'bg-[var(--border-strong)]'}`}/><span className="hidden sm:inline">{label}</span></span>;
}

export function RunHeader({ session, agent, taskPrompt, streamStatus, queuedTasks, rawVisible, rawAvailable, restarting, onOpenSidebar, onInterrupt, onRestart, onOpenPrompt, onArchive, onToggleRaw }: {
  session: Session;
  agent?: Agent;
  taskPrompt?: string;
  streamStatus: StreamStatus;
  queuedTasks: Task[];
  rawVisible: boolean;
  rawAvailable: boolean;
  restarting: boolean;
  onOpenSidebar(): void;
  onInterrupt(): void;
  onRestart(): void;
  onOpenPrompt(): void;
  onArchive(): void;
  onToggleRaw(): void;
}) {
  const workspace = workspaceName(session.cwd);
  const taskGoal = taskPrompt?.trim() || '未命名任务';
  // 状态文案、是否呼吸、能否重新启动全部来自同一个判断，见 ui.tsx:effectiveStatus。
  // 这里曾经四处直接读 session.state，归档任务因此显示「思考中」+ 呼吸动画，
  // 并且给出可点击的「重新启动」按钮——归档是只读，那是功能缺陷。
  const status = effectiveStatus(session);
  // nextActionForState 的入参只有 state，拿不到 archivedAt，改签名会波及
  // workspace-model 里 attentionReasonForSession 等调用点；归档分支放在这里。
  const nextAction = status.archived ? '已归档任务只读；可查看历史记录，不能再下指令' : nextActionForState(session.state);
  return <header className="shrink-0 border-b border-[var(--border-default)] bg-[var(--surface-default)] backdrop-blur">
    <div className="flex min-h-14 items-center px-3 sm:px-5">
      <span className="mr-1 md:hidden"><IconButton label="打开工作台导航" onClick={onOpenSidebar}><Menu size={17}/></IconButton></span>
      <div className="min-w-0 flex-1"><div className="flex min-w-0 items-center gap-1.5 text-[12px]"><span className="max-w-28 shrink-0 truncate font-semibold text-[var(--text-primary)] sm:max-w-44" title={workspace}>{workspace}</span><ChevronRight size={12} className="shrink-0 text-[var(--border-strong)]"/><h1 className="min-w-0 flex-1 truncate font-semibold text-[var(--text-secondary)]" title={taskGoal}>{taskGoal}</h1><span className="hidden shrink-0 font-mono text-[9px] tracking-[.08em] text-[var(--text-muted)] sm:inline">{shortRunId(session)}</span></div><div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-[var(--text-muted)]"><Folder size={10}/><span title={session.cwd} className="truncate">{session.cwd}</span><span className="shrink-0">·</span><span className="shrink-0">{agent?.name ?? session.agentId}</span>{session.permissionMode && <><span className="shrink-0">·</span><span title="本任务的权限姿态" className={`shrink-0 font-medium ${session.permissionMode === 'full-trust' ? 'text-[var(--status-danger)]' : 'text-[var(--text-muted)]'}`}>{permissionLabels[session.permissionMode]}</span></>}</div></div>
      <div className="ml-3 flex shrink-0 items-center gap-0.5">{status.busy && <IconButton label="中断当前任务" onClick={onInterrupt}><Square size={14}/></IconButton>}{session.systemPrompt && <IconButton label="查看系统提示词" onClick={onOpenPrompt}><BookOpen size={14}/></IconButton>}{!status.archived && <IconButton label="归档任务" onClick={onArchive}><Archive size={15}/></IconButton>}<button type="button" disabled={!rawAvailable} onClick={onToggleRaw} aria-label="原始日志" className={`ml-1 flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-35 ${rawVisible ? 'border-[var(--surface-inverse)] bg-[var(--surface-inverse)] text-[var(--text-inverse)]' : 'border-[var(--border-default)] bg-[var(--surface-default)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]'}`}>{rawVisible ? <PanelRightOpen size={13}/> : <Terminal size={13}/>}<span className="hidden sm:inline">日志</span></button></div>
    </div>
    <div className="flex min-h-10 items-center gap-2 border-t border-[var(--border-subtle)] bg-[var(--surface-muted)] px-4 sm:px-5"><span aria-label={status.label} className={`h-2 w-2 shrink-0 rounded-full ${status.busy ? 'ui-status-pulse' : ''} ${status.archived ? 'bg-[var(--status-neutral-solid)]' : stateTone[session.state] ?? 'bg-[var(--status-neutral-solid)]'}`}/><strong className="shrink-0 text-[11px] font-semibold text-[var(--text-secondary)]">{status.label}</strong><span className="hidden text-[11px] text-[var(--border-strong)] sm:inline">/</span><span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-muted)]">{nextAction}</span>{status.recoverable && <button type="button" disabled={restarting} onClick={onRestart} className="shrink-0 rounded-lg bg-[var(--status-danger-solid)] px-2.5 py-1 text-[10px] font-semibold text-[var(--text-on-action)] hover:brightness-110 disabled:opacity-50">{restarting ? '恢复中…' : '重新启动'}</button>}{queuedTasks.length > 0 && <span className="shrink-0 rounded-full bg-[var(--status-queued-soft)] px-2 py-1 text-[9px] font-semibold text-[var(--status-queued)]">待执行指令 {queuedTasks.length} 条</span>}<ConnectionState status={streamStatus}/></div>
  </header>;
}
