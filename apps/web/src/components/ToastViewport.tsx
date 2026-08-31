import { useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { dismiss as dismissToast, useToasts, type Toast, type ToastKind } from '../useToasts';

// 每类通知的文本标签 + 语义 token。
// 文本标签是硬要求：交互蓝图 §1「不用颜色单独表意」——绿色/红色底加图标不足以表意，
// 色觉障碍用户和读屏用户都必须能读到「成功 / 失败」这几个字。
const kindMeta: Record<ToastKind, { label: string; icon: typeof CheckCircle2; text: string; soft: string; border: string }> = {
  success: { label: '成功', icon: CheckCircle2, text: 'text-[var(--status-success)]', soft: 'bg-[var(--status-success-soft)]', border: 'border-[var(--status-success-border)]' },
  error: { label: '失败', icon: AlertCircle, text: 'text-[var(--status-danger)]', soft: 'bg-[var(--status-danger-soft)]', border: 'border-[var(--status-danger-border)]' },
  info: { label: '提示', icon: Info, text: 'text-[var(--status-info)]', soft: 'bg-[var(--status-info-soft)]', border: 'border-[var(--status-info-border)]' },
  warning: { label: '注意', icon: AlertTriangle, text: 'text-[var(--status-warning)]', soft: 'bg-[var(--status-warning-soft)]', border: 'border-[var(--status-warning-border)]' }
};

/** 断言式（role="alert"）通道承载的类型：失败必须打断读屏当前朗读，警告同理；成功/提示走礼貌通道。 */
const assertiveKinds = new Set<ToastKind>(['error', 'warning']);

export type ToastViewportProps = { toasts?: Toast[]; onDismiss?(id: string): void };

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss(id: string): void }) {
  const meta = kindMeta[toast.kind];
  const Icon = meta.icon;
  const [running, setRunning] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const runAction = async () => {
    if (!toast.action || running) return;
    setRunning(true);
    setActionError(undefined);
    // action 可能是异步的（撤销要重新打一次接口）。成功才收起这条通知；
    // 失败时留在原地并就地写出原因 —— 既不把 rejection 泄漏成 unhandled rejection，
    // 也不假装操作成功（诚实表达系统能力），用户可以直接重试。
    // 调用方契约：如果 run() 自己已经 push 了失败通知，就在 run() 内部 catch 并正常 resolve，
    // 这张卡片会直接收起，不会重复报错。
    try {
      await toast.action.run();
      onDismiss(toast.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      setRunning(false);
    }
  };
  return <div className={`ui-toast pointer-events-auto flex w-full items-start gap-2.5 rounded-xl border ${meta.border} bg-[var(--surface-raised)] p-3 shadow-[var(--shadow-panel)] sm:w-[352px]`}>
    <div className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${meta.soft} ${meta.text}`}><Icon size={15} strokeWidth={1.9} aria-hidden="true"/></div>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span className={`shrink-0 rounded px-1 py-px text-[11px] font-semibold ${meta.soft} ${meta.text}`}>{meta.label}</span>
        <p className="min-w-0 text-[13px] font-semibold leading-5 tracking-[-.01em] text-[var(--text-primary)]">{toast.title}</p>
      </div>
      {toast.description && <p className="mt-1 text-[12px] leading-5 text-[var(--text-secondary)]">{toast.description}</p>}
      {actionError && <p className="mt-1.5 rounded-lg border border-[var(--status-danger-border)] bg-[var(--status-danger-soft)] px-2 py-1.5 text-[11px] leading-4 text-[var(--status-danger)]">{`${toast.action?.label ?? '该操作'}没有成功：${actionError}`}</p>}
      {toast.action && <button type="button" disabled={running} onClick={() => { void runAction(); }} className="mt-2 inline-flex min-h-10 items-center rounded-lg bg-[var(--action-soft)] px-3 text-[12px] font-semibold text-[var(--action-primary)] transition-[background-color,transform] active:scale-[.98] hover:bg-[var(--action-soft-hover)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50">{running ? '正在执行' : actionError ? `重试${toast.action.label}` : toast.action.label}</button>}
    </div>
    <button type="button" aria-label={`关闭通知：${toast.title}`} onClick={() => onDismiss(toast.id)} className="grid min-h-10 min-w-10 shrink-0 place-items-center rounded-lg text-[var(--text-muted)] transition-[color,background-color] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] focus-visible:outline-none"><X size={15} strokeWidth={2} aria-hidden="true"/></button>
  </div>;
}

/**
 * 通知视口：挂一次在根节点即可。零 props 时自己订阅 store（App 的用法），
 * 传入 toasts / onDismiss 时以 props 为准，便于在不碰全局状态的前提下做 DOM 测试。
 *
 * 为什么是「两个堆叠的 live region」而不是一个：
 * aria-live 的礼貌级别只能挂在容器上，无法按条目切换。要让失败立刻打断读屏、
 * 同时让成功不打断用户当前朗读，唯一可靠的做法就是常驻两个容器——
 * 礼貌区（success / info）与断言区（role="alert"，error / warning），按 kind 分流。
 * 两个容器必须始终存在于 DOM 中：live region 若与内容同时插入，读屏通常不播报。
 * 断言区放在后面，于是失败通知贴着屏幕底边，是最显眼、最容易点到的位置。
 *
 * 通知不是模态：不抢焦点、不设 autoFocus、不做焦点陷阱，容器 pointer-events-none
 * 只让卡片本体可点，空白处仍能穿透点到底下的界面。
 */
export function ToastViewport({ toasts, onDismiss }: ToastViewportProps = {}) {
  const store = useToasts();
  const list = toasts ?? store.toasts;
  const handleDismiss = onDismiss ?? dismissToast;
  const polite = list.filter(toast => !assertiveKinds.has(toast.kind));
  const assertive = list.filter(toast => assertiveKinds.has(toast.kind));
  // 底部固定：桌面靠右下角，移动端整宽贴底并让出安全区，避免压住 composer 的发送按钮。
  //
  // 这里用 aria-live 而不是 role="status" / role="alert"：两者的播报行为等价
  // （role="alert" 等于 aria-live="assertive" + aria-atomic="true"），
  // 但 role 会把这两个常驻空容器登记进无障碍树的 status/alert 角色里，
  // 与页面自身的错误条、过期数据条抢同一个角色查询——读屏用户会听到两个竞争的 alert，
  // 测试里 getByRole('alert') 也会命中这个空容器。用 aria-live 保留播报、不占角色。
  return <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-col px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:inset-x-auto sm:right-4 sm:items-end">
    <div aria-live="polite" aria-atomic="false" aria-label="操作结果通知" className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
      {polite.map(toast => <ToastCard key={toast.id} toast={toast} onDismiss={handleDismiss}/>)}
    </div>
    <div aria-live="assertive" aria-atomic="false" aria-label="失败与注意事项通知" className="flex w-full flex-col gap-2 [&:not(:empty)]:mt-2 sm:w-auto sm:items-end">
      {assertive.map(toast => <ToastCard key={toast.id} toast={toast} onDismiss={handleDismiss}/>)}
    </div>
  </div>;
}
