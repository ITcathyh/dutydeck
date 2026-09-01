import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Agent, Session, Task } from '../api';
import { nextActionForState } from '../workspace-model';
import { RunHeader } from './RunHeader';
import { permissionLabels } from './ui';

const agent: Agent = { id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'full-trust' };
const session: Session = { id: 's1', agentId: 'codex', state: 'thinking', cwd: '/repo/dockmux', permissionMode: 'full-trust', runId: 'run-abc1234', createdAt: '', updatedAt: '' };
const queued: Task = { id: 't1', sessionId: 's1', prompt: '补充测试', status: 'queued', createdAt: '', updatedAt: '' };

describe('RunHeader', () => {
  it('集中展示 workspace、任务状态、下一步与队列', () => {
    render(<RunHeader session={session} agent={agent} taskPrompt="优化飞书任务卡片" streamStatus="open" queuedTasks={[queued]} rawVisible={false} rawAvailable={false} restarting={false} onOpenSidebar={() => {}} onInterrupt={() => {}} onRestart={() => {}} onOpenPrompt={() => {}} onArchive={() => {}} onToggleRaw={() => {}}/>);
    expect(screen.getByText('dockmux')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '优化飞书任务卡片' })).toBeTruthy();
    expect(screen.getByText('思考中')).toBeTruthy();
    expect(screen.getByText(nextActionForState('thinking'))).toBeTruthy();
    // 排队徽标统一为「待执行指令 N 条」，与总览页任务行同一措辞。
    expect(screen.getByText('待执行指令 1 条')).toBeTruthy();
    expect(screen.getByText(permissionLabels['full-trust'])).toBeTruthy();
    expect(screen.getByTitle('本任务的权限姿态')).toBeTruthy();
    expect(screen.getByTitle('实时同步')).toBeTruthy();
  });

  it('任务控制保持可达', async () => {
    const user = userEvent.setup(); const onInterrupt = vi.fn(); const onArchive = vi.fn();
    render(<RunHeader session={session} agent={agent} streamStatus="open" queuedTasks={[]} rawVisible={false} rawAvailable={false} restarting={false} onOpenSidebar={() => {}} onInterrupt={onInterrupt} onRestart={() => {}} onOpenPrompt={() => {}} onArchive={onArchive} onToggleRaw={() => {}}/>);
    await user.click(screen.getByRole('button', { name: '中断当前任务' }));
    await user.click(screen.getByRole('button', { name: '归档任务' }));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: '原始日志' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('failed / stopped 任务可调用真实 restart 操作', async () => {
    const user = userEvent.setup(); const onRestart = vi.fn();
    render(<RunHeader session={{ ...session, state: 'failed' }} agent={agent} streamStatus="open" queuedTasks={[]} rawVisible={false} rawAvailable={false} restarting={false} onOpenSidebar={() => {}} onInterrupt={() => {}} onRestart={onRestart} onOpenPrompt={() => {}} onArchive={() => {}} onToggleRaw={() => {}}/>);
    await user.click(screen.getByRole('button', { name: '重新启动' }));
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('长任务目标视觉截断但为辅助技术和悬停保留完整文本', () => {
    const goal = '大规模优化并重构整个项目，使用户可以从飞书高效指挥任务并完成端到端验收';
    render(<RunHeader session={session} agent={agent} taskPrompt={`  ${goal}  `} streamStatus="open" queuedTasks={[]} rawVisible={false} rawAvailable={false} restarting={false} onOpenSidebar={() => {}} onInterrupt={() => {}} onRestart={() => {}} onOpenPrompt={() => {}} onArchive={() => {}} onToggleRaw={() => {}}/>);
    const heading = screen.getByRole('heading', { name: goal });
    expect(heading.className).toContain('truncate');
    expect(heading.getAttribute('title')).toBe(goal);
  });
});

// 详情页顶部状态条曾四处直接读 session.state：归档的 thinking 任务写着「思考中」、
// 圆点一直呼吸、下一步提示还在说「Agent 正在推进」，而 recoverable 漏判 archivedAt
// 让一条已归档的失败任务显示出可点击的「重新启动」——那是功能缺陷，不只是显示错误。
// 这组用例守的是「状态文案、呼吸动画、可恢复性出自同一个判断」，见 ui.tsx:effectiveStatus。
describe('RunHeader 归档态状态视觉与只读约束', () => {
  const archivedAt = '2026-08-30T00:00:00.000Z';
  function renderHeader(overrides: Partial<Session>, restarting = false) {
    const { container } = render(<RunHeader session={{ ...session, ...overrides }} agent={agent} taskPrompt="优化飞书任务卡片" streamStatus="open" queuedTasks={[]} rawVisible={false} rawAvailable={false} restarting={restarting} onOpenSidebar={() => {}} onInterrupt={() => {}} onRestart={() => {}} onOpenPrompt={() => {}} onArchive={() => {}} onToggleRaw={() => {}}/>);
    // 状态条的圆点是唯一带 aria-label 的 span，文案在它右边的 <strong> 里。
    return { dot: container.querySelector('span[aria-label]')!, statusText: container.querySelector('strong')! };
  }

  it('归档 + thinking：状态写「已归档」，圆点不再呼吸', () => {
    const { dot, statusText } = renderHeader({ state: 'thinking', archivedAt });
    expect(statusText.textContent).toBe('已归档');
    expect(dot.getAttribute('aria-label')).toBe('已归档');
    expect(dot.className).not.toContain('ui-status-pulse');
    expect(dot.className).not.toContain('--status-warning-solid');
    expect(dot.className).toContain('bg-[var(--status-neutral-solid)]');
    expect(screen.queryByText('思考中')).toBeNull();
  });

  it('归档 + failed：不再给出「重新启动」按钮，归档是只读终态', () => {
    const { statusText } = renderHeader({ state: 'failed', archivedAt });
    expect(statusText.textContent).toBe('已归档');
    expect(screen.queryByRole('button', { name: '重新启动' })).toBeNull();
    // 中断与归档按钮同属写操作，归档后也不该出现。
    expect(screen.queryByRole('button', { name: '中断当前任务' })).toBeNull();
    expect(screen.queryByRole('button', { name: '归档任务' })).toBeNull();
  });

  it('归档任务的下一步提示说明只读，不再谎报 Agent 在推进', () => {
    renderHeader({ state: 'thinking', archivedAt });
    expect(screen.queryByText(nextActionForState('thinking'))).toBeNull();
    expect(screen.getByText('已归档任务只读；可查看历史记录，不能再下指令')).toBeTruthy();
  });

  it('未归档 + failed：「重新启动」按钮照旧在，别把正常恢复路径改没了', async () => {
    const user = userEvent.setup(); const onRestart = vi.fn();
    render(<RunHeader session={{ ...session, state: 'failed' }} agent={agent} streamStatus="open" queuedTasks={[]} rawVisible={false} rawAvailable={false} restarting={false} onOpenSidebar={() => {}} onInterrupt={() => {}} onRestart={onRestart} onOpenPrompt={() => {}} onArchive={() => {}} onToggleRaw={() => {}}/>);
    await user.click(screen.getByRole('button', { name: '重新启动' }));
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(screen.getByText('失败')).toBeTruthy();
    expect(screen.getByText(nextActionForState('failed'))).toBeTruthy();
  });

  it('未归档 + thinking：圆点仍呼吸，状态仍写「思考中」', () => {
    const { dot, statusText } = renderHeader({ state: 'thinking' });
    expect(statusText.textContent).toBe('思考中');
    expect(dot.getAttribute('aria-label')).toBe('思考中');
    expect(dot.className).toContain('ui-status-pulse');
    expect(dot.className).toContain('bg-[var(--status-warning-solid)]');
    expect(screen.getByText(nextActionForState('thinking'))).toBeTruthy();
  });
});
