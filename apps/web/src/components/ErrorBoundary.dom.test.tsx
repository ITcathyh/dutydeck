// @vitest-environment jsdom
import { lazy } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary, LazyBoundary, isChunkLoadError } from './ErrorBoundary';

// 部署后旧标签页引用的哈希 chunk 不再存在。没有错误边界时 React 19 会卸载整棵树，页面白屏只能手动刷新。

const staleChunk = () => new TypeError('Failed to fetch dynamically imported module: https://dutydeck.example.test/assets/BotManagement-0a1b2c.js');

let broken = true;
function Flaky({ label }: { label: string }) {
  if (broken) throw new Error(`渲染 ${label} 失败`);
  return <p>{label} 已恢复</p>;
}

beforeEach(() => {
  broken = true;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('ErrorBoundary', () => {
  it('懒加载 chunk 失败时只让这一块降级为「已更新，请刷新」，页面其余部分照常显示', async () => {
    const Stale = lazy(() => Promise.reject(staleChunk()));
    render(<div><nav>任务导航</nav><LazyBoundary fallback={<p>加载中</p>}><Stale/></LazyBoundary></div>);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Dutydeck 已更新');
    expect(screen.getByRole('button', { name: '刷新页面' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    expect(screen.getByText('任务导航')).toBeTruthy();
  });

  it('普通渲染错误给出错误信息和重试，重试后恢复', async () => {
    render(<ErrorBoundary><Flaky label="时间线"/></ErrorBoundary>);
    expect(screen.getByRole('alert').textContent).toContain('渲染 时间线 失败');
    broken = false;
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(screen.getByText('时间线 已恢复')).toBeTruthy();
  });

  it('resetKey 变化（如切换会话）清掉错误，不必刷新整页', () => {
    const view = render(<ErrorBoundary resetKey="session-a"><Flaky label="会话"/></ErrorBoundary>);
    expect(screen.getByRole('alert')).toBeTruthy();
    broken = false;
    view.rerender(<ErrorBoundary resetKey="session-b"><Flaky label="会话"/></ErrorBoundary>);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('会话 已恢复')).toBeTruthy();
  });

  it('整页边界只提供刷新', () => {
    render(<ErrorBoundary variant="page"><Flaky label="工作台"/></ErrorBoundary>);
    expect(screen.getByRole('alert').textContent).toContain('页面出错了');
    expect(screen.getByRole('button', { name: '刷新页面' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  });

  it('识别各浏览器的动态 import 失败文案', () => {
    expect(isChunkLoadError(staleChunk())).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module: /assets/App-1.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/App-1.css'))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
  });
});
