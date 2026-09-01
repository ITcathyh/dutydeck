import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../../useEscapeKey';

export type PopoverPlacement = 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';

export type PopoverProps = {
  open: boolean;
  onClose(): void;
  anchor: RefObject<HTMLElement | null>;
  placement?: PopoverPlacement;
  width?: number | 'anchor' | 'auto';
  children: ReactNode;
};

/*
  非模态浮层：Composer 的 5 个面板与 CompactSelect 共用。

  与 Dialog 的区别是刻意的，不要互换：
  - Popover 不锁焦点、不 inert 背景。它是「附着在触发器旁边的补充信息」，
    Tab 走出去就该关掉，强行困住焦点会让人退不出面板。
  - 但 Escape 与外部点击必须关闭，且关闭后焦点回到触发器——这是浮层的最低契约。

  同样 portal 到 body：Composer 的面板锚在一个 overflow-hidden 的输入框壳里，
  就地渲染会被裁掉半截，这正是现在 5 个面板各自写 z-index 的原因。
*/
export function Popover({ open, onClose, anchor, placement = 'bottom-start', width = 'anchor', children }: PopoverProps) {
  const panel = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<CSSProperties>();
  useEscapeKey(open, () => { anchor.current?.focus(); onClose(); });

  // 定位要在浏览器绘制前完成，用 layout effect；useEffect 会先闪一帧在左上角。
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const top = placement.startsWith('bottom') ? { top: rect.bottom + 4 } : { bottom: window.innerHeight - rect.top + 4 };
      const side = placement.endsWith('start') ? { left: rect.left } : { right: window.innerWidth - rect.right };
      setPosition({ position: 'fixed', ...top, ...side, width: width === 'anchor' ? rect.width : width === 'auto' ? undefined : width });
    };
    place();
    // 滚动用捕获阶段：面板可能锚在内层滚动容器里，冒泡阶段收不到那次滚动。
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, anchor, placement, width]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      // 点触发器自身不在这里关：触发器的 onClick 会把 open 翻成 false，
      // 两边都关就变成「关了又开」，面板点不掉。
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, anchor, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={panel}
      style={position}
      className="ui-popover z-drawer overflow-auto rounded-lg border border-default bg-surface p-1 text-body shadow-panel"
    >{children}</div>,
    document.body
  );
}

/**
 * 触发器必须自报 aria-expanded / aria-haspopup，否则读屏用户完全不知道这颗按钮
 * 会展开一个面板。契约把这个责任留给调用方，这个 hook 让「补上」只有一行成本。
 *
 * 返回的 id 用于 aria-controls；面板本身不带这个 id 时浏览器会忽略，无害。
 */
export function usePopoverTrigger(open: boolean, kind: 'menu' | 'listbox' | 'dialog' | 'true' = 'true') {
  const id = useId();
  return {
    'aria-expanded': open,
    'aria-haspopup': kind,
    'aria-controls': open ? id : undefined,
    popoverId: id
  } as const;
}
