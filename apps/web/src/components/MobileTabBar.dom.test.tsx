import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MobileTabBar } from './MobileTabBar';
import { TopBar } from './TopBar';

describe('MobileTabBar', () => {
  it('手机底部 4 个同级目的地：总览、任务、待办、更多', async () => {
    const onNavigate = vi.fn();
    render(<MobileTabBar current="tasks" onNavigate={onNavigate} inboxCount={3}/>);
    const nav = screen.getByRole('navigation', { name: '主要页面' });
    expect(within(nav).getAllByRole('button').map(button => button.textContent)).toEqual(['总览', '任务', '3待办', '更多']);
    expect(within(nav).getByRole('button', { name: '任务' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('button', { name: '总览' }).getAttribute('aria-current')).toBeNull();
    await userEvent.setup({ delay: null }).click(within(nav).getByRole('button', { name: '更多' }));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('more');
  });

  it('处于自动化或管理页面时，激活项对应在「更多」', async () => {
    const onNavigate = vi.fn();
    const { rerender } = render(<MobileTabBar current="automation" onNavigate={onNavigate}/>);
    const nav = screen.getByRole('navigation', { name: '主要页面' });
    expect(within(nav).getByRole('button', { name: '更多' }).getAttribute('aria-current')).toBe('page');

    rerender(<MobileTabBar current="bots" onNavigate={onNavigate}/>);
    expect(within(nav).getByRole('button', { name: '更多' }).getAttribute('aria-current')).toBe('page');
  });

  it('新建任务是导航外的独立按钮，检测 Agent 期间不可点', async () => {
    const onCreateTask = vi.fn();
    const user = userEvent.setup({ delay: null });

    // 1. 底栏导航里没有新建按钮（符合 HIG Tab 只承担同级目的地）
    render(<MobileTabBar current="home" onNavigate={vi.fn()}/>);
    const nav = screen.getByRole('navigation', { name: '主要页面' });
    expect(within(nav).queryByRole('button', { name: '新建任务' })).toBeNull();

    // 2. 顶栏按钮可点触发新建
    const topBarView = render(<TopBar onOpenNavigation={vi.fn()} onGoHome={vi.fn()} onOpenSearch={vi.fn()} onOpenShortcuts={vi.fn()} themePreference="system" themeResolved="light" onThemeChange={vi.fn()} showCreateTask onCreateTask={onCreateTask} createTaskDisabled={false}/>);
    const topBarCreateBtn = topBarView.getByRole('button', { name: '新建任务' });
    expect(topBarCreateBtn).toBeTruthy();
    await user.click(topBarCreateBtn);
    expect(onCreateTask).toHaveBeenCalledOnce();

    // 3. 检测 Agent 期间 disabled
    topBarView.rerender(<TopBar onOpenNavigation={vi.fn()} onGoHome={vi.fn()} onOpenSearch={vi.fn()} onOpenShortcuts={vi.fn()} themePreference="system" themeResolved="light" onThemeChange={vi.fn()} showCreateTask onCreateTask={onCreateTask} createTaskDisabled={true}/>);
    expect((topBarView.getByRole('button', { name: '新建任务' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
