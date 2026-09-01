// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { IconButton } from './IconButton';

// 图标钮没有可见文字，label 既是鼠标 tooltip 也是读屏名字，缺一样就有一类用户点不明白。
// 契约 §9：视觉可以缩到 32px，但命中区恒 40×40——伪元素外扩会让相邻图标钮互相盖住，
// 所以命中区做在按钮本体上，视觉尺寸交给内层 chip。

const iconButton = (name: string) => screen.getByRole('button', { name });

describe('IconButton 可访问性', () => {
  it('label 同时成为 title 与 aria-label', () => {
    render(<IconButton label="归档任务" onClick={() => {}}><span>x</span></IconButton>);
    const node = iconButton('归档任务');
    expect(node.getAttribute('title')).toBe('归档任务');
    expect(node.getAttribute('aria-label')).toBe('归档任务');
  });

  it('默认 type=button，放进表单里不会误提交', () => {
    render(<IconButton label="归档任务" onClick={() => {}}><span>x</span></IconButton>);
    expect(iconButton('归档任务').getAttribute('type')).toBe('button');
  });

  it('children 渲染在内层 chip 里', () => {
    render(<IconButton label="归档任务" onClick={() => {}}><span data-testid="glyph">x</span></IconButton>);
    expect(iconButton('归档任务').contains(screen.getByTestId('glyph'))).toBe(true);
  });
});

describe('IconButton 命中区与尺寸', () => {
  it('sm 视觉 32px，但按钮本体仍是 40×40 命中区', () => {
    render(<IconButton label="归档任务" size="sm" onClick={() => {}}><span>x</span></IconButton>);
    const node = iconButton('归档任务');
    expect(node.className).toContain('h-10');
    expect(node.className).toContain('w-10');
    const chip = node.querySelector('span')!;
    expect(chip.className).toContain('h-8');
    expect(chip.className).toContain('w-8');
  });

  it('md 内外都是 40px', () => {
    render(<IconButton label="归档任务" size="md" onClick={() => {}}><span>x</span></IconButton>);
    const node = iconButton('归档任务');
    expect(node.className).toContain('h-10');
    expect(node.className).toContain('w-10');
    const chip = node.querySelector('span')!;
    expect(chip.className).toContain('h-10');
    expect(chip.className).toContain('w-10');
  });

  it('不传 size 时默认 sm 视觉，命中区照样 40px', () => {
    render(<IconButton label="归档任务" onClick={() => {}}><span>x</span></IconButton>);
    const node = iconButton('归档任务');
    expect(node.className).toContain('h-10 w-10');
    expect(node.querySelector('span')!.className).toContain('h-8 w-8');
  });
});

describe('IconButton 语气与禁用', () => {
  it('tone=danger 用危险色 token，默认档不带危险色', () => {
    const { unmount } = render(<IconButton label="删除" tone="danger" onClick={() => {}}><span>x</span></IconButton>);
    const dangerChip = iconButton('删除').querySelector('span')!.className;
    expect(dangerChip).toContain('text-danger');
    expect(dangerChip).toContain('bg-danger-soft');
    unmount();

    render(<IconButton label="删除" onClick={() => {}}><span>x</span></IconButton>);
    const defaultChip = iconButton('删除').querySelector('span')!.className;
    expect(defaultChip).toContain('text-subtle');
    expect(defaultChip).not.toContain('danger');
  });

  it('disabled 时按钮真的禁用，点击不回调', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<IconButton label="归档任务" disabled onClick={onClick}><span>x</span></IconButton>);
    expect((iconButton('归档任务') as HTMLButtonElement).disabled).toBe(true);
    await user.click(iconButton('归档任务'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('可用时点击与键盘 Enter 都回调 onClick', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<IconButton label="归档任务" onClick={onClick}><span>x</span></IconButton>);
    await user.click(iconButton('归档任务'));
    expect(onClick).toHaveBeenCalledTimes(1);
    iconButton('归档任务').focus();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});
