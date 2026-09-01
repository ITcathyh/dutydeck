// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Card } from './Card';

// 契约 §4「默认无线」：default 与 muted 靠表面色差分层，只有 dashed（空态框）
// 才允许画线。这组用例守的是「有人顺手给卡片补了一圈 border」这类回归。

const cardOf = (container: HTMLElement) => container.firstElementChild as HTMLElement;

describe('Card 语气', () => {
  it('default / muted / dashed 三档类名互不相同', () => {
    const classNames = (['default', 'muted', 'dashed'] as const).map(tone => {
      const { container, unmount } = render(<Card tone={tone}>内容</Card>);
      const value = cardOf(container).className;
      unmount();
      return value;
    });
    expect(new Set(classNames).size).toBe(3);
  });

  it('default 用表面色 + 投影分层，不画边框', () => {
    const { container } = render(<Card>内容</Card>);
    const className = cardOf(container).className;
    expect(className).toContain('bg-surface');
    expect(className).toContain('shadow-card');
    expect(className).not.toContain('border');
  });

  it('muted 用弱化底色分层，同样不画边框', () => {
    const { container } = render(<Card tone="muted">内容</Card>);
    const className = cardOf(container).className;
    expect(className).toContain('bg-muted');
    expect(className).not.toContain('border');
  });

  it('只有 dashed 例外：虚线表示「这里本该有内容」', () => {
    const { container } = render(<Card tone="dashed">空空如也</Card>);
    const className = cardOf(container).className;
    expect(className).toContain('border');
    expect(className).toContain('border-dashed');
    expect(className).toContain('border-default');
  });

  it('三档共用 rounded-lg 圆角', () => {
    for (const tone of ['default', 'muted', 'dashed'] as const) {
      const { container, unmount } = render(<Card tone={tone}>内容</Card>);
      expect(cardOf(container).className).toContain('rounded-lg');
      unmount();
    }
  });
});

describe('Card 内边距与标签', () => {
  it('none / sm / md / lg 分别是 无 / p-3 / p-4 / p-6', () => {
    for (const [padding, expected] of [['sm', 'p-3'], ['md', 'p-4'], ['lg', 'p-6']] as const) {
      const { container, unmount } = render(<Card padding={padding}>内容</Card>);
      expect(cardOf(container).className).toContain(expected);
      unmount();
    }
    const { container } = render(<Card padding="none">内容</Card>);
    const className = cardOf(container).className;
    expect(/(^|\s)p-\d/.test(className)).toBe(false);
  });

  it('默认内边距是 md', () => {
    const { container } = render(<Card>内容</Card>);
    expect(cardOf(container).className).toContain('p-4');
  });

  it('as 决定渲染出的标签，默认是 div', () => {
    const { container, unmount } = render(<Card>内容</Card>);
    expect(cardOf(container).tagName).toBe('DIV');
    unmount();
    for (const [as, tag] of [['section', 'SECTION'], ['article', 'ARTICLE'], ['aside', 'ASIDE']] as const) {
      const { container: next, unmount: dispose } = render(<Card as={as}>内容</Card>);
      expect(cardOf(next).tagName).toBe(tag);
      dispose();
    }
  });

  it('额外 className 与原生属性一起透传', () => {
    render(<Card className="mt-4" data-testid="card" aria-label="任务卡片">内容</Card>);
    const node = screen.getByTestId('card');
    expect(node.className).toContain('mt-4');
    expect(node.className).toContain('rounded-lg');
    expect(node.getAttribute('aria-label')).toBe('任务卡片');
    expect(node.textContent).toBe('内容');
  });
});
