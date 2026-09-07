import type { RunSummary, Session } from './api';

export type WorkbenchView = 'all' | 'attention' | 'active' | 'completed' | 'archived';

/**
 * 筛选项的唯一定义，顺序即界面顺序，也即数字快捷键 1–5 的顺序。
 * 侧栏与总览页曾各自硬编码一份 7 项数组，标签逐字重复却又各自漂移；
 * 现在只有总览页渲染筛选，标签仍集中在此，避免第二份副本重新长出来。
 */
export const workbenchViewOrder = ['all', 'attention', 'active', 'completed', 'archived'] as const;

export const workbenchViewLabels: Record<WorkbenchView, string> = {
  all: '总览',
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

export type WorkbenchTaskSection = 'attention' | 'active' | 'recent';

const activeStates = new Set(['starting', 'thinking', 'running_tool', 'interrupting']);
const attentionStates = new Set(['waiting_for_permission', 'idle', 'interrupted']);
const failedStates = new Set(['failed', 'stopped']);
const taskSectionRank: Record<WorkbenchTaskSection, number> = { attention: 0, active: 1, recent: 2 };
const errorSummaryLimit = 140;

export function workspaceName(cwd: string): string {
  const normalized = cwd.trim().replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) || cwd || '未命名工作区';
}

/**
 * 「待你处理」的唯一判据。
 *
 * 失败和已停止属于待你处理：产品定义里这一层就是「系统无法自行前进」，
 * 修正失败与授权、补充指令并列（docs/interaction-design-2026-08-30.md §1）。
 *
 * 这个函数存在的意义是它只有一份。筛选计数与分区归属曾各写一套判断，
 * 对 failed 的取舍正好相反，于是同一屏上「待你处理」的芯片显示 0、
 * 分区标题显示 12 条。任何新的「待你处理」口径都必须改这里，不得在
 * 调用点旁边另写一个条件。
 */
export function needsAttention(session: Session, summary?: RunSummary): boolean {
  if (session.archivedAt) return false;
  if (session.state === 'waiting_for_permission') return true;
  if (failedStates.has(session.state)) return true;
  // 有排队指令时 Agent 还有活可干，不算卡在用户这一侧。
  return (attentionStates.has(session.state) || session.state === 'created') && (summary?.queuedCount ?? 0) === 0;
}

export function sessionMatchesView(session: Session, view: WorkbenchView, summary?: RunSummary): boolean {
  if (view === 'archived') return Boolean(session.archivedAt);
  if (session.archivedAt) return false;
  if (view === 'all') return true;
  // 「进行中」的口径直接委托给分区函数，不在这里复制一份条件。
  // 已排队的任务也属于「进行中」（docs/interaction-design-2026-08-30.md §1），
  // 而 activeStates 里没有 created/queued，所以「只判状态」会漏掉它们。
  // 委托而不是照抄 `activeStates.has(state) || queuedCount > 0`，是因为分区函数
  // 先判 needsAttention 再判 active：照抄会让「等待授权 + 有排队指令」的任务
  // 同时被 attention 与 active 两个芯片计数，分区里却只出现一次——又一处分裂。
  // 要改「进行中」的定义，改 workbenchTaskSection，不要在这里加条件。
  if (view === 'active') return workbenchTaskSection(session, summary) === 'active';
  if (view === 'attention') return needsAttention(session, summary);
  // 「已完成」同样委托，不再裸判 `state === 'completed'`。
  //
  // 视图名与分区 key 不同名，这不是笔误：分区 key 叫 `recent` 是 workbenchTaskSection
  // 的兜底分支命名（`return 'recent'`），用户可见的标题与筛选芯片都写「已完成」。
  // 穷举 11 个状态 × queuedCount 有无（共 22 种组合）后，落到 recent 的只有
  // 「completed 且没有排队指令」，两者是同一个集合，所以这里可以直接映射。
  //
  // 裸判状态曾让「completed 且排了一条指令」同时被「已完成」和「进行中」两个芯片
  // 计数（counts 里 active:1、completed:1 指向同一条 session），而分区只把它放进
  // 「进行中」一处——与 active 分支上方注释预言的分裂同源，只是发生在 completed。
  if (view === 'completed') return workbenchTaskSection(session, summary) === 'recent';
  return false;
}

/**
 * 不变量：除 all / archived 之外的每个视图都必须委托给同一个 workbenchTaskSection。
 *
 *   active    → workbenchTaskSection(...) === 'active'
 *   attention → needsAttention(...)（即 workbenchTaskSection 的第一行判据）
 *   completed → workbenchTaskSection(...) === 'recent'
 *
 * 因为「芯片计数」与「分区条数」都只读这一个函数，两者在结构上不可能再分裂：
 * 一条 session 只会被归到一个分区，也就只会被一个芯片数到。
 * 新增视图必须同样委托，不得在这里另写一套状态判断——照抄条件会让同一条任务
 * 被两个芯片计数，而分区里只出现一次，那正是本文件三处注释反复记下的那类故障。
 */
export function workbenchCounts(sessions: Session[], summaries: Record<string, RunSummary> = {}) {
  const current = sessions.filter(session => !session.archivedAt);
  return {
    all: current.length,
    active: current.filter(session => sessionMatchesView(session, 'active', summaries[session.id])).length,
    queuedCommands: current.reduce((count, session) => count + (summaries[session.id]?.queuedCount ?? 0), 0),
    attention: current.filter(session => sessionMatchesView(session, 'attention', summaries[session.id])).length,
    completed: current.filter(session => sessionMatchesView(session, 'completed', summaries[session.id])).length,
    archived: sessions.length - current.length
  };
}

export function workbenchTaskSection(session: Session, summary?: RunSummary): WorkbenchTaskSection {
  if (needsAttention(session, summary)) return 'attention';
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
      queuedCount: sorted.reduce((count, session) => count + (summaries[session.id]?.queuedCount ?? 0), 0),
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
  if (state === 'failed') return '查看失败详情，修正后重新启动';
  // 重新启动会换一个全新的 Agent 进程（runtime 走 driver.start()，不是 resume），
  // 上下文不会跟着回来。这里不能承诺「保留当前上下文」。
  if (state === 'stopped') return '任务已停止，可重新启动；重启会从空白上下文开始';
  if (state === 'completed') return '检查交付结果，继续追问或归档任务';
  if (state === 'interrupted') return '任务已中断，输入新指令即可继续';
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
  return error ? `任务异常：${error}；打开详情查看` : nextActionForState(session.state);
}
