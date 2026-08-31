import { useState } from 'react';
import { BookOpen, BrainCircuit, ChevronDown, ChevronRight, Database, FilePenLine, FlaskConical, GitBranch, Globe2, LoaderCircle, Search, Terminal, Users, Wrench } from 'lucide-react';
import type { TimelineActivityGroup, TimelineEvent } from '../timeline';
import { MarkdownContent } from '../MarkdownContent';
import { elapsedMilliseconds, formatElapsed, groupToolActivityRows, toolActionLabel, toolDescription, toolPresentation, type ToolKind } from '../tool-presentation';

export function ToolKindIcon({ kind, size = 14 }: { kind: ToolKind; size?: number }) {
  if (kind === 'read') return <BookOpen size={size}/>;
  if (kind === 'edit') return <FilePenLine size={size}/>;
  if (kind === 'search') return <Search size={size}/>;
  if (kind === 'web') return <Globe2 size={size}/>;
  if (kind === 'git') return <GitBranch size={size}/>;
  if (kind === 'test') return <FlaskConical size={size}/>;
  if (kind === 'database') return <Database size={size}/>;
  if (kind === 'agent') return <Users size={size}/>;
  if (kind === 'terminal') return <Terminal size={size}/>;
  return <Wrench size={size}/>;
}

export function ToolCard({ event, ongoing = false, preferDescription = true }: { event: TimelineEvent; ongoing?: boolean; preferDescription?: boolean }) {
  const data = event.data; const done = data.status === 'completed'; const failed = data.status === 'failed'; const terminal = done || failed;
  const [open, setOpen] = useState(ongoing && !terminal); const hasDetails = data.input !== undefined || data.output !== undefined;
  const presentation = toolPresentation(data);
  const elapsed = formatElapsed(elapsedMilliseconds(data.startedAt ?? event.timestamp, terminal ? data.completedAt ?? event.timestamp : undefined));
  const statusLabel = failed ? '失败' : done ? '已完成' : '执行中'; const actionLabel = preferDescription ? toolDescription(data) ?? toolActionLabel(presentation, terminal) : toolActionLabel(presentation, terminal);
  const tone = failed ? 'text-[var(--status-danger)]' : done ? 'text-[var(--status-success)]' : 'text-[var(--status-info)]';
  return <div className="overflow-hidden">
    <button type="button" disabled={!hasDetails} onClick={() => setOpen(value => !value)} className="group/tool flex min-h-9 w-full items-center gap-2 py-1.5 text-left transition-colors hover:text-[var(--text-primary)] disabled:cursor-default">
      <span className={`grid h-5 w-5 shrink-0 place-items-center ${tone}`}><ToolKindIcon kind={presentation.kind} size={13}/></span><span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-muted)]"><span className="font-medium text-[var(--text-secondary)]">{actionLabel}</span>{presentation.detail && <span title={presentation.detail} className="ml-1.5 font-mono text-[var(--text-muted)]">{presentation.detail}</span>}</span>
      <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[10px] tabular-nums text-[var(--text-muted)]">{elapsed && <span>{elapsed}</span>}{!terminal ? <LoaderCircle size={11} className="animate-spin text-[var(--status-info-solid)]"/> : <span className={`h-1.5 w-1.5 rounded-full ${failed ? 'bg-[var(--status-danger-solid)]' : 'bg-[var(--status-success-solid)]'}`}/>}<span className={tone}>{statusLabel}</span>{hasDetails && (open ? <ChevronDown size={12}/> : <ChevronRight size={12}/>)}</span>
    </button>
    {open && hasDetails && <div className="mb-2 ml-7 border-l border-[var(--border-default)] pl-3"><pre className="m-0 max-h-72 overflow-auto whitespace-pre-wrap border-0 bg-transparent py-1 text-[10px] leading-5 text-[var(--text-muted)]">{JSON.stringify({ ...(data.input !== undefined ? { input: data.input } : {}), ...(data.output !== undefined ? { output: data.output } : {}) }, null, 2)}</pre></div>}
  </div>;
}

