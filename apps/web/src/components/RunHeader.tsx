import { Archive, BookOpen, ChevronRight, Folder, Menu, PanelRightOpen, Square, Terminal } from 'lucide-react';
import type { Agent, Session, Task } from '../api';
import type { StreamStatus } from '../sse';
import { nextActionForState, shortRunId, workspaceName } from '../workspace-model';
import { busyStates, IconButton, stateLabels, stateTone } from './ui';

const permissionLabels = {
  ask: '交互确认',
  'approve-reads': '自动读取',
  'deny-all': '全部拒绝',
  'full-trust': '完全信任'
} as const;

function ConnectionState({ status }: { status: StreamStatus }) {
  const label = status === 'open' ? '实时同步' : status === 'reconnecting' ? '正在重连' : '正在连接';
  return <span title={label} className="inline-flex items-center gap-1.5 text-[10px] text-slate-500"><span className={`h-1.5 w-1.5 rounded-full ${status === 'open' ? 'bg-teal-500' : status === 'reconnecting' ? 'ui-status-pulse bg-amber-500' : 'bg-slate-300'}`}/><span className="hidden sm:inline">{label}</span></span>;
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
  const taskGoal = taskPrompt?.trim() || '任务运行';
  const busy = busyStates.has(session.state);
  const recoverable = session.state === 'failed' || session.state === 'stopped';
  return <header className="shrink-0 border-b border-slate-200 bg-white/95 backdrop-blur">
    <div className="flex min-h-14 items-center px-3 sm:px-5">
      <span className="mr-1 md:hidden"><IconButton label="打开工作台导航" onClick={onOpenSidebar}><Menu size={17}/></IconButton></span>
      <div className="min-w-0 flex-1"><div className="flex min-w-0 items-center gap-1.5 text-[12px]"><span className="max-w-28 shrink-0 truncate font-semibold text-slate-900 sm:max-w-44" title={workspace}>{workspace}</span><ChevronRight size={12} className="shrink-0 text-slate-300"/><h1 className="min-w-0 flex-1 truncate font-semibold text-slate-700" title={taskGoal}>{taskGoal}</h1><span className="hidden shrink-0 font-mono text-[9px] tracking-[.08em] text-slate-400 sm:inline">{shortRunId(session)}</span></div><div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-slate-400"><Folder size={10}/><span title={session.cwd} className="truncate">{session.cwd}</span><span className="shrink-0">·</span><span className="shrink-0">{agent?.name ?? session.agentId}</span>{session.permissionMode && <><span className="shrink-0">·</span><span title="本次运行的权限姿态" className={`shrink-0 font-medium ${session.permissionMode === 'full-trust' ? 'text-rose-600' : 'text-slate-500'}`}>{permissionLabels[session.permissionMode]}</span></>}</div></div>
      <div className="ml-3 flex shrink-0 items-center gap-0.5">{!session.archivedAt && busy && <IconButton label="中断当前任务" onClick={onInterrupt}><Square size={14}/></IconButton>}{session.systemPrompt && <IconButton label="查看系统提示词" onClick={onOpenPrompt}><BookOpen size={14}/></IconButton>}{!session.archivedAt && <IconButton label="归档任务运行" onClick={onArchive}><Archive size={15}/></IconButton>}<button type="button" disabled={!rawAvailable} onClick={onToggleRaw} aria-label="原始日志" className={`ml-1 flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-35 ${rawVisible ? 'border-slate-800 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'}`}>{rawVisible ? <PanelRightOpen size={13}/> : <Terminal size={13}/>}<span className="hidden sm:inline">日志</span></button></div>
    </div>
    <div className="flex min-h-10 items-center gap-2 border-t border-slate-100 bg-slate-50/75 px-4 sm:px-5"><span aria-label={stateLabels[session.state]} className={`h-2 w-2 shrink-0 rounded-full ${busy ? 'ui-status-pulse' : ''} ${stateTone[session.state] ?? 'bg-slate-400'}`}/><strong className="shrink-0 text-[11px] font-semibold text-slate-700">{stateLabels[session.state] ?? session.state}</strong><span className="hidden text-[11px] text-slate-300 sm:inline">/</span><span className="min-w-0 flex-1 truncate text-[11px] text-slate-500">{nextActionForState(session.state)}</span>{recoverable && <button type="button" disabled={restarting} onClick={onRestart} className="shrink-0 rounded-lg bg-rose-600 px-2.5 py-1 text-[10px] font-semibold text-white hover:bg-rose-500 disabled:opacity-50">{restarting ? '恢复中…' : '重新启动'}</button>}{queuedTasks.length > 0 && <span className="shrink-0 rounded-full bg-indigo-50 px-2 py-1 text-[9px] font-semibold text-indigo-700">{queuedTasks.length} 条待执行</span>}<ConnectionState status={streamStatus}/></div>
  </header>;
}
