import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Tabs } from './Tabs';

// Tabs 是 WAI-ARIA tabs 模式的唯一实现，这些用例盯的是「键盘用户被困住」类回归：
// roving tabindex 退化成每个标签都能 Tab、方向键改了选中却不搬焦点、首尾不循环。

type TabId = 'timeline' | 'terminal' | 'diff';

const items: Array<{ id: TabId; label: string }> = [
  { id: 'timeline', label: '时间线' },
  { id: 'terminal', label: '终端' },
  { id: 'diff', label: '改动' }
];

function Host({ initial = 'timeline', onChange }: { initial?: TabId; onChange?: (value: TabId) => void }) {
  const [value, setValue] = useState<TabId>(initial);
  return <Tabs
    value={value}
    label="详情视图"
    items={items}
    onChange={next => { setValue(next); onChange?.(next); }}
  />;
}

/** 聚焦当前选中的标签，模拟用户用 Tab 键进到标签栏之后的状态。 */
const focusSelected = () => (screen.getByRole('tab', { selected: true }) as HTMLElement).focus();

describe('Tabs 渲染', () => {
  it('渲染带 aria-label 的 tablist，每个条目一个 tab', () => {
    render(<Host/>);
    const tablist = screen.getByRole('tablist', { name: '详情视图' });
    expect(tablist).toBeTruthy();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map(tab => tab.textContent)).toEqual(['时间线', '终端', '改动']);
  });

  it('只有选中项 aria-selected=true，其余为 false', () => {
    render(<Host initial="terminal"/>);
    expect(screen.getByRole('tab', { name: '终端' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: '时间线' }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('tab', { name: '改动' }).getAttribute('aria-selected')).toBe('false');
  });

  it('roving tabindex：整条标签栏在 Tab 序列里只占一站', () => {
    render(<Host initial="terminal"/>);
    expect(screen.getByRole('tab', { name: '终端' }).getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('tab', { name: '时间线' }).getAttribute('tabindex')).toBe('-1');
    expect(screen.getByRole('tab', { name: '改动' }).getAttribute('tabindex')).toBe('-1');
  });

  it('每个标签都用 aria-controls 指向自己的面板', () => {
    render(<Host/>);
    expect(screen.getByRole('tab', { name: '时间线' }).getAttribute('aria-controls')).toBe('tabpanel-timeline');
    expect(screen.getByRole('tab', { name: '终端' }).getAttribute('aria-controls')).toBe('tabpanel-terminal');
    expect(screen.getByRole('tab', { name: '改动' }).getAttribute('aria-controls')).toBe('tabpanel-diff');
  });

  it('标签触控高度不低于 40px（h-10）', () => {
    render(<Host/>);
    for (const tab of screen.getAllByRole('tab')) expect(tab.className).toContain('h-10');
  });
});

describe('Tabs 键盘操作', () => {
  it('ArrowRight 选中下一个，并把焦点一起搬过去', async () => {
    const user = userEvent.setup();
    render(<Host/>);
    focusSelected();
    await user.keyboard('{ArrowRight}');
    const terminal = screen.getByRole('tab', { name: '终端' });
    expect(terminal.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(terminal);
    expect(terminal.getAttribute('tabindex')).toBe('0');
  });

  it('ArrowLeft 选中上一个，并把焦点一起搬过去', async () => {
    const user = userEvent.setup();
    render(<Host initial="diff"/>);
    focusSelected();
    await user.keyboard('{ArrowLeft}');
    const terminal = screen.getByRole('tab', { name: '终端' });
    expect(terminal.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(terminal);
  });

  it('ArrowRight 在末尾回到第一个（首尾循环）', async () => {
    const user = userEvent.setup();
    render(<Host initial="diff"/>);
    focusSelected();
    await user.keyboard('{ArrowRight}');
    const first = screen.getByRole('tab', { name: '时间线' });
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(first);
  });

  it('ArrowLeft 在开头回到最后一个（首尾循环）', async () => {
    const user = userEvent.setup();
    render(<Host initial="timeline"/>);
    focusSelected();
    await user.keyboard('{ArrowLeft}');
    const last = screen.getByRole('tab', { name: '改动' });
    expect(last.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(last);
  });

  it('连续方向键从新位置继续走，而不是从旧位置重算', async () => {
    const user = userEvent.setup();
    render(<Host/>);
    focusSelected();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    const last = screen.getByRole('tab', { name: '改动' });
    expect(last.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(last);
  });

  it('Home 选中第一个，End 选中最后一个', async () => {
    const user = userEvent.setup();
    render(<Host initial="terminal"/>);
    focusSelected();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: '改动' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '改动' }));
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: '时间线' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '时间线' }));
  });

  it('其它按键不拦截，也不改选中项', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host onChange={onChange}/>);
    focusSelected();
    await user.keyboard('{ArrowDown}a');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: '时间线' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('Tabs 鼠标操作', () => {
  it('点击标签回调 onChange，并带上被点的 id', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host onChange={onChange}/>);
    await user.click(screen.getByRole('tab', { name: '改动' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('diff');
    expect(screen.getByRole('tab', { name: '改动' }).getAttribute('aria-selected')).toBe('true');
  });

  it('受控用法下不自作主张：value 不变时选中项也不变', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Tabs value="timeline" label="详情视图" items={items} onChange={onChange}/>);
    await user.click(screen.getByRole('tab', { name: '终端' }));
    expect(onChange).toHaveBeenCalledWith('terminal');
    expect(screen.getByRole('tab', { name: '时间线' }).getAttribute('aria-selected')).toBe('true');
  });
});
