// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Popover, usePopoverTrigger } from './Popover';

function Harness({ placement, width }: { placement?: 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end'; width?: number | 'anchor' | 'auto' }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const trigger = usePopoverTrigger(open, 'listbox');
  return <div>
    <button type="button" ref={anchor} aria-expanded={trigger['aria-expanded']} aria-haspopup={trigger['aria-haspopup']} onClick={() => setOpen(current => !current)}>选择模型</button>
    <button type="button">外部按钮</button>
    <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement={placement} width={width}>
      <button type="button">选项甲</button>
      <button type="button">选项乙</button>
    </Popover>
  </div>;
}

describe('Popover 原语', () => {
  it('关闭时不渲染', () => {
    render(<Harness/>);
    expect(screen.queryByText('选项甲')).toBeNull();
  });

  it('portal 到 document.body，不被祖先的 overflow 裁掉', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness/>);
    await user.click(screen.getByRole('button', { name: '选择模型' }));
    const option = screen.getByText('选项甲');
    expect(container.contains(option)).toBe(false);
    expect(document.body.contains(option)).toBe(true);
  });

  it('Escape 关闭并把焦点还给触发器', async () => {
    const user = userEvent.setup();
    render(<Harness/>);
    const trigger = screen.getByRole('button', { name: '选择模型' });
    await user.click(trigger);
    expect(screen.getByText('选项甲')).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText('选项甲')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('点外部关闭，点面板内部不关', async () => {
    const user = userEvent.setup();
    render(<Harness/>);
    await user.click(screen.getByRole('button', { name: '选择模型' }));
    await user.click(screen.getByText('选项甲'));
    expect(screen.getByText('选项甲')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '外部按钮' }));
    await waitFor(() => expect(screen.queryByText('选项甲')).toBeNull());
  });

  it('点触发器自身由触发器负责收起，Popover 不重复处理（否则关了又开）', async () => {
    const user = userEvent.setup();
    render(<Harness/>);
    const trigger = screen.getByRole('button', { name: '选择模型' });
    await user.click(trigger);
    expect(screen.getByText('选项甲')).toBeTruthy();
    await user.click(trigger);
    await waitFor(() => expect(screen.queryByText('选项甲')).toBeNull());
  });

  it('不锁焦点：Tab 能走出浮层（与 Dialog 的关键区别）', async () => {
    const user = userEvent.setup();
    render(<Harness/>);
    await user.click(screen.getByRole('button', { name: '选择模型' }));
    const outside = screen.getByRole('button', { name: '外部按钮' });
    outside.focus();
    expect(document.activeElement).toBe(outside);
  });

  it('usePopoverTrigger 提供 aria-expanded / aria-haspopup', async () => {
    const user = userEvent.setup();
    render(<Harness/>);
    const trigger = screen.getByRole('button', { name: '选择模型' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
    await user.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('按 placement 定位，并支持 anchor / 固定宽度 / auto 三种宽度', async () => {
    const user = userEvent.setup();
    const rect = { top: 100, bottom: 140, left: 50, right: 250, width: 200, height: 40, x: 50, y: 100, toJSON: () => ({}) } as DOMRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect);

    const { unmount } = render(<Harness placement="bottom-start"/>);
    await user.click(screen.getByRole('button', { name: '选择模型' }));
    let panel = screen.getByText('选项甲').parentElement as HTMLElement;
    expect(panel.style.top).toBe('144px');       // rect.bottom + 4
    expect(panel.style.left).toBe('50px');
    expect(panel.style.width).toBe('200px');     // width='anchor' 取锚点宽度
    unmount();

    const { unmount: unmount2 } = render(<Harness placement="top-end" width={320}/>);
    await user.click(screen.getByRole('button', { name: '选择模型' }));
    panel = screen.getByText('选项甲').parentElement as HTMLElement;
    expect(panel.style.bottom).toBeTruthy();     // top-* 用 bottom 定位
    expect(panel.style.top).toBe('');
    expect(panel.style.width).toBe('320px');
    unmount2();

    render(<Harness width="auto"/>);
    await user.click(screen.getByRole('button', { name: '选择模型' }));
    panel = screen.getByText('选项甲').parentElement as HTMLElement;
    expect(panel.style.width).toBe('');
    vi.restoreAllMocks();
  });

  it('复用 index.css 的 ui-popover 动画类，不自造 keyframes', async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<Harness/>);
    await user.click(screen.getByRole('button', { name: '选择模型' }));
    expect(baseElement.querySelector('.ui-popover')).toBeTruthy();
    expect(baseElement.querySelector('style')).toBeNull();
  });

  it('只使用语义 token 类，不出现硬编码调色板', async () => {
    const user = userEvent.setup();
    render(<Harness/>);
    await user.click(screen.getByRole('button', { name: '选择模型' }));
    const panel = screen.getByText('选项甲').parentElement as HTMLElement;
    for (const banned of ['zinc-', 'slate-', 'amber-', 'teal-', 'rose-', 'bg-white', 'text-white', 'bg-black', 'var(--']) expect(panel.className).not.toContain(banned);
    expect(panel.className).toContain('bg-surface');
  });

  it('关闭后摘掉 Escape 与 pointerdown 监听', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const anchor = { current: document.createElement('button') };
    const { rerender } = render(<Popover open onClose={onClose} anchor={anchor}>内容</Popover>);
    rerender(<Popover open={false} onClose={onClose} anchor={anchor}>内容</Popover>);
    await user.keyboard('{Escape}');
    await user.click(document.body);
    expect(onClose).not.toHaveBeenCalled();
  });
});
