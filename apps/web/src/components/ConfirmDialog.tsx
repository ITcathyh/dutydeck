import { AlertTriangle } from 'lucide-react';
import { Banner, Button, Dialog } from './primitives';

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  tone?: 'danger' | 'warning';
  busy?: boolean;
  error?: string;
  onConfirm(): void;
  onCancel(): void;
};

/*
  全项目唯一的破坏性操作闸门（删除 / 归档）。

  三处闸门语义写在 props 上，不要靠 onCancel 里 return 来实现：
  1. busy 时**任何**关闭路径都必须失效。Escape 走 closeOnEscape={false}——在 onClose
     里 return 是错的，useEscapeKey 仍会 preventDefault 把按键吃掉；遮罩走
     closeOnScrim={false}。
  2. 焦点落在「取消」而不是危险的确认按钮：取消按钮带 data-dialog-initial-focus，
     useDialogFocus 会优先聚焦它。这里不用 Dialog 的 initialFocus，因为 Button 原语
     不转发 ref（契约 §10 冻结了它的签名）。
  3. role="alertdialog"：这是一个需要用户裁决才能继续的中断，不是普通信息浮层。

  描述文本原先挂 aria-describedby。Dialog 原语只暴露 aria-label（契约 §10），
  改由 label={title} 播报标题，描述留在正文里由读屏顺序读到。
*/
export function ConfirmDialog({ open, title, description, confirmLabel, tone = 'warning', busy = false, error, onConfirm, onCancel }: ConfirmDialogProps) {
  const danger = tone === 'danger';
  return <Dialog
    open={open}
    onClose={onCancel}
    label={title}
    size="sm"
    role="alertdialog"
    closeOnEscape={!busy}
    closeOnScrim={!busy}
  >
    <Dialog.Body className="py-5">
      <div className="flex gap-3.5">
        <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-md border ${danger ? 'border-danger-border bg-danger-soft text-danger' : 'border-warning-border bg-warning-soft text-warning'}`}><AlertTriangle size={19} strokeWidth={1.8}/></div>
        <div className="min-w-0 pt-0.5">
          <h2 className="text-title font-semibold tracking-[-.01em] text-primary">{title}</h2>
          <p className="mt-1.5 text-caption text-subtle">{description}</p>
        </div>
      </div>
      {error && <div className="mt-4"><Banner tone="danger">{error}</Banner></div>}
    </Dialog.Body>
    <Dialog.Footer>
      <Button data-dialog-initial-focus disabled={busy} onClick={onCancel}>取消</Button>
      <Button
        variant={danger ? 'danger' : 'secondary'}
        tone={danger ? 'default' : 'inverse'}
        loading={busy}
        onClick={onConfirm}
        className="min-w-24"
      >{busy ? '处理中' : confirmLabel}</Button>
    </Dialog.Footer>
  </Dialog>;
}
