import { useCallback, useEffect, useRef, type RefCallback } from 'react';

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(focusableSelector)]
    .filter(element => element.tabIndex >= 0 && element.getAttribute('aria-hidden') !== 'true');
}

let pendingOpener: HTMLElement | null = null;

/** Capture the opener inside its click/key event, before React commits an auto-focused dialog. */
export function captureDialogOpener(): void {
  pendingOpener = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
}

/**
 * Gives a modal its expected keyboard contract: focus enters the dialog,
 * cycles inside it, and returns to the element that opened it.
 *
 * 下面两段补偿逻辑（「猜最后一个 [role=dialog]」与「手工遍历兄弟节点打 inert」）
 * 曾计划在 Dialog 原语 portal 化之后删除。Phase 0 实测：现在还删不掉，两段都仍然
 * 承载着未迁移调用方的行为，删任何一段都会退化。
 *
 *   - 猜 dialog：NewSessionModal.tsx:35 与 LarkConfigModal.tsx:17 调用了本 hook
 *     但**不挂返回的 ref**，dialog.current 恒为 null。删掉这段，这两个弹层的 Tab
 *     直接不再被困住（已用探针测到：焦点根本进不去弹层）。
 *   - 兄弟 inert：App.dom.test.tsx 断言设置中心打开时 <main> 带 inert。那是这段
 *     遍历打上去的。删掉即挂。
 *
 * 经 Dialog 原语渲染的浮层两段都不需要：ref 直接挂到面板上，且 portal 到 body 后
 * 「背景」就是整棵应用子树，遍历自然落在它身上。等 Phase 1 把 11 份手写遮罩壳
 * 全部迁到 <Dialog> 之后，这两段才能安全删除——删之前请重跑上面两个探针场景。
 */
export function useDialogFocus(active = true): RefCallback<HTMLElement> {
  const dialog = useRef<HTMLElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const wasActive = useRef(false);
  const setDialog = useCallback((node: HTMLElement | null) => { dialog.current = node; }, []);

  // Capture during render, before a dialog descendant's `autoFocus` runs in
  // the commit phase and replaces the element that actually opened it.
  if (active && !wasActive.current && typeof document !== 'undefined') {
    opener.current = pendingOpener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    pendingOpener = null;
  }
  wasActive.current = active;

  useEffect(() => {
    if (!active) return;
    if (!dialog.current?.isConnected) {
      dialog.current = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')].at(-1) ?? null;
    }
    const previous = opener.current;
    const overlay = dialog.current?.closest<HTMLElement>('.ui-overlay');
    const background = overlay?.parentElement
      ? [...overlay.parentElement.children].filter((element): element is HTMLElement => element instanceof HTMLElement && element !== overlay)
      : [];
    const backgroundState = background.map(element => ({
      element,
      inert: element.hasAttribute('inert'),
      ariaHidden: element.getAttribute('aria-hidden')
    }));
    for (const element of background) {
      element.setAttribute('inert', '');
      element.setAttribute('aria-hidden', 'true');
    }
    const frame = requestAnimationFrame(() => {
      const root = dialog.current;
      if (!root) return;
      const focused = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : undefined;
      const initial = focused ?? root.querySelector<HTMLElement>('[data-dialog-initial-focus]') ?? focusableElements(root)[0] ?? root;
      if (initial === root && root.tabIndex < 0) root.tabIndex = -1;
      initial.focus();
    });
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialog.current) return;
      const items = focusableElements(dialog.current);
      if (!items.length) {
        event.preventDefault();
        dialog.current.focus();
        return;
      }
      const first = items[0]!;
      const last = items.at(-1)!;
      const current = document.activeElement;
      const outside = !(current instanceof Node) || !dialog.current.contains(current);
      if (event.shiftKey && (outside || current === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (outside || current === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      for (const { element, inert, ariaHidden } of backgroundState) {
        if (inert) element.setAttribute('inert', '');
        else element.removeAttribute('inert');
        if (ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', ariaHidden);
      }
      if (previous?.isConnected) previous.focus();
    };
  }, [active]);

  return setDialog;
}
