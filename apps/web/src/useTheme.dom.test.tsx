import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_STORAGE_KEY } from './theme';
import { useTheme } from './useTheme';

type MediaListener = () => void;

// 可控的 matchMedia：既能给出初始深浅，也能在测试里主动触发系统外观变化。
function installMatchMedia(initialDark: boolean) {
  const listeners = new Set<MediaListener>();
  const state = { matches: initialDark };
  window.matchMedia = vi.fn().mockImplementation(() => ({
    get matches() { return state.matches; },
    addEventListener: (_event: string, listener: MediaListener) => { listeners.add(listener); },
    removeEventListener: (_event: string, listener: MediaListener) => { listeners.delete(listener); }
  })) as unknown as typeof window.matchMedia;
  return { setDark(next: boolean) { state.matches = next; for (const listener of listeners) listener(); }, listenerCount: () => listeners.size };
}

function Probe() {
  const { preference, resolved, setPreference } = useTheme();
  return <div>
    <span data-testid="preference">{preference}</span>
    <span data-testid="resolved">{resolved}</span>
    <button type="button" onClick={() => setPreference('light')}>选择浅色</button>
    <button type="button" onClick={() => setPreference('system')}>回到跟随系统</button>
  </div>;
}

describe('useTheme', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('默认跟随系统，系统为深色时解析为深色且不写 data-theme', () => {
    installMatchMedia(true);
    render(<Probe/>);
    expect(screen.getByTestId('preference').textContent).toBe('system');
    expect(screen.getByTestId('resolved').textContent).toBe('dark');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('跟随系统时系统外观变化会同步反映到解析结果', () => {
    const media = installMatchMedia(false);
    render(<Probe/>);
    expect(screen.getByTestId('resolved').textContent).toBe('light');
    act(() => media.setDark(true));
    expect(screen.getByTestId('resolved').textContent).toBe('dark');
  });

  it('显式选择浅色会压过系统深色，并写入 data-theme 与持久化存储', async () => {
    const user = userEvent.setup();
    installMatchMedia(true);
    render(<Probe/>);
    await user.click(screen.getByRole('button', { name: '选择浅色' }));
    expect(screen.getByTestId('preference').textContent).toBe('light');
    expect(screen.getByTestId('resolved').textContent).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('从显式选择切回跟随系统时立即拿到当时的系统外观', async () => {
    const user = userEvent.setup();
    const media = installMatchMedia(false);
    render(<Probe/>);
    await user.click(screen.getByRole('button', { name: '选择浅色' }));
    act(() => media.setDark(true));
    expect(screen.getByTestId('resolved').textContent).toBe('light');
    await user.click(screen.getByRole('button', { name: '回到跟随系统' }));
    expect(screen.getByTestId('resolved').textContent).toBe('dark');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('启动时读取已持久化的偏好', () => {
    installMatchMedia(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    render(<Probe/>);
    expect(screen.getByTestId('preference').textContent).toBe('dark');
    expect(screen.getByTestId('resolved').textContent).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('卸载后移除系统外观监听，不留下泄漏', () => {
    const media = installMatchMedia(false);
    const view = render(<Probe/>);
    expect(media.listenerCount()).toBe(1);
    view.unmount();
    expect(media.listenerCount()).toBe(0);
  });
});
