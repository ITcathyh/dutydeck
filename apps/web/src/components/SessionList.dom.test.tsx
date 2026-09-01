import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../api';
import { workbenchViewLabels, workbenchViewOrder } from '../workspace-model';
import { SessionList, type SessionListProps } from './SessionList';

const baseProps: SessionListProps = { open: false, onClose: () => {}, sessions: [], summaries: {}, sessionsLoading: false, agents: [], larkBots: [], view: 'all', onSelect: () => {}, onNewSession: () => {}, onOpenControlCenter: () => {} };
const originalMatchMedia = window.matchMedia;

afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: originalMatchMedia }); });

describe('SessionList mobile accessibility', () => {
  it('移动侧栏关闭时 inert 且从可访问树隐藏，打开后恢复', () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: matchMedia });
    const { container, rerender } = render(<SessionList {...baseProps}/>);
    const aside = container.querySelector('aside')!;
    expect(aside.hasAttribute('inert')).toBe(true);
    expect(aside.getAttribute('aria-hidden')).toBe('true');
    rerender(<SessionList {...baseProps} open/>);
    expect(aside.hasAttribute('inert')).toBe(false);
    expect(aside.hasAttribute('aria-hidden')).toBe(false);
  });

  /**
   * 侧栏只回答「按目录找任务」，状态筛选是总览页的职责。
   *
   * 侧栏在桌面端恒常可见（md:static），此前它自带一份 7 项状态导航，
   * 于是同一屏上必然出现两份筛选，且两份的口径还各自漂移。
   * 这条用例守的是「状态筛选在侧栏里不存在」，防止它再长回来。
   */
  it('侧栏只做工作区导航，不再重复渲染状态筛选', () => {
    const makeSession = (id: string, state: string): Session => ({ id, agentId: 'codex', state, cwd: `/repo/${id}`, runId: `run-${id}`, createdAt: '', updatedAt: '' });
    render(<SessionList {...baseProps} open sessions={[makeSession('alpha', 'failed'), makeSession('beta', 'thinking')]}/>);
    expect(screen.queryByRole('navigation', { name: '任务视图' })).toBeNull();
    for (const label of [...workbenchViewOrder.map(view => workbenchViewLabels[view]), '有排队的运行', '失败']) {
      expect(screen.queryByRole('button', { name: new RegExp(`^${label}`) })).toBeNull();
    }
    // 「绑定 Bot」也从侧栏移除：飞书入口只在总览页与设置里各留一处。
    expect(screen.queryByRole('button', { name: /绑定 Bot/ })).toBeNull();
    // 工作区分组仍然列任务，这是侧栏保留的那条检索路径。
    expect(screen.getByText('工作区')).toBeTruthy();
    for (const name of ['alpha', 'beta']) expect(screen.getByText(name)).toBeTruthy();
  });

  it('创建任务按钮在 Agent 未就绪时不谎报，加载完成后才给出真实去向', async () => {
    const user = userEvent.setup();
    const onNewSession = vi.fn(); const onOpenControlCenter = vi.fn();
    const { rerender } = render(<SessionList {...baseProps} open agentsLoading onNewSession={onNewSession} onOpenControlCenter={onOpenControlCenter}/>);
    const detecting = screen.getByRole('button', { name: '正在检测 Agent…' });
    expect(detecting.hasAttribute('disabled')).toBe(true);

    // 加载完仍然没有 Agent：按钮如实改口，去向是「准备 Agent」而不是创建任务。
    rerender(<SessionList {...baseProps} open agents={[]} onNewSession={onNewSession} onOpenControlCenter={onOpenControlCenter}/>);
    await user.click(screen.getByRole('button', { name: '准备 Agent' }));
    expect(onOpenControlCenter).toHaveBeenCalledTimes(1);
    expect(onNewSession).not.toHaveBeenCalled();

    rerender(<SessionList {...baseProps} open agents={[{ id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'full-trust' }]} onNewSession={onNewSession} onOpenControlCenter={onOpenControlCenter}/>);
    await user.click(screen.getByRole('button', { name: '创建任务' }));
    expect(onNewSession).toHaveBeenCalledTimes(1);
  });

  it('归档视图只展示已归档任务', () => {
    const makeSession = (id: string, archivedAt?: string): Session => ({ id, agentId: 'codex', state: 'completed', cwd: `/repo/${id}`, runId: `run-${id}`, createdAt: '', updatedAt: '', ...(archivedAt ? { archivedAt } : {}) });
    render(<SessionList {...baseProps} open view="archived" sessions={[makeSession('current'), makeSession('history', '2026-08-30T00:00:00Z')]}/>);
    expect(screen.getByText('history')).toBeTruthy();
    expect(screen.queryByText('current')).toBeNull();
  });

  it('以设置与接入承载低频配置，并明确受信开发机模式', async () => {
    const onOpenControlCenter = vi.fn();
    render(<SessionList {...baseProps} open authRequired={false} onOpenControlCenter={onOpenControlCenter}/>);
    await userEvent.click(screen.getByRole('button', { name: /Agent 与设置/ }));
    expect(onOpenControlCenter).toHaveBeenCalledOnce();
    expect(screen.getByText(/受信开发机模式 · 无需 token/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /开启监听/ })).toBeNull();
  });
});
