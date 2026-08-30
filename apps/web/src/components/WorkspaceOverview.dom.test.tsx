import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Agent, Session } from '../api';
import { WorkspaceOverview } from './WorkspaceOverview';

const agents: Agent[] = [{ id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'full-trust' }];
const session = (id: string, cwd: string, state: string): Session => ({ id, cwd, state, agentId: 'codex', runId: `run-${id}`, createdAt: `2026-08-2${id}T00:00:00Z`, updatedAt: `2026-08-2${id}T00:00:00Z` });

describe('WorkspaceOverview', () => {
  it('展示现有 Session 数据的工作区与状态投影', () => {
    const archived = { ...session('6', '/repo/archive', 'completed'), archivedAt: '2026-08-30T00:00:00Z' };
    render(<WorkspaceOverview sessions={[session('1', '/repo/dockmux', 'thinking'), session('2', '/repo/dockmux', 'created'), session('3', '/repo/api', 'idle'), session('4', '/repo/api', 'failed'), session('5', '/repo/web', 'completed'), archived]} summaries={{ '1': { sessionId: '1', taskId: 't1', prompt: '优化工作台', status: 'running', queuedCount: 0, updatedAt: '' }, '2': { sessionId: '2', taskId: 't2', prompt: '等待调度', status: 'queued', queuedCount: 1, updatedAt: '' } }} agents={agents} loading={false} larkBots={1} view="all" onViewChange={() => {}} onSelect={() => {}} onCreate={() => {}} onOpenLark={() => {}}/>);
    const overview = screen.getByRole('region', { name: '运行概览' });
    expect(overview.textContent).toContain('正在推进1');
    expect(overview.textContent).toContain('排队等待1');
    expect(overview.textContent).toContain('等待处理1');
    expect(overview.textContent).toContain('需要恢复1');
    expect(overview.textContent).toContain('已经完成1');
    expect(overview.textContent).toContain('已经归档1');
    expect(screen.getByText('优化工作台')).toBeTruthy();
    expect(screen.getByText('1 个机器人已接入。随时从飞书下达任务、跟进执行。')).toBeTruthy();
  });

  it('创建、选择运行与打开飞书均保持可达', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(); const onSelect = vi.fn(); const onOpenLark = vi.fn(); const onViewChange = vi.fn();
    render(<WorkspaceOverview sessions={[session('1', '/repo/dockmux', 'idle')]} summaries={{ '1': { sessionId: '1', taskId: 't1', prompt: '优化工作台', status: 'queued', queuedCount: 1, updatedAt: '' } }} agents={agents} loading={false} larkBots={0} view="all" onViewChange={onViewChange} onSelect={onSelect} onCreate={onCreate} onOpenLark={onOpenLark}/>);
    await user.click(screen.getByRole('button', { name: /创建任务/ }));
    await user.click(screen.getByRole('button', { name: /dockmux/ }));
    await user.click(screen.getByRole('button', { name: /排队等待/ }));
    await user.click(screen.getByRole('button', { name: /飞书指挥台/ }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('1');
    expect(onViewChange).toHaveBeenCalledWith('queued');
    expect(onOpenLark).toHaveBeenCalledTimes(1);
  });

  it('按已选状态过滤跨工作区运行，并让长任务目标保留完整 title', () => {
    const longGoal = '修复登录超时并补齐覆盖所有回归路径的端到端测试与性能验证';
    render(<WorkspaceOverview sessions={[session('1', '/repo/run', 'thinking'), session('2', '/repo/queue', 'created')]} summaries={{ '1': { sessionId: '1', taskId: 't1', prompt: '运行中的任务', status: 'running', queuedCount: 0, updatedAt: '' }, '2': { sessionId: '2', taskId: 't2', prompt: longGoal, status: 'queued', queuedCount: 1, updatedAt: '' } }} agents={agents} loading={false} larkBots={0} view="queued" onViewChange={() => {}} onSelect={() => {}} onCreate={() => {}} onOpenLark={() => {}}/>);
    expect(screen.getByTitle(longGoal)).toBeTruthy();
    expect(screen.queryByText('运行中的任务')).toBeNull();
  });

  it('运行中的 Session 有后续排队任务时，同时进入排队视图并按任务数计数', () => {
    render(<WorkspaceOverview sessions={[session('1', '/repo/run', 'thinking')]} summaries={{ '1': { sessionId: '1', taskId: 't1', prompt: '运行中且排了两条', status: 'running', queuedCount: 2, updatedAt: '' } }} agents={agents} loading={false} larkBots={0} view="queued" onViewChange={() => {}} onSelect={() => {}} onCreate={() => {}} onOpenLark={() => {}}/>);
    expect(screen.getByRole('button', { name: /排队等待 2/ })).toBeTruthy();
    expect(screen.getByText('运行中且排了两条')).toBeTruthy();
  });
});
