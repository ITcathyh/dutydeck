// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Spinner } from './Spinner';

// 读屏用户看不到转圈：带文案时必须 role=status + aria-live=polite 才念得出来；
// 不带文案时纯装饰，整块 aria-hidden，否则每个加载态都会念一个无意义的图形节点。

describe('Spinner 无文案（纯装饰）', () => {
  it('不进可访问树：没有 role=status，节点本身 aria-hidden', () => {
    const { container } = render(<Spinner/>);
    expect(screen.queryByRole('status')).toBeNull();
    const circle = container.firstElementChild as HTMLElement;
    expect(circle.getAttribute('aria-hidden')).toBe('true');
    expect(circle.className).toContain('animate-spin');
  });
});

describe('Spinner 带文案', () => {
  it('role=status + aria-live=polite，文案念得出来', () => {
    render(<Spinner label="正在保存…"/>);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toContain('正在保存…');
  });

  it('转圈本身仍 aria-hidden，只念文案不念图形', () => {
    render(<Spinner label="正在保存…"/>);
    const status = screen.getByRole('status');
    const circle = status.querySelector('span[aria-hidden="true"]')!;
    expect(circle.className).toContain('animate-spin');
    expect(circle.textContent).toBe('');
  });

  it('文案用 text-caption 语义字号', () => {
    render(<Spinner label="正在保存…"/>);
    expect(screen.getByRole('status').className).toContain('text-caption');
  });
});

describe('Spinner 尺寸', () => {
  it('sm 与 md 尺寸类不同（3.5 与 5）', () => {
    const { container, unmount } = render(<Spinner size="sm"/>);
    const sm = (container.firstElementChild as HTMLElement).className;
    unmount();
    const { container: next } = render(<Spinner size="md"/>);
    const md = (next.firstElementChild as HTMLElement).className;
    expect(sm).toContain('h-3.5');
    expect(sm).toContain('w-3.5');
    expect(md).toContain('h-5');
    expect(md).toContain('w-5');
    expect(sm).not.toBe(md);
  });

  it('默认尺寸是 sm', () => {
    const { container } = render(<Spinner/>);
    expect((container.firstElementChild as HTMLElement).className).toContain('h-3.5');
  });

  it('带文案时尺寸依旧作用在转圈上', () => {
    render(<Spinner size="md" label="正在保存…"/>);
    const circle = screen.getByRole('status').querySelector('span[aria-hidden="true"]')!;
    expect(circle.className).toContain('h-5');
  });
});
