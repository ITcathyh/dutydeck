// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog';

function Harness({ closeOnEscape = true, closeOnScrim = true, withInitialFocus = false }: { closeOnEscape?: boolean; closeOnScrim?: boolean; withInitialFocus?: boolean }) {
  const [open, setOpen] = useState(false);
  const confirm = useRef<HTMLButtonElement>(null);
  return <div>
    <button type="button" onClick={() => setOpen(true)}>打开</button>
    <p>背景内容</p>
    <Dialog open={open} onClose={() => setOpen(false)} label="测试弹层" closeOnEscape={closeOnEscape} closeOnScrim={closeOnScrim} initialFocus={withInitialFocus ? confirm : undefined}>
      <Dialog.Header><h2>标题</h2></Dialog.Header>
      <Dialog.Body>正文</Dialog.Body>
      <Dialog.Footer>
        <button type="button" onClick={() => setOpen(false)}>取消</button>
        <button type="button" ref={confirm}>确认</button>
      </Dialog.Footer>
    </Dialog>
  </div>;
}

describe('Dialog 原语', () => {
  it('关闭时不渲染任何节点', () => {
    render(<Harness/>);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('portal 到 document.body，不留在组件树里', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness/>);
    await user.click(screen.getByRole('button', { name: '打开' }));
    const dialog = screen.getByRole('dialog', { name: '测试弹层' });
    // 契约 §7：所有模态经 Dialog 原语 portal 到 body，不在组件树里就地渲染。
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });

  it('恒带 aria-modal 与 aria-label，role 可切到 alertdialog', async () => {
    const user = userEvent.setup();
    render(<Harness/>);
    await user.click(screen.getByRole('button', { name: '打开' }));
    const dialog = screen.getByRole('dialog', { name: '测试弹层' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    render(<Dialog open onClose={() => {}} label="危险确认" role="alertdialog">内容</Dialog>);
    expect(screen.getByRole('alertdialog', { name: '危险确认' }).getAttribute('aria-modal')).toBe('true');
  });

  it('层级用 z-dialog，不再手工排 z-index', async () => {
    const user = userEvent.setup();
    render(<Harness/>);
    await user.click(screen.getByRole('button', { name: '打开' }));
    const overlay = screen.getByRole('dialog').parentElement!;
    expect(overlay.className).toContain('z-dialog');
    expect(overlay.className).toContain('ui-overlay');
  });

  it('四档宽度对应契约的 420 / 640 / 960 / 1152', () => {
    for (const [size, width] of [['sm', '420'], ['md', '640'], ['lg', '960'], ['xl', '1152']] as const) {
      const { unmount } = render(<Dialog open onClose={() => {}} label={`宽度 ${size}`} size={size}>内容</Dialog>);
      expect(screen.getByRole('dialog', { name: `宽度 ${size}` }).className).toContain(`max-w-[${width}px]`);
      unmount();
    }
  });

  it('焦点进入弹层，Tab 在内部循环，关闭后回到触发器', async () => {
    const user = userEvent.setup();
    render(<Harness/>);
    const opener = screen.getByRole('button', { name: '打开' });
    opener.focus();
    await user.click(opener);
    const cancel = screen.getByRole('button', { name: '取消' });
    const confirm = screen.getByRole('button', { name: '确认' });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    await user.tab();
    expect(document.activeElement).toBe(confirm);
    // 末项再 Tab 必须回到首项，不能跑到弹层外的背景按钮上。
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(confirm);
    await user.click(cancel);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('initialFocus 压过默认的首个可聚焦元素', async () => {
    const user = userEvent.setup();
    render(<Harness withInitialFocus/>);
    await user.click(screen.getByRole('button', { name: '打开' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '确认' })));
  });

  it('Escape 关闭；closeOnEscape=false 时（busy 场景）不关', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness/>);
    await user.click(screen.getByRole('button', { name: '打开' }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    unmount();

    render(<Harness closeOnEscape={false}/>);
    await user.click(screen.getByRole('button', { name: '打开' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: '测试弹层' })).toBeTruthy();
  });

  it('点遮罩关闭；点面板内部不关；closeOnScrim=false 时点遮罩也不关', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness/>);
    await user.click(screen.getByRole('button', { name: '打开' }));
    await user.click(screen.getByText('正文'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    await user.click(screen.getByRole('dialog').parentElement!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    unmount();

    render(<Harness closeOnScrim={false}/>);
    await user.click(screen.getByRole('button', { name: '打开' }));
    await user.click(screen.getByRole('dialog').parentElement!);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('打开时把背景 inert 并移出可访问树，关闭后原样恢复', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness/>);
    // portal 之后遮罩挂在 body 下，所以背景是整棵应用子树（这里是 RTL 的 container），
    // 而不是弹层的兄弟节点。inert 会向下继承，背景里的按钮同样点不到。
    await user.click(screen.getByRole('button', { name: '打开' }));
    expect(container.hasAttribute('inert')).toBe(true);
    expect(container.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('背景内容').closest('[inert]')).toBe(container);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(container.hasAttribute('inert')).toBe(false));
    expect(container.getAttribute('aria-hidden')).toBeNull();
  });

  it('Header / Body / Footer 三段式：只有 Body 滚动', () => {
    render(<Dialog open onClose={() => {}} label="分段">
      <Dialog.Header>头</Dialog.Header>
      <Dialog.Body>身</Dialog.Body>
      <Dialog.Footer>脚</Dialog.Footer>
    </Dialog>);
    expect(screen.getByText('头').className).toContain('shrink-0');
    expect(screen.getByText('身').className).toContain('overflow-y-auto');
    expect(screen.getByText('脚').className).toContain('shrink-0');
  });

  it('复用 index.css 的 ui-overlay / ui-dialog 动画类，不自造 keyframes', () => {
    const { baseElement } = render(<Dialog open onClose={() => {}} label="动效">内容</Dialog>);
    expect(baseElement.querySelector('.ui-overlay')).toBeTruthy();
    expect(screen.getByRole('dialog').className).toContain('ui-dialog');
    expect(baseElement.querySelector('style')).toBeNull();
  });

  it('只使用语义 token 类，不出现硬编码调色板', () => {
    const { baseElement } = render(<Dialog open onClose={() => {}} label="配色"><Dialog.Body>内容</Dialog.Body></Dialog>);
    const classNames = [...baseElement.querySelectorAll<HTMLElement>('*')].map(node => node.className).join(' ');
    for (const banned of ['zinc-', 'slate-', 'amber-', 'teal-', 'rose-', 'bg-white', 'text-white', 'bg-black', 'var(--']) expect(classNames).not.toContain(banned);
  });

  it('关闭后摘掉 Escape 监听，不会替下一个浮层抢按键', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(<Dialog open onClose={onClose} label="监听">内容</Dialog>);
    rerender(<Dialog open={false} onClose={onClose} label="监听">内容</Dialog>);
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
});
