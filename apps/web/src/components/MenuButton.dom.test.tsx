import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MenuButton } from './MenuButton';

const setup = () => {
  const rename = vi.fn(), archive = vi.fn(), raw = vi.fn();
  render(<MenuButton label="更多操作" icon={<span>…</span>} items={[
    { id: 'rename', label: '重命名会话', onSelect: rename },
    { id: 'raw', label: '原始日志', checked: true, onSelect: raw },
    { id: 'disabled', label: '不可用', disabled: true, onSelect: vi.fn() },
    { id: 'sep', separator: true },
    { id: 'archive', label: '归档任务', tone: 'danger', onSelect: archive }
  ]}/>);
  return { rename, archive, raw, trigger: screen.getByRole('button', { name: '更多操作' }) };
};

describe('MenuButton', () => {
  it('触发器自报菜单语义，展开后焦点落在第一项', async () => {
    const user = userEvent.setup();
    const { trigger } = setup();
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await user.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu', { name: '更多操作' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '重命名会话' })));
  });

  it('方向键跳过禁用项循环移动，Escape 关闭并回到触发器', async () => {
    const user = userEvent.setup();
    const { trigger } = setup();
    await user.click(trigger);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '重命名会话' })));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitemcheckbox', { name: '原始日志' }));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '归档任务' }));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '重命名会话' }));
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '归档任务' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('开关项用 menuitemcheckbox 报告状态；选中后先关菜单、焦点回触发器，再执行动作', async () => {
    const user = userEvent.setup();
    const { trigger, archive } = setup();
    await user.click(trigger);
    expect(screen.getByRole('menuitemcheckbox', { name: '原始日志' }).getAttribute('aria-checked')).toBe('true');
    archive.mockImplementation(() => expect(document.activeElement).toBe(trigger));
    await user.click(screen.getByRole('menuitem', { name: '归档任务' }));
    expect(archive).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
