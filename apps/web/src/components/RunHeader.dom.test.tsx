import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Agent, Session, Task } from '../api';
import { RunHeader } from './RunHeader';

const agent: Agent = { id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'full-trust' };
const session: Session = { id: 's1', agentId: 'codex', state: 'thinking', cwd: '/repo/dockmux', permissionMode: 'full-trust', runId: 'run-abc1234', createdAt: '', updatedAt: '' };
const queued: Task = { id: 't1', sessionId: 's1', prompt: '补充测试', status: 'queued', createdAt: '', updatedAt: '' };

describe('RunHeader', () => {
  it('集中展示 workspace、运行状态、下一步与队列', () => {
    render(<RunHeader session={session} agent={agent} taskPrompt="优化飞书任务卡片" streamStatus="open" queuedTasks={[queued]} rawVisible={false} rawAvailable={false} restarting={false} onOpenSidebar={() => {}} onInterrupt={() => {}} onRestart={() => {}} onOpenPrompt={() => {}} onArchive={() => {}} onToggleRaw={() => {}}/>);
    expect(screen.getByText('dockmux')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '优化飞书任务卡片' })).toBeTruthy();
    expect(screen.getByText('思考中')).toBeTruthy();
    expect(screen.getByText(/可以排队补充要求/)).toBeTruthy();
    expect(screen.getByText('1 条待执行')).toBeTruthy();
    expect(screen.getByText('完全信任')).toBeTruthy();
    expect(screen.getByTitle('实时同步')).toBeTruthy();
  });

  it('运行控制保持可达', async () => {
    const user = userEvent.setup(); const onInterrupt = vi.fn(); const onArchive = vi.fn();
    render(<RunHeader session={session} agent={agent} streamStatus="open" queuedTasks={[]} rawVisible={false} rawAvailable={false} restarting={false} onOpenSidebar={() => {}} onInterrupt={onInterrupt} onRestart={() => {}} onOpenPrompt={() => {}} onArchive={onArchive} onToggleRaw={() => {}}/>);
    await user.click(screen.getByRole('button', { name: '中断当前任务' }));
    await user.click(screen.getByRole('button', { name: '归档任务运行' }));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: '原始日志' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('failed / stopped 运行可调用真实 restart 操作', async () => {
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
