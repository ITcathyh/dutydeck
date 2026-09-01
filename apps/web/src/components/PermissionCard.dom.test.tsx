import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TimelineEvent } from '../timeline';
import { PermissionCard } from './PermissionCard';

const permission = (status: string): TimelineEvent => ({ id: 'event-1', sequence: 1, type: 'permission_request', timestamp: '', data: { id: 'permission-1', title: '写入配置文件', status } });

describe('PermissionCard', () => {
  it('pending 审批可允许或拒绝', async () => {
    const user = userEvent.setup(); const onResolve = vi.fn();
    render(<PermissionCard event={permission('pending')} onResolve={onResolve}/>);
    await user.click(screen.getByRole('button', { name: '允许' }));
    await user.click(screen.getByRole('button', { name: '拒绝' }));
    expect(onResolve).toHaveBeenNthCalledWith(1, 'permission-1', true);
    expect(onResolve).toHaveBeenNthCalledWith(2, 'permission-1', false);
  });

  it('resolved 审批只读且不再展示操作', () => {
    render(<PermissionCard event={permission('approved')} onResolve={() => {}}/>);
    expect(screen.getByText('已允许')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  // 全站风险最高的两个决策按钮曾是 h-8（32px），低于契约 §9 的 40px 触控目标。
  // 用 Button 默认 md 档后是 h-10；这条守的是别有人把它改回 size="sm"。
  it('允许 / 拒绝的触控目标是 40px，不是 32px', () => {
    render(<PermissionCard event={permission('pending')} onResolve={() => {}}/>);
    for (const name of ['允许', '拒绝']) expect(screen.getByRole('button', { name }).className).toContain('h-10');
  });

  // resolving 期间原先是手写转圈图标，现由 Button 的 loading 渲染 Spinner 并置 aria-busy。
  // 两个按钮都必须点不动，否则用户能重复提交同一条授权。
  it('resolving 期间两个按钮都禁用，「允许」标记 aria-busy', () => {
    render(<PermissionCard event={permission('pending')} resolving onResolve={() => {}}/>);
    const approve = screen.getByRole('button', { name: '允许' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(approve.getAttribute('aria-busy')).toBe('true');
    expect((screen.getByRole('button', { name: '拒绝' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
