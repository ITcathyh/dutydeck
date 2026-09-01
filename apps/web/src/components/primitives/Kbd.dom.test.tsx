// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Kbd } from './Kbd';

// 键帽必须是真的 <kbd>：帮助面板的用例靠 container.querySelectorAll('kbd') 逐键断言，
// 换成 <span> 会让那些用例静默失效。

describe('Kbd 键帽', () => {
  it('渲染成 <kbd> 元素，children 原样呈现', () => {
    const { container } = render(<Kbd>⌘</Kbd>);
    const kbd = container.querySelector('kbd')!;
    expect(kbd).toBeTruthy();
    expect(kbd.textContent).toBe('⌘');
    expect(screen.getByText('⌘').tagName).toBe('KBD');
  });

  it('多字符键位也整块放进同一个 <kbd>', () => {
    const { container } = render(<Kbd>Ctrl</Kbd>);
    expect(container.querySelectorAll('kbd').length).toBe(1);
    expect(container.querySelector('kbd')!.textContent).toBe('Ctrl');
  });

  it('圆角取 rounded-sm，配 min-w 保证单字符键帽不塌成细条', () => {
    const { container } = render(<Kbd>K</Kbd>);
    const className = container.querySelector('kbd')!.className;
    expect(className).toContain('rounded-sm');
    expect(className).not.toContain('rounded-full');
    expect(className).toContain('min-w-[1.5rem]');
  });

  it('用等宽字体与 text-meta 语义字号', () => {
    const { container } = render(<Kbd>K</Kbd>);
    const className = container.querySelector('kbd')!.className;
    expect(className).toContain('font-mono');
    expect(className).toContain('text-meta');
  });
});
