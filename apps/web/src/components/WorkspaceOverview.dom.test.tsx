import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Agent, Session } from '../api';
import { attentionReasonForSession, nextActionForState, workbenchViewLabels, workbenchViewOrder } from '../workspace-model';
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
    const filters = screen.getByRole('region', { name: '任务筛选' });
    // 筛选芯片就是 workbenchViewOrder 这一份常量，标签改文案不需要动这里。
    expect(workbenchViewOrder.map(view => within(filters).getByRole('button', { name: new RegExp(workbenchViewLabels[view]) }))).toHaveLength(5);
    expect(filters.textContent).toContain('总览5');
    // 失败并入「待你处理」：idle 的 3 与 failed 的 4，共 2 条。
    expect(filters.textContent).toContain('待你处理2');
    // 进行中同时含 thinking 的 1 与「created 但排了 1 条指令」的 2：
    // 排队中也算系统已承诺推进，芯片与分区用的是同一个判据（interaction-design §1）。
    expect(filters.textContent).toContain('进行中2');
    expect(filters.textContent).toContain('已完成1');
    expect(filters.textContent).toContain('已归档1');
    // 「有排队的任务」不再是可点击视图，待执行指令总数只作为说明性标签出现。
    expect(within(filters).queryByRole('button', { name: /有排队的运行|失败/ })).toBeNull();
    expect(filters.textContent).toContain('另有待执行指令 1 条');
    expect(screen.getByText('优化工作台')).toBeTruthy();
    expect(screen.getByText('1 个机器人已接入')).toBeTruthy();
  });

  it('创建、选择任务与打开飞书均保持可达', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(); const onSelect = vi.fn(); const onOpenLarkSetup = vi.fn(); const onViewChange = vi.fn();
    render(<WorkspaceOverview sessions={[session('1', '/repo/dockmux', 'idle')]} summaries={{ '1': { sessionId: '1', taskId: 't1', prompt: '优化工作台', status: 'queued', queuedCount: 1, updatedAt: '' } }} agents={agents} loading={false} larkBots={0} view="all" onViewChange={onViewChange} onSelect={onSelect} onCreate={onCreate} onOpenAgentSetup={() => {}} onOpenLarkSetup={onOpenLarkSetup}/>);
    await user.click(screen.getByRole('button', { name: /创建任务/ }));
    await user.click(screen.getByRole('button', { name: /优化工作台/ }));
    await user.click(screen.getByRole('button', { name: /已归档/ }));
    await user.click(screen.getByRole('button', { name: /绑定飞书 Bot/ }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('1');
    expect(onViewChange).toHaveBeenCalledWith('archived');
    expect(onOpenLarkSetup).toHaveBeenCalledTimes(1);
  });

  it('按已选状态过滤跨工作区任务，并让长任务目标保留完整 title', () => {
    const longGoal = '修复登录超时并补齐覆盖所有回归路径的端到端测试与性能验证';
    render(<WorkspaceOverview sessions={[session('1', '/repo/run', 'thinking'), session('2', '/repo/queue', 'failed')]} summaries={{ '1': { sessionId: '1', taskId: 't1', prompt: '运行中的任务', status: 'running', queuedCount: 0, updatedAt: '' }, '2': { sessionId: '2', taskId: 't2', prompt: longGoal, status: 'failed', queuedCount: 0, updatedAt: '' } }} agents={agents} loading={false} larkBots={0} view="attention" onViewChange={() => {}} onSelect={() => {}} onCreate={() => {}} onOpenAgentSetup={() => {}} onOpenLarkSetup={() => {}}/>);
    expect(screen.getByTitle(longGoal)).toBeTruthy();
    expect(screen.queryByText('运行中的任务')).toBeNull();
  });

  it('进行中的任务有后续排队指令时，任务行按指令数标注待执行', () => {
    render(<WorkspaceOverview sessions={[session('1', '/repo/run', 'thinking')]} summaries={{ '1': { sessionId: '1', taskId: 't1', prompt: '运行中且排了两条', status: 'running', queuedCount: 2, updatedAt: '' } }} agents={agents} loading={false} larkBots={0} view="active" onViewChange={() => {}} onSelect={() => {}} onCreate={() => {}} onOpenAgentSetup={() => {}} onOpenLarkSetup={() => {}}/>);
    expect(screen.getByRole('button', { name: /运行中且排了两条.*待执行指令 2 条/ })).toBeTruthy();
    expect(screen.getByRole('region', { name: '任务筛选' }).textContent).toContain('另有待执行指令 2 条');
  });

  it('默认将待处理与失败任务置顶，并给出可行动原因与更新时间', () => {
    const { container } = render(<WorkspaceOverview sessions={[session('5', '/repo/recent', 'completed'), session('4', '/repo/run', 'thinking'), session('3', '/repo/fail', 'failed'), session('2', '/repo/auth', 'waiting_for_permission')]} summaries={{}} agents={agents} loading={false} larkBots={0} view="all" onViewChange={() => {}} onSelect={() => {}} onCreate={() => {}} onOpenAgentSetup={() => {}} onOpenLarkSetup={() => {}}/>);
    expect(screen.getAllByRole('heading', { level: 2 }).map(node => node.textContent).slice(0, 3)).toEqual(['待你处理', '进行中', '已完成']);
    expect(screen.getByText(nextActionForState('waiting_for_permission'))).toBeTruthy();
    expect(screen.getByText(nextActionForState('failed'))).toBeTruthy();
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
    expect(screen.getByText('任务异常：连接本地进程失败 Authorization: [已隐藏]；打开详情查看')).toBeTruthy();
    expect(screen.getByText(attentionReasonForSession(failed))).toBeTruthy();
    expect(screen.queryByText(/should-not-render/)).toBeNull();
    expect(screen.queryByText(nextActionForState('idle'))).toBeNull();
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

  // 第三个分区的 key 是 workbenchTaskSection 的兜底分支 recent，但穷举 11 个状态 ×
  // queuedCount 有无后只有「completed 且无排队指令」会落进来，所以它就是筛选芯片
  // 「已完成」那一批，标题也必须写「已完成」——叫「最近」时用户按芯片名找不到分区。
  // 副标题说的「没有后续排队指令」不是废话：completed 排了指令就归「进行中」，
  // 这条用例把文案和实际归类绑在一起。
  it('第三个分区标题与「已完成」芯片同名，副标题说明它只装已交付且无排队指令的任务', () => {
    const sessions = [session('1', '/repo/done', 'completed'), session('2', '/repo/more', 'completed')];
    render(<WorkspaceOverview {...baseProps} sessions={sessions} summaries={{ '1': { sessionId: '1', taskId: 't1', prompt: '已交付', status: 'completed', queuedCount: 0, updatedAt: '' }, '2': { sessionId: '2', taskId: 't2', prompt: '交付后又排了一条', status: 'completed', queuedCount: 1, updatedAt: '' } }}/>);
    expect(screen.queryByRole('region', { name: '最近' })).toBeNull();
    const done = screen.getByRole('region', { name: '已完成' });
    expect(within(done).getByText('已交付且没有后续排队指令的任务')).toBeTruthy();
    // 分区 key 保持 recent：它是内部标识，taskSectionRank 与 data-task-priority 都用它。
    expect(done.querySelectorAll('[data-task-priority="recent"]')).toHaveLength(1);
    // 副标题的「没有后续排队指令」必须与归类一致：排了指令的那条不在这个分区里。
    expect(within(done).getByText('已交付')).toBeTruthy();
    expect(within(done).queryByText('交付后又排了一条')).toBeNull();
    expect(within(screen.getByRole('region', { name: '进行中' })).getByText('交付后又排了一条')).toBeTruthy();
  });

  // 任务行的状态徽标走 effectiveStatus(session).label，不再自己判 archivedAt。
  // 一条在 thinking 时被归档的任务，state 永远停在 'thinking'：徽标必须写「已归档」，
  // 否则会告诉用户它还在跑。删掉 effectiveStatus 的归档分支时这条要挂。
  it('归档 + thinking：任务行徽标写「已归档」，不谎报仍在思考', () => {
    const archived = { ...session('1', '/repo/archive', 'thinking'), archivedAt: '2026-08-30T00:00:00Z' };
    render(<WorkspaceOverview {...baseProps} sessions={[archived]} summaries={{ '1': { sessionId: '1', taskId: 't1', prompt: '归档时还在思考', status: 'running', queuedCount: 0, updatedAt: '' } }} view="archived"/>);
    const row = screen.getByRole('button', { name: /归档时还在思考/ });
    expect(row.textContent).toContain('已归档');
    expect(row.textContent).not.toContain('思考中');
  });

  it('数据就绪后仍然如实展示空状态', () => {
    render(<WorkspaceOverview {...baseProps} sessions={[]} agents={[]}/>);
    expect(screen.getByText('还没有任务。先准备 Agent，再创建第一个任务。')).toBeTruthy();
    expect(screen.getByText('尚未接入机器人')).toBeTruthy();
  });
});
