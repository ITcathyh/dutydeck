import { MessageSquare } from 'lucide-react';
import type { Agent, RunSummary, Session } from '../api';
import { fallbackRunTitle } from '../run-summary';
import { formatRelativeTime, shortRunId } from '../workspace-model';
import { sidebarStatusVisual } from './ui';

export type SessionRowProps = { session: Session; summary?: RunSummary; agent?: Agent; botName?: string; active: boolean; onClick(): void };

export function SessionRow({ session, summary, agent, botName, active, onClick }: SessionRowProps) {
  const lark = session.source === 'lark';
  // 文案、文字色、圆点色、是否呼吸全部来自同一个判断，见 ui.tsx:sidebarStatusVisual。
  // status.textClass / status.dotClass 原样拼进 className：它们是那个判断的产物，
  // 在调用点换成语义类等于把同一条规则又抄了一遍，正是这组测试在防的漂移。
  const status = sidebarStatusVisual(session);
  // 别处（总览、命令面板、RunHeader）统一写「待执行指令 N 条」，这一行是唯一例外：
  // 侧栏整行宽度只有 248px（重做前是 292px，浮动卡片对齐 botmux 后又窄了 44px），
  // 还要同时容纳 Agent 名、飞书来源、相对时间和 run id，多出的两个字会把相对时间挤掉。
  // 这里省掉「指令」二字，量词「条」保留。窄了之后这条理由只会更强，别改回长版。
  const queuedCount = summary?.queuedCount ?? 0;
  // aria-current：选中态此前只有视觉（左侧 3px 内阴影），读屏用户听完整列任务也不知道
  // 自己正停在哪一个。取值用 'true' 而不是 'page'——侧栏任务行切换的是同一页面内的
  // 主区内容，不是页面导航项，报成 'page' 会让读屏播报成「当前页」，与事实不符。
  // 行高 52px（刻意的两行高度），按契约 §3「半径 ≈ 高度/3.5」取 rounded-lg（14px）。
  // 选中态的左侧色条走 shadow-row-active 这一档（tailwind.config 里单列，
  // 因为它是「选中」的视觉承载而不是分层阴影，复用 card/panel 那五档会语义不符）。
  return <button onClick={onClick} aria-current={active ? 'true' : undefined} className={`ui-session-row group relative mb-1 min-h-[52px] w-full rounded-lg border px-2.5 py-2 text-left transition-[background-color,border-color,box-shadow,transform] duration-fast active:scale-[.99] ${active ? 'border-sidebar-border bg-sidebar-active shadow-row-active' : 'border-transparent hover:border-sidebar-border hover:bg-sidebar-hover'}`}>
    <div className="flex items-center gap-2"><span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.pulse ? 'ui-status-pulse' : ''} ${status.dotClass}`}/><span className={`min-w-0 flex-1 truncate text-body font-medium ${active ? 'text-sidebar-text-strong' : 'text-sidebar-text'}`} title={summary?.prompt}>{summary?.prompt ?? fallbackRunTitle(session.source)}</span><span className={`shrink-0 text-caption font-medium ${status.textClass}`}>{status.label}</span></div>
    <div className="mt-1 flex min-w-0 items-center gap-1.5 pl-3.5 text-caption text-sidebar-text-muted">{lark && <MessageSquare size={11} className="shrink-0 text-queued"/>}<span className="truncate">{session.archivedAt ? `${agent?.name ?? session.agentId} · 只读` : `${agent?.name ?? session.agentId}${lark ? ` · ${botName ?? '飞书'}` : ''}`}</span>{queuedCount > 0 && <span className="shrink-0 text-queued">待执行 {queuedCount} 条</span>}<span className="ml-auto shrink-0 text-caption text-sidebar-text-muted">更新于 {formatRelativeTime(session.updatedAt || session.createdAt)}</span><span className="hidden shrink-0 font-mono text-meta tracking-[.06em] text-sidebar-text-faint xl:inline">{shortRunId(session)}</span></div>
  </button>;
}
