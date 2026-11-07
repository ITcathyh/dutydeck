import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Popover, usePopoverTrigger, type PopoverPlacement } from './primitives/Popover';

export type MenuAction = {
  id: string;
  label: string;
  icon?: ReactNode;
  /** 有值时渲染为 menuitemcheckbox，用于「原始日志」这类开关。 */
  checked?: boolean;
  disabled?: boolean;
  tone?: 'default' | 'danger';
  onSelect(): void;
};
export type MenuEntry = MenuAction | { id: string; separator: true };

const isAction = (entry: MenuEntry): entry is MenuAction => !('separator' in entry);

/*
  低频操作收进「⋯」：任务页头只留状态与真正常用的一两个入口。

  键盘契约按 WAI-ARIA menu button：打开后焦点落在第一项，上下方向键 / Home / End
  在可用项之间移动，Escape 关闭并回到触发器，Tab 直接离开并关闭。

  选中某项时先把焦点还给触发器再执行：多数菜单项会打开弹窗，弹窗用
  captureDialogOpener 记下「当前焦点」作为关闭后的落点，菜单项那时已卸载。
*/
export function MenuButton({ label, icon, items, placement = 'bottom-end' }: { label: string; icon: ReactNode; items: MenuEntry[]; placement?: PopoverPlacement }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const trigger = usePopoverTrigger(open, 'menu');
  const enabled = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
  const close = () => { setOpen(false); anchor.current?.focus(); };
  const select = (action: MenuAction) => { close(); action.onSelect(); };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') { setOpen(false); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const list = enabled();
    if (!list.length) return;
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? list.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
    list[next]?.focus();
  };
  return <>
    <button
      ref={anchor}
      type="button"
      title={label}
      aria-label={label}
      aria-expanded={trigger['aria-expanded']}
      aria-haspopup={trigger['aria-haspopup']}
      aria-controls={trigger['aria-controls']}
      onClick={() => setOpen(value => !value)}
      className="group grid h-10 w-10 shrink-0 place-items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      <span className={`grid h-8 w-8 place-items-center rounded-md transition-colors duration-fast ease-out group-active:scale-[.96] ${open ? 'bg-muted text-primary' : 'text-subtle group-hover:bg-muted group-hover:text-primary'}`}>{icon}</span>
    </button>
    <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement={placement} width="auto">
      <div
        ref={node => { menu.current = node; if (node && !node.contains(document.activeElement)) requestAnimationFrame(() => enabled()[0]?.focus()); }}
        id={trigger.popoverId}
        role="menu"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="min-w-48 py-0.5"
      >
        {items.map(entry => isAction(entry)
          ? <button
            key={entry.id}
            type="button"
            role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={entry.checked}
            tabIndex={-1}
            disabled={entry.disabled}
            onClick={() => select(entry)}
            className={`flex min-h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-body transition-colors duration-fast ease-out hover:bg-muted focus:bg-muted focus:outline-none disabled:cursor-not-allowed disabled:opacity-45 ${entry.tone === 'danger' ? 'text-danger' : 'text-primary'}`}
          >
            <span aria-hidden="true" className={`grid w-4 shrink-0 place-items-center ${entry.tone === 'danger' ? '' : 'text-subtle'}`}>{entry.icon}</span>
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {entry.checked && <Check aria-hidden="true" size={14} className="shrink-0 text-subtle"/>}
          </button>
          : <div key={entry.id} role="separator" className="mx-2 my-1 border-t border-subtle"/>)}
      </div>
    </Popover>
  </>;
}
