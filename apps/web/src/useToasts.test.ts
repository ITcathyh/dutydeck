import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION_MIN_DURATION_MS, MAX_TOASTS, TOAST_DURATIONS, isStickyDuration, toastStore, useToasts } from './useToasts';

// toast store 是全局模块状态，用例之间必须清干净，否则上一条通知会污染下一个用例的快照。
// 同时用假定时器：自动消失的时长是这个模块最容易被误改的部分，必须精确到毫秒断言。

const titles = () => toastStore.getSnapshot().map(toast => toast.title);

beforeEach(() => {
  vi.useFakeTimers();
  toastStore.clear();
});

afterEach(() => {
  toastStore.clear();
  vi.useRealTimers();
});

describe('toastStore 基础行为', () => {
  it('push 返回可用于 dismiss 的 id，且 id 不重复', () => {
    const first = toastStore.push({ kind: 'success', title: '已发送指令' });
    const second = toastStore.push({ kind: 'success', title: '已归档任务运行' });
    expect(first).not.toBe(second);
    expect(toastStore.getSnapshot().map(toast => toast.id)).toEqual([first, second]);
    toastStore.dismiss(first);
    expect(titles()).toEqual(['已归档任务运行']);
  });

  it('dismiss 不存在的 id 不抛错、也不改变快照引用', () => {
    toastStore.push({ kind: 'info', title: '已加载更早的执行记录' });
    const before = toastStore.getSnapshot();
    toastStore.dismiss('toast-not-there');
    expect(toastStore.getSnapshot()).toBe(before);
  });

  it('clear 清空全部通知', () => {
    toastStore.push({ kind: 'success', title: '已重启任务运行' });
    toastStore.push({ kind: 'error', title: '重启失败' });
    toastStore.clear();
    expect(titles()).toEqual([]);
  });

  it('可以在 React 之外调用（模拟 useMutation 的 onError 回调）', () => {
    const onError = (error: Error) => toastStore.push({ kind: 'error', title: '取消待执行指令失败', description: error.message });
    onError(new Error('服务端拒绝了该操作'));
    expect(toastStore.getSnapshot()[0]).toMatchObject({ kind: 'error', title: '取消待执行指令失败', description: '服务端拒绝了该操作' });
  });
});

describe('数量上限与淘汰', () => {
  it(`最多同时保留 ${MAX_TOASTS} 条，第 4 条挤掉最旧的一条`, () => {
    for (const title of ['第一条', '第二条', '第三条']) toastStore.push({ kind: 'info', title });
    expect(titles()).toEqual(['第一条', '第二条', '第三条']);
    toastStore.push({ kind: 'info', title: '第四条' });
    expect(titles()).toEqual(['第二条', '第三条', '第四条']);
  });

  it('连续超量 push 后仍只剩最新的 3 条，顺序为旧到新', () => {
    for (let index = 1; index <= 7; index++) toastStore.push({ kind: 'info', title: `第 ${index} 条` });
    expect(titles()).toEqual(['第 5 条', '第 6 条', '第 7 条']);
  });

  it('被淘汰的通知不会在它原本的时间点再触发一次 setState（定时器已回收）', () => {
    toastStore.push({ kind: 'error', title: '会被挤掉的失败通知' }); // error 10s
    for (const title of ['A', 'B', 'C']) toastStore.push({ kind: 'success', title });
    expect(titles()).toEqual(['A', 'B', 'C']);
    // 只剩 3 条 success 的定时器，被淘汰的 error 定时器必须已经清掉
    expect(toastStore.pendingTimerCount()).toBe(3);
    vi.advanceTimersByTime(TOAST_DURATIONS.error + 1_000);
    expect(titles()).toEqual([]);
    expect(toastStore.pendingTimerCount()).toBe(0);
  });
});

