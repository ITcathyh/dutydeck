import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ThemeToggle } from './ThemeToggle';

describe('ThemeToggle', () => {
  it('三个外观选项同时可见，并用文字而非颜色标出当前值', () => {
    render(<ThemeToggle preference="dark" resolved="dark" onChange={() => {}}/>);
    const group = screen.getByRole('radiogroup', { name: '界面外观' });
    expect(group).toBeTruthy();
    const options = screen.getAllByRole('radio');
    expect(options.map(option => option.textContent)).toEqual(['跟随系统', '浅色', '深色']);
    expect(screen.getByRole('radio', { name: /深色/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /浅色/ }).getAttribute('aria-checked')).toBe('false');
  });

  it('跟随系统时告知当前实际生效的外观，不让用户猜', () => {
    render(<ThemeToggle preference="system" resolved="dark" onChange={() => {}}/>);
    expect(screen.getByRole('radio', { name: /跟随系统.*当前为深色/ })).toBeTruthy();
  });

  it('选择任一外观都会回传偏好', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ThemeToggle preference="system" resolved="light" onChange={onChange}/>);
    await user.click(screen.getByRole('radio', { name: /^深色/ }));
    expect(onChange).toHaveBeenCalledWith('dark');
    await user.click(screen.getByRole('radio', { name: /^浅色/ }));
    expect(onChange).toHaveBeenCalledWith('light');
    await user.click(screen.getByRole('radio', { name: /^跟随系统/ }));
    expect(onChange).toHaveBeenCalledWith('system');
  });

  it('每个选项都提供至少 40px 触控目标', () => {
    render(<ThemeToggle preference="system" resolved="light" onChange={() => {}}/>);
    for (const option of screen.getAllByRole('radio')) expect(option.className).toContain('min-h-10');
  });

  it('选项不使用硬编码调色板颜色，保证深浅两套主题都可读', () => {
    const { container } = render(<ThemeToggle preference="light" resolved="light" onChange={() => {}}/>);
    expect(container.innerHTML).not.toMatch(/\b(bg|text|border)-(zinc|slate|gray|white)\b/);
  });
});
