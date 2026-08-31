import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Agent, Session } from '../api';
import { WorkspaceOverview } from './WorkspaceOverview';

const agents: Agent[] = [{ id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'full-trust' }];
const session = (id: string, cwd: string, state: string): Session => ({ id, cwd, state, agentId: 'codex', runId: `run-${id}`, createdAt: `2026-08-2${id}T00:00:00Z`, updatedAt: `2026-08-2${id}T00:00:00Z` });
const baseProps = { sessions: [], summaries: {}, agents, loading: false, larkBots: 0, view: 'all' as const, onViewChange: () => {}, onSelect: () => {}, onCreate: () => {}, onOpenAgentSetup: () => {}, onOpenLarkSetup: () => {} };

describe('WorkspaceOverview', () => {
  it('does not claim work is in progress when both tasks and Agents are empty', () => {
    render(<WorkspaceOverview {...baseProps} sessions={[]} agents={[]}/>);
    expect(screen.getByText('还没有任务。先准备 Agent，再创建第一个任务。')).toBeTruthy();
    expect(document.body.textContent).not.toContain('继续跟进进行中的任务');
  });

  it('展示现有 Session 数据的工作区与状态投影', () => {
    const archived = { ...session('6', '/repo/archive', 'completed'), archivedAt: '2026-08-30T00:00:00Z' };
    render(<WorkspaceOverview sessions={[session('1', '/repo/dockmux', 'thinking'), session('2', '/repo/dockmux', 'created'), session('3', '/repo/api', 'idle'), session('4', '/repo/api', 'failed'), session('5', '/repo/web', 'completed'), archived]} summaries={{ '1': { sessionId: '1', taskId: 't1', prompt: '优化工作台', status: 'running', queuedCount: 0, updatedAt: '' }, '2': { sessionId: '2', taskId: 't2', prompt: '等待调度', status: 'queued', queuedCount: 1, updatedAt: '' } }} agents={agents} loading={false} larkBots={1} view="all" onViewChange={() => {}} onSelect={() => {}} onCreate={() => {}} onOpenAgentSetup={() => {}} onOpenLarkSetup={() => {}}/>);
    const overview = screen.getByRole('region', { name: '运行概览' });
    expect(overview.textContent).toContain('进行中1');
    expect(overview.textContent).toContain('有排队的运行1待执行 1 条');
    expect(overview.textContent).toContain('待你处理1');
    expect(overview.textContent).toContain('失败1');
    expect(overview.textContent).toContain('已完成1');
    expect(overview.textContent).toContain('已归档1');
    expect(screen.getByText('优化工作台')).toBeTruthy();
    expect(screen.getByText('1 个机器人已接入')).toBeTruthy();
  });

  it('创建、选择运行与打开飞书均保持可达', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(); const onSelect = vi.fn(); const onOpenLarkSetup = vi.fn(); const onViewChange = vi.fn();
    render(<WorkspaceOverview sessions={[session('1', '/repo/dockmux', 'idle')]} summaries={{ '1': { sessionId: '1', taskId: 't1', prompt: '优化工作台', status: 'queued', queuedCount: 1, updatedAt: '' } }} agents={agents} loading={false} larkBots={0} view="all" onViewChange={onViewChange} onSelect={onSelect} onCreate={onCreate} onOpenAgentSetup={() => {}} onOpenLarkSetup={onOpenLarkSetup}/>);
    await user.click(screen.getByRole('button', { name: /创建任务/ }));
    await user.click(screen.getByRole('button', { name: /优化工作台/ }));
    await user.click(screen.getByRole('button', { name: /有排队的运行/ }));
    await user.click(screen.getByRole('button', { name: /绑定飞书 Bot/ }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('1');
    expect(onViewChange).toHaveBeenCalledWith('queued');
    expect(onOpenLarkSetup).toHaveBeenCalledTimes(1);
  });

  it('按已选状态过滤跨工作区运行，并让长任务目标保留完整 title', () => {
    const longGoal = '修复登录超时并补齐覆盖所有回归路径的端到端测试与性能验证';
    render(<WorkspaceOverview sessions={[session('1', '/repo/run', 'thinking'), session('2', '/repo/queue', 'created')]} summaries={{ '1': { sessionId: '1', taskId: 't1', prompt: '运行中的任务', status: 'running', queuedCount: 0, updatedAt: '' }, '2': { sessionId: '2', taskId: 't2', prompt: longGoal, status: 'queued', queuedCount: 1, updatedAt: '' } }} agents={agents} loading={false} larkBots={0} view="queued" onViewChange={() => {}} onSelect={() => {}} onCreate={() => {}} onOpenAgentSetup={() => {}} onOpenLarkSetup={() => {}}/>);
    expect(screen.getByTitle(longGoal)).toBeTruthy();
    expect(screen.queryByText('运行中的任务')).toBeNull();
  });

  it('运行中的 Session 有后续排队任务时，同时进入排队视图并按任务数计数', () => {
    render(<WorkspaceOverview sessions={[session('1', '/repo/run', 'thinking')]} summaries={{ '1': { sessionId: '1', taskId: 't1', prompt: '运行中且排了两条', status: 'running', queuedCount: 2, updatedAt: '' } }} agents={agents} loading={false} larkBots={0} view="queued" onViewChange={() => {}} onSelect={() => {}} onCreate={() => {}} onOpenAgentSetup={() => {}} onOpenLarkSetup={() => {}}/>);
    expect(screen.getByRole('button', { name: /有排队的运行 1 待执行 2 条/ })).toBeTruthy();
    expect(screen.getByText('运行中且排了两条')).toBeTruthy();
  });

  it('默认将待处理与失败任务置顶，并给出可行动原因与更新时间', () => {
    const { container } = render(<WorkspaceOverview sessions={[session('5', '/repo/recent', 'completed'), session('4', '/repo/run', 'thinking'), session('3', '/repo/fail', 'failed'), session('2', '/repo/auth', 'waiting_for_permission')]} summaries={{}} agents={agents} loading={false} larkBots={0} view="all" onViewChange={() => {}} onSelect={() => {}} onCreate={() => {}} onOpenAgentSetup={() => {}} onOpenLarkSetup={() => {}}/>);
    expect(screen.getAllByRole('heading', { level: 2 }).map(node => node.textContent).slice(0, 3)).toEqual(['待你处理', '进行中', '最近']);
    expect(screen.getByText('需要你授权 Agent 执行下一步操作')).toBeTruthy();
    expect(screen.getByText('查看失败详情，修正后重新运行')).toBeTruthy();
    expect(container.querySelectorAll('[data-task-priority="attention"]')).toHaveLength(2);
    expect(container.querySelector('[data-task-priority="attention"]')?.textContent).toContain('更新于');
    expect(screen.getByRole('button', { name: /等待授权.*需要你授权/ })).toBeTruthy();
  });

  it('过滤视图展示全部匹配任务，不截断最近六条', () => {
    const sessions = Array.from({ length: 8 }, (_, index) => session(String(index + 1), `/repo/${index + 1}`, 'thinking'));
    render(<WorkspaceOverview sessions={sessions} summaries={Object.fromEntries(sessions.map(item => [item.id, { sessionId: item.id, taskId: `t${item.id}`, prompt: `任务 ${item.id}`, status: 'running', queuedCount: 0, updatedAt: item.updatedAt }]))} agents={agents} loading={false} larkBots={0} view="active" onViewChange={() => {}} onSelect={() => {}} onCreate={() => {}} onOpenAgentSetup={() => {}} onOpenLarkSetup={() => {}}/>);
    for (const item of sessions) expect(screen.getByText(`任务 ${item.id}`)).toBeTruthy();
    expect(screen.getByRole('region', { name: '任务列表' }).querySelectorAll('[data-task-priority]')).toHaveLength(8);
  });

  it('主操作与状态筛选提供至少 40px 触控目标', () => {
    render(<WorkspaceOverview sessions={[]} summaries={{}} agents={agents} loading={false} larkBots={0} view="all" onViewChange={() => {}} onSelect={() => {}} onCreate={() => {}} onOpenAgentSetup={() => {}} onOpenLarkSetup={() => {}}/>);
    expect(screen.getByRole('button', { name: '创建任务' }).className).toContain('min-h-10');
    expect(screen.getByRole('button', { name: /总览 0/ }).className).toContain('min-h-10');
  });

  it('待处理任务优先展示经脱敏的 Runtime 错误摘要', () => {
    const failed = { ...session('1', '/repo/error', 'idle'), error: '连接本地进程失败\nAuthorization: Bearer should-not-render' };
    render(<WorkspaceOverview sessions={[failed]} summaries={{}} agents={agents} loading={false} larkBots={0} view="all" onViewChange={() => {}} onSelect={() => {}} onCreate={() => {}} onOpenAgentSetup={() => {}} onOpenLarkSetup={() => {}}/>);
    expect(screen.getByText('运行异常：连接本地进程失败 Authorization: [已隐藏]；打开详情查看')).toBeTruthy();
    expect(screen.queryByText(/should-not-render/)).toBeNull();
    expect(screen.queryByText('Agent 正在等你的下一条指令')).toBeNull();
  });

  it('在 App 的主内容内使用有名区域，不再嵌套 main landmark', () => {
    const { container } = render(<WorkspaceOverview sessions={[]} summaries={{}} agents={agents} loading={false} larkBots={0} view="all" onViewChange={() => {}} onSelect={() => {}} onCreate={() => {}} onOpenAgentSetup={() => {}} onOpenLarkSetup={() => {}}/>);
    expect(container.querySelector('main')).toBeNull();
    expect(screen.getByRole('region', { name: '今天需要推进什么？' })).toBeTruthy();
  });

  it('Agent 尚未加载完时不谎报「先准备 Agent」，改为说明正在检测', () => {
    render(<WorkspaceOverview {...baseProps} sessions={[]} agents={[]} agentsLoading/>);
    expect(screen.getByText('正在同步任务状态…')).toBeTruthy();
    expect(screen.queryByText('还没有任务。先准备 Agent，再创建第一个任务。')).toBeNull();
    const cta = screen.getByRole('button', { name: '正在检测 Agent…' });
    expect(cta.hasAttribute('disabled')).toBe(true);
  });

  it('Agent 加载中时任务列表展示骨架，而不是先闪一次空状态', () => {
    const { container } = render(<WorkspaceOverview {...baseProps} sessions={[]} agents={[]} agentsLoading/>);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    expect(screen.queryByText('先准备一个可用 Agent')).toBeNull();
  });

  it('飞书接入状态未就绪时不谎报「尚未接入机器人」', () => {
    render(<WorkspaceOverview {...baseProps} sessions={[]} larkBots={0} larkBotsLoading/>);
    expect(screen.getByText('正在读取接入状态…')).toBeTruthy();
    expect(screen.queryByText('尚未接入机器人')).toBeNull();
  });

  it('数据就绪后仍然如实展示空状态', () => {
    render(<WorkspaceOverview {...baseProps} sessions={[]} agents={[]}/>);
    expect(screen.getByText('还没有任务。先准备 Agent，再创建第一个任务。')).toBeTruthy();
    expect(screen.getByText('尚未接入机器人')).toBeTruthy();
  });
});