describe('自动消失时长', () => {
  it('success 4s / info 5s / warning 7s / error 10s：失败一定比成功停留更久', () => {
    expect(TOAST_DURATIONS).toEqual({ success: 4_000, info: 5_000, warning: 7_000, error: 10_000 });
    expect(TOAST_DURATIONS.error).toBeGreaterThan(TOAST_DURATIONS.success);
    expect(TOAST_DURATIONS.warning).toBeGreaterThan(TOAST_DURATIONS.success);
  });

  it.each([['success', 4_000], ['info', 5_000], ['warning', 7_000], ['error', 10_000]] as const)('%s 在 %ims 时消失，差 1ms 时仍在', (kind, duration) => {
    toastStore.push({ kind, title: `${kind} 通知` });
    vi.advanceTimersByTime(duration - 1);
    expect(titles()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(titles()).toEqual([]);
  });

  it('多条通知各自独立计时，先到的先消失', () => {
    toastStore.push({ kind: 'success', title: '已发送指令' }); // 4s
    toastStore.push({ kind: 'error', title: '发送失败' }); // 10s
    vi.advanceTimersByTime(TOAST_DURATIONS.success);
    expect(titles()).toEqual(['发送失败']);
    vi.advanceTimersByTime(TOAST_DURATIONS.error - TOAST_DURATIONS.success);
    expect(titles()).toEqual([]);
  });

  it('显式 durationMs 覆盖该类默认值', () => {
    toastStore.push({ kind: 'error', title: '一闪而过的失败', durationMs: 1_000 });
    vi.advanceTimersByTime(1_000);
    expect(titles()).toEqual([]);
  });
});

describe('常驻通知', () => {
  it('durationMs 为 0 时常驻，推进很久也不消失，只能手动关闭', () => {
    const id = toastStore.push({ kind: 'error', title: '有 1 处授权请求等待处理', durationMs: 0 });
    expect(toastStore.pendingTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * 60_000);
    expect(titles()).toEqual(['有 1 处授权请求等待处理']);
    toastStore.dismiss(id);
    expect(titles()).toEqual([]);
  });

  it('durationMs 为 Infinity 时同样常驻', () => {
    toastStore.push({ kind: 'warning', title: '模型列表仍是缓存值', durationMs: Number.POSITIVE_INFINITY });
    vi.advanceTimersByTime(60 * 60_000);
    expect(titles()).toHaveLength(1);
  });

  it('isStickyDuration 覆盖 0 / Infinity / 负数 / NaN', () => {
    expect(isStickyDuration(0)).toBe(true);
    expect(isStickyDuration(Number.POSITIVE_INFINITY)).toBe(true);
    expect(isStickyDuration(-1)).toBe(true);
    expect(isStickyDuration(Number.NaN)).toBe(true);
    expect(isStickyDuration(1)).toBe(false);
  });
});

describe('带操作的通知（撤销）', () => {
  it('带操作的 success 至少存活 10s，够用户把手指移到按钮上', () => {
    toastStore.push({ kind: 'success', title: '已取消 1 条待执行指令', action: { label: '恢复这条指令', run: () => {} } });
    const toast = toastStore.getSnapshot()[0];
    expect(toast.durationMs).toBe(ACTION_MIN_DURATION_MS);
    expect(toast.durationMs).toBeGreaterThan(TOAST_DURATIONS.success);
    // 到 success 默认时长时按钮必须还在
    vi.advanceTimersByTime(TOAST_DURATIONS.success);
    expect(titles()).toHaveLength(1);
    vi.advanceTimersByTime(ACTION_MIN_DURATION_MS - TOAST_DURATIONS.success);
    expect(titles()).toEqual([]);
  });

  it('带操作的 error 直接常驻：失败后的恢复动作不给倒计时压力', () => {
    toastStore.push({ kind: 'error', title: '发送指令失败', action: { label: '重新发送这条指令', run: () => {} } });
    expect(toastStore.getSnapshot()[0].durationMs).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(titles()).toHaveLength(1);
  });

  it('带操作时显式 durationMs 仍然优先（调用方可以自己决定）', () => {
    toastStore.push({ kind: 'success', title: '已取消 1 条待执行指令', durationMs: 2_000, action: { label: '恢复这条指令', run: () => {} } });
    vi.advanceTimersByTime(2_000);
    expect(titles()).toEqual([]);
  });

  it('action.run 支持异步：await 得到的是调用方的 Promise', async () => {
    const order: string[] = [];
    toastStore.push({ kind: 'success', title: '已取消 1 条待执行指令', action: { label: '恢复这条指令', run: async () => { order.push('start'); await Promise.resolve(); order.push('end'); } } });
    await toastStore.getSnapshot()[0].action!.run();
    expect(order).toEqual(['start', 'end']);
  });
});

describe('按 key 去重', () => {
  it('同 key 的新通知原地替换旧的，不堆叠', () => {
    toastStore.push({ kind: 'error', title: '刷新模型列表失败', description: '第 1 次', key: 'refresh-models' });
    toastStore.push({ kind: 'error', title: '刷新模型列表失败', description: '第 2 次', key: 'refresh-models' });
    toastStore.push({ kind: 'error', title: '刷新模型列表失败', description: '第 3 次', key: 'refresh-models' });
    expect(toastStore.getSnapshot()).toHaveLength(1);
    expect(toastStore.getSnapshot()[0].description).toBe('第 3 次');
    expect(toastStore.pendingTimerCount()).toBe(1);
  });

  it('替换保持原位置，不把已有通知顶到末尾', () => {
    toastStore.push({ kind: 'info', title: '最旧' });
    toastStore.push({ kind: 'error', title: '刷新模型列表失败', key: 'refresh-models' });
    toastStore.push({ kind: 'info', title: '最新' });
    toastStore.push({ kind: 'error', title: '刷新模型列表失败（重试后）', key: 'refresh-models' });
    expect(titles()).toEqual(['最旧', '刷新模型列表失败（重试后）', '最新']);
  });

  it('替换会重置倒计时：旧定时器不能提前收走新通知', () => {
    toastStore.push({ kind: 'error', title: '刷新模型列表失败', key: 'refresh-models' });
    vi.advanceTimersByTime(TOAST_DURATIONS.error - 500);
    toastStore.push({ kind: 'error', title: '刷新模型列表失败（重试后）', key: 'refresh-models' });
    vi.advanceTimersByTime(600); // 若沿用旧定时器，这里已经被收走
    expect(titles()).toEqual(['刷新模型列表失败（重试后）']);
    vi.advanceTimersByTime(TOAST_DURATIONS.error);
    expect(titles()).toEqual([]);
  });

  it('没有 key 的相同文案照常堆叠（去重必须显式声明）', () => {
    toastStore.push({ kind: 'error', title: '刷新模型列表失败' });
    toastStore.push({ kind: 'error', title: '刷新模型列表失败' });
    expect(toastStore.getSnapshot()).toHaveLength(2);
  });
});

describe('定时器清理', () => {
  it('手动 dismiss 后定时器立即回收，到点不再触发', () => {
    const id = toastStore.push({ kind: 'success', title: '已切换模型' });
    expect(toastStore.pendingTimerCount()).toBe(1);
    toastStore.dismiss(id);
    expect(toastStore.pendingTimerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clear 回收全部定时器', () => {
    toastStore.push({ kind: 'success', title: 'A' });
    toastStore.push({ kind: 'error', title: 'B' });
    toastStore.push({ kind: 'warning', title: 'C' });
    expect(toastStore.pendingTimerCount()).toBe(3);
    toastStore.clear();
    expect(toastStore.pendingTimerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('自动消失后自身定时器也不残留', () => {
    toastStore.push({ kind: 'success', title: '已发送指令' });
    vi.advanceTimersByTime(TOAST_DURATIONS.success);
    expect(toastStore.pendingTimerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('useToasts 订阅', () => {
  // renderHook 而不是自建探针组件：这个文件是纯 .ts，不写 JSX；
  // 视口层的 DOM 行为由 ToastViewport.dom.test.tsx 覆盖，这里只验证订阅与清理。
  it('在 React 之外 push，hook 能拿到更新后的列表', () => {
    const { result } = renderHook(() => useToasts());
    expect(result.current.toasts).toEqual([]);
    act(() => { toastStore.push({ kind: 'success', title: '已发送指令' }); });
    expect(result.current.toasts.map(toast => toast.title)).toEqual(['已发送指令']);
  });

  it('定时器到点时 hook 同步收起该通知', () => {
    const { result } = renderHook(() => useToasts());
    act(() => { toastStore.push({ kind: 'success', title: '已归档任务运行' }); });
    expect(result.current.toasts).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(TOAST_DURATIONS.success); });
    expect(result.current.toasts).toEqual([]);
  });

  it('通过 hook 的 push / dismiss 操作与 store 是同一份状态', () => {
    const { result } = renderHook(() => useToasts());
    let id = '';
    act(() => { id = result.current.push({ kind: 'info', title: '已加载更早的执行记录' }); });
    expect(toastStore.getSnapshot()).toHaveLength(1);
    act(() => { result.current.dismiss(id); });
    expect(result.current.toasts).toEqual([]);
    expect(toastStore.getSnapshot()).toEqual([]);
  });

  it('组件卸载后定时器仍能安全触发，不报 setState-after-unmount', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = renderHook(() => useToasts());
    act(() => { toastStore.push({ kind: 'success', title: '已切换思考强度' }); });
    unmount();
    act(() => { vi.advanceTimersByTime(TOAST_DURATIONS.success); });
    expect(toastStore.getSnapshot()).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('hook 暴露的 push / dismiss / clear 引用稳定，可安全进依赖数组', () => {
    const { result, rerender } = renderHook(() => useToasts());
    const first = result.current;
    rerender();
    expect(result.current.push).toBe(first.push);
    expect(result.current.dismiss).toBe(first.dismiss);
    expect(result.current.clear).toBe(first.clear);
  });
});
