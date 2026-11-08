import { useEffect, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useDialogFocus } from '../../useDialogFocus';
import { useEscapeKey } from '../../useEscapeKey';
import { cn } from './cn';

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl';
export type DialogVariant = 'modal' | 'sheet';

export type DialogProps = {
  open: boolean;
  onClose(): void;
  label: string;
  size?: DialogSize;
  role?: 'dialog' | 'alertdialog';
  variant?: DialogVariant;
  closeOnEscape?: boolean;
  closeOnScrim?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  children: ReactNode;
};

const sizeClass: Record<DialogSize, string> = {
  sm: 'max-w-[420px]',
  md: 'max-w-[640px]',
  lg: 'max-w-[960px]',
  xl: 'max-w-[1152px]',
  '2xl': 'max-w-[1800px]'
};

/*
  全站唯一的模态外壳。

  三件事只在这里做一次（契约 §7）：
  1. **portal 到 document.body**。就地渲染的浮层会继承祖先的 transform / overflow /
     stacking context，是 11 份手写遮罩壳里 5 档手工 z-index 的根因。portal 之后
     层级只有一个 z-dialog。
  2. **焦点陷阱**由 useDialogFocus 提供（那已经是完整实现：捕获 opener、Tab 循环、
     背景 inert、关闭后归还焦点），这里只负责把 ref 挂上去。
  3. **Escape** 走 useEscapeKey。busy 时调用方传 closeOnEscape={false}，不要在
     onClose 里自己 return——那样 Escape 仍会被 preventDefault 吃掉。

  aria-modal 恒为 true：契约 §12.6 要求所有 role=dialog 都带 aria-modal，
  由这里保证，调用方无从遗漏。
*/
export function Dialog({ open, onClose, label, size = 'md', role = 'dialog', variant = 'modal', closeOnEscape = true, closeOnScrim = true, initialFocus, children }: DialogProps) {
  const setDialogNode = useDialogFocus(open);
  useEscapeKey(open && closeOnEscape, onClose);

  useEffect(() => {
    if (!open || !initialFocus) return;
    // useDialogFocus 在下一帧把焦点移到首个可聚焦元素；initialFocus 要压过它，
    // 所以也排到同一帧之后，而不是同步 focus 后被覆盖。
    const frame = requestAnimationFrame(() => initialFocus.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, initialFocus]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className={cn(
        'ui-overlay fixed inset-0 z-dialog bg-scrim backdrop-blur-[2px]',
        variant === 'sheet'
          ? 'flex items-end justify-center p-0 sm:grid sm:place-items-center sm:p-4'
          : 'grid place-items-center p-4'
      )}
      // mousedown 而不是 click：在面板内按下、拖到遮罩上松开（划选文本）时
      // click 会落在遮罩上，用 click 关闭会把正在选词的用户的弹层关掉。
      onMouseDown={event => { if (closeOnScrim && event.target === event.currentTarget) onClose(); }}
    >
      <div
        ref={setDialogNode}
        role={role}
        aria-modal="true"
        aria-label={label}
        className={cn(
          'ui-dialog flex w-full flex-col overflow-hidden bg-surface shadow-dialog',
          variant === 'sheet'
            ? 'ui-sheet max-h-[80dvh] rounded-t-2xl border-t border-default sm:max-h-[92dvh] sm:rounded-xl sm:border'
            : 'max-h-[92dvh] rounded-xl border border-default',
          sizeClass[size]
        )}
      >
        {variant === 'sheet' && (
          <div className="mx-auto mt-2.5 h-1.5 w-9 shrink-0 rounded-full bg-border-strong sm:hidden" aria-hidden="true"/>
        )}
        {children}
      </div>
    </div>,
    document.body
  );
}

/** 固定在弹层顶部，不随 Body 滚动。契约 §5 白名单第 1 类：功能性边界允许画底边。 */
function DialogHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex shrink-0 items-start gap-3 border-b border-subtle px-5 py-4', className)}>{children}</div>;
}

/** 唯一的滚动区。overflow 放在 Body 上，Header / Footer 才能钉住。 */
function DialogBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-4 text-body text-secondary', className)}>{children}</div>;
}

function DialogFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex shrink-0 items-center justify-end gap-2 border-t border-subtle bg-muted px-5 py-3.5', className)}>{children}</div>;
}

Dialog.Header = DialogHeader;
Dialog.Body = DialogBody;
Dialog.Footer = DialogFooter;
