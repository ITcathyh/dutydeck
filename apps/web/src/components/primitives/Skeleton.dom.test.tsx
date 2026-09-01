// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Skeleton } from './Skeleton';

// 骨架是「内容还没到」的视觉占位，读屏念出一串空盒子毫无意义：整块 aria-hidden。
// aria-hidden 的节点不会出现在 role 查询里，所以这里一律用 container 查询断言。

const rootOf = (container: HTMLElement) => container.firstElementChild as HTMLElement;
const barsOf = (container: HTMLElement) => [...rootOf(container).children] as HTMLElement[];

describe('Skeleton 可访问性', () => {
  it('整块 aria-hidden + role=presentation，不进可访问树', () => {
    const { container } = render(<Skeleton/>);
    const root = rootOf(container);
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(root.getAttribute('role')).toBe('presentation');
  });

  it('骨架自己不挂 aria-live，播报交给 Spinner', () => {
    const { container } = render(<Skeleton lines={3}/>);
    expect(container.querySelector('[aria-live]')).toBeNull();
  });
});

describe('Skeleton 变体与行数', () => {
  it('text / block / row 三档形状类互不相同', () => {
    const shapes = (['text', 'block', 'row'] as const).map(variant => {
      const { container, unmount } = render(<Skeleton variant={variant}/>);
      const value = barsOf(container)[0].className;
      unmount();
      return value;
    });
    const [text, block, row] = shapes;
    expect(text).toContain('h-3.5');
    expect(text).toContain('rounded-sm');
    expect(block).toContain('h-20');
    expect(block).toContain('rounded-md');
    expect(row).toContain('h-12');
    expect(row).toContain('rounded-md');
    expect(new Set(shapes).size).toBe(3);
  });

  it('默认变体是 text，默认一行', () => {
    const { container } = render(<Skeleton/>);
    const bars = barsOf(container);
    expect(bars.length).toBe(1);
    expect(bars[0].className).toContain('h-3.5');
  });

  it('lines 渲染出对应条数的占位条', () => {
    for (const lines of [1, 2, 5]) {
      const { container, unmount } = render(<Skeleton lines={lines}/>);
      expect(barsOf(container).length).toBe(lines);
      unmount();
    }
  });

  it('lines 小于 1 时至少画一条，不渲染成空块', () => {
    const { container } = render(<Skeleton lines={0}/>);
    expect(barsOf(container).length).toBe(1);
  });

  it('多行文本骨架的最后一行收窄到 2/3，看着像自然段落', () => {
    const { container } = render(<Skeleton lines={3}/>);
    const bars = barsOf(container);
    expect(bars[0].className).not.toContain('w-2/3');
    expect(bars[1].className).not.toContain('w-2/3');
    expect(bars.at(-1)!.className).toContain('w-2/3');
  });

  it('每条占位条都在脉动，用的是 bg-muted 语义底色', () => {
    const { container } = render(<Skeleton variant="row" lines={2}/>);
    for (const bar of barsOf(container)) {
      expect(bar.className).toContain('animate-pulse');
      expect(bar.className).toContain('bg-muted');
    }
  });
});

describe('Skeleton 样式透传', () => {
  it('自定义 className 挂在外层，且不冲掉 space-y-2', () => {
    const { container } = render(<Skeleton className="mt-3 w-40"/>);
    const root = rootOf(container);
    expect(root.className).toContain('mt-3');
    expect(root.className).toContain('w-40');
    expect(root.className).toContain('space-y-2');
  });
});
