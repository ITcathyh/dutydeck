import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EmptyState } from './EmptyState';

// 这些用例守的是契约 §10 的语气规则：三种 tone 不可混用，
// 尤其是「没有待办是好消息，用绿勾不用灰色失望感」——把「你已经处理完了」
// 画成灰色空盒子，等于为一件好事道歉。

/** 图标包裹层是 .ui-empty-state 的第一个 span，tone 的颜色就落在它身上。 */
const iconWrapper = (container: HTMLElement) => container.querySelector('.ui-empty-state > span');

describe('EmptyState 语气', () => {
  it('三种 tone 的图标底色互不相同', () => {
    const neutral = render(<EmptyState tone="neutral" icon={<i data-testid="glyph"/>} title="没有匹配结果"/>);
    expect(iconWrapper(neutral.container)!.className).toContain('bg-muted');
    expect(iconWrapper(neutral.container)!.className).toContain('text-subtle');
    neutral.unmount();

    const positive = render(<EmptyState tone="positive" title="全部处理完了"/>);
    expect(iconWrapper(positive.container)!.className).toContain('bg-success-soft');
    expect(iconWrapper(positive.container)!.className).toContain('text-success');
    positive.unmount();

    const guide = render(<EmptyState tone="guide" icon={<i data-testid="glyph"/>} title="创建第一个任务"/>);
    expect(iconWrapper(guide.container)!.className).toContain('bg-action-soft');
    expect(iconWrapper(guide.container)!.className).toContain('text-action');
  });

  it('tone=positive 不传 icon 也自带绿勾，绝不退化成灰色空盒子', () => {
    const { container } = render(<EmptyState tone="positive" title="没有待办"/>);
    const wrapper = iconWrapper(container);
    expect(wrapper).toBeTruthy();
    // 默认图标必须真的画出来，而不是留一个空壳。
    expect(wrapper!.querySelector('svg')).toBeTruthy();
    expect(wrapper!.className).toContain('bg-success-soft');
    expect(wrapper!.className).toContain('text-success');
    expect(wrapper!.className).not.toContain('bg-muted');
    expect(wrapper!.className).not.toContain('text-subtle');
  });

  it('tone=neutral 不传 icon 时不硬塞图标（灰色空盒子只在真的没内容时才画）', () => {
    const { container } = render(<EmptyState title="没有匹配结果"/>);
    expect(iconWrapper(container)).toBeNull();
  });

  it('显式传入的 icon 覆盖默认绿勾', () => {
    const { container } = render(<EmptyState tone="positive" icon={<i data-testid="custom-glyph"/>} title="全部处理完了"/>);
    expect(screen.getByTestId('custom-glyph')).toBeTruthy();
    expect(container.querySelector('svg')).toBeNull();
    // 覆盖的只是图形，tone 的语义颜色仍然保留。
    expect(iconWrapper(container)!.className).toContain('bg-success-soft');
  });

  it('neutral 标题用次级文字色，其余 tone 用主文字色', () => {
    const neutral = render(<EmptyState title="没有匹配结果"/>);
    expect(screen.getByText('没有匹配结果').className).toContain('text-secondary');
    neutral.unmount();
    render(<EmptyState tone="positive" title="全部处理完了"/>);
    expect(screen.getByText('全部处理完了').className).toContain('text-primary');
  });
});

describe('EmptyState 内容与动作', () => {
  it('渲染标题；description 不传时不占一行', () => {
    const { container } = render(<EmptyState title="没有匹配结果"/>);
    expect(screen.getByText('没有匹配结果')).toBeTruthy();
    expect(container.querySelectorAll('p').length).toBe(1);
  });

  it('传了 description 就渲染成说明文字', () => {
    render(<EmptyState title="没有匹配结果" description="换个筛选条件再试试。"/>);
    const description = screen.getByText('换个筛选条件再试试。');
    expect(description.className).toContain('text-caption');
    expect(description.className).toContain('text-subtle');
  });

  it('没有任何 action 时不渲染按钮', () => {
    render(<EmptyState title="没有匹配结果"/>);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('primaryAction 与 secondaryAction 各渲染一个按钮并各自回调', async () => {
    const user = userEvent.setup();
    const onPrimary = vi.fn();
    const onSecondary = vi.fn();
    render(<EmptyState
      tone="guide"
      title="创建第一个任务"
      primaryAction={{ label: '新建任务', onClick: onPrimary }}
      secondaryAction={{ label: '查看文档', onClick: onSecondary }}
    />);
    await user.click(screen.getByRole('button', { name: '新建任务' }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    expect(onSecondary).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '查看文档' }));
    expect(onSecondary).toHaveBeenCalledTimes(1);
  });

  it('primaryAction.disabled 让按钮真的点不动，而不是只变浅', async () => {
    const user = userEvent.setup();
    const onPrimary = vi.fn();
    render(<EmptyState
      tone="guide"
      title="创建第一个任务"
      primaryAction={{ label: '新建任务', onClick: onPrimary, disabled: true }}
    />);
    const button = screen.getByRole('button', { name: '新建任务' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.click(button);
    expect(onPrimary).not.toHaveBeenCalled();
  });

  it('只传 secondaryAction 时也能单独渲染', async () => {
    const user = userEvent.setup();
    const onSecondary = vi.fn();
    render(<EmptyState title="没有匹配结果" secondaryAction={{ label: '清除筛选', onClick: onSecondary }}/>);
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBe(1);
    await user.click(buttons[0]!);
    expect(onSecondary).toHaveBeenCalledTimes(1);
  });
});
