import type { ReactNode } from 'react';
import { cn } from './cn';

export type ToolbarProps = { label: string; children: ReactNode };

/*
  页头工具栏与筛选条。

  role=toolbar 让读屏把一排按钮当作一组来播报，而不是 N 个孤立控件。
  契约 §5 白名单第 1 类：内容区与固定工具条之间的功能性边界允许画底边。
*/
export function Toolbar({ label, children }: ToolbarProps) {
  return <div role="toolbar" aria-label={label} aria-orientation="horizontal" className={cn('flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-default bg-surface px-4')}>{children}</div>;
}
