// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';

// 按钮是全站点击入口的唯一实现，这组用例盯的是「按钮说一套做一套」类回归：
// loading 只画了转圈却仍然可点（重复提交）、尺寸档漂移到非触控高度、
// 键盘用户按 Enter/Space 点不动。

const button = () => screen.getByRole('button');

describe('Button 变体与尺寸', () => {
  it('四种 variant 渲染出互不相同的语义色类', () => {
    const classNames = (['primary', 'secondary', 'ghost', 'danger'] as const).map(variant => {
      const { unmount } = render(<Button variant={variant}>动作</Button>);
      const value = button().className;
      unmount();
      return value;
    });
    const [primary, secondary, ghost, danger] = classNames;
    expect(primary).toContain('bg-action');
    expect(secondary).toContain('bg-surface');
    expect(secondary).toContain('border-default');
    expect(ghost).toContain('bg-transparent');
    expect(danger).toContain('bg-danger-solid');
    expect(new Set(classNames).size).toBe(4);
  });

  it('sm / md / lg 对应 32 / 40 / 44px 三档触控高度', () => {
    for (const [size, height] of [['sm', 'h-8'], ['md', 'h-10'], ['lg', 'h-11']] as const) {
      const { unmount } = render(<Button size={size}>动作</Button>);
      expect(button().className).toContain(height);
      unmount();
    }
  });

  it('默认是 secondary + md（40px），不需要调用方每次显式写', () => {
    render(<Button>动作</Button>);
    const className = button().className;
    expect(className).toContain('h-10');
    expect(className).toContain('bg-surface');
    expect(className).toContain('border-default');
  });

  it('fullWidth 补 w-full，默认不占满', () => {
    const { unmount } = render(<Button>动作</Button>);
    expect(button().className).not.toContain('w-full');
    unmount();
    render(<Button fullWidth>动作</Button>);
    expect(button().className).toContain('w-full');
  });

  it('icon 与 iconEnd 都渲染进按钮内部', () => {
    render(<Button icon={<span data-testid="lead">L</span>} iconEnd={<span data-testid="trail">T</span>}>动作</Button>);
    expect(button().contains(screen.getByTestId('lead'))).toBe(true);
    expect(button().contains(screen.getByTestId('trail'))).toBe(true);
    expect(button().textContent).toContain('动作');
  });

  it('额外 className 透传，不覆盖原语自己的类', () => {
    render(<Button className="ml-auto">动作</Button>);
    expect(button().className).toContain('ml-auto');
    expect(button().className).toContain('h-10');
  });
});

describe('Button 禁用与加载态', () => {
  it('loading 同时置 aria-busy 与 disabled，点击不再触发 onClick', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>保存</Button>);
    // 只置 aria-busy 而仍可点，会让用户在请求飞行途中重复提交。
    expect(button().getAttribute('aria-busy')).toBe('true');
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    await user.click(button());
    expect(onClick).not.toHaveBeenCalled();
  });

  it('loading 时用 Spinner 顶掉 icon，转圈本身不进可访问树', () => {
    render(<Button loading icon={<span data-testid="lead">L</span>}>保存</Button>);
    expect(screen.queryByTestId('lead')).toBeNull();
    expect(button().querySelector('span[aria-hidden="true"].animate-spin')).toBeTruthy();
  });

  it('非 loading 时不留 aria-busy 属性', () => {
    render(<Button>保存</Button>);
    expect(button().hasAttribute('aria-busy')).toBe(false);
  });

  it('disabled 阻止 onClick', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>保存</Button>);
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    await user.click(button());
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Button 键盘可达', () => {
  it('聚焦后按 Enter 触发 onClick', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>提交</Button>);
    button().focus();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('聚焦后按空格触发 onClick', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>提交</Button>);
    button().focus();
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('loading 时键盘同样点不动，且拿不到焦点', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>提交</Button>);
    button().focus();
    await user.keyboard('{Enter}');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('默认 type=button，放进表单里不会误提交', () => {
    render(<Button>提交</Button>);
    expect(button().getAttribute('type')).toBe('button');
  });
});
