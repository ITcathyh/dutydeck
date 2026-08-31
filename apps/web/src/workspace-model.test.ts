import { describe, expect, it } from 'vitest';
import type { RunSummary, Session } from './api';
import { attentionReasonForSession, formatRelativeTime, groupSessionsByWorkspace, orderSessionsForWorkbench, sessionErrorSummary, sessionMatchesView, workbenchCounts, workspaceName } from './workspace-model';

const session = (id: string, cwd: string, state: string, updatedAt: string): Session => ({ id, cwd, state, updatedAt, createdAt: updatedAt, agentId: 'codex', runId: `run-${id}` });

describe('workspace model', () => {
  it('按 cwd 聚合，并在默认视图将需要处理的工作区置顶', () => {
    const groups = groupSessionsByWorkspace([
      session('1', '/repo/alpha', 'idle', '2026-08-20T00:00:00Z'),
      session('2', '/repo/beta/', 'thinking', '2026-08-22T00:00:00Z'),
      session('3', '/repo/alpha/', 'failed', '2026-08-21T00:00:00Z')
    ]);
    expect(groups.map(group => group.name)).toEqual(['alpha', 'beta']);
    expect(groups[0].sessions.map(item => item.id)).toEqual(['3', '1']);
  });

  it('使用运行数计状态，并将排队运行数与待执行指令数分开', () => {
    const archived = { ...session('6', '/repo/archive', 'completed', ''), archivedAt: '2026-08-30T00:00:00Z' };
    const sessions = [
      session('1', '/repo', 'thinking', ''),
      session('2', '/repo', 'created', ''),
      session('3', '/repo', 'idle', ''),
      session('4', '/repo', 'failed', ''),
      session('5', '/repo', 'completed', ''),
      archived
    ];
    const summaries: Record<string, RunSummary> = {
      '1': { sessionId: '1', taskId: 't1', prompt: '正在运行且还有排队任务', status: 'running', queuedCount: 2, updatedAt: '' },
      '2': { sessionId: '2', taskId: 't2', prompt: '等待调度', status: 'queued', queuedCount: 1, updatedAt: '' }
    };
    expect(workbenchCounts(sessions, summaries)).toEqual({ all: 5, active: 1, queued: 2, queuedCommands: 3, attention: 1, failed: 1, completed: 1, archived: 1 });
    expect(sessionMatchesView(sessions[0], 'queued', summaries['1'])).toBe(true);
    expect(sessionMatchesView(sessions[1], 'queued', summaries['2'])).toBe(true);
    expect(sessionMatchesView(sessions[1], 'attention', summaries['2'])).toBe(false);
    const noTask = session('no-task', '/repo', 'created', '');
    expect(sessionMatchesView(noTask, 'queued')).toBe(false);
    expect(sessionMatchesView(noTask, 'attention')).toBe(true);
    expect(sessionMatchesView(sessions[2], 'attention')).toBe(true);
    expect(sessionMatchesView(archived, 'completed')).toBe(false);
    expect(groupSessionsByWorkspace(sessions, 'failed')[0].sessions[0].id).toBe('4');
    expect(groupSessionsByWorkspace(sessions, 'archived')[0].sessions[0].id).toBe('6');
    expect(groupSessionsByWorkspace(sessions, 'queued', summaries)[0].queuedCount).toBe(3);
    expect(groupSessionsByWorkspace(sessions, 'all').flatMap(group => group.sessions)).not.toContain(archived);
  });

  it('兼容 Unix 与 Windows 工作目录', () => {
    expect(workspaceName('/repo/dockmux/')).toBe('dockmux');
    expect(workspaceName('C:\\work\\dockmux\\')).toBe('dockmux');
  });

  it('默认按待处理、进行中、最近的优先级排列，过滤视图保持时间顺序', () => {
    const sessions = [
      session('done', '/repo', 'completed', '2026-08-29T05:00:00Z'),
      session('working', '/repo', 'thinking', '2026-08-29T02:00:00Z'),
      session('failed', '/repo', 'failed', '2026-08-29T01:00:00Z'),
      session('permission', '/repo', 'waiting_for_permission', '2026-08-29T03:00:00Z')
    ];
    expect(orderSessionsForWorkbench(sessions, 'all').map(item => item.id)).toEqual(['permission', 'failed', 'working', 'done']);
    expect(orderSessionsForWorkbench(sessions, 'failed').map(item => item.id)).toEqual(['failed']);
  });

  it('将更新时间格式化为可扫描的相对时间', () => {
    const now = Date.parse('2026-08-30T12:00:00Z');
    expect(formatRelativeTime('2026-08-30T11:58:00Z', now)).toBe('2 分钟前');
    expect(formatRelativeTime('2026-08-30T08:00:00Z', now)).toBe('4 小时前');
    expect(formatRelativeTime('invalid', now)).toBe('时间未知');
  });

  it('优先展示 Runtime 错误摘要，并隐藏凭据、归一化换行与截断超长文本', () => {
    const raw = `\u001b[31m连接本地进程失败\u001b[0m\nAuthorization: Bearer super-secret token=raw-token --api-key cli-secret dockmux_group_tools_token=runtime-secret ${'详情'.repeat(100)}`;
    const summary = sessionErrorSummary(raw)!;
    expect(summary).toContain('连接本地进程失败 Authorization: [已隐藏]');
    expect(summary).toContain('token=[已隐藏]');
    expect(summary).toContain('--api-key [已隐藏]');
    expect(summary).toContain('dockmux_group_tools_token=[已隐藏]');
    expect(summary).not.toMatch(/super-secret|raw-token|cli-secret|runtime-secret|\n|\u001b/);
    expect(Array.from(summary)).toHaveLength(140);
    expect(summary.endsWith('…')).toBe(true);
    expect(attentionReasonForSession({ ...session('idle-error', '/repo', 'idle', ''), error: raw })).toBe(`运行异常：${summary}；打开详情查看`);
  });
});
