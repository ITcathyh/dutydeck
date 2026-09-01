import type { ReactNode } from 'react';
import { cn } from './cn';

export type KbdProps = { children: ReactNode };

/** 键帽。高度 ~20px，按「高度 / 3.5」取 rounded-sm。 */
export function Kbd({ children }: KbdProps) {
  return <kbd className={cn('inline-flex min-w-[1.5rem] items-center justify-center rounded-sm border border-default bg-muted px-1.5 py-0.5 font-mono text-meta font-medium text-secondary')}>{children}</kbd>;
}
