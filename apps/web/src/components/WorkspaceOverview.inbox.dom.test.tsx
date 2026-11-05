import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Agent, InboxItem, Session } from '../api';
import { WorkspaceOverview, type WorkspaceInbox } from './WorkspaceOverview';

const agents: Agent[] = [{ id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'full-trust' }];
const session = (id: string, cwd: string, state: string, extra: Partial<Session> = {}): Session => ({ id, cwd, state, agentId: 'codex', runId: `run-${id}`, createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z', ...extra });
const item = (id: string, kind: InboxItem['kind'], sessionId: string, title: string): InboxItem => ({ id, kind, sessionId, sessionTitle: '会话', workspace: 'repo', title, createdAt: '2026-11-05T00:00:00Z', waitingMs: 60_000, actions: [{ id: 'open', label: '查看', type: 'open' }] });
const props = { sessions: [session('1', '/repo/waiting', 'waiting_for_permission'), session('2', '/repo/failed', 'failed')], summaries: {}, agents, loading: false, larkBots: [], view: 'all' as const, onViewChange: () => {}, onSelect: () => {}, onCreate: () => {}, onOpenAgentSetup: () => {}, onOpenLarkSetup: () => {} };
const inbox = (items: InboxItem[], extra: Partial<WorkspaceInbox> = {}): WorkspaceInbox => ({ items, loading: false, failed: false, call: vi.fn(async () => ({})), ...extra });

describe('WorkspaceOverview 待你决定', () => {
  it('首页在任务列表上方列出汇总；权限已逐条列出的会话不再在「需要你处理」里重复，需要恢复的会话照常保留', () => {
    render(<WorkspaceOverview mode="home" {...props} inbox={inbox([item('permission:1:p', 'permission', '1', '运行 build 脚本'), item('plan:3:t', 'plan', '3', '整理依赖')])}/>);
    const panel = screen.getByRole('region', { name: '待你决定' });
    expect(panel.textContent).toContain('运行 build 脚本');
    expect(panel.textContent).toContain('整理依赖');
    const list = screen.getByRole('region', { name: '任务列表' });
    expect(list.textContent).not.toContain('waiting');
    expect(list.textContent).toContain('failed');
  });

  it('汇总读取失败时不隐藏任何会话，并显示重试', async () => {
    const onRetry = vi.fn();
    render(<WorkspaceOverview mode="home" {...props} inbox={inbox([], { failed: true, onRetry })}/>);
    expect(screen.getByText('无法读取待处理汇总')).toBeTruthy();
    expect(screen.getByRole('region', { name: '任务列表' }).textContent).toContain('waiting');
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('只有「任务」页（非首页）不显示汇总；条目的「查看」走进入会话的回调', async () => {
    const onSelectAttention = vi.fn();
    const { rerender } = render(<WorkspaceOverview mode="home" {...props} onSelectAttention={onSelectAttention} inbox={inbox([item('plan:3:t', 'plan', '3', '整理依赖')])}/>);
    await userEvent.click(screen.getByRole('button', { name: '查看' }));
    expect(onSelectAttention).toHaveBeenCalledWith('3');
    rerender(<WorkspaceOverview mode="tasks" {...props} inbox={inbox([item('plan:3:t', 'plan', '3', '整理依赖')])}/>);
    expect(screen.queryByRole('region', { name: '待你决定' })).toBeNull();
  });
});
