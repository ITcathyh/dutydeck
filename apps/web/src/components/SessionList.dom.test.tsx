import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../api';
import { SessionList, type SessionListProps } from './SessionList';

const baseProps: SessionListProps = { open: false, onClose: () => {}, sessions: [], summaries: {}, sessionsLoading: false, agents: [], larkBots: [], view: 'all', onViewChange: () => {}, onSelect: () => {}, onNewSession: () => {}, onOpenLarkSetup: () => {}, onOpenControlCenter: () => {} };
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

  it('所有任务状态都是可选视图，选择后回到工作台首页', async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn(); const onSelect = vi.fn();
    render(<SessionList {...baseProps} open onViewChange={onViewChange} onSelect={onSelect}/>);
    for (const label of ['总览', '待你处理', '进行中', '有排队的运行', '失败', '已完成', '已归档']) expect(screen.getByRole('button', { name: new RegExp(label) })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /已归档/ }));
    expect(onViewChange).toHaveBeenCalledWith('archived');
    expect(onSelect).toHaveBeenCalledWith(undefined);
  });

  it('归档视图只展示归档运行', () => {
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
