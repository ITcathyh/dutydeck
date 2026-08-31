import { create } from 'zustand';

// 轻量 toast 通道：mutation 成功/失败后给出「结论 + 下一步」，取代「成功完全静默」。
//
// 为什么是 module store 而不是 React state：push 的调用点在 useMutation 的
// onSuccess / onError 里，那里不在 render 期间，也拿不到 hook。所以状态和定时器
// 都放在模块级，React 侧只订阅快照（useToasts），非 React 侧直接用 toastStore。

export type ToastKind = 'success' | 'error' | 'info' | 'warning';
export type ToastAction = { label: string; run(): void | Promise<void> };
export type Toast = {
  id: string;
  kind: ToastKind;
  title: string;
  description?: string;
  action?: ToastAction;
  /** 去重键：同 key 的新 toast 原地替换旧的，避免连点重试堆出 3 条一样的通知。与 React 的 key 无关。 */
  key?: string;
  /** 0 / Infinity / NaN 都视为常驻，需要用户手动关闭。 */
  durationMs: number;
  createdAt: number;
};
export type ToastInput = Omit<Toast, 'id' | 'createdAt' | 'durationMs'> & { durationMs?: number };

/** 同时可见的上限。超过时淘汰最旧的一条，保证屏幕右下角不会被通知糊满。 */
export const MAX_TOASTS = 3;

/**
 * 每类默认存活时长。排序依据是「用户读完并做出判断需要多久」：
 * - success 4s：只是确认动作已落地，一眼扫完即可，久留反而挡住 composer。
 * - info 5s：通常带一句补充说明，比纯确认多一点阅读量。
 * - warning 7s：「注意」类文案要求用户记住一个约束，需要读完整句。
 * - error 10s：失败文案是服务端原文 + 下一步，最长；且 4.3 节要求失败必须指向恢复，
 *   所以给足时间；真正必须处理的失败由调用方显式传 durationMs: 0 变成常驻。
 */
export const TOAST_DURATIONS: Record<ToastKind, number> = { success: 4_000, info: 5_000, warning: 7_000, error: 10_000 };

/**
 * 带操作按钮（如撤销）的 toast 的最短存活时长。
 * 10s 的依据：用户要先读完标题确认「撤销的是哪一条」，再把鼠标/手指移到按钮上；
 * 移动端还要跨过半个屏幕。低于 6s 时按钮经常在手指到位前就消失，等于这个能力不存在。
 * error + action 更进一步：直接常驻，因为失败后的恢复动作不该有倒计时压力。
 */
export const ACTION_MIN_DURATION_MS = 10_000;

/** 常驻判定：非正数与非有限值都不排定时器。 */
export const isStickyDuration = (durationMs: number) => !(durationMs > 0) || !Number.isFinite(durationMs);

const resolveDuration = (input: ToastInput) => {
  if (input.durationMs !== undefined) return input.durationMs; // 调用方显式指定优先，含 0 / Infinity
  if (!input.action) return TOAST_DURATIONS[input.kind];
  return input.kind === 'error' ? 0 : Math.max(TOAST_DURATIONS[input.kind], ACTION_MIN_DURATION_MS);
};

type ToastState = { toasts: Toast[] };
// toasts 按时间升序（旧 → 新）。视口自底向上贴边渲染，于是最新一条离屏幕底边最近。
const useToastState = create<ToastState>(() => ({ toasts: [] }));

const timers = new Map<string, ReturnType<typeof setTimeout>>();
let sequence = 0; // 单调计数器而非 Math.random()：id 可预期，测试可断言顺序

const clearTimer = (id: string) => {
  const timer = timers.get(id);
  if (timer === undefined) return;
  clearTimeout(timer);
  timers.delete(id);
};

const armTimer = (toast: Toast) => {
  clearTimer(toast.id);
  if (isStickyDuration(toast.durationMs)) return;
  timers.set(toast.id, setTimeout(() => { timers.delete(toast.id); dismiss(toast.id); }, toast.durationMs));
};

/** 推入一条通知，返回它的 id（可用于提前 dismiss）。可在 React 之外调用。 */
export function push(input: ToastInput): string {
  const toast: Toast = { ...input, id: `toast-${++sequence}`, durationMs: resolveDuration(input), createdAt: Date.now() };
  useToastState.setState(state => {
    const replaced = toast.key === undefined ? undefined : state.toasts.find(existing => existing.key === toast.key);
    // 同 key 原地替换：保持位置不跳动，同时重置倒计时（下面统一 armTimer）
    if (replaced) { clearTimer(replaced.id); return { toasts: state.toasts.map(existing => existing === replaced ? toast : existing) }; }
    const next = [...state.toasts, toast];
    while (next.length > MAX_TOASTS) clearTimer(next.shift()!.id); // 淘汰最旧的，并回收它的定时器
    return { toasts: next };
  });
  armTimer(toast);
  return toast.id;
}

/** 移除一条通知；同时回收它的定时器，避免已移除的 toast 再触发一次 setState。 */
export function dismiss(id: string): void {
  clearTimer(id);
  useToastState.setState(state => state.toasts.some(toast => toast.id === id) ? { toasts: state.toasts.filter(toast => toast.id !== id) } : state);
}

/** 清空全部通知（例如切换 session 时），所有定时器一并回收。 */
export function clear(): void {
  for (const id of [...timers.keys()]) clearTimer(id);
  useToastState.setState(state => state.toasts.length ? { toasts: [] } : state);
}

/**
 * 命令式入口：给 useMutation 回调、api 层等 React 之外的调用点使用。
 * subscribe / getSnapshot 保持 useSyncExternalStore 的签名，便于将来换实现。
 */
export const toastStore = {
  push,
  dismiss,
  clear,
  subscribe: (listener: () => void) => useToastState.subscribe(() => listener()),
  getSnapshot: () => useToastState.getState().toasts,
  /** 仅用于「定时器泄漏」回归测试：正常代码不要依赖它。 */
  pendingTimerCount: () => timers.size
};

export type ToastsController = { toasts: Toast[]; push(input: ToastInput): string; dismiss(id: string): void; clear(): void };

/** React 侧订阅入口。push / dismiss / clear 是模块级函数，引用恒定，可直接进依赖数组。 */
export function useToasts(): ToastsController {
  const toasts = useToastState(state => state.toasts);
  return { toasts, push, dismiss, clear };
}
