import type { RunSummary, Session } from './api';
import type { WorkspaceOrganization } from '@dutydeck/shared';
import {
  collectWorkspaceGroups,
  normalizeWorkspacePath,
  sessionWorkspaceDirectory,
  workspaceName
} from '@dutydeck/shared';

export { normalizeWorkspacePath, sessionWorkspaceDirectory, workspaceName };

export type WorkbenchView = 'all' | 'attention' | 'active' | 'completed' | 'archived';

/**
 * 筛选项的唯一定义，顺序即界面顺序，也即数字快捷键 1–5 的顺序。
 * 侧栏与总览页曾各自硬编码一份 7 项数组，标签逐字重复却又各自漂移；
 * 现在只有总览页渲染筛选，标签仍集中在此，避免第二份副本重新长出来。
 */
export const workbenchViewOrder = ['all', 'attention', 'active', 'completed', 'archived'] as const;

export const workbenchViewLabels: Record<WorkbenchView, string> = {
  all: '全部',
  attention: '待你处理',
  active: '进行中',
  completed: '已完成',
  archived: '已归档'
};

export type WorkspaceGroup = {
  id: string;
  cwd: string;
  name: string;
  sessions: Session[];
  /**
   * 该工作区下所有任务的待执行指令总数。
   *
   * 目前没有渲染点：侧栏一行只有 248px，容不下第三个数字（工作区名 + 任务数已占满，
   * 见 SessionRow.tsx:15-18 关于同一宽度压力的记录）。留着是因为它是这一层的完整
   * 投影而不是遗留——workspace-model.test.ts 在断言它，删掉等于删一条真实覆盖。
   * 若将来确定侧栏永不展示排队口径，连同那条断言一起删，不要只删字段。
   */
  queuedCount: number;
  updatedAt: string;
};

export type WorkbenchTaskSection = 'attention' | 'active' | 'continue' | 'recent';
export type SessionAttention = 'decision' | 'recovery' | 'active' | 'continue' | 'completed' | 'archived';

const activeStates = new Set(['starting', 'thinking', 'running_tool', 'interrupting']);
const continuableStates = new Set(['created', 'idle']);
const recoveryStates = new Set(['failed', 'stopped', 'interrupted']);
const taskSectionRank: Record<WorkbenchTaskSection, number> = { attention: 0, active: 1, continue: 2, recent: 3 };
const errorSummaryLimit = 140;

export function sessionWorkspaceName(session: Pick<Session, 'cwd' | 'workspaceSourceCwd'>): string {
  return workspaceName(sessionWorkspaceDirectory(session));
}

/** 计数、筛选、排序与行内说明共享同一投影；正常空闲不构成待办。 */
export function sessionAttention(session: Session, summary?: RunSummary): SessionAttention {
  if (session.archivedAt) return 'archived';
  if (session.state === 'waiting_for_permission' || session.state === 'waiting_for_answer') return 'decision';
  if (recoveryStates.has(session.state) || session.error?.trim()) return 'recovery';
  if (activeStates.has(session.state) || (summary?.queuedCount ?? 0) > 0) return 'active';
  if (continuableStates.has(session.state)) return 'continue';
  if (session.state === 'completed') return 'completed';
  return 'recovery';
}

export function needsAttention(session: Session, summary?: RunSummary): boolean {
  const attention = sessionAttention(session, summary);
  return attention === 'decision' || attention === 'recovery';
}

export function sessionMatchesView(session: Session, view: WorkbenchView, summary?: RunSummary): boolean {
  if (view === 'archived') return Boolean(session.archivedAt);
  if (session.archivedAt) return false;
  if (view === 'all') return true;
  if (view === 'attention') return needsAttention(session, summary);
  if (view === 'active') return workbenchTaskSection(session, summary) === 'active';
  return workbenchTaskSection(session, summary) === 'recent';
}

