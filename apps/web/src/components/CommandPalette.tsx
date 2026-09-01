import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { CornerDownLeft, Search } from 'lucide-react';
import type { Agent, RunSummary, Session } from '../api';
import { fallbackRunTitle } from '../run-summary';
import { searchTasks, taskSearchTerms, type TaskSearchField, type TaskSearchMatch } from '../task-search';
import { useDialogFocus } from '../useDialogFocus';
import { attentionReasonForSession, formatRelativeTime, shortRunId, workbenchTaskSection, workspaceName } from '../workspace-model';
import { effectiveStatus, stateBadgeStyle } from './ui';

export type CommandAction = {
  id: string;
  label: string;
  hint?: string;
  group: string;
  keywords?: string;
  shortcut?: string;
  disabled?: boolean;
  disabledReason?: string;
  run(): void;
};

export type CommandPaletteProps = {
  open: boolean;
  onClose(): void;
  sessions: Session[];
  summaries: Record<string, RunSummary>;
  agents: Agent[];
  actions: CommandAction[];
  onSelectSession(id: string): void;
};

type PaletteItem =
  | { kind: 'action'; key: string; index: number; action: CommandAction }
  | { kind: 'task'; key: string; index: number; match: TaskSearchMatch };
type PaletteSection = { id: string; title: string; hint?: string; items: PaletteItem[] };

// 空查询时的「最近更新」预览条数。有明确标题和说明，输入关键词后即展示全部匹配，不做无出口截断。
const recentPreviewLimit = 5;
const fieldLabels: Record<TaskSearchField, string> = { goal: '任务目标', workspace: '工作区', agent: 'Agent' };

/** 命令按 label + keywords 做同一套 AND 子串匹配，中文不分词，与任务检索保持一致的手感。 */
function matchAction(action: CommandAction, terms: string[]): boolean {
  if (!terms.length) return true;
  const haystack = `${action.label} ${action.keywords ?? ''}`.normalize('NFKC').toLowerCase();
  return terms.every(term => haystack.includes(term));
}