export function ToolBatch({ description, events, ongoing = false }: { description: string; events: TimelineEvent[]; ongoing?: boolean }) {
  const [open, setOpen] = useState(ongoing && events.some(event => event.data.status !== 'completed' && event.data.status !== 'failed'));
  const failedCount = events.filter(event => event.data.status === 'failed').length;
  const completedCount = events.filter(event => event.data.status === 'completed').length;
  const failed = failedCount > 0;
  const running = events.some(event => event.data.status !== 'completed' && event.data.status !== 'failed');
  const presentation = toolPresentation(events[0]!.data);
  const tone = failed ? 'text-[var(--status-danger)]' : running ? 'text-[var(--status-info)]' : 'text-[var(--status-success)]';
  const statusLabel = failed && completedCount ? '部分失败' : failed ? '失败' : running ? '执行中' : '已完成';
  return <div className="overflow-hidden">
    <button type="button" onClick={() => setOpen(value => !value)} className="flex min-h-9 w-full items-center gap-2 py-1.5 text-left transition-colors">
      <span className={`grid h-5 w-5 shrink-0 place-items-center ${tone}`}><ToolKindIcon kind={presentation.kind} size={13}/></span>
      <span title={description} className="min-w-0 flex-1 truncate text-[11px] font-medium text-[var(--text-secondary)]">{description}</span><span className="shrink-0 whitespace-nowrap text-[10px] text-[var(--text-muted)]">{events.length} 次操作</span>
      {running ? <LoaderCircle size={11} className="shrink-0 animate-spin text-[var(--status-info-solid)]"/> : <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${failed ? 'bg-[var(--status-danger-solid)]' : 'bg-[var(--status-success-solid)]'}`}/>}<span className={`shrink-0 whitespace-nowrap text-[10px] ${tone}`}>{statusLabel}</span>
      {open ? <ChevronDown size={12} className="shrink-0 text-[var(--text-muted)]"/> : <ChevronRight size={12} className="shrink-0 text-[var(--text-muted)]"/>}
    </button>
    {open && <div className="mb-2 ml-7 border-l border-[var(--border-default)] pl-3">{events.map(event => <ToolCard key={event.id} event={event} ongoing={ongoing} preferDescription={false}/>)}</div>}
  </div>;
}

export function ActivityContent({ events, ongoing = false }: { events: TimelineEvent[]; ongoing?: boolean }) {
  const rows = groupToolActivityRows(events);
  return <div className="space-y-1">
    {rows.map(row => row.kind === 'batch' ? <ToolBatch key={row.id} description={row.description} events={row.events} ongoing={ongoing}/> : row.event.type === 'text' ? null : row.event.type === 'thinking' ? <div key={row.event.id} className="py-1.5">
      <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-[var(--text-secondary)]"><BrainCircuit size={13}/><span>思考过程</span></div>
      <div className="markdown pl-5 text-[12px] leading-5 text-[var(--text-muted)]"><MarkdownContent>{row.event.data.text ?? ''}</MarkdownContent></div>
    </div> : <ToolCard key={row.event.id} event={row.event} ongoing={ongoing}/>) }
  </div>;
}

export function ActivityGroupPanel({ group, ongoing = false }: { group: TimelineActivityGroup; ongoing?: boolean }) {
  const [open, setOpen] = useState(ongoing);
  const toolCount = group.events.filter(event => event.type === 'tool_call' || event.type === 'tool_result').length;
  const thinkingCount = group.events.filter(event => event.type === 'thinking').length;
  const countLabel = [thinkingCount ? `${thinkingCount} 段思考` : '', toolCount ? `${toolCount} 次工具调用` : ''].filter(Boolean).join(' · ');
  const elapsed = formatElapsed(elapsedMilliseconds(group.startedAt, ongoing ? undefined : group.completedAt));
  const hasFailure = group.events.some(event => (event.type === 'tool_call' || event.type === 'tool_result') && event.data.status === 'failed');
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="reasoning-group group/stage border-b border-[var(--border-default)] text-sm text-[var(--text-muted)] last:border-b-0">
    <summary className="flex min-h-10 cursor-pointer select-none items-center gap-2 py-2 text-[12px] font-medium text-[var(--text-muted)] outline-none transition-colors hover:text-[var(--text-primary)] focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-[var(--border-default)] focus-visible:ring-inset">
      <span title={group.label} className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{group.label}</span>
      {elapsed && <span className="shrink-0 whitespace-nowrap tabular-nums text-[10px] text-[var(--text-muted)]">{elapsed}</span>}
      {ongoing ? <LoaderCircle size={11} className="shrink-0 animate-spin text-[var(--status-info-solid)]"/> : <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${hasFailure ? 'bg-[var(--status-danger-solid)]' : 'bg-[var(--status-success-solid)]'}`}/>}<span className={`shrink-0 whitespace-nowrap text-[10px] ${ongoing ? 'text-[var(--status-info)]' : hasFailure ? 'text-[var(--status-danger)]' : 'text-[var(--status-success)]'}`}>{ongoing ? '执行中' : hasFailure ? '部分失败' : '已完成'}</span>
      <ChevronRight size={13} className="shrink-0 text-[var(--text-muted)] transition-transform group-open/stage:rotate-90"/>
    </summary>
    <div className="pb-3 pl-5">
      {countLabel && <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-[var(--text-muted)]"><Wrench size={14}/><span>{countLabel}</span></div>}
      <ActivityContent events={group.events} ongoing={ongoing}/>
    </div>
  </details>;
}
