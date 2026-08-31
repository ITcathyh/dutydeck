import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

// ConfirmDialog 是全项目唯一的破坏性操作闸门（删除 / 归档）。
// 这些用例盯的是「闸门失效」类回归：busy 时仍能触发、Esc 绕过、焦点逃出弹窗。

const baseProps = {
  title: '删除该 Session？',
  description: '删除后不可恢复。',
  confirmLabel: '删除',
  onConfirm: () => {},
  onCancel: () => {}
};

describe('ConfirmDialog 交互', () => {
  it('点击确认按钮回调 onConfirm，且不误触 onCancel', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog {...baseProps} open onConfirm={onConfirm} onCancel={onCancel}/>);
    await user.click(screen.getByRole('button', { name: '删除' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('点击取消按钮回调 onCancel，且不误触 onConfirm', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog {...baseProps} open onConfirm={onConfirm} onCancel={onCancel}/>);
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Esc 关闭弹窗', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<ConfirmDialog {...baseProps} open onCancel={onCancel}/>);
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('busy 时 Esc 不生效（正在执行的破坏性操作不能被键盘中断）', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<ConfirmDialog {...baseProps} open busy onCancel={onCancel}/>);
    await user.keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('busy 时两个按钮都 disabled，并展示「处理中」替代确认文案', () => {
    render(<ConfirmDialog {...baseProps} open busy/>);
    expect(screen.getByText('处理中')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
    for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('点击遮罩关闭；busy 时点击遮罩不关闭', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const { container, rerender } = render(<ConfirmDialog {...baseProps} open onCancel={onCancel}/>);
    const overlay = container.querySelector('.ui-overlay') as HTMLElement;
    await user.click(overlay);
    expect(onCancel).toHaveBeenCalledTimes(1);
    onCancel.mockClear();
    rerender(<ConfirmDialog {...baseProps} open busy onCancel={onCancel}/>);
    await user.click(container.querySelector('.ui-overlay') as HTMLElement);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('打开后焦点自动落到「取消」而不是危险的确认按钮', async () => {
    render(<ConfirmDialog {...baseProps} open tone="danger"/>);
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' })));
  });

  it('Tab 焦点在弹窗内循环，不逃到弹窗外的元素', async () => {
    const user = userEvent.setup();
    render(<><button type="button">页面外按钮</button><ConfirmDialog {...baseProps} open/></>);
    const cancel = screen.getByRole('button', { name: '取消' });
    const confirm = screen.getByRole('button', { name: '删除' });
    await vi.waitFor(() => expect(document.activeElement).toBe(cancel));
    await user.tab();
    expect(document.activeElement).toBe(confirm);
    // 到达最后一个可聚焦元素后应绕回第一个，而非跳到「页面外按钮」
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(confirm);
  });

  it('tone="danger" 时确认按钮为红色，默认 warning 为深灰', () => {
    const { rerender } = render(<ConfirmDialog {...baseProps} open tone="danger"/>);
    expect(screen.getByRole('button', { name: '删除' }).className).toContain('bg-[var(--status-danger-solid)]');
    rerender(<ConfirmDialog {...baseProps} open/>);
    expect(screen.getByRole('button', { name: '删除' }).className).toContain('bg-[var(--surface-inverse)]');
  });

  it('传入 error 时展示错误文案；未传时不渲染错误区', () => {
    const { rerender } = render(<ConfirmDialog {...baseProps} open error="服务端拒绝了该操作"/>);
    expect(screen.getByText('服务端拒绝了该操作')).toBeTruthy();
    rerender(<ConfirmDialog {...baseProps} open/>);
    expect(screen.queryByText('服务端拒绝了该操作')).toBeNull();
  });

  it('open=false 时不渲染任何内容，也不注册 keydown（Esc 不触发回调）', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const { container } = render(<ConfirmDialog {...baseProps} open={false} onCancel={onCancel}/>);
    expect(container.innerHTML).toBe('');
    await user.keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();
  });
});
