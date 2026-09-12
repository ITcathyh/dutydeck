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
    await user.click(screen.getByRole('button', { name: '允许本次' }));
    await user.click(screen.getByRole('button', { name: '拒绝' }));
    expect(onResolve).toHaveBeenNthCalledWith(1, 'permission-1', true);
    expect(onResolve).toHaveBeenNthCalledWith(2, 'permission-1', false);
  });

  it('shows source facts, redacts commands, and makes unknown details explicit', async () => {
    const event = permission('pending');
    event.data.operation = { source: 'acp_tool_call', cwd: '/work/project', resource: '/work/project/file.ts', command: 'pnpm test --token=synthetic-secret' };
    const view = render(<PermissionCard event={event}/>);
    expect(screen.getByText('来源：执行端工具请求')).toBeTruthy();
    expect(screen.getByText('目录：/work/project')).toBeTruthy();
    expect(screen.getByText('资源：/work/project/file.ts')).toBeTruthy();
    await userEvent.setup().click(screen.getByText('查看命令（已脱敏）'));
    expect(screen.getByText('pnpm test --token=[REDACTED]')).toBeTruthy();
    expect(view.container.textContent).not.toContain('synthetic-secret');
    expect(screen.getByText('本次选择只处理这一条请求，不改变后续授权方式。')).toBeTruthy();
    view.rerender(<PermissionCard event={permission('pending')}/>);
    expect(screen.getByText('执行端未提供详细操作。')).toBeTruthy();
  });

  it('never offers a decision for an expired request', () => {
    render(<PermissionCard event={permission('expired')} onResolve={vi.fn()}/>);
    expect(screen.getByText('已失效')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
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
    for (const name of ['允许本次', '拒绝']) expect(screen.getByRole('button', { name }).className).toContain('h-10');
  });

  // resolving 期间原先是手写转圈图标，现由 Button 的 loading 渲染 Spinner 并置 aria-busy。
  // 两个按钮都必须点不动，否则用户能重复提交同一条授权。
  it('resolving 期间两个按钮都禁用，「允许」标记 aria-busy', () => {
    render(<PermissionCard event={permission('pending')} resolving onResolve={() => {}}/>);
    const approve = screen.getByRole('button', { name: '允许本次' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(approve.getAttribute('aria-busy')).toBe('true');
    expect((screen.getByRole('button', { name: '拒绝' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
