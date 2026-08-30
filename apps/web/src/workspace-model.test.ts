import { describe, expect, it } from 'vitest';
import type { RunSummary, Session } from './api';
import { groupSessionsByWorkspace, sessionMatchesView, workbenchCounts, workspaceName } from './workspace-model';

const session = (id: string, cwd: string, state: string, updatedAt: string): Session => ({ id, cwd, state, updatedAt, createdAt: updatedAt, agentId: 'codex', runId: `run-${id}` });

describe('workspace model', () => {
  it('按 cwd 聚合并按最近活动排序', () => {
    const groups = groupSessionsByWorkspace([
      session('1', '/repo/alpha', 'idle', '2026-08-20T00:00:00Z'),
      session('2', '/repo/beta/', 'thinking', '2026-08-22T00:00:00Z'),
      session('3', '/repo/alpha/', 'failed', '2026-08-21T00:00:00Z')
    ]);
    expect(groups.map(group => group.name)).toEqual(['beta', 'alpha']);
    expect(groups[1].sessions.map(item => item.id)).toEqual(['3', '1']);
  });

  it('提供运行、排队、待处理、失败、完成和归档的互斥视图与计数', () => {
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
    expect(workbenchCounts(sessions, summaries)).toEqual({ all: 5, active: 1, queued: 3, attention: 1, failed: 1, completed: 1, archived: 1 });
    expect(sessionMatchesView(sessions[0], 'queued', summaries['1'])).toBe(true);
    expect(sessionMatchesView(sessions[1], 'queued', summaries['2'])).toBe(true);
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
});
