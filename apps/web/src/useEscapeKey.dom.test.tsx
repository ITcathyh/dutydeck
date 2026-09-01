import { renderHook } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEscapeKey } from './useEscapeKey';

// useEscapeKey 是全站唯一的 Escape 监听实现，合并了 7 处原本行为不一致的浮层。
// 两条硬约束在这里守：enabled=false 时必须彻底不响应（提交中不能把写操作丢在半路），
// 以及 handler 走 ref、换了内联箭头函数也不重挂监听、不丢事件。

describe('useEscapeKey', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('enabled 时按 Escape 调用 handler', async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    renderHook(() => useEscapeKey(true, handler));
    await user.keyboard('{Escape}');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('enabled=false 时按 Escape 完全不回调（提交中不允许被关掉）', async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    renderHook(() => useEscapeKey(false, handler));
    await user.keyboard('{Escape}');
    expect(handler).not.toHaveBeenCalled();
  });

  it('enabled 从 false 翻到 true 后才开始响应，翻回 false 立即停', async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    const { rerender } = renderHook(({ enabled }) => useEscapeKey(enabled, handler), { initialProps: { enabled: false } });
    await user.keyboard('{Escape}');
    expect(handler).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await user.keyboard('{Escape}');
    expect(handler).toHaveBeenCalledTimes(1);
    rerender({ enabled: false });
    await user.keyboard('{Escape}');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('其它按键一律忽略', async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    renderHook(() => useEscapeKey(true, handler));
    await user.keyboard('{Enter}{Tab}{ArrowDown} a');
    expect(handler).not.toHaveBeenCalled();
  });

  it('卸载后摘掉 document 上的监听', async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    const removeEventListener = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() => useEscapeKey(true, handler));
    unmount();
    expect(removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function));
    await user.keyboard('{Escape}');
    expect(handler).not.toHaveBeenCalled();
  });

  it('换了 handler 直接生效，调用的是最新那个而不是首帧那个', async () => {
    const user = userEvent.setup();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ handler }) => useEscapeKey(true, handler), { initialProps: { handler: first } });
    await user.keyboard('{Escape}');
    expect(first).toHaveBeenCalledTimes(1);
    rerender({ handler: second });
    await user.keyboard('{Escape}');
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('handler 每帧都换（内联箭头函数）也不重挂监听，事件不会丢在挂载间隙', async () => {
    const user = userEvent.setup();
    const calls: number[] = [];
    const addEventListener = vi.spyOn(document, 'addEventListener');
    const { rerender } = renderHook(({ tick }) => useEscapeKey(true, () => calls.push(tick)), { initialProps: { tick: 1 } });
    const keydownMounts = () => addEventListener.mock.calls.filter(call => call[0] === 'keydown').length;
    expect(keydownMounts()).toBe(1);
    for (const tick of [2, 3, 4]) rerender({ tick });
    expect(keydownMounts()).toBe(1);
    await user.keyboard('{Escape}');
    expect(calls).toEqual([4]);
  });

  it('阻止默认行为，避免 Escape 同时被浏览器原生行为消费', () => {
    const handler = vi.fn();
    renderHook(() => useEscapeKey(true, handler));
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    document.dispatchEvent(event);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  /*
    嵌套场景：Dialog 里开一个 Popover（NewSessionModal 的 Agent 选择器就是这个形状）。
    一次 Escape 只能收起最上面那一层；两层一起关会让用户在想收下拉时丢掉整张表单。
  */
  it('嵌套时只有最上层响应，一次 Escape 不会连关两层', async () => {
    const user = userEvent.setup();
    const outer = vi.fn();
    const inner = vi.fn();
    renderHook(() => useEscapeKey(true, outer));
    const innerHook = renderHook(() => useEscapeKey(true, inner));

    await user.keyboard('{Escape}');
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();

    // 上层收起后，Escape 才轮到下层。
    innerHook.unmount();
    await user.keyboard('{Escape}');
    expect(outer).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
