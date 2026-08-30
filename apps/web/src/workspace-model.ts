import type { RunSummary, Session } from './api';

export type WorkbenchView = 'all' | 'active' | 'queued' | 'attention' | 'failed' | 'completed' | 'archived';

export type WorkspaceGroup = {
  id: string;
  cwd: string;
  name: string;
  sessions: Session[];
  activeCount: number;
  queuedCount: number;
  attentionCount: number;
  failedCount: number;
  completedCount: number;
  archivedCount: number;
  updatedAt: string;
};

const activeStates = new Set(['starting', 'thinking', 'running_tool', 'interrupting']);
const attentionStates = new Set(['waiting_for_permission', 'idle', 'interrupted']);
const failedStates = new Set(['failed', 'stopped']);
const completedStates = new Set(['completed']);

export function workspaceName(cwd: string): string {
  const normalized = cwd.trim().replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) || cwd || '未命名工作区';
}

export function sessionMatchesView(session: Session, view: WorkbenchView, summary?: RunSummary): boolean {
  if (view === 'archived') return Boolean(session.archivedAt);
  if (session.archivedAt) return false;
  if (view === 'all') return true;
  if (view === 'active') return activeStates.has(session.state);
  if (view === 'queued') return (summary?.queuedCount ?? 0) > 0;
  if (view === 'attention') return attentionStates.has(session.state) || (session.state === 'created' && (summary?.queuedCount ?? 0) === 0);
  if (view === 'failed') return failedStates.has(session.state);
  return completedStates.has(session.state);
}

export function workbenchCounts(sessions: Session[], summaries: Record<string, RunSummary> = {}) {
  const current = sessions.filter(session => !session.archivedAt);
  return {
    all: current.length,
    active: current.filter(session => sessionMatchesView(session, 'active', summaries[session.id])).length,
    queued: current.reduce((count, session) => count + (summaries[session.id]?.queuedCount ?? 0), 0),
    attention: current.filter(session => sessionMatchesView(session, 'attention', summaries[session.id])).length,
    failed: current.filter(session => sessionMatchesView(session, 'failed', summaries[session.id])).length,
    completed: current.filter(session => sessionMatchesView(session, 'completed', summaries[session.id])).length,
    archived: sessions.length - current.length
  };
}

export function groupSessionsByWorkspace(sessions: Session[], view: WorkbenchView = 'all', summaries: Record<string, RunSummary> = {}): WorkspaceGroup[] {
  const groups = new Map<string, Session[]>();
  for (const session of sessions) {
    if (!sessionMatchesView(session, view, summaries[session.id])) continue;
    const cwd = session.cwd.trim().replace(/[\\/]+$/, '') || session.cwd;
    groups.set(cwd, [...(groups.get(cwd) ?? []), session]);
  }
  return [...groups.entries()].map(([cwd, entries]) => {
    const sorted = [...entries].sort((left, right) => (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt));
    return {
      id: cwd,
      cwd,
      name: workspaceName(cwd),
      sessions: sorted,
      activeCount: sorted.filter(session => sessionMatchesView(session, 'active', summaries[session.id])).length,
      queuedCount: sorted.reduce((count, session) => count + (summaries[session.id]?.queuedCount ?? 0), 0),
      attentionCount: sorted.filter(session => sessionMatchesView(session, 'attention', summaries[session.id])).length,
      failedCount: sorted.filter(session => sessionMatchesView(session, 'failed', summaries[session.id])).length,
      completedCount: sorted.filter(session => sessionMatchesView(session, 'completed', summaries[session.id])).length,
      archivedCount: sorted.filter(session => sessionMatchesView(session, 'archived', summaries[session.id])).length,
      updatedAt: sorted[0]?.updatedAt ?? sorted[0]?.createdAt ?? ''
    };
  }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function shortRunId(session: Session): string {
  return (session.runId || session.id).replace(/^run[-_:]?/i, '').slice(0, 7).toUpperCase();
}

export function nextActionForState(state: string): string {
  if (state === 'waiting_for_permission') return '需要你确认 Agent 的下一步操作';
  if (activeStates.has(state)) return 'Agent 正在推进；你可以排队补充要求或立即介入';
  if (state === 'failed') return '检查失败信息，然后重新启动该任务运行';
  if (state === 'stopped') return '运行已停止，可重新启动并保留当前上下文';
  if (state === 'completed') return '检查交付结果，继续追问或归档运行';
  if (state === 'interrupted') return '运行已中断，输入新指令即可继续';
  return '描述下一步目标，Agent 将从当前上下文继续';
}
