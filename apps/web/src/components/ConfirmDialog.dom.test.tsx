import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
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
    // 弹层 portal 到 document.body，不在 RTL 的 container 里，只能从 baseElement 找。
    const { baseElement, rerender } = render(<ConfirmDialog {...baseProps} open onCancel={onCancel}/>);
    const overlay = baseElement.querySelector('.ui-overlay') as HTMLElement;
    await user.click(overlay);
    expect(onCancel).toHaveBeenCalledTimes(1);
    onCancel.mockClear();
    rerender(<ConfirmDialog {...baseProps} open busy onCancel={onCancel}/>);
    await user.click(baseElement.querySelector('.ui-overlay') as HTMLElement);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('portal 到 document.body，不留在组件树里（契约 §7）', () => {
    const { container, baseElement } = render(<ConfirmDialog {...baseProps} open/>);
    const dialog = screen.getByRole('alertdialog', { name: '删除该 Session？' });
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
    expect(baseElement).toBe(document.body);
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
    // 契约 §12.3 禁止 bg-[var(--…)] 内联 token，这里断言语义类。
    const { rerender } = render(<ConfirmDialog {...baseProps} open tone="danger"/>);
    expect(screen.getByRole('button', { name: '删除' }).className).toContain('bg-danger-solid');
    rerender(<ConfirmDialog {...baseProps} open/>);
    expect(screen.getByRole('button', { name: '删除' }).className).toContain('bg-inverse');
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
    const { container, baseElement } = render(<ConfirmDialog {...baseProps} open={false} onCancel={onCancel}/>);
    expect(container.innerHTML).toBe('');
    // portal 之后「什么都没渲染」要连 body 一起查：container 空只说明没就地渲染。
    expect(baseElement.querySelector('.ui-overlay')).toBeNull();
    await user.keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();
  });

  // 接管原 ConfirmDialog.test.ts（SSR 静态渲染）的两条断言。
  // 那份用的是 renderToStaticMarkup，而 Dialog 原语 portal 到 body 后服务端渲染器
  // 会直接抛「Portals are not currently supported by the server renderer」，
  // 内容渲染只能在客户端测。语义搬到这里，覆盖不丢。
  it('打开时渲染标题、描述与确认按钮文案', () => {
    render(<ConfirmDialog {...baseProps} open title="确认删除？" description="删除后不可恢复。" confirmLabel="确认"/>);
    expect(screen.getByText('确认删除？')).toBeTruthy();
    expect(screen.getByText('删除后不可恢复。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '确认' })).toBeTruthy();
  });

  it('关闭态在服务端渲染下必须安全返回空串（app-smoke 的隐式前提）', () => {
    /*
      守的是「Dialog 不得在 SSR 路径上以 open=true 渲染」。

      Dialog 原语 portal 到 document.body，而 React 的服务端渲染器不支持 portal：
      open=true 时 renderToStaticMarkup 会抛
      「Portals are not currently supported by the server renderer」。

      这条契约现在是隐式的——`app-smoke.test.ts` 用 renderToStaticMarkup 渲染整个 App，
      它之所以是绿的，只是因为 App 里所有弹层恰好都 open=false。谁给 App 加一个默认
      展开的 Dialog，那个 smoke 就会以这条报错炸掉，而报错文本跟「弹层默认开着」这个
      真实原因隔着好几层，排查很费劲。这里把前提钉成断言，让它在离原因最近的地方失败。

      注意只断言 open=false：open=true 抛错是 React 的既定行为，不是本组件的缺陷，
      也不该靠给冻结的原语加一条只为测试存在的 SSR 降级分支来消除。
    */
    expect(renderToStaticMarkup(<ConfirmDialog {...baseProps} open={false}/>)).toBe('');
  });
});