export function CommandPalette({ open, onClose, sessions, summaries, agents, actions, onSelectSession }: CommandPaletteProps) {
  const dialogRef = useDialogFocus(open);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const baseId = `command-palette-${useId()}`;
  const listboxId = `${baseId}-listbox`;
  const hintId = `${baseId}-hint`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const { sections, items, taskCount, actionCount, searching } = useMemo(() => {
    const terms = taskSearchTerms(query);
    const visibleActions = actions.filter(action => matchAction(action, terms));
    const matches = terms.length
      ? searchTasks({ sessions, summaries, agents, query })
      : [...sessions]
        .filter(session => !session.archivedAt)
        .sort((left, right) => (right.updatedAt || right.createdAt || '').localeCompare(left.updatedAt || left.createdAt || ''))
        .slice(0, recentPreviewLimit)
        .map(session => ({ session, score: 0, fields: [] as TaskSearchField[] }));
    const built: PaletteSection[] = [];
    let index = 0;
    for (const group of [...new Set(visibleActions.map(action => action.group))]) {
      built.push({ id: `group-${group}`, title: group, items: visibleActions.filter(action => action.group === group).map(action => ({ kind: 'action', key: `action-${action.id}`, index: index++, action })) });
    }
    if (matches.length) built.push({
      id: 'tasks',
      title: terms.length ? '匹配的任务' : '最近更新的任务',
      hint: terms.length ? `全部 ${matches.length} 条匹配都在下面，没有截断` : `按更新时间取前 ${matches.length} 个未归档任务；输入关键词可检索全部 ${sessions.length} 个任务`,
      items: matches.map(match => ({ kind: 'task', key: `task-${match.session.id}`, index: index++, match }))
    });
    return { sections: built, items: built.flatMap(section => section.items), taskCount: matches.length, actionCount: visibleActions.length, searching: terms.length > 0 };
  }, [actions, agents, query, sessions, summaries]);

  const enabled = (index: number) => { const item = items[index]; return Boolean(item) && !(item.kind === 'action' && item.action.disabled); };
  const firstEnabled = () => { for (let index = 0; index < items.length; index += 1) if (enabled(index)) return index; return -1; };

  useEffect(() => { if (open) { setQuery(''); setActiveIndex(0); } }, [open]);
  // 列表变化后把高亮落到第一个可用项；全部禁用时用 -1 表示「当前没有可执行项」。
  useEffect(() => { setActiveIndex(previous => (enabled(previous) ? previous : firstEnabled())); }, [items]);
  useEffect(() => { if (open) optionRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' }); }, [activeIndex, open]);

  if (!open) return null;

  // 沿 DOM 顺序循环查找下一个可用项；全部禁用时保持原样，不把高亮落到不能执行的行上。
  const move = (target: number, step: number) => {
    if (!items.length) return;
    const size = items.length;
    for (let offset = 0; offset < size; offset += 1) {
      const next = (((target + step * offset) % size) + size) % size;
      if (enabled(next)) { setActiveIndex(next); return; }
    }
  };
  const runItem = (index: number) => {
    const item = items[index];
    if (!item) return;
    if (item.kind === 'task') { onSelectSession(item.match.session.id); onClose(); return; }
    if (item.action.disabled) return;
    item.action.run();
    onClose();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); move(activeIndex + 1, 1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); move(activeIndex - 1, -1); return; }
    if (event.key === 'Home') { event.preventDefault(); move(0, 1); return; }
    if (event.key === 'End') { event.preventDefault(); move(items.length - 1, -1); return; }
    if (event.key === 'Enter') { event.preventDefault(); runItem(activeIndex); }
  };

  const summaryText = searching
    ? `找到 ${taskCount} 个任务、${actionCount} 个命令`
    : `${actionCount} 个命令，${taskCount} 个最近任务`;

  return <div className="ui-overlay fixed inset-0 z-50 flex items-start justify-center bg-[var(--overlay-scrim)] p-4 pt-[9vh] backdrop-blur-[3px]" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="搜索任务与命令" onKeyDown={onKeyDown} className="ui-dialog flex max-h-[76dvh] w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-[var(--border-default)] bg-[var(--surface-default)] shadow-[var(--shadow-dialog)]">
      <div className="flex items-center gap-2.5 border-b border-[var(--border-subtle)] px-4 py-3">
        <Search aria-hidden="true" size={17} className="shrink-0 text-[var(--text-muted)]"/>
        <input
          data-dialog-initial-focus
          autoFocus
          type="text"
          role="combobox"
          aria-label="搜索任务与命令"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-describedby={hintId}
          aria-autocomplete="list"
          aria-activedescendant={items[activeIndex] ? optionId(activeIndex) : undefined}
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="搜索任务目标、工作区或 Agent，也可执行命令"
          className="min-w-0 flex-1 bg-transparent text-[14px] leading-6 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
        />
        <kbd className="hidden shrink-0 rounded border border-[var(--border-default)] bg-[var(--surface-muted)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-muted)] sm:inline">Esc</kbd>
      </div>
      <p id={hintId} role="status" aria-live="polite" className="border-b border-[var(--border-subtle)] bg-[var(--surface-muted)] px-4 py-1.5 text-[11px] leading-5 text-[var(--text-secondary)]">{summaryText}</p>
      <div id={listboxId} role="listbox" aria-label="搜索结果" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        {items.length === 0
          ? <p className="ui-empty-state px-3 py-8 text-center text-[13px] leading-6 text-[var(--text-secondary)]">{searching ? '没有匹配的任务或命令。换个关键词，或按 Esc 关闭。' : '还没有任务，也没有可执行的命令。先创建一个任务，再回到这里检索。'}</p>
          : sections.map(section => <div key={section.id} role="group" aria-labelledby={`${baseId}-${section.id}`} className="mb-1.5 last:mb-0">
            <div className="flex items-baseline gap-2 px-2 pb-1 pt-1.5"><h2 id={`${baseId}-${section.id}`} className="text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--text-muted)]">{section.title}</h2>{section.hint && <span className="min-w-0 flex-1 truncate text-[11px] leading-5 text-[var(--text-muted)]">{section.hint}</span>}</div>
            {section.items.map(item => item.kind === 'action'
              ? <button
                key={item.key}
                ref={node => { optionRefs.current[item.index] = node; }}
                type="button"
                role="option"
                id={optionId(item.index)}
                tabIndex={-1}
                aria-selected={item.index === activeIndex}
                aria-disabled={item.action.disabled ? true : undefined}
                disabled={item.action.disabled}
                onMouseMove={() => { if (!item.action.disabled) setActiveIndex(item.index); }}
                onClick={() => runItem(item.index)}
                className={`flex min-h-10 w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left ${item.action.disabled ? 'cursor-not-allowed opacity-60' : item.index === activeIndex ? 'bg-[var(--action-soft)]' : 'hover:bg-[var(--surface-hover)]'}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-[var(--text-primary)]">{item.action.label}</span>
                  {(item.action.disabled ? item.action.disabledReason : item.action.hint) && <span className={`mt-0.5 block truncate text-[11px] leading-4 ${item.action.disabled ? 'text-[var(--status-warning)]' : 'text-[var(--text-secondary)]'}`}>{item.action.disabled ? item.action.disabledReason : item.action.hint}</span>}
                </span>
                {item.action.shortcut && <kbd className="shrink-0 rounded border border-[var(--border-default)] bg-[var(--surface-muted)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-muted)]">{item.action.shortcut}</kbd>}
                {item.index === activeIndex && !item.action.disabled && <CornerDownLeft aria-hidden="true" size={13} className="shrink-0 text-[var(--action-primary)]"/>}
              </button>
              : <TaskOption
                key={item.key}
                optionRef={node => { optionRefs.current[item.index] = node; }}
                match={item.match}
                summary={summaries[item.match.session.id]}
                agent={agents.find(agent => agent.id === item.match.session.agentId)}
                optionId={optionId(item.index)}
                active={item.index === activeIndex}
                onHover={() => setActiveIndex(item.index)}
                onRun={() => runItem(item.index)}
              />)}
          </div>)}
      </div>
      <p className="border-t border-[var(--border-subtle)] bg-[var(--surface-muted)] px-4 py-2 text-[11px] leading-5 text-[var(--text-muted)]">↑↓ 选择 · Enter 打开 · Esc 关闭</p>
    </div>
  </div>;
}

function TaskOption({ optionRef, match, summary, agent, optionId, active, onHover, onRun }: {
  optionRef(node: HTMLButtonElement | null): void;
  match: TaskSearchMatch;
  summary?: RunSummary;
  agent?: Agent;
  optionId: string;
  active: boolean;
  onHover(): void;
  onRun(): void;
}) {
  const { session, fields } = match;
  const updatedAt = session.updatedAt || session.createdAt;
  const status = effectiveStatus(session).label;
  const goal = summary?.prompt?.trim() || fallbackRunTitle(session.source);
  const queuedCommands = summary?.queuedCount ?? 0;
  const attention = !session.archivedAt && workbenchTaskSection(session, summary) === 'attention';
  return <button ref={optionRef} type="button" role="option" id={optionId} tabIndex={-1} aria-selected={active} onMouseMove={onHover} onClick={onRun} className={`flex min-h-10 w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left ${active ? 'bg-[var(--action-soft)]' : 'hover:bg-[var(--surface-hover)]'}`}>
    <span className={`mt-px inline-flex h-6 shrink-0 items-center rounded-full border px-2 text-[11px] font-semibold ${stateBadgeStyle(session)}`}>{status}</span>
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[13px] font-medium leading-5 text-[var(--text-primary)]" title={goal}>{goal}</span>
      <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-4 text-[var(--text-secondary)]">
        <span>{workspaceName(session.cwd)}</span><span aria-hidden="true">·</span><span>{agent?.name ?? session.agentId}</span>
        <span aria-hidden="true">·</span><span title={updatedAt ? new Date(updatedAt).toLocaleString('zh-CN') : undefined}>更新于 {formatRelativeTime(updatedAt)}</span>
        {queuedCommands > 0 && <span className="rounded bg-[var(--status-queued-soft)] px-1.5 text-[var(--status-queued)]">待执行指令 {queuedCommands} 条</span>}
        {fields.length > 0 && <span className="text-[var(--text-muted)]">命中 {fields.map(field => fieldLabels[field]).join('、')}</span>}
      </span>
      {attention && <span className="mt-0.5 block truncate text-[11px] leading-4 font-medium text-[var(--text-primary)]">{attentionReasonForSession(session)}</span>}
    </span>
    <span className="ml-auto hidden shrink-0 font-mono text-[11px] text-[var(--text-muted)] sm:block">{shortRunId(session)}</span>
  </button>;
}
