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

export type WorkbenchTaskSection = 'attention' | 'active' | 'recent';

const activeStates = new Set(['starting', 'thinking', 'running_tool', 'interrupting']);
const attentionStates = new Set(['waiting_for_permission', 'idle', 'interrupted']);
const failedStates = new Set(['failed', 'stopped']);
const completedStates = new Set(['completed']);
const taskSectionRank: Record<WorkbenchTaskSection, number> = { attention: 0, active: 1, recent: 2 };
const errorSummaryLimit = 140;

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
  if (view === 'attention') return session.state === 'waiting_for_permission' || ((attentionStates.has(session.state) || session.state === 'created') && (summary?.queuedCount ?? 0) === 0);
  if (view === 'failed') return failedStates.has(session.state);
  return completedStates.has(session.state);
}

export function workbenchCounts(sessions: Session[], summaries: Record<string, RunSummary> = {}) {
  const current = sessions.filter(session => !session.archivedAt);
  return {
    all: current.length,
    active: current.filter(session => sessionMatchesView(session, 'active', summaries[session.id])).length,
    queued: current.filter(session => sessionMatchesView(session, 'queued', summaries[session.id])).length,
    queuedCommands: current.reduce((count, session) => count + (summaries[session.id]?.queuedCount ?? 0), 0),
    attention: current.filter(session => sessionMatchesView(session, 'attention', summaries[session.id])).length,
    failed: current.filter(session => sessionMatchesView(session, 'failed', summaries[session.id])).length,
    completed: current.filter(session => sessionMatchesView(session, 'completed', summaries[session.id])).length,
    archived: sessions.length - current.length
  };
}

export function workbenchTaskSection(session: Session, summary?: RunSummary): WorkbenchTaskSection {
  if (failedStates.has(session.state) || sessionMatchesView(session, 'attention', summary)) return 'attention';
  if (activeStates.has(session.state) || (summary?.queuedCount ?? 0) > 0) return 'active';
  return 'recent';
}

export function orderSessionsForWorkbench(sessions: Session[], view: WorkbenchView, summaries: Record<string, RunSummary> = {}): Session[] {
  return sessions
    .filter(session => sessionMatchesView(session, view, summaries[session.id]))
    .sort((left, right) => {
      if (view === 'all') {
        const priority = taskSectionRank[workbenchTaskSection(left, summaries[left.id])] - taskSectionRank[workbenchTaskSection(right, summaries[right.id])];
        if (priority) return priority;
      }
      return (right.updatedAt || right.createdAt).localeCompare(left.updatedAt || left.createdAt);
    });
}

export function formatRelativeTime(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '时间未知';
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))} 小时前`;
  if (elapsed < 48 * 60 * 60_000) return '昨天';
  if (elapsed < 7 * 24 * 60 * 60_000) return `${Math.floor(elapsed / (24 * 60 * 60_000))} 天前`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(timestamp);
}

export function groupSessionsByWorkspace(sessions: Session[], view: WorkbenchView = 'all', summaries: Record<string, RunSummary> = {}): WorkspaceGroup[] {
  const groups = new Map<string, Session[]>();
  for (const session of sessions) {
    if (!sessionMatchesView(session, view, summaries[session.id])) continue;
    const cwd = session.cwd.trim().replace(/[\\/]+$/, '') || session.cwd;
    groups.set(cwd, [...(groups.get(cwd) ?? []), session]);
  }
  return [...groups.entries()].map(([cwd, entries]) => {
    const sorted = orderSessionsForWorkbench(entries, view, summaries);
    const latest = [...entries].sort((left, right) => (right.updatedAt || right.createdAt).localeCompare(left.updatedAt || left.createdAt))[0];
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
      updatedAt: latest?.updatedAt || latest?.createdAt || ''
    };
  }).sort((left, right) => {
    if (view === 'all') {
      const priority = taskSectionRank[workbenchTaskSection(left.sessions[0], summaries[left.sessions[0]?.id])] - taskSectionRank[workbenchTaskSection(right.sessions[0], summaries[right.sessions[0]?.id])];
      if (priority) return priority;
    }
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

export function shortRunId(session: Session): string {
  return (session.runId || session.id).replace(/^run[-_:]?/i, '').slice(0, 7).toUpperCase();
}

export function nextActionForState(state: string): string {
  if (state === 'waiting_for_permission') return '需要你授权 Agent 执行下一步操作';
  if (activeStates.has(state)) return 'Agent 正在推进；你可以排队补充要求或立即介入';
  if (state === 'failed') return '查看失败详情，修正后重新运行';
  if (state === 'stopped') return '运行已停止，可重新启动并保留当前上下文';
  if (state === 'completed') return '检查交付结果，继续追问或归档运行';
  if (state === 'interrupted') return '运行已中断，输入新指令即可继续';
  if (state === 'idle') return 'Agent 正在等你的下一条指令';
  if (state === 'created') return '还没有可执行的指令；补充目标后即可开始';
  return '描述下一步目标，Agent 将从当前上下文继续';
}

export function sessionErrorSummary(error?: string): string | undefined {
  if (!error?.trim()) return;
  const redacted = error
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[已隐藏私钥]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[已隐藏凭据]@')
    .replace(/\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer\s+)?[^\s,;]+/gi, 'Authorization: [已隐藏]')
    .replace(/\bbearer\s+[^\s,;]+/gi, 'Bearer [已隐藏]')
    .replace(/(--(?:api-key|token|password|secret|client-secret))\s+[^\s,;]+/gi, '$1 [已隐藏]')
    .replace(/\b([A-Za-z0-9_-]*(?:api[_-]?key|secret[_-]?access[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret|cookie))\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1=[已隐藏]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[已隐藏凭据]')
    .replace(/\b(?:sk|ghp|gho|xoxb|xoxp|xoxa|xoxr)[-_][A-Za-z0-9_-]{12,}\b/gi, '[已隐藏凭据]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!redacted) return;
  const characters = Array.from(redacted);
  return characters.length <= errorSummaryLimit ? redacted : `${characters.slice(0, errorSummaryLimit - 1).join('')}…`;
}

export function attentionReasonForSession(session: Session): string {
  const error = sessionErrorSummary(session.error);
  return error ? `运行异常：${error}；打开详情查看` : nextActionForState(session.state);
}
