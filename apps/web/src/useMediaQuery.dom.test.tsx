import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMediaQuery } from './useMediaQuery';

// useMediaQuery 合并 App.tsx 与 SessionList.tsx 两份逐字重复的订阅。两处都踩过同样的坑：
// jsdom / SSR 下 matchMedia 不存在会直接抛；首帧不同步取值会让移动端先按桌面布局闪一帧。
// 这两条是本文件的主要看守对象。

type MediaListener = (event: MediaQueryListEvent) => void;

/** 可控 matchMedia：能给初值、能主动触发 change、能数出监听器有没有摘干净。 */
function installMatchMedia(initialMatches: boolean) {
  const state = { matches: initialMatches };
  const listeners = new Set<MediaListener>();
  const addEventListener = vi.fn((event: string, listener: MediaListener) => { if (event === 'change') listeners.add(listener); });
  const removeEventListener = vi.fn((event: string, listener: MediaListener) => { if (event === 'change') listeners.delete(listener); });
  const matchMedia = vi.fn((query: string) => ({
    media: query,
    get matches() { return state.matches; },
    addEventListener,
    removeEventListener,
    dispatchEvent: () => true
  }));
  window.matchMedia = matchMedia as unknown as typeof window.matchMedia;
  return {
    matchMedia,
    addEventListener,
    removeEventListener,
    listenerCount: () => listeners.size,
    emit(next: boolean) {
      state.matches = next;
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
    }
  };
}

const QUERY = '(max-width: 768px)';

describe('useMediaQuery', () => {
  const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');

  beforeEach(() => { vi.restoreAllMocks(); });

  afterEach(() => {
    if (original) Object.defineProperty(window, 'matchMedia', original);
    else Reflect.deleteProperty(window, 'matchMedia');
  });

  it('window.matchMedia 缺失时返回 false，且不抛异常', () => {
    Reflect.deleteProperty(window, 'matchMedia');
    expect(typeof window.matchMedia).not.toBe('function');
    const { result, unmount } = renderHook(() => useMediaQuery(QUERY));
    expect(result.current).toBe(false);
    // 卸载路径同样不能因为拿不到 media 而炸。
    expect(() => unmount()).not.toThrow();
  });

  it('首帧就同步给出命中结果，不会先渲染一帧错的（无闪烁）', () => {
    installMatchMedia(true);
    const seen: boolean[] = [];
    function Probe() {
      const matches = useMediaQuery(QUERY);
      seen.push(matches);
      return <span data-testid="matches">{String(matches)}</span>;
    }
    render(<Probe/>);
    // 第一次渲染输出的就必须是 true，中间不能出现 false。
    expect(seen[0]).toBe(true);
    expect(seen).not.toContain(false);
  });

  it('初始不命中时首帧就是 false', () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery(QUERY));
    expect(result.current).toBe(false);
  });

  it('订阅 change 事件，媒体状态变化后重新渲染', () => {
    const media = installMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery(QUERY));
    expect(result.current).toBe(false);
    expect(media.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    act(() => media.emit(true));
    expect(result.current).toBe(true);
    act(() => media.emit(false));
    expect(result.current).toBe(false);
  });

  it('卸载时摘掉监听，不留泄漏', () => {
    const media = installMatchMedia(false);
    const { unmount } = renderHook(() => useMediaQuery(QUERY));
    expect(media.listenerCount()).toBe(1);
    unmount();
    expect(media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(media.listenerCount()).toBe(0);
  });

  it('查询语句变了会换订阅，旧的先摘掉', () => {
    const media = installMatchMedia(false);
    const { rerender } = renderHook(({ query }) => useMediaQuery(query), { initialProps: { query: QUERY } });
    expect(media.listenerCount()).toBe(1);
    rerender({ query: '(min-width: 1024px)' });
    expect(media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(media.listenerCount()).toBe(1);
    expect(media.matchMedia).toHaveBeenCalledWith('(min-width: 1024px)');
  });

  it('挂载副作用会补齐首帧之后发生的变化', () => {
    const media = installMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery(QUERY));
    expect(result.current).toBe(false);
    act(() => media.emit(true));
    expect(result.current).toBe(true);
  });
});