export function workbenchCounts(sessions: Session[], summaries: Record<string, RunSummary> = {}) {
  const current = sessions.filter(session => !session.archivedAt);
  return {
    all: current.length,
    active: current.filter(session => sessionMatchesView(session, 'active', summaries[session.id])).length,
    queuedCommands: current.reduce((count, session) => count + (summaries[session.id]?.queuedCount ?? 0), 0),
    attention: current.filter(session => needsAttention(session, summaries[session.id])).length,
    continuable: current.filter(session => sessionAttention(session, summaries[session.id]) === 'continue').length,
    completed: current.filter(session => sessionMatchesView(session, 'completed', summaries[session.id])).length,
    archived: sessions.length - current.length
  };
}

export function workbenchTaskSection(session: Session, summary?: RunSummary): WorkbenchTaskSection {
  const attention = sessionAttention(session, summary);
  if (attention === 'decision' || attention === 'recovery') return 'attention';
  if (attention === 'active') return 'active';
  if (attention === 'continue') return 'continue';
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

export function groupSessionsByWorkspace(
  sessions: Session[],
  view: WorkbenchView = 'all',
  summaries: Record<string, RunSummary> = {},
  organization?: WorkspaceOrganization
): WorkspaceGroup[] {
  const filtered = sessions.filter(session => sessionMatchesView(session, view, summaries[session.id]));
  const groupSummaries = collectWorkspaceGroups(filtered, organization);
  const sessionMap = new Map<string, Session>(filtered.map(session => [session.id, session]));

  const groups: WorkspaceGroup[] = [];
  for (const groupSummary of groupSummaries) {
    const groupSessions = groupSummary.sessionIds
      .map(id => sessionMap.get(id))
      .filter((session): session is Session => Boolean(session));

    if (view !== 'all' && groupSessions.length === 0) {
      continue;
    }
    if (view === 'all' && !groupSummary.custom && groupSessions.length === 0) {
      continue;
    }

    const sorted = orderSessionsForWorkbench(groupSessions, view, summaries);
    const latest = [...groupSessions].sort((left, right) => (right.updatedAt || right.createdAt).localeCompare(left.updatedAt || left.createdAt))[0];
    groups.push({
      id: groupSummary.id,
      cwd: groupSummary.directories.join('\n'),
      name: groupSummary.name,
      sessions: sorted,
      queuedCount: sorted.reduce((count, session) => count + (summaries[session.id]?.queuedCount ?? 0), 0),
      updatedAt: latest?.updatedAt || latest?.createdAt || ''
    });
  }

  return groups.sort((left, right) => {
    if (view === 'all') {
      const leftFirst = left.sessions[0];
      const rightFirst = right.sessions[0];
      const leftRank = leftFirst ? taskSectionRank[workbenchTaskSection(leftFirst, summaries[leftFirst.id])] : 3;
      const rightRank = rightFirst ? taskSectionRank[workbenchTaskSection(rightFirst, summaries[rightFirst.id])] : 3;
      const priority = leftRank - rightRank;
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
  if (state === 'waiting_for_answer') return '需要你回答 Agent 的问题后继续';
  if (activeStates.has(state)) return 'Agent 正在推进；你可以排队补充要求或立即介入';
  if (state === 'failed') return '查看失败详情，修正后重新启动';
  // 重新启动会换一个全新的 Agent 进程（runtime 走 driver.start()，不是 resume），
  // 上下文不会跟着回来。这里不能承诺「保留当前上下文」。
  if (state === 'stopped') return '任务已停止，可重新启动；重启会从空白上下文开始';
  if (state === 'completed') return '检查交付结果，继续追问或归档任务';
  if (state === 'interrupted') return '任务已中断，输入新指令即可继续';
  if (state === 'idle') return 'Agent 正在等你的下一条指令';
  if (state === 'created') return '还没有可执行的指令；补充目标后即可开始';
  return '状态待确认，打开任务检查执行记录与连接';
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
  return error ? `任务异常：${error}；打开详情查看` : nextActionForState(session.state);
}
