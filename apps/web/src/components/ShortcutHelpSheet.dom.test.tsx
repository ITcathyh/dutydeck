import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ShortcutHelpSheet } from './ShortcutHelpSheet';
import { captureDialogOpener } from '../useDialogFocus';
import { shortcutDefinitions } from '../useKeyboardShortcuts';

// 帮助面板是快捷键的唯一说明书，这些用例盯的是「说明书撒谎」类回归：
// 把不可用的快捷键描述成可用、只用灰度而不用文字标注、平台键位显示错误。

const allUnavailable = Object.fromEntries(shortcutDefinitions.map(definition => [definition.id, false]));
const allAvailable = Object.fromEntries(shortcutDefinitions.map(definition => [definition.id, true]));
/** 按 id 取当前文案，这样改快捷键描述不用回来改测试。 */
const labelOf = (id: string) => shortcutDefinitions.find(definition => definition.id === id)!.label;

describe('ShortcutHelpSheet 渲染', () => {
  it('open=false 时不渲染任何内容，Esc 也不回调 onClose', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(<ShortcutHelpSheet open={false} onClose={onClose}/>);
    expect(container.innerHTML).toBe('');
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('打开后是带中文 aria-label 的模态对话框', () => {
    render(<ShortcutHelpSheet open onClose={() => {}} platform="mac"/>);
    const dialog = screen.getByRole('dialog', { name: '键盘快捷键帮助' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('按分组渲染真实标题，注册表里的每条快捷键都能找到文案', () => {
    render(<ShortcutHelpSheet open onClose={() => {}} platform="mac"/>);
    for (const group of ['导航', '任务', '视图', '帮助']) expect(screen.getByRole('heading', { name: group, level: 3 })).toBeTruthy();
    for (const definition of shortcutDefinitions) expect(screen.getByText(definition.label)).toBeTruthy();
  });

  it('macOS 显示 ⌘，其它平台显示 Ctrl', () => {
    // 面板 portal 到 document.body，container 里没有节点，只能从 baseElement 找。
    const { rerender, baseElement } = render(<ShortcutHelpSheet open onClose={() => {}} platform="mac"/>);
    const macKeys = [...baseElement.querySelectorAll('kbd')].map(node => node.textContent);
    expect(macKeys).toContain('⌘');
    expect(macKeys).not.toContain('Ctrl');
    rerender(<ShortcutHelpSheet open onClose={() => {}} platform="other"/>);
    const pcKeys = [...baseElement.querySelectorAll('kbd')].map(node => node.textContent);
    expect(pcKeys).toContain('Ctrl');
    expect(pcKeys).not.toContain('⌘');
  });

  it('每个按键片段都渲染成独立的 <kbd>，而不是一串纯文本', () => {
    const { baseElement } = render(<ShortcutHelpSheet open onClose={() => {}} platform="mac"/>);
    const keys = [...baseElement.querySelectorAll('kbd')].map(node => node.textContent);
    expect(keys).toContain('K');
    expect(keys).toContain('?');
    expect(keys).toContain('N');
    expect(keys.some(key => key?.includes('+'))).toBe(false);
  });

  it('和弦用「然后」表达按下顺序，不会被读成同时按', () => {
    render(<ShortcutHelpSheet open onClose={() => {}} platform="mac"/>);
    const row = screen.getByText('回到任务中心总览').closest('li')!;
    expect(within(row).getAllByText('然后').length).toBe(1);
    expect([...row.querySelectorAll('kbd')].map(node => node.textContent)).toEqual(['G', 'T']);
  });

  it('别名写法与主写法并列展示（? 或 ⌘ /）', () => {
    render(<ShortcutHelpSheet open onClose={() => {}} platform="mac"/>);
    const row = screen.getByText('打开或关闭快捷键帮助').closest('li')!;
    expect([...row.querySelectorAll('kbd')].map(node => node.textContent)).toEqual(['?', '⌘', '/']);
    expect(within(row).getByText('或')).toBeTruthy();
  });

  it('不可用的快捷键用文字标注「当前不可用」，不只靠颜色', () => {
    render(<ShortcutHelpSheet open onClose={() => {}} platform="mac" available={{ ...allUnavailable, 'create-task': true }}/>);
    const unavailable = screen.getByText(labelOf('toggle-raw-log')).closest('li')!;
    expect(within(unavailable).getByText(/当前不可用/)).toBeTruthy();
    const availableRow = screen.getByText(labelOf('create-task')).closest('li')!;
    expect(within(availableRow).queryByText(/当前不可用/)).toBeNull();
  });

  it('session 作用域不可用时说明要先打开一个任务', () => {
    render(<ShortcutHelpSheet open onClose={() => {}} platform="mac" available={allUnavailable}/>);
    const row = screen.getByText(labelOf('interrupt-run')).closest('li')!;
    expect(within(row).getByText('当前不可用：先打开一个任务')).toBeTruthy();
    const globalRow = screen.getByText(labelOf('create-task')).closest('li')!;
    expect(within(globalRow).getByText('当前不可用')).toBeTruthy();
  });

  it('available 未传时视为全部可用，不出现「当前不可用」', () => {
    render(<ShortcutHelpSheet open onClose={() => {}} platform="mac"/>);
    expect(screen.queryByText(/当前不可用/)).toBeNull();
    expect(screen.getByText('以上快捷键在当前界面均可直接使用。')).toBeTruthy();
  });

  it('available 里缺失的 id 按未接线处理，标注为不可用', () => {
    render(<ShortcutHelpSheet open onClose={() => {}} platform="mac" available={{ 'create-task': true }}/>);
    const row = screen.getByText('打开命令面板，搜索任务与操作').closest('li')!;
    expect(within(row).getByText(/当前不可用/)).toBeTruthy();
  });

  it('底部统计出真实的不可用条数，不含糊其辞', () => {
    render(<ShortcutHelpSheet open onClose={() => {}} platform="mac" available={{ ...allAvailable, 'toggle-raw-log': false, 'archive-run': false }}/>);
    expect(screen.getByText('其中 2 项在当前界面不可用，已逐条标注原因。')).toBeTruthy();
  });

  it('Esc 关闭面板', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ShortcutHelpSheet open onClose={onClose} platform="mac"/>);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点击关闭按钮与底部「关闭」都回调 onClose', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ShortcutHelpSheet open onClose={onClose} platform="mac"/>);
    await user.click(screen.getByRole('button', { name: '关闭快捷键帮助' }));
    await user.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('点击遮罩关闭，点击面板内部不关闭', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { baseElement } = render(<ShortcutHelpSheet open onClose={onClose} platform="mac"/>);
    await user.click(baseElement.querySelector('.ui-overlay') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
    onClose.mockClear();
    await user.click(screen.getByRole('heading', { name: '键盘快捷键', level: 2 }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('打开时焦点进入面板，关闭后回到触发它的按钮', async () => {
    const user = userEvent.setup();
    function Host() {
      const [open, setOpen] = useState(false);
      return <><button type="button" onClick={() => { captureDialogOpener(); setOpen(true); }}>查看快捷键</button><ShortcutHelpSheet open={open} onClose={() => setOpen(false)} platform="mac"/></>;
    }
    render(<Host/>);
    const trigger = screen.getByRole('button', { name: '查看快捷键' });
    await user.click(trigger);
    await vi.waitFor(() => expect(screen.getByRole('dialog', { name: '键盘快捷键帮助' }).contains(document.activeElement)).toBe(true));
    await user.keyboard('{Escape}');
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('Tab 焦点锁在面板内，不逃到面板外的按钮', async () => {
    const user = userEvent.setup();
    render(<><button type="button">面板外按钮</button><ShortcutHelpSheet open onClose={() => {}} platform="mac"/></>);
    const dialog = screen.getByRole('dialog', { name: '键盘快捷键帮助' });
    await vi.waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    for (let step = 0; step < 4; step++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('正文区域可滚动，且不产生横向溢出（390px 窄屏）', () => {
    const { baseElement } = render(<ShortcutHelpSheet open onClose={() => {}} platform="mac"/>);
    const body = baseElement.querySelector('.overflow-y-auto') as HTMLElement;
    expect(body.className).toContain('overflow-y-auto');
    expect(body.className).toContain('overflow-x-hidden');
    const panel = screen.getByRole('dialog', { name: '键盘快捷键帮助' });
    expect(panel.className).toContain('max-h-[92dvh]');
    expect(panel.className).toContain('w-full');
  });

  it('复用 index.css 的 ui-overlay / ui-dialog 动画类，不自造关键帧', () => {
    const { baseElement } = render(<ShortcutHelpSheet open onClose={() => {}} platform="mac"/>);
    expect(baseElement.querySelector('.ui-overlay')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: '键盘快捷键帮助' }).className).toContain('ui-dialog');
  });

  it('portal 到 document.body，不留在组件树里（契约 §7）', () => {
    const { container, baseElement } = render(<ShortcutHelpSheet open onClose={() => {}} platform="mac"/>);
    const dialog = screen.getByRole('dialog', { name: '键盘快捷键帮助' });
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
    expect(baseElement).toBe(document.body);
  });

  it('关闭按钮触控高度不低于 40px（h-10）', () => {
    render(<ShortcutHelpSheet open onClose={() => {}} platform="mac"/>);
    expect(screen.getByRole('button', { name: '关闭快捷键帮助' }).className).toContain('h-10');
    expect(screen.getByRole('button', { name: '关闭' }).className).toContain('h-10');
  });

  it('只使用语义 token 颜色，不出现硬编码调色板（深色模式回归）', () => {
    // 弹层 portal 到 body 之后，container 是空的——这条必须扫 baseElement，
    // 否则断言会退化成永真的假绿。
    const { baseElement } = render(<ShortcutHelpSheet open onClose={() => {}} platform="mac"/>);
    const classNames = [...baseElement.querySelectorAll<HTMLElement>('*')].map(node => node.className).join(' ');
    for (const banned of ['zinc-', 'slate-', 'amber-', 'teal-', 'rose-', 'bg-white', 'text-white', 'bg-black']) expect(classNames).not.toContain(banned);
  });
});
