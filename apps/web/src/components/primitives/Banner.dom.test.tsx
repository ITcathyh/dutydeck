// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Banner } from './Banner';

// 横幅的 role 按语义分流：danger 是「有件事已经坏了」，必须打断读屏当前朗读（alert）；
// warning / info / success 是背景信息，插队播报反而扰人（status）。
// 这组用例守的是「有人把全部横幅统一成 status，错误从此不再打断读屏」这类回归。

describe('Banner role 默认分流', () => {
  it('danger 默认 role=alert', () => {
    render(<Banner tone="danger">连接失败</Banner>);
    expect(screen.getByRole('alert').textContent).toContain('连接失败');
  });

  it('warning / info / success 默认 role=status', () => {
    for (const tone of ['warning', 'info', 'success'] as const) {
      const { unmount } = render(<Banner tone={tone}>提示内容</Banner>);
      expect(screen.getByRole('status').textContent).toContain('提示内容');
      expect(screen.queryByRole('alert')).toBeNull();
      unmount();
    }
  });

  it('显式 role 压过默认值（两个方向都要能覆盖）', () => {
    const { unmount } = render(<Banner tone="danger" role="status">可以慢慢念</Banner>);
    expect(screen.getByRole('status').textContent).toContain('可以慢慢念');
    expect(screen.queryByRole('alert')).toBeNull();
    unmount();
    render(<Banner tone="info" role="alert">必须立刻念</Banner>);
    expect(screen.getByRole('alert').textContent).toContain('必须立刻念');
  });

  it('四档语气各用自己的语义软底色', () => {
    for (const tone of ['danger', 'warning', 'info', 'success'] as const) {
      const { container, unmount } = render(<Banner tone={tone}>提示内容</Banner>);
      const className = (container.firstElementChild as HTMLElement).className;
      expect(className).toContain(`bg-${tone}-soft`);
      expect(className).toContain(`border-${tone}-border`);
      expect(className).toContain(`text-${tone}`);
      unmount();
    }
  });
});

describe('Banner 标题、正文与操作', () => {
  it('title 渲染成加粗标题，children 渲染在下方', () => {
    render(<Banner tone="danger" title="任务启动失败">检查 Agent 配置后重试</Banner>);
    const title = screen.getByText('任务启动失败');
    expect(title.className).toContain('font-semibold');
    expect(screen.getByText('检查 Agent 配置后重试')).toBeTruthy();
  });

  it('不传 title 时只渲染正文', () => {
    render(<Banner tone="info">仅正文</Banner>);
    expect(screen.getByRole('status').querySelector('.font-semibold')).toBeNull();
    expect(screen.getByText('仅正文')).toBeTruthy();
  });

  it('action 渲染成按钮并回调 onClick', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Banner tone="danger" action={{ label: '重试', onClick }}>连接失败</Banner>);
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('action.busy 时按钮 aria-busy 且点不动，不会重复提交', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Banner tone="danger" action={{ label: '重试', onClick, busy: true }}>连接失败</Banner>);
    const retry = screen.getByRole('button', { name: '重试' });
    expect(retry.getAttribute('aria-busy')).toBe('true');
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    await user.click(retry);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('不传 action 时没有额外按钮', () => {
    render(<Banner tone="info">仅正文</Banner>);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('Banner 关闭按钮', () => {
  it('onDismiss 渲染出带中文 aria-label 的关闭钮并回调', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<Banner tone="warning" onDismiss={onDismiss}>可以关掉</Banner>);
    await user.click(screen.getByRole('button', { name: '关闭提示' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('不传 onDismiss 时不渲染关闭钮', () => {
    render(<Banner tone="warning">关不掉</Banner>);
    expect(screen.queryByRole('button', { name: '关闭提示' })).toBeNull();
  });

  it('action 与 onDismiss 可以并存，互不吞掉对方', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const onDismiss = vi.fn();
    render(<Banner tone="danger" title="失败" action={{ label: '重试', onClick }} onDismiss={onDismiss}>连接失败</Banner>);
    await user.click(screen.getByRole('button', { name: '重试' }));
    await user.click(screen.getByRole('button', { name: '关闭提示' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
