import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MobileTabBar } from './MobileTabBar';

describe('MobileTabBar', () => {
  it('标出当前页面，点击切换一级页面', async () => {
    const onNavigate = vi.fn();
    render(<MobileTabBar current="tasks" onNavigate={onNavigate} onCreateTask={vi.fn()}/>);
    const nav = screen.getByRole('navigation', { name: '主要页面' });
    expect(within(nav).getAllByRole('button').map(button => button.textContent)).toEqual(['总览', '任务', '待办', '自动化']);
    expect(within(nav).getByRole('button', { name: '任务' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('button', { name: '总览' }).getAttribute('aria-current')).toBeNull();
    await userEvent.setup({ delay: null }).click(within(nav).getByRole('button', { name: '自动化' }));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('automation');
  });

  it('新建任务是导航外的独立按钮，检测 Agent 期间不可点', async () => {
    const onCreateTask = vi.fn();
    const view = render(<MobileTabBar current="home" onNavigate={vi.fn()} onCreateTask={onCreateTask}/>);
    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: '新建任务' }));
    expect(onCreateTask).toHaveBeenCalledOnce();
    expect(within(screen.getByRole('navigation', { name: '主要页面' })).queryByRole('button', { name: '新建任务' })).toBeNull();
    view.rerender(<MobileTabBar current="home" onNavigate={vi.fn()} onCreateTask={onCreateTask} createDisabled/>);
    expect((screen.getByRole('button', { name: '新建任务' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
