import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { CornerDownLeft, Search } from 'lucide-react';
import type { Agent, RunSummary, Session } from '../api';
import { fallbackRunTitle, sessionDisplayName } from '../run-summary';
import { searchTasks, taskSearchTerms, type TaskSearchField, type TaskSearchMatch } from '../task-search';
import { useDialogFocus } from '../useDialogFocus';
import { attentionReasonForSession, formatRelativeTime, sessionWorkspaceName, shortRunId, workbenchTaskSection } from '../workspace-model';
import { Kbd, StatusBadge } from './primitives';

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
  /*
    Escape 刻意留在这个本地 onKeyDown 上，没有迁到 useEscapeKey——两者在这里
    互斥，不是漏迁。

    实测（jsdom 探针，React 19）：
      · 只用 useEscapeKey（document 冒泡监听）→ onClose 调用 1 次，但外层 React
        onKeyDown 也被调用 1 次。React 把监听挂在 root container 上，document 在
        冒泡链末端，所以外层先收到事件，面板无法再收回。
      · useEscapeKey + 本地 stopPropagation → 两边都是 0 次：SyntheticEvent
        .stopPropagation() 会连原生事件一起停掉，document 上的监听根本不会跑。

    也就是说「用 useEscapeKey」与「Escape 不冒泡给外层」（CommandPalette.dom.test.tsx
    「Escape 关闭面板，且不冒泡给外层」）不能同时成立，除非把 useEscapeKey 改成捕获
    阶段——那是 Phase 0 冻结的共享 hook，不在本轮改动范围。

    保留本地处理在语义上也不吃亏：面板是焦点陷阱，Escape 只有在焦点位于面板内时
    才会走到这里，天然就是「最上面那一层」，与 §8.1 的 LIFO 目标一致。
    嵌套两种方向都验证过：面板压在 ConfirmDialog 上时 stopPropagation 挡住下层的
    document 监听，只关面板；反过来别的弹层压在面板上时焦点不在面板内，这个处理
    根本不触发，由栈顶那层响应。
  */
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

  return <div className="ui-overlay fixed inset-0 z-dialog flex items-start justify-center bg-scrim p-4 pt-[9vh] backdrop-blur-[3px]" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="搜索任务与命令" onKeyDown={onKeyDown} className="ui-dialog flex max-h-[76dvh] w-full max-w-[640px] flex-col overflow-hidden rounded-xl border border-default bg-surface shadow-dialog">
      <div className="flex items-center gap-2.5 border-b border-subtle px-4 py-3">
        <Search aria-hidden="true" size={17} className="shrink-0 text-subtle"/>
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
          className="min-w-0 flex-1 bg-transparent text-body text-primary outline-none placeholder:text-subtle"
        />
        <span className="hidden shrink-0 sm:inline"><Kbd>Esc</Kbd></span>
      </div>
      <p id={hintId} role="status" aria-live="polite" className="border-b border-subtle bg-muted px-4 py-1.5 text-caption text-secondary">{summaryText}</p>
      <div id={listboxId} role="listbox" aria-label="搜索结果" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        {items.length === 0
          ? <p className="ui-empty-state px-3 py-8 text-center text-body text-secondary">{searching ? '没有匹配的任务或命令。换个关键词，或按 Esc 关闭。' : '还没有任务，也没有可执行的命令。先创建一个任务，再回到这里检索。'}</p>
          : sections.map(section => <div key={section.id} role="group" aria-labelledby={`${baseId}-${section.id}`} className="mb-1.5 last:mb-0">
            <div className="flex items-baseline gap-2 px-2 pb-1 pt-1.5"><h2 id={`${baseId}-${section.id}`} className="text-caption font-semibold uppercase tracking-[.06em] text-subtle">{section.title}</h2>{section.hint && <span className="min-w-0 flex-1 truncate text-caption text-subtle">{section.hint}</span>}</div>
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
                className={`flex min-h-10 w-full items-center gap-3 rounded-md px-2.5 py-1.5 text-left ${item.action.disabled ? 'cursor-not-allowed opacity-60' : item.index === activeIndex ? 'bg-action-soft' : 'hover:bg-hover'}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body font-medium text-primary">{item.action.label}</span>
                  {(item.action.disabled ? item.action.disabledReason : item.action.hint) && <span className={`mt-0.5 block truncate text-caption ${item.action.disabled ? 'text-warning' : 'text-secondary'}`}>{item.action.disabled ? item.action.disabledReason : item.action.hint}</span>}
                </span>
                {item.action.shortcut && <Kbd>{item.action.shortcut}</Kbd>}
                {item.index === activeIndex && !item.action.disabled && <CornerDownLeft aria-hidden="true" size={13} className="shrink-0 text-action"/>}
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
      <p className="border-t border-subtle bg-muted px-4 py-2 text-caption text-subtle">↑↓ 选择 · Enter 打开 · Esc 关闭</p>
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
  const goal = sessionDisplayName(session, summary?.prompt, fallbackRunTitle(session.source));
  const queuedCommands = summary?.queuedCount ?? 0;
  const attention = !session.archivedAt && workbenchTaskSection(session, summary) === 'attention';
  return <button ref={optionRef} type="button" role="option" id={optionId} tabIndex={-1} aria-selected={active} onMouseMove={onHover} onClick={onRun} className={`flex min-h-10 w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left ${active ? 'bg-action-soft' : 'hover:bg-hover'}`}>
    {/* 徽标文案与归档优先判据都来自 effectiveStatus，由 StatusBadge 单点消费；这里不再拼配色字符串。 */}
    <span className="mt-px shrink-0"><StatusBadge session={session}/></span>
    <span className="min-w-0 flex-1">
      <span className="block truncate text-body font-medium text-primary" title={goal}>{goal}</span>
      <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-caption text-secondary">
        <span>{sessionWorkspaceName(session)}</span><span aria-hidden="true">·</span><span>{agent?.name ?? session.agentId}</span>
        <span aria-hidden="true">·</span><span title={updatedAt ? new Date(updatedAt).toLocaleString('zh-CN') : undefined}>更新于 {formatRelativeTime(updatedAt)}</span>
        {queuedCommands > 0 && <span className="rounded-sm bg-queued-soft px-1.5 text-queued">待执行指令 {queuedCommands} 条</span>}
        {fields.length > 0 && <span className="text-subtle">命中 {fields.map(field => fieldLabels[field]).join('、')}</span>}
      </span>
      {attention && <span className="mt-0.5 block truncate text-caption font-medium text-primary">{attentionReasonForSession(session)}</span>}
    </span>
    {/* runId 是契约 §2 点名允许 text-meta 的低频元数据。 */}
    <span className="ml-auto hidden shrink-0 font-mono text-meta text-subtle sm:block">{shortRunId(session)}</span>
  </button>;
}
