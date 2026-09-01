import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from './cn';

export type TabsProps<T extends string> = {
  value: T;
  onChange(value: T): void;
  label: string;
  items: Array<{ id: T; label: string; icon?: ReactNode }>;
};

/*
  详情页 timeline|terminal 的标签栏。

  内建 roving tabindex：整条 tablist 在 Tab 序列里只占一站（只有选中项 tabIndex=0），
  组内切换用方向键 / Home / End。这是 WAI-ARIA 的 tabs 模式——每个标签都能 Tab 到
  会让键盘用户在标签栏里困上 N 次才能进内容区。
*/
export function Tabs<T extends string>({ value, onChange, label, items }: TabsProps<T>) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const index = items.findIndex(item => item.id === value);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
    const target = items[next];
    if (!target) return;
    onChange(target.id);
    // 选中即聚焦（automatic activation）：方向键移动后焦点必须跟着走，
    // 否则下一次方向键还是从旧位置算起。
    refs.current[target.id]?.focus();
  };

  return <div role="tablist" aria-label={label} className="flex items-center gap-1 border-b border-default">
    {items.map(item => {
      const selected = item.id === value;
      return <button
        key={item.id}
        ref={node => { refs.current[item.id] = node; }}
        type="button"
        role="tab"
        id={`tab-${item.id}`}
        aria-selected={selected}
        aria-controls={`tabpanel-${item.id}`}
        tabIndex={selected ? 0 : -1}
        onClick={() => onChange(item.id)}
        onKeyDown={onKeyDown}
        className={cn(
          '-mb-px flex h-10 items-center gap-1.5 border-b-2 px-3 text-caption font-semibold transition-colors duration-fast ease-out',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
          selected ? 'border-action text-primary' : 'border-transparent text-subtle hover:text-primary'
        )}
      >{item.icon}{item.label}</button>;
    })}
  </div>;
}
