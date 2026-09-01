import { useState } from 'react';
import { BookOpen, BrainCircuit, ChevronDown, ChevronRight, Database, FilePenLine, FlaskConical, GitBranch, Globe2, LoaderCircle, Search, Terminal, Users, Wrench } from 'lucide-react';
import type { TimelineActivityGroup, TimelineEvent } from '../timeline';
import { CodeBlock, MarkdownContent } from '../MarkdownContent';
import { elapsedMilliseconds, formatElapsed, groupToolActivityRows, toolActionLabel, toolDescription, toolPresentation, type ToolKind } from '../tool-presentation';

/*
  状态灯是本文件唯一的 `span.rounded-full`（ToolCard.dom.test.tsx:26 靠它精确定位）。
  别给其它 span 加 rounded-full，也别把这里的 LoaderCircle 换成 Spinner 原语——
  Spinner 内部就是一个 rounded-full 的 span，会让「未终结时没有终态圆点」的断言抓错元素。
*/

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
  const tone = failed ? 'text-danger' : done ? 'text-success' : 'text-info';
  // 展开区不走 ```json 包一层再喂 MarkdownContent：工具输出里可能自带三个反引号，会炸掉解析。
  const detailJson = JSON.stringify({ ...(data.input !== undefined ? { input: data.input } : {}), ...(data.output !== undefined ? { output: data.output } : {}) }, null, 2);
  return <div className="overflow-hidden">
    <button type="button" disabled={!hasDetails} onClick={() => setOpen(value => !value)} className="group/tool flex min-h-10 w-full items-center gap-2 py-1.5 text-left transition-colors hover:text-primary disabled:cursor-default">
      <span className={`grid h-5 w-5 shrink-0 place-items-center ${tone}`}><ToolKindIcon kind={presentation.kind} size={13}/></span><span className="min-w-0 flex-1 truncate text-caption text-subtle"><span className="font-medium text-secondary">{actionLabel}</span>{presentation.detail && <span title={presentation.detail} className="ml-1.5 font-mono text-subtle">{presentation.detail}</span>}</span>
      <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-caption tabular-nums text-subtle">{elapsed && <span>{elapsed}</span>}{!terminal ? <LoaderCircle size={11} className="animate-spin text-info-solid"/> : <span className={`h-1.5 w-1.5 rounded-full ${failed ? 'bg-danger-solid' : 'bg-success-solid'}`}/>}<span className={tone}>{statusLabel}</span>{hasDetails && (open ? <ChevronDown size={12}/> : <ChevronRight size={12}/>)}</span>
    </button>
    {open && hasDetails && <div className="mb-2 ml-7 border-l border-default pl-3"><CodeBlock className="language-json" code={detailJson}/></div>}
  </div>;
}

export function ToolBatch({ description, events, ongoing = false }: { description: string; events: TimelineEvent[]; ongoing?: boolean }) {
  const [open, setOpen] = useState(ongoing && events.some(event => event.data.status !== 'completed' && event.data.status !== 'failed'));
  const failedCount = events.filter(event => event.data.status === 'failed').length;
  const completedCount = events.filter(event => event.data.status === 'completed').length;
  const failed = failedCount > 0;
  const running = events.some(event => event.data.status !== 'completed' && event.data.status !== 'failed');
  const presentation = toolPresentation(events[0]!.data);
  const tone = failed ? 'text-danger' : running ? 'text-info' : 'text-success';
  const statusLabel = failed && completedCount ? '部分失败' : failed ? '失败' : running ? '执行中' : '已完成';
  return <div className="overflow-hidden">
    <button type="button" onClick={() => setOpen(value => !value)} className="flex min-h-10 w-full items-center gap-2 py-1.5 text-left transition-colors">
      <span className={`grid h-5 w-5 shrink-0 place-items-center ${tone}`}><ToolKindIcon kind={presentation.kind} size={13}/></span>
      <span title={description} className="min-w-0 flex-1 truncate text-caption font-medium text-secondary">{description}</span><span className="shrink-0 whitespace-nowrap text-caption text-subtle">{events.length} 次操作</span>
      {running ? <LoaderCircle size={11} className="shrink-0 animate-spin text-info-solid"/> : <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${failed ? 'bg-danger-solid' : 'bg-success-solid'}`}/>}<span className={`shrink-0 whitespace-nowrap text-caption ${tone}`}>{statusLabel}</span>
      {open ? <ChevronDown size={12} className="shrink-0 text-subtle"/> : <ChevronRight size={12} className="shrink-0 text-subtle"/>}
    </button>
    {open && <div className="mb-2 ml-7 border-l border-default pl-3">{events.map(event => <ToolCard key={event.id} event={event} ongoing={ongoing} preferDescription={false}/>)}</div>}
  </div>;
}

export function ActivityContent({ events, ongoing = false }: { events: TimelineEvent[]; ongoing?: boolean }) {
  const rows = groupToolActivityRows(events);
  return <div className="space-y-1">
    {rows.map(row => row.kind === 'batch' ? <ToolBatch key={row.id} description={row.description} events={row.events} ongoing={ongoing}/> : row.event.type === 'text' ? null : row.event.type === 'thinking' ? <div key={row.event.id} className="py-1.5">
      <div className="mb-1 flex items-center gap-2 text-caption font-medium text-secondary"><BrainCircuit size={13}/><span>思考过程</span></div>
      <div className="markdown pl-5 text-caption text-subtle"><MarkdownContent>{row.event.data.text ?? ''}</MarkdownContent></div>
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
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="reasoning-group group/stage border-b border-default text-body text-subtle last:border-b-0">
    <summary className="flex min-h-10 cursor-pointer select-none items-center gap-2 py-2 text-caption font-medium text-subtle outline-none transition-colors hover:text-primary focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-inset">
      <span title={group.label} className="min-w-0 flex-1 truncate text-secondary">{group.label}</span>
      {elapsed && <span className="shrink-0 whitespace-nowrap tabular-nums text-caption text-subtle">{elapsed}</span>}
      {ongoing ? <LoaderCircle size={11} className="shrink-0 animate-spin text-info-solid"/> : <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${hasFailure ? 'bg-danger-solid' : 'bg-success-solid'}`}/>}<span className={`shrink-0 whitespace-nowrap text-caption ${ongoing ? 'text-info' : hasFailure ? 'text-danger' : 'text-success'}`}>{ongoing ? '执行中' : hasFailure ? '部分失败' : '已完成'}</span>
      <ChevronRight size={13} className="shrink-0 text-subtle transition-transform group-open/stage:rotate-90"/>
    </summary>
    <div className="pb-3 pl-5">
      {countLabel && <div className="mb-1 flex items-center gap-2 text-caption font-medium text-subtle"><Wrench size={14}/><span>{countLabel}</span></div>}
      <ActivityContent events={group.events} ongoing={ongoing}/>
    </div>
  </details>;
}
