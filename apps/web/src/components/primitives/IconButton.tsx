import type { ReactNode } from 'react';
import { cn } from './cn';

export type IconButtonProps = {
  label: string;
  size?: 'sm' | 'md';
  tone?: 'default' | 'danger';
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
};

/*
  图标按钮。导出名与 props 形状保持不变（8 个文件 14 处在用），只扩展 size / tone。

  契约 §9：视觉尺寸可以是 32px，但命中区必须 ≥40px。这里不用 ::before 撑命中区——
  相邻图标钮之间只有 gap-0.5（2px），伪元素外扩会让后一枚的命中区盖住前一枚的右边缘，
  把「太小点不中」换成「点错一个」。改成按钮本体恒 40×40（真实命中区，也占真实布局
  宽度，兄弟之间不重叠），内层 chip 承担 32px 的视觉底色与圆角。
*/
export function IconButton({ label, size = 'sm', tone = 'default', disabled, onClick, children }: IconButtonProps) {
  return <button
    type="button"
    title={label}
    aria-label={label}
    disabled={disabled}
    onClick={onClick}
    className="group grid h-10 w-10 shrink-0 place-items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:pointer-events-none disabled:opacity-30"
  >
    <span className={cn(
      'grid place-items-center rounded-md transition-[color,background-color,transform] duration-fast ease-out group-active:scale-[.96]',
      size === 'sm' ? 'h-8 w-8' : 'h-10 w-10',
      tone === 'danger'
        ? 'text-danger group-hover:bg-danger-soft'
        : 'text-subtle group-hover:bg-muted group-hover:text-primary'
    )}>{children}</span>
  </button>;
}
